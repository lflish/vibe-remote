# 机器概览页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击桌面端侧边栏机器名时，在右侧显示该机器的精简概览卡片，并从卡片发起该机器的新会话。

**Architecture:** 保留现有 `activeKey` 会话状态，新增互斥的 `overviewMachineKey`。概览 DOM 与 xterm 会话容器并列，进入概览只隐藏终端、不销毁 WebSocket/xterm；点击会话或概览页新建按钮时恢复会话视图。概览数据直接消费现有的 `machineOnline`、`machineSessions` 与 `MachineConfig`，轮询时按当前概览机器刷新卡片。

**Tech Stack:** Electron renderer、TypeScript、原生 DOM、CSS、现有 `VibeRemoteRest` / `openDirPicker` / `openSession`。

## Global Constraints

- 必须保持 PTY 字节透传：客户端不解析 Claude 输出。
- 机器 Map 继续使用 `addr:port` 作为 key。
- 不新增协议或服务端接口；只复用现有 REST/WS 客户端。
- 不销毁进入概览前已打开的 `SessionView`；tmux/WS 生命周期保持现有行为。
- 概览页只显示精简卡片：机器名、连接状态、地址端口、会话总数、机器级新建按钮。
- 不在侧边栏机器标题行新增 `+` 图标；顶部全局新建按钮保持不变。
- 所有 UI 文案沿用当前 renderer 的英文文案风格。

---

### Task 1: Add overview DOM and styling

**Files:**
- Modify: `desktop/src/renderer/index.html:25-35`
- Modify: `desktop/src/renderer/styles.css` near `.empty-state` and main-area styles

**Interfaces:**
- Produces: a persistent `#machine-overview` element inside `#terminal-container`, hidden by default, and CSS classes `.machine-overview`, `.overview-card`, `.overview-status`, `.overview-meta`, `.overview-action`.

- [ ] **Step 1: Add the persistent overview mount point**

Insert this before the existing terminal containers are appended dynamically:

```html
<div id="terminal-container">
  <div id="machine-overview" class="machine-overview" hidden></div>
</div>
```

- [ ] **Step 2: Add the card styles**

Add styles that center the card in the main area without changing terminal layout:

```css
.machine-overview[hidden] { display: none; }
.machine-overview {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  box-sizing: border-box;
}
.overview-card {
  width: min(520px, 100%);
  padding: 28px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-surface);
  box-shadow: 0 8px 24px rgba(43, 42, 40, 0.08);
}
.overview-card h1 { margin: 0 0 8px; font-size: 22px; color: var(--text-primary); }
.overview-status { display: flex; align-items: center; gap: 8px; color: var(--text-secondary); }
.overview-status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--error); }
.overview-status-dot.connected { background: var(--success); }
.overview-meta { margin: 20px 0 24px; color: var(--text-muted); font-size: 13px; line-height: 1.7; }
.overview-action { width: auto; margin-top: 4px; }
```

- [ ] **Step 3: Verify the mount point does not alter empty-state markup**

Read the resulting `index.html` and confirm `#terminal-container` still exists exactly once and `#machine-overview` is its only static child. Do not add a second terminal root.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/renderer/index.html desktop/src/renderer/styles.css
git commit -m "feat(desktop): add machine overview mount and styles"
```

---

### Task 2: Implement overview state and rendering

**Files:**
- Modify: `desktop/src/renderer/index.ts:37-55,337-355,359-383,490-532`

**Interfaces:**
- Consumes: `machineKey`, `machineSessions`, `machineOnline`, `MachineConfig`, `openDirPicker`, `openSession`.
- Produces: `let overviewMachineKey: string | null`, `showMachineOverview(machine: MachineConfig): void`, `renderMachineOverview(machine: MachineConfig): void`.

- [ ] **Step 1: Add the overview state**

```ts
let overviewMachineKey: string | null = null;
```

- [ ] **Step 2: Implement `renderMachineOverview` with existing data sources**

```ts
function renderMachineOverview(machine: MachineConfig) {
  const mount = document.getElementById('machine-overview');
  if (!mount) return;
  const online = machineOnline.get(machineKey(machine)) === true;
  const count = machineSessions.get(machineKey(machine))?.length ?? 0;
  mount.textContent = '';

  const card = document.createElement('section');
  card.className = 'overview-card';
  const title = document.createElement('h1');
  title.textContent = machine.name;
  const status = document.createElement('div');
  status.className = 'overview-status';
  const dot = document.createElement('span');
  dot.className = `overview-status-dot${online ? ' connected' : ''}`;
  const statusText = document.createElement('span');
  statusText.textContent = online ? 'Connected' : 'Offline';
  status.append(dot, statusText);
  const meta = document.createElement('div');
  meta.className = 'overview-meta';
  meta.textContent = `${machine.addr}:${machine.port}\n${count} ${count === 1 ? 'session' : 'sessions'}`;
  meta.style.whiteSpace = 'pre-line';
  const create = document.createElement('button');
  create.className = 'btn-primary overview-action';
  create.textContent = '+ New Session';
  create.addEventListener('click', async () => {
    const picked = await openDirPicker(machine);
    if (picked === null) return;
    openSession(machine, '', picked.workdir, picked.flags);
  });
  card.append(title, status, meta, create);
  mount.append(card);
}
```

- [ ] **Step 3: Implement `showMachineOverview` and display switching**

```ts
function showMachineOverview(machine: MachineConfig) {
  overviewMachineKey = machineKey(machine);
  for (const view of views.values()) view.container.style.display = 'none';
  const mount = document.getElementById('machine-overview');
  if (mount) { mount.hidden = false; renderMachineOverview(machine); }
  updateStatusBar();
}
```

Extend `setActive` so it clears overview state and hides the mount before showing the selected terminal:

```ts
overviewMachineKey = null;
const overview = document.getElementById('machine-overview');
if (overview) overview.hidden = true;
```

Update the machine title click to call both existing selection logic and `showMachineOverview(machine)`.

- [ ] **Step 4: Make overview data refresh with the existing poll**

After `renderSidebar()` in `refreshAllMachines`, add:

```ts
if (overviewMachineKey) {
  const overviewMachine = machines.find((m) => machineKey(m) === overviewMachineKey);
  if (overviewMachine) renderMachineOverview(overviewMachine);
}
```

If the selected/overview machine disappeared in `onSaved`, clear `overviewMachineKey` and show either the first machine overview or `renderEmptyState()`.

- [ ] **Step 5: Update the status bar for overview mode**

Before the existing `if (view)` branch, derive the overview machine and add this branch:

```ts
const overviewMachine = overviewMachineKey
  ? machines.find((m) => machineKey(m) === overviewMachineKey)
  : null;
