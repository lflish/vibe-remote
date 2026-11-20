// chat/session.ts: the chat state machine. Rewritten from 69d8c70
// session.test.ts (vitest; checkpoint / rollback / cost cases dropped) plus the
// v3 cases from the test plan: echo → stream → result, tool pairing, prompts
// from chat_state (submitting reverts, cancelled, bypass), interrupt results,
// slash commands from state, omitted marker, preview merged by message.id,
// turn error with retry text.
import { strict as assert } from 'node:assert';
import { load, runner } from './chat-test-util.mjs';

const { ChatSession, filterSlashCommands, endedView } = await load('src/renderer/chat/index.ts');
const { test, run } = runner('test-chat-session');

const state = (extra = {}) => ({
  type: 'chat_state', status: 'idle', permissionMode: 'default', permissionLocked: false,
  pending: [], slashCommands: [], claudeVersion: '2.1.210', claudeSessionId: 'u', ended: null, ...extra,
});
const sync = (extra = {}) => ({ type: 'chat_sync', epoch: 'e1', reset: true, omitted: 0, historyCount: 0, backlog: 0, ...extra });
const echo = (id, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, vr_client_msg_id: id });
const start = (id) => ({ type: 'stream_event', event: { type: 'message_start', message: { id, model: 'claude-x' } } });
const blockStart = (index, type = 'text') => ({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' } } });
const delta = (text, index = 0) => ({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } });
const stop = () => ({ type: 'stream_event', event: { type: 'message_stop' } });
const assistant = (id, content) => ({ type: 'assistant', message: { id, model: 'claude-x', content } });
const text = (t) => ({ type: 'text', text: t });
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, ...extra });
const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, content, isError = false) => ({ tool_use_id: id, type: 'tool_result', content, is_error: isError });

