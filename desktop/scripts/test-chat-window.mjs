// chat/window.ts: the virtual list window (d13). The full history is kept in
// ChatSession; the DOM holds only [start, end). 3000 messages → the newest 300
// first, 200 more per scroll to the top, following new messages only when the
// user is at the bottom.
import { strict as assert } from 'node:assert';
import { load, runner } from './chat-test-util.mjs';

const W = await load('src/renderer/chat/window.ts');
const { test, run } = runner('test-chat-window');

test('initial window is the newest 300', () => {
  assert.deepEqual(W.initialWindow(3000), { start: 2700, end: 3000 });
  assert.deepEqual(W.initialWindow(120), { start: 0, end: 120 });
  assert.deepEqual(W.initialWindow(0), { start: 0, end: 0 });
  assert.equal(W.INITIAL, 300);
  assert.equal(W.PAGE, 200);
});

test('expandUp adds 200 each time down to 0', () => {
  let w = W.initialWindow(3000);
  const starts = [];
  while (w.start > 0) {
    w = W.expandUp(w);
    starts.push(w.start);
    assert.equal(w.end, 3000, 'the bottom stays put');
  }
  assert.equal(starts[0], 2500);
  assert.equal(starts.at(-1), 0);
  assert.equal(starts.length, 14, '2700 / 200 rounded up');
  assert.deepEqual(W.expandUp({ start: 0, end: 10 }), { start: 0, end: 10 }, 'nothing above the first message');
  assert.deepEqual(W.expandUp({ start: 50, end: 400 }, 200), { start: 0, end: 400 });
});

test('new messages: follow at the bottom, stay put otherwise', () => {
  const w = W.initialWindow(3000);
  assert.deepEqual(W.follow(w, 3005, true), { start: 2700, end: 3005 });
  assert.deepEqual(W.follow(w, 3005, false), w, 'scrolled up: window does not move');
  // A transcript reset (shorter than the window) starts over.
  assert.deepEqual(W.follow(w, 40, true), { start: 0, end: 40 });
  assert.deepEqual(W.follow(w, 40, false), { start: 0, end: 40 });
});

await run();
