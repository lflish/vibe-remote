# Web 端（ChatGPT 式门户）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `web/`（Vite + React）网页版 vibe-remote，复用 `@vibe-remote/core` + `@vibe-remote/ui`，做多机器 ChatGPT 式门户；由极简 Go 静态服务 `cmd/vibe-portal` 托管。

**Architecture:** 三端重构第三期。web 是纯静态 SPA，浏览器直连 N 台远程 `vibe-remoted` 的 headless `ws://`（Tailscale/WireGuard 加密）。**聊天逻辑与视图 100% 复用 core（ChatSession/client/rest/base64）+ ui（ChatView/mountChat）**——web 只新写「外壳」：多机器侧边栏、机器管理、远程目录选择、localStorage 存储适配、响应式布局。会话模型 = workdir（headless 无 tmux 会话，一个 workdir 一条聊天线）。

**Tech Stack:** Vite 6 + React 19 + TypeScript；`@vibe-remote/core`、`@vibe-remote/ui`；Go `embed` + `http.FileServer`（门户二进制）。

## Global Constraints

- monorepo：web 是 npm workspace 成员，根 `package.json` 的 `workspaces` 已含 `packages/*`、`desktop`、`mobile`，需新增 `"web"`。
- 复用优先：凡 core/ui 已有的能力（WS 客户端、REST、chat 解析、ChatView、mountChat、testConnection、validateMachineFields、base64、markdown）**一律 import，不得在 web 重写**。
- 会话模型 = workdir（方案 A）：attach 用 `mode:'headless'`、`sessionId` 空、`workdir` 为选中目录。侧边栏 workdir 列表数据源 = localStorage（不用 `listSessions`，那列 tmux）。
- 传输：明文 `ws://<addr>:<port>/ws`，Tailscale 加密；token 走 `auth` 帧 + REST Bearer。
- 存储：机器清单 + 每台机器的 workdir 列表，存浏览器 `localStorage`。
- 零后端改动：`vibe-remoted` 完全不改（headless 线、`/api/v1/fs`、`/api/v1/history`、`/api/v1/info` 均已就绪）。
- React JSX：`tsconfig` 用 `"jsx": "react-jsx"`，vite 用 `@vitejs/plugin-react`。
- 安全：token 存 localStorage（XSS 暴露面比原生大）——仅 Tailscale 可信网内使用；不引入第三方脚本；markdown 已由 ui 的 DOMPurify 消毒。

---

## 文件结构

新增 `web/`（workspace 成员）：

- `web/package.json` — name `@vibe-remote/web`，依赖 core+ui+react，scripts: dev/build/typecheck
- `web/tsconfig.json` — jsx react-jsx，paths 别名 `@net`/`@shared` → `../packages/core/src`（与 mobile 一致）
- `web/vite.config.ts` — `@vitejs/plugin-react` + 别名
- `web/index.html` — SPA 挂载点 `#root`
- `web/src/main.tsx` — React 入口，挂 `<App/>`
- `web/src/storage.ts` — localStorage 后端的 KV + `makeMachineStore`（复用 core 的存储契约思路；含 workdir 列表存取）
- `web/src/App.tsx` — 顶层：路由（机器列表页 ⇄ 聊天页）+ 响应式外壳
- `web/src/Sidebar.tsx` — 多机器分组 + 每机器 workdir 列表 + 「+ 选目录开聊」+ 在线状态点
- `web/src/ChatPane.tsx` — 单个聊天：用 core `VibeRemoteClient` + ui `mountChat`，headless attach + history 回填
- `web/src/MachineManager.tsx` — 机器 CRUD（复用 core `testConnection`/`validateMachineFields`）
- `web/src/DirPicker.tsx` — 远程目录选择（复用 rest `listDir` → `/api/v1/fs`）
- `web/src/machineStatus.ts` — 6s 超时探活（复用 core `testConnection`，纯逻辑）
- `web/src/styles.css` — 门户布局 + 响应式抽屉（聊天区样式由 ui `styles.css` 提供）
- `web/src/*.test.ts(x)` — storage / machineStatus / ChatPane 端到端冒烟（vitest）

新增门户二进制：
- `vibe-remoted/cmd/vibe-portal/main.go` — `embed` `web/dist` + `http.FileServer` + SPA fallback
- `Makefile` — 加 `portal` target（build web + 编译门户）

