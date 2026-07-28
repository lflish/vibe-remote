# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目本质

vibe-remote 是一个「远程 Claude」工具：真正的 `claude` CLI 始终跑在**远程 Linux** 上，桌面 / web / iOS 三端以**结构化聊天式富交互 UI** 连上去。三端是 npm workspaces monorepo，共享一套框架无关内核 `@vibe-remote/core` + 一套 React 视图 `@vibe-remote/ui`；各端只是薄壳。

**两条数据平面**（关键，别混淆）：

- **headless 线（结构化，默认）**：服务端跑 `claude -p --output-format stream-json`，把 claude **官方 NDJSON 协议**按行透传；客户端用 `core` 的 parser/session **解析成结构化消息**（tool_use↔tool_result 配对、thinking、cost），`ui` 渲染成工具卡片/diff/思考/成本。**解析的是官方结构化协议，不是 TUI 像素** —— 所以「客户端不解析终端」的原则仍成立（解析仅用于显示）。这是当前三端默认走的线。
- **TUI 线（字节透传，逃生舱）**：PTY→tmux→claude，WS 双向透传 PTY 字节，客户端 xterm 哑终端。服务端 `wsRelay`/`wsOpenTUI` 保留，用于跑交互式全屏程序（vim/htop/claude 原生 TUI）。**这条线才是「纯字节透传、绝不解析」约束的适用范围**。

改动时分清你在哪条线：碰 headless/结构化 UI（`packages/*`、各端 chat 视图）时解析是合法的；碰 TUI 线（`ws.go` 的 wsRelay、xterm）时维持字节透传约束。

TUI 线是 **agent 无关**的（`claude_cmd` 换 `codex` 或任意交互 CLI 都照常）；headless 线依赖 claude 官方 stream-json 协议。

## 常用命令

**monorepo 根**（npm workspaces：`packages/*` + `desktop` + `mobile` + `web`）：

```bash
npm install                # 一次装齐所有 workspace（monorepo 前置）
npm test                   # 所有 JS workspace 测试：core / ui / mobile / web
npm run typecheck          # 所有 workspace typecheck
npm run build:core         # 单独构建 @vibe-remote/core
```

**服务端（Go）**：

```bash
make server                # 构建 → bin/vibe-remoted
make dev-server            # go run，读 ../vibe-remoted.json
cd vibe-remoted && go test ./...       # 单元测试（config 含路径越权 + bind 校验）
cd vibe-remoted && go vet ./...
cd vibe-remoted && GOOS=linux GOARCH=amd64 go build -o ../bin/vibe-remoted-linux-amd64 ./cmd/vibe-remoted   # 交叉编译到远程 Linux
scp bin/vibe-remoted-linux-amd64 dev:~/vibe-remoted
```

**Web 门户（Go embed 静态托管 web/dist）**：

```bash
make portal                            # web build → cp -R web/dist → cmd/vibe-portal → bin/vibe-portal
./bin/vibe-portal -addr 127.0.0.1:9000 # 起门户，浏览器打开该 URL
npm run dev --workspace=@vibe-remote/web   # 或直接 Vite dev
```

⚠️ **Go embed 不支持 symlink**（`cannot embed irregular file`），Makefile `portal` target 用 `cp -R` 构建期复制（不用 `ln -sfn`）。

**桌面（Electron）**：

```bash
npm run dev --workspace=vibe-remote      # Vite + Electron 热重载
npm run typecheck --workspace=vibe-remote
npm run build --workspace=vibe-remote    # tsc + vite build + electron-builder → dist/*.dmg
```

**iOS（Capacitor）**：

```bash
npm run build --workspace=vibe-remote-mobile   # tsc + vite build
cd mobile && npx cap sync ios                  # 同步 web 产物到 Xcode 工程
```

**冒烟**：

```bash
make smoke                 # curl localhost:8765/healthz
```

打包 Electron 时用国内镜像加速：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

## 架构：关键机制（跨文件才能理解的部分）

### monorepo / 三端共享（重构后的核心结构）

```
packages/core/   @vibe-remote/core  框架无关（零 DOM）：protocol / client(WS) / rest / base64 /
                                    machines(testConnection + validateMachineFields) /
                                    chat/{types, parser, session, diff, lines}
packages/ui/     @vibe-remote/ui    共享 React 视图：ChatView / MessageView / ToolCard /
                                    DiffToolCard / MarkdownBody / ChatInput / mountChat + styles.css
vibe-remoted/    Go 服务端 + cmd/vibe-portal（web 静态托管，embed web/dist）
desktop/         Electron 瘦壳（renderer 用 React + 挂 core+ui 的 mountChat；main 保持 Electron IPC）
mobile/          Capacitor 瘦壳（同上，Preferences 存机器清单；键盘避让）
web/             Vite+React SPA 瘦壳（localStorage 存机器 + workdir；Sidebar/App 外壳）
```

