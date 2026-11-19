// Layout checks for the shell around the sessions (row menus, the toolbar
// title, the note under a launch option), shared by the GUI smoke scripts.
// They run in the smallest window the app allows, 800×500, where these are
// the first things to stop fitting; jsdom has no layout, so only the running
// app can show it. The window size is emulated: the real window is left alone.
//
// Each function takes a `cdp` with send() and evaluate() and returns
// { problems, ... }: `problems` is empty when the check passes, the other
// fields say what was actually measured.

export const MIN_WINDOW = { width: 800, height: 500 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` with the page laid out as a `size` window, then puts the real size back. */
export async function atWindowSize(cdp, size, fn) {
  const original = await cdp.evaluate('({ width: innerWidth, height: innerHeight })');
  const settle = async (want) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const now = await cdp.evaluate('({ width: innerWidth, height: innerHeight })');
      if (now.width === want.width && now.height === want.height) return true;
      await sleep(50);
    }
    return false;
  };
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
    if (!(await settle(size))) return { problems: [`the window did not become ${size.width}×${size.height}`] };
    // Let the sidebar and the terminal settle into the new size.
    await sleep(250);
    return await fn();
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await settle(original);
  }
}

// Opens the menu of one row with the row at the bottom edge of the sidebar's
// visible part (the worst place for a menu that opens downwards) and measures
// it. `kind` is 'project' or 'worktree'; the last row of that kind that has a
// menu button is used.
const OPEN_ROW_MENU = (kind) => `(() => {
  const px = (n) => Math.round(n * 10) / 10;
  const testid = ${JSON.stringify(kind === 'project' ? 'project-menu' : 'worktree-menu')};
  const buttons = [...document.querySelectorAll('#machine-list [data-testid="' + testid + '"]')].filter((b) => b.getClientRects().length > 0);
  const btn = buttons[buttons.length - 1];
  if (!btn) return { missing: true };
  const row = btn.closest('.project-row, .worktree-row');
  row.scrollIntoView({ block: 'end' });
  btn.click();
  const menu = document.querySelector('body > .menu');
  if (!menu) return { missing: true, why: 'the menu did not open' };
  const a = btn.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const problems = [];
  const what = ${JSON.stringify(kind)} + ' row "' + (row.querySelector('.project-name, .worktree-label')?.textContent ?? '') + '"';
  if (m.top < -0.5 || m.left < -0.5 || m.bottom > innerHeight + 0.5 || m.right > innerWidth + 0.5) {
    problems.push(what + ': menu ' + px(m.left) + ',' + px(m.top) + '..' + px(m.right) + ',' + px(m.bottom) + ' leaves the ' + innerWidth + '×' + innerHeight + ' window');
  }
  const items = [...menu.querySelectorAll('.menu-item')];
  if (items.length === 0) problems.push(what + ': the menu has no items');
  for (const item of items) {
    const r = item.getBoundingClientRect();
    const inside = r.top >= -0.5 && r.left >= -0.5 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
    const hit = inside ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    if (!inside) problems.push(what + ': menu item "' + item.textContent + '" ' + px(r.top) + '..' + px(r.bottom) + ' is outside the ' + innerHeight + 'px-high window');
    else if (!hit || !item.contains(hit)) problems.push(what + ': menu item "' + item.textContent + '" cannot be clicked: its center hits ' + (hit ? '<' + hit.tagName.toLowerCase() + ' class="' + hit.className + '">' : 'nothing'));
  }
  // The menu belongs to its button: right above or right below it.
  if (m.top < a.bottom - 0.5 && m.bottom > a.top + 0.5) problems.push(what + ': the menu covers its own button');
  return { problems, what, anchorBottom: px(a.bottom), menu: [px(m.top), px(m.bottom)], window: [innerWidth, innerHeight] };
})()`;

const CLOSE_MENU = `(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const list = document.querySelector('#machine-list');
  let e = list; while (e && e.scrollHeight <= e.clientHeight + 1) e = e.parentElement;
  if (e) e.scrollTop = 0;
  return !document.querySelector('body > .menu');
})()`;

/**
 * Opens the "more" menu of the last project row and of the last worktree row
 * that have one, each with its row scrolled to the bottom of the sidebar, in
 * an 800×500 window. Every menu item has to be inside the window and take a
 * click at its center. `measured` lists what was opened and where;
 * `nearBottom` counts the menus whose button sat within 60px of the window's
 * bottom edge — 0 means the sidebar was too short to exercise anything.
 */
export async function rowMenuLayout(cdp, size = MIN_WINDOW) {
  return atWindowSize(cdp, size, async () => {
    const problems = [];
    const measured = [];
    let nearBottom = 0;
    for (const kind of ['project', 'worktree']) {
      const r = await cdp.evaluate(OPEN_ROW_MENU(kind));
      if (r.missing) {
        problems.push(`no ${kind} row with a menu to open${r.why ? `: ${r.why}` : ''}`);
      } else {
        problems.push(...r.problems);
        measured.push(`${r.what}: button bottom ${r.anchorBottom}, menu ${r.menu[0]}..${r.menu[1]} in ${r.window[0]}×${r.window[1]}`);
        if (r.anchorBottom > r.window[1] - 60) nearBottom++;
      }
      if (!(await cdp.evaluate(CLOSE_MENU))) problems.push(`the ${kind} menu did not close on Escape`);
    }
    return { problems, measured, nearBottom };
  });
}

const TITLE = `(() => {
  const px = (n) => Math.round(n * 10) / 10;
  const title = document.querySelector('#toolbar-title');
  const part = (id) => title?.querySelector('[data-testid="' + id + '"]');
  const project = part('title-project');
  const branch = part('title-branch');
  const session = part('title-session');
  if (!title || !project || !session) return { problems: ['the toolbar title has no project / session parts'] };
  const problems = [];
  const cut = (el) => el.scrollWidth > el.clientWidth + 1;
  const em = parseFloat(getComputedStyle(title).fontSize);
  const t = title.getBoundingClientRect();
  for (const [label, el] of [['project', project], ['branch', branch], ['session name', session]]) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) problems.push(label + ' has no visible width');
    if (r.left < t.left - 0.75 || r.right > t.right + 0.75) problems.push(label + ' ' + px(r.left) + '..' + px(r.right) + ' leaves the title ' + px(t.left) + '..' + px(t.right));
    if (cut(el) && getComputedStyle(el).textOverflow !== 'ellipsis') problems.push(label + ' is cut off without an ellipsis');
  }
  // The session name is the part that reads: the branch gives way first. A cut
  // session name is fine only once the branch is down to its minimum.
  const branchMin = 3 * em + 1;
  if (branch && cut(session) && branch.clientWidth > branchMin) {
    problems.push('session name shows ' + session.clientWidth + ' of ' + session.scrollWidth + 'px while the branch still takes ' + branch.clientWidth + 'px (it can go down to ' + px(branchMin) + 'px)');
  }
  const status = document.querySelector('#toolbar-status')?.getBoundingClientRect();
  if (status && t.right > status.left + 0.75) problems.push('the title ' + px(t.right) + ' runs into the connection status ' + px(status.left));
  const sizes = (el) => (el ? { text: el.textContent, shown: el.clientWidth, needs: el.scrollWidth } : null);
  return { problems, project: sizes(project), branch: sizes(branch), session: sizes(session), window: [innerWidth, innerHeight] };
})()`;

/**
 * Measures the toolbar title of the session on screen in an 800×500 window:
 * project, branch and session name are all visible, inside the title and cut
 * only with an ellipsis; the session name is not cut while the branch still
 * has room to give.
 */
export async function titleLayout(cdp, size = MIN_WINDOW) {
  return atWindowSize(cdp, size, () => cdp.evaluate(TITLE));
}

const NOTE = `(() => {
  const px = (n) => Math.round(n * 10) / 10;
  const note = document.querySelector('.modal-overlay [data-testid="continue-note"]');
  const body = note?.closest('.modal-body');
  if (!note || !body) return { problems: ['the note about the continue option is not in the dialog'] };
  const n = note.getBoundingClientRect();
  const b = body.getBoundingClientRect();
  const top = Math.max(b.top, 0);
  const bottom = Math.min(b.bottom, innerHeight);
  const visible = Math.max(0, Math.min(n.bottom, bottom) - Math.max(n.top, top));
  const problems = [];
  if (visible < n.height - 0.75) problems.push('the note ' + px(n.top) + '..' + px(n.bottom) + ' shows only ' + px(visible) + ' of ' + px(n.height) + 'px in the dialog body ' + px(top) + '..' + px(bottom));
  return { problems, note: [px(n.top), px(n.bottom)], body: [px(top), px(bottom)], visible: px(visible), height: px(n.height), window: [innerWidth, innerHeight] };
})()`;

/**
 * With a new-session dialog open in an 800×500 window: ticks the launch option
 * `continue` with a real mouse click (scrolling it into view first, as a user
 * would) and measures whether the note that then appears under it can be read
 * without scrolling further.
 */
export async function continueNoteLayout(cdp, size = MIN_WINDOW) {
  return atWindowSize(cdp, size, async () => {
    const at = await cdp.evaluate(`(() => {
      const box = document.querySelector('.modal-overlay .modal-flag input[name="claude-flag-continue"]');
      if (!box) return null;
      if (box.checked) box.click();
      box.scrollIntoView({ block: 'nearest' });
      const r = box.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!at) return { problems: ['the dialog has no "continue" launch option'] };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(200);
    return cdp.evaluate(NOTE);
  });
}
