# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目本质

vibe-remote 是一个「远程 Claude」工具：真正的 `claude` CLI 始终跑在**远程 Linux** 上，桌面 / web / iOS 三端以**结构化聊天式富交互 UI** 连上去。三端是 npm workspaces monorepo，共享一套框架无关内核 `@vibe-remote/core` + 一套 React 视图 `@vibe-remote/ui`；各端只是薄壳。

**唯一数据平面：headless 结构化线**。服务端跑 `claude -p --output-format stream-json`，把 claude **官方 NDJSON 协议**按行透传；客户端用 `core` 的 parser/session **解析成结构化消息**（tool_use↔tool_result 配对、thinking、cost），`ui` 渲染成工具卡片/diff/思考/成本。**解析的是官方结构化协议，不是 TUI 像素** —— 所以「客户端不解析终端」的原则仍成立（解析仅用于显示）。会话以 **workdir** 为身份（`claude -c` 续接该目录最近对话），无 tmux / PTY / sessionId 概念。

历史上曾有一条 **TUI 字节透传线**（PTY→tmux→claude + xterm 哑终端）作为逃生舱，已于 2026-07-28 完全删除。现在服务端不启 tmux、不管 PTY，`use_tmux` 配置字段虽保留（向后兼容旧配置）但**不再被消费**。

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

### headless turn 模型（每 turn spawn claude）

无常驻进程、无 tmux。一个 `attach` 绑定一个 workdir；每收到一个 `data` 帧（用户 prompt）就在该 workdir 下 spawn 一次 `claude -c -p --output-format stream-json --include-partial-messages --verbose`（prompt 经 stdin 传入），把 claude 的 NDJSON 输出**按行**作为 `data` 帧转发，进程退出后发 `exit` 帧并等下一个 `data`。会话连续性完全靠 claude 自己的 `-c`（续接该 workdir 最近 jsonl），服务端不持有会话状态。

- **exit 帧语义**：`exit` 帧表示「本次 turn 的 claude 进程退出」（一次响应结束），不是会话销毁——客户端收到后仍可继续发下一个 prompt。
- 相关文件：`vibe-remoted/internal/session/headless.go`（spawn + 逐行转发）、`manager.go`（构造 HeadlessRunner + 注入事件环境变量）、`ws.go`（握手 + turn 循环）。

### 协议（单一事实来源：docs/protocol.md）

JSON 分帧 WebSocket，帧靠 `type` 区分，data 帧 payload 走 base64。**TS 单一事实来源在 core**：`packages/core/src/protocol.ts`（不再是 `desktop/src/shared/protocol.ts` —— 那已退化为 re-export core 的薄壳）与 Go 端 `vibe-remoted/internal/protocol/protocol.go` **手工对齐**（无代码生成）—— 改协议时两端都要改，并同步 `docs/protocol.md`。

握手时序：`auth`（首帧，10s 超时）→ 客户端可空闲浏览（ping/pong 保活，**无 attach 超时**）→ `attach`（带 workdir + flags）→ `ready` → 双向 `data`（C→S 一条 prompt 触发一次 turn，S→C 是 claude stream-json 的 NDJSON 行）。

帧类型收敛：仅 `auth / attach / data / ping / pong / ready / exit / error`。原 `resize / sessions / notify` 及 `attach.mode / attach.sessionId / attach.cols/rows / ready.sessionId` 字段在 TUI 线删除时一并去除。

辅助 REST（Bearer token 鉴权）：`/healthz`、`/api/v1/info`（主机名/默认 workdir/allowed_roots/claude_flags）、`/api/v1/fs?path=`（远程目录选择器，受 workdir 白名单约束）、`/api/v1/history?path=&limit=`（读该 workdir 最近 jsonl，聊天 UI 用它做历史回填）。原 `/api/v1/sessions*` 与 `/api/v1/events` 已删除。

### 客户端会话模型

`desktop/src/renderer/index.ts` 的 **SessionView** 抽象：每个打开的会话 = **独立 WebSocket（`VibeRemoteClient` from core）+ 独立聊天挂载点（ui 的 `mountChat` 挂 ChatView）**。切换会话 = 显示/隐藏对应挂载点容器，未聚焦会话在服务端 headless 端保活（`claude -c` 续会话）。所有机器级 Map 用 **`addr:port`（machineKey）** 做 key（不是 addr，防同主机多端口冲突）。

**会话 = workdir**：一个 workdir = 一条聊天线（`claude -c` 续接该目录最近对话），无 sessionId、无 tmux 会话概念。三端侧边栏都按 workdir 列表组织——桌面走 preload IPC 存 Electron userData、iOS 走 Capacitor Preferences、web 走 `localStorage`（`vibe-remote.workdirs.<addr:port>`）。

`client.attach(workdir?, flags?)` 是唯一签名（headless 唯一线）。`data` 帧 payload：S→C 是 base64 的 NDJSON 文本，经 `mount.feed()` → `makeLineSplitter` → `ChatSession.applyLine` 累积成结构化消息；C→S 是 base64 的用户 prompt。三端 chat 视图都用同一个 `mountChat`。

