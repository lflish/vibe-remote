// ChatView on a jsdom window: frames in → DOM out, with a fake client. Covers
// the data-testids the GUI tests rely on (chat-view, chat-transcript,
// chat-msg-user / -assistant, chat-tool, chat-diff, chat-input, chat-send,
// chat-stop), that a typed message goes out through the queue, and that model
// output is rendered as sanitized markdown. T10: permission / plan / question
// prompts (chat-perm*, chat-plan*, chat-question*), the mode switcher
// (chat-mode), the slash menu (chat-slash-menu) and queued messages
// (chat-queue-item).
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

const bashReq = (suggestions) => ({ subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' }, tool_use_id: 'tu1', ...(suggestions ? { permission_suggestions: suggestions } : {}) });
const addRules = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' };
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const responds = (client) => client.sent.filter((f) => f.type === 'chat_respond');

test('permission prompt: allow, always, deny, handled elsewhere', () => {
  const { view, client, $, $$ } = makeView();
  client.onChatState(state({ status: 'waiting', pending: [{ requestId: 'r1', seq: 3, request: bashReq([addRules]) }] }));
  flush();
  const perm = $('chat-perm');
  assert.ok(perm, 'prompt shown');
  assert.equal(perm.dataset.requestId, 'r1');
  assert.equal(perm.dataset.state, 'open');
  assert.ok(perm.textContent.includes('npm test'));
  assert.ok($('chat-perm-always'), 'don\'t-ask-again option from the suggestion');
  assert.equal(view.composer.root.hidden, true, 'the prompt replaces the composer');
  click($('chat-perm-allow'));
  assert.deepEqual(responds(client).at(-1), { type: 'chat_respond', requestId: 'r1', response: { behavior: 'allow', updatedInput: { command: 'npm test' } }, setMode: undefined });
  flush();
  assert.equal($('chat-perm').dataset.state, 'submitting');
  assert.equal($('chat-perm-allow').disabled, true, 'no second click while submitting');
  client.onChatAck({ type: 'chat_ack', op: 'respond', ref: 'r1', ok: false, code: 'request_not_pending' });
  flush();
  assert.equal($('chat-perm').dataset.state, 'handledElsewhere');
  client.onChatState(state({ status: 'running', pending: [] }));
  flush();
  assert.equal($('chat-perm'), null);
  assert.equal(view.composer.root.hidden, false, 'composer back');

  // Always: sends the rule suggestion.
  client.onChatState(state({ status: 'waiting', pending: [{ requestId: 'r2', seq: 4, request: bashReq([addRules]) }] }));
  flush();
  click($('chat-perm-always'));
  assert.deepEqual(responds(client).at(-1).response.updatedPermissions, [addRules]);
  // chat_busy: answerable again.
  client.onChatAck({ type: 'chat_ack', op: 'respond', ref: 'r2', ok: false, code: 'chat_busy' });
  flush();
  assert.equal($('chat-perm').dataset.state, 'open');

  // Deny with a note; no suggestions → no always option (R5.2b).
  client.onChatState(state({ status: 'waiting', pending: [{ requestId: 'r3', seq: 5, request: bashReq() }] }));
  flush();
  assert.equal($('chat-perm-always'), null);
  $('chat-perm-deny-text').value = '先别改这个文件';
  click($('chat-perm-deny'));
  assert.deepEqual(responds(client).at(-1), { type: 'chat_respond', requestId: 'r3', response: { behavior: 'deny', message: '先别改这个文件' }, setMode: undefined });
  assert.equal($$('chat-perm').length, 1);
});

test('plan prompt options', () => {
  const { client, $ } = makeView();
  const plan = { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Plan\n1. **do** it' }, requires_user_interaction: true };
  client.onChatState(state({ status: 'waiting', permissionMode: 'plan', pending: [{ requestId: 'p1', seq: 1, request: plan }] }));
  flush();
  const card = $('chat-plan');
  assert.ok(card);
  assert.ok(card.querySelector('h1'), 'plan rendered as markdown');
  for (const n of [1, 2, 3]) assert.ok($(`chat-plan-opt-${n}`), `option ${n}`);
  click($('chat-plan-opt-2'));
  assert.deepEqual(responds(client).at(-1), { type: 'chat_respond', requestId: 'p1', response: { behavior: 'allow', updatedInput: plan.input }, setMode: 'default' });
  client.onChatAck({ type: 'chat_ack', op: 'respond', ref: 'p1', ok: false, code: 'chat_busy' });
  flush();
  card.querySelector('input').value = 'use a2';
  click($('chat-plan-opt-3'));
  assert.deepEqual(responds(client).at(-1).response, { behavior: 'deny', message: 'use a2' });
});

test('question prompt', () => {
  const { client, $ } = makeView();
  const input = { questions: [
    { question: 'Tea or coffee?', header: 'Drink', options: [{ label: 'Tea' }, { label: 'Coffee' }], multiSelect: false },
    { question: 'Fruits?', header: 'Fruit', options: [{ label: 'Apple' }, { label: 'Banana' }], multiSelect: true },
  ] };
  client.onChatState(state({ status: 'waiting', permissionMode: 'bypassPermissions', permissionLocked: true, pending: [{ requestId: 'q1', seq: 1, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input } }] }));
  flush();
  const card = $('chat-question');
  assert.ok(card, 'question card shows in bypass too');
  const submit = $('chat-question-submit');
  assert.equal(submit.disabled, true, 'nothing answered');
  assert.equal(card.querySelectorAll('.q.missing').length, 2, 'unanswered questions marked');
  const radios = card.querySelectorAll('input[type=radio]');
  radios[0].checked = true;
  radios[0].dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(submit.disabled, true);
  assert.equal(card.querySelectorAll('.q.missing').length, 1);
  const boxes = card.querySelectorAll('.q')[1].querySelectorAll('input[type=checkbox]');
  boxes[0].checked = true;
  boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
  boxes[1].checked = true;
  boxes[1].dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(submit.disabled, false);
  click(submit);
  assert.deepEqual(responds(client).at(-1).response.updatedInput.answers, { 'Tea or coffee?': 'Tea', 'Fruits?': 'Apple, Banana' });
});

test('mode switcher', () => {
  const { client, $ } = makeView();
  const chip = $('chat-mode');
  assert.ok(chip);
  assert.equal(chip.dataset.mode, 'default');
  click(chip);
  const items = [...document.querySelectorAll('[data-testid="chat-mode-option"]')];
  assert.deepEqual(items.map((i) => i.dataset.mode), ['default', 'acceptEdits', 'plan']);
  click(items[2]);
  assert.deepEqual(client.sent.at(-1), { type: 'chat_set_mode', mode: 'plan' });
  // Shift+Tab cycles from the input.
  client.onChatState(state({ permissionMode: 'acceptEdits' }));
  flush();
  $('chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  assert.deepEqual(client.sent.at(-1), { type: 'chat_set_mode', mode: 'plan' });
  // Locked: only bypass, with the reason.
  client.onChatState(state({ permissionMode: 'bypassPermissions', permissionLocked: true }));
  flush();
  const before = client.sent.length;
  click($('chat-mode'));
  const locked = [...document.querySelectorAll('[data-testid="chat-mode-option"]')];
  assert.deepEqual(locked.map((i) => i.dataset.mode), ['bypassPermissions']);
  assert.ok($('chat-mode-locked'), 'reason shown');
  $('chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  assert.equal(client.sent.length, before, 'no mode change when locked');
});

test('slash menu and terminal-only commands', () => {
  const { client, $ } = makeView();
  client.onChatState(state({ slashCommands: [{ name: 'compact', description: 'Compact' }, { name: 'review', description: 'Review' }] }));
  flush();
  const input = $('chat-input');
  input.value = '/';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  let menu = $('chat-slash-menu');
  assert.ok(menu && !menu.hidden, 'menu opens on /');
  assert.equal(menu.querySelectorAll('[data-testid="chat-slash-item"]').length, 2);
  input.value = '/co';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(menu.querySelectorAll('[data-testid="chat-slash-item"]').length, 1);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(input.value, '/compact ', 'Enter picks the command into the input');
  assert.equal(client.sent.filter((f) => f.type === 'chat_send').length, 0, 'picking does not send');
  assert.equal($('chat-slash-menu').hidden, true);
  input.value = '/login';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(client.sent.filter((f) => f.type === 'chat_send').length, 0, '/login is not sent');
  assert.ok($('chat-terminal-only'), 'terminal-only notice');
  assert.equal(input.value, '/login', 'input kept');
});

test('queue items, withdraw, interrupt returns them', () => {
  const { client, $, $$ } = makeView();
  client.onChatState(state({ status: 'running' })); // another desktop's turn
  flush();
  const input = $('chat-input');
  for (const text of ['one', 'two']) {
    input.value = text;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  flush();
  assert.equal(client.sent.filter((f) => f.type === 'chat_send').length, 0);
  let items = $$('chat-queue-item');
  assert.equal(items.length, 2);
  click(items[0].querySelector('button'));
  flush();
  items = $$('chat-queue-item');
  assert.equal(items.length, 1);
  assert.ok(items[0].textContent.includes('two'));
  input.value = 'draft';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(client.sent.at(-1), { type: 'chat_interrupt' });
  flush();
  assert.equal($$('chat-queue-item').length, 0);
  assert.equal(input.value, 'two\n\ndraft', 'queued text back in the input, not sent');
  client.onChatState(state({ status: 'idle' }));
  flush();
  assert.equal(client.sent.filter((f) => f.type === 'chat_send').length, 0);
});

test('undelivered message can be re-sent under the same id', () => {
  const { client, $, $$ } = makeView();
  const input = $('chat-input');
  input.value = 'hello';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const id = client.sent.at(-1).clientMsgId;
  client.onChatAck({ type: 'chat_ack', op: 'send', ref: id, ok: false, code: 'chat_not_running' });
  flush();
  const bubble = $$('chat-msg-user')[0];
  assert.equal(bubble.dataset.delivery, 'undelivered');
  click(bubble.querySelector('[data-testid="chat-resend"]'));
  flush();
  const last = client.sent.at(-1);
  assert.equal(last.type, 'chat_send');
  assert.equal(last.clientMsgId, id);
  assert.equal($$('chat-msg-user').length, 1, 'no second bubble');
});

test('resend clicked twice while offline: one queue entry, one bubble, queue not stuck', () => {
  const { view, client, $, $$ } = makeView();
  const input = $('chat-input');
  input.value = 'hello';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const id = client.sent.at(-1).clientMsgId;
  client.onChatAck({ type: 'chat_ack', op: 'send', ref: id, ok: false, code: 'chat_not_running' });
  flush();
  view.setConnected(false);
  client.open = false;
  click($('chat-resend'));
  flush();
  const again = $('chat-resend');
  assert.ok(!again || again.disabled, 'resend button disabled once queued');
  if (again) click(again);
  flush();
  assert.deepEqual(view.queue.queued().map((it) => it.id), [id], 'queued once');
  // Reconnect: an incremental sync, the queued resend goes out once.
  client.open = true;
  view.setConnected(true);
  client.onChatSync({ type: 'chat_sync', epoch: 'e', reset: false, omitted: 0, historyCount: 0, backlog: 0 });
  client.onChatState(state());
  flush();
  assert.equal(client.sent.filter((f) => f.type === 'chat_send' && f.clientMsgId === id).length, 2, 'original + one resend');
  client.onChat(1, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }, vr_client_msg_id: id }, false);
  client.onChat(2, { type: 'result', subtype: 'success', is_error: false, result: 'hi' }, false);
  client.onChatAck({ type: 'chat_ack', op: 'send', ref: id, ok: true });
  client.onChatState(state());
  flush();
  assert.equal($$('chat-msg-user').length, 1, 'one bubble');
  assert.equal(view.state().messages.find((m) => m.role === 'user').delivery, 'sent');
  input.value = 'next message';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  flush();
  assert.equal(client.sent.at(-1).text, 'next message', 'queue not stuck');
  assert.equal(view.queue.queued().length, 0);
});

test('reset sync past an overflow: the sent message is confirmed by a duplicate ack, not marked undelivered', () => {
  for (const completed of [true, false]) {
    const { view, client, $, $$ } = makeView();
    const input = $('chat-input');
    input.value = 'burst 1200';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const id = client.sent.at(-1).clientMsgId;
    // Dropped before the echo; the turn overflowed the ring while away.
    view.setConnected(false);
    view.setConnected(true);
    client.onChatSync({ type: 'chat_sync', epoch: 'e', reset: true, omitted: 400, historyCount: 0, backlog: 1 });
    client.onChat(900, { type: 'assistant', message: { id: 'msg_tail', content: [{ type: 'text', text: 'tail' }] } }, false);
    client.onChatState(state({ status: completed ? 'idle' : 'running' }));
    flush();
    const bubble = $$('chat-msg-user')[0];
    assert.notEqual(bubble.dataset.delivery, 'undelivered', 'not judged undelivered from an evicted echo');
    assert.equal($('chat-resend'), null);
    const again = client.sent.filter((f) => f.type === 'chat_send' && f.clientMsgId === id);
    assert.equal(again.length, 2, 'asked the daemon again under the same id');
    // Daemon: duplicate (already written); completed or still running.
    client.onChatAck({ type: 'chat_ack', op: 'send', ref: id, ok: true, duplicate: true, completed });
    flush();
    assert.equal(view.state().messages.find((m) => m.role === 'user').delivery, 'sent');
    assert.equal($$('chat-msg-user').length, 1);
    input.value = 'echo next';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    flush();
    if (completed) {
      assert.equal(client.sent.at(-1).text, 'echo next', 'queue released');
    } else {
      assert.equal(view.queue.queued().length, 1, 'waits for the running turn');
      client.onChat(901, { type: 'result', subtype: 'success', is_error: false }, false);
      client.onChatState(state());
      flush();
      assert.equal(client.sent.at(-1).text, 'echo next', 'sent after its result');
    }
    assert.equal(view.queue.queued().length, 0);
    assert.equal(view.queue.canSend(), false, 'next one in flight');
  }
});

test('history in batches with frames between: only the newest 300 end up in the DOM', () => {
  const { view, client, $$ } = makeView();
  client.onChatSync({ type: 'chat_sync', epoch: 'e2', reset: true, omitted: 0, historyCount: 3000, backlog: 0 });
  for (let batch = 0; batch < 15; batch++) {
    for (let i = batch * 200; i < (batch + 1) * 200; i++) {
      client.onChat(0, { type: 'assistant', message: { id: `hist-${i}`, content: [{ type: 'text', text: `History ${i}` }] } }, true);
    }
    flush();
    assert.ok($$('chat-msg-assistant').length <= 300, `batch ${batch}: at most 300 in the DOM`);
  }
  client.onChatState(state());
  flush();
  const nodes = $$('chat-msg-assistant');
  assert.equal(view.state().messages.length, 3000);
  assert.equal(nodes.length, 300);
  assert.equal(nodes[0].dataset.id, 'hist-2700');
  assert.equal(nodes.at(-1).dataset.id, 'hist-2999');
  // New live messages still follow at the bottom.
  client.onChat(1, { type: 'assistant', message: { id: 'live-1', content: [{ type: 'text', text: 'live' }] } }, false);
  flush();
  assert.equal($$('chat-msg-assistant').at(-1).dataset.id, 'live-1');
});

test('ended banner, restart tracking and retry', () => {
  const { view, client, $ } = makeView();
  const calls = [];
  view.onRestart = () => calls.push('restart');
  view.onHandoff = () => calls.push('handoff');
  view.onRecheck = () => calls.push('recheck');
  view.onOpenTerminal = (id) => calls.push(`open:${id}`);
  const msgs = [];
  view.onMessage = (m) => msgs.push(m);
  flush();
  assert.equal($('chat-ended').hidden, true, 'no banner while running');

  // Turn error → retry sends the same text as a new message (R13.1).
  const input = $('chat-input');
  input.value = 'please';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const first = client.sent.at(-1);
  client.onChat(1, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'please' }] }, vr_client_msg_id: first.clientMsgId }, false);
  client.onChat(2, { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 Overloaded' }, false);
  flush();
  click($('chat-retry'));
  flush();
  const again = client.sent.at(-1);
  assert.equal(again.type, 'chat_send');
  assert.equal(again.text, 'please');
  assert.notEqual(again.clientMsgId, first.clientMsgId);

  // Process exited → restart + handoff (R13.2).
  client.onChatState(state({ status: 'ended', ended: { reason: 'exited', code: 1, stderrTail: 'boom' } }));
  flush();
  assert.equal($('chat-ended').hidden, false);
  assert.equal($('chat-ended').dataset.reason, 'exited');
  click($('chat-restart'));
  click($('chat-handoff'));
  assert.deepEqual(calls, ['restart', 'handoff']);
  assert.equal($('chat-input').disabled, true, 'no input while ended');

  // Reload: 202 → "restarting" → stopped → new epoch idle = done (d10).
  view.beginRestart();
  flush();
  assert.equal($('chat-ended').dataset.reason, 'restarting');
  client.onChatState(state({ status: 'ended', ended: { reason: 'stopped' } }));
  flush();
  assert.equal($('chat-ended').dataset.reason, 'restarting', 'stopped is the reload\'s own first step');
  client.onChatSync({ type: 'chat_sync', epoch: 'e2', reset: true, omitted: 0, historyCount: 0, backlog: 0 });
  client.onChatState(state());
  flush();
  assert.equal($('chat-ended').hidden, true);
  assert.equal(msgs.at(-1), 'Chat session restarted');

  // Restart failure shows the message (R15.3, d10).
  view.beginRestart();
  client.onChatState(state({ status: 'ended', ended: { reason: 'restart_failed', message: 'No conversation found' } }));
  flush();
  assert.equal($('chat-ended').dataset.reason, 'restart_failed');
  assert.match($('chat-ended').textContent, /No conversation found/);

  // Version too old → recheck; handed off → open the terminal session only.
  client.onChatState(state({ status: 'ended', ended: { reason: 'version_unsupported', claudeVersion: '1.0.0', minClaudeVersion: '2.1.210' } }));
  flush();
  click($('chat-recheck'));
  assert.equal($('chat-restart'), null);
  client.onChatState(state({ status: 'ended', ended: { reason: 'handed_off', handedOffTo: 't-1' } }));
  flush();
  assert.equal($('chat-handoff'), null);
  click($('chat-open-terminal'));
  assert.deepEqual(calls.slice(2), ['recheck', 'open:t-1']);
});

await run();
