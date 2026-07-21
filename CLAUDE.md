# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目本质

vibe-remote 是一个「远程 Claude 终端」桌面工具：真正的 `claude` CLI 始终跑在**远程 Linux** 上（PTY→tmux→claude），桌面端（Electron + xterm.js）只是**哑终端**，通过 WebSocket 双向透传 PTY 字节流。

**核心设计约束 —— 纯字节透传**：客户端**绝不解析** claude 的输出。PTY 字节流（含 ANSI 转义、颜色、光标控制、box-drawing）原样双向搬运，所以流式/颜色/重绘全部 0 失真「免费」还原。任何「解析 claude 输出来做富文本」的想法都违背此架构 —— 「富文本」指的是**外壳 UI 的精致度**（侧边栏/状态栏对标 Claude Desktop），不是解析终端内容。这条约束是整个项目成立的前提，改动时优先维护它。

架构是 **agent 无关**的：把 `claude_cmd` 换成 `codex` 或任意交互式 CLI 都照常工作（tmux 持久化、重连、resize、Ctrl+C 全部通用）。

## 常用命令

```bash
# 服务端（Go）
make server                    # 构建 → bin/vibe-remoted
make dev-server                # go run，读 ../vibe-remoted.json
cd vibe-remoted && go test ./...    # 单元测试（config 包含路径越权 + bind 校验）
cd vibe-remoted && go test ./internal/config -run TestValidateBindAddr   # 跑单个测试
cd vibe-remoted && go vet ./...

# 交叉编译部署到远程 Linux（远程通常无 go）
cd vibe-remoted && GOOS=linux GOARCH=amd64 go build -o ../bin/vibe-remoted-linux-amd64 ./cmd/vibe-remoted
scp bin/vibe-remoted-linux-amd64 dev:~/vibe-remoted

# 客户端（Electron）
cd desktop && npm install
cd desktop && npm run dev       # Vite + Electron 热重载
cd desktop && npm run typecheck # tsc --noEmit
cd desktop && npm run build     # tsc + vite build + electron-builder → dist/*.dmg

make smoke                      # curl localhost:8765/healthz
```

打包时用国内镜像加速 electron 二进制：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

## 架构：关键机制（跨文件才能理解的部分）

### 会话持久化模型（PTY → tmux → claude）

单一事实来源是 **tmux**，不是服务端内存。每个 vibe-remote 会话 = 一个 tmux 会话 `vibe-remote-<id>`，跑在**专用 socket** `tmux -L vibe-remote` 上（隔离用户自己的 tmux；`set -g status off` 让 claude 拿到全高 PTY —— 否则 status 栏吃掉 1 行导致错行）。

- 客户端断开 → `Runner.DetachEpoch` 关 PTY，**tmux + claude 存活**。
- 客户端重连 → `Runner.AttachExisting` 新起 PTY 重新 `tmux attach` + `refresh-client` 强制全屏重绘 → 现场恢复。
- 服务端重启后内存 map 空 → `Manager.List` / `Manager.Attach` 靠 `tmux list-sessions` / `has-session` 找回会话（`liveTmuxSessions` 查 `pane_current_path` 回填 workdir）。
- `Manager.List` 以 tmux 为准**双向 reconcile**：map 有 tmux 无的删（幽灵会话），tmux 有 map 无的补建恢复条目（隐形会话）。查询失败时回退内存 map，避免瞬时故障误删。

相关文件：`vibe-remoted/internal/session/runner.go`（PTY/tmux 生命周期）、`manager.go`（会话表 + reconcile）。

### epoch 代际（防重连竞态）

`Runner.epoch` 每次装新 PTY（start / AttachExisting）+1。relay（`ws.go:wsRelay`）在 attach 后捕获自己的 epoch，teardown 时调 `DetachEpoch(epoch)` —— **只在仍拥有当前 epoch 时才关 PTY**，避免旧连接慢速 teardown 误关新重连已装的 PTY。Read/Write 用 `ptmxSnapshot()` 锁内快照后再阻塞操作，避免阻塞的 Read 卡死 Resize/Detach。改动 runner 的 PTY 生命周期时务必保持 race build 通过（`go build -race`）。

