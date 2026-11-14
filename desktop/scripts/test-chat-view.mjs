// ChatView on a jsdom window: frames in → DOM out, with a fake client. Covers
// the data-testids the GUI tests rely on (chat-view, chat-transcript,
// chat-msg-user / -assistant, chat-tool, chat-diff, chat-input, chat-send,
// chat-stop), that a typed message goes out through the queue, and that model
// output is rendered as sanitized markdown.
import { strict as assert } from 'node:assert';
import { JSDOM } from 'jsdom';
import { load, runner } from './chat-test-util.mjs';

const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
const w = dom.window;
for (const k of ['window', 'document', 'HTMLElement', 'HTMLDetailsElement', 'Node', 'MouseEvent', 'KeyboardEvent', 'Event']) {
  Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
}
let rafQueue = [];
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
const flush = () => { const q = rafQueue; rafQueue = []; q.forEach((f) => f(0)); };
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });
w.vibeRemote = { openExternal: async () => true, writeClipboardText: async () => true };

const { ChatView } = await load('src/renderer/chat/view.ts', { platform: 'browser' });
const { test, run } = runner('test-chat-view');

class FakeClient {
  constructor() { this.sent = []; this.open = true; }
  sendChat(text, id) { if (!this.open) return false; this.sent.push({ type: 'chat_send', text, clientMsgId: id }); return true; }
  respond(requestId, response, setMode) { this.sent.push({ type: 'chat_respond', requestId, response, setMode }); return true; }
  interrupt() { this.sent.push({ type: 'chat_interrupt' }); return true; }
  setMode(mode) { this.sent.push({ type: 'chat_set_mode', mode }); return true; }
  reconnectNow() {}
  disconnect() {}
}
const state = (extra = {}) => ({ type: 'chat_state', status: 'idle', permissionMode: 'default', permissionLocked: false, pending: [], slashCommands: [], claudeVersion: '2.1.210', claudeSessionId: 'u', ended: null, ...extra });

function makeView() {
  const client = new FakeClient();
  const view = new ChatView({ name: 'dev', addr: '127.0.0.1', port: 1, token: 't' }, client, 'k', 's1', '/w');
  document.body.appendChild(view.container);
  view.setConnected(true);
  client.onChatSync({ type: 'chat_sync', epoch: 'e', reset: true, omitted: 0, historyCount: 0, backlog: 0 });
  client.onChatState(state());
  flush();
  return { view, client, $: (id) => view.container.querySelector(`[data-testid="${id}"]`), $$: (id) => [...view.container.querySelectorAll(`[data-testid="${id}"]`)] };
}

test('structure and send', () => {
  const { view, client, $, $$ } = makeView();
  assert.equal(view.container.dataset.testid, 'chat-view');
  assert.ok($('chat-transcript'));
  const input = $('chat-input');
  assert.ok(input);
  assert.ok($('chat-send'));
  assert.equal($('chat-stop').hidden, true, 'stop hidden while idle');
  input.value = 'echo hi';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(input.value, '', 'input cleared after send');
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].text, 'echo hi');
  flush();
  assert.equal($$('chat-msg-user').length, 1, 'shows immediately');
  // Blank input sends nothing.
  input.value = '   ';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(client.sent.length, 1);

  const id = client.sent[0].clientMsgId;
  client.onChat(1, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'echo hi' }] }, vr_client_msg_id: id }, false);
  client.onChatState(state({ status: 'running' }));
  client.onChat(2, { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } }, false);
  client.onChat(3, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'h' } } }, false);
  flush();
  assert.equal($('chat-stop').hidden, false, 'stop shows while running');
  client.onChat(4, { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: '**hi** <script>alert(1)</script>' }] } }, false);
  client.onChat(5, { type: 'result', subtype: 'success', is_error: false }, false);
  client.onChatState(state());
  flush();
  assert.equal($$('chat-msg-user').length, 1);
  const a = $$('chat-msg-assistant');
  assert.equal(a.length, 1);
  assert.equal(a[0].querySelector('strong').textContent, 'hi');
  assert.equal(a[0].querySelector('script'), null);
  assert.ok(a[0].textContent.includes('<script>alert(1)</script>'));
});

test('tool blocks and diff', () => {
  const { client, $, $$ } = makeView();
  client.onChat(1, { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.go' } }] } }, false);
  client.onChat(2, { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/a/c.go', old_string: 'x', new_string: 'y' } }] } }, false);
  client.onChat(3, { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'false' } }] } }, false);
  client.onChat(4, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '<b>file</b>' }, { type: 'tool_result', tool_use_id: 't3', content: 'exit 1', is_error: true }] } }, false);
  flush();
  const tools = $$('chat-tool');
  assert.deepEqual(tools.map((d) => [d.dataset.tool, d.dataset.status]), [['Read', 'ok'], ['Edit', 'running'], ['Bash', 'error']]);
  assert.equal(tools[0].open, false, 'Read folded');
  assert.equal(tools[0].querySelector('b'), null, 'tool output is text');
  assert.ok(tools[0].textContent.includes('<b>file</b>'));
  assert.equal(tools[2].open, true, 'failure shown open');
  const diff = $('chat-diff');
  assert.ok(diff);
  assert.equal(diff.querySelectorAll('.dl.del').length, 1);
  assert.equal(diff.querySelectorAll('.dl.add').length, 1);
});

await run();
