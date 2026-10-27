import type { MachineConfig, SessionInfo } from '../shared/protocol';
import { t } from './i18n';

// Every REST call gets a deadline. Without one, a black-holed host (daemon
// gone, route still up) leaves the fetch pending forever: the 5s sidebar poll
// then never records a failure, never backs off, and stacks another hung
// request on every tick.
const REQUEST_TIMEOUT_MS = 8000;

export function timedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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

  async info(): Promise<MachineInfo> {
    const res = await timedFetch(`${this.base()}/api/v1/info`, { headers: this.headers() });
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
    if (!res.ok && res.status !== 204) {
      let message = `reload failed: ${res.status}`;
      try {
        const details = await res.json() as { error?: string };
        if (details.error) message = details.error;
      } catch { /* non-JSON response */ }
      throw new Error(message);
    }
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

export class DeleteSessionError extends Error {
  constructor(public status: number, public code: string, public detail?: string, public worktreeRoot?: string, public branch?: string) {
    super(detail || code);
    this.name = 'DeleteSessionError';
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
}

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
}
