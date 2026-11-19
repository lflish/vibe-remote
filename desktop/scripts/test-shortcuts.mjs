// shortcuts.ts (T16): ⌘1–9 opens the n-th session the sidebar shows, ⌘⇧[ / ⌘⇧]
// the previous / next one. The pure parts are tested directly; the listener in
// a jsdom page; the last cases drive index.ts through loadIndex() to check what
// "the sessions the sidebar shows" is wired to.
import { strict as assert } from 'node:assert';
import { indexDom, load, loadIndex, runner } from './chat-test-util.mjs';

await indexDom();
const { matchShortcut, pickTarget, installShortcuts } = await load('src/renderer/shortcuts.ts', { platform: 'browser' });

const { test, run } = runner('test-shortcuts');

const ev = (code, mods = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const CMD = { metaKey: true };
const CMD_SHIFT = { metaKey: true, shiftKey: true };

/** A real keydown, dispatched on `target`; `key` is what the layout would produce. */
function press(target, code, mods = {}, key = '') {
  const e = new KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true, ...mods });
  target.dispatchEvent(e);
  return e;
}

/** installShortcuts on the current window with recording deps. */
function install(over = {}) {
  const opened = [];
  const deps = { blocked: () => false, count: () => 5, activeIndex: () => 0, open: (i) => opened.push(i), ...over };
  const uninstall = installShortcuts(window, deps);
  return { opened, uninstall };
}

test('match_digits', () => {
  assert.deepEqual(matchShortcut(ev('Digit3', CMD)), { kind: 'index', n: 3 });
  assert.deepEqual(matchShortcut(ev('Digit1', CMD)), { kind: 'index', n: 1 });
  assert.deepEqual(matchShortcut(ev('Digit9', CMD)), { kind: 'index', n: 9 });
  assert.equal(matchShortcut(ev('Digit0', CMD)), null, '⌘0 is not a session');
  assert.equal(matchShortcut(ev('Digit3', { metaKey: true, altKey: true })), null, '⌘⌥3');
  assert.equal(matchShortcut(ev('Digit3', { metaKey: true, ctrlKey: true })), null, '⌃⌘3');
  assert.equal(matchShortcut(ev('Digit3', CMD_SHIFT)), null, '⌘⇧3 belongs to the system');
  assert.equal(matchShortcut(ev('Digit3')), null, 'a plain 3 is typing');
  assert.equal(matchShortcut(ev('Digit3', { ctrlKey: true })), null, '⌃3');
  assert.equal(matchShortcut(ev('Numpad3', CMD)), null);
  assert.equal(matchShortcut(ev('KeyC', CMD)), null, '⌘C stays with the clipboard');
});

test('match_brackets', () => {
  assert.deepEqual(matchShortcut(ev('BracketRight', CMD_SHIFT)), { kind: 'next' });
  assert.deepEqual(matchShortcut(ev('BracketLeft', CMD_SHIFT)), { kind: 'prev' });
  assert.equal(matchShortcut(ev('BracketRight', CMD)), null, 'without ⇧');
  assert.equal(matchShortcut(ev('BracketLeft', CMD)), null, 'without ⇧');
  assert.equal(matchShortcut(ev('BracketRight', { ...CMD_SHIFT, altKey: true })), null, 'with ⌥');
  assert.equal(matchShortcut(ev('BracketLeft', { ...CMD_SHIFT, ctrlKey: true })), null, 'with ⌃');
  assert.equal(matchShortcut(ev('BracketRight', { shiftKey: true })), null, 'without ⌘ it types }');
  // Decided by the physical key: what `key` holds ({ or }) makes no difference.
  assert.deepEqual(matchShortcut({ ...ev('BracketRight', CMD_SHIFT), key: '}' }), { kind: 'next' });
  assert.deepEqual(matchShortcut({ ...ev('BracketLeft', CMD_SHIFT), key: '{' }), { kind: 'prev' });
});

test('pick_index', () => {
  assert.equal(pickTarget(5, 0, { kind: 'index', n: 3 }), 2);
  assert.equal(pickTarget(5, 4, { kind: 'index', n: 1 }), 0);
  assert.equal(pickTarget(5, 2, { kind: 'index', n: 3 }), 2, 'the current one is still a valid answer');
  assert.equal(pickTarget(5, 0, { kind: 'index', n: 7 }), null, 'past the end: stay');
  assert.equal(pickTarget(5, 0, { kind: 'index', n: 6 }), null);
  assert.equal(pickTarget(12, 0, { kind: 'index', n: 9 }), 8, '⌘9 is the 9th, not the last');
  assert.equal(pickTarget(0, -1, { kind: 'index', n: 1 }), null);
});

