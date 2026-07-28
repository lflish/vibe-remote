import { describe, it, expect, vi } from 'vitest';
import { probeMachine } from './machineStatus';

const M = { name: 'dev', addr: '100.1.1.1', port: 8765, token: 't' };

describe('probeMachine', () => {
  it('超时返回 online:false', async () => {
    // fetch 永不 resolve → 触发超时分支
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    const r = await probeMachine(M, 50);
    expect(r.online).toBe(false);
    vi.unstubAllGlobals();
  });

  it('healthz+info 成功返回 online:true + hostname', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      if (String(url).endsWith('/healthz')) return Promise.resolve({ ok: true } as Response);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ hostname: 'boxA', default_workdir: '/w', allowed_roots: [] }) } as Response);
    });
    const r = await probeMachine(M, 2000);
    expect(r).toEqual({ online: true, hostname: 'boxA' });
    vi.unstubAllGlobals();
  });
});
