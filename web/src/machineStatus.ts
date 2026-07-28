import { testConnection, type MachineConfig } from '@vibe-remote/core';

// 浏览器 fetch 无默认超时；不可达主机会永久挂起。用 6s 超时兜底（与 mobile 一致）。
export async function probeMachine(
  m: MachineConfig,
  timeoutMs = 6000,
): Promise<{ online: boolean; hostname?: string }> {
  const timeout = new Promise<{ ok: false }>((resolve) =>
    setTimeout(() => resolve({ ok: false }), timeoutMs),
  );
  const result = await Promise.race([testConnection(m), timeout]);
  if ('ok' in result && result.ok) return { online: true, hostname: result.hostname };
  return { online: false };
}
