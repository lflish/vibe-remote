#!/usr/bin/env node
// Browser (CDP) acceptance cases for "sessions organised by project and
// worktree, and the M1 look" (docs/changes/2026-11-16-project-worktrees: the
// 「dev-test / 浏览器」 and 「协议冒烟」 rows of tasks.md, R1–R9 of spec.md).
// Sibling of gui-chat-smoke.mjs: the *built* app (stock Electron, throwaway
// userData, --use-mock-keychain) against throwaway daemons, never the
// developer's machines.json, keychain, ~/.claude or tmux.
//
// Everything lives under one fresh directory in /tmp and is removed at the end:
// git repositories with several worktrees, each daemon's config, state_dir,
// CLAUDE_CONFIG_DIR and tmux socket directory. TMUX_TMPDIR is set to a
// directory of this run for every process this script starts, so nothing here
// can reach the default tmux socket directory, whatever the caller's
// environment says. The daemons' allowed_roots are directories of this run
// only: these daemons delete directories and branches.
//
// Machines (all 127.0.0.1, random ports, own tmux server each):
//   this-mac    the picture of the spec: devflow (main, fix-login, the hidden
//               change/general-skills, a detached one), new-api, notes
//   lab-mac     repositories the cases change: webapp (new worktrees), del
//               (deleting), untrusted / selftrust (chat trust), failrepo
//   keep-mac    /bin/bash only, git reached through a wrapper that can be told
//               to fail `worktree remove`; restarted by R2.2
//   narrow-mac  allowed_roots is one repository and nothing around it
//   old-mac     vibe-remoted built from the commit before this change (protocol 3)
// this-mac and lab-mac run `claude`, a two-line wrapper: the fake claude
// (vibe-remoted/internal/chat/fakeclaude) for chat sessions and --version,
// /bin/bash for terminal sessions.
//
// How things are faked (so a failure can be read): the renderer's WebSocket and
// fetch are wrapped before the app starts (window.__vrNet: cut a connection
// before `ready`, refuse new connections, delay one REST path); the timer of
// the 5 s poll is captured (window.__vrPoll) so a case can ask for a refresh
// instead of waiting for one; the main process is paused at its first
// statement (--inspect-brk) to record the window's background and the first
// painted frame of the cold start. Keys go to this app's page through CDP
// (Input.dispatchKeyEvent), never to the system.
//
// Usage (from the repo root):
//   node .claude/skills/verify/scripts/gui-worktree-smoke.mjs [--no-build] [--keep] [--list] [--only=R3,R5.2]
//   DEVFLOW_EVIDENCE_DIR=<dir>   save one PNG per case (<case>.png)
//   VR_BASE_DAEMON=<path>        reuse a protocol-3 vibe-remoted build (default: built from VR_BASE_REF)
//   VR_BASE_REF=<commit>         the commit before this change (default 6d88e45)
//   VR_RESULTS=<file.json>       write the results as JSON
//   VR_DESKTOP_DIR=<dir> / VR_DAEMON=<binary>  run against another build (one with a defect put in on purpose: do the cases notice?)
//   VR_CDP_PORT / VR_INSPECT_PORT  fixed debug ports (with --keep, for poking around)
// Requires Node 22+, Go, tmux, git; macOS with a display.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { sidebarLayout } from './sidebar-layout.mjs';
import { atWindowSize, MIN_WINDOW } from './shell-layout.mjs';
import { slashMenuLayout } from './slash-menu-layout.mjs';
import { dialogLayout } from './dialog-layout.mjs';
import { decodePng, hexRgb, rgbHex, colorDistance, countColor, dominantColors } from './png-pixels.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
// VR_DESKTOP_DIR / VR_DAEMON: another build of the desktop / of the daemon, to
// check that the cases notice a build with a defect put in on purpose.
const DESKTOP = process.env.VR_DESKTOP_DIR ? resolve(process.env.VR_DESKTOP_DIR) : join(ROOT, 'desktop');
const argv = process.argv.slice(2);
const args = new Set(argv);
const ONLY = (argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EVIDENCE_DIR = process.env.DEVFLOW_EVIDENCE_DIR ? resolve(process.env.DEVFLOW_EVIDENCE_DIR) : '';
const BASE_REF = process.env.VR_BASE_REF || '6d88e45';
const J = JSON.stringify;

let failures = 0;
const results = [];
const ok = (msg) => console.log(`PASS ${msg}`);
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`); };
const note = (msg) => console.log(`NOTE ${msg}`);

async function waitFor(fn, ms, what, interval = 100) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e; }
    if (Date.now() >= deadline) break;
    await sleep(interval);
  }
  throw new Error(`timeout (${ms}ms): ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const eq = (got, want, what) => assert(J(got) === J(want), `${what}: got ${J(got)}, want ${J(want)}`);

// --- Throwaway environment ---------------------------------------------------

// Short base path: tmux sockets live under it (macOS caps them at ~104 bytes).
const work = realpathSync(mkdtempSync('/tmp/vr-wt-'));
// Whatever this script starts gets a tmux socket directory of this run.
process.env.TMUX_TMPDIR = join(work, 'tmux');
mkdirSync(process.env.TMUX_TMPDIR);
delete process.env.TMUX;
delete process.env.TMUX_PANE;

const binDir = join(work, 'bin');
const daemonBin = join(binDir, 'vibe-remoted');
const fakeClaude = join(binDir, 'fake', 'claude');
const claudeBin = join(binDir, 'claude');
const gitWrapDir = join(work, 'gitwrap');
const gitFailFlag = join(work, 'git-remove-fails');
const userData = join(work, 'userData');
const cdpPort = Number(process.env.VR_CDP_PORT) || 30000 + Math.floor(Math.random() * 10000);
const inspectPort = Number(process.env.VR_INSPECT_PORT) || 40000 + Math.floor(Math.random() * 10000);
const keychainService = 'vibe-remote Safe Storage';
const keychainExisted = keychainHas(keychainService);
const REAL_GIT = spawnSync('/usr/bin/which', ['git'], { encoding: 'utf-8' }).stdout.trim() || '/usr/bin/git';
let baseWorktree = '';
const daemons = new Map();
let electron = null;
let electronLog = '';
let cdp = null;
let mainProc = null;
let firstFrame = null; // what the cold start looked like (R8.6)
let savedClipboard = null;
const usedPorts = new Set();
const dialogs = [];
const chmodBack = []; // directories a case made read-only

function keychainHas(service) {
  return spawnSync('security', ['find-generic-password', '-s', service], { stdio: 'ignore' }).status === 0;
}

function freePort() {
  for (;;) {
    const p = 20000 + Math.floor(Math.random() * 10000);
    if (!usedPorts.has(p)) { usedPorts.add(p); return p; }
  }
}

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR', 'TMUX', 'TMUX_PANE'].includes(k) || k.startsWith('FAKE_CLAUDE_') || k.startsWith('GIT_')) continue;
    env[k] = v;
  }
  return env;
}

// --- git (the script's own view of the disk) ----------------------------------

const GIT_ENV = { ...cleanEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };
const GIT_ID = ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'commit.gpgsign=false'];

function gitRun(cwd, ...a) {
  return spawnSync(REAL_GIT, [...GIT_ID, ...a], { cwd, encoding: 'utf-8', env: GIT_ENV });
}
function git(cwd, ...a) {
  const r = gitRun(cwd, ...a);
  if (r.status !== 0) throw new Error(`git ${a.join(' ')} (in ${cwd}): ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}
const gitOk = (cwd, ...a) => gitRun(cwd, ...a).status === 0;
const head = (dir, ref = 'HEAD') => git(dir, 'rev-parse', ref);
const branchExists = (repo, name) => gitOk(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`);
const branches = (repo) => git(repo, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads').split('\n').filter(Boolean).sort();
/** The worktrees git lists for `repo`: [{ path, head, branch?, detached?, locked?, prunable? }]. */
function worktrees(repo) {
  const out = [];
  for (const block of git(repo, 'worktree', 'list', '--porcelain').split('\n\n')) {
    const w = {};
    for (const line of block.split('\n')) {
      const [k, ...rest] = line.split(' ');
      if (k === 'worktree') w.path = rest.join(' ');
      else if (k === 'HEAD') w.head = rest[0];
      else if (k === 'branch') w.branch = rest[0].replace('refs/heads/', '');
      else if (k) w[k] = rest.join(' ') || true;
    }
    if (w.path) out.push(w);
  }
  return out;
}
const listed = (repo, path) => worktrees(repo).some((w) => w.path === path);
/** What is on disk for one worktree: its directory, git's list, its branch. */
const disk = (repo, path, branch) => ({ dir: existsSync(path), listed: listed(repo, path), branch: branch ? branchExists(repo, branch) : null });

function makeRepo(dir, branch = 'main') {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  writeFileSync(join(dir, 'README.md'), `${dir.split('/').pop()}\n`);
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.env\n.devflow-tmp/\n');
  git(dir, 'add', 'README.md', '.gitignore');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
/** Adds `n` commits to the worktree at `dir`, each with one new file. */
function commits(dir, n, tag = 'c') {
  for (let i = 1; i <= n; i++) {
    const f = `${tag}${i}-${randomBytes(3).toString('hex')}.txt`;
    writeFileSync(join(dir, f), `${f}\n`);
    git(dir, 'add', f);
    git(dir, 'commit', '-q', '-m', `${tag} ${i}`);
  }
}

// --- Daemons --------------------------------------------------------------------

const trusted = (dirs) => J({ projects: Object.fromEntries(dirs.map((d) => [d, { hasTrustDialogAccepted: true }])) });

function defineDaemon(name, { bin = daemonBin, cfg, env = {} }) {
  const port = freePort();
  const token = randomBytes(32).toString('hex');
  const dir = join(work, 'd', name);
  const tmux = join(dir, 't');
  mkdirSync(tmux, { recursive: true });
  const d = { name, bin, port, token, tmux, env, addr: `127.0.0.1:${port}`, cfgPath: join(dir, 'daemon.json'), cfg: { bind_addr: '127.0.0.1', port, token, use_tmux: true, state_dir: join(dir, 'state'), ...cfg } };
  daemons.set(name, d);
  return d;
}

async function startDaemon(d) {
  writeFileSync(d.cfgPath, J(d.cfg), { mode: 0o600 });
  d.proc = spawn(d.bin, ['--config', d.cfgPath], { env: { ...cleanEnv(), TMUX_TMPDIR: d.tmux, ...d.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  d.log = d.log ?? '';
  d.proc.stdout.on('data', (x) => { d.log += x; });
  d.proc.stderr.on('data', (x) => { d.log += x; });
  await waitFor(async () => (await fetch(`http://${d.addr}/healthz`)).ok, 15000, `${d.name} /healthz`).catch((e) => {
    throw new Error(`${e.message}\n${d.log}`);
  });
}

async function stopDaemon(d) {
  if (!d.proc) return;
  const p = d.proc;
  d.proc = null;
  p.kill('SIGTERM');
  await new Promise((r) => { p.once('exit', r); setTimeout(r, 8000); });
}

const rest = (d, method, path, body) => fetch(`http://${d.addr}${path}`, {
  method,
  headers: { Authorization: `Bearer ${d.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? J(body) : undefined,
});
const sessions = async (d) => (await (await rest(d, 'GET', '/api/v1/sessions')).json()).list ?? [];
const projects = async (d) => (await (await rest(d, 'GET', '/api/v1/projects')).json()).projects ?? [];
const endSession = (d, id) => rest(d, 'DELETE', `/api/v1/sessions/${id}`);
const rename = (d, id, name) => rest(d, 'POST', `/api/v1/sessions/${id}/rename`, { name });
const hookEvent = (d, sessionId, kind, message = 'smoke') => rest(d, 'POST', '/api/v1/events', { sessionId, kind, message });

// --- A second "desktop": plain WebSocket client --------------------------------

class Conn {
  static async open(d) {
    const c = new Conn();
    c.ws = new WebSocket(`ws://${d.addr}/ws`);
    c.frames = [];
    c.waiters = new Set();
    c.ws.onmessage = (e) => {
      c.frames.push(JSON.parse(e.data));
      for (const w of [...c.waiters]) w();
    };
    await new Promise((res, rej) => { c.ws.onopen = res; c.ws.onerror = () => rej(new Error('ws open failed')); });
    c.send({ type: 'auth', token: d.token });
    return c;
  }

  send(frame) { this.ws.send(J(frame)); }
  close() { try { this.ws.close(); } catch { /* closed */ } }

  wait(pred, ms, what, from = 0) {
    return new Promise((res, rej) => {
      const check = () => {
        const v = pred(this.frames.slice(from));
        if (v) { done(); res(v); }
      };
      const timer = setTimeout(() => { done(); rej(new Error(`timeout (${ms}ms): ${what}`)); }, ms);
      const done = () => { clearTimeout(timer); this.waiters.delete(check); };
      this.waiters.add(check);
      check();
    });
  }

  async attachChat(sessionId) {
    const from = this.frames.length;
    this.send({ type: 'attach', sessionId, ui: 'chat', cols: 100, rows: 30 });
    await this.wait((fs) => {
      const i = fs.findIndex((f) => f.type === 'chat_sync');
      return i >= 0 && fs.slice(i).some((f) => f.type === 'chat_state');
    }, 15000, 'chat sync', from);
  }

  lastState() { return [...this.frames].reverse().find((f) => f.type === 'chat_state'); }

  chat(text) {
    const id = `m-${randomBytes(4).toString('hex')}`;
    this.send({ type: 'chat_send', clientMsgId: id, text });
    return id;
  }
}

/**
 * Creates a session the way a desktop does (one attach frame) and leaves it
 * running. `frame` adds to the attach: workdir, ui, mode, worktreeName,
 * flags. Returns the `ready` frame; an `error` frame is thrown as
 * Error(code: message) with .frame set.
 */
async function createSession(d, frame) {
  const c = await Conn.open(d);
  try {
    c.send({ type: 'attach', sessionId: '', cols: 100, rows: 30, ...frame });
    const f = await c.wait((fs) => fs.find((x) => x.type === 'ready' || x.type === 'error'), 30000, `ready for a session in ${frame.workdir}`);
    if (f.type === 'error') throw Object.assign(new Error(`${f.code}: ${f.message}`), { frame: f });
    return f;
  } finally {
    c.close();
  }
}
/** A terminal session in `workdir`; returns its id. */
const terminalIn = async (d, workdir) => (await createSession(d, { workdir })).sessionId;
/** A chat session in `workdir`; returns its id. */
const chatIn = async (d, workdir) => (await createSession(d, { workdir, ui: 'chat', newSessionId: `${Date.now()}-${randomBytes(4).toString('hex')}` })).sessionId;
/**
 * A worktree created by vibe-remote itself (so it is `managed`): a session is
 * created in worktree mode with the name, from `source`. Returns
 * { id, path, branch }; with `keep: false` the session is ended again, which
 * leaves the worktree with no session.
 */
async function managedWorktree(d, source, name, { ui = 'terminal', keep = false } = {}) {
  const f = await createSession(d, { workdir: source, mode: 'worktree', worktreeName: name, ui, newSessionId: `${Date.now()}-${randomBytes(4).toString('hex')}` });
  const s = (await sessions(d)).find((x) => x.id === f.sessionId);
  assert(s?.worktreeRoot && s.branch === name, `the daemon did not create worktree ${name}: ${J(s)}`);
  if (!keep) assert((await endSession(d, f.sessionId)).status === 204, `ending the session that created ${name}`);
  return { id: f.sessionId, path: s.worktreeRoot, branch: name };
}
/** Puts a repository on the daemon's project list without leaving a session in it. */
async function registerProject(d, dir) {
  const id = await terminalIn(d, dir);
  assert((await endSession(d, id)).status === 204, `ending the session that registered ${dir}`);
}

// --- CDP ------------------------------------------------------------------------

async function cdpSocket(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`CDP websocket ${wsUrl}`)); });
  let nextId = 0;
  const pending = new Map();
  const events = [];
  const listeners = new Set();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method) {
      events.push(msg);
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { resolve: res, reject: rej });
    ws.send(J({ id, method, params }));
  });
  const evaluate = async (expression, extra = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...extra });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { ws, send, evaluate, events, listeners };
}

// Runs in the page before any of the app's code (and again after a reload).
const PAGE_HOOKS = `(() => {
  if (window.__vrNet) return;
  // The 5 s poll: the app's own refresh function, callable by a case.
  const setI = window.setInterval;
  window.setInterval = function (fn, ms, ...rest) {
    if (ms === 5000 && typeof fn === 'function' && !window.__vrPoll) window.__vrPoll = fn;
    return setI.call(window, fn, ms, ...rest);
  };
  const net = { sockets: [], offline: false, attaches: [], sent: [], cut: null, delays: [], fetched: [] };
  const Orig = window.WebSocket;
  const desc = Object.getOwnPropertyDescriptor(Orig.prototype, 'onmessage');
  class W extends Orig {
    constructor(url, p) {
      super(net.offline ? 'ws://127.0.0.1:9/ws' : url, p);
      this.__url = url; this.__sid = ''; this.__cut = false;
      net.sockets.push(this);
    }
    send(d) {
      try {
        const f = JSON.parse(d);
        if (f.type === 'data') net.sent.push(atob(f.payload));
        if (f.type === 'attach' && !f.sessionId) {
          net.attaches.push({ newSessionId: f.newSessionId, worktreeName: f.worktreeName, mode: f.mode, ui: f.ui, workdir: f.workdir });
          // Cut this connection before its ready arrives (see the cut in onmessage).
          if (net.cut && !net.cut.done && f.worktreeName === net.cut.name) this.__cut = true;
        }
      } catch {}
      super.send(d);
    }
    get onmessage() { return this.__h || null; }
    set onmessage(h) {
      this.__h = h;
      desc.set.call(this, h ? (e) => {
        try {
          const f = JSON.parse(e.data);
          if (f.type === 'ready') {
            if (this.__cut && net.cut && !net.cut.done) {
              // The daemon has created the session; the desktop never hears of it.
              net.cut.done = true;
              net.cut.readySessionId = f.sessionId;
              if (net.cut.offline) net.offline = true;
              this.close();
              return;
            }
            this.__sid = f.sessionId;
          }
        } catch {}
        h.call(this, e);
      } : null);
    }
  }
  window.WebSocket = W;
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const rule = net.delays.find((r) => url.includes(r.match) && (r.times === undefined || r.times > 0));
    const entry = { url, t: performance.now(), delayed: rule ? rule.ms : 0, done: false };
    net.fetched.push(entry);
    if (rule) {
      if (rule.times !== undefined) rule.times--;
      await new Promise((r) => setTimeout(r, rule.ms));
    }
    try {
      return await origFetch.call(window, input, init);
    } finally {
      entry.done = true;
    }
  };
  window.__vrNet = net;
  window.__vrSock = (sid) => net.sockets.filter((s) => s.__sid === sid && s.readyState === 1).pop();
})()`;

// Evaluated in the main process while it is paused at its first statement:
// records the window's background color when it is first shown and the page as
// first painted (`ready-to-show` = "rendered for the first time").
const MAIN_FIRST_FRAME = `(() => {
  const { app } = require('electron');
  const f = globalThis.__vrFirst = { t0: Date.now(), events: [] };
  const at = (name) => f.events.push([name, Date.now() - f.t0]);
  app.on('browser-window-created', (_e, win) => {
    if (f.created) return;
    f.created = true;
    at('created');
    win.once('show', () => { at('show'); f.backgroundAtShow = win.getBackgroundColor(); });
    setImmediate(() => { f.backgroundAfterCreate = win.getBackgroundColor(); f.visibleAfterCreate = win.isVisible(); });
    win.webContents.once('dom-ready', () => at('dom-ready'));
    win.once('ready-to-show', async () => {
      at('ready-to-show');
      f.backgroundAtFirstPaint = win.getBackgroundColor();
      try {
        const img = await win.webContents.capturePage();
        f.size = img.getSize();
        f.png = img.toPNG().toString('base64');
        at('captured');
      } catch (e) { f.error = String(e); }
    });
  });
  return true;
})()`;

