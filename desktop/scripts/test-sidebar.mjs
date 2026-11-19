// sidebar.ts: the sidebar renderer. The first case is a byte-for-byte DOM
// snapshot captured from the pre-move renderer (T6a); the move must not change
// it. The behavior cases (added in the move commit) drive index.ts through
// loadIndex() so the real SidebarModel/SidebarActions wiring is exercised.
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { indexDom, loadIndex, runner } from './chat-test-util.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(here, 'fixtures', 'sidebar-flat.html');

const { test, run } = runner('test-sidebar');

const machineA = { name: 'alpha', addr: '10.0.0.1', port: 8765, token: 't' };
const machineB = { name: 'beta', addr: '10.0.0.2', port: 8765, token: 't' };
const mkA = '10.0.0.1:8765';
const mkB = '10.0.0.2:8765';

// A fixed data set: two machines (beta collapsed), three sessions on alpha (a
// terminal, a background chat whose dot is waiting, and the open/active one).
async function setupFlat() {
  const page = await indexDom();
  // Set persisted state the module reads at init, before loadIndex() runs it.
  localStorage.setItem('vibe-remote.locale', 'en');
  localStorage.setItem('vibe-remote.collapsed-machines', JSON.stringify([mkB]));
  const app = await loadIndex();
  app.setMachines([machineA, machineB]);
  app.machineOnline.set(mkA, true);
  app.machineOnline.set(mkB, true);
  app.machineSessions.set(mkA, [
    { id: 't1', title: 'build', workdir: '/w/a', created: '2026-11-14T00:00:00Z', mode: 'normal' },
    { id: 'c1', title: 'waiting chat', workdir: '/w/b', created: '2026-11-14T00:01:00Z', mode: 'normal', ui: 'chat', state: 'waiting' },
    { id: 'c2', title: 'open chat', workdir: '/w/c', created: '2026-11-14T00:02:00Z', mode: 'normal', ui: 'chat', state: 'running' },
  ]);
  app.machineSessions.set(mkB, [
    { id: 'b1', title: 'remote', workdir: '/w/d', created: '2026-11-14T00:03:00Z', mode: 'normal' },
  ]);
  const chatView = (id, activity) => {
    const container = document.createElement('div');
    document.getElementById('terminal-container').appendChild(container);
    return { ui: 'chat', key: `${mkA}::${id}`, sessionId: id, machine: machineA, container, activity, client: { state: 'connected' }, show() {} };
  };
  app.views.set(`${mkA}::c1`, chatView('c1', 'waiting'));
  app.views.set(`${mkA}::c2`, chatView('c2', 'none'));
  app.setActive(`${mkA}::c2`);
  return { page, app };
}

test('flat_dom_snapshot_unchanged', async () => {
  const { page } = await setupFlat();
  const html = document.getElementById('machine-list').innerHTML;
  if (process.env.UPDATE_SNAPSHOT) {
    writeFileSync(SNAPSHOT, html);
    console.log('updated snapshot');
  } else {
    assert.ok(existsSync(SNAPSHOT), 'snapshot file exists');
    assert.equal(html, readFileSync(SNAPSHOT, 'utf8'));
  }
  page.dom.window.close();
});

// A loadIndex() app with one machine and the given sessions, REST stubbed.
async function setupApp(sessions, { fetchHandler } = {}) {
  const page = await indexDom();
  localStorage.setItem('vibe-remote.locale', 'en');
  localStorage.removeItem('vibe-remote.collapsed-machines');
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body };
    calls.push(call);
    if (fetchHandler) {
      const r = await fetchHandler(call);
      if (r) return r;
    }
    if (call.url.endsWith('/api/v1/sessions')) {
      return new Response(JSON.stringify({ list: app.machineSessions.get(mkA) || [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(null, { status: 204 });
  };
  const app = await loadIndex();
  app.setMachines([machineA]);
  app.rebuildRests();
  app.machineOnline.set(mkA, true);
  app.machineSessions.set(mkA, sessions);
  app.renderSidebar();
  return { page, app, calls, restore() { globalThis.fetch = origFetch; } };
}

const term = (id, title) => ({ id, title, workdir: `/w/${id}`, created: `2026-11-14T00:00:0${id.length}Z`, mode: 'normal' });

test('no_rerender_while_renaming', async () => {
  const { page, app, restore } = await setupApp([term('t1', 'build')]);
  document.querySelector('.session-label').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const input = document.querySelector('.session-rename-input');
  assert.ok(input, 'rename input appeared');
  input.value = 'half-typed';
  app.renderSidebar(); // must be a no-op while renaming
  const after = document.querySelector('.session-rename-input');
  assert.equal(after, input, 'same input node survives the rebuild');
  assert.equal(after.value, 'half-typed', 'typed text preserved');
  restore();
  page.dom.window.close();
});

test('inline_rename_commits', async () => {
  const { page, app, calls, restore } = await setupApp([term('t1', 'build')]);
  // Enter commits: one rename POST carrying the new name.
  document.querySelector('.session-label').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  let input = document.querySelector('.session-rename-input');
  input.value = '登录修复';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  const renames = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/v1/sessions/t1/rename'));
  assert.equal(renames.length, 1, 'one rename request');
  assert.equal(JSON.parse(renames[0].body).name, '登录修复');
  // Esc cancels: no further rename request.
  const before = calls.length;
  document.querySelector('.session-label').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  input = document.querySelector('.session-rename-input');
  input.value = 'nope';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.filter((c) => c.url.endsWith('/api/v1/sessions/t1/rename')).length, 1, 'Esc sends no rename');
  assert.ok(calls.length >= before, 'no crash');
  restore();
  page.dom.window.close();
});

test('actions_fire_once', async () => {
  const origConfirm = window.confirm;
  const sessions = [
    { id: 'o', title: 'open', workdir: '/w/o', created: '2026-11-14T00:00:01Z', mode: 'normal', ui: 'chat', state: 'running' },
    term('d', 'del'),
  ];
  const { page, app, calls, restore } = await setupApp(sessions);
  window.confirm = () => true;
  // Pre-open a fake view for 'o' so clicking its row is an instant setActive.
  const container = document.createElement('div');
  document.getElementById('terminal-container').appendChild(container);
  app.views.set(`${mkA}::o`, { ui: 'chat', key: `${mkA}::o`, sessionId: 'o', machine: machineA, container, activity: 'none', client: { state: 'connected' }, show() {} });
  app.showMachineOverview(machineA);
  assert.equal(app.activeKey, null);

  // open: click the open session's row.
  const labelOf = (title) => [...document.querySelectorAll('.session-item')]
    .find((r) => r.querySelector('.session-label-text').textContent === title);
  labelOf('open').querySelector('.session-label').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.equal(app.activeKey, `${mkA}::o`, 'open switched the active session');

  // deleteSession: click close on the other row (confirm accepted).
  labelOf('del').querySelector('.session-close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  const deletes = calls.filter((c) => c.method === 'DELETE' && c.url.endsWith('/api/v1/sessions/d'));
  assert.equal(deletes.length, 1, 'exactly one DELETE');

  // toggleMachine: click the machine toggle.
  assert.equal(document.querySelector('.session-list').hidden, false);
  document.querySelector('.machine-toggle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.equal(document.querySelector('.session-list').hidden, true, 'machine collapsed');
  assert.ok(JSON.parse(localStorage.getItem('vibe-remote.collapsed-machines')).includes(mkA));

  window.confirm = origConfirm;
  restore();
  page.dom.window.close();
});

await run();