**依赖 DAG（必须单向）**：`core → {ui, desktop, mobile, web}`，`ui → {desktop, mobile, web}`，`vibe-remoted → cmd/vibe-portal`。core 不得依赖 ui，ui 不得依赖具体壳。

**core 里的「零 DOM」纪律**：`core/tsconfig.json` 保留 DOM lib 只为拿 `WebSocket`/`fetch`/`URL` 等 Web 平台 API 类型（三端运行时都提供），**禁止**在 core 写 `document.` / `window.` 的 DOM 树操作。这条纪律靠审查守，不靠 tsconfig 缺 lib（缺 lib 反而挡住合法的 fetch/WebSocket）。

**mountChat 契约**（`packages/ui/src/mount.ts`）：命令式 API，把 core 的 `ChatSession`（逻辑）与 `ChatView`（React 视图）接到一个 DOM 挂载点，返回 `{session, feed(base64), setHistory, dispose}`。**三端共用**。⚠️ `dispose` 里 `unmount()` 用 `queueMicrotask` 延迟——React 19 禁止在另一组件 render/commit 周期内同步 unmount root（三端卸载共用此路径）。

**共享 protocol 单一事实来源**：`packages/core/src/protocol.ts`（TS） 与 `vibe-remoted/internal/protocol/protocol.go`（Go）**手工镜像**，改协议时两端都要改，并同步 `docs/protocol.md`。desktop 的 `desktop/src/shared/protocol.ts` 只是 re-export `@vibe-remote/core/protocol` 的薄壳（保 renderer 现有 import 路径不动）。

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

JSON 分帧 WebSocket，帧靠 `type` 区分，data 帧 payload 走 base64。**TS 单一事实来源在 core**：`packages/core/src/protocol.ts`（不再是 `desktop/src/shared/protocol.ts` —— 那已退化为 re-export core 的薄壳）与 Go 端 `vibe-remoted/internal/protocol/protocol.go` **手工对齐**（无代码生成）—— 改协议时两端都要改，并同步 `docs/protocol.md`。

握手时序：`auth`（首帧，10s 超时）→ 服务端推 `sessions` 列表（tmux 会话，仅 TUI 线用）→ 客户端可空闲浏览（ping/pong 保活，**无 attach 超时**）→ `attach`（带 workdir + `mode`）→ `ready` → 双向 `data`。

`attach` 的 **`mode` 字段决定走哪条线**：
- `mode:"headless"`（默认，三端聊天 UI 走这条）：data 帧 payload = base64 的用户 prompt / 服务端 NDJSON 行。会话 = workdir（无 sessionId），服务端不启 tmux，每 turn spawn 一次 `claude -p`。
- `mode:"tui"`（可选逃生舱）：data 帧 payload = base64 的 PTY 字节，服务端 PTY→tmux→claude 全字节透传。

辅助 REST（Bearer token 鉴权）：`/healthz`、`/api/v1/info`、`/api/v1/sessions`（tmux 会话列表，headless 不出现）、`DELETE /api/v1/sessions/{id}`、`/api/v1/fs?path=`（远程目录选择器，受 workdir 白名单约束）、`/api/v1/history?path=&limit=`（读该 workdir 最近 jsonl，headless 聊天 UI 用它做历史回填）。

### 客户端会话模型

`desktop/src/renderer/index.ts` 的 **SessionView** 抽象：每个打开的会话 = **独立 WebSocket（`VibeRemoteClient` from core）+ 独立聊天挂载点（ui 的 `mountChat` 挂 ChatView）**。切换会话 = 显示/隐藏对应 term-instance 容器，未聚焦会话在服务端各自保活（headless 靠 `claude -c` 续会话；TUI 线靠 tmux）。所有机器级 Map 用 **`addr:port`（machineKey）** 做 key（不是 addr，防同主机多端口冲突）。侧边栏靠 REST 每 5s 轮询各机器状态。

**默认 attach 走 headless**：`client.attach(sessionId, 80, 24, workdir, flags, 'headless')`（headless 下 cols/rows 无意义，传占位值）。data 帧 payload 是 base64 的 NDJSON 文本，经 `mount.feed()` → `makeLineSplitter` → `ChatSession.applyLine` 累积成结构化消息。web/mobile 同结构（各自的 ChatPane / openChat 都用同一个 `mountChat`）。

