// chat/parser.ts: claude stream-json messages (and daemon vr_* messages) →
// ChatEvent. Rewritten from 69d8c70 parser.test.ts (vitest) plus the v3 cases:
// all tool_results of a user message, interrupt markers, string-content user
// messages from /compact (V20), result interrupt/error shapes, control
// requests, vr_* messages, and every line of the shared probe fixture.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { load, runner } from './chat-test-util.mjs';

const { parseChatMessage } = await load('src/renderer/chat/parser.ts');
const { test, run } = runner('test-chat-parser');
const p = (o) => parseChatMessage(o);

test('malformed input is ignored', () => {
  for (const v of [null, undefined, 42, 'x', [], {}, { type: 'nope' }, { type: 'assistant' }, { type: 'user', message: 5 }]) {
    assert.deepEqual(p(v), { kind: 'ignored' });
  }
});

test('system hook / init / status lines are ignored', () => {
  assert.deepEqual(p({ type: 'system', subtype: 'hook_started', hook_name: 'x' }), { kind: 'ignored' });
  assert.deepEqual(p({ type: 'system', subtype: 'init', slash_commands: ['a'] }), { kind: 'ignored' });
  assert.deepEqual(p({ type: 'system', subtype: 'status', permissionMode: 'default' }), { kind: 'ignored' });
  assert.deepEqual(p({ type: 'system', subtype: 'some_future_thing' }), { kind: 'ignored' });
  assert.deepEqual(p({ type: 'keep_alive' }), { kind: 'ignored' });
});

test('assistant thinking part', () => {
  assert.deepEqual(p({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'let me think', signature: 'sig' }] } }), {
    kind: 'assistant', id: 'msg_1', model: undefined, parts: [{ type: 'thinking', text: 'let me think' }],
  });
});

test('assistant tool_use part keeps id/name/input', () => {
  const ev = p({ type: 'assistant', message: { model: 'claude-x', content: [{ id: 'toolu_01ANW', input: { command: 'echo hello' }, name: 'Bash', type: 'tool_use' }] } });
  assert.equal(ev.kind, 'assistant');
  assert.equal(ev.model, 'claude-x');
  assert.deepEqual(ev.parts, [{ type: 'tool_use', id: 'toolu_01ANW', name: 'Bash', input: { command: 'echo hello' } }]);
});

test('user tool_result with string content', () => {
  assert.deepEqual(p({ type: 'user', message: { content: [{ tool_use_id: 'toolu_01ANW', type: 'tool_result', content: 'hello', is_error: false }] } }), {
    kind: 'tool_results', results: [{ toolUseId: 'toolu_01ANW', result: { content: 'hello', isError: false } }],
  });
});

test('tool_result array content is flattened', () => {
  const ev = p({ type: 'user', message: { content: [{ tool_use_id: 't1', type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'err A' }, { type: 'text', text: ' err B' }] }] } });
  assert.deepEqual(ev.results, [{ toolUseId: 't1', result: { content: 'err A err B', isError: true } }]);
});

test('every tool_result in one user message', () => {
  const ev = p({ type: 'user', message: { content: [
    { tool_use_id: 'a', type: 'tool_result', content: '1' },
    { tool_use_id: 'b', type: 'tool_result', content: '2', is_error: true },
    { tool_use_id: 'c', type: 'tool_result', content: '3' },
  ] } });
  assert.deepEqual(ev.results.map((r) => [r.toolUseId, r.result.isError]), [['a', false], ['b', true], ['c', false]]);
});

