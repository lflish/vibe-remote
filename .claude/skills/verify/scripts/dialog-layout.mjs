// Layout check for whatever dialog is on screen (.modal-overlay > .modal with
// a header, a .modal-body and a .modal-footer), shared by the GUI smoke
// scripts. jsdom has no layout: only the running app can show a button pushed
// out of a short window or two texts drawn over each other.
//
// It reports:
//   - the dialog reaching past the window
//   - a footer button outside the window or the dialog, or one that does not
//     take a click at its center (document.elementFromPoint)
//   - two footer buttons, or two children of one row, drawn over each other
//   - text cut off sideways without an ellipsis, or spilling out of the dialog
//   - a body that is not the part that scrolls (the footer must stay put)
//
// Use with atWindowSize() of shell-layout.mjs for the 800×500 minimum window.

const MEASURE = `(() => {
  const EPS = 0.75;
  const px = (n) => Math.round(n * 10) / 10;
  const overlay = [...document.querySelectorAll('.modal-overlay')].pop();
  const modal = overlay?.querySelector('.modal');
  if (!modal) return { problems: ['no dialog on screen'] };
  const problems = [];
  const name = modal.dataset.testid || 'dialog';
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || el.hidden) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const m = modal.getBoundingClientRect();
  if (m.left < -EPS || m.top < -EPS || m.right > innerWidth + EPS || m.bottom > innerHeight + EPS) {
    problems.push(name + ' ' + px(m.left) + ',' + px(m.top) + '..' + px(m.right) + ',' + px(m.bottom) + ' leaves the ' + innerWidth + '×' + innerHeight + ' window');
  }
  const body = modal.querySelector('.modal-body');
  const footer = modal.querySelector('.modal-footer');
  if (!body || !footer) problems.push(name + ' has no .modal-body / .modal-footer');
  const buttons = footer ? [...footer.querySelectorAll('button')].filter(shown) : [];
  if (footer && buttons.length === 0) problems.push(name + ': no button in the footer');
  const measured = [];
  for (const b of buttons) {
    const r = b.getBoundingClientRect();
    const label = '"' + b.textContent.trim() + '"';
    measured.push(label + ' ' + px(r.left) + ',' + px(r.top) + '..' + px(r.right) + ',' + px(r.bottom));
    const inWindow = r.left >= -EPS && r.top >= -EPS && r.right <= innerWidth + EPS && r.bottom <= innerHeight + EPS;
    const inModal = r.left >= m.left - EPS && r.top >= m.top - EPS && r.right <= m.right + EPS && r.bottom <= m.bottom + EPS;
    if (!inWindow) problems.push(name + ': button ' + label + ' ' + px(r.top) + '..' + px(r.bottom) + ' is outside the ' + innerWidth + '×' + innerHeight + ' window');
    else if (!inModal) problems.push(name + ': button ' + label + ' is outside the dialog box');
    else {
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !b.contains(hit)) problems.push(name + ': button ' + label + ' does not take a click: its center hits ' + (hit ? '<' + hit.tagName.toLowerCase() + ' class="' + hit.className + '">' : 'nothing'));
    }
    if (b.scrollWidth > b.clientWidth + 1) problems.push(name + ': the text of button ' + label + ' is cut (' + b.clientWidth + ' of ' + b.scrollWidth + 'px)');
  }
  const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > EPS && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > EPS;
  // Children of one parent never cover each other (absolutely placed decorations aside).
  const what = (el) => '<' + el.tagName.toLowerCase() + (el.dataset.testid ? ' ' + el.dataset.testid : el.className ? ' .' + String(el.className).split(' ')[0] : '') + '> "' + el.textContent.trim().slice(0, 24) + '"';
  for (const parent of [modal, ...modal.querySelectorAll('*')]) {
    const kids = [...parent.children].filter((k) => shown(k) && !['absolute', 'fixed'].includes(getComputedStyle(k).position));
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        if (overlap(kids[i].getBoundingClientRect(), kids[j].getBoundingClientRect())) problems.push(name + ': ' + what(kids[i]) + ' and ' + what(kids[j]) + ' overlap');
      }
    }
  }
  // Text: cut sideways only with an ellipsis, and never drawn outside the dialog.
  for (const el of modal.querySelectorAll('*')) {
    if (!shown(el)) continue;
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
    if (!ownText) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (el.scrollWidth > el.clientWidth + 1 && cs.display !== 'inline') {
      if (cs.overflowX === 'visible') {
        if (r.left + el.scrollWidth > m.right + EPS) problems.push(name + ': ' + what(el) + ' spills ' + px(r.left + el.scrollWidth - m.right) + 'px out of the dialog');
      } else if (cs.textOverflow !== 'ellipsis' && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') {
        problems.push(name + ': ' + what(el) + ' is cut off without an ellipsis (' + el.clientWidth + ' of ' + el.scrollWidth + 'px)');
      }
    }
    if (r.left < m.left - EPS || r.right > m.right + EPS) problems.push(name + ': ' + what(el) + ' ' + px(r.left) + '..' + px(r.right) + ' is outside the dialog ' + px(m.left) + '..' + px(m.right));
  }
  // The body is the only part that scrolls; the footer sits below it, inside the dialog.
  let bodyScrolls = false;
  if (body && footer) {
    const b = body.getBoundingClientRect();
    const f = footer.getBoundingClientRect();
    bodyScrolls = body.scrollHeight > body.clientHeight + 1;
    if (bodyScrolls && !['auto', 'scroll'].includes(getComputedStyle(body).overflowY)) problems.push(name + ': the body is ' + body.scrollHeight + 'px of content in ' + body.clientHeight + 'px and does not scroll');
    if (f.top < b.bottom - EPS) problems.push(name + ': the footer ' + px(f.top) + ' starts above the end of the body ' + px(b.bottom));
    if (modal.scrollHeight > modal.clientHeight + 1) problems.push(name + ': the dialog itself scrolls (' + modal.clientHeight + ' of ' + modal.scrollHeight + 'px): the footer can be scrolled away');
  }
  return { problems, name, window: [innerWidth, innerHeight], modal: [px(m.left), px(m.top), px(m.right), px(m.bottom)], buttons: measured, bodyScrolls, lang: document.documentElement.lang };
})()`;

/**
 * Measures the dialog on screen as it is right now. `cdp` needs evaluate().
 * Returns { problems, name, window, modal, buttons, bodyScrolls, lang }:
 * `problems` is empty when the dialog passes.
 */
export function dialogLayout(cdp) {
  return cdp.evaluate(MEASURE);
}
