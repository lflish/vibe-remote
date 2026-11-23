// The sidebar is rebuilt only when what it shows has changed (T34).
//
// Two things are held here, on the renderer entry (index.ts with sidebar.ts)
// running on jsdom:
//  - a refresh that brings the same data leaves every node of #machine-list
//    the object it was: a press and its release, a click and the dblclick that
//    follows, land on the same element;
//  - whatever changes what the sidebar shows does get there: one case per kind
//    of change. These are the ones that fail when something the rendering
//    reads is left out of the comparison (a sidebar that stays as it was).
import { strict as assert } from 'node:assert';
import { indexDom, loadIndex, runner } from './chat-test-util.mjs';

const { test, run } = runner('test-sidebar-refresh');

// For sessions opened through index.ts: a socket that opens when told to and
// records what the client sends (the auth frame carries the machine's token).
const sockets = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  fireOpen() { this.readyState = 1; this.onopen?.(); }
};

const DEV = '127.0.0.1:1234';
const LAB = '127.0.0.1:1235';
const FIX = '/w/repo-worktrees/fix-login';
const sha = (c) => c.repeat(40);

/**
 * Two machines. dev: a repository with its main directory (chat session c1), a
 * worktree vibe-remote made (terminal session t1) and one made elsewhere (no
 * session), and a plain folder (chat session c2). lab: one terminal session.
 * `world` is what the daemons answer; a case changes it and refreshes.
 */
async function setup() {
  const page = await indexDom();
  localStorage.clear();
  localStorage.setItem('vibe-remote.locale', 'zh');
  const app = await loadIndex();
  const dev = { name: 'dev', addr: '127.0.0.1', port: 1234, token: 'first-token' };
  const lab = { name: 'lab', addr: '127.0.0.1', port: 1235, token: 'lab-token' };
  const world = {
    [DEV]: {
      down: false,
      legacy: false,
      sessions: [
        { id: 'c1', title: 'conversation', workdir: '/w/repo', created: '2026-11-20T10:00:00Z', mode: 'normal', ui: 'chat', state: 'idle', activitySeq: 3, epoch: 'e1' },
        { id: 't1', title: 'shell', workdir: FIX, created: '2026-11-20T10:00:01Z', mode: 'normal' },
        { id: 'c2', title: 'notes chat', workdir: '/w/notes', created: '2026-11-20T10:00:02Z', mode: 'normal', ui: 'chat', state: 'idle', activitySeq: 1, epoch: 'e1' },
      ],
      projects: [
        {
          id: '/w/repo', name: 'repo', git: true, sessions: [], worktrees: [
            { path: '/w/repo', branch: 'main', head: sha('a'), main: true, sessions: ['c1'] },
            { path: FIX, branch: 'fix-login', head: sha('b'), managed: true, sessions: ['t1'] },
            { path: '/w/elsewhere/spike', branch: 'spike', head: sha('c'), sessions: [] },
          ],
        },
        { id: '/w/notes', name: 'notes', git: false, worktrees: [], sessions: ['c2'] },
      ],
    },
    [LAB]: {
      down: false,
      legacy: false,
      sessions: [{ id: 'l1', title: 'lab shell', workdir: '/l/x', created: '2026-11-20T10:00:03Z', mode: 'normal' }],
      projects: [{ id: '/l/x', name: 'x', git: false, worktrees: [], sessions: ['l1'] }],
    },
  };
  app.setMachines([dev, lab]);
  for (const key of [DEV, LAB]) {
    app.rests.set(key, {
      async listSessions() { if (world[key].down) throw new Error('fetch failed'); return structuredClone(world[key].sessions); },
      async listProjects() {
        // `holdProjects`: a promise the answer waits for (the daemon is still running git).
        await world[key].holdProjects;
        if (world[key].down || world[key].projectsFail) throw new Error('fetch failed');
        return world[key].legacy ? null : structuredClone(world[key].projects);
      },
    });
  }
  const refresh = () => app.refreshAllMachines(true);
  await refresh();

  const list = document.getElementById('machine-list');
  const host = document.getElementById('terminal-container');
  /** Every element of the sidebar, in document order. */
  const nodes = () => [...list.querySelectorAll('*')];
  /** Fails unless the sidebar still consists of exactly the elements in `before`. */
  const sameNodes = (before, what) => {
    const now = nodes();
    assert.equal(now.length, before.length, `${what}: the sidebar has another number of elements`);
    assert.ok(now.every((n, i) => n === before[i]), `${what}: elements of the sidebar were replaced`);
  };
  const row = (id) => list.querySelector(`.session-item[data-session-id="${id}"]`);
  const group = (key) => [...list.querySelectorAll('.machine-group')].find((g) => g.dataset.machineKey === key);
  const projectGroup = (id) => [...list.querySelectorAll('.project-group')].find((g) => g.dataset.projectId === id);
  const worktree = (path) => [...list.querySelectorAll('.worktree-group')].find((g) => g.dataset.path === path);
  const text = (el) => el?.textContent ?? null;

  /** A chat session open here (a stand-in view: what index.ts reads of it). */
  const chatView = (machine, key, id) => {
    const view = { key: `${key}::${id}`, sessionId: id, machine, container: document.createElement('div'), activity: 'none', ui: 'chat', client: { state: 'connected' }, show() {}, focus() {} };
    host.appendChild(view.container);
    app.views.set(view.key, view);
    return view;
  };
  /** A terminal session open here (stand-in). */
  const terminalView = (machine, key, id) => {
    const view = { key: `${key}::${id}`, sessionId: id, machine, container: document.createElement('div'), activity: 'none', ui: 'terminal', client: { state: 'connected' }, terminal: { focus() {} }, fitAddon: { fit() {} }, screen: { forget() {} } };
    host.appendChild(view.container);
    app.views.set(view.key, view);
    return view;
  };
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
  return { page, app, dev, lab, world, refresh, list, nodes, sameNodes, row, group, projectGroup, worktree, text, chatView, terminalView, click, settle, close: () => page.dom.window.close() };
}

