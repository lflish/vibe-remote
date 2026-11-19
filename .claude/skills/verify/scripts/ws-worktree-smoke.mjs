#!/usr/bin/env node
// End-to-end checks of creating and deleting worktrees over the real REST and
// WebSocket protocol, in the environments where "which sessions are running"
// is hardest for the daemon to answer, and with whatever git it is given:
//
//   git: the commands the daemon relies on, with this git (the two --force of
//        `worktree remove` on a locked entry among them)
//   named worktree → session in it → delete (directory and branch); a second
//        one with unmerged commits, deleting the branch as well
//   tmux: a fresh socket directory, chat sessions only → deleting works and
//        starts no tmux server
//   tmux: no tmux program on the daemon's PATH → deleting works
//   tmux: the socket file is removed while the server runs → refused (500,
//        nothing touched); after SIGUSR1 to that server → works, session ended
//   tmux: no tmux program on PATH but its socket is there → refused
//   tmux: the server has exited and left its socket file → deleting works
//   a repository whose main directory git does not name (--separate-git-dir,
//        a submodule): one project with one worktree, no named worktree there
//   a terminal session from before the upgrade (a tmux session with none of
//        the @vibe_remote_* options) is counted and ended
//
// Everything is isolated and removed afterwards: every daemon has its own
// port, token, state_dir, CLAUDE_CONFIG_DIR, TMUX_TMPDIR and allowed root
// under one fresh directory in /tmp. The only signal sent goes to a tmux
// server this script's own daemon started.
//
// Usage (from the repo root):
//   node .claude/skills/verify/scripts/ws-worktree-smoke.mjs [--only=<substring>]
//   VR_GIT=<path to a git binary>   run the daemons (and the fixtures) with that git, e.g. one older than 2.31
//   VR_EVIDENCE=<file>              also write the output, with the daemons' answers, to a file
//   VR_DAEMON=<binary>              another build of the daemon (an earlier commit, or one with a defect put in: do the cases notice?)
// Requires Node 22+ (global WebSocket), Go, tmux and git.

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);

