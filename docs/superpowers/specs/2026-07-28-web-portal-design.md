# 网页版（ChatGPT 式门户）设计

日期：2026-07-28
状态：设计讨论中（含参考 pi-web 后的技术栈修订 + review 后的断言校正），待用户审阅

> **review 校正（2026-07-28）**：本文档初稿把若干**未经真机验证的假设**写成了「已就绪、可复用」。经对照代码库核实，下列断言需降级或修正，已在正文对应位置标注 ⚠️：
> 1. slash_commands 链路（见「slash 命令」节）——现有 `stream.ts` 主动丢弃 `system` 事件，headless 是否下发 `slash_commands` **未验证**。
> 2. `client.ts "可直接搬"`（见「文件结构」节）——mobile/ 无 client.ts，desktop 那份是 TUI/PTY 专用，不适用 headless。
> 3. token 存 localStorage 的安全含义（见新增「安全模型」节）。
> 4. 混合内容（mixed content）对「浏览器直连后端」的潜在影响（见「架构」节）。
> 5. **【架构级】headless 无「会话列表」——「会话 = workdir」（方案 A 已定）**。核实发现：`Manager.List`（`listSessions`）**只列 tmux 会话**，而 `HeadlessRunner` 明确「no tmux session」；headless 的会话身份就是 workdir（`wsHeadless`："Identity for headless is just the workdir"，`sessionId` 被忽略），`-c` 只 continue 该目录最近一次对话，同 workdir 无法并存多会话。因此**侧边栏的「多会话」模型不成立**，已按方案 A 重构为「会话 = workdir」（见新增「会话模型（方案 A）」节，布局图 / 验收标准 2、5 同步修订）。
>
> **动工前置**：先真机跑一次 `claude -c -p --output-format stream-json --verbose`，抓原始 NDJSON 存档，确认 `system/init` + `slash_commands` 的实际结构。此步同时消解 1、2 两处最大不确定性。

## 背景与目标

vibe-remote 已有 headless 聊天线（`mobile/` 那套纯 TS web 代码）和 iOS Capacitor 壳。现调整优先级：**降低 iOS 原生打包优先级，先做一个相对完善的网页版**。

网页版形态：**ChatGPT 式聊天网页**——左侧边栏（多机器 + 各自会话）+ 右主聊天区，底层连**多台远程机器**的 headless claude。参考 pi-web（github.com/agegr/pi-web）的聊天 Web 交互（三栏布局、ChatInput 的 slash/@补全、SSE 状态推送、CSS 令牌+主题、移动端断点），但突出 vibe-remote 独有的"多远程机器"能力。

**技术栈决策（参考 pi-web 后修订）**：网页版用 **React + Vite** 从头写一个新前端 `web/`，追求 pi-web 级精致度。pi-web 是 React 生态，其 ChatInput/markdown 管线/状态机可最大化直接参考移植；选 Vite 而非 Next 因为我们是纯静态门户 + 独立 Go 后端，不需要 SSR/API routes。**不再是 mobile/ 就地升级**——现有 mobile/ 与 desktop/ 的纯 DOM 前端代码不被 web/ 复用（复用发生在 Go 协议/后端与设计思路层面，不在前端组件层）。

关键洞察：手机端不再需要 Capacitor 原生壳——手机浏览器直接打开门户 URL（或加到主屏）即可，响应式布局手机桌面通吃。iOS 原生打包工作量因此可砍。

## 需求锁定（经澄清）

