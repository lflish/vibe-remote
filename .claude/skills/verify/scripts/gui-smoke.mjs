#!/usr/bin/env node
// GUI regression run for the desktop app, driven over the Chrome DevTools
// Protocol. It stands in for the manual click-through after risky desktop
// changes (an Electron major upgrade, terminal or clipboard work):
//
//   legacy machines.json → encrypted on launch (real safeStorage path)
//   overview → new session → dir picker → terminal fills the window
//   typing → PTY echo; drag-select under mouse reporting + ⌘C; ⌘V paste
//   navigation / window.open blocked; hook event → desktop notification
//   daemon restart → reconnect banner → session recovered
//
// It launches the *built* app (dist/) with the stock Electron binary against a
// throwaway daemon and a throwaway userData dir, so the developer's real
// machines.json, window state and tmux sessions are never touched. macOS only:
// it needs a display and tmux.
//
// Usage (from the repo root):  node .claude/skills/verify/scripts/gui-smoke.mjs
//   --no-build   reuse existing desktop/dist and skip `vite build`
//   --keep       leave the app open at the end (manual poking); Ctrl+C to exit
// Requires Node 22+ (global WebSocket).

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DESKTOP = join(ROOT, 'desktop');
const args = new Set(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (msg) => console.log(`PASS ${msg}`);
const fail = (msg) => { failures++; console.log(`FAIL ${msg}`); };
const check = (cond, msg, detail = '') => (cond ? ok(msg) : fail(detail ? `${msg} — ${detail}` : msg));

async function waitFor(fn, ms, what, interval = 150) {
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

// --- Throwaway environment ---------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'vr-gui-'));
const userData = join(work, 'userData');
const port = 20000 + Math.floor(Math.random() * 10000);
const cdpPort = 30000 + Math.floor(Math.random() * 10000);
const token = randomBytes(32).toString('hex');
const daemonBin = join(work, 'vibe-remoted');
const daemonCfg = join(work, 'daemon.json');
const keychainService = 'vibe-remote Safe Storage';
const keychainExisted = keychainHas(keychainService);
let daemon = null;
let electron = null;
let savedClipboard = null;
let cdp = null;
const createdSessions = new Set();

function keychainHas(service) {
  return spawnSync('security', ['find-generic-password', '-s', service], { stdio: 'ignore' }).status === 0;
}

function startDaemon() {
  daemon = spawn(daemonBin, ['--config', daemonCfg], { stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stdout.on('data', () => {});
  daemon.stderr.on('data', () => {});
  return waitFor(async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).ok, 15000, 'daemon /healthz');
}

async function stopDaemon() {
  if (!daemon) return;
  const d = daemon;
  daemon = null;
  d.kill('SIGTERM');
  await new Promise((r) => { d.once('exit', r); setTimeout(r, 3000); });
}

async function restSessions() {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json()).list ?? [];
}

// --- Minimal CDP client -------------------------------------------------------

async function connectCDP() {
  const target = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    return list.find((t) => t.type === 'page' && t.url.startsWith('file://'));
  }, 30000, 'app page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket')); });
  let nextId = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { ws, send, evaluate, events };
}

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const KEY_CODES = { Enter: 13, c: 67, v: 86 };

async function pressKey(key, modifiers = 0) {
  const text = key === 'Enter' ? '\r' : key.length === 1 && !(modifiers & (MOD.meta | MOD.ctrl)) ? key : undefined;
  const code = key === 'Enter' ? 'Enter' : key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const base = { key, code, modifiers, windowsVirtualKeyCode: KEY_CODES[key] ?? key.toUpperCase().charCodeAt(0) };
  await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', text, ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function typeLine(line) {
  await cdp.evaluate(`document.querySelector('.term-instance:not([style*="none"]) .xterm-helper-textarea')?.focus(), true`);
  await cdp.send('Input.insertText', { text: line });
  await pressKey('Enter');
}

const screenText = () => cdp.evaluate(`(() => {
  const rows = [...document.querySelectorAll('.term-instance')].find((c) => c.style.display !== 'none')?.querySelector('.xterm-rows');
  return rows ? rows.innerText : '';
})()`);

// --- Run ------------------------------------------------------------------------

