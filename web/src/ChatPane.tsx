import { useEffect, useRef } from 'react';
import { VibeRemoteClient, VibeRemoteRest, type MachineConfig, type Message } from '@vibe-remote/core';
import { mountChat } from '@vibe-remote/ui';
import '@vibe-remote/ui/styles.css';

// 单个 headless 聊天。会话=workdir：attach 直接传 workdir。
// 命令式 mountChat 封进 React：useEffect 挂载、卸载时 dispose + 断开 WS。
export function ChatPane({ machine, workdir, onBack }: { machine: MachineConfig; workdir: string; onBack: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current!;
    const client = new VibeRemoteClient(machine);
    const mount = mountChat(host, { onSend: (payload) => client.sendData(payload) });

    // 历史回填：{role,text} → core Message（纯文本 part）。
    new VibeRemoteRest(machine)
      .history(workdir, 50)
      .then((turns) => {
        const msgs: Message[] = turns.map((t) =>
          t.role === 'assistant'
            ? { role: 'assistant', parts: [{ type: 'text', text: t.text }], streaming: false }
            : { role: 'user', parts: [{ type: 'text', text: t.text }] },
        );
        if (!cancelled && msgs.length) mount.setHistory(msgs);
      })
      .catch(() => { /* history best-effort */ });

    client.onData = (payload) => mount.feed(payload);
    client.connect();
    client.attach(workdir);

    return () => {
      cancelled = true;
      client.disconnect();
      mount.dispose();
    };
  }, [machine, workdir]);

  return (
    <div className="web-chat-pane">
      <div className="web-chat-header">
        <button onClick={onBack}>‹ 返回</button>
        <span className="web-chat-title">{workdir}</span>
      </div>
      <div className="chat-host" ref={hostRef} />
    </div>
  );
}
