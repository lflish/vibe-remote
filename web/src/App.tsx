import { useEffect, useState } from 'react';
import type { MachineConfig } from '@vibe-remote/core';
import { ChatPane } from './ChatPane';
import { DirPicker } from './DirPicker';
import { MachineManager } from './MachineManager';
import { Sidebar } from './Sidebar';
import { makeWebStore, machineKey } from './storage';
import './styles.css';

type Modal = { type: 'manage' } | { type: 'pick'; machine: MachineConfig } | null;
type ActiveChat = { machine: MachineConfig; workdir: string } | null;

// 顶层：机器列表 + workdir 列表存 localStorage；主区显示当前聊天或空态。
export function App() {
  const store = makeWebStore();
  const [machines, setMachines] = useState<MachineConfig[]>([]);
  const [workdirsByKey, setWorkdirsByKey] = useState<Record<string, string[]>>({});
  const [modal, setModal] = useState<Modal>(null);
  const [chat, setChat] = useState<ActiveChat>(null);

  const reload = async () => {
    const ms = await store.getMachines();
    setMachines(ms);
    const map: Record<string, string[]> = {};
    for (const m of ms) map[machineKey(m)] = await store.getWorkdirs(machineKey(m));
    setWorkdirsByKey(map);
  };

  useEffect(() => { reload(); }, []);

  const openChat = (m: MachineConfig, workdir: string) => setChat({ machine: m, workdir });

  const pickDir = async (path: string) => {
    if (modal?.type !== 'pick') return;
    const m = modal.machine;
    await store.addWorkdir(machineKey(m), path);
    setModal(null);
    await reload();
    openChat(m, path);
  };

  return (
    <div className="web-app">
      <Sidebar
        machines={machines}
        workdirsByKey={workdirsByKey}
        onOpen={openChat}
        onAddWorkdir={(m) => setModal({ type: 'pick', machine: m })}
        onManage={() => setModal({ type: 'manage' })}
      />
      <main className="web-main">
        {chat ? (
          <ChatPane machine={chat.machine} workdir={chat.workdir} onBack={() => setChat(null)} />
        ) : (
          <div className="web-placeholder">从左侧选择一个 workdir 或添加机器</div>
        )}
      </main>
      {modal?.type === 'manage' && (
        <div className="web-modal">
          <MachineManager
            machines={machines}
            onSave={async (ms) => { await store.saveMachines(ms); await reload(); }}
            onClose={() => setModal(null)}
          />
        </div>
      )}
      {modal?.type === 'pick' && (
        <div className="web-modal">
          <DirPicker machine={modal.machine} onPick={pickDir} onCancel={() => setModal(null)} />
        </div>
      )}
    </div>
  );
}
