# ccdesk 体验增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 ccdesk 第一期后续增加四块体验增强——机器管理 UI、会话命名、后台会话提示（圆点 + hook 事件）、重连体验——全程维护「纯字节透传」核心铁律。

**Architecture:** 纯客户端改动（机器管理、重连、圆点）先落地快速见效；服务端改动（会话命名走 tmux 用户选项 + REST rename 端点）打通「服务端加操作」；最重的事件基建（通用 `/api/v1/events` 端点 + Manager pub/sub 路由表 + notify 帧）压轴。hook 自动注入本期只留接口不实现。

**Tech Stack:** Go 1.26（`coder/websocket`、`creack/pty`、`tmux -L ccdesk`）；Electron + TypeScript + xterm.js（Vite 构建）。协议两端手动对齐（无代码生成）。

## Global Constraints

- **纯字节透传铁律**：客户端绝不解析 claude 的 PTY 输出。所有新特性均为外壳 UI 或带外事件，不碰字节流。
- **协议两端手动对齐**：`ccdeskd/internal/protocol/protocol.go`（Go）与 `desktop/src/shared/protocol.ts`（TS）改动必须同步，并更新 `docs/protocol.md`。
- **安全模型不放松**：REST 端点一律 `Authorization: Bearer <token>` 校验（`s.checkToken`）；tmux 命令用参数化传值，绝不拼 shell。
- **race build 必过**：服务端并发改动后 `cd ccdeskd && go build -race ./...` 必须通过。
- **DOM 安全构建**：renderer 用 `textContent`/`createElement`，绝不用 `innerHTML` 拼服务端数据（沿用 `dirpicker.ts` 的 `el()` 范式）。
- **tmux socket**：所有 tmux 命令走专用 socket，用 `tmuxCmd(...)`（内部已加 `-L ccdesk`）。
- **测试命令**：Go 用 `cd ccdeskd && go test ./...`；TS 用 `cd desktop && npm run typecheck`。
- **提交信息**：中文描述，结尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`。

---

## 文件结构总览

**新建：**
- `desktop/src/renderer/machines.ts` — 机器管理 modal（列表 + 增删改表单 + 测试连接）
- `ccdeskd/internal/session/manager_test.go` — Manager 的 Title 规则 + Rename + pub/sub 单测
- `ccdeskd/internal/server/events_test.go` — events 端点单测

**修改（服务端 Go）：**
- `ccdeskd/internal/session/runner.go` — `SetName`/`readName`（tmux 用户选项）；`cmd.Env` 注入三个 `CCDESK_*` 变量（两处）
- `ccdeskd/internal/session/manager.go` — `List()` Title 规则；`Rename()`；pub/sub 路由表 `Subscribe`/`PublishEvent`
- `ccdeskd/internal/protocol/protocol.go` — `TypeNotify` + `NotifyFrame` + events 端点请求体类型
- `ccdeskd/internal/server/server.go` — `POST /api/v1/sessions/{id}/rename`；`POST /api/v1/events`
- `ccdeskd/internal/server/ws.go` — `wsRelay` 订阅 + notify 转发 goroutine

**修改（客户端 TS）：**
- `desktop/src/shared/protocol.ts` — `NotifyFrame` + `FrameType.Notify` + union
- `desktop/src/renderer/client.ts` — `onNotify` 回调；`onStateChange` 带 attempt；`reconnectNow()`
- `desktop/src/renderer/rest.ts` — `renameSession()`
- `desktop/src/renderer/index.ts` — 齿轮入口 / 空状态引导 / 双击重命名 / 圆点 / 重连横幅 / 桌面通知 / activity 状态
- `desktop/src/renderer/styles.css` — 表单控件 / 内联 input / 圆点 / 横幅样式
- `docs/protocol.md` — notify 帧 + events 端点 + rename 端点

**文档：**
- `docs/protocol.md` 每次协议改动同步。

---

## 阶段一：机器管理 UI（纯客户端）

### Task 1: 机器管理 modal（CRUD + 测试连接 + 空状态引导）

**Files:**
- Create: `desktop/src/renderer/machines.ts`
- Modify: `desktop/src/renderer/index.ts`（接入齿轮入口 + 空状态改造 + 保存后热重载）
- Modify: `desktop/src/renderer/index.html:12-22`（sidebar-header 加齿轮按钮）
- Modify: `desktop/src/renderer/styles.css`（表单控件样式）

**Interfaces:**
- Consumes：`window.ccdesk.getMachines()` / `window.ccdesk.saveMachines(machines)`（已存在，见 `preload.ts`）；`CcdeskRest`（`rest.ts`）；`MachineConfig`（`protocol.ts`）。
- Produces：
  - `openMachineManager(opts: { machines: MachineConfig[]; onSaved: (machines: MachineConfig[]) => void }): void` — 打开机器管理 modal。
  - `testConnection(machine: MachineConfig): Promise<{ ok: boolean; hostname?: string; error?: string }>` — 测试连接（`GET /healthz` + `GET /api/v1/info`）。

- [ ] **Step 1: 在 index.html 的 sidebar-header 加齿轮按钮**

修改 `desktop/src/renderer/index.html` 第 13-15 行的 `.sidebar-header`：

```html
      <div class="sidebar-header">
        <h1>ccdesk</h1>
        <button id="btn-manage-machines" class="icon-btn" title="Manage machines">⚙</button>
      </div>
```

- [ ] **Step 2: 创建 machines.ts —— 测试连接函数**

创建 `desktop/src/renderer/machines.ts`，先写测试连接逻辑（复用 `CcdeskRest.info`）：

```typescript
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
```

- [ ] **Step 3: machines.ts —— openMachineManager modal 主体**

在 `machines.ts` 追加 modal 构建。追加到文件末尾：

```typescript
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
```

- [ ] **Step 4: index.ts —— 接入齿轮入口 + 空状态引导 + 保存后热重载**

修改 `desktop/src/renderer/index.ts`。顶部 import 加：

```typescript
import { openMachineManager } from './machines';
```

在 `init()` 里（第 63-76 行区域），改造为：机器为空时也 wire 齿轮/空状态引导，不再直接 return。替换现有 `init()`：

```typescript
async function init() {
  machines = await window.ccdesk.getMachines();
  wireManageMachinesButton();
  wireNewSessionButton();
  wireWindowResize();
  if (machines.length === 0) {
    renderEmptyState();
    return;
  }
  rebuildRests();
  await refreshAllMachines();
  setInterval(refreshAllMachines, 5000);
}

// rebuildRests rebuilds the machineKey→REST map after the machine list changes
// (add/edit/delete via the manager). Existing session WebSockets are untouched.
function rebuildRests() {
  rests.clear();
  for (const m of machines) rests.set(machineKey(m), new CcdeskRest(m));
}

// wireManageMachinesButton opens the machine manager and hot-reloads on save:
// rebuild REST clients, close views for machines that no longer exist, refresh.
function wireManageMachinesButton() {
  document.getElementById('btn-manage-machines')?.addEventListener('click', () => {
    openMachineManager({
      machines,
      onSaved: (updated) => {
        const removedKeys = machines
          .filter((old) => !updated.some((u) => machineKey(u) === machineKey(old)))
          .map(machineKey);
        machines = updated;
        rebuildRests();
        // Close views belonging to removed machines (does NOT kill remote sessions).
        for (const rk of removedKeys) {
          for (const [k, v] of [...views]) {
            if (machineKey(v.machine) === rk) {
              v.client.disconnect();
              v.terminal.dispose();
              v.container.remove();
              views.delete(k);
              if (activeKey === k) activeKey = null;
            }
          }
        }
        if (machines.length === 0) {
          renderEmptyState();
        } else {
          refreshAllMachines();
        }
      },
    });
  });
}
```

- [ ] **Step 5: index.ts —— 空状态引导改造**

替换 `renderEmptyState()`（第 317-328 行）：

```typescript
function renderEmptyState() {
  const container = document.getElementById('terminal-container')!;
  container.textContent = '';
  const box = document.createElement('div');
  box.className = 'empty-state';
  const h = document.createElement('p');
  h.textContent = 'Add your first machine';
  h.style.fontSize = '16px';
  h.style.color = 'var(--text-secondary)';
  const p = document.createElement('p');
  p.style.fontSize = '12px';
  p.textContent = 'The machine must be on the same tailnet and running ccdeskd.';
  const btn = document.createElement('button');
  btn.className = 'btn-primary';
  btn.style.width = 'auto';
  btn.style.marginTop = '8px';
  btn.textContent = 'Add machine';
  btn.addEventListener('click', () => document.getElementById('btn-manage-machines')?.dispatchEvent(new MouseEvent('click')));
  const hint = document.createElement('p');
  hint.style.fontSize = '11px';
  hint.textContent = 'Address: tailscale IP (100.x) or MagicDNS name · Token: matches ccdeskd config';
  box.append(h, p, btn, hint);
  container.appendChild(box);
}
```

- [ ] **Step 6: styles.css —— 表单与机器行样式**

在 `desktop/src/renderer/styles.css` 末尾追加：

```css
/* --- Machine manager --- */
.icon-btn {
  background: transparent; border: none; color: var(--text-muted);
  font-size: 16px; cursor: pointer; -webkit-app-region: no-drag;
  padding: 2px 6px; border-radius: 6px;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.sidebar-header { display: flex; align-items: center; justify-content: space-between; }

.machine-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-radius: var(--radius); gap: 12px;
}
.machine-row:hover { background: var(--bg-hover); }
.machine-row-name { font-size: 13px; color: var(--text-primary); font-weight: 500; }
.machine-row-addr { font-size: 11px; color: var(--text-muted); font-family: 'SF Mono', monospace; }
.machine-row-actions { display: flex; gap: 6px; }
.machine-row-actions .btn-secondary { padding: 4px 10px; font-size: 11px; }

