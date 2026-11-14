// chat/queue.ts: the send queue (design 6.8, R9) and slash classification
// (R10.2). Pure logic, driven directly.
import { strict as assert } from 'node:assert';
import { load, runner } from './chat-test-util.mjs';

const { SendQueue, classifySlash } = await load('src/renderer/chat/queue.ts');
const { test, run } = runner('test-chat-queue');

function makeQueue({ connected = true } = {}) {
  const sent = [];
  let n = 0;
  const conn = { up: connected };
  const q = new SendQueue((item) => {
    if (!conn.up) return false;
    sent.push(item);
    return true;
  }, () => `own-${++n}`);
  return { q, sent, conn };
}

test('empty not sent', () => {
  const { q, sent } = makeQueue();
  assert.equal(q.enqueue(''), null);
  assert.equal(q.enqueue('   \n\t'), null);
  assert.equal(q.queued().length, 0);
  assert.equal(sent.length, 0);
});

test('idle: first message goes straight out', () => {
  const { q, sent } = makeQueue();
  q.setStatus('idle');
  q.enqueue('hi');
  assert.deepEqual(sent.map((s) => s.text), ['hi']);
  assert.equal(q.queued().length, 0);
});

test('busy: two queued messages go in order, one per result', () => {
  const { q, sent } = makeQueue();
  q.setStatus('idle');
  const a = q.enqueue('first');
  q.onEcho(a.id);
  q.setStatus('running');
  q.enqueue('second');
  q.enqueue('third');
  assert.deepEqual(sent.map((s) => s.text), ['first']);
  assert.deepEqual(q.queued().map((s) => s.text), ['second', 'third'], 'shown as queued');
  q.onResult();
  assert.deepEqual(sent.map((s) => s.text), ['first', 'second'], 'one at a time');
  // second is not echoed yet: third waits even after more results.
  q.onResult();
  assert.equal(sent.length, 2);
  q.onEcho(sent[1].id);
  q.onResult();
  assert.deepEqual(sent.map((s) => s.text), ['first', 'second', 'third']);
});

test('remove: withdrawn message is never sent', () => {
  const { q, sent } = makeQueue();
  q.setStatus('running');
  const a = q.enqueue('a');
  q.enqueue('b');
  assert.equal(q.remove(a.id), true);
  assert.equal(q.remove('nope'), false);
  q.setStatus('idle');
  assert.deepEqual(sent.map((s) => s.text), ['b']);
});

test('interrupt takes the queue back into the input box', () => {
  const { q, sent } = makeQueue();
  q.setStatus('idle');
  q.enqueue('running one');
  q.enqueue('queued 1');
  q.enqueue('queued 2');
  assert.equal(q.takeBackAll(), 'queued 1\n\nqueued 2');
  assert.equal(q.queued().length, 0);
  q.onEcho(sent[0].id);
  q.onResult();
  assert.equal(sent.length, 1, 'nothing is sent automatically after an interrupt');
});

test('own-result gating', () => {
  // Another desktop's echoes and results interleave with ours. We send the
  // next message only once ours is echoed and paired (FIFO) with a result;
  // the global status staying "running" does not matter.
  const { q, sent } = makeQueue();
  q.setStatus('idle');
  const mine = q.enqueue('mine');
  q.setStatus('running');
  q.enqueue('next');
  q.onEcho('other-1'); // the other desktop's message was written first
  q.onEcho(mine.id);
  q.onResult(); // pairs with other-1
  assert.equal(sent.length, 1, 'a result for the other desktop does not release ours');
  q.onEcho('other-2');
  q.onResult(); // pairs with mine
  assert.deepEqual(sent.map((s) => s.text), ['mine', 'next'], 'released by our own result while status is still running');
  // stale_turn counts as paired.
  q.onEcho(sent[1].id);
  q.enqueue('after stale');
  q.onStaleTurn('other-2');
  assert.equal(sent.length, 2);
  q.onStaleTurn(sent[1].id);
  assert.deepEqual(sent.map((s) => s.text), ['mine', 'next', 'after stale']);
});

test('stale result not paired', () => {
  const { q, sent } = makeQueue();
  q.setStatus('idle');
  const a = q.enqueue('a');
  q.setStatus('running');
  q.enqueue('b');
  q.onEcho(a.id);
  q.onResult(true); // vr_stale: belongs to a turn already written off
  assert.equal(sent.length, 1, 'a stale result releases nothing');
  q.onResult(false);
  assert.equal(sent.length, 2);
});

test('first send while busy queues', () => {
  const { q, sent } = makeQueue();
  q.setStatus('running'); // another desktop's turn
  q.enqueue('hello');
  assert.equal(sent.length, 0);
  assert.equal(q.queued().length, 1);
  q.setStatus('waiting');
  assert.equal(sent.length, 0);
  q.setStatus('idle');
  assert.deepEqual(sent.map((s) => s.text), ['hello']);
});

test('idle status releases an echoed message whose result was missed', () => {
  const { q, sent } = makeQueue();
  q.setStatus('idle');
  const a = q.enqueue('a');
  q.enqueue('b');
  q.resetPairing(); // reset sync: our result was evicted from the buffer
  q.onEcho(a.id);
  q.setStatus('idle');
  assert.equal(sent.length, 2);
});

test('undelivered message stops blocking', () => {
  const { q, sent } = makeQueue();
  q.setStatus('idle');
  const a = q.enqueue('lost');
  q.enqueue('next');
  q.onUndelivered(a.id);
  assert.deepEqual(sent.map((s) => s.text), ['lost', 'next']);
  // Re-send under the same id.
  const again = q.enqueue('lost', a.id);
  assert.equal(again.id, a.id);
});

test('socket down keeps the item queued', () => {
  const { q, sent, conn } = makeQueue({ connected: false });
  q.setStatus('idle');
  q.enqueue('x');
  assert.equal(sent.length, 0);
  assert.equal(q.queued().length, 1);
  conn.up = true;
  q.pump();
  assert.equal(sent.length, 1);
});

test('terminal-only command', () => {
  const cmds = [{ name: 'compact' }, { name: 'review' }];
  assert.equal(classifySlash('/login', cmds), 'terminalOnly');
  assert.equal(classifySlash('/theme dark', cmds), 'terminalOnly');
  assert.equal(classifySlash('  /logout', cmds), 'terminalOnly');
  assert.equal(classifySlash('/compact', cmds), 'send');
  assert.equal(classifySlash('/fake-skill', cmds), 'send', 'unknown but not terminal-only: let claude decide');
  assert.equal(classifySlash('please /login later', cmds), 'send');
  // If the session itself offers it, it is sent.
  assert.equal(classifySlash('/config', [{ name: 'config' }]), 'send');
});

await run();
