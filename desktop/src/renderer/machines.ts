import type { MachineConfig } from '../shared/protocol';
import { VibeRemoteRest } from './rest';
import { t } from './i18n';
import { activateModal } from './modal';

/**
 * Machine manager modal — app-internal CRUD for the machine list, replacing
 * hand-editing machines.json. Persists via window.vibeRemote.saveMachines (main
 * process is the only writer). Test-connection hits the target vibe-remoted
 * directly (healthz + info), not the main process.
 *
 * Safe DOM construction (textContent / createElement) throughout — never
 * innerHTML with user- or server-provided strings.
 */

export interface TestResult {
  ok: boolean;
  hostname?: string;
  reason?: 'unreachable' | 'auth' | 'version';
  error?: string;
}

// testConnection verifies a machine is reachable and the token is valid:
// /healthz needs no auth (proves reachability); /api/v1/info needs the Bearer
// token (proves the token), and returns the hostname to show on success.
export async function testConnection(machine: MachineConfig): Promise<TestResult> {
  const base = `http://${machine.addr}:${machine.port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    if (!health.ok) return { ok: false, reason: 'unreachable', error: `healthz ${health.status}` };
  } catch (e) {
    return { ok: false, reason: 'unreachable', error: (e as Error).message };
  }
  try {
    const rest = new VibeRemoteRest(machine);
    const info = await rest.info();
    return { ok: true, hostname: info.hostname };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /\b(401|403)\b/.test(message) ? 'auth' : /\b404\b/.test(message) ? 'version' : 'unreachable';
    return { ok: false, reason, error: message };
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
// copy of the machine array; commits via window.vibeRemote.saveMachines on save,
// then calls onSaved so the caller can hot-reload without restarting the app.
export function openMachineManager(opts: ManagerOpts): void {
  const working: MachineConfig[] = opts.machines.map((m) => ({ ...m }));
  let closed = false;

  const overlay = el('div', 'modal-overlay');
  const modal = el('div', 'modal');

  const header = el('h2', 'modal-header');
  header.textContent = t('machines.title');
  modal.appendChild(header);

  const list = el('div', 'modal-list');
  modal.appendChild(list);

  const bar = el('div', 'modal-error');
  bar.style.display = 'none';
  bar.setAttribute('role', 'alert');
  bar.setAttribute('aria-live', 'assertive');
  modal.appendChild(bar);

  const footer = el('div', 'modal-footer');
  const addBtn = el('button', 'btn-secondary');
  (addBtn as HTMLButtonElement).type = 'button';
  addBtn.textContent = t('machines.add');
  const doneBtn = el('button', 'btn-primary');
  (doneBtn as HTMLButtonElement).type = 'button';
  doneBtn.textContent = t('machines.done');
  footer.append(addBtn, doneBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  let deactivateModal = () => {};
  function close() {
    if (closed) return;
    closed = true;
    deactivateModal();
    overlay.remove();
  }

  // commit persists the working list and notifies the caller. Returns whether
  // the save succeeded; on failure it surfaces a visible error instead of
  // leaving an unhandled promise rejection, so callers can skip follow-up UI.
  async function commit(): Promise<boolean> {
    try {
      await window.vibeRemote.saveMachines(working);
      bar.style.display = 'none';
      opts.onSaved(working.map((m) => ({ ...m })));
      return true;
    } catch (e) {
      console.error('saveMachines failed', e);
      bar.textContent = t('machines.saveFailed', { msg: (e as Error).message });
      bar.style.display = 'block';
      return false;
    }
  }

  function renderList() {
    list.textContent = '';
    if (working.length === 0) {
      const empty = el('div', 'modal-empty');
      empty.textContent = t('machines.empty');
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
      (editBtn as HTMLButtonElement).type = 'button';
      editBtn.textContent = t('machines.edit');
      editBtn.addEventListener('click', () => openForm(idx));
      const delBtn = el('button', 'btn-secondary');
      (delBtn as HTMLButtonElement).type = 'button';
      delBtn.textContent = t('machines.delete');
      delBtn.addEventListener('click', () => confirmDelete(idx));
      actions.append(editBtn, delBtn);

      row.append(info, actions);
      list.appendChild(row);
    });
  }

  function confirmDelete(idx: number) {
    const m = working[idx];
    if (!window.confirm(t('machines.deleteConfirm', { name: m.name }))) {
      return;
    }
    working.splice(idx, 1);
    commit().then((saved) => {
      if (!saved) working.splice(idx, 0, m);
      renderList();
    });
  }

  // openForm shows the add/edit form. idx === -1 means add.
  function openForm(idx: number) {
    const editing = idx >= 0 ? working[idx] : { name: '', addr: '', port: 8765, token: '' };
    const form = el('div', 'machine-form');

    const nameIn = field(form, t('machines.field.name'), editing.name, 'text', 'machine-name', 'off');
    const addrIn = field(form, t('machines.field.addr'), editing.addr, 'text', 'machine-address', 'off');
    const portIn = field(form, t('machines.field.port'), String(editing.port), 'number', 'machine-port', 'off');
    const tokenIn = field(form, t('machines.field.token'), editing.token, 'password', 'machine-token', 'off');

    const status = el('div', 'form-status');
    form.appendChild(status);

    const row = el('div', 'form-actions');
    const testBtn = el('button', 'btn-secondary');
    (testBtn as HTMLButtonElement).type = 'button';
    testBtn.textContent = t('machines.test');
    const saveBtn = el('button', 'btn-primary');
    (saveBtn as HTMLButtonElement).type = 'button';
    saveBtn.textContent = t('machines.save');
    const cancelBtn = el('button', 'btn-secondary');
    (cancelBtn as HTMLButtonElement).type = 'button';
    cancelBtn.textContent = t('machines.cancel');
    row.append(testBtn, cancelBtn, saveBtn);
    form.appendChild(row);

    function collect(): MachineConfig | null {
      const name = nameIn.value.trim();
      const addr = addrIn.value.trim();
      const port = parseInt(portIn.value, 10);
      const token = tokenIn.value.trim();
      if (!name) { showStatus(t('machines.err.name'), true); nameIn.focus(); return null; }
      if (!addr) { showStatus(t('machines.err.addr'), true); addrIn.focus(); return null; }
      if (!Number.isInteger(port) || port < 1 || port > 65535) { showStatus(t('machines.err.port'), true); portIn.focus(); return null; }
      if (!token) { showStatus(t('machines.err.token'), true); tokenIn.focus(); return null; }
      return { name, addr, port, token };
    }

    function showStatus(msg: string, isError: boolean) {
      status.textContent = msg;
      status.className = 'form-status' + (isError ? ' error' : ' ok');
    }

    testBtn.addEventListener('click', async () => {
      const m = collect();
      if (!m) return;
      showStatus(t('machines.testing'), false);
      (testBtn as HTMLButtonElement).disabled = true;
      testBtn.setAttribute('aria-busy', 'true');
      try {
        const res = await testConnection(m);
        if (res.ok) showStatus(t('machines.testOk'), false);
        else showStatus(t('machines.testFail', { msg: t(`machines.testReason.${res.reason ?? 'unreachable'}`) }), true);
      } finally {
        (testBtn as HTMLButtonElement).disabled = false;
        testBtn.removeAttribute('aria-busy');
      }
    });

    cancelBtn.addEventListener('click', () => { form.remove(); renderList(); });

    saveBtn.addEventListener('click', async () => {
      const m = collect();
      if (!m) return;
      (saveBtn as HTMLButtonElement).disabled = true;
      saveBtn.setAttribute('aria-busy', 'true');
      const previous = idx >= 0 ? working[idx] : null;
      if (idx >= 0) working[idx] = m;
      else working.push(m);
      if (!(await commit())) {
        if (idx >= 0 && previous) working[idx] = previous;
        else working.pop();
        (saveBtn as HTMLButtonElement).disabled = false;
        saveBtn.removeAttribute('aria-busy');
        return;
      }
      form.remove();
      renderList();
    });

    list.textContent = '';
    list.appendChild(form);
    nameIn.focus();
  }

  addBtn.addEventListener('click', () => openForm(-1));
  doneBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  deactivateModal = activateModal(overlay, modal, header, addBtn, close);

  renderList();
}

// field builds a labeled input inside the form and returns the input element.
let fieldId = 0;
function field(form: HTMLElement, label: string, value: string, type: string, name: string, autocomplete: HTMLInputElement['autocomplete']): HTMLInputElement {
  const wrap = el('div', 'form-field');
  const lab = el('label');
  lab.textContent = label;
  const input = document.createElement('input');
  const id = `machine-field-${++fieldId}`;
  input.id = id;
  input.type = type;
  input.name = name;
  input.autocomplete = autocomplete;
  input.spellcheck = false;
  input.value = value;
  lab.setAttribute('for', id);
  wrap.append(lab, input);
  form.appendChild(wrap);
  return input;
}
