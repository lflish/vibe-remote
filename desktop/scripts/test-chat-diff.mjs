// chat/diff.ts: line diff for Edit / Write / MultiEdit tool blocks.
// Rewritten from 69d8c70 diff.test.ts (vitest), unchanged cases.
import { strict as assert } from 'node:assert';
import { load, runner } from './chat-test-util.mjs';

const { computeLineDiff, diffFromToolInput } = await load('src/renderer/chat/diff.ts');
const { test, run } = runner('test-chat-diff');

const like = (row, want) => {
  for (const [k, v] of Object.entries(want)) assert.equal(row[k], v, `${k} in ${JSON.stringify(row)}`);
};

test('identical text → all context rows', () => {
  const rows = computeLineDiff('a\nb', 'a\nb');
  assert.deepEqual(rows.map((r) => r.kind), ['context', 'context']);
  like(rows[0], { left: 'a', right: 'a', leftNo: 1, rightNo: 1 });
});

test('pure addition (Write: empty → content)', () => {
  const rows = computeLineDiff('', 'x\ny');
  assert.deepEqual(rows.map((r) => r.kind), ['add', 'add']);
  like(rows[0], { right: 'x', rightNo: 1 });
  like(rows[1], { right: 'y', rightNo: 2 });
});

test('one line replaced → one del, one add', () => {
  const rows = computeLineDiff('hello\nworld', 'hello\nthere');
  assert.deepEqual(rows.map((r) => r.kind), ['context', 'del', 'add']);
  like(rows.find((r) => r.kind === 'del'), { left: 'world' });
  like(rows.find((r) => r.kind === 'add'), { right: 'there' });
});

test('line numbers stay continuous on both sides', () => {
  const rows = computeLineDiff('a\nb\nc', 'a\nx\nc');
  const ctx = rows.filter((r) => r.kind === 'context');
  like(ctx[0], { leftNo: 1, rightNo: 1 });
  like(ctx[1], { leftNo: 3, rightNo: 3 });
});

test('Write → empty to content', () => {
  assert.deepEqual(diffFromToolInput('Write', { file_path: '/a', content: 'hi' }), { oldText: '', newText: 'hi' });
});

test('Edit → old_string / new_string', () => {
  assert.deepEqual(diffFromToolInput('Edit', { file_path: '/a', old_string: 'a', new_string: 'b' }), { oldText: 'a', newText: 'b' });
});

test('MultiEdit → edits joined', () => {
  const r = diffFromToolInput('MultiEdit', { file_path: '/a', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] });
  assert.deepEqual(r, { oldText: 'a\nc', newText: 'b\nd' });
});

test('non-edit tool (Bash) → null', () => {
  assert.equal(diffFromToolInput('Bash', { command: 'ls' }), null);
});

await run();
