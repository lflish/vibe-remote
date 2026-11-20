// Regression check: rows of the chat slash command menu must stay readable
// with real command lists (plugin skills named like
// "posthog:signals-scout-customer-analytics-billing-and-usage", descriptions
// of several sentences). Name and description used to share one line of a
// 340px menu: the name was squeezed to ~85px, wrapped at its hyphens or was
// drawn over the description, and the description was cut after a few words.
//
// A row is now the name on one line (ellipsis when too long) with the
// description below it on at most two lines. The measured behavior is covered
// by .claude/skills/verify/scripts/slash-menu-layout.mjs (gui-chat-smoke);
// this guards the CSS it depends on.
//
// Run with: node scripts/test-slash-menu-layout.mjs

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/renderer/styles.css', 'utf8');
const rule = (selector) => {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `styles.css must have a ${selector} rule`);
  return m[1];
};

const row = rule('.chat-instance .slash-menu .mi');
assert.match(row, /flex-direction:\s*column/, 'the description must sit below the command name, not beside it');

const name = rule('.chat-instance .menu .mi .cmd');
assert.match(name, /white-space:\s*nowrap/, 'a command name must never wrap');
assert.match(name, /overflow:\s*hidden/, 'a long command name must be cut, not drawn over other text');
assert.match(name, /text-overflow:\s*ellipsis/, 'a cut command name must end with an ellipsis');
assert.doesNotMatch(name, /(?:^|[;\s])(?:min-|max-)?width:/, 'the command name must take the full row width');

const desc = rule('.chat-instance .menu .mi small');
assert.match(desc, /-webkit-line-clamp:\s*2/, 'a description shows at most two lines');
assert.match(desc, /display:\s*-webkit-box/, 'line clamping needs display: -webkit-box');
assert.match(desc, /overflow:\s*hidden/, 'lines after the second must be hidden');
assert.match(desc, /overflow-wrap:\s*anywhere/, 'a description without spaces (a URL) must wrap inside the row');
assert.doesNotMatch(desc, /white-space:\s*nowrap/, 'a description must wrap onto its second line');

const menu = rule('.chat-instance .slash-menu');
assert.match(rule('.chat-instance .menu'), /max-width:\s*calc\(100% - 44px\)/, 'the menu must not be wider than the input area');
assert.match(menu, /max-height:\s*min\([^;]*100vh/, 'the menu height must be capped by the window height');

const composer = readFileSync('src/renderer/chat/composer.ts', 'utf8');
assert.match(composer, /el\('div', 'menu slash-menu'\)/, 'the slash menu must carry the .slash-menu class');

console.log('slash menu layout regression checks passed');
