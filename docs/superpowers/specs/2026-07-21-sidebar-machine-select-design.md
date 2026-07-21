# 侧边栏机器可点选:新建会话落到选中的机器

**日期**: 2026-07-21
**状态**: 设计待评审

## Context(为什么做这个改动)

桌面端侧边栏是「机器 → 其下会话」两级结构。会话项可点(打开/切换),但**机器名那行(`.machine-name`)没有任何点击交互**——`styles.css` 里甚至显式 `cursor: default`。用户无法「选中某台机器」。

新建会话的选机逻辑(`desktop/src/renderer/index.ts:566-568`)是:`当前活动会话的机器 → 否则 machines[0]`。于是当用户还没打开任何会话、或想在**非当前**机器上新建时,会话总落到第一台。用户有两台机器却只能在第一台上新建——这是本次要修的核心痛点。

**对标 Claude Desktop 风**:点机器 = 选中(设为新建目标),**不自动打开该机器下的会话**(点机器和点会话职责分开,更可预测,类似 VS Code 点文件夹不自动开文件)。选中态视觉克制——机器头是分组标题,不该抢会话选中(`.session-item.active`)的视觉重量。

**范围**:纯客户端 renderer 交互增强,不动协议、不动服务端。方案讨论时提到的「右键菜单」与「claude 参数多选」已拆到独立的后续 spec,本次不做。

## 改动清单(仅 2 个文件)

### 1. 新增模块级状态 — `index.ts`(`activeKey` 附近,约 :45)

```ts
// 新建会话在无活动会话可继承时的目标机器。点击侧边栏机器头设置;
// 必须是模块级状态(而非 DOM 标记),因为 renderSidebar 每 5s 被轮询全量重建。
let selectedMachineKey: string | null = null;
```

### 2. 机器名行可点选 — `renderSidebar()`(`index.ts:352-362` 的 `nameRow` 段)

- 追加选中态 class:`nameRow.className = 'machine-name' + (machineKey(machine) === selectedMachineKey ? ' selected' : '')`。
- 给 `nameRow` 加 click 监听:设 `selectedMachineKey = machineKey(machine)` → 调 `renderSidebar()` 重渲(即时高亮)。**不打开任何会话**。
- 复用现有 `machineKey(machine)`(`index.ts:52`)。

### 3. 选机逻辑改为「选中优先」 — `wireNewSessionButton()`(`index.ts:566-568`)

```ts
const active = activeKey ? views.get(activeKey) : null;
const selected = selectedMachineKey
  ? machines.find((m) => machineKey(m) === selectedMachineKey)
  : null;
const machine = active?.machine || selected || machines[0];
```

保留「活动会话机器」最高优先级(在某会话里点新建,自然沿用同机),选中机器次之,`machines[0]` 兜底。

### 4. 默认选中 + 失效清理

- **默认选中第一台**:机器列表加载后(`refreshAllMachines` / 初始化,`index.ts:167-182`),若 `selectedMachineKey` 为空或不在当前 `machines` 里,置为 `machineKey(machines[0])`。让选中态始终可见、行为可预测。
- **删除机器时清理**:机器管理保存回调(`onSaved`,`index.ts:110-144`)里,若 `selectedMachineKey` 已不在新 `machines` 列表,重置为第一台(或 null)。避免选中态悬挂到已删除的机器。

### 5. 选中态样式 — `styles.css`(`.machine-name` 约 :84)

- `cursor: default` → `cursor: pointer`。
- 新增 `.machine-name.selected`:文字提亮(`color: var(--text)`)+ 一条克制的左侧高亮条,弱于 `.session-item.active` 的整块高亮。取现有 CSS 变量。

## 验证方式(端到端)

1. **typecheck**:`cd desktop && npm run typecheck` 通过(`tsc --noEmit`)。
2. **真机点选**(两台机器已在列表:本机 `192.168.51.163` + dev `100.95.191.101`):
   - 起服务端两台 + 桌面端 → 点第二台机器名 → 该行高亮、**不打开会话** → 点「+ New session」→ 目录选择器和新会话落在**第二台**。
   - 点第一台 → 高亮切换 → 新建落第一台。
   - 在某台已有会话里点新建 → 仍沿用该会话的机器(活动优先级未破坏)。
   - 等 ≥5s(触发轮询重建)→ 高亮**不丢失**(验证模块级状态)。
3. **删除机器**:机器管理删掉当前选中的那台 → 选中态回落剩余第一台,不悬挂、不报错。

## 不做(YAGNI)

- 不改协议、不动服务端。纯客户端 renderer 交互增强。
- 点机器不打开会话、不做机器级展开/折叠、不做拖拽排序。
- 不持久化选中态到 machines.json(会话级偏好,重启回落默认第一台即可)。

## 后续(Spec 2,单独实现)

方案讨论中确定但拆出的两项:**右键上下文菜单**(在此新建/重命名/删除机器)+ **claude 参数多选 flag**(服务端白名单 `claude_flags`,协议 `AttachFrame` 加 `flags []string` 传 id,服务端查表拼接,不管冲突全拼)。待本 spec 完成后单独走 brainstorming→plan。
