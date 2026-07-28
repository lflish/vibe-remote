// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { makeWebStore, machineKey } from './storage';

const M = { name: 'dev', addr: '100.1.1.1', port: 8765, token: 't' };

describe('makeWebStore', () => {
  beforeEach(() => localStorage.clear());

  it('machineKey 用 addr:port', () => {
    expect(machineKey(M)).toBe('100.1.1.1:8765');
  });

  it('机器清单存取往返', async () => {
    const s = makeWebStore();
    expect(await s.getMachines()).toEqual([]);
    await s.saveMachines([M]);
    expect(await s.getMachines()).toEqual([M]);
  });

  it('workdir 列表按机器 key 存取、去重', async () => {
    const s = makeWebStore();
    const k = machineKey(M);
    await s.addWorkdir(k, '/a');
    await s.addWorkdir(k, '/b');
    await s.addWorkdir(k, '/a'); // 重复不加
    expect(await s.getWorkdirs(k)).toEqual(['/a', '/b']);
  });

  it('坏 JSON 返回空数组', async () => {
    localStorage.setItem('vibe-remote.machines', '{bad');
    expect(await makeWebStore().getMachines()).toEqual([]);
  });
});
