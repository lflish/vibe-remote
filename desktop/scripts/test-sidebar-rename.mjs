// Inline rename from the sidebar (R15.1, X8): double-clicking the name of a
// session that is already open must end in a focused rename input — for chat
// and terminal sessions, current or in the background — and Enter saves the
// name. The renderer entry (index.ts) runs on jsdom with real ChatViews; the
// terminal view is a stand-in whose terminal.focus() takes the keyboard like
// xterm's helper textarea does.
//
// A real double click is click → click → dblclick. The pointer does not move,
// so the second click lands on whatever label is under it by then, and
// dblclick goes to the element the second click hit — even if a handler took
// that element out of the document in between.
import { strict as assert } from 'node:assert';
import { indexDom, load, loadIndex, runner } from './chat-test-util.mjs';

const { test, run } = runner('test-sidebar-rename');

const machine = { name: 'dev', addr: '127.0.0.1', port: 1234, token: 't' };
const mk = '127.0.0.1:1234';
const chatState = { type: 'chat_state', status: 'idle', permissionMode: 'default', permissionLocked: false, pending: [], slashCommands: [], claudeVersion: '2.1.210', claudeSessionId: 'u', ended: null };

async function setup() {
  const page = await indexDom();
  const app = await loadIndex();
  const sessions = [
    { id: 'c1', title: 'conversation', workdir: '/w/c1', created: '2026-11-20', mode: 'normal', ui: 'chat', state: 'idle' },
    { id: 't1', title: 'shell', workdir: '/w/t1', created: '2026-11-20', mode: 'normal' },
    { id: 'c2', title: 'other', workdir: '/w/c2', created: '2026-11-20', mode: 'normal', ui: 'chat', state: 'idle' },
  ];
  const renames = [];
  app.setMachines([machine]);
  app.machineOnline.set(mk, true);
  app.machineSessions.set(mk, sessions);
  app.rests.set(mk, {
    async renameSession(id, name) { renames.push([id, name]); sessions.find((s) => s.id === id).title = name; },
    async listSessions() { return sessions.map((s) => ({ ...s })); },
  });
  const host = document.getElementById('terminal-container');

  const chat = (id) => {
    const client = { sent: [], state: 'connected', sendChat(text) { this.sent.push(text); return true; }, reconnectNow() {}, disconnect() {} };
    const view = new app.ChatView(machine, client, `${mk}::${id}`, id, `/w/${id}`);
    host.appendChild(view.container);
    app.views.set(view.key, view);
    view.setConnected(true);
    client.onChatSync({ type: 'chat_sync', epoch: 'e', reset: true, omitted: 0, historyCount: 0, backlog: 0 });
    client.onChatState(chatState);
    return { view, client, input: view.container.querySelector('[data-testid="chat-input"]') };
  };
  const terminal = (id) => {
    const container = document.createElement('div');
    // A visible terminal has a box: setActive fits and focuses it right away.
    Object.defineProperty(container, 'clientWidth', { get: () => (container.style.display === 'none' ? 0 : 800) });
    Object.defineProperty(container, 'clientHeight', { get: () => (container.style.display === 'none' ? 0 : 600) });
    const helper = document.createElement('textarea');
    container.appendChild(helper);
    host.appendChild(container);
    const typed = [];
    helper.addEventListener('keydown', (e) => typed.push(e.key));
    const view = {
      ui: 'terminal', key: `${mk}::${id}`, sessionId: id, machine, container, activity: 'none', client: { state: 'connected' },
      terminal: { focus: () => helper.focus() }, fitAddon: { fit() {} },
    };
    app.views.set(view.key, view);
    return { view, helper, typed };
  };

  const label = (title) => [...document.querySelectorAll('.session-item')].find((i) => i.querySelector('.session-label-text')?.textContent === title)?.querySelector('.session-label') ?? null;
  const titles = () => [...document.querySelectorAll('.session-item')].map((i) => i.querySelector('.session-label-text')?.textContent ?? '(renaming)');
  const renameInput = () => document.querySelector('.session-rename-input');
  /** click → click → dblclick on the label showing `title`; frames run between the clicks at a human pace. */
  const doubleClick = (title, { humanPace }) => {
    label(title).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    if (humanPace) page.flushFrames();
    const second = label(title);
    second.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    second.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    for (let i = 0; i < 3; i++) page.flushFrames();
  };
  /** Type into whatever has the keyboard, then Enter. */
  const typeAndEnter = (text) => {
    const el = document.activeElement;
    if (el && 'value' in el) el.value = text;
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  };
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  return { page, app, sessions, renames, chat, terminal, label, titles, renameInput, doubleClick, typeAndEnter, settle };
}

