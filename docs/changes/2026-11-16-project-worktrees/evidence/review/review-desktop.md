# 桌面端评审（change/project-worktrees @ e278f87，基准 6d88e45）

> 边审边写。本文件按「已证实的问题 → 待验证项 → 覆盖范围」组织；写到一半中断时，以已落盘的条目为准。

状态：已完成。全部实验在自建的临时实例上做（临时 daemon：独立端口 / `state_dir` / `TMUX_TMPDIR` / `CLAUDE_CONFIG_DIR`，`allowed_roots` 只有 `/tmp` 下自建目录；Electron：临时 userData、`--use-mock-keychain`、随机调试端口，裸 CDP 驱动；daemon 前面挂了一个可按路径加延迟或改状态码的本地代理）。没有接触 127.0.0.1:8765、默认 tmux socket 和真实应用数据。结束时进程已停、临时目录已删，文中提到的截图随之删除，结论以写在证据里的数值为准。

基线检查：`cd desktop && npm run typecheck`（exit 0）、`npm test`（exit 0，全部通过）、`TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs --no-build`（40 个 PASS，exit 0）。下面的问题都是这些检查全绿时存在的。

## 已证实的问题

### [一般] 一个仓库的 git 卡住（daemon 5 秒超时）时，整台机器的项目树不再刷新，「读取失败」也永远显示不出来
- 位置：`desktop/src/renderer/index.ts:394-462`（`refreshAllMachines`：`generation = ++machineRefreshGeneration`，`isCurrent()` 丢弃旧一代的响应），`index.ts:277`（`setInterval(refreshAllMachines, 5000)`）
- 证据：临时实例（临时 daemon + 临时 userData，daemon 的 PATH 前放了一个 git 垫片：只对路径含 `slowrepo` 的调用 `sleep 30`）。
  - 直接量 daemon：`GET /api/v1/projects` 平时 43 ms；一个仓库的 git 卡住后 `200 in 5011 ms`，响应里该项目是 `{"error":"git_failed","errorMessage":"git worktree list --porcelain: context deadline exceeded"}`（daemon 行为符合 design 4.2「git_failed（含超时）」）。
  - 桌面端：卡住期间在**另一个健康仓库**里 `git worktree add -b added-later`，侧边栏在 t+10/20/30/45 s 始终是 `["main","change/…","fix-login","release/next"]`，没有 `added-later`；`slowrepo` 一行始终没有 `project-error`。去掉垫片 12 秒后才出现 `added-later`。
  - 复验（开了 CDP 的焦点模拟，排除后台定时器节流；在页面里包了一层 `fetch` 记时间）：卡住的 32 秒里页面每 5 秒发一轮，`/sessions → 200 after 10 ms`，`/projects → 200 after 5295 / 5314 / 5326 / 5336 / 5346 ms` 共 5 个 200 都收到了，侧边栏的 worktree 行和 `project-error` 一个没变；卡住结束后 11 秒出现新 worktree。
  - 重启验证（CDP `Page.reload`，卡住期间）：t+8 s 侧边栏出现 `slowrepo [读取失败：git worktree list --porcelain: context deadline exceeded]`（启动时那一次落地了），之后 t+20 / 35 s 不再变化，直到卡住结束。
  - 原因：每 5 秒一轮的 `refreshAllMachines` 都把全局代数 +1，上一轮还没回来的 `/projects` 响应（5011 ms > 5000 ms）回来时 `isCurrent()` 为假，整个丢弃（连 `machineCaps` / `machineProjects` 都不写）。只有启动时那一次（`init` 里 `await refreshAllMachines()` 之后才 `startPolling()`）能落地，之后每一轮都被下一轮作废。删除 worktree、移除项目之后的 `refreshAllMachines(true, mk)` 同样被作废，界面看起来像操作没生效。
  - 按需求应有：R2.7「git 执行失败 → 项目行显示『读取失败』及原因，已有会话照常显示和可用」；R2.1 / R2.5 下一次刷新能看到 worktree 的增减。超时是 daemon 设计里明确的一种失败（5 秒），而它恰好等于桌面端的轮询间隔。