if (!view && overviewMachine) {
  const online = machineOnline.get(overviewMachineKey!) === true;
  tbTitle.textContent = overviewMachine.name;
  connEl.className = online ? 'connected' : 'error';
  connEl.textContent = online ? `Connected · ${overviewMachine.name}` : `Offline · ${overviewMachine.name}`;
  tbStatus.className = online ? 'connected' : 'error';
  tbStatusText.textContent = online ? 'Connected' : 'Offline';
  sessionEl.textContent = extra || '';
  return;
}
```

The `!view` condition ensures the active terminal status remains authoritative while a hidden view is retained.

- [ ] **Step 6: Show the first machine overview on initial load**

After the first successful `refreshAllMachines()` in `init`, call:

```ts
showMachineOverview(machines[0]);
```

Do not call this when `machines.length === 0`.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/renderer/index.ts
git commit -m "feat(desktop): render machine overview and scoped new session"
```

---

### Task 3: Verify the complete user flow

**Files:**
- No source changes expected.
- Test artifacts: `/tmp/vibe-machine-overview-check.mjs` (temporary, not committed)

**Interfaces:**
- Verifies: `showMachineOverview`, `setActive`, `renderMachineOverview`, existing `openDirPicker`/`openSession` integration.

- [ ] **Step 1: Run static checks**

Run:

```bash
cd desktop && npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 2: Start the local tmux + claude server**

```bash
cd /Users/mac/github/vibe-remote
TS_IP=$(tailscale ip -4 | head -1)
VIBE_REMOTED_BIND_ADDR=127.0.0.1 ./bin/vibe-remoted -config vibe-remoted.local-tmux.json
```

Expected log includes `bind=127.0.0.1:8765 tmux=true` and `listening`.

- [ ] **Step 3: Start Electron dev mode with CDP**

```bash
cd desktop
VIBE_REMOTE_DEBUG_PORT=9222 VIBE_REMOTE_NO_DEVTOOLS=1 npm run dev
```

Expected: Vite prints `Local: http://localhost:5173/`, Electron window opens.

- [ ] **Step 4: Use CDP to assert initial overview**

Evaluate:

```js
document.querySelector('#machine-overview')?.hidden === false
```

Expected: `true` when at least one machine is configured.

- [ ] **Step 5: Click a machine and assert card contents**

Click the machine name, then assert:

```js
const text = document.querySelector('#machine-overview')?.textContent ?? '';
text.includes(machine.name) && text.includes(`${machine.addr}:${machine.port}`)
```

Expected: `true`; status and singular/plural session count are present.

- [ ] **Step 6: Verify scoped create flow**

Click `.overview-action`, choose a directory in the existing picker, and assert that after `ready` the overview mount is hidden and a `.term-instance` is visible. Confirm the terminal receives real ANSI/Claude bytes; do not parse or transform PTY output in the application.

- [ ] **Step 7: Verify navigation preserves views**

With a live session open, click another machine name and assert all `.term-instance` elements remain in the DOM while `#machine-overview` is visible. Click the original session row and assert the overview is hidden and that same terminal container is visible.

- [ ] **Step 8: Verify polling and fallback**

While a machine overview is visible, change the server session list (create/delete remotely), wait for the 5-second poll, and assert the count updates. Remove the configured machine through machine manager and assert the app shows the first remaining machine overview; remove the last machine and assert `renderEmptyState()` appears.

- [ ] **Step 9: Commit verification notes if needed**

No verification script or generated screenshots should be committed. Record only confirmed results in the final response.
