// 机器连接测试 + 表单校验的框架无关纯逻辑。
// 从 desktop/src/renderer/machines.ts 与 mobile/src/machines.ts 的逐字重复上提到 core。
// 视图层（desktop createElement / mobile innerHTML）各自保留；文案通过参数注入，
// 使 core 不绑定中英文。
import { VibeRemoteRest } from './rest';
import type { MachineConfig } from './protocol';

export interface TestResult {
  ok: boolean;
  hostname?: string;
  error?: string;
}

// 可注入的错误文案（desktop 传英文、mobile 传中文）。
export interface TestConnectionMessages {
  unreachableStatus: (status: number) => string;
  unreachableErr: (msg: string) => string;
  badToken: string;
}

const DEFAULT_MESSAGES: TestConnectionMessages = {
  unreachableStatus: (s) => `unreachable (healthz ${s})`,
  unreachableErr: (m) => `unreachable (${m})`,
  badToken: 'bad token or info failed',
};

/**
 * 验证机器可达且 token 有效：/healthz 无需鉴权（证明可达），
 * /api/v1/info 需 Bearer token（证明 token），成功时返回 hostname。
 */
export async function testConnection(
  machine: MachineConfig,
  messages: TestConnectionMessages = DEFAULT_MESSAGES,
): Promise<TestResult> {
  const base = `http://${machine.addr}:${machine.port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    if (!health.ok) return { ok: false, error: messages.unreachableStatus(health.status) };
  } catch (e) {
    return { ok: false, error: messages.unreachableErr((e as Error).message) };
  }
  try {
    const rest = new VibeRemoteRest(machine);
    const info = await rest.info();
    return { ok: true, hostname: info.hostname };
  } catch {
    return { ok: false, error: messages.badToken };
  }
}

// 表单原始输入（字符串），来自 UI 输入框。
export interface MachineFormInput {
  name: string;
  addr: string;
  port: string;
  token: string;
}

// 校验失败时返回出错字段（key），由调用方翻译成本地化文案。
export type MachineField = 'name' | 'addr' | 'port' | 'token';
export type ValidateResult =
  | { ok: true; machine: MachineConfig }
  | { ok: false; field: MachineField };

/**
 * 校验并归一机器表单。规则：name/addr/token 非空（trim 后），port 为 1–65535 整数。
 * 校验通过返回归一后的 MachineConfig；失败返回首个出错字段。
 */
export function validateMachineFields(input: MachineFormInput): ValidateResult {
  const name = input.name.trim();
  const addr = input.addr.trim();
  const port = parseInt(input.port, 10);
  const token = input.token.trim();
  if (!name) return { ok: false, field: 'name' };
  if (!addr) return { ok: false, field: 'addr' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, field: 'port' };
  if (!token) return { ok: false, field: 'token' };
  return { ok: true, machine: { name, addr, port, token } };
}
