// rest.ts: the v4 project and worktree endpoints, the RestError they throw and
// the per-request deadline.
import { strict as assert } from 'node:assert';
import { load, runner } from './chat-test-util.mjs';

// i18n (imported by rest.ts) reads these at module load.
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });

const { VibeRemoteRest, RestError, removeTimeoutMs, timedFetch } = await load('src/renderer/rest.ts');
const { test, run } = runner('test-rest-projects');

const machine = { name: 'm', addr: '127.0.0.1', port: 9999, token: 'secret' };

async function withFetch(handler, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('listProjects: 404 means an old daemon → null', async () => {
  const rest = new VibeRemoteRest(machine);
  const res = await withFetch(async () => new Response(null, { status: 404 }), () => rest.listProjects());
  assert.equal(res, null);
});

test('listProjects: 200 → the projects array', async () => {
  const rest = new VibeRemoteRest(machine);
  const res = await withFetch(
    async () => json(200, { proto: 4, projects: [{ id: '/a', name: 'a', git: true, worktrees: [], sessions: [] }] }),
    () => rest.listProjects(),
  );
  assert.equal(res.length, 1);
  assert.equal(res[0].id, '/a');
});

// The body is {proto, projects}, both required (docs/protocol.md). A 200 that
// lacks the list is a broken answer, not a machine with no projects: taking it
// for an empty tree would wipe the sidebar and mark the daemon as protocol 4.
test('listProjects: a 200 without the projects array is an error, not an empty tree', async () => {
  const rest = new VibeRemoteRest(machine);
  for (const body of [{}, { proto: 4 }, { proto: 4, projects: null }, { proto: 4, projects: {} }, null, []]) {
    let err;
    let res;
    await withFetch(async () => json(200, body), async () => {
      try { res = await rest.listProjects(); } catch (e) { err = e; }
    });
    assert.ok(err instanceof Error, `${JSON.stringify(body)} is refused (got ${JSON.stringify(res)})`);
    assert.ok(!(err instanceof RestError), 'not an HTTP refusal');
  }
  // An empty list is a valid answer.
  const empty = await withFetch(async () => json(200, { proto: 4, projects: [] }), () => rest.listProjects());
  assert.deepEqual(empty, []);
});

test('listProjects: 500 → RestError with status 500', async () => {
  const rest = new VibeRemoteRest(machine);
  let err;
  await withFetch(async () => new Response('oops', { status: 500 }), async () => {
    try { await rest.listProjects(); } catch (e) { err = e; }
  });
  assert.ok(err instanceof RestError, 'threw a RestError');
  assert.equal(err.status, 500);
});

test('removeProject: 409 → RestError.code project_has_sessions', async () => {
  const rest = new VibeRemoteRest(machine);
  let err;
  await withFetch(async () => json(409, { error: 'project_has_sessions' }), async () => {
    try { await rest.removeProject('/r/x'); } catch (e) { err = e; }
  });
  assert.ok(err instanceof RestError, 'threw a RestError');
  assert.equal(err.code, 'project_has_sessions');
});

test('removeProject: 204 → resolves', async () => {
  const rest = new VibeRemoteRest(machine);
  await withFetch(async () => new Response(null, { status: 204 }), () => rest.removeProject('/r/x'));
});

test('plan_encodes_query', async () => {
  const rest = new VibeRemoteRest(machine);
  const seen = [];
  const plan = await withFetch(
    async (url, init) => {
      seen.push({ url: String(url), auth: init?.headers?.Authorization, method: init?.method ?? 'GET' });
      return json(200, { ok: true, project: '/r/a b', projectName: 'a b', base: { branch: 'main', head: 'a1b2c3d' }, branch: 'change/foo', path: '/r/a b-worktrees/change-foo' });
    },
    () => rest.planWorktree('/r/a b', 'change/foo'),
  );
  assert.equal(seen.length, 1);
  const raw = seen[0].url;
  assert.ok(raw.startsWith('http://127.0.0.1:9999/api/v1/worktrees/plan?'), raw);
  assert.ok(!raw.includes(' ') && !raw.includes('/r/a') && !raw.includes('change/foo'), `parameters are URL-encoded: ${raw}`);
  const q = new URL(raw).searchParams;
  assert.equal(q.get('workdir'), '/r/a b');
  assert.equal(q.get('name'), 'change/foo');
  assert.equal(seen[0].auth, 'Bearer secret');
  assert.equal(seen[0].method, 'GET');
  assert.equal(plan.ok, true);
  assert.equal(plan.branch, 'change/foo');
  assert.equal(plan.base.head, 'a1b2c3d');

  // ok:false is a normal answer, not an exception.
  const rejected = await withFetch(
    async () => json(200, { ok: false, error: 'worktree_branch_exists', message: 'branch "fix" already exists', conflict: 'fix', branch: 'fix/login' }),
    () => rest.planWorktree('/r/devflow', 'fix/login'),
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.conflict, 'fix');

  let err;
  await withFetch(async () => json(403, { error: 'path not in allowed roots' }), async () => {
    try { await rest.planWorktree('/etc', 'x'); } catch (e) { err = e; }
  });
  assert.ok(err instanceof RestError, 'HTTP 403 throws a RestError');
  assert.equal(err.status, 403);
});

const STATUS = {
  path: '/r/devflow-worktrees/fix login', project: '/r/devflow', branch: 'fix-login', head: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',
  main: false, managed: true, dirtyFiles: 3, unmergedCommits: 2, ignoredFiles: 1204, sessions: ['s1', 's2'],
};

test('worktree_status_encodes_query', async () => {
  const rest = new VibeRemoteRest(machine);
  const seen = [];
  const st = await withFetch(
    async (url, init) => { seen.push({ url: String(url), auth: init?.headers?.Authorization, method: init?.method ?? 'GET' }); return json(200, STATUS); },
    () => rest.worktreeStatus(STATUS.path),
  );
  assert.deepEqual(st, STATUS);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.startsWith('http://127.0.0.1:9999/api/v1/worktrees/status?'), seen[0].url);
  assert.ok(!seen[0].url.includes(' '), 'the path is URL-encoded');
  assert.equal(new URL(seen[0].url).searchParams.get('path'), STATUS.path);
  assert.equal(seen[0].auth, 'Bearer secret');
  assert.equal(seen[0].method, 'GET');

  let err;
  await withFetch(async () => json(404, { error: 'worktree_not_found', message: 'gone' }), async () => {
    try { await rest.worktreeStatus('/r/nope'); } catch (e) { err = e; }
  });
  assert.ok(err instanceof RestError);
  assert.equal(err.status, 404);
  assert.equal(err.code, 'worktree_not_found');
});