.machine-form { padding: 8px; display: flex; flex-direction: column; gap: 12px; }
.form-field { display: flex; flex-direction: column; gap: 4px; }
.form-field label { font-size: 11px; color: var(--text-muted); }
.form-field input {
  background: var(--bg-sidebar); border: 1px solid var(--border);
  border-radius: 6px; padding: 8px 10px; color: var(--text-primary);
  font-size: 13px; font-family: inherit;
}
.form-field input:focus { outline: none; border-color: var(--accent); }
.form-status { font-size: 12px; min-height: 16px; }
.form-status.ok { color: var(--success); }
.form-status.error { color: var(--error); }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; }
.form-actions .btn-primary { width: auto; }
```

- [ ] **Step 7: typecheck**

Run: `cd desktop && npm run typecheck`
Expected: PASS（无类型错误）

- [ ] **Step 8: 手动冒烟**

Run: `cd desktop && npm run dev`
预期：点齿轮打开机器管理 modal；能添加机器（填字段 → Test connection → Save）；编辑/删除生效；删除有二次确认；机器列表为空时主区显示「Add your first machine」引导；保存后不重启即出现在侧边栏。

- [ ] **Step 9: Commit**

```bash
git add desktop/src/renderer/machines.ts desktop/src/renderer/index.ts desktop/src/renderer/index.html desktop/src/renderer/styles.css
git commit -m "$(cat <<'EOF'
feat(desktop): app 内机器管理 UI（CRUD + 测试连接 + 空状态引导）

齿轮入口打开管理 modal，增删改机器写回 machines.json 不重启即生效；
加机器带 healthz+info 测试连接；空状态引导替代干巴巴提示。
删除机器只关本地 view，不杀远程会话。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 阶段二：重连体验（纯客户端）

### Task 2: 重连状态栏细节 + 终端断线横幅

**Files:**
- Modify: `desktop/src/renderer/client.ts`（`onStateChange` 带 attempt；`reconnectNow()`；`Reconnected` 短暂态）
- Modify: `desktop/src/renderer/index.ts`（横幅 DOM + 状态栏 attempt）
- Modify: `desktop/src/renderer/styles.css`（横幅样式）

**Interfaces:**
- Consumes：`CcdeskClient`（`client.ts`）已有的 `ConnectionState`、`onStateChange`、`state`、`reconnectAttempt`（当前 private）。
- Produces：
  - `CcdeskClient.onStateChange?: (state: ConnectionState, attempt: number) => void` — 回调签名扩展，带上重连尝试次数。
  - `CcdeskClient.reconnectNow(): void` — 立即重试（清除退避计时器直接 connect）。

- [ ] **Step 1: client.ts —— onStateChange 带 attempt + reconnectNow**

修改 `desktop/src/renderer/client.ts`。改回调类型（第 34 行）：

```typescript
  onStateChange?: (state: ConnectionState, attempt: number) => void;
```

改 `setState`（第 203-206 行）把 attempt 一起传出：

```typescript
  private setState(state: ConnectionState) {
    this.state = state;
    this.onStateChange?.(state, this.reconnectAttempt);
  }
```

在 `disconnect()` 之后（第 119 行后）新增 `reconnectNow()`：

```typescript
  /** Skip the backoff wait and reconnect immediately (manual retry). */
  reconnectNow() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.currentSessionId) {
      this.pendingAttach = {
        sessionId: this.currentSessionId,
        cols: this.lastCols,
        rows: this.lastRows,
      };
    }
    this.connect();
  }
```

- [ ] **Step 2: index.ts —— 横幅 DOM 结构（每个 SessionView 一个）**

修改 `desktop/src/renderer/index.ts`。在 `SessionView` 接口（第 23-31 行）加一个 banner 字段：

```typescript
interface SessionView {
  key: string;
  machine: MachineConfig;
  sessionId: string;
  client: CcdeskClient;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLElement;
  banner: HTMLElement; // reconnect banner overlay, hidden by default
}
```

在 `openSession()` 创建 container 后（第 149 行 `wrap.appendChild(container);` 之后）加横幅构建：

```typescript
  const banner = document.createElement('div');
  banner.className = 'reconnect-banner';
  banner.style.display = 'none';
  const bannerText = document.createElement('span');
  bannerText.textContent = 'Connection lost, reconnecting…';
  const retryBtn = document.createElement('button');
  retryBtn.textContent = 'Retry now';
  retryBtn.addEventListener('click', () => view.client.reconnectNow());
  banner.append(bannerText, retryBtn);
  container.appendChild(banner);
```

（注意：`view` 在下方定义，`retryBtn` 的闭包在点击时才读 `view`，此时已定义——但为安全，把 banner 构建移到 `views.set(view.key, view)` 之后。见 Step 3 的落点说明。）

- [ ] **Step 3: index.ts —— 把横幅构建放在 view 定义之后并存入 view**

将 Step 2 的横幅构建代码放到 `const view: SessionView = {...}` 定义**之后**。修改 `view` 字面量把 `banner` 塞进去，并在其后构建 banner DOM。替换第 154-156 行区域：

```typescript
  const client = new CcdeskClient(machine);
  const banner = document.createElement('div');
  banner.className = 'reconnect-banner';
  banner.style.display = 'none';
  const view: SessionView = { key, machine, sessionId, client, terminal: term, fitAddon: fit, container, banner };
  views.set(key, view);

  const bannerText = document.createElement('span');
  bannerText.textContent = 'Connection lost, reconnecting…';
  const retryBtn = document.createElement('button');
  retryBtn.textContent = 'Retry now';
  retryBtn.addEventListener('click', () => view.client.reconnectNow());
  banner.append(bannerText, retryBtn);
  container.appendChild(banner);
```

- [ ] **Step 4: index.ts —— onStateChange 驱动横幅 + 状态栏 attempt**

修改 `openSession()` 里的 `client.onStateChange`（第 181 行）。替换：

```typescript
  client.onStateChange = (state, attempt) => {
    // Banner shows only on the active session; non-active disconnects don't nag.
    if (state === ConnectionState.Reconnecting) {
      view.banner.style.display = 'flex';
    } else if (state === ConnectionState.Connected) {
      view.banner.style.display = 'none';
    }
    if (view.key === activeKey) updateStatusBar(undefined, attempt);
  };
```

在 `client.onReady`（第 167 行）里，ready 后隐藏横幅并短暂显示 Reconnected：

在 `client.onReady` 回调体开头加：

```typescript
    view.banner.style.display = 'none';
```

- [ ] **Step 5: index.ts —— updateStatusBar 支持 attempt + Reconnected 短暂态**

替换 `updateStatusBar()`（第 269-292 行）：

