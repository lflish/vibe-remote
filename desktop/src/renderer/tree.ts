// tree.ts — pure functions that merge the daemon's project tree (GET
// /api/v1/projects) with the session list into the three-level model the
// sidebar renders. No DOM here (design 4.10). When the daemon is too old to
// serve /api/v1/projects (projects === null) the same model is rebuilt from
// session fields alone (legacy grouping).
import type { Project, ProjectWorktree, SessionInfo } from '../shared/protocol';
import type { Dot } from './chat/activity';

export interface TreeSession {
  id: string;
  info: SessionInfo;
  name: string;
  gone: boolean;
}

export interface TreeWorktree {
  path: string;
  label: string;
  branch?: string;
  detached: boolean;
  main: boolean;
  managed: boolean;
  sessions: TreeSession[];
}

export interface TreeProject {
  id: string;
  name: string;
  git: boolean;
  flat: boolean;
  branchLabel?: string;
  error?: { code: string; message: string };
  worktrees: TreeWorktree[];
  sessions: TreeSession[];
}

export type Capability = 'v4' | 'legacy' | 'unknown';

// --- intermediate (id-only) structures, converted to Tree* at the end so name
// de-duplication runs once per group over the final session order. ---
interface IWorktree {
  path: string;
  branch?: string;
  head: string;
  detached: boolean;
  main: boolean;
  managed: boolean;
  ids: string[];
}
interface IProject {
  id: string;
  name: string;
  git: boolean;
  error?: { code: string; message: string };
  worktrees: IWorktree[];
  sessionIds: string[];
  fromDaemon: boolean;
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

// The base display name for a session before duplicate numbering.
function baseName(info: SessionInfo): string {
  return info.title || (info.workdir ? basename(info.workdir) : '') || info.id;
}

function underOrEqual(path: string, root: string): boolean {
  return path === root || path.startsWith(root + '/');
}

export function buildTree(sessions: SessionInfo[], projects: Project[] | null): TreeProject[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const iprojects: IProject[] = [];

  if (projects) {
    // New daemon: follow daemon order; resolve referenced sessions, skip stale.
    const placed = new Set<string>();
    for (const p of projects) {
      const ip: IProject = {
        id: p.id,
        name: p.name,
        git: p.git,
        error: p.error ? { code: p.error, message: p.errorMessage ?? '' } : undefined,
        worktrees: [],
        sessionIds: [],
        fromDaemon: true,
      };
      for (const w of p.worktrees) {
        const iw: IWorktree = {
          path: w.path,
          branch: w.branch,
          head: w.head,
          detached: !!w.detached,
          main: !!w.main,
          managed: !!w.managed,
          ids: [],
        };
        for (const id of w.sessions) {
          if (byId.has(id)) { iw.ids.push(id); placed.add(id); }
        }
        ip.worktrees.push(iw);
      }
      for (const id of p.sessions) {
        if (byId.has(id)) { ip.sessionIds.push(id); placed.add(id); }
      }
      iprojects.push(ip);
    }
    // Sessions the daemon tree did not reference (created between the two
    // requests) are placed by the legacy rule, merged into the existing tree.
    const leftover = sessions.filter((s) => !placed.has(s.id));
    legacyPlace(iprojects, leftover, byId);
  } else {
    // Old daemon: rebuild from session fields, then sort per design 4.2.
    legacyPlace(iprojects, sessions, byId);
    sortLegacy(iprojects, byId);
  }

  return iprojects.map((ip) => finalizeProject(ip, byId));
}

// legacyPlace groups sessions by their own fields (design 4.10 legacy rule). It
// mutates `iprojects` in place, so it also serves to merge new-daemon leftovers.
function legacyPlace(iprojects: IProject[], sessions: SessionInfo[], byId: Map<string, SessionInfo>): void {
  const findProject = (id: string) => iprojects.find((p) => p.id === id);
  const ensureProject = (id: string, git: boolean) => {
    let p = findProject(id);
    if (!p) {
      p = { id, name: basename(id), git, worktrees: [], sessionIds: [], fromDaemon: false };
      iprojects.push(p);
    }
    if (git) p.git = true;
    return p;
  };

  const placedHere = new Set<string>();
  // Pass 1: worktree-mode sessions establish git projects and worktree rows.
  for (const s of sessions) {
    if (s.mode === 'worktree' && s.sourceRepo && s.worktreeRoot) {
      const p = ensureProject(s.sourceRepo, true);
      let wt = p.worktrees.find((w) => w.path === s.worktreeRoot);
      if (!wt) {
        wt = { path: s.worktreeRoot, branch: s.branch, head: '', detached: false, main: false, managed: true, ids: [] };
        p.worktrees.push(wt);
      }
      wt.ids.push(s.id);
      placedHere.add(s.id);
    }
  }
  // Pass 2: the rest, matched against all known worktree roots and project ids.
  for (const s of sessions) {
    if (placedHere.has(s.id)) continue;
    const wd = s.workdir;
    // Longest matching worktree root wins (sub-worktree over main).
    let best: IWorktree | null = null;
    for (const p of iprojects) {
      for (const w of p.worktrees) {
        if (underOrEqual(wd, w.path) && (!best || w.path.length > best.path.length)) best = w;
      }
    }
    if (best) { best.ids.push(s.id); continue; }
    // Then by the id of a git project (its main row). A plain folder takes only
    // the sessions started in the folder itself, further down: were it to
    // catch its subfolders too, the grouping would depend on the order the
    // sessions are listed in, which a protocol 3 daemon changes on every poll.
    let bestProj: IProject | null = null;
    for (const p of iprojects) {
      if (p.git && underOrEqual(wd, p.id) && (!bestProj || p.id.length > bestProj.id.length)) bestProj = p;
    }
    if (bestProj) {
      let main = bestProj.worktrees.find((w) => w.main) ?? bestProj.worktrees.find((w) => w.path === bestProj!.id);
      if (!main) {
        main = { path: bestProj.id, branch: undefined, head: '', detached: false, main: true, managed: false, ids: [] };
        bestProj.worktrees.push(main);
      }
      main.ids.push(s.id);
      continue;
    }
    // Otherwise the session's workdir is its own (non-git) project.
    ensureProject(wd, false).sessionIds.push(s.id);
  }
}

function worktreeLabel(w: Pick<IWorktree, 'branch' | 'head' | 'detached'>): string {
  if (!w.detached && w.branch) return w.branch;
  return w.head ?? '';
}

function sortLegacy(iprojects: IProject[], byId: Map<string, SessionInfo>): void {
  const createdOf = (id: string) => byId.get(id)?.created ?? '';
  const sortIds = (ids: string[]) =>
    ids.sort((a, b) => createdOf(a).localeCompare(createdOf(b)) || a.localeCompare(b));
  iprojects.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
  for (const p of iprojects) {
    p.worktrees.sort((a, b) => {
      if (a.main !== b.main) return a.main ? -1 : 1;
      if (a.detached !== b.detached) return a.detached ? 1 : -1;
      const ka = a.detached ? a.head : worktreeLabel(a);
      const kb = b.detached ? b.head : worktreeLabel(b);
      return ka.localeCompare(kb) || a.path.localeCompare(b.path);
    });
    for (const w of p.worktrees) sortIds(w.ids);
    sortIds(p.sessionIds);
  }
}

function finalizeProject(ip: IProject, byId: Map<string, SessionInfo>): TreeProject {
  const worktrees = ip.worktrees.map((w) => ({
    path: w.path,
    label: worktreeLabel(w),
    branch: w.branch,
    detached: w.detached,
    main: w.main,
    managed: w.managed,
    sessions: nameSessions(w.ids, byId, false),
  }));
  // A git project is flat with 0 or 1 worktree; a non-git project is always
  // flat (design 4.10). gone sessions live at the project level of a git
  // project with no error.
  const flat = !ip.git || worktrees.length <= 1;
  const branchLabel = ip.git && worktrees.length === 1 ? worktrees[0].label : undefined;
  const gone = ip.git && !ip.error;
  return {
    id: ip.id,
    name: ip.name,
    git: ip.git,
    flat,
    branchLabel,
    error: ip.error,
    worktrees,
    sessions: nameSessions(ip.sessionIds, byId, gone),
  };
}

// nameSessions resolves ids to TreeSessions, numbering duplicate base names in
// order within this one group (design 4.10: fix-login, fix-login 2, …).
function nameSessions(ids: string[], byId: Map<string, SessionInfo>, gone: boolean): TreeSession[] {
  const counts = new Map<string, number>();
  const out: TreeSession[] = [];
  for (const id of ids) {
    const info = byId.get(id);
    if (!info) continue;
    const base = baseName(info);
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    out.push({ id, info, name: n === 1 ? base : `${base} ${n}`, gone });
  }
  return out;
}

// visibleSessions lists sessions top-to-bottom as the sidebar shows them, across
// machines, skipping collapsed machines and collapsed projects (design 6.5).
export function visibleSessions(
  machines: { key: string; collapsed: boolean; tree: TreeProject[] }[],
  collapsedProjects: Set<string>,
): { machineKey: string; id: string }[] {
  const out: { machineKey: string; id: string }[] = [];
  for (const m of machines) {
    if (m.collapsed) continue;
    for (const p of m.tree) {
      if (collapsedProjects.has(`${m.key}|${p.id}`)) continue;
      for (const w of p.worktrees) for (const s of w.sessions) out.push({ machineKey: m.key, id: s.id });
      for (const s of p.sessions) out.push({ machineKey: m.key, id: s.id });
    }
  }
  return out;
}

// projectRollup returns 'waiting' if any session in the project needs the user,
// else 'none' (collapsed-project dot, R1.6 / d11).
export function projectRollup(project: TreeProject, dotOf: (id: string) => Dot): 'waiting' | 'none' {
  const any = (list: TreeSession[]) => list.some((s) => dotOf(s.id) === 'waiting');
  if (project.worktrees.some((w) => any(w.sessions))) return 'waiting';
  return any(project.sessions) ? 'waiting' : 'none';
}

export function sessionContext(
  tree: TreeProject[],
  id: string,
): { project: string; branch?: string; name: string } | null {
  for (const p of tree) {
    for (const w of p.worktrees) {
      const s = w.sessions.find((x) => x.id === id);
      if (s) return { project: p.name, branch: p.git ? w.label : undefined, name: s.name };
    }
    const s = p.sessions.find((x) => x.id === id);
    if (s) return { project: p.name, branch: p.git ? p.branchLabel : undefined, name: s.name };
  }
  return null;
}

export function notificationTitle(
  machineName: string,
  ctx: { project: string; branch?: string; name: string },
): string {
  const mid = ctx.branch ? `${ctx.project} / ${ctx.branch}` : ctx.project;
  return `${machineName} · ${mid} · ${ctx.name}`;
}

export function nextCapability(prev: Capability, result: Project[] | null | Error): Capability {
  if (Array.isArray(result)) return 'v4';
  if (result === null) return 'legacy';
  return prev;
}

// projectHue: FNV-1a 32-bit hash over UTF-16 code units, mod 360 (design 4.10).
export function projectHue(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 360;
}

// countActiveSessionsAt: sessions whose workdir equals dir and are not ended
// (the -c continue note, d24).
export function countActiveSessionsAt(sessions: SessionInfo[], dir: string): number {
  return sessions.filter((s) => s.workdir === dir && s.state !== 'ended').length;
}
