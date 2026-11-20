// The only place in chat/ that turns a string into markup (R3.3, design 7).
// Model output → markdown-it with html:false (raw HTML stays text; its
// validateLink drops javascript:/vbscript:/file:/data: links) → DOMPurify
// (second layer: only http(s)/mailto URLs, no style or on* attributes) →
// DOM fragment. Links are then intercepted and opened in the system browser
// via the main process; code blocks get a copy button. The window is
// injectable so Node tests can run DOMPurify on a jsdom window.

import MarkdownIt from 'markdown-it';
import createDOMPurify, { type Config, type DOMPurify as Purifier } from 'dompurify';

export interface MarkdownOptions {
  /** Opens a link outside the app (main process `open-external`). */
  openExternal?: (url: string) => void;
  /** Writes a code block's text to the clipboard. */
  copy?: (text: string) => void | Promise<unknown>;
  copyLabel?: string;
  copiedLabel?: string;
}

const PURIFY_CONFIG: Config = {
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  FORBID_ATTR: ['style'],
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
};

const purifiers = new WeakMap<object, Purifier>();

/** The DOMPurify instance bound to `win` (one per window). */
export function purifierFor(win: globalThis.Window): Purifier {
  let p = purifiers.get(win);
  if (!p) {
    p = createDOMPurify(win as unknown as Parameters<typeof createDOMPurify>[0]);
    purifiers.set(win, p);
  }
  return p;
}

function defaultOpenExternal(url: string) {
  void window.vibeRemote?.openExternal(url);
}

function defaultCopy(text: string) {
  return window.vibeRemote?.writeClipboardText(text);
}

/** Returns renderMarkdown(text) → DocumentFragment for `win`. */
export function createMarkdownRenderer(win: globalThis.Window = window, opts: MarkdownOptions = {}) {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
  const DOMPurify = purifierFor(win);
  const doc = win.document;
  const openExternal = opts.openExternal ?? defaultOpenExternal;
  const copy = opts.copy ?? defaultCopy;
  const copyLabel = opts.copyLabel ?? 'Copy';
  const copiedLabel = opts.copiedLabel ?? copyLabel;

  return function renderMarkdown(text: string): DocumentFragment {
    const template = doc.createElement('template');
    template.innerHTML = DOMPurify.sanitize(md.render(text), { ...PURIFY_CONFIG, RETURN_TRUSTED_TYPE: false }) as string;
    const frag = template.content;

    for (const a of frag.querySelectorAll('a')) {
      a.removeAttribute('target');
      a.setAttribute('rel', 'noopener noreferrer');
      a.dataset.external = '1';
      a.addEventListener('click', (e) => {
        // Never navigate inside the app window; hand http(s)/mailto to the OS.
        e.preventDefault();
        const href = a.getAttribute('href');
        if (href) openExternal(href);
      });
    }

    for (const pre of frag.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      const lang = [...(code?.classList ?? [])].find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? '';
      const block = doc.createElement('div');
      block.className = 'cb';
      const head = doc.createElement('div');
      head.className = 'cb-h';
      const label = doc.createElement('span');
      label.textContent = lang;
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'cb-copy';
      btn.textContent = copyLabel;
      btn.addEventListener('click', () => {
        void Promise.resolve(copy(code?.textContent ?? pre.textContent ?? '')).then(() => {
          btn.textContent = copiedLabel;
          win.setTimeout(() => (btn.textContent = copyLabel), 1500);
        });
      });
      head.append(label, btn);
      pre.replaceWith(block);
      block.append(head, pre);
    }
    return frag;
  };
}
