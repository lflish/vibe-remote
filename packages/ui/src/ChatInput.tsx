import { useRef, useState } from 'react';

// 输入框：自适应高度、Enter 发送（Shift+Enter 换行）、流式中显示「停止」。
export function ChatInput({
  streaming,
  onSend,
  onStop,
  disabled,
}: {
  streaming: boolean;
  onSend: (text: string) => void;
  onStop?: () => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const t = text.trim();
    if (!t || streaming) return;
    onSend(t);
    setText('');
    if (ref.current) ref.current.style.height = 'auto';
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const autoGrow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  return (
    <div className="vr-composer">
      <textarea
        ref={ref}
        className="vr-composer-input"
        value={text}
        placeholder="输入消息…"
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          autoGrow();
        }}
        onKeyDown={onKeyDown}
        rows={1}
      />
      {streaming ? (
        <button className="vr-composer-stop" onClick={() => onStop?.()}>
          停止
        </button>
      ) : (
        <button className="vr-composer-send" onClick={send} disabled={disabled || !text.trim()}>
          发送
        </button>
      )}
    </div>
  );
}
