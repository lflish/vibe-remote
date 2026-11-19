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
//   VR_CDP_PORT / VR_INSPECT_PORT  fixed debug ports (with --keep, for poking around)
// Requires Node 22+, Go, tmux, git; macOS with a display.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
const DESKTOP = join(ROOT, 'desktop');
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
    net.fetched.push({ url, t: performance.now(), delayed: rule ? rule.ms : 0 });
    if (rule) {
      if (rule.times !== undefined) rule.times--;
      await new Promise((r) => setTimeout(r, rule.ms));
    }
    return origFetch.call(window, input, init);
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

async function waitDialog(id, ms = 8000) {
  await waitFor(() => exists(DLG(id)), ms, `dialog ${id}`);
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

/** "New session" on a worktree row (or a flat project's row): opens the dialog and waits until it can be confirmed. */
async function openNewSessionDialog(d, proj, label) {
  const button = label === null
    ? `${pg(d, proj)}?.querySelector(':scope > .project-row ${tid('project-new-session')}')`
    : `${wg(d, proj, label)}?.querySelector('.worktree-row ${tid('worktree-new-session')}')`;
  await click(button, `"new session" on ${proj}${label ? ` / ${label}` : ''}`);
  await waitDialog('worktree-session-dialog');
  // machine info and the folder's trust are in: the chat card's state is final
  await waitFor(() => ev(`(() => { const d = ${DLG('worktree-session-dialog')}; const b = d.querySelector('${tid('dialog-confirm')}'); const c = d.querySelector('${tid('picker-ui-chat')}'); const r = d.querySelector('${tid('picker-ui-chat-reason')}');
    return !b.disabled && (!c.disabled || (r.textContent !== '' && !r.textContent.includes('正在检查'))); })()`), 15000, 'new-session dialog ready');
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
  default: d.querySelector('.modal-footer button[data-default]')?.dataset.testid ?? null }; })()`);

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
  await evidence('R3.1-dialog');
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
  build(daemonBin, './cmd/vibe-remoted');
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
  WT.env = { CLAUDE_CONFIG_DIR: configDir('this-mac', [fx.devflow]) };
  LAB = defineDaemon('lab-mac', { cfg: { default_workdir: L, allowed_roots: [L], ...claudeCfg } });
  LAB.env = { CLAUDE_CONFIG_DIR: configDir('lab-mac', [fx.webapp, fx.del, fx.selftrustWt]) };
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
  for (let i = 0; i < 4 && (await exists(`document.querySelector('.modal-overlay')`).catch(() => false)); i++) {
    await pressKey('Escape').catch(() => {});
    await sleep(200);
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