### exit 帧语义

`wsRelay` 用 `detaching atomic.Bool` 区分「我方主动 detach（会话在 tmux 里还活着）」vs「claude 进程真退出」。**只有真退出才发 exit 帧**。正常客户端断开不能发 exit（否则客户端会以为会话死了）。

### 协议（单一事实来源：docs/protocol.md）

JSON 分帧 WebSocket，帧靠 `type` 区分，PTY 字节走 base64（`data` 帧）。Go 端 `vibe-remoted/internal/protocol/protocol.go` 与 TS 端 `desktop/src/shared/protocol.ts` **必须手动保持对齐**（无代码生成）—— 改协议时两端都要改，并同步 `docs/protocol.md`。

握手时序：`auth`（首帧，10s 超时）→ 服务端推 `sessions` 列表 → 客户端可空闲浏览（ping/pong 保活，**无 attach 超时**）→ `attach`（空 sessionId=新建，带 workdir）→ `ready` → 双向 `data`。

辅助 REST（Bearer token 鉴权）：`/healthz`、`/api/v1/info`、`/api/v1/sessions`、`DELETE /api/v1/sessions/{id}`、`/api/v1/fs?path=`（远程目录选择器，受 workdir 白名单约束）。

### 客户端会话模型

`desktop/src/renderer/index.ts` 的 **SessionView** 抽象：每个打开的会话 = **独立 WebSocket（VibeRemoteClient）+ 独立 xterm 实例**。切换会话 = 显示/隐藏对应 term-instance，未聚焦会话由 tmux 服务端保活。所有机器级 Map 用 **`addr:port`（machineKey）** 做 key（不是 addr，防同主机多端口冲突）。侧边栏靠 REST 每 5s 轮询各机器会话列表。

`client.ts` 重连：指数退避，`reconnectAttempt` 在收到 **`ready`（连接确认健康）后才归零**（不是 onopen —— 否则坏 token 每秒锤服务端）。重连按 `lastCols/lastRows` re-attach，`pendingAttach` **必须带 workdir**（曾因丢 workdir 导致新会话总落默认目录）。

### UTF-8 字节处理（易踩坑）

`atob()` 返回 Latin-1，直接 `term.write(string)` 会把多字节 UTF-8（box-drawing/emoji/CJK）拆成乱码。**必须** base64 → `Uint8Array` → `term.write`（xterm 自己按 UTF-8 解码）；输入方向用 `TextEncoder` 编码后再 base64。见 `index.ts` 的 `base64ToBytes`/`bytesToBase64`。

### 环境加载（登录 shell）

`login_shell: true`（默认）时 runner 用 `<shell> -lic 'exec <claudeCmd>'` 启动，加载完整用户环境（PATH、fnm/nvm 等）。治本 —— 契合「跟在 shell 里敲 claude 一致」。远程若用 fnm 管理 node，不走登录 shell 会报 `node: command not found`。

## 安全模型

- vibe-remoted **绑私有网段地址**：`config.validateBindAddr` 放行 RFC1918 / loopback / link-local / IPv6 ULA / tailscale CGNAT 段（`isPrivateBindIP`，用 `net.IP.IsPrivate` + CGNAT 补丁），拒绝**公网 IP**（需 `allow_insecure_bind: true` 逃生舱）和**所有通配地址**（`0.0.0.0`/`::`，恒拒，逃生舱也不放行）。
- **静态 token 是准入核心边界**：WS `auth` 帧 + REST `Authorization: Bearer`，均用 `crypto/subtle.ConstantTimeCompare` 常量时间校验（token 现在是主防线，防时序侧信道）。
- workdir 白名单：`config.IsAllowedWorkdir` 用 `filepath.Rel` + `..` 前缀检查防路径越权；`/api/v1/fs` 和 attach 的 workdir 都受约束。
- 传输为明文 `ws://`（无 `wss://`）：绑 tailscale IP 时由 WireGuard 加密，绑 LAN IP 时为明文——**仅在可信网络使用**。Origin 检查跳过（Electron 跨 origin）+ permissive CORS，均以 token + 私有网段不可达公网为前提。**Tailscale 仍是推荐方案**（自带加密+跨网），只是不再强制。

