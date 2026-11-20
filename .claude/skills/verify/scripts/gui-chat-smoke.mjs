#!/usr/bin/env node
// Browser (CDP) acceptance cases for chat sessions (docs/changes/2026-11-13-dual-mode,
// the 「dev-test / 浏览器」 rows of tasks.md). Sibling of gui-smoke.mjs: same way of
// launching the *built* app (stock Electron, throwaway userData,
// --use-mock-keychain) against throwaway daemons, never the developer's
// machines.json, keychain, ~/.claude or tmux.
//
// Machines (all 127.0.0.1, random ports, own tmux server each):
//   gui-term        /bin/bash daemon (terminal sessions; chat card greyed: not claude)
//   gui-chat        fake claude, claude_flags -c / --dangerously-skip-permissions
//   gui-old-claude  fake claude reporting 1.0.51 (chat card greyed: claude too old)
//   gui-old-init    fake claude whose system/init says 1.0.0 (R13.4)
//   gui-main        vibe-remoted built from the main branch (protocol 2, R17.2)
//
// Network faults are simulated inside the renderer: WebSocket is wrapped
// (before any chat view exists) so a test can hold incoming frames, drop
// outgoing ones, close a socket, or refuse new connections ("offline"). A
// second "desktop" is a plain WebSocket client in this script. The main
// process is reached over --inspect to read the Dock badge, stub
// shell.openExternal (no real browser is opened) and simulate a notification
// click.
//
// Usage (from the repo root):
//   node .claude/skills/verify/scripts/gui-chat-smoke.mjs [--no-build] [--keep]
//   DEVFLOW_EVIDENCE_DIR=<dir>  save a PNG per case (<case>.png)
//   VR_MAIN_DAEMON=<path>       reuse a main-branch vibe-remoted build
//   VR_CDP_PORT / VR_INSPECT_PORT  fixed debug ports (with --keep, for poking around)
//   VR_ONLY=<id,id,…>           run only these cases (ids as in test('<id>', …)); only
//                               for cases that set up their own sessions (X7-*, X8-*, X10-*)
// Requires Node 22+, Go, tmux, git; macOS with a display.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { pickerLayout } from './picker-layout.mjs';
import { slashMenuLayout } from './slash-menu-layout.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DESKTOP = join(ROOT, 'desktop');
const args = new Set(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EVIDENCE_DIR = process.env.DEVFLOW_EVIDENCE_DIR ? resolve(process.env.DEVFLOW_EVIDENCE_DIR) : '';

let failures = 0;
const results = [];
const ok = (msg) => console.log(`PASS ${msg}`);
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`); };

async function waitFor(fn, ms, what, interval = 120) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`timeout (${ms}ms): ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- Throwaway environment ---------------------------------------------------

// Short base path: tmux sockets live under it (macOS caps them at ~104 bytes).
const work = realpathSync(mkdtempSync('/tmp/vr-gc-'));
const binDir = join(work, 'bin');
const daemonBin = join(binDir, 'vibe-remoted');
const claudeBin = join(binDir, 'claude');
const userData = join(work, 'userData');
const cdpPort = Number(process.env.VR_CDP_PORT) || 30000 + Math.floor(Math.random() * 10000);
const inspectPort = Number(process.env.VR_INSPECT_PORT) || 40000 + Math.floor(Math.random() * 10000);
const keychainService = 'vibe-remote Safe Storage';
const keychainExisted = keychainHas(keychainService);
let mainWorktree = '';
const daemons = new Map();
let electron = null;
let cdp = null;
let mainProc = null;
let savedClipboard = null;
const usedPorts = new Set();

function keychainHas(service) {
  return spawnSync('security', ['find-generic-password', '-s', service], { stdio: 'ignore' }).status === 0;
}

function freePort() {
  for (;;) {
    const p = 20000 + Math.floor(Math.random() * 10000);
    if (!usedPorts.has(p)) { usedPorts.add(p); return p; }
  }
}

const trusted = (dirs) => JSON.stringify({ projects: Object.fromEntries(dirs.map((d) => [d, { hasTrustDialogAccepted: true }])) });

// A daemon description: name (= machine name), bin, cfg object, env extras.
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR', 'TMUX', 'TMUX_PANE'].includes(k) || k.startsWith('FAKE_CLAUDE_')) continue;
    env[k] = v;
  }
  return env;
}

