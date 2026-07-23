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

  it('extracts tool_use from content_block_start', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Bash', input: {} },
      },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'tool', name: 'Bash', summary: undefined });
  });

  it('extracts tool_use with input summary (Bash command)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
      },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'tool', name: 'Bash', summary: 'git status' });
  });

  it('extracts tool_use with file_path summary (Read)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } },
      },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'tool', name: 'Read', summary: '/a/b.ts' });
  });

  it('extracts input/output tokens from result', () => {
    const line = JSON.stringify({
      type: 'result', subtype: 'success', total_cost_usd: 0.12, num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 42 },
    });
    expect(parseStreamLine(line)).toEqual({
      kind: 'result', costUsd: 0.12, numTurns: 1, inputTokens: 100, outputTokens: 42,
    });
  });

  it('ignores text content_block_start (only tool_use surfaces)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'text', text: '' } },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored' });
  });
});