**复用（不新写）**：`@vibe-remote/core` 的 `VibeRemoteClient`/`VibeRemoteRest`/`base64`/`testConnection`/`validateMachineFields`/`MachineConfig`；`@vibe-remote/ui` 的 `mountChat`/`ChatView` + `styles.css`。

**注意**：`mountChat` 是命令式 API（`createRoot` 挂 DOM 节点）。web 是 React 应用，`ChatPane` 用 `useRef` + `useEffect` 在挂载后调 `mountChat(ref.current, …)`，卸载时 `dispose()`——把命令式挂载封进一个 React 组件。ChatView 本身是 React 组件，但 mountChat 会在其内部再开一个 root；这是可接受的（隔离聊天子树），第一期不追求单一 React 树。

---

### Task 1: web 脚手架 + localStorage 存储

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/storage.ts`
- Create: `web/src/storage.test.ts`
- Modify: `package.json`（根，workspaces 加 `"web"`）

**Interfaces:**
- Consumes: `@vibe-remote/core` 的 `MachineConfig`
- Produces: `makeWebStore()` → `{ getMachines(): Promise<MachineConfig[]>; saveMachines(m: MachineConfig[]): Promise<void>; getWorkdirs(machineKey: string): Promise<string[]>; addWorkdir(machineKey: string, dir: string): Promise<void> }`；`machineKey(m: MachineConfig): string`（`${addr}:${port}`）

- [ ] **Step 1: 根 package.json 加 web workspace**

Modify `package.json` 的 `workspaces` 数组，从：
```json
  "workspaces": [
    "packages/*",
    "desktop",
    "mobile"
  ],
```
改为：
```json
  "workspaces": [
    "packages/*",
    "desktop",
    "mobile",
    "web"
  ],
```

- [ ] **Step 2: 写 web/package.json**

```json
{
  "name": "@vibe-remote/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@vibe-remote/core": "0.1.0",
    "@vibe-remote/ui": "0.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^29.1.1",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: 写 web/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "baseUrl": ".",
    "paths": {
      "@net/*": ["../packages/core/src/*"],
      "@shared/*": ["../packages/core/src/*"]
    }
  },
  "include": ["src"]
}
```

- [ ] **Step 4: 写 web/vite.config.ts**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@net': path.resolve(__dirname, '../packages/core/src'),
      '@shared': path.resolve(__dirname, '../packages/core/src'),
    },
  },
  build: { outDir: 'dist' },
});
```

- [ ] **Step 5: 写 web/index.html**

```html
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>vibe-remote</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 6: 写 web/src/storage.ts**

```ts
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
```

- [ ] **Step 7: 写失败测试 web/src/storage.test.ts**

```ts
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
```

- [ ] **Step 8: 写 web/src/main.tsx（临时占位，Task 3 换 App）**

```tsx
import { createRoot } from 'react-dom/client';
createRoot(document.getElementById('root')!).render(<div>vibe-remote web</div>);
```

- [ ] **Step 9: 安装依赖并运行测试**

Run: `cd /Users/mac/github/vibe-remote && npm install && npm run test --workspace=@vibe-remote/web`
Expected: storage.test.ts 4 tests PASS

- [ ] **Step 10: typecheck + commit**

Run: `npm run typecheck --workspace=@vibe-remote/web`
Expected: 无 error
```bash
git add package.json web/
git commit -m "feat(web): 脚手架 + localStorage 机器/workdir 存储"
```

---

### Task 2: 机器探活（6s 超时，复用 core testConnection）

**Files:**
- Create: `web/src/machineStatus.ts`, `web/src/machineStatus.test.ts`

**Interfaces:**
- Consumes: `@vibe-remote/core` 的 `testConnection`、`MachineConfig`
- Produces: `probeMachine(m: MachineConfig, timeoutMs?: number): Promise<{ online: boolean; hostname?: string }>`

- [ ] **Step 1: 写失败测试 web/src/machineStatus.test.ts**

```ts
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
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ hostname: 'boxA', tmux_enabled: false, default_workdir: '/w', allowed_roots: [] }) } as Response);
    });
    const r = await probeMachine(M, 2000);
    expect(r).toEqual({ online: true, hostname: 'boxA' });
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test --workspace=@vibe-remote/web -- machineStatus`
Expected: FAIL（probeMachine 未定义）

- [ ] **Step 3: 写 web/src/machineStatus.ts**

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test --workspace=@vibe-remote/web -- machineStatus`
Expected: 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/machineStatus.ts web/src/machineStatus.test.ts
git commit -m "feat(web): 机器探活（6s 超时，复用 core testConnection）"
```

---

### Task 3: ChatPane —— headless 聊天（复用 mountChat + client + history）

**Files:**
- Create: `web/src/ChatPane.tsx`, `web/src/ChatPane.test.tsx`

**Interfaces:**
- Consumes: `@vibe-remote/core` 的 `VibeRemoteClient`、`VibeRemoteRest`、`Message`；`@vibe-remote/ui` 的 `mountChat` + `styles.css`
- Produces: `<ChatPane machine={MachineConfig} workdir={string} onBack={() => void} />`（React 组件）

- [ ] **Step 1: 写 web/src/ChatPane.tsx**

```tsx
import { useEffect, useRef } from 'react';
import { VibeRemoteClient, VibeRemoteRest, type MachineConfig, type Message } from '@vibe-remote/core';
import { mountChat } from '@vibe-remote/ui';
import '@vibe-remote/ui/styles.css';

