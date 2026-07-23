// Parse one NDJSON line from `claude -p --output-format stream-json`.
// The stream mixes hook/system events with the actual model output; we filter
// by top-level `type` and surface text deltas, tool-call starts, and the final
// result. We parse claude's OFFICIAL structured protocol here (not TUI pixels),
// so this respects the "no parsing of TUI output" rule — parsing is display-only.

export type ChatEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'tool'; name: string; summary?: string }
  | { kind: 'result'; costUsd?: number; numTurns?: number; inputTokens?: number; outputTokens?: number }
  | { kind: 'ignored' };

// Pull a short human-readable summary from a tool_use input, best-effort.
// Common claude tools carry their most salient arg under one of these keys.
function toolSummary(input: any): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const candidates = ['command', 'file_path', 'path', 'pattern', 'url', 'description'];
  for (const k of candidates) {
    if (typeof input[k] === 'string' && input[k]) return input[k];
  }
  return undefined;
}

export function parseStreamLine(line: string): ChatEvent {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'ignored' };

  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // Malformed line — skip it, never crash the stream (dumb-pipe tolerance).
    return { kind: 'ignored' };
  }

  switch (obj?.type) {
    case 'stream_event': {
      const ev = obj.event;
      if (
        ev?.type === 'content_block_delta' &&
        ev.delta?.type === 'text_delta' &&
        typeof ev.delta.text === 'string'
      ) {
        return { kind: 'delta', text: ev.delta.text };
      }
      if (
        ev?.type === 'content_block_start' &&
        ev.content_block?.type === 'tool_use' &&
        typeof ev.content_block.name === 'string'
      ) {
        return { kind: 'tool', name: ev.content_block.name, summary: toolSummary(ev.content_block.input) };
      }
      return { kind: 'ignored' };
    }
    case 'result':
      return {
        kind: 'result',
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
        numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : undefined,
        inputTokens: typeof obj.usage?.input_tokens === 'number' ? obj.usage.input_tokens : undefined,
        outputTokens: typeof obj.usage?.output_tokens === 'number' ? obj.usage.output_tokens : undefined,
      };
    default:
      // 'system', 'assistant', hook events, etc. — noise for the chat view.
      return { kind: 'ignored' };
  }
}
