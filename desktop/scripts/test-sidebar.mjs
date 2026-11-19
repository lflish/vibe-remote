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

await run();
