// Layout check for the new-session dialog (directory picker), shared by
// gui-smoke.mjs and gui-chat-smoke.mjs. Those scripts press the dialog's
// buttons with element.click(), which works even when the button is clipped
// out of the dialog; this measures whether a person could reach it.
//
// The window height is emulated (the real window is left alone): the dialog
// must fit from the app's minimum window height (500) up.

export const PICKER_HEIGHTS = [500, 700, 803];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MEASURE = `(() => {
  const modal = document.querySelector('.modal');
  const btn = modal?.querySelector('.modal-footer .btn-primary');
  const path = modal?.querySelector('.modal-path');
  if (!modal || !btn || !path) return ['the picker is not open'];
  const px = (n) => Math.round(n * 10) / 10;
  const m = modal.getBoundingClientRect();
  const b = btn.getBoundingClientRect();
  const inside = (o) => b.top >= o.top - 0.5 && b.bottom <= o.bottom + 0.5 && b.left >= o.left - 0.5 && b.right <= o.right + 0.5;
  const problems = [];
  if (m.top < -0.5 || m.bottom > innerHeight + 0.5) problems.push('dialog ' + px(m.top) + '..' + px(m.bottom) + ' does not fit the ' + innerHeight + 'px window');
  if (modal.scrollHeight > modal.clientHeight + 1) problems.push('dialog content clipped: ' + modal.scrollHeight + 'px in ' + modal.clientHeight + 'px');
  if (!inside(m)) problems.push('primary button ' + px(b.top) + '..' + px(b.bottom) + ' outside the dialog ' + px(m.top) + '..' + px(m.bottom));
  if (!inside({ top: 0, left: 0, right: innerWidth, bottom: innerHeight })) problems.push('primary button ' + px(b.top) + '..' + px(b.bottom) + ' outside the ' + innerHeight + 'px window');
  const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  if (!hit || !btn.contains(hit)) problems.push('primary button not clickable: its center hits ' + (hit ? '<' + hit.tagName.toLowerCase() + ' class="' + hit.className + '">' : 'nothing'));
  if (path.clientHeight < path.scrollHeight) problems.push('path bar squeezed to ' + path.clientHeight + 'px of ' + path.scrollHeight + 'px');
  return problems;
})()`;

/**
 * Measures the open picker at each window height. `cdp` needs send() and
 * evaluate(). Returns [{ height, problems }]; an empty `problems` means the
 * primary button is inside the dialog and the window and takes a click at its
 * center, the path bar is not squeezed, and nothing in the dialog is cut off.
 */
export async function pickerLayout(cdp, heights = PICKER_HEIGHTS) {
  const original = await cdp.evaluate('innerHeight');
  const settle = async (want) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await cdp.evaluate('innerHeight')) === want) return true;
      await sleep(50);
    }
    return false;
  };
  const out = [];
  try {
    for (const height of heights) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height, deviceScaleFactor: 0, mobile: false });
      const problems = (await settle(height)) ? await cdp.evaluate(MEASURE) : [`window height did not become ${height}px`];
      out.push({ height, problems });
    }
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await settle(original);
  }
  return out;
}
