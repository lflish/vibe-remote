# ccdesk UI 浅色米白重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ccdesk 桌面端界面从 Catppuccin 深紫黑主题重做为 Claude Desktop 风格的浅色米白 + 赤陶橙强调色，并新增顶部工具栏显示当前会话/机器/连接状态。

**Architecture:** 纯外壳 UI 改动，不碰任何业务逻辑与协议。分三块：① styles.css 配色 token 整体重做 + 组件浅色适配；② index.html 主区新增顶部工具栏 DOM、状态栏精简；③ index.ts 的 xterm 主题改浅色 + updateStatusBar 拆分为工具栏更新 + 状态栏更新。守住纯字节透传铁律（只改 xterm theme 不解析内容）与已完成 10 个功能 Task 的全部交互挂载点。

**Tech Stack:** Electron + TypeScript + xterm.js（@xterm/xterm）+ Vite（热重载）。无新增依赖。

## Global Constraints

- **纯字节透传铁律**：不解析 claude 的 PTY 输出。本次只改 xterm 的 `theme` 配色对象，绝不读/匹配终端内容。
- **不破坏已完成功能**：机器管理齿轮入口（`#btn-manage-machines`）、双击内联重命名（`.session-rename-input`/`renamingActive`/`startInlineRename`）、圆点语义（`.session-unread` 的 output/idle/waiting）、重连横幅（`.reconnect-banner`）、活动会话切换（`setActive`）、新建会话按钮（`#btn-new-session`）、空状态引导（`.empty-state`）全部保留，只换皮 + 加工具栏，不动交互逻辑。
- **DOM id 契约**：index.ts 引用了这些 id，重构 index.html 时**必须保留**：`#sidebar`、`#machine-list`、`#btn-manage-machines`、`#btn-new-session`、`#terminal-container`、`#status-connection`、`#status-session`。新增的工具栏用新 id，不占用旧 id。
- **圆点语义色不变**：idle=绿、waiting=黄 保留（用户已依赖此语义）；output 点从蓝紫改为配浅底的中性/赤陶色，但**类名 `.session-unread`/`.idle`/`.waiting`/`.hidden` 不变**（index.ts renderSidebar 依赖这些类名）。
- **验证方式**：纯 UI 无单元测试。每个 Task 以 `cd desktop && npm run typecheck` 通过 + Vite 热重载可见为准。GUI 目视由控制方人工确认。
- **提交信息**：中文描述，结尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`。

---

## 文件结构总览

**修改（3 个文件）：**
- `desktop/src/renderer/styles.css` — 配色 token 整体重做（`:root` 变量）+ 全组件浅色适配 + 新增 `.toolbar` 样式
- `desktop/src/renderer/index.html` — 主区 `#main-area` 内新增 `<div id="toolbar">`（在 terminal-container 之前）；status-bar 保留精简
- `desktop/src/renderer/index.ts` — `makeTerminal()` 的 xterm `theme` 改浅色（约 line 190-198）；`updateStatusBar()` 扩展为同时更新顶部工具栏（约 line 468-492）

**任务拆分理由**：配色（Task 1）是纯 CSS 变量 + 组件适配，可独立热重载验证；工具栏（Task 2）需要 html 结构 + css + ts 三处协同，是一个独立可验证的增量；xterm 终端主题（Task 3）是 index.ts 单点改动，独立可验证。三者边界清晰，各自可被单独审查/回退。

---

## 阶段一：浅色米白配色

### Task 1: 配色 token 重做 + 全组件浅色适配

**Files:**
- Modify: `desktop/src/renderer/styles.css`（`:root` 变量 line 3-19；及所有引用旧色值的组件规则）

**Interfaces:**
- Consumes：无（纯 CSS）。
- Produces：新的 `:root` CSS 变量集（下方 Step 1 列出的确切变量名与值），供 Task 2 工具栏样式复用。变量名保持与现有一致（`--bg-primary`/`--bg-sidebar`/`--bg-hover`/`--text-primary`/`--text-secondary`/`--text-muted`/`--accent`/`--accent-hover`/`--border`/`--success`/`--warning`/`--error`/`--radius`/`--sidebar-width`）+ 新增 `--bg-elevated`，这样大部分组件规则无需改动即自动变浅色。

