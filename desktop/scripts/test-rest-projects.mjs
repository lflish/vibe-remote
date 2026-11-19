// rest.ts: listProjects / removeProject and the RestError they throw (v4).
import { strict as assert } from 'node:assert';
import { load, runner } from './chat-test-util.mjs';

// i18n (imported by rest.ts) reads these at module load.
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });

const { VibeRemoteRest, RestError } = await load('src/renderer/rest.ts');
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

await run();
