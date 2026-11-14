// Render guard for the chat UI (R3.3): model output must reach the DOM only
// through renderMarkdown(). Under src/renderer/chat/, only markdown.ts may
// write HTML strings into the DOM, and there only DOMPurify's output.
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'src/renderer/chat';
const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
assert.ok(files.includes('markdown.ts'), 'markdown.ts must exist');
assert.ok(files.length > 3, 'chat/ should contain the chat modules');

// Strip comments so prose mentioning these names does not count.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const sinks = /\b(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write\s*\(|createContextualFragment|DOMParser/;

for (const f of files) {
  const src = code(readFileSync(join(dir, f), 'utf8'));
  if (f === 'markdown.ts') continue;
  const m = sinks.exec(src);
  assert.equal(m, null, `${f} uses ${m?.[0]}: only chat/markdown.ts may turn strings into markup`);
}

// markdown.ts: every innerHTML assignment takes DOMPurify.sanitize(...) output,
// and the other sinks are not used at all.
const md = code(readFileSync(join(dir, 'markdown.ts'), 'utf8'));
const assigns = [...md.matchAll(/\binnerHTML\s*=([^;]*);/g)];
assert.ok(assigns.length >= 1, 'markdown.ts should set innerHTML from the sanitizer');
for (const [, rhs] of assigns) {
  assert.match(rhs.trim(), /^DOMPurify\.sanitize\(/, `innerHTML must be assigned DOMPurify.sanitize(...) directly, got: ${rhs.trim()}`);
}
assert.equal(/\b(outerHTML|insertAdjacentHTML)\b|document\.write\s*\(/.exec(md), null, 'markdown.ts must not use other HTML sinks');
// html:false is the first layer of defence: raw HTML in markdown stays text.
assert.match(md, /html:\s*false/, 'markdown-it must be created with html: false');

console.log(`chat render guard passed (${files.length} files)`);