test('pick_prev_next_wraps', () => {
  assert.equal(pickTarget(5, 4, { kind: 'next' }), 0);
  assert.equal(pickTarget(5, 0, { kind: 'prev' }), 4);
  assert.equal(pickTarget(5, 2, { kind: 'next' }), 3);
  assert.equal(pickTarget(5, 2, { kind: 'prev' }), 1);
  assert.equal(pickTarget(5, -1, { kind: 'next' }), 0, 'nothing open: next is the first');
  assert.equal(pickTarget(5, -1, { kind: 'prev' }), 4, 'nothing open: previous is the last');
  assert.equal(pickTarget(0, -1, { kind: 'next' }), null);
  assert.equal(pickTarget(0, -1, { kind: 'prev' }), null);
  assert.equal(pickTarget(1, 0, { kind: 'next' }), 0);
});

test('capture_blocks_propagation', () => {
  const s = install();
  const area = document.createElement('textarea');
  document.body.appendChild(area);
  area.value = 'draft';
  const seen = [];
  area.addEventListener('keydown', (e) => seen.push(e.code));
  const docSeen = [];
  const onDoc = (e) => docSeen.push(e.code);
  document.addEventListener('keydown', onDoc, true);
  area.focus();

  const e = press(area, 'Digit3', CMD, '3');
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(seen, [], "the textarea's own keydown listener never ran");
  assert.deepEqual(docSeen, [], 'nor did a capturing listener further in (xterm, a menu)');
  assert.deepEqual(s.opened, [2], 'open(2) once');
  assert.equal(area.value, 'draft');

  const next = press(area, 'BracketRight', CMD_SHIFT, '}');
  assert.equal(next.defaultPrevented, true);
  assert.deepEqual(seen, []);
  assert.deepEqual(s.opened, [2, 1]);

  // Anything else passes through untouched.
  const plain = press(area, 'KeyA', {}, 'a');
  assert.equal(plain.defaultPrevented, false);
  assert.deepEqual(seen, ['KeyA']);
  const copy = press(area, 'KeyC', CMD, 'c');
  assert.equal(copy.defaultPrevented, false);
  assert.deepEqual(seen, ['KeyA', 'KeyC']);
  assert.deepEqual(s.opened, [2, 1]);

  document.removeEventListener('keydown', onDoc, true);
  area.remove();
  s.uninstall();
});

test('blocked_does_not_intercept', () => {
  let blocked = true;
  const s = install({ blocked: () => blocked });
  const input = document.createElement('input');
  document.body.appendChild(input);
  const seen = [];
  input.addEventListener('keydown', (e) => seen.push(e.code));
  for (const [code, mods] of [['Digit2', CMD], ['BracketRight', CMD_SHIFT], ['BracketLeft', CMD_SHIFT]]) {
    const e = press(input, code, mods);
    assert.equal(e.defaultPrevented, false, `${code} is left alone while blocked`);
  }
  assert.deepEqual(s.opened, []);
  assert.deepEqual(seen, ['Digit2', 'BracketRight', 'BracketLeft'], 'the key still reaches whatever has the focus');
  blocked = false;
  assert.equal(press(input, 'Digit2', CMD).defaultPrevented, true);
  assert.deepEqual(s.opened, [1]);
  input.remove();
  s.uninstall();
});

test('index_out_of_range_still_intercepted', () => {
  const s = install();
  const area = document.createElement('textarea');
  document.body.appendChild(area);
  const seen = [];
  area.addEventListener('keydown', (e) => seen.push(e.code));
  const e = press(area, 'Digit7', CMD, '7');
  assert.deepEqual(s.opened, [], 'nothing to open');
  assert.equal(e.defaultPrevented, true, 'the key is ours all the same: it must not fall through to the terminal');
  assert.deepEqual(seen, []);
  area.remove();
  s.uninstall();
});

test('no_sessions_still_intercepted', () => {
  const s = install({ count: () => 0, activeIndex: () => -1 });
  assert.equal(press(document.body, 'BracketRight', CMD_SHIFT).defaultPrevented, true);
  assert.deepEqual(s.opened, []);
  s.uninstall();
});

