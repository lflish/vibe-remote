# 裁决记录 · 按项目和 worktree 组织会话

规则见 dev-workflow/references/decisions.md。只追加，不修改旧行。

| # | 阶段 | 决定 | 类型 | 依据 | 理由 | 放弃的选项 | 定错的代价 | 处理结果 |
|---|------|------|------|------|------|------------|------------|----------|
| 1 | 需求 | 规模定为标准 | 机械 | 规模表 | 涉及侧边栏、目录选择器、协议、会话管理和 worktree，远超 3 个文件，且改对外协议 | 小 | 低 | — |
| 2 | 需求 | 现状用临时 daemon 实验查清（同目录多会话、`-c` 互斥、worktree 创建与删除），不拿去问用户 | 机械 | 运行结果 | 行为都能运行观察到；结果写在 spec「现状」 | 只读代码推断 | 低 | — |
| d1 | 需求 | 需求分支从 `change/dual-mode` 开（不是默认分支），并在 `.devflow-tmp/worktrees/project-worktrees` 里做 | 口味 | 原则6 | 需求依赖对话会话，且 `docs/changes/`、`.devflow.yml` 还没进 main；主目录有未提交改动、本机 daemon 正从主目录运行，不切它的分支 | 从 main 开分支；在主目录切分支并 stash | 低：双模式合并后变基即可 | — |
| 3 | 需求 | 评审回复按意思处理：做三层组织和 worktree 功能，另加视觉风格；未逐项回答的 E、Q 按推荐，写进假设 H5–H8 | 机械 | questions.md「部分回答」 | 用户回复「视觉风格修改下吧，功能点不变，还有最初讨论的几个功能」 | 再追问一轮 | 低：关口 A 都能改 | — |
| d2 | 需求 | 视觉风格并入本需求，不另开需求 | 口味 | 原则3 | 侧边栏既改结构又改样式，是同一块代码；分两个需求会改两遍并互相冲突 | 另开 visual-restyle 需求 | 中：需求变大，关口 A 说明 | — |
| d3 | 需求 | 「视觉风格」理解为配色加形态（侧边栏条目、标题、消息气泡、输入框），不含参考图里的功能 | 口味 | 用户原话「功能点不变」 | 只换配色达不到参考图的观感；功能明确不要 | 只换配色；连功能一起做 | 中：效果页上可见，关口 A 可改 | — |
| 4 | 需求 | 新人通读检查的 8 个问题：7 个按默认定进假设或场景（H16–H19、R5.11、R9.1/R9.2、H26），信任规则 1 个带默认放到关口 A（Q5） | 机械 | dev-requirements 第 6 步 | 前 7 个合理的开发者可以定且关口 A 可改；信任规则是安全边界 | 全部自己定；全部拿去问 | 低 | — |
| d4 | 需求 | 状态点加形状区分（空心灰 / 实心绿 / 带光圈的黄） | 口味 | 运行结果 | 效果页实测三种点两两亮度比只有 1.1–1.4 | 只靠颜色 | 低：效果页可见，关口 A 可改 | — |
| c1 | 需求 | 协议版本由 3 升到 4（新增 worktree 列表、命名 worktree、删除 worktree 的字段或端点） | 只有人能做 | `.devflow.yml` human_decisions | 旧 daemon 会静默忽略新字段，客户端要靠版本号判断并降级（R9.1） | 不升版本，靠探测 | 中 | 关口 A Q6 |
| c2 | 需求 | 改写 CLAUDE.md 里「外壳 UI 对标 Claude Desktop」的表述，以选定的视觉方案为准 | 只有人能做 | `.devflow.yml` human_decisions；规则文件 | 选 M1 或 M2 后原表述不再成立 | 不改 | 低 | 关口 A Q7 |
| 5 | 需求 | 关口 A 通过：视觉方案 M1；Q5 按 A；c1（协议版本 3 升 4）同意；c2（改写 CLAUDE.md 的风格表述）同意；两处界面修复提交到 `change/dual-mode`；假设不变 | — | 用户回复 | 「按照推荐1来吧」，未提到的按默认 | — | — | 用户确认 |
| 6 | 设计 | 项目和 worktree 的树走新端点 `GET /api/v1/projects`；`/api/v1/sessions`、`sessions` 帧、`ready` 帧一个字段都不加，会话归属写在树里（`worktrees[].sessions`） | 机械 | 原则1（不变的规则） | 终端会话的帧要逐字节不变，现有 golden 连 `sessions` 帧的外层都逐字节比对；这样 `TestTerminalFramesUnchangedV3` 一个字不用改 | 给 `sessions[]` 加归属字段；把树并进 `/api/v1/sessions` | 低 | — |
| 7 | 设计 | 列表里每个项目只跑一次 `git worktree list --porcelain`，8 路并发；未提交文件数、未合并提交数只在删除确认时现查 | 机械 | 运行结果 | 20 仓库 × 5 worktree：顺序 477 ms，8 路并发 116 ms；若把 `git status` 放进列表，100 个 worktree 顺序 2.6 s、8 路并发 536 ms（evidence/perf-list.txt） | 列表里带改动数；顺序执行；读 `.git` 内部文件省掉进程（reftable 下不成立） | 中：超出 200 ms 预算 | — |
| 8 | 设计 | 新建 worktree 在 daemon 内按仓库串行；跑 git 之前自己查分支和目录是否已存在；失败后清掉本次建出的分支和目录 | 机械 | 运行结果 | 实测 `git worktree add -b <新分支> <已存在的目录>` 和「父目录不可写」都会先建出分支再失败，分支留在仓库里（evidence/git-probe.txt）；不串行就分不清残留分支是自己的还是并发请求的 | 只靠 git 自己报错；不加锁 | 中：R3.5、R3.8 的「不留下半截分支」不成立 | — |
| 9 | 设计 | 信任规则里「这个目录是不是该仓库的 worktree」以仓库自己的 worktree 列表为准，不看目录自称 | 机械 | 运行结果 | 实测伪造一个 `.git` 文件指向受信任仓库的 worktree 管理目录后，`rev-parse --git-common-dir` 会指向受信任仓库，但 `git worktree list` 不会列出这个伪造目录（evidence/git-probe.txt） | 用 `rev-parse --git-common-dir` 反推主目录 | 高：安全边界被绕过 | — |
| 10 | 设计 | 快捷键在 `window` 的 keydown 捕获阶段拦截并 `preventDefault` + `stopPropagation` | 机械 | 运行结果 | 调试实例实测：xterm 聚焦时 ⌘1/⌘3/⌘9/⌘⇧[/⌘⇧] 捕获监听全部收到，发往 PTY 的字节为 0；普通键照常到 PTY；应用菜单没有占用这些键（evidence/shortcut-probe.txt） | 主进程 `before-input-event`；自定义菜单加速键 | 低 | — |
| 11 | 设计 | 断言旧行为的测试按已确认的 spec 改写为断言新行为，不算放松检查：会话删除相关 6 个（H16、H10：`TestChatWorktreeAndFlags` 末段、`TestManagerDeleteRecoveredCleanWorktreeRemovesGitResources`、`TestManagerDeleteDirtyWorktreeStopsSessionAndPreservesGitResources`、`TestDeleteDirtyWorktreeReturnsStructuredConflict`、`TestWorktreeDirtyCleanupPreservesBoth`、`TestWorktreeIgnoredFileIsPreserved`）、`TestInfoAndReadyProto3` 的 3 改 4（c1 已同意）；每个改写后仍是一个断言同等严格的测试，design 7.1 列出新旧断言 | 机械 | 原则1 | 关口 A 确认的 H16 写明 409 `worktree_preserved` 不再出现、删会话不动 worktree；H10 写明被忽略的文件不算改动；测试必须跟着 spec | 保留旧测试（与 spec 矛盾，无法同时通过）；记成 c 等用户 | 低 | — |
| 12 | 设计 | 改侧边栏和对话框结构的任务负责同步调整 `gui-smoke.mjs`、`gui-chat-smoke.mjs` 里的选择器，用例数和断言不动；现有元素的 class 名尽量保留 | 机械 | spec 完成条件 | 完成条件写明「选择器可随结构调整」；这两个脚本是测试代码，不是约束 AI 的规则 | 留给 dev-test 统一改（期间冒烟一直是红的） | 低 | — |
| d5 | 设计 | 先行修复（H8）的过渡行为：工作区干净但分支有未合并提交时，目录和分支都保留，返回现有的 409 `worktree_preserved` | 口味 | 原则3 | 不丢任何东西；沿用桌面端已有的「Worktree 已保留」提示，桌面端零改动；最接近最终状态（都保留） | 删目录、留分支、返回 204（用户不知道提交留在哪个分支） | 低：最终状态下这段逻辑不再被会话删除调用 | — |
| d6 | 设计 | 项目清单和「由 vibe-remote 创建的 worktree」记录同存 `<state_dir>/projects.json`；判定 managed 时要求路径和当前分支都与记录一致 | 口味 | 原则2 | 沿用 `chat-sessions.json` 的原子写做法；H17/H18 写的是 daemon 记下 | 写进仓库的 git 配置 `branch.<名字>.*`（分支删了记录自动消失，但会改用户仓库的配置） | 中：换存储位置要迁移记录 | — |
| d7 | 设计 | 新桌面端识别旧 daemon：每轮轮询请求 `/api/v1/projects`，200（带 `proto`）= 新，404 = 旧版并按会话自带信息分组；目录选择器沿用它已经请求的 `/api/v1/info.proto` | 口味 | 原则3 | 每轮自带判断，不存在缓存过期（daemon 原地升级也能在下一轮发现）；旧 daemon 实测对新路径返回 404（evidence/shortcut-probe.txt） | 每台机器缓存 `/info` 的 proto 并在各种时机刷新 | 低 | — |
| d8 | 设计 | 新建命名 worktree 沿用 attach（加 `worktreeName`），对话框里的即时校验和「基于哪个提交」来自 `GET /api/v1/worktrees/plan` | 口味 | 原则2 | 复用现有的幂等重放、失败回滚、信任检查；R9.2 的旧路径本来就要保留 | 先用 REST 建好 worktree，再发普通 attach（出错更容易留在对话框里，但要另做一套幂等，且建好后会话没起来会留下空 worktree） | 中：换做法要改协议 | — |
| d9 | 设计 | 删除 worktree 分两步：`GET /worktrees/status` 给出确认框上的数字；`POST /worktrees/remove` 带上用户看到的 HEAD、要结束的会话和同意丢弃的内容，daemon 删除前重查，不一致返回 409 `worktree_changed` 和最新状态，桌面端重新弹确认 | 口味 | 原则3 | 用户确认的是什么，daemon 就只做什么；带同意项而不是逐个数字比对，避免会话还在写文件时反复对不上 | 一次请求带 `force`；回传每个数字逐一相等比对 | 中 | — |
| d10 | 设计 | 会话行第一行不显示相对时间（效果页 M1 上有「3 分钟前」） | 口味 | 原则1（功能点不变） | 协议里没有「最近活动时间」，终端会话更是没有来源；用创建时间冒充会误导 | 显示创建时间；给协议加最近活动时间 | 低：关口 B 汇总里可改 | — |
| d11 | 设计 | 折叠的项目行只上卷「等你处理」这一种状态点 | 口味 | 原则1 | R1.6 只要求这一种 | 三种状态都上卷，取最紧急的 | 低 | — |
| d12 | 设计 | 同一 worktree 下重名会话的序号由桌面端按创建顺序加（`fix-login 2`），daemon 下发的 `title` 不变 | 口味 | 原则1（不变的规则） | 改服务端 `title` 会改变终端会话 `sessions` 帧里的值；序号只是显示 | daemon 生成带序号的默认名 | 低 | — |
| d13 | 设计 | `-c` 说明（R6）的触发条件：勾选了 id 为 `continue` 的启动选项，且目标 worktree 下已有会话 | 口味 | 原则2 | daemon 的重载逻辑和示例配置已经用 `continue` 这个 id 表示续接；`/api/v1/info` 不下发 `arg` | 给 `/api/v1/info` 的每个 flag 加「是否续接」字段 | 低 | — |
| d14 | 设计 | 终端只换底色、前景色、光标、选区四个颜色，16 个 ANSI 色保持现值 | 口味 | 原则1 | R8.2 只列了这四项；现有 ANSI 色在白底上对比度足够 | 重新配一套 ANSI 色 | 低 | — |
| d15 | 设计 | 删除会话的确认从系统 `confirm` 换成应用内对话框；重载、交接、删除机器的 `confirm` 不动 | 口味 | 原则1 | R5.1 的文案要写明 worktree 和分支会保留，R8.5 要量删除确认框的布局，效果页也画成了应用内对话框；其余确认不在本次范围 | 只改 `confirm` 的文字 | 低 | — |
| c3 | 设计 | 更新约束 AI 的规则文件：CLAUDE.md 里除 c2 那句以外的内容（协议版本 4 与新端点、会话归属与项目清单、删会话不再动 worktree、信任规则、客户端侧边栏模型）；`.devflow.yml` 的 `invariants` 新增 6 条（design 7.1）；`.claude/skills/protocol-sync/SKILL.md` 第 4 步补 v4 的核对项 | 只有人能做 | 规则文件 | 不更新的话，这些文件描述的是旧行为（例如「版本当前为 3」「worktree 模式查所选的源目录本身」） | 不改 | 低：只影响文档与规则是否与代码一致 | 等用户；T16 阻塞 |
| d16 | 设计 | （补记：design 4.2 已按此写，当时漏记）daemon 重启后找回的终端会话，`created` 仍是找回的时刻（现有行为不改）；同一批时间相同的靠会话 id 排先后 | 口味 | 原则1（不变的规则） | 改 `created` 的来源会改变终端会话 `sessions` 帧里的值；会话 id 以创建时的毫秒时间戳开头，足够排出先后，R1.5 只要求没有新建和删除期间顺序不变 | 把创建时间存进 tmux 用户选项 | 低：重启后同一 worktree 下的会话可能与重启前的先后不同，之后保持稳定 | — |
| d17 | 设计 | （补记：design 7.4 已按此写）`-c` 说明用的「已有会话数」：在 worktree 行上新建时是该 worktree 节点的会话数；目录选择器普通模式是这台机器上 `workdir` 等于当前所列目录的会话数；Worktree 模式和新建 worktree 对话框恒为 0 | 口味 | 原则2 | `-c` 续的是这一个目录最近的对话；新 worktree 里没有会话 | 目录选择器里按所在 worktree 统计（子目录的会话也算进来，会误报） | 低 | — |
| d18 | 设计 | （补记：design 7.4 已按此写）删除会话的确认框初始焦点在「取消」 | 口味 | 原则1 | 被替换掉的系统 `confirm` 回车是确认；删除会终止远程进程、无法撤销，回车不应直接删（与 H22 的方向一致） | 初始焦点在「删除会话」 | 低 | — |
| 13 | 设计 | 等 c3 的任务在 tasks.md 里是 T20（c3 那一行写的「T16」是拆任务之前的编号；T16 是快捷键） | 机械 | 运行结果 | design.md 的 7.1 和第 9 节 V7 都按 T20 = 规则文件、T16 = 快捷键引用；decisions.md 只追加，不改旧行 | 改 c3 那一行 | 低 | — |
| d19 | 设计 | 扁平项目行（不显示 worktree 层）上的「新建会话」：git 项目用它唯一的那个 worktree，非 git 项目用项目目录本身（`path` = 项目 id，`label` = 项目名），都走 `openWorktreeSessionDialog`；读取失败、没有任何可用 worktree 的 git 项目不显示这个按钮 | 口味 | 原则2 | design 7.4 的 DOM 列了 `project-new-session`（flat 时），但没写非 git 项目没有 worktree 节点时打开什么；R1.3 只排除了分支名和 worktree 相关的入口，在该目录再开一个会话是普通新建 | 非 git 项目不提供这个按钮（只能回机器概览从目录选择器进） | 低 | — |
| d20 | 设计 | 新桌面端连旧 daemon 的各个降级分支，写在引入对应入口的任务里（T5 分组、T6 说明条和置灰、T9 名字段、T12 删除文案、T14 删除入口）；T17 只做整体核对（对着协议 3 的假 daemon 跑一遍渲染进程入口、只用协议 3 的帧走一遍新 daemon）并补 `docs/protocol.md` 的版本互连说明 | 口味 | 原则3 | 入口一出现就必须判断版本：旧 daemon 会静默忽略 `worktreeName`（design V9），留到后面的任务再判断，中间状态会建出自动命名的 worktree | 所有降级分支集中在 T17 实现 | 低 | — |
