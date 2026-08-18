// Regression checks for macOS terminal clipboard shortcuts.
// Run with: node scripts/test-terminal-clipboard.mjs

import { strict as assert } from 'node:assert';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vr-terminal-clipboard-'));
const bundle = join(dir, 'clipboard.mjs');
await build({
  entryPoints: ['src/renderer/terminal-clipboard.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
});
const { attachMacClipboardShortcuts } = await import(bundle);

const key = (overrides = {}) => ({ type: 'keydown', key: 'c', metaKey: true, altKey: false, ...overrides });
const setup = ({ selection = 'selected output', clipboard = 'pasted input', read = null, write = null } = {}) => {
  let handler;
  let currentSelection = selection;
  const pasted = [];
  const writes = [];
  const diagnostics = [];
  const listeners = new Map();
  const terminal = {
    element: {
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
    hasSelection: () => currentSelection !== '',
    getSelection: () => currentSelection,
    paste: (text) => pasted.push(text),
    attachCustomKeyEventHandler: (value) => { handler = value; },
    dispatch: (type, event) => listeners.get(type)?.(event),
  };
  const bridge = {
    readClipboardText: read || (async () => clipboard),
    writeClipboardText: write || (async (text) => { writes.push(text); return true; }),
  };
  const errors = [];
  attachMacClipboardShortcuts(terminal, bridge, (error) => errors.push(error), (operation, details) => diagnostics.push({ operation, details }));
  return { handler, pasted, writes, errors, diagnostics, dispatch: (type, event) => terminal.dispatch(type, event), setSelection: (value) => { currentSelection = value; } };
};

{
  const state = setup();
  const event = { preventDefault: () => {}, stopImmediatePropagation: () => {} };
  state.dispatch('copy', event);
  await Promise.resolve();
  assert.deepEqual(state.writes, ['selected output'], 'native copy event must write selected terminal text');

  const unicode = '第一行\n第二行 😀';
  state.setSelection(unicode);
  assert.equal(state.handler(key()), false);
  await Promise.resolve();
  assert.equal(state.writes.at(-1), unicode);
  assert.equal(state.diagnostics.at(-1).details.utf8Length, new TextEncoder().encode(unicode).length);
}

{
  const state = setup({ selection: '' });
  const event = { preventDefault: () => { throw new Error('must not prevent empty copy'); }, stopImmediatePropagation: () => {} };
  state.dispatch('copy', event);
  await Promise.resolve();
  assert.deepEqual(state.writes, []);
}

{
  const state = setup({ selection: '' });
  assert.equal(state.handler(key()), true, '⌘C without selection must preserve terminal behavior');
  assert.deepEqual(state.writes, []);
}

{
  const state = setup();
  assert.equal(state.handler(key({ key: 'v' })), false, '⌘V must consume the shortcut');
  await Promise.resolve();
  assert.deepEqual(state.pasted, ['pasted input']);

  const longText = `${'x'.repeat(12000)}\n第二行 😀`;
  const longState = setup({ clipboard: longText });
  assert.equal(longState.handler(key({ key: 'v' })), false);
  await Promise.resolve();
  assert.equal(longState.pasted[0], longText);
  assert.equal(longState.diagnostics[0].details.utf8Length, new TextEncoder().encode(longText).length);
}

for (const event of [
  { type: 'keyup', key: 'c', metaKey: true, altKey: false },
  { type: 'keydown', key: 'c', metaKey: false, altKey: false },
  { type: 'keydown', key: 'c', metaKey: true, altKey: true },
  { type: 'keydown', key: 'x', metaKey: true, altKey: false },
]) {
  const state = setup();
  assert.equal(state.handler(event), true, `event should preserve default handling: ${JSON.stringify(event)}`);
}

{
  const failure = new Error('clipboard unavailable');
  const state = setup({ write: async () => { throw failure; } });
  state.handler(key());
  await Promise.resolve();
  assert.deepEqual(state.errors, [failure], 'write errors must be reported');
}

{
  const failure = new Error('clipboard unavailable');
  const state = setup({ read: async () => { throw failure; } });
  state.handler(key({ key: 'v' }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(state.errors.length, 1, 'read errors must be reported');
  assert.equal(state.errors[0], failure);
}

console.log('terminal clipboard regression checks passed');