let failures = 0;
const lines = [];
const say = (line) => { console.log(line); lines.push(line); };
const pass = (name, detail = '') => say(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
const fail = (name, detail = '') => { failures++; say(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); };
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (got, want, what) => assert(J(got) === J(want), `${what}: got ${J(got)}, want ${J(want)}`);

async function waitFor(fn, ms, what) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() >= deadline) throw new Error(`timeout (${ms}ms): ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
    await sleep(100);
  }
}

// --- Throwaway environment ------------------------------------------------------

// Short base path: tmux sockets live under it (macOS caps them at ~104 bytes).
const work = realpathSync(mkdtempSync('/tmp/vr-wr-'));
// Nothing this script starts can reach the default tmux socket directory.
process.env.TMUX_TMPDIR = join(work, 'tmux');
mkdirSync(process.env.TMUX_TMPDIR);
delete process.env.TMUX;
delete process.env.TMUX_PANE;

const binDir = join(work, 'bin');
const daemonBin = join(binDir, 'vibe-remoted');
const claudeBin = join(binDir, 'claude');
const which = (name) => spawnSync('/usr/bin/which', [name], { encoding: 'utf-8' }).stdout.trim();
const GIT = process.env.VR_GIT ? resolve(process.env.VR_GIT) : which('git');
const TMUX = which('tmux');
// PATH of the daemons: the chosen git first; a variant without any tmux.
const gitDir = join(work, 'gitbin');
mkdirSync(gitDir, { recursive: true });
symlinkSync(GIT, join(gitDir, 'git'));
const PATH_WITH_TMUX = `${gitDir}:${dirname(TMUX)}:/usr/bin:/bin:/usr/sbin:/sbin`;
const PATH_NO_TMUX = `${gitDir}:/usr/bin:/bin:/usr/sbin:/sbin`;
const uid = process.getuid();
const running = new Set();

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR', 'TMUX', 'TMUX_PANE', 'PATH'].includes(k) || k.startsWith('FAKE_CLAUDE_') || k.startsWith('GIT_')) continue;
    env[k] = v;
  }
  return env;
}

const GIT_ENV = { ...cleanEnv(), PATH: PATH_WITH_TMUX, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };
const gitRun = (cwd, ...a) => spawnSync(GIT, ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf-8', env: GIT_ENV });
function git(cwd, ...a) {
  const r = gitRun(cwd, ...a);
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}
const branchExists = (repo, name) => gitRun(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`).status === 0;
const listed = (repo, path) => git(repo, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${path}`);
const disk = (repo, path, branch) => ({ dir: existsSync(path), listed: listed(repo, path), branch: branch ? branchExists(repo, branch) : null });

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(join(dir, 'README.md'), 'smoke\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/**
 * One throwaway daemon in its own directory `<work>/<name>`: allowed root
 * `root/`, tmux socket directory `t/`. `chat`: claude_cmd is the fake claude
 * and `root/repo` is trusted. `path`: the daemon's PATH.
 */
function defineDaemon(name, { chat = false, path = PATH_WITH_TMUX } = {}) {
  const dir = join(work, name);
  const root = join(dir, 'root');
  const tmux = join(dir, 't');
  const cc = join(dir, 'cc');
  for (const d of [root, tmux, cc]) mkdirSync(d, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 10000);
  const token = randomBytes(32).toString('hex');
  writeFileSync(join(cc, '.claude.json'), J({ projects: { [join(root, 'repo')]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  const cmd = chat ? claudeBin : '/bin/bash';
  const cfg = { bind_addr: '127.0.0.1', port, token, default_workdir: root, allowed_roots: [root], use_tmux: true, login_shell: false, claude_cmd: cmd, claude_reload_cmd: cmd, state_dir: join(dir, 'state') };
  writeFileSync(join(dir, 'daemon.json'), J(cfg), { mode: 0o600 });
  return { name, dir, root, tmux, port, token, path, env: { ...cleanEnv(), PATH: path, TMUX_TMPDIR: tmux, CLAUDE_CONFIG_DIR: cc }, socket: join(realpathSync(tmux), `tmux-${uid}`, 'vibe-remote'), log: '' };
}

async function startDaemon(d, path = d.path) {
  d.proc = spawn(daemonBin, ['--config', join(d.dir, 'daemon.json')], { env: { ...d.env, PATH: path }, stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(d);
  d.proc.stdout.on('data', (x) => { d.log += x; });
  d.proc.stderr.on('data', (x) => { d.log += x; });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${d.port}/healthz`)).ok, 15000, `${d.name} /healthz`).catch((e) => { throw new Error(`${e.message}\n${d.log}`); });
}

async function stopDaemon(d) {
  if (!d.proc) return;
  const p = d.proc;
  d.proc = null;
  p.kill('SIGTERM');
  await new Promise((r) => { p.once('exit', r); setTimeout(r, 8000); });
}

/** tmux of this daemon only: -L vibe-remote under its own TMUX_TMPDIR. */
const tmux = (d, ...a) => spawnSync(TMUX, ['-L', 'vibe-remote', ...a], { env: { ...d.env, PATH: PATH_WITH_TMUX }, encoding: 'utf-8' });