- [ ] **Step 1: 重做 :root 配色变量**

替换 `desktop/src/renderer/styles.css` 顶部 `:root { ... }`（line 3-19）为：

```css
:root {
  /* Claude Desktop-inspired warm light theme */
  --bg-primary: #F5F4EF;      /* app / main background — warm off-white */
  --bg-secondary: #EFEDE6;    /* status bar / subtle bands */
  --bg-sidebar: #EDEAE3;      /* sidebar — slightly deeper warm grey */
  --bg-elevated: #FFFFFF;     /* cards / modal / inputs — raised white */
  --bg-hover: #E6E1D7;        /* hover */
  --text-primary: #2B2A28;    /* near-black warm grey */
  --text-secondary: #6B6862;
  --text-muted: #9B978E;
  --accent: #C9645A;          /* Claude terracotta/clay */
  --accent-hover: #B5564D;
  --border: #E2DDD3;          /* very faint warm border */
  --success: #6BA368;         /* muted warm green */
  --warning: #C98A3C;         /* amber */
  --error: #C0564B;           /* warm red */
  --radius: 8px;
  --sidebar-width: 240px;
}
```

- [ ] **Step 2: 修正硬编码/深色残留的组件规则**

以下规则在深色主题下用了对浅色不合适的值，逐处改：

1. `.session-close:hover`（约 line 174-177）——原 `color: var(--bg-primary)` 在浅底上会是浅字，改为白字：
```css
.session-close:hover {
  background: var(--error);
  color: #ffffff;
}
```

2. `.btn-primary`（约 line 180-191）——原 `color: var(--bg-primary)`（浅色）在赤陶底上对比不足，改白字：
```css
.btn-primary {
  width: 100%;
  padding: 8px 12px;
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: #ffffff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
```

3. `.modal`（约 line 290-300）——背景改用抬升白 + 更淡阴影（浅色主题阴影要浅）：
```css
.modal {
  width: 480px;
  max-height: 70vh;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 12px 48px rgba(60, 50, 40, 0.18);
}
```

4. `.modal-overlay`（约 line 279-288）——遮罩在浅色下用更淡的暖色半透明：
```css
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(43, 42, 40, 0.28);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  -webkit-app-region: no-drag;
}
```

5. `.form-field input`（约 line 414-418）——背景改抬升白（原 `--bg-sidebar` 现在是米灰，输入框应更亮）：
```css
.form-field input {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
}
```

6. `.modal-path`（约 line 309-318）的 `background: var(--bg-sidebar)` 和 `.session-rename-input` 的 `background: var(--bg-sidebar)`（约 line 445）——改为 `var(--bg-elevated)` 让输入/路径栏更亮：
```css
.modal-path {
  padding: 8px 16px;
  font-size: 11px;
  font-family: 'SF Mono', monospace;
  color: var(--text-muted);
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  overflow-x: auto;
}
```
```css
.session-rename-input {
  flex: 1; min-width: 0;
  background: var(--bg-elevated); border: 1px solid var(--accent);
  border-radius: 5px; padding: 3px 6px;
  color: var(--text-primary); font-size: 12px; font-family: inherit;
}
```

- [ ] **Step 3: output 圆点改配浅底的中性色**

`.session-unread`（约 line 452-455）的默认色（output 态）原为 accent 蓝紫，现 accent 已是赤陶。为了让 output（有输出）与 idle（绿）/waiting（黄）视觉区分，output 用中性灰蓝，idle/waiting 语义色保留：

```css
.session-unread {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  background: #8C9AA6; /* 'output' default: neutral slate — distinct from idle/waiting */
}
.session-unread.idle { background: var(--success); }
.session-unread.waiting {
  background: var(--warning);
  box-shadow: 0 0 0 3px rgba(201, 138, 60, 0.14);
}
.session-unread.hidden { display: none; }
.session-item:hover .session-unread { display: none; }
```

- [ ] **Step 4: 滚动条改浅色适配**

