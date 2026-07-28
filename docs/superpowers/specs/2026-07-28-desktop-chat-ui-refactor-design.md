# 桌面端聊天式富交互 UI 重构 · 第一期设计

**日期**：2026-07-28
**范围**：仅第一期（桌面 Electron 端从 xterm 终端 → 聊天式富交互 UI）
**参考**：pi-web（主要蓝本）、VSCode Claude Code 插件（理念借鉴）

---

## 1. 背景与动机

vibe-remote 当前桌面端（Electron）是纯字节透传的 xterm 终端：claude 跑在远程（PTY→tmux→claude），客户端只做哑终端。用户希望**用方便交互的聊天式 UI 取代命令行终端**，对标 pi-web / VSCode Claude 插件的体验。

**关键发现**：项目已有一条完整的结构化交互旁路——**headless 模式**。服务端跑 `claude -p --output-format stream-json`，透传的是 claude **官方 NDJSON 结构化协议**（不是解析 TUI 像素），因此**不违背** CLAUDE.md 的「纯字节透传/客户端绝不解析 TUI」约束（该约束的原意是禁止解析终端像素，官方 stream-json 本就是结构化数据，解析仅用于显示）。移动端（`mobile/`）已用此路线跑通了基础聊天 UI。

**本期本质**：把移动端已验证的 headless 聊天路线**推广到桌面端**，并借 pi-web 的成熟组件把展示层**做深**（工具结果卡片、并排 diff、thinking 折叠等）。

## 2. 目标与非目标

### 第一期目标
- 桌面 Electron 端**彻底移除 xterm**，改走 `attach {mode:"headless"}`，呈现聊天式富交互 UI。
- 抽出**框架无关的共享 chat 内核**（`desktop/src/shared/chat/`），桌面/移动双端复用（方案 A）。
- 展示层对标 pi-web：message parts 分派渲染、工具卡片、并排 diff、thinking 折叠、token/成本栏、历史回填、会话侧边栏。
- **停止/中断**按钮（流式中可中止当前 turn）。
- **斜杠命令补全**（静态命令表，UI 辅助）。

### 非目标（明确留后期）
- **按钮式权限确认闭环**——需服务端改造 claude 权限通道（`--dangerously-skip-permissions` 之外的权限交互），是硬骨头。
- **steering（运行中插队）/ follow-up 队列**——需服务端把 headless 从「一次一 turn」升级为「持续 stream-json 双向会话」。
- **@文件引用**——留后期（本期只做斜杠命令）。
- 虚拟化消息列表（第一期普通滚动即可，性能优化留后期）。
- 移动端视图层重写（本期移动端只切换到共享内核，视图不动）。

## 3. 决策记录

| 决策点 | 选择 | 理由 |
|---|---|---|
| 壳形态 | 保留 Electron，改造桌面端 | 用户明确要改造现有桌面端 |
| 终端去留 | 彻底去终端，只留聊天 | 用户明确「不要命令行模式」 |
| 技术栈 | 轻量框架 → **Preact + preact/compat** | 体积小，又能直接用 React 生态（react-markdown/diff 组件）；比原生 TS 好维护，比 React 轻 |
| 代码组织 | **方案 A：共享内核双端复用** | 一次做对，两端收敛；内核可单测（延续移动端 vitest 传统） |
| 分期 | 先只规划第一期 | 全家桶工程过大，分期可持续交付、每期可用 |
| 输入增强 | 只做斜杠命令补全（@引用留后期） | 斜杠命令不需服务端改动 |
| 停止按钮 | 放第一期 | 用户要求；服务端小改（turnCtx + interrupt 帧），比权限交互轻得多 |

## 4. 架构与数据流

### 端到端数据流
```
远程 claude -p --output-format stream-json          （服务端已有，不改）
   └─ NDJSON stdout 逐行
      └─ ws.go 加换行分帧 → data 帧 base64            （已有，不改）
         └─ [客户端] client.ts 收 data 帧             （已有，不改）
            └─ lines.ts 跨帧行缓冲                     （从 mobile 上提到 shared）
               └─ parser.ts 深度解析 → ChatEvent       （新写：解析完整 content blocks）
                  └─ session.ts 状态机 → Message[]      （从 mobile chat.ts 上提 + 增强）
                     └─ Preact 组件树渲染               （桌面新写视图层）
```

### 为什么展示数据几乎不用碰服务端
已核实 `headless.go` 与 `ws.go:wsHeadless`：claude 的**完整 NDJSON 已原样送到客户端**（含藏着 `tool_result` 的 `user` 消息块、`assistant` 完整块）。服务端 `onLine` 只加换行分帧、从不解析内容。移动端「工具结果没卡片」的原因在客户端——`mobile/src/stream.ts:63-65` 把 `assistant`/`user` 完整消息块全部 `ignored` 了，只挑了 `stream_event` 的 text delta 和 tool_use start。