```typescript
function updateStatusBar(extra?: string, attempt?: number) {
  const connEl = document.getElementById('status-connection')!;
  const sessionEl = document.getElementById('status-session')!;
  const view = activeKey ? views.get(activeKey) : null;

  connEl.className = '';
  if (view) {
    const st = view.client.state;
    if (st === ConnectionState.Connected) {
      connEl.className = 'connected';
      connEl.textContent = `Connected · ${view.machine.name}`;
    } else if (st === ConnectionState.Reconnecting) {
      connEl.className = 'reconnecting';
      const n = attempt ?? 0;
      connEl.textContent = n > 0 ? `Reconnecting… (attempt ${n})` : 'Reconnecting…';
    } else {
      connEl.textContent = 'Disconnected';
    }
  } else {
    const anyOnline = [...machineOnline.values()].some(Boolean);
    connEl.className = anyOnline ? 'connected' : '';
    connEl.textContent = anyOnline ? 'Ready' : 'No connection';
  }
  sessionEl.textContent = extra || (view?.sessionId ? `Session: ${view.sessionId}` : '');
}
```

- [ ] **Step 6: styles.css —— 横幅样式**

在 `styles.css` 末尾追加：

```css
/* --- Reconnect banner --- */
.reconnect-banner {
  position: absolute; left: 8px; right: 8px; top: 8px; z-index: 10;
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 8px 12px; border-radius: 8px;
  background: rgba(249, 226, 175, 0.12);
  border: 1px solid rgba(249, 226, 175, 0.35);
  color: var(--warning); font-size: 12px;
}
.reconnect-banner button {
  background: transparent; border: 1px solid rgba(249, 226, 175, 0.4);
  color: var(--warning); border-radius: 6px; font-size: 11px;
  padding: 3px 10px; cursor: pointer;
}
.reconnect-banner button:hover { background: rgba(249, 226, 175, 0.18); }
```

- [ ] **Step 7: typecheck**

Run: `cd desktop && npm run typecheck`
Expected: PASS

- [ ] **Step 8: 手动冒烟**

Run: `cd desktop && npm run dev`（连一台机器开一个会话，然后 kill 掉 ccdeskd 制造断线）
预期：断线瞬间活动会话终端顶部出现黄色横幅「Connection lost, reconnecting…」+ Retry now；状态栏显示「Reconnecting… (attempt N)」N 递增；重启 ccdeskd 后横幅消失、现场恢复。

- [ ] **Step 9: Commit**

```bash
git add desktop/src/renderer/client.ts desktop/src/renderer/index.ts desktop/src/renderer/styles.css
git commit -m "$(cat <<'EOF'
feat(desktop): 重连体验强化（状态栏尝试次数 + 终端断线横幅）

onStateChange 带 attempt，状态栏显示第几次重连；活动会话终端顶部
弹黄色横幅 + Retry now 立即重连（跳过退避）。非活动会话不打扰。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 阶段三：会话命名（服务端 + 协议 + 客户端）

### Task 3: 服务端 —— tmux 用户选项读写 + Title 规则 + Rename

**Files:**
- Modify: `ccdeskd/internal/session/runner.go`（`SetName`/`readName`）
- Modify: `ccdeskd/internal/session/manager.go`（`List()` Title 规则；`Rename()`）
- Create: `ccdeskd/internal/session/manager_test.go`（Title 规则 + Rename）

**Interfaces:**
- Consumes：`tmuxCmd(...)`（`runner.go`，已加 `-L ccdesk`）；`Runner`（含 `ID`、`Workdir`、`useTmux` 字段）。
- Produces：
  - `sanitizeSessionName(name string) string` — 净化名字（截断 200 + 剥控制字符）。
  - `(*Runner).SetName(name string) error` — 写 tmux 用户选项 `@ccdesk_name`。
  - `(*Runner).readName() string` — 读 tmux 用户选项（无则返回空）。
  - `(*Runner).displayTitle() string` — 三级回落：`@ccdesk_name` → workdir 末段 → ID。
  - `(*Manager).Rename(id, name string) error` — 净化后写 tmux。

- [ ] **Step 1: 写失败测试 —— sanitizeSessionName + displayTitle 回落规则**

创建 `ccdeskd/internal/session/manager_test.go`：

```go
package session

import (
	"strings"
	"testing"
)

