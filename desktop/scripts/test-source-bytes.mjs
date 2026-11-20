// Source files under desktop/src must not contain raw NUL bytes. grep (and
// most code search) treats a file with one as binary and silently skips its
// contents — chat/prompts.ts once carried the "other" option's sentinel as a
// literal 0x00 instead of the escape '\0other', and searches missed the file.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else yield p;
  }
}

const bad = [];
let checked = 0;
for (const p of files('src')) {
  const buf = readFileSync(p);
  checked++;
  let at = buf.indexOf(0);
  while (at >= 0) {
    bad.push(`${p}:${buf.subarray(0, at).toString('latin1').split('\n').length}`);
    at = buf.indexOf(0, at + 1);
  }
}
if (bad.length) {
  console.error(`FAIL: raw NUL byte in source (write it as an escape, e.g. '\\0'):\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
if (checked === 0) {
  console.error('FAIL: no files under src/ (run from desktop/)');
  process.exit(1);
}
console.log(`source bytes check passed (${checked} files, no NUL)`);