- 依据：R2.7、R2.1、R2.5；design 6.4「各自独立发布」；清单「错误路径：外部调用超时」
- 改法：`/projects` 的结果不要用「全局一代」判新旧。按机器、按请求种类各记一个序号（发出时 +1，回来时只要比该机器该种类已落地的序号新就采用）；或者同一台机器上一轮 `/projects` 还没回来时这一轮不再发新的。全局代数只留给「机器列表被编辑」「重命名事务」这两种真正需要作废旧响应的情况。补一个用例：`listProjects()` 延迟 > 轮询间隔时树仍会更新。
- 类别：明确错误

### [一般] 侧边栏最后一行项目的「⋯」菜单画到窗口外面，「从侧边栏移除」看不见也点不到（800×500 必现）
- 位置：`desktop/src/renderer/menu.ts:46-50`（`el.style.top = rect.bottom`、`left = rect.left`，没有翻转和夹取）
- 证据：临时实例，`Emulation.setDeviceMetricsOverride` 设 800×500，中英文各一遍。新建一个排在最后的 git 项目 `zeta`，开一个会话再删掉（项目按 R2.2 留在侧边栏，扁平、没有会话行），侧边栏滚到底，悬停该行点 `project-menu`：
  `{"window":[800,500],"menuTopBottom":[486,528],"itemTopBottom":[492,522],"itemCenterY":507,"itemFullyInside":false,"centerHitsItem":false,"text":"从侧边栏移除"}`（英文同样的数）。截图上窗口底边只露出菜单顶上一条白边。
  按同一段定位代码推断（未逐一实测）：最后一个项目被折叠时（项目行就是最后一行）、窗口更大但侧边栏内容超过一屏并滚到底时，也是这个结果。worktree 行的菜单因为下面总跟着会话行或「没有会话」行，实测刚好放得下（`menu [458,500]` 贴着底边）；菜单再多一行说明文字时会超出，这一点同样是推断。
  按需求应有：R8.5「窗口是最小尺寸 800×500 … 主按钮都在窗口内且点得到」；R2.3 的唯一入口就是这个菜单项。
- 依据：R8.5、R2.3；design 7.4「菜单用新文件 menu.ts（一个定位在按钮下方的列表）」没有考虑放不下的情况
- 改法：`openMenu` 里把菜单挂进 DOM 后量它的高宽：`rect.bottom + 高 > innerHeight` 时改放在按钮上方（`top = rect.top - 高`），`left` 夹到 `innerWidth - 宽 - 边距` 以内。`sidebar-layout.mjs`（或 design 7.5 提到、目前还没有的 `shell-layout.mjs`）加一条：侧边栏滚到底，打开最后一个项目行和最后一个 worktree 行的菜单，断言菜单项在窗口内且 `elementFromPoint` 命中它。
- 类别：明确错误

### [一般] 顶部标题里分支名一长，会话名被挤成「l…」（800×500 下 4 个字母的名字都显示不全）
- 位置：`desktop/src/renderer/styles.css:623-624`（`#toolbar-title > span { min-width: 0; overflow: hidden; text-overflow: ellipsis }`，只有 `title-project` 设了 `flex-shrink: 0`；分支和会话名按各自宽度等比例收缩）
- 证据：临时实例，800×500，打开冒烟脚本自己用的长分支 `change/general-skills-and-a-long-tail`（37 个字符）下的会话：
  `title-branch {shown:222, needs:260}`、`title-session {text:"long", shown:42, needs:49}`，截图上会话名显示为「l…」；把会话改名为「登录修复」后 `title-session {shown:60, needs:77}`。1000×600 起正常。分支名更长时（90 个字符的那个测试分支）会话名只剩「…」。
  按需求应有：R1.7「标题包含项目名、分支和会话名」；R8.5「800×500、中英文下没有文字截断到看不出内容」。样式注释自己也写着「the session name is the part that reads」，实际被牺牲的正是它。
- 依据：R1.7、R8.5
- 改法：让分支先让位：`[data-testid='title-session'] { flex-shrink: 0; max-width: 55%; }`（名字本身很长时仍可省略），`title-branch` 保持 `flex: 0 1 auto; min-width: 3em`。`sidebar-layout.mjs` 的那类检查在标题上也加一条：会话名被截断时，分支名不应还占着超过它最小宽度的位置。
- 类别：明确错误

