// 框架无关的结构化 chat 数据模型。零 DOM。
// 对标 pi-web 的 lib/types.ts（AgentMessage / AssistantContentBlock），做了简化：
// 只保留 vibe-remote 从 claude stream-json 能拿到、且 UI 要渲染的部分。
//
// 数据流：claude stream-json NDJSON → parser.ts（逐行 → StreamEvent）
//        → session.ts（状态机累积 → Message[]） → 各端视图渲染。

/** 工具执行结果，配对回填到发起它的 tool_use part。 */
export interface ToolResult {
  content: string;
  isError: boolean;
}

/** 一条消息里的内容块。assistant 消息可含多个 part（文本/思考/工具调用交替）。 */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; durationMs?: number }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: unknown;
      // result 在对应 tool_result 到达后由状态机回填（先显示调用转圈 → 结果展开）。
      result?: ToolResult;
    };

/** 一条对话消息。 */
export type Message =
  | { role: 'user'; parts: Part[] }
  | {
      role: 'assistant';
      parts: Part[];
      model?: string;
      streaming: boolean;
      interrupted?: boolean;
    };

/** 底部状态提示：空闲 / 等模型首字 / 正在跑工具。 */
export type Phase = 'idle' | 'waiting_model' | 'running_tool';

export interface CostInfo {
  usd?: number;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
}

/** 整个 chat 会话的可渲染状态。 */
export interface ChatState {
  messages: Message[];
  streaming: boolean;
  phase: Phase;
  cost?: CostInfo;
}