`::-webkit-scrollbar-thumb`（约 line 269-275）在浅底上用更深的暖灰：
```css
::-webkit-scrollbar-thumb {
  background: #D2CCC0;
  border-radius: 3px;
}
::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}
```

- [ ] **Step 5: 更新文件顶部注释**

把 line 1 的注释 `/* ccdesk — Claude Desktop-inspired theme */` 保留即可（已贴切）。确认无遗漏的旧色值引用：搜索 css 里是否还有 `#1e1e2e`/`#cdd6f4`/`#89b4fa` 等硬编码深色（除 index.ts 的 xterm theme 外，css 里不应再有）。

Run: `grep -nE '#1e1e2e|#181825|#11111b|#313244|#cdd6f4|#a6adc8|#6c7086|#89b4fa|#74c7ec' desktop/src/renderer/styles.css`
Expected: 无输出（所有深色硬编码已被变量或新值取代）

- [ ] **Step 6: typecheck（CSS 不影响类型，跑一遍确保没误改到别处）**

Run: `cd desktop && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add desktop/src/renderer/styles.css
git commit -m "$(cat <<'EOF'
style(desktop): 界面改为 Claude Desktop 风格浅色米白配色

配色 token 整体重做（暖米白背景 + 赤陶橙强调色），全组件浅色适配；
output 圆点改中性灰蓝以区分 idle 绿/waiting 黄语义色。仅改样式，
不动交互逻辑与类名契约。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 阶段二：顶部工具栏

### Task 2: 主区新增顶部工具栏（显示当前会话/机器/连接状态）

**Files:**
- Modify: `desktop/src/renderer/index.html`（`#main-area` 内 line 26-32）
- Modify: `desktop/src/renderer/styles.css`（新增 `.toolbar` 相关样式）
- Modify: `desktop/src/renderer/index.ts`（`updateStatusBar` 约 line 468-492 扩展更新工具栏）

**Interfaces:**
- Consumes：Task 1 的配色变量；现有 `updateStatusBar(extra?, attempt?)` 函数、`activeKey`、`views`、`ConnectionState`、`machineOnline`（index.ts 已有）。
- Produces：新 DOM 元素 `#toolbar-title`（会话名+机器）、`#toolbar-status`（连接状态点+文案）。`updateStatusBar` 同时驱动工具栏与底部状态栏。

- [ ] **Step 1: index.html 主区加工具栏**

替换 `desktop/src/renderer/index.html` 的 `<main id="main-area">...</main>`（line 25-32）为：

```html
    <!-- Main terminal area -->
    <main id="main-area">
      <div id="toolbar">
        <div id="toolbar-title">ccdesk</div>
        <div id="toolbar-status"><span id="toolbar-status-text"></span></div>
      </div>
      <div id="terminal-container"></div>
      <div id="status-bar">
        <span id="status-connection">Disconnected</span>
        <span id="status-session"></span>
      </div>
    </main>
```

（保留 `#terminal-container`、`#status-connection`、`#status-session` 不变——index.ts 依赖它们。）

- [ ] **Step 2: styles.css 加工具栏样式**

在 styles.css 末尾追加：

```css
/* --- Top toolbar --- */
#toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 44px;
  padding: 0 16px;
  padding-top: 4px; /* balance with sidebar traffic-light area */
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag; /* toolbar is draggable window region */
  user-select: none;
}
#toolbar-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#toolbar-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  -webkit-app-region: no-drag;
  flex-shrink: 0;
}
#toolbar-status::before {
  content: '';
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
}
#toolbar-status.connected::before { background: var(--success); }
#toolbar-status.reconnecting::before {
  background: var(--warning);
  animation: pulse 1.5s ease-in-out infinite;
}
#toolbar-status.error::before { background: var(--error); }
```

- [ ] **Step 3: index.ts 扩展 updateStatusBar 驱动工具栏**

替换 `desktop/src/renderer/index.ts` 的 `updateStatusBar` 函数（约 line 468-492）为：

