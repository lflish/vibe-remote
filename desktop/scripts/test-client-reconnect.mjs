// Regression: calling connect() while a previous socket is still connecting
// must not start a reconnect loop.
//
// connect() used to close the old socket without unbinding its handlers. The
// old onclose then fired with this.ws already pointing at the new socket: it
// stopped the new socket's ping timer and scheduled a reconnect, whose
// connect() closed the new socket, whose onclose scheduled another, and so on.
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

const dir = mkdtempSync(join(tmpdir(), 'vr-client-reconnect-'));
const bundle = join(dir, 'client.mjs');
await build({
  entryPoints: ['src/renderer/client.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
});

// Fake timers: record instead of run, so the test decides what fires.
let nextTimerId = 1;
const timeouts = new Map(); // id -> fn
const intervals = new Map(); // id -> fn
globalThis.setTimeout = (fn) => {
  const id = nextTimerId++;
  timeouts.set(id, fn);
  return id;
};
globalThis.clearTimeout = (id) => timeouts.delete(id);
globalThis.setInterval = (fn) => {
  const id = nextTimerId++;
  intervals.set(id, fn);
  return id;
};
globalThis.clearInterval = (id) => intervals.delete(id);

// Fake WebSocket: starts CONNECTING; the test drives open/close explicitly.
// close() only flips readyState — like a browser, the close event is delivered
// later, through whatever onclose is bound at that moment.
const sockets = [];
globalThis.WebSocket = class {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closeCalls = 0;
    sockets.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closeCalls++;
    this.readyState = 3;
  }
  fireOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  fireClose() {
    this.readyState = 3;
    this.onclose?.();
  }
};

const { VibeRemoteClient } = await import(bundle);
const client = new VibeRemoteClient({ name: 'm', addr: '127.0.0.1', port: 1, token: 't' });

client.connect();
const first = sockets[0];
// Keep the handler the first socket was given, to also exercise the
// "is this still the current socket" guard, not just the unbinding.
const staleOnClose = first.onclose;
const staleOnOpen = first.onopen;
if (typeof staleOnClose !== 'function') fail('connect() did not bind onclose');

// Second connect() while the first socket is still CONNECTING.
client.connect();
const second = sockets[1];
if (!second) fail('second connect() did not open a new socket');
if (client.ws !== second) fail('client.ws is not the new socket');
if (first.closeCalls !== 1) fail(`old socket closed ${first.closeCalls} times, want 1`);
for (const h of ['onopen', 'onclose', 'onerror', 'onmessage']) {
  if (first[h] !== null) fail(`old socket ${h} was not unbound`);
}

second.fireOpen();
if (client.state !== 'connected') fail(`state after open = ${client.state}, want connected`);
if (!second.sent.some((f) => f.type === 'auth')) fail('new socket did not send auth');
if (intervals.size !== 1) fail(`want exactly 1 ping interval after open, got ${intervals.size}`);
const pingId = [...intervals.keys()][0];

// The old socket's close event arrives late (no handler bound any more).
first.fireClose();
// And a stale handler reference invoked directly must be a no-op too.
staleOnClose();
staleOnOpen();

if (timeouts.size !== 0) fail(`stale close scheduled ${timeouts.size} reconnect(s)`);
if (client.state !== 'connected') fail(`stale close changed state to ${client.state}`);
if (!intervals.has(pingId) || intervals.size !== 1) {
  fail('stale close disturbed the new socket ping timer');
}
if (client.ws !== second) fail('stale close replaced the current socket');
if (second.closeCalls !== 0) fail('stale close closed the new socket');
for (const h of ['onopen', 'onclose', 'onerror', 'onmessage']) {
  if (typeof second[h] !== 'function') fail(`new socket ${h} was unbound`);
}
if (second.sent.filter((f) => f.type === 'auth').length !== 1) fail('stale onopen re-sent auth');

// The ping timer still pings through the new socket.
intervals.get(pingId)();
if (!second.sent.some((f) => f.type === 'ping')) fail('ping timer no longer pings the new socket');

// A real drop of the current socket still schedules exactly one reconnect.
second.fireClose();
if (timeouts.size !== 1) fail(`real close scheduled ${timeouts.size} reconnects, want 1`);
if (intervals.size !== 0) fail('real close left the ping timer running');

// A direct connect() supersedes that queued backoff instead of racing it.
client.connect();
if (timeouts.size !== 0) fail('connect() left a queued reconnect behind');

client.disconnect();
rmSync(dir, { recursive: true, force: true });
console.log('client-reconnect regression checks passed');
process.exit(0);
