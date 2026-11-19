// Throwaway daemons built from the verify worktree; everything under one /tmp dir.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';

const SRC = '/Users/mac/github/vibe-remote/.devflow-tmp/verify-482ab63';
const BASE = fs.mkdtempSync('/tmp/vr-v2e-');
fs.appendFileSync('/tmp/vr-v2-work/tmpdirs', BASE + '\n');
const real = fs.realpathSync(BASE);
const bin = path.join(real, 'bin'); fs.mkdirSync(bin);
const roots = path.join(real, 'roots'); fs.mkdirSync(roots);
const outside = path.join(real, 'outside'); fs.mkdirSync(outside);
const log = (...a) => console.log(...a);
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@example.com'); git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'README'), 'initial\n'); git(dir, 'add', 'README'); git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}
execFileSync('go', ['build', '-o', path.join(bin, 'vibe-remoted'), './cmd/vibe-remoted'], { cwd: path.join(SRC, 'vibe-remoted'), stdio: 'inherit' });
log('daemon built from', execFileSync('git', ['-C', SRC, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const procs = [];
async function startDaemon(name, extraEnv = {}) {
  const port = await freePort();
  if (port === 8765) throw new Error('refusing 8765');
  const token = crypto.randomBytes(32).toString('hex');
  const dir = path.join(real, name); fs.mkdirSync(dir);
  const tmuxDir = fs.mkdtempSync('/tmp/vr-v2t-'); fs.appendFileSync('/tmp/vr-v2-work/tmuxdirs', tmuxDir + '\n');
  const claudeDir = path.join(dir, 'claude'); fs.mkdirSync(claudeDir);
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ bind_addr: '127.0.0.1', port, token, default_workdir: roots, allowed_roots: [roots], use_tmux: true, claude_cmd: '/bin/bash', claude_reload_cmd: '/bin/bash', state_dir: path.join(dir, 'state') }), { mode: 0o600 });
  const env = { ...process.env, TMUX_TMPDIR: tmuxDir, CLAUDE_CONFIG_DIR: claudeDir, ...extraEnv };
  delete env.TMUX; delete env.VIBE_REMOTED_TOKEN; delete env.VIBE_REMOTED_BIND_ADDR;
  const out = fs.openSync(path.join(dir, 'daemon.log'), 'w');
  const p = spawn(path.join(bin, 'vibe-remoted'), ['--config', cfg], { env, stdio: ['ignore', out, out] });
  procs.push({ p, tmuxDir });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  const H = { Authorization: 'Bearer ' + token };
  const get = async (p) => { const r = await fetch(base + p, { headers: H }); return { status: r.status, body: await r.text() }; };
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.text() }; };
  const attach = (frame) => new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); let done = false;
    const finish = (v) => { if (!done) { done = true; res({ ...v, ws }); } };
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'auth', token })); ws.send(JSON.stringify({ type: 'attach', sessionId: '', cols: 80, rows: 24, ...frame })); };
    ws.onmessage = (ev) => { const f = JSON.parse(ev.data); if (f.type === 'ready' || f.type === 'error') finish({ frame: f }); };
    ws.onclose = () => finish({ frame: { type: 'closed' } });
    setTimeout(() => finish({ frame: { type: 'timeout' } }), 20000);
  });
  return { name, port, token, dir, tmuxDir, claudeDir, get, post, attach, base, logFile: path.join(dir, 'daemon.log') };
}
const q = encodeURIComponent;
const newId = () => `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const disk = (r) => ({ worktrees: git(r, 'worktree', 'list', '--porcelain').split('\n\n').map((b) => b.replace(/\n/g, ' | ')), branches: git(r, 'for-each-ref', '--format=%(refname:short) %(objectname:short)', 'refs/heads') .split('\n') });

try {
  const d = await startDaemon('d1');
  // ---- X15 -------------------------------------------------------------
  log('\n== X15: GET /api/v1/worktrees/plan');
  const r1 = repo(path.join(roots, 'plain'));
  fs.writeFileSync(path.join(roots, 'afile'), 'x');
  fs.symlinkSync(path.join(outside, 'gone'), path.join(roots, 'dangling'));
  fs.symlinkSync(outside, path.join(roots, 'out'));
  fs.mkdirSync(path.join(outside, 'there'));
  const cases = {
    'missing, in the allowed root': path.join(roots, 'missing'),
    'missing, inside a repository': path.join(r1, 'no', 'such'),
    'a file': path.join(roots, 'afile'),
    'under a file': path.join(roots, 'afile', 'x'),
    'outside, existing': path.join(outside, 'there'),
    'outside, missing': path.join(outside, 'nope'),
    'dot-dot to outside, existing': path.join(roots) + '/../outside/there',
    'dot-dot to outside, missing': path.join(roots) + '/../outside/nope',
    'dangling link': path.join(roots, 'dangling'),
    'link out of the roots, existing target': path.join(roots, 'out', 'there'),
    'link out of the roots, missing target': path.join(roots, 'out', 'nope'),
    'relative': 'roots/missing',
    'existing repository': r1,
  };
  for (const [name, p] of Object.entries(cases)) {
    const r = await d.get(`/api/v1/worktrees/plan?workdir=${q(p)}&name=fix-login`);
    log(`  ${name}: ${r.status} ${r.body.trim().replaceAll(real, '<base>').slice(0, 160)}`);
  }
  const r0 = await d.get('/api/v1/worktrees/plan?name=x'); log(`  no workdir: ${r0.status} ${r0.body.trim()}`);
  const noTok = await fetch(d.base + `/api/v1/worktrees/plan?workdir=${q(r1)}&name=x`); log(`  no token: ${noTok.status}`);

  // ---- post-checkout hook fails -----------------------------------------
  log('\n== d70: post-checkout hook exits non-zero');
  const hooked = repo(path.join(roots, 'hooked'));
  const hook = path.join(hooked, '.git', 'hooks', 'post-checkout');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\necho 'This repository is configured for Git LFS but git-lfs was not found on your path' >&2\nexit 2\n", { mode: 0o755 });
  const target = path.join(roots, 'hooked-worktrees', 'fix-login');
  let plan = await d.get(`/api/v1/worktrees/plan?workdir=${q(hooked)}&name=fix-login`);
  log('  plan before:', plan.status, plan.body.trim().replaceAll(real, '<base>'));
  const id1 = newId();
  let a = await d.attach({ newSessionId: id1, workdir: hooked, mode: 'worktree', worktreeName: 'fix-login' });
  log('  attach #1 →', JSON.stringify(a.frame).replaceAll(real, '<base>')); a.ws.close();
  log('  disk:', JSON.stringify(disk(hooked)).replaceAll(real, '<base>'), 'dir exists:', fs.existsSync(target), fs.existsSync(target) ? fs.readdirSync(target) : '');
  let sessions = await d.get('/api/v1/sessions'); log('  sessions:', sessions.body.trim());
  let projects = JSON.parse((await d.get('/api/v1/projects')).body);
  log('  projects:', JSON.stringify(projects.projects.filter((p) => p.name === 'hooked')).replaceAll(real, '<base>'));
  plan = await d.get(`/api/v1/worktrees/plan?workdir=${q(hooked)}&name=fix-login`);
  log('  plan for the same name again:', plan.status, plan.body.trim().replaceAll(real, '<base>'));
  a = await d.attach({ newSessionId: id1, workdir: hooked, mode: 'worktree', worktreeName: 'fix-login' });
  log('  replay with the same newSessionId →', JSON.stringify(a.frame).replaceAll(real, '<base>')); a.ws.close();
  a = await d.attach({ newSessionId: newId(), workdir: hooked, mode: 'worktree', worktreeName: 'fix-login' });
  log('  attach #2 (new id, same name) →', JSON.stringify(a.frame).replaceAll(real, '<base>')); a.ws.close();
  a = await d.attach({ newSessionId: newId(), workdir: hooked, mode: 'worktree', worktreeName: 'second' });
  log('  attach #3 (another name) →', JSON.stringify(a.frame).replaceAll(real, '<base>').slice(0, 300)); a.ws.close();
  log('  disk:', JSON.stringify(disk(hooked)).replaceAll(real, '<base>'));
  // remove the leftovers through the interface
  for (const name of ['fix-login', 'second']) {
    const p = path.join(roots, 'hooked-worktrees', name);
    const st = await d.get(`/api/v1/worktrees/status?path=${q(p)}`);
    log(`  status of leftover ${name}:`, st.status, st.body.trim().replaceAll(real, '<base>'));
    if (st.status === 200) {
      const s = JSON.parse(st.body);
      const rm = await d.post('/api/v1/worktrees/remove', { path: p, head: s.head, sessions: s.sessions });
      log(`  remove leftover ${name}:`, rm.status, rm.body.trim().replaceAll(real, '<base>'), 'dir exists:', fs.existsSync(p));
    }
  }
  log('  disk after removing the leftovers:', JSON.stringify(disk(hooked)).replaceAll(real, '<base>'));
  fs.rmSync(hook);
  a = await d.attach({ newSessionId: newId(), workdir: hooked, mode: 'worktree', worktreeName: 'fix-login' });
  log('  attach with the hook gone →', a.frame.type, a.frame.code || '', (a.frame.workdir || '').replaceAll(real, '<base>'));
  if (a.frame.type === 'ready') await fetch(d.base + '/api/v1/sessions/' + a.frame.sessionId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + d.token } });
  a.ws.close();
  log('  disk:', JSON.stringify(disk(hooked)).replaceAll(real, '<base>'));
  fs.writeFileSync('/tmp/vr-v2-work/d1.env', `PORT=${d.port}\nROOTS=${roots}\n`);
  fs.writeFileSync('/tmp/vr-v2-work/d1.token', d.token, { mode: 0o600 });

  // ---- ws-smoke against this daemon --------------------------------------
  log('\n== ws-smoke.mjs against the throwaway daemon');
  try {
    const out = execFileSync('node', [path.join(SRC, '.claude/skills/verify/scripts/ws-smoke.mjs'), `127.0.0.1:${d.port}`, roots], { env: { ...process.env, VR_TOKEN: d.token }, encoding: 'utf8' });
    log(out.trim()); log('  ws-smoke exit=0');
  } catch (e) { log((e.stdout || '') + (e.stderr || '')); log('  ws-smoke exit=' + e.status); }

  // ---- fallback list (git without -z) + newline path, through REST --------
  log('\n== git without `worktree list -z` + a worktree path with a newline, through the daemon');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const fakeDir = path.join(real, 'oldgit'); fs.mkdirSync(fakeDir);
  fs.writeFileSync(path.join(fakeDir, 'git'), `#!/bin/sh\nwt=0; ls=0; z=0\nfor a in "$@"; do\n [ "$a" = worktree ] && wt=1\n [ "$a" = list ] && ls=1\n [ "$a" = -z ] && z=1\ndone\nif [ $wt = 1 ] && [ $ls = 1 ] && [ $z = 1 ]; then echo "error: unknown switch 'z'" >&2; exit 129; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const d2 = await startDaemon('d2', { PATH: fakeDir + ':' + process.env.PATH });
  const trusted = repo(path.join(roots, 'trusted'));
  const cont = path.join(roots, 'trusted-worktrees'); fs.mkdirSync(cont);
  const realWt = path.join(cont, 'a\nfoo');
  git(trusted, 'worktree', 'add', '-q', '-b', 'nl', realWt);
  const victim = path.join(cont, 'a'); fs.mkdirSync(path.join(victim, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(victim, '.claude', 'settings.json'), '{"hooks":{}}');
  const admin = fs.readdirSync(path.join(trusted, '.git', 'worktrees'))[0];
  fs.writeFileSync(path.join(victim, '.git'), `gitdir: ${path.join(trusted, '.git', 'worktrees', admin)}\n`);
  for (const dd of [d, d2]) fs.writeFileSync(path.join(dd.claudeDir, '.claude.json'), JSON.stringify({ projects: { [trusted]: { hasTrustDialogAccepted: true } } }));
  for (const [label, dd] of [['real git 2.50.1 (-z)', d], ['git without -z (fallback)', d2]]) {
    // a session in the trusted repo so that the project is listed
    const s = await dd.attach({ newSessionId: newId(), workdir: trusted });
    const pr = JSON.parse((await dd.get('/api/v1/projects')).body).projects.find((p) => p.name === 'trusted');
    log(`  [${label}] project tree rows:`, JSON.stringify((pr?.worktrees || []).map((w) => ({ path: w.path, branch: w.branch, main: w.main }))).replaceAll(real, '<base>'));
    const fsr = await dd.get(`/api/v1/fs?path=${q(victim)}`);
    let trust = ''; try { trust = JSON.parse(fsr.body).chatTrust; } catch {}
    log(`  [${label}] GET /api/v1/fs?path=<…/trusted-worktrees/a> (NOT a worktree): ${fsr.status} chatTrust=${JSON.stringify(trust)}`);
    const st = await dd.get(`/api/v1/worktrees/status?path=${q(victim)}`);
    log(`  [${label}] worktrees/status of that directory: ${st.status} ${st.body.trim().replaceAll(real, '<base>').slice(0, 260)}`);
    const st2 = await dd.get(`/api/v1/worktrees/status?path=${q(realWt)}`);
    log(`  [${label}] worktrees/status of the real worktree (path with a newline): ${st2.status} ${st2.body.trim().replaceAll(real, '<base>').slice(0, 200)}`);
    if (s.frame.type === 'ready') await fetch(dd.base + '/api/v1/sessions/' + s.frame.sessionId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + dd.token } });
    s.ws.close();
  }
} finally {
  for (const { p, tmuxDir } of procs) {
    p.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    try { execFileSync('tmux', ['-L', 'vibe-remote', 'kill-server'], { env: { ...process.env, TMUX_TMPDIR: tmuxDir, TMUX: '' }, stdio: 'ignore' }); } catch {}
    fs.rmSync(tmuxDir, { recursive: true, force: true });
  }
  try { fs.rmSync('/tmp/vr-v2-work/d1.token', { force: true }); } catch {}
  fs.rmSync(BASE, { recursive: true, force: true });
  log('\ncleanup: daemons stopped, tmux servers of their own socket dirs killed, ' + BASE + ' removed');
}