```typescript
function updateStatusBar(extra?: string, attempt?: number) {
  const connEl = document.getElementById('status-connection')!;
  const sessionEl = document.getElementById('status-session')!;
  const tbTitle = document.getElementById('toolbar-title')!;
  const tbStatus = document.getElementById('toolbar-status')!;
  const tbStatusText = document.getElementById('toolbar-status-text')!;
  const view = activeKey ? views.get(activeKey) : null;

  connEl.className = '';
  tbStatus.className = '';

  if (view) {
    // Toolbar title: session name · machine
    const title = view.sessionId
      ? `${view.machine.name}`
      : view.machine.name;
    tbTitle.textContent = title;

    const st = view.client.state;
    if (st === ConnectionState.Connected) {
      connEl.className = 'connected';
      connEl.textContent = `Connected · ${view.machine.name}`;
      tbStatus.className = 'connected';
      tbStatusText.textContent = 'Connected';
    } else if (st === ConnectionState.Reconnecting) {
      connEl.className = 'reconnecting';
      const n = attempt ?? 0;
      const msg = n > 0 ? `Reconnecting… (attempt ${n})` : 'Reconnecting…';
      connEl.textContent = msg;
      tbStatus.className = 'reconnecting';
      tbStatusText.textContent = n > 0 ? `Reconnecting… (${n})` : 'Reconnecting…';
    } else {
      connEl.textContent = 'Disconnected';
      tbStatus.className = 'error';
      tbStatusText.textContent = 'Disconnected';
    }
  } else {
    tbTitle.textContent = 'ccdesk';
    const anyOnline = [...machineOnline.values()].some(Boolean);
    connEl.className = anyOnline ? 'connected' : '';
    connEl.textContent = anyOnline ? 'Ready' : 'No connection';
    tbStatus.className = anyOnline ? 'connected' : '';
    tbStatusText.textContent = anyOnline ? 'Ready' : 'No connection';
  }
  sessionEl.textContent = extra || (view?.sessionId ? `Session: ${view.sessionId}` : '');
}
```

- [ ] **Step 4: 让工具栏标题显示会话友好名（而非机器名）**

上面 Step 3 的 title 只显示机器名。工具栏更有用的是显示**当前会话名 + 机器**。会话名来自侧边栏渲染时的 title（`s.title`），但 `updateStatusBar` 只有 `view`（含 `sessionId`/`machine`），没有 title 字符串。最简处理：在 SessionView 上没有存 title，故工具栏用 `sessionId` 短码 + 机器名。修正 Step 3 的 title 行为：

将 Step 3 中的 title 计算改为：

```typescript
    const shortId = view.sessionId ? view.sessionId.slice(-6) : 'new';
    tbTitle.textContent = `${view.machine.name} · ${shortId}`;
```

（说明：SessionView 未持有会话显示名，工具栏用「机器名 · 会话短码」已足够定位。若未来要显示友好名，需在 setActive 时从侧边栏 title 传入，属后续增强，本次 YAGNI 不做。）

- [ ] **Step 5: typecheck**

Run: `cd desktop && npm run typecheck`
Expected: PASS（无类型错误；新增 getElementById 的元素在 html 中已存在）

- [ ] **Step 6: Commit**