### [一般] 机器概览的 Worktree 模式：`/api/v1/info` 还没回来时确认按钮可点，点下去建出一个没名字的 `vibe/<会话id>` worktree
- 位置：`desktop/src/renderer/dirpicker.ts:162`（`naming()` 在 `info` 未到时为假）、`dirpicker.ts:194-196`（确认按钮只看 `listingReady`，不等 info）
- 证据：临时实例（协议 4 的临时 daemon），代理把 `/api/v1/info` 延迟 4 秒。概览 → 「创建隔离 Worktree」→ 进到 `devflow` 仓库：
  `{"worktreeModePressed":["false","true"],"nameInput":false,"modeNote":[…,"Worktree 模式会从所选仓库创建一个隔离分支。"],"flags":0,"confirmDisabled":false}`。点确认后 `git worktree list` 从 8 项变 9 项，标题是 `devflow / vibe/1795091296672-5ba8c255 · 1795091296672-5ba8c255`；配置里默认勾选的启动选项也没带上（`flags:0`）。info 到了之后同一个对话框是 `nameInput:true, flags:2, confirmDisabled:true`。
  延迟是人为放大的，但这段代码不看时长：info 比目录列表晚回来（或 info 请求失败而 WebSocket 正常）就会走到。删会话不再清理 worktree（P3）之后，这样误建的 `vibe/<id>` 目录和分支会一直留着，要用户另外去删。
  按需求应有：R3.9「出现同样的名字输入框和规则；名字为空时确认按钮不可用」。两个新对话框已经按 d34 等 info；d34 只说了启动选项，没有考虑 Worktree 模式下「没有名字就建」这个后果。
- 依据：R3.9；d34；清单「先查再写的竞态」
- 改法：`refreshUI()` 里 `mode === 'worktree'` 时加上 `info === undefined && infoError === undefined` → 确认按钮不可用；info 失败时要么不允许 Worktree 模式，要么保留现有说明并写明「将自动命名」。顺手让普通模式也等 info（与 d34 一致），默认启动选项就不会丢。`test-session-form` / `test-legacy-daemon` 加一条「info 未到时 Worktree 模式不能确认」。
- 类别：明确错误

### [一般] 删除 worktree 的请求发出后界面没有任何「正在删除」的表示，那一行和它的菜单照常可用
- 位置：`desktop/src/renderer/worktree-dialogs.ts:541-545`（确认框一关就 `await rest.removeWorktree(req)`，期间不通知调用方）、`index.ts:1325-1333`（`handleDeleteWorktree` 只在流程结束后刷新）
- 证据：临时实例，代理把 `POST /api/v1/worktrees/remove` 延迟 6 秒（真实场景：逐个结束会话每个最长约 4 秒、删大目录，设计给的超时是 10–60 秒）。确认后 2.5 秒：`{"dialog":false,"statusBar":null,"rowStillThere":true,"rowBusyAttr":false}`，再打开该行菜单，`worktree-delete` 仍是可点的。6 秒后才一下子消失。期间用户看到的是「点了删除没反应」，再点一次会再走一遍删除流程（这一步我没有实测；按代码，同一仓库的删除在 daemon 侧串行，第二次会走到 `deleteWorktreeFlow` 的 404 分支，提示「已经不存在」，不会多删东西）。
- 依据：R5.6（确认后会话结束、worktree 被处理）没有规定过程中的显示；清单「重复提交（连点、重试）」
- 改法：`deleteWorktreeFlow` 在发出请求前后回调（或 `handleDeleteWorktree` 维护一个 `removingWorktrees: Set<machineKey|path>`），该行显示「正在删除…」、菜单项置灰，结束后清掉；与 `reloadingSessions` 的做法一致。
- 类别：取舍

### [一般] 新建 worktree 对话框：输完名字立刻回车没有任何反应
- 位置：`desktop/src/renderer/worktree-dialogs.ts:103-104`（`submit()` 见确认按钮不可用就返回；按钮在 250 ms 防抖 + 预检回来之前都不可用）
- 证据：临时实例，在名字框里输入 `wt-a` 后马上发回车：`dialog still open = true`，`confirmDisabled:true`，没有任何提示；0.8 秒后按钮才可用，再按一次回车才创建。「输名字 → 回车」是这个对话框最自然的操作顺序，手快的人每次都要按两次。
- 依据：d33（「按钮不可用时回车不做任何事」）；R3.1
- 改法：`submit()` 的入口条件改成「名字过了本地规则、info 已到、界面可用」，不要求 `nameSection.ready()`——`nameSection.confirm()` 本来就会立刻再问一次 plan，不通过就把原因显示在名字下方。
- 类别：取舍

