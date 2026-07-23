import { VibeRemoteRest } from '@net/rest';
import type { MachineConfig } from '@shared/protocol';

// testConnection verifies a machine is reachable and the token is valid.
// healthz (no auth) proves reachability; info (Bearer token) proves token.
export async function testConnection(machine: MachineConfig): Promise<{ ok: boolean; hostname?: string; error?: string }> {
  const base = `http://${machine.addr}:${machine.port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    if (!health.ok) return { ok: false, error: `不可达 (healthz ${health.status})` };
  } catch (e) {
    return { ok: false, error: `不可达 (${(e as Error).message})` };
  }
  try {
    const rest = new VibeRemoteRest(machine);
    const info = await rest.info();
    return { ok: true, hostname: info.hostname };
  } catch {
    return { ok: false, error: 'Token 无效或 info 接口失败' };
  }
}

// Escapes for both text and double-quoted attribute contexts (form values go
// into value="..." so " must be escaped too, or a token containing a quote
// would break out of the attribute).
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

export interface MachineManagerOpts {
  app: HTMLElement;
  getMachines: () => Promise<MachineConfig[]>;
  saveMachines: (machines: MachineConfig[]) => Promise<void>;
  onDone: () => void; // called when user navigates back
}

export async function openMachineManager(opts: MachineManagerOpts) {
  const { app, getMachines, saveMachines, onDone } = opts;
  let machines = await getMachines();

  function render() {
    app.innerHTML = `
      <div class="header">
        <button class="back" id="mm-back">‹ 返回</button>
        <span>机器管理</span>
      </div>
      <div class="list" id="mm-list"></div>
      <div class="mm-footer">
        <button class="btn-primary btn-full" id="mm-add">+ 添加机器</button>
      </div>`;

    const list = document.getElementById('mm-list')!;
    if (machines.length === 0) {
      list.innerHTML = `<div class="empty-guide"><div class="empty-icon">📡</div><div class="empty-title">尚未添加机器</div><div class="empty-sub">添加你的第一台远程机器，开始移动端 Claude 体验</div></div>`;
    } else {
      machines.forEach((m, idx) => {
        const item = document.createElement('div');
        item.className = 'list-item machine-item';
        item.innerHTML = `
          <div class="machine-info">
            <div class="title">${escapeHtml(m.name)}</div>
            <div class="sub">${escapeHtml(m.addr)}:${m.port}</div>
          </div>
          <div class="machine-actions">
            <button class="btn-sm" data-edit="${idx}">编辑</button>
            <button class="btn-sm btn-danger" data-del="${idx}">删除</button>
          </div>`;
        list.appendChild(item);
      });

      list.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const editIdx = target.getAttribute('data-edit');
        const delIdx = target.getAttribute('data-del');
        if (editIdx != null) openForm(parseInt(editIdx));
        if (delIdx != null) confirmDelete(parseInt(delIdx));
      });
    }

    document.getElementById('mm-back')!.onclick = onDone;
    document.getElementById('mm-add')!.onclick = () => openForm(-1);
  }

  async function confirmDelete(idx: number) {
    const m = machines[idx];
    if (!confirm(`删除机器「${m.name}」？远程 claude 会话仍在运行，仅移除本地配置。`)) return;
    machines.splice(idx, 1);
    await saveMachines(machines);
    render();
  }

  function openForm(idx: number) {
    const editing = idx >= 0 ? { ...machines[idx] } : { name: '', addr: '', port: 8765, token: '' };

    app.innerHTML = `
      <div class="header">
        <button class="back" id="form-cancel">‹ 取消</button>
        <span>${idx >= 0 ? '编辑机器' : '添加机器'}</span>
      </div>
      <div class="form-body">
        <div class="form-field">
          <label>名称</label>
          <input id="f-name" type="text" value="${escapeHtml(editing.name)}" placeholder="例如 dev-server" />
        </div>
        <div class="form-field">
          <label>地址（Tailscale IP 或 MagicDNS）</label>
          <input id="f-addr" type="text" value="${escapeHtml(editing.addr)}" placeholder="100.x.x.x" />
        </div>
        <div class="form-field">
          <label>端口</label>
          <input id="f-port" type="number" value="${editing.port}" />
        </div>
        <div class="form-field">
          <label>Token</label>
          <input id="f-token" type="password" value="${escapeHtml(editing.token)}" placeholder="vibe-remoted 配置的 token" />
        </div>
        <div class="form-status" id="f-status"></div>
        <div class="form-actions">
          <button class="btn-secondary" id="f-test">测试连接</button>
          <button class="btn-primary" id="f-save">保存</button>
        </div>
      </div>`;

    const nameIn = document.getElementById('f-name') as HTMLInputElement;
    const addrIn = document.getElementById('f-addr') as HTMLInputElement;
    const portIn = document.getElementById('f-port') as HTMLInputElement;
    const tokenIn = document.getElementById('f-token') as HTMLInputElement;
    const status = document.getElementById('f-status')!;

    function showStatus(msg: string, isError: boolean) {
      status.textContent = msg;
      status.className = 'form-status ' + (isError ? 'error' : 'ok');
    }

    function collect(): MachineConfig | null {
      const name = nameIn.value.trim();
      const addr = addrIn.value.trim();
      const port = parseInt(portIn.value, 10);
      const token = tokenIn.value.trim();
      if (!name) { showStatus('名称不能为空', true); return null; }
      if (!addr) { showStatus('地址不能为空', true); return null; }
      if (!Number.isInteger(port) || port < 1 || port > 65535) { showStatus('端口必须在 1–65535', true); return null; }
      if (!token) { showStatus('Token 不能为空', true); return null; }
      return { name, addr, port, token };
    }

    document.getElementById('form-cancel')!.onclick = () => render();

    document.getElementById('f-test')!.onclick = async () => {
      const m = collect();
      if (!m) return;
      showStatus('连接中…', false);
      const res = await testConnection(m);
      if (res.ok) showStatus(`✓ 已连接 · ${res.hostname}`, false);
      else showStatus(`✗ ${res.error}`, true);
    };

    document.getElementById('f-save')!.onclick = async () => {
      const m = collect();
      if (!m) return;
      if (idx >= 0) machines[idx] = m;
      else machines.push(m);
      await saveMachines(machines);
      render();
    };
  }

  render();
}
