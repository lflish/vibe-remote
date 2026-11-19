// Layout check for the three-level sidebar (machine → project → worktree →
// session), shared by the GUI smoke scripts. jsdom has no layout, so the unit
// tests cannot see a name squeezed to nothing or a badge drawn over it; this
// measures the real boxes in the running app, at whatever width the sidebar has.
//
// For every visible project, worktree and session row it reports:
//   - a row or one of its parts reaching past the sidebar's edges
//   - two parts of one row drawn over each other (name, kind badge, state text,
//     state dot, branch, tags, action buttons)
//   - a session name with no visible width, or cut down to less than
//     MIN_NAME_EM characters' worth while the full name would need more
//   - a name ending in "…" while its line still has free space
//   - text that is cut off without an ellipsis

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MEASURE = `(() => {
  const MIN_NAME_EM = 4;
  const EPS = 0.75;
  const TEXT_PARTS = ['kind badge', 'state text', 'branch', 'status', 'tag'];
  const px = (n) => Math.round(n * 10) / 10;
  const sidebar = document.querySelector('#sidebar');
  const list = document.querySelector('#machine-list');
  if (!sidebar || !list) return { problems: ['the sidebar is not in the page'], rows: 0, sessions: 0, width: 0, truncated: [] };
  const edge = sidebar.getBoundingClientRect();
  const problems = [];
  const truncated = [];
  const shown = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    // Hover-only parts (opacity 0) are measured by the hover pass instead.
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const cut = (el) => el.scrollWidth > el.clientWidth + 1;
  const overlap = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > EPS && h > EPS;
  };
  // Free space on the line the element sits on, inside its flex/grid parent:
  // what is left between the siblings that share its vertical band.
  const slack = (el) => {
    const parent = el.parentElement;
    const cs = getComputedStyle(parent);
    const p = parent.getBoundingClientRect();
    const me = el.getBoundingClientRect();
    const gap = parseFloat(cs.columnGap) || 0;
    const band = [...parent.children].filter(shown).map((c) => c.getBoundingClientRect())
      .filter((r) => Math.min(r.bottom, me.bottom) - Math.max(r.top, me.top) > EPS)
      .sort((a, b) => a.left - b.left);
    if (!band.length) return 0;
    let free = Math.max(0, band[0].left - (p.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth)));
    free += Math.max(0, (p.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth)) - band[band.length - 1].right);
    for (let i = 1; i < band.length; i++) free += Math.max(0, band[i].left - band[i - 1].right - gap);
    return free;
  };

  const checkRow = (row, what, parts, names) => {
    const r = row.getBoundingClientRect();
    if (r.left < edge.left - EPS || r.right > edge.right + EPS) problems.push(what + ': row ' + px(r.left) + '..' + px(r.right) + ' leaves the sidebar ' + px(edge.left) + '..' + px(edge.right));
    const live = parts.filter(([, el]) => shown(el));
    for (const [label, el] of live) {
      const b = el.getBoundingClientRect();
      if (b.left < r.left - EPS || b.right > r.right + EPS) problems.push(what + ': ' + label + ' ' + px(b.left) + '..' + px(b.right) + ' leaves its row ' + px(r.left) + '..' + px(r.right));
    }
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        if (overlap(live[i][1].getBoundingClientRect(), live[j][1].getBoundingClientRect())) problems.push(what + ': ' + live[i][0] + ' and ' + live[j][0] + ' overlap');
      }
    }
    for (const [label, el] of live) {
      if (names.includes(label)) {
        if (cut(el)) {
          const free = slack(el);
          truncated.push(what + ' ' + label + ' (' + el.clientWidth + ' of ' + el.scrollWidth + 'px, ' + px(free) + 'px free)');
          if (free > 2) problems.push(what + ': ' + label + ' is cut to ' + el.clientWidth + ' of ' + el.scrollWidth + 'px while its line has ' + px(free) + 'px free');
        }
      } else if (TEXT_PARTS.includes(label) && cut(el) && getComputedStyle(el).textOverflow !== 'ellipsis') {
        problems.push(what + ': ' + label + ' text is cut off (' + el.clientWidth + ' of ' + el.scrollWidth + 'px) without an ellipsis');
      }
    }
  };

  const q = (root, sel) => root.querySelector(':scope ' + sel);
  let rows = 0;
  let sessions = 0;
  for (const row of list.querySelectorAll('.project-row')) {
    if (!shown(row)) continue;
    rows++;
    const name = q(row, '.project-name');
    checkRow(row, 'project "' + (name?.textContent ?? '') + '"', [
      ['name', name], ['tag', q(row, '.project-tag')], ['toggle', q(row, '.project-toggle')], ['branch', q(row, '.project-branch')],
      ['status', q(row, '.project-status')], ['dot', q(row, '.session-unread')], ['actions', q(row, '.row-actions')],
    ], ['name', 'branch']);
  }
  for (const row of list.querySelectorAll('.worktree-row')) {
    if (!shown(row)) continue;
    rows++;
    const name = q(row, '.worktree-label');
    checkRow(row, 'worktree "' + (name?.textContent ?? '') + '"', [
      ['name', name], ['tag', q(row, '.worktree-tag')], ['actions', q(row, '.row-actions')],
    ], ['name']);
  }
  for (const row of list.querySelectorAll('.session-item')) {
    if (!shown(row)) continue;
    rows++;
    sessions++;
    const name = q(row, '.session-label-text');
    const what = 'session "' + (name?.textContent ?? row.dataset.sessionId) + '"';
    if (!name) { if (!q(row, '.session-rename-input')) problems.push(what + ': no name element'); continue; }
    const n = name.getBoundingClientRect();
    const need = Math.min(name.scrollWidth, MIN_NAME_EM * parseFloat(getComputedStyle(name).fontSize));
    if (n.width <= 0 || name.clientWidth <= 0) problems.push(what + ': name has no visible width');
    else if (name.clientWidth + 1 < need) problems.push(what + ': name shows only ' + name.clientWidth + 'px of ' + name.scrollWidth + 'px (needs at least ' + px(need) + 'px)');
    checkRow(row, what, [
      ['name', name], ['kind icon', q(row, '.session-kind-icon')], ['kind badge', q(row, '.session-ui-badge')], ['state text', q(row, '.session-meta')],
      ['state dot', q(row, '.session-unread')], ['reload', q(row, '.session-reload')], ['close', q(row, '.session-close')],
    ], ['name']);
  }
  // Where to point the mouse for the hover pass: rows that are in view.
  const targets = [...list.querySelectorAll('.project-row, .worktree-row, .session-item')].filter(shown).map((row) => {
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }).filter((t) => t.y > 0 && t.y < innerHeight && document.elementFromPoint(t.x, t.y)?.closest('#machine-list'));
  return { problems, rows, sessions, width: px(edge.width), truncated, targets };
})()`;

