// Regression: a brand-new session must survive a drop that happens after the
// attach frame is sent but before `ready` comes back.
//
// In that window the client has no sessionId yet (the server assigns it), so a
// reconnect that rebuilds the attach from currentSessionId alone sends nothing —
// leaving the app connected but attached to no session. The replayed attach also
// has to keep workdir/flags/mode, which a sessionId-only re-attach would drop.
//
// Runs client.ts through esbuild against a fake WebSocket; no test framework.
import { build } from 'esbuild';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const fail = (msg) => {
  console.error('FAIL: ' + msg);
  process.exit(1);
};

const dir = mkdtempSync(join(tmpdir(), 'vr-attach-replay-'));
const bundle = join(dir, 'client.mjs');
await build({
  entryPoints: ['src/renderer/client.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
});

const sent = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor() {
    this.readyState = 1;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(data) {
    sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
};

const attaches = () => sent.filter((f) => f.type === 'attach');
// Longer than the client's first backoff step.
const settle = () => new Promise((r) => setTimeout(r, 1600));

const { VibeRemoteClient } = await import(bundle);
const client = new VibeRemoteClient({ name: 'm', addr: '127.0.0.1', port: 1, token: 't' });
client.connect();
await new Promise((r) => setTimeout(r, 30));

// New session: empty sessionId, with a chosen workdir/flags/mode.
client.attach('', 120, 40, '/home/u/proj', ['skip-perms'], 'worktree');
if (attaches().length !== 1) fail(`expected 1 attach frame, got ${attaches().length}`);

// Drop before `ready`.
client.ws.close();
await settle();

if (attaches().length < 2) {
  fail('reconnect sent no attach after an unconfirmed one — the new session is lost');
}
const replay = attaches().at(-1);
const lost = [];
if (replay.workdir !== '/home/u/proj') lost.push(`workdir=${replay.workdir}`);
if (replay.flags?.[0] !== 'skip-perms') lost.push(`flags=${JSON.stringify(replay.flags)}`);
if (replay.mode !== 'worktree') lost.push(`mode=${replay.mode}`);
if (replay.cols !== 120 || replay.rows !== 40) lost.push(`size=${replay.cols}x${replay.rows}`);
if (lost.length) fail('replayed attach lost fields: ' + lost.join(', '));

// Once ready lands, reconnects should use the server-assigned sessionId.
client.handleMessage(
  JSON.stringify({ type: 'ready', sessionId: 'sess-1', workdir: '/home/u/proj' }),
);
const beforeSecondDrop = attaches().length;
client.ws.close();
await settle();
if (attaches().length <= beforeSecondDrop) fail('reconnect after ready sent no attach');
if (attaches().at(-1).sessionId !== 'sess-1') {
  fail('reconnect after ready must carry the assigned sessionId, got ' + JSON.stringify(attaches().at(-1)));
}

// A deliberate disconnect must not leave an attach queued for replay.
client.disconnect();
if (client.unconfirmedAttach !== null || client.pendingAttach !== null) {
  fail('disconnect() left attach state behind, so a later connect() would resurrect the session');
}

console.log('attach-replay regression checks passed');
process.exit(0);
