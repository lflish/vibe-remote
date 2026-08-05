# 机器概览页设计

日期:2026-08-05
状态:待实现

## 背景与问题

当前桌面端主区域 `#terminal-container` 只在两种内容间切换:
- 某个会话的终端(`view.container`,靠 `display` 显隐)
- 空状态盒(`renderEmptyState()`,仅当无任何机器时)

点击侧边栏机器名(`renderSidebar` 里 `nameRow` 的 click)只做两件事:设 `selectedMachineKey` + 重渲染侧边栏移动高亮。**右侧主区域不变**。

这留下两个体验空白:
1. 选中一台机器但还没进入任何会话时,右侧要么空白、要么停留在别的会话终端,没有"这台机器的落地页"。
2. 机器级新建会话没有就近入口——只能靠顶部全局 `+ New Session`(它按 active/selected/first 优先级猜目标机器)。

## 目标

点击机器名时,右侧主区域渲染该机器的**精简概览卡片**,并提供机器级新建会话入口。

## 非目标(YAGNI)

- 不做会话列表仪表盘(概览页不重复列会话——会话已在侧边栏该机器分组下)。
- 不在概览页嵌入服务端 info(hostname/tmux/flags)或编辑/删除机器快捷方式。
- 不在侧边栏机器名行加快捷新建 `+` 图标。
- 不改动会话终端的显隐/保活模型。

## 三项已确认决策

1. **触发时机:总是切概览页。** 任何时候点机器名,右侧立即切为该机器概览页,即使当前正看着某会话终端。终端不销毁(与 tmux 保活模型一致),再点会话即切回。机器名成为导航入口。
2. **内容:精简卡片。** 机器名 + 连接状态(在线/离线)+ 地址端口 + 会话总数 + 一个大的「+ 新建会话」按钮。
3. **侧边栏不加 `+` 图标。** 新建入口 = 概览页大按钮 + 顶部全局 `+ New Session`。

## 架构

### 主区域内容的三态模型

`#terminal-container` 的内容从"会话终端 / 空状态"两态扩展为三态:

| 态 | 触发 | DOM |
|---|---|---|
| 会话终端 | 点会话项 / setActive | 对应 `view.container` display:block,其余 none |
| **机器概览页** | 点机器名 | 概览卡片可见,所有 `view.container` display:none |
| 空状态 | 无任何机器 | `renderEmptyState()` |

引入一个新的顶层状态量表达"当前主区域展示什么":

```
type MainView =
  | { kind: 'session'; key: string }   // 某会话终端
  | { kind: 'overview'; machineKey: string }  // 某机器概览页
  | { kind: 'empty' }
```

现有代码用 `activeKey: string | null` 表达当前活动会话。为最小改动、避免大重构,采用**并存**方案:
- 保留 `activeKey`(会话态语义不变,终端焦点/活动圆点逻辑依赖它)。
- 新增 `overviewMachineKey: string | null`。非 null 时表示主区域正显示该机器概览页。
- 二者互斥:进概览页时不清 `activeKey`(终端 view 仍存活,只是 display:none),但设 `overviewMachineKey`;进会话(setActive)时清 `overviewMachineKey`。

### 组件:renderMachineOverview(machine)

新增一个渲染函数,职责单一:根据一台机器的当前状态构建概览卡片 DOM 并挂到主区域。

- 输入:`MachineConfig`
- 依赖(全部现成数据源):
  - `machineOnline.get(mKey)` → 连接状态圆点
  - `machineSessions.get(mKey)?.length ?? 0` → 会话总数
  - `machine.addr` / `machine.port` → 地址端口
  - `machine.name` → 标题
- 行为:
  - 清空并渲染卡片到一个专用容器 `#machine-overview`(见下)
  - 「+ 新建会话」按钮 click → 复用现有 `openDirPicker(machine)` → `openSession(machine, '', workdir, flags)`(与 `wireNewSessionButton` 完全一致的路径,零新逻辑)

### DOM 落点

在 `#terminal-container` 内并列一个 `#machine-overview` 容器(独立于各 `view.container` 和空状态盒):
- 显示概览页:`#machine-overview` display:block + 填充卡片,所有 view.container display:none。
- 显示会话:`#machine-overview` display:none(setActive 里统一处理)。

这样概览页与会话终端用同一套 display 显隐机制,互不干扰。

## 数据流

```
点机器名 nameRow.click
  → selectedMachineKey = mKey        (现有,保留)
  → overviewMachineKey = mKey        (新增)
  → showOverview(machine)            (新增:隐藏所有 view.container,渲染并显示 #machine-overview)
  → renderSidebar()                  (现有,移动高亮)
  → updateStatusBar()                (调整:overview 态下标题显示机器名)

点会话项 → openSession/setActive
  → overviewMachineKey = null        (新增:离开概览态)
  → 隐藏 #machine-overview,显示目标 view.container   (setActive 扩展)

概览页「+ 新建会话」click
  → openDirPicker(machine) → openSession(...)   (完全复用现有路径)
  → openSession 内部会 setActive → 自动离开概览态
```

## 状态栏(updateStatusBar)调整

现有 `updateStatusBar` 用 `activeKey`/`view` 决定工具栏标题与连接状态。新增分支:
- 当 `overviewMachineKey` 非 null 且无活动会话显示时:工具栏标题显示机器名,连接状态显示该机器 online/offline。
- 会话态逻辑不变。

## 边界情况

1. **机器被删除时正在看它的概览页**:轮询/机器列表更新后,若 `overviewMachineKey` 指向的机器已不存在 → 回退到 empty 或第一台机器的概览(复用现有 `selectedMachineKey` 失效回退逻辑,二者同步处理)。
2. **概览页会话数实时性**:侧边栏靠 5s REST 轮询更新 `machineSessions`。概览页显示的会话数在轮询刷新时若正显示概览页,需重渲染卡片(在轮询回调里,若 `overviewMachineKey === mKey` 则 `renderMachineOverview` 重画)。
3. **离线机器的新建按钮**:机器 offline 时点「+ 新建会话」会走 `openDirPicker`(内部 REST fs 请求)失败。保持现有行为(dirpicker 自身的错误处理),不额外禁用按钮——避免误判瞬时离线。
4. **启动初始态**:`init` 现有逻辑设 `selectedMachineKey = 第一台机器`。相应地初始主区域可显示第一台机器的概览页(而非空白),让首屏有落地内容。

## 测试与验证

- typecheck 通过(`npm run typecheck`)。
- 端到端 CDP 驱动验证:
  1. 点机器名 → 主区域出现概览卡片(机器名/状态/地址/会话数)。
  2. 概览页「+ 新建会话」→ 弹目录选择器 → 建会话后自动进终端(离开概览态)。
  3. 点会话项 → 概览页隐藏、终端显示;再点机器名 → 切回概览页,终端未销毁。
  4. 概览页会话数随轮询刷新。

## 影响文件

- `desktop/src/renderer/index.html`:`#terminal-container` 内加 `#machine-overview` 容器。
- `desktop/src/renderer/index.ts`:新增 `overviewMachineKey` 状态 + `renderMachineOverview` / `showOverview` 函数;`nameRow.click`、`setActive`、`updateStatusBar`、轮询回调、init 各处接线。
- `desktop/src/renderer/styles.css`:`.machine-overview` 卡片样式。

纯客户端改动,不涉及协议/服务端。
