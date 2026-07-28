import { useEffect, useState } from 'react';
import type { MachineConfig } from '@vibe-remote/core';
import { probeMachine } from './machineStatus';
import { machineKey } from './storage';

// 侧边栏：多机器分组，每台机器下列 workdir 列表 + 「+ 选目录开聊」+ 在线点。
// workdir 列表来自 localStorage（会话=workdir，不用 listSessions）。
export function Sidebar({ machines, workdirsByKey, onOpen, onAddWorkdir, onManage }: {
  machines: MachineConfig[];
  workdirsByKey: Record<string, string[]>;
  onOpen: (m: MachineConfig, dir: string) => void;
  onAddWorkdir: (m: MachineConfig) => void;
  onManage: () => void;
}) {
  const [status, setStatus] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, boolean> = {};
      await Promise.all(machines.map(async (m) => {
        const r = await probeMachine(m);
        next[machineKey(m)] = r.online;
      }));
      if (!cancelled) setStatus(next);
    })();
    return () => { cancelled = true; };
  }, [machines]);

  return (
    <aside className="web-sidebar">
      <div className="web-sidebar-head">
        <span>vibe-remote</span>
        <button onClick={onManage}>⚙</button>
      </div>
      {machines.length === 0 && (
        <div className="web-empty">
          <div>尚未添加机器</div>
          <button onClick={onManage}>+ 添加第一台</button>
        </div>
      )}
      {machines.map((m) => {
        const k = machineKey(m);
        const online = status[k];
        return (
          <div key={k} className="web-machine-group">
            <div className="web-machine-head">
              <span className={`web-dot ${online ? 'ok' : 'off'}`} />
              <span className="web-machine-name">{m.name}</span>
              <button onClick={() => onAddWorkdir(m)}>+ 选目录开聊</button>
            </div>
            <ul className="web-workdir-list">
              {(workdirsByKey[k] ?? []).map((dir) => (
                <li key={dir}>
                  <button onClick={() => onOpen(m, dir)}>{dir}</button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </aside>
  );
}