test('text_delta / thinking_delta keep the block index', () => {
  assert.deepEqual(p({ type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Hi' } } }), { kind: 'text_delta', index: 2, text: 'Hi' });
  assert.deepEqual(p({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The' } } }), { kind: 'thinking_delta', index: 0, text: 'The' });
  assert.deepEqual(p({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } } }), { kind: 'ignored' });
  assert.deepEqual(p({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } } }), { kind: 'ignored' });
});

test('message_start carries message.id and model; block start and stop', () => {
  assert.deepEqual(p({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_9', model: 'claude-opus' } } }), { kind: 'message_start', id: 'msg_9', model: 'claude-opus' });
  assert.deepEqual(p({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } }), { kind: 'block_start', index: 1, part: { type: 'text', text: '' } });
  assert.deepEqual(p({ type: 'stream_event', event: { type: 'message_stop' } }), { kind: 'message_stop' });
});

test('result success / error / interrupted', () => {
  assert.deepEqual(p({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }), { kind: 'result', stale: false, interrupted: false, duringExecution: false, isError: false, errorText: undefined });
  const fail = p({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 Overloaded' });
  assert.equal(fail.isError, true);
  assert.equal(fail.errorText, 'API Error: 529 Overloaded');
  for (const reason of ['aborted_streaming', 'aborted_tools']) {
    const ev = p({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: reason });
    assert.equal(ev.interrupted, true, reason);
    assert.equal(ev.isError, false, `${reason} is not a turn error`);
  }
  // V21: --resume of a missing transcript → errors[0].
  const missing = p({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, errors: ['No conversation found with session ID: x'] });
  assert.equal(missing.isError, true);
  assert.equal(missing.errorText, 'No conversation found with session ID: x');
  assert.equal(p({ type: 'result', subtype: 'success', vr_stale: true }).stale, true);
});

test('interrupt markers are not user text', () => {
  assert.deepEqual(p({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }), { kind: 'interrupt_marker', forToolUse: false });
  assert.deepEqual(p({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }), { kind: 'interrupt_marker', forToolUse: true });
});

test('string-content user messages', () => {
  // Samples from the V20 log (evidence/probe-stream-json.md, /compact).
  const summary = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request';
  assert.deepEqual(p({ type: 'user', message: { role: 'user', content: summary } }), { kind: 'compact_summary', text: summary });
  assert.deepEqual(p({ type: 'user', message: { role: 'user', content: 'whatever' }, isCompactSummary: true }), { kind: 'compact_summary', text: 'whatever' });
  assert.deepEqual(p({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, isReplay: true }), { kind: 'command_output', text: 'Compacted' });
  assert.deepEqual(p({ type: 'user', message: { content: '<local-command-stderr>boom</local-command-stderr>' } }), { kind: 'command_output', text: 'boom' });
  assert.deepEqual(p({ type: 'system', subtype: 'compact_boundary', compact_metadata: {} }), { kind: 'compact_boundary' });
  // A plain string prompt (terminal-mode JSONL history) is still user text.
  assert.deepEqual(p({ type: 'user', message: { content: 'fix the bug' } }), { kind: 'user_text', text: 'fix the bug' });
  assert.deepEqual(p({ type: 'user', message: { content: '<command-name>/review</command-name>\n<command-args>pr 12</command-args>' } }), { kind: 'user_text', text: '/review pr 12' });
});

test('daemon echo and vr_* messages', () => {
  assert.deepEqual(p({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi 你好 🎉' }] }, vr_client_msg_id: 'm-1' }), { kind: 'user_echo', clientMsgId: 'm-1', text: 'hi 你好 🎉' });
  assert.deepEqual(p({ type: 'vr_resolved', request_id: 'r1', outcome: 'cancelled' }), { kind: 'resolved', requestId: 'r1', outcome: 'cancelled', message: undefined });
  assert.deepEqual(p({ type: 'vr_resolved', request_id: 'r1', outcome: 'bogus' }), { kind: 'ignored' });
  assert.deepEqual(p({ type: 'vr_notice', code: 'stale_turn', text: 't', clientMsgId: 'm-2' }), { kind: 'notice', code: 'stale_turn', text: 't', clientMsgId: 'm-2' });
  assert.deepEqual(p({ type: 'vr_exit', code: 1, reason: 'exited', stderrTail: 'x' }), { kind: 'exit', code: 1, reason: 'exited', stderrTail: 'x' });
  const req = { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } };
  assert.deepEqual(p({ type: 'control_request', request_id: 'r9', request: req }), { kind: 'can_use_tool', requestId: 'r9', request: req });
  assert.deepEqual(p({ type: 'control_request', request_id: 'r9', request: { subtype: 'hook_callback' } }), { kind: 'ignored' });
  assert.deepEqual(p({ type: 'control_cancel_request', request_id: 'r9' }), { kind: 'ignored' });
  assert.deepEqual(p({ type: 'control_response', response: { subtype: 'success' } }), { kind: 'ignored' });
});

test('api_retry', () => {
  assert.deepEqual(p({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, error: 'unknown' }), { kind: 'api_retry', attempt: 2, maxRetries: 10 });
});

test('fixture lines', () => {
  // Shared with the daemon's TestFakeClaudeMatchesProbe: real claude 2.1.210 output.
  const lines = readFileSync('../vibe-remoted/internal/chat/testdata/probe-stream.jsonl', 'utf8').split('\n').filter((l) => l.trim());
  assert.ok(lines.length > 20, 'fixture should have the probe samples');
  const kinds = new Set();
  for (const line of lines) {
    const msg = JSON.parse(line);
    const ev = parseChatMessage(msg);
    kinds.add(ev.kind);
    const known = ['assistant', 'user', 'stream_event', 'result', 'system', 'control_request', 'control_response', 'control_cancel_request'];
    assert.ok(known.includes(msg.type), `unexpected fixture type ${msg.type}`);
    if (['control_response', 'control_cancel_request'].includes(msg.type)) assert.equal(ev.kind, 'ignored');
  }
  for (const k of ['assistant', 'tool_results', 'text_delta', 'result', 'can_use_tool', 'interrupt_marker', 'compact_summary', 'command_output', 'compact_boundary', 'message_start']) {
    assert.ok(kinds.has(k), `fixture produced no ${k} event`);
  }
});

await run();
