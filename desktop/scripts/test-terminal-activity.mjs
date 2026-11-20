// terminal-activity.ts: a background terminal session shows "new messages"
// only when what is on its screen changed (c7 of the project and worktree
// change). tmux repaints every client whenever a session option is set — the
// daemon does that when any session is created or renamed — and such a
// repaint brings bytes but the same screen.
//
// The terminal here is the real xterm (it parses without being opened), and
// the repaint is what a real tmux sent (scripts/fixtures/tmux-redraw.json).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { indexDom, load, loadIndex, runner } from './chat-test-util.mjs';

const { screenText, ScreenWatch, writeWatched } = await load('src/renderer/terminal-activity.ts');
const { Terminal } = createRequire(import.meta.url)('@xterm/xterm');
const { test, run } = runner('test-terminal-activity');
const { captures } = JSON.parse(readFileSync(new URL('./fixtures/tmux-redraw.json', import.meta.url), 'utf8'));

const bytes = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));
const enc = (s) => new TextEncoder().encode(s);
const newTerm = (cols = 80, rows = 24) => new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true });
const write = (term, data) => new Promise((r) => term.write(data, r));
/** Writes `data` in pieces of `size` bytes through writeWatched; resolves to how often it reported a change. */
async function watched(term, watch, data, size = data.length) {
  let changes = 0;
  const pieces = [];
  for (let i = 0; i < data.length; i += size) pieces.push(data.subarray(i, i + size));
  for (const p of pieces) writeWatched(term, p, watch, () => { changes++; });
  await write(term, '');
  return changes;
}

test('screenText is the text of the rows on screen, nothing else', () => {
  const line = (s) => ({ translateToString: (trim) => (trim ? s.replace(/\s+$/, '') : s) });
  const source = (lines, { rows = 3, baseY = 0, type = 'normal' } = {}) => ({ rows, buffer: { active: { type, baseY, getLine: (y) => lines[y] } } });
  const a = screenText(source([line('one  '), line(''), line('three')]));
  assert.equal(a, screenText(source([line('one'), line('   '), line('three   ')])), 'trailing blanks are not text');
  assert.notEqual(a, screenText(source([line('one'), line('x'), line('three')])));
  assert.notEqual(a, screenText(source([line('one'), line('three'), line('')])), 'the same text on another row');
  // only the rows on screen: what has scrolled off above them is not compared, but how much has is
  const scrolled = [line('gone'), line('one'), line(''), line('three')];
  assert.notEqual(screenText(source(scrolled, { baseY: 1 })), a, 'a screen that scrolled is another screen');
  assert.equal(screenText(source(scrolled, { baseY: 1 })), screenText(source([line('other'), line('one'), line(''), line('three')], { baseY: 1 })));
  assert.notEqual(screenText(source([line('one'), line(''), line('three')], { type: 'alternate' })), a, 'the other screen buffer');
  // a row xterm has no line for reads as empty
  assert.equal(screenText(source([line('one')])), screenText(source([line('one'), line(''), line('')])));
});

for (const cap of captures) {
  test(`a tmux repaint of the same screen is not a change (${cap.tmux}, ${cap.cols}×${cap.rows})`, async () => {
    const term = newTerm(cap.cols, cap.rows);
    await write(term, bytes(cap.attach));
    const before = screenText(term);
    assert.ok(before.includes('line 99 of colored text') && before.includes('prompt'), `the capture did not draw its screen:\n${before}`);
    const watch = new ScreenWatch(term);
    // whole, in the 4096-byte pieces the daemon reads, and in pieces that cut escape sequences and characters apart
    for (const size of [bytes(cap.redraw).length, 4096, 1000, 7, 1]) {
      assert.equal(await watched(term, watch, bytes(cap.redraw), size), 0, `the repaint in pieces of ${size} bytes was taken for new output`);
      assert.equal(screenText(term), before);
    }
    // ten in a row, as creating one session sends them
    for (let i = 0; i < 10; i++) assert.equal(await watched(term, watch, bytes(cap.redraw), 4096), 0);
    // and then something is printed
    assert.equal(await watched(term, watch, enc('\r\nbuild finished')), 1, 'new text on the screen was not noticed');
    assert.equal(await watched(term, watch, bytes(cap.redraw)), 1, 'a repaint that takes that text away again is a change too');
    term.dispose();
  });
}