test('uninstall_removes_listener', () => {
  const s = install();
  assert.equal(press(document.body, 'Digit3', CMD).defaultPrevented, true);
  assert.deepEqual(s.opened, [2]);
  s.uninstall();
  const e = press(document.body, 'Digit3', CMD);
  assert.equal(e.defaultPrevented, false);
  assert.deepEqual(s.opened, [2], 'open is not called after uninstalling');
});

// --- index.ts wiring (loadIndex) ---

const M = { name: 'this-mac', addr: '10.0.0.9', port: 8765, token: 't' };
const MK = '10.0.0.9:8765';
const M2 = { name: 'box', addr: '10.0.0.10', port: 8765, token: 't' };
const MK2 = '10.0.0.10:8765';

/** A page with index.ts loaded and every listed session already open as a (fake) view. */
async function setupApp(byMachine) {
  const dom = await indexDom();
  localStorage.setItem('vibe-remote.locale', 'zh');
  localStorage.removeItem('vibe-remote.collapsed-machines');
  localStorage.removeItem('vibe-remote.collapsed-projects');
  globalThis.fetch = async () => new Response(null, { status: 204 });
  const app = await loadIndex();
  app.setMachines(byMachine.map((b) => b.machine));
  app.rebuildRests();
  for (const { machine, sessions } of byMachine) {
    const mk = `${machine.addr}:${machine.port}`;
    app.machineOnline.set(mk, true);
    app.machineSessions.set(mk, sessions);
    // What a protocol 4 daemon lists: one plain-folder project per workdir, in name order.
    const dirs = [...new Set(sessions.map((x) => x.workdir))].sort();
    app.machineProjects.set(mk, dirs.map((dir) => ({
      id: dir, name: dir.split('/').pop(), git: false, worktrees: [], sessions: sessions.filter((x) => x.workdir === dir).map((x) => x.id),
    })));
    for (const s of sessions) {
      const container = document.createElement('div');
      document.getElementById('terminal-container').appendChild(container);
      const key = `${mk}::${s.id}`;
      app.views.set(key, { ui: 'chat', key, sessionId: s.id, machine, container, activity: 'none', client: { state: 'connected' }, show() {}, dispose() {} });
    }
  }
  app.renderSidebar();
  return { dom, app };
}

const s = (id, workdir, n) => ({ id, title: id, workdir, created: `2026-01-01T00:00:0${n}Z`, mode: 'normal', ui: 'chat', state: 'running' });
const TWO_PROJECTS = [s('a1', '/r/alpha', 1), s('a2', '/r/alpha', 2), s('b1', '/r/beta', 3), s('b2', '/r/beta', 4)];
const rowOrder = () => [...document.querySelectorAll('.session-item')].map((r) => r.dataset.sessionId);
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

test('opens_by_position_via_index', async () => {
  const { dom, app } = await setupApp([{ machine: M, sessions: TWO_PROJECTS }]);
  assert.deepEqual(rowOrder(), ['a1', 'a2', 'b1', 'b2'], 'the order the sidebar shows');
  assert.equal(app.activeKey, null);
  assert.equal(press(document.body, 'Digit3', CMD).defaultPrevented, true);
  assert.equal(app.activeKey, `${MK}::b1`, '⌘3 opens the third row');
  press(document.body, 'Digit1', CMD);
  assert.equal(app.activeKey, `${MK}::a1`);
  press(document.body, 'Digit7', CMD);
  assert.equal(app.activeKey, `${MK}::a1`, 'past the end: stays');
  press(document.body, 'BracketLeft', CMD_SHIFT);
  assert.equal(app.activeKey, `${MK}::b2`, '⌘⇧[ from the first wraps to the last');
  press(document.body, 'BracketRight', CMD_SHIFT);
  assert.equal(app.activeKey, `${MK}::a1`, '⌘⇧] from the last wraps to the first');
  // From the machine overview (no session shown) "next" is the first one.
  app.showMachineOverview(M);
  assert.equal(app.activeKey, null);
  press(document.body, 'BracketRight', CMD_SHIFT);
  assert.equal(app.activeKey, `${MK}::a1`);
  dom.dom.window.close();
});

