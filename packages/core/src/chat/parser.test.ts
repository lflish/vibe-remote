import { describe, it, expect } from 'vitest';
import { parseStreamLine } from './parser';

// Fixtures 取自本机 claude 2.1.210 真实 stream-json 采样（--output-format stream-json
// --include-partial-messages --verbose，触发 Bash 工具调用一轮往返）。

describe('parseStreamLine', () => {
  it('忽略空行与畸形 JSON（dumb-pipe 容错）', () => {
    expect(parseStreamLine('')).toEqual({ kind: 'ignored' });
    expect(parseStreamLine('   ')).toEqual({ kind: 'ignored' });
    expect(parseStreamLine('{not json')).toEqual({ kind: 'ignored' });
  });

  it('忽略 system / hook 事件', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'x' });
    expect(parseStreamLine(line)).toEqual({ kind: 'ignored' });
  });

  it('解析完整 assistant 块的 thinking part', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'let me think', signature: 'sig' }] },
    });
    const ev = parseStreamLine(line);
    expect(ev.kind).toBe('assistant_message');
    if (ev.kind === 'assistant_message') {
      expect(ev.parts).toEqual([{ type: 'thinking', text: 'let me think' }]);
    }
  });

  it('解析完整 assistant 块的 tool_use part（保留 id/name/input）', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { id: 'toolu_01ANW', input: { command: 'echo hello', description: 'Print hello' }, name: 'Bash', type: 'tool_use' },
        ],
      },
    });
    const ev = parseStreamLine(line);
    expect(ev.kind).toBe('assistant_message');
    if (ev.kind === 'assistant_message') {
      expect(ev.parts).toEqual([
        { type: 'tool_use', id: 'toolu_01ANW', name: 'Bash', input: { command: 'echo hello', description: 'Print hello' } },
      ]);
    }
  });

  it('解析 user 块里的 tool_result（字符串 content）并带上配对键', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ tool_use_id: 'toolu_01ANW', type: 'tool_result', content: 'hello', is_error: false }] },
    });
    const ev = parseStreamLine(line);
    expect(ev).toEqual({
      kind: 'tool_result',
      toolUseId: 'toolu_01ANW',
      result: { content: 'hello', isError: false },
    });
  });

  it('tool_result 的数组型 content 归一为文本', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { tool_use_id: 't1', type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'err A' }, { type: 'text', text: ' err B' }] },
        ],
      },
    });
    const ev = parseStreamLine(line);
    expect(ev).toEqual({ kind: 'tool_result', toolUseId: 't1', result: { content: 'err A err B', isError: true } });
  });

  it('解析 text_delta / thinking_delta 打字机增量', () => {
    const textLine = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } });
    expect(parseStreamLine(textLine)).toEqual({ kind: 'text_delta', text: 'Hi' });

    const thinkLine = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'The' } } });
    expect(parseStreamLine(thinkLine)).toEqual({ kind: 'thinking_delta', text: 'The' });
  });

  it('从 message_start 提取 model', () => {
    const line = JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-opus-4-8' } } });
    expect(parseStreamLine(line)).toEqual({ kind: 'model', model: 'claude-opus-4-8' });
  });

  it('解析 result 的成本与 token', () => {
    const line = JSON.stringify({ type: 'result', total_cost_usd: 0.0123, num_turns: 2, usage: { input_tokens: 100, output_tokens: 50 } });
    expect(parseStreamLine(line)).toEqual({ kind: 'result', costUsd: 0.0123, numTurns: 2, inputTokens: 100, outputTokens: 50 });
  });
});