async function main() {
  console.log(`work dir ${work}`);

  const go = spawnSync('go', ['build', '-o', daemonBin, './cmd/vibe-remoted'], { cwd: join(ROOT, 'vibe-remoted'), stdio: 'inherit' });
  if (go.status !== 0) throw new Error('go build failed');
  const base = JSON.parse(readFileSync(join(ROOT, 'vibe-remoted.tmux.json'), 'utf-8'));
  writeFileSync(daemonCfg, JSON.stringify({ ...base, port, token }), { mode: 0o600 });
  await startDaemon();
  ok(`daemon up on 127.0.0.1:${port}`);
  const preexisting = new Set((await restSessions()).map((s) => s.id));

  if (!args.has('--no-build')) {
    const vb = spawnSync('npx', ['vite', 'build'], { cwd: DESKTOP, stdio: ['ignore', 'ignore', 'inherit'] });
    if (vb.status !== 0) throw new Error('vite build failed');
  }

  // A legacy (pre-encryption) plaintext machines.json: the app must encrypt it
  // on first launch through the real safeStorage code path.
  spawnSync('mkdir', ['-p', userData]);
  const machine = { name: 'gui-smoke', addr: '127.0.0.1', port, token };
  writeFileSync(join(userData, 'machines.json'), JSON.stringify([machine], null, 2), { mode: 0o644 });

  const electronBin = createRequire(join(DESKTOP, 'package.json'))('electron');
  const electronVersion = JSON.parse(readFileSync(join(DESKTOP, 'node_modules/electron/package.json'), 'utf-8')).version;
  console.log(`electron ${electronVersion}`);
  electron = spawn(electronBin, [DESKTOP, '--use-mock-keychain'], {
    env: {
      ...process.env,
      VIBE_REMOTE_DEBUG_PORT: String(cdpPort),
      VIBE_REMOTE_USER_DATA_DIR: userData,
      VIBE_REMOTE_NO_DEVTOOLS: '1',
      VITE_DEV_SERVER_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let electronLog = '';
  electron.stdout.on('data', (d) => { electronLog += d; });
  electron.stderr.on('data', (d) => { electronLog += d; });

  cdp = await connectCDP();
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  savedClipboard = await cdp.evaluate('window.vibeRemote.readClipboardText()').catch(() => null);

  // 1. Startup + machines.json migration
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.machine-name-label') && document.querySelector('.machine-name-label').textContent.includes('gui-smoke')`), 20000, 'machine in sidebar');
  ok('app started and lists the machine');
  const stored = JSON.parse(readFileSync(join(userData, 'machines.json'), 'utf-8'))[0] ?? {};
  check(typeof stored.tokenEnc === 'string' && stored.token === undefined, 'legacy plaintext token encrypted on launch', JSON.stringify(Object.keys(stored)));

  // 2. New session from the overview
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.workspace-mode-card:not([disabled])')`), 15000, 'enabled new-session card');
  await cdp.evaluate(`document.querySelector('.workspace-mode-card:not([disabled])').click(), true`);
  await waitFor(() => cdp.evaluate(`(() => { const b = document.querySelector('.modal .modal-footer .btn-primary'); return !!b && !b.disabled; })()`), 15000, 'dir picker ready');
  ok('dir picker lists the remote directory');
  await cdp.evaluate(`document.querySelector('.modal .modal-footer .btn-primary').click(), true`);
  await waitFor(async () => /\$ ?$|\$\s/m.test(await screenText()), 20000, 'shell prompt in terminal');
  ok('terminal attached and shows the remote shell prompt');
  for (const s of await restSessions()) if (!preexisting.has(s.id)) createdSessions.add(s.id);
  check(createdSessions.size === 1, 'exactly one session created on the daemon', `got ${createdSessions.size}`);

  const fill = await cdp.evaluate(`(() => {
    const c = [...document.querySelectorAll('.term-instance')].find((e) => e.style.display !== 'none');
    const screen = c?.querySelector('.xterm-screen');
    return c && screen ? screen.getBoundingClientRect().height / c.getBoundingClientRect().height : 0;
  })()`);
  check(fill > 0.8, 'terminal fills its container on first layout', `ratio ${fill.toFixed(2)}`);

  // 3. Typing reaches the PTY and output renders (marker split so the echoed
  //    command line can't satisfy the check).
  await typeLine(`echo GUI_$((40+2))_OK`);
  await waitFor(async () => (await screenText()).includes('GUI_42_OK'), 10000, 'echo output');
  ok('keystrokes reach the remote shell and output renders');

  // 4. Drag-select while the remote app has mouse reporting on, then ⌘C. This is
  //    the regression mouseEventsRequireAlt guards: without it xterm hands the
  //    drag to the app and the clipboard gets ''.
  //    The PTY's client is tmux, which only asks the outer terminal for mouse
  //    reporting when its `mouse` option is on — exactly how a mouse-aware CLI
  //    inside tmux triggers it in production. Scope it to this session only.
  await typeLine(`tmux set-option mouse on; clear; echo SELECT_ME_PLEASE`);
  await waitFor(async () => (await screenText()).includes('SELECT_ME_PLEASE'), 10000, 'selection target');
  // With mouseEventsRequireAlt, xterm only adds `enable-mouse-events` (= mouse
  // goes to the app, selection off) while ⌥ is held — and only if the app has
  // mouse reporting on. So: ⌥-hover must flip it on, a plain hover must not.
  const termBox = await cdp.evaluate(`(() => { const r = [...document.querySelectorAll('.term-instance')].find((c) => c.style.display !== 'none').querySelector('.xterm-screen').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const hover = (modifiers) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: termBox.x, y: termBox.y, modifiers });
  const mouseClass = () => cdp.evaluate(`!!document.querySelector('.xterm.enable-mouse-events')`);
  const altOn = await waitFor(async () => { await hover(MOD.alt); return mouseClass(); }, 5000, '⌥ hands mouse to the app').catch(() => false);
  check(altOn, 'remote mouse reporting is active and ⌥ routes the mouse to the app');
  await hover(0);
  check(!(await mouseClass()), 'without ⌥ the mouse stays with xterm selection');
  const rect = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.term-instance')].find((c) => c.style.display !== 'none').querySelector('.xterm-rows');
    const row = [...rows.children].find((r) => r.textContent.trim() === 'SELECT_ME_PLEASE');
    if (!row) return null;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const first = walker.nextNode();
    let last = first; for (let n = first; n; n = walker.nextNode()) last = n;
    const text = row.textContent; const start = text.indexOf('SELECT');
    range.setStart(first, Math.max(0, start)); range.setEnd(last, last.textContent.length);
    const r = range.getBoundingClientRect();
    // Start inside the first cell, end just past the last one so xterm selects
    // the whole word (ending mid-cell drops the final character).
    return { x1: r.left + 2, x2: r.right + 2, y: r.top + r.height / 2 };
  })()`);
  if (!rect) {
    const rows = await cdp.evaluate(`[...[...document.querySelectorAll('.term-instance')].find((c) => c.style.display !== 'none').querySelector('.xterm-rows').children].map((r) => r.textContent).filter((t) => t.trim()).slice(0, 8)`);
    fail(`could not locate the selection target row — rows: ${JSON.stringify(rows)}`);
  } else {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x1, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x1 + ((rect.x2 - rect.x1) * i) / 8, y: rect.y, button: 'left', buttons: 1 });
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x2, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });
    await cdp.evaluate(`window.vibeRemote.writeClipboardText('__before_copy__')`);
    await pressKey('c', MOD.meta);
    const copied = await waitFor(async () => {
      const t = await cdp.evaluate('window.vibeRemote.readClipboardText()');
      return t !== '__before_copy__' ? t : null;
    }, 5000, 'clipboard updated by ⌘C').catch(() => '');
    check(copied.trim() === 'SELECT_ME_PLEASE', 'drag-select under mouse reporting + ⌘C copies the text', JSON.stringify(copied));
  }
  await typeLine(`tmux set-option mouse off; clear`);

  // 5. ⌘V pastes the native clipboard into the PTY.
  await cdp.evaluate(`window.vibeRemote.writeClipboardText("echo PASTE_$((5+5))_OK")`);
  await cdp.evaluate(`document.querySelector('.term-instance:not([style*="none"]) .xterm-helper-textarea')?.focus(), true`);
  await pressKey('v', MOD.meta);
  await sleep(300);
  await pressKey('Enter');
  await waitFor(async () => (await screenText()).includes('PASTE_10_OK'), 10000, 'pasted command output').then(
    () => ok('⌘V pastes the native clipboard into the remote shell'),
    (e) => fail(`⌘V paste — ${e.message}`),
  );

  // 6. Window lockdown: no navigation away from the app, no new windows.
  const pagesBefore = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).filter((t) => t.type === 'page').length;
  await cdp.evaluate(`window.open('https://example.com/'), true`);
  await cdp.evaluate(`setTimeout(() => { location.href = 'https://example.com/'; }, 0), true`);
  await sleep(1500);
  const url = await cdp.evaluate('location.href');
  const pagesAfter = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).filter((t) => t.type === 'page').length;
  check(url.startsWith('file://'), 'navigation away from the app is blocked', url);
  check(pagesAfter === pagesBefore, 'window.open is denied', `${pagesBefore} → ${pagesAfter} pages`);

  // 7. A `waiting` hook event goes through the real notify path (renderer →
  //    IPC → main-process Notification, Dock fallback where native ones fail).
  //    The renderer logs `[notify] <shown|fallback>: <title>`; nothing is stubbed.
  const sessionId = [...createdSessions][0];
  const notifyLogs = () => cdp.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled')
    .map((e) => e.params.args.map((a) => a.value ?? '').join(' '))
    .filter((line) => line.startsWith('[notify]'));
  const ev = await fetch(`http://127.0.0.1:${port}/api/v1/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, kind: 'waiting', message: 'needs input' }),
  });
  check(ev.status === 204, 'events endpoint accepted the hook event', String(ev.status));
  const note = await waitFor(() => notifyLogs()[0], 8000, 'desktop notification').catch(() => null);
  check(note && /^\[notify\] (shown|fallback): /.test(note) && note.includes('gui-smoke') && !note.includes(sessionId),
    'waiting event raises a desktop notification titled with the session name', JSON.stringify(note));
  if (note) console.log(`NOTE notification outcome in this build: ${note.split(':')[0].replace('[notify] ', '')}`);

  // 8. Daemon restart: banner shows, then the session reattaches and works.
  await stopDaemon();
  await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('.reconnect-banner')].some((b) => b.style.display === 'flex')`), 15000, 'reconnect banner').then(
    () => ok('reconnect banner appears when the daemon goes away'),
    (e) => fail(`reconnect banner — ${e.message}`),
  );
  await startDaemon();
  await waitFor(() => cdp.evaluate(`![...document.querySelectorAll('.reconnect-banner')].some((b) => b.style.display === 'flex')`), 45000, 'banner cleared after reconnect').then(
    () => ok('client reconnects after the daemon restarts'),
    (e) => fail(`reconnect — ${e.message}`),
  );
  await typeLine(`echo BACK_$((6*7))_AGAIN`);
  await waitFor(async () => (await screenText()).includes('BACK_42_AGAIN'), 10000, 'output after reconnect').then(
    () => ok('the same tmux session is usable after reconnect'),
    (e) => fail(`post-reconnect session — ${e.message}`),
  );

  const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
  check(exceptions.length === 0, 'no uncaught renderer exceptions', exceptions.join(' | '));
  if (/Electron.*(Deprecat|deprecat)/.test(electronLog)) console.log(`NOTE electron deprecation output:\n${electronLog.split('\n').filter((l) => /eprecat/.test(l)).join('\n')}`);

  if (args.has('--keep')) {
    console.log('--keep: app left running; press Ctrl+C to clean up');
    await new Promise((r) => process.once('SIGINT', r));
  }
}

async function cleanup() {
  try {
    if (cdp && savedClipboard !== null) await cdp.evaluate(`window.vibeRemote.writeClipboardText(${JSON.stringify(savedClipboard)})`);
  } catch { /* app already gone */ }
  for (const id of createdSessions) {
    await fetch(`http://127.0.0.1:${port}/api/v1/sessions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  }
  try { cdp?.ws.close(); } catch { /* closed */ }
  if (electron) { electron.kill('SIGTERM'); await new Promise((r) => { electron.once('exit', r); setTimeout(r, 3000); }); }
  await stopDaemon();
  // --use-mock-keychain should keep Chromium off the login keychain; if a run
  // ever did create the app's Safe Storage item, remove only one we created.
  if (!keychainExisted && keychainHas(keychainService)) {
    spawnSync('security', ['delete-generic-password', '-s', keychainService], { stdio: 'ignore' });
    console.log(`NOTE removed the "${keychainService}" keychain item this run created (mock keychain not honored)`);
  }
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
}

main()
  .catch((e) => fail(e.message))
  .finally(async () => {
    await cleanup();
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall GUI checks passed');
    process.exit(failures ? 1 : 0);
  });
