#!/usr/bin/env node
// End-to-end smoke test of chat sessions over the real wire protocol. Builds
// vibe-remoted and the fake claude (vibe-remoted/internal/chat/fakeclaude),
// starts a throwaway daemon whose claude_cmd is the fake, and drives it like a
// desktop would:
//
//   create → echo reply; create replayed before `ready` → one session; two
//   clients on one session; a pending permission prompt survives a reconnect;
//   incremental resync of 50 messages; handoff to a terminal session running
//   `claude --resume`; daemon restart → ended/daemon_restart, then reload;
//   REST state without hooks; delete keeps the JSONL transcript.
//
// Everything is isolated: its own port, token, state_dir, CLAUDE_CONFIG_DIR
// (with a workspace-trust file for its temp folders) and tmux server
// (TMUX_TMPDIR), so neither the developer's ~/.claude nor a running
// vibe-remoted is touched.
//
// Usage (from the repo root):  node .claude/skills/verify/scripts/ws-chat-smoke.mjs
// Requires Node 22+ (global WebSocket), Go and tmux.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const pass = (name, detail = '') => console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
const fail = (name, detail = '') => { failures++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); };

// --- Throwaway environment ------------------------------------------------------

// Short base path: the tmux socket lives under TMUX_TMPDIR and macOS limits
// socket paths to ~104 bytes.
const work = realpathSync(mkdtempSync('/tmp/vr-chat-'));
const binDir = join(work, 'bin');
const daemonBin = join(binDir, 'vibe-remoted');
const claudeBin = join(binDir, 'claude');
const projects = join(work, 'proj');
const stateDir = join(work, 'state');
const configDir = join(work, 'claude-config');
const pidDir = join(work, 'pids');
const tmuxDir = join(work, 'tmux');
const cfgPath = join(work, 'daemon.json');
const port = 20000 + Math.floor(Math.random() * 10000);
const token = randomBytes(32).toString('hex');
const base = `http://127.0.0.1:${port}`;
let daemon = null;

// The daemon (and so every claude it starts, and its tmux server) gets a clean
// environment: no nested-claude guard from the shell running this script, no
// real claude config, and the fake claude's pid directory for the
// one-process-per-conversation check.
function daemonEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_CODE_ENTRYPOINT' || k === 'CLAUDE_CONFIG_DIR' || k === 'TMUX' || k === 'TMUX_PANE' || k.startsWith('FAKE_CLAUDE_')) continue;
    env[k] = v;
  }
  return { ...env, CLAUDE_CONFIG_DIR: configDir, TMUX_TMPDIR: tmuxDir, FAKE_CLAUDE_PIDDIR: pidDir };
}

function trust(dirs) {
  const projectsMap = {};
  for (const d of dirs) projectsMap[d] = { hasTrustDialogAccepted: true };
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ projects: projectsMap }, null, 2), { mode: 0o600 });
}

