import { Preferences } from '@capacitor/preferences';
import type { MachineConfig } from '@shared/protocol';

const KEY = 'vibe-remote.machines';

// KV is the minimal key/value contract the machine store needs. Abstracting it
// lets tests inject an in-memory backend and keeps the persistence mechanism
// swappable (Capacitor Preferences on device, localStorage in browser dev).
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

// makeMachineStore replaces the desktop's window.vibeRemote.getMachines/
// saveMachines (Electron IPC) with a KV-backed equivalent. Same shape, so the
// mobile UI code reads/writes machines identically to the desktop renderer.
export function makeMachineStore(kv: KV) {
  return {
    async getMachines(): Promise<MachineConfig[]> {
      const raw = await kv.get(KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as MachineConfig[]) : [];
      } catch {
        return [];
      }
    },
    async saveMachines(machines: MachineConfig[]): Promise<void> {
      await kv.set(KEY, JSON.stringify(machines));
    },
  };
}

// defaultKV uses Capacitor Preferences on device. In a plain browser (vite dev
// without the native layer) Preferences falls back to localStorage internally,
// so this works in both contexts.
export function defaultKV(): KV {
  return {
    async get(key) {
      const { value } = await Preferences.get({ key });
      return value ?? null;
    },
    async set(key, value) {
      await Preferences.set({ key, value });
    },
  };
}
