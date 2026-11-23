#!/usr/bin/env node
// GUI regression run for the desktop app, driven over the Chrome DevTools
// Protocol. It stands in for the manual click-through after risky desktop
// changes (an Electron major upgrade, terminal or clipboard work):
//
//   legacy machines.json → encrypted on launch (real safeStorage path)
//   overview → new session → dir picker (fits 500/700/803px-high windows) →
//   terminal fills the window
//   typing → PTY echo; drag-select under mouse reporting + ⌘C; ⌘V paste
//   navigation / window.open blocked; hook event → desktop notification
//   daemon restart → reconnect banner → session recovered
//   three-level sidebar (throwaway repositories with several worktrees) →
//   every row's name, badge, state text and dot are readable at the default width;
//   at 800×500 the "more" menu of a row at the bottom of the sidebar is usable
//   and the toolbar title keeps the session name under a long branch; the note
//   under the "continue" launch option is brought into view when it appears
//   chat (second daemon, fake claude): new chat session via the picker →
//   reply rendered → permission prompt allowed once → turn resumes
//   session-switching keys (⌘1–9, ⌘⇧[, ⌘⇧]) with the focus in the terminal and
//   in the chat input: the session changes, nothing is typed into either; the
//   keys are intercepted (prevented, never delivered to the page) while another
//   ⌘ key is not, and with a dialog open they are not intercepted either
//
// It launches the *built* app (dist/) with the stock Electron binary against a
// throwaway daemon and a throwaway userData dir, so the developer's real
// machines.json, window state and tmux sessions are never touched. The chat
// cases use a second throwaway daemon whose claude_cmd is the fake claude
// (vibe-remoted/internal/chat/fakeclaude), with its own port, state_dir,
// CLAUDE_CONFIG_DIR (holding the workspace-trust file for its temp folder) and
// tmux server; the terminal cases stay on the /bin/bash daemon. macOS only:
// it needs a display and tmux.
//
// Usage (from the repo root):  node .claude/skills/verify/scripts/gui-smoke.mjs
//   --no-build   reuse existing desktop/dist and skip `vite build`
//   --keep       leave the app open at the end (manual poking); Ctrl+C to exit
// VR_SIDEBAR_SHOT=<file.png> saves screenshots of the sidebar after the layout checks.
// Requires Node 22+ (global WebSocket).

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { pickerLayout } from './picker-layout.mjs';
import { sidebarLayout, makeSidebarRepos, startSession, LONG_BRANCH } from './sidebar-layout.mjs';
import { rowMenuLayout, titleLayout, continueNoteLayout } from './shell-layout.mjs';

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
// Chat daemon: fake claude, isolated claude config + tmux server (short path:
// macOS caps socket paths at ~104 bytes).
const chatPort = 20000 + ((port - 20000 + 1 + Math.floor(Math.random() * 9998)) % 10000);
const chatToken = randomBytes(32).toString('hex');
const chatCfg = join(work, 'chat-daemon.json');
const claudeBin = join(work, 'bin', 'claude');
const chatTmux = mkdtempSync('/tmp/vr-gt-');
let chatDaemon = null;
const keychainService = 'vibe-remote Safe Storage';
const keychainExisted = keychainHas(keychainService);
let daemon = null;
let electron = null;
let savedClipboard = null;
let cdp = null;
const createdSessions = new Set();
let sidebarRoot = null;
// The only directory the bash daemon may use (its default_workdir and allowed_roots).
let termWorkdir = null;

function keychainHas(service) {
  return spawnSync('security', ['find-generic-password', '-s', service], { stdio: 'ignore' }).status === 0;
}

function startDaemon() {
  // The daemon reads claude's trust file for the directory picker (chatTrust)
  // although it runs /bin/bash: give it an empty config directory of this run,
  // so that it never reads the real ~/.claude.json.
  const noClaude = join(work, 'term-claude-config');
  mkdirSync(noClaude, { recursive: true, mode: 0o700 });
  daemon = spawn(daemonBin, ['--config', daemonCfg], { env: { ...process.env, CLAUDE_CONFIG_DIR: noClaude }, stdio: ['ignore', 'pipe', 'pipe'] });
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

// The chat daemon's environment: no nested-claude guard from the shell running
// this script, claude's config (transcripts, trust) and tmux in temp dirs.
function chatEnv(configDir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR', 'TMUX', 'TMUX_PANE'].includes(k) || k.startsWith('FAKE_CLAUDE_')) continue;
    env[k] = v;
  }
  return { ...env, CLAUDE_CONFIG_DIR: configDir, TMUX_TMPDIR: chatTmux };
}

function startChatDaemon(configDir) {
  chatDaemon = spawn(daemonBin, ['--config', chatCfg], { env: chatEnv(configDir), stdio: ['ignore', 'pipe', 'pipe'] });
  chatDaemon.stdout.on('data', () => {});
  chatDaemon.stderr.on('data', () => {});
  return waitFor(async () => (await fetch(`http://127.0.0.1:${chatPort}/healthz`)).ok, 15000, 'chat daemon /healthz');
}