// --- nothing changed: nothing is rebuilt ---

test('the same data again — polls, a refresh asked for by an action, a render — leaves every element in place', async () => {
  const t = await setup();
  const c1 = t.chatView(t.dev, DEV, 'c1');
  t.app.setActive(c1.key);
  const before = t.nodes();
  assert.ok(before.length > 40, 'fixture: the sidebar is drawn');
  // Two machines, two requests each: four answers per round.
  await t.app.pollMachines();
  t.sameNodes(before, 'after a poll');
  await t.app.pollMachines();
  t.sameNodes(before, 'after a second poll');
  await t.refresh();
  t.sameNodes(before, 'after a refresh asked for by an action');
  t.app.renderSidebar();
  t.sameNodes(before, 'after a render with nothing new');
  t.app.setActive(c1.key);
  t.sameNodes(before, 'after showing the session that is shown already');
  t.close();
});

test('a chat session that is not open keeps working (activitySeq, state, epoch move, its dot stays): nothing is rebuilt', async () => {
  const t = await setup();
  // The first change lights "new messages" (and that does redraw the row).
  Object.assign(t.world[DEV].sessions[2], { state: 'running', activitySeq: 5 });
  await t.refresh();
  assert.equal(t.row('c2').dataset.dot, 'output', 'the dot new activity lights');
  const before = t.nodes();
  // More of the same turn: the numbers move, what the row shows does not.
  Object.assign(t.world[DEV].sessions[2], { activitySeq: 9 });
  await t.app.pollMachines();
  Object.assign(t.world[DEV].sessions[2], { activitySeq: 14 });
  await t.app.pollMachines();
  t.sameNodes(before, 'while the session keeps producing messages');
  // … and the rows still act on the session: a click opens it.
  t.click(t.row('c2').querySelector('.session-label'));
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(t.app.activeKey, `${DEV}::c2`, 'a click on the kept row opens the session');
  for (const v of t.app.views.values()) v.client.disconnect?.();
  t.close();
});

// --- something changed: it shows ---

