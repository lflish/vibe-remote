// 深度解析 `claude -p --output-format stream-json --include-partial-messages --verbose`
// 的单行 NDJSON。解析的是 claude 官方结构化协议（Messages API SSE + Claude Code
// wrapper），非 TUI 像素 —— 属 display-only，不违背「客户端不解析 TUI」约束。
//
// 策略（对标 pi-web）：以完整的 `assistant` / `user` 消息块为事实来源
// （tool_use / tool_result / thinking / text 都完整且带 id），`stream_event`
// 的增量仅用于流式打字机预览。tool_use ↔ tool_result 靠 id 精确配对（在 session.ts）。
//
// 真实样本结构（本机 claude 2.1.210 采集验证）：
//   {"type":"assistant","message":{"content":[{"type":"thinking",...}|
//        {"type":"text","text":..}|{"type":"tool_use","id":..,"name":..,"input":..}]}}
//   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":..,
//        "is_error":bool,"content":string|[{type:"text",text}]}]}}
//   {"type":"stream_event","event":{"type":"content_block_delta",
//        "delta":{"type":"text_delta","text":..}|{"type":"thinking_delta","thinking":..}}}
//   {"type":"stream_event","event":{"type":"message_start","message":{"model":..}}}
//   {"type":"result","total_cost_usd":..,"num_turns":..,"usage":{input_tokens,output_tokens}}

import type { Part, ToolResult } from './types';

export type StreamEvent =
  // 一条完整 assistant 消息（含若干 part）到达。
  | { kind: 'assistant_message'; parts: Part[]; model?: string }
  // 一条完整 user 消息里的 tool_result（配对键 toolUseId）。
  | { kind: 'tool_result'; toolUseId: string; result: ToolResult }
  // 流式文本增量（打字机预览）。
  | { kind: 'text_delta'; text: string }
  // 流式思考增量。
  | { kind: 'thinking_delta'; text: string }
  // 模型标识（message_start）。
  | { kind: 'model'; model: string }
  // 一轮结束的汇总（成本/token）。
  | { kind: 'result'; costUsd?: number; numTurns?: number; inputTokens?: number; outputTokens?: number }
  // 与 chat 视图无关的行（system / hook / 未知），安全跳过。
  | { kind: 'ignored' };

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

// tool_result 的 content 可能是纯字符串，也可能是 [{type:'text',text}] 数组；归一为文本。
function flattenResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object' && typeof (b as any).text === 'string') return (b as any).text;
        return '';
      })
      .join('');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

// 把一条完整 assistant message 的 content[] 转成 Part[]。
function parseAssistantContent(content: unknown): Part[] {
  if (!Array.isArray(content)) return [];
  const parts: Part[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const t = (b as any).type;
    if (t === 'text' && typeof (b as any).text === 'string') {
      parts.push({ type: 'text', text: (b as any).text });
    } else if (t === 'thinking' && typeof (b as any).thinking === 'string') {
      parts.push({ type: 'thinking', text: (b as any).thinking });
    } else if (t === 'tool_use' && typeof (b as any).id === 'string' && typeof (b as any).name === 'string') {
      parts.push({ type: 'tool_use', id: (b as any).id, name: (b as any).name, input: (b as any).input });
    }
  }
  return parts;
}

/** 解析单行 NDJSON。永不抛异常：畸形/未知行返回 { kind: 'ignored' }（dumb-pipe 容错）。 */
export function parseStreamLine(line: string): StreamEvent {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'ignored' };

  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { kind: 'ignored' };
  }

  switch (obj?.type) {
    case 'assistant': {
      const msg = obj.message ?? {};
      const parts = parseAssistantContent(msg.content);
      if (parts.length === 0) return { kind: 'ignored' };
      return { kind: 'assistant_message', parts, model: str(msg.model) };
    }

    case 'user': {
      // user 块承载 tool_result（可能一条里有多个，但常见为一个；取第一个 tool_result）。
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && typeof b === 'object' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            return {
              kind: 'tool_result',
              toolUseId: b.tool_use_id,
              result: { content: flattenResultContent(b.content), isError: b.is_error === true },
            };
          }
        }
      }
      return { kind: 'ignored' };
    }

    case 'stream_event': {
      const ev = obj.event;
      const et = ev?.type;
      if (et === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
          return { kind: 'text_delta', text: ev.delta.text };
        }
        if (ev.delta?.type === 'thinking_delta' && typeof ev.delta.thinking === 'string') {
          return { kind: 'thinking_delta', text: ev.delta.thinking };
        }
        return { kind: 'ignored' };
      }
      if (et === 'message_start') {
        const model = str(ev.message?.model);
        return model ? { kind: 'model', model } : { kind: 'ignored' };
      }
      return { kind: 'ignored' };
    }

    case 'result':
      return {
        kind: 'result',
        costUsd: num(obj.total_cost_usd),
        numTurns: num(obj.num_turns),
        inputTokens: num(obj.usage?.input_tokens),
        outputTokens: num(obj.usage?.output_tokens),
      };

    default:
      // 'system' / hook 事件等 —— chat 视图的噪声。
      return { kind: 'ignored' };
  }
}