for (const humanPace of [true, false]) {
  const pace = humanPace ? 'human pace' : 'instant';

  test(`open chat session, current: double click renames it, nothing is sent to claude (${pace})`, async () => {
    const t = await setup();
    const c1 = t.chat('c1');
    t.app.setActive(c1.view.key);
    t.page.flushFrames();
    t.doubleClick('conversation', { humanPace });
    const input = t.renameInput();
    assert.ok(input && input.isConnected, 'the rename input is in the sidebar');
    assert.equal(document.activeElement, input, 'the rename input has the keyboard');
    t.typeAndEnter('登录页重构');
    await t.settle();
    assert.deepEqual(t.renames, [['c1', '登录页重构']], 'saved on the daemon');
    assert.deepEqual(c1.client.sent, [], 'no chat message went out');
    assert.equal(c1.input.value, '', 'nothing typed into the chat input');
    assert.deepEqual(t.titles(), ['登录页重构', 'shell', 'other'], 'sidebar shows the new name');
    // The sidebar keeps updating afterwards.
    t.app.setActive(c1.view.key);
    assert.ok(t.label('登录页重构').closest('.session-item').classList.contains('active'));
    t.page.dom.window.close();
  });

  test(`open chat session, in the background: double click switches to it and renames it (${pace})`, async () => {
    const t = await setup();
    const c1 = t.chat('c1');
    const c2 = t.chat('c2');
    t.app.setActive(c2.view.key);
    t.page.flushFrames();
    t.doubleClick('conversation', { humanPace });
    const input = t.renameInput();
    assert.ok(input && input.isConnected, 'the rename input is in the sidebar');
    assert.equal(document.activeElement, input, 'the rename input has the keyboard');
    assert.equal(t.app.activeKey, c1.view.key, 'the first click made it the current session');
    t.typeAndEnter('renamed');
    await t.settle();
    assert.deepEqual(t.renames, [['c1', 'renamed']]);
    assert.deepEqual([...c1.client.sent, ...c2.client.sent], [], 'no chat message went out');
    t.page.dom.window.close();
  });

  test(`open terminal session, current and background: double click renames it, no keys reach the terminal (${pace})`, async () => {
    for (const background of [false, true]) {
      const t = await setup();
      const term = t.terminal('t1');
      const c2 = t.chat('c2');
      t.app.setActive(background ? c2.view.key : term.view.key);
      t.page.flushFrames();
      t.doubleClick('shell', { humanPace });
      const input = t.renameInput();
      assert.ok(input && input.isConnected, `the rename input is in the sidebar (background=${background})`);
      assert.equal(document.activeElement, input, `the rename input has the keyboard (background=${background})`);
      t.typeAndEnter('build box');
      await t.settle();
      assert.deepEqual(t.renames, [['t1', 'build box']]);
      assert.deepEqual(term.typed, [], 'the terminal got no keys');
      assert.deepEqual(t.titles(), ['conversation', 'build box', 'other']);
      t.page.dom.window.close();
    }
  });
}

test('Esc cancels, blur saves; the keyboard goes back to the session afterwards', async () => {
  const t = await setup();
  const c1 = t.chat('c1');
  t.app.setActive(c1.view.key);
  t.page.flushFrames();
  t.doubleClick('conversation', { humanPace: true });
  t.renameInput().value = 'not kept';
  t.renameInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await t.settle();
  assert.deepEqual(t.renames, [], 'Esc saves nothing');
  assert.equal(t.renameInput(), null);
  assert.deepEqual(t.titles(), ['conversation', 'shell', 'other']);
  t.doubleClick('conversation', { humanPace: true });
  t.renameInput().value = 'kept';
  c1.input.focus(); // the user clicks into the chat: blur commits
  await t.settle();
  assert.deepEqual(t.renames, [['c1', 'kept']]);
  // A plain click on the current session's name puts the keyboard back in it.
  t.label('kept').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  t.page.flushFrames();
  assert.equal(document.activeElement, c1.input, 'click on the current session focuses its input');
  t.page.dom.window.close();
});

test('a rename that cannot start (its label is no longer in the document) does not freeze the sidebar', async () => {
  const t = await setup();
  const c1 = t.chat('c1');
  t.app.setActive(c1.view.key);
  const stale = t.label('conversation');
  t.app.renderSidebar(); // e.g. the 5 s poll rebuilt the list under the pointer
  assert.equal(stale.isConnected, false);
  stale.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
  t.page.flushFrames();
  assert.equal(t.renameInput(), null, 'no rename input appeared');
  // The sidebar still follows the session list and the current session.
  t.sessions[0].title = 'changed elsewhere';
  t.app.machineSessions.set(mk, t.sessions.map((s) => ({ ...s })));
  t.app.renderSidebar();
  assert.deepEqual(t.titles(), ['changed elsewhere', 'shell', 'other'], 'sidebar rebuilt');
  t.page.dom.window.close();
});

// Same sidebar, the delete button: a chat session's conversation is kept in
// claude's own history (R15.2), a terminal session's screen is not. The
// confirmation must say which.
test('delete confirmation: chat says the conversation stays in claude\'s history, terminal says the screen is lost (zh and en)', async () => {
  const t = await setup();
  const { dictionaries } = await load('src/renderer/i18n.ts');
  for (const locale of ['zh', 'en']) {
    const chat = dictionaries[locale]['chat.delete.confirm'];
    assert.ok(chat, `chat.delete.confirm (${locale})`);
    assert.match(chat, /JSONL/, `${locale}: says where the conversation stays`);
    assert.match(chat, /\{name\}/);
    assert.doesNotMatch(chat, /当前画面会丢失|current screen lost/, `${locale}: no "screen is lost" for a chat session`);
    assert.match(dictionaries[locale]['session.deleteConfirm'], /当前画面会丢失|current screen lost/, `${locale}: terminal text unchanged`);
  }

  t.chat('c1');
  t.app.renderSidebar();
  const asked = [];
  window.confirm = (msg) => { asked.push(msg); return false; };
  const item = (title) => t.label(title).closest('.session-item');
  item('conversation').querySelector('.session-close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  item('shell').querySelector('.session-close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.equal(asked.length, 2);
  assert.equal(asked[0], dictionaries.en['chat.delete.confirm'].replace('{name}', 'conversation'));
  assert.equal(asked[1], dictionaries.en['session.deleteConfirm'].replace('{name}', 'shell'));
  assert.deepEqual(t.titles(), ['conversation', 'shell', 'other'], 'declined: nothing deleted');
  t.page.dom.window.close();
});

await run();