async function launchApp({ recordFirstFrame = false } = {}) {
  const electronBin = createRequire(join(DESKTOP, 'package.json'))('electron');
  electron = spawn(electronBin, [`${recordFirstFrame ? '--inspect-brk' : '--inspect'}=${inspectPort}`, DESKTOP, '--use-mock-keychain'], {
    env: { ...process.env, VIBE_REMOTE_DEBUG_PORT: String(cdpPort), VIBE_REMOTE_USER_DATA_DIR: userData, VIBE_REMOTE_NO_DEVTOOLS: '1', VITE_DEV_SERVER_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  electron.stdout.on('data', (x) => { electronLog += x; });
  electron.stderr.on('data', (x) => { electronLog += x; });

  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0], 20000, 'main process inspector');
  const m = await cdpSocket(target.webSocketDebuggerUrl);
  mainProc = { ...m, evaluate: (expr) => m.evaluate(expr, { includeCommandLineAPI: true }) };
  if (recordFirstFrame) {
    let paused = null;
    m.listeners.add((msg) => { if (msg.method === 'Debugger.paused') paused = msg.params; });
    await m.send('Debugger.enable');
    await m.send('Runtime.runIfWaitingForDebugger');
    await waitFor(() => paused, 15000, 'main process paused at its first statement');
    const r = await m.send('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId, expression: MAIN_FIRST_FRAME, returnByValue: true, includeCommandLineAPI: true });
    if (r.exceptionDetails || r.result?.value !== true) throw new Error(`first-frame recorder not installed: ${J(r.exceptionDetails ?? r.result)}`);
    await m.send('Debugger.resume');
    await m.send('Debugger.disable');
  }

  const page = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    return list.find((t) => t.type === 'page' && t.url.startsWith('file://'));
  }, 30000, 'app page target');
  cdp = await cdpSocket(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  cdp.listeners.add((msg) => {
    if (msg.method === 'Page.javascriptDialogOpening') {
      dialogs.push(msg.params.message);
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  });
  if (recordFirstFrame) {
    firstFrame = JSON.parse(await waitFor(() => mainProc.evaluate(`globalThis.__vrFirst && (globalThis.__vrFirst.png || globalThis.__vrFirst.error) ? JSON.stringify(globalThis.__vrFirst) : ''`), 20000, 'first painted frame recorded'));
    savedClipboard = await cdp.evaluate('window.vibeRemote.readClipboardText()').catch(() => null);
  }
  // Fixed locale (assertions use the zh strings), hooks in place before the app's code.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HOOKS });
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.machine-name-label')`), 20000, 'app started');
  await cdp.evaluate(`localStorage.setItem('vibe-remote.locale', 'zh'), true`);
  await cdp.send('Page.reload');
  await sleep(300);
  await waitFor(() => cdp.evaluate(`document.querySelectorAll('.machine-name-label').length === ${daemons.size} && document.documentElement.lang === 'zh-CN' && typeof window.__vrPoll === 'function' && !!window.__vrNet`), 20000, 'app reloaded in zh with the hooks');
}

async function quitApp() {
  try { cdp?.ws.close(); mainProc?.ws.close(); } catch { /* closed */ }
  cdp = null;
  mainProc = null;
  if (electron) {
    const e = electron;
    electron = null;
    e.kill('SIGTERM');
    await new Promise((r) => { e.once('exit', r); setTimeout(r, 4000); });
  }
}

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const KEYS = { Enter: [13, 'Enter', '\r'], Escape: [27, 'Escape'], Tab: [9, 'Tab'], Backspace: [8, 'Backspace'] };

async function pressKey(key, modifiers = 0) {
  const [vk, code, txt] = KEYS[key] ?? [key.toUpperCase().charCodeAt(0), `Key${key.toUpperCase()}`, key];
  const textToType = modifiers & (MOD.meta | MOD.ctrl) ? undefined : txt;
  const base = { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp.send('Input.dispatchKeyEvent', { type: textToType ? 'keyDown' : 'rawKeyDown', text: textToType, ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** The page as a decoded image plus the factor from CSS pixels to image pixels. */
async function screenshot(clip) {
  const m = await cdp.evaluate('({ w: innerWidth, h: innerHeight })');
  const c = clip ?? { x: 0, y: 0, width: m.w, height: m.h };
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { ...c, scale: 1 } });
  const img = decodePng(Buffer.from(r.data, 'base64'));
  return { img, scale: img.width / c.width, origin: c };
}

/**
 * Saves the page as <DEVFLOW_EVIDENCE_DIR>/<name>.png, scaled down until it is
 * small. `selector` limits the picture to one element (the sidebar, a dialog);
 * `rowExpr` (an expression for an element) is scrolled into view first.
 */
async function evidence(name, selector, rowExpr) {
  if (!EVIDENCE_DIR || !cdp) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  if (rowExpr) await cdp.evaluate(`(${rowExpr})?.scrollIntoView({ block: 'center' }), true`).catch(() => {});
  const m = await cdp.evaluate(`(() => {
    const r = ${selector ? `document.querySelector(${J(selector)})?.getBoundingClientRect()` : 'null'};
    const box = r && r.width > 0 ? { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.width, innerWidth), height: Math.min(r.height, innerHeight) } : { x: 0, y: 0, width: innerWidth, height: innerHeight };
    return { box, dpr: devicePixelRatio };
  })()`);
  const file = join(EVIDENCE_DIR, `${name}.png`);
  for (const css of [1, 0.8, 0.65, 0.5]) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { ...m.box, scale: css / m.dpr } });
    const buf = Buffer.from(r.data, 'base64');
    if (buf.length < 100_000 || css === 0.5) {
      writeFileSync(file, buf);
      break;
    }
  }
  if (rowExpr) await cdp.evaluate(`document.querySelector('#machine-list').scrollTop = 0, true`).catch(() => {});
}

// --- Page helpers -----------------------------------------------------------------

const ev = (expr) => cdp.evaluate(expr);
const tid = (id) => `[data-testid="${id}"]`;
// Rows of the sidebar, found the way a user reads them: by the names shown.
const mg = (d) => `[...document.querySelectorAll('#machine-list .machine-group')].find((g) => g.querySelector('.machine-name-label')?.textContent === ${J(d.name)})`;
const pg = (d, project) => `[...(${mg(d)}?.querySelectorAll('.project-group') ?? [])].find((g) => g.querySelector('.project-name')?.textContent === ${J(project)})`;
const wg = (d, project, label) => `[...(${pg(d, project)}?.querySelectorAll('.worktree-group') ?? [])].find((g) => g.querySelector('.worktree-label')?.textContent === ${J(label)})`;
const srow = (id) => `document.querySelector('#machine-list .session-item[data-session-id="${id}"]')`;
const DLG = (id) => `document.querySelector('.modal-overlay ${tid(id)}')`;
const VC = `[...document.querySelectorAll('.chat-instance')].find((c) => c.style.display !== 'none')`;
const inChat = (sel) => `${VC}?.querySelector(${J(sel)})`;
const VT = `[...document.querySelectorAll('.term-instance')].find((c) => c.style.display !== 'none')`;

/** What the sidebar shows under machine `d`: projects → worktrees → sessions. */
function sidebar(d) {
  return ev(`(() => {
    const g = ${mg(d)};
    if (!g) return null;
    const sess = (s) => ({
      id: s.dataset.sessionId, ui: s.dataset.ui, name: s.querySelector('.session-label-text')?.textContent ?? '', dot: s.dataset.dot,
      active: s.classList.contains('active'), meta: s.querySelector('.session-meta')?.textContent ?? '', gone: !!s.querySelector('${tid('session-gone')}'),
      icon: !!s.querySelector('.session-kind-icon svg'), dotEl: !!s.querySelector('.session-unread'),
    });
    return {
      state: g.querySelector('${tid('machine-state')}')?.dataset.state, legacyNote: g.querySelector('${tid('machine-legacy-note')}')?.textContent ?? null,
      projects: [...g.querySelectorAll('.project-group')].map((p) => {
        const row = p.querySelector(':scope > .project-row');
        return {
          name: row.querySelector('.project-name').textContent, id: p.dataset.projectId,
          branch: row.querySelector('${tid('project-branch')}')?.textContent ?? null,
          error: row.querySelector('${tid('project-error')}')?.textContent ?? null,
          dot: row.querySelector('${tid('project-dot')}')?.className ?? null,
          collapsed: row.querySelector('.project-toggle').getAttribute('aria-expanded') === 'false',
          buttons: [...row.querySelectorAll('.row-actions [data-testid]')].map((b) => b.dataset.testid + (b.disabled ? ':disabled' : '')),
          worktrees: [...p.querySelectorAll(':scope > .worktree-group')].map((w) => ({
            label: w.querySelector('.worktree-label').textContent, path: w.dataset.path,
            tags: [...w.querySelectorAll('.worktree-tag')].map((t) => t.dataset.testid),
            empty: w.querySelector('${tid('worktree-empty')} .worktree-empty-text')?.textContent ?? null,
            buttons: [...w.querySelectorAll('.worktree-row .row-actions [data-testid], ${tid('worktree-empty-new-session')}')].map((b) => b.dataset.testid + (b.disabled ? ':disabled' : '')),
            sessions: [...w.querySelectorAll('.session-item')].map(sess),
          })),
          sessions: [...p.querySelectorAll(':scope > .session-item')].map(sess),
        };
      }),
    };
  })()`);
}
const project = async (d, name) => (await sidebar(d))?.projects.find((p) => p.name === name) ?? null;
const worktreeRow = async (d, proj, label) => (await project(d, proj))?.worktrees.find((w) => w.label === label) ?? null;
/** Session ids in the sidebar, top to bottom, rows that are showing only. */
const visibleIds = () => ev(`[...document.querySelectorAll('#machine-list .session-item')].filter((r) => r.getClientRects().length > 0).map((r) => r.dataset.sessionId)`);
const activeId = () => ev(`document.querySelector('#machine-list .session-item.active')?.dataset.sessionId ?? null`);

/** Asks the app for a refresh now (its own 5 s poll function) and waits for the answers. */
async function refresh() {
  await ev(`window.__vrPoll().then(() => true)`);
}

/** Clicks the element `expr` evaluates to, once it exists. */
async function click(expr, what, ms = 8000) {
  await waitFor(() => ev(`(() => { const e = ${expr}; if (!e || e.disabled) return false; e.click(); return true; })()`), ms, `${what} to click`);
}
const exists = (expr) => ev(`!!(${expr})`);
const text = (expr) => ev(`(${expr})?.textContent ?? null`);
const statusMessage = () => ev(`document.getElementById('status-bar').hidden ? '' : document.getElementById('status-message').textContent`);

/** Waits for the dialog and for the focus to have moved into it (the dialogs focus their default control a frame later). */
async function waitDialog(id, ms = 8000) {
  await waitFor(() => exists(DLG(id)), ms, `dialog ${id}`);
  await waitFor(() => ev(`!!document.activeElement?.closest('.modal-overlay')`), 3000, `focus inside dialog ${id}`);
}
const dialogGone = (ms = 8000) => waitFor(() => ev(`!document.querySelector('.modal-overlay')`), ms, 'dialog closed');
const cancelDialog = async () => { await click(`document.querySelector('.modal-overlay ${tid('dialog-cancel')}')`, 'cancel'); await dialogGone(); };
const closeMenus = () => ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), !document.querySelector('body > .menu')`);

/** Replaces the content of the input `expr` evaluates to by typing `value`. */
async function typeInto(expr, value) {
  await waitFor(() => ev(`(() => { const i = ${expr}; if (!i) return false; i.focus(); i.select(); return document.activeElement === i; })()`), 5000, 'input focused');
  if ((await ev(`(${expr}).value`)) !== '') await pressKey('Backspace');
  if (value) await cdp.send('Input.insertText', { text: value });
  const got = await ev(`(${expr}).value`);
  assert(got === value, `typed ${J(value)}, the field has ${J(got)}`);
}

async function openMachine(d) {
  await click(`${mg(d)}?.querySelector('.machine-name')`, `machine ${d.name}`);
  await waitFor(() => ev(`!!document.querySelector('#machine-overview .workspace-mode-card:not([disabled])') && document.querySelector('#machine-overview h1')?.textContent === ${J(d.name)}`), 20000, `${d.name} overview, online`);
}

/** Opens the session `id` from its sidebar row and waits until it is the one shown. */
async function openSession(id) {
  if ((await activeId()) === id) return;
  await click(`${srow(id)}?.querySelector('.session-label')`, `session ${id} row`);
  await waitFor(async () => (await activeId()) === id, 15000, `session ${id} shown`);
}

const screen = () => ev(`(() => { const r = ${VT}?.querySelector('.xterm-rows'); return r ? r.innerText : ''; })()`);
const focusTerminal = () => ev(`(() => { const t = ${VT}?.querySelector('.xterm-helper-textarea'); t?.focus(); return !!t && document.activeElement === t; })()`);
async function typeLine(line) {
  await waitFor(focusTerminal, 5000, 'terminal focused');
  await cdp.send('Input.insertText', { text: line });
  await pressKey('Enter');
}
/** Runs a shell line in the terminal on screen and waits for `expect` in its output. */
async function shell(line, expect, ms = 10000) {
  await waitFor(async () => /[$#%] ?$/m.test((await screen()).trimEnd()) || (await screen()).includes('$'), 20000, 'shell prompt');
  await typeLine(line);
  return waitFor(async () => { const s = await screen(); return s.includes(expect) ? s : null; }, ms, `terminal shows ${J(expect)}`);
}

async function sendChat(msg) {
  await waitFor(() => ev(`(() => { const i = ${inChat(tid('chat-input'))}; i?.focus(); return !!i && !i.disabled && document.activeElement === i; })()`), 10000, 'chat input focused');
  await cdp.send('Input.insertText', { text: msg });
  await pressKey('Enter');
}
const assistantText = () => ev(`[...(${VC}?.querySelectorAll('${tid('chat-msg-assistant')}') ?? [])].map((m) => m.textContent).join('\\n')`);
const waitAssistant = (sub, ms = 15000) => waitFor(async () => (await assistantText()).includes(sub), ms, `assistant "${sub}"`);
const chatIdle = () => waitFor(() => ev(`(() => { const s = ${inChat(tid('chat-stop'))}; return !!s && s.hidden && !${VC}.querySelector('.spin'); })()`), 20000, 'turn over');

/** "New session" on a worktree row (or a flat project's row): opens the dialog and waits until it has what it asked the daemon for. */
async function openNewSessionDialog(d, proj, label) {
  const button = label === null
    ? `${pg(d, proj)}?.querySelector(':scope > .project-row ${tid('project-new-session')}')`
    : `${wg(d, proj, label)}?.querySelector('.worktree-row ${tid('worktree-new-session')}')`;
  const from = await ev('window.__vrNet.fetched.length');
  await click(button, `"new session" on ${proj}${label ? ` / ${label}` : ''}`);
  await waitDialog('worktree-session-dialog');
  // The machine info and the folder's trust are both in: the chat card's state
  // is final (with only one of them it shows a reason that is about to change).
  await waitFor(() => ev(`(() => { const asked = window.__vrNet.fetched.slice(${from}).filter((f) => f.url.includes(':${d.port}/api/v1/'));
    const got = (path) => asked.some((f) => f.url.includes(path) && f.done);
    return got('/api/v1/info') && got('/api/v1/fs') && !${DLG('worktree-session-dialog')}.querySelector('${tid('dialog-confirm')}').disabled; })()`), 15000, 'new-session dialog ready');
  await sleep(50);
}

/** Creates a session from the row's dialog; returns the new session's id once it is the one shown. */
async function newSessionVia(d, proj, label, { ui = 'terminal' } = {}) {
  const before = new Set((await sessions(d)).map((s) => s.id));
  await openNewSessionDialog(d, proj, label);
  if (ui === 'chat') {
    await click(`${DLG('worktree-session-dialog')}.querySelector('${tid('picker-ui-chat')}')`, 'chat card');
    await waitFor(() => ev(`${DLG('worktree-session-dialog')}?.querySelector('${tid('picker-ui-chat')}').getAttribute('aria-pressed') === 'true'`), 5000, 'chat chosen');
  }
  await click(`${DLG('worktree-session-dialog')}.querySelector('${tid('dialog-confirm')}')`, 'confirm');
  await dialogGone();
  return waitNewSession(d, before, ui);
}

/** Waits for a session that was not in `before` to be listed by the daemon and shown as the active row. */
async function waitNewSession(d, before, ui = 'terminal', ms = 30000) {
  const s = await waitFor(async () => (await sessions(d)).find((x) => !before.has(x.id) && (x.ui ?? 'terminal') === ui), ms, `new ${ui} session on ${d.name}`);
  await waitFor(async () => (await activeId()) === s.id, 15000, `new session ${s.id} shown`);
  if (ui === 'chat') await waitFor(() => ev(`(() => { const i = ${inChat(tid('chat-input'))}; return !!i && !i.disabled; })()`), 20000, 'chat view ready');
  return s.id;
}

/** "New worktree" on a project row: opens the dialog and waits for the daemon's first answer (the base line). */
async function openNewWorktreeDialog(d, proj) {
  await click(`${pg(d, proj)}?.querySelector(':scope > .project-row ${tid('project-new-worktree')}')`, `"new worktree" on ${proj}`);
  await waitDialog('new-worktree-dialog');
  await waitFor(() => ev(`(() => { const b = ${DLG('new-worktree-dialog')}.querySelector('${tid('wt-base-info')}'); const e = ${DLG('new-worktree-dialog')}.querySelector('${tid('wt-name-error')}'); return !b.hidden || !e.hidden; })()`), 10000, 'the base of the new worktree');
}
const NAME = `document.querySelector('.modal-overlay ${tid('wt-name-input')}')`;
/** The name field's state: the error under it, the directory it would create, whether Confirm is on. */
const nameState = () => ev(`(() => { const o = document.querySelector('.modal-overlay'); const e = o.querySelector('${tid('wt-name-error')}'); return {
  value: o.querySelector('${tid('wt-name-input')}').value, error: e.hidden ? '' : e.textContent, target: o.querySelector('${tid('wt-target-path')}')?.textContent ?? '',
  base: o.querySelector('${tid('wt-base-info')}')?.hidden ? '' : o.querySelector('${tid('wt-base-info')}')?.textContent ?? '', confirm: !o.querySelector('${tid('dialog-confirm')}').disabled, disabled: o.querySelector('${tid('wt-name-input')}').disabled }; })()`);
/** Types a name and waits until the dialog has made up its mind about it (an error, or a target directory). */
async function typeName(name) {
  await typeInto(NAME, name);
  return waitFor(async () => { const s = await nameState(); return s.value === name && (s.error !== '' || (s.target !== '' && s.target !== '—' && s.confirm)) ? s : null; }, 10000, `verdict on the name ${J(name)}`);
}

/** Opens the "more" menu of a worktree row and picks "delete worktree"; the confirmation is on screen afterwards. */
async function openDeleteWorktree(d, proj, label) {
  await waitFor(() => ev(`(() => { const g = ${wg(d, proj, label)}; if (!g) return false; g.scrollIntoView({ block: 'center' }); return true; })()`), 8000, `row ${proj} / ${label}`);
  await click(`${wg(d, proj, label)}?.querySelector('.worktree-row ${tid('worktree-menu')}')`, `menu of ${proj} / ${label}`);
  await click(`document.querySelector('body > .menu ${tid('worktree-delete')}')`, '"delete worktree"');
  await waitDialog('delete-wt-dialog');
}
/** What the delete-worktree confirmation says. */
const deleteDialog = () => ev(`(() => { const d = ${DLG('delete-wt-dialog')}; if (!d) return null; const t = (id) => d.querySelector('[data-testid="' + id + '"]')?.textContent ?? null; const a = document.activeElement; return {
  variant: d.dataset.variant, title: d.querySelector('.modal-title').textContent, text: d.querySelector('.modal-body').textContent,
  files: t('delete-wt-files'), commits: t('delete-wt-commits'), sessions: t('delete-wt-sessions'), external: t('delete-wt-external'), ignored: t('delete-wt-ignored'),
  error: t('delete-wt-error'), ended: t('delete-wt-ended'), changed: t('delete-wt-changed'),
  keep: d.querySelector('${tid('delete-wt-keep-branch')}')?.checked ?? null, drop: d.querySelector('${tid('delete-wt-delete-branch')}')?.checked ?? null,
  focus: a?.dataset.testid ?? a?.tagName ?? null, buttons: [...d.querySelectorAll('.modal-footer button')].map((b) => b.dataset.testid + '=' + b.textContent),
  default: d.querySelector('.modal-footer button[data-default]')?.dataset.testid ?? null, hint: d.querySelector('.modal-footer-hint')?.textContent ?? null }; })()`);

/** Console lines of the renderer since `from` (an index into cdp.events) that start with `prefix`. */
const consoleLines = (prefix, from = 0) => cdp.events.slice(from)
  .filter((e) => e.method === 'Runtime.consoleAPICalled')
  .map((e) => e.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  .filter((l) => l.startsWith(prefix));

/** Measures the dialog on screen in an 800×500 window; throws on any problem. */
async function fitsSmallWindow(what) {
  const l = await atWindowSize(cdp, MIN_WINDOW, () => dialogLayout(cdp));
  assert(l.problems.length === 0, `${what} in 800×500 (${l.lang ?? '?'}): ${l.problems.join('; ')}`);
  return l;
}

// --- Cases ------------------------------------------------------------------------

const cases = [];
const test = (id, name, fn) => cases.push({ id, name, fn });

let WT, LAB, KEEP, NARROW, OLD; // daemons
const A = join(work, 'a'); // this-mac's allowed root
const L = join(work, 'l'); // lab-mac's
const K = join(work, 'k'); // keep-mac's
const N = join(work, 'n', 'solo'); // narrow-mac's: one repository
const O = join(work, 'o'); // old-mac's
const fx = {}; // what main() set up: ids and paths the cases refer to

// ---- R1 侧边栏按 机器 → 项目 → worktree 组织 ------------------------------------

test('R1.1', 'R1.1 one project, two worktrees, each with a session', async () => {
  const side = await sidebar(WT);
  const devflow = side.projects.find((p) => p.name === 'devflow');
  assert(devflow, `no project devflow under this-mac: ${J(side.projects.map((p) => p.name))}`);
  const labels = devflow.worktrees.map((w) => w.label);
  assert(labels.includes('main') && labels.includes('fix-login'), `worktree rows ${J(labels)}`);
  const main = devflow.worktrees.find((w) => w.label === 'main');
  const fix = devflow.worktrees.find((w) => w.label === 'fix-login');
  const chat = main.sessions.find((s) => s.id === fx.mainChat);
  const term = fix.sessions.find((s) => s.id === fx.fix.id);
  assert(chat && chat.ui === 'chat', `the chat session is not under main: ${J(main.sessions)}`);
  assert(term && term.ui === 'terminal', `the terminal session is not under fix-login: ${J(fix.sessions)}`);
  assert(!fix.sessions.some((s) => s.id === fx.mainChat) && !main.sessions.some((s) => s.id === fx.fix.id), 'a session shows under both worktrees');
  for (const s of [chat, term]) {
    assert(s.icon, `session ${s.name} has no kind icon`);
    assert(s.dotEl && ['none', 'output', 'idle', 'waiting'].includes(s.dot), `session ${s.name} has no state dot: ${J(s)}`);
  }
  // The two kinds are told apart by more than a data attribute: the icons differ, and the row says which it is.
  const icons = await ev(`[${J(fx.mainChat)}, ${J(fx.fix.id)}].map((id) => document.querySelector('.session-item[data-session-id="' + id + '"] .session-kind-icon path').getAttribute('d'))`);
  assert(icons[0] !== icons[1], 'the chat and the terminal session have the same icon');
  assert(chat.meta.includes('对话') && term.meta.includes('终端'), `kind text: ${J([chat.meta, term.meta])}`);
  eq(main.tags, ['worktree-tag-main'], 'tags of the main row');
  await evidence('R1.1');
  return `devflow: ${labels.join(', ')}; main has the chat session "${chat.name}", fix-login the terminal session "${term.name}"`;
});

test('R1.2', 'R1.2 a project with one worktree has no worktree level', async () => {
  const p = await project(WT, 'new-api');
  assert(p, 'no project new-api');
  eq(p.worktrees, [], 'worktree rows under new-api');
  const ids = p.sessions.map((s) => s.id);
  assert(ids.includes(fx.api1) && ids.includes(fx.api2), `sessions under new-api: ${J(p.sessions)}`);
  eq(p.branch, 'dev', 'branch on the project row');
  eq(git(fx.newApi, 'symbolic-ref', '--short', 'HEAD'), 'dev', 'branch on disk');
  await evidence('R1.2', '#sidebar', pg(WT, 'new-api'));
  return `2 sessions directly under new-api, row shows "${p.branch}"`;
});

test('R1.3', 'R1.3 a folder outside any git repository', async () => {
  const p = await project(WT, 'notes');
  assert(p, 'no project notes');
  eq(p.worktrees, [], 'worktree rows under notes');
  eq(p.branch, null, 'branch on the notes row');
  assert(p.sessions.some((s) => s.id === fx.notes1), `sessions under notes: ${J(p.sessions)}`);
  assert(!p.buttons.some((b) => b.startsWith('project-new-worktree') || b.startsWith('project-menu')), `worktree entries on a non-git project: ${J(p.buttons)}`);
  assert(!gitOk(fx.notes, 'rev-parse', '--git-dir'), 'the fixture folder is inside a git repository');
  return `notes: ${p.sessions.length} session(s), row buttons ${J(p.buttons)}`;
});

test('R1.4', 'R1.4 sessions of one worktree that were never renamed', async () => {
  const main = await worktreeRow(WT, 'devflow', 'main');
  const mine = [fx.mainChat, fx.main2, fx.main3].map((id) => main.sessions.find((s) => s.id === id)?.name);
  eq(mine, ['devflow', 'devflow 2', 'devflow 3'], 'names of the three sessions in main, in the order they were created');
  const all = main.sessions.map((s) => s.name);
  assert(new Set(all).size === all.length, `two sessions show the same name: ${J(all)}`);
  // none of them has a name of its own on the daemon
  const titles = (await sessions(WT)).filter((s) => [fx.mainChat, fx.main2, fx.main3].includes(s.id)).map((s) => s.title);
  eq(titles, ['devflow', 'devflow', 'devflow'], 'titles the daemon reports');
  await evidence('R1.4', '#sidebar', wg(WT, 'devflow', 'main'));
  return mine.join(' | ');
});

test('R1.5', 'R1.5 the order is the same over 40 refreshes', async () => {
  const shape = async () => {
    const s = await sidebar(WT);
    return s.projects.map((p) => `${p.name}[${p.worktrees.map((w) => `${w.label}(${w.sessions.map((x) => x.id).join(',')})`).join(' ')}|${p.sessions.map((x) => x.id).join(',')}]`).join(' ');
  };
  const first = await shape();
  const fetchedBefore = await ev(`window.__vrNet.fetched.filter((f) => f.url.includes(':${WT.port}/api/v1/projects')).length`);
  let different = 0;
  for (let i = 0; i < 40; i++) {
    await refresh();
    if ((await shape()) !== first) different++;
  }
  const fetched = (await ev(`window.__vrNet.fetched.filter((f) => f.url.includes(':${WT.port}/api/v1/projects')).length`)) - fetchedBefore;
  assert(fetched >= 40, `only ${fetched} project lists were requested in 40 refreshes`);
  eq(different, 0, 'refreshes that showed another order');
  // and it is the documented one
  const side = await sidebar(WT);
  const names = side.projects.map((p) => p.name);
  eq(names, [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), 'projects by name');
  const created = new Map((await sessions(WT)).map((s) => [s.id, s.created]));
  let count = 0;
  for (const p of side.projects) {
    for (const w of p.worktrees) {
      const t = w.sessions.map((s) => created.get(s.id));
      eq(t, [...t].sort(), `sessions of ${p.name} / ${w.label} by creation time`);
      count += t.length;
    }
    const t = p.sessions.map((s) => created.get(s.id));
    eq(t, [...t].sort(), `sessions of ${p.name} by creation time`);
    count += t.length;
  }
  const devflow = side.projects.find((p) => p.name === 'devflow');
  eq(devflow.worktrees[0].label, 'main', 'first worktree of devflow');
  const branchRows = devflow.worktrees.slice(1).filter((w) => !/^[0-9a-f]{7}$/.test(w.label)).map((w) => w.label);
  eq(branchRows, [...branchRows].sort(), 'other worktrees by branch name');
  assert(/^[0-9a-f]{7}$/.test(devflow.worktrees.at(-1).label), `the detached worktree is not last: ${J(devflow.worktrees.map((w) => w.label))}`);
  assert(side.projects.length >= 3 && count >= 8, `fixture too small: ${side.projects.length} projects, ${count} sessions`);
  return `${side.projects.length} projects, ${count} sessions, 40 refreshes (${fetched} requests of the project list), 0 differences`;
});

test('R1.6', 'R1.6 a folded project shows that a session inside is waiting', async () => {
  const toggle = `${pg(WT, 'devflow')}.querySelector(':scope > .project-row .project-toggle')`;
  // look at another machine, so no devflow session is the one on screen
  await openMachine(KEEP);
  if (!(await project(WT, 'devflow')).collapsed) await click(toggle, 'fold devflow');
  await waitFor(async () => (await project(WT, 'devflow')).collapsed, 5000, 'devflow folded');
  eq((await project(WT, 'devflow')).dot, null, 'dot on the folded row before anything waits');
  const other = await Conn.open(WT);
  try {
    await other.attachChat(fx.mainChat);
    other.chat('perm touch r16.txt');
    const pending = await other.wait((fs) => fs.filter((f) => f.type === 'chat_state').at(-1)?.pending?.[0], 15000, 'pending permission request');
    await waitFor(async () => { await refresh(); return (await project(WT, 'devflow')).dot; }, 15000, 'dot on the folded project row');
    const folded = await project(WT, 'devflow');
    assert(folded.dot.includes('waiting'), `the folded row's dot is not the "needs you" one: ${folded.dot}`);
    eq(folded.worktrees.length + folded.sessions.length, 0, 'rows showing under a folded project');
    await evidence('R1.6');
    await click(toggle, 'unfold devflow');
    const row = await waitFor(async () => (await worktreeRow(WT, 'devflow', 'main'))?.sessions.find((s) => s.id === fx.mainChat), 5000, 'the session row after unfolding');
    eq(row.dot, 'waiting', 'dot of the session row');
    assert(row.meta.includes('等你处理'), `the row does not say it waits: ${row.meta}`);
    eq((await project(WT, 'devflow')).dot, null, 'dot on the project row once unfolded');
    other.send({ type: 'chat_respond', requestId: pending.requestId, response: { behavior: 'allow' } });
    await other.wait((fs) => fs.some((f) => f.type === 'chat' && f.msg?.type === 'result'), 15000, 'turn finished after allowing');
    return `folded: ${folded.dot}; unfolded: session row dot ${row.dot}, "${row.meta}"`;
  } finally {
    other.close();
    if ((await project(WT, 'devflow'))?.collapsed) await click(toggle, 'unfold devflow').catch(() => {});
  }
});

