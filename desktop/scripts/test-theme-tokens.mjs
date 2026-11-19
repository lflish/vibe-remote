// The M1 theme (docs/changes/2026-11-16-project-worktrees, design 7.5): every
// color in the app is a CSS variable defined in :root of styles.css. These
// cases keep the variables at their design values, keep color literals out of
// the rest of the stylesheet, and check the contrast the spec asks for (R8.4)
// from the values themselves. The terminal takes four of the variables through
// theme.ts; its 16 ANSI colors are not part of the theme (R8.2).
//
// Run with: node scripts/test-theme-tokens.mjs
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { load, runner } from './chat-test-util.mjs';

const css = readFileSync('src/renderer/styles.css', 'utf8');
const mainSource = readFileSync('src/main/index.ts', 'utf8');
const { test, run } = runner('test-theme-tokens');

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const ROOT_RE = /:root\s*\{([^}]*)\}/;

function rootVars(text) {
  const m = ROOT_RE.exec(stripComments(text));
  assert.ok(m, 'styles.css must define its variables in a :root block');
  const vars = {};
  for (const decl of m[1].split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    vars[decl.slice(0, i).trim()] = decl.slice(i + 1).trim().replace(/\s+/g, ' ');
  }
  return vars;
}
const vars = rootVars(css);
const outsideRoot = (text) => stripComments(text).replace(ROOT_RE, '');

/** All declarations of the rules whose selector list has `selector`, later rules winning. */
function decls(selector, text = css) {
  const out = {};
  let found = false;
  for (const m of outsideRoot(text).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')).includes(selector)) continue;
    found = true;
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim().replace(/\s+/g, ' ');
    }
  }
  assert.ok(found, `styles.css must have a rule for ${selector}`);
  return out;
}