test('what counts as a change: the text, not the cursor, not the colours', async () => {
  const term = newTerm();
  await write(term, 'user@host:~$ ');
  const watch = new ScreenWatch(term);
  const same = async (seq, why) => assert.equal(await watched(term, watch, enc(seq)), 0, why);
  const differs = async (seq, why) => assert.equal(await watched(term, watch, enc(seq)), 1, why);
  await same('\x1b[5;10H', 'the cursor moved');
  await same('\x1b[H\x1b[1;32muser@host:~$ \x1b[0m', 'the same text in another colour');
  await same('\x1b[?25l\x1b[?25h\x1b[?12l', 'cursor shown, hidden, blinking');
  await same('\x1b[Huser@host:~$ \x1b[K', 'the same line written again');
  await same('\x07', 'the bell');
  await differs('ls', 'two characters typed');
  await same('\r\n', 'a line feed on a screen that is not full moves only the cursor');
  await differs('done', 'text on the next line');
  term.dispose();
});

test('output that scrolls is a change even when every line reads the same', async () => {
  const term = newTerm(20, 4);
  await write(term, 'y\r\ny\r\ny\r\ny');
  const watch = new ScreenWatch(term);
  const before = screenText(term);
  assert.equal(await watched(term, watch, enc('\r\ny')), 1, 'a line scrolled off and the same text came in below');
  assert.notEqual(screenText(term), before);
  term.dispose();
});

test('one event per change, counted from what was last compared', async () => {
  const term = newTerm();
  const watch = new ScreenWatch(term);
  // three frames queued before xterm has parsed the first: each is compared with the screen before it
  assert.equal(await watched(term, watch, enc('abc'), 1), 3);
  assert.equal(await watched(term, watch, enc('\x1b[Habc')), 0);
  term.dispose();
});

test('a screen that is being looked at is not remembered', async () => {
  const term = newTerm();
  await write(term, 'first');
  const watch = new ScreenWatch(term);
  // forgotten between the write and its callback (the user opened the session): no event
  let changes = 0;
  writeWatched(term, enc(' second'), watch, () => { changes++; });
  watch.forget();
  await write(term, '');
  assert.equal(changes, 0);
  // the next time it is in the background, the screen as it is then is the starting point
  assert.equal(await watched(term, watch, enc('\x1b[Hfirst second')), 0);
  assert.equal(await watched(term, watch, enc(' third')), 1);
  term.dispose();
});

test('the bytes reach xterm unchanged and in order, whatever the comparison says', async () => {
  const written = [];
  const fake = { rows: 1, buffer: { active: { type: 'normal', baseY: 0, getLine: () => ({ translateToString: () => 'same' }) } }, write(data, cb) { written.push(data); cb?.(); } };
  const watch = new ScreenWatch(fake);
  const a = new Uint8Array([0xe4, 0xb8]);
  const b = new Uint8Array([0xad, 0x1b, 0x5b]);
  let changes = 0;
  writeWatched(fake, a, watch, () => { changes++; });
  writeWatched(fake, b, watch, () => { changes++; });
  assert.equal(written.length, 2);
  assert.equal(written[0], a, 'the very array that came in');
  assert.equal(written[1], b);
  assert.equal(changes, 0);
});

// --- index.ts: the dot of a background terminal session ---------------------------

async function appWithTwoTerminals() {
  const page = await indexDom();
  globalThis.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
  const app = await loadIndex({ realXterm: true });
  const machine = { name: 'dev', addr: '127.0.0.1', port: 1234, token: 't' };
  const mk = '127.0.0.1:1234';
  app.setMachines([machine]);
  app.machineOnline.set(mk, true);
  app.machineSessions.set(mk, [
    { id: 'a', title: 'a', workdir: '/w/a', created: '2026-11-20T00:00:01Z', mode: 'normal' },
    { id: 'b', title: 'b', workdir: '/w/b', created: '2026-11-20T00:00:02Z', mode: 'normal' },
  ]);
  const a = app.openSession(machine, 'a');
  const b = app.openSession(machine, 'b'); // b is the one shown
  const feed = async (view, data) => { view.client.onData(Buffer.from(data).toString('base64')); await write(view.terminal, ''); await Promise.resolve(); };
  const dot = (id) => [...document.querySelectorAll('.session-item')].find((r) => r.dataset.sessionId === id)?.dataset.dot;
  return { page, app, a, b, feed, dot, mk };
}