test('R1.7', 'R1.7 title and notification title carry project, branch and session name', async () => {
  await openSession(fx.fix.id);
  const title = await waitFor(async () => {
    const t = await ev(`(() => { const p = (id) => document.querySelector('#toolbar-title [data-testid="' + id + '"]')?.textContent ?? null; return { project: p('title-project'), branch: p('title-branch'), session: p('title-session'), all: document.getElementById('toolbar-title').textContent }; })()`);
    return t.session === '登录修复' ? t : null;
  }, 10000, 'toolbar title of the session');
  eq([title.project, title.branch, title.session], ['devflow', 'fix-login', '登录修复'], 'parts of the toolbar title');
  assert(!title.all.includes('this-mac'), `the toolbar title names the machine: ${title.all}`);
  await evidence('R1.7');
  // in the background: another session on screen, then the hook event of an agent that needs input
  await openSession(fx.api1);
  const from = cdp.events.length;
  eq((await hookEvent(WT, fx.fix.id, 'waiting', 'needs input')).status, 204, 'events endpoint');
  const line = await waitFor(() => consoleLines('[notify]', from)[0], 8000, 'desktop notification');
  const m = /^\[notify\] (shown|fallback): (.*)$/.exec(line);
  assert(m, `unexpected notify line ${line}`);
  eq(m[2], 'this-mac · devflow / fix-login · 登录修复', 'notification title');
  await waitFor(async () => (await worktreeRow(WT, 'devflow', 'fix-login')).sessions.find((s) => s.id === fx.fix.id)?.dot === 'waiting', 5000, 'the row shows it waits');
  await openSession(fx.fix.id); // looked at: the dot goes
  return `title "${title.all}"; notification (${m[1]}) "${m[2]}"`;
});

test('R1.8', 'R1.8 a worktree on no branch shows its short commit id', async () => {
  const short = head(fx.detached).slice(0, 7);
  assert(!gitOk(fx.detached, 'symbolic-ref', '-q', 'HEAD'), 'the fixture worktree is on a branch');
  const row = (await project(WT, 'devflow')).worktrees.find((w) => w.path === fx.detached);
  assert(row, 'the detached worktree has no row');
  eq(row.label, short, 'label of the detached worktree');
  await evidence('R1.8', '#sidebar', pg(WT, 'devflow'));
  return `row "${row.label}" = HEAD of ${fx.detached}`;
});

// ---- R2 列出项目的全部 worktree ---------------------------------------------------

test('R2.1', 'R2.1 a worktree made elsewhere, with no session', async () => {
  const row = await worktreeRow(WT, 'devflow', 'change/general-skills');
  assert(row, 'no row change/general-skills under devflow');
  eq(row.path, fx.general, 'directory of the row');
  eq(row.sessions, [], 'sessions under it');
  eq(row.empty, '没有会话', 'what the row says about sessions');
  assert(row.tags.includes('worktree-tag-external'), `not marked as made elsewhere: ${J(row.tags)}`);
  assert(row.buttons.includes('worktree-new-session') && row.buttons.includes('worktree-empty-new-session'), `no "new session" entry: ${J(row.buttons)}`);
  // the entry leads to a new session in that directory
  await click(`${wg(WT, 'devflow', 'change/general-skills')}.querySelector('${tid('worktree-empty-new-session')}')`, '"new session" under the empty worktree');
  await waitDialog('worktree-session-dialog');
  const where = await text(`${DLG('worktree-session-dialog')}.querySelector('${tid('session-dialog-path')}')`);
  assert(where.includes(fx.general), `the dialog is for ${where}`);
  await cancelDialog();
  await evidence('R2.1', '#sidebar', wg(WT, 'devflow', 'change/general-skills'));
  return `row "${row.label}" (${row.empty}), entries ${J(row.buttons)}`;
});

test('R2.2', 'R2.2 a project whose sessions are all deleted stays, across a desktop and a daemon restart', async () => {
  const id = await terminalIn(KEEP, fx.keep);
  await refresh();
  const withSession = await project(KEEP, 'keep');
  eq(withSession?.worktrees.map((w) => w.label), ['main', 'side'], 'worktrees of keep');
  eq((await endSession(KEEP, id)).status, 204, 'deleting the only session');
  await refresh();
  const check = async (when) => {
    const p = await project(KEEP, 'keep');
    assert(p, `${when}: keep is gone from the sidebar`);
    eq(p.worktrees.map((w) => [w.label, w.empty, w.sessions.length]), [['main', '没有会话', 0], ['side', '没有会话', 0]], `${when}: worktrees of keep`);
  };
  await check('after deleting the session');
  eq((await sessions(KEEP)).filter((s) => s.workdir?.startsWith(fx.keep)).length, 0, 'sessions left in keep');
  // the desktop is quit and started again
  await quitApp();
  await launchApp();
  await waitFor(async () => !!(await project(KEEP, 'keep')), 20000, 'keep listed after the desktop restart');
  await check('after the desktop restart');
  await evidence('R2.2', '#sidebar', pg(KEEP, 'keep'));
  // the daemon is stopped and started again
  await stopDaemon(KEEP);
  await startDaemon(KEEP);
  await waitFor(async () => { await refresh(); return (await sidebar(KEEP)).state === 'connected' && !!(await project(KEEP, 'keep')); }, 40000, 'keep listed after the daemon restart', 500);
  await check('after the daemon restart');
  const stored = JSON.parse(readFileSync(join(KEEP.cfg.state_dir, 'projects.json'), 'utf-8'));
  assert(J(stored).includes(fx.keep), 'projects.json does not record the project');
  return 'keep and its 2 worktrees listed after: deleting its session, restarting the desktop, restarting the daemon';
});

test('R2.3', 'R2.3 remove a project from the sidebar', async () => {
  await registerProject(KEEP, fx.rm);
  await refresh();
  assert(await project(KEEP, 'rm'), 'rm is not listed');
  const before = { worktrees: worktrees(fx.rm), branches: branches(fx.rm) };
  await click(`${pg(KEEP, 'rm')}.querySelector(':scope > .project-row ${tid('project-menu')}')`, 'menu of rm');
  const item = await ev(`(() => { const b = document.querySelector('body > .menu ${tid('project-remove')}'); return b ? { text: b.textContent, disabled: b.disabled } : null; })()`);
  eq(item, { text: '从侧边栏移除', disabled: false }, 'the menu item');
  await click(`document.querySelector('body > .menu ${tid('project-remove')}')`, '"remove from sidebar"');
  await waitFor(async () => !(await project(KEEP, 'rm')), 8000, 'rm gone from the sidebar');
  await refresh();
  assert(!(await project(KEEP, 'rm')), 'rm came back with the next refresh');
  assert(!(await projects(KEEP)).some((p) => p.id === fx.rm), 'the daemon still lists it');
  // nothing on disk was touched
  eq({ worktrees: worktrees(fx.rm), branches: branches(fx.rm) }, before, 'worktrees and branches on disk');
  assert(existsSync(join(fx.rm, 'README.md')) && existsSync(join(fx.rmSide, 'README.md')), 'a directory is missing');
  await evidence('R2.3', '#sidebar', mg(KEEP));
  // a new session anywhere in the repository brings it back
  const id = await terminalIn(KEEP, join(fx.rm, 'sub'));
  await refresh();
  const back = await project(KEEP, 'rm');
  assert(back, 'rm did not come back with a new session in rm/sub');
  assert(back.worktrees.find((w) => w.label === 'main')?.sessions.some((s) => s.id === id), `the new session is not under main: ${J(back.worktrees)}`);
  await endSession(KEEP, id);
  return 'removed: not shown, not listed by the daemon, 2 worktrees and 2 branches untouched; back after a session in rm/sub';
});

test('R2.4', 'R2.4 a project with sessions cannot be removed', async () => {
  const id = await terminalIn(KEEP, fx.rm);
  try {
    await refresh();
    await click(`${pg(KEEP, 'rm')}.querySelector(':scope > .project-row ${tid('project-menu')}')`, 'menu of rm');
    const item = await waitFor(() => ev(`(() => { const m = document.querySelector('body > .menu'); const b = m?.querySelector('${tid('project-remove')}'); return b ? { disabled: b.disabled, note: m.querySelector('.menu-note')?.textContent ?? '' } : null; })()`), 5000, 'the menu');
    eq(item, { disabled: true, note: '这个项目下还有会话，先结束会话才能移除' }, 'the menu item');
    await evidence('R2.4');
    // a click on it does nothing
    await ev(`document.querySelector('body > .menu ${tid('project-remove')}').click(), true`);
    await sleep(400);
    await closeMenus();
    await refresh();
    assert(await project(KEEP, 'rm'), 'the project was removed all the same');
    eq((await rest(KEEP, 'POST', '/api/v1/projects/remove', { id: fx.rm })).status, 409, 'the daemon, asked directly');
    return `disabled, with the note "${item.note}"`;
  } finally {
    await endSession(KEEP, id);
  }
});

test('R2.5', 'R2.5 a worktree removed outside the app', async () => {
  const px = join(K, 'prune-wt', 'x');
  git(fx.prune, 'worktree', 'add', '-q', '-b', 'px', px);
  const id = await terminalIn(KEEP, px);
  try {
    await refresh();
    const before = await worktreeRow(KEEP, 'prune', 'px');
    assert(before?.sessions.some((s) => s.id === id), `the session is not under px: ${J(await project(KEEP, 'prune'))}`);
    git(fx.prune, 'worktree', 'remove', '--force', px);
    await refresh();
    const p = await project(KEEP, 'prune');
    assert(!p.worktrees.some((w) => w.label === 'px') && !J(p).includes(`"label":"px"`), `the row px is still there: ${J(p.worktrees)}`);
    const s = p.sessions.find((x) => x.id === id);
    assert(s, `the session is no longer shown under the project: ${J(p)}`);
    assert(s.gone && s.meta === '目录已不存在', `the session row does not say its directory is gone: ${J(s)}`);
    await evidence('R2.5', '#sidebar', pg(KEEP, 'prune'));
    return `row px gone; session "${s.name}" under prune says "${s.meta}"`;
  } finally {
    await endSession(KEEP, id);
  }
});

test('R2.6', 'R2.6 a worktree outside the allowed directories is not listed', async () => {
  eq(worktrees(N).map((w) => w.path).sort(), [N, fx.outside].sort(), 'what git lists');
  const side = await sidebar(NARROW);
  const p = side.projects.find((x) => x.name === 'solo');
  assert(p, `solo is not listed: ${J(side.projects.map((x) => x.name))}`);
  assert(!J(side).includes('outside'), `the sidebar mentions the outside worktree: ${J(p)}`);
  eq(p.worktrees, [], 'worktree rows (the main directory alone shows no worktree level)');
  eq(p.branch, 'main', 'branch on the project row');
  const listedByDaemon = (await projects(NARROW)).flatMap((x) => x.worktrees.map((w) => w.path));
  eq(listedByDaemon, [N], 'worktrees the daemon lists');
  eq((await rest(NARROW, 'GET', `/api/v1/worktrees/status?path=${encodeURIComponent(fx.outside)}`)).status, 404, 'status of the outside worktree');
  return `git lists 2 worktrees, the sidebar and the daemon only ${N}`;
});

test('R2.7', 'R2.7 the worktree list cannot be read', async () => {
  // the repository directory disappears
  const a = await terminalIn(KEEP, fx.gone);
  // git fails in the repository
  const b = await terminalIn(KEEP, fx.broken);
  const moved = join(work, 'gone-moved');
  const headFile = join(fx.broken, '.git', 'HEAD');
  const headWas = readFileSync(headFile);
  try {
    await refresh();
    eq([(await project(KEEP, 'gone'))?.error, (await project(KEEP, 'broken'))?.error], [null, null], 'errors before');
    renameSync(fx.gone, moved);
    writeFileSync(headFile, 'not a ref\n');
    await refresh();
    const gone = await project(KEEP, 'gone');
    const broken = await project(KEEP, 'broken');
    eq(gone.error, '仓库目录不存在', 'the row of the missing repository');
    assert(/^读取失败：.+/.test(broken.error ?? ''), `the row of the broken repository: ${J(broken.error)}`);
    assert(gone.sessions.some((s) => s.id === a) && broken.sessions.some((s) => s.id === b), `sessions under the failed projects: ${J([gone.sessions, broken.sessions])}`);
    await evidence('R2.7', '#sidebar', pg(KEEP, 'gone'));
    // the sessions still open and work
    await openSession(a);
    await shell('echo GONE_$((20+2))_OK', 'GONE_22_OK');
    await openSession(b);
    await shell('echo BROKEN_$((30+3))_OK', 'BROKEN_33_OK');
    // the other projects of the machine are read as before
    assert((await sidebar(KEEP)).projects.filter((p) => !p.error).length >= 1, 'every project of the machine shows an error');
    return `gone: "${gone.error}"; broken: "${broken.error}"; both sessions take input`;
  } finally {
    if (existsSync(moved)) renameSync(moved, fx.gone);
    writeFileSync(headFile, headWas);
    await endSession(KEEP, a);
    await endSession(KEEP, b);
  }
});

// ---- R3 在项目里新建带名字的 worktree ------------------------------------------------

const confirmNewWorktree = async () => {
  await click(`${DLG('new-worktree-dialog')}.querySelector('${tid('dialog-confirm')}')`, 'confirm');
  await dialogGone(15000);
};
const pressEnterInName = async () => {
  await ev(`${NAME}.focus(), true`);
  await pressKey('Enter');
  await sleep(600);
};

test('R3.1', 'R3.1 new worktree fix-login with a chat session', async () => {
  const base = head(fx.webapp);
  const path = join(L, 'webapp-worktrees', 'fix-login');
  const before = new Set((await sessions(LAB)).map((s) => s.id));
  await openNewWorktreeDialog(LAB, 'webapp');
  eq(await text(`${DLG('new-worktree-dialog')}.querySelector('.modal-title')`), '在 webapp 新建 worktree', 'dialog title');
  const s = await typeName('fix-login');
  eq([s.error, s.target], ['', path], 'verdict on the name');
  await click(`${DLG('new-worktree-dialog')}.querySelector('${tid('picker-ui-chat')}')`, 'chat card');
  await waitFor(() => ev(`${DLG('new-worktree-dialog')}.querySelector('${tid('picker-ui-chat')}').getAttribute('aria-pressed') === 'true' && !${DLG('new-worktree-dialog')}.querySelector('${tid('dialog-confirm')}').disabled`), 5000, 'chat chosen');
  await confirmNewWorktree();
  const id = await waitNewSession(LAB, before, 'chat');
  const row = await waitFor(async () => { const r = await worktreeRow(LAB, 'webapp', 'fix-login'); return r?.sessions.some((x) => x.id === id) ? r : null; }, 10000, 'row fix-login with the new session');
  eq(row.tags, [], 'tags of the new row (made by vibe-remote: neither main nor external)');
  eq(row.sessions.find((x) => x.id === id).ui, 'chat', 'kind of the session');
  // on disk
  eq(head(fx.webapp, 'refs/heads/fix-login'), base, 'the new branch points at main\'s commit');
  eq(git(path, 'symbolic-ref', '--short', 'HEAD'), 'fix-login', 'branch checked out in the new directory');
  eq(git(path, 'status', '--porcelain'), '', 'state of the new worktree');
  assert(listed(fx.webapp, path), 'git does not list the new worktree');
  eq((await sessions(LAB)).find((x) => x.id === id).workdir, path, 'working directory of the session');
  await sendChat('echo hello from fix-login');
  await waitAssistant('hello from fix-login');
  await chatIdle();
  await evidence('R3.1');
  return `branch fix-login @ ${base.slice(0, 7)}, directory ${path}, chat session ${id}`;
});

test('R3.2', 'R3.2 a name with a slash', async () => {
  const path = join(L, 'webapp-worktrees', 'change-foo');
  const before = new Set((await sessions(LAB)).map((s) => s.id));
  await openNewWorktreeDialog(LAB, 'webapp');
  const s = await typeName('change/foo');
  eq([s.error, s.target], ['', path], 'verdict on the name');
  await confirmNewWorktree();
  const id = await waitNewSession(LAB, before);
  const row = await waitFor(() => worktreeRow(LAB, 'webapp', 'change/foo'), 10000, 'row change/foo');
  assert(row.sessions.some((x) => x.id === id), 'the new session is not under change/foo');
  assert(branchExists(fx.webapp, 'change/foo') && existsSync(join(path, 'README.md')) && listed(fx.webapp, path), `on disk: ${J(disk(fx.webapp, path, 'change/foo'))}`);
  const out = await shell('pwd; echo SLASH_$((4+4))_OK', 'SLASH_8_OK');
  assert(out.replace(/\n/g, '').includes(path), `the terminal is not in ${path}`);
  await evidence('R3.2', '#sidebar', wg(LAB, 'webapp', 'change/foo'));
  return `sidebar "change/foo", branch change/foo, directory ${path}`;
});

test('R3.3', 'R3.3 names that cannot be used', async () => {
  const container = join(L, 'webapp-worktrees');
  const state = () => J({ branches: branches(fx.webapp), worktrees: worktrees(fx.webapp).map((w) => w.path), dirs: readdirSync(container).sort() });
  const before = state();
  const count = (await sessions(LAB)).length;
  await openNewWorktreeDialog(LAB, 'webapp');
  eq((await nameState()).confirm, false, 'Confirm before anything is typed');
  const seen = [];
  for (const [name, why] of [['a b', '名字不能包含空格'], ['a..b', '名字不能包含 ..'], ['-x', '名字不能以 - 开头'], ['a~b', 'git 不接受这个分支名'], ['@{-1}', 'git 不接受这个分支名'], ['', '请填写名字']]) {
    await typeInto(NAME, name);
    const s = await waitFor(async () => { const x = await nameState(); return x.error !== '' && x.value === name ? x : null; }, 8000, `a reason for ${J(name)}`);
    eq(s.error, why, `reason shown for ${J(name)}`);
    eq(s.confirm, false, `Confirm with ${J(name)}`);
    await pressEnterInName();
    assert(await exists(DLG('new-worktree-dialog')), `Enter with ${J(name)} closed the dialog`);
    seen.push(`${J(name)} → ${s.error}`);
    if (name === 'a~b') await evidence('R3.3', '.modal-overlay .modal');
  }
  await cancelDialog();
  eq(state(), before, 'branches, worktrees and directories on disk');
  eq((await sessions(LAB)).length, count, 'sessions on the daemon');
  return seen.join('; ');
});

test('R3.4', 'R3.4 the branch already exists', async () => {
  const at = head(fx.webapp, 'refs/heads/taken-branch');
  const before = new Set((await sessions(LAB)).map((s) => s.id));
  await openNewWorktreeDialog(LAB, 'webapp');
  const s = await typeName('taken-branch');
  eq([s.error, s.confirm], ['分支 taken-branch 已存在', false], 'verdict on the name');
  await pressEnterInName();
  assert(await exists(DLG('new-worktree-dialog')), 'the dialog closed');
  eq((await nameState()).error, '分支 taken-branch 已存在', 'reason after Enter');
  await evidence('R3.4', '.modal-overlay .modal');
  assert(!existsSync(join(L, 'webapp-worktrees', 'taken-branch')), 'a directory was created');
  eq(head(fx.webapp, 'refs/heads/taken-branch'), at, 'the existing branch');
  // another name in the same dialog works
  const s2 = await typeName('taken-branch-2');
  eq([s2.error, s2.confirm], ['', true], 'verdict on the second name');
  await confirmNewWorktree();
  const id = await waitNewSession(LAB, before);
  assert(branchExists(fx.webapp, 'taken-branch-2') && listed(fx.webapp, join(L, 'webapp-worktrees', 'taken-branch-2')), 'the second name was not created');
  return `"${s.error}", dialog stayed open; taken-branch-2 then created (session ${id})`;
});

