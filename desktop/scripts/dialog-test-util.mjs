// Shared helpers for the dialog tests (test-session-form, test-worktree-dialogs):
// a fake daemon behind globalThis.fetch and a few DOM shortcuts. The caller sets
// up the jsdom globals (indexDom) first.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lets pending promise callbacks and zero-delay timers run. */
export async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) await sleep(0);
}

/** Longer than the name field's 250 ms debounce. */
export const afterDebounce = () => sleep(320);

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const INFO_V4 = {
  hostname: 'h', tmux_enabled: true, default_workdir: '/r', allowed_roots: ['/r'], proto: 4, version: 'test',
  chat: { supported: true, claudeVersion: '2.1.210', minClaudeVersion: '2.1.210' },
  claude_flags: [{ id: 'continue', label: '续上次会话 (-c)' }, { id: 'skip', label: '跳过权限确认', default: true }],
};

/**
 * Replaces fetch with a fake daemon. `routes` may define:
 *   info:  object | () => object | Error
 *   fs:    (path) => listing object
 *   plan:  (workdir, name) => WorktreePlan | Promise<WorktreePlan> | Response
 * Every request is recorded in `calls` as { path, query }.
 */
export function fakeDaemon(routes = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const query = Object.fromEntries(url.searchParams);
    calls.push({ path: url.pathname, query, method: init?.method ?? 'GET' });
    const answer = async (value) => {
      const v = typeof value === 'function' ? await value() : value;
      if (v instanceof Error) throw v;
      return v instanceof Response ? v : json(200, v);
    };
    if (url.pathname === '/api/v1/info') return answer(routes.info ?? INFO_V4);
    if (url.pathname === '/api/v1/fs') {
      const fs = routes.fs ?? ((path) => ({ path: path || '/r/devflow', entries: [], parent: '/r', chatTrust: 'trusted' }));
      return answer(() => fs(query.path));
    }
    if (url.pathname === '/api/v1/worktrees/plan') {
      if (!routes.plan) return json(404, {});
      return answer(() => routes.plan(query.workdir, query.name));
    }
    return json(404, {});
  };
  return {
    calls,
    plans: () => calls.filter((c) => c.path === '/api/v1/worktrees/plan').map((c) => c.query),
    restore() { globalThis.fetch = original; },
  };
}

/** A plan answer for the example repo: base `main @ a1b2c3d`, target under devflow-worktrees. */
export function planFor(name, over = {}) {
  const base = { project: '/r/devflow', projectName: 'devflow', base: { branch: 'main', head: 'a1b2c3d' } };
  if (!name) return { ok: false, error: 'invalid_worktree_name', message: 'empty', ...base, ...over };
  return { ok: true, ...base, branch: name, path: `/r/devflow-worktrees/${name.replaceAll('/', '-')}`, ...over };
}

export const tid = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);
export const overlay = () => document.querySelector('.modal-overlay');
export const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

export function typeInto(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function pressKey(target, key) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}