// 单个 headless 聊天。会话=workdir：attach 用 mode:'headless'、sessionId 空、workdir=选中目录。
// 命令式 mountChat 封进 React：useEffect 挂载、卸载时 dispose + 断开 WS。
export function ChatPane({ machine, workdir, onBack }: { machine: MachineConfig; workdir: string; onBack: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const client = new VibeRemoteClient(machine);
    const mount = mountChat(host, { onSend: (payload) => client.sendData(payload) });

    // 历史回填：{role,text} → core Message（纯文本 part）。
    new VibeRemoteRest(machine)
      .history(workdir, 50)
      .then((turns) => {
        const msgs: Message[] = turns.map((t) =>
          t.role === 'assistant'
            ? { role: 'assistant', parts: [{ type: 'text', text: t.text }], streaming: false }
            : { role: 'user', parts: [{ type: 'text', text: t.text }] },
        );
        if (msgs.length) mount.setHistory(msgs);
      })
      .catch(() => { /* history best-effort */ });

    client.onData = (payload) => mount.feed(payload);
    client.connect();
    client.attach('', 80, 24, workdir, undefined, 'headless');

    return () => {
      client.disconnect();
      mount.dispose();
    };
  }, [machine, workdir]);

  return (
    <div className="web-chat-pane">
      <div className="web-chat-header">
        <button onClick={onBack}>‹ 返回</button>
        <span className="web-chat-title">{workdir}</span>
      </div>
      <div className="chat-host" ref={hostRef} />
    </div>
  );
}
```

- [ ] **Step 2: 写端到端冒烟 web/src/ChatPane.test.tsx**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ChatPane } from './ChatPane';

// stub 掉 WS/REST 网络，只验证组件挂载不抛错、渲染出容器与标题。
vi.mock('@vibe-remote/core', async (orig) => {
  const actual = await orig<typeof import('@vibe-remote/core')>();
  return {
    ...actual,
    VibeRemoteClient: class { onData?: (p: string) => void; connect() {} attach() {} disconnect() {} sendData() {} },
    VibeRemoteRest: class { history() { return Promise.resolve([]); } },
  };
});

afterEach(cleanup);

describe('ChatPane', () => {
  it('挂载渲染标题（workdir）与聊天挂载点', () => {
    const M = { name: 'dev', addr: '1.1.1.1', port: 8765, token: 't' };
    const { container, getByText } = render(<ChatPane machine={M} workdir="/home/proj" onBack={() => {}} />);
    expect(getByText('/home/proj')).toBeTruthy();
    expect(container.querySelector('.chat-host')).toBeTruthy();
  });
});
```

- [ ] **Step 3: 加测试依赖 @testing-library/react**

