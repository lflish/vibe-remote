# 移动端适配（iOS MVP）设计

日期：2026-07-22
状态：设计已确认，待写实现计划

## 背景与目标

vibe-remote 现有桌面端（Electron + xterm.js）通过纯字节透传把远端 `claude` TUI 搬到本地哑终端。本设计为其新增**移动端（iOS 优先）**支持。

经需求澄清，移动端的真实场景是**碎片监控 + 轻回复**：人不在电脑前时，想瞄一眼远端 claude 跑到哪、随手回一句让它继续；并希望**把电脑端的会话继续在手机上工作**。

因此移动端 MVP 不追求"把桌面终端塞进手机"，而是做**聊天式的轻量交互**。

## 核心技术前提（已在本机实测验证）

claude CLI（实测版本 2.1.210）具备以下能力，构成本方案的物理基础：

- `-c/--continue` = "continue the most recent conversation in the current directory"，靠 **cwd + 时间**认会话，不依赖显式 session-id。
- 会话历史持久化在 `~/.claude/projects/<目录编码>/<session-id>.jsonl`，**不在运行进程里**。TUI 模式与 headless 模式只是读写同一份 jsonl 的两种方式。
- `--output-format stream-json`（配 `--verbose`）实时吐 **NDJSON 事件流**，逐 token 流式（`message_start` → `content_block_delta` → `message_stop` → `result`），与 TUI 打字机效果同源。流式/`--input-format stream-json`/`--include-partial-messages` 等**仅在 `-p/--print` 下有效**。

**实测结论**：headless `claude -c -p --output-format stream-json` 能成功续接一个已有会话（准确记得上一轮设置的暗号）、并逐 token 流式吐结构化 JSON。跨进程接力 + 流式，双双成立。

实测发现的三个设计要点：
1. `-c` 会新起一个 wrapper session_id，但 `result` 里 top-level `session_id` 仍是原始会话 id —— 会话身份连续。
2. 首个响应约 6s TTFT（加载历史/冷启），UI 需"思考中"loading 态。
3. headless 流里混有 hook 事件（`type:"system"` 的 `SessionStart:resume` 等）—— 手机端须按 `type` 过滤，只认 `stream_event`/`assistant`/`result`，忽略 `system`/hook 噪声。

## 整体架构：双线并存

现有架构完全不动，并联新增一条 headless 线：

```
                          ┌─ 线 A（现有，桌面）: PTY→tmux→claude(TUI) ──纯字节透传──┐
远端 Linux ─ vibe-remoted ─┤                                                       ├─ WebSocket
                          └─ 线 B（新增，移动）: claude -c -p --stream-json ──NDJSON按行转发─┘
                                                    ↑ 共享同一份 ~/.claude/projects/<dir>/*.jsonl
```

架构原则的延续：

- **线 B 服务端仍是"哑管道"** —— 只按行搬运 NDJSON，不解析。"解析"只发生在手机端展示层，且解析的是 claude **官方结构化协议**（stream-json），不是逆向 TUI 像素。**不违背 CLAUDE.md 的"纯字节透传/不解析 TUI"铁律**（铁律禁的是解析 TUI 输出）。
- **agent 无关性延续** —— 线 B 换 `codex -p` 或任何支持结构化流的 CLI 照样成立。
- **共享基础设施** —— token 鉴权、workdir 白名单、私有网段绑定、REST 端点、事件通道全部复用。
- **桌面端零改动** —— 移动端是纯增量。

## MVP 范围

**做**：一个 iOS App，Tailscale 网内连到现有 vibe-remoted，用聊天式 UI 接力/续接远端 claude 会话。

**明确不做**（留待 MVP 验证后）：移动端完整终端（线 A）、Android、App Store 上架、推送通知、语音输入、多机管理 UI 精修、双端并发写的强互斥锁。

## 六个 MVP 决策

### ① 形态：Capacitor 壳

复用现有 `desktop/src/renderer/` 的平台无关 Web 代码：

- `client.ts`（WebSocket 收发、重连、ping/pong）—— 浏览器原生 `WebSocket`，零改动
- `rest.ts`（REST 客户端）—— 浏览器原生 `fetch`，零改动
- `shared/protocol.ts`（协议类型）—— 零改动（仅新增 headless 帧字段）

套 Capacitor iOS 壳。唯一桌面专有依赖 `window.vibeRemote.getMachines/saveMachines`（Electron IPC 存 machines.json）换成 Capacitor Preferences，改动面 <10 行。

选 Capacitor 而非 PWA 的原因：PWA 要被"安装"需宿主页为 `https://`，但从 https 页发起明文 `ws://` = mixed content，被浏览器完全禁止；退回 http 页则 PWA 装不了。Capacitor 的 WebView 本地加载打包 HTML，绕开此死路。

### ② 网络：明文 ws + ATS 例外

走 Tailscale（复用现有安全模型：WireGuard 加密 + 私有网段 + token）。iOS `Info.plist` 配 ATS 例外允许明文 `ws://`（Capacitor 本地加载 HTML，无 mixed-content 约束）。MVP 不引入 wss/TLS。