func TestSanitizeSessionName(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"plain", "my session", "my session"},
		{"trim spaces", "  hi  ", "hi"},
		{"strip newline", "a\nb", "ab"},
		{"strip tab and cr", "a\tb\rc", "abc"},
		{"strip ansi esc", "a\x1b[31mb", "ab"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeSessionName(tt.in); got != tt.want {
				t.Errorf("sanitizeSessionName(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestSanitizeSessionNameTruncates(t *testing.T) {
	long := strings.Repeat("x", 300)
	got := sanitizeSessionName(long)
	if len(got) != 200 {
		t.Errorf("expected truncation to 200, got len %d", len(got))
	}
}

func TestDisplayTitleFallback(t *testing.T) {
	// No tmux available in unit test → readName returns "" → falls back.
	tests := []struct {
		name    string
		runner  *Runner
		want    string
	}{
		{"workdir tail", &Runner{ID: "abc", Workdir: "/home/user/proj", useTmux: false}, "proj"},
		{"empty workdir falls to id", &Runner{ID: "abc", Workdir: "", useTmux: false}, "abc"},
		{"trailing slash", &Runner{ID: "abc", Workdir: "/home/user/proj/", useTmux: false}, "proj"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.runner.displayTitle(); got != tt.want {
				t.Errorf("displayTitle() = %q, want %q", got, tt.want)
			}
		})
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd ccdeskd && go test ./internal/session -run 'TestSanitizeSessionName|TestDisplayTitle' -v`
Expected: FAIL（`sanitizeSessionName` / `displayTitle` 未定义，编译错误）

- [ ] **Step 3: runner.go —— 实现 sanitize + SetName/readName + displayTitle**

在 `ccdeskd/internal/session/runner.go` 末尾追加。先加 import（文件顶部 import 块已含 `strings`）；追加函数：

```go
// sanitizeSessionName cleans a user-supplied session name before it's stored
// as a tmux option: strip control characters (including ANSI escape sequences)
// and trim surrounding whitespace, then cap the length. tmux gets the value as
// a set-option argument (not a shell string), so this is defense-in-depth
// against display corruption, not shell injection.
func sanitizeSessionName(name string) string {
	var b strings.Builder
	i := 0
	for i < len(name) {
		c := name[i]
		// Drop an ANSI escape sequence: ESC '[' ... final byte in @-~.
		if c == 0x1b {
			i++
			if i < len(name) && name[i] == '[' {
				i++
				for i < len(name) && !(name[i] >= 0x40 && name[i] <= 0x7e) {
					i++
				}
				if i < len(name) {
					i++ // consume the final byte
				}
			}
			continue
		}
		// Drop other control characters (newline, tab, CR, etc.).
		if c < 0x20 || c == 0x7f {
			i++
			continue
		}
		b.WriteByte(c)
		i++
	}
	out := strings.TrimSpace(b.String())
	if len(out) > 200 {
		out = out[:200]
	}
	return out
}

// SetName stores a user-set display name on the tmux session as a custom user
// option (@ccdesk_name). Empty name clears it (falls back to the default rule).
func (r *Runner) SetName(name string) error {
	if !r.useTmux {
		return fmt.Errorf("naming requires tmux mode")
	}
	tmuxSessionName := fmt.Sprintf("ccdesk-%s", r.ID)
	if name == "" {
		// Unset so displayTitle falls back to workdir/id.
		return tmuxCmd("set-option", "-t", tmuxSessionName, "-u", "@ccdesk_name").Run()
	}
	return tmuxCmd("set-option", "-t", tmuxSessionName, "@ccdesk_name", name).Run()
}

// readName reads the @ccdesk_name user option, or "" if unset / tmux errors.
func (r *Runner) readName() string {
	if !r.useTmux {
		return ""
	}
	tmuxSessionName := fmt.Sprintf("ccdesk-%s", r.ID)
	out, err := tmuxCmd("show-options", "-t", tmuxSessionName, "-qv", "@ccdesk_name").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// displayTitle resolves the session's display name at read time (not stored):
// user-set @ccdesk_name → workdir basename → session ID.
func (r *Runner) displayTitle() string {
	if name := r.readName(); name != "" {
		return name
	}
	if r.Workdir != "" {
		trimmed := strings.TrimRight(r.Workdir, "/")
		if idx := strings.LastIndex(trimmed, "/"); idx >= 0 && idx+1 < len(trimmed) {
			return trimmed[idx+1:]
		}
		if trimmed != "" {
			return trimmed
		}
	}
	return r.ID
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd ccdeskd && go test ./internal/session -run 'TestSanitizeSessionName|TestDisplayTitle' -v`
Expected: PASS

- [ ] **Step 5: manager.go —— List() 用 displayTitle + Rename()**

修改 `ccdeskd/internal/session/manager.go`。替换 `List()` 里组装 `SessionInfo` 的循环（第 162-171 行）：

```go
	list := make([]protocol.SessionInfo, 0, len(m.sessions))
	for _, r := range m.sessions {
		list = append(list, protocol.SessionInfo{
			ID:      r.ID,
			Title:   r.displayTitle(),
			Workdir: r.Workdir,
			Created: r.Created.Format(time.RFC3339),
		})
	}
	return list
```

在 `Delete()` 之后（第 118 行后）新增 `Rename()`：

```go
// Rename sets a user display name on a session (persisted as a tmux option).
// An empty name clears the custom name, reverting to the default title rule.
func (m *Manager) Rename(id, name string) error {
	m.mu.RLock()
	runner, ok := m.sessions[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("session %q not found", id)
	}
	return runner.SetName(sanitizeSessionName(name))
}
```

- [ ] **Step 6: 运行全部 session 包测试 + race build**

Run: `cd ccdeskd && go test ./internal/session/... && go build -race ./...`
Expected: PASS（测试通过，race build 无输出即成功）

- [ ] **Step 7: Commit**

```bash
git add ccdeskd/internal/session/runner.go ccdeskd/internal/session/manager.go ccdeskd/internal/session/manager_test.go
git commit -m "$(cat <<'EOF'
feat(ccdeskd): 会话命名——tmux 用户选项存名 + Title 三级回落 + Rename

@ccdesk_name 存 tmux 会话上，跟随生命周期；List Title 读取时按
名字→workdir末段→id 回落；Rename 净化名字（截断200+剥控制字符）。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### Task 4: 服务端 —— rename REST 端点

**Files:**
- Modify: `ccdeskd/internal/server/server.go`（注册 + handler）
- Modify: `docs/protocol.md`（rename 端点）

**Interfaces:**
- Consumes：`(*Manager).Rename(id, name string) error`（Task 3）；`s.checkToken`、`writeJSON`（`server.go` 已有）。
- Produces：`POST /api/v1/sessions/{id}/rename`，请求体 `{"name": "..."}`，成功 204。

- [ ] **Step 1: server.go —— 注册路由 + handler**

修改 `ccdeskd/internal/server/server.go`。在 `routes()`（第 37-44 行）加一行：

```go
	s.mux.HandleFunc("POST /api/v1/sessions/{id}/rename", s.handleRenameSession)
```

在 `handleDeleteSession` 之后（第 118 行后）新增 handler：

```go
// handleRenameSession sets a user display name on a session.
func (s *Server) handleRenameSession(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing session id"})
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if err := s.mgr.Rename(id, body.Name); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

- [ ] **Step 2: 构建确认**

Run: `cd ccdeskd && go build ./...`
Expected: 无输出（编译通过）

- [ ] **Step 3: 手动验证端点（本地 tmux 模式）**

Run（另开终端起 ccdeskd，用 `ccdeskd.tmux.json`）：

```bash
# 先起 ccdeskd（tmux 模式），创建一个会话后拿到 id，然后：
curl -s -X POST http://127.0.0.1:8765/api/v1/sessions/<id>/rename \
  -H "Authorization: Bearer <token>" -d '{"name":"my task"}' -w '%{http_code}\n'
curl -s http://127.0.0.1:8765/api/v1/sessions -H "Authorization: Bearer <token>"
```

Expected: rename 返回 204；sessions 列表里该会话 `title` 变成 `my task`。

> 注：若 `ccdeskd.tmux.json` 的 bind_addr 非 127.0.0.1，用其配置的地址。tmux 模式需本机有 tmux。

- [ ] **Step 4: docs/protocol.md —— 补 rename 端点**

修改 `docs/protocol.md` 的 REST 表格（第 130-136 行），在 DELETE 行后加一行：

```markdown
| POST | `/api/v1/sessions/{id}/rename` | 重命名会话，body `{"name":"..."}`，名字存 tmux 用户选项 |
```

- [ ] **Step 5: Commit**

```bash
git add ccdeskd/internal/server/server.go docs/protocol.md
git commit -m "$(cat <<'EOF'
feat(ccdeskd): 新增 POST /api/v1/sessions/{id}/rename 重命名端点

Bearer 鉴权，body {name}，委托 Manager.Rename 写 tmux 用户选项。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### Task 5: 客户端 —— rename REST 方法 + 双击内联重命名

**Files:**
- Modify: `desktop/src/renderer/rest.ts`（`renameSession`）
- Modify: `desktop/src/renderer/index.ts`（双击 label → 内联 input）
- Modify: `desktop/src/renderer/styles.css`（内联 input 样式）

**Interfaces:**
- Consumes：后端 `POST /api/v1/sessions/{id}/rename`（Task 4）；`renderSidebar()`、`refreshAllMachines()`、`SessionInfo.title`（已有）。
- Produces：`CcdeskRest.renameSession(id: string, name: string): Promise<void>`。

- [ ] **Step 1: rest.ts —— renameSession**

在 `desktop/src/renderer/rest.ts` 的 `deleteSession` 之后（第 37 行后）加：

```typescript
  async renameSession(id: string, name: string): Promise<void> {
    const res = await fetch(`${this.base()}/api/v1/sessions/${id}/rename`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok && res.status !== 204) throw new Error(`rename failed: ${res.status}`);
  }
```

- [ ] **Step 2: index.ts —— 双击 label 进入内联编辑**

修改 `desktop/src/renderer/index.ts` 的 `renderSidebar()` 里 label 构建部分（第 248-252 行）。替换：

```typescript
      const label = document.createElement('span');
      label.className = 'session-label';
      label.textContent = s.title || (s.workdir ? s.workdir.split('/').pop() : '') || s.id;
      label.title = s.workdir || s.id;
      label.addEventListener('click', () => openSession(machine, s.id));
      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startInlineRename(machine, s, label);
      });
```

在 `renderSidebar()` 函数之后（第 267 行后）新增 `startInlineRename`：

```typescript
// startInlineRename replaces a session label with an input for in-place rename.
// Enter/blur commits, Esc cancels. Empty input clears the custom name (server
// falls back to the default title). After commit we refresh from the server so
// the authoritative title is shown (keeps multi-client views consistent).
function startInlineRename(machine: MachineConfig, s: SessionInfo, label: HTMLElement) {
  const input = document.createElement('input');
  input.className = 'session-rename-input';
  input.value = s.title || '';
  label.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    try {
      await rests.get(machineKey(machine))!.renameSession(s.id, name);
    } catch (e) {
      console.error('rename failed', e);
    }
    refreshAllMachines();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    renderSidebar();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit);
}
```

- [ ] **Step 3: styles.css —— 内联 input 样式**

在 `styles.css` 末尾追加：

```css
/* --- Inline session rename --- */
.session-rename-input {
  flex: 1; min-width: 0;
  background: var(--bg-sidebar); border: 1px solid var(--accent);
  border-radius: 5px; padding: 3px 6px;
  color: var(--text-primary); font-size: 12px; font-family: inherit;
}
.session-rename-input:focus { outline: none; }
```

- [ ] **Step 4: typecheck**

Run: `cd desktop && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 手动冒烟 + tmux 持久化验证**

Run: `cd desktop && npm run dev`
预期：双击侧边栏会话标签变成输入框；改名回车后侧边栏显示新名字；清空回车恢复默认名（workdir 末段）。持久化验证：改名后重启 ccdeskd（tmux 模式），刷新侧边栏名字仍在。

- [ ] **Step 6: Commit**

```bash
git add desktop/src/renderer/rest.ts desktop/src/renderer/index.ts desktop/src/renderer/styles.css
git commit -m "$(cat <<'EOF'
feat(desktop): 会话双击内联重命名

双击侧边栏标签就地编辑，Enter/失焦提交、Esc 取消、空值回落默认名；
提交后从服务端刷新权威 title 保证多端一致。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 阶段四：圆点兜底（纯客户端，3A）

### Task 6: 非活动会话有新输出圆点

**Files:**
- Modify: `desktop/src/renderer/index.ts`（`SessionView.activity` + onData 标记 + 抑制窗口 + setActive 清除 + renderSidebar 圆点）
- Modify: `desktop/src/renderer/styles.css`（`.session-unread` 圆点）

**Interfaces:**
- Consumes：`SessionView`、`client.onData`、`client.onReady`、`setActive`、`renderSidebar`（均已有）。
- Produces：`SessionView.activity: 'none' | 'output' | 'idle' | 'waiting'`（本 Task 只用 `'none'`/`'output'`；`'idle'`/`'waiting'` 由阶段五 hook 事件写入，此处先定义好联合类型）。`SessionView.suppressUntil: number`（抑制窗口截止时间戳，ms）。

- [ ] **Step 1: index.ts —— SessionView 加 activity + suppressUntil 字段**

修改 `SessionView` 接口（Task 2 已加 `banner` 字段的那个接口），追加两个字段：

```typescript
interface SessionView {
  key: string;
  machine: MachineConfig;
  sessionId: string;
  client: CcdeskClient;
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLElement;
  banner: HTMLElement;
  activity: 'none' | 'output' | 'idle' | 'waiting'; // sidebar dot state
  suppressUntil: number; // ms timestamp: ignore onData activity until then (attach repaint)
}
```

在 `const view: SessionView = {...}` 字面量里补上初值（Task 2 Step 3 的那个字面量）：

```typescript
  const view: SessionView = { key, machine, sessionId, client, terminal: term, fitAddon: fit, container, banner, activity: 'none', suppressUntil: 0 };
```

- [ ] **Step 2: index.ts —— onData 标记活动（带抑制窗口）**

修改 `client.onData`（第 165 行）。替换：

```typescript
  client.onData = (payload: string) => {
    term.write(base64ToBytes(payload));
    // Mark background activity as a dot — but not during the post-attach
    // suppression window (tmux full repaint would false-trigger it), and not
    // for the session the user is actively viewing.
    if (view.key !== activeKey && Date.now() >= view.suppressUntil) {
      if (view.activity === 'none') {
        view.activity = 'output';
        renderSidebar();
      }
    }
  };
```

- [ ] **Step 3: index.ts —— onReady 设置抑制窗口**

在 `client.onReady` 回调体里（Task 2 Step 4 已加 `view.banner.style.display = 'none';`），在 `term.clear();` 之后加：

```typescript
    // Suppress activity marking briefly so the tmux full repaint on (re)attach
    // doesn't false-light the dot. 500ms is an empirical, tunable value.
    view.suppressUntil = Date.now() + 500;
```

- [ ] **Step 4: index.ts —— setActive 清除活动**

在 `setActive()`（第 205 行）里，设置 activeKey 后清除该 view 的 activity。在 `activeKey = key;` 之后加：

```typescript
  const activeView = views.get(key);
  if (activeView && activeView.activity !== 'none') {
    activeView.activity = 'none';
  }
```

- [ ] **Step 5: index.ts —— renderSidebar 画圆点**

修改 `renderSidebar()` 里 session-item 构建（第 245-261 行）。在 `const close = ...` 之前插入圆点构建，并调整 append 顺序。替换第 254-261 行区域：

```typescript
      const dot = document.createElement('span');
      dot.className = 'session-unread';
      const openView = views.get(key);
      const act = openView?.activity ?? 'none';
      if (act === 'none' || key === activeKey) {
        dot.classList.add('hidden');
      } else {
        dot.classList.add(act); // 'output' | 'idle' | 'waiting'
      }

      const close = document.createElement('span');
      close.className = 'session-close';
      close.textContent = '×';
      close.title = 'Close session (kills remote claude)';
      close.addEventListener('click', (e) => { e.stopPropagation(); closeSession(machine, s.id); });

      item.append(label, dot, close);
      list.appendChild(item);
```

- [ ] **Step 6: styles.css —— 圆点样式**

在 `styles.css` 末尾追加：

```css
/* --- Session activity dot --- */
.session-unread {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  background: var(--accent); /* 'output' default: accent blue */
}
.session-unread.idle { background: var(--success); }
.session-unread.waiting {
  background: var(--warning);
  box-shadow: 0 0 0 3px rgba(249, 226, 175, 0.12);
}
.session-unread.hidden { display: none; }
/* Keep the × from overlapping the dot: dot hides on hover so × takes its slot. */
.session-item:hover .session-unread { display: none; }
```

- [ ] **Step 7: typecheck**

Run: `cd desktop && npm run typecheck`
Expected: PASS

- [ ] **Step 8: 手动冒烟**

Run: `cd desktop && npm run dev`（用 `claude_cmd: /bin/bash` 的本地 ccdeskd，开两个会话）
预期：在会话 A，切到会话 B；在 B 里 `echo` 出点东西 → 侧边栏 A 项亮蓝点；切回 A → 蓝点消失。刚 attach/切换的一瞬间不应误亮（500ms 抑制窗口）。

- [ ] **Step 9: Commit**

```bash
git add desktop/src/renderer/index.ts desktop/src/renderer/styles.css
git commit -m "$(cat <<'EOF'
feat(desktop): 非活动会话有新输出圆点（A 兜底）

onData 标记后台会话活动为蓝点，切入即清除；attach 全量重绘用 500ms
抑制窗口避免误报。activity 联合类型预留 idle/waiting 供 hook 事件升级。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 阶段五：事件基建（服务端 + 协议 + 客户端，3C；hook 自动注入留接口不实现）

### Task 7: 协议 —— notify 帧 + events 请求体（两端）

**Files:**
- Modify: `ccdeskd/internal/protocol/protocol.go`（`TypeNotify`、`NotifyFrame`、`EventRequest`）
- Modify: `desktop/src/shared/protocol.ts`（`FrameType.Notify`、`NotifyFrame`、union）
- Modify: `docs/protocol.md`（notify 帧 + events 端点）

**Interfaces:**
- Produces（Go）：
  - `protocol.TypeNotify = "notify"`
  - `protocol.NotifyFrame{ Type, SessionID string; Kind string; Message string }`
  - `protocol.EventRequest{ SessionID, Kind, Message string }`（events 端点请求体）
- Produces（TS）：
  - `FrameType.Notify = 'notify'`
  - `NotifyFrame { type; sessionId; kind; message? }` 并入 `ServerFrame` union。

- [ ] **Step 1: protocol.go —— 加常量与类型**

修改 `ccdeskd/internal/protocol/protocol.go`。在常量块（第 5-16 行）加 `TypeNotify`：

```go
	TypeNotify   = "notify"
```

在 `ErrorFrame` 之后（第 82 行后）加：

```go
// NotifyFrame carries an out-of-band session event to the client (e.g. from a
// claude hook via the events endpoint). Kind is an open string ("idle",
// "waiting", or future kinds); clients ignore kinds they don't recognize.
type NotifyFrame struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"`
	Message   string `json:"message,omitempty"`
}

// EventRequest is the JSON body posted to POST /api/v1/events by hooks (or any
// tailnet-local reporter). Transport reuses the existing HTTP server + Bearer
// auth + tailscale binding. Kind is an open enum for forward-compatibility.
type EventRequest struct {
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"`
	Message   string `json:"message,omitempty"`
}
```

- [ ] **Step 2: protocol.ts —— 加类型并入 union**

修改 `desktop/src/shared/protocol.ts`。在 `FrameType`（第 3-14 行）加：

```typescript
  Notify: 'notify',
```

在 `PongFrame`（第 83-85 行）之后加：

```typescript
export interface NotifyFrame {
  type: typeof FrameType.Notify;
  sessionId: string;
  kind: string; // 'idle' | 'waiting' | future kinds (open enum)
  message?: string;
}
```

在 `ServerFrame` union（第 88-94 行）加 `| NotifyFrame`：

```typescript
export type ServerFrame =
  | ReadyFrame
  | DataFrameS2C
  | SessionsFrame
  | ExitFrame
  | ErrorFrame
  | PongFrame
  | NotifyFrame;
```

- [ ] **Step 3: docs/protocol.md —— notify 帧 + events 端点**

修改 `docs/protocol.md`。在 error 帧（第 118-124 行）之后加一节：

```markdown
### notify (S→C)

带外会话事件（如 claude hook 经 events 端点上报）。`kind` 为开放枚举，客户端忽略不认识的 kind。

```json
{"type": "notify", "sessionId": "1720000000000", "kind": "waiting", "message": "需要确认权限"}
```

- `kind: "idle"`：claude 完成一次响应（Stop hook）
- `kind: "waiting"`：claude 需要权限确认/等待输入（Notification hook）
```

在 REST 表格（Task 4 已加 rename 行）后追加一行：

```markdown
| POST | `/api/v1/events` | 带外事件上报，body `{sessionId,kind,message?}`，路由为该会话的 notify 帧 |
```

- [ ] **Step 4: 两端编译确认**

Run: `cd ccdeskd && go build ./... && cd ../desktop && npm run typecheck`
Expected: 两端均 PASS

- [ ] **Step 5: Commit**

```bash
git add ccdeskd/internal/protocol/protocol.go desktop/src/shared/protocol.ts docs/protocol.md
git commit -m "$(cat <<'EOF'
feat(protocol): 新增 notify 帧 + events 请求体（两端对齐）

带外事件通道协议：notify 帧（kind 开放枚举）+ EventRequest 请求体，
docs/protocol.md 同步。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### Task 8: 服务端 —— Manager pub/sub 路由表

**Files:**
- Modify: `ccdeskd/internal/session/manager.go`（`subs` map + `Subscribe`/`PublishEvent`）
- Modify: `ccdeskd/internal/session/manager_test.go`（pub/sub 测试）

**Interfaces:**
- Consumes：`protocol.NotifyFrame`（Task 7）。
- Produces：
  - `(*Manager).Subscribe(sessionID string) (ch <-chan protocol.NotifyFrame, unsubscribe func())` — 订阅某会话的 notify 事件；返回只读 channel（buffer 16）与退订函数。
  - `(*Manager).PublishEvent(sessionID string, f protocol.NotifyFrame)` — 广播给该会话所有订阅者；非阻塞（channel 满则丢弃该条）。

- [ ] **Step 1: 写失败测试 —— 订阅/发布/退订/多订阅者**

在 `ccdeskd/internal/session/manager_test.go` 末尾追加：

```go
func newTestManager() *Manager {
	return &Manager{
		sessions: map[string]*Runner{},
		subs:     map[string][]chan protocol.NotifyFrame{},
	}
}

func TestPubSubDelivers(t *testing.T) {
	m := newTestManager()
	ch, unsub := m.Subscribe("s1")
	defer unsub()

	m.PublishEvent("s1", protocol.NotifyFrame{Type: protocol.TypeNotify, SessionID: "s1", Kind: "idle"})

	select {
	case f := <-ch:
		if f.Kind != "idle" {
			t.Errorf("kind = %q, want idle", f.Kind)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for event")
	}
}

func TestPubSubMultipleSubscribers(t *testing.T) {
	m := newTestManager()
	ch1, unsub1 := m.Subscribe("s1")
	defer unsub1()
	ch2, unsub2 := m.Subscribe("s1")
	defer unsub2()

	m.PublishEvent("s1", protocol.NotifyFrame{Kind: "waiting"})

	for i, ch := range []<-chan protocol.NotifyFrame{ch1, ch2} {
		select {
		case f := <-ch:
			if f.Kind != "waiting" {
				t.Errorf("subscriber %d kind = %q, want waiting", i, f.Kind)
			}
		case <-time.After(time.Second):
			t.Fatalf("subscriber %d timed out", i)
		}
	}
}

func TestPubSubUnsubscribeRemoves(t *testing.T) {
	m := newTestManager()
	_, unsub := m.Subscribe("s1")
	unsub()

	m.mu.RLock()
	n := len(m.subs["s1"])
	m.mu.RUnlock()
	if n != 0 {
		t.Errorf("after unsubscribe, subs[s1] len = %d, want 0", n)
	}
}

func TestPublishToNoSubscribersIsNoop(t *testing.T) {
	m := newTestManager()
	// Must not panic or block.
	m.PublishEvent("ghost", protocol.NotifyFrame{Kind: "idle"})
}
```

顶部 import 加 `"time"` 和 protocol（`manager_test.go` 目前只 import `strings`/`testing`）：

```go
import (
	"strings"
	"testing"
	"time"

	"github.com/anthropic/ccdesk/ccdeskd/internal/protocol"
)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd ccdeskd && go test ./internal/session -run TestPubSub -v`
Expected: FAIL（`subs` 字段 / `Subscribe` / `PublishEvent` 未定义，编译错误）

- [ ] **Step 3: manager.go —— 加 subs 字段 + Subscribe/PublishEvent**

修改 `ccdeskd/internal/session/manager.go`。在 `Manager` struct（第 14-22 行）加字段：

```go
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Runner
	subs     map[string][]chan protocol.NotifyFrame // sessionID → notify subscribers

	useTmux    bool
	claudeCmd  string
	loginShell bool
	shell      string
}
```

在 `NewManager`（第 25-33 行）初始化 `subs`：

```go
func NewManager(useTmux bool, claudeCmd string, loginShell bool, shell string) *Manager {
	return &Manager{
		sessions:   make(map[string]*Runner),
		subs:       make(map[string][]chan protocol.NotifyFrame),
		useTmux:    useTmux,
		claudeCmd:  claudeCmd,
		loginShell: loginShell,
		shell:      shell,
	}
}
```

在文件末尾（`generateID` 之前或之后均可）追加：

```go
// Subscribe registers a subscriber for a session's out-of-band notify events.
// Returns a receive-only channel (buffered so a brief consumer stall doesn't
// block the publisher) and an idempotent unsubscribe function. A wsRelay
// subscribes on attach and unsubscribes on teardown.
func (m *Manager) Subscribe(sessionID string) (<-chan protocol.NotifyFrame, func()) {
	ch := make(chan protocol.NotifyFrame, 16)
	m.mu.Lock()
	m.subs[sessionID] = append(m.subs[sessionID], ch)
	m.mu.Unlock()

	var once sync.Once
	unsub := func() {
		once.Do(func() {
			m.mu.Lock()
			subs := m.subs[sessionID]
			for i, c := range subs {
				if c == ch {
					m.subs[sessionID] = append(subs[:i], subs[i+1:]...)
					break
				}
			}
			if len(m.subs[sessionID]) == 0 {
				delete(m.subs, sessionID)
			}
			m.mu.Unlock()
			close(ch)
		})
	}
	return ch, unsub
}

// PublishEvent broadcasts a notify frame to every subscriber of a session.
// Non-blocking: if a subscriber's buffer is full, that event is dropped for
// that subscriber rather than stalling the events endpoint.
func (m *Manager) PublishEvent(sessionID string, f protocol.NotifyFrame) {
	m.mu.RLock()
	subs := append([]chan protocol.NotifyFrame(nil), m.subs[sessionID]...)
	m.mu.RUnlock()
	for _, ch := range subs {
		select {
		case ch <- f:
		default: // subscriber lagging — drop rather than block
		}
	}
}
```

- [ ] **Step 4: 运行测试确认通过 + race**

Run: `cd ccdeskd && go test ./internal/session -run TestPubSub -race -v`
Expected: PASS（race 无告警）

- [ ] **Step 5: Commit**

```bash
git add ccdeskd/internal/session/manager.go ccdeskd/internal/session/manager_test.go
git commit -m "$(cat <<'EOF'
feat(ccdeskd): Manager pub/sub 路由表（Subscribe/PublishEvent）

按 sessionID 订阅 notify 事件，缓冲 channel + 幂等退订；发布非阻塞
（订阅者满则丢弃），支持同会话多订阅者广播。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### Task 9: 服务端 —— events 端点 + wsRelay 订阅转发 + 环境变量注入

**Files:**
- Modify: `ccdeskd/internal/server/server.go`（注册 + `handleEvents`）
- Modify: `ccdeskd/internal/server/ws.go`（`wsRelay` 订阅 + notify 转发 goroutine）
- Modify: `ccdeskd/internal/session/runner.go`（`cmd.Env` 注入三个 `CCDESK_*`，两处）
- Modify: `ccdeskd/internal/session/manager.go`（`Create` 传入 events URL 所需的 bind/port/token；见下）
- Create: `ccdeskd/internal/server/events_test.go`（端点鉴权 + 路由）

**Interfaces:**
- Consumes：`(*Manager).PublishEvent`、`Subscribe`（Task 8）；`protocol.EventRequest`、`NotifyFrame`（Task 7）；`s.checkToken`（server.go）。
- Produces：`POST /api/v1/events`。环境变量 `CCDESK_SESSION_ID`、`CCDESK_EVENTS_URL`、`CCDESK_TOKEN` 注入 claude 进程。

> **设计说明**：runner 需要知道 events URL（`http://<bind>:<port>/api/v1/events`）和 token 才能注入环境变量。当前 `RunnerConfig` 不含这些。最小改动：给 `RunnerConfig` 和 `Runner` 加 `EventsURL string` 和 `Token string` 字段，由 `Manager.Create` 从 Manager 新增的 `eventsURL`/`token` 字段传入；Manager 这两个字段在 `NewManager` 时由调用方（main）传入。**但为避免改动 `NewManager` 签名波及面**，采用更小的方案：给 Manager 加一个可选 setter `SetEventEnv(eventsURL, token string)`，main 在构造后调用。

- [ ] **Step 1: 写失败测试 —— events 端点鉴权 + 路由到订阅者**

创建 `ccdeskd/internal/server/events_test.go`：

```go
package server

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/anthropic/ccdesk/ccdeskd/internal/config"
	"github.com/anthropic/ccdesk/ccdeskd/internal/protocol"
	"github.com/anthropic/ccdesk/ccdeskd/internal/session"
)

func newTestServer() *Server {
	cfg := &config.Config{Token: "secret", BindAddr: "100.64.0.1", Port: 8765}
	mgr := session.NewManager(false, "/bin/bash", false, "")
	return New(cfg, mgr)
}

func TestEventsRejectsBadToken(t *testing.T) {
	s := newTestServer()
	req := httptest.NewRequest("POST", "/api/v1/events",
		bytes.NewBufferString(`{"sessionId":"s1","kind":"idle"}`))
	req.Header.Set("Authorization", "Bearer wrong")
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("code = %d, want 401", w.Code)
	}
}

func TestEventsRoutesToSubscriber(t *testing.T) {
	s := newTestServer()
	ch, unsub := s.mgr.Subscribe("s1")
	defer unsub()

	req := httptest.NewRequest("POST", "/api/v1/events",
		bytes.NewBufferString(`{"sessionId":"s1","kind":"waiting","message":"hi"}`))
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("code = %d, want 204", w.Code)
	}

	select {
	case f := <-ch:
		if f.Kind != "waiting" || f.SessionID != "s1" {
			t.Errorf("frame = %+v, want kind=waiting sessionId=s1", f)
		}
		if f.Type != protocol.TypeNotify {
			t.Errorf("type = %q, want notify", f.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("event not delivered to subscriber")
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd ccdeskd && go test ./internal/server -run TestEvents -v`
Expected: FAIL（`/api/v1/events` 未注册 → 404，或编译错误）

- [ ] **Step 3: server.go —— 注册 + handleEvents**

修改 `ccdeskd/internal/server/server.go`。在 `routes()` 加：

```go
	s.mux.HandleFunc("POST /api/v1/events", s.handleEvents)
```

在 `handleRenameSession`（Task 4）之后加：

```go
// handleEvents receives an out-of-band session event (from a claude hook or any
// tailnet-local reporter) and routes it to the session's WS subscribers as a
// notify frame. Reuses the same Bearer auth as every other REST endpoint.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	var body protocol.EventRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.SessionID == "" || body.Kind == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sessionId and kind required"})
		return
	}
	s.mgr.PublishEvent(body.SessionID, protocol.NotifyFrame{
		Type:      protocol.TypeNotify,
		SessionID: body.SessionID,
		Kind:      body.Kind,
		Message:   body.Message,
	})
	w.WriteHeader(http.StatusNoContent)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd ccdeskd && go test ./internal/server -run TestEvents -v`
Expected: PASS

- [ ] **Step 5: ws.go —— wsRelay 订阅 + notify 转发 goroutine**

修改 `ccdeskd/internal/server/ws.go` 的 `wsRelay`（第 160 行起）。在 `epoch := runner.CurrentEpoch()` 之后、`detaching` 声明之前，加订阅与转发：

```go
	// Subscribe to out-of-band notify events for this session and forward them
	// to the client as notify frames. Unsubscribe on teardown so we don't leak.
	notifyCh, unsub := s.mgr.Subscribe(sessionID)
	defer unsub()
	go func() {
		for f := range notifyCh {
			if err := wsjson.Write(ctx, conn, f); err != nil {
				return
			}
		}
	}()
```

- [ ] **Step 6: runner.go —— cmd.Env 注入 CCDESK_* 变量（两处）**

修改 `ccdeskd/internal/session/runner.go`。先给 `RunnerConfig`（第 83-92 行）和 `Runner`（第 61-80 行）加字段：

`Runner` struct 加：

```go
	eventsURL string
	token     string
```

`RunnerConfig` 加：

```go
	EventsURL string
	Token     string
```

`NewRunner`（第 95-104 行）里把配置带入：

```go
	r := &Runner{
		ID:         cfg.ID,
		Workdir:    cfg.Workdir,
		Created:    time.Now(),
		useTmux:    cfg.UseTmux,
		claudeCmd:  cfg.ClaudeCmd,
		loginShell: cfg.LoginShell,
		shell:      cfg.Shell,
		eventsURL:  cfg.EventsURL,
		token:      cfg.Token,
	}
```

新增一个 helper（文件末尾）：

```go
// ccdeskEnv returns the CCDESK_* environment variables injected into the claude
// process so a hook (claude's child) can report out-of-band events back to this
// daemon's events endpoint. These are inert unless a hook actually uses them —
// the hook wiring itself is intentionally out of scope for now (see plan).
func (r *Runner) ccdeskEnv() []string {
	env := []string{"CCDESK_SESSION_ID=" + r.ID}
	if r.eventsURL != "" {
		env = append(env, "CCDESK_EVENTS_URL="+r.eventsURL)
	}
	if r.token != "" {
		env = append(env, "CCDESK_TOKEN="+r.token)
	}
	return env
}
```

在 `start()` 的 `cmd.Env`（第 150-153 行）追加：

```go
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)
	cmd.Env = append(cmd.Env, r.ccdeskEnv()...)
```

在 `AttachExisting()` 的 `cmd.Env`（第 197-200 行）同样追加：

```go
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)
	cmd.Env = append(cmd.Env, r.ccdeskEnv()...)
```

- [ ] **Step 7: manager.go —— Create 传入 EventsURL/Token + SetEventEnv setter**

修改 `ccdeskd/internal/session/manager.go`。给 `Manager` struct 加两个字段：

```go
	eventsURL string
	token     string
```

新增 setter（`NewManager` 之后）：

```go
// SetEventEnv configures the events endpoint URL and token injected into new
// sessions' environment (for hook-based out-of-band reporting). Called once at
// startup after the bind address/port/token are known.
func (m *Manager) SetEventEnv(eventsURL, token string) {
	m.eventsURL = eventsURL
	m.token = token
}
```

在 `Create()` 的 `NewRunner(RunnerConfig{...})`（第 39-48 行）里加两字段：

```go
	runner, err := NewRunner(RunnerConfig{
		ID:         id,
		Workdir:    workdir,
		UseTmux:    m.useTmux,
		ClaudeCmd:  m.claudeCmd,
		LoginShell: m.loginShell,
		Shell:      m.shell,
		Cols:       cols,
		Rows:       rows,
		EventsURL:  m.eventsURL,
		Token:      m.token,
	})
```

- [ ] **Step 8: main.go —— 调用 SetEventEnv**

Read: `ccdeskd/cmd/ccdeskd/main.go`（确认 Manager 构造点），在构造 `mgr` 之后、启动 server 之前加：

```go
	mgr.SetEventEnv(fmt.Sprintf("http://%s:%d/api/v1/events", cfg.BindAddr, cfg.Port), cfg.Token)
```

（若 main.go 未 import `fmt`，加上。具体行号以实际文件为准——此步先 Read main.go 定位 Manager 构造与 server 启动。）

- [ ] **Step 9: 全量测试 + race build**

Run: `cd ccdeskd && go test ./... && go build -race ./...`
Expected: 全部 PASS，race build 无告警

- [ ] **Step 10: 手动全链路验证（events → notify → 客户端圆点，hook 用手动 curl 代替）**

Run（本地起 ccdeskd，desktop dev 连上开会话，拿到 sessionId 后）：

```bash
curl -s -X POST http://<bind>:<port>/api/v1/events \
  -H "Authorization: Bearer <token>" \
  -d '{"sessionId":"<id>","kind":"waiting","message":"test"}' -w '%{http_code}\n'
```

Expected: 返回 204；desktop 客户端该会话（若非活动）圆点变黄（waiting）。这验证了除「claude 自动触发 hook」外的全链路。（客户端 onNotify 消费在 Task 10。）

- [ ] **Step 11: Commit**

```bash
git add ccdeskd/internal/server/server.go ccdeskd/internal/server/ws.go ccdeskd/internal/server/events_test.go ccdeskd/internal/session/runner.go ccdeskd/internal/session/manager.go ccdeskd/cmd/ccdeskd/main.go
git commit -m "$(cat <<'EOF'
feat(ccdeskd): 通用 events 端点 + wsRelay 订阅转发 + CCDESK_* 环境变量

POST /api/v1/events 收带外事件路由为 notify 帧；wsRelay attach 时订阅、
teardown 退订；claude 进程注入 CCDESK_SESSION_ID/EVENTS_URL/TOKEN
（hook 自动注入本期留接口不实现，变量本身无副作用）。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### Task 10: 客户端 —— onNotify 消费 + 圆点语义升级 + 桌面通知

**Files:**
- Modify: `desktop/src/renderer/client.ts`（`onNotify` 回调 + handleMessage case）
- Modify: `desktop/src/renderer/index.ts`（onNotify → activity 升级 + 桌面通知）

**Interfaces:**
- Consumes：`NotifyFrame`（Task 7）；`SessionView.activity`（Task 6）；`renderSidebar`。
- Produces：`CcdeskClient.onNotify?: (kind: string, message?: string) => void`。

- [ ] **Step 1: client.ts —— onNotify 回调 + case**

修改 `desktop/src/renderer/client.ts`。顶部 import 加 `NotifyFrame`（第 1-11 行的 import 块）：

```typescript
  type ServerFrame,
  type SessionInfo,
  type MachineConfig,
```

（`ServerFrame` union 已含 `NotifyFrame`，无需单独 import 类型用于 switch；但需要回调声明。）在回调区（第 39 行 `onReady` 后）加：

```typescript
  onNotify?: (kind: string, message?: string) => void;
```

在 `handleMessage` 的 switch（第 165-194 行）加 case：

```typescript
      case FrameType.Notify:
        this.onNotify?.(frame.kind, frame.message);
        break;
```

- [ ] **Step 2: index.ts —— onNotify 升级 activity + 桌面通知**

修改 `desktop/src/renderer/index.ts`。在 `openSession()` 里 `client.onError` 之后（第 194 行后）加：

```typescript
  client.onNotify = (kind, message) => {
    // hook 事件把圆点从「有输出」升级为语义状态。活动会话不标记（用户在看）。
    if (kind === 'idle' || kind === 'waiting') {
      if (view.key !== activeKey) {
        view.activity = kind;
        renderSidebar();
      }
      // waiting = 需要用户介入，可选弹桌面通知（移动端伏笔）。
      if (kind === 'waiting' && notificationsEnabled()) {
        const title = view.terminal ? (views.get(view.key)?.sessionId || 'ccdesk') : 'ccdesk';
        notifyDesktop(`${machine.name} · ${title}`, message || 'Claude 需要你的确认');
      }
    }
  };
```

在文件末尾（`// --- Boot ---` 之前）加桌面通知 helper：

```typescript
// --- Desktop notifications (optional, for `waiting` events) ---
// A simple localStorage flag gates whether we attempt OS notifications. The OS
// permission itself is separate: a denied permission silently degrades to just
// the sidebar dot. The machine-manager settings can flip this flag.
function notificationsEnabled(): boolean {
  return localStorage.getItem('ccdesk.notifications') !== 'off';
}

function notifyDesktop(title: string, body: string) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body });
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((perm) => {
      if (perm === 'granted') new Notification(title, { body });
    });
  }
}
```

- [ ] **Step 3: typecheck**

Run: `cd desktop && npm run typecheck`
Expected: PASS

- [ ] **Step 4: 手动全链路冒烟**

Run: `cd desktop && npm run dev`（连本地 ccdeskd，开两个会话，切到会话 B）
用 Task 9 Step 10 的 curl 向会话 A 发 `kind:"waiting"`：
预期：侧边栏 A 项圆点变黄（waiting）；若 OS 通知权限已授予，弹出桌面通知「<机器名> · …」。发 `kind:"idle"` → 圆点变绿。切到 A → 圆点消失。

- [ ] **Step 5: Commit**

```bash
git add desktop/src/renderer/client.ts desktop/src/renderer/index.ts
git commit -m "$(cat <<'EOF'
feat(desktop): onNotify 消费——圆点语义升级 + waiting 桌面通知

notify 帧把后台会话圆点从蓝（有输出）升级为绿（idle）/黄（waiting）；
waiting 可选弹 Electron 桌面通知（localStorage 开关，权限拒绝则降级圆点）。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 收尾：文档与全链路回归

### Task 11: 更新 CLAUDE.md 状态 + README + 全链路回归

**Files:**
- Modify: `CLAUDE.md`（「状态」节：把新做的四块从「未做」移出，记录 hook 自动注入的留空状态）
- Modify: `README.md`（如需补机器管理 UI / 会话命名说明）

- [ ] **Step 1: CLAUDE.md —— 更新状态节**

修改 `CLAUDE.md` 末尾「## 状态」节，追加一段：

```markdown
### 第二批体验增强（已完成）

- 机器管理 app 内 UI（CRUD + 空状态引导 + 测试连接），不再手改 machines.json。
- 会话命名：默认名跟随 workdir，双击侧边栏内联重命名，名字存 tmux 用户选项 `@ccdesk_name`（跟随 tmux 生命周期，重启/多端一致）。
- 后台会话提示：A 圆点兜底（非活动会话有字节到达即亮蓝点，任何 agent 通用）+ C hook 事件增强（notify 帧把圆点升级为 idle 绿/waiting 黄 + 可选桌面通知）。
- 重连体验：状态栏显示重连尝试次数 + 活动会话终端顶部断线横幅 + Retry now。

**事件基建（通用可扩展）**：`POST /api/v1/events`（Bearer 鉴权，body `{sessionId,kind,message?}`）+ Manager pub/sub 路由表 + notify 帧。`kind` 为开放枚举，未来带外事件（token 用量等）复用此通道。claude 进程已注入 `CCDESK_SESSION_ID`/`CCDESK_EVENTS_URL`/`CCDESK_TOKEN`。

**⚠️ 故意留空（本期不实现）**：ccdeskd 自动生成 hook 配置让 claude 带上（`--settings` 注入方式需真机验证 claude 版本合并语义）。当前靠手动配 hook 或手动 curl events 端点即可验证全链路；日后补「自动注入」一小段，前面基建全不用动。
```

- [ ] **Step 2: 全量测试 + race build 回归**

Run: `cd ccdeskd && go test ./... && go vet ./... && go build -race ./...`
Expected: 全部 PASS

- [ ] **Step 3: typecheck 回归**

Run: `cd desktop && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs: 更新 CLAUDE.md 状态节记录第二批体验增强

四块特性 + 事件基建已完成；hook 自动注入明确标为故意留空。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review 记录

**1. Spec coverage（规格覆盖）：**
- 机器管理 CRUD + 空状态引导 + 测试连接 → Task 1 ✓
- 会话命名（tmux 存储 + 默认名规则 + 双击内联 + REST rename）→ Task 3/4/5 ✓
- 后台提示 A 圆点（onData + 500ms 抑制窗口）→ Task 6 ✓
- 后台提示 C hook 事件（events 端点 + pub/sub + notify 帧 + 环境变量 + onNotify + 桌面通知）→ Task 7/8/9/10 ✓
- hook 自动注入留接口不实现 → Task 9 环境变量注入到位，注入配置明确留空，Task 11 记录 ✓
- 重连体验（状态栏 attempt + 终端横幅）→ Task 2 ✓
- 四个默认决策（删机器不杀会话 / 名字净化 / 通知权限降级 / 500ms 可调）→ 分别落在 Task 1 Step 4、Task 3 Step 3、Task 10 Step 2、Task 6 Step 3 ✓

**2. Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整代码；唯一「以实际文件为准」在 Task 9 Step 8（main.go 行号），已要求先 Read 定位，非占位符。

**3. Type consistency：**
- `activity: 'none'|'output'|'idle'|'waiting'` 在 Task 6 定义，Task 10 写 `'idle'`/`'waiting'` 一致。
- `NotifyFrame` 字段（`sessionId`/`kind`/`message`）Go（Task 7 Step 1）与 TS（Task 7 Step 2）一致；client `onNotify(kind, message)` 与 handleMessage 传参一致。
- `Subscribe` 返回 `(<-chan NotifyFrame, func())`，Task 8 定义、Task 9 Step 5 消费一致。
- `renameSession(id, name)` REST 方法（Task 5）与后端 `POST .../rename` body `{name}`（Task 4）一致。
- `SetEventEnv(eventsURL, token)`（Task 9 Step 7）与 main 调用（Step 8）一致。