async function stopChatDaemon() {
  if (!chatDaemon) return;
  const d = chatDaemon;
  chatDaemon = null;
  d.kill('SIGTERM');
  await new Promise((r) => { d.once('exit', r); setTimeout(r, 8000); });
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
  // One launch option, off by default: the new-session dialogs show their
  // options section, and the note under "continue" can be measured (step 9).
  // No session of this run is started with it.
  const claudeFlags = [{ id: 'continue', label: 'Continue the last conversation (-c)', arg: '-c' }];
  // The bash daemon only gets a directory of this run, not all of /tmp.
  mkdirSync(join(work, 'term-proj'), { recursive: true });
  termWorkdir = realpathSync(join(work, 'term-proj'));
  writeFileSync(daemonCfg, JSON.stringify({ ...base, port, token, default_workdir: termWorkdir, allowed_roots: [termWorkdir], claude_flags: claudeFlags }), { mode: 0o600 });
  await startDaemon();
  ok(`daemon up on 127.0.0.1:${port}`);
  const preexisting = new Set((await restSessions()).map((s) => s.id));

  // Second daemon for the chat cases: claude_cmd is the fake claude, and its
  // temp workdir is marked trusted in its own CLAUDE_CONFIG_DIR (never the
  // real ~/.claude.json).
  const fake = spawnSync('go', ['build', '-o', claudeBin, './internal/chat/fakeclaude'], { cwd: join(ROOT, 'vibe-remoted'), stdio: 'inherit' });
  if (fake.status !== 0) throw new Error('go build fakeclaude failed');
  const chatDir = join(work, 'chat-proj');
  const chatConfigDir = join(work, 'chat-claude-config');
  mkdirSync(chatDir, { recursive: true });
  mkdirSync(chatConfigDir, { recursive: true, mode: 0o700 });
  const chatWorkdir = realpathSync(chatDir);
  writeFileSync(join(chatConfigDir, '.claude.json'), JSON.stringify({ projects: { [chatWorkdir]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  writeFileSync(chatCfg, JSON.stringify({
    bind_addr: '127.0.0.1', port: chatPort, token: chatToken,
    default_workdir: chatWorkdir, allowed_roots: [chatWorkdir],
    use_tmux: true, claude_cmd: claudeBin, claude_reload_cmd: claudeBin, login_shell: false,
    state_dir: join(work, 'chat-state'),
  }), { mode: 0o600 });
  await startChatDaemon(chatConfigDir);
  ok(`chat daemon (fake claude) up on 127.0.0.1:${chatPort}`);

  if (!args.has('--no-build')) {
    const vb = spawnSync('npx', ['vite', 'build'], { cwd: DESKTOP, stdio: ['ignore', 'ignore', 'inherit'] });
    if (vb.status !== 0) throw new Error('vite build failed');
  }

  // A legacy (pre-encryption) plaintext machines.json: the app must encrypt it
  // on first launch through the real safeStorage code path.
  spawnSync('mkdir', ['-p', userData]);
  const machine = { name: 'gui-smoke', addr: '127.0.0.1', port, token };
  const chatMachine = { name: 'gui-chat', addr: '127.0.0.1', port: chatPort, token: chatToken };
  writeFileSync(join(userData, 'machines.json'), JSON.stringify([machine, chatMachine], null, 2), { mode: 0o644 });

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
  for (const l of await pickerLayout(cdp)) check(l.problems.length === 0, `dir picker fits a ${l.height}px-high window`, l.problems.join('; '));
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
  // Where the output line is. The typed command contains the same words, so
  // "the screen mentions them" is true before `clear; echo` has run: wait for
  // the line that is exactly the output, with the prompt back below it, and
  // for two looks 150 ms apart to see the same screen in the same place.
  const locateTarget = () => cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.term-instance')].find((c) => c.style.display !== 'none').querySelector('.xterm-rows');
    const list = [...rows.children];
    const i = list.findIndex((r) => r.textContent.trim() === 'SELECT_ME_PLEASE');
    if (i < 0) return null;
    const row = list[i];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const first = walker.nextNode();
    let last = first; for (let n = first; n; n = walker.nextNode()) last = n;
    const text = row.textContent; const start = text.indexOf('SELECT');
    range.setStart(first, Math.max(0, start)); range.setEnd(last, last.textContent.length);
    const r = range.getBoundingClientRect();
    // Start inside the first cell, end just past the last one so xterm selects
    // the whole word (ending mid-cell drops the final character).
    return { x1: r.left + 2, x2: r.right + 2, y: r.top + r.height / 2, below: list[i + 1]?.textContent ?? '', screen: rows.innerText };
  })()`);
  const settledTarget = async () => {
    const a = await locateTarget();
    if (!a || !/\$\s*$/.test(a.below)) return null;
    await sleep(150);
    const b = await locateTarget();
    return b && b.y === a.y && b.screen === a.screen ? b : null;
  };
  await waitFor(settledTarget, 10000, 'selection target on a settled screen').catch(() => null);
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
  let rect = await waitFor(settledTarget, 10000, 'selection target on a settled screen').catch(() => null);
  if (!rect) {
    const rows = await cdp.evaluate(`[...[...document.querySelectorAll('.term-instance')].find((c) => c.style.display !== 'none').querySelector('.xterm-rows').children].map((r) => r.textContent).filter((t) => t.trim()).slice(0, 8)`);
    fail(`could not locate the selection target row — rows: ${JSON.stringify(rows)}`);
  } else {
    // The drag is nine separate CDP calls. If the screen moved under them
    // (a late repaint), the coordinates measured before are stale and the
    // selection spans other rows: look again afterwards and redo the gesture
    // from fresh coordinates. What gets copied is asserted exactly either way.
    for (let attempt = 1; ; attempt++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x1, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 8; i++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x1 + ((rect.x2 - rect.x1) * i) / 8, y: rect.y, button: 'left', buttons: 1 });
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x2, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });
      const after = await locateTarget();
      if ((after && after.y === rect.y && after.screen === rect.screen) || attempt >= 3) break;
      console.log(`NOTE drag-select: the screen changed during the drag (target row y ${rect.y} → ${after ? after.y : 'gone'}); measuring again (attempt ${attempt + 1})`);
      const again = await waitFor(settledTarget, 10000, 'selection target on a settled screen').catch(() => null);
      if (!again) break;
      rect = again;
    }
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

  // 9. Three-level sidebar: every row readable at the default sidebar width.
  await sidebarCase(sessionId);

  // 10. Chat sessions on the second machine (fake claude).
  await chatCases();
  const withChat = await sidebarLayout(cdp);
  check(withChat.problems.length === 0, 'sidebar rows stay readable with a chat session listed', withChat.problems.join('; '));
  if (process.env.VR_SIDEBAR_SHOT) await sidebarShot(process.env.VR_SIDEBAR_SHOT);

  // 11. Session-switching keys.
  await shortcutCase(sessionId);

  const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
  check(exceptions.length === 0, 'no uncaught renderer exceptions', exceptions.join(' | '));
  if (/Electron.*(Deprecat|deprecat)/.test(electronLog)) console.log(`NOTE electron deprecation output:\n${electronLog.split('\n').filter((l) => /eprecat/.test(l)).join('\n')}`);

  if (args.has('--keep')) {
    console.log('--keep: app left running; press Ctrl+C to clean up');
    console.log(`--keep: Electron pid ${electron.pid}`);
    console.log(`--keep: CDP 127.0.0.1:${cdpPort}`);
    await new Promise((r) => process.once('SIGINT', r));
  }
}

// Sessions spread over three projects (one with four worktrees, two flat) and a
// plain folder; two of them carry a state dot. Then the real boxes are measured.
async function sidebarCase(firstSessionId) {
  try {
    const repos = makeSidebarRepos(termWorkdir);
    sidebarRoot = repos.root;
    const d = repos.dirs;
    const addr = `127.0.0.1:${port}`;
    const ids = {};
    for (const [k, dir] of [['main', d.main], ['fix', d.fix], ['fix2', d.fix], ['long', d.long], ['api', d.newApi], ['api2', d.newApi], ['billing', d.billing], ['notes', d.notes]]) {
      ids[k] = await startSession(addr, token, dir);
      createdSessions.add(ids[k]);
    }
    const rename = (id, name) => fetch(`http://${addr}/api/v1/sessions/${id}/rename`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await rename(ids.fix2, '登录修复与回归测试的会话');
    await rename(ids.api2, 'a-session-with-a-rather-long-name');
    const row = (id) => `document.querySelector('.session-item[data-session-id="${id}"]')`;
    await waitFor(() => cdp.evaluate(`[${Object.values(ids).map((id) => JSON.stringify(id)).join(',')}].every((id) => !!document.querySelector('.session-item[data-session-id="' + id + '"]'))
      && document.querySelectorAll('.worktree-row').length >= 4
      && [...document.querySelectorAll('.session-label-text')].some((e) => e.textContent.includes('登录修复'))`), 20000, 'sidebar lists the new sessions and worktrees');
    // A state dot needs an open view: open two of the sessions, go back to the
    // first one, then send them hook events.
    const open = async (id) => {
      await cdp.evaluate(`${row(id)}.querySelector('.session-label').click(), true`);
      await waitFor(() => cdp.evaluate(`${row(id)}?.classList.contains('active')`), 15000, `session ${id} open`);
    };
    await open(ids.fix);
    await open(ids.api);
    await open(firstSessionId);
    const event = (sessionId, kind) => fetch(`http://${addr}/api/v1/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, kind, message: 'layout' }),
    });
    await event(ids.fix, 'idle');
    await event(ids.api, 'waiting');
    await waitFor(() => cdp.evaluate(`${row(ids.fix)}?.dataset.dot === 'idle' && ${row(ids.api)}?.dataset.dot === 'waiting'`), 10000, 'state dots on the two background sessions');
    const l = await sidebarLayout(cdp);
    const labels = await cdp.evaluate(`[...document.querySelectorAll('.worktree-label')].map((e) => e.textContent)`);
    console.log(`NOTE sidebar ${l.width}px wide: ${l.rows} rows (${l.hovered} also measured under the mouse), ${l.sessions} sessions; names ending in "…": ${l.truncated.length ? l.truncated.join(' | ') : 'none'}`);
    check(l.sessions >= 9 && labels.includes(LONG_BRANCH) && labels.includes('fix-login'), 'sidebar shows the projects, worktrees and sessions under test', `${l.sessions} sessions, worktrees ${JSON.stringify(labels)}`);
    check(l.problems.length === 0, 'sidebar rows are readable at the default width (names, badges, state text, dots)', l.problems.join('; '));
    // The smallest window: a row at the bottom of the sidebar still gets a menu that can be used.
    const menus = await rowMenuLayout(cdp);
    console.log(`NOTE row menus in an 800×500 window: ${(menus.measured ?? []).join(' | ')}`);
    check(menus.problems.length === 0 && menus.nearBottom > 0, 'the "more" menu of a project row and of a worktree row at the bottom of the sidebar stays inside an 800×500 window and takes a click',
      menus.problems.length ? menus.problems.join('; ') : 'no row sat near the bottom of the window: nothing was exercised');
    // The toolbar title of the session under the long branch: the branch is what gets shortened.
    await open(ids.long);
    const title = await titleLayout(cdp);
    console.log(`NOTE toolbar title in an 800×500 window: ${JSON.stringify({ project: title.project, branch: title.branch, session: title.session })}`);
    check(title.problems.length === 0 && title.branch?.text === LONG_BRANCH && title.branch.needs > title.branch.shown,
      'under a long branch the toolbar title of an 800×500 window shortens the branch and keeps the session name whole',
      title.problems.length ? title.problems.join('; ') : `the branch was not the long one or was not shortened: ${JSON.stringify(title.branch)}`);
    // "New session" in a worktree that already has sessions: ticking "continue" shows a note, which has to be readable.
    await cdp.evaluate(`[...document.querySelectorAll('.worktree-group')].find((g) => g.querySelector('.worktree-label').textContent === 'fix-login').querySelector('[data-testid="worktree-new-session"]').click(), true`);
    await waitFor(() => cdp.evaluate(`(() => { const d = document.querySelector('.modal-overlay [data-testid="worktree-session-dialog"]'); const b = d?.querySelector('[data-testid="dialog-confirm"]'); return !!b && !b.disabled && !!d.querySelector('.modal-flag input[name="claude-flag-continue"]'); })()`), 10000, 'new-session dialog with its launch options');
    const note = await continueNoteLayout(cdp);
    await cdp.evaluate(`document.querySelector('.modal-overlay [data-testid="dialog-cancel"]').click(), true`);
    await waitFor(() => cdp.evaluate(`!document.querySelector('.modal-overlay')`), 5000, 'new-session dialog closed');
    check(note.problems.length === 0 && note.height > 0, 'in an 800×500 window the note under "continue" is fully visible once the option is ticked',
      note.problems.length ? note.problems.join('; ') : 'the note has no height');
  } catch (e) {
    fail(`three-level sidebar layout — ${e.message}`);
  }
}

// Saves the sidebar as shown, then with the mouse over the first project row
// (<name>-hover.png: the row's action buttons); when the list scrolls, a third
// file (<name>-bottom.png) shows its end.
async function sidebarShot(file) {
  const r = await cdp.evaluate(`(() => { const b = document.querySelector('#sidebar').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width + 24, height: b.height }; })()`);
  const save = async (to) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 2 } });
    writeFileSync(to, Buffer.from(shot.data, 'base64'));
    console.log(`NOTE sidebar screenshot saved to ${to}`);
  };
  const scroller = `(() => { let e = document.querySelector('#machine-list'); while (e && e.scrollHeight <= e.clientHeight + 1) e = e.parentElement; return e; })()`;
  await save(file);
  const suffix = (tag) => file.replace(/(\.png)?$/, `-${tag}.png`);
  const p = await cdp.evaluate(`(() => { const b = document.querySelector('.project-row')?.getBoundingClientRect(); return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null; })()`);
  if (p) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await save(suffix('hover'));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.width + 200, y: 8 });
  }
  if (await cdp.evaluate(`(() => { const e = ${scroller}; if (!e) return false; e.scrollTop = e.scrollHeight; return true; })()`)) {
    await sleep(200);
    await save(suffix('bottom'));
    await cdp.evaluate(`${scroller}.scrollTop = 0, true`);
  }
}

const $tid = (id) => `document.querySelector('[data-testid="${id}"]')`;
const visibleChat = `[...document.querySelectorAll('.chat-instance')].find((c) => c.style.display !== 'none')`;

async function chatCases() {
  // chat session created via picker: open the gui-chat machine, pick "Chat".
  try {
    await cdp.evaluate(`[...document.querySelectorAll('.machine-name')].find((b) => b.textContent.includes('gui-chat')).click(), true`);
    await waitFor(() => cdp.evaluate(`!!document.querySelector('.workspace-mode-card:not([disabled])')`), 15000, 'chat machine online');
    await cdp.evaluate(`document.querySelector('.workspace-mode-card:not([disabled])').click(), true`);
    await waitFor(() => cdp.evaluate(`(() => { const c = ${$tid('picker-ui-chat')}; return !!c && !c.disabled; })()`), 15000, 'chat card enabled');
    await cdp.evaluate(`${$tid('picker-ui-chat')}.click(), true`);
    await waitFor(() => cdp.evaluate(`(() => { const b = document.querySelector('.modal .modal-footer .btn-primary'); return !!b && !b.disabled && ${$tid('picker-ui-chat')}.getAttribute('aria-pressed') === 'true'; })()`), 10000, 'picker ready with chat chosen');
    for (const l of await pickerLayout(cdp)) check(l.problems.length === 0, `dir picker with chat chosen fits a ${l.height}px-high window`, l.problems.join('; '));
    await cdp.evaluate(`document.querySelector('.modal .modal-footer .btn-primary').click(), true`);
    await waitFor(() => cdp.evaluate(`(() => {
      const v = ${visibleChat};
      const input = v?.querySelector('[data-testid="chat-input"]');
      return !!v && v.dataset.testid === 'chat-view' && !!input && !input.disabled
        && !!document.querySelector('.session-item[data-ui="chat"]');
    })()`), 20000, 'chat view open with a chat sidebar entry');
    ok('chat session created via picker');
  } catch (e) {
    fail(`chat session created via picker — ${e.message}`);
    return;
  }

  const sendChat = async (text) => {
    await cdp.evaluate(`${visibleChat}.querySelector('[data-testid="chat-input"]').focus(), true`);
    await cdp.send('Input.insertText', { text });
    await pressKey('Enter');
  };
  const assistantText = () => cdp.evaluate(`[...${visibleChat}.querySelectorAll('[data-testid="chat-msg-assistant"]')].map((m) => m.textContent).join('\\n')`);

  // chat reply rendered
  try {
    await sendChat('echo hi from gui');
    await waitFor(() => cdp.evaluate(`[...${visibleChat}.querySelectorAll('[data-testid="chat-msg-user"]')].some((m) => m.textContent.includes('echo hi from gui'))`), 10000, 'user message');
    await waitFor(async () => (await assistantText()).includes('hi from gui'), 15000, 'assistant reply');
    ok('chat reply rendered');
  } catch (e) {
    fail(`chat reply rendered — ${e.message}`);
  }

  // permission allow once resumes
  try {
    await sendChat('perm touch gui-smoke.txt');
    await waitFor(() => cdp.evaluate(`!!${visibleChat}.querySelector('[data-testid="chat-perm"] [data-testid="chat-perm-allow"]')`), 15000, 'permission prompt');
    await cdp.evaluate(`${visibleChat}.querySelector('[data-testid="chat-perm-allow"]').click(), true`);
    await waitFor(() => cdp.evaluate(`!${visibleChat}.querySelector('[data-testid="chat-perm"]')`), 10000, 'prompt closed');
    await waitFor(async () => (await assistantText()).includes('done Bash'), 15000, 'reply after allow');
    ok('permission allow once resumes');
  } catch (e) {
    fail(`permission allow once resumes — ${e.message}`);
  }
}

// ⌘1–9 / ⌘⇧[ / ⌘⇧] sent as key events to this app's page (never to the system):
// the session shown changes, in sidebar order, and the keys reach neither the
// PTY nor the chat input. Runs last: every session of the run is listed by now.
const SHORTCUT_KEYS = {
  next: ['}', 'BracketRight', 221, MOD.meta | MOD.shift],
  prev: ['{', 'BracketLeft', 219, MOD.meta | MOD.shift],
};
for (let n = 1; n <= 9; n++) SHORTCUT_KEYS[n] = [String(n), `Digit${n}`, 48 + n, MOD.meta];
// Not a shortcut of this app: the control for "is the key intercepted".
SHORTCUT_KEYS.k = ['k', 'KeyK', 75, MOD.meta];

// Records where each ⌘ keydown gets to. The app takes its switching keys on
// `window` in the capture phase, prevents their default action and stops them
// there. Three probes, all added after the app's own listener:
//   seen    — on window, capture: runs for every key (same target as the app's
//             listener, which ran first); `prevented` is what the app did to it
//   page    — on document, capture: the first stop past the window; a key that
//             was stopped never gets here, whatever the focused element does
//   bubble  — on document, bubble: the key went all the way down and back up
// "No bytes sent" and "nothing typed" cannot tell an intercepted ⌘ key from an
// ignored one (xterm sends nothing for ⌘ keys anyway); this can.
const KEY_PROBE = `(() => {
  if (!window.__vrKeyProbe) {
    const log = window.__vrKeyProbe = [];
    const note = (phase) => (e) => { if (e.metaKey) log.push({ phase, code: e.code, prevented: e.defaultPrevented }); };
    window.addEventListener('keydown', note('seen'), true);
    document.addEventListener('keydown', note('page'), true);
    document.addEventListener('keydown', note('bubble'), false);
  }
  window.__vrKeyProbe.length = 0;
  return true;
})()`;

// Presses the key and reports how far its keydown got.
async function probeKey(name) {
  await cdp.evaluate(KEY_PROBE);
  await pressShortcut(name);
  const log = await cdp.evaluate(`JSON.stringify(window.__vrKeyProbe)`);
  const events = JSON.parse(log).filter((e) => e.code === SHORTCUT_KEYS[name][1]);
  const at = (phase) => events.find((e) => e.phase === phase);
  return {
    name,
    // Taken by the app: prevented, and delivered to nothing past the window.
    intercepted: !!at('seen') && at('seen').prevented === true && !at('page') && !at('bubble'),
    // Left alone: delivered through the page, default action intact.
    delivered: !!at('seen') && at('seen').prevented === false && !!at('page') && !!at('bubble') && at('bubble').prevented === false,
    trace: events.map((e) => `${e.phase}${e.prevented ? '(prevented)' : ''}`).join('>') || 'no keydown',
  };
}
const traces = (list) => list.map((p) => `${p.name}: ${p.trace}`).join('; ');

async function pressShortcut(name) {
  const [key, code, vk, modifiers] = SHORTCUT_KEYS[name];
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function shortcutCase(firstSessionId) {
  try {
    const order = () => cdp.evaluate(`[...document.querySelectorAll('#machine-list .session-item')].filter((r) => r.getClientRects().length > 0).map((r) => r.dataset.sessionId)`);
    const active = () => cdp.evaluate(`document.querySelector('#machine-list .session-item.active')?.dataset.sessionId ?? null`);
    const focusKind = () => cdp.evaluate(`(() => { const a = document.activeElement; return !a ? 'none' : a.classList.contains('xterm-helper-textarea') ? 'terminal' : a.dataset.testid === 'chat-input' ? 'chat-input' : a.tagName.toLowerCase(); })()`);
    // Presses the key and reports whether `want` became the session shown.
    const switchTo = async (name, want) => {
      await pressShortcut(name);
      return waitFor(async () => (await active()) === want, 8000, `${name} → ${want}`).then(() => true, () => false);
    };
    // Presses the key and reports whether the session shown stayed `want`.
    const stays = async (name, want) => {
      await pressShortcut(name);
      await sleep(400);
      return (await active()) === want;
    };
    const openRow = async (id) => {
      await cdp.evaluate(`document.querySelector('.session-item[data-session-id="${id}"] .session-label').click(), true`);
      await waitFor(async () => (await active()) === id, 15000, `session ${id} open`);
    };
    const focusTerminal = async () => {
      await cdp.evaluate(`document.querySelector('.term-instance:not([style*="none"]) .xterm-helper-textarea')?.focus(), true`);
      return (await focusKind()) === 'terminal';
    };

    const all = await order();
    const n = all.length;
    const chatId = await cdp.evaluate(`document.querySelector('#machine-list .session-item[data-ui="chat"]')?.dataset.sessionId ?? null`);
    if (n < 5 || !chatId || all[n - 1] !== chatId) throw new Error(`unexpected sidebar: ${n} sessions, chat session ${chatId} at ${all.indexOf(chatId)}`);

    // By position, then previous / next, from a focused terminal (R7.1, R7.2, R7.3).
    await openRow(firstSessionId);
    const inTerminal = await focusTerminal();
    const third = await switchTo(3, all[2]);
    const next = await switchTo('next', all[3]);
    const prev = await switchTo('prev', all[2]);
    check(inTerminal && third && next && prev, '⌘3 opens the third session in the sidebar; ⌘⇧] and ⌘⇧[ step to its neighbours',
      `focus in terminal ${inTerminal}, ⌘3 ${third}, ⌘⇧] ${next}, ⌘⇧[ ${prev}`);

    // The interception itself, from the focused terminal (R7.3): the switching
    // keys stop at the window; a ⌘ key that is not one of them goes through.
    const termFocused = await waitFor(async () => (await focusKind()) === 'terminal', 3000, 'terminal focused').then(() => true, () => false);
    const tNext = await probeKey('next');
    await waitFor(async () => (await active()) === all[3], 8000, '⌘⇧] → the fourth session').catch(() => {});
    await waitFor(async () => (await focusKind()) === 'terminal', 3000, 'terminal focused').catch(() => {});
    const tIndex = await probeKey(3);
    await waitFor(async () => (await active()) === all[2], 8000, '⌘3 → the third session').catch(() => {});
    await waitFor(async () => (await focusKind()) === 'terminal', 3000, 'terminal focused').catch(() => {});
    const tOther = await probeKey('k');
    const tStayed = (await active()) === all[2] && (await focusKind()) === 'terminal';
    check(termFocused && tNext.intercepted && tIndex.intercepted && tOther.delivered && tStayed,
      'in a focused terminal ⌘⇧] and ⌘3 are taken before the page sees them (prevented, not delivered), while ⌘K is delivered untouched',
      `terminal focused ${termFocused}; ${traces([tNext, tIndex, tOther])}; after ⌘K still on the third session with the terminal focused ${tStayed}`);

    // Wrapping at both ends; the last session is the chat one.
    const first = await switchTo(1, all[0]);
    const wrapBack = await switchTo('prev', all[n - 1]);
    const wrapOn = await switchTo('next', all[0]);
    check(first && wrapBack && wrapOn, '⌘⇧[ on the first session goes to the last one and ⌘⇧] comes back', `⌘1 ${first}, ⌘⇧[ ${wrapBack}, ⌘⇧] ${wrapOn}`);

    // From the chat input: the keys switch and the draft is left alone (R7.3).
    await openRow(chatId);
    await cdp.evaluate(`${visibleChat}.querySelector('[data-testid="chat-input"]').focus(), true`);
    await cdp.send('Input.insertText', { text: 'draft stays' });
    const inChat = (await focusKind()) === 'chat-input';
    const away = await switchTo('prev', all[n - 2]);
    const back = await switchTo('next', chatId);
    const draft = await cdp.evaluate(`${visibleChat}.querySelector('[data-testid="chat-input"]').value`);
    check(inChat && away && back && draft === 'draft stays', 'with the focus in the chat input the keys switch sessions and type nothing into it',
      `focus in chat input ${inChat}, ⌘⇧[ ${away}, ⌘⇧] back ${back}, input ${JSON.stringify(draft)}`);
    // And the interception with the focus in the chat input: same as in the terminal.
    await cdp.evaluate(`${visibleChat}.querySelector('[data-testid="chat-input"]').focus(), true`);
    const cFocused = (await focusKind()) === 'chat-input';
    const cOther = await probeKey('k');
    const cStayed = (await active()) === chatId;
    const cPrev = await probeKey('prev');
    const cMoved = await waitFor(async () => (await active()) === all[n - 2], 8000, '⌘⇧[ from the chat input').then(() => true, () => false);
    await openRow(chatId);
    const draftAfter = await cdp.evaluate(`${visibleChat}.querySelector('[data-testid="chat-input"]').value`);
    check(cFocused && cOther.delivered && cStayed && cPrev.intercepted && cMoved && draftAfter === 'draft stays',
      'with the focus in the chat input ⌘⇧[ is taken before the input sees it, while ⌘K reaches the input and changes nothing',
      `focus in chat input ${cFocused}; ${traces([cOther, cPrev])}; ⌘K stayed ${cStayed}, ⌘⇧[ switched ${cMoved}, input ${JSON.stringify(draftAfter)}`);
    await cdp.evaluate(`(() => { const i = ${visibleChat}.querySelector('[data-testid="chat-input"]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

    // A folded project is skipped, and a position past the end does nothing (R7.5, R7.1).
    const folded = await cdp.evaluate(`(() => {
      const group = [...document.querySelectorAll('#machine-list .project-group')].find((g) => g.querySelectorAll('.session-item').length >= 3 && !g.querySelector('.session-item.active'));
      if (!group) return null;
      const ids = [...group.querySelectorAll('.session-item')].map((r) => r.dataset.sessionId);
      group.querySelector('.project-toggle').click();
      return { project: group.dataset.projectId, ids };
    })()`);
    if (!folded) throw new Error('no project with three sessions to fold');
    const visible = await waitFor(async () => { const o = await order(); return o.length === n - folded.ids.length ? o : null; }, 5000, 'project folded');
    const start = visible.indexOf(chatId);
    const seen = [];
    for (let i = 1; i <= visible.length; i++) {
      const want = visible[(start + i) % visible.length];
      if (!(await switchTo('next', want))) { seen.push(`${await active()} (wanted ${want})`); break; }
      seen.push(want);
    }
    const fullCircle = seen.length === visible.length && seen[seen.length - 1] === chatId && !seen.some((id) => folded.ids.includes(id));
    const pastEnd = visible.length < 9 ? await stays(9, chatId) : true;
    check(fullCircle && pastEnd, 'a folded project is skipped by ⌘⇧], and ⌘9 with fewer than nine sessions showing does nothing',
      `${visible.length} showing, a full circle visited ${seen.length}: ${seen.join(', ')}; ⌘9 stayed ${pastEnd}`);
    await cdp.evaluate(`document.querySelector('#machine-list .project-group[data-project-id=${JSON.stringify(folded.project)}] .project-toggle').click(), true`);
    await waitFor(async () => (await order()).length === n, 5000, 'project unfolded');

    // With a dialog open the keys do nothing (R7.4).
    await openRow(all[1]);
    await cdp.evaluate(`document.querySelector('.session-item[data-session-id="${all[2]}"] .session-close').click(), true`);
    await waitFor(() => cdp.evaluate(`!!document.querySelector('.modal-overlay [data-testid="delete-session-dialog"]')`), 5000, 'delete confirmation');
    const blockedIndex = await stays(4, all[1]);
    const blockedNext = await stays('next', all[1]);
    // Not intercepted at all while a dialog is open (R7.4): the keys are delivered like any other.
    const dIndex = await probeKey(4);
    const dNext = await probeKey('next');
    await sleep(400);
    const dStayed = (await active()) === all[1];
    await cdp.evaluate(`document.querySelector('.modal-overlay [data-testid="dialog-cancel"]').click(), true`);
    await waitFor(() => cdp.evaluate(`!document.querySelector('.modal-overlay')`), 5000, 'confirmation closed');
    check(blockedIndex && blockedNext && (await order()).length === n, 'with a dialog open ⌘4 and ⌘⇧] leave the session shown alone', `⌘4 stayed ${blockedIndex}, ⌘⇧] stayed ${blockedNext}`);
    check(dIndex.delivered && dNext.delivered && dStayed, 'with a dialog open ⌘4 and ⌘⇧] are not intercepted: they are delivered to the page with their default action intact',
      `${traces([dIndex, dNext])}; session stayed ${dStayed}`);

    // Nothing goes to a PTY for these keys. Every terminal session is opened
    // first, so that a first attach (xterm answering the remote's terminal
    // queries) cannot be mistaken for a typed key.
    for (const id of all) if (id !== chatId) await openRow(id);
    await sleep(1500);
    await cdp.evaluate(`(() => {
      window.__vrSent = [];
      if (!window.__vrSendHooked) {
        window.__vrSendHooked = true;
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (d) {
          try { const f = JSON.parse(d); if (f.type === 'data') window.__vrSent.push(atob(f.payload)); } catch { /* not a frame */ }
          return send.call(this, d);
        };
      }
      return true;
    })()`);
    const sent = () => cdp.evaluate(`JSON.stringify(window.__vrSent)`);
    await openRow(all[0]);
    const focused = [await focusTerminal()];
    const steps = [[2, all[1]], ['next', all[2]], [5, all[4]], ['prev', all[3]], [1, all[0]]];
    const moved = [];
    for (const [name, want] of steps) {
      moved.push(await switchTo(name, want));
      // The session just shown takes the focus itself; the next key goes to its terminal.
      focused.push(await waitFor(async () => (await focusKind()) === 'terminal', 3000, 'terminal focused').then(() => true, () => false));
    }
    const stayed = n < 9 ? await stays(9, all[0]) : true;
    const typed = await sent();
    check(moved.every(Boolean) && focused.every(Boolean) && stayed && typed === '[]', 'the switching keys pressed in a focused terminal send no bytes to the remote',
      `switched ${JSON.stringify(moved)}, terminal focused ${JSON.stringify(focused)}, bytes sent ${typed}`);
    // The same recorder does see ordinary typing.
    await typeLine(`echo KEYS_$((3+4))_OK`);
    await waitFor(async () => (await screenText()).includes('KEYS_7_OK'), 10000, 'echo after the shortcuts');
    check((await sent()).includes('KEYS_'), 'ordinary keys typed afterwards still reach the remote shell');
  } catch (e) {
    fail(`session-switching keys — ${e.message}`);
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
  await stopChatDaemon();
  spawnSync('tmux', ['-L', 'vibe-remote', 'kill-server'], { env: { ...process.env, TMUX_TMPDIR: chatTmux }, stdio: 'ignore' });
  rmSync(chatTmux, { recursive: true, force: true });
  // --use-mock-keychain should keep Chromium off the login keychain; if a run
  // ever did create the app's Safe Storage item, remove only one we created.
  if (!keychainExisted && keychainHas(keychainService)) {
    spawnSync('security', ['delete-generic-password', '-s', keychainService], { stdio: 'ignore' });
    console.log(`NOTE removed the "${keychainService}" keychain item this run created (mock keychain not honored)`);
  }
  if (sidebarRoot) rmSync(sidebarRoot, { recursive: true, force: true });
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
}

main()
  .catch((e) => fail(e.message))
  .finally(async () => {
    await cleanup();
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall GUI checks passed');
    process.exit(failures ? 1 : 0);
  });