`client.ts` 重连：指数退避，`reconnectAttempt` 在收到 **`ready`（连接确认健康）后才归零**（不是 onopen —— 否则坏 token 每秒锤服务端）。重连按 `lastAttach = {workdir, flags}` re-attach，`pendingAttach` **必须带 workdir**（曾因丢 workdir 导致新会话总落默认目录）。

### 编解码工具（`@vibe-remote/core/base64`）

`base64ToBytes` / `bytesToBase64` / `base64ToText` / `textToBase64` 已上提到 core（三端共用）。当前 data 帧承载的是 **文本**（S→C 的 NDJSON 行 / C→S 的用户 prompt）：S→C 侧用 `base64ToText` 解出，C→S 侧用 `textToBase64` 编码——不涉及二进制字节流，无 UTF-8 拆坏风险。

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
- 目标 Linux 需 `claude`（无需 `tmux`——headless 唯一线不用 tmux；也不需要 go，交叉编译部署）。
- 真机联调用 ssh config 的 `dev`（tailscale `100.95.191.101`）；vibe-remoted 托管为常驻 `tmux new-session -d -s vibe-remoted-daemon`。
- **本地无远程机冒烟**：见 README 的「Web-portal smoke」章节（绑 loopback + 真 claude + `make portal` 起门户，浏览器发一条消息验证完整结构化链路）。
- **GUI 调试**：`VIBE_REMOTE_DEBUG_PORT=9222` 开 CDP 端口，用 CDP over WebSocket 驱动/检查 renderer（chrome-devtools MCP 在此 Electron 版本有调用故障，改用裸 CDP）。`VIBE_REMOTE_NO_DEVTOOLS=1` 禁自动开 DevTools。

## 状态

**第一期**（Mac 桌面 TUI 可用版）：验收 7 项真机通过，`.dmg` 已交付（历史里程碑，TUI 线代码已删除）。

**三端结构化重构（阶段 0-3，已完成并合并 main）**：抽出 `@vibe-remote/core`（协议/客户端/REST/chat 深度解析内核）+ `@vibe-remote/ui`（React 视图）；桌面去 xterm 改走 headless 结构化聊天；mobile（Capacitor）切共享内核+视图升级；新建 web 端（Vite+React SPA + `cmd/vibe-portal` Go 静态门户）。三端共享 core+ui。web 端浏览器真机端到端验证通过（发消息→流式→工具卡片/diff/思考/成本）。参考蓝本：pi-web（结构化消息 + 富渲染）、VSCode Claude 插件（权限交互理念）。

**阶段 4（待办）**：结构化工具权限确认 + steering（运行中插队）。二者都要求把 headless 从「一次一 turn」升级为「长驻双向 stream-json 会话」（`--input-format stream-json` + stdin 不 close + interrupt 帧）。权限路径已确认：`--permission-prompt-tool` + 自写权限 MCP server（纯 CLI 可跑通，无需 SDK），claude 要用工具时调该 MCP 工具、经带外通道推客户端弹 allow/deny。`mountChat` 的 `onStop`（停止/中断）已留空实现，等这条线落地后接入。

**TUI 逃生舱线删除（2026-07-28，已合并 main）**：服务端 `wsRelay` / `wsOpenTUI` / runner（PTY）/ tmux 集成 / `/api/v1/sessions*` / `/api/v1/events` 全删；客户端 `resize` / `sessions` / `notify` / `mode` / `sessionId` / `cols/rows` 全删；三端侧边栏改按 workdir 组织。headless 结构化线是**唯一数据平面**。核心净删 -1351 行 Go。带外通道（原 `/api/v1/events`）一并删；`Manager.SetEventEnv` 环境变量注入保留，供未来 hook / 权限 MCP 复用。

未做（可选）：代码签名、app 图标、侧边栏轮询改推送、codex 多 agent 产品化、web 端 wss/TLS（当前明文 ws 靠 Tailscale 加密）。完整进展见 `REQUIREMENTS.md`。

### 第二批体验增强（部分已随 TUI 线删除）

- 机器管理 app 内 UI（CRUD + 空状态引导 + 测试连接）：**保留**。
- 会话命名（默认名跟随 workdir，名字存 tmux 用户选项 `@vibe_remote_name`）：**已随 TUI 线删除**——headless 会话身份 = workdir，直接用目录路径展示，无独立命名。
- 后台会话提示 A 圆点 + C hook notify 升级：**已随 TUI 线删除**（依赖 `/api/v1/sessions` 会话列表 + `/api/v1/events` + `notify` 帧）。将在阶段 4 权限 MCP 带外通道落地后按需重接。
- 重连体验：状态栏显示重连尝试次数——保留（断线提示由 chat UI 层承担）。

**事件基建（原通用通道，已删）**：原 `POST /api/v1/events` + Manager pub/sub 路由表 + `notify` 帧随 TUI 线一并删除。**保留**的是 `Manager.SetEventEnv` 环境变量注入机制（`VIBE_REMOTE_EVENTS_URL` / `VIBE_REMOTE_TOKEN`，当 Manager 未配 eventsURL 时自动跳过注入），供阶段 4 权限 MCP / hook 重新接入带外事件时复用——届时补一个新的接收端点即可，注入侧不用动。
