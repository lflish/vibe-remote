// Shared helpers for the chat test scripts: bundle a TS entry with esbuild and
// import it, plus a tiny named-case runner that prints `ok - <name>` and exits
// non-zero on the first failure. No test framework.
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dirs = [];
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Bundles `entry` (relative to desktop/) and imports it. */
export async function load(entry, { platform = 'neutral' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vr-chat-test-'));
  dirs.push(dir);
  const outfile = join(dir, 'bundle.mjs');
  await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

/**
 * A jsdom page with the elements the renderer entry needs, installed as the
 * globals (window, document, …). `notifications` collects notify() calls; the
 * window reports focus unless `focus.window` is cleared. Rendering frames are
 * queued (`flushFrames`).
 */
export async function indexDom() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(
    '<!doctype html><body><div id="machine-list"></div><div id="terminal-container"><div id="machine-overview"></div></div>' +
      '<div id="status-bar"></div><div id="status-message"></div><div id="toolbar-title"></div><div id="toolbar-status"></div>' +
      '<div id="toolbar-status-text"></div></body>',
    { url: 'https://local.test', pretendToBeVisual: true },
  );
  const w = dom.window;
  for (const k of ['window', 'document', 'localStorage', 'location', 'HTMLElement', 'HTMLDetailsElement', 'HTMLInputElement', 'Node', 'MouseEvent', 'KeyboardEvent', 'Event']) {
    Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });
  const focus = { window: true };
  Object.defineProperty(w.document, 'hasFocus', { value: () => focus.window });
  let frames = [];
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  const notifications = [];
  w.vibeRemote = {
    onNotificationClick() {},
    notify(title, body, tag) { notifications.push({ title, body, tag }); return Promise.resolve(focus.notifyResult ?? 'shown'); },
    openExternal: async () => true,
    writeClipboardText: async () => true,
  };
  return {
    dom,
    notifications,
    /** Window focus as the page sees it; `focus.notifyResult` = what notify() resolves to (default 'shown'). */
    focus,
    /** The window comes to the front. */
    focusWindow() { focus.window = true; w.dispatchEvent(new w.Event('focus')); },
    flushFrames() { const q = frames; frames = []; q.forEach((f) => f(0)); },
  };
}

/**
 * Bundles the renderer entry (src/renderer/index.ts) without its boot code and
 * imports it, exposing its module state as `__test`. xterm is stubbed; the
 * caller sets up a DOM (document, window, …) before calling this.
 * `realXterm`: the terminal is the real xterm, never opened into the page — it
 * parses what is written to it and has a screen buffer, which is all a test
 * of what a session's output does needs.
 */
export async function loadIndex({ realXterm = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vr-chat-index-'));
  dirs.push(dir);
  const outfile = join(dir, 'index.mjs');
  let source = readFileSync('src/renderer/index.ts', 'utf8');
  const cut = source.indexOf('const boot =');
  if (cut < 0) throw new Error('index.ts: boot marker not found');
  source = source.slice(0, cut) + `
export const __test = {
  views, machineSessions, machineOnline, machineTrees, machineCaps, machineProjects, rests, ChatView, removingWorktrees, reloadingSessions,
  get activeKey() { return activeKey; },
  setMachines(list: MachineConfig[]) { machines = list; },
  showMachineOverview, applyViewActivity, renderSidebar, openChatSession, openSession, rebuildRests, setActive, refreshAllMachines, pollMachines,
  toggleLocale, wireLanguageToggle,
};
`;
  const stub = {
    name: 'stub-xterm',
    setup(b) {
      b.onResolve({ filter: /^@xterm\// }, (args) => ({ path: args.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: args.path.endsWith('.css')
          ? ''
          : realXterm
            ? `import { createRequire } from 'node:module';
               const { Terminal: Real } = createRequire(${JSON.stringify(pathToFileURL(join(process.cwd(), 'package.json')).href)})('@xterm/xterm');
               export class Terminal extends Real { constructor(o) { super({ ...o, cols: 80, rows: 24 }); } open() {} focus() {} attachCustomKeyEventHandler() {} }
               export class FitAddon { activate() {} dispose() {} fit() {} proposeDimensions() { return undefined; } }`
          : `export class Terminal { constructor() { this.cols = 80; this.rows = 24; }
               open() {} loadAddon() {} onData() {} onResize() {} write() {} clear() {} focus() {} dispose() {}
               attachCustomKeyEventHandler() {} hasSelection() { return false; } getSelection() { return ''; } }
             export class FitAddon { fit() {} proposeDimensions() { return undefined; } }`,
        loader: 'js',
      }));
    },
  };
  await build({
    stdin: { contents: source, loader: 'ts', resolveDir: 'src/renderer', sourcefile: 'index.ts' },
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['node:module'],
    plugins: [stub],
    logLevel: 'silent',
  });
  return (await import(pathToFileURL(outfile).href)).__test;
}

/** Returns a `test(name, fn)` that runs synchronously-or-async cases under `prefix`. */
export function runner(prefix) {
  const cases = [];
  const test = (name, fn) => cases.push({ name, fn });
  const run = async () => {
    for (const { name, fn } of cases) {
      try {
        await fn();
      } catch (e) {
        console.error(`FAIL: ${prefix}: ${name}`);
        console.error(e);
        process.exit(1);
      }
      console.log(`ok - ${prefix}: ${name}`);
    }
    console.log(`${prefix} checks passed (${cases.length})`);
  };
  return { test, run };
}
