import { describe, it, expect } from 'vitest';
import { makeMachineStore, type KV } from './storage';
import type { MachineConfig } from '@shared/protocol';

function memKV(): KV {
  const m = new Map<string, string>();
  return {
    get: async (k) => (m.has(k) ? m.get(k)! : null),
    set: async (k, v) => { m.set(k, v); },
  };
}

const sample: MachineConfig[] = [{ name: 'dev', addr: '100.0.0.1', port: 8765, token: 't' }];

describe('makeMachineStore', () => {
  it('round-trips machines', async () => {
    const store = makeMachineStore(memKV());
    await store.saveMachines(sample);
    expect(await store.getMachines()).toEqual(sample);
  });

  it('returns [] when nothing stored', async () => {
    const store = makeMachineStore(memKV());
    expect(await store.getMachines()).toEqual([]);
  });

  it('returns [] on corrupt stored value', async () => {
    const kv = memKV();
    await kv.set('vibe-remote.machines', 'not-json{');
    const store = makeMachineStore(kv);
    expect(await store.getMachines()).toEqual([]);
  });
});