**结论**：工具结果卡片、并排 diff、thinking 折叠等展示特性是**纯客户端工程**（把 parser 从「只挑 delta+tool start」做深到「解析完整 message parts」）。**唯一的服务端改动**来自「停止按钮」（turnCtx + interrupt 帧，见 §7）。

### 代码组织（方案 A）
新建 `desktop/src/shared/chat/`（框架无关内核，可单测）：
- `types.ts` — Message / Part / ChatState 数据模型（见 §5）
- `lines.ts` — NDJSON 跨帧行缓冲（从 `mobile/src/lines.ts` 上提）
- `parser.ts` — 深度 parser（新写，解析完整 content blocks → 结构化事件）
- `session.ts` — 会话状态机（从 `mobile/src/chat.ts` 上提 + 增强：tool_use↔tool_result 配对、thinking 块、interrupted 标记、cost 累积）
- `diff.ts` — unified diff → 并排结构解析（新写）

桌面 `desktop/src/renderer/`：引入 Preact，视图层消费内核。
移动端 `mobile/src/`：改为 import 共享内核（删除自身较浅的 parser/lines），视图层暂不动。

## 5. 数据模型与配对机制

```ts
// desktop/src/shared/chat/types.ts（框架无关）
type Message =
  | { role: 'user'; parts: Part[] }
  | { role: 'assistant'; parts: Part[]; model?: string; streaming: boolean; interrupted?: boolean }

type Part =
  | { type: 'text'; text: string }                              // → markdown
  | { type: 'thinking'; text: string; durationMs?: number }     // → 可折叠
  | { type: 'tool_use'; id: string; name: string; input: any;   // → 工具卡片
      result?: ToolResult }                                     //   result 配对回填
type ToolResult = { content: string; isError: boolean }

type ChatState = {
  messages: Message[]
  streaming: boolean
  phase: 'idle' | 'waiting_model' | 'running_tool'  // 底部脉冲提示
  cost?: { usd: number; inputTokens: number; outputTokens: number }
}
```

### tool_use ↔ tool_result 配对
claude 的 stream-json 里，`tool_use` 出现在 assistant 消息块，`tool_result` 出现在**后续的 user 消息块**里（通过 `tool_use_id` 关联）。状态机维护 `Map<toolUseId, Part>`，收到 tool_result 时回填对应 `tool_use` part 的 `.result`。UI 效果：卡片「先显示调用（转圈）→ 结果到达后展开」。这是移动端漏掉的核心部分。

## 6. 组件树（Preact，对标 pi-web MessageView）

```
<ChatView>                          会话容器（滚动 + 自动贴底）
 ├─ <MessageList>                   消息列表（第一期普通滚动，虚拟化留后期）
 │   ├─ <UserBubble>                用户气泡
 │   └─ <AssistantMessage>          按 parts 分派：
 │       ├─ <MarkdownBlock>         text part → markdown-it + DOMPurify（复用 mobile render.ts）
 │       ├─ <ThinkingBlock>         thinking part → 可折叠（显示耗时）
 │       └─ <ToolCard>              tool_use part → 按 name 分派：
 │           ├─ <DiffToolCard>        Edit/MultiEdit/Write → 并排 split diff
 │           ├─ <BashToolCard>        Bash → 命令 + 输出
 │           └─ <GenericToolCard>     Read/Grep/Glob/LS/未知 → 参数预览 + 结果折叠
 ├─ <PhaseIndicator>               底部脉冲："正在思考 / 正在运行 Bash…"
 ├─ <CostBar>                      token / 成本
 └─ <Composer>                     输入框 + 发送/停止键 + / 斜杠命令补全
```

### 工具名 → 卡片分派（第一期覆盖）
- `Edit` / `MultiEdit` / `Write` → **DiffToolCard**（解析 old/new 或文件内容 → 并排 diff）
- `Bash` → **BashToolCard**（命令 + 输出，截断可展开）
- `Read` / `Grep` / `Glob` / `LS` → **GenericToolCard**（参数预览 + 结果折叠）
- 未知工具 → **GenericToolCard** 兜底（永不崩）

## 7. 停止 / 中断

### 协议（新增 `interrupt` 帧，无 payload）
三处同步：`vibe-remoted/internal/protocol/protocol.go`（Go 常量）、`desktop/src/shared/protocol.ts`（TS 类型）、`docs/protocol.md`。

