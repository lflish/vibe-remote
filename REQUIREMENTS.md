# vibe-remote 需求文档

> **⚠️ 当前状态（2026-07-28 更新）**：项目已经历一次三端结构化重构，**当前形态**（默认）是「结构化聊天式富交互 UI」而非 TUI 终端；下方「一、体验目标 → 十、验收标准」章节是**第一期 TUI 版**的原始需求，作为 **TUI 逃生舱线** 的规格保留（这条线在服务端 wsRelay 仍在，用于跑 vim/htop 等交互全屏程序）。当前实际交付形态、三端架构、共享内核等参见「第十一节 三端结构化重构（当前形态）」。

## 一句话定义

**当前**：一个「远程 Claude」跨端工具——远程 Linux 上跑 Claude Code CLI，桌面 / web / iOS 三端以**结构化聊天式富交互 UI**（工具卡片 / 并排 diff / 思考折叠 / 成本）连上去。三端共享一套框架无关内核 + React 视图。

**历史**（第一期 TUI 定义，见下方）：一个跨端的"远程 Claude 终端"客户端，桌面端像用本地 shell 一样连上去交互——现在这条线降级为可选的 TUI 逃生舱。

---

## 一、核心需求

### 1.1 体验目标
- 远程连接到跑在 **Linux 上的 Claude Code CLI**（`claude` 命令，交互模式）。
- 客户端交互体验**跟直接用 shell 访问 claude 一模一样**：
  - 原汁原味的流式输出（逐字/逐块吐字）
  - 保留颜色、光标控制、进度条等终端效果
  - 支持 `Ctrl+C` 中断当前生成
  - 支持终端 resize（窗口大小变化）
- 用 **交互模式**（`claude` 默认），**不用** `--print/stream-json`——只有交互模式才能还原完整 shell 体验。 <!-- ⚠️ 当前形态已改：headless 线默认用 `-p --output-format stream-json`；本条仅描述 TUI 逃生舱线的规格。见第十一节。 -->

### 1.2 实现原理
把远程 Linux 上的 `claude` 进程放进 **PTY（伪终端）** 里跑，PTY 的字节流通过长连接**双向透传**给客户端的终端组件。
- 流式是"免费"的：不解析内容，纯字节透传，所以能 0 失真还原 shell。
- **PTY 永远只在远程 Linux**，客户端只是"哑终端"（收发字节），不碰任何操作系统的 PTY API。

---

## 二、平台与分期

| 端 | 分期 | 说明 |
|----|------|------|
| **Mac 桌面** | **第一期** | 首个可用版本 |
| **Windows 桌面** | 第二期 | 客户端代码不变，仅换打包目标 |
| **移动端 iOS/Android** | 第三期 | 复用同一 WebSocket 协议，后端零改动 |

关键约束：因为后端协议中立、客户端是"哑终端"，Win/Mac/移动端跑同一套交互逻辑，**跨平台成本极低**。

---

## 三、已确认的关键技术决策

| 项 | 决策 | 理由 |
|----|------|------|
| **连接方式** | 自写 **Go 服务端 + WebSocket**（不走 SSH） | 协议自定义、可扩展；WebSocket 天然全双工，适配终端双向交互 |
| **网络拓扑** | **Tailscale 直连**，每台 Linux 各跑一个 `vibe-remoted`，**无中心 Hub** | 用户所有机器都在同一 tailnet，Tailscale(WireGuard) 已解决 NAT 穿透、点对点加密、移动端外网可达 |
| **会话保留** | **第一期就上 tmux 兜底** | 移动端锁屏/切后台易断网，断线重连恢复现场是刚需 |
| **会话模型** | **多会话 / 多机器**，后端数据结构一开始就按此抽象 | 用户明确要求"多机器上的多 claude 管理" |
| **机器发现** | 第一期**客户端手动机器清单**；第二期接 Tailscale API 自动发现 | 先能用，后优化 |
| **鉴权/加密** | `vibe-remoted` **绑私有网段地址**（拒公网+wildcard，不暴露公网）+ **静态 token** 准入核心（常量时间校验）；绑 tailscale IP 时 WireGuard 加密，LAN 为明文 | 安全暴露面收敛到私有网络内，token 为主防线 |
| **桌面外壳** | **Electron** | Windows 生态最稳；客户端是纯 xterm.js 哑终端，选型差异小 |
| **终端组件** | **xterm.js** | 网页终端事实标准 |
| **服务端语言** | **Go** | 单文件二进制、部署零依赖 |

---

## 四、多机器多 Claude 管理（核心能力）