test('R3.5', 'R3.5 the directory already exists', async () => {
  const count = (await sessions(LAB)).length;
  await openNewWorktreeDialog(LAB, 'webapp');
  const s = await typeName('occupied');
  eq([s.error, s.confirm], [`目录已存在：${fx.occupied}`, false], 'verdict on the name');
  await pressEnterInName();
  assert(await exists(DLG('new-worktree-dialog')), 'the dialog closed');
  await evidence('R3.5', '.modal-overlay .modal');
  await cancelDialog();
  eq(readdirSync(fx.occupied), ['keep.txt'], 'content of the existing directory');
  eq(readFileSync(join(fx.occupied, 'keep.txt'), 'utf-8'), 'here first\n', 'the file in it');
  assert(!branchExists(fx.webapp, 'occupied') && !listed(fx.webapp, fx.occupied), 'a branch or a worktree was created');
  eq((await sessions(LAB)).length, count, 'sessions on the daemon');
  return s.error;
});

test('R3.6', 'R3.6 uncommitted changes where the worktree starts from', async () => {
  const readme = join(fx.webapp, 'README.md');
  const was = readFileSync(readme, 'utf-8');
  writeFileSync(readme, `${was}edited, not committed\n`);
  writeFileSync(join(fx.webapp, 'uncommitted.txt'), 'new, not committed\n');
  try {
    assert(git(fx.webapp, 'status', '--porcelain') !== '', 'the fixture has no uncommitted change');
    const at = head(fx.webapp);
    const before = new Set((await sessions(LAB)).map((s) => s.id));
    await openNewWorktreeDialog(LAB, 'webapp');
    const s = await nameState();
    eq(s.base, `基于 main @ ${at.slice(0, 7)}，不包含未提交的改动`, 'the line about the base');
    await evidence('R3.6', '.modal-overlay .modal');
    // and it is true
    const named = await typeName('after-dirty');
    eq(named.error, '', 'verdict on the name');
    await confirmNewWorktree();
    await waitNewSession(LAB, before);
    const path = join(L, 'webapp-worktrees', 'after-dirty');
    eq(head(path), at, 'commit of the new worktree');
    eq(git(path, 'status', '--porcelain'), '', 'state of the new worktree');
    assert(!existsSync(join(path, 'uncommitted.txt')), 'the untracked file was carried over');
    eq(readFileSync(join(path, 'README.md'), 'utf-8'), was, 'README in the new worktree');
    return `"${s.base}"; the new worktree is clean at ${at.slice(0, 7)}`;
  } finally {
    writeFileSync(readme, was);
    rmSync(join(fx.webapp, 'uncommitted.txt'), { force: true });
  }
});

// Confirms a new worktree `name` and cuts the connection after the daemon has
// created the session but before the desktop hears `ready`. `manual`: every
// reconnect fails until the user presses Retry in the banner.
async function createWithCutConnection(name, manual) {
  const before = new Set((await sessions(LAB)).map((s) => s.id));
  await openNewWorktreeDialog(LAB, 'webapp');
  const s = await typeName(name);
  eq(s.error, '', `verdict on ${name}`);
  await ev(`window.__vrNet.attaches.length = 0, window.__vrNet.cut = { name: ${J(name)}, done: false, offline: ${manual} }, true`);
  await confirmNewWorktree();
  await waitFor(() => ev('window.__vrNet.cut?.done === true'), 20000, 'connection cut before ready');
  const created = await ev('window.__vrNet.cut.readySessionId');
  if (manual) {
    const banner = `[...document.querySelectorAll('.reconnect-banner')].find((b) => b.style.display === 'flex')`;
    await waitFor(() => exists(banner), 15000, 'reconnect banner');
    await sleep(1500); // a few automatic attempts fail meanwhile
    eq(await activeId(), null, 'session shown while the create is unconfirmed');
    await ev('window.__vrNet.offline = false, true');
    await click(`${banner}.querySelector('.reconnect-banner-retry')`, 'Retry now');
  }
  const id = await waitNewSession(LAB, before);
  const sent = JSON.parse(await ev(`JSON.stringify(window.__vrNet.attaches.filter((a) => a.worktreeName === ${J(name)}))`));
  assert(sent.length >= 2, `the attach was sent ${sent.length} time(s)`);
  eq([...new Set(sent.map((a) => a.newSessionId))].length, 1, 'different session ids over the replays');
  eq(id, created, 'the session shown is the one the first attach created');
  eq(worktrees(fx.webapp).filter((w) => w.branch === name).length, 1, `worktrees on branch ${name}`);
  eq(branches(fx.webapp).filter((b) => b.split(' ')[0] === name).length, 1, `branches named ${name}`);
  eq(readdirSync(join(L, 'webapp-worktrees')).filter((d) => d.startsWith(name)), [name], 'directories');
  eq((await sessions(LAB)).filter((x) => x.branch === name).map((x) => x.id), [id], `sessions in ${name}`);
  await refresh();
  eq((await worktreeRow(LAB, 'webapp', name))?.sessions.map((x) => x.id), [id], 'sessions under the row');
  eq((await project(LAB, 'webapp')).worktrees.filter((w) => w.label === name).length, 1, 'rows for the name');
  await shell(`echo CUT_${manual ? 'M' : 'A'}_$((6*7))`, `CUT_${manual ? 'M' : 'A'}_42`);
  return `${sent.length} attaches with one id`;
}

test('R3.7', 'R3.7 the connection drops between confirming and ready', async () => {
  const auto = await createWithCutConnection('replay-auto', false);
  const manual = await createWithCutConnection('replay-manual', true);
  await evidence('R3.7', '#sidebar', wg(LAB, 'webapp', 'replay-manual'));
  return `automatic reconnect: ${auto}; Retry now: ${manual}; one worktree, one branch, one session each`;
});

test('R3.8', 'R3.8 git fails while creating', async () => {
  const meta = join(fx.failrepo, '.git', 'worktrees');
  const state = () => J({ branches: branches(fx.failrepo), worktrees: worktrees(fx.failrepo).map((w) => w.path), container: existsSync(join(L, 'failrepo-worktrees')) });
  const before = state();
  const count = (await sessions(LAB)).length;
  await openNewWorktreeDialog(LAB, 'failrepo');
  const s = await typeName('will-fail');
  eq([s.error, s.confirm], ['', true], 'verdict on the name (the pre-check cannot see this failure)');
  chmodSync(meta, 0o555);
  chmodBack.push([meta, 0o755]);
  await click(`${DLG('new-worktree-dialog')}.querySelector('${tid('dialog-confirm')}')`, 'confirm');
  const msg = await waitFor(async () => { const m = await statusMessage(); return m.startsWith('错误：') ? m : null; }, 20000, 'the error in the status bar');
  await evidence('R3.8');
  assert(/Permission denied|could not create|cannot|unable|failed/i.test(msg), `the message does not carry git's error: ${msg}`);
  await dialogGone();
  await refresh();
  assert(!(await worktreeRow(LAB, 'failrepo', 'will-fail')), 'a row for the failed worktree');
  eq(state(), before, 'branches, worktrees and the container directory on disk');
  eq((await sessions(LAB)).length, count, 'sessions on the daemon');
  eq(await activeId(), null, 'a session view left open');
  return msg;
});

test('R3.9', 'R3.9 Worktree mode from the machine overview asks for the name too', async () => {
  const before = new Set((await sessions(LAB)).map((s) => s.id));
  await openMachine(LAB);
  await click(`[...document.querySelectorAll('#machine-overview .workspace-mode-card')].find((c) => c.textContent.includes('创建隔离 Worktree'))`, 'the Worktree card');
  const modal = `document.querySelector('.modal-overlay .modal')`;
  await waitFor(() => ev(`${modal}?.querySelector('.modal-path')?.textContent === ${J(L)} && !!${modal}.querySelector('${tid('wt-name-input')}')`), 15000, 'picker in worktree mode');
  // the folder it opens in is not a repository
  const atRoot = await waitFor(async () => { const s = await nameState(); return s.error ? s : null; }, 8000, 'verdict on the starting folder');
  eq([atRoot.error, atRoot.disabled, atRoot.confirm], ['这个目录不在 git 仓库里', true, false], 'outside a repository');
  await click(`[...${modal}.querySelectorAll('.modal-item')].find((b) => b.querySelector('span')?.textContent === 'webapp')`, 'folder webapp');
  await waitFor(async () => (await ev(`${modal}.querySelector('.modal-path').textContent`)) === fx.webapp && !(await nameState()).disabled && (await nameState()).base !== '', 10000, 'picker in webapp');
  const empty = await nameState();
  eq([empty.value, empty.confirm], ['', false], 'Confirm with no name');
  assert(empty.base.startsWith('基于 main @ '), `the base line: ${empty.base}`);
  const bad = await typeName('a b');
  eq([bad.error, bad.confirm], ['名字不能包含空格', false], 'a name with a space');
  const taken = await typeName('taken-branch');
  eq([taken.error, taken.confirm], ['分支 taken-branch 已存在', false], 'an existing branch');
  const good = await typeName('from-overview');
  eq([good.error, good.target, good.confirm], ['', join(L, 'webapp-worktrees', 'from-overview'), true], 'a usable name');
  await evidence('R3.9');
  await click(`${modal}.querySelector('${tid('dialog-confirm')}')`, 'confirm');
  await dialogGone(15000);
  const id = await waitNewSession(LAB, before);
  assert(branchExists(fx.webapp, 'from-overview') && listed(fx.webapp, good.target), 'branch or worktree missing on disk');
  eq((await sessions(LAB)).find((x) => x.id === id).branch, 'from-overview', 'branch of the session');
  return `name field with the same rules; created branch from-overview (session ${id})`;
});

test('R3.10', 'R3.10 the new directory would be outside the allowed directories', async () => {
  const target = join(work, 'n', 'solo-worktrees', 'blocked');
  const p = await project(NARROW, 'solo');
  assert(p.buttons.includes('project-new-worktree'), `no enabled "new worktree" on solo: ${J(p.buttons)}`);
  await openNewWorktreeDialog(NARROW, 'solo');
  const s = await typeName('blocked');
  eq([s.error, s.confirm], [`目录不在允许的范围内：${target}`, false], 'verdict on the name');
  await pressEnterInName();
  assert(await exists(DLG('new-worktree-dialog')), 'the dialog closed');
  await evidence('R3.10', '.modal-overlay .modal');
  await cancelDialog();
  assert(!existsSync(join(work, 'n', 'solo-worktrees')) && !branchExists(N, 'blocked'), 'a directory or a branch was created');
  return s.error;
});

// ---- R4 在已有 worktree 里开会话 ----------------------------------------------------

test('R4.1', 'R4.1 "new session" on a worktree row', async () => {
  await openNewSessionDialog(WT, 'devflow', 'fix-login');
  const d = await ev(`(() => { const d = ${DLG('worktree-session-dialog')}; return {
    title: d.querySelector('.modal-title').textContent, where: d.querySelector('${tid('session-dialog-path')}').textContent,
    folders: d.querySelectorAll('.modal-list, .modal-item, .modal-path').length, modes: d.querySelectorAll('.modal-mode-card:not(.modal-ui-card)').length,
    name: !!d.querySelector('${tid('wt-name-input')}'), ui: [...d.querySelectorAll('.modal-ui-card')].map((c) => c.dataset.ui + ':' + c.getAttribute('aria-pressed')),
    flags: [...d.querySelectorAll('.modal-flag input')].map((i) => i.name), text: d.textContent }; })()`);
  eq(d.title, '在 fix-login 新建会话', 'dialog title');
  assert(d.where.includes('devflow') && d.where.includes(fx.fix.path), `the dialog does not show project and path: ${d.where}`);
  eq([d.folders, d.modes, d.name], [0, 0, false], 'folder list / session-mode cards / name field in the dialog');
  eq(d.ui, ['terminal:true', 'chat:false'], 'interface cards');
  eq(d.flags, ['claude-flag-continue'], 'launch options');
  assert(!d.text.includes('创建隔离 Worktree') && !d.text.includes('打开现有目录'), 'the dialog offers session modes');
  await evidence('R4.1');
  await cancelDialog();
  return `"${d.title}" · ${d.where}`;
});

test('R4.2', 'R4.2 a worktree under a hidden directory', async () => {
  assert(fx.general.includes('/.devflow-tmp/'), 'the fixture worktree is not under a hidden directory');
  const id = await newSessionVia(WT, 'devflow', 'change/general-skills');
  const out = await shell('pwd; echo HIDDEN_$((9+9))_OK', 'HIDDEN_18_OK');
  assert(out.replace(/\n/g, '').includes(fx.general), `pwd is not ${fx.general}:\n${out}`);
  eq((await sessions(WT)).find((s) => s.id === id).workdir, fx.general, 'working directory the daemon reports');
  assert((await worktreeRow(WT, 'devflow', 'change/general-skills')).sessions.some((s) => s.id === id), 'the session is not under its worktree row');
  await evidence('R4.2');
  return `terminal session ${id} runs in ${fx.general}`;
});