- **形态**：ChatGPT 式聊天，双栏布局（响应式：窄屏侧边栏变抽屉）
- **技术栈**：React + Vite（新前端 `web/`），复用 Go 协议/后端而非前端组件
- **访问**：Tailscale 网内，浏览器打开**一个中心门户 URL**
- **托管**：独立门户前端（方案 B1，极简 Go 静态服务单二进制），连后端 N 台 vibe-remoted
- **传输**：明文 ws，由 Tailscale（WireGuard）加密——机器分散在不同网络、需在外面连，**Tailscale 必须保留**（既是加密也是跨网可达基础）
- **会话模型（方案 A：会话 = workdir）**：headless 无 tmux 会话、无独立会话 id，一个 workdir = 一条聊天线（`claude -c` 接该目录最近对话，`ReadHistory` 读该目录最近 jsonl）。侧边栏每台机器下列的是 **workdir 列表**（非 tmux 会话），「+ 选目录开聊」= 选目录新开一条线。不新造存储层，但 `listSessions`（列 tmux）**不适用 headless 导航**，workdir 列表数据源需另定（见「会话模型（方案 A）」节）。
- **slash 命令**：前端补全菜单（从 headless `system/init` 事件的 `slash_commands` 数组解析），支持 prompt 展开类 / 自定义命令；TUI 交互类（`/clear`/`/compact`）headless 下无解，菜单不列
- **语音输入**：本期不做（pi-web 实测无此功能可参考；浏览器原生方案留后续）
- **底层数据流**：复用现有 headless 线（attach mode=headless → `claude -c -p --output-format stream-json` → NDJSON 按行转发 → 前端解析）。Go 协议 `protocol.ts`/`protocol.go`、stream-json 解析规则、jsonl 历史端点均已就绪，React 前端重新实现消费层。

## 架构：门户 + 多后端

```
        浏览器（门户 URL, http://<portal-tailscale-ip>:9000/）
             │ ① 加载网页 HTML
             ↓
   ┌──── 门户前端（B1: 极简 Go 静态服务, 单二进制 cmd/vibe-portal）────┐
   │      embed 网页产物 + http.FileServer，不碰会话                  │
   └──────────────────────────────────────────────────────────────┘
             │ ② 浏览器直连各机器 ws（明文, WireGuard 加密）
   ┌─────────┼─────────┐
   ↓         ↓         ↓
 vibe-remoted A   B   C   （各跑 headless claude，Tailscale IP，完全不改）
```

三个独立单元：

1. **门户前端**（新增 `vibe-remoted/cmd/vibe-portal/main.go`，~40 行）：`embed` 打包 web 产物 + `http.FileServer` 托管。交叉编译扔到门户机（用户 Mac 或某台）。**不参与任何会话数据流**——只在浏览器首次加载 HTML 时需要。
2. **网页应用**（`web/`，React + Vite 从头新写，**不复用** mobile/ 前端组件）：桌面双栏布局 + 多机器侧边栏 + slash 菜单 + 响应式抽屉。复用只发生在 Go 协议/后端与设计思路层面，前端纯逻辑（stream/lines/commands 等）从 mobile/ **移植并 React 化**（非照搬）。machines 列表存浏览器本地存储。
3. **vibe-remoted**：完全不改，各机器照跑 headless。

关键性质：
- 门户挂了不影响已打开的页面（ws 直连后端）；门户只在首次加载时需要。
- 任一后端机器挂了只影响那台会话，其他照常。
- 浏览器直连各后端，连接/重连都在前端（headless WS 封装需新写，见「文件结构」⚠️）。
- ⚠️ **混合内容约束**：本期门户走 `http://`，浏览器直连后端 `ws://` 正常。**但一旦门户日后升级 https，浏览器会直接 block 页面里的 `ws://` 连接（mixed content）**——届时「浏览器直连各后端」这一核心架构会崩，必须同步给各后端上 `wss://`。加 TLS 时务必成对处理门户与后端，不能只升门户。

## 会话模型（方案 A：会话 = workdir）

⚠️ 这是 review 阶段暴露、动工前必须先定的**架构级决策**。初稿布局图把侧边栏画成「机器 ▸ 会话1/会话2/+新建」，暗含「一台机器有多个可枚举、可并存的会话」——但 headless 后端不是这样：

