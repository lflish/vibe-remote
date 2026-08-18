// Regression check: the terminal must stay selectable while the remote app has
// mouse reporting enabled (claude does). xterm's SelectionService disables
// selection whenever `areMouseEventsActive`, so a plain drag selects nothing and
// ⌘C copies an empty string.
//
// `mouseEventsRequireAlt: true` inverts that: normal drag selects text, and
// mouse events reach the application only while Alt is held (wheel/scroll is
// unaffected). `macOptionClickForcesSelection` stays on as the fallback for the
// case where mouseEventsRequireAlt is unavailable — the former takes precedence.
//
// Run with: node scripts/test-terminal-selection.mjs

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/renderer/index.ts', 'utf8');
const start = source.indexOf('function makeTerminal(');
assert.ok(start >= 0, 'makeTerminal must exist');
const body = source.slice(start, source.indexOf('\n}', start));

assert.match(
  body,
  /mouseEventsRequireAlt:\s*true/,
  'makeTerminal must set mouseEventsRequireAlt: true so a plain drag selects text even while claude has mouse reporting on',
);

assert.match(
  body,
  /macOptionClickForcesSelection:\s*true/,
  'keep macOptionClickForcesSelection: true as the fallback selection escape hatch',
);

// Both options must exist in the pinned xterm, otherwise they silently do nothing.
const typings = readFileSync('node_modules/@xterm/xterm/typings/xterm.d.ts', 'utf8');
for (const option of ['mouseEventsRequireAlt', 'macOptionClickForcesSelection']) {
  assert.match(
    typings,
    new RegExp(`${option}\\?:\\s*boolean`),
    `pinned xterm must declare ${option}`,
  );
}

// The version carrying mouseEventsRequireAlt is a prerelease, so it must be
// pinned exactly — a floating range would silently drop the fix.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const pinned = pkg.dependencies['@xterm/xterm'];
assert.match(pinned, /^\d/, `@xterm/xterm must be pinned exactly (no ^ or ~), got "${pinned}"`);

console.log('terminal selection regression checks passed');
