// Shared helpers for the chat test scripts: bundle a TS entry with esbuild and
// import it, plus a tiny named-case runner that prints `ok - <name>` and exits
// non-zero on the first failure. No test framework.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
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