// A session that has completed an empty reset sync.
function ready() {
  const s = new ChatSession();
  s.applySync(sync());
  s.applyState(state());
  return s;
}
let seq = 0;
const feed = (s, msgs) => { for (const m of msgs) s.applyChat(++seq, m); };
const userBubbles = (st) => st.messages.filter((m) => m.role === 'user');
const assistants = (st) => st.messages.filter((m) => m.role === 'assistant');
const textOf = (m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('');

test('echo → stream → result', () => {
  const s = ready();
  let updates = 0;
  s.onUpdate = () => updates++;
  s.addLocalUser('m1', 'hello');
  let st = s.getState();
  assert.equal(userBubbles(st).length, 1, 'user message shows immediately');
  assert.equal(userBubbles(st)[0].delivery, 'sending');
  feed(s, [echo('m1', 'hello')]);
  s.applyState(state({ status: 'running' }));
  st = s.getState();
  assert.equal(userBubbles(st).length, 1, 'echo replaces the local message, not a second bubble');
  assert.equal(userBubbles(st)[0].delivery, 'sent');
  assert.equal(st.status, 'running');
  feed(s, [start('msg_1'), blockStart(0), delta('Hel')]);
  assert.equal(textOf(assistants(s.getState())[0]), 'Hel');
  assert.equal(assistants(s.getState())[0].streaming, true);
  feed(s, [delta('lo')]);
  assert.equal(textOf(assistants(s.getState())[0]), 'Hello', 'preview grows segment by segment');
  feed(s, [assistant('msg_1', [text('Hello world')]), stop(), result()]);
  s.applyState(state({ status: 'idle' }));
  st = s.getState();
  assert.equal(assistants(st).length, 1);
  assert.deepEqual(assistants(st)[0].parts, [{ type: 'text', text: 'Hello world' }], 'complete block replaces the preview');
  assert.equal(assistants(st)[0].streaming, false);
  assert.equal(st.status, 'idle');
  assert.ok(updates > 0, 'onUpdate fires');
});

test('echo from another desktop is a plain user bubble', () => {
  const s = ready();
  feed(s, [echo('other-1', 'from elsewhere')]);
  const u = userBubbles(s.getState())[0];
  assert.equal(textOf(u), 'from elsewhere');
  assert.equal(u.delivery, undefined);
});

test('tool pairing', () => {
  const s = ready();
  feed(s, [
    echo('m1', 'run things'),
    assistant('msg_a', [{ type: 'thinking', thinking: 'ok' }]),
    assistant('msg_a', [toolUse('tu1', 'Bash', { command: 'echo a' })]),
    assistant('msg_a', [toolUse('tu2', 'Read', { file_path: '/x' })]),
    assistant('msg_a', [toolUse('tu3', 'Edit', { file_path: '/y', old_string: 'a', new_string: 'b' })]),
    { type: 'user', message: { content: [toolResult('tu1', 'a'), toolResult('tu2', [{ type: 'text', text: 'file' }]), toolResult('tu3', 'no such file', true)] } },
  ]);
  const st = s.getState();
  assert.equal(assistants(st).length, 1, 'blocks of one message.id stay one message');
  const parts = assistants(st)[0].parts;
  assert.deepEqual(parts.map((p) => p.type), ['thinking', 'tool_use', 'tool_use', 'tool_use']);
  const byId = Object.fromEntries(parts.filter((p) => p.type === 'tool_use').map((p) => [p.id, p]));
  assert.deepEqual(byId.tu1.result, { content: 'a', isError: false });
  assert.deepEqual(byId.tu2.result, { content: 'file', isError: false });
  assert.deepEqual(byId.tu3.result, { content: 'no such file', isError: true }, 'is_error → failed');
  assert.equal(userBubbles(st).length, 1, 'tool results are not user bubbles');
});

test('preview merged by message.id', () => {
  // Preview, then the rest of the stream caught up after a reconnect
  // (incremental sync), then the complete block: one reply, full text.
  const s = ready();
  feed(s, [echo('m1', 'q'), start('msg_r'), blockStart(0), delta('Hel'), delta('lo')]);
  s.applySync(sync({ reset: false, backlog: 3 }));
  feed(s, [delta(' wor'), delta('ld'), assistant('msg_r', [text('Hello world')])]);
  s.applyState(state({ status: 'running' }));
  let st = s.getState();
  assert.equal(assistants(st).length, 1, 'the reply shows exactly once');
  assert.equal(textOf(assistants(st)[0]), 'Hello world');
  assert.ok(st.messages.some((m) => m.role === 'notice' && m.kind === 'resync' && m.count === 3), 'reconnect divider');

  // Reset sync: the tail is replayed from message_start, then the complete block.
  const r = ready();
  feed(r, [echo('m1', 'q'), start('msg_r'), blockStart(0), delta('Hel')]);
  r.applySync(sync({ epoch: 'e1', backlog: 4 }));
  feed(r, [echo('m1', 'q'), start('msg_r'), blockStart(0), delta('Hel'), delta('lo'), assistant('msg_r', [text('Hello')])]);
  r.applyState(state({ status: 'running' }));
  st = r.getState();
  assert.equal(assistants(st).length, 1);
  assert.equal(textOf(assistants(st)[0]), 'Hello');
  assert.equal(userBubbles(st).length, 1);

  // Two blocks: complete block 0 replaces preview 0, preview 1 stays after it.
  const t = ready();
  feed(t, [start('msg_t'), blockStart(0, 'thinking'), { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } } }]);
  feed(t, [assistant('msg_t', [{ type: 'thinking', thinking: 'hmm.' }]), blockStart(1), delta('An', 1)]);
  assert.deepEqual(assistants(t.getState())[0].parts, [{ type: 'thinking', text: 'hmm.' }, { type: 'text', text: 'An' }]);
});

