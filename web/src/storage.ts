import type { MachineConfig } from '@vibe-remote/core';

const MACHINES_KEY = 'vibe-remote.machines';
const WORKDIRS_PREFIX = 'vibe-remote.workdirs.';

export function machineKey(m: MachineConfig): string {
  return `${m.addr}:${m.port}`;
}

// 机器清单 + 每台机器开过的 workdir 列表，存 localStorage（会话=workdir 方案 A）。
export function makeWebStore() {
  return {
    async getMachines(): Promise<MachineConfig[]> {
      const raw = localStorage.getItem(MACHINES_KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as MachineConfig[]) : [];
      } catch {
        return [];
      }
    },
    async saveMachines(machines: MachineConfig[]): Promise<void> {
      localStorage.setItem(MACHINES_KEY, JSON.stringify(machines));
    },
    async getWorkdirs(key: string): Promise<string[]> {
      const raw = localStorage.getItem(WORKDIRS_PREFIX + key);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as string[]) : [];
      } catch {
        return [];
      }
    },
    async addWorkdir(key: string, dir: string): Promise<void> {
      const cur = await this.getWorkdirs(key);
      if (cur.includes(dir)) return;
      localStorage.setItem(WORKDIRS_PREFIX + key, JSON.stringify([...cur, dir]));
    },
  };
}
