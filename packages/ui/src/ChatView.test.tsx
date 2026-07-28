// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatSession } from '@vibe-remote/core';
import { ChatView } from './ChatView';

// 端到端冒烟：core ChatSession 消费真实 stream-json → ChatView 渲染 → 断言 DOM。
// 验证 core 逻辑内核与 ui 视图层的契约（Message/Part → 组件）真正打通。
function feed(s: ChatSession, objs: unknown[]) {
  for (const o of objs) s.applyLine(JSON.stringify(o));
}

describe('ChatView（core + ui 端到端）', () => {
  it('渲染 user 消息 + assistant 文本', () => {
    const s = new ChatSession();
    s.startUserTurn('你好');
    feed(s, [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi **there**' }] } }]);
    const html = renderToStaticMarkup(<ChatView state={s.getState()} onSend={() => {}} />);
    expect(html).toContain('你好');
    expect(html).toContain('<strong>there</strong>'); // markdown 渲染生效
  });

  it('渲染工具卡片 + 配对结果（Bash）', () => {
    const s = new ChatSession();
    s.startUserTurn('run');
    feed(s, [
      { type: 'assistant', message: { content: [{ id: 'tu1', name: 'Bash', input: { command: 'echo hi' }, type: 'tool_use' }] } },
      { type: 'user', message: { content: [{ tool_use_id: 'tu1', type: 'tool_result', content: 'hi', is_error: false }] } },
      { type: 'result', total_cost_usd: 0.002, usage: { input_tokens: 5, output_tokens: 2 } },
    ]);
    const html = renderToStaticMarkup(<ChatView state={s.getState()} onSend={() => {}} />);
    expect(html).toContain('Bash');
    expect(html).toContain('echo hi'); // 参数摘要
    expect(html).toContain('完成'); // 成功状态（非 error）
    expect(html).toContain('$0.0020'); // cost 栏
  });

  it('流式中显示 phase 提示', () => {
    const s = new ChatSession();
    s.startUserTurn('hi');
    const html = renderToStaticMarkup(<ChatView state={s.getState()} onSend={() => {}} />);
    expect(html).toContain('正在思考');
  });
});
