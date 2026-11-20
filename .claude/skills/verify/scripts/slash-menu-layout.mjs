// Layout check for the slash command menu of a chat session (the list that
// opens on "/" in the chat input), used by gui-chat-smoke.mjs.
//
// Real command lists are long: plugin skills have names such as
// "posthog:signals-scout-customer-analytics-billing-and-usage" and
// descriptions of several sentences. Each row must stay readable: the name on
// one line (cut with an ellipsis, never wrapped or drawn over other text), the
// description below it on at most two lines, nothing outside the row, the menu
// inside the window.
//
// The window size is emulated (the real window is left alone), from the app's
// minimum window size (800x500) up.

export const SLASH_MENU_SIZES = [{ width: 800, height: 500 }, { width: 1280, height: 800 }];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MEASURE = `(() => {
  const menu = [...document.querySelectorAll('[data-testid="chat-slash-menu"]')].find((m) => !m.hidden && m.getClientRects().length);
  if (!menu) return { problems: ['the slash menu is not open'] };
  const px = (n) => Math.round(n * 10) / 10;
  const m = menu.getBoundingClientRect();
  const view = menu.closest('.chat-instance').getBoundingClientRect();
  const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  const problems = [];
  if (m.top < Math.max(0, view.top) - 0.5 || m.bottom > Math.min(innerHeight, view.bottom) + 0.5 || m.left < Math.max(0, view.left) - 0.5 || m.right > Math.min(innerWidth, view.right) + 0.5) {
    problems.push('menu ' + px(m.left) + ',' + px(m.top) + '..' + px(m.right) + ',' + px(m.bottom) + ' does not fit the chat view ' + px(view.left) + ',' + px(view.top) + '..' + px(view.right) + ',' + px(view.bottom) + ' of the ' + innerWidth + 'x' + innerHeight + ' window');
  }
  if (menu.scrollWidth > menu.clientWidth + 1) problems.push('menu scrolls sideways: ' + menu.scrollWidth + 'px in ' + menu.clientWidth + 'px');
  const items = [...menu.querySelectorAll('[data-testid="chat-slash-item"]')];
  let described = 0;
  for (const item of items) {
    const name = item.querySelector('.cmd');
    const desc = [...item.querySelectorAll('small')].find((d) => d.textContent);
    const full = name.textContent;
    const label = full.length > 30 ? full.slice(0, 29) + '…' : full;
    const bad = (what) => problems.push(label + ': ' + what);
    const row = item.getBoundingClientRect();
    const n = name.getBoundingClientRect();
    const ns = getComputedStyle(name);
    const range = document.createRange();
    range.selectNodeContents(name);
    const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
    const text = range.getBoundingClientRect();
    // What is painted: the text, cut to the name's box unless it may overflow it.
    const ink = ns.overflowX === 'visible' ? text : { left: Math.max(text.left, n.left), right: Math.min(text.right, n.right), top: Math.max(text.top, n.top), bottom: Math.min(text.bottom, n.bottom) };
    if (lines !== 1) bad('name wraps onto ' + lines + ' lines');
    if (n.height > parseFloat(ns.fontSize) * 1.6) bad('name is ' + px(n.height) + 'px high, more than one line of ' + ns.fontSize + ' text');
    if (ink.right > row.right + 0.5 || ink.left < row.left - 0.5) bad('name is drawn outside its row (' + px(ink.left) + '..' + px(ink.right) + ' in ' + px(row.left) + '..' + px(row.right) + ')');
    if (row.left < m.left - 0.5 || row.right > m.right + 0.5) bad('row ' + px(row.left) + '..' + px(row.right) + ' outside the menu ' + px(m.left) + '..' + px(m.right));
    if (name.scrollWidth > name.clientWidth + 1 && name.title !== full) bad('name is cut but has no title with the full name');
    if (!desc) {
      const s = getComputedStyle(item);
      if (row.height > n.height + parseFloat(s.paddingTop) + parseFloat(s.paddingBottom) + 1) bad('row without a description is ' + px(row.height) + 'px high for a ' + px(n.height) + 'px name');
      continue;
    }
    described++;
    const d = desc.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(desc).lineHeight);
    const cut = desc.scrollWidth > desc.clientWidth + 1 || desc.scrollHeight > desc.clientHeight + 1;
    if (overlap(ink, d)) bad('name is drawn over the description (name ' + px(ink.left) + '..' + px(ink.right) + ', description from ' + px(d.left) + ')');
    if (d.top < n.bottom - 0.5 || Math.abs(d.left - n.left) > 1) bad('description is not below the name');
    if (d.right > row.right + 0.5 || d.left < row.left - 0.5) bad('description ' + px(d.left) + '..' + px(d.right) + ' outside its row ' + px(row.left) + '..' + px(row.right));
    if (d.height > lineHeight * 2 + 1) bad('description is ' + px(d.height) + 'px high, more than 2 lines');
    if (cut && d.height < lineHeight * 2 - 1) bad('description is cut after one line');
    if (cut && desc.title !== desc.textContent) bad('description is cut but has no title with the full text');
  }
  const whole = items.filter((i) => { const r = i.getBoundingClientRect(); return r.top >= m.top - 0.5 && r.bottom <= m.bottom + 0.5; }).length;
  if (items.length > 3 && whole < 3) problems.push('only ' + whole + ' of ' + items.length + ' rows fit in the menu');
  return { problems, menu: px(m.width) + 'x' + px(m.height), rows: items.length, described, whole };
})()`;

/**
 * Measures the open slash menu at each window size. `cdp` needs send() and
 * evaluate(). `at(size)` runs while that size is emulated, after the
 * measurement (screenshots, key presses). Returns
 * [{ size, problems, menu, rows, described, whole }]; an empty `problems`
 * means every row is laid out as described at the top of this file.
 */
export async function slashMenuLayout(cdp, { sizes = SLASH_MENU_SIZES, at } = {}) {
  const original = await cdp.evaluate('({ width: innerWidth, height: innerHeight })');
  const settle = async (want) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await cdp.evaluate(`innerWidth === ${want.width} && innerHeight === ${want.height}`)) return true;
      await sleep(50);
    }
    return false;
  };
  const out = [];
  try {
    for (const size of sizes) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 0, mobile: false });
      const measured = (await settle(size)) ? await cdp.evaluate(MEASURE) : { problems: [`window did not become ${size.width}x${size.height}`] };
      out.push({ size, ...measured });
      if (at) await at(size);
    }
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await settle(original);
  }
  return out;
}