test('sessions: one more, one less, another name, another directory', async () => {
  const t = await setup();
  t.world[DEV].sessions.push({ id: 't2', title: 'second shell', workdir: FIX, created: '2026-11-20T10:00:09Z', mode: 'normal' });
  t.world[DEV].projects[0].worktrees[1].sessions.push('t2');
  await t.refresh();
  assert.equal(t.text(t.row('t2')?.querySelector('.session-label-text')), 'second shell', 'a new session gets a row');
  assert.equal(t.text(t.group(DEV).querySelector('.machine-session-count')), '4', 'the machine counts it');

  t.world[DEV].sessions = t.world[DEV].sessions.filter((s) => s.id !== 't2');
  t.world[DEV].projects[0].worktrees[1].sessions = ['t1'];
  await t.refresh();
  assert.equal(t.row('t2'), null, 'a session that is gone loses its row');

  t.world[DEV].sessions[1].title = 'build box';
  await t.refresh();
  assert.equal(t.text(t.row('t1').querySelector('.session-label-text')), 'build box', 'a rename done elsewhere shows');

  t.world[DEV].sessions[1].workdir = `${FIX}/sub`;
  await t.refresh();
  assert.equal(t.row('t1').querySelector('.session-label').title, `${FIX}/sub`, 'the directory in the tooltip follows the session');
  t.close();
});

test('state dots of sessions open here: lit by a hook event or a chat frame, cleared when the session is opened', async () => {
  const t = await setup();
  const c1 = t.chatView(t.dev, DEV, 'c1');
  const t1 = t.terminalView(t.dev, DEV, 't1');
  const l1 = t.terminalView(t.lab, LAB, 'l1');
  t.app.setActive(l1.key);
  assert.deepEqual([t.row('c1').dataset.dot, t.row('t1').dataset.dot], ['none', 'none']);
  // What client.onNotify does with an idle hook event on a background terminal session.
  t1.activity = 'idle';
  t.app.renderSidebar();
  assert.equal(t.row('t1').dataset.dot, 'idle', 'green dot on the terminal session');
  assert.ok(t.text(t.row('t1').querySelector('.session-meta')).includes('回合结束'), 'and the words for it');
  t1.activity = 'waiting';
  t.app.renderSidebar();
  assert.equal(t.row('t1').dataset.dot, 'waiting', 'the dot goes from green to yellow');
  // A chat frame on a background chat session.
  t.app.applyViewActivity(c1, { kind: 'chat' });
  assert.equal(t.row('c1').dataset.dot, 'output', 'grey dot on the chat session');
  // Opening a session takes its dot away.
  t.app.setActive(t1.key);
  assert.equal(t.row('t1').dataset.dot, 'none', 'no dot on the session now shown');
  assert.ok(t.row('t1').classList.contains('active'));
  t.close();
});

test('state dots of chat sessions not open here: what the poll says (activitySeq, state), also on a folded project row', async () => {
  const t = await setup();
  assert.equal(t.row('c1').dataset.dot, 'none');
  Object.assign(t.world[DEV].sessions[0], { state: 'running', activitySeq: 7 });
  await t.app.pollMachines();
  assert.equal(t.row('c1').dataset.dot, 'output', 'activitySeq moved: new messages');
  Object.assign(t.world[DEV].sessions[0], { state: 'idle', activitySeq: 9 });
  await t.app.pollMachines();
  assert.equal(t.row('c1').dataset.dot, 'idle', 'the turn ended');
  // Folded, the project row carries "needs you" for the sessions inside.
  t.click(t.projectGroup('/w/repo').querySelector('.project-toggle'));
  assert.equal(t.row('c1'), null, 'fixture: the project is folded');
  assert.equal(t.projectGroup('/w/repo').querySelector('[data-testid="project-dot"]'), null);
  Object.assign(t.world[DEV].sessions[0], { state: 'waiting', activitySeq: 10 });
  await t.app.pollMachines();
  assert.ok(t.projectGroup('/w/repo').querySelector('[data-testid="project-dot"]'), 'a session inside waits: the folded project row says so');
  Object.assign(t.world[DEV].sessions[0], { state: 'running', activitySeq: 12 });
  await t.app.pollMachines();
  assert.equal(t.projectGroup('/w/repo').querySelector('[data-testid="project-dot"]'), null, 'answered elsewhere: the mark on the project row goes');
  t.close();
});