**核实到的后端事实**：
- `Manager.List`（即 `listSessions` REST）的会话表**唯一来源是 tmux**（`liveTmuxSessions()`），而 `HeadlessRunner` 明确 "holds no long-lived process and **no tmux session**"。→ headless 会话**根本不出现在 `listSessions` 里**。
- headless 的会话身份**就是 workdir**：`wsHeadless` 注释 "Identity for headless is just the workdir"，attach 帧的 `sessionId` 被忽略（"may be empty; workdir is the real key"）。
- `-c` = continue **most recent** conversation；`ReadHistory` 读**最近修改的** jsonl。→ 同一 workdir 下**无法区分/并存多个** headless 会话，只有「这个目录的最近对话」这一条。

**决策：会话 = workdir。** 一个 workdir 一条聊天线，语义与 headless 现状完全对齐，**vibe-remoted 零改动**。

- **侧边栏列表数据源**（不能用 `listSessions`，它列 tmux）：候选 —— (a) 客户端本地记录「用户在该机器开过的 workdir」存 localStorage（随 machines 一起）；(b) 新增/复用一个「扫 `~/.claude/projects` 下有历史 jsonl 的目录」的只读端点。**本期取 (a)**：纯前端、零后端改动、够用；(b) 留作后续增强（自动发现历史目录）。
- **「+ 选目录开聊」**：复用 `/api/v1/fs` 远程目录选择器（已存在，受 workdir 白名单约束）选一个目录 → 加入侧边栏该机器分组 → attach（mode=headless, workdir=选中目录, sessionId 空）。
- **切换「会话」= 切 workdir**：断当前 headless ws、以新 workdir 建新连（headless 每轮一进程，本就不保活）。
- **同 workdir 不重复开**：侧边栏点已存在的 workdir = 聚焦,不新建。
- **后台圆点**：headless 非 attach 期无进程、无字节流,桌面端「A 圆点」机制(靠 PTY 字节到达)**不适用**——本期后台提示能力受限,如需保留需另走 events 端点,列为可选/后续。

## 布局：ChatGPT 式双栏

```
┌────────────────┬──────────────────────────────────────┐
│ vibe-remote  ⚙ │  会话标题 · 机器名                      │  ← 顶栏
│                │                                        │
│ ▼ 机器A 🟢     │   历史气泡(灰) / 用户气泡(右)           │
│   · ~/proj-a   │   🔧 工具卡片 / assistant(markdown)     │
│   · ~/proj-b   │                                        │
│ + 选目录开聊   │   $0.02 · 212→80 tok                   │
│ ▼ 机器B 🔴离线 │  ┌──────────────────────┐ ┌────┐      │
│ ▼ 机器C 🟢     │  │ 输入框(自适应, / 唤起菜单)│ │发送│      │
│   · ~/work     │  └──────────────────────┘ └────┘      │
└────────────────┴──────────────────────────────────────┘
     侧边栏(~260px, 可折叠)          主聊天区
```

「会话1/会话2」在方案 A 下即 workdir（见「会话模型」节），侧边栏列的是 workdir 列表。

**左侧边栏**：logo + ⚙（机器管理，复用 machines.ts CRUD）；每台机器分组（机器名 + 🟢/🔴 状态点，复用 6s 超时探测）；机器下列 **workdir 列表**（数据源见「会话模型（方案 A）」节，**非** `listSessions`——那列 tmux）；每组"+ 选目录开聊"（复用 `/api/v1/fs` 远程目录选择器，受 workdir 白名单约束）；后台新字节亮圆点（可选，复用桌面 A 圆点）。

**右主聊天区**：顶栏（workdir + 机器名）；消息区（复用 renderMessage：历史/用户/工具卡片/markdown assistant）；底部成本行 + 自适应输入框 + 发送（复用现有 composer）。

**响应式**：窄屏（手机浏览器）侧边栏变抽屉（汉堡切换），主区全宽——同一份网页手机好用。

## slash 命令（前端补全菜单）

