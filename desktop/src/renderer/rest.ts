import type { MachineConfig, Project, ProjectsResponse, SessionInfo, WorktreePlan, WorktreeRemoveRequest, WorktreeRemoveResult, WorktreeStatus } from '../shared/protocol';
import { t } from './i18n';

// Every REST call gets a deadline. Without one, a black-holed host (daemon
// gone, route still up) leaves the fetch pending forever: the 5s sidebar poll
// then never records a failure, never backs off, and stacks another hung
// request on every tick.
const REQUEST_TIMEOUT_MS = 8000;

export function timedFetch(input: string, init: RequestInit = {}, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Deadline for removing a worktree that has `sessionCount` sessions. The daemon
 * ends them one by one (a chat process takes up to about 4 s to stop) and a
 * large directory takes time to delete, so the usual deadline is too short.
 */
export function removeTimeoutMs(sessionCount: number): number {
  return Math.min(60_000, 10_000 + 5_000 * sessionCount);
}

/**
 * REST client for a vibe-remoted instance. Complements the WebSocket connection
 * with the auxiliary HTTP endpoints (info, sessions list, delete, fs browse).
 */
export class VibeRemoteRest {
  constructor(private machine: MachineConfig) {}

  private base(): string {
    return `http://${this.machine.addr}:${this.machine.port}`;
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.machine.token}` };
  }

  /** `recheck` makes the daemon probe claude's version again ("upgraded, check again"). */
  async info(opts?: { recheck?: boolean }): Promise<MachineInfo> {
    const query = opts?.recheck ? '?recheck=1' : '';
    const res = await timedFetch(`${this.base()}/api/v1/info${query}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`info failed: ${res.status}`);
    return res.json();
  }

  async listSessions(): Promise<SessionInfo[]> {
    const res = await timedFetch(`${this.base()}/api/v1/sessions`, { headers: this.headers() });
    if (!res.ok) throw new Error(`sessions failed: ${res.status}`);
    const data = await res.json();
    return data.list || [];
  }

  async deleteSession(id: string): Promise<void> {
    const res = await timedFetch(`${this.base()}/api/v1/sessions/${id}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 204) {
      let details: { error?: string; message?: string; worktreeRoot?: string; branch?: string } = {};
      try { details = await res.json(); } catch { /* non-JSON response */ }
      throw new DeleteSessionError(res.status, details.error || `delete failed: ${res.status}`, details.message, details.worktreeRoot, details.branch);
    }
  }

  /**
   * Fetch the project tree (v4). An old daemon has no such route and answers
   * 404, which maps to null so the caller can fall back to session grouping;
   * any other non-2xx throws a RestError. A 200 whose body has no `projects`
   * array is not what the protocol defines and throws as well (a plain Error):
   * read as an empty tree it would empty the sidebar. The caller treats it
   * like any failed request and keeps what it had.
   */
  async listProjects(): Promise<Project[] | null> {
    const res = await timedFetch(`${this.base()}/api/v1/projects`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw await RestError.from(res);
    const body = await res.json() as Partial<ProjectsResponse> | null;
    if (!body || !Array.isArray(body.projects)) throw new Error('projects: the response has no project list');
    return body.projects;
  }

  /** Remove a project from the list (the disk is untouched). */
  async removeProject(id: string): Promise<void> {
    const res = await timedFetch(`${this.base()}/api/v1/projects/remove`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok && res.status !== 204) throw await RestError.from(res);
  }

  async renameSession(id: string, name: string): Promise<void> {
    const res = await timedFetch(`${this.base()}/api/v1/sessions/${id}/rename`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok && res.status !== 204) throw new Error(`rename failed: ${res.status}`);
  }

  async reloadSession(id: string): Promise<void> {
    const res = await timedFetch(`${this.base()}/api/v1/sessions/${id}/reload`, {
      method: 'POST',
      headers: this.headers(),
    });
    // 204 = terminal reloaded; 202 = chat reload accepted, its outcome comes
    // as chat_state (d10).
    if (!res.ok && res.status !== 204) {
      let message = `reload failed: ${res.status}`;
      let owner: string | undefined;
      try {
        const details = await res.json() as { error?: string; owner?: string };
        if (details.error) message = details.error;
        owner = details.owner;
      } catch { /* non-JSON response */ }
      throw new ReloadSessionError(res.status, message, owner);
    }
  }

  /**
   * Read-only pre-check for a new worktree named `name` created from `workdir`
   * (v4). A name that cannot be used is a normal answer (`ok: false` with the
   * reason); only an HTTP failure throws (RestError).
   */
  async planWorktree(workdir: string, name: string): Promise<WorktreePlan> {
    const url = new URL(`${this.base()}/api/v1/worktrees/plan`);
    url.searchParams.set('workdir', workdir);
    url.searchParams.set('name', name);
    const res = await timedFetch(url.toString(), { headers: this.headers() });
    if (!res.ok) throw await RestError.from(res);
    return res.json();
  }

  /**
   * The state of a worktree (v4): what the delete confirmation shows. Throws a
   * RestError; 404 `worktree_not_found` when it is no longer there.
   */
  async worktreeStatus(path: string): Promise<WorktreeStatus> {
    const url = new URL(`${this.base()}/api/v1/worktrees/status`);
    url.searchParams.set('path', path);
    const res = await timedFetch(url.toString(), { headers: this.headers() });
    if (!res.ok) throw await RestError.from(res);
    return res.json();
  }

  /**
   * Remove a worktree (v4). `req` carries what the user saw (head, sessions,
   * branch) and agreed to. A refusal is a RestError whose body has `endedSessions`
   * for 409 `worktree_changed` (with the current `status`) and 500
   * `worktree_remove_failed`. A timeout or network failure is not a RestError:
   * the daemon carries the removal through regardless, so the outcome is then
   * unknown, not negative.
   */
  async removeWorktree(req: WorktreeRemoveRequest): Promise<WorktreeRemoveResult> {
    const res = await timedFetch(`${this.base()}/api/v1/worktrees/remove`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    }, removeTimeoutMs(req.sessions.length));
    if (!res.ok) throw await RestError.from(res);
    return res.json();
  }

  /** List directory entries (directories only) for the remote picker. */
  async listDir(path?: string): Promise<DirListing> {
    const url = new URL(`${this.base()}/api/v1/fs`);
    if (path) url.searchParams.set('path', path);
    const res = await timedFetch(url.toString(), { headers: this.headers() });
    if (!res.ok) {
      // Prefer the server's reason ("path not in allowed roots") over a bare
      // status code, which told the user nothing actionable.
      let message = res.status === 403 ? t('picker.outsideRoots') : `fs failed: ${res.status}`;
      try {
        const details = await res.json() as { error?: string };
        if (details.error && res.status !== 403) message = details.error;
      } catch { /* non-JSON response */ }
      throw new Error(message);
    }
    return res.json();
  }
}

/** `message` is the daemon's error code (e.g. claude_session_busy); `owner` names the session holding the conversation. */
export class ReloadSessionError extends Error {
  constructor(public status: number, message: string, public owner?: string) {
    super(message);
    this.name = 'ReloadSessionError';
  }
}

export class DeleteSessionError extends Error {
  constructor(public status: number, public code: string, public detail?: string, public worktreeRoot?: string, public branch?: string) {
    super(detail || code);
    this.name = 'DeleteSessionError';
  }
}

/**
 * A non-2xx response from a v4 project/worktree endpoint. `code` is the
 * daemon's error code (e.g. project_has_sessions); timeouts and network
 * failures are not RestErrors.
 */
export class RestError extends Error {
  constructor(public status: number, public code: string, public body: unknown) {
    super(code || `request failed: ${status}`);
    this.name = 'RestError';
  }

  static async from(res: Response): Promise<RestError> {
    let body: unknown = undefined;
    let code = `request failed: ${res.status}`;
    try {
      body = await res.json();
      if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
        code = (body as { error: string }).error;
      }
    } catch { /* non-JSON response */ }
    return new RestError(res.status, code, body);
  }
}
export interface ClaudeFlagInfo {
  id: string;
  label: string;
  default?: boolean;
}

export interface MachineInfo {
  hostname: string;
  tmux_enabled: boolean;
  default_workdir: string;
  allowed_roots: string[];
  claude_flags?: ClaudeFlagInfo[];
  /** Daemon build version (e.g. "v0.1.4" or "dev"). Absent on older daemons. */
  version?: string;
  /** Daemon protocol version (protocol.Version). Absent on daemons older than 2. */
  proto?: number;
  /** Chat UI availability (v3). Absent on older daemons: treat as "upgrade vibe-remoted". */
  chat?: ChatInfo;
}

export type ChatUnsupportedReason =
  | 'not_claude'
  | 'shell_syntax'
  | 'conflicting_args'
  | 'claude_not_found'
  | 'claude_too_old'
  | 'state_dir_unwritable'
  | 'workdir_untrusted';

export interface ChatInfo {
  supported: boolean;
  reason?: ChatUnsupportedReason | string;
  /** Empty while the daemon has not determined the version yet. */
  claudeVersion?: string;
  minClaudeVersion: string;
}

export type ChatTrust = 'trusted' | 'untrusted' | 'unknown';

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  entries: DirEntry[];
  /**
   * Canonical parent path, or empty/absent when `path` is already at an
   * allowed root. The server decides this because allowed_roots are configured
   * pre-symlink-resolution while `path` is canonical, so the client cannot
   * compare them reliably. Absent on older daemons — treat as "unknown".
   */
  parent?: string;
  /**
   * Whether a chat session may start in `path` (v3): claude trusts it, or (v4)
   * it is a worktree root of a repository whose main directory claude trusts.
   * Only 'trusted' allows a chat session.
   */
  chatTrust?: ChatTrust;
}
