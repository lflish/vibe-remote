// Regression: the client must stop reconnecting when the daemon says retrying
// cannot help, and must notice a connection that died without a close.
//
// Before: an error frame was only printed, so attaching to a session that no
// longer existed (tmux killed, deleted from another client) replayed the attach
// every backoff step forever. And with no liveness check, a half-open socket
// (lid closed, network switched) never fired onclose, so the UI kept showing
// "connected" for a connection that delivered nothing.
//
// Runs client.ts through esbuild against a fake WebSocket and fake timers; no
// test framework.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const fail = (msg) => {
  console.error('FAIL: ' + msg);
  process.exit(1);
};

const dir = mkdtempSync(join(tmpdir(), 'vr-client-liveness-'));
const bundle = join(dir, 'client.mjs');
await build({
  entryPoints: ['src/renderer/client.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
});

// Fake clock + timers: the test decides when time passes and what fires.
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

const { VibeRemoteClient } = await import(bundle);
const newClient = () => new VibeRemoteClient({ name: 'm', addr: '127.0.0.1', port: 1, token: 't' });

// --- fatal error: stop, don't loop ---
{
  const client = newClient();
  const errors = [];
  client.onError = (msg, fatal, code) => errors.push({ msg, fatal, code });
  client.connect();
  const ws = sockets.at(-1);
  ws.fireOpen();
  client.attach('gone-session', 80, 24);
  ws.fireMessage({ type: 'error', message: 'attach session: not found', code: 'session_not_found', fatal: true });
  ws.fireClose(); // the daemon closes right after a fatal error

  if (errors.length !== 1 || !errors[0].fatal || errors[0].code !== 'session_not_found') {
    fail('onError did not report the fatal error with its code: ' + JSON.stringify(errors));
  }
  if (timeouts.size !== 0) fail(`fatal error still scheduled ${timeouts.size} reconnect(s)`);
  if (client.state !== 'disconnected') fail(`state after fatal error = ${client.state}, want disconnected`);
  if (client.currentSessionId !== null || client.unconfirmedAttach !== null || client.pendingAttach !== null) {
    fail('fatal error left attach state that a later connect() would replay');
  }

  // A manual reconnect afterwards starts clean: no stale attach replayed.
  client.reconnectNow();
  const fresh = sockets.at(-1);
  fresh.fireOpen();
  if (fresh.sent.some((f) => f.type === 'attach')) fail('reconnect after a fatal error replayed the dead attach');
  client.disconnect();
}

// --- non-fatal error: keep retrying ---
{
  timeouts.clear();
  const client = newClient();
  client.connect();
  const ws = sockets.at(-1);
  ws.fireOpen();
  client.attach('busy-session', 80, 24);
  ws.fireMessage({ type: 'error', message: 'attach session: pty attach: busy', code: 'attach_failed' });
  ws.fireClose();
  if (timeouts.size !== 1) fail(`transient error scheduled ${timeouts.size} reconnects, want 1`);
  if (client.state !== 'reconnecting') fail(`state after transient error = ${client.state}, want reconnecting`);
  client.disconnect();
}

// --- pre-v2 daemons send no fatal flag: old behavior (retry) is kept ---
{
  timeouts.clear();
  const client = newClient();
  client.connect();
  const ws = sockets.at(-1);
  ws.fireOpen();
  client.attach('s', 80, 24);
  ws.fireMessage({ type: 'error', message: 'attach session: session "s" not found' });
  ws.fireClose();
  if (timeouts.size !== 1) fail('an error frame without `fatal` must not stop reconnecting');
  client.disconnect();
}

// --- liveness watchdog ---
{
  timeouts.clear();
  intervals.clear();
  const client = newClient();
  client.connect();
  const ws = sockets.at(-1);
  ws.fireOpen();
  client.attach('s', 80, 24);
  ws.fireMessage({ type: 'ready', sessionId: 's', workdir: '/w', proto: 2 });

  // Healthy but idle: a pong per ping keeps it alive indefinitely.
  for (let i = 0; i < 10; i++) {
    now += 25_000;
    tickPing();
    ws.fireMessage({ type: 'pong' });
  }
  if (client.state !== 'connected') fail(`idle-but-answering connection was dropped (state ${client.state})`);
  if (ws.closeCalls !== 0) fail('watchdog closed a socket that kept answering pings');

  // Half-open: pings go out, nothing comes back, onclose never fires.
  now += 25_000; tickPing(); // ping sent, no reply yet: not a miss
  if (client.state !== 'connected') fail('watchdog fired on the first unanswered ping');
  now += 25_000; tickPing(); // previous ping unanswered: one miss
  if (client.state !== 'connected') fail('watchdog fired after a single missed pong');
  now += 25_000; tickPing(); // second miss in a row: dead
  if (client.state !== 'reconnecting') fail(`silent connection not detected (state ${client.state})`);
  if (ws.closeCalls !== 1) fail('watchdog did not close the dead socket');
  if (timeouts.size !== 1) fail(`watchdog scheduled ${timeouts.size} reconnects, want 1`);
  if (intervals.size !== 0) fail('watchdog left the ping timer running');

  // The reconnect re-attaches the same session.
  [...timeouts.values()][0]();
  const next = sockets.at(-1);
  next.fireOpen();
  const reattach = next.sent.find((f) => f.type === 'attach');
  if (reattach?.sessionId !== 's') fail('reconnect after watchdog did not re-attach the session: ' + JSON.stringify(reattach));
  client.disconnect();
}

// --- hidden window: throttled timers must not kill a healthy connection ---
// Chromium runs timers in a hidden/minimized window about once a minute, so
// the 25s ping fires every ~60s and the pong arrives just as late. A silence
// timeout measured in wall-clock time would see 60s of nothing and tear every
// background session down, over and over. Counting unanswered pings doesn't.
{
  timeouts.clear();
  intervals.clear();
  const client = newClient();
  client.connect();
  const ws = sockets.at(-1);
  ws.fireOpen();
  client.attach('bg', 80, 24);
  ws.fireMessage({ type: 'ready', sessionId: 'bg', workdir: '/w', proto: 2 });
  for (let i = 0; i < 10; i++) {
    now += 61_000; // throttled tick
    tickPing();
    if (client.state !== 'connected') fail(`throttled-but-healthy connection dropped on tick ${i} (state ${client.state})`);
    now += 300; // the pong lands shortly after the late ping
    ws.fireMessage({ type: 'pong' });
  }
  if (ws.closeCalls !== 0) fail('watchdog closed a healthy socket in a throttled window');
  client.disconnect();
}

rmSync(dir, { recursive: true, force: true });
console.log('client-liveness regression checks passed');
process.exit(0);
