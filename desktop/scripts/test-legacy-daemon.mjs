// R9.1: this desktop against a protocol 3 daemon. The renderer entry (index.ts)
// is driven through loadIndex() against a fake daemon that answers the way the
// daemon built before protocol 4 does: /api/v1/info says proto 3, the session
// list has no project tree to go with it (/api/v1/projects is a 404), a
// worktree session is deleted together with its worktree, and `ready` carries
// proto 3. Every entry a user can reach has to degrade, not fail.
import { strict as assert } from 'node:assert';
import { indexDom, load, loadIndex, runner } from './chat-test-util.mjs';

const { test, run } = runner('test-legacy-daemon');
await indexDom();
localStorage.setItem('vibe-remote.locale', 'zh');
const { t } = await load('src/renderer/i18n.ts', { platform: 'browser' });

const M = { name: 'this-mac', addr: '10.0.0.9', port: 8765, token: 't' };
const MK = '10.0.0.9:8765';
const WT_ID = '1794824025040-12b763ac';
const WT_ROOT = `/r/devflow-worktrees/${WT_ID}`;
const WT_BRANCH = `vibe/${WT_ID}`;

const SESSIONS = [
  { id: 'main-1', title: 'devflow', workdir: '/r/devflow', created: '2026-01-01T00:00:01Z', mode: 'normal' },
  { id: WT_ID, title: WT_ID, workdir: WT_ROOT, created: '2026-01-01T00:00:02Z', mode: 'worktree',
    sourceWorkdir: '/r/devflow', sourceRepo: '/r/devflow', worktreeRoot: WT_ROOT, branch: WT_BRANCH },
  { id: 'notes-1', title: 'notes', workdir: '/tmp/notes', created: '2026-01-01T00:00:03Z', mode: 'normal' },
];

const INFO_V3 = {
  hostname: 'h', tmux_enabled: true, default_workdir: '/r/devflow', allowed_roots: ['/r', '/tmp'], proto: 3, version: '0.1.3',
  chat: { supported: true, claudeVersion: '2.1.210', minClaudeVersion: '2.1.210' },
  claude_flags: [{ id: 'continue', label: '续上次会话 (-c)' }],
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const tid = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);
const tall = (id, root = document) => [...root.querySelectorAll(`[data-testid="${id}"]`)];

/**
 * A page with index.ts loaded against the fake protocol 3 daemon. `daemon`
 * holds what it serves and records what it was asked: `requests` (method +
 * path), `frames` (everything written to a WebSocket).
 */