### 服务端（`ws.go:wsHeadless` 小改）
- 每个 turn 派生独立 `turnCtx, turnCancel := context.WithCancel(ctx)`。
- 收到 `interrupt` 帧 → 调 `turnCancel()`。
- `RunTurn` 已用 `exec.CommandContext(turnCtx, ...)`，收到 ctx 取消**自动杀 claude 进程**（这层免费，不改 `headless.go`）。
- turn 结束后清理 turnCancel。
- 不碰 headless「一次一 turn / busy 锁」核心逻辑。

### 客户端
- `session.streaming === true` 时，Composer 发送键渲染为「停止」键。
- 点击 → `client.sendInterrupt()` 发 `interrupt` 帧。
- 收到后续 `result` 帧或 error 帧 → 复位为发送键。
- 被停止的 assistant 消息标记 `interrupted`，UI 显示「已停止」。

### 边界
停止后 claude 的 `-c` 已把部分输出写进 jsonl，历史连续；下一条 prompt 接着来。需**真机验证**：杀进程后 jsonl 历史仍连续可续。

## 8. 斜杠命令补全
- Composer 输入以 `/` 开头 → 弹补全浮层。
- 第一期用**静态命令表**（claude 常见命令，如 `/clear` `/compact` `/help` 等内置清单）。
- 选中后原样作为 prompt 文本发出，claude 自己处理命令语义，UI 只做补全辅助。
- 不查服务端、不需新协议。

## 9. 迁移策略（去 xterm）
- 桌面 `attach` 从空 mode（TUI）改为 `mode:"headless"`。
- 移除 xterm 依赖与 `term.write` 相关代码（`desktop/src/renderer/index.ts:254,260-261` 等）。
- **SessionView 抽象保留**（每会话独立 client + 独立视图容器），容器内容从 `Terminal` 换成 `<ChatView>`。
- **复用不动**：侧边栏、机器管理、REST 轮询、重连（指数退避 + 断线横幅）、UTF-8 base64 处理——它们不关心 TUI/headless。
- **历史回填**：复用 `GET /api/v1/history` 读 jsonl，进入会话时把历史喂给同一 parser 还原 message parts。

## 10. 错误处理
- parser 遇到无法识别 / 畸形 NDJSON 行 → 归为 `ignored`，永不崩（继承移动端 dumb-pipe 容错）。
- 未知工具名 → GenericToolCard 兜底。
- turn 出错（服务端 error 帧）→ 消息流内联红色错误块，不阻塞后续输入。
- 断线重连 → 复用现有指数退避 + 断线横幅；重连后靠 `-c` 继续。

## 11. 测试策略（延续 vitest；内核可单测是方案 A 的红利）
- `parser.test.ts`：喂真实 claude NDJSON 样本（text delta / tool_use / tool_result 配对 / thinking / result），断言输出 message parts。
- `session.test.ts`：状态机——tool_use↔tool_result 配对回填、interrupted 标记、cost 累积。
- `lines.test.ts`：跨帧行缓冲（迁移现有）。
- `diff.test.ts`：unified diff → 并排结构。
- 视图层组件：真机冒烟（本地 `claude_cmd` 代跑链路 + 真机 dev）。
- 服务端 interrupt：Go 侧 turnCtx 取消路径 + 真机验证杀进程后 jsonl 连续。

## 12. 影响的关键文件
**新增**：`desktop/src/shared/chat/{types,parser,session,diff}.ts`、桌面 Preact 组件（`ChatView` / `MessageList` / `ToolCard` 等）。
**上提/迁移**：`mobile/src/lines.ts` → shared；`mobile/src/chat.ts` 逻辑 → `shared/chat/session.ts`。
**改动**：`desktop/src/renderer/index.ts`（去 xterm、挂 Preact、attach mode）、`desktop/src/shared/protocol.ts`（interrupt 帧）、`vibe-remoted/internal/protocol/protocol.go`（interrupt 帧）、`vibe-remoted/internal/server/ws.go`（turnCtx + interrupt 处理）、`docs/protocol.md`（interrupt 帧）、桌面构建配置（Preact 依赖）。
**复用不动**：侧边栏 / 机器管理 / REST / 重连 / `client.ts` / `history.go`。

## 13. 验收标准（第一期）
1. 桌面端打开会话进入聊天式 UI（无 xterm），能发 prompt、看到流式 markdown 回复。
2. 工具调用显示为卡片；Edit/Write 显示并排 diff；Bash 显示命令+输出；结果正确配对。
3. thinking 块可折叠。
4. token/成本栏正确显示。
5. 历史会话进入时正确回填为 message parts。
6. 流式中点「停止」能中止当前 turn，历史连续，可继续下一条。
7. 输入 `/` 弹出斜杠命令补全。
8. 移动端切换到共享内核后功能不回归。
9. 内核单测通过；`go build -race` 通过（服务端 interrupt 改动）。
