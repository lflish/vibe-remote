// Regression check: the new-session dialog (directory picker) must fit short
// windows. Its sections used to be direct children of .modal and could not
// shrink, so in a window under ~1090px high the launch options and the
// Cancel / Open here buttons were clipped out of the dialog and unreachable.
//
// The picker now keeps only header, body and footer in .modal; the body
// (.modal-body) holds everything else and scrolls. The measured behavior is
// covered by .claude/skills/verify/scripts/picker-layout.mjs (gui-smoke); this
// guards the structure it depends on.
//
// Run with: node scripts/test-picker-layout.mjs

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const picker = readFileSync('src/renderer/dirpicker.ts', 'utf8');
const direct = [...picker.matchAll(/\bmodal\.(?:appendChild|append|prepend|insertBefore)\(([^)]*)\)/g)].map((m) => m[1].trim());
assert.deepEqual(
  direct,
  ['header', 'body', 'footer'],
  'the picker dialog must contain only header, body and footer; put new sections in the scrolling body',
);
assert.match(picker, /const body = el\('div', 'modal-body'\)/, 'the picker body must be a .modal-body');

const css = readFileSync('src/renderer/styles.css', 'utf8');
const rule = (selector) => {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `styles.css must have a ${selector} rule`);
  return m[1];
};
const body = rule('.modal-body');
assert.match(body, /overflow-y:\s*auto/, '.modal-body must scroll');
assert.match(body, /min-height:\s*0/, '.modal-body must be allowed to shrink below its content');
assert.match(rule('.modal-body > *'), /flex-shrink:\s*0/, 'picker sections must keep their height (the body scrolls instead)');
assert.match(rule('.modal-footer'), /flex:\s*none/, 'the dialog footer must never be squeezed or pushed out');
assert.match(rule('.modal-path'), /flex-shrink:\s*0/, 'the path bar must keep its height');
assert.match(rule('.modal'), /max-height:[^;]*100vh/, 'the dialog height must be capped by the window height');

console.log('picker layout regression checks passed');
