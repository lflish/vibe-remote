// Structure check for the app's dialogs (R8.5): a dialog puts exactly a header,
// a .modal-body and a .modal-footer into .modal. Everything else goes into the
// body, which scrolls, so in a short window the footer buttons stay inside the
// dialog (see test-picker-layout.mjs for the CSS this relies on; the measured
// behavior is in .claude/skills/verify/scripts/).
//
// Run with: node scripts/test-dialog-layout.mjs

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const SHELL = ['header', 'body', 'footer'];

for (const file of ['src/renderer/dirpicker.ts', 'src/renderer/worktree-dialogs.ts']) {
  const source = readFileSync(file, 'utf8');
  const calls = [...source.matchAll(/\bmodal\.(?:appendChild|append|prepend|insertBefore|replaceChildren)\(([^)]*)\)/g)]
    .map((m) => m[1].split(',').map((arg) => arg.trim()).filter(Boolean));
  assert.ok(calls.length > 0, `${file}: a dialog must put its parts into .modal`);
  const direct = calls.flat();
  for (const arg of direct) {
    assert.ok(SHELL.includes(arg), `${file}: .modal may only hold header, body and footer, found "${arg}"; put new sections in the scrolling body`);
  }
  // Every dialog built in the file adds all three, in order.
  assert.equal(direct.length % 3, 0, `${file}: each dialog needs header, body and footer`);
  for (let i = 0; i < direct.length; i += 3) {
    assert.deepEqual(direct.slice(i, i + 3), SHELL, `${file}: dialog parts must be header, body, footer in that order`);
  }
  assert.match(source, /'modal-body'/, `${file}: the dialog body must be a .modal-body`);
  assert.match(source, /'modal-footer'/, `${file}: the dialog footer must be a .modal-footer`);
  // No other way to put children into .modal.
  assert.doesNotMatch(source, /\bmodal\.(?:innerHTML|insertAdjacent\w+|before|after)\b/, `${file}: build .modal with append only`);
}

console.log('dialog layout structure checks passed');
