// 通用「React 挂载 ChatView」helper：把 core 的 ChatSession（逻辑）与 ChatView（视图）
// 接起来，三端（桌面/web/iOS）共享。data 帧的解析/累积在 core，视图渲染在 ui，
// 这里只负责把两者接到一个 DOM 挂载点 + 提供 feed/dispose。
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatSession, makeLineSplitter, base64ToText, textToBase64 } from '@vibe-remote/core';
import type { Message } from '@vibe-remote/core';
import { ChatView } from './ChatView';

export interface ChatMount {
  session: ChatSession;
  /** 把服务端 data 帧（base64 的 NDJSON 文本）喂进解析管线。 */
  feed: (base64Payload: string) => void;
  /** 预填历史消息（来自 jsonl-backed REST）。 */
  setHistory: (messages: Message[]) => void;
  /** 卸载 React root。 */
  dispose: () => void;
}

// 在 container 挂一个 ChatView。
// onSend：用户发消息 → 内部 startUserTurn + 把 prompt 编码为 base64 交给调用方发出。
// onStop：用户点停止（需 headless 双向化 interrupt 帧落地后接入）。
export function mountChat(
  container: HTMLElement,
  handlers: { onSend: (payload: string) => void; onStop?: () => void },
): ChatMount {
  const session = new ChatSession();
  const root: Root = createRoot(container);

  const render = () => {
    root.render(
      createElement(ChatView, {
        state: session.getState(),
        onSend: (text: string) => {
          session.startUserTurn(text);
          handlers.onSend(textToBase64(text));
        },
        onStop: handlers.onStop,
      }),
    );
  };

  session.onUpdate = render;
  render(); // 首次渲染空态

  const splitter = makeLineSplitter((line) => session.applyLine(line));

  return {
    session,
    feed: (base64Payload: string) => splitter(base64ToText(base64Payload)),
    setHistory: (messages: Message[]) => session.setHistory(messages),
    dispose: () => root.unmount(),
  };
}
