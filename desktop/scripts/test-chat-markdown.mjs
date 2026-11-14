// chat/markdown.ts on a real DOM: markdown-it (html:false) → DOMPurify on a
// jsdom window. Checks the GFM output, that raw HTML / scripts / javascript:
// links from the model never become live markup (R3.3), and that links are
// intercepted for the system browser and code blocks get a copy button (R3.2).
//
// DOMPurify needs a DOM; without one it returns its input unsanitized and
// isSupported is false — asserted first so this test cannot pass vacuously.
import { strict as assert } from 'node:assert';
import { JSDOM } from 'jsdom';
import { load, runner } from './chat-test-util.mjs';

const { createMarkdownRenderer, purifierFor } = await load('src/renderer/chat/markdown.ts', { platform: 'browser' });
const { test, run } = runner('test-chat-markdown');

const { window } = new JSDOM('<!DOCTYPE html><body></body>');
const opened = [];
const copied = [];
const render = createMarkdownRenderer(window, {
  openExternal: (url) => opened.push(url),
  copy: (text) => copied.push(text),
  copyLabel: 'Copy',
  copiedLabel: 'Copied',
});
const html = (md) => {
  const div = window.document.createElement('div');
  div.appendChild(render(md));
  return div;
};

test('DOMPurify runs on the injected window', () => {
  assert.equal(purifierFor(window).isSupported, true);
});

test('gfm', () => {
  const d = html([
    '# Title',
    '## Sub',
    '- one',
    '- two',
    '',
    '1. first',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    'inline `code` here',
    '',
    '```go',
    'func main() {}',
    '```',
  ].join('\n'));
  assert.ok(d.querySelector('h1'));
  assert.equal(d.querySelector('h1').textContent, 'Title');
  assert.ok(d.querySelector('h2'));
  assert.equal(d.querySelectorAll('ul > li').length, 2);
  assert.ok(d.querySelector('ol > li'));
  assert.ok(d.querySelector('table thead th'));
  assert.equal(d.querySelectorAll('table tbody td').length, 2);
  assert.equal(d.querySelector('p code').textContent, 'code');
  const pre = d.querySelector('pre code');
  assert.ok(pre, 'code block');
  assert.equal(pre.textContent, 'func main() {}\n');
  assert.ok(pre.classList.contains('language-go'));
});

test('code block copy button', () => {
  const d = html('```\nnpm test\n```');
  const block = d.querySelector('.cb');
  assert.ok(block, 'code block wrapped with a header');
  const btn = block.querySelector('button.cb-copy');
  assert.equal(btn.textContent, 'Copy');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(copied, ['npm test\n']);
});

test('raw html escaped', () => {
  const d = html([
    'before <script>alert(1)</script> after',
    '',
    '<img src=x onerror=alert(1)>',
    '',
    '<b onclick="alert(1)">bold?</b>',
    '',
    '[x](javascript:alert(1)) [v](vbscript:msgbox) [d](data:text/html,<script>alert(1)</script>)',
  ].join('\n'));
  assert.equal(d.querySelector('script'), null, 'no script element');
  assert.equal(d.querySelector('img'), null, 'no img element from raw HTML');
  assert.equal(d.querySelector('b'), null, 'raw tags are not markup');
  for (const el of d.querySelectorAll('*')) {
    for (const attr of el.attributes) assert.ok(!/^on/i.test(attr.name), `event handler attribute ${attr.name}`);
  }
  assert.ok(d.textContent.includes('<script>alert(1)</script>'), 'script shows as text');
  assert.ok(d.textContent.includes('<img src=x onerror=alert(1)>'), 'img shows as text');
  for (const a of d.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? '';
    assert.ok(!/^(javascript|vbscript|data):/i.test(href), `dangerous href ${href}`);
  }
  assert.equal(d.querySelectorAll('a[href^="javascript:"]').length, 0);
});

test('sanitizer drops what markdown-it might let through', () => {
  // Second layer on its own: even markup that reached the sanitizer loses
  // scripts, handlers, styles and non-http(s)/mailto URLs.
  const purify = purifierFor(window);
  const out = purify.sanitize('<a href="javascript:alert(1)" style="x" onclick="y">l</a><script>1</script><img src="https://e.x/a.png" onerror="z"><a href="https://ok.example/">ok</a>', { ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i, FORBID_ATTR: ['style'] });
  assert.ok(!/script|onclick|onerror|style=|javascript:/i.test(out), out);
  assert.ok(out.includes('href="https://ok.example/"'));
});

test('links get no target and are intercepted', () => {
  const d = html('see [ok](https://example.com/x) and https://linkified.example and [m](mailto:a@b.c)');
  const links = [...d.querySelectorAll('a')];
  assert.equal(links.length, 3);
  for (const a of links) {
    assert.equal(a.getAttribute('target'), null);
    assert.equal(a.dataset.external, '1');
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  }
  const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  links[0].dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true, 'no in-app navigation');
  links[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(opened, ['https://example.com/x', 'https://linkified.example']);
});

await run();