`client.ts` 重连：指数退避，`reconnectAttempt` 在收到 **`ready`（连接确认健康）后才归零**（不是 onopen —— 否则坏 token 每秒锤服务端）。重连按 `lastCols/lastRows/lastMode` re-attach，`pendingAttach` **必须带 workdir + mode**（曾因丢 workdir 导致新会话总落默认目录；丢 mode 导致 headless 重连退化成 TUI）。

**会话 = workdir**（headless 线）：headless 无 tmux 会话、无独立 sessionId，一个 workdir = 一条聊天线（`claude -c` 续接该目录最近对话）。web 端侧边栏列 workdir 列表存 localStorage；`Manager.List` 的 tmux 会话列表**只服务 TUI 线**，headless 不出现在里面。

### 编解码工具（`@vibe-remote/core/base64`）

`base64ToBytes` / `bytesToBase64` / `base64ToText` / `textToBase64` 已上提到 core（三端共用）。**易踩坑**：`atob()` 返回 Latin-1，直接 `term.write(string)` 会把多字节 UTF-8 拆坏——**必须** base64 → `Uint8Array` → `term.write`（xterm 自己按 UTF-8 解码）；输入方向用 `TextEncoder` 编码后再 base64。这条只对 **TUI 线**（xterm 字节透传）适用；headless 线 data 帧是 NDJSON **文本**（`base64ToText` 解出即可，无 UTF-8 拆坏风险）。

### 环境加载（登录 shell）

`login_shell: true`（默认）时 runner 用 `<shell> -lic 'exec <claudeCmd>'` 启动，加载完整用户环境（PATH、fnm/nvm 等）。治本 —— 契合「跟在 shell 里敲 claude 一致」。远程若用 fnm 管理 node，不走登录 shell 会报 `node: command not found`。

## 安全模型

- vibe-remoted **绑私有网段地址**：`config.validateBindAddr` 放行 RFC1918 / loopback / link-local / IPv6 ULA / tailscale CGNAT 段（`isPrivateBindIP`，用 `net.IP.IsPrivate` + CGNAT 补丁），拒绝**公网 IP**（需 `allow_insecure_bind: true` 逃生舱）和**所有通配地址**（`0.0.0.0`/`::`，恒拒，逃生舱也不放行）。
- **静态 token 是准入核心边界**：WS `auth` 帧 + REST `Authorization: Bearer`，均用 `crypto/subtle.ConstantTimeCompare` 常量时间校验（token 现在是主防线，防时序侧信道）。
- workdir 白名单：`config.IsAllowedWorkdir` 用 `filepath.Rel` + `..` 前缀检查防路径越权；`/api/v1/fs` 和 attach 的 workdir 都受约束。
- 传输为明文 `ws://`（无 `wss://`）：绑 tailscale IP 时由 WireGuard 加密，绑 LAN IP 时为明文——**仅在可信网络使用**。Origin 检查跳过（Electron/Capacitor 跨 origin，web 浏览器直连也免检查）+ permissive CORS，均以 token + 私有网段不可达公网为前提。**Tailscale 仍是推荐方案**（自带加密+跨网），只是不再强制。web 门户在浏览器 HTTPS 页面下会因混合内容拦截 `ws://`——tailnet 内以 `http://` 提供门户或在 vibe-remoted 前置 TLS。

## 配置

服务端读 JSON（`vibe-remoted.example.json` 为模板），可用 `VIBE_REMOTED_BIND_ADDR`/`VIBE_REMOTED_TOKEN` 覆盖。**追加 claude 启动参数**：`claude_cmd` 是整条命令串，直接写 `"claude --dangerously-skip-permissions -c"`，按 shell 规则解析。

**可选 `claude_flags`**（`[{id,label,arg,default}]`）：客户端新建会话时在目录选择器里按 `label` 多选启动 flag，服务端按 `id` 查白名单把 `arg` 拼到 `claude_cmd` 后（**per-session**，每个会话独立；客户端只传 id、服务端查表拼接 = 零命令注入；`/api/v1/info` 只下发 id/label/default，不含 arg；冲突不去重、按声明顺序全拼）。`default` 控制初始勾选。`ResolveClaudeCmd`（`config.go`）是拼接入口，空 flags 时回退原 `claude_cmd`（向后兼容）。