test('X3 reset sync mid-reply: a long reply shows once, complete (R12.4)', () => {
  // What the daemon replays when a client joins a reply longer than the
  // stream tail (20000 events): the reply's message_start, then the newest
  // deltas. The complete message then replaces the preview.
  const full = 'x'.repeat(20001);
  const s = new ChatSession();
  s.applySync(sync({ backlog: 20001 }));
  feed(s, [start('long-reply'), ...Array.from({ length: 20000 }, () => delta('x'))]);
  s.applyState(state({ status: 'running' }));
  assert.equal(assistants(s.getState()).length, 1, 'one preview while it streams');
  feed(s, [assistant('long-reply', [text(full)]), stop(), result()]);
  s.applyState(state());
  let a = assistants(s.getState());
  assert.equal(a.length, 1, 'the reply shows exactly once');
  assert.equal(textOf(a[0]), full, 'and it is complete');
  assert.equal(a[0].streaming, false);

  // A daemon that dropped the start with the oldest deltas (the frames gate
  // C's counterexample got from e869add): the preview has no id to merge by.
  // The complete message of the same reply still takes its place.
  const o = new ChatSession();
  o.applySync(sync({ backlog: 20000 }));
  feed(o, Array.from({ length: 20000 }, () => delta('x')));
  o.applyState(state({ status: 'running' }));
  assert.equal(assistants(o.getState()).length, 1, 'the tail shows as a preview');
  feed(o, [delta('x'), assistant('long-reply', [text(full)]), stop(), result()]);
  o.applyState(state());
  a = assistants(o.getState());
  assert.equal(a.length, 1, 'no id-less fragment next to the complete reply');
  assert.equal(a[0].id, 'long-reply');
  assert.equal(textOf(a[0]), full);
  assert.equal(a[0].streaming, false);
});

