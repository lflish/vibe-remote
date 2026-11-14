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
 * window reports focus. Rendering frames are queued (`flushFrames`).
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
  for (const k of ['window', 'document', 'localStorage', 'location', 'HTMLElement', 'HTMLDetailsElement', 'Node', 'MouseEvent', 'KeyboardEvent', 'Event']) {
    Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });
  Object.defineProperty(w.document, 'hasFocus', { value: () => true });
  let frames = [];
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  const notifications = [];
  w.vibeRemote = {
    onNotificationClick() {},
    notify(title, body, tag) { notifications.push({ title, body, tag }); return Promise.resolve('shown'); },
    openExternal: async () => true,
    writeClipboardText: async () => true,
  };
  return {
    dom,
    notifications,
    flushFrames() { const q = frames; frames = []; q.forEach((f) => f(0)); },
  };
}

/**
 * Bundles the renderer entry (src/renderer/index.ts) without its boot code and
 * imports it, exposing its module state as `__test`. xterm is stubbed; the
 * caller sets up a DOM (document, window, …) before calling this.
 */
export async function loadIndex() {
  const dir = mkdtempSync(join(tmpdir(), 'vr-chat-index-'));
  dirs.push(dir);
  const outfile = join(dir, 'index.mjs');
  let source = readFileSync('src/renderer/index.ts', 'utf8');
  const cut = source.indexOf('const boot =');
  if (cut < 0) throw new Error('index.ts: boot marker not found');
  source = source.slice(0, cut) + `
export const __test = {
  views, machineSessions, machineOnline,
  get activeKey() { return activeKey; },
  setMachines(list: MachineConfig[]) { machines = list; },
  showMachineOverview, applyViewActivity, renderSidebar, openChatSession, openSession, rebuildRests, setActive,
};
`;
  const stub = {
    name: 'stub-xterm',
    setup(b) {
      b.onResolve({ filter: /^@xterm\// }, (args) => ({ path: args.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: args.path.endsWith('.css')
          ? ''
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