### ③ UI：聊天式，单会话

- 会话列表页：REST 轮询各机器会话列表（复用现有 `/api/v1/sessions`）。
- 聊天视图：解析 NDJSON 的 `content_block_delta` 增量渲染打字机效果；`result` 帧显示成本/token（白送数据）；首响应期间显示"思考中"loading。
- 底部多行输入框 + 发送按钮。**不放 xterm**。
- 发送方向：手机每发一句 → 服务端起一个 `claude -c -p "<用户输入>" --output-format stream-json --verbose`（每轮一进程，跑完即退），契合"无状态/刷新即 -c"。MVP 不用长驻进程 + `--input-format stream-json`（那是多轮交互式喂输入的用法，留待后续按需引入）。

### ④ 接力：刷新即 `-c`，无状态

延续项目"tmux/文件是唯一事实来源，服务端内存可丢弃"的哲学：

- 手机每发一句 = 服务端在该 workdir 起一个 `claude -c -p "<输入>" --output-format stream-json --verbose`（每轮一进程），流式转发 NDJSON 后进程退出。
- 刷新/重开 App、每一轮发送 = 都重新 `-c` = 读到该目录最新 jsonl。**无需服务端"谁接管谁"的状态机，也无需长驻进程**。
- 与现有 attach 帧已带 workdir 的机制天然契合，几乎不改协议语义。
- 天然双向：桌面/手机谁想接手谁就刷新，最后写者赢，另一端刷新即同步。

**防分叉软标记**（MVP 可先只提示不强制）：手机接管时服务端标记该 tmux 会话"已被移动端接管"；桌面重新聚焦时横幅提示"此会话最近在移动端更新过，`-c` 刷新以同步"。前提约定：不两端同时活跃写（用户人只有一个，天然遵守）。

安全边界：`-c` 干净的前提是接力时另一端进程空闲/未在写。桌面 TUI 停在等输入态（碎片场景的典型）时接管安全；真正要防的是"接管后桌面 TUI 仍活着"回头一敲导致 jsonl 分叉——由上述软标记 + 约定覆盖。

### ⑤ 服务端改动（Go）

- attach 帧新增 `mode: "headless"` 字段（缺省 `"tui"`，向后兼容）。
- 命中 headless 时：收到用户输入即在指定 workdir 起 `claude -c -p "<输入>" --output-format stream-json --verbose`（每轮一进程，而非 tmux+TUI 长驻），按行转发 NDJSON 到 `data` 帧，进程退出后等下一轮。
- 现有 TUI 线（PTY→tmux→claude）**完全不动**。
- 协议两端手动对齐（无代码生成），同步更新 `docs/protocol.md`。

### ⑥ 手机端解析

按 `type` 过滤 NDJSON：只认 `stream_event`/`assistant`/`result`，忽略 `type:"system"` 及 hook 事件噪声。首响应 ~6s TTFT 需 loading 态。

## 组件边界

| 组件 | 职责 | 依赖 | 改动类型 |
|---|---|---|---|
| iOS Capacitor 壳 | 打包、ATS 配置、原生存储 | Capacitor | 新增 |
| 移动端聊天 UI | 会话列表 + 气泡视图 + 输入框 | client.ts / rest.ts | 新增 |
| NDJSON 解析层 | stream-json → 气泡增量 | protocol 类型 | 新增 |
| 存储适配 | machines 持久化 | Capacitor Preferences | 替换 <10 行 |
| client.ts / rest.ts | WS/REST 传输 | 浏览器原生 API | 复用零改动 |
| vibe-remoted headless 模式 | 启 claude -p + 转发 NDJSON | 现有 session/manager | 服务端新增 |
| protocol（两端） | attach 帧加 mode 字段 | — | 小改 + 文档同步 |

## 错误处理

- 首响应超时 / claude 进程异常退出：聊天视图显示错误气泡，可重试（重新 attach = 重新 `-c`）。
- WebSocket 断开：复用现有 `client.ts` 指数退避重连（`ready` 后归零 attempt）。
- headless 进程 crash：服务端发 exit 帧，手机端提示会话结束，可刷新重接。
- NDJSON 解析异常行：跳过该行不崩溃（哑管道容错）。

## 测试策略

- 服务端 headless 模式：Go 单测覆盖"attach mode=headless 启对命令""NDJSON 按行转发不粘包""workdir 白名单约束仍生效"。
- 本机冒烟：macOS 自带 PTY，用真实 `claude -p` 验证转发链路（已手工验证核心命门）。
- 端到端验收（见下）。

## MVP 验收标准

Tailscale 网内，iOS App：
1. 打开 → 看到远端会话列表。
2. 点进一个桌面开过的会话 → 聊天视图看到接上的上下文。
3. 发一句 → 流式看到 claude 回复（打字机效果）、显示成本/token。
4. 回桌面对同目录 `-c` → 能看到手机这轮对话。

## 后续（非 MVP）

Android、App Store 上架、推送通知（复用现有事件通道 `POST /api/v1/events` + notify 帧）、语音输入、移动端完整终端（线 A）、双端并发强互斥锁、vibe-remoted 自动注入 hook 配置。
