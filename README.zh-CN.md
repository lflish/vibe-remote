# vibe-remote

[English](./README.md) ｜ **简体中文**

一个跨端的「远程 Claude」客户端：远程 Linux 机器上跑 Claude Code CLI，
桌面端 / web 端 / iOS 端以**结构化聊天式富交互 UI** 连上去——工具卡片、并排 diff、
可折叠思考、token/成本、流式 markdown。三端共享同一套框架无关内核 + 同一套 React 视图。

详见 [REQUIREMENTS.md](./REQUIREMENTS.md) 和 [docs/protocol.md](./docs/protocol.md)。

## 架构

```
桌面端 (Electron) ┐
Web (Vite SPA)    ┼─ws(JSON分帧)─►  vibe-remoted (Go)  ──►  claude -c -p --output-format stream-json
iOS (Capacitor)   ┘  @vibe-remote/{core,ui}  每台机器一个     （一次 turn 一次 spawn；会话=workdir）
```

- **结构化事件，非 TUI 字节**：服务端跑 `claude -p --output-format stream-json`，把 claude
  **官方 NDJSON 协议**按行透传。客户端**只为显示而解析**（tool_use ↔ tool_result 配对、思考、成本）——
  解析的是官方结构化协议、不是 TUI 像素，所以「客户端不解析终端」的约束依然成立。
- **共享内核 + UI**：[`@vibe-remote/core`](./packages/core) 是协议、WS/REST 客户端、chat 解析器/状态机
  （零 DOM、可单测）；[`@vibe-remote/ui`](./packages/ui) 是 React 组件。桌面/web/iOS 都是它们之上的瘦壳。
- **唯一数据平面（headless 线）**：服务端在选定 workdir 下每 turn spawn 一次
  `claude -c -p --output-format stream-json` 并按行透传 NDJSON。会话以 **workdir** 为身份，
  连续性完全靠 claude 自己的 `-c`（读共享 jsonl）——无 tmux、无 PTY、服务端不持有会话状态。
- **无中心 Hub**：每台机器各跑一个 vibe-remoted，客户端直连。服务端绑私有网段地址（LAN / tailscale），
  静态 token 为准入核心；跨网/加密可交给 Tailscale。

## 主要特性

- **富交互聊天 UI**：流式 markdown、工具调用卡片（可折叠、成功/错误配色）、Edit/Write 并排 diff、
  可折叠思考块、token/成本栏——全部由 claude 的结构化 stream-json 渲染而来。
- **三端一套代码**：桌面（Electron）、web（浏览器 SPA + 极简 Go 静态门户）、iOS（Capacitor）
  都消费同一个 `@vibe-remote/core` + `@vibe-remote/ui`。
- **多机器**：侧边栏按机器分组带可达状态点；会话以 workdir 为身份（`claude -c` 续接该目录最近对话）。
- **断线重连**：状态栏显示重连进度，断线横幅 + Retry。
- **claude 参数预设**：服务端配 `claude_flags` 白名单，新建会话时页面多选（如 `-c` 续会话、跳过权限），per-session 生效。
- **app 内机器管理**：增删改机器 + 测试连接，不用手改机器清单文件。

## 目录结构

```
packages/core/   @vibe-remote/core — 框架无关共享内核（协议、WS/REST、chat 解析器）
packages/ui/     @vibe-remote/ui   — 共享 React 视图组件（ChatView、ToolCard、DiffToolCard…）
vibe-remoted/    Go 服务端（单二进制）+ cmd/vibe-portal（web 静态托管）
desktop/         Electron 客户端（core+ui 瘦壳）
mobile/          iOS 客户端（Capacitor，core+ui 瘦壳）
web/             Web SPA（Vite + React，core+ui 瘦壳）
docs/            协议文档
```

这是一个 npm workspaces monorepo，在根目录 `npm install` 一次即可。

## 服务端 vibe-remoted

### 构建

```bash
make server          # 产出 bin/vibe-remoted
# 或
cd vibe-remoted && go build -o ../bin/vibe-remoted ./cmd/vibe-remoted
```

### 配置

复制 `vibe-remoted.example.json` 并按机器修改：

```json
{
  "bind_addr": "192.168.x.x",      // 私有网段地址(RFC1918/loopback/link-local
                                    //   /tailscale 100.64.0.0/10)，校验强制
  "port": 8765,
  "token": "your-secure-token",     // 静态鉴权 token，准入核心边界（常量时间校验）
  "default_workdir": "/home/user",
  "allowed_roots": ["/home/user"],  // workdir 白名单，防越权
  "use_tmux": true,                 // 已废弃 / 已忽略（保留字段做旧配置向后兼容；headless 线不用 tmux）
  "claude_cmd": "claude",           // 基础命令，整串传给 shell
  "claude_flags": [                 // 可选：客户端新建会话时可多选的启动参数
    { "id": "continue",   "label": "续上次会话 (-c)", "arg": "-c",                             "default": false },
    { "id": "skip-perms", "label": "跳过权限确认",     "arg": "--dangerously-skip-permissions", "default": false }
  ],
  "login_shell": true,              // 通过登录 shell 启动，加载用户环境
                                    //   （PATH、fnm/nvm 等），默认 true
  "shell": "",                      // 登录 shell 路径，空=用 $SHELL 或 /bin/bash
  "allow_insecure_bind": false      // true 才允许绑公网地址(不建议)；wildcard 恒拒
}
```

