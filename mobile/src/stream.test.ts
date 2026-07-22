import { describe, it, expect } from 'vitest';
import { parseStreamLine } from './stream';

describe('parseStreamLine', () => {
  it('extracts text from content_block_delta', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '紫' } },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'delta', text: '紫' });
  });

  it('reports result with cost', () => {
    const line = JSON.stringify({
      type: 'result', subtype: 'success', total_cost_usd: 0.12, num_turns: 1, result: '紫色犀牛42',
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'result', costUsd: 0.12, numTurns: 1 });
  });

  it('ignores system/hook noise', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'hook_started' });
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored' });
  });

  it('ignores assistant summary frames (deltas already cover text)', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } });
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored' });
  });

  it('ignores non-text delta (e.g. tool input) safely', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored' });
  });

  it('ignores malformed JSON without throwing', () => {
    expect(parseStreamLine('not json{')).toEqual({ kind: 'ignored' });
  });

  it('ignores empty line', () => {
    expect(parseStreamLine('')).toEqual({ kind: 'ignored' });
  });
});