test('projects and worktrees: added, removed, another branch, no longer one of ours, cannot be read', async () => {
  const t = await setup();
  const repo = t.world[DEV].projects[0];
  repo.worktrees.push({ path: '/w/repo-worktrees/new-one', branch: 'new-one', head: sha('d'), managed: true, sessions: [] });
  await t.refresh();
  assert.equal(t.text(t.worktree('/w/repo-worktrees/new-one')?.querySelector('.worktree-label')), 'new-one', 'a new worktree gets a row');

  repo.worktrees = repo.worktrees.filter((w) => w.path !== '/w/repo-worktrees/new-one');
  await t.refresh();
  assert.equal(t.worktree('/w/repo-worktrees/new-one'), undefined, 'a worktree that is gone loses its row');

  repo.worktrees[1].branch = 'fix-login-2';
  await t.refresh();
  assert.equal(t.text(t.worktree(FIX).querySelector('.worktree-label')), 'fix-login-2', 'a branch switched in the worktree shows');

  assert.equal(t.worktree(FIX).querySelector('[data-testid="worktree-tag-external"]'), null);
  repo.worktrees[1].managed = false;
  await t.refresh();
  assert.ok(t.worktree(FIX).querySelector('[data-testid="worktree-tag-external"]'), 'no longer created by vibe-remote: tagged external');

  t.world[DEV].projects.push({ id: '/w/api', name: 'api', git: true, sessions: [], worktrees: [{ path: '/w/api', branch: 'main', head: sha('e'), main: true, sessions: [] }] });
  await t.refresh();
  assert.equal(t.text(t.projectGroup('/w/api')?.querySelector('.project-name')), 'api', 'a new project gets a row');

  Object.assign(t.world[DEV].projects[2], { error: 'repo_missing', errorMessage: 'gone', worktrees: [] });
  await t.refresh();
  assert.equal(t.text(t.projectGroup('/w/api').querySelector('[data-testid="project-error"]')), '仓库目录不存在', 'a project that cannot be read says so');

  t.world[DEV].projects.pop();
  await t.refresh();
  assert.equal(t.projectGroup('/w/api'), undefined, 'a project taken off the list loses its row');
  t.close();
});

test('a machine goes offline and comes back; a daemon turns out to be an old one', async () => {
  const t = await setup();
  const state = (key) => t.group(key).querySelector('[data-testid="machine-state"]');
  assert.deepEqual([state(LAB).dataset.state, t.text(state(LAB))], ['connected', '已连接']);
  t.world[LAB].down = true;
  await t.refresh();
  assert.deepEqual([state(LAB).dataset.state, t.text(state(LAB))], ['offline', '离线'], 'the machine that stopped answering');
  assert.equal(state(DEV).dataset.state, 'connected', 'the other one');
  t.world[LAB].down = false;
  await t.refresh();
  assert.equal(state(LAB).dataset.state, 'connected', 'back');
  // /api/v1/projects answers 404: an old daemon. The note appears, the entries go off.
  assert.equal(t.group(LAB).querySelector('[data-testid="machine-legacy-note"]'), null);
  t.world[LAB].legacy = true;
  await t.refresh();
  assert.ok(t.group(LAB).querySelector('[data-testid="machine-legacy-note"]'), 'the old-daemon note');
  t.close();
});

test('folding and unfolding a machine and a project', async () => {
  const t = await setup();
  const sessionList = () => t.group(DEV).querySelector('.session-list');
  assert.equal(sessionList().hidden, false);
  t.click(t.group(DEV).querySelector('.machine-toggle'));
  assert.equal(sessionList().hidden, true, 'machine folded');
  assert.equal(t.group(DEV).querySelector('.machine-toggle').getAttribute('aria-expanded'), 'false');
  t.click(t.group(DEV).querySelector('.machine-toggle'));
  assert.equal(sessionList().hidden, false, 'machine unfolded');

  assert.ok(t.row('c1'));
  t.click(t.projectGroup('/w/repo').querySelector('.project-toggle'));
  assert.equal(t.row('c1'), null, 'project folded: its sessions are not listed');
  assert.ok(t.row('c2'), 'the other project is as it was');
  t.click(t.projectGroup('/w/repo').querySelector('.project-toggle'));
  assert.ok(t.row('c1'), 'project unfolded');
  t.close();
});

