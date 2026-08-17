// Regression checks for the initial xterm layout timing bug.
// Run with: node scripts/test-terminal-layout.mjs

import { strict as assert } from 'node:assert';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vr-terminal-layout-'));
const bundle = join(dir, 'layout.mjs');
await build({
  entryPoints: ['src/renderer/terminal-layout.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
});
const { fitWhenVisible, dimensionsWhenVisible } = await import(bundle);

const rafQueue = [];
const scheduleFrame = (callback) => rafQueue.push(callback);
const flushFrames = () => {
  while (rafQueue.length > 0) rafQueue.shift()();
};

{
  let fits = 0;
  const hidden = { clientWidth: 0, clientHeight: 0 };
  const visible = { clientWidth: 1200, clientHeight: 800 };
  const fit = () => { fits++; };

  // A hidden xterm must not be fitted against 0×0; it should wait until the
  // element has a usable box and then fit exactly once.
  fitWhenVisible(hidden, fit, scheduleFrame);
  flushFrames();
  assert.equal(fits, 0, 'hidden terminal must not fit');

  fitWhenVisible(visible, fit, scheduleFrame);
  flushFrames();
  assert.equal(fits, 1, 'visible terminal must fit once');
}

{
  const hidden = { clientWidth: 0, clientHeight: 0 };
  assert.equal(dimensionsWhenVisible(hidden, () => ({ cols: 120, rows: 40 })), null);
  assert.deepEqual(
    dimensionsWhenVisible({ clientWidth: 1200, clientHeight: 800 }, () => ({ cols: 120, rows: 40 })),
    { cols: 120, rows: 40 },
  );
}

console.log('terminal layout regression checks passed');