test('index: a repaint does not light the dot of a background terminal session, new text does', async () => {
  const cap = captures[0];
  const { page, app, a, b, feed, dot } = await appWithTwoTerminals();
  a.terminal.resize(cap.cols, cap.rows);
  assert.equal(app.activeKey, b.key);
  await feed(a, bytes(cap.attach));
  // what came in while it was being attached does not count (as before); from here on the screen is compared
  a.activity = 'none';
  a.suppressUntil = 0;
  app.renderSidebar();
  for (let i = 0; i < 10; i++) await feed(a, bytes(cap.redraw));
  assert.equal(a.activity, 'none', 'ten repaints of the same screen lit the dot');
  assert.equal(dot('a'), 'none');
  await feed(a, enc('\r\ntests passed'));
  assert.equal(a.activity, 'output', 'a new line did not light the dot');
  assert.equal(dot('a'), 'output', 'sidebar');
  // looked at, then left: the dot is gone, and the screen as it was left is what the next bytes are compared with
  app.setActive(a.key);
  assert.equal(a.activity, 'none');
  await feed(a, enc('\r\nprinted while it was being looked at'));
  assert.equal(a.activity, 'none');
  app.setActive(b.key);
  await feed(a, enc('\x1b[3;7H\x1b[?25l\x1b[?25h'));
  assert.equal(a.activity, 'none', 'a cursor that moved lit the dot');
  await feed(a, enc('!'));
  assert.equal(a.activity, 'output');
  page.dom.window.close();
});

test('index: the session shown gets no dot; hook events are not affected', async () => {
  const { page, app, a, b, feed } = await appWithTwoTerminals();
  await feed(b, enc('typing along'));
  assert.equal(b.activity, 'none', 'the session on screen');
  a.suppressUntil = 0;
  // "turn finished" from a hook, with no change on the screen at all
  a.client.onNotify('idle', '');
  assert.equal(a.activity, 'idle');
  await feed(a, enc('more output'));
  assert.equal(a.activity, 'idle', 'output does not take a hook state back to "new messages"');
  a.client.onNotify('waiting', 'needs you');
  assert.equal(a.activity, 'waiting');
  // during the repaint that follows an attach nothing is compared
  app.setActive(a.key);
  app.setActive(b.key);
  a.suppressUntil = Date.now() + 60_000;
  await feed(a, enc('\x1b[2J\x1b[Hrepainted after attach'));
  assert.equal(a.activity, 'none');
  page.dom.window.close();
});

test('index: after a re-attach reset the screen, the comparison starts over', async () => {
  const { page, a, feed } = await appWithTwoTerminals();
  globalThis.fetch = async () => { throw new Error('offline'); };
  a.suppressUntil = 0;
  // enough lines to scroll, so the reset below changes how far the buffer has scrolled
  await feed(a, enc(Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\r\n')));
  assert.equal(a.activity, 'output');
  a.activity = 'none';
  await feed(a, enc('\x1b[H\x1b[24;1H')); // the screen as it is now is remembered
  assert.equal(a.activity, 'none');
  // the connection came back: the terminal is cleared for tmux's full repaint
  a.client.onReady('a', '/w/a', 4, {});
  assert.ok(a.suppressUntil > Date.now(), 'the repaint after an attach is not compared');
  a.suppressUntil = 0; // …and that time is over
  await feed(a, enc('\x1b[H'));
  assert.equal(a.activity, 'none', 'the cleared screen was compared with the one from before the re-attach');
  await feed(a, enc('fresh output'));
  assert.equal(a.activity, 'output');
  page.dom.window.close();
});

await run();
