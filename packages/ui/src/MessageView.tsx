import { useState } from 'react';
import type { Message, Part } from '@vibe-remote/core';
import { MarkdownBody } from './MarkdownBody';
import { ToolCard } from './ToolCard';

// 一条消息的渲染。user 右对齐纯文本气泡；assistant 逐 part 分派。
export function MessageView({ message }: { message: Message }) {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    return (
      <div className="vr-msg vr-msg-user">
        <div className="vr-bubble">{text}</div>
      </div>
    );
  }
  return (
    <div className={`vr-msg vr-msg-assistant${message.interrupted ? ' vr-interrupted' : ''}`}>
      {message.parts.map((part, i) => (
        <PartView key={i} part={part} />
      ))}
      {message.interrupted && <div className="vr-interrupted-note">已停止</div>}
    </div>
  );
}

function PartView({ part }: { part: Part }) {
  switch (part.type) {
    case 'text':
      return <MarkdownBody text={part.text} />;
    case 'thinking':
      return <ThinkingBlock text={part.text} />;
    case 'tool_use':
      return <ToolCard part={part} />;
  }
}

// 可折叠思考块。
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="vr-thinking">
      <button className="vr-thinking-head" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} 思考
      </button>
      {open && <div className="vr-thinking-body">{text}</div>}
    </div>
  );
}