// --- color math (WCAG 2.x) -------------------------------------------------
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `not a 6-digit hex color: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
}
function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
function luminance([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** color-mix(in srgb, a pct%, b) for opaque colors. */
const mix = (a, pct, b) => a.map((c, i) => Math.round(c * pct / 100 + b[i] * (1 - pct / 100)));
const color = (name, from = vars) => {
  assert.ok(from[name], `:root must define ${name}`);
  return hexToRgb(from[name]);
};
const pct = (name, from = vars) => {
  const m = /^(\d+(?:\.\d+)?)%$/.exec(from[name] ?? '');
  assert.ok(m, `:root must define ${name} as a percentage`);
  return Number(m[1]);
};

// --- design 7.5 --------------------------------------------------------------
const DESIGN = {
  '--bg-app': '#EFEFF4', '--bg-sidebar': '#EFEFF4',
  '--bg-primary': '#FFFFFF', '--bg-canvas': '#FFFFFF', '--bg-elevated': '#FFFFFF',
  '--bg-secondary': '#F6F6FA', '--bg-hover': '#E5E4EE', '--bg-selected': '#DDD7F5',
  '--text-primary': '#1C1B22', '--text-secondary': '#565365', '--text-muted': '#6A6779',
  '--accent': '#6B54D3', '--accent-hover': '#5942BF', '--accent-soft': '#E3DEF7', '--accent-softer': '#F3F0FC',
  '--on-accent': '#FFFFFF',
  '--border': '#E4E3EB', '--border-strong': '#D2D0DC',
  '--success': '#1B7F52', '--warning': '#9A5A0A', '--error': '#BB382E',
  '--dot-new': '#6F6C86', '--dot-idle': '#1A8F58', '--dot-wait': '#C2710A',
  '--diff-add-bg': '#E3F4EA', '--diff-add-fg': '#155C3A', '--diff-del-bg': '#FBE7E4', '--diff-del-fg': '#972A22',
  '--term-bg': '#FFFFFF', '--term-fg': '#1C1B22', '--term-cursor': '#6B54D3', '--term-selection': '#D9D2F4',
  '--sidebar-glow': '#C3B8EC',
  '--tag-bg-s': '62%', '--tag-bg-l': '90%', '--tag-fg-s': '48%', '--tag-fg-l': '30%',
  '--scrim': 'rgba(28, 27, 44, .24)',
  '--radius': '10px', '--radius-card': '14px', '--radius-item': '9px',
  '--sidebar-width': '284px',
  '--shadow-card': '0 1px 2px rgba(24, 20, 48, .04), 0 10px 28px rgba(24, 20, 48, .07)',
  '--shadow-lift': '0 2px 6px rgba(20, 18, 40, .08), 0 22px 54px rgba(20, 18, 40, .2)',
  '--shadow-inset': 'none',
};

test('root_values_match_design', () => {
  for (const [name, want] of Object.entries(DESIGN)) {
    assert.ok(name in vars, `:root must define ${name}`);
    assert.equal(vars[name].toLowerCase(), want.toLowerCase(), `${name} must be ${want} (design 7.5)`);
  }
});

// A color literal: a hex color, rgb()/rgba(), a named black or white, or an
// hsl()/hsla() with any number among its arguments. hsl() whose arguments are
// all var(--…) is the one allowed form (the project tag, whose hue is set per
// element and whose saturation and lightness are :root variables).
function colorLiterals(text) {
  const found = [];
  for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}(?![\w-])/g)) found.push(m[0]);
  for (const m of text.matchAll(/rgba?\([^)]*\)/g)) found.push(m[0]);
  for (const m of text.matchAll(/:[^;{}]*?(?<![\w-])(white|black)(?![\w-])/g)) found.push(m[1]);
  for (const m of text.matchAll(/hsla?\(((?:[^()]|\([^()]*\))*)\)/g)) {
    if (/\d/.test(m[1].replace(/var\(--[\w-]+\)/g, ''))) found.push(m[0]);
  }
  return found;
}

test('no_color_literals_outside_root', () => {
  // The check itself must catch what it is for.
  assert.deepEqual(colorLiterals('a { color: hsl(210 50% 40%); }'), ['hsl(210 50% 40%)']);
  assert.deepEqual(colorLiterals('a { color: hsl(var(--tag-hue) 62% 90%); }'), ['hsl(var(--tag-hue) 62% 90%)']);
  assert.deepEqual(colorLiterals('a { color: #fff; background: rgba(0, 0, 0, .2); border-color: white; white-space: nowrap; }'), ['#fff', 'rgba(0, 0, 0, .2)', 'white']);
  assert.deepEqual(colorLiterals('#app .x { color: hsl(var(--tag-hue) var(--tag-bg-s) var(--tag-bg-l)); }'), []);
  assert.deepEqual(colorLiterals(outsideRoot(css)), [], 'colors outside :root must be variables (or color-mix of variables)');
});

test('tag_contrast_all_hues', () => {
  const lowest = (fgL) => {
    let min = Infinity;
    for (let h = 0; h < 360; h++) {
      min = Math.min(min, contrast(hslToRgb(h, pct('--tag-fg-s'), fgL), hslToRgb(h, pct('--tag-bg-s'), pct('--tag-bg-l'))));
    }
    return min;
  };
  assert.deepEqual([vars['--tag-bg-s'], vars['--tag-bg-l'], vars['--tag-fg-s'], vars['--tag-fg-l']], ['62%', '90%', '48%', '30%']);
  const min = lowest(pct('--tag-fg-l'));
  assert.ok(min >= 4.5, `project tag text must reach 4.5:1 on its background at every hue, lowest is ${min.toFixed(2)}`);
  // The prototype's original lightness does not pass: the case can tell.
  assert.ok(lowest(32) < 4.5, 'a 32% lightness must fail this check');
});

// evidence/contrast-m1.txt, the 35 pairs marked ok: [what, foreground, background, minimum].
// A background written [a, pct, b] is color-mix(in srgb, a pct%, b).
const PAIRS = [
  ['body text', '--text-primary', '--bg-primary', 4.5],
  ['body text on the sidebar', '--text-primary', '--bg-sidebar', 4.5],
  ['body text on the selected row', '--text-primary', '--bg-selected', 4.5],
  ['body text on the user bubble', '--text-primary', '--accent-soft', 4.5],
  ['body text on a sunk surface', '--text-primary', '--bg-secondary', 4.5],
  ['body text on a note', '--text-primary', '--accent-softer', 4.5],
  ['body text on the darkest sidebar glow', '--text-primary', '--sidebar-glow', 4.5],
  ['body text on a warning tint', '--text-primary', ['--warning', 11, '--bg-primary'], 4.5],
  ['body text on a danger tint', '--text-primary', ['--error', 9, '--bg-primary'], 4.5],
  ['secondary text', '--text-secondary', '--bg-primary', 3],
  ['secondary text on the sidebar', '--text-secondary', '--bg-sidebar', 3],
  ['secondary text on the sidebar glow', '--text-secondary', '--sidebar-glow', 3],
  ['muted text', '--text-muted', '--bg-primary', 3],
  ['muted text on the sidebar', '--text-muted', '--bg-sidebar', 3],
  ['muted text on the selected row', '--text-muted', '--bg-selected', 3],
  ['muted text on a sunk surface', '--text-muted', '--bg-secondary', 3],
  ['primary button text', '--on-accent', '--accent', 4.5],
  ['primary button text, hover', '--on-accent', '--accent-hover', 4.5],
  ['danger button text', '--on-accent', '--error', 4.5],
  ['neutral button text', '--on-accent', '--text-primary', 4.5],
  ['outlined danger button text', '--error', '--bg-primary', 4.5],
  ['link', '--accent', '--bg-primary', 4.5],
  ['link on the sidebar', '--accent', '--bg-sidebar', 4.5],
  ['warning text', '--warning', '--bg-primary', 4.5],
  ['warning text on the sidebar', '--warning', '--bg-sidebar', 4.5],
  ['success text on the sidebar', '--success', '--bg-sidebar', 3],
  ['diff added line', '--diff-add-fg', '--diff-add-bg', 4.5],
  ['diff removed line', '--diff-del-fg', '--diff-del-bg', 4.5],
  ['terminal text', '--term-fg', '--term-bg', 4.5],
  ['terminal text on the selection', '--term-fg', '--term-selection', 4.5],
  ['terminal cursor', '--term-cursor', '--term-bg', 3],
  ['new-output dot on the sidebar', '--dot-new', '--bg-sidebar', 3],
  ['turn-finished dot on the sidebar', '--dot-idle', '--bg-sidebar', 3],
  ['needs-you dot on the sidebar', '--dot-wait', '--bg-sidebar', 3],
  ['new-output dot on the selected row', '--dot-new', '--bg-selected', 3],
];

test('contrast_table', () => {
  assert.equal(PAIRS.length, 35);
  for (const [what, fg, bg, min] of PAIRS) {
    const back = Array.isArray(bg) ? mix(color(bg[0]), bg[1], color(bg[2])) : color(bg);
    const ratio = contrast(color(fg), back);
    assert.ok(ratio >= min, `${what}: ${fg} on ${Array.isArray(bg) ? bg.join(' ') : bg} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
  }
});