test('skips_collapsed_via_index', async () => {
  const { dom, app } = await setupApp([{ machine: M, sessions: TWO_PROJECTS }]);
  app.setActive(`${MK}::b2`);
  click(document.querySelector('.project-group[data-project-id="/r/alpha"] .project-toggle'));
  assert.deepEqual(rowOrder(), ['b1', 'b2'], 'the first project is folded away');
  press(document.body, 'BracketRight', CMD_SHIFT);
  assert.equal(app.activeKey, `${MK}::b1`, 'next from the last visible one is the first visible one, not a folded session');
  press(document.body, 'BracketLeft', CMD_SHIFT);
  assert.equal(app.activeKey, `${MK}::b2`);
  press(document.body, 'Digit1', CMD);
  assert.equal(app.activeKey, `${MK}::b1`, '⌘1 counts visible rows only');
  press(document.body, 'Digit3', CMD);
  assert.equal(app.activeKey, `${MK}::b1`, 'two rows are visible: ⌘3 does nothing');
  assert.equal(document.querySelector('.project-group[data-project-id="/r/alpha"] .project-toggle').getAttribute('aria-expanded'), 'false', 'the folded project stays folded');
  dom.dom.window.close();
});

test('crosses_machines_and_skips_collapsed_machine', async () => {
  const { dom, app } = await setupApp([
    { machine: M, sessions: [s('a1', '/r/alpha', 1)] },
    { machine: M2, sessions: [s('z1', '/r/zeta', 2), s('z2', '/r/zeta', 3)] },
  ]);
  press(document.body, 'Digit3', CMD);
  assert.equal(app.activeKey, `${MK2}::z2`, 'positions run on across machines');
  press(document.body, 'BracketRight', CMD_SHIFT);
  assert.equal(app.activeKey, `${MK}::a1`);
  // Fold the second machine: its sessions are out of the cycle.
  click(document.querySelectorAll('.machine-toggle')[1]);
  press(document.body, 'BracketRight', CMD_SHIFT);
  assert.equal(app.activeKey, `${MK}::a1`, 'the only visible session');
  press(document.body, 'Digit2', CMD);
  assert.equal(app.activeKey, `${MK}::a1`);
  dom.dom.window.close();
});

test('closes_row_menu_via_index', async () => {
  const { dom, app } = await setupApp([{ machine: M, sessions: TWO_PROJECTS }]);
  app.machineProjects.set(MK, [{
    id: '/r/alpha', name: 'alpha', git: true, sessions: [],
    worktrees: [{ path: '/r/alpha', branch: 'main', head: 'a1b2c3d', main: true, sessions: ['a1', 'a2'] }],
  }, { id: '/r/beta', name: 'beta', git: false, worktrees: [], sessions: ['b1', 'b2'] }]);
  app.renderSidebar();
  click(document.querySelector('[data-testid="project-menu"]'));
  assert.ok(document.querySelector('.menu'), 'a row menu is open');
  press(document.body, 'Digit4', CMD);
  assert.equal(app.activeKey, `${MK}::b2`);
  assert.equal(document.querySelector('.menu'), null, 'the menu does not outlive the row it was opened on');
  dom.dom.window.close();
});

test('dialog_or_rename_blocks_via_index', async () => {
  const { dom, app } = await setupApp([{ machine: M, sessions: TWO_PROJECTS }]);
  app.setActive(`${MK}::a1`);
  // A dialog is open (the delete-session confirmation).
  click(document.querySelector('.session-item[data-session-id="a2"] .session-close'));
  await new Promise((r) => setTimeout(r, 20));
  const dialog = document.querySelector('.modal-overlay');
  assert.ok(dialog, 'a dialog is up');
  for (const [code, mods] of [['Digit2', CMD], ['BracketRight', CMD_SHIFT], ['BracketLeft', CMD_SHIFT]]) {
    const e = press(dialog.querySelector('[data-testid="dialog-cancel"]'), code, mods);
    assert.equal(e.defaultPrevented, false);
    assert.equal(app.activeKey, `${MK}::a1`, `${code} does not switch while a dialog is open`);
  }
  click(dialog.querySelector('[data-testid="dialog-cancel"]'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(document.querySelector('.modal-overlay'), null);
  press(document.body, 'Digit2', CMD);
  assert.equal(app.activeKey, `${MK}::a2`, 'works again once the dialog is gone');

  // An inline rename is in progress.
  document.querySelector('.session-item[data-session-id="b1"] .session-label').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const input = document.querySelector('.session-rename-input');
  assert.ok(input, 'rename input is open');
  const e = press(input, 'Digit1', CMD);
  assert.equal(e.defaultPrevented, false);
  assert.equal(app.activeKey, `${MK}::a2`, 'no switch while renaming');
  assert.equal(document.querySelector('.session-rename-input'), input, 'the rename input is untouched');
  dom.dom.window.close();
});

await run();
