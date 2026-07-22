import { describe, it, expect } from 'vitest';
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

describe('ChatController', () => {
  it('startUserTurn pushes user msg + assistant placeholder and sets loading', () => {
    const c = new ChatController();
    c.startUserTurn('你好');
    expect(c.messages).toEqual([
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '' },
    ]);
    expect(c.loading).toBe(true);
  });

  it('accumulates deltas into the last assistant message', () => {
    const c = new ChatController();
    c.startUserTurn('暗号?');
    c.applyLine(deltaLine('紫'));
    c.applyLine(deltaLine('色犀牛42'));
    expect(c.messages[1]).toEqual({ role: 'assistant', text: '紫色犀牛42' });
    expect(c.loading).toBe(true); // still streaming until result
  });

  it('result line ends loading and records cost', () => {
    const c = new ChatController();
    c.startUserTurn('暗号?');
    c.applyLine(deltaLine('紫色犀牛42'));
    c.applyLine(resultLine(0.12));
    expect(c.loading).toBe(false);
    expect(c.lastCostUsd).toBe(0.12);
  });

  it('ignores noise lines without mutating messages', () => {
    const c = new ChatController();
    c.startUserTurn('x');
    const before = JSON.stringify(c.messages);
    c.applyLine(JSON.stringify({ type: 'system', subtype: 'hook_started' }));
    c.applyLine('garbage{');
    expect(JSON.stringify(c.messages)).toBe(before);
  });

  it('fires onUpdate on each mutation', () => {
    const c = new ChatController();
    let n = 0;
    c.onUpdate = () => { n++; };
    c.startUserTurn('x');    // +1
    c.applyLine(deltaLine('a')); // +1
    c.applyLine(resultLine(0.01)); // +1
    expect(n).toBe(3);
  });
});