test('dot_shapes_differ', () => {
  const base = decls('.session-unread');
  assert.equal(base.width, '8px');
  assert.equal(base.height, '8px');
  assert.equal(base['border-radius'], '50%');
  const output = decls('.session-unread.output');
  const idle = decls('.session-unread.idle');
  const waiting = decls('.session-unread.waiting');
  // New output: a ring. Turn finished: a solid dot. Needs you: a solid dot with a halo.
  assert.equal(output.border, '2px solid var(--dot-new)');
  assert.equal(output.background, 'transparent');
  assert.equal(idle.background, 'var(--dot-idle)');
  assert.ok(!('box-shadow' in idle) && !('border' in idle), 'the turn-finished dot is plain');
  assert.equal(waiting.background, 'var(--dot-wait)');
  assert.match(waiting['box-shadow'] ?? '', /^0 0 0 3px /, 'the needs-you dot has a 3px halo');
  assert.ok(!('box-shadow' in base) && !('border' in base) && !('box-shadow' in output), 'only the needs-you dot has a halo');
  for (const d of [output, idle, waiting]) assert.ok(!('width' in d) && !('height' in d), 'all three dots keep the 8px size');
});

test('window_background_matches_bg_app', () => {
  const m = /backgroundColor:\s*'(#[0-9A-Fa-f]{6})'/.exec(mainSource);
  assert.ok(m, 'main/index.ts must set the window backgroundColor');
  assert.equal(m[1].toLowerCase(), vars['--bg-app'].toLowerCase(), 'the window background must equal --bg-app, or a cold start flashes');
  assert.equal(m[1].toUpperCase(), '#EFEFF4');
});

// The terminal's ANSI palette before this change (index.ts makeTerminal): it stays as it was (d14).
const ANSI_BEFORE = {
  black: '#3B3A37', red: '#C0564B', green: '#5E8C58', yellow: '#B07D2E',
  blue: '#4A72B0', magenta: '#9A5BA0', cyan: '#3E8C8C', white: '#6B6862',
  brightBlack: '#9B978E', brightRed: '#C0564B', brightGreen: '#5E8C58',
  brightYellow: '#B07D2E', brightBlue: '#4A72B0', brightMagenta: '#9A5BA0',
  brightCyan: '#3E8C8C', brightWhite: '#2B2A28',
};

async function themeInDom() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(`<!doctype html><html><head><style>:root {${ROOT_RE.exec(stripComments(css))[1]}}</style></head><body></body></html>`);
  for (const k of ['window', 'document']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
  const { terminalTheme } = await load('src/renderer/theme.ts', { platform: 'browser' });
  return { terminalTheme, root: dom.window.document.documentElement };
}

test('terminal_theme_from_css_vars', async () => {
  const { terminalTheme, root } = await themeInDom();
  const th = terminalTheme();
  assert.deepEqual([th.background, th.foreground, th.cursor, th.selectionBackground], ['#FFFFFF', '#1C1B22', '#6B54D3', '#D9D2F4']);
  // Read when called, not cached at import.
  root.style.setProperty('--term-bg', ' #101010 ');
  assert.equal(terminalTheme().background, '#101010');
  root.style.removeProperty('--term-bg');
});

test('ansi_colors_unchanged', async () => {
  const { terminalTheme } = await themeInDom();
  const th = terminalTheme();
  for (const [name, want] of Object.entries(ANSI_BEFORE)) assert.equal(th[name], want, `ANSI ${name} must stay ${want}`);
  assert.deepEqual(Object.keys(th).sort(), ['background', 'cursor', 'foreground', 'selectionBackground', ...Object.keys(ANSI_BEFORE)].sort());
});

test('index_uses_terminal_theme', () => {
  const index = readFileSync('src/renderer/index.ts', 'utf8');
  assert.match(index, /theme:\s*terminalTheme\(\)/, 'makeTerminal must take its theme from terminalTheme()');
  assert.deepEqual(colorLiterals(index.slice(index.indexOf('function makeTerminal'), index.indexOf('function openExisting'))), [], 'no colors written into makeTerminal');
});

await run();