## 配置

服务端读 JSON（`vibe-remoted.example.json` 为模板），可用 `VIBE_REMOTED_BIND_ADDR`/`VIBE_REMOTED_TOKEN` 覆盖。**追加 claude 启动参数**：`claude_cmd` 是整条命令串，直接写 `"claude --dangerously-skip-permissions -c"`，按 shell 规则解析。

**可选 `claude_flags`**（`[{id,label,arg,default}]`）：客户端新建会话时在目录选择器里按 `label` 多选启动 flag，服务端按 `id` 查白名单把 `arg` 拼到 `claude_cmd` 后（**per-session**，每个会话独立；客户端只传 id、服务端查表拼接 = 零命令注入；`/api/v1/info` 只下发 id/label/default，不含 arg；冲突不去重、按声明顺序全拼）。`default` 控制初始勾选。`ResolveClaudeCmd`（`config.go`）是拼接入口，空 flags 时回退原 `claude_cmd`（向后兼容）。

客户端机器清单在 Electron userData 下的 `machines.json`（macOS: `~/Library/Application Support/vibe-remote/machines.json`），格式 `[{name, addr, port, token}]`。

## 前置条件与联调

- 所有机器（含 Mac 客户端）在同一 Tailscale tailnet（`tailscale up`）。
- 目标 Linux 需 `claude` + `tmux`（不需要 go，交叉编译部署）。
- 真机联调用 ssh config 的 `dev`（tailscale `100.95.191.101`）；vibe-remoted 托管为常驻 `tmux new-session -d -s vibe-remoted-daemon`。
- **本地无远程机冒烟**：macOS 本身有 PTY+tmux，用 `claude_cmd: "/bin/bash"` 代跑即可验证透传链路（纯字节透传不关心跑什么）。测试配置 `vibe-remoted.local.json`（无 tmux）/ `vibe-remoted.tmux.json`。
- **GUI 调试**：`VIBE_REMOTE_DEBUG_PORT=9222` 开 CDP 端口，用 CDP over WebSocket 驱动/检查 renderer（chrome-devtools MCP 在此 Electron 版本有调用故障，改用裸 CDP）。`VIBE_REMOTE_NO_DEVTOOLS=1` 禁自动开 DevTools。

## 状态

第一期（Mac 桌面可用版）验收 7 项全部真机通过，`.dmg` 已交付。未做（可选）：代码签名、app 图标、侧边栏轮询改推送、codex 多 agent 产品化（config 多 agent 列表 + attach 带 `agent` 字段 + UI 选择）。完整进展见 `REQUIREMENTS.md` 和插件计划文件。

### 第二批体验增强（已完成）

- 机器管理 app 内 UI（CRUD + 空状态引导 + 测试连接），不再手改 machines.json。
- 会话命名：默认名跟随 workdir，双击侧边栏内联重命名，名字存 tmux 用户选项 `@vibe_remote_name`（跟随 tmux 生命周期，重启/多端一致）。
- 后台会话提示：A 圆点兜底（非活动会话有字节到达即亮蓝点，任何 agent 通用）+ C hook 事件增强（notify 帧把圆点升级为 idle 绿/waiting 黄 + 可选桌面通知）。
- 重连体验：状态栏显示重连尝试次数 + 活动会话终端顶部断线横幅 + Retry now。

**事件基建（通用可扩展）**：`POST /api/v1/events`（Bearer 鉴权，body `{sessionId,kind,message?}`）+ Manager pub/sub 路由表 + notify 帧。`kind` 为开放枚举，未来带外事件（token 用量等）复用此通道。claude 进程已注入 `VIBE_REMOTE_SESSION_ID`/`VIBE_REMOTE_EVENTS_URL`/`VIBE_REMOTE_TOKEN`。

**⚠️ 故意留空（本期不实现）**：vibe-remoted 自动生成 hook 配置让 claude 带上（`--settings` 注入方式需真机验证 claude 版本合并语义）。当前靠手动配 hook 或手动 curl events 端点即可验证全链路；日后补「自动注入」一小段，前面基建全不用动。
