// Checks src/renderer/i18n.ts: the zh and en dictionaries define exactly the
// same keys and the same {placeholders} per key, English strings carry no
// full-width CJK punctuation, and the default locale follows navigator.language
// unless the user saved a choice.
//
// Runs i18n.ts through esbuild with stubbed localStorage/navigator; no test
// framework.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const fail = (msg) => {
  console.error('FAIL: ' + msg);
  process.exit(1);
};

const dir = mkdtempSync(join(tmpdir(), 'vr-i18n-parity-'));
const bundle = join(dir, 'i18n.mjs');
await build({
  entryPoints: ['src/renderer/i18n.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
});

// i18n.ts reads the saved locale and navigator.language at module load, so
// each scenario imports a fresh module instance (distinct query string).
let instance = 0;
async function loadWith({ saved, language }) {
  const store = new Map(saved ? [['vibe-remote.locale', saved]] : []);
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  Object.defineProperty(globalThis, 'navigator', { value: { language }, configurable: true, writable: true });
  return import(`${pathToFileURL(bundle).href}?i=${++instance}`);
}

const { dictionaries } = await loadWith({ language: 'en-US' });
const { zh, en } = dictionaries;

const zhKeys = Object.keys(zh);
const enKeys = Object.keys(en);
const onlyZh = zhKeys.filter((k) => !(k in en));
const onlyEn = enKeys.filter((k) => !(k in zh));
if (onlyZh.length || onlyEn.length) {
  fail(`dictionary key mismatch\n  only in zh: ${onlyZh.join(', ') || '-'}\n  only in en: ${onlyEn.join(', ') || '-'}`);
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const k of zhKeys) {
  if (placeholders(zh[k]) !== placeholders(en[k])) {
    fail(`placeholder mismatch for "${k}": zh {${placeholders(zh[k])}} vs en {${placeholders(en[k])}}`);
  }
}

// Full-width punctuation that has crept into English UI/aria strings before.
const fullWidth = /[：，。；！？（）【】“”]/;
for (const k of enKeys) {
  if (fullWidth.test(en[k])) fail(`en "${k}" contains full-width punctuation: ${en[k]}`);
}

// Default locale detection.
const cases = [
  [{ language: 'zh-CN' }, 'zh'],
  [{ language: 'zh-Hant-TW' }, 'zh'],
  [{ language: 'en-US' }, 'en'],
  [{ language: 'ja-JP' }, 'en'],
  [{ language: undefined }, 'en'],
  [{ saved: 'en', language: 'zh-CN' }, 'en'],
  [{ saved: 'zh', language: 'en-US' }, 'zh'],
];
for (const [env, want] of cases) {
  const { getLocale } = await loadWith(env);
  if (getLocale() !== want) fail(`initial locale for ${JSON.stringify(env)} = ${getLocale()}, want ${want}`);
}

rmSync(dir, { recursive: true, force: true });
console.log(`i18n parity checks passed (${zhKeys.length} keys)`);