test('the session shown, and the machine overview', async () => {
  const t = await setup();
  const c1 = t.chatView(t.dev, DEV, 'c1');
  const t1 = t.terminalView(t.dev, DEV, 't1');
  const active = () => [...t.list.querySelectorAll('.session-item.active')].map((i) => i.dataset.sessionId);
  t.app.setActive(c1.key);
  assert.deepEqual(active(), ['c1']);
  t.app.setActive(t1.key);
  assert.deepEqual(active(), ['t1'], 'the highlight moves with the session shown');
  t.app.showMachineOverview(t.lab);
  assert.deepEqual(active(), [], 'no session is shown on the overview');
  assert.ok(t.group(LAB).querySelector('.machine-name').classList.contains('selected'), 'the machine whose overview is shown');
  t.app.showMachineOverview(t.dev);
  assert.ok(t.group(DEV).querySelector('.machine-name').classList.contains('selected'));
  assert.ok(!t.group(LAB).querySelector('.machine-name').classList.contains('selected'), 'only one machine is selected');
  t.close();
});

test('the chat session shown asks for permission while the window is in the background: yellow dot, gone once the window is focused (X6)', async () => {
  const t = await setup();
  const c1 = t.chatView(t.dev, DEV, 'c1');
  t.app.setActive(c1.key);
  assert.equal(t.row('c1').dataset.dot, 'none');
  t.page.focus.window = false;
  t.page.focus.notifyResult = 'fallback';
  t.app.applyViewActivity(c1, { kind: 'prompt' }, { kind: 'permission', toolName: 'Bash' });
  assert.equal(t.row('c1').dataset.dot, 'waiting', 'yellow dot on the session shown');
  assert.ok(t.text(t.row('c1').querySelector('.session-meta')).includes('等你处理'));
  await t.settle();
  t.page.focusWindow();
  assert.equal(t.row('c1').dataset.dot, 'none', 'seen: the dot goes');
  t.close();
});

test('a worktree being deleted says so, and stops saying so', async () => {
  const t = await setup();
  const removing = () => t.worktree(FIX).querySelector('[data-testid="worktree-removing"]');
  assert.equal(removing(), null);
  // What handleDeleteWorktree does while the request is in flight.
  t.app.removingWorktrees.add(`${DEV}|${FIX}`);
  t.app.renderSidebar();
  assert.equal(t.text(removing()), '正在删除…', 'the row says it is being deleted');
  assert.equal(t.worktree(FIX).querySelector('[data-testid="worktree-new-session"]').disabled, true, 'and offers nothing');
  t.app.removingWorktrees.delete(`${DEV}|${FIX}`);
  t.app.renderSidebar();
  assert.equal(removing(), null, 'the removal was refused: an ordinary row again');
  assert.equal(t.worktree(FIX).querySelector('[data-testid="worktree-new-session"]').disabled, false);
  t.close();
});

test('a reload in flight disables the row\'s reload button until it is over', async () => {
  const t = await setup();
  const reload = () => t.row('t1').querySelector('.session-reload');
  assert.equal(reload().disabled, false);
  t.app.reloadingSessions.add(`${DEV}::t1`);
  t.app.renderSidebar();
  assert.equal(reload().disabled, true, 'no second reload while the first runs');
  t.app.reloadingSessions.delete(`${DEV}::t1`);
  t.app.renderSidebar();
  assert.equal(reload().disabled, false, 'over: the button works again');
  t.close();
});

test('switching the language redraws the sidebar in the other language', async () => {
  const t = await setup();
  t.app.wireLanguageToggle();
  const kind = () => t.text(t.row('t1').querySelector('.session-meta'));
  const main = () => t.text(t.worktree('/w/repo').querySelector('[data-testid="worktree-tag-main"]'));
  assert.deepEqual([kind(), main()], ['终端', '主目录']);
  t.app.toggleLocale();
  assert.deepEqual([kind(), main()], ['Terminal', 'Main'], 'English');
  t.app.toggleLocale();
  assert.deepEqual([kind(), main()], ['终端', '主目录'], 'and back');
  t.close();
});