async function startDaemon(d) {
  writeFileSync(d.cfgPath, JSON.stringify(d.cfg), { mode: 0o600 });
  d.proc = spawn(d.bin, ['--config', d.cfgPath], { env: { ...cleanEnv(), TMUX_TMPDIR: d.tmux, ...d.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  d.log = '';
  d.proc.stdout.on('data', (x) => { d.log += x; });
  d.proc.stderr.on('data', (x) => { d.log += x; });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${d.port}/healthz`)).ok, 15000, `${d.name} /healthz`).catch((e) => {
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

function defineDaemon(name, { bin = daemonBin, cfg, env = {} }) {
  const port = freePort();
  const token = randomBytes(32).toString('hex');
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const tmux = join(dir, 't');
  mkdirSync(tmux, { recursive: true });
  const d = { name, bin, port, token, tmux, env, cfgPath: join(dir, 'daemon.json'), cfg: { bind_addr: '127.0.0.1', port, token, ...cfg } };
  daemons.set(name, d);
  return d;
}

const rest = (d, method, path, body) => fetch(`http://127.0.0.1:${d.port}${path}`, {
  method,
  headers: { Authorization: `Bearer ${d.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
async function sessions(d) {
  return (await (await rest(d, 'GET', '/api/v1/sessions')).json()).list ?? [];
}

// --- A second "desktop": plain WebSocket client --------------------------------

class Conn {
  static async open(d) {
    const c = new Conn();
    c.ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
    c.frames = [];
    c.waiters = new Set();
    c.ws.onmessage = (ev) => {
      c.frames.push(JSON.parse(ev.data));
      for (const w of [...c.waiters]) w();
    };
    await new Promise((res, rej) => { c.ws.onopen = res; c.ws.onerror = () => rej(new Error('ws open failed')); });
    c.send({ type: 'auth', token: d.token });
    return c;
  }

  send(frame) { this.ws.send(JSON.stringify(frame)); }
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

  lastState() {
    return [...this.frames].reverse().find((f) => f.type === 'chat_state');
  }

  chat(text) {
    const id = `m-${randomBytes(4).toString('hex')}`;
    this.send({ type: 'chat_send', clientMsgId: id, text });
    return id;
  }

  /** Waits for the result that ends the turn of clientMsgId. */
  turn(id, ms = 20000) {
    return this.wait((fs) => {
      const i = fs.findIndex((f) => f.type === 'chat' && f.msg?.vr_client_msg_id === id);
      if (i < 0) return null;
      const j = fs.findIndex((f, k) => k > i && f.type === 'chat' && f.msg?.type === 'result');
      return j < 0 ? null : fs.slice(i, j + 1);
    }, ms, `turn ${id}`);
  }
}

// --- CDP ------------------------------------------------------------------------

async function cdpSocket(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`CDP websocket ${wsUrl}`)); });
  let nextId = 0;
  const pending = new Map();
  const events = [];
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
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
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, extra = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...extra });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { ws, send, evaluate, events, listeners };
}

async function connectRenderer() {
  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    return list.find((t) => t.type === 'page' && t.url.startsWith('file://'));
  }, 30000, 'app page target');
  return cdpSocket(target.webSocketDebuggerUrl);
}

async function connectMain() {
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0], 20000, 'main process inspector');
  const s = await cdpSocket(target.webSocketDebuggerUrl);
  return { ...s, evaluate: (expr) => s.evaluate(expr, { includeCommandLineAPI: true }) };
}

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const KEYS = { Enter: [13, 'Enter', '\r'], Escape: [27, 'Escape'], Tab: [9, 'Tab'], ArrowDown: [40, 'ArrowDown'], ArrowUp: [38, 'ArrowUp'], 1: [49, 'Digit1', '1'] };

async function pressKey(key, modifiers = 0) {
  const [vk, code, txt] = KEYS[key] ?? [key.toUpperCase().charCodeAt(0), `Key${key.toUpperCase()}`, key];
  const textToType = modifiers & (MOD.meta | MOD.ctrl) ? undefined : txt;
  const base = { key, code, modifiers, windowsVirtualKeyCode: vk };
  await cdp.send('Input.dispatchKeyEvent', { type: textToType ? 'keyDown' : 'rawKeyDown', text: textToType, ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// --- Real input ------------------------------------------------------------------
// What a hand does, through the browser's input pipeline (hit testing, focus,
// click / dblclick synthesis, wheel scrolling) — element.click() and setting
// scrollTop skip all of that, which is how X7 and X8 went unnoticed.

/**
 * Centre of the element `expr` evaluates to; it must be what a pointer there hits.
 * A sidebar row that is scrolled out of the list is scrolled into it first: with
 * project rows and two-line session rows the sessions of a run no longer fit in
 * the window. Only the sidebar — the transcript is never scrolled from here.
 */
async function pointOf(expr, what) {
  const p = await ev(`(() => {
    const e = ${expr};
    if (!e) return null;
    if (e.closest('#machine-list')) e.scrollIntoView({ block: 'nearest' });
    const r = e.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: !!hit && (hit === e || e.contains(hit)) };
  })()`);
  assert(p, `${what}: not on the page`);
  assert(p.hit, `${what}: something else is on top of it`);
  return p;
}

/**
 * Watches the sidebar list from inside the page: when it was last rebuilt, and
 * how often it was rebuilt while a mouse button was down. The list is rebuilt
 * as a whole whenever a refresh lands — every 5 s, and after a session was
 * created or renamed; on the three-level sidebar twice per machine (the
 * sessions, then the project tree, which the daemon answers later).
 */
const SIDEBAR_WATCH = `(() => {
  if (window.__vrSidebar) return true;
  const w = window.__vrSidebar = { at: performance.now(), down: false, hits: 0 };
  document.addEventListener('mousedown', () => { w.down = true; }, true);
  document.addEventListener('mouseup', () => { w.down = false; }, true);
  new MutationObserver(() => { w.at = performance.now(); if (w.down) w.hits++; }).observe(document.getElementById('machine-list'), { childList: true });
  return true; })()`;

/** Waits until the sidebar list has not been rebuilt for 300 ms: what the previous step set off (a new session, a rename) has landed. */
async function sidebarQuiet() {
  await ev(SIDEBAR_WATCH);
  await waitFor(() => ev(`performance.now() - window.__vrSidebar.at > 300`), 15000, 'the sidebar to stop being rebuilt', 40);
}

/**
 * A real double click on a session's name in the sidebar (to rename it).
 *
 * A rebuild of the list between a press and its release takes the pressed name
 * out from under the pointer, and the click — here the second one, with the
 * dblclick — is never delivered. That is a known problem of the app that is
 * not fixed (follow-up list in docs/changes/2026-11-13-dual-mode/tasks.md:
 * "按下和松开之间刚好重建"), and it is not what these cases are about; with
 * five machines a refresh is ten rebuilds over some 50 ms
 * (docs/changes/2026-11-16-project-worktrees/evidence/merge-dual-mode/trace-*.txt).
 * So the gesture is watched: when the list was rebuilt while the button was
 * down and no rename started, that is printed (NOTE) and the gesture is made
 * again, at most twice. A double click that was not disturbed is never
 * repeated; what it leads to is asserted by the caller as before.
 */
async function doubleClickName(expr, what) {
  for (let attempt = 1; ; attempt++) {
    await sidebarQuiet();
    await ev(`(window.__vrSidebar.hits = 0, true)`);
    await realClick(expr, what, 2);
    const hits = await ev(`window.__vrSidebar.hits`);
    if (hits === 0 || attempt >= 3) return;
    await sleep(300);
    if (await renameFocused()) return;
    console.log(`NOTE double click on ${what}: the sidebar was rebuilt ${hits}× while the button was down and the click was lost (known, not fixed); doing it again (attempt ${attempt + 1})`);
  }
}

/** A real click (count 2 = a double click at a human pace: 40 ms down, 90 ms between). */
async function realClick(expr, what, count = 1) {
  const p = await pointOf(expr, what);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  for (let n = 1; n <= count; n++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: n });
    await sleep(40);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: n });
    if (n < count) await sleep(90);
  }
}

/** A real wheel turn over the element (deltaY > 0 scrolls down). */
async function realWheel(expr, deltaY, what) {
  const p = await pointOf(expr, what);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY });
}

async function evidence(name) {
  if (!EVIDENCE_DIR || !cdp) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const m = await cdp.evaluate('({ w: innerWidth, h: innerHeight })');
  const file = join(EVIDENCE_DIR, `${name}.png`);
  for (const scale of [1, 0.8, 0.65, 0.5, 0.4]) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width: m.w, height: m.h, scale } });
    const buf = Buffer.from(r.data, 'base64');
    if (buf.length < 300_000 || scale === 0.4) {
      writeFileSync(file, buf);
      return;
    }
  }
}

// --- Page helpers -----------------------------------------------------------------

const $tid = (id, root = 'document') => `${root}.querySelector('[data-testid="${id}"]')`;
const VC = `[...document.querySelectorAll('.chat-instance')].find((c) => c.style.display !== 'none')`;
const inChat = (sel) => `${VC}?.querySelector(${JSON.stringify(sel)})`;
const ev = (expr) => cdp.evaluate(expr);
// zh locale strings (the run forces zh, see main()).
const zh = { checking: '正在检查这台机器是否支持对话界面…' };

// Fake network faults in the renderer (installed before any chat view).
const NET_HOOK = `(() => {
  if (window.__vrNet) return true;
  const Orig = window.WebSocket;
  const desc = Object.getOwnPropertyDescriptor(Orig.prototype, 'onmessage');
  const net = { sockets: [], offline: false, ready: [] };
  class W extends Orig {
    constructor(url, p) {
      super(net.offline ? 'ws://127.0.0.1:9/ws' : url, p);
      this.__url = url; this.__hold = false; this.__buf = []; this.__dropSend = false; this.__sid = '';
      net.sockets.push(this);
    }
    send(d) { if (this.__dropSend) return; super.send(d); }
    get onmessage() { return this.__h || null; }
    set onmessage(h) {
      this.__h = h;
      desc.set.call(this, h ? (e) => {
        try { const f = JSON.parse(e.data); if (f.type === 'ready') { this.__sid = f.sessionId; net.ready.push({ sid: f.sessionId, t: performance.now() }); } } catch {}
        if (this.__hold) this.__buf.push(e); else h.call(this, e);
      } : null);
    }
    release() { this.__hold = false; const b = this.__buf; this.__buf = []; for (const e of b) this.__h && this.__h.call(this, e); }
  }
  window.WebSocket = W;
  window.__vrNet = net;
  window.__vrSock = (sid) => net.sockets.filter((s) => s.__sid === sid && s.readyState === 1).pop();
  return true;
})()`;

async function openMachine(name) {
  await ev(`[...document.querySelectorAll('.machine-name')].find((b) => b.querySelector('.machine-name-label')?.textContent === ${JSON.stringify(name)}).click(), true`);
  await waitFor(() => ev(`!!document.querySelector('.workspace-mode-card:not([disabled])')`), 20000, `${name} online`);
}

async function openPicker(name) {
  await openMachine(name);
  await ev(`document.querySelector('.workspace-mode-card:not([disabled])').click(), true`);
  await waitFor(() => ev(`(() => { const b = document.querySelector('.modal .modal-footer .btn-primary'); return !!b && !b.disabled; })()`), 15000, 'dir picker listed');
  // machine info loaded = the chat card's state is final
  await waitFor(() => ev(`(() => { const c = ${$tid('picker-ui-chat')}; const r = ${$tid('picker-ui-chat-reason')}; return !!c && (!c.disabled || (r && r.textContent && !r.textContent.includes(${JSON.stringify(zh.checking)}))); })()`), 15000, 'chat availability known');
}

async function pickerEnter(sub) {
  await ev(`[...document.querySelectorAll('.modal .modal-item')].find((b) => b.querySelector('span')?.textContent === ${JSON.stringify(sub)}).click(), true`);
  await waitFor(() => ev(`(() => { const p = document.querySelector('.modal .modal-path')?.textContent || ''; const b = document.querySelector('.modal .modal-footer .btn-primary'); return p.endsWith('/' + ${JSON.stringify(sub)}) && !!b; })()`), 10000, `picker in ${sub}`);
}

async function pickerFlags(ids) {
  for (const id of ids) {
    await waitFor(() => ev(`!!document.querySelector('.modal input[name="claude-flag-${id}"]')`), 10000, `flag ${id}`);
    await ev(`(() => { const i = document.querySelector('.modal input[name="claude-flag-${id}"]'); if (!i.checked) i.click(); return true; })()`);
  }
}

async function pickerChat() {
  await waitFor(() => ev(`(() => { const c = ${$tid('picker-ui-chat')}; return !!c && !c.disabled; })()`), 10000, 'chat card enabled');
  await ev(`${$tid('picker-ui-chat')}.click(), true`);
  await waitFor(() => ev(`(() => { const b = document.querySelector('.modal .modal-footer .btn-primary'); return !!b && !b.disabled && ${$tid('picker-ui-chat')}.getAttribute('aria-pressed') === 'true'; })()`), 10000, 'chat chosen');
}

const pickerOpen = () => ev(`document.querySelector('.modal .modal-footer .btn-primary').click(), true`);
const pickerCancel = () => ev(`document.querySelector('.modal .modal-footer .btn-secondary').click(), true`);

/** New chat session on machine `d` in <root>/<sub>; returns its session id. */
async function newChat(d, sub, flags = []) {
  const before = new Set((await sessions(d)).map((s) => s.id));
  await openPicker(d.name);
  await pickerEnter(sub);
  await pickerFlags(flags);
  await pickerChat();
  await pickerOpen();
  await waitFor(() => ev(`(() => { const v = ${VC}; const i = v?.querySelector('[data-testid="chat-input"]'); return !!i && !i.disabled && !!v.querySelector('.c-hint')?.textContent; })()`), 20000, 'chat view open');
  const s = await waitFor(async () => (await sessions(d)).find((x) => !before.has(x.id) && x.ui === 'chat'), 10000, 'new chat session listed');
  await waitFor(() => ev(`!!window.__vrSock(${JSON.stringify(s.id)})`), 10000, 'chat socket ready');
  await waitFor(() => ev(`${inChat('[data-testid="chat-input"]')}?.closest('.chat-bottom') && ${VC}.querySelector('.composer:not(.dis)') !== null`), 10000, 'chat connected');
  return s.id;
}

async function sendChat(msg) {
  // Never type into whatever else has focus (Enter on the EN button flips the locale).
  await waitFor(() => ev(`(() => { const i = ${inChat('[data-testid="chat-input"]')}; i?.focus(); return !!i && document.activeElement === i; })()`), 5000, 'chat input focused');
  await cdp.send('Input.insertText', { text: msg });
  await pressKey('Enter');
}

const assistantText = () => ev(`[...${VC}.querySelectorAll('[data-testid="chat-msg-assistant"]')].map((m) => m.textContent).join('\\n')`);
const transcriptText = () => ev(`${inChat('[data-testid="chat-transcript"]')}?.textContent || ''`);
const userCount = (t) => ev(`[...${VC}.querySelectorAll('[data-testid="chat-msg-user"]')].filter((m) => m.querySelector('.u-text')?.textContent === ${JSON.stringify(t)}).length`);
const status = () => ev(`${VC}.querySelector('.c-hint span')?.textContent || ''`);
async function idle() {
  await waitFor(() => ev(`(() => { const s = ${inChat('[data-testid="chat-stop"]')}; return !!s && s.hidden && !${VC}.querySelector('.spin'); })()`), 20000, 'turn over');
}
async function waitAssistant(sub, ms = 15000) {
  await waitFor(async () => (await assistantText()).includes(sub), ms, `assistant "${sub}"`);
}
const scrollBottom = () => ev(`(() => { const t = ${inChat('[data-testid="chat-transcript"]')}; t.scrollTop = t.scrollHeight; return true; })()`);
const clearInput = () => ev(`(() => { const i = ${inChat('[data-testid="chat-input"]')}; i.value = ''; i.dispatchEvent(new Event('input')); return true; })()`);

/** Opens the session whose sidebar label text is `label` on machine `d`. */
async function openSidebar(d, label, ui = 'chat') {
  await ev(`(() => {
    const g = [...document.querySelectorAll('.machine-name')].find((b) => b.querySelector('.machine-name-label')?.textContent === ${JSON.stringify(d.name)}).closest('.machine-group') ?? document;
    const it = [...g.querySelectorAll('.session-item')].find((i) => i.dataset.ui === ${JSON.stringify(ui)} && i.querySelector('.session-label-text')?.textContent === ${JSON.stringify(label)});
    it.querySelector('.session-label').click(); return true; })()`);
}
const sidebarItem = (d, label, expr, ui = 'chat') => ev(`(() => {
  const g = [...document.querySelectorAll('.machine-name')].find((b) => b.querySelector('.machine-name-label')?.textContent === ${JSON.stringify(d.name)}).closest('.machine-group') ?? document;
  const it = [...g.querySelectorAll('.session-item')].find((i) => i.dataset.ui === ${JSON.stringify(ui)} && i.querySelector('.session-label-text')?.textContent === ${JSON.stringify(label)});
  return it ? (${expr}) : null; })()`);

// Real-input variants (X7 / X8 cases).
const TRANSCRIPT = inChat('[data-testid="chat-transcript"]');
const INPUT = inChat('[data-testid="chat-input"]');
const scrollState = () => ev(`(() => { const t = ${TRANSCRIPT}; return { top: t.scrollTop, gap: t.scrollHeight - t.scrollTop - t.clientHeight, client: t.clientHeight, height: t.scrollHeight }; })()`);
const lastAssistant = () => ev(`[...${VC}.querySelectorAll('[data-testid="chat-msg-assistant"]')].pop()?.textContent.trim() || ''`);
/** Is the last assistant message inside the transcript's viewport? */
const lastAssistantOnScreen = () => ev(`(() => { const m = [...${VC}.querySelectorAll('[data-testid="chat-msg-assistant"]')].pop(); if (!m) return false; const r = m.getBoundingClientRect(), t = ${TRANSCRIPT}.getBoundingClientRect(); return r.bottom <= t.bottom + 1 && r.bottom > t.top; })()`);
async function wheelTo(deltaY, pred, what) {
  await realWheel(TRANSCRIPT, deltaY, 'chat transcript');
  return waitFor(async () => { const s = await scrollState(); return pred(s) ? s : null; }, 4000, what);
}
/** Click into the input box and type `msg` + Enter, all as real input events. */
async function typeChat(msg) {
  await realClick(INPUT, 'chat input');
  await waitFor(() => ev(`document.activeElement === ${INPUT}`), 3000, 'the click focused the chat input');
  await cdp.send('Input.insertText', { text: msg });
  await pressKey('Enter');
}
const sidebarLabel = (d, label, ui = 'chat') => `(() => {
  const g = [...document.querySelectorAll('.machine-name')].find((b) => b.querySelector('.machine-name-label')?.textContent === ${JSON.stringify(d.name)})?.closest('.machine-group');
  return [...(g?.querySelectorAll('.session-item') ?? [])].find((i) => i.dataset.ui === ${JSON.stringify(ui)} && i.querySelector('.session-label-text')?.textContent === ${JSON.stringify(label)})?.querySelector('.session-label') ?? null; })()`;
/** Switch sessions with a real click on the sidebar. */
async function clickSidebar(d, label, ui = 'chat') {
  for (let attempt = 0; ; attempt++) {
    await realClick(sidebarLabel(d, label, ui), `sidebar item ${label}`);
    try {
      await waitFor(() => sidebarItem(d, label, `it.classList.contains('active')`, ui), 1500, `${label} is the current session`);
      return;
    } catch (e) {
      // The sidebar is rebuilt every 5 s; a rebuild between press and release
      // swallows that click (tasks.md follow-up list). One more try.
      if (attempt >= 1) throw e;
    }
  }
}

// --- Cases ------------------------------------------------------------------------

const cases = [];
const test = (id, name, fn) => cases.push({ id, name, fn });

let TERM, CHAT, OLD, INIT, MAIN; // daemons
let chatRoot = '';
let histU = '';
let other = null; // second desktop on the main chat session
let S1 = ''; // main chat session id (dir "main")
let X7 = ''; // the X7 cases' own chat session (dir "x7")
const dialogs = [];

test('R1.3', 'R1.3 bash machine: chat card disabled with the reason', async () => {
  await openPicker(TERM.name);
  const st = await ev(`({ disabled: ${$tid('picker-ui-chat')}.disabled, reason: ${$tid('picker-ui-chat-reason')}.textContent, term: ${$tid('picker-ui-terminal')}.getAttribute('aria-pressed') })`);
  assert(st.disabled === true, `chat card enabled: ${JSON.stringify(st)}`);
  assert(st.reason === '对话界面只支持 claude：这台机器的 claude_cmd 不是 claude', `reason ${JSON.stringify(st.reason)}`);
  assert(st.term === 'true', 'terminal card not the default');
  await ev(`${$tid('picker-ui-chat')}.click(), true`);
  assert((await ev(`${$tid('picker-ui-chat')}.getAttribute('aria-pressed')`)) === 'false', 'clicking the disabled chat card selected it');
  return st.reason;
});

test('R1.1', 'R1.1 default new session is a terminal session', async () => {
  // picker still open from R1.3, nothing touched in 界面
  const before = new Set((await sessions(TERM)).map((s) => s.id));
  await pickerOpen();
  const screen = () => ev(`(() => { const r = [...document.querySelectorAll('.term-instance')].find((c) => c.style.display !== 'none')?.querySelector('.xterm-rows'); return r ? r.innerText : ''; })()`);
  await waitFor(async () => /\$ ?$|\$\s/m.test(await screen()), 20000, 'shell prompt');
  await ev(`document.querySelector('.term-instance:not([style*="none"]) .xterm-helper-textarea')?.focus(), true`);
  await cdp.send('Input.insertText', { text: 'echo R11_$((5+6))_OK' });
  await pressKey('Enter');
  await waitFor(async () => (await screen()).includes('R11_11_OK'), 10000, 'echo output');
  const created = (await sessions(TERM)).filter((s) => !before.has(s.id));
  assert(created.length === 1 && (created[0].ui ?? 'terminal') === 'terminal', `created ${JSON.stringify(created)}`);
  assert(!(await ev(`!!${VC}`)), 'a chat view is visible');
  assert(await ev(`!!document.querySelector('.session-item.active[data-ui="terminal"]')`), 'active sidebar item is not a terminal');
  return `session ${created[0].id}`;
});

test('R1.4', 'R1.4 claude too old: chat card disabled, upgrade claude', async () => {
  await openPicker(OLD.name);
  const st = await ev(`({ disabled: ${$tid('picker-ui-chat')}.disabled, reason: ${$tid('picker-ui-chat-reason')}.textContent })`);
  assert(st.disabled, 'chat card enabled');
  assert(st.reason === '远程 claude 版本 1.0.51 低于对话界面要求的 2.1.210，请升级 claude', `reason ${JSON.stringify(st.reason)}`);
  await evidence('R1.4');
  await pickerCancel();
  return st.reason;
});

test('picker-layout', 'new-session dialog: buttons reachable in 500/700/803px-high windows', async () => {
  // tallest state: chat chosen on a machine with launch flags (flag note shown)
  await openPicker(CHAT.name);
  await waitFor(() => ev(`document.querySelectorAll('.modal .modal-flag').length === 2`), 10000, 'launch flags listed');
  await pickerChat();
  const layout = await pickerLayout(cdp);
  await evidence('picker-layout');
  await pickerCancel();
  const bad = layout.filter((l) => l.problems.length > 0);
  assert(bad.length === 0, bad.map((l) => `${l.height}px: ${l.problems.join('; ')}`).join(' | '));
  return layout.map((l) => `${l.height}px ok`).join(', ');
});

test('R17.2', 'R17.2 new desktop + protocol-2 daemon: terminal works, chat card says upgrade vibe-remoted', async () => {
  await openPicker(MAIN.name);
  const st = await ev(`({ disabled: ${$tid('picker-ui-chat')}.disabled, reason: ${$tid('picker-ui-chat-reason')}.textContent, warn: [...document.querySelectorAll('.modal [role="note"]')].map((n) => n.textContent).join(' ') })`);
  assert(st.disabled, 'chat card enabled');
  assert(st.reason === '这台机器的 vibe-remoted（协议 2）不支持对话界面（需要协议 3），请升级 vibe-remoted', `reason ${JSON.stringify(st.reason)}`);
  await evidence('R17.2-picker');
  await pickerOpen();
  const screen = () => ev(`(() => { const r = [...document.querySelectorAll('.term-instance')].find((c) => c.style.display !== 'none')?.querySelector('.xterm-rows'); return r ? r.innerText : ''; })()`);
  await waitFor(async () => /\$ ?$|\$\s/m.test(await screen()), 20000, 'shell prompt on the old daemon');
  await ev(`document.querySelector('.term-instance:not([style*="none"]) .xterm-helper-textarea')?.focus(), true`);
  await cdp.send('Input.insertText', { text: 'echo OLD_$((40+2))_DAEMON' });
  await pressKey('Enter');
  await waitFor(async () => (await screen()).includes('OLD_42_DAEMON'), 10000, 'echo on old daemon');
  await evidence('R17.2');
  return `${st.reason}; picker note: ${st.warn}`;
});

test('R1.5', 'R1.5 chat + -c shows the full 3000-line history, windowed', async () => {
  const id = await newChat(CHAT, 'hist', ['continue']);
  const count = () => ev(`${VC}.querySelectorAll('[data-testid="chat-msg-user"], [data-testid="chat-msg-assistant"]').length`);
  await waitFor(async () => (await transcriptText()).includes('hist-a #1000'), 20000, 'newest history message');
  await sleep(300);
  const initial = await count();
  assert(initial > 0 && initial <= 300, `initial DOM messages ${initial}`);
  assert(!(await transcriptText()).includes('hist-q #0001'), 'oldest message rendered on first screen');
  assert(await ev(`!!${VC}.querySelector('[data-testid="chat-tool"][data-tool="Read"]')`), 'no tool block in history');
  await evidence('R1.5');
  let scrolls = 0;
  while (!(await transcriptText()).includes('hist-q #0001') && scrolls < 30) {
    await ev(`(() => { const t = ${inChat('[data-testid="chat-transcript"]')}; t.scrollTop = 0; t.dispatchEvent(new Event('scroll')); return true; })()`);
    await sleep(120);
    scrolls++;
  }
  const all = await count();
  assert((await transcriptText()).includes('hist-q #0001'), `oldest not reached after ${scrolls} scrolls`);
  assert(all === 2000, `rendered ${all} messages, want 2000 (1000 user + 1000 assistant)`);
  await evidence('R1.5-top');
  await scrollBottom();
  await sendChat('echo after history');
  await waitAssistant('after history');
  const last = await ev(`[...${VC}.querySelectorAll('[data-testid="chat-msg-assistant"]')].pop().textContent`);
  assert(last.includes('after history'), `last message ${last}`);
  const argv = readFileSync(join(work, 'argv.log'), 'utf-8');
  const runs = argv.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a.includes(histU));
  assert(runs.length > 0 && runs.every((a) => a[a.indexOf('--resume') + 1] === histU && !a.includes('-c') && !a.includes('--continue')), `claude argv ${JSON.stringify(runs)}`);
  return `session ${id}; first screen ${initial} messages; ${scrolls} scrolls to the first; total 2000`;
});

test('R1.6', 'R1.6/R11.2 bypass: mode fixed, no permission prompts', async () => {
  await newChat(CHAT, 'bypass', ['skip']);
  await waitFor(() => ev(`${inChat('[data-testid="chat-mode"]')}.dataset.mode === 'bypassPermissions'`), 10000, 'bypass mode chip');
  await ev(`${inChat('[data-testid="chat-mode"]')}.click(), true`);
  const menu = await ev(`(() => { const o = [...${VC}.querySelectorAll('[data-testid="chat-mode-option"]')]; return { modes: o.map((x) => x.dataset.mode), disabled: o.every((x) => x.disabled), why: ${VC}.querySelector('[data-testid="chat-mode-locked"]')?.textContent || '' }; })()`);
  assert(menu.modes.join() === 'bypassPermissions' && menu.disabled && menu.why, `menu ${JSON.stringify(menu)}`);
  await evidence('R1.6');
  await ev(`document.body.click(), true`);
  let sawPrompt = false;
  await sendChat('tool Bash');
  await waitFor(async () => {
    if (await ev(`!!${inChat('[data-testid="chat-perm"]')}`)) sawPrompt = true;
    return (await assistantText()).includes('done Bash');
  }, 15000, 'Bash ran');
  assert(!sawPrompt, 'a permission prompt appeared in bypass');
  return `menu ${menu.modes.join()} (${menu.why})`;
});

test('X7-send', 'X7 scrolled up with the wheel: a typed message and its reply show; replies do not drag the view; reaching the bottom shows them', async () => {
  X7 = await newChat(CHAT, 'x7');
  await sendChat('burst 80');
  await waitFor(async () => (await lastAssistant()) === 'burst 80', 15000, 'burst 80 rendered');
  await idle();
  const s0 = await scrollState();
  assert(s0.gap < 48 && s0.height > s0.client + 400, `expected more than a screen of content, at the bottom: ${JSON.stringify(s0)}`);
  // (1) not at the bottom → send
  await wheelTo(-300, (s) => s.gap >= 200, 'scrolled up 300px');
  await typeChat('echo x7 can you see this');
  await waitFor(async () => (await userCount('echo x7 can you see this')) === 1, 5000, 'own message shown after sending while scrolled up');
  await waitAssistant('x7 can you see this', 8000);
  await idle();
  const s1 = await scrollState();
  assert(s1.gap < 48 && (await lastAssistantOnScreen()), `after sending the view is not at the bottom: ${JSON.stringify(s1)}`);
  await evidence('X7-send');
  // (4) reading history: a reply from elsewhere does not drag the view …
  const up = await wheelTo(-300, (s) => s.gap >= 200, 'scrolled up again');
  const c = await Conn.open(CHAT);
  try {
    await c.attachChat(X7);
    await c.turn(c.chat('echo x7 from elsewhere'));
    await sleep(600);
    const s2 = await scrollState();
    assert(Math.abs(s2.top - up.top) < 2, `the view moved while reading history: ${up.top} → ${s2.top}`);
    // (2) … and is there on reaching the bottom, with no further session update.
    await wheelTo(100000, (s) => s.gap < 2, 'wheel down to the bottom');
    await sleep(300);
    // When the assertion below is about to fail, say where things are: it failed
    // once in a run of several cases and in none of twelve runs alone.
    if (!((await lastAssistant()).includes('x7 from elsewhere') && (await lastAssistantOnScreen()))) {
      console.log(`NOTE X7-send, newest reply not on screen at the bottom: ${await ev(`(() => { const t = ${TRANSCRIPT}; const m = [...${VC}.querySelectorAll('[data-testid="chat-msg-assistant"]')].pop(); const r = m?.getBoundingClientRect(), b = t.getBoundingClientRect(); return JSON.stringify({ gap: Math.round(t.scrollHeight - t.scrollTop - t.clientHeight), height: t.scrollHeight, lastBottom: r ? Math.round(r.bottom) : null, viewport: [Math.round(b.top), Math.round(b.bottom)] }); })()`)}`);
    }
    assert((await lastAssistant()).includes('x7 from elsewhere') && (await lastAssistantOnScreen()), `at the bottom the newest reply is missing; last message: ${await lastAssistant()}`);
  } finally {
    c.close();
  }
  return `gap after sending ${Math.round(s1.gap)}px; history kept at ${Math.round(up.top)}px while a reply arrived`;
});

test('X7-background', 'X7 background session got more than a screen: back at the bottom with the newest, a typed message shows; left scrolled up → same place', async () => {
  const c = await Conn.open(CHAT);
  try {
    await c.attachChat(X7);
    await clickSidebar(CHAT, 'x7');
    await wheelTo(100000, (s) => s.gap < 2, 'x7 at the bottom');
    await newChat(CHAT, 'x7b'); // x7 is now a background session
    await c.turn(c.chat('burst 40'), 30000);
    await clickSidebar(CHAT, 'x7');
    await waitFor(async () => (await lastAssistant()) === 'burst 40', 5000, 'newest message rendered on return');
    await sleep(400);
    const s = await scrollState();
    assert(s.gap < 48 && (await lastAssistantOnScreen()), `back from the background the view is ${Math.round(s.gap)}px above the newest message`);
    await typeChat('echo x7 back');
    await waitFor(async () => (await userCount('echo x7 back')) === 1, 5000, 'message typed right after returning is shown');
    await waitAssistant('x7 back', 8000);
    await idle();
    assert((await scrollState()).gap < 48, 'not at the bottom after sending');
    await evidence('X7-background');
    // left scrolled up: same place on return, the newest is rendered below
    const up = await wheelTo(-400, (st) => st.gap >= 300, 'scrolled up 400px');
    await clickSidebar(CHAT, 'x7b');
    await c.turn(c.chat('burst 6'), 15000);
    await clickSidebar(CHAT, 'x7');
    await waitFor(async () => (await lastAssistant()) === 'burst 6', 5000, 'newest message rendered on return (scrolled up)');
    await sleep(400);
    const s3 = await scrollState();
    assert(Math.abs(s3.top - up.top) < 2, `left scrolled up at ${up.top}px, came back at ${s3.top}px`);
    await wheelTo(100000, (st) => st.gap < 2, 'wheel down to the bottom');
    assert(await lastAssistantOnScreen(), 'the newest message is not reachable by scrolling down');
    return `back at the bottom (gap ${Math.round(s.gap)}px) after 40 messages in the background; scrolled-up place kept (${Math.round(up.top)}px)`;
  } finally {
    c.close();
  }
});

// X8: rename by double click, with the real pointer (two presses 90 ms apart).
const renameFocused = () => ev(`(() => { const i = document.querySelector('.session-rename-input'); return !!i && i.isConnected && document.activeElement === i; })()`);
async function renameByDoubleClick(d, label, ui, name) {
  await doubleClickName(sidebarLabel(d, label, ui), `sidebar item ${label}`);
  // Whatever the two clicks set off (session switch, redraw, focus) has run by now.
  await sleep(600);
  assert(await renameFocused(), `double click on "${label}": no focused rename input 600 ms later (focus is on ${await ev(`document.activeElement?.className || document.activeElement?.tagName`)})`);
  await cdp.send('Input.insertText', { text: name });
  await pressKey('Enter');
  await waitFor(async () => (await sessions(d)).some((x) => x.title === name), 5000, `"${name}" saved on the daemon`);
  await waitFor(() => sidebarItem(d, name, 'true', ui), 5000, `sidebar shows "${name}"`);
}

test('X8-chat', 'X8 double click on an open chat session (current, then background) renames it; the name is not sent to claude; the sidebar keeps updating', async () => {
  const id = await newChat(CHAT, 'x8');
  const c = await Conn.open(CHAT);
  try {
    await c.attachChat(id);
    const from = c.frames.length;
    // current session
    await renameByDoubleClick(CHAT, 'x8', 'chat', '登录页重构');
    const after = await ev(`({ users: ${VC}.querySelectorAll('[data-testid="chat-msg-user"]').length, input: ${INPUT}.value })`);
    assert(after.users === 0 && after.input === '', `the new name went into the chat: ${JSON.stringify(after)}`);
    // open, but in the background
    const idB = await newChat(CHAT, 'x8b');
    await renameByDoubleClick(CHAT, '登录页重构', 'chat', 'x8 第二个名字');
    assert(await sidebarItem(CHAT, 'x8 第二个名字', `it.classList.contains('active')`), 'the double-clicked session did not become the current one');
    await sleep(500);
    assert(!c.frames.slice(from).some((f) => f.type === 'chat'), 'claude got a message during the renames');
    assert((await ev(`${VC}.querySelectorAll('[data-testid="chat-msg-user"]').length`)) === 0, 'a user message appeared in the renamed session');
    // The sidebar is not frozen: a turn in the (now background) x8b lights its dot,
    // and a click still switches sessions.
    const cb = await Conn.open(CHAT);
    try {
      await cb.attachChat(idB);
      await cb.turn(cb.chat('echo x8 background turn'));
      await waitFor(() => sidebarItem(CHAT, 'x8b', `it.dataset.dot !== 'none'`), 8000, 'activity dot on x8b after the rename');
    } finally {
      cb.close();
    }
    await clickSidebar(CHAT, 'x8b');
    await evidence('X8-chat');
    return 'current → "登录页重构", background → "x8 第二个名字"; no chat traffic; sidebar dot and switch still work';
  } finally {
    c.close();
  }
});

test('X8-terminal', 'X8 double click on an open terminal session (current ×3, background ×2) renames it; nothing is typed into the shell', async () => {
  const screen = () => ev(`(() => { const r = [...document.querySelectorAll('.term-instance')].find((c) => c.style.display !== 'none')?.querySelector('.xterm-rows'); return r ? r.innerText : ''; })()`);
  const newTerminal = async (sub) => {
    await openPicker(TERM.name);
    await pickerEnter(sub);
    await pickerOpen();
    await waitFor(() => sidebarItem(TERM, sub, `it.classList.contains('active')`, 'terminal'), 20000, `terminal session ${sub} open`);
    await waitFor(async () => /\$ ?$|\$\s/m.test(await screen()), 20000, 'shell prompt');
  };
  await newTerminal('x8t');
  let name = 'x8t';
  for (const next of ['build box', 'build box 2', 'build box 3']) {
    await renameByDoubleClick(TERM, name, 'terminal', next);
    name = next;
  }
  assert(!(await screen()).includes('build box'), `the new name was typed into the shell: ${JSON.stringify((await screen()).slice(-200))}`);
  await newTerminal('x8u'); // the renamed one is now open in the background
  for (const next of ['bg box', 'bg box 2']) {
    await renameByDoubleClick(TERM, name, 'terminal', next);
    assert(await sidebarItem(TERM, next, `it.classList.contains('active')`, 'terminal'), 'the double-clicked session did not become the current one');
    name = next;
    await clickSidebar(TERM, 'x8u', 'terminal');
  }
  await clickSidebar(TERM, name, 'terminal');
  assert(!(await screen()).includes('box'), `a new name was typed into the shell: ${JSON.stringify((await screen()).slice(-200))}`);
  await evidence('X8-terminal');
  return `5 renames, last "${name}"`;
});

// X10: where the keyboard is after opening a session that waits for an answer,
// and after a rename. Between the action and the keys there is no click: the
// keys go wherever the app left the focus.
const focusedOn = () => ev(`(() => { const a = document.activeElement; return !a ? 'nothing' : a === document.body ? 'BODY (nowhere)' : (a.dataset?.testid || String(a.className) || a.tagName); })()`);
const lastBash = () => ev(`(() => { const d = [...${VC}.querySelectorAll('[data-testid="chat-tool"][data-tool="Bash"]')].pop(); return d ? d.dataset.status : ''; })()`);

test('X10-prompt', 'X10 a background chat session asks for permission (yellow dot): a real click opens it, then 1 answers / Esc interrupts without clicking the card, and typing goes on in the input', async () => {
  const id = await newChat(CHAT, 'x10');
  await newChat(CHAT, 'x10b'); // x10 is now a background session
  const c = await Conn.open(CHAT);
  try {
    await c.attachChat(id);
    const openWaiting = async (turnText) => {
      const turn = c.chat(turnText);
      await waitFor(() => sidebarItem(CHAT, 'x10', `it.dataset.dot === 'waiting'`), 10000, 'yellow dot on x10');
      await clickSidebar(CHAT, 'x10');
      await waitFor(() => ev(`!!${inChat('[data-testid="chat-perm"]')}`), 5000, 'the prompt card is on screen');
      await sleep(400); // whatever the click set off (switch, redraw, focus) has run
      return turn;
    };
    // (1) the key 1 = "yes"
    let turn = await openWaiting('tool Bash');
    let focus = await focusedOn();
    await evidence('X10-prompt');
    await pressKey('1');
    await waitFor(() => ev(`!${inChat('[data-testid="chat-perm"]')}`), 4000, `the card to close after pressing 1 without clicking it (the keyboard was on: ${focus})`);
    await c.turn(turn);
    await idle();
    assert((await lastBash()) === 'ok' && (await assistantText()).includes('done Bash'), `the turn did not go on after 1: Bash is ${await lastBash()}`);
    // … and the next message is typed without a click, too.
    await sleep(300);
    focus = await focusedOn();
    await cdp.send('Input.insertText', { text: 'echo x10 typed after the answer' });
    await pressKey('Enter');
    await waitFor(async () => (await userCount('echo x10 typed after the answer')) === 1, 4000, `the message typed right after answering (the keyboard was on: ${focus})`);
    await waitAssistant('x10 typed after the answer', 8000);
    await idle();
    // (2) Esc = interrupt the request
    await clickSidebar(CHAT, 'x10b');
    turn = await openWaiting('perm touch x10-esc.txt');
    focus = await focusedOn();
    await pressKey('Escape');
    await waitFor(() => ev(`!${inChat('[data-testid="chat-perm"]')}`), 4000, `the card to close after pressing Esc without clicking it (the keyboard was on: ${focus})`);
    await idle();
    await waitFor(async () => (await transcriptText()).includes('Bash 的请求已中断'), 5000, 'the request shown as interrupted');
    assert((await lastBash()) !== 'ok', 'the tool ran although the request was interrupted');
    return `opened from the yellow dot: keyboard on ${focus}; 1 → done Bash, next message typed without a click; Esc → request interrupted`;
  } finally {
    c.close();
  }
});

test('X10-rename-chat', 'X10 after renaming a chat session (Enter, Esc, a click on another session) the next keys go into the current session, without a click', async () => {
  const id = await newChat(CHAT, 'x10r');
  await newChat(CHAT, 'x10s');
  await clickSidebar(CHAT, 'x10r');
  const c = await Conn.open(CHAT);
  try {
    await c.attachChat(id);
    const typeNow = async (msg, where) => {
      await sleep(300); // the rename is over; nothing is clicked from here on
      const focus = await focusedOn();
      await cdp.send('Input.insertText', { text: msg });
      await pressKey('Enter');
      await waitFor(async () => (await userCount(msg)) === 1, 4000, `"${msg}" to show up in ${where} — typed without a click (the keyboard was on: ${focus})`);
      await waitAssistant(msg.replace(/^echo /, ''), 8000);
      await idle();
    };
    // Enter
    await renameByDoubleClick(CHAT, 'x10r', 'chat', 'x10 改名');
    await typeNow('echo typed after rename', 'the renamed session');
    // Esc
    await doubleClickName(sidebarLabel(CHAT, 'x10 改名'), 'sidebar item x10 改名');
    await waitFor(renameFocused, 3000, 'rename input focused');
    await cdp.send('Input.insertText', { text: '不保存的名字' });
    await pressKey('Escape');
    await waitFor(() => ev(`!document.querySelector('.session-rename-input')`), 3000, 'rename cancelled');
    assert(await sidebarItem(CHAT, 'x10 改名', 'true'), 'Esc changed the name');
    await typeNow('echo typed after esc', 'the session');
    assert((await ev(`${INPUT}.value`)) === '', 'part of the cancelled name stayed in the input');
    await evidence('X10-rename-chat');
    // A click on another session commits the rename and switches: keys go there.
    // The rename request takes 500 ms here, as against a remote daemon: on
    // 127.0.0.1 it is back — and the sidebar rebuilt — before the button is
    // released, and a rebuild under the pointer swallows the click (tasks.md
    // follow-up list).
    const from = c.frames.length;
    await doubleClickName(sidebarLabel(CHAT, 'x10 改名'), 'sidebar item x10 改名');
    await waitFor(renameFocused, 3000, 'rename input focused');
    await cdp.send('Input.insertText', { text: 'x10 名字二' });
    await ev(`(() => { const f = window.fetch; window.__x10Fetch = f; window.fetch = (u, o) => String(u).includes('/rename') ? new Promise((r) => setTimeout(r, 500)).then(() => f(u, o)) : f(u, o); return true; })()`);
    try {
      await realClick(sidebarLabel(CHAT, 'x10s'), 'sidebar item x10s');
      await waitFor(async () => (await sessions(CHAT)).some((x) => x.title === 'x10 名字二'), 5000, 'the name was saved by clicking elsewhere');
    } finally {
      await ev(`(window.fetch = window.__x10Fetch, true)`);
    }
    await waitFor(() => sidebarItem(CHAT, 'x10s', `it.classList.contains('active')`), 5000, 'x10s is the current session');
    await waitFor(() => sidebarItem(CHAT, 'x10 名字二', 'true'), 5000, 'sidebar shows the saved name');
    await typeNow('echo typed in the other session', 'the session that was clicked');
    assert(!c.frames.slice(from).some((f) => f.type === 'chat'), 'the renamed session got a message');
    return 'Enter, Esc and click-elsewhere: the next message was typed without a click each time';
  } finally {
    c.close();
  }
});

test('X10-rename-terminal', 'X10 after renaming a terminal session (Enter, Esc) the next keys go into the terminal, without a click', async () => {
  const screen = () => ev(`(() => { const r = [...document.querySelectorAll('.term-instance')].find((c) => c.style.display !== 'none')?.querySelector('.xterm-rows'); return r ? r.innerText : ''; })()`);
  await openPicker(TERM.name);
  await pickerEnter('x10t');
  await pickerOpen();
  await waitFor(() => sidebarItem(TERM, 'x10t', `it.classList.contains('active')`, 'terminal'), 20000, 'terminal session x10t open');
  await waitFor(async () => /\$ ?$|\$\s/m.test(await screen()), 20000, 'shell prompt');
  const typeNow = async (cmd, out) => {
    await sleep(300); // the rename is over; nothing is clicked from here on
    const focus = await focusedOn();
    await cdp.send('Input.insertText', { text: cmd });
    await pressKey('Enter');
    await waitFor(async () => (await screen()).includes(out), 5000, `${out} on the terminal — typed without a click (the keyboard was on: ${focus})`);
  };
  await renameByDoubleClick(TERM, 'x10t', 'terminal', 'x10 box');
  await typeNow('echo X10_$((6*7))_TYPED', 'X10_42_TYPED');
  await doubleClickName(sidebarLabel(TERM, 'x10 box', 'terminal'), 'sidebar item x10 box');
  await waitFor(renameFocused, 3000, 'rename input focused');
  await cdp.send('Input.insertText', { text: 'zzz-not-kept' });
  await pressKey('Escape');
  await waitFor(() => ev(`!document.querySelector('.session-rename-input')`), 3000, 'rename cancelled');
  await typeNow('echo X10_$((7*7))_ESC', 'X10_49_ESC');
  const out = await screen();
  assert(!out.includes('x10 box') && !out.includes('zzz-not-kept'), `a name was typed into the shell: ${JSON.stringify(out.slice(-200))}`);
  await evidence('X10-rename-terminal');
  return 'Enter and Esc: the next command was typed without a click';
});

test('S1', 'main chat session created (dir main)', async () => {
  S1 = await newChat(CHAT, 'main');
  other = await Conn.open(CHAT);
  await other.attachChat(S1);
  return S1;
});

test('R3.2', 'R3.2 markdown + code copy button', async () => {
  await sendChat('md');
  await waitFor(() => ev(`!!${VC}.querySelector('[data-testid="chat-msg-assistant"] table')`), 15000, 'table rendered');
  await idle();
  const m = await ev(`(() => { const a = [...${VC}.querySelectorAll('[data-testid="chat-msg-assistant"]')].pop();
    return { h1: !!a.querySelector('h1'), li: a.querySelectorAll('li').length, table: !!a.querySelector('table td'), code: !!a.querySelector('p code'),
      pre: getComputedStyle(a.querySelector('pre code')).fontFamily, copy: !!a.querySelector('.cb .cb-copy') }; })()`);
  assert(m.h1 && m.li === 2 && m.table && m.code && m.copy, JSON.stringify(m));
  assert(/mono|Menlo|Monaco|Courier/i.test(m.pre), `code font ${m.pre}`);
  await cdp.evaluate(`window.vibeRemote.writeClipboardText('__before__')`);
  await ev(`[...${VC}.querySelectorAll('.cb-copy')].pop().click(), true`);
  const clip = await waitFor(async () => { const t = await ev('window.vibeRemote.readClipboardText()'); return t !== '__before__' ? t : null; }, 5000, 'clipboard');
  assert(clip.trim() === 'fmt.Println("hi")', `clipboard ${JSON.stringify(clip)}`);
  await evidence('R3.2');
  return `font ${m.pre.split(',')[0]}`;
});

test('R3.3', 'R3.3 raw html/script inert, links go to the system browser', async () => {
  const m = await ev(`(() => { const a = [...${VC}.querySelectorAll('[data-testid="chat-msg-assistant"]')].pop();
    return { script: a.querySelectorAll('script').length, img: a.querySelectorAll('img').length, onerr: !!a.querySelector('[onerror]'),
      text: a.textContent, links: [...a.querySelectorAll('a')].map((x) => [x.textContent, x.getAttribute('href')]) }; })()`);
  assert(m.script === 0 && m.img === 0 && !m.onerr, JSON.stringify(m));
  assert(m.text.includes('<script>alert(1)</script>') && m.text.includes('<img src=x onerror=alert(1)>'), 'raw html not shown as text');
  assert(!m.links.some(([, h]) => h && h.startsWith('javascript')), `javascript: href ${JSON.stringify(m.links)}`);
  const before = await ev('location.href');
  await mainProc.evaluate(`globalThis.__opened = []; require('electron').shell.openExternal = async (u) => { globalThis.__opened.push(u); }; true`);
  await ev(`[...[...${VC}.querySelectorAll('[data-testid="chat-msg-assistant"]')].pop().querySelectorAll('a')].find((x) => x.textContent === 'ok').click(), true`);
  const opened = await waitFor(async () => { const o = await mainProc.evaluate('JSON.stringify(globalThis.__opened)'); return o !== '[]' ? o : null; }, 5000, 'open-external');
  await ev(`[...[...${VC}.querySelectorAll('[data-testid="chat-msg-assistant"]')].pop().querySelectorAll('a')].find((x) => x.textContent === 'x')?.click(), true`);
  await sleep(500);
  assert((await ev('location.href')) === before, 'window navigated');
  assert(opened === '["https://example.com"]', `opened ${opened}`);
  assert((await mainProc.evaluate('JSON.stringify(globalThis.__opened)')) === '["https://example.com"]', 'javascript: link reached open-external');
  assert(dialogs.length === 0, `dialogs ${JSON.stringify(dialogs)}`);
  await evidence('R3.3');
  return `links ${JSON.stringify(m.links)}; open-external got ${opened}`;
});

test('R4', 'R4 tool blocks: Read/Grep folded, Bash output, Edit diff, failure', async () => {
  for (const cmd of ['tool Read', 'tool Grep']) {
    await sendChat(cmd);
    await idle();
  }
  const allowNext = async () => {
    await waitFor(() => ev(`!!${inChat('[data-testid="chat-perm-allow"]')}`), 10000, 'permission prompt');
    await ev(`${inChat('[data-testid="chat-perm-allow"]')}.click(), true`);
    await idle();
  };
  await sendChat('tool Bash');
  await allowNext();
  await sendChat('tool Edit');
  await allowNext();
  await sendChat('tool Bash fail');
  await allowNext();
  const tools = await ev(`[...${VC}.querySelectorAll('[data-testid="chat-tool"]')].slice(-5).map((d) => ({ tool: d.dataset.tool, status: d.dataset.status, open: d.open, diff: !!d.querySelector('[data-testid="chat-diff"]'), text: d.textContent }))`);
  const [read, grep, bash, edit, bad] = tools;
  assert(read.tool === 'Read' && read.status === 'ok' && !read.open && read.text.includes('README.md'), `Read ${JSON.stringify(read)}`);
  assert(grep.tool === 'Grep' && grep.status === 'ok' && !grep.open && grep.text.includes('TODO'), `Grep ${JSON.stringify(grep)}`);
  assert(bash.tool === 'Bash' && bash.status === 'ok' && bash.text.includes('echo fake'), `Bash ${JSON.stringify(bash)}`);
  assert(edit.tool === 'Edit' && edit.diff && edit.open, `Edit ${JSON.stringify(edit)}`);
  assert(bad.tool === 'Bash' && bad.status === 'error' && bad.open, `failed Bash ${JSON.stringify(bad)}`);
  const diff = await ev(`(() => { const d = [...${VC}.querySelectorAll('[data-testid="chat-tool"][data-tool="Edit"] [data-testid="chat-diff"]')].pop(); return { add: d.querySelectorAll('.add, .ins, [class*="add"]').length, del: d.querySelectorAll('.del, .rem, [class*="del"]').length }; })()`);
  assert(diff.add > 0 && diff.del > 0, `diff lines ${JSON.stringify(diff)}`);
  // folded → expandable
  await ev(`(() => { const d = [...${VC}.querySelectorAll('[data-testid="chat-tool"][data-tool="Read"]')].pop(); d.querySelector('summary').click(); return true; })()`);
  assert(await ev(`[...${VC}.querySelectorAll('[data-testid="chat-tool"][data-tool="Read"]')].pop().open`), 'Read block does not expand');
  await scrollBottom();
  await evidence('R4');
  return tools.map((x) => `${x.tool}:${x.status}${x.open ? ':open' : ''}`).join(' ');
});

test('R5.6', 'R5.6 answer lost before reaching the daemon → prompt open again after reconnect', async () => {
  const from = other.frames.length;
  await sendChat('perm touch r56.txt');
  await waitFor(() => ev(`!!${inChat('[data-testid="chat-perm-allow"]')}`), 10000, 'permission prompt');
  await ev(`window.__vrSock(${JSON.stringify(S1)}).__dropSend = true`);
  await ev(`${inChat('[data-testid="chat-perm-allow"]')}.click(), true`);
  await waitFor(() => ev(`${inChat('[data-testid="chat-perm"]')}?.dataset.state === 'submitting'`), 5000, 'submitting');
  await ev(`window.__vrSock(${JSON.stringify(S1)}).close(), true`);
  await waitFor(() => ev(`${inChat('[data-testid="chat-perm"]')}?.dataset.state === 'open' && !!window.__vrSock(${JSON.stringify(S1)})`), 15000, 'prompt open after reconnect');
  await evidence('R5.6');
  // The answer never arrived, so nothing may have run: the tool block has no
  // result yet, claude has not gone on, and the daemon has neither a
  // resolution of the request nor a tool result (seen by the other desktop).
  const before = await ev(`(() => { const d = [...${VC}.querySelectorAll('[data-testid="chat-tool"][data-tool="Bash"]')].pop(); return { status: d.dataset.status, text: d.textContent }; })()`);
  assert(before.text.includes('r56.txt') && before.status !== 'ok' && before.status !== 'error', `the tool block already has a result although the answer was never delivered: ${JSON.stringify(before)}`);
  assert(!(await assistantText()).trimEnd().endsWith('done Bash'), 'claude went on ("done Bash") although the answer was never delivered');
  const leaked = other.frames.slice(from).filter((f) => f.type === 'chat' && (f.msg?.type === 'vr_resolved'
    || (f.msg?.type === 'user' && Array.isArray(f.msg.message?.content) && f.msg.message.content.some((b) => b.type === 'tool_result'))));
  assert(leaked.length === 0, `the daemon saw an answer / a tool result before the answer was delivered: ${JSON.stringify(leaked).slice(0, 300)}`);
  await ev(`${inChat('[data-testid="chat-perm-allow"]')}.click(), true`);
  await waitFor(() => ev(`!${inChat('[data-testid="chat-perm"]')}`), 10000, 'prompt closed');
  await idle();
  const tool = await ev(`(() => { const d = [...${VC}.querySelectorAll('[data-testid="chat-tool"][data-tool="Bash"]')].pop(); return { status: d.dataset.status, text: d.textContent }; })()`);
  assert(tool.status === 'ok' && tool.text.includes('r56.txt'), `tool ${JSON.stringify(tool)}`);
  return 'submitting → reconnect → open → allow → ran';
});

test('R5.7', 'R5.7 second answer → "handled elsewhere", claude gets one answer', async () => {
  const from = other.frames.length;
  await sendChat('perm touch r57.txt');
  await waitFor(() => ev(`!!${inChat('[data-testid="chat-perm-allow"]')}`), 10000, 'permission prompt');
  const st = await other.wait((fs) => { const s = [...fs].reverse().find((f) => f.type === 'chat_state'); return s?.pending?.length ? s : null; }, 10000, 'other sees pending', from);
  await ev(`window.__vrSock(${JSON.stringify(S1)}).__hold = true`);
  other.send({ type: 'chat_respond', requestId: st.pending[0].requestId, response: { behavior: 'allow' } });
  await other.wait((fs) => fs.some((f) => f.type === 'chat_ack' && f.op === 'respond' && f.ok), 10000, 'other answer acked', from);
  await ev(`${inChat('[data-testid="chat-perm-allow"]')}.click(), true`);
  await sleep(500);
  await ev(`window.__vrSock(${JSON.stringify(S1)}).release(), true`);
  await waitFor(async () => (await transcriptText()).includes('Bash 的请求已在别处处理'), 10000, 'handled-elsewhere notice');
  await idle();
  await other.wait((fs) => fs.some((f) => f.type === 'chat' && f.msg?.type === 'result'), 10000, 'turn result', from);
  const responses = other.frames.slice(from).filter((f) => f.type === 'chat' && f.msg?.type === 'vr_resolved');
  assert(responses.length === 1, `vr_resolved ×${responses.length}`);
  await scrollBottom();
  await evidence('R5.7');
  return `vr_resolved ${responses[0].msg.outcome}`;
});

test('R6', 'R6 plan review: approve+acceptEdits, approve+manual, revise', async () => {
  const mode = () => ev(`${inChat('[data-testid="chat-mode"]')}.dataset.mode`);
  await sendChat('plan');
  await waitFor(() => ev(`!!${inChat('[data-testid="chat-plan"]')}`), 10000, 'plan card');
  const doc = await ev(`${inChat('[data-testid="chat-plan"] .plan-doc')}.textContent`);
  assert(doc.includes('Plan: fake change') && doc.includes('Step two'), `plan ${doc}`);
  await evidence('R6');
  await ev(`${inChat('[data-testid="chat-plan-opt-1"]')}.click(), true`);
  await waitAssistant('plan approved');
  await idle();
  await waitFor(async () => (await mode()) === 'acceptEdits', 5000, 'mode acceptEdits after option 1');
  await sendChat('plan');
  await waitFor(() => ev(`!!${inChat('[data-testid="chat-plan-opt-2"]')}`), 10000, 'plan card 2');
  await ev(`${inChat('[data-testid="chat-plan-opt-2"]')}.click(), true`);
  await idle();
  await waitFor(async () => (await mode()) === 'default', 5000, 'mode default after option 2');
  await sendChat('plan');
  await waitFor(() => ev(`!!${inChat('[data-testid="chat-plan-opt-3"]')}`), 10000, 'plan card 3');
  const firstReq = await ev(`${inChat('[data-testid="chat-plan"]')}.dataset.requestId`);
  await ev(`(() => { const i = ${VC}.querySelector('[data-testid="chat-plan"] .rej input'); i.value = 'more detail please'; i.dispatchEvent(new Event('input')); return true; })()`);
  await ev(`${inChat('[data-testid="chat-plan-opt-3"]')}.click(), true`);
  await waitAssistant('revising: more detail please');
  await waitFor(() => ev(`(() => { const c = ${inChat('[data-testid="chat-plan"]')}; return !!c && c.dataset.requestId !== ${JSON.stringify(firstReq)}; })()`), 10000, 'revised plan presented again');
  const midMode = await mode();
  await evidence('R6-revise');
  await ev(`${inChat('[data-testid="chat-plan-opt-2"]')}.click(), true`);
  await idle();
  return `opt1→acceptEdits, opt2→default, opt3→revised (mode while revising: ${midMode})`;
});

test('R7', 'R7 AskUserQuestion form: incomplete → disabled, single/multi/other → answers', async () => {
  await sendChat('ask');
  await waitFor(() => ev(`!!${inChat('[data-testid="chat-question"]')}`), 10000, 'question card');
  const q = (expr) => ev(`(() => { const c = ${inChat('[data-testid="chat-question"]')}; return ${expr}; })()`);
  assert(await q('c.querySelector(\'[data-testid="chat-question-submit"]\').disabled'), 'submit enabled with nothing answered');
  assert((await q('c.querySelectorAll(".q.missing").length')) === 2, 'unanswered questions not marked');
  await evidence('R7');
  await q(`(c.querySelectorAll('.q')[0].querySelector('input[value="Banana"]').click(), true)`);
  assert(await q('c.querySelector(\'[data-testid="chat-question-submit"]\').disabled'), 'submit enabled with one question open');
  assert((await q('[...c.querySelectorAll(".q")].map((b) => b.classList.contains("missing")).join()')) === 'false,true', 'missing marks wrong');
  await q(`(c.querySelectorAll('.q')[1].querySelector('input[value="Blue"]').click(), true)`);
  await q(`(() => { const t = c.querySelectorAll('.q')[1].querySelector('.qo-other'); t.value = 'my own colour'; t.dispatchEvent(new Event('input')); return true; })()`);
  assert(!(await q('c.querySelector(\'[data-testid="chat-question-submit"]\').disabled')), 'submit still disabled');
  await q(`(c.querySelector('[data-testid="chat-question-submit"]').click(), true)`);
  await idle();
  const txt = await assistantText();
  const tail = txt.slice(-400);
  assert(tail.includes('Banana') && tail.includes('Blue') && tail.includes('my own colour'), `answers echoed: ${tail}`);
  return 'Banana / Blue + "my own colour"';
});

test('R8', 'R8 Esc and stop interrupt; Esc on a prompt; Esc idle does nothing', async () => {
  const interruptedCount = () => ev(`${VC}.querySelectorAll('.chat-interrupted').length`);
  const n0 = await interruptedCount();
  await sendChat('slow 200 60');
  await waitFor(() => ev(`!${inChat('[data-testid="chat-stop"]')}.hidden`), 10000, 'stop button');
  await waitFor(async () => /\b3\b/.test(await assistantText()), 10000, 'streaming started');
  await ev(`${inChat('[data-testid="chat-input"]')}.focus(), true`);
  await pressKey('Escape');
  await idle();
  assert((await interruptedCount()) === n0 + 1, 'Esc: no 已中断 marker');
  await evidence('R8');
  await sendChat('slow 200 60');
  await waitFor(() => ev(`!${inChat('[data-testid="chat-stop"]')}.hidden`), 10000, 'stop button 2');
  await sleep(500);
  await ev(`${inChat('[data-testid="chat-stop"]')}.click(), true`);
  await idle();
  assert((await interruptedCount()) === n0 + 2, 'stop button: no 已中断 marker');
  await sendChat('echo after interrupt');
  await waitAssistant('after interrupt');
  await idle();
  // R8.2: Esc on an open permission prompt
  await sendChat('perm touch r82.txt');
  await waitFor(() => ev(`!!${inChat('[data-testid="chat-perm"]')}`), 10000, 'prompt');
  await ev(`${inChat('[data-testid="chat-perm"]')}.focus(), true`);
  await pressKey('Escape');
  await waitFor(() => ev(`!${inChat('[data-testid="chat-perm"]')}`), 10000, 'prompt closed by Esc');
  await idle();
  await waitFor(async () => (await transcriptText()).includes('Bash 的请求已中断'), 5000, 'prompt interrupted notice');
  const last = await ev(`(() => { const d = [...${VC}.querySelectorAll('[data-testid="chat-tool"][data-tool="Bash"]')].pop(); return { status: d.dataset.status, text: d.textContent }; })()`);
  assert(last.text.includes('r82.txt') && last.status !== 'ok', `tool ran anyway ${JSON.stringify(last)}`);
  // R8.3: idle Esc
  const len = await ev(`${VC}.querySelector('.tl-in').children.length`);
  const sent = other.frames.length;
  await ev(`${inChat('[data-testid="chat-input"]')}.focus(), true`);
  await pressKey('Escape');
  await sleep(800);
  assert((await ev(`${VC}.querySelector('.tl-in').children.length`)) === len, 'idle Esc changed the transcript');
  assert(!other.frames.slice(sent).some((f) => f.type === 'chat'), 'idle Esc produced chat traffic');
  return `Esc + stop → 已中断; prompt Esc → tool ${last.status}; idle Esc no-op`;
});

test('R9', 'R9 queue while busy: queued, remove, interrupt returns to the input', async () => {
  await sendChat('slow 150 30');
  await waitFor(() => ev(`!${inChat('[data-testid="chat-stop"]')}.hidden`), 10000, 'busy');
  await sendChat('echo q-one');
  await sendChat('echo q-two');
  const items = await waitFor(async () => { const t = await ev(`[...${VC}.querySelectorAll('[data-testid="chat-queue-item"]')].map((i) => i.textContent)`); return t.length === 2 ? t : null; }, 5000, 'two queued');
  assert(items.every((x) => x.includes('排队中')), `queue labels ${items}`);
  await evidence('R9');
  await ev(`[...${VC}.querySelectorAll('[data-testid="chat-queue-item"]')].find((i) => i.textContent.includes('q-two')).querySelector('.qi-x').click(), true`);
  await waitFor(async () => (await ev(`${VC}.querySelectorAll('[data-testid="chat-queue-item"]').length`)) === 1, 3000, 'one left');
  await waitAssistant('q-one', 20000);
  await idle();
  await sleep(1000);
  assert((await userCount('echo q-two')) === 0, 'removed message was sent');
  // R9.3
  await sendChat('slow 150 30');
  await waitFor(() => ev(`!${inChat('[data-testid="chat-stop"]')}.hidden`), 10000, 'busy 2');
  await sendChat('echo q-three');
  await waitFor(async () => (await ev(`${VC}.querySelectorAll('[data-testid="chat-queue-item"]').length`)) === 1, 3000, 'queued 3');
  await ev(`${inChat('[data-testid="chat-input"]')}.focus(), true`);
  await pressKey('Escape');
  await idle();
  await sleep(800);
  const val = await ev(`${inChat('[data-testid="chat-input"]')}.value`);
  assert(val.includes('echo q-three'), `input ${JSON.stringify(val)}`);
  assert((await userCount('echo q-three')) === 0, 'queued message sent after interrupt');
  await evidence('R9-interrupt');
  await clearInput();
  return 'queued ×2, removed one, interrupt put "echo q-three" back';
});

test('R10', 'R10 slash menu and terminal-only commands', async () => {
  await ev(`${inChat('[data-testid="chat-input"]')}.focus(), true`);
  await cdp.send('Input.insertText', { text: '/' });
  await waitFor(() => ev(`!${inChat('[data-testid="chat-slash-menu"]')}.hidden`), 5000, 'slash menu');
  const all = await ev(`[...${VC}.querySelectorAll('[data-testid="chat-slash-item"] .cmd')].map((c) => c.textContent)`);
  assert(['/compact', '/review', '/fake-skill'].every((c) => all.includes(c)), `menu ${all}`);
  await cdp.send('Input.insertText', { text: 're' });
  await sleep(150);
  const filtered = await ev(`[...${VC}.querySelectorAll('[data-testid="chat-slash-item"] .cmd')].map((c) => c.textContent)`);
  assert(filtered.length >= 1 && filtered.every((c) => c.startsWith('/re')), `filtered ${filtered}`);
  await evidence('R10');
  await pressKey('Enter');
  const picked = await ev(`${inChat('[data-testid="chat-input"]')}.value`);
  assert(picked === '/review ', `picked ${JSON.stringify(picked)}`);
  await clearInput();
  await cdp.send('Input.insertText', { text: '/theme' });
  await pressKey('Enter');
  const notice = await waitFor(() => ev(`(() => { const n = ${inChat('[data-testid="chat-terminal-only"]')}; return n && !n.hidden ? { text: n.textContent, btn: n.querySelector('button')?.textContent } : null; })()`), 5000, 'terminal-only notice');
  assert(notice.text.includes('/theme 只能在终端界面使用') && notice.btn === '新建终端会话接上', JSON.stringify(notice));
  assert((await userCount('/theme')) === 0, '/theme was sent');
  await evidence('R10-terminal-only');
  await clearInput();
  return `menu ${all.join(' ')}; "/re" → ${filtered.join(' ')}`;
});

test('slash-layout', 'slash menu with long names and descriptions: rows readable in 800x500 and 1280x800 windows, selection stays in view', async () => {
  const menu = inChat('[data-testid="chat-slash-menu"]');
  const input = inChat('[data-testid="chat-input"]');
  const openMenu = async () => {
    await ev(`${input}.focus(), true`);
    await cdp.send('Input.insertText', { text: '/' });
    await waitFor(() => ev(`!${menu}.hidden`), 5000, 'slash menu');
  };
  await openMenu();
  const names = await ev(`[...${menu}.querySelectorAll('[data-testid="chat-slash-item"] .cmd')].map((c) => c.textContent)`);
  assert(names.length >= 10 && names.some((n) => n.length > 150) && names.includes('/dev-requirements'), `the fake claude's long commands are missing: ${names.length} commands`);
  const selected = () => ev(`(() => {
    const m = ${menu}; const on = m.querySelector('.mi.on'); const mr = m.getBoundingClientRect(); const r = on.getBoundingClientRect();
    return { name: on.querySelector('.cmd').textContent, shown: r.top >= mr.top - 0.5 && r.bottom <= mr.bottom + 0.5, scrollTop: m.scrollTop };
  })()`);
  const lost = [];
  const layout = await slashMenuLayout(cdp, {
    at: async ({ width, height }) => {
      const where = `${width}x${height}`;
      await evidence(`slash-layout-${where}`);
      // once around the list and back over both ends
      const walk = [...names.map((_, i) => ['ArrowDown', names[(i + 1) % names.length]]), ['ArrowUp', names[names.length - 1]], ['ArrowDown', names[0]]];
      for (const [key, want] of walk) {
        await pressKey(key);
        const s = await selected();
        if (s.name !== want) lost.push(`${where}: ${key} selected ${s.name.slice(0, 30)}, expected ${want.slice(0, 30)}`);
        else if (!s.shown) lost.push(`${where}: ${key} → ${want.slice(0, 30)} is selected but scrolled out of the menu`);
      }
      const s = await selected();
      if (s.scrollTop !== 0) lost.push(`${where}: back on the first command the list is still scrolled by ${s.scrollTop}px`);
    },
  });
  for (const l of layout) for (const p of l.problems) console.log(`NOTE slash menu ${l.size.width}x${l.size.height}: ${p}`);
  for (const l of lost) console.log(`NOTE slash menu ${l}`);
  const problems = layout.flatMap((l) => l.problems.map((p) => `${l.size.width}x${l.size.height} ${p}`)).concat(lost);
  // a click picks the row under the pointer
  const at = await ev(`(() => { const r = [...${menu}.querySelectorAll('[data-testid="chat-slash-item"]')][1].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 });
  const clicked = await ev(`({ value: ${input}.value, hidden: ${menu}.hidden })`);
  await clearInput();
  await openMenu();
  await pressKey('Escape');
  const escaped = await ev(`({ value: ${input}.value, hidden: ${menu}.hidden })`);
  await clearInput();
  assert(problems.length === 0, `${problems.length} layout problem(s), see the NOTE lines; first: ${problems.slice(0, 3).join(' | ')}`);
  assert(clicked.value === `${names[1]} ` && clicked.hidden, `click on the second row: ${JSON.stringify(clicked)}`);
  assert(escaped.value === '/' && escaped.hidden, `Esc: ${JSON.stringify(escaped)}`);
  return layout.map((l) => `${l.size.width}x${l.size.height}: menu ${l.menu}, ${l.rows} rows (${l.whole} whole) ok`).join('; ');
});

test('R11', 'R11.1 permission mode: Shift+Tab cycle and menu', async () => {
  const mode = () => ev(`${inChat('[data-testid="chat-mode"]')}.dataset.mode`);
  assert((await mode()) === 'default', `start mode ${await mode()}`);
  const seen = [];
  for (const want of ['acceptEdits', 'plan', 'default']) {
    await ev(`${inChat('[data-testid="chat-input"]')}.focus(), true`);
    await pressKey('Tab', MOD.shift);
    await waitFor(async () => (await mode()) === want, 5000, `mode ${want}`);
    seen.push(want);
  }
  await ev(`${inChat('[data-testid="chat-mode"]')}.click(), true`);
  const opts = await ev(`[...${VC}.querySelectorAll('[data-testid="chat-mode-option"]')].map((o) => o.dataset.mode + (o.disabled ? ':disabled' : ''))`);
  assert(opts.join() === 'default,acceptEdits,plan', `menu ${opts}`);
  await ev(`[...${VC}.querySelectorAll('[data-testid="chat-mode-option"]')].find((o) => o.dataset.mode === 'acceptEdits').click(), true`);
  await waitFor(async () => (await mode()) === 'acceptEdits', 5000, 'menu → acceptEdits');
  await evidence('R11');
  // acceptEdits: Write runs without asking
  await sendChat('tool Write');
  let asked = false;
  await waitFor(async () => { if (await ev(`!!${inChat('[data-testid="chat-perm"]')}`)) asked = true; return (await ev(`[...${VC}.querySelectorAll('[data-testid="chat-msg-assistant"]')].pop()?.textContent || ''`)).includes('done Write'); }, 10000, 'Write done');
  assert(!asked, 'acceptEdits still asked for Write');
  await idle();
  await ev(`${inChat('[data-testid="chat-mode"]')}.click(), true`);
  await ev(`[...${VC}.querySelectorAll('[data-testid="chat-mode-option"]')].find((o) => o.dataset.mode === 'default').click(), true`);
  await waitFor(async () => (await mode()) === 'default', 5000, 'back to default');
  return `Shift+Tab ${seen.join('→')}; menu ${opts.join()}`;
});

test('R12', 'R12/R12.2 offline, 500 messages meanwhile → divider, render ≤2000 ms', async () => {
  await scrollBottom();
  await ev(`(() => { window.__vrNet.offline = true; window.__vrSock(${JSON.stringify(S1)}).close(); return true; })()`);
  await waitFor(() => ev(`${VC}.querySelector('.reconnect-banner').style.display === 'flex'`), 10000, 'reconnect banner');
  const id = other.chat('burst 500');
  await other.turn(id, 30000);
  const readyBefore = await ev('window.__vrNet.ready.length');
  const dividersBefore = await ev(`${VC}.querySelectorAll('[data-testid="chat-resync-divider"]').length`);
  await ev(`(() => {
    window.__vrMeasure = null;
    const tick = () => {
      const v = ${VC};
      const div = v && v.querySelectorAll('[data-testid="chat-resync-divider"]').length > ${dividersBefore};
      const msgs = v ? v.querySelectorAll('[data-testid="chat-msg-assistant"]') : [];
      const last = msgs[msgs.length - 1];
      if (div && last && last.textContent.includes('burst 500')) window.__vrMeasure = performance.now();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__vrNet.offline = false;
    ${VC}.querySelector('.reconnect-banner-retry').click();
    return true;
  })()`);
  await waitFor(() => ev('window.__vrMeasure !== null'), 15000, 'backlog rendered');
  const t = await ev(`(() => { const r = window.__vrNet.ready.slice(${readyBefore}).find((x) => x.sid === ${JSON.stringify(S1)}); return { ready: r?.t, done: window.__vrMeasure }; })()`);
  const ms = Math.round(t.done - t.ready);
  const divider = await ev(`[...${VC}.querySelectorAll('[data-testid="chat-resync-divider"]')].pop().textContent`);
  const n = Number(/已补回断线期间 (\d+) 条消息/.exec(divider)?.[1] ?? 0);
  assert(n >= 500, `divider ${divider}`);
  // order, no duplicates
  const order = await ev(`[...${VC}.querySelectorAll('[data-testid="chat-msg-assistant"]')].map((m) => m.textContent).filter((x) => /^burst \\d+$/.test(x.trim())).map((x) => Number(x.trim().slice(6)))`);
  const tail = order.slice(-500);
  assert(tail.length === 500 && tail.every((v, i) => v === i + 1), `order: ${tail.length} msgs, first ${tail[0]}, last ${tail.at(-1)}`);
  await ev(`[...${VC}.querySelectorAll('[data-testid="chat-resync-divider"]')].pop().scrollIntoView({ block: 'center' }), true`);
  await sleep(200);
  await evidence('R12');
  await scrollBottom();
  results.push({ id: 'R12.2-timing', detail: `${ms} ms` });
  assert(ms <= 2000, `render took ${ms} ms`);
  return `divider "${divider}"; ready → rendered ${ms} ms`;
});

test('R13.1', 'R13.1 turn error shows retry; retry resends', async () => {
  await sendChat('fail');
  await waitFor(() => ev(`!!${inChat('[data-testid="chat-turn-error"] [data-testid="chat-retry"]')}`), 10000, 'error card');
  const err = await ev(`[...${VC}.querySelectorAll('[data-testid="chat-turn-error"]')].pop().textContent`);
  assert(err.includes('API Error: 529 Overloaded'), err);
  await evidence('R13.1');
  const before = await userCount('fail');
  const cards = await ev(`${VC}.querySelectorAll('[data-testid="chat-turn-error"]').length`);
  await ev(`[...${VC}.querySelectorAll('[data-testid="chat-retry"]')].pop().click(), true`);
  await waitFor(async () => (await userCount('fail')) === before + 1, 10000, 'retry sent');
  await waitFor(async () => (await ev(`${VC}.querySelectorAll('[data-testid="chat-turn-error"]').length`)) === cards + 1, 10000, 'second error');
  return err.trim();
});

test('R16.3', 'R16.3 waiting in a background session: yellow dot, notification / Dock fallback, click opens it', async () => {
  // Another session becomes the current one; S1 is in the background.
  await openSidebar(CHAT, 'bypass');
  await waitFor(() => sidebarItem(CHAT, 'bypass', `it.classList.contains('active')`), 5000, 'bypass active');
  const focusedBefore = await mainProc.evaluate(`require('electron').BrowserWindow.getAllWindows()[0].isFocused()`);
  await mainProc.evaluate(`require('electron').app.hide(), true`);
  await sleep(400);
  const nLogs = cdp.events.length;
  const id = other.chat('perm touch r163.txt');
  await waitFor(() => sidebarItem(CHAT, 'main', `it.dataset.dot === 'waiting'`), 10000, 'yellow dot on main');
  const note = await waitFor(() => cdp.events.slice(nLogs).filter((e) => e.method === 'Runtime.consoleAPICalled').map((e) => e.params.args.map((a) => a.value ?? '').join(' ')).find((l) => l.startsWith('[notify]')), 8000, 'notify log');
  const outcome = /^\[notify\] (shown|fallback)/.exec(note)?.[1];
  const badge = await mainProc.evaluate(`require('electron').app.dock.getBadge()`);
  const stillB = await sidebarItem(CHAT, 'bypass', `it.classList.contains('active')`);
  await mainProc.evaluate(`(() => { const { app, BrowserWindow } = require('electron'); app.show(); app.focus({ steal: true }); const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus(); return true; })()`);
  await sleep(800);
  // Back on screen: rendering (requestAnimationFrame) runs again.
  await waitFor(() => ev('new Promise((r) => { requestAnimationFrame(() => r(true)); setTimeout(() => r(false), 500); })'), 10000, 'window rendering again');
  const badgeAfter = await mainProc.evaluate(`require('electron').app.dock.getBadge()`);
  // macOS may refuse to bring a background-launched app forward; the badge
  // only has to clear once the window really has focus.
  const focusedAfter = await mainProc.evaluate(`require('electron').BrowserWindow.getAllWindows()[0].isFocused()`);
  if (focusedAfter) assert(badgeAfter === '', `badge not cleared on focus: ${JSON.stringify(badgeAfter)}`);
  assert(outcome, `notify log ${note}`);
  assert(note.includes('gui-chat · main'), `title ${note}`);
  assert(stillB, 'current session switched by itself');
  if (outcome === 'fallback') assert(badge === '•', `Dock badge ${JSON.stringify(badge)}`);
  await evidence('R16.3-fallback');
  // Clicking a (native) notification: main process hands the tag back.
  const key = `127.0.0.1:${CHAT.port}::${S1}`;
  await mainProc.evaluate(`require('electron').BrowserWindow.getAllWindows()[0].webContents.send('notification-click', ${JSON.stringify(key)}), true`);
  await waitFor(() => sidebarItem(CHAT, 'main', `it.classList.contains('active')`), 5000, 'notification click opened main');
  await waitFor(() => ev(`!!${inChat('[data-testid="chat-perm-allow"]')}`), 5000, 'prompt visible in main');
  await evidence('R16.3-click');
  await ev(`${inChat('[data-testid="chat-perm-allow"]')}.click(), true`);
  await other.turn(id);
  await idle();
  return `window focused before: ${focusedBefore}; notify ${outcome}; badge while hidden ${JSON.stringify(badge)}, after focus() ${JSON.stringify(badgeAfter)} (window focused: ${focusedAfter}); click → main opened`;
});

test('X6', 'R16.3 current session while the window is in the background: yellow dot on it + notification; cleared once the window is focused again', async () => {
  // "main" is the current session (R16.3 left it open). Real focus this time:
  // the run's focus emulation is off while the app is hidden.
  assert(await sidebarItem(CHAT, 'main', `it.classList.contains('active')`), 'main is not the current session');
  let id = '';
  let note = '';
  try {
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    // Hide the app, and take focus off the page explicitly: when macOS never
    // made this (background-launched) window key, hiding it sends no blur.
    await mainProc.evaluate(`(() => { const { app, BrowserWindow } = require('electron'); BrowserWindow.getAllWindows()[0].blurWebView(); app.hide(); return true; })()`);
    await waitFor(async () => !(await ev('document.hasFocus()')), 5000, 'the window lost focus');
    const nLogs = cdp.events.length;
    id = other.chat('perm touch x6.txt');
    await waitFor(() => sidebarItem(CHAT, 'main', `it.dataset.dot === 'waiting'`), 10000, 'yellow dot on the current session');
    note = await waitFor(() => cdp.events.slice(nLogs).filter((e) => e.method === 'Runtime.consoleAPICalled').map((e) => e.params.args.map((a) => a.value ?? '').join(' ')).find((l) => l.startsWith('[notify]')), 8000, 'notify log');
    assert(note.includes('gui-chat · main'), `notification title ${note}`);
    await sleep(600); // the notification's outcome (Dock fallback on unsigned builds) is back
    const st = await sidebarItem(CHAT, 'main', `({ dot: it.dataset.dot, active: it.classList.contains('active') })`);
    assert(st.dot === 'waiting' && st.active, `after the notification outcome: ${JSON.stringify(st)}`);
  } finally {
    await mainProc.evaluate(`(() => { const { app, BrowserWindow } = require('electron'); app.show(); app.focus({ steal: true }); const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus(); w.focusOnWebView(); return true; })()`);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await waitFor(() => ev('new Promise((r) => { requestAnimationFrame(() => r(true)); setTimeout(() => r(false), 500); })'), 10000, 'window rendering again');
  }
  await waitFor(async () => (await ev('document.hasFocus()')) && (await sidebarItem(CHAT, 'main', `it.dataset.dot === 'none'`)), 10000, 'dot cleared once the window is focused again');
  await waitFor(() => ev(`!!${inChat('[data-testid="chat-perm-allow"]')}`), 5000, 'the prompt is on screen');
  await ev(`${inChat('[data-testid="chat-perm-allow"]')}.click(), true`);
  await other.turn(id);
  await idle();
  return `${note}; dot waiting while in the background, none after focus`;
});

test('R13.2', 'R13.2 claude exits → ended banner, restart works', async () => {
  await sendChat('crash 1');
  await waitFor(() => ev(`(() => { const e = ${inChat('[data-testid="chat-ended"]')}; return e && !e.hidden && e.dataset.reason === 'exited'; })()`), 10000, 'ended banner').catch(async (e) => {
    const st = await ev(`({ ended: ${inChat('[data-testid="chat-ended"]')}?.dataset.reason ?? null, hidden: ${inChat('[data-testid="chat-ended"]')}?.hidden, hint: ${VC}.querySelector('.c-hint span')?.textContent, last: [...${VC}.querySelectorAll('[data-testid="chat-msg-user"]')].slice(-2).map((m) => m.textContent + '|' + (m.dataset.delivery || '')) })`);
    throw new Error(`${e.message} ${JSON.stringify(st)}`);
  });
  const b = await ev(`({ text: ${inChat('[data-testid="chat-ended"]')}.textContent, restart: !!${inChat('[data-testid="chat-restart"]')}, handoff: !!${inChat('[data-testid="chat-handoff"]')}, input: ${inChat('[data-testid="chat-input"]')}.disabled })`);
  assert(b.restart && b.handoff && b.input && b.text.includes('会话已结束'), JSON.stringify(b));
  await evidence('R13.2');
  await ev(`${inChat('[data-testid="chat-restart"]')}.click(), true`);
  await waitFor(() => ev(`${inChat('[data-testid="chat-ended"]')}.hidden && !${inChat('[data-testid="chat-input"]')}.disabled`), 15000, 'restarted');
  await sendChat('echo after restart');
  await waitAssistant('after restart');
  await idle();
  return b.text;
});

test('R14.2', 'R14.2 handoff while a turn runs asks first, then continues in a terminal', async () => {
  await sendChat('slow 300 100');
  await waitFor(() => ev(`!${inChat('[data-testid="chat-stop"]')}.hidden`), 10000, 'running');
  await ev(`${inChat('[data-testid="chat-input"]')}.focus(), true`);
  await cdp.send('Input.insertText', { text: '/theme' });
  await pressKey('Enter');
  await waitFor(() => ev(`!${inChat('[data-testid="chat-terminal-only"]')}.hidden`), 5000, 'terminal-only notice');
  const nd = dialogs.length;
  await ev(`${inChat('[data-testid="chat-terminal-only"] button')}.click(), true`);
  await waitFor(() => dialogs.length > nd, 5000, 'confirm dialog');
  assert(dialogs[nd].includes('中断当前回合'), `dialog ${dialogs[nd]}`);
  const screen = () => ev(`(() => { const r = [...document.querySelectorAll('.term-instance')].find((c) => c.style.display !== 'none')?.querySelector('.xterm-rows'); return r ? r.innerText : ''; })()`);
  const out = await waitFor(async () => { const s = await screen(); return s.includes('fake-claude interactive resume=') ? s : null; }, 20000, 'terminal running claude --resume');
  await evidence('R14.2');
  const list = await sessions(CHAT);
  const chat = list.find((s) => s.id === S1);
  assert(chat?.state === 'ended' && chat.endReason === 'handed_off', `chat session ${JSON.stringify(chat)}`);
  await openSidebar(CHAT, 'main');
  await waitFor(() => ev(`${inChat('[data-testid="chat-ended"]')}?.dataset.reason === 'handed_off' && ${inChat('[data-testid="chat-input"]')}.disabled`), 10000, 'chat shows handed_off');
  await evidence('R14.2-chat');
  return `dialog "${dialogs[nd]}"; terminal: ${out.split('\n').find((l) => l.includes('fake-claude'))}`;
});

test('R13.4', 'R13.4 init reports an old claude → ended with required version, no reconnect', async () => {
  const id = await newChat(INIT, 'w');
  const socketsBefore = await ev('window.__vrNet.sockets.length');
  await sendChat('echo hello');
  await waitFor(() => ev(`${inChat('[data-testid="chat-ended"]')}?.dataset.reason === 'version_unsupported'`), 15000, 'version_unsupported');
  const b = await ev(`({ text: ${inChat('[data-testid="chat-ended"]')}.textContent, handoff: !!${inChat('[data-testid="chat-handoff"]')} })`);
  assert(b.text.includes('1.0.0') && b.text.includes('2.1.210') && b.handoff, JSON.stringify(b));
  await sleep(3000);
  const st = await ev(`({ sockets: window.__vrNet.sockets.length, open: !!window.__vrSock(${JSON.stringify(id)}), banner: ${VC}.querySelector('.reconnect-banner').style.display })`);
  assert(st.sockets === socketsBefore && st.open && st.banner === 'none', `reconnected? ${JSON.stringify(st)}`);
  await evidence('R13.4');
  return b.text;
});

// --- Run ------------------------------------------------------------------------

function writeHistory(configDir, dir) {
  histU = randomUUID();
  const enc = dir.replace(/[/.]/g, '-');
  const pdir = join(configDir, 'projects', enc);
  mkdirSync(pdir, { recursive: true });
  const lines = [];
  let parent = null;
  const push = (type, message) => {
    const uuid = randomUUID();
    lines.push(JSON.stringify({ parentUuid: parent, isSidechain: false, userType: 'external', cwd: dir, sessionId: histU, version: '2.1.210', type, message, uuid, timestamp: new Date().toISOString() }));
    parent = uuid;
  };
  for (let i = 1; i <= 1000; i++) {
    const n = String(i).padStart(4, '0');
    push('user', { role: 'user', content: `hist-q #${n}` });
    push('assistant', { id: `msg_hist_${n}`, type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: `hist-a #${i}` }, { type: 'tool_use', id: `toolu_hist_${n}`, name: 'Read', input: { file_path: `${dir}/f${n}.txt` } }], stop_reason: 'tool_use' });
    push('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_hist_${n}`, content: `content of f${n}` }] });
  }
  writeFileSync(join(pdir, `${histU}.jsonl`), lines.join('\n') + '\n');
}

function buildMainDaemon() {
  if (process.env.VR_MAIN_DAEMON) return process.env.VR_MAIN_DAEMON;
  mainWorktree = join(work, 'main-src');
  const wt = spawnSync('git', ['worktree', 'add', '--detach', mainWorktree, 'main'], { cwd: ROOT, stdio: 'ignore' });
  if (wt.status !== 0) throw new Error('git worktree add main failed');
  const out = join(binDir, 'vibe-remoted-main');
  const b = spawnSync('go', ['build', '-o', out, './cmd/vibe-remoted'], { cwd: join(mainWorktree, 'vibe-remoted'), stdio: 'inherit' });
  if (b.status !== 0) throw new Error('go build (main) failed');
  return out;
}

function chatDaemon(name, configDir, roots, extra = {}) {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, '.claude.json'), trusted(roots), { mode: 0o600 });
  return defineDaemon(name, {
    cfg: {
      default_workdir: roots[0], allowed_roots: [roots[0]], use_tmux: true, login_shell: false,
      claude_cmd: claudeBin, claude_reload_cmd: claudeBin, state_dir: join(work, name, 'state'), ...extra.cfg,
    },
    env: { CLAUDE_CONFIG_DIR: configDir, ...extra.env },
  });
}

async function main() {
  console.log(`work dir ${work}`);
  mkdirSync(binDir, { recursive: true });
  for (const [out, pkg] of [[daemonBin, './cmd/vibe-remoted'], [claudeBin, './internal/chat/fakeclaude']]) {
    const r = spawnSync('go', ['build', '-o', out, pkg], { cwd: join(ROOT, 'vibe-remoted'), stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`go build ${pkg} failed`);
  }
  const mainBin = buildMainDaemon();

  // The bash daemons only get a directory of this run, not all of /tmp.
  const termRoot = join(work, 'term-root');
  for (const s of ['x8t', 'x8u', 'x10t']) mkdirSync(join(termRoot, s), { recursive: true });
  const bashCfg = { default_workdir: termRoot, allowed_roots: [termRoot], use_tmux: true, claude_cmd: '/bin/bash', claude_reload_cmd: '/bin/bash' };
  TERM = defineDaemon('gui-term', { cfg: bashCfg });
  MAIN = defineDaemon('gui-main', { bin: mainBin, cfg: bashCfg });

  chatRoot = join(work, 'gui-chat', 'proj');
  const subs = ['main', 'bypass', 'hist', 'x7', 'x7b', 'x8', 'x8b', 'x10', 'x10b', 'x10r', 'x10s'].map((s) => join(chatRoot, s));
  for (const s of subs) mkdirSync(s, { recursive: true });
  const chatConfig = join(work, 'gui-chat', 'cc');
  CHAT = chatDaemon('gui-chat', chatConfig, [chatRoot, ...subs], {
    cfg: { claude_flags: [
      { id: 'continue', label: '-c', arg: '-c' },
      { id: 'skip', label: '--dangerously-skip-permissions', arg: '--dangerously-skip-permissions' },
    ] },
    env: { FAKE_CLAUDE_ARGV_LOG: join(work, 'argv.log'), FAKE_CLAUDE_LONG_COMMANDS: '1' },
  });
  writeHistory(chatConfig, join(chatRoot, 'hist'));

  const oldRoot = join(work, 'gui-old-claude', 'proj');
  mkdirSync(oldRoot, { recursive: true });
  OLD = chatDaemon('gui-old-claude', join(work, 'gui-old-claude', 'cc'), [oldRoot], { env: { FAKE_CLAUDE_VERSION: '1.0.51' } });
  const initRoot = join(work, 'gui-old-init', 'proj');
  mkdirSync(join(initRoot, 'w'), { recursive: true });
  INIT = chatDaemon('gui-old-init', join(work, 'gui-old-init', 'cc'), [initRoot, join(initRoot, 'w')], { env: { FAKE_CLAUDE_INIT_VERSION: '1.0.0' } });

  for (const d of daemons.values()) await startDaemon(d);
  ok(`${daemons.size} daemons up (${[...daemons.values()].map((d) => `${d.name}:${d.port}`).join(' ')})`);

  if (!args.has('--no-build')) {
    const vb = spawnSync('npx', ['vite', 'build'], { cwd: DESKTOP, stdio: ['ignore', 'ignore', 'inherit'] });
    if (vb.status !== 0) throw new Error('vite build failed');
  }

  mkdirSync(userData, { recursive: true });
  const machines = [...daemons.values()].map((d) => ({ name: d.name, addr: '127.0.0.1', port: d.port, token: d.token }));
  writeFileSync(join(userData, 'machines.json'), JSON.stringify(machines, null, 2), { mode: 0o600 });

  const electronBin = createRequire(join(DESKTOP, 'package.json'))('electron');
  electron = spawn(electronBin, [`--inspect=${inspectPort}`, DESKTOP, '--use-mock-keychain'], {
    env: { ...process.env, VIBE_REMOTE_DEBUG_PORT: String(cdpPort), VIBE_REMOTE_USER_DATA_DIR: userData, VIBE_REMOTE_NO_DEVTOOLS: '1', VITE_DEV_SERVER_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let electronLog = '';
  electron.stdout.on('data', (x) => { electronLog += x; });
  electron.stderr.on('data', (x) => { electronLog += x; });

  cdp = await connectRenderer();
  mainProc = await connectMain();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  cdp.listeners.add((m) => {
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push(m.params.message);
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  });
  savedClipboard = await cdp.evaluate('window.vibeRemote.readClipboardText()').catch(() => null);

  // Fixed locale (assertions use the zh strings), then the network hook.
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.machine-name-label')`), 20000, 'app started');
  await cdp.evaluate(`localStorage.setItem('vibe-remote.locale', 'zh'), true`);
  await cdp.send('Page.reload');
  await sleep(500);
  await waitFor(() => cdp.evaluate(`document.querySelectorAll('.machine-name-label').length === ${daemons.size} && document.documentElement.lang === 'zh-CN'`), 20000, 'app reloaded in zh');
  await cdp.evaluate(NET_HOOK);
  ok('app started with 5 machines (zh), network hook installed');

  const only = process.env.VR_ONLY ? new Set(process.env.VR_ONLY.split(',')) : null;
  for (const c of cases) {
    if (only && !only.has(c.id)) continue;
    try {
      const detail = await c.fn();
      ok(`${c.name}${detail ? ` — ${detail}` : ''}`);
      results.push({ id: c.id, ok: true, detail });
      if (c.id === 'R1.1' || c.id === 'R1.3') await evidence(c.id).catch(() => {}); // the others take their own
    } catch (e) {
      fail(`${c.name} — ${e.message.split('\n')[0]}`);
      results.push({ id: c.id, ok: false, detail: e.message });
      await evidence(`${c.id}-FAIL`).catch(() => {});
      if (c.id === 'S1') break; // the rest needs the main chat session
    }
  }

  const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
  exceptions.length === 0 ? ok('no uncaught renderer exceptions') : fail(`renderer exceptions: ${exceptions.join(' | ')}`);
  const errors = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error').map((e) => e.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  if (errors.length) console.log(`NOTE console errors:\n  ${errors.join('\n  ')}`);
  if (process.env.VR_GUI_LOG) writeFileSync(process.env.VR_GUI_LOG, electronLog + '\n--- daemons ---\n' + [...daemons.values()].map((d) => `## ${d.name}\n${d.log}`).join('\n'));

  if (args.has('--keep')) {
    console.log('--keep: app left running; press Ctrl+C to clean up');
    await new Promise((r) => process.once('SIGINT', r));
  }
}

async function cleanup() {
  try {
    if (cdp && savedClipboard !== null) await cdp.evaluate(`window.vibeRemote.writeClipboardText(${JSON.stringify(savedClipboard)})`);
  } catch { /* app gone */ }
  try { other?.close(); } catch { /* closed */ }
  try { cdp?.ws.close(); mainProc?.ws.close(); } catch { /* closed */ }
  if (electron) { electron.kill('SIGTERM'); await new Promise((r) => { electron.once('exit', r); setTimeout(r, 3000); }); }
  for (const d of daemons.values()) {
    for (const s of await sessions(d).catch(() => [])) await rest(d, 'DELETE', `/api/v1/sessions/${s.id}`).catch(() => {});
    await stopDaemon(d);
    spawnSync('tmux', ['-L', 'vibe-remote', 'kill-server'], { env: { ...process.env, TMUX_TMPDIR: d.tmux }, stdio: 'ignore' });
  }
  if (mainWorktree) spawnSync('git', ['worktree', 'remove', '--force', mainWorktree], { cwd: ROOT, stdio: 'ignore' });
  if (!keychainExisted && keychainHas(keychainService)) {
    spawnSync('security', ['delete-generic-password', '-s', keychainService], { stdio: 'ignore' });
    console.log(`NOTE removed the "${keychainService}" keychain item this run created`);
  }
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
}

main()
  .catch((e) => fail(e.message))
  .finally(async () => {
    await cleanup();
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall GUI chat checks passed');
    process.exit(failures ? 1 : 0);
  });
