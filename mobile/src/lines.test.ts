import { describe, it, expect } from 'vitest';
import { makeLineSplitter } from './lines';
import { ChatController } from './chat';

function deltaLine(text: string): string {
  return JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  });
}
function resultLine(cost: number): string {
  return JSON.stringify({ type: 'result', total_cost_usd: cost, num_turns: 1 });
}

describe('makeLineSplitter', () => {
  it('emits each line of a multi-line single frame', () => {
    const out: string[] = [];
    const feed = makeLineSplitter((l) => out.push(l));
    feed('a\nb\n');
    expect(out).toEqual(['a', 'b']);
  });

  it('buffers a line split across frames and emits once complete', () => {
    const out: string[] = [];
    const feed = makeLineSplitter((l) => out.push(l));
    feed('{"ty');
    expect(out).toEqual([]); // nothing yet — no '\n' seen
    feed('pe"}\n');
    expect(out).toEqual(['{"type"}']);
  });

  it('does not emit a trailing segment with no newline (stays buffered)', () => {
    const out: string[] = [];
    const feed = makeLineSplitter((l) => out.push(l));
    feed('done\npartial');
    expect(out).toEqual(['done']); // 'partial' held in buffer, not emitted
  });

  // The seam test: this is exactly the client half of the NDJSON contract.
  // The server forwards ONE '\n'-terminated NDJSON line per WebSocket frame
  // (bufio.Scanner strips the '\n', ws.go re-adds it). If the server did NOT
  // re-add the '\n', these frames would concatenate into one un-splittable blob
  // and makeLineSplitter would never emit — so applyLine would never fire and
  // the assistant bubble would stay empty. This asserts the round-trip works.
  it('stream → splitter → applyLine assembles the bubble and ends loading', () => {
    const c = new ChatController();
    c.startUserTurn('暗号?');
    const feed = makeLineSplitter((l) => c.applyLine(l));

    // Each server frame is a single line WITH its trailing '\n' restored.
    feed(deltaLine('紫') + '\n');
    feed(deltaLine('色犀牛42') + '\n');
    feed(resultLine(0.12) + '\n');

    expect(c.messages[1]).toEqual({ role: 'assistant', text: '紫色犀牛42' });
    expect(c.loading).toBe(false);
    expect(c.lastCostUsd).toBe(0.12);
  });

  // Reverse proof: WITHOUT the server re-adding '\n' the frames concatenate and
  // no line boundary is ever found — the bubble stays empty and loading never
  // ends. This is precisely the bug fix 1 addresses; it must hold.
  it('WITHOUT trailing newlines the frames never split → bubble stays empty (bug repro)', () => {
    const c = new ChatController();
    c.startUserTurn('暗号?');
    const feed = makeLineSplitter((l) => c.applyLine(l));

    feed(deltaLine('紫'));       // no '\n'
    feed(deltaLine('色犀牛42')); // no '\n'
    feed(resultLine(0.12));      // no '\n'

    expect(c.messages[1]).toEqual({ role: 'assistant', text: '' });
    expect(c.loading).toBe(true);
  });
});