test('a machine edited in the manager: its new name shows, and a session opened from the sidebar uses the new settings', async () => {
  const t = await setup();
  t.app.setMachines([{ ...t.dev, name: 'dev box' }, t.lab]);
  t.app.renderSidebar();
  assert.equal(t.text(t.group(DEV).querySelector('.machine-name-label')), 'dev box', 'the new name');
  // Only the token changed: nothing the sidebar shows is different, but its
  // rows must open sessions with the machine as it is now.
  t.app.setMachines([{ ...t.dev, name: 'dev box', token: 'second-token' }, t.lab]);
  t.app.renderSidebar();
  t.click(t.row('c2').querySelector('.session-label'));
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(t.app.activeKey, `${DEV}::c2`, 'the click opened the session');
  const ws = sockets.at(-1);
  ws.fireOpen();
  assert.deepEqual(ws.sent[0], { type: 'auth', token: 'second-token' }, 'the connection authenticates with the token saved last');
  for (const v of t.app.views.values()) v.client.disconnect?.();
  t.close();
});

// --- renaming ---

test('a rename ended with Esc puts the name back, though nothing the sidebar shows has changed', async () => {
  const t = await setup();
  const c1 = t.chatView(t.dev, DEV, 'c1');
  t.app.setActive(c1.key);
  const label = t.row('c1').querySelector('.session-label');
  label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  const input = t.list.querySelector('.session-rename-input');
  assert.ok(input && t.row('c1').querySelector('.session-label') === null, 'the input took the place of the name');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await t.settle();
  assert.equal(t.list.querySelector('.session-rename-input'), null, 'the input is gone');
  assert.equal(t.text(t.row('c1').querySelector('.session-label-text')), 'conversation', 'the name is back');
  t.close();
});