async function setup(sessions = SESSIONS) {
  const dom = await indexDom();
  localStorage.setItem('vibe-remote.locale', 'zh');
  localStorage.removeItem('vibe-remote.collapsed-machines');
  localStorage.removeItem('vibe-remote.collapsed-projects');
  const daemon = {
    sessions: [...sessions],
    projects: null, // null = this daemon has no /api/v1/projects (404)
    deleteAnswer: null,
    requests: [],
    frames: [],
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || 'GET';
    daemon.requests.push(`${method} ${u.pathname}`);
    if (u.pathname === '/api/v1/info') return json(200, INFO_V3);
    if (u.pathname === '/api/v1/sessions') return json(200, { type: 'sessions', list: daemon.sessions });
    if (u.pathname === '/api/v1/projects') {
      return daemon.projects ? json(200, { proto: 4, projects: daemon.projects }) : new Response('404 page not found\n', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
    if (u.pathname === '/api/v1/fs') return json(200, { path: u.searchParams.get('path') || '/r/devflow', entries: [], parent: '/r', chatTrust: 'trusted' });
    if (method === 'DELETE' && u.pathname.startsWith('/api/v1/sessions/')) {
      if (daemon.deleteAnswer) return daemon.deleteAnswer();
      daemon.sessions = daemon.sessions.filter((s) => `/api/v1/sessions/${s.id}` !== u.pathname);
      return new Response(null, { status: 204 });
    }
    return new Response('404 page not found\n', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  };
  // The socket of a protocol 3 daemon: `ready` says proto 3, and a worktree
  // create gets the branch the daemon names itself.
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      setTimeout(() => this.onopen?.(), 0);
    }
    send(data) {
      const frame = JSON.parse(data);
      daemon.frames.push(frame);
      if (frame.type !== 'attach') return;
      const id = frame.sessionId || frame.newSessionId;
      const ready = frame.mode === 'worktree'
        ? { type: 'ready', sessionId: id, workdir: `/r/devflow-worktrees/${id}`, proto: 3, mode: 'worktree', sourceWorkdir: frame.workdir, sourceRepo: '/r/devflow', worktreeRoot: `/r/devflow-worktrees/${id}`, branch: `vibe/${id}` }
        : { type: 'ready', sessionId: id, workdir: frame.workdir || '/r/devflow', proto: 3, mode: 'normal' };
      setTimeout(() => this.onmessage?.({ data: JSON.stringify(ready) }), 0);
    }
    close() {
      this.readyState = 3;
    }
  };
  const app = await loadIndex();
  app.setMachines([M]);
  app.rebuildRests();
  await app.refreshAllMachines(true, MK);
  app.showMachineOverview(M);
  await settle();
  return { dom, app, daemon };
}

function teardown({ dom, app }) {
  // Open terminal views keep a ping timer running.
  for (const view of app.views.values()) view.client.disconnect?.();
  dom.dom.window.close();
}

const projectRow = (name) => tall('project-row').find((r) => r.querySelector('.project-name')?.textContent === name);
const sessionRow = (id) => document.querySelector(`.session-item[data-session-id="${id}"]`);
const statusText = () => document.getElementById('status-message').textContent;
const overviewCard = (index) => document.querySelectorAll('#machine-overview .workspace-mode-card')[index];

test('groups_by_session_fields', async () => {
  const env = await setup();
  assert.equal(env.app.machineCaps.get(MK), 'legacy');
  const names = tall('project-row').map((r) => r.querySelector('.project-name').textContent);
  assert.deepEqual(names, ['devflow', 'notes'], 'two projects, by name');
  const devflow = projectRow('devflow').closest('.project-group');
  const rows = tall('worktree-row', devflow);
  assert.equal(rows.length, 2, 'the main directory and the worktree of the worktree session');
  assert.ok(rows[0].querySelector('[data-testid="worktree-tag-main"]'), 'the main directory comes first');
  assert.equal(rows[1].querySelector('.worktree-label').textContent, WT_BRANCH, "the worktree row shows the session's branch");
  assert.equal(rows[0].closest('.worktree-group').querySelector('.session-item').dataset.sessionId, 'main-1');
  assert.equal(rows[1].closest('.worktree-group').querySelector('.session-item').dataset.sessionId, WT_ID);
  assert.equal(tall('worktree-empty').length, 0, 'no worktree without a session can be listed');
  const notes = projectRow('notes').closest('.project-group');
  assert.equal(tall('worktree-row', notes).length, 0, 'a plain folder has no worktree level');
  assert.equal(notes.querySelector('.session-item').dataset.sessionId, 'notes-1');
  assert.equal(tall('session-row').length, 3, 'every session is listed exactly once');
  assert.equal(tall('session-gone').length, 0, 'nothing is marked as missing');
  teardown(env);
});

test('same_tree_whatever_order_the_daemon_lists', async () => {
  // A protocol 3 daemon lists sessions in map order, different on every poll.
  const more = [
    ...SESSIONS,
    { id: 'notes-2', title: 'notes', workdir: '/tmp/notes', created: '2026-01-01T00:00:04Z', mode: 'normal' },
    { id: 'notes-sub', title: 'sub', workdir: '/tmp/notes/sub', created: '2026-01-01T00:00:05Z', mode: 'normal' },
    { id: 'main-2', title: 'devflow', workdir: '/r/devflow', created: '2026-01-01T00:00:06Z', mode: 'normal' },
    { id: 'src-1', title: 'src', workdir: '/r/devflow/src', created: '2026-01-01T00:00:07Z', mode: 'normal' },
  ];
  const env = await setup(more);
  const snapshot = () => [...document.querySelectorAll('#machine-list [data-testid="project-row"], #machine-list [data-testid="worktree-row"], #machine-list [data-testid="session-row"]')]
    .map((r) => `${r.dataset.testid}:${r.querySelector('.project-name, .worktree-label, .session-label-text')?.textContent}:${r.dataset.sessionId ?? ''}`);
  const first = snapshot();
  const order = (ids) => first.filter((l) => l.startsWith('session-row:')).map((l) => l.split(':')[2]).filter((id) => ids.includes(id));
  assert.deepEqual(order(['notes-1', 'notes-2']), ['notes-1', 'notes-2'], 'sessions of one folder in creation order');
  assert.deepEqual(order(['main-1', 'main-2', 'src-1']), ['main-1', 'main-2', 'src-1']);
  assert.ok(first.includes('session-row:notes:notes-1') && first.includes('session-row:notes 2:notes-2'), `same-named sessions of one folder are numbered: ${first.join(' | ')}`);
  assert.ok(first.includes('session-row:devflow:main-1') && first.includes('session-row:devflow 2:main-2'));
  assert.ok(first.includes('project-row:sub:'), 'a subfolder of a plain folder is a project of its own, as on a protocol 4 daemon');
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 40; i++) {
    env.daemon.sessions = [...more].map((s) => [rand(), s]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    await env.app.refreshAllMachines(true, MK);
    assert.deepEqual(snapshot(), first, `poll ${i + 1}: listed as ${env.daemon.sessions.map((s) => s.id).join(',')}`);
  }
  teardown(env);
});

test('note_and_disabled_entries', async () => {
  const env = await setup();
  const note = tid('machine-legacy-note');
  assert.ok(note, 'the machine says why entries are missing');
  assert.equal(note.textContent, t('sidebar.legacy.note'));
  const upgrade = '需要升级这台机器的 vibe-remoted';
  assert.equal(t('sidebar.legacy.needUpgrade'), upgrade);

  const newWorktree = tid('project-new-worktree', projectRow('devflow'));
  assert.ok(newWorktree, 'the entry is shown');
  assert.equal(newWorktree.disabled, true);
  assert.equal(newWorktree.title, upgrade);
  // The way a person's click arrives: a disabled button does not take it.
  newWorktree.click();
  await settle();
  assert.equal(document.querySelector('.modal-overlay'), null, 'a disabled entry opens nothing');

  const row = tall('worktree-row').find((r) => r.querySelector('.worktree-label').textContent === WT_BRANCH);
  click(tid('worktree-menu', row));
  const del = tid('worktree-delete');
  assert.ok(del, 'the menu has the entry');
  assert.equal(del.disabled, true);
  assert.equal(del.parentElement.querySelector('.menu-note').textContent, upgrade);
  click(del);
  await settle();
  assert.equal(document.querySelector('.modal-overlay'), null);
  assert.ok(!env.daemon.requests.some((r) => r.includes('/api/v1/worktrees/')), `no worktree endpoint was called: ${env.daemon.requests.join(', ')}`);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  // The main directory row has no delete entry at all, as everywhere.
  const mainRow = tall('worktree-row').find((r) => r.querySelector('[data-testid="worktree-tag-main"]'));
  assert.equal(tid('worktree-menu', mainRow), null);
  teardown(env);
});

test('chat_still_available', async () => {
  const env = await setup();
  click(overviewCard(0));
  await settle();
  const picker = document.querySelector('.modal-overlay');
  assert.ok(picker, 'the directory picker opened');
  assert.equal(tid('picker-ui-chat', picker).disabled, false, 'protocol 3 has the chat interface');
  assert.equal(tid('picker-ui-chat-reason', picker).hidden, true);
  // The picker says the daemon is older, with both protocol numbers.
  const warn = [...picker.querySelectorAll('.modal-mode-note')].find((n) => n.getAttribute('role') === 'note');
  assert.equal(warn.textContent, t('picker.oldDaemon', { proto: 3, want: 4, version: '0.1.3' }));
  assert.ok(warn.textContent.includes('协议 3') && warn.textContent.includes('协议 4'), warn.textContent);
  click(tid('dialog-cancel', picker));
  await settle();

  // "New session" on a worktree row works against the old daemon too.
  const row = tall('worktree-row').find((r) => r.querySelector('.worktree-label').textContent === WT_BRANCH);
  click(tid('worktree-new-session', row));
  await settle();
  const dialog = document.querySelector('.modal-overlay [data-testid="worktree-session-dialog"]');
  assert.ok(dialog);
  assert.equal(tid('picker-ui-chat', dialog).disabled, false);
  assert.equal(tid('dialog-confirm', dialog).disabled, false);
  click(tid('picker-ui-chat', dialog));
  click(tid('dialog-confirm', dialog));
  await settle();
  const attach = env.daemon.frames.filter((f) => f.type === 'attach').at(-1);
  assert.equal(attach.workdir, WT_ROOT);
  assert.equal(attach.ui, 'chat');
  assert.equal(attach.mode, 'normal');
  assert.ok(!('worktreeName' in attach));
  teardown(env);
});

test('worktree_mode_sends_no_name', async () => {
  const env = await setup();
  click(overviewCard(1));
  await settle();
  const picker = document.querySelector('.modal-overlay');
  assert.ok(picker, 'the directory picker opened');
  const worktreeCard = [...picker.querySelectorAll('.modal-mode-card:not(.modal-ui-card)')][1];
  assert.equal(worktreeCard.getAttribute('aria-pressed'), 'true', 'Worktree mode is chosen');
  assert.equal(tid('wt-name-input', picker), null, 'no name field: this daemon names the worktree itself');
  const modeNote = [...picker.querySelectorAll('.modal-mode-note')].find((n) => n.textContent === t('picker.modeNote'));
  assert.ok(modeNote && !modeNote.hidden, 'the old note about the isolated branch is shown instead');
  const confirm = tid('dialog-confirm', picker);
  assert.equal(confirm.disabled, false);
  click(confirm);
  await settle();
  const attaches = env.daemon.frames.filter((f) => f.type === 'attach');
  assert.equal(attaches.length, 1);
  const attach = attaches[0];
  assert.equal(attach.mode, 'worktree');
  assert.equal(attach.workdir, '/r/devflow');
  assert.match(attach.newSessionId, /^\d+-[0-9a-f]{8}$/);
  assert.ok(!('worktreeName' in attach), `the attach has no worktreeName key: ${JSON.stringify(attach)}`);
  assert.ok(!env.daemon.requests.some((r) => r.includes('/api/v1/worktrees/')), 'the daemon was never asked for a plan');
  // The session came up on the branch the daemon chose.
  assert.equal(env.app.activeKey, `${MK}::${attach.newSessionId}`);
  teardown(env);
});

test('old_daemon_warning_text', async () => {
  const env = await setup();
  click(sessionRow('main-1').querySelector('.session-label'));
  // A session not open yet opens after the double-click (rename) window.
  await new Promise((r) => setTimeout(r, 280));
  await settle();
  assert.equal(env.app.activeKey, `${MK}::main-1`);
  const text = statusText();
  assert.equal(text, t('terminal.oldDaemon', { proto: 3, want: 4 }));
  assert.equal(text, '远程 daemon 的协议版本 3 低于桌面端 4，部分功能不可用，请更新 vibe-remoted');
  assert.equal(document.getElementById('status-bar').hidden, false);
  teardown(env);
});

test('delete_confirm_is_legacy_text', async () => {
  const env = await setup();
  click(sessionRow(WT_ID).querySelector('.session-close'));
  await settle();
  let dialog = document.querySelector('.modal-overlay [data-testid="delete-session-dialog"]');
  assert.ok(dialog, 'the in-app confirmation opened');
  const note = tid('delete-session-note', dialog);
  assert.equal(note.textContent, t('session.delete.legacyWorktree'));
  assert.ok(note.textContent.includes('旧版') && note.textContent.includes('一并删除'), note.textContent);
  assert.ok(!dialog.textContent.includes('都会保留'), 'it does not promise the worktree is kept');
  click(tid('dialog-cancel', dialog));
  await settle();
  assert.ok(!env.daemon.requests.some((r) => r.startsWith('DELETE')), 'cancelling deletes nothing');

  // A plain session: nothing to say about a worktree.
  click(sessionRow('notes-1').querySelector('.session-close'));
  await settle();
  dialog = document.querySelector('.modal-overlay [data-testid="delete-session-dialog"]');
  assert.ok(dialog);
  assert.equal(tid('delete-session-note', dialog), null);
  click(tid('dialog-cancel', dialog));
  await settle();
  // A plain session in the main directory row of a project neither.
  click(sessionRow('main-1').querySelector('.session-close'));
  await settle();
  dialog = document.querySelector('.modal-overlay [data-testid="delete-session-dialog"]');
  assert.equal(tid('delete-session-note', dialog), null);
  click(tid('dialog-cancel', dialog));
  await settle();
  teardown(env);
});

test('delete_removes_session_and_its_worktree_row', async () => {
  // The old daemon deletes a clean worktree with its session: 204, and the row is gone.
  const env = await setup();
  click(sessionRow(WT_ID).querySelector('.session-close'));
  await settle();
  click(tid('dialog-confirm', document.querySelector('.modal-overlay')));
  await settle(30);
  assert.deepEqual(env.daemon.requests.filter((r) => r.startsWith('DELETE')), [`DELETE /api/v1/sessions/${WT_ID}`]);
  assert.equal(sessionRow(WT_ID), null);
  assert.equal(tall('worktree-row').length, 0, 'one directory left in the project: no worktree level');
  assert.equal(projectRow('devflow').closest('.project-group').querySelector('.session-item').dataset.sessionId, 'main-1');
  teardown(env);
});

test('preserved_409_still_shown', async () => {
  const env = await setup();
  env.daemon.deleteAnswer = () => json(409, { error: 'worktree_preserved', message: 'worktree has uncommitted changes', worktreeRoot: WT_ROOT, branch: WT_BRANCH });
  click(sessionRow(WT_ID).querySelector('.session-close'));
  await settle();
  click(tid('dialog-confirm', document.querySelector('.modal-overlay')));
  await settle(30);
  assert.equal(statusText(), `Worktree 已保留 · ${WT_ROOT} · 分支 ${WT_BRANCH}`);
  assert.equal(statusText(), t('session.worktreePreserved', { path: WT_ROOT, branch: WT_BRANCH }));
  teardown(env);
});

test('upgrade_in_place', async () => {
  const env = await setup();
  assert.ok(tid('machine-legacy-note'));
  // The daemon is replaced by a protocol 4 build; the next poll sees it.
  env.daemon.projects = [{
    id: '/r/devflow', name: 'devflow', git: true, sessions: [], worktrees: [
      { path: '/r/devflow', branch: 'main', head: 'a1b2c3d', main: true, sessions: ['main-1'] },
      { path: WT_ROOT, branch: WT_BRANCH, head: '9f8e7d6', managed: true, sessions: [WT_ID] },
      { path: '/r/devflow/.devflow-tmp/worktrees/general-skills', branch: 'change/general-skills', head: '1234567', sessions: [] },
    ],
  }, { id: '/tmp/notes', name: 'notes', git: false, worktrees: [], sessions: ['notes-1'] }];
  await env.app.refreshAllMachines(true, MK);
  assert.equal(env.app.machineCaps.get(MK), 'v4');
  assert.equal(tid('machine-legacy-note'), null, 'the note is gone');
  assert.equal(tid('project-new-worktree', projectRow('devflow')).disabled, false);
  assert.equal(tall('worktree-row').length, 3, 'the worktree without a session is listed now');
  assert.equal(tall('worktree-empty').length, 1);
  const row = tall('worktree-row').find((r) => r.querySelector('.worktree-label').textContent === WT_BRANCH);
  click(tid('worktree-menu', row));
  assert.equal(tid('worktree-delete').disabled, false);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  // Deleting a worktree session now says the worktree is kept.
  click(sessionRow(WT_ID).querySelector('.session-close'));
  await settle();
  const note = tid('delete-session-note', document.querySelector('.modal-overlay'));
  assert.equal(note.textContent, t('session.delete.keepsWorktree', { worktree: WT_BRANCH }));
  click(tid('dialog-cancel', document.querySelector('.modal-overlay')));
  await settle();

  // And back: a daemon rolled back to protocol 3 is noticed the same way.
  env.daemon.projects = null;
  await env.app.refreshAllMachines(true, MK);
  assert.equal(env.app.machineCaps.get(MK), 'legacy');
  assert.ok(tid('machine-legacy-note'));
  assert.equal(tall('worktree-empty').length, 0);
  teardown(env);
});

await run();
// Status-bar timers and client pings would keep the process alive.
process.exit(0);
