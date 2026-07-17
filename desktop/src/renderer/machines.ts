import type { MachineConfig } from '../shared/protocol';
import { CcdeskRest } from './rest';

/**
 * Machine manager modal — app-internal CRUD for the machine list, replacing
 * hand-editing machines.json. Persists via window.ccdesk.saveMachines (main
 * process is the only writer). Test-connection hits the target ccdeskd
 * directly (healthz + info), not the main process.
 *
 * Safe DOM construction (textContent / createElement) throughout — never
 * innerHTML with user- or server-provided strings.
 */

export interface TestResult {
  ok: boolean;
  hostname?: string;
  error?: string;
}

// testConnection verifies a machine is reachable and the token is valid:
// /healthz needs no auth (proves reachability); /api/v1/info needs the Bearer
// token (proves the token), and returns the hostname to show on success.
export async function testConnection(machine: MachineConfig): Promise<TestResult> {
  const base = `http://${machine.addr}:${machine.port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    if (!health.ok) return { ok: false, error: `unreachable (healthz ${health.status})` };
  } catch (e) {
    return { ok: false, error: `unreachable (${(e as Error).message})` };
  }
  try {
    const rest = new CcdeskRest(machine);
    const info = await rest.info();
    return { ok: true, hostname: info.hostname };
  } catch {
    return { ok: false, error: 'bad token or info failed' };
  }
}

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

interface ManagerOpts {
  machines: MachineConfig[];
  onSaved: (machines: MachineConfig[]) => void;
}

// openMachineManager renders the list + inline add/edit form. Works on a local
// copy of the machine array; commits via window.ccdesk.saveMachines on save,
// then calls onSaved so the caller can hot-reload without restarting the app.
export function openMachineManager(opts: ManagerOpts): void {
  const working: MachineConfig[] = opts.machines.map((m) => ({ ...m }));

  const overlay = el('div', 'modal-overlay');
  const modal = el('div', 'modal');

  const header = el('div', 'modal-header');
  header.textContent = 'Machines';
  modal.appendChild(header);

  const list = el('div', 'modal-list');
  modal.appendChild(list);

  const footer = el('div', 'modal-footer');
  const addBtn = el('button', 'btn-secondary');
  addBtn.textContent = '+ Add machine';
  const doneBtn = el('button', 'btn-primary');
  doneBtn.textContent = 'Done';
  footer.append(addBtn, doneBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
  }

  async function commit() {
    await window.ccdesk.saveMachines(working);
    opts.onSaved(working.map((m) => ({ ...m })));
  }

  function renderList() {
    list.textContent = '';
    if (working.length === 0) {
      const empty = el('div', 'modal-empty');
      empty.textContent = 'No machines yet. Add your first one.';
      list.appendChild(empty);
    }
    working.forEach((m, idx) => {
      const row = el('div', 'machine-row');
      const info = el('div', 'machine-row-info');
      const name = el('div', 'machine-row-name');
      name.textContent = m.name;
      const addr = el('div', 'machine-row-addr');
      addr.textContent = `${m.addr}:${m.port}`;
      info.append(name, addr);

      const actions = el('div', 'machine-row-actions');
      const editBtn = el('button', 'btn-secondary');
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openForm(idx));
      const delBtn = el('button', 'btn-secondary');
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => confirmDelete(idx));
      actions.append(editBtn, delBtn);

      row.append(info, actions);
      list.appendChild(row);
    });
  }

  function confirmDelete(idx: number) {
    const m = working[idx];
    if (!window.confirm(`Delete machine "${m.name}"? Its open sessions will be closed locally (the remote claude keeps running).`)) {
      return;
    }
    working.splice(idx, 1);
    commit().then(renderList);
  }

  // openForm shows the add/edit form. idx === -1 means add.
  function openForm(idx: number) {
    const editing = idx >= 0 ? working[idx] : { name: '', addr: '', port: 8765, token: '' };
    const form = el('div', 'machine-form');

    const nameIn = field(form, 'Name', editing.name, 'text');
    const addrIn = field(form, 'Address (tailscale IP or MagicDNS)', editing.addr, 'text');
    const portIn = field(form, 'Port', String(editing.port), 'number');
    const tokenIn = field(form, 'Token', editing.token, 'password');

    const status = el('div', 'form-status');
    form.appendChild(status);

    const row = el('div', 'form-actions');
    const testBtn = el('button', 'btn-secondary');
    testBtn.textContent = 'Test connection';
    const saveBtn = el('button', 'btn-primary');
    saveBtn.textContent = 'Save';
    const cancelBtn = el('button', 'btn-secondary');
    cancelBtn.textContent = 'Cancel';
    row.append(testBtn, cancelBtn, saveBtn);
    form.appendChild(row);

    function collect(): MachineConfig | null {
      const name = nameIn.value.trim();
      const addr = addrIn.value.trim();
      const port = parseInt(portIn.value, 10);
      const token = tokenIn.value.trim();
      if (!name) { showStatus('Name is required', true); return null; }
      if (!addr) { showStatus('Address is required', true); return null; }
      if (!Number.isInteger(port) || port < 1 || port > 65535) { showStatus('Port must be 1–65535', true); return null; }
      if (!token) { showStatus('Token is required', true); return null; }
      return { name, addr, port, token };
    }

    function showStatus(msg: string, isError: boolean) {
      status.textContent = msg;
      status.className = 'form-status' + (isError ? ' error' : ' ok');
    }

    testBtn.addEventListener('click', async () => {
      const m = collect();
      if (!m) return;
      showStatus('Testing…', false);
      const res = await testConnection(m);
      if (res.ok) showStatus(`Connected · ${res.hostname}`, false);
      else showStatus(res.error || 'failed', true);
    });

    cancelBtn.addEventListener('click', () => { form.remove(); renderList(); });

    saveBtn.addEventListener('click', async () => {
      const m = collect();
      if (!m) return;
      if (idx >= 0) working[idx] = m;
      else working.push(m);
      await commit();
      form.remove();
      renderList();
    });

    list.textContent = '';
    list.appendChild(form);
  }

  addBtn.addEventListener('click', () => openForm(-1));
  doneBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  renderList();
}

// field builds a labeled input inside the form and returns the input element.
function field(form: HTMLElement, label: string, value: string, type: string): HTMLInputElement {
  const wrap = el('div', 'form-field');
  const lab = el('label');
  lab.textContent = label;
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  wrap.append(lab, input);
  form.appendChild(wrap);
  return input;
}