test('R4.3', 'R4.3 chat in a worktree whose main directory is trusted', async () => {
  const trust = Object.keys(JSON.parse(readFileSync(join(WT.env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf-8')).projects);
  eq(trust, [fx.devflow], 'directories claude trusts on this-mac');
  const id = await newSessionVia(WT, 'devflow', 'change/general-skills', { ui: 'chat' });
  eq((await sessions(WT)).find((s) => s.id === id).workdir, fx.general, 'working directory of the chat session');
  await sendChat('echo trusted through main');
  await waitAssistant('trusted through main');
  await chatIdle();
  await evidence('R4.3');
  return `chat session ${id} in ${fx.general}; only ${fx.devflow} is in the trust file`;
});

test('R4.4', 'R4.4 neither the main directory nor the worktree is trusted', async () => {
  const before = new Set((await sessions(LAB)).map((s) => s.id));
  await openNewSessionDialog(LAB, 'untrusted', 'topic-a');
  const dlg = DLG('worktree-session-dialog');
  const st = await ev(`({ chatDisabled: ${dlg}.querySelector('${tid('picker-ui-chat')}').disabled, reason: ${dlg}.querySelector('${tid('picker-ui-chat-reason')}').textContent,
    terminal: ${dlg}.querySelector('${tid('picker-ui-terminal')}').getAttribute('aria-pressed'), terminalDisabled: ${dlg}.querySelector('${tid('picker-ui-terminal')}').disabled, confirm: !${dlg}.querySelector('${tid('dialog-confirm')}').disabled })`);
  eq(st, { chatDisabled: true, reason: `先用终端界面在项目主目录 ${fx.untrusted} 打开一次 claude，信任这个项目后才能用对话界面。`, terminal: 'true', terminalDisabled: false, confirm: true }, 'the interface cards');
  await ev(`${dlg}.querySelector('${tid('picker-ui-chat')}').click(), true`);
  eq(await ev(`${dlg}.querySelector('${tid('picker-ui-chat')}').getAttribute('aria-pressed')`), 'false', 'chat card after a click');
  await evidence('R4.4');
  // the terminal interface does work there
  await click(`${dlg}.querySelector('${tid('dialog-confirm')}')`, 'confirm');
  await dialogGone();
  const id = await waitNewSession(LAB, before);
  await shell('echo UNTRUSTED_$((5+5))_TERM', 'UNTRUSTED_10_TERM');
  await endSession(LAB, id);
  return st.reason;
});

test('R4.5', 'R4.5 a second session in the same worktree', async () => {
  const had = (await worktreeRow(WT, 'devflow', 'fix-login')).sessions.map((s) => s.id);
  assert(had.includes(fx.fix.id), 'fix-login has no session to begin with');
  const id = await newSessionVia(WT, 'devflow', 'fix-login');
  const row = await waitFor(async () => { const r = await worktreeRow(WT, 'devflow', 'fix-login'); return r.sessions.some((s) => s.id === id) ? r : null; }, 10000, 'the second session under fix-login');
  eq(row.sessions.length, had.length + 1, 'sessions under fix-login');
  const names = row.sessions.map((s) => s.name);
  assert(new Set(names).size === names.length, `two sessions show the same name: ${J(names)}`);
  // both run and take input
  await shell('echo SECOND_$((2+2))_HERE', 'SECOND_4_HERE');
  await openSession(fx.fix.id);
  await shell('echo FIRST_$((3+3))_HERE', 'FIRST_6_HERE');
  const live = (await sessions(WT)).filter((s) => [id, fx.fix.id].includes(s.id));
  eq(live.map((s) => s.workdir), [fx.fix.path, fx.fix.path], 'working directories of the two');
  await evidence('R4.5', '#sidebar', wg(WT, 'devflow', 'fix-login'));
  return `fix-login: ${names.join(' | ')}; both take input`;
});

test('R4.6', 'R4.6 the worktree itself is trusted, the main directory is not', async () => {
  const trust = Object.keys(JSON.parse(readFileSync(join(LAB.env.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf-8')).projects);
  assert(trust.includes(fx.selftrustWt) && !trust.includes(fx.selftrust), `trust file: ${J(trust)}`);
  const id = await newSessionVia(LAB, 'selftrust', 'topic-b', { ui: 'chat' });
  await sendChat('echo trusted by itself');
  await waitAssistant('trusted by itself');
  await chatIdle();
  await endSession(LAB, id);
  return `chat session ${id} in ${fx.selftrustWt}`;
});

// ---- R5 会话与 worktree 分开收尾 ------------------------------------------------------
// Every case reads the disk itself afterwards: the directory, git's worktree
// list, the branch, and whether the commits can still be reached.

const unmerged = (repo, branch) => Number(git(repo, 'rev-list', '--count', `main..${branch}`));
const containedIn = (repo, sha) => git(repo, 'for-each-ref', '--contains', sha, '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
const confirmDelete = async (testid = 'dialog-confirm') => { await click(`${DLG('delete-wt-dialog')}.querySelector('${tid(testid)}')`, testid); };
/** Waits until the sidebar no longer has the row, asking for refreshes meanwhile. */
const rowGone = (d, proj, label) => waitFor(async () => { await refresh(); return !(await worktreeRow(d, proj, label)); }, 20000, `row ${proj} / ${label} gone`, 400);
const rowShown = (d, proj, label) => waitFor(async () => { await refresh(); return worktreeRow(d, proj, label); }, 15000, `row ${proj} / ${label}`, 400);

test('R5.1', 'R5.1 deleting a session keeps its worktree, branch and commits', async () => {
  const w = await managedWorktree(LAB, fx.del, 'r51', { keep: true });
  commits(w.path, 2);
  const tip = head(w.path);
  await rowShown(LAB, 'del', 'r51');
  await click(`${srow(w.id)}?.querySelector('.session-close')`, 'delete button of the session row');
  await waitDialog('delete-session-dialog');
  const d = await ev(`(() => { const d = ${DLG('delete-session-dialog')}; return { title: d.querySelector('.modal-title').textContent, note: d.querySelector('${tid('delete-session-note')}')?.textContent ?? null, focus: document.activeElement?.dataset.testid ?? null }; })()`);
  eq(d.note, 'worktree r51 的目录和分支都会保留，之后可以在侧边栏继续使用，或者单独删除。', 'what the confirmation says about the worktree');
  eq(d.focus, 'dialog-cancel', 'button with the focus');
  await evidence('R5.1');
  await click(`${DLG('delete-session-dialog')}.querySelector('${tid('dialog-confirm')}')`, 'delete session');
  await dialogGone();
  await waitFor(async () => !(await sessions(LAB)).some((s) => s.id === w.id), 10000, 'session gone on the daemon');
  const row = await waitFor(async () => { await refresh(); const r = await worktreeRow(LAB, 'del', 'r51'); return r && r.sessions.length === 0 ? r : null; }, 10000, 'row r51 without sessions');
  eq(row.empty, '没有会话', 'what the row says');
  eq(disk(fx.del, w.path, 'r51'), { dir: true, listed: true, branch: true }, 'on disk');
  eq([head(fx.del, 'refs/heads/r51'), unmerged(fx.del, 'r51')], [tip, 2], 'tip of the branch and its unmerged commits');
  return `"${d.note}"; afterwards the directory, branch r51 and its 2 commits are there, the row says "${row.empty}"`;
});

test('R5.2', 'R5.2 deleting a clean, merged worktree removes the directory and the branch', async () => {
  const w = await managedWorktree(LAB, fx.del, 'r52');
  await rowShown(LAB, 'del', 'r52');
  eq(disk(fx.del, w.path, 'r52'), { dir: true, listed: true, branch: true }, 'before');
  await openDeleteWorktree(LAB, 'del', 'r52');
  const d = await deleteDialog();
  eq([d.variant, d.title, d.files, d.commits, d.sessions, d.ignored], ['clean', '删除 worktree r52？', null, null, null, null], 'the confirmation');
  assert(d.text.includes('目录和分支都会删除'), `the confirmation does not say what goes: ${d.text}`);
  eq(d.default, 'dialog-confirm', 'default button');
  await evidence('R5.2');
  await confirmDelete();
  await dialogGone(20000);
  await rowGone(LAB, 'del', 'r52');
  eq(disk(fx.del, w.path, 'r52'), { dir: false, listed: false, branch: false }, 'on disk');
  assert(branchExists(fx.del, 'main') && existsSync(join(fx.del, 'README.md')), 'the main directory was touched');
  return 'row gone; directory, worktree entry and branch r52 gone';
});

test('R5.3', 'R5.3 uncommitted and untracked files: Enter cancels, "delete anyway" deletes', async () => {
  const w = await managedWorktree(LAB, fx.del, 'r53');
  writeFileSync(join(w.path, 'README.md'), 'changed\n');
  writeFileSync(join(w.path, 'staged.txt'), 'staged\n');
  git(w.path, 'add', 'staged.txt');
  writeFileSync(join(w.path, 'untracked.txt'), 'untracked\n');
  const dirty = () => git(w.path, 'status', '--porcelain').split('\n').filter(Boolean).length;
  eq(dirty(), 3, 'dirty files in the fixture');
  await rowShown(LAB, 'del', 'r53');
  await openDeleteWorktree(LAB, 'del', 'r53');
  const d = await deleteDialog();
  eq([d.variant, d.files], ['files', '有 3 个文件未提交或未跟踪。删除 worktree 会丢弃它们，无法恢复。'], 'the warning');
  eq([d.focus, d.default], ['dialog-cancel', 'dialog-cancel'], 'focused / default button');
  assert(d.buttons.includes('delete-wt-force=仍然删除'), `buttons: ${J(d.buttons)}`);
  eq(d.hint, '回车 = 取消', 'what the footer says about Enter');
  await evidence('R5.3');
  await pressKey('Enter');
  await dialogGone();
  await refresh();
  assert(await worktreeRow(LAB, 'del', 'r53'), 'Enter removed the row');
  eq([disk(fx.del, w.path, 'r53'), dirty()], [{ dir: true, listed: true, branch: true }, 3], 'on disk after Enter');
  await openDeleteWorktree(LAB, 'del', 'r53');
  await confirmDelete('delete-wt-force');
  await dialogGone(20000);
  await rowGone(LAB, 'del', 'r53');
  // the branch had nothing of its own, and the confirmation said it goes too
  assert(d.text.includes('分支 r53 上的提交都已包含在其他分支里，分支会一并删除。'), `nothing said about the branch: ${d.text}`);
  eq(disk(fx.del, w.path, 'r53'), { dir: false, listed: false, branch: false }, 'on disk after "delete anyway"');
  return `"${d.files}"; Enter changed nothing; "仍然删除" removed the directory`;
});

test('R5.4', 'R5.4 only ignored files: treated as clean, with their number', async () => {
  const w = await managedWorktree(LAB, fx.del, 'r54');
  mkdirSync(join(w.path, 'node_modules', 'a', 'b'), { recursive: true });
  for (const f of ['node_modules/x.js', 'node_modules/a/y.js', 'node_modules/a/b/z.js', '.env']) writeFileSync(join(w.path, f), 'ignored\n');
  eq(git(w.path, 'status', '--porcelain'), '', 'git status of the fixture');
  const ignored = git(w.path, 'ls-files', '--others', '--ignored', '--exclude-standard').split('\n').filter(Boolean).length;
  eq(ignored, 4, 'ignored files in the fixture');
  await rowShown(LAB, 'del', 'r54');
  await openDeleteWorktree(LAB, 'del', 'r54');
  const d = await deleteDialog();
  eq([d.variant, d.files, d.ignored], ['clean', null, `另有 ${ignored} 个被 git 忽略的文件会一并删除。`], 'the confirmation');
  eq(d.default, 'dialog-confirm', 'default button');
  await evidence('R5.4');
  await confirmDelete();
  await dialogGone(20000);
  await rowGone(LAB, 'del', 'r54');
  eq(disk(fx.del, w.path, 'r54'), { dir: false, listed: false, branch: false }, 'on disk');
  return `clean form, "${d.ignored}" (R5.2 checks that a worktree without ignored files has no such line)`;
});

test('R5.5', 'R5.5 unmerged commits: keep the branch (default) or delete it too', async () => {
  const a = await managedWorktree(LAB, fx.del, 'r55');
  commits(a.path, 2);
  const b = await managedWorktree(LAB, fx.del, 'r55b');
  commits(b.path, 2);
  const [tipA, tipB] = [head(a.path), head(b.path)];
  await rowShown(LAB, 'del', 'r55b');
  await openDeleteWorktree(LAB, 'del', 'r55');
  const d = await deleteDialog();
  eq([d.variant, d.title, d.commits], ['commits', 'r55 有 2 个未合并的提交', '这 2 个提交不在其他任何本地分支或远程分支上。'], 'the confirmation');
  eq([d.keep, d.drop, d.default], [true, false, 'dialog-confirm'], 'preselected choice and default button');
  assert(d.text.includes('只删目录、保留分支') && d.text.includes('目录和分支都删'), `the two choices: ${d.text}`);
  await evidence('R5.5');
  await pressKey('Enter'); // the default: directory only
  await dialogGone(20000);
  await rowGone(LAB, 'del', 'r55');
  eq(disk(fx.del, a.path, 'r55'), { dir: false, listed: false, branch: true }, 'on disk after the default');
  eq([head(fx.del, 'refs/heads/r55'), unmerged(fx.del, 'r55')], [tipA, 2], 'branch r55 and its commits');
  // the other choice
  await openDeleteWorktree(LAB, 'del', 'r55b');
  await click(`${DLG('delete-wt-dialog')}.querySelector('${tid('delete-wt-delete-branch')}')`, '"directory and branch"');
  const chosen = await deleteDialog();
  eq([chosen.keep, chosen.drop, chosen.default], [false, true, 'dialog-cancel'], 'after choosing to delete the branch (Enter must not lose commits)');
  await confirmDelete();
  await dialogGone(20000);
  await rowGone(LAB, 'del', 'r55b');
  eq(disk(fx.del, b.path, 'r55b'), { dir: false, listed: false, branch: false }, 'on disk after "directory and branch"');
  eq(containedIn(fx.del, tipB), [], 'branches that still contain the dropped commits');
  return 'default: directory gone, branch r55 keeps its 2 commits; "目录和分支都删": branch r55b gone as well';
});

test('R5.6', 'R5.6 a worktree with two running sessions', async () => {
  const w = await managedWorktree(LAB, fx.del, 'r56', { keep: true });
  const chat = await chatIn(LAB, w.path);
  await waitFor(async () => { await refresh(); return (await worktreeRow(LAB, 'del', 'r56'))?.sessions.length === 2; }, 15000, 'two sessions under r56');
  // both open here, the chat one on screen
  await openSession(w.id);
  await openSession(chat);
  const viewsBefore = await ev(`document.querySelectorAll('#terminal-container .term-instance, #terminal-container .chat-instance').length`);
  await openDeleteWorktree(LAB, 'del', 'r56');
  const d = await deleteDialog();
  eq([d.variant, d.sessions], ['clean', '会先结束这 2 个会话。'], 'the confirmation');
  await evidence('R5.6');
  await confirmDelete();
  await dialogGone(30000);
  await waitFor(async () => !(await sessions(LAB)).some((s) => [w.id, chat].includes(s.id)), 20000, 'both sessions ended');
  await rowGone(LAB, 'del', 'r56');
  eq(disk(fx.del, w.path, 'r56'), { dir: false, listed: false, branch: false }, 'on disk');
  const viewsAfter = await ev(`document.querySelectorAll('#terminal-container .term-instance, #terminal-container .chat-instance').length`);
  eq(viewsBefore - viewsAfter, 2, 'session views closed');
  assert(![w.id, chat].includes(await activeId()), 'an ended session is still the one shown');
  return `"${d.sessions}"; both ended, their views closed, worktree removed as a clean one`;
});

test('R5.7', 'R5.7 the main directory cannot be deleted', async () => {
  await managedWorktree(LAB, fx.del, 'r57');
  const p = await waitFor(async () => { await refresh(); const x = await project(LAB, 'del'); return x?.worktrees.some((w) => w.label === 'r57') ? x : null; }, 15000, 'del with two rows');
  const main = p.worktrees.find((w) => w.label === 'main');
  const other = p.worktrees.find((w) => w.label === 'r57');
  assert(main.tags.includes('worktree-tag-main'), 'no main row');
  assert(!main.buttons.some((b) => b.startsWith('worktree-menu')), `the main row has a menu: ${J(main.buttons)}`);
  assert(other.buttons.includes('worktree-menu'), `the other row has no menu: ${J(other.buttons)}`);
  // the project's own menu offers no deletion either
  await click(`${pg(LAB, 'del')}.querySelector(':scope > .project-row ${tid('project-menu')}')`, 'menu of del');
  const items = await ev(`[...document.querySelectorAll('body > .menu .menu-item')].map((b) => b.textContent)`);
  eq(items, ['从侧边栏移除'], 'items of the project menu');
  await closeMenus();
  // a flat project (its only directory is the main one) has no worktree menu at all
  assert(!(await project(WT, 'new-api')).buttons.some((b) => b.startsWith('worktree-menu')), 'new-api offers a worktree menu');
  const r = await rest(LAB, 'POST', '/api/v1/worktrees/remove', { path: fx.del, head: head(fx.del), sessions: [] });
  eq([r.status, (await r.json()).error], [400, 'worktree_is_main'], 'the daemon, asked directly');
  assert(existsSync(join(fx.del, '.git')), 'the main directory is gone');
  return `main row buttons ${J(main.buttons)}; other row has the menu; daemon answers 400 worktree_is_main`;
});

test('R5.8', 'R5.8 a worktree vibe-remote did not create: directory only, the branch stays', async () => {
  const path = join(L, 'del-ext', 'tool');
  git(fx.del, 'worktree', 'add', '-q', '-b', 'ext/tool', path);
  const row = await rowShown(LAB, 'del', 'ext/tool');
  assert(row.tags.includes('worktree-tag-external'), `not marked external: ${J(row.tags)}`);
  // the file warning applies to it as well
  writeFileSync(join(path, 'scratch.txt'), 'untracked\n');
  await openDeleteWorktree(LAB, 'del', 'ext/tool');
  const warned = await deleteDialog();
  eq([warned.variant, warned.files, warned.default], ['files', '有 1 个文件未提交或未跟踪。删除 worktree 会丢弃它们，无法恢复。', 'dialog-cancel'], 'with an untracked file');
  eq(warned.external, '这个 worktree 不是由 vibe-remote 创建：只删目录，分支 ext/tool 保留。', 'the line about who created it');
  await cancelDialog();
  assert(existsSync(join(path, 'scratch.txt')), 'cancel removed something');
  rmSync(join(path, 'scratch.txt'));
  await openDeleteWorktree(LAB, 'del', 'ext/tool');
  const d = await deleteDialog();
  eq([d.variant, d.external, d.keep, d.drop], ['external', '这个 worktree 不是由 vibe-remote 创建：只删目录，分支 ext/tool 保留。', null, null], 'the confirmation (no branch choice)');
  await evidence('R5.8');
  await confirmDelete();
  await dialogGone(20000);
  await rowGone(LAB, 'del', 'ext/tool');
  eq(disk(fx.del, path, 'ext/tool'), { dir: false, listed: false, branch: true }, 'on disk');
  eq(git(fx.del, 'branch', '--list', 'ext/tool').trim(), 'ext/tool', 'git branch --list ext/tool');
  return `"${d.external}"; directory gone, branch ext/tool still listed`;
});

test('R5.9', 'R5.9 failures found before anything is touched: locked, nested worktree', async () => {
  // locked, with a session inside
  const w = await managedWorktree(LAB, fx.del, 'r59', { keep: true });
  git(fx.del, 'worktree', 'lock', '--reason', 'usb', w.path);
  // another worktree of the repository inside an ignored directory of this one
  const outer = await managedWorktree(LAB, fx.del, 'r59b');
  const inner = join(outer.path, 'node_modules', 'inner');
  mkdirSync(join(outer.path, 'node_modules'));
  git(fx.del, 'worktree', 'add', '-q', '-b', 'r59-inner', inner);
  writeFileSync(join(inner, 'wip.txt'), 'not committed\n');
  try {
    await rowShown(LAB, 'del', 'r59b');
    await openSession(w.id);
    await shell('echo BEFORE_$((1+2))_LOCK', 'BEFORE_3_LOCK');
    await openDeleteWorktree(LAB, 'del', 'r59');
    eq((await deleteDialog()).sessions, '会先结束这 1 个会话。', 'the confirmation');
    await confirmDelete();
    const d = await waitFor(async () => { const x = await deleteDialog(); return x?.error ? x : null; }, 20000, 'the reason in the dialog');
    assert(d.error.startsWith('删除失败：') && /lock/i.test(d.error) && d.error.includes('usb'), `the reason: ${d.error}`);
    eq([d.ended, d.sessions], [null, '会先结束这 1 个会话。'], 'what the dialog says about sessions');
    await evidence('R5.9');
    const small = await fitsSmallWindow('the confirmation with an error');
    await cancelDialog();
    assert((await sessions(LAB)).some((s) => s.id === w.id), 'the session was ended');
    eq(await activeId(), w.id, 'the session shown');
    await shell('echo AFTER_$((2+3))_LOCK', 'AFTER_5_LOCK');
    await refresh();
    assert((await worktreeRow(LAB, 'del', 'r59'))?.sessions.some((s) => s.id === w.id), 'row r59 or its session is gone');
    eq(disk(fx.del, w.path, 'r59'), { dir: true, listed: true, branch: true }, 'r59 on disk');

    await openDeleteWorktree(LAB, 'del', 'r59b');
    await confirmDelete();
    const n = await waitFor(async () => { const x = await deleteDialog(); return x?.error ? x : null; }, 20000, 'the reason in the dialog');
    assert(n.error.includes(inner), `the reason does not name the worktree inside: ${n.error}`);
    await cancelDialog();
    await refresh();
    eq([disk(fx.del, outer.path, 'r59b'), disk(fx.del, inner, 'r59-inner')], [{ dir: true, listed: true, branch: true }, { dir: true, listed: true, branch: true }], 'both worktrees on disk');
    eq(readFileSync(join(inner, 'wip.txt'), 'utf-8'), 'not committed\n', 'the uncommitted file inside');
    assert(await worktreeRow(LAB, 'del', 'r59b'), 'row r59b is gone');
    return `locked: "${d.error}" (fits 800×500: ${small.buttons.length} buttons reachable), session still takes input; nested: "${n.error}"`;
  } finally {
    gitRun(fx.del, 'worktree', 'unlock', w.path);
    await endSession(LAB, w.id);
  }
});

test('R5.10', 'R5.10 a desktop that only sends DELETE /sessions/{id} loses no commits', async () => {
  const a = await managedWorktree(LAB, fx.del, 'r510', { keep: true });
  commits(a.path, 2);
  const b = await managedWorktree(LAB, fx.del, 'r510b', { keep: true });
  writeFileSync(join(b.path, 'wip.txt'), 'not committed\n');
  const tip = head(a.path);
  // what the previous desktop does: nothing but this request
  const ra = await endSession(LAB, a.id);
  const rb = await endSession(LAB, b.id);
  eq([ra.status, rb.status], [204, 204], 'answers to DELETE (never 409 worktree_preserved)');
  eq([disk(fx.del, a.path, 'r510'), disk(fx.del, b.path, 'r510b')], [{ dir: true, listed: true, branch: true }, { dir: true, listed: true, branch: true }], 'on disk');
  eq([head(fx.del, 'refs/heads/r510'), unmerged(fx.del, 'r510')], [tip, 2], 'branch r510 and its commits');
  assert(existsSync(join(b.path, 'wip.txt')), 'the uncommitted file is gone');
  const rows = await waitFor(async () => { await refresh(); const p = await project(LAB, 'del'); const r = p?.worktrees.filter((w) => ['r510', 'r510b'].includes(w.label)); return r?.length === 2 ? r : null; }, 15000, 'both rows');
  eq(rows.map((r) => r.empty), ['没有会话', '没有会话'], 'what the rows say');
  return 'clean with 2 unmerged commits → 204; with an uncommitted file → 204; directories, branches, commits and the file are there';
});

test('R5.11', 'R5.11 a worktree on no branch', async () => {
  const path = join(L, 'del-det', 'loose');
  git(fx.del, 'worktree', 'add', '-q', '--detach', path);
  commits(path, 2);
  const tip = head(path);
  const label = tip.slice(0, 7);
  await rowShown(LAB, 'del', label);
  await openDeleteWorktree(LAB, 'del', label);
  const d = await deleteDialog();
  eq([d.variant, d.commits], ['detached', '这 2 个提交删除后不再属于任何分支，无法恢复。'], 'the warning');
  eq([d.focus, d.default], ['dialog-cancel', 'dialog-cancel'], 'focused / default button');
  await evidence('R5.11');
  await pressKey('Enter');
  await dialogGone();
  eq([disk(fx.del, path), head(path)], [{ dir: true, listed: true, branch: null }, tip], 'on disk after Enter');
  await openDeleteWorktree(LAB, 'del', label);
  await confirmDelete('delete-wt-force');
  await dialogGone(20000);
  await rowGone(LAB, 'del', label);
  eq(disk(fx.del, path), { dir: false, listed: false, branch: null }, 'on disk after "delete anyway"');
  eq(containedIn(fx.del, tip), [], 'branches that contain the two commits');
  // without such commits it is an ordinary deletion: no warning, Enter deletes
  const clean = (await project(WT, 'devflow')).worktrees.find((w) => w.path === fx.detached);
  await openDeleteWorktree(WT, 'devflow', clean.label);
  const c = await deleteDialog();
  assert(c.commits === null && c.files === null && c.default === 'dialog-confirm', `a detached worktree with nothing to lose still warns: ${J(c)}`);
  assert(c.text.includes('工作区是干净的，没有不属于任何分支的提交。只删除目录。'), `what it says: ${c.text}`);
  await cancelDialog();
  return `"${d.commits}"; Enter changed nothing; "仍然删除" removed it; a clean detached worktree gets the plain confirmation`;
});

test('R5.12', 'R5.12 failures after the sessions were ended are reported as they are', async () => {
  // git fails at `worktree remove` and removes nothing
  const fa = join(K, 'fail-wt', 'a');
  git(fx.fail, 'worktree', 'add', '-q', '-b', 'fa', fa);
  const s1 = await terminalIn(KEEP, fa);
  const s2 = await terminalIn(KEEP, fa);
  // git drops the worktree from its list but cannot delete all of the directory
  const fb = join(K, 'fail2-wt', 'b');
  git(fx.fail2, 'worktree', 'add', '-q', '-b', 'fb', fb);
  mkdirSync(join(fb, 'locked'));
  writeFileSync(join(fb, 'locked', 'file.txt'), 'git cannot delete this\n');
  git(fb, 'add', 'locked/file.txt');
  git(fb, 'commit', '-q', '-m', 'a file git will not be able to delete');
  const s3 = await terminalIn(KEEP, fb);
  await waitFor(async () => { await refresh(); return (await worktreeRow(KEEP, 'fail', 'fa'))?.sessions.length === 2 && (await worktreeRow(KEEP, 'fail2', 'fb'))?.sessions.length === 1; }, 15000, 'rows fa and fb with their sessions');

  await openSession(s1);
  writeFileSync(gitFailFlag, '');
  await openDeleteWorktree(KEEP, 'fail', 'fa');
  eq((await deleteDialog()).sessions, '会先结束这 2 个会话。', 'the confirmation');
  await confirmDelete();
  const d = await waitFor(async () => { const x = await deleteDialog(); return x?.error ? x : null; }, 30000, 'the error in the dialog');
  assert(d.error.includes('simulated failure of worktree remove'), `git's error is not shown: ${d.error}`);
  eq([d.ended, d.sessions], ['已结束 2 个会话。', null], 'what the dialog says about sessions');
  await evidence('R5.12');
  await cancelDialog();
  rmSync(gitFailFlag, { force: true });
  assert(!(await sessions(KEEP)).some((s) => [s1, s2].includes(s.id)), 'a session the dialog reported as ended is still running');
  assert(![s1, s2].includes(await activeId()) && !(await exists(srow(s1))), 'the view or the row of an ended session is still there');
  const row = await waitFor(async () => { await refresh(); const r = await worktreeRow(KEEP, 'fail', 'fa'); return r && r.sessions.length === 0 ? r : null; }, 10000, 'row fa without sessions');
  eq(row.empty, '没有会话', 'what row fa says');
  eq(disk(fx.fail, fa, 'fa'), { dir: true, listed: true, branch: true }, 'fa on disk');

  chmodSync(join(fb, 'locked'), 0o555);
  chmodBack.push([join(fb, 'locked'), 0o755]);
  await openDeleteWorktree(KEEP, 'fail2', 'fb');
  await confirmDelete();
  await waitDialog('delete-wt-failed', 30000);
  const f = await ev(`(() => { const d = ${DLG('delete-wt-failed')}; const t = (id) => d.querySelector('[data-testid="' + id + '"]')?.textContent ?? null; return { title: d.querySelector('.modal-title').textContent, error: t('delete-wt-error'), ended: t('delete-wt-ended'), partial: t('delete-wt-partial'), buttons: [...d.querySelectorAll('.modal-footer button')].map((b) => b.textContent) }; })()`);
  assert(/failed to delete|Permission denied/i.test(f.error), `git's error is not shown: ${f.error}`);
  eq([f.ended, f.buttons], ['已结束 1 个会话。', ['关闭']], 'ended sessions / buttons');
  assert(f.partial.includes(fb) && f.partial.includes('分支没有删除'), `what is left: ${f.partial}`);
  const small = await fitsSmallWindow('the failure note');
  await click(`${DLG('delete-wt-failed')}.querySelector('${tid('dialog-cancel')}')`, 'close');
  await dialogGone();
  await rowGone(KEEP, 'fail2', 'fb');
  eq(disk(fx.fail2, fb, 'fb'), { dir: true, listed: false, branch: true }, 'fb on disk');
  assert(existsSync(join(fb, 'locked', 'file.txt')), 'the undeletable file is gone');
  assert(!(await sessions(KEEP)).some((s) => s.id === s3), 'the session of fb is still running');
  return `git refuses: "${d.error}" + "${d.ended}", directory and branch kept; half-deleted: "${f.partial}" (fits 800×500: ${small.buttons.join(', ')})`;
});

// ---- R6 `-c` 的后果写在新建对话框里 ---------------------------------------------------

const CONTINUE = `document.querySelector('.modal-overlay .modal-flag input[name="claude-flag-continue"]')`;
const continueNote = () => ev(`(() => { const n = document.querySelector('.modal-overlay ${tid('continue-note')}'); return n && n.getClientRects().length > 0 ? n.textContent : null; })()`);

test('R6.1', 'R6.1 -c where a session already runs: the note, and Confirm stays on', async () => {
  assert((await sessions(WT)).some((s) => s.id === fx.mainChat && s.workdir === fx.devflow && s.state !== 'ended'), 'no running chat session in devflow main');
  await openNewSessionDialog(WT, 'devflow', 'main');
  eq(await continueNote(), null, 'the note before the option is ticked');
  await click(CONTINUE, 'the continue option');
  const said = await waitFor(continueNote, 5000, 'the note');
  eq(said, '这个目录已有会话正在用最近那段对话：对话界面会切到已有的那个会话，终端界面可能无法启动。不勾选即可开一段新对话。', 'the note');
  eq(await ev(`document.querySelector('.modal-overlay ${tid('dialog-confirm')}').disabled`), false, 'Confirm disabled');
  await evidence('R6.1');
  await click(CONTINUE, 'the continue option again');
  eq(await continueNote(), null, 'the note once the option is unticked');
  await cancelDialog();
  return said;
});

test('R6.2', 'R6.2 -c where no session runs: no note', async () => {
  const row = (await project(WT, 'devflow')).worktrees.find((w) => w.path === fx.detached);
  eq(row.sessions, [], 'sessions in the worktree');
  await openNewSessionDialog(WT, 'devflow', row.label);
  await click(CONTINUE, 'the continue option');
  await sleep(400);
  eq(await ev(`${CONTINUE}.checked`), true, 'the option is ticked');
  eq(await continueNote(), null, 'the note');
  eq(await ev(`!!document.querySelector('.modal-overlay ${tid('continue-note')}')`), false, 'the note is in the dialog at all');
  await cancelDialog();
  return 'ticked, no note';
});

// ---- R7 用快捷键切换会话 -------------------------------------------------------------
// ⌘1–9 / ⌘⇧[ / ⌘⇧] as key events to this app's page (never to the system).

const SHORTCUT_KEYS = {
  next: ['}', 'BracketRight', 221, MOD.meta | MOD.shift],
  prev: ['{', 'BracketLeft', 219, MOD.meta | MOD.shift],
  k: ['k', 'KeyK', 75, MOD.meta], // not a shortcut of this app: the control
};
for (let n = 1; n <= 9; n++) SHORTCUT_KEYS[n] = [String(n), `Digit${n}`, 48 + n, MOD.meta];

async function pressShortcut(name) {
  const [key, code, vk, modifiers] = SHORTCUT_KEYS[name];
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
// Where a ⌘ keydown gets to. The app takes its keys on `window` in the capture
// phase; these listeners are added after it: `seen` on window (capture, runs for
// every key), `page` on document (capture: the first stop past the window),
// `bubble` on document (the key went all the way down and back up).
const KEY_PROBE = `(() => {
  if (!window.__vrKeyProbe) {
    const log = window.__vrKeyProbe = [];
    const mark = (phase) => (e) => { if (e.metaKey) log.push({ phase, code: e.code, prevented: e.defaultPrevented }); };
    window.addEventListener('keydown', mark('seen'), true);
    document.addEventListener('keydown', mark('page'), true);
    document.addEventListener('keydown', mark('bubble'), false);
  }
  window.__vrKeyProbe.length = 0;
  return true;
})()`;
/** Presses the key and reports how far its keydown got. */
async function probeKey(name) {
  await ev(KEY_PROBE);
  await pressShortcut(name);
  const events = JSON.parse(await ev(`JSON.stringify(window.__vrKeyProbe)`)).filter((e) => e.code === SHORTCUT_KEYS[name][1]);
  const at = (phase) => events.find((e) => e.phase === phase);
  return {
    // taken by the app: prevented, and delivered to nothing past the window
    intercepted: !!at('seen') && at('seen').prevented === true && !at('page') && !at('bubble'),
    // left alone: delivered through the page, default action intact
    delivered: !!at('seen') && at('seen').prevented === false && !!at('page') && !!at('bubble') && at('bubble').prevented === false,
    trace: `${name}: ${events.map((e) => `${e.phase}${e.prevented ? '(prevented)' : ''}`).join('>') || 'no keydown'}`,
  };
}
const switchesTo = async (name, want) => {
  await pressShortcut(name);
  return waitFor(async () => (await activeId()) === want, 8000, `${name} → ${want}`).then(() => true, async () => { throw new Error(`key ${name}: session shown is ${await activeId()}, want ${want}`); });
};
const staysOn = async (name, want) => {
  await pressShortcut(name);
  await sleep(450);
  const now = await activeId();
  assert(now === want, `key ${name} changed the session shown to ${now}`);
};
const focusKind = () => ev(`(() => { const a = document.activeElement; return !a ? 'none' : a.classList.contains('xterm-helper-textarea') ? 'terminal' : a.dataset.testid === 'chat-input' ? 'chat-input' : a.tagName.toLowerCase(); })()`);

/** Folds every machine but this-mac, and every project of this-mac except `open`. Returns the session ids showing, top to bottom. */
async function showOnly(open) {
  await openSession(fx.mainChat); // a session of this-mac on screen: nothing unfolds by itself later
  for (const d of daemons.values()) {
    const want = d === WT ? 'true' : 'false';
    const t = `${mg(d)}.querySelector('.machine-toggle')`;
    if ((await ev(`${t}.getAttribute('aria-expanded')`)) !== want && !(await ev(`${t}.disabled`))) await ev(`${t}.click(), true`);
  }
  for (const p of (await sidebar(WT)).projects) {
    if (p.collapsed === open.includes(p.name)) await ev(`${pg(WT, p.name)}.querySelector(':scope > .project-row .project-toggle').click(), true`);
  }
  await sleep(150);
  return visibleIds();
}
async function unfoldAll() {
  for (const d of daemons.values()) {
    const t = `${mg(d)}.querySelector('.machine-toggle')`;
    if ((await ev(`${t}.getAttribute('aria-expanded')`)) === 'false' && !(await ev(`${t}.disabled`))) await ev(`${t}.click(), true`);
    for (const p of (await sidebar(d)).projects) {
      if (p.collapsed) await ev(`${pg(d, p.name)}.querySelector(':scope > .project-row .project-toggle').click(), true`);
    }
  }
}
/**
 * Runs `fn(order)` with only some projects of this-mac unfolded. `open` names
 * them; without it devflow is shown, plus new-api while that makes fewer than
 * five sessions, so that between 5 and 8 are showing (⌘9 is then past the end).
 */
const folded = async (open, fn) => {
  try {
    const few = (await project(WT, 'devflow')).worktrees.flatMap((w) => w.sessions).length >= 5 ? ['devflow'] : ['devflow', 'new-api'];
    const order = await showOnly(open ?? few);
    assert(order.length >= 5 && (open || order.length <= 8), `${order.length} sessions showing; the case needs 5 to 8`);
    return await fn(order);
  } finally {
    await unfoldAll();
  }
};

test('R7.1', 'R7.1 ⌘1–⌘9 open the session at that position', () => folded(null, async (order) => {
  const n = order.length;
  await switchesTo(3, order[2]);
  await switchesTo(1, order[0]);
  await switchesTo(n, order[n - 1]);
  await switchesTo(2, order[1]);
  // a position past the last session does nothing
  for (let k = n + 1; k <= 9; k++) await staysOn(k, order[1]);
  // and the key is taken by the app, not merely ignored by whatever has the focus
  const p = await probeKey(3);
  assert(p.intercepted, `⌘3 was not intercepted: ${p.trace}`);
  await waitFor(async () => (await activeId()) === order[2], 8000, '⌘3 → the third session');
  const other = await probeKey('k');
  assert(other.delivered, `⌘K (not a shortcut) was not left alone: ${other.trace}`);
  await evidence('R7.1');
  return `${n} sessions showing: ⌘3, ⌘1, ⌘${n}, ⌘2 open that position; ⌘${n + 1}…⌘9 do nothing; ${p.trace}; ${other.trace}`;
}));

test('R7.2', 'R7.2 ⌘⇧] / ⌘⇧[ step through the sessions and wrap around', () => folded(null, async (order) => {
  const n = order.length;
  await switchesTo(n, order[n - 1]);
  await switchesTo('next', order[0]); // from the last to the first
  await switchesTo('prev', order[n - 1]); // and back
  await switchesTo('prev', order[n - 2]);
  await switchesTo('next', order[n - 1]);
  const seen = [];
  for (let i = 0; i < n; i++) {
    await switchesTo('next', order[i]);
    seen.push(order[i]);
  }
  eq(seen, order, 'a full circle with ⌘⇧]');
  return `${n} sessions: last → ⌘⇧] → first → ⌘⇧[ → last; a full circle visits each once, in sidebar order`;
}));

test('R7.3', 'R7.3 with the focus in a terminal or in the chat input the keys switch and type nothing', () => folded(null, async (order) => {
  // terminal: both sessions open already, so no first attach is mistaken for typing
  const [a, b] = [fx.main2, fx.main3];
  const [ia, ib] = [order.indexOf(a) + 1, order.indexOf(b) + 1];
  assert(ia > 0 && ib > 0 && ib <= 9, `the two terminal sessions are not among the first nine: ${ia}, ${ib}`);
  await openSession(b);
  await shell('echo R73_$((7+3))_B', 'R73_10_B');
  await openSession(a);
  await shell('echo R73_$((7+4))_A', 'R73_11_A');
  await sleep(800);
  await waitFor(focusTerminal, 5000, 'terminal focused');
  await ev(`window.__vrNet.sent.length = 0, true`);
  const p = await probeKey(ib);
  assert(p.intercepted, `⌘${ib} in a focused terminal was not intercepted: ${p.trace}`);
  await waitFor(async () => (await activeId()) === b, 8000, `⌘${ib} → the other terminal session`);
  await waitFor(async () => (await focusKind()) === 'terminal', 5000, 'the terminal now shown has the focus');
  await switchesTo('prev', order[ib - 2]);
  await switchesTo('next', b);
  await sleep(300);
  eq(JSON.parse(await ev(`JSON.stringify(window.__vrNet.sent)`)), [], 'bytes sent to the remote by the switching keys');
  // the recorder does see ordinary typing
  await shell('echo R73_$((7+5))_TYPED', 'R73_12_TYPED');
  assert((await ev(`window.__vrNet.sent.join('')`)).includes('R73_'), 'the recorder saw no typing at all');

  // chat input
  await openSession(fx.mainChat);
  const input = inChat(tid('chat-input'));
  await waitFor(() => ev(`(() => { const i = ${input}; i?.focus(); return !!i && document.activeElement === i; })()`), 5000, 'chat input focused');
  await cdp.send('Input.insertText', { text: 'draft stays' });
  const at = order.indexOf(fx.mainChat);
  const q = await probeKey('next');
  assert(q.intercepted, `⌘⇧] in the chat input was not intercepted: ${q.trace}`);
  await waitFor(async () => (await activeId()) === order[(at + 1) % order.length], 8000, '⌘⇧] from the chat input');
  await openSession(fx.mainChat);
  eq(await ev(`${input}.value`), 'draft stays', 'the draft in the chat input');
  await ev(`(() => { const i = ${input}; i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  return `terminal: ${p.trace}, 0 bytes sent; chat input: ${q.trace}, draft unchanged`;
}));

test('R7.4', 'R7.4 with a dialog open the keys do not switch', () => folded(null, async (order) => {
  await openSession(order[0]);
  const seen = [];
  const check = async (what) => {
    await staysOn(2, order[0]);
    await staysOn('next', order[0]);
    const p = await probeKey(2);
    const q = await probeKey('next');
    await sleep(300);
    eq(await activeId(), order[0], `session shown with the ${what} open`);
    assert(p.delivered && q.delivered, `with the ${what} open the keys are still taken: ${p.trace}; ${q.trace}`);
    seen.push(`${what}: ${p.trace}; ${q.trace}`);
  };
  await openNewSessionDialog(WT, 'devflow', 'main');
  await check('new-session dialog');
  await cancelDialog();
  await click(`${srow(order[1])}.querySelector('.session-close')`, 'delete button of a session row');
  await waitDialog('delete-session-dialog');
  await check('delete confirmation');
  await cancelDialog();
  assert((await sessions(WT)).some((s) => s.id === order[1]), 'the session was deleted');
  // and once the dialog is closed they work again
  await switchesTo(2, order[1]);
  return seen.join(' | ');
}));

test('R7.5', 'R7.5 sessions of a folded project are skipped', () => folded(['devflow', 'notes'], async (order) => {
  const hidden = (await project(WT, 'new-api')).collapsed ? [fx.api1, fx.api2] : null;
  assert(hidden && !order.includes(fx.api1) && !order.includes(fx.api2), 'new-api is not folded');
  assert(order.includes(fx.notes1), 'notes, below the folded project, is not showing');
  await openSession(order[0]);
  const visited = [];
  for (let i = 1; i <= order.length; i++) {
    await pressShortcut('next');
    const want = order[i % order.length];
    await waitFor(async () => (await activeId()) === want, 8000, `⌘⇧] → ${want}`).catch(async () => { throw new Error(`⌘⇧] went to ${await activeId()}, want ${want}`); });
    visited.push(want);
    assert((await project(WT, 'new-api')).collapsed, 'new-api unfolded by itself');
  }
  assert(!visited.some((id) => hidden.includes(id)), 'a session of the folded project was shown');
  eq(visited.at(-1), order[0], 'where the full circle ends');
  await evidence('R7.5');
  return `${order.length} sessions showing around the folded new-api: a full circle of ⌘⇧] never stops in it`;
}));

// ---- R8 视觉风格 -----------------------------------------------------------------------

/** The computed value of CSS custom properties as rgb()/color() strings and as #RRGGBB. */
const themeColors = (names) => ev(`(() => {
  const probe = document.createElement('div'); document.body.appendChild(probe);
  const out = {};
  for (const n of ${J(names)}) { probe.style.color = 'var(' + n + ')'; out[n] = { css: getComputedStyle(probe).color, hex: getComputedStyle(document.documentElement).getPropertyValue(n).trim().toUpperCase() }; }
  probe.remove();
  return out;
})()`);

// In-page helpers for colors as they end up on screen: any CSS color → rgba
// (through a canvas, so color-mix() results are covered), an element's
// background composited over what is behind it, WCAG contrast.
const COLOR_LIB = `(() => {
  if (window.__vrColor) return true;
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (css) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = css; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((i) => Math.round(top[i] * a + under[i] * (1 - a))).concat(1); };
  const background = (el) => {
    const chain = [];
    for (let e = el; e; e = e.parentElement) chain.push(e);
    let c = [255, 255, 255, 1];
    for (const e of chain.reverse()) c = over(rgba(getComputedStyle(e).backgroundColor), c);
    return c;
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const hex = (c) => '#' + c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  window.__vrColor = { rgba, over, background, ratio, hex };
  return true;
})()`;

test('R8.1', 'R8.1 a chat session in the M1 look', async () => {
  await openSession(fx.mainChat);
  await sendChat('echo 你好，这是 **M1** 的样子');
  await waitAssistant('M1');
  await chatIdle();
  await sendChat('tool Read');
  await waitFor(() => exists(inChat(tid('chat-tool'))), 15000, 'a tool block');
  await chatIdle();
  const c = await themeColors(['--accent-soft', '--bg-primary', '--bg-app', '--bg-elevated']);
  const box = `(e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; }`;
  const styled = `(e) => { const s = getComputedStyle(e); return { bg: s.backgroundColor, radius: parseFloat(s.borderTopLeftRadius), border: parseFloat(s.borderTopWidth), shadow: s.boxShadow }; }`;
  // the input, while it is on screen (a permission card takes its place)
  const composer = await ev(`(() => { const box = ${box}; const styled = ${styled}; const v = ${VC}; const input = v.querySelector('${tid('chat-input')}');
    let e = input; while (e && e !== v && !(parseFloat(getComputedStyle(e).borderTopLeftRadius) >= 12)) e = e.parentElement;
    return e && e !== v && input.getClientRects().length > 0 ? { ...box(e), ...styled(e), placeholder: input.placeholder } : null; })()`);
  await sendChat('perm touch m1.txt');
  try {
    await waitFor(() => exists(inChat(`${tid('chat-perm')} ${tid('chat-perm-allow')}`)), 15000, 'a permission card');
    await ev(`(() => { const t = ${inChat(tid('chat-transcript'))}; t.scrollTop = t.scrollHeight; return true; })()`);
    await sleep(300);
    const m = await ev(`(() => {
      const box = ${box}; const styled = ${styled}; const v = ${VC};
      const withBg = (root, color) => [root, ...root.querySelectorAll('*')].find((e) => getComputedStyle(e).backgroundColor === color);
      const users = [...v.querySelectorAll('${tid('chat-msg-user')}')];
      const assistants = [...v.querySelectorAll('${tid('chat-msg-assistant')}')];
      const bubble = withBg(users.at(-1), ${J(c['--accent-soft'].css)});
      const ink = (e) => { const r = document.createRange(); r.selectNodeContents(e); return box(r); };
      const perm = v.querySelector('${tid('chat-perm')}');
      const tool = v.querySelector('${tid('chat-tool')}');
      const main = document.getElementById('main-area');
      return {
        window: [innerWidth, innerHeight],
        bubble: bubble ? { ...box(bubble), ...styled(bubble) } : null,
        assistant: { ...ink(assistants[0]), bg: getComputedStyle(assistants[0]).backgroundColor },
        perm: perm ? { ...box(perm), ...styled(perm), buttons: [...perm.querySelectorAll('button')].map((b) => b.textContent.trim()) } : null,
        tool: tool ? { ...box(tool), ...styled(tool), text: tool.textContent.trim().slice(0, 40) } : null,
        main: { ...box(main), ...styled(main) }, body: getComputedStyle(document.body).backgroundColor,
      };
    })()`);
    await evidence('R8.1');
    // The column the conversation is set in: the permission card spans it.
    assert(m.perm && m.perm.radius >= 8 && m.perm.buttons.length >= 2, `permission card: ${J(m.perm)}`);
    const col = { left: m.perm.left, right: m.perm.right, width: m.perm.width };
    // user message: a bubble in the soft accent, at the right edge of the column
    assert(m.bubble, `the user message has no bubble in --accent-soft (${c['--accent-soft'].hex})`);
    assert(m.bubble.radius >= 12, `the bubble's corners: ${m.bubble.radius}px`);
    assert(Math.abs(col.right - m.bubble.right) < 4 && m.bubble.left - col.left > col.width * 0.3, `the user bubble ${Math.round(m.bubble.left)}..${Math.round(m.bubble.right)} is not at the right of the column ${Math.round(col.left)}..${Math.round(col.right)}`);
    // assistant message: plain text from the left edge, no bubble
    assert(Math.abs(m.assistant.left - col.left) < 4, `the assistant text starts at ${Math.round(m.assistant.left)}, the column at ${Math.round(col.left)}`);
    assert(m.assistant.bg !== c['--accent-soft'].css, 'the assistant message has the user bubble\'s color');
    // the input: a rounded card as wide as the column
    assert(composer && composer.radius >= 12 && (composer.border > 0 || composer.shadow !== 'none'), `the input is not a rounded card: ${J(composer)}`);
    assert(Math.abs(composer.left - col.left) < 4 && Math.abs(composer.right - col.right) < 4, `the input card ${Math.round(composer.left)}..${Math.round(composer.right)} is not the width of the column`);
    // the tool block is a row of the same column
    assert(m.tool && m.tool.left >= col.left - 1 && m.tool.right <= col.right + 1 && m.tool.width > col.width * 0.8, `tool block: ${J(m.tool)}`);
    // the main area: a white card with round corners, floating on the app background
    eq(m.main.bg, c['--bg-primary'].css, 'background of the main area');
    assert(m.main.radius >= 10 && m.main.shadow !== 'none', `the main area is not a raised card: radius ${m.main.radius}px, shadow ${m.main.shadow}`);
    assert(m.main.top > 0 && m.main.right < m.window[0] && m.main.bottom < m.window[1], `the main area touches the window's edge: ${J(m.main)} in ${J(m.window)}`);
    eq(m.body, c['--bg-app'].css, 'background behind the card');
    return `user bubble ${c['--accent-soft'].hex} r${m.bubble.radius} at the right of the column; assistant text from its left; input card r${composer.radius}; permission card r${m.perm.radius}; main card r${m.main.radius} with a shadow on ${c['--bg-app'].hex}`;
  } finally {
    // answer the request, so the session is idle again
    await click(inChat(tid('chat-perm-allow')), 'allow').catch(() => {});
    await chatIdle().catch(() => {});
  }
});

test('R8.2', 'R8.2 a terminal session: shell and the four terminal colors follow the theme', async () => {
  await openSession(fx.main2);
  // remote output arrives as it is: text and its ANSI color
  await shell(`printf '\\033[31mRED_%s\\033[0m\\n' PASSTHROUGH`, 'RED_PASSTHROUGH');
  await shell('echo M1_$((40+2))_TERMINAL', 'M1_42_TERMINAL');
  const c = await themeColors(['--term-bg', '--term-fg', '--term-cursor', '--term-selection', '--bg-app', '--bg-sidebar', '--bg-primary', '--text-primary']);
  eq([c['--term-bg'].hex, c['--term-fg'].hex, c['--term-cursor'].hex, c['--term-selection'].hex], ['#FFFFFF', '#1C1B22', '#6B54D3', '#D9D2F4'], 'the theme\'s terminal colors');
  const shellColors = await ev(`({ body: getComputedStyle(document.body).backgroundColor, sidebar: getComputedStyle(document.getElementById('sidebar')).backgroundColor, main: getComputedStyle(document.getElementById('main-area')).backgroundColor, title: getComputedStyle(document.querySelector('#toolbar-title ${tid('title-session')}')).color })`);
  eq([shellColors.body, shellColors.main, shellColors.title], [c['--bg-app'].css, c['--bg-primary'].css, c['--text-primary'].css], 'window background, main card, session name in the title');
  assert([c['--bg-sidebar'].css, 'rgba(0, 0, 0, 0)'].includes(shellColors.sidebar), `sidebar background ${shellColors.sidebar}`);
  // what is painted
  await waitFor(focusTerminal, 5000, 'terminal focused');
  const rect = await ev(`(() => { const r = ${VT}.querySelector('.xterm-screen').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
  const shot = async () => { const s = await screenshot(rect); return s.img; };
  const whole = (img) => ({ x: 0, y: 0, width: img.width, height: img.height });
  let img = await shot();
  const bg = dominantColors(img, whole(img), 2, 1)[0];
  eq(bg.hex, c['--term-bg'].hex, 'most frequent color painted in the terminal');
  assert(bg.share > 0.7, `the background covers only ${bg.share} of the terminal`);
  const fg = countColor(img, whole(img), hexRgb(c['--term-fg'].hex), 28);
  assert(fg.match > 200, `only ${fg.match} pixels near the foreground color ${c['--term-fg'].hex}`);
  // the cursor blinks: look until it is painted
  const cursor = await waitFor(async () => { const n = countColor(await shot(), whole(img), hexRgb(c['--term-cursor'].hex), 10).match; return n > 30 ? n : 0; }, 4000, `pixels in the cursor color ${c['--term-cursor'].hex}`);
  // select a line with the mouse
  const line = await ev(`(() => { const rows = [...${VT}.querySelectorAll('.xterm-rows > div')]; const row = rows.find((r) => r.textContent.includes('M1_42_TERMINAL') && !r.textContent.includes('echo')); const r = row.getBoundingClientRect(); return { y: r.top + r.height / 2, x0: r.left + 4, x1: r.left + 200 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: line.x0, y: line.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (line.x0 + line.x1) / 2, y: line.y, button: 'left', buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: line.x1, y: line.y, button: 'left', buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: line.x1, y: line.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(200);
  img = await shot();
  const selection = countColor(img, whole(img), hexRgb(c['--term-selection'].hex), 6).match;
  assert(selection > 500, `only ${selection} pixels in the selection color ${c['--term-selection'].hex}`);
  await evidence('R8.2');
  // nothing of the previous palette, nothing dark, anywhere in the window
  const all = (await screenshot()).img;
  for (const old of ['#F5F4EF', '#E6E1D8', '#1E1E1E', '#000000']) {
    const n = countColor(all, whole(all), hexRgb(old), 2, 2);
    assert(n.match / n.total < 0.002, `${n.match} of ${n.total} sampled pixels are ${old}`);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: line.x0, y: line.y + 40, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: line.x0, y: line.y + 40, button: 'left', buttons: 0, clickCount: 1 });
  return `painted: background ${bg.hex} (${Math.round(bg.share * 100)}%), ${fg.match} px near ${c['--term-fg'].hex}, cursor ${cursor} px of ${c['--term-cursor'].hex}, selection ${selection} px of ${c['--term-selection'].hex}; remote text and color shown as sent`;
});

test('R8.3', 'R8.3 the two existing GUI scripts keep every case of the version before this change', async () => {
  const out = [];
  for (const [file, pattern] of [['gui-smoke.mjs', /\bcheck\(/g], ['gui-chat-smoke.mjs', /^test\(/gm]]) {
    const rel = `.claude/skills/verify/scripts/${file}`;
    const base = spawnSync(REAL_GIT, ['show', `${BASE_REF}:${rel}`], { cwd: ROOT, encoding: 'utf-8', maxBuffer: 1 << 26 });
    assert(base.status === 0, `git show ${BASE_REF}:${rel} failed`);
    const now = readFileSync(join(ROOT, rel), 'utf-8');
    const [was, is] = [(base.stdout.match(pattern) ?? []).length, (now.match(pattern) ?? []).length];
    assert(is >= was, `${file}: ${is} cases, the version before had ${was}`);
    // no line that asserts or waits for something was taken out or changed
    const current = new Set(now.split('\n').map((l) => l.trim()));
    const lost = base.stdout.split('\n').map((l) => l.trim()).filter((l) => /\b(check|assert|test|waitFor|fail)\(/.test(l) && !current.has(l));
    assert(lost.length === 0, `${file}: ${lost.length} asserting line(s) of the version before are gone or changed, e.g. ${lost[0]?.slice(0, 120)}`);
    out.push(`${file}: ${was} → ${is} cases, no asserting line removed`);
  }
  if (!args.has('--with-existing')) return `${out.join('; ')} (run them for the other half: gui-smoke.mjs, gui-chat-smoke.mjs)`;
  for (const file of ['gui-smoke.mjs', 'gui-chat-smoke.mjs']) {
    // They start their own daemons and app; TMUX_TMPDIR is this run's directory.
    const r = await new Promise((res) => {
      const p = spawn(process.execPath, [join(ROOT, '.claude/skills/verify/scripts', file), '--no-build'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let o = '';
      p.stdout.on('data', (x) => { o += x; });
      p.stderr.on('data', (x) => { o += x; });
      p.on('exit', (code) => res({ code, o }));
    });
    const pass = (r.o.match(/^PASS /gm) ?? []).length;
    const failed = r.o.split('\n').filter((l) => l.startsWith('FAIL '));
    assert(r.code === 0 && failed.length === 0, `${file}: exit ${r.code}, ${failed.length} FAIL: ${failed.join(' | ').slice(0, 400)}`);
    out.push(`${file} run: ${pass} PASS, 0 FAIL`);
  }
  return out.join('; ');
});

test('R8.4', 'R8.4 text contrast as painted, and three state dots that differ in shape', async () => {
  await ev(COLOR_LIB);
  // Reads the contrast of every element matching the selectors that is showing.
  const measure = (groups) => ev(`(() => {
    const C = window.__vrColor; const out = [];
    for (const [kind, min, selectors] of ${J(groups)}) for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.getClientRects().length === 0 || el.textContent.trim() === '' || el.disabled || el.closest('[disabled]')) continue;
        const s = getComputedStyle(el); if (s.visibility === 'hidden' || s.opacity === '0') continue;
        const bg = C.background(el); const fg = C.over(C.rgba(s.color), bg);
        out.push({ kind, min, sel, text: el.textContent.trim().slice(0, 18), fg: C.hex(fg), bg: C.hex(bg), ratio: Math.round(C.ratio(fg, bg) * 100) / 100 });
      }
    }
    return out;
  })()`);
  const body = ['.session-label-text', '.project-name', '.worktree-label', '.machine-name-label', `#toolbar-title ${tid('title-session')}`, '.workspace-header h1', '.workspace-section h2', '.workspace-session-copy strong', '.workspace-mode-head strong',
    '.modal-title', '.modal-confirm-text', '.modal-mode-title', '.modal-option-title', '.modal-name-input', `${tid('chat-msg-assistant')} p`, `${tid('chat-msg-user')} .u-text`, `${tid('chat-input')}`];
  const buttons = ['.btn-primary', '.btn-secondary', '.worktree-empty-action', '.workspace-mode-action', '.menu-item'];
  const secondary = [`#toolbar-title ${tid('title-project')}`, `#toolbar-title ${tid('title-branch')}`, '.session-meta', '.project-branch', '.worktree-tag', '.worktree-empty-text', '.machine-state', '.machine-session-count', '.workspace-section-subtitle', '.workspace-summary', '.workspace-mode-desc', '.workspace-mode-hint', '.workspace-badge',
    '.modal-subtitle', '.modal-mode-description', '.modal-mode-note', '.modal-option-description', '.modal-name-base', '.modal-footer-hint', '.modal-kv dt', '.menu-note', '.c-hint span'];
  const groups = [['body text', 4.5, body], ['button text', 4.5, buttons], ['secondary text', 3, secondary]];
  const all = [];
  const screenOf = async (name) => { for (const r of await measure(groups)) all.push({ ...r, screen: name }); };

  // a worktree whose deletion shows the busiest confirmation (files + commits)
  const w = await managedWorktree(LAB, fx.del, 'r84');
  commits(w.path, 1);
  writeFileSync(join(w.path, 'wip.txt'), 'x\n');
  await rowShown(LAB, 'del', 'r84');

  await openSession(fx.mainChat); // sidebar + chat
  await sendChat('echo contrast');
  await waitAssistant('contrast');
  await chatIdle();
  await screenOf('chat session');
  await openMachine(WT);
  await screenOf('machine overview');
  await openNewWorktreeDialog(LAB, 'webapp');
  await typeName('taken-branch');
  await screenOf('new worktree dialog');
  await cancelDialog();
  await openDeleteWorktree(LAB, 'del', 'r84');
  await screenOf('delete confirmation');
  await cancelDialog();
  await click(`${pg(WT, 'devflow')}.querySelector(':scope > .project-row ${tid('project-menu')}')`, 'a row menu');
  await screenOf('row menu');
  await closeMenus();

  const low = all.filter((r) => r.ratio < r.min);
  const worst = (kind) => all.filter((r) => r.kind === kind).sort((a, b) => a.ratio - b.ratio)[0];
  for (const kind of ['body text', 'button text', 'secondary text']) assert(all.filter((r) => r.kind === kind).length >= 8, `only ${all.filter((r) => r.kind === kind).length} ${kind} elements were measured`);
  assert(low.length === 0, `${low.length} of ${all.length} texts below their minimum: ${low.slice(0, 6).map((r) => `${r.screen} ${r.sel} "${r.text}" ${r.fg} on ${r.bg} = ${r.ratio} (< ${r.min})`).join('; ')}`);

  // the three dots, at the same time, on rows that are not the one shown
  for (const id of [fx.main3, fx.fix.id, fx.main2]) await openSession(id);
  await shell('echo DOTS_$((1+1))_READY', 'DOTS_2_READY');
  await typeLine('sleep 2; echo late output'); // arrives once this session is in the background
  await openSession(fx.api1);
  eq((await hookEvent(WT, fx.main3, 'idle')).status, 204, 'idle event');
  eq((await hookEvent(WT, fx.fix.id, 'waiting')).status, 204, 'waiting event');
  await waitFor(() => ev(`${srow(fx.main2)}?.dataset.dot === 'output' && ${srow(fx.main3)}?.dataset.dot === 'idle' && ${srow(fx.fix.id)}?.dataset.dot === 'waiting'`), 12000, 'the three dots')
    .catch(async (e) => { throw new Error(`${e.message}: ${await ev(`JSON.stringify([${J(fx.main2)}, ${J(fx.main3)}, ${J(fx.fix.id)}].map((id) => document.querySelector('.session-item[data-session-id="' + id + '"]')?.dataset.dot))`)}`); });
  const dots = await ev(`(() => { const C = window.__vrColor; const one = (id) => { const row = document.querySelector('.session-item[data-session-id="' + id + '"]'); const d = row.querySelector('.session-unread'); const s = getComputedStyle(d); const bg = C.background(row);
    const fill = C.rgba(s.backgroundColor); const edge = C.rgba(s.borderTopColor); const ink = fill[3] > 0.5 ? C.over(fill, bg) : C.over(edge, bg);
    return { state: row.dataset.dot, filled: fill[3] > 0.5, border: parseFloat(s.borderTopWidth), ring: s.boxShadow !== 'none', size: Math.round(d.getBoundingClientRect().width), color: C.hex(ink), on: C.hex(bg), ratio: Math.round(C.ratio(ink, bg) * 100) / 100, text: row.querySelector('.session-meta').textContent };
  }; return [${J(fx.main2)}, ${J(fx.main3)}, ${J(fx.fix.id)}].map(one); })()`);
  await evidence('R8.4', '#sidebar', wg(WT, 'devflow', 'main'));
  const [output, idle, waiting] = dots;
  assert(!output.filled && output.border > 0 && !output.ring, `"new output" is not a ring: ${J(output)}`);
  assert(idle.filled && !idle.ring, `"turn finished" is not a plain solid dot: ${J(idle)}`);
  assert(waiting.filled && waiting.ring, `"needs you" is not a solid dot with a halo: ${J(waiting)}`);
  for (const d of dots) assert(d.ratio >= 3 && d.size >= 6, `the ${d.state} dot ${d.color} on ${d.on}: ${d.ratio}, ${d.size}px`);
  eq(dots.map((d) => d.text), ['终端 · 有新消息', '终端 · 回合结束', '终端 · 等你处理'], 'what the rows say next to the dots');
  await openSession(fx.main2);
  await openSession(fx.main3);
  await openSession(fx.fix.id);
  return `${all.length} texts on 5 screens: lowest body ${worst('body text').ratio} (${worst('body text').sel}), button ${worst('button text').ratio} (${worst('button text').sel}), secondary ${worst('secondary text').ratio} (${worst('secondary text').sel}); dots: ring ${output.ratio}, solid ${idle.ratio}, solid+halo ${waiting.ratio} against the sidebar`;
});

test('R8.5', 'R8.5 the smallest window, 800×500, in Chinese and in English', async () => {
  // Worktrees in every state the delete confirmation has a form for.
  const mk = async (name, fn) => { const w = await managedWorktree(LAB, fx.del, name); fn?.(w.path); return w; };
  await mk('l-clean', (p) => writeFileSync(join(p, '.env'), 'x\n'));
  await mk('l-files', (p) => { commits(p, 2); writeFileSync(join(p, 'a.txt'), 'x\n'); writeFileSync(join(p, 'b.txt'), 'x\n'); });
  await mk('l-commits', (p) => commits(p, 3));
  const LONG = 'change/general-skills-and-a-long-tail';
  git(fx.del, 'worktree', 'add', '-q', '-b', LONG, join(L, 'del-lay', 'ext'));
  const det = join(L, 'del-lay', 'det');
  git(fx.del, 'worktree', 'add', '-q', '--detach', det);
  commits(det, 1);
  const locked = await managedWorktree(LAB, fx.del, 'l-locked', { keep: true });
  git(fx.del, 'worktree', 'lock', '--reason', 'layout', locked.path);
  const chat = await chatIn(LAB, fx.webapp);
  await rowShown(LAB, 'del', LONG);
  const detLabel = head(det).slice(0, 7);
  const problems = [];
  const measured = [];
  const lang = () => ev('document.documentElement.lang');
  const measureDialog = async (what, shot) => {
    const l = await atWindowSize(cdp, MIN_WINDOW, async () => { const m = await dialogLayout(cdp); if (shot) await evidence(shot); return m; });
    measured.push(`${l.lang ?? '?'} ${what}`);
    for (const p of l.problems ?? []) problems.push(`[${l.lang} ${what}] ${p}`);
    return l;
  };
  try {
    for (const want of ['zh-CN', 'en']) {
      if ((await lang()) !== want) await ev(`document.getElementById('btn-lang').click(), true`);
      await waitFor(async () => (await lang()) === want, 5000, `language ${want}`);

      // the sidebar: three levels, long names, a row menu at the bottom
      await openSession(locked.id);
      const side = await atWindowSize(cdp, MIN_WINDOW, () => sidebarLayout(cdp));
      measured.push(`${want} sidebar (${side.rows} rows)`);
      assert(side.rows >= 10, `the sidebar shows only ${side.rows} rows`);
      for (const p of side.problems) problems.push(`[${want} sidebar] ${p}`);

      // the directory picker in Worktree mode with a name that is refused: its tallest state
      await openMachine(LAB);
      await ev(`[...document.querySelectorAll('#machine-overview .workspace-mode-card')].at(-1).click(), true`);
      await waitFor(() => exists(NAME), 15000, 'picker in worktree mode');
      await click(`[...document.querySelectorAll('.modal-overlay .modal-item')].find((b) => b.querySelector('span')?.textContent === 'webapp')`, 'folder webapp');
      await waitFor(async () => !(await nameState()).disabled && (await nameState()).base !== '', 10000, 'picker in webapp');
      await typeName('taken-branch');
      await measureDialog('picker, worktree mode, name refused');
      await cancelDialog();

      // "new session" on a worktree where chat is off, with the long reason
      await click(`${wg(LAB, 'untrusted', 'topic-a')}.querySelector('.worktree-row ${tid('worktree-new-session')}')`, 'new session on untrusted / topic-a');
      await waitFor(() => ev(`(() => { const r = ${DLG('worktree-session-dialog')}?.querySelector('${tid('picker-ui-chat-reason')}'); return !!r && r.textContent.includes(${J(fx.untrusted)}); })()`), 15000, 'the reason chat is off');
      await click(CONTINUE, 'the continue option');
      await measureDialog('new session in a worktree, chat off');
      await cancelDialog();

      // "new worktree": a usable name, then the longest refusal
      await openNewWorktreeDialog(LAB, 'webapp');
      await typeName('layout/a-rather-long-branch-name-for-the-dialog');
      await measureDialog('new worktree, usable name');
      await typeName('taken-branch/sub');
      await measureDialog('new worktree, name refused');
      await cancelDialog();

      // delete session
      await click(`${srow(locked.id)}.querySelector('.session-close')`, 'delete button of the session row');
      await waitDialog('delete-session-dialog');
      await measureDialog('delete session');
      await cancelDialog();

      // delete worktree: every form
      for (const [label, variant] of [['l-clean', 'clean'], ['l-files', 'files'], ['l-commits', 'commits'], [detLabel, 'detached'], [LONG, 'external']]) {
        await openDeleteWorktree(LAB, 'del', label);
        eq((await deleteDialog()).variant, variant, `form of the confirmation for ${label}`);
        await measureDialog(`delete worktree: ${variant}`, want === 'en' && variant === 'files' ? 'R8.5' : undefined);
        await cancelDialog();
      }
      // ... and re-opened with an error, a session to end and the note that the state changed
      await openDeleteWorktree(LAB, 'del', 'l-locked');
      await confirmDelete();
      await waitFor(async () => (await deleteDialog())?.error, 20000, 'the error in the dialog');
      await measureDialog('delete worktree: failed, re-opened');
      await cancelDialog();

      // the slash menu of a chat session
      await openSession(chat);
      const input = inChat(tid('chat-input'));
      await waitFor(() => ev(`(() => { const i = ${input}; i?.focus(); return !!i && !i.disabled && document.activeElement === i; })()`), 10000, 'chat input focused');
      await cdp.send('Input.insertText', { text: '/' });
      await waitFor(() => ev(`(() => { const m = ${inChat(tid('chat-slash-menu'))}; return !!m && !m.hidden; })()`), 5000, 'slash menu');
      for (const s of await slashMenuLayout(cdp, { sizes: [MIN_WINDOW] })) {
        measured.push(`${want} slash menu (${s.rows} commands)`);
        assert(s.rows >= 10, `the slash menu lists only ${s.rows} commands`);
        for (const p of s.problems) problems.push(`[${want} slash menu] ${p}`);
      }
      await ev(`(() => { const i = ${input}; i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await pressKey('Escape');
    }
  } finally {
    if ((await lang()) !== 'zh-CN') await ev(`document.getElementById('btn-lang').click(), true`);
    gitRun(fx.del, 'worktree', 'unlock', locked.path);
    await endSession(LAB, locked.id);
    await endSession(LAB, chat);
  }
  assert(problems.length === 0, `${problems.length} layout problem(s) in ${measured.length} measurements: ${problems.join(' || ')}`);
  return `${measured.length} measurements at 800×500, no problem: ${measured.join('; ')}`;
});

test('R8.6', 'R8.6 a cold start shows the theme from the first frame', async () => {
  const f = firstFrame;
  assert(f && !f.error && f.png, `the first frame was not recorded: ${f?.error ?? 'nothing'}`);
  // the native window, before the page has painted anything
  eq((f.backgroundAtShow ?? f.backgroundAfterCreate ?? '').toUpperCase(), '#EFEFF4', 'window background when it is first shown');
  eq(f.backgroundAtFirstPaint.toUpperCase(), '#EFEFF4', 'window background at the first paint');
  // the page as first painted
  const img = decodePng(Buffer.from(f.png, 'base64'));
  if (EVIDENCE_DIR) { mkdirSync(EVIDENCE_DIR, { recursive: true }); writeFileSync(join(EVIDENCE_DIR, 'R8.6.png'), Buffer.from(f.png, 'base64')); }
  const [w, h] = [img.width, img.height];
  const app = hexRgb('#EFEFF4');
  // the strip around the main card (right and bottom edge of the window) and the lower part of the sidebar are the app background
  // (the card's shadow falls on the strips next to it: a little darker than the background, never another hue)
  const gutters = [{ x: w * 0.3, y: h - 6, width: w * 0.6, height: 4, tolerance: 12 }, { x: w - 6, y: h * 0.2, width: 4, height: h * 0.6, tolerance: 12 }, { x: 4, y: h * 0.6, width: w * 0.15, height: h * 0.35, tolerance: 3 }];
  for (const g of gutters) {
    const n = countColor(img, g, app, g.tolerance, 2);
    assert(n.match / n.total > 0.95, `area ${J(g)} of the first frame is ${J(dominantColors(img, g, 2, 2))}, not the app background`);
  }
  const card = dominantColors(img, { x: w * 0.35, y: h * 0.2, width: w * 0.5, height: h * 0.6 }, 3, 1)[0];
  eq(card.hex, '#FFFFFF', 'the main card of the first frame');
  const whole = { x: 0, y: 0, width: w, height: h };
  // No area in the previous look's background (a few pixels on the edge of a
  // colored chip can come out in any color: an area is what would be a flash).
  for (const old of ['#F5F4EF', '#E6E1D8']) {
    const n = countColor(img, whole, hexRgb(old), 2, 3);
    assert(n.match / n.total < 0.005, `${Math.round((n.match / n.total) * 1000) / 10}% of the first frame is the previous background ${old}`);
  }
  let dark = 0;
  let total = 0;
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) { const p = img.at(x, y); total++; if (p[0] + p[1] + p[2] < 180) dark++; }
  assert(dark / total < 0.03, `${Math.round((dark / total) * 100)}% of the first frame is dark`);
  const t = Object.fromEntries(f.events);
  return `window background ${f.backgroundAtShow ?? f.backgroundAfterCreate} ${f.backgroundAtShow ? 'when shown' : `right after it was created (visible: ${f.visibleAfterCreate})`}, first paint ${t['ready-to-show'] - t.created} ms after the window was created: ${t['ready-to-show']} ms: gutters and sidebar #EFEFF4, card ${card.hex}, ${Math.round((dark / total) * 1000) / 10}% dark pixels (text), none of the previous beige`;
});

// ---- R9 新旧版本互连 ---------------------------------------------------------------------

test('R9.1', 'R9.1 this desktop with a protocol-3 daemon', async () => {
  await refresh();
  const side = await sidebar(OLD);
  eq(side.legacyNote, 'vibe-remoted 版本较旧：不能新建或删除 worktree，没有会话的 worktree 不会列出。升级 vibe-remoted 后可用。', 'the note under the machine');
  const p = side.projects.find((x) => x.name === 'legacy');
  assert(p, `no project legacy: ${J(side.projects.map((x) => x.name))}`);
  // grouped by project and worktree from what the sessions carry
  const auto = (await sessions(OLD)).find((s) => s.id === fx.oldWt);
  eq(auto.branch, `vibe/${fx.oldWt}`, 'branch of the worktree-mode session (named by the old daemon)');
  const wtRow = p.worktrees.find((w) => w.label === auto.branch);
  const mainRow = p.worktrees.find((w) => w.tags.includes('worktree-tag-main'));
  assert(wtRow?.sessions.some((s) => s.id === fx.oldWt), `the worktree session is not under its own row: ${J(p.worktrees)}`);
  assert(mainRow?.sessions.some((s) => s.id === fx.oldMain), `the session of the main directory is not under the main row: ${J(p.worktrees)}`);
  // a worktree without sessions is on disk but not shown
  assert(listed(fx.legacy, fx.legacyQuiet), 'fixture: the quiet worktree is not on disk');
  assert(!J(side).includes('quiet'), 'the worktree without sessions is listed');
  // the two entries are off, and say why
  const off = await ev(`(() => { const b = ${pg(OLD, 'legacy')}.querySelector(':scope > .project-row ${tid('project-new-worktree')}'); return { disabled: b.disabled, why: b.title }; })()`);
  eq(off, { disabled: true, why: '需要升级这台机器的 vibe-remoted' }, '"new worktree" on the project row');
  await ev(`${wg(OLD, 'legacy', auto.branch)}.querySelector('.worktree-row ${tid('worktree-menu')}').click(), true`);
  const item = await waitFor(() => ev(`(() => { const m = document.querySelector('body > .menu'); const b = m?.querySelector('${tid('worktree-delete')}'); return b ? { disabled: b.disabled, note: m.querySelector('.menu-note')?.textContent ?? '' } : null; })()`), 5000, 'the row menu');
  eq(item, { disabled: true, note: '需要升级这台机器的 vibe-remoted' }, '"delete worktree" in the row menu');
  await evidence('R9.1', '#sidebar', pg(OLD, 'legacy'));
  await closeMenus();

  // Worktree mode from the overview: the old behavior, no name to fill in
  const before = new Set((await sessions(OLD)).map((s) => s.id));
  await openMachine(OLD);
  await click(`[...document.querySelectorAll('#machine-overview .workspace-mode-card')].find((c) => c.textContent.includes('创建隔离 Worktree'))`, 'the Worktree card');
  const modal = `document.querySelector('.modal-overlay .modal')`;
  await waitFor(() => ev(`${modal}?.querySelector('.modal-path')?.textContent === ${J(O)} && [...${modal}.querySelectorAll('[role="note"]')].some((n) => n.textContent.includes('协议 3'))`), 15000, 'picker on the old daemon, with its note');
  await click(`[...${modal}.querySelectorAll('.modal-item')].find((b) => b.querySelector('span')?.textContent === 'legacy')`, 'folder legacy');
  await waitFor(() => ev(`${modal}.querySelector('.modal-path').textContent === ${J(fx.legacy)} && !${modal}.querySelector('${tid('dialog-confirm')}').disabled`), 10000, 'picker in legacy');
  const picker = await ev(`({ name: !!${modal}.querySelector('${tid('wt-name-input')}'), note: [...${modal}.querySelectorAll('.modal-mode-note')].filter((n) => !n.hidden).map((n) => n.textContent) })`);
  eq(picker.name, false, 'a name field in the picker');
  assert(picker.note.includes('Worktree 模式会从所选仓库创建一个隔离分支。'), `the mode note: ${J(picker.note)}`);
  await click(`${modal}.querySelector('${tid('dialog-confirm')}')`, 'confirm');
  await dialogGone(15000);
  const id = await waitNewSession(OLD, before);
  const made = (await sessions(OLD)).find((s) => s.id === id);
  eq([made.mode, made.branch], ['worktree', `vibe/${id}`], 'mode and branch of the new session');
  assert(branchExists(fx.legacy, `vibe/${id}`) && existsSync(made.worktreeRoot), 'branch or directory missing on disk');
  // the rest works as before: input, output
  await shell('echo OLD_$((30+3))_DAEMON', 'OLD_33_DAEMON');

  // deleting a worktree session says what this daemon will do, and that is what happens
  await refresh();
  await click(`${srow(id)}.querySelector('.session-close')`, 'delete button of the session row');
  await waitDialog('delete-session-dialog');
  const said = await text(`${DLG('delete-session-dialog')}.querySelector('${tid('delete-session-note')}')`);
  eq(said, '这台机器的 vibe-remoted 是旧版：工作区干净时，worktree 的目录和分支会被一并删除；有未提交改动时会保留。', 'what the confirmation says');
  await click(`${DLG('delete-session-dialog')}.querySelector('${tid('dialog-confirm')}')`, 'delete session');
  await dialogGone();
  await waitFor(async () => !(await sessions(OLD)).some((s) => s.id === id), 10000, 'session gone');
  // (the old daemon drops the session from its list before it has finished with the worktree)
  await waitFor(() => !existsSync(made.worktreeRoot) && !branchExists(fx.legacy, `vibe/${id}`), 8000, 'the old daemon removing the clean worktree').catch(() => {});
  eq([existsSync(made.worktreeRoot), branchExists(fx.legacy, `vibe/${id}`)], [false, false], 'directory / branch of the clean worktree after the old daemon deleted the session');
  // and with uncommitted work it keeps both and says where
  writeFileSync(join(auto.worktreeRoot, 'wip.txt'), 'x\n');
  await click(`${srow(fx.oldWt)}.querySelector('.session-close')`, 'delete button of the other worktree session');
  await waitDialog('delete-session-dialog');
  await click(`${DLG('delete-session-dialog')}.querySelector('${tid('dialog-confirm')}')`, 'delete session');
  const kept = await waitFor(async () => { const m = await statusMessage(); return m.startsWith('Worktree 已保留') ? m : null; }, 15000, 'the "worktree preserved" message');
  assert(kept.includes(auto.worktreeRoot) && existsSync(join(auto.worktreeRoot, 'wip.txt')) && branchExists(fx.legacy, auto.branch), `kept: ${kept}`);
  return `grouped under legacy (main row, ${auto.branch}); quiet worktree not listed; both entries off: "${off.why}"; picker without a name field → vibe/${id}; delete note is the old-daemon one and true; dirty one: "${kept}"`;
});

test('R9.2', 'R9.2 the previous desktop\'s protocol against this daemon', async () => {
  // its own smoke script, as it was before this change
  const script = join(work, 'ws-smoke-base.mjs');
  const src = spawnSync(REAL_GIT, ['show', `${BASE_REF}:.claude/skills/verify/scripts/ws-smoke.mjs`], { cwd: ROOT, encoding: 'utf-8' });
  assert(src.status === 0, `git show ${BASE_REF}:…/ws-smoke.mjs failed`);
  writeFileSync(script, src.stdout);
  const r = spawnSync(process.execPath, [script, KEEP.addr, K], { encoding: 'utf-8', env: { ...cleanEnv(), VR_TOKEN: KEEP.token }, timeout: 120000 });
  const pass = (r.stdout.match(/^PASS /gm) ?? []).length;
  const failed = r.stdout.split('\n').filter((l) => l.startsWith('FAIL '));
  assert(r.status === 0 && failed.length === 0 && pass >= 10, `ws-smoke of ${BASE_REF}: exit ${r.status}, ${pass} PASS, FAIL: ${failed.join(' | ')}`);
  // Worktree mode as it sends it: no name → the branch is named by the daemon as before
  const ready = await createSession(KEEP, { workdir: fx.keep, mode: 'worktree' });
  const id = ready.sessionId;
  const s = (await sessions(KEEP)).find((x) => x.id === id);
  eq([s.mode, s.branch, s.worktreeRoot], ['worktree', `vibe/${id}`, join(K, 'keep-worktrees', id)], 'mode, branch and directory of the session');
  assert(branchExists(fx.keep, `vibe/${id}`) && listed(fx.keep, s.worktreeRoot), 'branch or worktree missing on disk');
  // attach, type, delete: the frames and the endpoint it knows
  const c = await Conn.open(KEEP);
  try {
    c.send({ type: 'attach', sessionId: id, cols: 100, rows: 30 });
    await c.wait((fs) => fs.some((f) => f.type === 'ready' && f.sessionId === id), 10000, 'attach to the existing session');
    c.send({ type: 'data', payload: Buffer.from('echo V3_$((3*3))_CLIENT\r').toString('base64') });
    await c.wait((fs) => fs.filter((f) => f.type === 'data').map((f) => Buffer.from(f.payload, 'base64').toString()).join('').includes('V3_9_CLIENT'), 10000, 'echo through the terminal');
  } finally {
    c.close();
  }
  eq((await endSession(KEEP, id)).status, 204, 'DELETE /api/v1/sessions/{id}');
  assert(!(await sessions(KEEP)).some((x) => x.id === id), 'the session is still listed');
  return `ws-smoke.mjs of ${BASE_REF}: ${pass} PASS, 0 FAIL; worktree mode without a name → vibe/${id}; attach, input, delete work`;
});

// ---- 评审留下的待验证项里要在真实窗口里看的两条（review.md 待验证项 11） -----------------------

test('X11.menu', 'an open row menu survives the sidebar being rebuilt and still works (review, pending 11)', async () => {
  await managedWorktree(LAB, fx.del, 'x11m');
  await rowShown(LAB, 'del', 'x11m');
  const row = wg(LAB, 'del', 'x11m');
  await ev(`${row}.scrollIntoView({ block: 'center' }), true`);
  const scrolled = await ev(`document.getElementById('machine-list').scrollTop`);
  await click(`${row}.querySelector('.worktree-row ${tid('worktree-menu')}')`, 'menu of x11m');
  await waitFor(() => exists(`document.querySelector('body > .menu ${tid('worktree-delete')}')`), 5000, 'the menu');
  // where the menu is, relative to its button
  const place = () => ev(`(() => { const menu = document.querySelector('body > .menu'); const btn = ${row}?.querySelector('${tid('worktree-menu')}'); if (!menu || !btn) return null; const a = btn.getBoundingClientRect(); const r = menu.getBoundingClientRect();
    return { gap: Math.round(Math.min(Math.abs(r.top - a.bottom), Math.abs(a.top - r.bottom))), left: Math.round(r.left - a.left), inWindow: a.top >= 0 && a.bottom <= innerHeight }; })()`);
  const before = await place();
  assert(before?.inWindow && before.gap <= 12, `the menu did not open next to its button: ${J(before)}`);
  const rebuilt = async () => {
    await ev(`${row}.dataset.vrMark = '1', true`);
    await refresh();
    return ev(`!${row}.dataset.vrMark`);
  };
  assert(await rebuilt(), 'the refresh did not rebuild the row');
  assert(await rebuilt(), 'the second refresh did not rebuild the row');
  const after = await place();
  assert(after, 'the menu closed when the sidebar was rebuilt');
  eq(after, before, 'where the menu is after two rebuilds');
  eq(await ev(`document.getElementById('machine-list').scrollTop`), scrolled, 'how far the sidebar is scrolled after two rebuilds');
  await click(`document.querySelector('body > .menu ${tid('worktree-delete')}')`, '"delete worktree" after two rebuilds');
  await waitDialog('delete-wt-dialog');
  eq((await deleteDialog()).title, '删除 worktree x11m？', 'the confirmation the menu item opened');
  await cancelDialog();
  return `after two rebuilds the menu is still ${after.gap}px from the same button, the sidebar is still scrolled to ${scrolled}px, and the item opens the confirmation`;
});

test('X11.removing', 'a worktree being deleted says so until its row is gone (review, pending 11)', async () => {
  const w = await managedWorktree(LAB, fx.del, 'x11r');
  await rowShown(LAB, 'del', 'x11r');
  const DELAY = 3000;
  await openDeleteWorktree(LAB, 'del', 'x11r');
  // the removal request and the refresh after it are both slow
  await ev(`window.__vrNet.delays = [{ match: ':${LAB.port}/api/v1/worktrees/remove', ms: ${DELAY}, times: 1 }], true`);
  const t0 = Date.now();
  await confirmDelete();
  await dialogGone();
  const samples = [];
  let slowedList = false;
  for (;;) {
    const row = await worktreeRow(LAB, 'del', 'x11r');
    if (!row) break;
    samples.push({ t: Date.now() - t0, removing: row.tags.includes('worktree-removing'), buttons: row.buttons });
    if (!slowedList && !existsSync(w.path)) {
      // the daemon has removed it: now the list that would take the row away is slow too
      slowedList = true;
      await ev(`window.__vrNet.delays.push({ match: ':${LAB.port}/api/v1/projects', ms: ${DELAY}, times: 3 }), true`);
    }
    assert(Date.now() - t0 < 30000, 'the row never went away');
    await sleep(150);
  }
  const took = Date.now() - t0;
  const plain = samples.filter((s) => !s.removing);
  assert(samples.length >= 15 && took >= DELAY, `too little was observed: ${samples.length} samples in ${took} ms`);
  assert(plain.length === 0, `${plain.length} of ${samples.length} samples show an ordinary row while it was being deleted, first at ${plain[0]?.t} ms: ${J(plain[0])}`);
  const usable = samples.filter((s) => s.buttons.some((b) => b === 'worktree-new-session' || b === 'worktree-empty-new-session'));
  assert(usable.length === 0, `"new session" could be used on the row while it was being deleted (first at ${usable[0]?.t} ms)`);
  eq(disk(fx.del, w.path, 'x11r'), { dir: false, listed: false, branch: false }, 'on disk');
  return `${samples.length} looks over ${took} ms (request and list each delayed ${DELAY} ms): the row always said "正在删除…" with "new session" off, then went away`;
});

// ---- 非功能：性能（spec「非功能要求」，tasks.md 测试计划的「性能 / 协议冒烟」一行） ----------------

test('NFR.perf', 'performance: 20 projects × 5 worktrees add at most 200 ms to the lists', async () => {
  const P = join(work, 'p');
  const perf = defineDaemon('perf', { cfg: { default_workdir: P, allowed_roots: [P], claude_cmd: '/bin/bash', claude_reload_cmd: '/bin/bash' } });
  daemons.delete('perf'); // not one of the app's machines
  mkdirSync(P);
  const median = async (path) => {
    const t = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      const r = await rest(perf, 'GET', path);
      await r.arrayBuffer();
      assert(r.status === 200, `${path}: ${r.status}`);
      t.push(performance.now() - t0);
    }
    return Math.round(t.sort((a, b) => a - b)[7] * 10) / 10;
  };
  try {
    await startDaemon(perf);
    const empty = await median('/api/v1/sessions');
    for (let i = 1; i <= 20; i++) {
      const repo = makeRepo(join(P, `proj-${String(i).padStart(2, '0')}`));
      for (let k = 1; k <= 4; k++) git(repo, 'worktree', 'add', '-q', '-b', `wt-${k}`, join(P, `proj-${String(i).padStart(2, '0')}-wt`, `wt-${k}`));
      await terminalIn(perf, repo); // one live session per project
    }
    const tree = await projects(perf);
    eq([tree.length, tree.reduce((n, p) => n + p.worktrees.length, 0)], [20, 100], 'projects / worktrees the daemon lists');
    const withProjects = await median('/api/v1/sessions');
    const list = await median('/api/v1/projects');
    assert(list <= 200, `/api/v1/projects takes ${list} ms (median of 15)`);
    assert(withProjects - empty <= 200, `/api/v1/sessions takes ${withProjects} ms with the projects, ${empty} ms without`);
    return `median of 15: /api/v1/projects ${list} ms; /api/v1/sessions ${empty} ms on an empty daemon, ${withProjects} ms with 20 projects × 5 worktrees and 20 sessions`;
  } finally {
    for (const s of await sessions(perf).catch(() => [])) await endSession(perf, s.id).catch(() => {});
    await stopDaemon(perf);
    spawnSync('tmux', ['-L', 'vibe-remote', 'kill-server'], { env: { ...cleanEnv(), TMUX_TMPDIR: perf.tmux }, stdio: 'ignore' });
  }
});

// @@CASES@@

// --- Run ------------------------------------------------------------------------

function build(out, pkg, cwd = join(ROOT, 'vibe-remoted')) {
  const r = spawnSync('go', ['build', '-o', out, pkg], { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`go build ${pkg} failed`);
}

function buildBaseDaemon() {
  if (process.env.VR_BASE_DAEMON) return process.env.VR_BASE_DAEMON;
  baseWorktree = join(work, 'base-src');
  const wt = spawnSync(REAL_GIT, ['worktree', 'add', '--detach', baseWorktree, BASE_REF], { cwd: ROOT, stdio: 'ignore' });
  if (wt.status !== 0) throw new Error(`git worktree add ${BASE_REF} failed`);
  const out = join(binDir, 'vibe-remoted-base');
  build(out, './cmd/vibe-remoted', join(baseWorktree, 'vibe-remoted'));
  return out;
}

const wants = (id) => ONLY.length === 0 || ONLY.some((o) => id === o || id.startsWith(`${o}.`));

async function setup() {
  mkdirSync(join(binDir, 'fake'), { recursive: true });
  if (process.env.VR_DAEMON) copyFileSync(resolve(process.env.VR_DAEMON), daemonBin);
  else build(daemonBin, './cmd/vibe-remoted');
  build(fakeClaude, './internal/chat/fakeclaude');
  // `claude` on this-mac and lab-mac: the fake claude for chat sessions and
  // the version probe, a shell for terminal sessions.
  writeFileSync(claudeBin, `#!/bin/bash\nfor a in "$@"; do case "$a" in -p|--print|--version|-v) exec ${J(fakeClaude)} "$@";; esac; done\nexec /bin/bash\n`, { mode: 0o755 });
  // keep-mac's git: the real one, except that `worktree remove` fails while the flag file exists.
  mkdirSync(gitWrapDir, { recursive: true });
  writeFileSync(join(gitWrapDir, 'git'), `#!/bin/bash\nif [ -f ${J(gitFailFlag)} ]; then w=0; for a in "$@"; do [ "$a" = worktree ] && w=1; if [ $w = 1 ] && [ "$a" = remove ]; then echo "fatal: simulated failure of worktree remove (gui-worktree-smoke)" >&2; exit 1; fi; done; fi\nexec ${J(REAL_GIT)} "$@"\n`, { mode: 0o755 });
  const baseBin = buildBaseDaemon();

  // this-mac: the spec's example.
  fx.devflow = makeRepo(join(A, 'devflow'));
  fx.general = join(fx.devflow, '.devflow-tmp', 'worktrees', 'general-skills');
  git(fx.devflow, 'worktree', 'add', '-q', '-b', 'change/general-skills', fx.general);
  fx.detached = join(A, 'devflow-wt', 'detached');
  git(fx.devflow, 'worktree', 'add', '-q', '--detach', fx.detached);
  fx.newApi = makeRepo(join(A, 'new-api'), 'dev');
  fx.notes = join(A, 'notes');
  mkdirSync(fx.notes);

  // lab-mac: what the cases change.
  fx.webapp = makeRepo(join(L, 'webapp'));
  git(fx.webapp, 'branch', 'taken-branch');
  fx.occupied = join(L, 'webapp-worktrees', 'occupied');
  mkdirSync(fx.occupied, { recursive: true });
  writeFileSync(join(fx.occupied, 'keep.txt'), 'here first\n');
  fx.del = makeRepo(join(L, 'del'));
  fx.untrusted = makeRepo(join(L, 'untrusted'));
  fx.untrustedWt = join(L, 'untrusted-wt', 'a');
  git(fx.untrusted, 'worktree', 'add', '-q', '-b', 'topic-a', fx.untrustedWt);
  fx.selftrust = makeRepo(join(L, 'selftrust'));
  fx.selftrustWt = join(L, 'selftrust-wt', 'b');
  git(fx.selftrust, 'worktree', 'add', '-q', '-b', 'topic-b', fx.selftrustWt);
  fx.failrepo = makeRepo(join(L, 'failrepo'));
  git(fx.failrepo, 'worktree', 'add', '-q', '-b', 'side', join(L, 'failrepo-wt', 'side'));

  // keep-mac
  for (const name of ['keep', 'rm', 'prune', 'gone', 'broken', 'fail', 'fail2']) fx[name] = makeRepo(join(K, name));
  fx.keepSide = join(K, 'keep-wt', 'side');
  git(fx.keep, 'worktree', 'add', '-q', '-b', 'side', fx.keepSide);
  fx.rmSide = join(K, 'rm-wt', 'side');
  git(fx.rm, 'worktree', 'add', '-q', '-b', 'side', fx.rmSide);
  mkdirSync(join(fx.rm, 'sub'));
  writeFileSync(join(fx.rm, 'sub', 'file.txt'), 'x\n');
  git(fx.rm, 'add', 'sub');
  git(fx.rm, 'commit', '-q', '-m', 'sub');

  // narrow-mac: the repository is the only allowed root; one of its worktrees is outside.
  makeRepo(N);
  fx.outside = join(work, 'n', 'outside-wt');
  git(N, 'worktree', 'add', '-q', '-b', 'outside', fx.outside);

  // old-mac
  fx.legacy = makeRepo(join(O, 'legacy'));
  fx.legacyQuiet = join(O, 'legacy-wt', 'quiet');
  git(fx.legacy, 'worktree', 'add', '-q', '-b', 'quiet', fx.legacyQuiet);

  const flags = [{ id: 'continue', label: '续上次会话 (-c)', arg: '-c' }];
  const claudeCfg = { claude_cmd: claudeBin, claude_reload_cmd: claudeBin, login_shell: false, claude_flags: flags };
  const bashCfg = { claude_cmd: '/bin/bash', claude_reload_cmd: '/bin/bash', claude_flags: flags };
  const configDir = (name, dirs) => {
    const dir = join(work, 'd', name, 'cc');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, '.claude.json'), trusted(dirs), { mode: 0o600 });
    return dir;
  };
  WT = defineDaemon('this-mac', { cfg: { default_workdir: A, allowed_roots: [A], ...claudeCfg } });
  WT.env = { CLAUDE_CONFIG_DIR: configDir('this-mac', [fx.devflow]), FAKE_CLAUDE_LONG_COMMANDS: '1' };
  LAB = defineDaemon('lab-mac', { cfg: { default_workdir: L, allowed_roots: [L], ...claudeCfg } });
  LAB.env = { CLAUDE_CONFIG_DIR: configDir('lab-mac', [fx.webapp, fx.del, fx.selftrustWt]), FAKE_CLAUDE_LONG_COMMANDS: '1' };
  KEEP = defineDaemon('keep-mac', { cfg: { default_workdir: K, allowed_roots: [K], ...bashCfg }, env: { PATH: `${gitWrapDir}:${process.env.PATH}` } });
  NARROW = defineDaemon('narrow-mac', { cfg: { default_workdir: N, allowed_roots: [N], ...bashCfg } });
  OLD = defineDaemon('old-mac', { bin: baseBin, cfg: { default_workdir: O, allowed_roots: [O], ...bashCfg } });
  for (const d of daemons.values()) await startDaemon(d);
  const protos = {};
  for (const d of daemons.values()) protos[d.name] = (await (await rest(d, 'GET', '/api/v1/info')).json()).proto;
  eq([protos['this-mac'], protos['old-mac']], [4, 3], 'protocol of the new and of the old daemon');
  ok(`${daemons.size} daemons up (${[...daemons.values()].map((d) => `${d.name}:${d.port} proto ${protos[d.name]}`).join(', ')})`);

  // Sessions of the spec's picture: 3 projects, 8 sessions on this-mac.
  fx.mainChat = await chatIn(WT, fx.devflow);
  fx.main2 = await terminalIn(WT, fx.devflow);
  fx.main3 = await terminalIn(WT, fx.devflow);
  fx.fix = await managedWorktree(WT, fx.devflow, 'fix-login', { keep: true });
  eq((await rename(WT, fx.fix.id, '登录修复')).status, 204, 'rename');
  fx.api1 = await terminalIn(WT, fx.newApi);
  fx.api2 = await terminalIn(WT, fx.newApi);
  fx.notes1 = await terminalIn(WT, fx.notes);
  fx.notes2 = await terminalIn(WT, fx.notes);
  for (const dir of [fx.webapp, fx.del, fx.untrusted, fx.selftrust, fx.failrepo]) await registerProject(LAB, dir);
  await registerProject(NARROW, N);
  fx.oldMain = await terminalIn(OLD, fx.legacy);
  fx.oldWt = (await createSession(OLD, { workdir: fx.legacy, mode: 'worktree' })).sessionId;
}

async function resetUi() {
  if (!cdp) return;
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await ev(`(() => { const n = window.__vrNet; if (n) { n.offline = false; n.cut = null; n.delays = []; } return true; })()`).catch(() => {});
  // A dialog a failed case left open: its Cancel button, else Escape sent to
  // it; one that survives both is taken out, so the next case starts clean.
  for (let i = 0; i < 6 && (await exists(`document.querySelector('.modal-overlay')`).catch(() => false)); i++) {
    await ev(`(() => { const o = [...document.querySelectorAll('.modal-overlay')].pop(); const b = o.querySelector('${tid('dialog-cancel')}') ?? o.querySelector('.btn-secondary');
      if (${i} < 2 && b) b.click(); else if (${i} < 4) o.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); else o.remove(); return true; })()`).catch(() => {});
    await sleep(150);
  }
  await closeMenus().catch(() => {});
  if ((await ev('document.documentElement.lang').catch(() => 'zh-CN')) !== 'zh-CN') await ev(`document.getElementById('btn-lang').click(), true`).catch(() => {});
  for (const [dir, mode] of chmodBack.splice(0)) { try { chmodSync(dir, mode); } catch { /* gone */ } }
  rmSync(gitFailFlag, { force: true });
}

async function main() {
  console.log(`work dir ${work}`);
  if (args.has('--list')) {
    for (const c of cases) console.log(`${c.id}\t${c.name}`);
    return;
  }
  await setup();

  if (!args.has('--no-build')) {
    const vb = spawnSync('npx', ['vite', 'build'], { cwd: DESKTOP, stdio: ['ignore', 'ignore', 'inherit'] });
    if (vb.status !== 0) throw new Error('vite build failed');
  }

  mkdirSync(userData, { recursive: true });
  const machines = [...daemons.values()].map((d) => ({ name: d.name, addr: '127.0.0.1', port: d.port, token: d.token }));
  writeFileSync(join(userData, 'machines.json'), J(machines), { mode: 0o600 });
  // A window of a known size instead of the maximized default (not the 800×500 minimum: that is emulated where it matters).
  writeFileSync(join(userData, 'window-state.json'), J({ width: 1280, height: 800, x: 60, y: 40 }));
  await launchApp({ recordFirstFrame: true });
  await waitFor(async () => (await sidebar(WT))?.projects.length >= 3, 20000, 'this-mac lists its projects');
  ok(`app started with ${daemons.size} machines (zh), hooks installed`);

  const selected = cases.filter((c) => wants(c.id));
  for (const c of selected) {
    const t0 = Date.now();
    try {
      const detail = await c.fn();
      ok(`${c.name}${detail ? ` — ${detail}` : ''}`);
      results.push({ id: c.id, name: c.name, ok: true, detail, ms: Date.now() - t0 });
    } catch (e) {
      fail(`${c.name} — ${e.message.split('\n')[0]}`);
      results.push({ id: c.id, name: c.name, ok: false, detail: e.message, ms: Date.now() - t0 });
      await evidence(`${c.id}-FAIL`).catch(() => {});
    }
    await resetUi();
  }

  if (cdp) {
    const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
    exceptions.length === 0 ? ok('no uncaught renderer exceptions') : fail(`renderer exceptions: ${exceptions.join(' | ')}`);
  }
  if (process.env.VR_GUI_LOG) writeFileSync(process.env.VR_GUI_LOG, electronLog + '\n--- daemons ---\n' + [...daemons.values()].map((d) => `## ${d.name}\n${d.log}`).join('\n'));

  const groups = new Map();
  for (const r of results) {
    const g = /^R\d+/.exec(r.id)?.[0] ?? 'other';
    const e = groups.get(g) ?? { pass: 0, fail: 0 };
    r.ok ? e.pass++ : e.fail++;
    groups.set(g, e);
  }
  console.log(`\n${results.length} cases: ${[...groups.entries()].map(([g, e]) => `${g} ${e.pass}/${e.pass + e.fail}`).join(', ')}`);
  if (process.env.VR_RESULTS) writeFileSync(process.env.VR_RESULTS, J(results.map((r) => ({ ...r, detail: String(r.detail ?? '') })), null, 2));

  if (args.has('--keep')) {
    console.log(`--keep: app left running (CDP 127.0.0.1:${cdpPort}, main inspector ${inspectPort}); press Ctrl+C to clean up`);
    await new Promise((r) => process.once('SIGINT', r));
  }
}

async function cleanup() {
  try {
    if (cdp && savedClipboard !== null) await cdp.evaluate(`window.vibeRemote.writeClipboardText(${J(savedClipboard)})`);
  } catch { /* app gone */ }
  await quitApp();
  for (const [dir, mode] of chmodBack.splice(0)) { try { chmodSync(dir, mode); } catch { /* gone */ } }
  for (const d of daemons.values()) {
    if (d.proc) for (const s of await sessions(d).catch(() => [])) await endSession(d, s.id).catch(() => {});
    await stopDaemon(d);
    // The tmux server of this daemon only: -L vibe-remote under its own TMUX_TMPDIR.
    spawnSync('tmux', ['-L', 'vibe-remote', 'kill-server'], { env: { ...cleanEnv(), TMUX_TMPDIR: d.tmux }, stdio: 'ignore' });
  }
  if (baseWorktree) spawnSync(REAL_GIT, ['worktree', 'remove', '--force', baseWorktree], { cwd: ROOT, stdio: 'ignore' });
  // --use-mock-keychain keeps Chromium off the login keychain. If the app's item
  // appeared during the run, it is reported and left alone: it may as well
  // belong to the installed app.
  if (!keychainExisted && keychainHas(keychainService)) note(`a "${keychainService}" keychain item appeared during this run; not removed`);
  if (existsSync(work)) {
    // read-only leftovers of the failure cases
    spawnSync('chmod', ['-R', 'u+rwx', work], { stdio: 'ignore' });
    rmSync(work, { recursive: true, force: true });
  }
}

let interrupted = false;
process.on('SIGTERM', () => { interrupted = true; cleanup().finally(() => process.exit(143)); });

main()
  .catch((e) => fail(e.message))
  .finally(async () => {
    if (interrupted) return;
    await cleanup();
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall GUI worktree checks passed');
    process.exit(failures ? 1 : 0);
  });