async function startDaemon() {
  daemon = spawn(daemonBin, ['--config', cfgPath], { env: daemonEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.log = '';
  daemon.stdout.on('data', (d) => { daemon && (daemon.log += d); });
  daemon.stderr.on('data', (d) => { daemon && (daemon.log += d); });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`daemon did not come up:\n${daemon?.log ?? ''}`);
}

async function stopDaemon() {
  if (!daemon) return;
  const d = daemon;
  daemon = null;
  d.kill('SIGTERM');
  await new Promise((r) => { d.once('exit', r); setTimeout(r, 10000); });
}

const rest = (method, path) => fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
async function listSessions() {
  const res = await rest('GET', '/api/v1/sessions');
  return (await res.json()).list ?? [];
}

const newId = () => `${Date.now()}-${randomBytes(4).toString('hex')}`;
const livePids = (u) => (existsSync(pidDir) ? readdirSync(pidDir).filter((f) => f.startsWith(`${u}.`)) : []);
const violation = () => existsSync(join(pidDir, 'VIOLATION'));
function transcript(u) {
  const root = join(configDir, 'projects');
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const p = join(root, d, `${u}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

async function until(fn, ms, what, interval = 100) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(interval);
  }
  throw new Error(`timeout (${ms}ms): ${what}`);
}

// --- WebSocket client ---------------------------------------------------------------

class Conn {
  static async open() {
    const c = new Conn();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    c.frames = [];
    c.waiters = new Set();
    c.closed = false;
    c.ws.onmessage = (ev) => {
      c.frames.push(JSON.parse(ev.data));
      for (const w of [...c.waiters]) w();
    };
    c.ws.onclose = () => { c.closed = true; for (const w of [...c.waiters]) w(); };
    await new Promise((res, rej) => { c.ws.onopen = res; c.ws.onerror = () => rej(new Error('ws open failed')); });
    c.send({ type: 'auth', token });
    return c;
  }

  send(frame) { this.ws.send(JSON.stringify(frame)); }
  close() { try { this.ws.close(); } catch { /* closed */ } }
  mark() { return this.frames.length; }

  /** Resolves with pred(frames since `from`) once truthy. */
  wait(pred, ms, what, from = 0) {
    return new Promise((res, rej) => {
      const check = () => {
        let v;
        try { v = pred(this.frames.slice(from)); } catch (e) { done(); rej(e); return; }
        if (v) { done(); res(v); }
      };
      const timer = setTimeout(() => { done(); rej(new Error(`timeout (${ms}ms): ${what}`)); }, ms);
      const done = () => { clearTimeout(timer); this.waiters.delete(check); };
      this.waiters.add(check);
      check();
    });
  }

  /** Attach and wait for ready + the sync it opens (chat) — returns {ready, sync, state, frames}. */
  async attach(frame, ms = 15000) {
    const from = this.mark();
    this.send({ type: 'attach', cols: 100, rows: 30, ...frame });
    const ready = await this.wait((fs) => fs.find((f) => f.type === 'ready' || f.type === 'error'), ms, 'ready', from);
    if (ready.type === 'error') throw new Error(`attach error ${ready.code}: ${ready.message}`);
    if (ready.ui !== 'chat') return { ready };
    return { ready, ...(await this.syncFrom(from)) };
  }

  /** The first complete sync (chat_sync … closing chat_state) at or after `from`. */
  async syncFrom(from, ms = 15000) {
    return this.wait((fs) => {
      const i = fs.findIndex((f) => f.type === 'chat_sync');
      if (i < 0) return null;
      const j = fs.findIndex((f, k) => k > i && f.type === 'chat_state');
      if (j < 0) return null;
      return { sync: fs[i], state: fs[j], frames: fs.slice(i + 1, j), end: from + j + 1 };
    }, ms, 'chat sync', from);
  }

  chat(text, clientMsgId = `m-${randomBytes(4).toString('hex')}`) {
    this.send({ type: 'chat_send', clientMsgId, text });
    return clientMsgId;
  }

  /** Waits for the result that ends the turn of `clientMsgId` (echo, then a result). */
  async turn(clientMsgId, ms = 15000) {
    return this.wait((fs) => {
      const i = fs.findIndex((f) => f.type === 'chat' && f.msg?.vr_client_msg_id === clientMsgId);
      if (i < 0) return null;
      const j = fs.findIndex((f, k) => k > i && f.type === 'chat' && f.msg?.type === 'result');
      return j < 0 ? null : fs.slice(i, j + 1);
    }, ms, `turn ${clientMsgId}`);
  }
}

const assistantText = (frames) => frames
  .filter((f) => f.type === 'chat' && f.msg?.type === 'assistant')
  .flatMap((f) => f.msg.message?.content ?? [])
  .filter((b) => b.type === 'text')
  .map((b) => b.text)
  .join('');

async function newChat(dir) {
  const c = await Conn.open();
  const id = newId();
  const r = await c.attach({ newSessionId: id, workdir: dir, ui: 'chat' });
  return { c, id, ...r };
}

// --- Cases --------------------------------------------------------------------------

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const dir = (name) => join(projects, name);

test('chat: create', async () => {
  const { c, id, ready, sync, state } = await newChat(dir('create'));
  if (ready.sessionId !== id || ready.ui !== 'chat' || !ready.claudeSessionId) throw new Error(`ready ${JSON.stringify(ready)}`);
  if (!sync.reset || state.status !== 'idle') throw new Error(`sync ${JSON.stringify(sync)} state ${state.status}`);
  const turn = await c.turn(c.chat('echo hello smoke'));
  if (!assistantText(turn).includes('hello smoke')) throw new Error(`reply ${JSON.stringify(assistantText(turn))}`);
  c.close();
  return `id=${id}`;
});

test('chat: replay before ready', async () => {
  const d = dir('replay');
  const id = newId();
  const first = await Conn.open();
  first.send({ type: 'attach', newSessionId: id, cols: 100, rows: 30, workdir: d, ui: 'chat' });
  first.close(); // dropped before ready
  const second = await Conn.open();
  const { ready } = await second.attach({ newSessionId: id, workdir: d, ui: 'chat' });
  if (ready.sessionId !== id) throw new Error(`replay got ${ready.sessionId}, want ${id}`);
  const mine = (await listSessions()).filter((s) => s.workdir === d);
  if (mine.length !== 1) throw new Error(`${mine.length} sessions for the folder`);
  const pids = livePids(ready.claudeSessionId);
  if (pids.length !== 1 || violation()) throw new Error(`pids ${pids.length}, violation ${violation()}`);
  second.close();
  return 'one session, one process';
});

test('chat: two clients', async () => {
  const { c: a, id, ready } = await newChat(dir('two'));
  const b = await Conn.open();
  const { end } = await b.attach({ sessionId: id, ui: 'chat' });
  const fromA = a.mark();
  const ida = a.chat('echo from-a');
  await a.turn(ida);
  const idb = b.chat('echo from-b');
  await b.turn(idb);
  const order = (conn, from) => conn.frames.slice(from)
    .filter((f) => f.type === 'chat' && (f.msg?.vr_client_msg_id === ida || f.msg?.vr_client_msg_id === idb))
    .map((f) => f.msg.vr_client_msg_id);
  await a.wait((fs) => fs.some((f) => f.msg?.vr_client_msg_id === idb), 5000, 'a sees b', fromA);
  const oa = order(a, fromA).join(',');
  const ob = order(b, end).join(',');
  if (oa !== `${ida},${idb}` || ob !== oa) throw new Error(`a saw ${oa}, b saw ${ob}`);
  const pids = livePids(ready.claudeSessionId);
  if (pids.length !== 1 || violation()) throw new Error(`pids ${pids.length}, violation ${violation()}`);
  a.close();
  b.close();
  return 'both saw both, same order, one process';
});

test('chat: pending survives reconnect', async () => {
  const { c, id } = await newChat(dir('pending'));
  c.chat('perm touch smoke.txt');
  const pending = await c.wait((fs) => fs.filter((f) => f.type === 'chat_state').at(-1)?.pending?.[0], 15000, 'pending prompt');
  c.close();
  await sleep(200);
  const c2 = await Conn.open();
  const { state } = await c2.attach({ sessionId: id, ui: 'chat' });
  if (!state.pending?.some((p) => p.requestId === pending.requestId)) throw new Error(`pending after reconnect ${JSON.stringify(state.pending)}`);
  const from = c2.mark();
  c2.send({ type: 'chat_respond', requestId: pending.requestId, response: { behavior: 'allow' } });
  await c2.wait((fs) => fs.some((f) => f.type === 'chat' && f.msg?.type === 'vr_resolved' && f.msg.request_id === pending.requestId && f.msg.outcome === 'allowed'), 10000, 'resolved', from);
  await c2.wait((fs) => fs.some((f) => f.type === 'chat' && f.msg?.type === 'result'), 10000, 'turn continues', from);
  c2.close();
  return `request ${pending.requestId} answered after reconnect`;
});

test('chat: resync 50', async () => {
  const { c: a, id, sync } = await newChat(dir('resync'));
  await a.turn(a.chat('echo before'));
  await a.wait((fs) => fs.filter((f) => f.type === 'chat_state').at(-1)?.status === 'idle', 5000, 'idle');
  const last = Math.max(...a.frames.filter((f) => f.type === 'chat' && !f.h).map((f) => f.seq));
  a.close();
  const b = await Conn.open();
  await b.attach({ sessionId: id, ui: 'chat' });
  await b.turn(b.chat('burst 50'));
  b.close();
  const c = await Conn.open();
  const r = await c.attach({ sessionId: id, ui: 'chat', epoch: sync.epoch, since: last });
  if (r.sync.reset || r.sync.historyCount !== 0) throw new Error(`sync ${JSON.stringify(r.sync)}`);
  const got = r.frames.filter((f) => f.type === 'chat');
  if (got.length !== r.sync.backlog || got[0]?.seq !== last + 1) throw new Error(`${got.length} frames (backlog ${r.sync.backlog}), first seq ${got[0]?.seq}, want ${last + 1}`);
  for (let i = 1; i < got.length; i++) if (got[i].seq !== got[i - 1].seq + 1) throw new Error(`seq gap at ${got[i].seq}`);
  const n = got.filter((f) => f.msg?.type === 'assistant').length;
  if (n !== 50) throw new Error(`${n} burst messages resent, want 50`);
  c.close();
  return `backlog ${r.sync.backlog}, seq ${last + 1}..${got.at(-1).seq}`;
});

test('chat: handoff', async () => {
  const { c, id, ready } = await newChat(dir('handoff'));
  await c.turn(c.chat('echo seed'));
  const u = ready.claudeSessionId;
  const t = await Conn.open();
  const { ready: tr } = await t.attach({ newSessionId: newId(), handoffFrom: id });
  if (tr.ui || tr.handoffFrom !== id) throw new Error(`terminal ready ${JSON.stringify(tr)}`);
  const want = `fake-claude interactive resume=${u}`;
  await t.wait((fs) => fs.filter((f) => f.type === 'data').map((f) => Buffer.from(f.payload, 'base64').toString('utf8')).join('').includes(want), 15000, 'resume banner in the PTY');
  const ended = await c.wait((fs) => fs.filter((f) => f.type === 'chat_state').at(-1)?.ended, 10000, 'chat ended');
  if (ended.reason !== 'handed_off' || ended.handedOffTo !== tr.sessionId) throw new Error(`ended ${JSON.stringify(ended)}`);
  if (livePids(u).length !== 1 || violation()) throw new Error(`pids ${livePids(u).length}, violation ${violation()}`);
  c.close();
  t.close();
  return `terminal ${tr.sessionId} runs --resume ${u}`;
});

test('chat: daemon restart → ended', async () => {
  const { c, id } = await newChat(dir('restart'));
  await c.turn(c.chat('echo remember-me'));
  c.close();
  await stopDaemon();
  await startDaemon();
  const c2 = await Conn.open();
  const r = await c2.attach({ sessionId: id, ui: 'chat' });
  if (r.state.ended?.reason !== 'daemon_restart') throw new Error(`ended ${JSON.stringify(r.state.ended)}`);
  const history = r.frames.filter((f) => f.type === 'chat' && f.h);
  if (history.length !== r.sync.historyCount || history.length < 2 || !assistantText(history).includes('remember-me')) {
    throw new Error(`history ${history.length} (sync says ${r.sync.historyCount}): ${assistantText(history)}`);
  }
  const from = c2.mark();
  const res = await rest('POST', `/api/v1/sessions/${id}/reload`);
  if (res.status !== 202) throw new Error(`reload ${res.status}`);
  const again = await c2.syncFrom(from);
  if (again.sync.epoch === r.sync.epoch || again.state.ended || again.state.status !== 'idle') {
    throw new Error(`after reload: ${JSON.stringify(again.sync)} ${JSON.stringify(again.state.ended)} ${again.state.status}`);
  }
  const turn = await c2.turn(c2.chat('echo after-restart'));
  if (!assistantText(turn).includes('after-restart')) throw new Error('no reply after reload');
  c2.close();
  return `history ${history.length}, reloaded and replying`;
});

test('chat: state without hooks', async () => {
  const { c, id } = await newChat(dir('state'));
  const seen = [];
  const state = async () => {
    const s = (await listSessions()).find((x) => x.id === id);
    if (s && seen.at(-1) !== s.state) seen.push(s.state);
    return s;
  };
  const first = await state();
  if (first?.ui !== 'chat' || first.state !== 'idle') throw new Error(`initial ${JSON.stringify(first)}`);
  c.chat('slow 150 20');
  await until(async () => (await state())?.state === 'running', 5000, 'running');
  await until(async () => (await state())?.state === 'idle', 15000, 'idle after the turn');
  c.chat('perm touch state.txt');
  await until(async () => (await state())?.state === 'waiting', 10000, 'waiting');
  const pending = c.frames.filter((f) => f.type === 'chat_state').at(-1)?.pending?.[0]
    ?? (await c.wait((fs) => fs.filter((f) => f.type === 'chat_state').at(-1)?.pending?.[0], 5000, 'pending'));
  c.send({ type: 'chat_respond', requestId: pending.requestId, response: { behavior: 'allow' } });
  const last = await until(async () => { const s = await state(); return s?.state === 'idle' ? s : null; }, 10000, 'idle after answering');
  // activitySeq is omitted while 0 (nothing sent yet).
  if (!(last.activitySeq > (first.activitySeq ?? 0)) || !last.epoch) throw new Error(`activitySeq ${first.activitySeq} → ${last.activitySeq}, epoch ${last.epoch}`);
  c.close();
  return seen.join(' → ');
});

test('chat: delete keeps jsonl', async () => {
  const { c, id, ready } = await newChat(dir('delete'));
  await c.turn(c.chat('echo keep me'));
  const u = ready.claudeSessionId;
  const path = transcript(u);
  if (!path) throw new Error('no transcript before delete');
  const res = await rest('DELETE', `/api/v1/sessions/${id}`);
  if (res.status !== 204) throw new Error(`delete ${res.status}`);
  if ((await listSessions()).some((s) => s.id === id)) throw new Error('still listed');
  await until(() => livePids(u).length === 0, 6000, 'claude process gone');
  if (!existsSync(path)) throw new Error('transcript deleted');
  c.close();
  return 'process gone, transcript kept';
});

// --- Run --------------------------------------------------------------------------

async function main() {
  console.log(`work dir ${work}`);
  for (const d of [binDir, projects, stateDir, configDir, pidDir, tmuxDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const goDir = join(ROOT, 'vibe-remoted');
  for (const [out, pkg] of [[daemonBin, './cmd/vibe-remoted'], [claudeBin, './internal/chat/fakeclaude']]) {
    const r = spawnSync('go', ['build', '-o', out, pkg], { cwd: goDir, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`go build ${pkg} failed`);
  }
  const names = ['create', 'replay', 'two', 'pending', 'resync', 'handoff', 'restart', 'state', 'delete'];
  for (const n of names) mkdirSync(dir(n));
  trust(names.map(dir));
  writeFileSync(cfgPath, JSON.stringify({
    bind_addr: '127.0.0.1',
    port,
    token,
    default_workdir: projects,
    allowed_roots: [projects],
    use_tmux: true,
    claude_cmd: claudeBin,
    claude_reload_cmd: claudeBin,
    login_shell: false,
    state_dir: stateDir,
  }), { mode: 0o600 });
  await startDaemon();
  const info = await (await rest('GET', '/api/v1/info')).json();
  if (info.proto !== 3 || !info.chat?.supported) throw new Error(`info ${JSON.stringify({ proto: info.proto, chat: info.chat })}`);
  console.log(`daemon up on 127.0.0.1:${port}, claude ${info.chat.claudeVersion} (fake)`);

  for (const { name, fn } of cases) {
    try {
      pass(name, await fn());
    } catch (e) {
      fail(name, e.message);
    }
  }
}

async function cleanup() {
  await stopDaemon();
  spawnSync('tmux', ['-L', 'vibe-remote', 'kill-server'], { env: { ...process.env, TMUX_TMPDIR: tmuxDir }, stdio: 'ignore' });
  rmSync(work, { recursive: true, force: true });
}

main()
  .catch((e) => fail('setup', e.message))
  .finally(async () => {
    await cleanup();
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall chat checks passed');
    process.exit(failures ? 1 : 0);
  });