```bash
git add desktop/src/renderer/index.html desktop/src/renderer/styles.css desktop/src/renderer/index.ts
git commit -m "$(cat <<'EOF'
feat(desktop): 主区新增顶部工具栏显示会话/机器/连接状态

顶部工具栏显示「机器名 · 会话短码」+ 连接状态点（绿/黄/灰），
重连时同步显示 attempt。底部状态栏保留为次要信息。工具栏为可拖拽
窗口区。updateStatusBar 同时驱动工具栏与状态栏。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 阶段三：xterm 终端浅色主题

### Task 3: 终端配色改浅色协调

**Files:**
- Modify: `desktop/src/renderer/index.ts`（`makeTerminal()` 的 `theme` 对象，约 line 190-198）

**Interfaces:**
- Consumes：无（xterm 配置）。
- Produces：xterm `Terminal` 用浅色 theme 构造，与外壳米白协调。

- [ ] **Step 1: 改 xterm theme 为浅色**

替换 `desktop/src/renderer/index.ts` 的 `makeTerminal()` 里 `theme: { ... }`（约 line 190-198）为浅色主题（暖白底 + 深色前景 + 低饱和 ANSI 色，配浅底仍清晰可读）：

```typescript
    theme: {
      background: '#F5F4EF', foreground: '#2B2A28', cursor: '#C9645A',
      selectionBackground: '#DCD6C9',
      black: '#3B3A37', red: '#C0564B', green: '#5E8C58', yellow: '#B07D2E',
      blue: '#4A72B0', magenta: '#9A5BA0', cyan: '#3E8C8C', white: '#6B6862',
      brightBlack: '#9B978E', brightRed: '#C0564B', brightGreen: '#5E8C58',
      brightYellow: '#B07D2E', brightBlue: '#4A72B0', brightMagenta: '#9A5BA0',
      brightCyan: '#3E8C8C', brightWhite: '#2B2A28',
    },
```

（说明：这是纯字节透传——只改 xterm 渲染字节流时用的调色板，不解析/修改任何 PTY 内容。终端里 claude/bash 的 ANSI 转义序列仍原样透传，只是映射到浅色友好的 RGB。）

- [ ] **Step 2: typecheck**

Run: `cd desktop && npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/renderer/index.ts
git commit -m "$(cat <<'EOF'
style(desktop): xterm 终端主题改浅色与外壳协调

终端从深色 Catppuccin 调色板改为暖白底 + 深色前景 + 低饱和 ANSI 色。
仅改 xterm theme 调色板，纯字节透传不变（不解析终端内容）。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 收尾：整体目视验证（人工）

所有 Task 完成后，控制方重启 Electron 目视确认：
- 侧边栏、工具栏、终端、状态栏、modal（机器管理/目录选择器）、表单均为浅色米白 + 赤陶强调
- 圆点：output 中性灰蓝、idle 绿、waiting 黄，三者可区分
- 重连横幅在浅底上可读（琥珀色横幅）
- 双击重命名输入框、机器管理表单在浅色下正常
- 终端文字在浅白底上清晰（bash/claude 输出的颜色可读）

（此步为人工目视，非自动化。）

---

## Self-Review 记录

**1. Spec coverage（对照已确认的设计方向）：**
- 浅色米白配色（暖白背景 + 赤陶橙）→ Task 1 ✓
- 全组件浅色适配（btn/modal/表单/圆点/滚动条/横幅经变量自动适配 + 硬编码修正）→ Task 1 Step 2-4 ✓
- 顶部工具栏（会话/机器/连接状态）→ Task 2 ✓
- xterm 终端浅色主题 → Task 3 ✓
- 重连横幅 + 工具栏都保留连接状态（职责分工）→ Task 2 Step 3 工具栏显示 + `.reconnect-banner` 保留不动 ✓
- 圆点语义色不变（idle 绿/waiting 黄，类名不变）→ Task 1 Step 3 ✓

**2. Placeholder scan：** 无 TBD/TODO。每个 Step 含完整代码或确切命令。Task 2 Step 4 明确说明了工具栏标题的 YAGNI 边界（不显示友好名）。

**3. Type consistency：**
- `updateStatusBar(extra?, attempt?)` 签名不变（Task 2 只扩展函数体，不改签名）——现有所有调用方（onStateChange 等）无需改。
- 新增 DOM id：`#toolbar`/`#toolbar-title`/`#toolbar-status`/`#toolbar-status-text`（html Step 1 定义，ts Step 3 getElementById 引用，一致）。
- 保留的 DOM id：`#status-connection`/`#status-session`/`#terminal-container` 未改，index.ts 其它引用处不受影响。
- CSS 类名契约：`.session-unread`/`.idle`/`.waiting`/`.hidden`/`.reconnect-banner`/`.empty-state`/`.machine-row` 等类名全部保留，只改样式值——index.ts renderSidebar 依赖的类名不变。
- CSS 变量名保留（`--bg-primary` 等），仅改值 + 新增 `--bg-elevated`——大部分组件规则自动适配。
