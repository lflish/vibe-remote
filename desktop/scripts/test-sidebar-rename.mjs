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

// For the views opened through index.ts (openChat below): a socket that opens
// when told to and records what the client sends.
const sockets = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  fireOpen() { this.readyState = 1; this.onopen?.(); }
};
const bash = (id) => ({ requestId: id, seq: 1, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch x' }, tool_use_id: `tu-${id}` } });

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

  /**
   * A chat view opened the way the app opens it (index.ts openChatSession: its
   * callbacks are wired), on a socket that records what is sent.
   */
  const openChat = (id, pending = []) => {
    const view = app.openChatSession(machine, id, `/w/${id}`);
    const ws = sockets.at(-1);
    ws.fireOpen();
    view.setConnected(true);
    view.client.onChatSync({ type: 'chat_sync', epoch: 'e', reset: true, omitted: 0, historyCount: 0, backlog: 0 });
    const push = (list) => { view.client.onChatState({ ...chatState, status: list.length ? 'waiting' : 'idle', pending: list }); page.flushFrames(); page.flushFrames(); };
    push(pending);
    opened.push(view);
    return {
      view, ws, push,
      input: view.container.querySelector('[data-testid="chat-input"]'),
      card: () => view.container.querySelector('[data-testid="chat-perm"]'),
      responses: () => ws.sent.filter((f) => f.type === 'chat_respond'),
      interrupts: () => ws.sent.filter((f) => f.type === 'chat_interrupt'),
    };
  };
  const opened = [];
  const close = () => { for (const v of opened) v.client.disconnect(); page.dom.window.close(); };

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
  /** A real key press on whatever has the keyboard. */
  const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  return { page, app, sessions, renames, chat, openChat, close, terminal, label, titles, renameInput, doubleClick, typeAndEnter, key, settle };
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

// X10: when a rename is over the keyboard is back in the current session, and
// a session opened from the sidebar with a prompt waiting has the keyboard on
// the prompt card — the user types, or presses the 1 / Esc written on the
// card, without clicking first.
test('X10 rename ends with Enter or Esc: the keyboard is back in the current chat session', async () => {
  const t = await setup();
  const c1 = t.openChat('c1');
  t.page.flushFrames();
  for (const [how, name] of [['Enter', 'renamed'], ['Escape', 'renamed']]) {
    t.doubleClick(t.titles()[0], { humanPace: true });
    assert.equal(document.activeElement, t.renameInput(), 'renaming');
    if (how === 'Enter') t.typeAndEnter(name);
    else t.key('Escape');
    await t.settle();
    t.page.flushFrames();
    assert.equal(t.renameInput(), null, `${how}: the rename is over`);
    assert.equal(document.activeElement, c1.input, `${how}: the keyboard is in the chat input`);
  }
  assert.deepEqual(t.renames, [['c1', 'renamed']]);
  t.close();
});

test('X10 rename ends with Enter or Esc: the keyboard is back in the current terminal session', async () => {
  const t = await setup();
  const term = t.terminal('t1');
  t.app.setActive(term.view.key);
  t.page.flushFrames();
  for (const how of ['Enter', 'Escape']) {
    t.doubleClick(t.titles()[1], { humanPace: true });
    assert.equal(document.activeElement, t.renameInput(), 'renaming');
    if (how === 'Enter') t.typeAndEnter('build box');
    else t.key('Escape');
    await t.settle();
    t.page.flushFrames();
    assert.equal(document.activeElement, term.helper, `${how}: the keyboard is in the terminal`);
  }
  assert.deepEqual(term.typed, [], 'the terminal got none of the rename keys');
  t.close();
});

test('X10 rename committed by clicking another session: the keyboard ends in that session', async () => {
  const t = await setup();
  const c1 = t.openChat('c1');
  const c2 = t.openChat('c2'); // current
  t.page.flushFrames();
  t.doubleClick('other', { humanPace: true }); // rename the current session c2
  t.renameInput().value = 'kept';
  // A click on another session's name: the press takes the focus off the
  // input (blur commits), the click switches.
  t.renameInput().blur();
  t.label('conversation').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  t.page.flushFrames();
  await t.settle();
  t.page.flushFrames();
  assert.deepEqual(t.renames, [['c2', 'kept']]);
  assert.equal(t.app.activeKey, c1.view.key, 'the clicked session is the current one');
  assert.equal(document.activeElement, c1.input, 'the keyboard is in the session that was clicked');
  assert.equal(c2.input.value, '', 'nothing went into the renamed session');
  t.close();
});

test('X10 rename committed by a click into a field elsewhere, or a dialog: the keyboard stays there', async () => {
  const t = await setup();
  const c1 = t.openChat('c1', [bash('r1')]); // a prompt is waiting in the current session
  t.page.flushFrames();
  // Any other field of the app (not in a dialog).
  const elsewhere = document.createElement('input');
  document.body.appendChild(elsewhere);
  t.doubleClick(t.titles()[0], { humanPace: true });
  t.renameInput().value = 'zero';
  elsewhere.focus(); // the user clicks into it: blur commits
  await t.settle();
  t.page.flushFrames();
  assert.deepEqual(t.renames, [['c1', 'zero']]);
  assert.equal(document.activeElement, elsewhere, 'the field the user clicked into keeps the keyboard');
  elsewhere.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const field = document.createElement('input');
  const button = document.createElement('button');
  overlay.append(field, button);
  document.body.appendChild(overlay);
  for (const target of [field, button]) {
    t.doubleClick(t.titles()[0], { humanPace: true });
    t.renameInput().value = target === field ? 'one' : 'two';
    target.focus(); // the user clicks into the dialog: blur commits
    await t.settle();
    t.page.flushFrames();
    assert.equal(document.activeElement, target, 'the dialog keeps the keyboard after the rename was saved');
  }
  // Focus nowhere, but a dialog is open: the session behind it does not take the keyboard.
  t.doubleClick('two', { humanPace: true });
  t.key('Escape');
  await t.settle();
  t.page.flushFrames();
  assert.equal(document.activeElement, document.body, 'nothing behind an open dialog takes the keyboard');
  assert.deepEqual(c1.responses(), []);
  t.close();
});

test('X10 opening a session whose prompt is waiting: the keyboard is on the card, 1 answers it and the input has it afterwards', async () => {
  const t = await setup();
  const c1 = t.openChat('c1');
  const c2 = t.openChat('c2'); // current; c1 is in the background
  t.page.flushFrames();
  c2.input.focus();
  c1.push([bash('r1')]); // the background session asks for permission
  assert.ok(c1.card(), 'the card exists in the background view');
  assert.equal(document.activeElement, c2.input, 'a card in a background session leaves the keyboard where it is');
  t.label('conversation').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  t.page.flushFrames();
  assert.equal(t.app.activeKey, c1.view.key);
  assert.equal(document.activeElement, c1.card(), 'the prompt card has the keyboard');
  t.key('1');
  assert.deepEqual(c1.responses().map((f) => [f.requestId, f.response.behavior]), [['r1', 'allow']], '1 = yes, without a click');
  c1.push([]); // answered: the card goes away
  assert.equal(c1.card(), null);
  assert.equal(document.activeElement, c1.input, 'the keyboard is in the input once the card is gone');

  // Same with Esc; and a plain click on the current session's name gives the
  // keyboard to the card, not to the (hidden) input.
  t.label('other').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  t.page.flushFrames();
  c1.push([bash('r2')]);
  t.label('conversation').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  t.page.flushFrames();
  assert.equal(document.activeElement, c1.card(), 'the second prompt card has the keyboard');
  document.body.focus();
  document.activeElement.blur?.();
  t.label('conversation').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  t.page.flushFrames();
  assert.equal(document.activeElement, c1.card(), 'click on the current session: keyboard on its card');
  t.key('Escape');
  assert.equal(c1.interrupts().length, 1, 'Esc interrupts, without a click');
  // A session with nothing waiting: the input.
  t.label('other').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  t.page.flushFrames();
  assert.equal(document.activeElement, c2.input, 'no prompt: the keyboard is in the input');
  t.close();
});

test('X10 a prompt that arrives in the current session while it is being renamed leaves the keyboard in the rename input', async () => {
  const t = await setup();
  const c1 = t.openChat('c1');
  t.page.flushFrames();
  t.doubleClick('conversation', { humanPace: true });
  const input = t.renameInput();
  input.value = 'name with 1 in it';
  c1.push([bash('r1')]);
  assert.ok(c1.card(), 'the card is there');
  assert.equal(document.activeElement, input, 'the rename input still has the keyboard');
  assert.equal(t.renameInput(), input, 'the rename is still open');
  assert.deepEqual(t.renames, [], 'nothing was saved half-typed');
  // Enter saves; now the keyboard goes to the waiting card.
  t.typeAndEnter('name with 1 in it');
  await t.settle();
  t.page.flushFrames();
  assert.deepEqual(t.renames, [['c1', 'name with 1 in it']]);
  assert.deepEqual(c1.responses(), [], 'no key of the name answered the prompt');
  assert.equal(document.activeElement, c1.card(), 'after the rename the card has the keyboard');
  t.close();
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