- **每台机器**跑一个 `vibe-remoted`，只管自己这台，可承载**多个 claude 会话**。
- **客户端维护一份机器清单**：`[{名字, tailscale地址/MagicDNS, token}]`。
- 客户端遍历清单里各机器的 `vibe-remoted`，汇总各自会话，形成 **"多机器 × 多 claude" 总览**。
- 每台机器对等，客户端直连，**无中心 Hub**。

```
              Tailscale tailnet (WireGuard 点对点加密)
┌────────────────────────┐                    ┌──────────────────────────┐
│ 桌面端 (Mac→Win→移动)    │  ws(JSON分帧)      │ 机器1  vibe-remoted             │
│  Electron + xterm.js    │ ──键盘/resize──►   │   └ 会话×N: PTY→tmux→claude│──►Claude
│  (哑终端 + 机器清单)     │ ◄─PTY字节流──────  ├──────────────────────────┤
│                         │ ── 直连机器2/3 ──► │ 机器2/3 ... 各跑一个 vibe-remoted │
└────────────────────────┘                    └──────────────────────────┘
```

---

## 五、会话与连接行为需求

1. **会话持久化**：客户端断网/关闭窗口后，远程 claude 会话**不丢失**（tmux `new-session -A -s <id>` 兜底）。
2. **断线重连**：客户端指数退避**自动重连**，重连后 attach 同一 sessionID，**现场完整恢复**（上下文、屏幕内容都在）。
3. **多会话**：同一机器可开多个独立 claude 会话，可列表、新建、切换、关闭。
4. **resize 同步**：客户端终端尺寸变化时同步给远程 PTY，避免错行/重绘异常。
5. **中断**：`Ctrl+C` 字节能穿透 PTY→tmux→claude 正确中断当前生成。

---

## 六、通信协议需求（中立、多端复用）

- 一套**与客户端解耦的 JSON 分帧 WebSocket 协议**，任何端（桌面/移动/网页）都能接，移动端后期复用**后端零改动**。
- 消息类型至少覆盖：`auth`（鉴权）、`attach`（打开/恢复会话）、`data`（键盘输入/PTY输出，base64）、`resize`、`ping/pong`、`ready`、`sessions`（会话列表）、`exit`、`error`。
- 辅助 REST（每台 vibe-remoted 各自暴露）：`GET /api/v1/info`、`GET /api/v1/sessions`、`DELETE /api/v1/sessions/{id}`、`GET /healthz`。

---

## 七、安全需求

> 注：安全模型已放宽（见 CLAUDE.md「安全模型」）——从「只绑 tailscale」改为「绑私有网段 + token 准入」，以支持可信 LAN 直连。Tailscale 仍为推荐方案。

1. `vibe-remoted` **只监听私有网段地址**（RFC1918 / loopback / link-local / tailscale CGNAT），拒绝公网 IP（需 `allow_insecure_bind`）和 wildcard（`0.0.0.0`/`::`，恒拒），不暴露公网。
2. 传输：绑 tailscale IP 时由 **WireGuard** 加密；绑 LAN IP 时为 `ws://` 明文，仅在可信网络使用；可选再叠 `wss`。
3. **静态 token** 是准入核心边界（`auth` 帧 + REST Bearer，常量时间校验）。
4. 建议 `vibe-remoted` 以**专用受限用户 / 容器**运行（`claude` 带 Bash 工具 = 可执行任意命令）。
5. config 预留 per-machine 工作目录/权限约束。
6. 第二期可选用 `tailscale whois` 做 tailnet 身份鉴权。

---

## 八、环境前提（已核实）

- 目标 Linux 机器已具备：`claude` 2.1.157、`tmux` 3.4、`go` 1.26.2。
- 所有机器（含客户端设备）都在**同一 Tailscale tailnet**——这是连接的前提，需在文档写清。
- tmux 不可用时，config 提供"降级直跑 claude"开关。

---

## 九、非目标（本项目明确不做）

- 不做直连 Anthropic API / 不自己重写 Claude Code 的工具执行与渲染。
- 不做中心 Hub / 反向注册（Tailscale 已消除该需求）。
- 不解析 claude 的输出内容（纯字节透传）。 <!-- ⚠️ 当前形态：headless 线**为显示而解析**官方 stream-json（非 TUI 像素），本条约束仅对 TUI 线适用。见第十一节。 -->
- 第一期不做：Windows/移动端打包、Tailscale API 自动发现、身份鉴权。

---

## 十、验收标准（第一期 Mac 可用版）

