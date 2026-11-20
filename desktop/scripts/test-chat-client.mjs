// Chat (protocol v3) behaviour of the connection layer, client.ts.
//
// A chat session reconnects through the same VibeRemoteClient as a terminal
// session. These checks pin the parts that are chat-specific:
//  - the attach carries ui:'chat' for the life of the session (create, replay
//    before ready, automatic reconnect, manual Retry);
//  - the resync position (epoch, since) is read when the attach is sent, and
//    only once a full sync for the current epoch has completed — a drop in the
//    middle of a sync must resync from scratch (reset), never claim "I have it";
//  - chat frames reach their own callbacks; chat_ack is not an error;
//  - an `exit` on a chat session keeps the session id (reload can bring it back).
//
// Runs client.ts through esbuild against a fake WebSocket and fake timers; no
// test framework.
import { build } from 'esbuild';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { indexDom, loadIndex } from './chat-test-util.mjs';

const dir = mkdtempSync(join(tmpdir(), 'vr-chat-client-'));
const bundle = join(dir, 'client.mjs');
await build({
  entryPoints: ['src/renderer/client.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
});

let now = 1_000_000;
Date.now = () => now;
let nextTimerId = 1;
const timeouts = new Map();
const intervals = new Map();
globalThis.setTimeout = (fn) => { const id = nextTimerId++; timeouts.set(id, fn); return id; };
globalThis.clearTimeout = (id) => timeouts.delete(id);
globalThis.setInterval = (fn) => { const id = nextTimerId++; intervals.set(id, fn); return id; };
globalThis.clearInterval = (id) => intervals.delete(id);
const tickPing = () => { for (const fn of [...intervals.values()]) fn(); };
const fireBackoff = () => {
  assert.equal(timeouts.size, 1, `want exactly one queued reconnect, got ${timeouts.size}`);
  const [id, fn] = [...timeouts.entries()][0];
  timeouts.delete(id);
  fn();
};

const sockets = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor() {
    this.readyState = 0;
    this.sent = [];
    this.closeCalls = 0;
    sockets.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closeCalls++; this.readyState = 3; }
  fireOpen() { this.readyState = 1; this.onopen?.(); }
  fireMessage(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  fireClose() { this.readyState = 3; this.onclose?.(); }
};
const attachesOf = (ws) => ws.sent.filter((f) => f.type === 'attach');
const lastAttach = (ws) => attachesOf(ws).at(-1);

const { VibeRemoteClient } = await import(bundle);
const newClient = () => new VibeRemoteClient({ name: 'm', addr: '127.0.0.1', port: 1, token: 't' });

const state = (extra = {}) => ({
  type: 'chat_state', status: 'idle', permissionMode: 'default', permissionLocked: false,
  pending: [], slashCommands: [], claudeVersion: '2.1.210', claudeSessionId: 'u', ended: null, ...extra,
});
const chat = (seq, extra = {}) => ({ type: 'chat', seq, msg: { type: 'assistant', message: { id: `m${seq}`, content: [] } }, ...extra });
const readyChat = (id = 'c1') => ({ type: 'ready', sessionId: id, workdir: '/w', proto: 3, mode: 'normal', ui: 'chat', claudeSessionId: 'u' });

let passed = 0;
const test = (name, fn) => {
  timeouts.clear();
  intervals.clear();
  try {
    fn();
  } catch (e) {
    console.error(`FAIL: test-chat-client: ${name}`);
    console.error(e);
    process.exit(1);
  }
  passed++;
  console.log(`ok - test-chat-client: ${name}`);
};

test('chat attach carries ui and position at send time', () => {
  const client = newClient();
  client.connect();
  let ws = sockets.at(-1);
  ws.fireOpen();
  client.attach('c1', 80, 24, undefined, undefined, undefined, { ui: 'chat' });
  const first = lastAttach(ws);
  assert.equal(first.ui, 'chat');
  assert.equal(first.sessionId, 'c1');
  assert.equal(first.epoch, undefined, 'first attach must not claim a position');
  assert.equal(first.since, undefined);

  ws.fireMessage(readyChat('c1'));
  ws.fireMessage({ type: 'chat_sync', epoch: 'e1', reset: true, omitted: 0, historyCount: 1, backlog: 2 });
  ws.fireMessage({ type: 'chat', seq: 0, h: true, msg: { type: 'user', message: { content: 'hi' } } });
  ws.fireMessage(chat(1));
  ws.fireMessage(chat(2));
  ws.fireMessage(state());
  ws.fireMessage(chat(3));
  ws.fireMessage(chat(4));
  ws.fireMessage(chat(5));
  ws.fireClose();
  fireBackoff();
  ws = sockets.at(-1);
  ws.fireOpen();
  const re = lastAttach(ws);
  assert.equal(re.ui, 'chat');
  assert.equal(re.sessionId, 'c1');
  assert.equal(re.epoch, 'e1');
  assert.equal(re.since, 5);
  client.disconnect();
});

test('同步中途断线后重连仍走 reset', () => {
  const client = newClient();
  client.connect();
  let ws = sockets.at(-1);
  ws.fireOpen();
  client.attach('c2', 80, 24, undefined, undefined, undefined, { ui: 'chat' });
  ws.fireMessage(readyChat('c2'));
  // A complete sync first, so the client has a valid position…
  ws.fireMessage({ type: 'chat_sync', epoch: 'e1', reset: true, omitted: 0, historyCount: 0, backlog: 1 });
  ws.fireMessage(chat(7));
  ws.fireMessage(state());
  ws.fireClose();
  fireBackoff();
  ws = sockets.at(-1);
  ws.fireOpen();
  assert.equal(lastAttach(ws).since, 7);
  ws.fireMessage(readyChat('c2'));
  // …then a second sync that drops halfway (no closing chat_state).
  ws.fireMessage({ type: 'chat_sync', epoch: 'e2', reset: true, omitted: 0, historyCount: 0, backlog: 3 });
  ws.fireMessage(chat(1));
  ws.fireClose();
  fireBackoff();
  ws = sockets.at(-1);
  ws.fireOpen();
  const re = lastAttach(ws);
  assert.equal(re.ui, 'chat');
  assert.equal(re.epoch, undefined, 'half-received sync must not be reported as a position');
  assert.equal(re.since, undefined);

  // A reset sync (or a new epoch) zeroes lastSeq: seq 1 of the new epoch is
  // delivered even though seq 7 was seen in the old one.
  ws.fireMessage(readyChat('c2'));
  const got = [];
  client.onChat = (seq) => got.push(seq);
  ws.fireMessage({ type: 'chat_sync', epoch: 'e3', reset: true, omitted: 0, historyCount: 0, backlog: 2 });
  ws.fireMessage(chat(1));
  ws.fireMessage(chat(2));
  ws.fireMessage(chat(2)); // duplicate: dropped
  ws.fireMessage(chat(1)); // stale: dropped
  ws.fireMessage(state());
  assert.deepEqual(got, [1, 2]);
  assert.deepEqual(client.chatPosition(), { epoch: 'e3', seq: 2 });
  // An incremental sync for the same epoch keeps lastSeq.
  ws.fireMessage({ type: 'chat_sync', epoch: 'e3', reset: false, omitted: 0, historyCount: 0, backlog: 0 });
  assert.equal(client.chatPosition(), null, 'position is withheld while a sync is in progress');
  ws.fireMessage(state());
  assert.deepEqual(client.chatPosition(), { epoch: 'e3', seq: 2 });
  // Epoch change without reset flag still zeroes lastSeq.
  ws.fireMessage({ type: 'chat_sync', epoch: 'e4', reset: false, omitted: 0, historyCount: 0, backlog: 0 });
  ws.fireMessage(state());
  assert.deepEqual(client.chatPosition(), { epoch: 'e4', seq: 0 });
  client.disconnect();
});

test("已确认的对话会话重连带 ui:'chat'", () => {
  const client = newClient();
  client.connect();
  let ws = sockets.at(-1);
  ws.fireOpen();
  client.attach('', 80, 24, '/w', ['f'], 'normal', { ui: 'chat' });
  const created = lastAttach(ws);
  assert.equal(created.ui, 'chat');
  ws.fireMessage(readyChat('c3'));
  // Automatic reconnect.
  ws.fireClose();
  fireBackoff();
  ws = sockets.at(-1);
  ws.fireOpen();
  let re = lastAttach(ws);
  assert.equal(re.sessionId, 'c3');
  assert.equal(re.ui, 'chat');
  assert.equal(re.newSessionId, undefined);
  assert.equal(re.workdir, undefined);
  // Manual Retry.
  ws.fireClose();
  client.reconnectNow();
  ws = sockets.at(-1);
  ws.fireOpen();
  re = lastAttach(ws);
  assert.equal(re.sessionId, 'c3');
  assert.equal(re.ui, 'chat');
  client.disconnect();

  // A terminal session created by a handoff: handoffFrom is part of the create
  // intent only; after ready the replay is a plain re-attach.
  const t = newClient();
  t.connect();
  ws = sockets.at(-1);
  ws.fireOpen();
  t.attach('', 80, 24, undefined, undefined, undefined, { ui: 'terminal', handoffFrom: 'c3' });
  const ho = lastAttach(ws);
  assert.equal(ho.handoffFrom, 'c3');
  assert.ok(ho.newSessionId);
  // Drop before ready: replay keeps handoffFrom and the same newSessionId.
  ws.fireClose();
  fireBackoff();
  ws = sockets.at(-1);
  ws.fireOpen();
  const hoReplay = lastAttach(ws);
  assert.equal(hoReplay.handoffFrom, 'c3');
  assert.equal(hoReplay.newSessionId, ho.newSessionId);
  ws.fireMessage({ type: 'ready', sessionId: 't9', workdir: '/w', proto: 3, mode: 'normal', handoffFrom: 'c3' });
  ws.fireClose();
  fireBackoff();
  ws = sockets.at(-1);
  ws.fireOpen();
  re = lastAttach(ws);
  assert.equal(re.sessionId, 't9');
  assert.equal(re.handoffFrom, undefined, 'handoffFrom must not be replayed after ready');
  assert.notEqual(re.ui, 'chat');
  t.disconnect();
});

test('create replay keeps newSessionId and ui', () => {
  const client = newClient();
  client.connect();
  let ws = sockets.at(-1);
  ws.fireOpen();
  client.attach('', 100, 30, '/proj', ['skip-perms'], 'worktree', { ui: 'chat' });
  const first = lastAttach(ws);
  assert.ok(first.newSessionId);
  ws.fireClose();
  fireBackoff();
  ws = sockets.at(-1);
  ws.fireOpen();
  const re = lastAttach(ws);
  assert.equal(re.newSessionId, first.newSessionId);
  assert.equal(re.ui, 'chat');
  assert.equal(re.workdir, '/proj');
  assert.deepEqual(re.flags, ['skip-perms']);
  assert.equal(re.mode, 'worktree');
  assert.equal(re.epoch, undefined);
  client.disconnect();
});

test('exit keeps session', () => {
  const client = newClient();
  client.connect();
  let ws = sockets.at(-1);
  ws.fireOpen();
  client.attach('c5', 80, 24, undefined, undefined, undefined, { ui: 'chat' });
  ws.fireMessage(readyChat('c5'));
  const exits = [];
  client.onExit = (code) => exits.push(code);
  ws.fireMessage({ type: 'exit', code: 1 });
  assert.deepEqual(exits, [1]);
  ws.fireClose();
  fireBackoff();
  ws = sockets.at(-1);
  ws.fireOpen();
  const re = lastAttach(ws);
  assert.equal(re?.sessionId, 'c5', 'a chat session must re-attach after exit (reload brings it back)');
  assert.equal(re.ui, 'chat');
  client.disconnect();

  // Terminal session: unchanged — exit forgets the session.
  const t = newClient();
  t.connect();
  ws = sockets.at(-1);
  ws.fireOpen();
  t.attach('t1', 80, 24);
  ws.fireMessage({ type: 'ready', sessionId: 't1', workdir: '/w', proto: 3, mode: 'normal' });
  ws.fireMessage({ type: 'exit', code: 0 });
  ws.fireClose();
  fireBackoff();
  ws = sockets.at(-1);
  ws.fireOpen();
  assert.equal(attachesOf(ws).length, 0, 'terminal session must not re-attach after exit');
  t.disconnect();
});

test('chat_ack routed', () => {
  const client = newClient();
  const acks = [];
  const errors = [];
  const syncs = [];
  const states = [];
  const readies = [];
  client.onChatAck = (a) => acks.push(a);
  client.onError = (m) => errors.push(m);
  client.onChatSync = (s) => syncs.push(s);
  client.onChatState = (s) => states.push(s);
  client.onReady = (id, wd, proto, ready) => readies.push({ id, wd, proto, ready });
  client.connect();
  const ws = sockets.at(-1);
  ws.fireOpen();
  client.attach('c6', 80, 24, undefined, undefined, undefined, { ui: 'chat' });
  ws.fireMessage(readyChat('c6'));
  assert.equal(readies.length, 1);
  assert.equal(readies[0].proto, 3);
  assert.equal(readies[0].ready.ui, 'chat');
  assert.equal(readies[0].ready.claudeSessionId, 'u');
  ws.fireMessage({ type: 'chat_sync', epoch: 'e', reset: true, omitted: 0, historyCount: 0, backlog: 0 });
  ws.fireMessage(state({ status: 'running' }));
  ws.fireMessage({ type: 'chat_ack', op: 'respond', ref: 'r1', ok: false, code: 'request_not_pending' });
  assert.equal(acks.length, 1);
  assert.equal(acks[0].code, 'request_not_pending');
  assert.equal(errors.length, 0, 'chat_ack must not surface as an error');
  assert.equal(syncs.length, 1);
  assert.equal(states.at(-1).status, 'running');
  assert.equal(client.state, 'connected');

  // Outgoing chat frames.
  assert.equal(client.sendChat('hello', 'm-1'), true);
  assert.equal(client.respond('r1', { behavior: 'allow', updatedInput: {} }, 'acceptEdits'), true);
  assert.equal(client.interrupt(), true);
  assert.equal(client.setMode('plan'), true);
  const out = ws.sent.filter((f) => f.type.startsWith('chat_'));
  assert.deepEqual(out, [
    { type: 'chat_send', clientMsgId: 'm-1', text: 'hello' },
    { type: 'chat_respond', requestId: 'r1', response: { behavior: 'allow', updatedInput: {} }, setMode: 'acceptEdits' },
    { type: 'chat_interrupt' },
    { type: 'chat_set_mode', mode: 'plan' },
  ]);
  ws.readyState = 3;
  assert.equal(client.sendChat('x', 'm-2'), false, 'sendChat reports a closed socket');
  client.disconnect();
});

// G3: a create that hits a daemon in shutdown gets shutting_down (fatal:false)
// and is replayed with the same newSessionId once the daemon is back.
test('shutting_down before ready: create kept and replayed with the same id', () => {
  const client = newClient();
  const errors = [];
  client.onError = (msg, fatal, code) => errors.push({ fatal, code });
  client.connect();
  let ws = sockets.at(-1);
  ws.fireOpen();
  client.attach('', 80, 24, '/w', undefined, 'normal', { ui: 'chat' });
  const created = lastAttach(ws);
  ws.fireMessage({ type: 'error', code: 'shutting_down', fatal: false, message: 'create session: daemon is shutting down' });
  ws.fireClose();
  assert.deepEqual(errors, [{ fatal: false, code: 'shutting_down' }]);
  assert.equal(client.state, 'reconnecting', 'keeps reconnecting');
  fireBackoff();
  ws = sockets.at(-1);
  ws.fireOpen();
  const re = lastAttach(ws);
  assert.equal(re.newSessionId, created.newSessionId, 'same create id');
  assert.equal(re.ui, 'chat');
  assert.equal(re.workdir, '/w');
  client.disconnect();
});

// Same hidden-window case as test-client-liveness, on a chat intent: chat
// connections get exactly the same watchdog and must not be dropped either.
test('liveness throttled on a chat intent', () => {
  const client = newClient();
  client.connect();
  const ws = sockets.at(-1);
  ws.fireOpen();
  client.attach('bg', 80, 24, undefined, undefined, undefined, { ui: 'chat' });
  ws.fireMessage(readyChat('bg'));
  for (let i = 0; i < 10; i++) {
    now += 61_000;
    tickPing();
    assert.equal(client.state, 'connected', `throttled-but-healthy chat connection dropped on tick ${i}`);
    now += 300;
    ws.fireMessage({ type: 'pong' });
  }
  assert.equal(ws.closeCalls, 0);
  // And a genuinely silent chat connection is still detected.
  now += 25_000; tickPing();
  now += 25_000; tickPing();
  now += 25_000; tickPing();
  assert.equal(client.state, 'reconnecting');
  client.disconnect();
});

// Renderer entry (index.ts): a create that fails before `ready` must not
// leave its view behind under the "new session" key — the next new chat or
// new terminal on that machine has to start a fresh attach, not reopen the
// dead view.
{
  const page = await indexDom();
  const app = await loadIndex();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ list: [] }) });
  const machine = { name: 'm', addr: '127.0.0.1', port: 1, token: 't' };
  app.setMachines([machine]);
  app.rebuildRests();
  test('fatal create before ready: next new chat / terminal starts fresh', () => {
    const before = sockets.length;
    const first = app.openChatSession(machine, '', '/w/a');
    const ws = sockets.at(-1);
    ws.fireOpen();
    assert.equal(lastAttach(ws).workdir, '/w/a');
    ws.fireMessage({ type: 'error', code: 'create_failed', fatal: true, message: 'spawn failed' });
    ws.fireClose();
    assert.equal([...app.views.values()].includes(first), false, 'failed view dropped');
    assert.equal(first.container.isConnected, false, 'failed view removed from the page');
    assert.equal(app.activeKey, null, 'nothing current');

    const again = app.openChatSession(machine, '', '/w/b');
    assert.notEqual(again, first);
    assert.equal(sockets.length, before + 2, 'new chat opened its own connection');
    const ws2 = sockets.at(-1);
    ws2.fireOpen();
    assert.equal(lastAttach(ws2).workdir, '/w/b');
    assert.equal(lastAttach(ws2).ui, 'chat');

    const term = app.openSession(machine, '', '/w/c');
    assert.notEqual(term, again, 'a new terminal is not the chat being created');
    assert.equal(term.ui, 'terminal');
    assert.equal(sockets.length, before + 3);
    const ws3 = sockets.at(-1);
    ws3.fireOpen();
    assert.equal(lastAttach(ws3).workdir, '/w/c');
    assert.equal(lastAttach(ws3).ui, undefined);
    // Both creates are still open, each under its own key.
    assert.ok([...app.views.values()].includes(again));
    assert.ok([...app.views.values()].includes(term));
    for (const v of [...app.views.values()]) v.client.disconnect();
  });
  page.dom.window.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(`chat client checks passed (${passed})`);
process.exit(0);
