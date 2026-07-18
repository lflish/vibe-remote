import type { MachineConfig, SessionInfo } from '../shared/protocol';

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
    const res = await fetch(`${this.base()}/api/v1/info`, { headers: this.headers() });
    if (!res.ok) throw new Error(`info failed: ${res.status}`);
    return res.json();
  }

  async listSessions(): Promise<SessionInfo[]> {
    const res = await fetch(`${this.base()}/api/v1/sessions`, { headers: this.headers() });
    if (!res.ok) throw new Error(`sessions failed: ${res.status}`);
    const data = await res.json();
    return data.list || [];
  }

  async deleteSession(id: string): Promise<void> {
    const res = await fetch(`${this.base()}/api/v1/sessions/${id}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 204) throw new Error(`delete failed: ${res.status}`);
  }

  async renameSession(id: string, name: string): Promise<void> {
    const res = await fetch(`${this.base()}/api/v1/sessions/${id}/rename`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok && res.status !== 204) throw new Error(`rename failed: ${res.status}`);
  }

  /** List directory entries (directories only) for the remote picker. */
  async listDir(path?: string): Promise<DirListing> {
    const url = new URL(`${this.base()}/api/v1/fs`);
    if (path) url.searchParams.set('path', path);
    const res = await fetch(url.toString(), { headers: this.headers() });
    if (!res.ok) throw new Error(`fs failed: ${res.status}`);
    return res.json();
  }
}

export interface MachineInfo {
  hostname: string;
  tmux_enabled: boolean;
  default_workdir: string;
  allowed_roots: string[];
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  entries: DirEntry[];
}