async function rest(d, method, path, body) {
  const r = await fetch(`http://127.0.0.1:${d.port}${path}`, { method, headers: { Authorization: `Bearer ${d.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? J(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: r.status, json, text };
}
const sessions = async (d) => (await rest(d, 'GET', '/api/v1/sessions')).json.list ?? [];
const status = (d, path) => rest(d, 'GET', `/api/v1/worktrees/status?path=${encodeURIComponent(path)}`);
/** Removes a worktree the way the desktop does: with what status just said, plus the consent given. */
async function remove(d, path, consent = {}) {
  const s = (await status(d, path)).json;
  return rest(d, 'POST', '/api/v1/worktrees/remove', { path, head: s.head, sessions: s.sessions, ...(s.branch ? { branch: s.branch } : {}), ...consent });
}

/** Creates a session with one attach frame; returns the `ready` frame. */
async function createSession(d, frame) {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
  try {
    return await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`no ready for ${J(frame)}`)), 30000);
      ws.onerror = () => { clearTimeout(timer); rej(new Error('daemon websocket')); };
      ws.onopen = () => {
        ws.send(J({ type: 'auth', token: d.token }));
        ws.send(J({ type: 'attach', sessionId: '', cols: 100, rows: 30, ...frame }));
      };
      ws.onmessage = (e) => {
        const f = JSON.parse(e.data);
        if (f.type === 'ready') { clearTimeout(timer); res(f); }
        if (f.type === 'error') { clearTimeout(timer); rej(new Error(`${f.code}: ${f.message}`)); }
      };
    });
  } finally {
    ws.close();
  }
}
const newId = () => `${Date.now()}-${randomBytes(4).toString('hex')}`;

// --- Cases ------------------------------------------------------------------------

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('git: the commands the daemon relies on', async () => {
  const dir = join(work, 'gitprobe');
  const repo = makeRepo(join(dir, 'repo'));
  const oid = git(repo, 'rev-parse', 'HEAD');
  const out = [];
  eq(git(repo, 'check-ref-format', '--branch', 'fix/login'), 'fix/login', 'check-ref-format --branch');
  assert(gitRun(repo, 'check-ref-format', '--branch', '@{-1}').status !== 0, 'check-ref-format --branch accepts @{-1} in a repository with no previous branch');
  git(repo, 'update-ref', 'refs/heads/probe', oid, '');
  assert(gitRun(repo, 'update-ref', 'refs/heads/probe', oid, '').status !== 0, 'update-ref with an empty old value overwrote an existing branch');
  out.push('update-ref <ref> <oid> "" creates only');
  const wt = join(dir, 'wt');
  git(repo, '-c', 'core.fsmonitor=false', 'worktree', 'add', '--detach', wt, oid);
  git(wt, 'symbolic-ref', '-m', 'worktree: attached to refs/heads/probe', 'HEAD', 'refs/heads/probe');
  const porcelain = git(repo, 'worktree', 'list', '--porcelain');
  assert(porcelain.includes(`worktree ${wt}`) && porcelain.includes('branch refs/heads/probe'), `worktree list --porcelain: ${porcelain}`);
  out.push('worktree add --detach + symbolic-ref HEAD are listed with the branch');
  // a locked entry: one --force is refused, two remove it (what undoing a half-made worktree needs)
  git(repo, 'worktree', 'lock', '--reason', 'initializing', wt);
  const once = gitRun(repo, 'worktree', 'remove', '--force', wt);
  assert(once.status !== 0 && existsSync(wt), `worktree remove --force removed a locked worktree: ${once.stderr}`);
  const twice = gitRun(repo, 'worktree', 'remove', '--force', '--force', wt);
  assert(twice.status === 0 && !existsSync(wt), `worktree remove --force --force on a locked worktree: exit ${twice.status}, ${twice.stderr.trim()}`);
  out.push(`locked: --force refused ("${once.stderr.trim().split('\n')[0]}"), --force --force removes it`);
  git(repo, 'update-ref', '-d', 'refs/heads/probe', oid);
  assert(!branchExists(repo, 'probe'), 'update-ref -d with the old value left the branch');
  eq(git(repo, 'rev-list', '--count', 'refs/heads/main', '--not', '--exclude=main', '--branches', '--remotes'), '1', 'rev-list --count <branch> --not --exclude=<branch> --branches --remotes');
  eq(git(repo, 'status', '--porcelain', '-z', '--untracked-files=all'), '', 'status --porcelain -z');
  eq(git(repo, 'ls-files', '--others', '--ignored', '--exclude-standard'), '', 'ls-files --others --ignored --exclude-standard');
  eq(git(repo, 'for-each-ref', '--count=1', '--format=%(refname)', 'refs/heads/main/'), '', 'for-each-ref with a prefix');
  return out.join('; ');
});

test('named worktree → session → delete, directory and branch', async () => {
  const d = defineDaemon('e2e');
  const repo = makeRepo(join(d.root, 'repo'));
  await startDaemon(d);
  try {
    // clean and merged: both go
    const a = await createSession(d, { workdir: repo, mode: 'worktree', worktreeName: 'fix-login', newSessionId: newId() });
    const sa = (await sessions(d)).find((s) => s.id === a.sessionId);
    eq([sa.branch, sa.worktreeRoot], ['fix-login', join(d.root, 'repo-worktrees', 'fix-login')], 'branch and directory of the new worktree');
    eq(git(sa.worktreeRoot, 'symbolic-ref', '--short', 'HEAD'), 'fix-login', 'branch checked out in it');
    const st = (await status(d, sa.worktreeRoot)).json;
    eq([st.managed, st.dirtyFiles, st.unmergedCommits, st.sessions], [true, 0, 0, [a.sessionId]], 'status of the new worktree');
    const ra = await remove(d, sa.worktreeRoot, { deleteBranch: true });
    eq([ra.status, ra.json], [200, { removed: true, branchDeleted: true, endedSessions: [a.sessionId] }], 'removing it with its session');
    eq(disk(repo, sa.worktreeRoot, 'fix-login'), { dir: false, listed: false, branch: false }, 'on disk');
    // unmerged commits: refused without the consent, then directory and branch
    const b = await createSession(d, { workdir: repo, mode: 'worktree', worktreeName: 'change/foo', newSessionId: newId() });
    const sb = (await sessions(d)).find((s) => s.id === b.sessionId);
    eq(sb.worktreeRoot, join(d.root, 'repo-worktrees', 'change-foo'), 'directory for a name with a slash');
    for (const f of ['one.txt', 'two.txt']) { writeFileSync(join(sb.worktreeRoot, f), 'x\n'); git(sb.worktreeRoot, 'add', f); git(sb.worktreeRoot, 'commit', '-q', '-m', f); }
    const refused = await remove(d, sb.worktreeRoot, { deleteBranch: true });
    eq([refused.status, refused.json.error, refused.json.status.unmergedCommits, refused.json.endedSessions], [409, 'worktree_changed', 2, []], 'deleting the branch without consent to drop its commits');
    eq(disk(repo, sb.worktreeRoot, 'change/foo'), { dir: true, listed: true, branch: true }, 'on disk after the refusal');
    const rb = await remove(d, sb.worktreeRoot, { deleteBranch: true, dropCommits: true });
    eq([rb.status, rb.json.removed, rb.json.branchDeleted], [200, true, true], 'removing it with the consent');
    eq(disk(repo, sb.worktreeRoot, 'change/foo'), { dir: false, listed: false, branch: false }, 'on disk');
    eq(git(repo, 'status', '--porcelain'), '', 'the main directory');
    return `fix-login created, used and removed (${J(ra.json)}); change/foo with 2 unmerged commits: 409 without consent, then removed with its branch`;
  } finally {
    await stopDaemon(d);
  }
});

test('tmux: a fresh socket directory, chat sessions only', async () => {
  const d = defineDaemon('fresh', { chat: true });
  const repo = makeRepo(join(d.root, 'repo'));
  const wt = join(d.root, 'wt', 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'topic-a', wt);
  await startDaemon(d);
  try {
    const chat = await createSession(d, { workdir: repo, ui: 'chat', newSessionId: newId() });
    assert(!existsSync(d.socket), 'a tmux socket exists before any terminal session');
    const r = await remove(d, wt);
    eq([r.status, r.json], [200, { removed: true, branchDeleted: false, endedSessions: [] }], 'removing a worktree without sessions');
    eq(disk(repo, wt, 'topic-a'), { dir: false, listed: false, branch: true }, 'on disk (not created by vibe-remote: the branch stays)');
    assert(!existsSync(d.socket), 'removing the worktree started a tmux server');
    assert((await sessions(d)).some((s) => s.id === chat.sessionId), 'the chat session is gone');
    return `200 ${J(r.json)}; no socket at ${d.socket.replace(work, '<work>')} before or after; the chat session still runs`;
  } finally {
    await stopDaemon(d);
  }
});

test('tmux: no tmux program on the daemon\'s PATH', async () => {
  const d = defineDaemon('notmux', { path: PATH_NO_TMUX });
  assert(spawnSync('/usr/bin/which', ['tmux'], { env: { PATH: PATH_NO_TMUX }, encoding: 'utf-8' }).stdout.trim() === '', 'that PATH does have a tmux');
  const repo = makeRepo(join(d.root, 'repo'));
  const wt = join(d.root, 'wt', 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'topic-a', wt);
  await startDaemon(d);
  try {
    // the project is known to the daemon only through its list: ask for the worktree directly
    const s = await status(d, wt);
    eq([s.status, s.json.sessions], [200, []], 'status');
    const r = await remove(d, wt);
    eq([r.status, r.json], [200, { removed: true, branchDeleted: false, endedSessions: [] }], 'removing a worktree without sessions');
    eq(disk(repo, wt, 'topic-a'), { dir: false, listed: false, branch: true }, 'on disk');
    return `200 ${J(r.json)} with use_tmux: true and no tmux in ${PATH_NO_TMUX.replace(work, '<work>')}`;
  } finally {
    await stopDaemon(d);
  }
});

test('tmux: the socket file is removed while the server runs', async () => {
  const d = defineDaemon('nosock');
  const repo = makeRepo(join(d.root, 'repo'));
  const wt = join(d.root, 'wt', 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'topic-a', wt);
  await startDaemon(d);
  try {
    const s = await createSession(d, { workdir: wt });
    const id = s.sessionId;
    const pid = Number(tmux(d, 'display-message', '-p', '#{pid}').stdout.trim());
    assert(pid > 1 && existsSync(d.socket), `tmux server of this daemon: pid ${pid}, socket ${existsSync(d.socket)}`);
    rmSync(d.socket); // someone cleaned up the temporary directory
    const r = await remove(d, wt);
    eq([r.status, r.json.error, r.json.endedSessions], [500, 'worktree_remove_failed', []], 'removing the worktree with its session, the socket file gone');
    assert(/socket/i.test(r.json.message) && /SIGUSR1/.test(r.json.message), `the message does not say what happened and what to do: ${r.json.message}`);
    eq(disk(repo, wt, 'topic-a'), { dir: true, listed: true, branch: true }, 'on disk after the refusal');
    assert((await sessions(d)).some((x) => x.id === id), 'the session left the daemon\'s list');
    try { process.kill(pid, 0); } catch { throw new Error('the tmux server is gone'); }
    // what the message says to do: SIGUSR1 makes this server create its socket again
    process.kill(pid, 'SIGUSR1');
    await waitFor(() => existsSync(d.socket), 5000, 'the socket file again');
    const again = await remove(d, wt);
    eq([again.status, again.json], [200, { removed: true, branchDeleted: false, endedSessions: [id] }], 'removing it once the socket is back');
    eq(disk(repo, wt, 'topic-a'), { dir: false, listed: false, branch: true }, 'on disk');
    assert(tmux(d, 'has-session', '-t', `vibe-remote-${id}`).status !== 0, 'the tmux session of the ended session still exists');
    return `socket gone: 500 "${r.json.message}", endedSessions [], directory, branch and session untouched; after SIGUSR1 to the server (pid of this run): 200 ${J(again.json)}`;
  } finally {
    await stopDaemon(d);
    tmux(d, 'kill-server');
  }
});

test('tmux: no tmux program on PATH but its socket is there', async () => {
  const d = defineDaemon('pathless');
  const repo = makeRepo(join(d.root, 'repo'));
  const wt = join(d.root, 'wt', 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'topic-a', wt);
  await startDaemon(d);
  try {
    const s = await createSession(d, { workdir: wt });
    const id = s.sessionId;
    // the same daemon, started again by something whose PATH has no tmux (launchd, systemd)
    await stopDaemon(d);
    assert(existsSync(d.socket) && tmux(d, 'has-session', '-t', `vibe-remote-${id}`).status === 0, 'the session did not survive the daemon');
    await startDaemon(d, PATH_NO_TMUX);
    const st = await status(d, wt);
    const r = await rest(d, 'POST', '/api/v1/worktrees/remove', { path: wt, head: st.json.head, sessions: st.json.sessions, branch: 'topic-a' });
    eq([r.status, r.json.error, r.json.endedSessions], [500, 'worktree_remove_failed', []], 'removing the worktree');
    assert(/tmux/i.test(r.json.message) && /socket/i.test(r.json.message), `the message does not say why: ${r.json.message}`);
    eq(disk(repo, wt, 'topic-a'), { dir: true, listed: true, branch: true }, 'on disk');
    assert(tmux(d, 'has-session', '-t', `vibe-remote-${id}`).status === 0, 'the tmux session was ended');
    return `status listed sessions ${J(st.json.sessions)}; remove: 500 "${r.json.message}", endedSessions [], directory, branch and the tmux session untouched`;
  } finally {
    await stopDaemon(d);
    tmux(d, 'kill-server');
  }
});

test('tmux: the server has exited and left its socket file', async () => {
  const d = defineDaemon('exited');
  const repo = makeRepo(join(d.root, 'repo'));
  const wt = join(d.root, 'wt', 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'topic-a', wt);
  await startDaemon(d);
  try {
    // the only session ends: the tmux server exits with it
    const s = await createSession(d, { workdir: repo });
    eq((await rest(d, 'DELETE', `/api/v1/sessions/${s.sessionId}`)).status, 204, 'deleting the only session');
    const answer = await waitFor(() => { const r = tmux(d, 'list-sessions'); return r.status !== 0 ? r.stderr.trim() : null; }, 8000, 'the tmux server to exit');
    const left = existsSync(d.socket);
    const r = await remove(d, wt);
    eq([r.status, r.json], [200, { removed: true, branchDeleted: false, endedSessions: [] }], 'removing a worktree without sessions');
    eq(disk(repo, wt, 'topic-a'), { dir: false, listed: false, branch: true }, 'on disk');
    return `tmux says "${answer.replaceAll(work, '<work>')}" (socket file ${left ? 'left behind' : 'gone'}): 200 ${J(r.json)}`;
  } finally {
    await stopDaemon(d);
    tmux(d, 'kill-server');
  }
});

test('a repository whose main directory git does not name (--separate-git-dir, a submodule)', async () => {
  const d = defineDaemon('single');
  // --separate-git-dir: `git worktree list` starts with the git directory, not the work tree
  const sep = join(d.root, 'sep');
  mkdirSync(sep, { recursive: true });
  git(d.root, 'init', '-q', '--separate-git-dir', join(d.root, 'sep.git'), sep);
  git(sep, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(join(sep, 'README.md'), 'sep\n');
  git(sep, 'add', 'README.md');
  git(sep, 'commit', '-q', '-m', 'init');
  // a submodule of another repository
  const lib = makeRepo(join(d.root, 'lib'));
  const sup = makeRepo(join(d.root, 'super'));
  git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'sub');
  git(sup, 'commit', '-q', '-m', 'add sub');
  const sub = join(sup, 'sub');
  await startDaemon(d);
  try {
    const a = (await createSession(d, { workdir: sep })).sessionId;
    const b = (await createSession(d, { workdir: sub })).sessionId;
    const tree = (await rest(d, 'GET', '/api/v1/projects')).json.projects;
    const out = [];
    for (const [dir, id, what] of [[sep, a, '--separate-git-dir'], [sub, b, 'submodule']]) {
      const p = tree.find((x) => x.id === dir);
      assert(p, `${what}: no project with the work tree as its id; projects are ${J(tree.map((x) => x.id.replace(d.root, '')))}`);
      eq([p.git, p.error ?? null, p.worktrees.map((w) => [w.path, w.main === true, w.sessions]), p.sessions], [true, null, [[dir, true, [id]]], []], `${what}: the project in /api/v1/projects`);
      // no named worktree can be started there, and the dialog can say so before anything is typed
      const plan = (await rest(d, 'GET', `/api/v1/worktrees/plan?workdir=${encodeURIComponent(dir)}&name=fix-login`)).json;
      eq([plan.ok, plan.error], [false, 'unsupported_repo'], `${what}: plan for a named worktree`);
      let refused = '';
      try { await createSession(d, { workdir: dir, mode: 'worktree', worktreeName: 'fix-login', newSessionId: newId() }); } catch (e) { refused = e.message.split(':')[0]; }
      eq(refused, 'create_failed', `${what}: creating a named worktree`);
      out.push(`${what}: one project, one worktree (main) holding the session; named worktree refused (unsupported_repo / create_failed)`);
    }
    assert(!existsSync(join(d.root, 'sep-worktrees')) && !existsSync(join(sup, 'sub-worktrees')), 'a refused create left a directory behind');
    // The old, nameless Worktree mode still works there; what it makes is a project of its own that the app cannot delete.
    const c = await createSession(d, { workdir: sep, mode: 'worktree' });
    const made = (await sessions(d)).find((s) => s.id === c.sessionId);
    assert(made.worktreeRoot && existsSync(made.worktreeRoot), `nameless worktree mode: ${J(made)}`);
    const after = (await rest(d, 'GET', '/api/v1/projects')).json.projects;
    const own = after.find((x) => x.id === made.worktreeRoot);
    assert(own, `the worktree made by the nameless mode is not a project of its own: ${J(after.map((x) => x.id.replace(d.root, '')))}`);
    eq(own.worktrees.map((w) => [w.path, w.main === true, w.sessions]), [[made.worktreeRoot, true, [c.sessionId]]], 'that project');
    const st = await status(d, made.worktreeRoot);
    const rm = await rest(d, 'POST', '/api/v1/worktrees/remove', { path: made.worktreeRoot, head: git(made.worktreeRoot, 'rev-parse', 'HEAD'), sessions: [c.sessionId] });
    assert((rm.status === 400 && rm.json.error === 'worktree_is_main') || (rm.status === 404 && rm.json.error === 'worktree_not_found'), `removing it: ${rm.status} ${rm.text}`);
    assert(existsSync(made.worktreeRoot) && (await sessions(d)).some((s) => s.id === c.sessionId), 'the refused removal touched the worktree or its session');
    out.push(`nameless worktree mode: ${made.worktreeRoot.replace(d.root, '<root>')} is its own project; status ${st.status}, remove ${rm.status} ${rm.json.error}`);
    return out.join('; ');
  } finally {
    await stopDaemon(d);
    tmux(d, 'kill-server');
  }
});

test('a terminal session from before the upgrade is counted and ended', async () => {
  const d = defineDaemon('legacy');
  const repo = makeRepo(join(d.root, 'repo'));
  const wt = join(d.root, 'wt', 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'topic-a', wt);
  // a session of an older vibe-remoted: the tmux session, and none of the @vibe_remote_* options
  const id = '1794824025040-12b763ac';
  const made = tmux(d, '-f', '/dev/null', 'new-session', '-d', '-s', `vibe-remote-${id}`, '-c', wt, '/bin/bash');
  assert(made.status === 0, `tmux new-session: ${made.stderr}`);
  await startDaemon(d);
  try {
    // straight to the worktree: no /api/v1/projects or /api/v1/sessions first
    const st = await status(d, wt);
    eq(st.status, 200, 'status');
    const counted = st.json.sessions.includes(id);
    const r = await rest(d, 'POST', '/api/v1/worktrees/remove', { path: wt, head: st.json.head, sessions: st.json.sessions, branch: 'topic-a' });
    const alive = tmux(d, 'has-session', '-t', `vibe-remote-${id}`).status === 0;
    const what = `status.sessions ${J(st.json.sessions)}; remove ${r.status} ${J(r.json)}; directory ${existsSync(wt) ? 'there' : 'gone'}, tmux session ${alive ? 'running' : 'ended'}`;
    assert(counted, `the old session is not among the worktree's sessions — ${what}`);
    eq([r.status, r.json.endedSessions, existsSync(wt), alive], [200, [id], false, false], `removing the worktree (${what})`);
    return what;
  } finally {
    await stopDaemon(d);
    tmux(d, 'kill-server');
  }
});

// --- Run ------------------------------------------------------------------------

async function main() {
  mkdirSync(binDir, { recursive: true });
  for (const [out, pkg] of [[daemonBin, './cmd/vibe-remoted'], [claudeBin, './internal/chat/fakeclaude']]) {
    if (out === daemonBin && process.env.VR_DAEMON) { copyFileSync(resolve(process.env.VR_DAEMON), daemonBin); continue; }
    const r = spawnSync('go', ['build', '-o', out, pkg], { cwd: join(ROOT, 'vibe-remoted'), stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`go build ${pkg} failed`);
  }
  say(`git: ${spawnSync(GIT, ['--version'], { encoding: 'utf-8' }).stdout.trim()} (${process.env.VR_GIT ? 'VR_GIT' : 'the one on PATH'}); tmux: ${spawnSync(TMUX, ['-V'], { encoding: 'utf-8' }).stdout.trim()}`);
  for (const c of cases) {
    if (ONLY && !c.name.includes(ONLY)) continue;
    try {
      pass(c.name, await c.fn());
    } catch (e) {
      fail(c.name, e.message.split('\n')[0]);
    }
  }
}

async function cleanup() {
  for (const d of running) {
    await stopDaemon(d);
    tmux(d, 'kill-server');
  }
  if (process.env.VR_EVIDENCE) writeFileSync(process.env.VR_EVIDENCE, lines.join('\n').replaceAll(work, '<work>') + '\n');
  rmSync(work, { recursive: true, force: true });
}

main()
  .catch((e) => fail('setup', e.message))
  .finally(async () => {
    await cleanup();
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall worktree checks passed');
    process.exit(failures ? 1 : 0);
  });
