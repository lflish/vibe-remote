import { describe, it, expect } from 'vitest';
import { ChatSession } from './session';
import type { ChatState } from './types';

// 便捷：把一串 NDJSON 行喂给 session。
function feed(s: ChatSession, objs: unknown[]) {
  for (const o of objs) s.applyLine(JSON.stringify(o));
}

describe('ChatSession', () => {
  it('startUserTurn 推入用户消息并进入 streaming', () => {
    const s = new ChatSession();
    s.startUserTurn('hello');
    const st = s.getState();
    expect(st.messages).toHaveLength(1);
    expect(st.messages[0]).toEqual({ role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    expect(st.streaming).toBe(true);
    expect(st.phase).toBe('waiting_model');
  });

  it('完整 assistant 块落定文本（覆盖打字机预览，不重复）', () => {
    const s = new ChatSession();
    s.startUserTurn('hi');
    feed(s, [
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
    ]);
    const assistant = s.getState().messages[1];
    expect(assistant.role).toBe('assistant');
    // 落定后应是官方内容 'Hello world'，而不是预览 'Hello' + 再拼 'Hello world'。
    expect(assistant.parts).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('tool_use ↔ tool_result 按 id 配对回填', () => {
    const s = new ChatSession();
    s.startUserTurn('run echo');
    feed(s, [
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'ok' }] } },
      { type: 'assistant', message: { content: [{ id: 'tu1', name: 'Bash', input: { command: 'echo hello' }, type: 'tool_use' }] } },
      { type: 'user', message: { content: [{ tool_use_id: 'tu1', type: 'tool_result', content: 'hello', is_error: false }] } },
    ]);
    const st = s.getState();
    const assistant = st.messages.find((m) => m.role === 'assistant')!;
    const toolPart = assistant.parts.find((p) => p.type === 'tool_use');
    expect(toolPart).toBeDefined();
    if (toolPart && toolPart.type === 'tool_use') {
      expect(toolPart.name).toBe('Bash');
      expect(toolPart.result).toEqual({ content: 'hello', isError: false });
    }
    // 有 tool_use 的块应把 phase 置为 running_tool。
    expect(st.phase).toBe('running_tool');
  });

  it('result 事件结束整轮并记录成本', () => {
    const s = new ChatSession();
    s.startUserTurn('hi');
    feed(s, [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', total_cost_usd: 0.01, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const st = s.getState();
    expect(st.streaming).toBe(false);
    expect(st.phase).toBe('idle');
    expect(st.cost).toEqual({ usd: 0.01, inputTokens: 10, outputTokens: 5, numTurns: 1 });
    const assistant = st.messages[1];
    if (assistant.role === 'assistant') expect(assistant.streaming).toBe(false);
  });

  it('markInterrupted 标记当前 assistant 并结束 turn', () => {
    const s = new ChatSession();
    s.startUserTurn('hi');
    feed(s, [{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } }]);
    s.markInterrupted();
    const st = s.getState();
    expect(st.streaming).toBe(false);
    const assistant = st.messages[1];
    if (assistant.role === 'assistant') expect(assistant.interrupted).toBe(true);
  });

  it('setHistory 批量替换消息列表', () => {
    const s = new ChatSession();
    const history: ChatState['messages'] = [
      { role: 'user', parts: [{ type: 'text', text: 'earlier' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'reply' }], streaming: false },
    ];
    s.setHistory(history);
    expect(s.getState().messages).toEqual(history);
  });

  it('onUpdate 在状态变化时回调', () => {
    const s = new ChatSession();
    let calls = 0;
    s.onUpdate = () => calls++;
    s.startUserTurn('hi');
    expect(calls).toBeGreaterThan(0);
  });
});
