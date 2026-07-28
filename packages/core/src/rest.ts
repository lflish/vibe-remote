import type { MachineConfig } from './protocol';

/**
 * REST client for a vibe-remoted instance.
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

  /** List directory entries (directories only) for the remote picker. */
  async listDir(path?: string): Promise<DirListing> {
    const url = new URL(`${this.base()}/api/v1/fs`);
    if (path) url.searchParams.set('path', path);
    const res = await fetch(url.toString(), { headers: this.headers() });
    if (!res.ok) throw new Error(`fs failed: ${res.status}`);
    return res.json();
  }

  /** Fetch recent conversation turns for a workdir (for history backfill). */
  async history(workdir: string, limit = 50): Promise<HistoryTurn[]> {
    const url = new URL(`${this.base()}/api/v1/history`);
    url.searchParams.set('path', workdir);
    url.searchParams.set('limit', String(limit));
    const res = await fetch(url.toString(), { headers: this.headers() });
    if (!res.ok) throw new Error(`history failed: ${res.status}`);
    const data = await res.json();
    return data.turns || [];
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
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  entries: DirEntry[];
}

export interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}