⚠️ **本节是待真机验证的技术假设，非既成事实。** 核实代码库发现两个反证：(a) `headless.go` 只构造 `-c -p --output-format stream-json --include-partial-messages --verbose`，未见 slash_commands 相关处理；(b) `mobile/src/stream.ts` **主动把 `system` 事件当噪音过滤掉**（注释原文标注 `'system'` 为 "noise for the chat view"）。即现有解析层不但没解析 `system/init`，还丢弃它。因此下面的链路能否成立，取决于前置真机抓包的结果。

**假设链路**（待验证）：
- attach 后第一个 NDJSON 是 `system/init`，含 `slash_commands` 数组 → 解析存下该会话可用命令。
- 输入框监听 `/` 开头 → `filterCommands(all, query)` 过滤 → 浮层菜单（键盘上下选、Enter 确认）→ 填入输入框。
- 发送时命令跟普通 prompt 一样走 stdin。
- 仅支持 prompt 展开类 / 自定义命令；TUI 交互类不列（headless 无 TUI 前端，那类会被当普通文本发给模型）。

**兜底方案**（若真机确认 headless 不下发 slash_commands，或结构不符）：
- 降级为**前端静态命令表**（内置常见 prompt 展开类命令），或从各机器约定的配置端点拉取，menu 交互不变。
- 最坏情况本期砍掉 slash 菜单（验收标准第 3 条相应移除），发消息链路不受影响。
- 无论哪条，React 侧解析层**不能沿用 mobile/ 丢弃 `system` 事件的逻辑**——需保留 init 事件用于命令解析。

## 多机器连接管理

- 侧边栏每台机器一个 `VibeRemoteRest`（REST 探活 + 拉 history）+ 状态点。机器级状态用 `addr:port`（machineKey）做 key，防同主机多端口冲突。**workdir 列表来自本地存储（方案 A 数据源 a），不调 `listSessions`。**
- 只有**当前打开的 workdir**建 `VibeRemoteClient`（WebSocket）。切 workdir = 断旧连、建新连（headless 每轮一进程，无需保活多条 ws）。其他机器只靠 REST 探活。

## 错误处理

- 门户不可达 → 浏览器打不开页面（用户可知）；已打开页面不受影响。
- 机器离线 → 侧边栏 🔴 + workdir 不可点；不影响其他机器。
- ws 断线 → 复用 client.ts 指数退避重连 + 顶部断线横幅（复用桌面端）。
- headless 进程异常 → 复用 error 帧 → 聊天区提示。
- NDJSON 畸形行 → 跳过不崩（复用现有容错）。

## 安全模型（相对 desktop 的降级与缓解）

⚠️ 门户方案把 machines 列表（**含各机器明文 token**）从 desktop 的 Electron userData 文件（`machines.json`，文件系统隔离）挪到了**浏览器 localStorage**。这是一处安全降级，须明确承认：

- **风险**：localStorage 里的明文 token 任何 XSS 都能读走。而门户要渲染 claude 输出的 markdown + 工具卡片，XSS 面不小——一旦某条注入执行，攻击者可窃取所有已配机器的 token（= 各远程机 claude 完整准入）。
- **缓解（本期应做）**：
  - markdown/工具卡片渲染走**严格净化**（React 默认转义 + 显式 sanitize，禁 `dangerouslySetInnerHTML` 裸用）。
  - 配 CSP（限制 script-src、connect-src 仅允许已知 tailscale 网段）。
  - token 输入框 `type="password"` 不回显（沿用 mobile/machines.ts 现有做法）。
- **前提仍成立**：整体仍以 Tailscale 网内不可达公网为大前提；此节讨论的是「门户被打开后」的前端侧攻击面，非网络侧。
- **后续可选**：token 不落 localStorage、改为每次会话手动输入或走门户侧代理鉴权（会改变「门户不碰数据流」的架构，本期不做）。

## 测试策略