Run: `npm install --workspace=@vibe-remote/web -D @testing-library/react@^16.0.0`

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test --workspace=@vibe-remote/web -- ChatPane`
Expected: 1 test PASS（组件挂载、标题与 .chat-host 存在）

- [ ] **Step 5: Commit**

```bash
git add web/src/ChatPane.tsx web/src/ChatPane.test.tsx web/package.json
git commit -m "feat(web): ChatPane（headless 聊天，复用 mountChat + history 回填）"
```

---

### Task 4: DirPicker —— 远程目录选择（复用 /api/v1/fs）

**Files:**
- Create: `web/src/DirPicker.tsx`

**Interfaces:**
- Consumes: `@vibe-remote/core` 的 `VibeRemoteRest`、`MachineConfig`；`DirListing`/`DirEntry`
- Produces: `<DirPicker machine={MachineConfig} initialPath?={string} onPick={(path: string) => void} onCancel={() => void} />`

- [ ] **Step 1: 写 web/src/DirPicker.tsx**

```tsx
import { useEffect, useState } from 'react';
import { VibeRemoteRest, type MachineConfig, type DirEntry, type DirListing } from '@vibe-remote/core';

// 浏览远程机器的目录（受 workdir 白名单 + realpath 约束）。用于「+ 选目录开聊」。
// 复用 rest.listDir（GET /api/v1/fs?path=...）。
export function DirPicker({ machine, initialPath, onPick, onCancel }: {
  machine: MachineConfig;
  initialPath?: string;
  onPick: (path: string) => void;
  onCancel: () => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState<string | undefined>(initialPath);

  useEffect(() => {
    setError(null);
    setListing(null);
    new VibeRemoteRest(machine)
      .listDir(path)
      .then(setListing)
      .catch((e) => setError((e as Error).message));
  }, [machine, path]);

  return (
    <div className="web-dirpicker">
      <div className="web-dirpicker-head">
        <button onClick={onCancel}>取消</button>
        <span className="web-dirpicker-path">{listing?.path ?? path ?? '(loading)'}</span>
        <button onClick={() => listing && onPick(listing.path)} disabled={!listing}>选此目录</button>
      </div>
      {error && <div className="web-dirpicker-error">{error}</div>}
      <ul className="web-dirpicker-list">
        {listing?.entries.map((e: DirEntry) => (
          <li key={e.path}>
            <button onClick={() => setPath(e.path)}>📁 {e.name}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck --workspace=@vibe-remote/web`
Expected: 无 error

- [ ] **Step 3: Commit**

```bash
git add web/src/DirPicker.tsx
git commit -m "feat(web): 远程目录选择器（复用 /api/v1/fs）"
```

---

### Task 5: MachineManager —— 机器 CRUD（复用 core 校验/探活）

**Files:**
- Create: `web/src/MachineManager.tsx`

**Interfaces:**
- Consumes: `@vibe-remote/core` 的 `validateMachineFields`、`MachineConfig`；`web/src/machineStatus` 的 `probeMachine`
- Produces: `<MachineManager machines={MachineConfig[]} onSave={(m: MachineConfig[]) => void} onClose={() => void} />`

- [ ] **Step 1: 写 web/src/MachineManager.tsx**

```tsx
import { useState } from 'react';
import { validateMachineFields, type MachineConfig } from '@vibe-remote/core';
import { probeMachine } from './machineStatus';

const FIELD_LABEL: Record<string, string> = { name: '名称', addr: '地址', port: '端口', token: 'Token' };

// 机器增删改。校验复用 core validateMachineFields（与桌面/移动同一规则），
// 测试连接复用 probeMachine（healthz + info）。
export function MachineManager({ machines, onSave, onClose }: {
  machines: MachineConfig[];
  onSave: (m: MachineConfig[]) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<MachineConfig[]>(machines);
  const [form, setForm] = useState({ name: '', addr: '', port: '', token: '' });
  const [err, setErr] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const add = () => {
    const r = validateMachineFields(form);
    if (!r.ok) { setErr(`${FIELD_LABEL[r.field]} 无效`); return; }
    setErr(null);
    setList([...list, r.machine]);
    setForm({ name: '', addr: '', port: '', token: '' });
  };

  const test = async () => {
    const r = validateMachineFields(form);
    if (!r.ok) { setErr(`${FIELD_LABEL[r.field]} 无效`); return; }
    setTestMsg('测试中…');
    const res = await probeMachine(r.machine);
    setTestMsg(res.online ? `✓ 已连接：${res.hostname ?? ''}` : '✗ 无法连接');
  };

  return (
    <div className="web-mm">
      <div className="web-mm-head">
        <span>机器管理</span>
        <button onClick={() => { onSave(list); onClose(); }}>完成</button>
      </div>
      <ul className="web-mm-list">
        {list.map((m, i) => (
          <li key={i}>
            {m.name} · {m.addr}:{m.port}
            <button onClick={() => setList(list.filter((_, j) => j !== i))}>删除</button>
          </li>
        ))}
      </ul>
      <div className="web-mm-form">
        <input placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="地址 (Tailscale IP)" value={form.addr} onChange={(e) => setForm({ ...form, addr: e.target.value })} />
        <input placeholder="端口" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
        <input placeholder="Token" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />
        {err && <div className="web-mm-err">{err}</div>}
        {testMsg && <div className="web-mm-test">{testMsg}</div>}
        <div className="web-mm-actions">
          <button onClick={test}>测试连接</button>
          <button onClick={add}>添加</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck --workspace=@vibe-remote/web`
Expected: 无 error

- [ ] **Step 3: Commit**

```bash
git add web/src/MachineManager.tsx
git commit -m "feat(web): 机器管理 CRUD（复用 core 校验 + 探活）"
```

---

### Task 6: App + Sidebar —— 顶层外壳组装

**Files:**
- Create: `web/src/Sidebar.tsx`, `web/src/App.tsx`, `web/src/styles.css`
- Modify: `web/src/main.tsx`（改为渲染 `<App/>`）

**Interfaces:**
- Consumes: 前 5 个 Task 的所有产物（storage、probeMachine、ChatPane、DirPicker、MachineManager）+ core `MachineConfig` + ui styles.css
- Produces: 页面顶层。无对外接口（应用根）。

- [ ] **Step 1: 写 web/src/Sidebar.tsx**

```tsx
import { useEffect, useState } from 'react';
import type { MachineConfig } from '@vibe-remote/core';
import { probeMachine } from './machineStatus';
import { machineKey } from './storage';

// 侧边栏：多机器分组，每台机器下列 workdir 列表 + 「+ 选目录开聊」+ 在线点。
// workdir 列表来自 localStorage（会话=workdir，不用 listSessions）。
export function Sidebar({ machines, workdirsByKey, onOpen, onAddWorkdir, onManage }: {
  machines: MachineConfig[];
  workdirsByKey: Record<string, string[]>;
  onOpen: (m: MachineConfig, dir: string) => void;
  onAddWorkdir: (m: MachineConfig) => void;
  onManage: () => void;
}) {
  const [status, setStatus] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, boolean> = {};
      await Promise.all(machines.map(async (m) => {
        const r = await probeMachine(m);
        next[machineKey(m)] = r.online;
      }));
      if (!cancelled) setStatus(next);
    })();
    return () => { cancelled = true; };
  }, [machines]);

  return (
    <aside className="web-sidebar">
      <div className="web-sidebar-head">
        <span>vibe-remote</span>
        <button onClick={onManage}>⚙</button>
      </div>
      {machines.length === 0 && (
        <div className="web-empty">
          <div>尚未添加机器</div>
          <button onClick={onManage}>+ 添加第一台</button>
        </div>
      )}
      {machines.map((m) => {
        const k = machineKey(m);
        const online = status[k];
        return (
          <div key={k} className="web-machine-group">
            <div className="web-machine-head">
              <span className={`web-dot ${online ? 'ok' : 'off'}`} />
              <span className="web-machine-name">{m.name}</span>
              <button onClick={() => onAddWorkdir(m)}>+ 选目录开聊</button>
            </div>
            <ul className="web-workdir-list">
              {(workdirsByKey[k] ?? []).map((dir) => (
                <li key={dir}>
                  <button onClick={() => onOpen(m, dir)}>{dir}</button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </aside>
  );
}
```

- [ ] **Step 2: 写 web/src/App.tsx**

```tsx
import { useEffect, useState } from 'react';
import type { MachineConfig } from '@vibe-remote/core';
import { ChatPane } from './ChatPane';
import { DirPicker } from './DirPicker';
import { MachineManager } from './MachineManager';
import { Sidebar } from './Sidebar';
import { makeWebStore, machineKey } from './storage';
import './styles.css';

type Modal = { type: 'manage' } | { type: 'pick'; machine: MachineConfig } | null;
type ActiveChat = { machine: MachineConfig; workdir: string } | null;

// 顶层：机器列表 + workdir 列表存 localStorage；主区显示当前聊天或空态。
export function App() {
  const store = makeWebStore();
  const [machines, setMachines] = useState<MachineConfig[]>([]);
  const [workdirsByKey, setWorkdirsByKey] = useState<Record<string, string[]>>({});
  const [modal, setModal] = useState<Modal>(null);
  const [chat, setChat] = useState<ActiveChat>(null);

  const reload = async () => {
    const ms = await store.getMachines();
    setMachines(ms);
    const map: Record<string, string[]> = {};
    for (const m of ms) map[machineKey(m)] = await store.getWorkdirs(machineKey(m));
    setWorkdirsByKey(map);
  };

  useEffect(() => { reload(); }, []);

  const openChat = (m: MachineConfig, workdir: string) => setChat({ machine: m, workdir });

  const pickDir = async (path: string) => {
    if (modal?.type !== 'pick') return;
    const m = modal.machine;
    await store.addWorkdir(machineKey(m), path);
    setModal(null);
    await reload();
    openChat(m, path);
  };

  return (
    <div className="web-app">
      <Sidebar
        machines={machines}
        workdirsByKey={workdirsByKey}
        onOpen={openChat}
        onAddWorkdir={(m) => setModal({ type: 'pick', machine: m })}
        onManage={() => setModal({ type: 'manage' })}
      />
      <main className="web-main">
        {chat ? (
          <ChatPane machine={chat.machine} workdir={chat.workdir} onBack={() => setChat(null)} />
        ) : (
          <div className="web-placeholder">从左侧选择一个 workdir 或添加机器</div>
        )}
      </main>
      {modal?.type === 'manage' && (
        <div className="web-modal">
          <MachineManager
            machines={machines}
            onSave={async (ms) => { await store.saveMachines(ms); await reload(); }}
            onClose={() => setModal(null)}
          />
        </div>
      )}
      {modal?.type === 'pick' && (
        <div className="web-modal">
          <DirPicker machine={modal.machine} onPick={pickDir} onCancel={() => setModal(null)} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 写 web/src/styles.css**

```css
/* 门户外壳：双栏 + 响应式抽屉。聊天区样式由 @vibe-remote/ui/styles.css 提供。 */
:root {
  --web-bg: #1a1a1a;
  --web-fg: #e6e6e6;
  --web-muted: #8a8a8a;
  --web-border: #2a2a2a;
  --web-accent: #4a9eff;
  --sidebar-w: 260px;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--web-bg); color: var(--web-fg); font: 14px/1.5 -apple-system, sans-serif; }

.web-app { display: grid; grid-template-columns: var(--sidebar-w) 1fr; height: 100vh; }
.web-sidebar { background: #141414; border-right: 1px solid var(--web-border); overflow-y: auto; padding: 12px; }
.web-sidebar-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 12px; border-bottom: 1px solid var(--web-border); margin-bottom: 12px; font-weight: 600; }
.web-sidebar-head button { background: none; border: none; color: var(--web-muted); cursor: pointer; font-size: 18px; }

.web-empty { color: var(--web-muted); text-align: center; padding: 20px 0; }
.web-empty button { margin-top: 8px; background: var(--web-accent); color: #fff; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; }

.web-machine-group { margin-bottom: 16px; }
.web-machine-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 13px; }
.web-machine-name { flex: 1; font-weight: 600; }
.web-machine-head button { font-size: 11px; background: none; border: 1px solid var(--web-border); color: var(--web-muted); border-radius: 4px; padding: 2px 6px; cursor: pointer; }
.web-dot { width: 8px; height: 8px; border-radius: 50%; }
.web-dot.ok { background: #3fb950; }
.web-dot.off { background: #6a6a6a; }

.web-workdir-list { list-style: none; padding: 0; margin: 0; }
.web-workdir-list li button { width: 100%; text-align: left; background: none; border: none; color: var(--web-fg); padding: 4px 8px; cursor: pointer; font-family: monospace; font-size: 12px; }
.web-workdir-list li button:hover { background: #202020; }

.web-main { overflow: hidden; }
.web-placeholder { color: var(--web-muted); display: flex; align-items: center; justify-content: center; height: 100%; }

.web-chat-pane { display: flex; flex-direction: column; height: 100%; }
.web-chat-header { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--web-border); background: #141414; }
.web-chat-header button { background: none; border: none; color: var(--web-fg); cursor: pointer; }
.web-chat-title { font-family: monospace; color: var(--web-muted); }
.chat-host { flex: 1; overflow: hidden; }

.web-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 10; }
.web-modal > * { background: var(--web-bg); border: 1px solid var(--web-border); border-radius: 8px; padding: 16px; min-width: 400px; max-width: 90vw; max-height: 80vh; overflow: auto; }

.web-dirpicker-head, .web-mm-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.web-dirpicker-list, .web-mm-list { list-style: none; padding: 0; margin: 12px 0; max-height: 400px; overflow-y: auto; }
.web-dirpicker-list li button, .web-mm-list li { padding: 6px 8px; width: 100%; text-align: left; }
.web-dirpicker-list li button { background: none; border: none; color: var(--web-fg); cursor: pointer; }
.web-dirpicker-list li button:hover { background: #202020; }
.web-dirpicker-error, .web-mm-err { color: #f85149; font-size: 12px; margin: 4px 0; }
.web-mm-test { color: var(--web-muted); font-size: 12px; margin: 4px 0; }

.web-mm-form input { display: block; width: 100%; margin: 4px 0; padding: 6px 8px; background: #202020; border: 1px solid var(--web-border); color: var(--web-fg); border-radius: 4px; }
.web-mm-actions { display: flex; gap: 8px; margin-top: 8px; }
.web-mm-actions button, .web-dirpicker-head button, .web-mm-head button { background: var(--web-accent); color: #fff; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }

/* 响应式：窄屏侧边栏变抽屉（第一期最小实现：<720px 顶起来） */
@media (max-width: 720px) {
  .web-app { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .web-sidebar { max-height: 40vh; }
}
```

- [ ] **Step 4: 改 web/src/main.tsx 挂 App**

Overwrite `web/src/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
```

- [ ] **Step 5: typecheck + build**

Run: `npm run typecheck --workspace=@vibe-remote/web && npm run build --workspace=@vibe-remote/web`
Expected: 无 error；build 成功，`web/dist/index.html` + assets 生成

- [ ] **Step 6: dev 服务器手动冒烟（需要至少一台可达 vibe-remoted）**

Run: `npm run dev --workspace=@vibe-remote/web`
浏览器打开输出的 URL，添加机器（Tailscale IP + token），「+ 选目录开聊」选一个 workdir，发消息，验证：
- 侧边栏机器状态点亮绿
- 工具卡片/diff/thinking 均显示（与桌面同级）
- 刷新页面后机器和 workdir 列表持久

若无可达 vibe-remoted，跳过此步（真机验证等阶段完成合并前做）。

- [ ] **Step 7: Commit**

```bash
git add web/
git commit -m "feat(web): 顶层外壳 App+Sidebar+样式（多机器 + workdir 侧边栏）"
```

---

### Task 7: vibe-portal —— Go 静态服务二进制 + Makefile

**Files:**
- Create: `vibe-remoted/cmd/vibe-portal/main.go`
- Modify: `Makefile`（加 `portal` target）

**Interfaces:**
- Consumes: `web/dist/` 构建产物
- Produces: `bin/vibe-portal` 单二进制，`-addr` 参数指定绑定地址，`GET /*` 返回 `web/dist` 静态资源 + SPA fallback

- [ ] **Step 1: 写 vibe-remoted/cmd/vibe-portal/main.go**

```go
// vibe-portal：极简静态门户服务。embed web/dist 到二进制，用 http.FileServer 托管，
// 未匹配路径 fallback 到 index.html（SPA 路由）。不参与任何会话数据流——浏览器加载
// 网页后直接连各机器的 vibe-remoted ws://。
package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"strings"
)

//go:embed all:dist
var distFS embed.FS

func main() {
	addr := flag.String("addr", "127.0.0.1:9000", "listen address")
	flag.Parse()

	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		log.Fatalf("embed sub: %v", err)
	}
	fileSvr := http.FileServer(http.FS(sub))

	// SPA fallback：非文件请求路径（如 /some/route）返回 index.html。
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// 有扩展名的当静态文件走 FileServer；无扩展名当 SPA route。
		if strings.Contains(r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:], ".") {
			fileSvr.ServeHTTP(w, r)
			return
		}
		r.URL.Path = "/"
		fileSvr.ServeHTTP(w, r)
	})

	log.Printf("vibe-portal listening on %s (serving embedded web/dist)", *addr)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		log.Fatal(err)
	}
}
```

- [ ] **Step 2: 把 web/dist 链到 vibe-remoted/cmd/vibe-portal 以便 embed**

Go embed 只能读同包目录及其子目录，`web/dist` 在仓库另一处。用**符号链接**桥接（Makefile 自动化）：
Skip this manual step — Makefile 的 `portal` target 会：build web → `ln -sfn ../../../../web/dist vibe-remoted/cmd/vibe-portal/dist` → go build。此 step 无需手动操作，Step 4 会跑通。

- [ ] **Step 3: 在 Makefile 加 portal target**

Modify `Makefile`，`.PHONY` 加 `portal`；在文件末尾加：

```makefile
# --- Web portal (Go static server hosting the web/ SPA) ---

portal:
	cd web && npm run build
	@ln -sfn ../../../../web/dist vibe-remoted/cmd/vibe-portal/dist
	cd vibe-remoted && go build -o ../bin/vibe-portal ./cmd/vibe-portal

dev-portal:
	cd web && npm run dev
```

同时把 `.PHONY: all server desktop clean dev-server dev-desktop dev-local` 改为 `.PHONY: all server desktop clean dev-server dev-desktop dev-local portal dev-portal`。

- [ ] **Step 4: 构建并冒烟测试**

Run: `make portal`
Expected: 生成 `bin/vibe-portal`（无编译错误）

Run: `./bin/vibe-portal -addr 127.0.0.1:9100 &` then `curl -sf http://127.0.0.1:9100/ | head -c 200`
Expected: 返回 web/dist/index.html 内容（包含 `<div id="root">`）
Cleanup: `pkill -f vibe-portal`

- [ ] **Step 5: Commit**

```bash
git add vibe-remoted/cmd/vibe-portal/main.go Makefile
# 提交时忽略符号链接产物（Makefile 每次重建）
git commit -m "feat(portal): vibe-portal 静态门户二进制（embed web/dist）+ Makefile portal target"
```

- [ ] **Step 6: .gitignore 排除 dist 符号链接**

Modify `.gitignore` 加一行：
```
/vibe-remoted/cmd/vibe-portal/dist
```

Run: `git add .gitignore && git commit -m "chore: ignore vibe-portal build-time dist symlink"`

---

## 验收标准

- [ ] `npm test`（根级）：core + ui + mobile + web 所有测试通过
- [ ] `npm run typecheck`（根级）：四包 typecheck 无 error
- [ ] `npm run build --workspace=@vibe-remote/web` 成功；`web/dist` 生成
- [ ] `make portal` 生成 `bin/vibe-portal`，`curl` 返回 SPA HTML
- [ ] 真机手动冒烟（至少一台可达 vibe-remoted）：加机器 → +选目录开聊 → 发消息 → 看到流式富交互（工具卡片/diff/thinking/cost）；刷新后机器与 workdir 列表持久
- [ ] 侧边栏在线状态点：可达绿点、不可达灰点（6s 超时）
- [ ] `<720px` 视口下侧边栏变上方抽屉，聊天区仍可用

## 自审检查（写完后已做）

- **Spec coverage**：会话=workdir ✓、多机器侧边栏 ✓、+选目录开聊 ✓、明文 ws + Tailscale ✓、machines localStorage ✓、门户 B1 embed ✓、slash 命令补全（Task 6 中未纳入本期，见「非目标」）
- **本期非目标（明确留后期）**：slash 命令补全菜单（需要真机验证 `system/init` 事件是否下发 `slash_commands`，可行性未确认 —— 见 web-portal 文档 §slash 命令的 ⚠️ 标注）；@文件引用；虚拟化消息列表；抽屉手势动画。
- **Placeholder scan**：所有 step 都含真实代码或命令；无 TBD/TODO。
- **Type consistency**：`makeWebStore`/`machineKey`/`probeMachine`/`<ChatPane>`/`<DirPicker>`/`<MachineManager>`/`<Sidebar>` 签名在定义处与使用处一致。core 复用签名（`VibeRemoteClient.attach(sid, cols, rows, workdir?, flags?, mode?)`、`VibeRemoteRest.history/listDir/info`、`mountChat(host, {onSend, onStop?})`、`validateMachineFields({name, addr, port, token})`、`MachineConfig`、`Message`）均已核实。

## 依赖顺序

Task 1 → 2 → 3 → 4 → 5 均可并行（除 1 是前置）；Task 6 依赖 1-5；Task 7 依赖 6。