客户端机器清单**三端各自存储**（同一份 `MachineConfig` schema，`[{name, addr, port, token}]`）：
- **桌面**：Electron userData 下的 `machines.json`（macOS: `~/Library/Application Support/vibe-remote/machines.json`），经 preload IPC 读写。
- **iOS**：Capacitor Preferences（key `vibe-remote.machines`）。
- **Web**：浏览器 `localStorage`（`vibe-remote.machines` + 每台机器 `vibe-remote.workdirs.<addr:port>`——web 会话=workdir 模型）。

## 前置条件与联调

- 所有机器（含 Mac 客户端）在同一 Tailscale tailnet（`tailscale up`）。
- 目标 Linux 需 `claude` + `tmux`（不需要 go，交叉编译部署）。
- 真机联调用 ssh config 的 `dev`（tailscale `100.95.191.101`）；vibe-remoted 托管为常驻 `tmux new-session -d -s vibe-remoted-daemon`。
- **本地无远程机冒烟**：macOS 本身有 PTY+tmux，用 `claude_cmd: "/bin/bash"` 代跑即可验证透传链路（纯字节透传不关心跑什么）。测试配置 `vibe-remoted.local.json`（无 tmux）/ `vibe-remoted.tmux.json`。
- **GUI 调试**：`VIBE_REMOTE_DEBUG_PORT=9222` 开 CDP 端口，用 CDP over WebSocket 驱动/检查 renderer（chrome-devtools MCP 在此 Electron 版本有调用故障，改用裸 CDP）。`VIBE_REMOTE_NO_DEVTOOLS=1` 禁自动开 DevTools。

## 状态

**第一期**（Mac 桌面 TUI 可用版）：验收 7 项真机通过，`.dmg` 已交付。

**三端结构化重构（阶段 0-3，已完成并合并 main）**：抽出 `@vibe-remote/core`（协议/客户端/REST/chat 深度解析内核）+ `@vibe-remote/ui`（React 视图）；桌面去 xterm 改走 headless 结构化聊天；mobile（Capacitor）切共享内核+视图升级；新建 web 端（Vite+React SPA + `cmd/vibe-portal` Go 静态门户）。三端共享 core+ui。web 端浏览器真机端到端验证通过（发消息→流式→工具卡片/diff/思考/成本）。参考蓝本：pi-web（结构化消息 + 富渲染）、VSCode Claude 插件（权限交互理念）。

**阶段 4（待办）**：结构化工具权限确认 + steering（运行中插队）。二者都要求把 headless 从「一次一 turn」升级为「长驻双向 stream-json 会话」（`--input-format stream-json` + stdin 不 close + interrupt 帧）。权限路径已确认：`--permission-prompt-tool` + 自写权限 MCP server（纯 CLI 可跑通，无需 SDK），claude 要用工具时调该 MCP 工具、经现有 events pub/sub 通道推客户端弹 allow/deny。`mountChat` 的 `onStop`（停止/中断）已留空实现，等这条线落地后接入。

未做（可选）：代码签名、app 图标、侧边栏轮询改推送、codex 多 agent 产品化、web 端 wss/TLS（当前明文 ws 靠 Tailscale 加密）。完整进展见 `REQUIREMENTS.md`。

### 第二批体验增强（已完成）

- 机器管理 app 内 UI（CRUD + 空状态引导 + 测试连接），不再手改 machines.json。
- 会话命名：默认名跟随 workdir，双击侧边栏内联重命名，名字存 tmux 用户选项 `@vibe_remote_name`（跟随 tmux 生命周期，重启/多端一致）。
- 后台会话提示：A 圆点兜底（非活动会话有字节到达即亮蓝点，任何 agent 通用）+ C hook 事件增强（notify 帧把圆点升级为 idle 绿/waiting 黄 + 可选桌面通知）。
- 重连体验：状态栏显示重连尝试次数 + 活动会话终端顶部断线横幅 + Retry now。

**事件基建（通用可扩展）**：`POST /api/v1/events`（Bearer 鉴权，body `{sessionId,kind,message?}`）+ Manager pub/sub 路由表 + notify 帧。`kind` 为开放枚举，未来带外事件（token 用量等）复用此通道。claude 进程已注入 `VIBE_REMOTE_SESSION_ID`/`VIBE_REMOTE_EVENTS_URL`/`VIBE_REMOTE_TOKEN`。

**⚠️ 故意留空（本期不实现）**：vibe-remoted 自动生成 hook 配置让 claude 带上（`--settings` 注入方式需真机验证 claude 版本合并语义）。当前靠手动配 hook 或手动 curl events 端点即可验证全链路；日后补「自动注入」一小段，前面基建全不用动。
