import { useState } from 'react';
import { validateMachineFields, type MachineConfig } from '@vibe-remote/core';
import { probeMachine } from './machineStatus';

const FIELD_LABEL: Record<string, string> = { name: '名称', addr: '地址', port: '端口', token: 'Token' };

// 机器增删改。校验复用 core validateMachineFields（与桌面/移动同一规则），
// 测试连接复用 probeMachine（healthz + info）。
export function MachineManager({ machines, onSave, onClose }: {
  machines: MachineConfig[];
  onSave: (m: MachineConfig[]) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<MachineConfig[]>(machines);
  const [form, setForm] = useState({ name: '', addr: '', port: '', token: '' });
  const [err, setErr] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const add = () => {
    const r = validateMachineFields(form);
    if (!r.ok) { setErr(`${FIELD_LABEL[r.field]} 无效`); return; }
    setErr(null);
    setList([...list, r.machine]);
    setForm({ name: '', addr: '', port: '', token: '' });
  };

  const test = async () => {
    const r = validateMachineFields(form);
    if (!r.ok) { setErr(`${FIELD_LABEL[r.field]} 无效`); return; }
    setTestMsg('测试中…');
    const res = await probeMachine(r.machine);
    setTestMsg(res.online ? `✓ 已连接：${res.hostname ?? ''}` : '✗ 无法连接');
  };

  return (
    <div className="web-mm">
      <div className="web-mm-head">
        <span>机器管理</span>
        <button onClick={() => { onSave(list); onClose(); }}>完成</button>
      </div>
      <ul className="web-mm-list">
        {list.map((m, i) => (
          <li key={i}>
            {m.name} · {m.addr}:{m.port}
            <button onClick={() => setList(list.filter((_, j) => j !== i))}>删除</button>
          </li>
        ))}
      </ul>
      <div className="web-mm-form">
        <input placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="地址 (Tailscale IP)" value={form.addr} onChange={(e) => setForm({ ...form, addr: e.target.value })} />
        <input placeholder="端口" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
        <input placeholder="Token" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />
        {err && <div className="web-mm-err">{err}</div>}
        {testMsg && <div className="web-mm-test">{testMsg}</div>}
        <div className="web-mm-actions">
          <button onClick={test}>测试连接</button>
          <button onClick={add}>添加</button>
        </div>
      </div>
    </div>
  );
}