### [一般] gui-smoke 第 11 步「快捷键不向远程发字节 / 不往输入框打字」这两条断言分不出按键有没有被拦截（终端那条已对照证实，输入框那条是推断）
- 位置：`.claude/skills/verify/scripts/gui-smoke.mjs` 的 `shortcutCase`：`'the switching keys pressed in a focused terminal send no bytes to the remote'`（`typed === '[]'`）和 `'with the focus in the chat input the keys switch sessions and type nothing into it'`（`draft === 'draft stays'`）；按键由 `pressShortcut` 以 `rawKeyDown`（不带 `text`）发出
- 证据：临时实例，用同一种发键方式（CDP `Input.dispatchKeyEvent` `rawKeyDown` + ⌘）向聚焦的终端发**不是快捷键、也没被拦截**的 ⌘K、⌘0、⌘J：冒泡阶段收到 `["KeyK:not-prevented","Digit0:not-prevented","KeyJ:not-prevented"]`，发往 PTY 的 `data` 帧同样是 `[]`。也就是说 xterm 在 macOS 上本来就不为 ⌘ 组合键发字节：没有拦截时这条断言同样成立。对话输入框那一条我没有单独做对照实验（我的临时实例没有配假 claude），属于推断：`rawKeyDown` 不带 `text` 不产生字符输入，草稿不会因为按键没被拦截而改变。它们守不住 R7.3 的后半句（「按键不被发送到远程或输入框」），真正起作用的只有「会话切换了」那一半。
  对照：同一脚本里新增的侧边栏布局检查是活的——我往页面里逐个注入 4 种样式故障（操作按钮常驻并加宽、状态行压到名字上、悬停时行变高、分支名截断不带省略号），`sidebarLayout()` 分别报出 5 / 32 / 5 / 2 个问题，基线为 0。
- 依据：R7.3；清单「测试不可能失败：没有反面情况」；design 第 10 节 T16 自己写了「真实键盘待人工确认」
- 改法：断言拦截本身，而不是它的副作用：在页面里加一个冒泡阶段的 `keydown` 监听，断言 ⌘3 / ⌘⇧] **到不了**它（或 `defaultPrevented` 为真），而 ⌘K 到得了；对话框开着时反过来（R7.4「不拦截」）。「不发字节」那条保留也行，但把名字改成它实际能证明的事。真实键盘那一步仍需人工确认，写进 test-report。
- 类别：检查放松

### [一般] 侧边栏每轮轮询整体重建，键盘焦点 3 秒左右就丢；新加的行内按钮正是靠焦点才显示的
- 位置：`desktop/src/renderer/sidebar.ts:85`（`container.textContent = ''` 后全量重建）、`index.ts:410-419`（每个响应都 `publish()` → `renderSidebar()`，现在每台机器每 5 秒两次）、`styles.css:296-312`（`.row-actions` 只在 `:hover` / `:focus-within` 时显示，注释写「the buttons stay reachable with Tab」）
- 证据：临时实例，`focus()` 到项目行的「新建 worktree」按钮（`.row-actions` 的 `opacity` 变成 1），什么都不做：3151 ms 后 `document.activeElement` 变成 `body`，按钮随之隐藏。11 秒内侧边栏被重建 4 次。用 Tab 走到某一行的「＋ / ⋯」再按回车，最多有两三秒时间；开着的行菜单的锚点按钮也会被换掉（实测一轮轮询之后菜单还留在屏幕上；重建后点它的菜单项我没有试）。滚动位置实测不受影响（252 → 252）。
  整体重建是原有做法（`renamingActive` 就是为它打的补丁），但这次它的频率翻倍，而且新增的入口（新建 worktree、删除 worktree、从侧边栏移除）在键盘下只有靠焦点才看得见。
- 依据：R8（「现有功能一个不少」之外的可达性）；清单「正确性和边界」
- 改法：最小改法是重建前记下焦点所在元素的身份（`data-testid` + 所在行的 `data-session-id` / `data-path` / `data-project-id`），重建后找回并 `focus()`；更彻底的是数据没变就不重建（对 `buildSidebarModel()` 的结果做一次浅比较）。
- 类别：取舍