test('remove_posts_request', async () => {
  const rest = new VibeRemoteRest(machine);
  const seen = [];
  const req = { path: STATUS.path, head: STATUS.head, sessions: ['s1', 's2'], discardFiles: true, deleteBranch: false };
  const res = await withFetch(
    async (url, init) => {
      seen.push({ url: String(url), method: init?.method, auth: init?.headers?.Authorization, type: init?.headers?.['Content-Type'], body: init?.body });
      return json(200, { removed: true, branchDeleted: false, branchError: 'still checked out', endedSessions: ['s1', 's2'] });
    },
    () => rest.removeWorktree(req),
  );
  assert.deepEqual(res, { removed: true, branchDeleted: false, branchError: 'still checked out', endedSessions: ['s1', 's2'] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://127.0.0.1:9999/api/v1/worktrees/remove');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].auth, 'Bearer secret');
  assert.equal(seen[0].type, 'application/json');
  assert.deepEqual(JSON.parse(seen[0].body), req);
});

// A removal ends its sessions one by one (a chat process takes up to ~4 s to
// stop), so its deadline grows with them; every other request keeps 8 s.
test('remove_timeout_scales', async () => {
  assert.equal(removeTimeoutMs(0), 10000);
  assert.equal(removeTimeoutMs(3), 25000);
  assert.equal(removeTimeoutMs(20), 60000);

  const rest = new VibeRemoteRest(machine);
  const origTimeout = AbortSignal.timeout;
  const asked = [];
  AbortSignal.timeout = (ms) => { asked.push(ms); return origTimeout.call(AbortSignal, ms); };
  try {
    const answers = {
      '/api/v1/worktrees/remove': { removed: true, branchDeleted: true, endedSessions: [] },
      '/api/v1/worktrees/status': STATUS,
      '/api/v1/worktrees/plan': { ok: true },
      '/api/v1/projects': { proto: 4, projects: [] },
      '/api/v1/sessions': { type: 'sessions', list: [] },
      '/api/v1/info': {},
    };
    await withFetch(async (url) => json(200, answers[new URL(String(url)).pathname] ?? {}), async () => {
      await rest.removeWorktree({ path: '/r/wt', head: 'h', sessions: ['a', 'b', 'c'] });
      await rest.removeWorktree({ path: '/r/wt', head: 'h', sessions: [] });
      assert.deepEqual(asked, [25000, 10000], 'a removal waits removeTimeoutMs(sessions)');
      asked.length = 0;
      await rest.worktreeStatus('/r/wt');
      await rest.planWorktree('/r', 'x');
      await rest.listProjects();
      await rest.listSessions();
      await rest.info();
      assert.deepEqual(asked, [8000, 8000, 8000, 8000, 8000], 'every other request keeps the 8 s deadline');
      asked.length = 0;
      await timedFetch('http://127.0.0.1:9999/x');
      await timedFetch('http://127.0.0.1:9999/x', {}, 1234);
      assert.deepEqual(asked, [8000, 1234]);
    });
  } finally {
    AbortSignal.timeout = origTimeout;
  }

  // A deadline hit is not a RestError: the outcome is unknown, not refused.
  let err;
  await withFetch(
    (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
    async () => {
      // Node's own timeout signal does not keep the process alive; this one does.
      AbortSignal.timeout = () => {
        const c = new AbortController();
        setTimeout(() => c.abort(new DOMException('The operation timed out.', 'TimeoutError')), 20);
        return c.signal;
      };
      try { await rest.removeWorktree({ path: '/r/wt', head: 'h', sessions: [] }); } catch (e) { err = e; } finally { AbortSignal.timeout = origTimeout; }
    },
  );
  assert.ok(err, 'the request was aborted');
  assert.ok(!(err instanceof RestError), 'a timeout is not a RestError');
  assert.equal(err.name, 'TimeoutError');
});

test('remove_409_carries_status', async () => {
  const rest = new VibeRemoteRest(machine);
  let err;
  await withFetch(
    async () => json(409, { error: 'worktree_changed', message: 'changed', status: { ...STATUS, dirtyFiles: 1 }, endedSessions: ['s1'] }),
    async () => { try { await rest.removeWorktree({ path: STATUS.path, head: STATUS.head, sessions: ['s1', 's2'] }); } catch (e) { err = e; } },
  );
  assert.ok(err instanceof RestError);
  assert.equal(err.status, 409);
  assert.equal(err.code, 'worktree_changed');
  assert.equal(err.body.status.dirtyFiles, 1);
  assert.equal(err.body.status.head, STATUS.head);
  assert.deepEqual(err.body.endedSessions, ['s1']);
});

test('remove_500_carries_ended_sessions', async () => {
  const rest = new VibeRemoteRest(machine);
  let err;
  await withFetch(
    async () => json(500, { error: 'worktree_remove_failed', message: "error: failed to delete '/r/wt': Directory not empty", endedSessions: ['s1', 's2'] }),
    async () => { try { await rest.removeWorktree({ path: STATUS.path, head: STATUS.head, sessions: ['s1', 's2'] }); } catch (e) { err = e; } },
  );
  assert.ok(err instanceof RestError);
  assert.equal(err.status, 500);
  assert.equal(err.code, 'worktree_remove_failed');
  assert.ok(Array.isArray(err.body.endedSessions));
  assert.deepEqual(err.body.endedSessions, ['s1', 's2']);
  assert.equal(err.body.message, "error: failed to delete '/r/wt': Directory not empty");
  for (const [status, code] of [[400, 'worktree_is_main'], [404, 'worktree_not_found']]) {
    let e2;
    await withFetch(async () => json(status, { error: code, message: 'm' }), async () => {
      try { await rest.removeWorktree({ path: '/r', head: 'h', sessions: [] }); } catch (e) { e2 = e; }
    });
    assert.ok(e2 instanceof RestError);
    assert.equal(e2.status, status);
    assert.equal(e2.code, code);
  }
});

await run();