**追加启动参数**：`claude_cmd` 是整条命令串，直接追加参数即可，例如
`"claude_cmd": "claude --dangerously-skip-permissions -c"`。因为通过登录 shell
以 `<shell> -lic 'exec <claude_cmd>'` 启动，参数按 shell 规则解析。

**参数预设（`claude_flags`）**：可选。配一组 `{id, label, arg, default}`，客户端新建会话时
在目录选择器里按 `label` 多选，服务端按 `id` 查白名单把 `arg` 拼到 `claude_cmd` 后
（**per-session**，每个会话独立）。客户端只传 id、服务端查表 = 零命令注入；`default` 控制初始勾选。
不配则退化为直接用 `claude_cmd`。

也可用环境变量覆盖：`VIBE_REMOTED_BIND_ADDR`、`VIBE_REMOTED_TOKEN`。

### 运行

```bash
./bin/vibe-remoted --config vibe-remoted.json
```

### 测试

```bash
cd vibe-remoted && go test ./...   # 单元测试（含路径越权防护）
```

## 客户端

三端共享 `@vibe-remote/core` + `@vibe-remote/ui`，在仓库根一次装好依赖：

```bash
npm install      # 装所有 workspace（packages/*、desktop、mobile、web）
```

每台机器用 `name / addr / port / token` 通过 app 内机器管理配置（增删改 + 测试连接）。
清单存于各端本地存储（桌面走 Electron userData、iOS 走 Capacitor Preferences、web 走 `localStorage`）。

### 桌面端（Electron）

```bash
npm run dev --workspace=vibe-remote      # Vite + Electron 热重载
npm run build --workspace=vibe-remote    # tsc + vite build + electron-builder → .dmg
```

### Web（SPA + Go 门户）

web 端是静态 SPA；一个极简 Go 二进制（`vibe-portal`）用 embed 打包并托管它。
浏览器加载页面后直连各机器的 vibe-remoted `ws://`（由 Tailscale 加密）。

```bash
npm run dev --workspace=@vibe-remote/web  # Vite dev 服务器
make portal                               # 构建 web/dist + embed → bin/vibe-portal
./bin/vibe-portal -addr 127.0.0.1:9000    # 起门户，用浏览器打开该 URL
```

### iOS（Capacitor）

```bash
npm run build --workspace=vibe-remote-mobile   # tsc + vite build
cd mobile && npx cap sync ios                  # 同步 web 产物到 Xcode 工程，再用 Xcode 构建
```

### 测试

```bash
npm test                    # 所有 JS workspace（core / ui / mobile / web）
npm run typecheck           # 所有 workspace
```

## 前置条件

- 客户端与目标机网络互通即可：同一 **Tailscale tailnet**（推荐，自带加密+跨网）
  或同一**可信局域网**（LAN 内 `ws://` 明文，仅在可信网络使用）。
- 目标 Linux 具备 `claude`；`tmux` 不再需要（headless 线不用 tmux）。`go` 只在构建
  vibe-remoted / vibe-portal 时需要，运行不需要（交叉编译后拷二进制过去）。
- 走 Tailscale 时，Mac 端需运行（`tailscale up`）。
- 浏览器在 HTTPS 页面下无法连明文 `ws://`（混合内容限制）。web 门户请在 tailnet 内以
  `http://` 提供，或在 vibe-remoted 前置 TLS。

## 本地开发冒烟（无需远程机）

macOS 可本地起 vibe-remoted 对真 `claude` 冒烟——无需 tmux、无需远程机。

### Web 门户冒烟

在一台机器上验证完整结构化链路（浏览器 → vibe-portal → vibe-remoted → 真 claude →
stream-json → 聊天富交互 UI）：

```bash
# 1) 配置：绑 loopback、真 claude
cat > /tmp/vibe-remoted.headless.json <<'EOF'
{"bind_addr":"127.0.0.1","port":8799,"token":"smoke",
 "default_workdir":"/tmp","allowed_roots":["/tmp","/Users"],
 "claude_cmd":"claude --dangerously-skip-permissions","login_shell":true}
EOF
./bin/vibe-remoted -config /tmp/vibe-remoted.headless.json &

# 2) 构建并托管门户
make portal
./bin/vibe-portal -addr 127.0.0.1:9100 &

# 3) 浏览器打开 http://127.0.0.1:9100，添加机器（127.0.0.1 / 8799 / smoke），
#    「+ 选目录开聊」→ 发消息 → 验证工具卡片 / diff / 思考 / 成本正确渲染。
```

## 开源协议

[MIT](./LICENSE) © 2026 lflish