### [一般] 折叠着的机器在会话归零后再也展不开：项目和 worktree 还在，但看不见也点不出来
- 位置：`desktop/src/renderer/sidebar.ts:102`（`toggle.disabled = total === 0`，`total` 只数会话）、`styles.css:151`（`.machine-toggle:disabled { opacity: 0; pointer-events: none; }`）、`sidebar.ts:148`（`list.hidden = collapsed`）
- 证据：临时实例。折叠机器（`aria-expanded=false`），随后它的会话全部结束（实验里用 REST 逐个删除，等同另一台桌面删除，或在各终端里 `exit`）。7 秒后 daemon 的 `/projects` 仍返回 `devflow(9 worktrees), new-api(1), slowrepo(1), zeta(1)`，而侧边栏：
  `{"count":"0","toggleDisabled":true,"toggleOpacity":"0","togglePointerEvents":"none","listHidden":true,"projectRowsInDom":4,"projectRowsVisible":0}`。
  在箭头原来的位置真实点击、点机器名之后都还是这个状态；用 CDP `Page.reload` 重启渲染进程（相当于重启桌面端，折叠状态存在 `localStorage` 的 `vibe-remote.collapsed-machines`）之后复验，仍是 `toggleDisabled:true, toggleOpacity:"0", listHidden:true, projectRowsVisible:0`。唯一的出路是从机器概览走目录选择器新建一个会话（`setActive` 会顺带展开），而用户要找的「在已有 worktree 上新建会话」「删除 worktree」「从侧边栏移除」入口全在被藏起来的那几行上。
  按需求应有：R2.2「项目的会话全部删除后，用户重启桌面端 → `devflow` 和它的 worktree 仍在侧边栏」；R2.1 没有会话的 worktree 行上有「新建会话」入口。`total === 0` 就禁用箭头是三层结构之前的逻辑（那时机器下面只有会话）。
- 依据：R2.2、R2.1
- 改法：`toggle.disabled = m.tree.length === 0`（没有任何项目时才禁用）；机器行右侧的数字可以继续只数会话。`test-sidebar.mjs` 加一条：折叠 + 0 会话 + 有项目时箭头可用，点了能展开。
- 类别：明确错误

### [一般] 能力状态是 `unknown` 时，界面把协议 4 的 daemon 说成「旧版」「需要升级」，删会话确认框还写着 worktree 会被一并删除
- 位置：`desktop/src/renderer/sidebar.ts:212`、`sidebar.ts:301-302`（`m.cap !== 'v4'` 一律用 `sidebar.legacy.needUpgrade`）、`index.ts:1347`（`legacyWorktree = machineCaps.get(mk) !== 'v4' && session.mode === 'worktree'`）
- 证据：临时实例，daemon 是协议 4（`/api/v1/info` 返回 `proto: 4`），代理让 `/api/v1/projects` 从启动起就返回 500（请求超时同理），重启渲染进程（CDP `Page.reload`）：
  - 项目行「新建 worktree」按钮 `{"disabled":true,"title":"需要升级这台机器的 vibe-remoted"}`；
  - 删除一个 Worktree 模式会话的确认框：`这台机器的 vibe-remoted 是旧版：工作区干净时，worktree 的目录和分支会被一并删除；有未提交改动时会保留。` ——对这台 daemon 是错的（协议 4 删会话不动 worktree）。`/projects` 恢复后同一个确认框变成 `worktree wt-c 的目录和分支都会保留…`。
  - 正常启动时也会闪一下：重启后 t+3 s（第一份 `/projects` 还没回来）按钮的提示就是「需要升级…」。
  置灰本身符合 design 6.4；说错话的是文案。项目说明里写的是「断网不等于旧 daemon」，而 `unknown` 恰恰是「还不知道」。
- 依据：R9.1（只对协议 3 的 daemon 要求这些文案）；design 7.4 写的是「`legacy` / `unknown` 时置灰并提示升级」「能力状态不是 `v4`」——实现与设计一致，问题在设计
- 改法：`unknown` 用中性的说法（如「还没读到这台机器的项目列表」），只有 `legacy` 才说升级；`legacyWorktree` 改为 `machineCaps.get(mk) === 'legacy'`，`unknown` 时两句说明都不写（或写「取决于 vibe-remoted 的版本」）。
- 类别：取舍

