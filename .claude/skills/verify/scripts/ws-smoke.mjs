#!/usr/bin/env node
// End-to-end smoke test against a running vibe-remoted (tmux mode, /bin/bash as
// the CLI). Exercises the real wire protocol rather than unit seams:
//   auth → attach(new) → ready → PTY round-trip → hook env + hook token →
//   events → notify, then a second session to prove per-session env isolation,
//   then cleanup via REST DELETE.
//
// Usage: VR_TOKEN=<token> node ws-smoke.mjs <host:port> [workdir]
// Requires Node 22+ (global WebSocket).

const target = process.argv[2];
const workdir = process.argv[3] || '/tmp';
const token = process.env.VR_TOKEN;
if (!target || !token) {
  console.error('usage: VR_TOKEN=<token> node ws-smoke.mjs <host:port> [workdir]');
  process.exit(2);
}
const base = `http://${target}`;

let failures = 0;
const ok = (msg) => console.log(`PASS ${msg}`);
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`); };

const enc = (s) => Buffer.from(s, 'utf8').toString('base64');
const dec = (b) => Buffer.from(b, 'base64').toString('utf8');
// Strip CSI/OSC sequences so markers survive bash's line editing noise.
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms)),
  ]);
}

// Opens a WS session and returns helpers bound to it.
async function openSession() {
  const ws = new WebSocket(`ws://${target}/ws`);
  const frames = [];
  const waiters = [];
  let output = '';
  ws.onmessage = (ev) => {
    const f = JSON.parse(ev.data);
    if (f.type === 'data') output += plain(dec(f.payload));
    frames.push(f);
    for (const w of [...waiters]) w();
  };
  const waitFor = (pred, ms, what) => withTimeout(new Promise((res) => {
    const check = () => {
      const hit = pred();
      if (hit) { waiters.splice(waiters.indexOf(check), 1); res(hit); }
    };
    waiters.push(check);
    check();
  }), ms, what);

  await withTimeout(new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }), 5000, 'ws open');
  ws.send(JSON.stringify({ type: 'auth', token }));
  ws.send(JSON.stringify({ type: 'attach', sessionId: '', cols: 120, rows: 40, workdir }));
  const ready = await waitFor(() => frames.find((f) => f.type === 'ready' || f.type === 'error'), 10000, 'ready');
  if (ready.type === 'error') throw new Error(`attach error: ${ready.message}`);

  // The format string splits the marker across quotes so bash's own echo of the
  // command line can never match the regex below — only real output can.
  ws.send(JSON.stringify({
    type: 'data',
    payload: enc(`printf 'VR'_ENV:%s:%s:%s:END\\n "$VIBE_REMOTE_SESSION_ID" "$VIBE_REMOTE_TOKEN" "$VIBE_REMOTE_EVENTS_URL"\r`),
  }));
  const m = await waitFor(() => output.match(/VR_ENV:([^:\s]*):([^:\s]*):(\S*?):END/), 10000, 'env echo');
  return { ws, frames, waitFor, ready, env: { sessionId: m[1], hookToken: m[2], eventsURL: m[3] } };
}

async function main() {
  const health = await fetch(`${base}/healthz`);
  health.ok ? ok('/healthz') : fail(`/healthz ${health.status}`);

  const info = await fetch(`${base}/api/v1/info`, { headers: { Authorization: `Bearer ${token}` } });
  const infoBody = info.ok ? await info.json() : {};
  info.ok ? ok(`/api/v1/info version=${infoBody.version ?? '(missing)'}`) : fail(`/api/v1/info ${info.status}`);
  if (info.ok && !infoBody.version) fail('/api/v1/info has no version field');

  const a = await openSession();
  ok(`session A ready id=${a.ready.sessionId}`);
  a.env.sessionId === a.ready.sessionId
    ? ok('A sees its own VIBE_REMOTE_SESSION_ID')
    : fail(`A env SESSION_ID=${a.env.sessionId} != ${a.ready.sessionId}`);
  a.env.hookToken && a.env.hookToken !== token
    ? ok('A got a hook token distinct from the main token')
    : fail('A hook token missing or equal to the main token');

  // Hook token: allowed for its own session's events, nothing else.
  const post = (tok, sessionId) => fetch(`${base}/api/v1/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, kind: 'idle', message: 'smoke' }),
  });
  const ev = await post(a.env.hookToken, a.ready.sessionId);
  ev.status === 204 ? ok('hook token → events 204') : fail(`hook token → events ${ev.status}`);
  try {
    await a.waitFor(() => a.frames.find((f) => f.type === 'notify' && f.kind === 'idle'), 5000, 'notify');
    ok('notify frame delivered to session A');
  } catch (e) { fail(e.message); }
  const wrong = await post(a.env.hookToken, 'some-other-session');
  [401, 403].includes(wrong.status) ? ok('hook token rejected for another sessionId') : fail(`hook token other session → ${wrong.status}`);
  const infoHook = await fetch(`${base}/api/v1/info`, { headers: { Authorization: `Bearer ${a.env.hookToken}` } });
  infoHook.status === 401 ? ok('hook token rejected on /api/v1/info') : fail(`hook token /info → ${infoHook.status}`);

  // A second session on the same tmux server must not inherit A's env.
  const b = await openSession();
  b.env.sessionId === b.ready.sessionId
    ? ok('B sees its own VIBE_REMOTE_SESSION_ID (no env bleed from A)')
    : fail(`B env SESSION_ID=${b.env.sessionId}, expected ${b.ready.sessionId}`);

  for (const s of [a, b]) {
    s.ws.close();
    const del = await fetch(`${base}/api/v1/sessions/${s.ready.sessionId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    del.status === 204 ? ok(`deleted ${s.ready.sessionId}`) : fail(`delete ${s.ready.sessionId} → ${del.status}`);
  }
}

main()
  .catch((e) => fail(e.message))
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  });