1. 服务端本地起，`/healthz` 通。
2. 裸 WS 冒烟：连上后发 auth+attach，能收到 claude 欢迎界面字节流。
3. 桌面端联调：输入有回显、流式丝滑、多秒任务逐字流式、`Ctrl+C` 能中断、resize 无错行。
4. **会话保留**：交互到一半关窗重开 → 自动重连同会话 → 现场完整恢复。
5. **多会话/多机器**：同机开第二会话可切换；机器清单加第二台机器能连上其会话。
6. **断网重连**：中途断网，客户端自动重连并恢复。
7. 打包出 Mac `.dmg` 并冒烟通过。

---

## 十一、三端结构化重构（当前形态，阶段 0-3 已完成并合并）

### 11.1 定位转变

从「远程终端（TUI 字节透传）」转为「远程 Claude 的**结构化聊天式富交互 UI**」。参考蓝本：**pi-web**（结构化消息 + 富渲染）、**VSCode Claude 插件**（权限交互理念）。原 TUI 线保留为服务端逃生舱（跑交互式全屏程序）。

### 11.2 两条数据平面

- **headless 线（结构化，默认）**：服务端 `claude -p --output-format stream-json`，透传 claude 官方 NDJSON；客户端解析成结构化消息**仅用于显示**（不违反「不解析终端」——解析的是官方协议不是 TUI 像素）。
- **TUI 线（字节透传，逃生舱）**：原第一期 PTY→tmux→claude 全字节透传，服务端 wsRelay 保留。

### 11.3 三端 + 共享架构

- **monorepo**（npm workspaces）：`packages/core`（框架无关内核：协议/WS 客户端/REST/base64/机器校验/chat 解析器+状态机，零 DOM 可单测）+ `packages/ui`（共享 React 视图：ChatView/ToolCard/DiffToolCard/MarkdownBody/ChatInput/mountChat）。
- **桌面**（Electron）：去 xterm，renderer 挂共享 ChatView，默认走 headless。
- **web**（Vite+React SPA）：新建，复用 core+ui 只写外壳（Sidebar/App/机器管理/目录选择/localStorage）；`cmd/vibe-portal`（Go embed 静态托管）提供门户，浏览器直连各机器 headless ws。
- **iOS**（Capacitor）：切共享内核，视图升级到与桌面同级。

### 11.4 当前功能需求（已实现）

1. **富交互渲染**：流式 markdown、工具调用卡片（可折叠 + 成功/错误配色 + 参数摘要）、Edit/Write 并排 diff、可折叠思考块、token/成本栏。
2. **会话 = workdir**（headless 模型）：一个 workdir 一条聊天线（`claude -c` 续接该目录最近对话），无 tmux 会话概念；web 侧边栏 workdir 列表存 localStorage。
3. **历史回填**：进入会话读该 workdir 最近 jsonl（`/api/v1/history`）恢复对话。
4. **多机器**：侧边栏按机器分组 + 可达状态点（6s 超时探活）+ 「选目录开聊」（复用 `/api/v1/fs` 远程目录选择器）。
5. **机器管理**：三端 app 内 CRUD + 测试连接，校验/探活逻辑复用 core。
6. **三端一致**：同一 core+ui，聊天体验一致。

### 11.5 当前非目标 / 待办（阶段 4）

- **结构化工具权限确认**：claude 用工具时客户端弹 allow/deny。路径已定：`--permission-prompt-tool` + 自写权限 MCP server（纯 CLI，无需 SDK）；经现有 events pub/sub 通道推客户端。
- **steering（运行中插队）/ 停止中断**：`mountChat.onStop` 已留空实现待接入。
- 二者都要求 headless 从「一次一 turn」升级为「长驻双向 stream-json 会话」（`--input-format stream-json` + stdin 不 close + interrupt 帧）——这是阶段 4 的服务端核心改造。
- web 端 wss/TLS（当前明文 ws 靠 Tailscale 加密）；浏览器 HTTPS 页面的混合内容限制。
- @文件引用、slash 命令补全（需真机验证 headless 是否下发 `system/init` 的 `slash_commands`）、虚拟化消息列表。

### 11.6 验收（当前形态）

- 五包 typecheck 干净；core/ui/mobile/web 单测通过；Go 服务端测试通过。
- `make portal` 构建门户二进制；curl 冒烟（首页/SPA fallback/静态资源）通过。
- **web 端浏览器真机端到端**（已通过）：加机器 → 测试连接（✓ hostname）→ 选目录开聊 → 发消息 → 「正在思考」→ thinking 折叠块 → 正文 → 成本栏；localStorage 刷新持久。