### [一般] 800×500 下勾选「续上次会话」后，R6.1 的说明落在对话框可见区域的下沿之外
- 位置：`desktop/src/renderer/session-form.ts:101-105`（`syncContinueNote()` 把说明插到选项下面，不滚动到可见）
- 证据：临时实例，800×500，在已有会话的主目录行上点「新建会话」，勾选 `continue`：中文 `{"noteTopBottom":[376,432],"bodyBottom":415,"visiblePx":39,"noteHeight":56}`（56 px 高的说明露出 39 px）；英文文案更长，截图上只露出说明框顶上一条边，要自己往下滚才读得到。确认按钮不受影响（H20）。
- 依据：R6.1「对话框显示一句说明」；R8.5
- 改法：说明插入后 `continueNote.scrollIntoView({ block: 'nearest' })`。
- 类别：取舍

## 待验证项

1. **[一般] 删除 worktree 时 daemon 回 404，桌面端把确认框里列的会话都当成「已结束」并关掉它们的视图**
   - 关联：R2.5（worktree 在别处被删、会话还在）、design 6.2 的表「404（删除时）→ `ended` 并上这次请求里的 `sessions`」
   - 已查到：`worktree-dialogs.ts:573-577`（`addEnded(req.sessions)`）→ `index.ts:1331`（`dropSessionView`）。404 是 daemon 在动手之前返回的（design 6.2 第 1、2 步），此时它没有结束任何会话；如果 worktree 是被别人 `git worktree remove --force` 掉的，原来的会话进程还活着。
   - 缺什么：没有在真实 daemon 上复现「确认框开着时 worktree 被外部删除、会话仍在运行」。
   - 最小实验：在有 1 个终端会话的外部 worktree 上打开删除确认框 → 另开终端 `git worktree remove --force <path>` → 点确认。若该会话的视图被关掉而 `/api/v1/sessions` 里它还在（侧边栏显示「目录已不存在」），即确认；若 daemon 此时返回的不是 404 或会话已不在，则排除。
2. **[一般] 项目只有一个被列出的 worktree 且它不是主目录（主目录在白名单之外，R2.6）时，这个 worktree 没有删除入口，「新建 worktree」置灰却没有原因**
   - 关联：R5（删除 worktree 是 worktree 上的操作）、R2.6、H3
   - 已查到：`tree.ts:222`（`flat = worktrees.length <= 1`，不看是不是主目录）→ `sidebar.ts:253-256` 扁平项目不渲染 worktree 行，也就没有 `worktree-menu`；`sidebar.ts:226-229` `!hasMain` 时按钮 `disabled`，而 `upgradeTitle` 在 `v4` 下是空串，提示仍是「新建 worktree」。
   - 缺什么：没有搭「`allowed_roots` 只含 worktree 目录、不含主目录」的 daemon 来看 `/projects` 实际返回什么。
   - 最小实验：临时 daemon 的 `allowed_roots` 只给 `<root>/repo-wt`，仓库主目录在 `<root>/repo`，在 `repo-wt/a` 里开一个会话。若侧边栏是一行扁平项目、行上没有「⋯ → 删除 worktree」，即确认。
3. **[一般，daemon 侧，不在本次桌面端范围] 工作目录名以 `;` 结尾时终端会话建不起来**
   - 关联：R4.2「会话在该目录启动」
   - 已查到：做不可信内容实验时，在目录 `…/<u>proj&amp;` 里经 WebSocket 新建终端会话，daemon 返回 `create session: tmux session vibe-remote-… did not become ready`；改名为 `<u>proj&x` 后正常。tmux 把参数末尾的 `;` 当命令分隔符，是已知行为。
   - 缺什么：只出现过这一次，没有分别试 `;` 和 `&`，也没有在基准 `6d88e45` 上对照（很可能是原有问题）。
   - 最小实验：`mkdir '/tmp/<root>/a;'`，用 `startSession()` 在其中新建会话；再在基准提交构建的 daemon 上重复一次。

## 覆盖范围

