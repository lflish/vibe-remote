// Parse one NDJSON line from `claude -p --output-format stream-json`.
// The stream mixes hook/system events with the actual model output; we filter
// by top-level `type` and only surface text deltas + the final result. We parse
// claude's OFFICIAL structured protocol here (not TUI pixels), so this respects
// the "no parsing of TUI output" rule — the parsing is in the display layer only.

export type ChatEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'result'; costUsd?: number; numTurns?: number }
  | { kind: 'ignored' };

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
      return { kind: 'ignored' };
    }
    case 'result':
      return {
        kind: 'result',
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
        numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : undefined,
      };
    default:
      // 'system', 'assistant', hook events, etc. — noise for the chat view.
      return { kind: 'ignored' };
  }
}