test('nothing is rebuilt while a rename is open; what changed meanwhile shows once it is over', async () => {
  const t = await setup();
  const c1 = t.chatView(t.dev, DEV, 'c1');
  t.app.setActive(c1.key);
  t.row('c1').querySelector('.session-label').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  const input = t.list.querySelector('.session-rename-input');
  assert.ok(input);
  const before = t.nodes();
  t.world[DEV].sessions[1].title = 'renamed elsewhere';
  await t.app.pollMachines();
  t.sameNodes(before, 'a poll during the rename');
  assert.equal(t.text(t.row('t1').querySelector('.session-label-text')), 'shell', 'the list waits for the rename');
  // … and changes back before the rename ends: the list is still drawn again,
  // because the input has to go.
  t.world[DEV].sessions[1].title = 'shell';
  await t.app.pollMachines();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await t.settle();
  assert.equal(t.list.querySelector('.session-rename-input'), null, 'the input is gone');
  assert.equal(t.text(t.row('c1').querySelector('.session-label-text')), 'conversation');
  // A change that stays shows after the rename.
  t.row('c1').querySelector('.session-label').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  t.world[DEV].sessions[1].title = 'renamed elsewhere';
  await t.app.pollMachines();
  t.list.querySelector('.session-rename-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await t.settle();
  assert.equal(t.text(t.row('t1').querySelector('.session-label-text')), 'renamed elsewhere', 'the change made during the rename');
  t.close();
});

// --- what goes with a render still happens when the render is skipped ---

test('a refresh that leaves the sidebar alone still redraws the overview page', async () => {
  const t = await setup();
  t.app.showMachineOverview(t.dev);
  const overview = document.getElementById('machine-overview');
  const badge = (title) => [...overview.querySelectorAll('.workspace-session-row')].find((r) => r.querySelector('strong').textContent === title)?.querySelector('.workspace-badge-status')?.textContent;
  assert.equal(badge('conversation'), '远程');
  // c1 has a view here now. The sidebar shows nothing of that; the overview
  // page does ("running"), from the next answer on.
  t.chatView(t.dev, DEV, 'c1');
  const before = t.nodes();
  await t.app.pollMachines();
  t.sameNodes(before, 'fixture: this refresh changes nothing the sidebar shows');
  assert.equal(badge('conversation'), '运行中', 'the overview page was drawn again');
  // The machine stops answering: sidebar, page and title all say so.
  t.world[DEV].down = true;
  await t.refresh();
  assert.equal(t.group(DEV).querySelector('[data-testid="machine-state"]').dataset.state, 'offline');
  assert.equal(document.getElementById('toolbar-status-text').textContent, '离线');
  assert.ok(overview.querySelector('.workspace-notice-error'), 'the overview page says the machine cannot be reached');
  t.close();
});

// --- T35: the overview page shows nothing of the project tree, and is not
// redrawn for its answer. A redraw replaces the page's buttons: a press and its
// release with one in between lose the click, as in the sidebar before T34.

test('the answer about the project tree — a list, an old daemon, a failure — leaves the overview page as it is; the answer about the sessions redraws it', async () => {
  const t = await setup();
  t.app.showMachineOverview(t.dev);
  const overview = document.getElementById('machine-overview');
  const page = () => overview.firstElementChild;
  for (const [what, arrange] of [
    ['the same project list again', () => {}],
    ['a project list with one more worktree', () => { t.world[DEV].projects[0].worktrees.push({ path: '/w/repo-worktrees/t35', branch: 't35', head: sha('f'), managed: true, sessions: [] }); }],
    ['a failed request', () => { t.world[DEV].projectsFail = true; }],
    ['404 from an old daemon', () => { t.world[DEV].projectsFail = false; t.world[DEV].legacy = true; }],
  ]) {
    arrange();
    let release;
    t.world[DEV].holdProjects = new Promise((r) => { release = r; });
    const before = page();
    const round = t.app.pollMachines();
    await t.settle();
    // The sessions have answered, the project tree has not.
    const afterSessions = page();
    assert.notEqual(afterSessions, before, `${what}: the answer about the sessions redraws the page (as before this change)`);
    release();
    await round;
    assert.equal(page(), afterSessions, `${what}: the page was redrawn for the answer about the project tree`);
  }
  t.world[DEV].holdProjects = undefined;
  // The sidebar did follow those answers.
  assert.ok(t.group(DEV).querySelector('[data-testid="machine-legacy-note"]'), 'the sidebar shows what the last answer said');
  t.close();
});

test('what the overview page shows follows the sessions: one more, one less, another name, running here, offline and back', async () => {
  const t = await setup();
  t.app.showMachineOverview(t.dev);
  const overview = document.getElementById('machine-overview');
  const recent = () => [...overview.querySelectorAll('.workspace-session-row strong')].map((x) => x.textContent);
  const summary = () => overview.querySelector('.workspace-summary').textContent;
  assert.deepEqual(recent(), ['notes chat', 'shell', 'conversation']);
  assert.ok(summary().startsWith('3 '), summary());

  t.world[DEV].sessions.push({ id: 't9', title: 'newest', workdir: FIX, created: '2026-11-20T10:00:09Z', mode: 'normal' });
  t.world[DEV].projects[0].worktrees[1].sessions.push('t9');
  await t.app.pollMachines();
  assert.deepEqual(recent(), ['newest', 'notes chat', 'shell', 'conversation'], 'a new session is listed');
  assert.ok(summary().startsWith('4 '), summary());

  t.world[DEV].sessions[1].title = 'build box';
  await t.app.pollMachines();
  assert.deepEqual(recent(), ['newest', 'notes chat', 'build box', 'conversation'], 'a rename done elsewhere shows');

  t.world[DEV].sessions = t.world[DEV].sessions.filter((x) => x.id !== 't9');
  t.world[DEV].projects[0].worktrees[1].sessions = ['t1'];
  await t.app.pollMachines();
  assert.deepEqual(recent(), ['notes chat', 'build box', 'conversation'], 'a session that is gone is not listed');
  assert.ok(summary().startsWith('3 '), summary());

  assert.equal(overview.querySelector('.workspace-notice-error'), null);
  assert.equal(overview.querySelector('.workspace-mode-card').disabled, false);
  t.world[DEV].down = true;
  await t.refresh();
  assert.ok(overview.querySelector('.workspace-notice-error'), 'offline: the page says so');
  assert.equal(overview.querySelector('.workspace-mode-card'), null, 'offline: nothing to start a session with');
  t.world[DEV].down = false;
  await t.refresh();
  assert.equal(overview.querySelector('.workspace-notice-error'), null, 'back: the notice is gone');
  assert.equal(overview.querySelector('.workspace-mode-card').disabled, false, 'back: sessions can be started');
  t.close();
});

await run();