**读过的文件**：`spec.md` 全文；`design.md` 4.2–4.7、4.10、6.2、6.4、6.5、7.4、7.5、第 10 节；`decisions.md` d11–d18、d23–d25、d30–d41；评审清单；`desktop/src/renderer/` 的 `tree.ts`、`sidebar.ts`、`index.ts`（全文）、`worktree-dialogs.ts`、`session-form.ts`、`dirpicker.ts`、`worktree-name.ts`、`shortcuts.ts`、`menu.ts`、`modal.ts`、`theme.ts`，`rest.ts` / `client.ts` / `chat/availability.ts` / `main/index.ts` 的改动，`i18n.ts` 新增和改写的全部键（中英文），`styles.css` 的侧边栏、行内按钮、菜单、标题几段，`index.html`；`.claude/skills/verify/scripts/sidebar-layout.mjs` 全文和 `gui-smoke.mjs` 的改动。

**跑过的检查和实验**（都在临时实例上）：
- `npm run typecheck`、`npm test`、`gui-smoke.mjs --no-build`：全绿。
- 轮询：一个仓库 git 卡住时的项目树（含重启）；`/projects` 从启动起失败（`unknown`）；`/projects` 404（旧 daemon 的分组、说明条、主目录行、删会话文案，中英文 800×500，`sidebarLayout()` 0 问题）；100 个项目 × 5 个 worktree × 2 个会话（1600 行）下 15 秒内没有超过 50 ms 的长任务；重建不影响滚动位置；重建后键盘焦点丢失。
- 新建：新建 worktree 对话框的本地校验（空格、`-` 开头、`..`、`@{`）、分支已存在、目录 / 文件冲突、合法名字的目标目录、回车提交，实际建出 `devflow-worktrees/wt-a` 和分支；info 延迟时的目录选择器 Worktree 模式；在 worktree 行上新建会话的标题、路径、没有目录列表（R4.1）；`-c` 说明在有 / 没有会话的目录下出现 / 不出现（R6）。
- 删除：`commits` 形态的默认按钮、改选后回车 = 取消且不发请求、改回「保留分支」后回车发出的请求体不带 `deleteBranch`（目录删除、分支保留）；`clean` 形态确认框打开后外部新增文件 → 409 → 重新确认框是 `files` 形态、带「状态变了」和「分支会一并删除」、默认取消、回车不再发请求、文件还在；请求体与界面逐项核对一致，没有发现「看到 A、发出 B」的路径；慢删除期间的界面。
- 不可信内容：分支名 `x/<img/src=x/onerror=…>&"q'…`、目录名 `<b>evil&dir`、`<u>proj&x`、会话名 `<img src=x onerror=…><b>bold</b>`，经侧边栏、标题、新建会话对话框、删除 worktree / 删除会话确认框，中英文各一遍：没有脚本执行，没有注入的元素；`chat/` 之外没有 `innerHTML`。
- 布局：以上各对话框在 800×500 中英文下，对话框在窗口内、底部按钮可命中、没有不带省略号的截断；行菜单在窗口底部；标题在长分支下。
- 冒烟脚本：对 `sidebarLayout()` 注入 4 种样式故障（都能报出）；用非快捷键的 ⌘ 组合键对照「不发字节」的断言。

**没来得及看或没法验证的**：
- 真实键盘和输入法下的快捷键（约束不允许向系统前台发键；CDP 事件不经过系统菜单和输入法）。
- 对话视图的外观（R8.1）没有自己起带假 claude 的实例核对，只看了开发者的截图和 `gui-smoke` 的对话用例通过；终端外观、冷启动不闪（R8.6）、对比度（R8.4，只依赖 `test-theme-tokens`）同样没有独立测量。
- 真正的协议 3 daemon 二进制没有构建，旧 daemon 的情形是用「`/projects` 返回 404」模拟的（`info.proto` 仍是 4，所以目录选择器里「旧 daemon 不出现名字输入框」那一半没有覆盖）。
- R3.7 创建中途断线的重放只读了 `client.ts` 的改动和现有单测，没有在界面上断网复现；R2.5「目录已不存在」、R1.6 状态点上卷、通知标题只读了代码。
- `desktop/scripts/` 下新增的单元测试没有逐个审断言强度；`styles.css` 其余部分、`protocol.ts` 三处对齐（另有评审者负责）没有看。