/**
 * Measures the sidebar as it is right now, then once more with the mouse over
 * each row in view (rows reveal their action buttons on hover, which takes room
 * from the name). `cdp` needs send() and evaluate(). Returns
 * { problems, rows, sessions, width, truncated, hovered }: `problems` is empty
 * when every row passes in every pass; `truncated` lists the names that end in
 * "…" with nothing hovered (allowed only when their line is full) so a run's
 * output shows what was actually exercised.
 */
export async function sidebarLayout(cdp) {
  const rest = await cdp.evaluate(MEASURE);
  const problems = [...rest.problems];
  for (const t of rest.targets) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.x, y: t.y });
    for (const p of (await cdp.evaluate(MEASURE)).problems) {
      const line = `with the mouse over a row: ${p}`;
      if (!rest.problems.includes(p) && !problems.includes(line)) problems.push(line);
    }
  }
  if (rest.targets.length) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rest.width + 200, y: 8 });
  return { problems, rows: rest.rows, sessions: rest.sessions, width: rest.width, truncated: rest.truncated, hovered: rest.targets.length };
}

export const LONG_BRANCH = 'change/general-skills-and-a-long-tail';

/**
 * Builds throwaway repositories for the sidebar under a fresh directory in
 * `base` (which must be inside the daemon's allowed roots) and returns
 * { root, dirs }. The caller removes `root` when done.
 *
 *   devflow/            main worktree (branch main)
 *   devflow-wt/fix      worktree, branch fix-login
 *   devflow-wt/long     worktree, branch LONG_BRANCH
 *   devflow-wt/empty    worktree, branch release/next, left without a session
 *   new-api/            one-worktree repository on branch dev (a flat project)
 *   billing/            one-worktree repository on LONG_BRANCH (flat, long branch)
 *   notes/              not a git repository
 */
export function makeSidebarRepos(base = '/tmp') {
  const root = mkdtempSync(join(base, 'vr-'));
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  };
  const repo = (name, branch) => {
    const dir = join(root, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', branch);
    writeFileSync(join(dir, 'README.md'), `${name}\n`);
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-q', '-m', 'init');
    return dir;
  };
  const devflow = repo('devflow', 'main');
  const wt = join(root, 'devflow-wt');
  mkdirSync(wt);
  git(devflow, 'worktree', 'add', '-q', '-b', 'fix-login', join(wt, 'fix'));
  git(devflow, 'worktree', 'add', '-q', '-b', LONG_BRANCH, join(wt, 'long'));
  git(devflow, 'worktree', 'add', '-q', '-b', 'release/next', join(wt, 'empty'));
  const newApi = repo('new-api', 'dev');
  const billing = repo('billing', LONG_BRANCH);
  const notes = join(root, 'notes');
  mkdirSync(notes);
  return { root, dirs: { main: devflow, fix: join(wt, 'fix'), long: join(wt, 'long'), empty: join(wt, 'empty'), newApi, billing, notes } };
}

/**
 * Starts a terminal session in `workdir` over the daemon's WebSocket and leaves
 * it running (the socket is closed after `ready`; tmux keeps the session).
 * Returns the session id.
 */
export async function startSession(addr, token, workdir) {
  const ws = new WebSocket(`ws://${addr}/ws`);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready for a session in ${workdir}`)), 15000);
      ws.onerror = () => { clearTimeout(timer); reject(new Error('daemon websocket')); };
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth', token }));
        ws.send(JSON.stringify({ type: 'attach', sessionId: '', cols: 100, rows: 30, workdir }));
      };
      ws.onmessage = (ev) => {
        const f = JSON.parse(ev.data);
        if (f.type === 'ready') { clearTimeout(timer); resolve(f.sessionId); }
        if (f.type === 'error') { clearTimeout(timer); reject(new Error(`attach in ${workdir}: ${f.message}`)); }
      };
    });
  } finally {
    ws.close();
  }
}