- 门户 Go 二进制：单测"`/` 返回 index.html""静态资源 200""SPA fallback"。
- 前端纯逻辑（Vitest）：`filterCommands`（slash 过滤）、stream-json 解析、NDJSON 分行、消息累积、多机器 machineKey 组织、**workdir 列表增删/去重（方案 A）**——这些逻辑从现有 mobile/ 移植为 React 侧的纯模块 + hooks。
- 端到端：Playwright 起门户 → 连本机真实 vibe-remoted → 选目录开聊 → `/` 弹菜单 → 发消息流式回复 + 成本。

## 文件结构

- **新建** `vibe-remoted/cmd/vibe-portal/main.go`：门户静态服务二进制（embed `web/dist` + FileServer + SPA fallback）
- **新建** `web/`（React + Vite，独立于 mobile/）：
  - `src/lib/`：纯逻辑（从 mobile/ 移植并 React 化）——`stream.ts`（stream-json 解析，⚠️ **须保留 `system/init` 事件**，勿沿用 mobile/ 丢弃 system 的逻辑）、`lines.ts`（NDJSON 分行）、`commands.ts`（解析 init 的 slash_commands + `filterCommands` 纯函数，见「slash 命令」⚠️）、`client.ts`（headless WS 封装，⚠️ **需新写**：mobile/ 无 client.ts，其 WS 逻辑散在 `main.ts`/`chat.ts`（~73 行，很薄）需抽取重写；desktop 的 `client.ts`（270 行）是 TUI/PTY 专用——epoch 代际、cols/rows re-attach、base64 光标控制——headless 门户完全用不到，**不要照搬**）、`rest.ts`（探活 + history + `/api/v1/fs` 目录选择器；**不含 listSessions**，方案 A 用不到）、`storage.ts`（机器清单 + **每台机器的 workdir 列表**，均存 localStorage）
  - `src/hooks/`：`useChatSession`（WS 事件 → 消息状态 reducer，参考 pi-web useAgentSession）、`useMachines`（含各机器 workdir 列表增删，方案 A）、`useIsMobile`
  - `src/components/`：`AppShell`（双栏+响应式抽屉）、`Sidebar`（多机器分组 + **workdir 列表** + 状态点 + 「选目录开聊」）、`ChatWindow`（消息流）、`MessageView`（复用 markdown 渲染，React 化，参考 pi-web markdown 管线）、`ChatInput`（自适应+slash 菜单，参考 pi-web ChatInput）、`MachineManager`（CRUD，移植 machines.ts 逻辑）、`DirPicker`（`/api/v1/fs` 远程目录选择，「选目录开聊」用）
  - Go `protocol.go` 的帧类型在 `src/lib/protocol.ts` 手动对齐（沿用现有两端对齐约定）
- **Go 后端与协议**：完全不改（headless 线、history 端点、mode 字段均已就绪）
- **构建产物**：`web/dist` 由 vibe-portal 的 embed 打包
- **Makefile**：加 `make portal`（`cd web && npm run build` + 编译门户二进制）

## 验收标准

Tailscale 网内：
1. 浏览器打开门户 URL → 看到双栏布局 + 侧边栏多机器列表（含在线/离线状态）。
2. 点某机器"+ 选目录开聊" → `/api/v1/fs` 选一个 workdir → 右侧打开聊天，加载该 workdir 历史；该 workdir 加入侧边栏列表。
3. 输入 `/` → 弹出命令补全菜单，选中填入。（⚠️ 依赖前置真机验证；若 headless 不下发 slash_commands，改为静态命令表或本条移除，见「slash 命令」节）
4. 发消息 → 流式看到 claude 回复（markdown）+ 工具卡片 + 成本。
5. 切换到另一台机器的另一个 workdir → 正确断旧连建新连、加载新 workdir 历史。
6. 手机浏览器打开同一 URL → 侧边栏变抽屉，聊天可用。

## 后续（非本期）

iOS 原生壳（已降优先级，未来可继续用 Capacitor 包 web/）、门户加简单登录门槛、后台会话推送圆点、公网 wss/TLS（若日后要脱离 Tailscale）。
