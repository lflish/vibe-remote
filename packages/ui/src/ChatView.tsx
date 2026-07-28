import { useEffect, useRef } from 'react';
import type { ChatState, Phase } from '@vibe-remote/core';
import { MessageView } from './MessageView';
import { ChatInput } from './ChatInput';

// 顶层聊天视图。纯受控：接收 core ChatSession 算出的 ChatState + 发送/停止回调，
// 自身不持有会话逻辑（逻辑全在 core，视图只渲染）。桌面/web/iOS 共享此组件。
export function ChatView({
  state,
  onSend,
  onStop,
}: {
  state: ChatState;
  onSend: (text: string) => void;
  onStop?: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // 新消息到达自动贴底（简单实现，第一期不做「用户上滚则不抢滚动」优化）。
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.streaming]);

  return (
    <div className="vr-chat">
      <div className="vr-chat-list" ref={listRef}>
        {state.messages.map((m, i) => (
          <MessageView key={i} message={m} />
        ))}
        {state.streaming && <PhaseIndicator phase={state.phase} />}
      </div>
      {state.cost && <CostBar state={state} />}
      <ChatInput streaming={state.streaming} onSend={onSend} onStop={onStop} />
    </div>
  );
}

function PhaseIndicator({ phase }: { phase: Phase }) {
  const label = phase === 'running_tool' ? '正在运行工具…' : '正在思考…';
  return <div className="vr-phase">{label}</div>;
}

function CostBar({ state }: { state: ChatState }) {
  const c = state.cost!;
  const parts: string[] = [];
  if (c.usd != null) parts.push(`$${c.usd.toFixed(4)}`);
  if (c.inputTokens != null || c.outputTokens != null) {
    parts.push(`↑${c.inputTokens ?? 0} ↓${c.outputTokens ?? 0} tok`);
  }
  if (c.numTurns != null) parts.push(`${c.numTurns} turns`);
  return <div className="vr-cost">{parts.join(' · ')}</div>;
}