test('X3 id-less preview: joins the message its complete blocks belong to; a later reply does not swallow an abandoned one', () => {
  // Joined while block 1 streams: block 0 is already a complete message (ring),
  // block 1's deltas come without a message_start.
  const s = new ChatSession();
  s.applySync(sync({ backlog: 3 }));
  feed(s, [echo('m1', 'q'), assistant('msg_m', [text('first block')]), delta('sec', 1)]);
  s.applyState(state({ status: 'running' }));
  feed(s, [delta('ond', 1)]);
  feed(s, [assistant('msg_m', [text('second block')]), stop(), result()]);
  s.applyState(state());
  let a = assistants(s.getState());
  assert.equal(a.length, 1, 'one message for the reply');
  assert.deepEqual(a[0].parts.map((p) => p.text), ['first block', 'second block']);

  // While it still streams, the preview shows after the complete block.
  const p = new ChatSession();
  p.applySync(sync({ backlog: 2 }));
  feed(p, [assistant('msg_p', [text('first block')]), delta('sec', 1)]);
  p.applyState(state({ status: 'running' }));
  feed(p, [assistant('msg_p', [{ type: 'tool_use', id: 't9', name: 'Read', input: {} }])]);
  a = assistants(p.getState());
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].parts.map((x) => x.type), ['text', 'tool_use']);

  // A preview whose reply never completed (turn interrupted) stays what it
  // was; the next turn's reply is its own message.
  const t = new ChatSession();
  t.applySync(sync({ backlog: 2 }));
  feed(t, [delta('half a rep'), delta('ly')]);
  t.applyState(state({ status: 'running' }));
  feed(t, [result({ subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' })]);
  feed(t, [echo('m2', 'next'), assistant('msg_n', [text('next reply')]), result()]);
  t.applyState(state());
  a = assistants(t.getState());
  assert.deepEqual(a.map((m) => textOf(m)), ['half a reply', 'next reply']);
});

test('history then backlog', () => {
  const s = new ChatSession();
  s.applySync(sync({ historyCount: 2, backlog: 1 }));
  s.applyHistory({ type: 'user', message: { content: 'earlier question' } });
  s.applyHistory(assistant('msg_h', [text('earlier reply')]));
  feed(s, [echo('m1', 'now')]);
  s.applyState(state({ status: 'running' }));
  const st = s.getState();
  assert.deepEqual(st.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(assistants(st)[0].streaming, false);
});

test('submitting reverts', () => {
  const s = ready();
  const req = { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch x' } };
  s.applyState(state({ status: 'waiting', pending: [{ requestId: 'r1', seq: 5, request: req }] }));
  assert.equal(s.getState().pending[0].state, 'open');
  assert.equal(s.getState().pending[0].kind, 'tool');
  s.markSubmitting('r1');
  assert.equal(s.getState().pending[0].state, 'submitting');
  // An ordinary broadcast keeps "submitting".
  s.applyState(state({ status: 'waiting', pending: [{ requestId: 'r1', seq: 5, request: req }] }));
  assert.equal(s.getState().pending[0].state, 'submitting');
  // Connection dropped before the answer arrived: the reset sync still lists it.
  s.applySync(sync({ epoch: 'e1' }));
  s.applyState(state({ status: 'waiting', pending: [{ requestId: 'r1', seq: 5, request: req }] }));
  assert.equal(s.getState().pending.length, 1);
  assert.equal(s.getState().pending[0].state, 'open', 'back to unanswered (R5.6)');
  // Same after an incremental sync.
  s.markSubmitting('r1');
  s.applySync(sync({ reset: false }));
  s.applyState(state({ status: 'waiting', pending: [{ requestId: 'r1', seq: 5, request: req }] }));
  assert.equal(s.getState().pending[0].state, 'open');
});

test('cancelled', () => {
  const s = ready();
  const req = { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch x' } };
  feed(s, [{ type: 'control_request', request_id: 'r2', request: req }]);
  s.applyState(state({ status: 'waiting', pending: [{ requestId: 'r2', seq: 1, request: req }] }));
  feed(s, [{ type: 'vr_resolved', request_id: 'r2', outcome: 'cancelled' }]);
  let st = s.getState();
  assert.equal(st.pending.length, 0, 'prompt closes');
  assert.equal(s.promptState('r2'), 'cancelled');
  const n = st.messages.find((m) => m.role === 'notice' && m.kind === 'prompt');
  assert.equal(n?.outcome, 'cancelled');
  assert.equal(n?.toolName, 'Bash');
  s.applyState(state({ status: 'running', pending: [] }));
  st = s.getState();
  assert.equal(st.pending.length, 0);
  assert.equal(s.promptState('r2'), 'cancelled', 'cannot be answered any more');
});

test('bypass still shows question cards', () => {
  const s = ready();
  const ask = { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Tea?', options: [{ label: 'Yes' }] }] }, requires_user_interaction: true };
  const plan = { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Plan' }, requires_user_interaction: true };
  s.applyState(state({ status: 'waiting', permissionMode: 'bypassPermissions', permissionLocked: true, pending: [{ requestId: 'q1', seq: 1, request: ask }, { requestId: 'p1', seq: 2, request: plan }] }));
  const st = s.getState();
  assert.equal(st.permissionLocked, true);
  assert.deepEqual(st.pending.map((p) => [p.requestId, p.kind, p.state]), [['q1', 'question', 'open'], ['p1', 'plan', 'open']]);
  assert.ok(!st.pending.some((p) => p.kind === 'tool'), 'no tool permission prompt in bypass');
});

test('interrupted result', () => {
  for (const [reason, marker] of [['aborted_streaming', '[Request interrupted by user]'], ['aborted_tools', '[Request interrupted by user for tool use]']]) {
    const s = ready();
    feed(s, [echo('m1', 'count'), start('msg_i'), blockStart(0), delta('1 2 3'), assistant('msg_i', [text('1 2 3')])]);
    feed(s, [{ type: 'user', message: { content: [{ type: 'text', text: marker }] } }]);
    feed(s, [result({ subtype: 'error_during_execution', is_error: true, terminal_reason: reason })]);
    const st = s.getState();
    const a = assistants(st)[0];
    assert.equal(a.interrupted, true, `${reason}: reply marked interrupted`);
    assert.equal(a.error, undefined, `${reason}: no error card`);
    assert.equal(a.streaming, false);
    assert.equal(userBubbles(st).length, 1, `${reason}: marker is not a user bubble`);
    assert.equal(st.messages.filter((m) => m.role === 'notice' && m.kind === 'interrupted').length, 1, `${reason}: one interrupted mark`);
  }
  // Interrupted with no marker line still gets one mark.
  const s = ready();
  feed(s, [echo('m1', 'x'), result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' })]);
  assert.equal(s.getState().messages.filter((m) => m.role === 'notice' && m.kind === 'interrupted').length, 1);
});

test('string-content user messages render as blocks, not bubbles', () => {
  const s = ready();
  feed(s, [
    echo('m1', '/compact'),
    { type: 'system', subtype: 'compact_boundary', compact_metadata: {} },
    { type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: …' } },
    { type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, isReplay: true },
    result({ num_turns: 0, result: '' }),
  ]);
  const st = s.getState();
  assert.equal(userBubbles(st).length, 1);
  assert.deepEqual(st.messages.filter((m) => m.role === 'notice').map((m) => m.kind), ['compact_boundary', 'compact_summary', 'command_output']);
});

test('slash commands from state', () => {
  const s = ready();
  const cmds = [{ name: 'compact', description: 'Compact' }, { name: 'review', description: 'Review' }, { name: 'fake-skill' }, { name: 'clear' }];
  s.applyState(state({ slashCommands: cmds }));
  const st = s.getState();
  assert.deepEqual(st.slashCommands, cmds);
  assert.deepEqual(filterSlashCommands(st.slashCommands, '/c').map((c) => c.name), ['compact', 'clear']);
  assert.deepEqual(filterSlashCommands(st.slashCommands, '/').map((c) => c.name), ['compact', 'review', 'fake-skill', 'clear']);
  assert.deepEqual(filterSlashCommands(st.slashCommands, '/REV').map((c) => c.name), ['review']);
  assert.deepEqual(filterSlashCommands(st.slashCommands, 'c'), [], 'not a slash input');
  assert.deepEqual(filterSlashCommands(st.slashCommands, '/compact now'), [], 'menu closes after the command word');
});

test('omitted marker', () => {
  const s = new ChatSession();
  s.applySync(sync({ omitted: 200, historyCount: 1, backlog: 2 }));
  s.applyHistory({ type: 'user', message: { content: 'old' } });
  feed(s, [assistant('msg_x', [text('kept 1')]), assistant('msg_y', [text('kept 2')])]);
  s.applyState(state());
  const st = s.getState();
  assert.equal(st.omitted, 200);
  assert.deepEqual(st.messages.map((m) => (m.role === 'notice' ? `notice:${m.kind}:${m.count}` : m.role)), ['user', 'notice:omitted:200', 'assistant', 'assistant']);
  // No backlog: the marker still appears at the end of the sync.
  const e = new ChatSession();
  e.applySync(sync({ omitted: 5 }));
  e.applyState(state());
  assert.equal(e.getState().messages.filter((m) => m.role === 'notice' && m.kind === 'omitted').length, 1);
});

test('turn error', () => {
  const s = ready();
  feed(s, [echo('m1', 'please do it'), result({ is_error: true, subtype: 'success', result: 'API Error: 529 Overloaded' })]);
  const a = assistants(s.getState()).at(-1);
  assert.equal(a.error, 'API Error: 529 Overloaded');
  assert.equal(a.retryText, 'please do it', 'retry resends the turn’s user message');
  // FIFO: with two echoes, the second result belongs to the second message.
  const t = ready();
  feed(t, [echo('m1', 'first'), echo('m2', 'second'), assistant('msg_1', [text('ok')]), result(), result({ is_error: true, result: 'boom' })]);
  const last = assistants(t.getState()).at(-1);
  assert.equal(last.error, 'boom');
  assert.equal(last.retryText, 'second');
  assert.equal(assistants(t.getState())[0].error, undefined);
});

test('undelivered after resync', () => {
  const s = ready();
  const turns = [];
  s.onTurn = (ev) => turns.push(ev);
  s.addLocalUser('m9', 'lost');
  s.applySync(sync({ epoch: 'e1' }));
  s.applyState(state());
  const u = userBubbles(s.getState());
  assert.equal(u.length, 1, 'kept after the reset');
  assert.equal(u[0].delivery, 'undelivered');
  assert.ok(turns.some((e) => e.kind === 'undelivered' && e.clientMsgId === 'm9'));
  assert.equal(s.resend('m9'), 'lost');
  assert.equal(userBubbles(s.getState())[0].delivery, 'sending');
  feed(s, [echo('m9', 'lost')]);
  assert.equal(userBubbles(s.getState()).length, 1);
  assert.equal(userBubbles(s.getState())[0].delivery, 'sent');
  // dropped_on_stop marks the message undelivered too.
  feed(s, [{ type: 'vr_notice', code: 'dropped_on_stop', clientMsgId: 'm9' }]);
  assert.equal(userBubbles(s.getState())[0].delivery, 'undelivered');
});

test('reset sync past an overflow: a missing echo is unconfirmed, not undelivered; duplicate ack settles it', () => {
  const s = ready();
  const turns = [];
  s.onTurn = (ev) => turns.push(ev);
  s.addLocalUser('m7', 'burst');
  // Its echo was evicted from the ring while we were away (omitted > 0).
  s.applySync(sync({ epoch: 'e1', omitted: 300, backlog: 2 }));
  feed(s, [assistant('msg_late', [text('tail')]), result()]);
  s.applyState(state());
  const u = userBubbles(s.getState());
  assert.equal(u.length, 1);
  assert.equal(u[0].delivery, 'sending', 'not judged from the missing echo');
  assert.equal(turns.some((e) => e.kind === 'undelivered'), false);
  assert.ok(turns.some((e) => e.kind === 'unconfirmed' && e.clientMsgId === 'm7'), 'asks to confirm with the daemon');
  // The daemon already has it, and its turn is done.
  s.markDuplicate('m7', true);
  assert.equal(userBubbles(s.getState())[0].delivery, 'sent');
  assert.ok(turns.some((e) => e.kind === 'duplicate' && e.clientMsgId === 'm7' && e.completed === true));
  // A later sync does not judge it again.
  turns.length = 0;
  s.applySync(sync({ epoch: 'e1', reset: false }));
  s.applyState(state());
  assert.equal(userBubbles(s.getState())[0].delivery, 'sent');
  assert.equal(turns.some((e) => e.kind === 'undelivered'), false);

  // Without an overflow a missing echo still means undelivered.
  const t = ready();
  const tt = [];
  t.onTurn = (ev) => tt.push(ev);
  t.addLocalUser('m8', 'lost');
  t.applySync(sync({ epoch: 'e2' }));
  t.applyState(state());
  assert.equal(userBubbles(t.getState())[0].delivery, 'undelivered');
  assert.ok(tt.some((e) => e.kind === 'undelivered' && e.clientMsgId === 'm8'));
});

test('prompt state transitions', () => {
  const s = ready();
  const bash = { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch x' }, tool_use_id: 'tu1' };
  const pend = (...ids) => ids.map((id) => ({ requestId: id, seq: 1, request: bash }));
  feed(s, [{ type: 'control_request', request_id: 'a', request: bash }, { type: 'control_request', request_id: 'b', request: bash }, { type: 'control_request', request_id: 'c', request: bash }, { type: 'control_request', request_id: 'd', request: bash }]);
  s.applyState(state({ status: 'waiting', pending: pend('a', 'b', 'c', 'd') }));
  assert.deepEqual(s.getState().pending.map((p) => p.state), ['open', 'open', 'open', 'open']);

  // a: answered here → resolved allowed.
  s.markSubmitting('a');
  assert.equal(s.promptState('a'), 'submitting');
  feed(s, [{ type: 'vr_resolved', request_id: 'a', outcome: 'allowed' }]);
  assert.equal(s.promptState('a'), 'allowed');
  assert.ok(!s.getState().pending.some((p) => p.requestId === 'a'));

  // b: claude cancelled it.
  feed(s, [{ type: 'vr_resolved', request_id: 'b', outcome: 'cancelled' }]);
  assert.equal(s.promptState('b'), 'cancelled');

  // c: interrupted while waiting (R8.2).
  feed(s, [{ type: 'vr_resolved', request_id: 'c', outcome: 'interrupted' }]);
  assert.equal(s.promptState('c'), 'interrupted');
  const notices = s.getState().messages.filter((m) => m.role === 'notice' && m.kind === 'prompt').map((m) => m.outcome);
  assert.deepEqual(notices, ['cancelled', 'interrupted'], 'allowed shows in the tool block, not as a notice');

  // d: we answered, but another desktop answered first (R5.7).
  s.markSubmitting('d');
  feed(s, [{ type: 'vr_resolved', request_id: 'd', outcome: 'denied' }]);
  s.markHandledElsewhere('d');
  assert.equal(s.promptState('d'), 'handledElsewhere');
  assert.ok(s.getState().messages.some((m) => m.role === 'notice' && m.outcome === 'handledElsewhere'));

  // chat_busy: the answer was not taken, the prompt is answerable again.
  s.applyState(state({ status: 'waiting', pending: pend('e') }));
  s.markSubmitting('e');
  s.markOpen('e');
  assert.equal(s.getState().pending[0].state, 'open');
  // Process exit closes it as exited.
  feed(s, [{ type: 'vr_resolved', request_id: 'e', outcome: 'exited' }]);
  assert.equal(s.promptState('e'), 'exited');
  assert.equal(s.getState().pending.length, 0);
});

test('reload success keeps history', () => {
  // Before the reload: a turn that is now in the JSONL.
  const s = ready();
  const turns = [];
  s.onTurn = (ev) => turns.push(ev);
  feed(s, [echo('m1', 'hello'), start('msg_1'), delta('hi'), assistant('msg_1', [text('hi there')]), stop(), result()]);
  const before = s.getState().messages.map((m) => `${m.role}:${m.parts ? textOf(m) : m.kind}`);
  // Reload: stopped, then the new epoch's reset sync replays the JSONL as history.
  s.applyState(state({ status: 'ended', ended: { reason: 'stopped' } }));
  assert.equal(s.getState().ended.reason, 'stopped');
  s.applySync(sync({ epoch: 'e2', reset: true, historyCount: 2 }));
  s.applyHistory({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } });
  s.applyHistory({ type: 'assistant', message: { id: 'msg_1', content: [text('hi there')] } });
  s.applyState(state({ status: 'idle', ended: null }));
  const after = s.getState().messages.map((m) => `${m.role}:${m.parts ? textOf(m) : m.kind}`);
  assert.deepEqual(after, before, 'same transcript as before the reload');
  assert.equal(s.getState().ended, null);
  assert.equal(s.getState().status, 'idle');
  // And the conversation continues.
  turns.length = 0;
  s.addLocalUser('m2', 'more');
  feed(s, [echo('m2', 'more'), assistant('msg_2', [text('sure')]), result()]);
  assert.deepEqual(turns.map((e) => e.kind), ['echo', 'result']);
  assert.equal(userBubbles(s.getState()).at(-1).delivery, 'sent');
  assert.equal(textOf(assistants(s.getState()).at(-1)), 'sure');
});

test('ended states', () => {
  const actions = (ended) => endedView(ended).actions.slice().sort();
  for (const reason of ['exited', 'daemon_restart', 'stopped']) {
    assert.deepEqual(actions({ reason }), ['handoff', 'restart'], reason);
  }
  assert.deepEqual(actions({ reason: 'version_unsupported', claudeVersion: '1.0.0', minClaudeVersion: '2.1.210' }), ['handoff', 'recheck']);
  const failed = endedView({ reason: 'restart_failed', message: 'No conversation found with session ID: x' });
  assert.deepEqual(failed.actions.slice().sort(), ['handoff', 'restart']);
  assert.equal(failed.detail, 'No conversation found with session ID: x');
  assert.deepEqual(actions({ reason: 'handed_off', handedOffTo: 't1' }), ['openTerminal']);
  // Every banner has a title key and passes the versions / exit code along.
  const old = endedView({ reason: 'version_unsupported', claudeVersion: '1.0.0', minClaudeVersion: '2.1.210' });
  assert.equal(old.params.version, '1.0.0');
  assert.equal(old.params.min, '2.1.210');
  const exited = endedView({ reason: 'exited', code: 1, stderrTail: 'boom' });
  assert.equal(exited.params.code, 1);
  assert.equal(exited.detail, 'boom');
  for (const reason of ['exited', 'daemon_restart', 'stopped', 'version_unsupported', 'restart_failed', 'handed_off', 'brand_new']) {
    assert.match(endedView({ reason }).titleKey, /^chat\.ended\./);
  }
});

await run();
