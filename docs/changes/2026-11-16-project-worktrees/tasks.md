# 任务：按项目和 worktree 组织会话，并更换视觉风格

依据：spec.md、design.md　共 21 个任务（T1–T20，其中 T6 拆成 T6a 和 T6b；开发中另加返工任务 T6c）　更新：2026-11-19（按第二轮工程评审和用户的三个决定修订，decisions #28–#40、d28–d31、c5；上一次是 2026-11-18 按第一轮工程评审修订，#16–#27、d22–d27、c4）

## 约定

这些约定对所有任务生效，任务里不再重复。

- 接口的名字和签名以 design.md 第 4 节为准；任务里只写用到和提供的名字，章节号（如 4.2、6.1）都指 design.md。
- 改协议的任务（T4、T7、T8、T10、T12、T13）在同一个任务里把三处一起改完：`vibe-remoted/internal/protocol/protocol.go`、`desktop/src/shared/protocol.ts` 与 `desktop/src/renderer/rest.ts`、`docs/protocol.md`。这些任务的完成定义都包含「按 `/protocol-sync` 现有的第 1–3 步（逐帧、逐端点列表比对 JSON 名、可缺省性、路由）核对，三处无差异」；v4 专用的核对项到 T20 才写进那个 skill，不影响这里的核对。
- 新增的界面文案，中英文键在用到它的任务里一起加进 `desktop/src/renderer/i18n.ts`，键名和中文原文照 design 7.4「文案」表；`cd desktop && npm run test:i18n-parity` 必须通过。
- 新增的 desktop 测试脚本放 `desktop/scripts/`，写法同现有脚本（`chat-test-util.mjs` 的 `load()` 用 esbuild 打包后导入；需要 DOM 的用 jsdom），并在 `desktop/package.json` 里加 `test:<名字>` 且接进 `test` 这一串，所以 `make check` 会跑到。下文写成 `test-tree.mjs › 用例名`。
- Go 测试里的 git 仓库一律建在 `t.TempDir()` 里。所有跑 Go 测试的命令前都带独立的 `TMUX_TMPDIR=$(mktemp -d)`（不管这一组测试用不用 tmux），不和本机正在用的 vibe-remote 会话共用 socket。完整检查因此写成 `TMUX_TMPDIR=$(mktemp -d) make check`。
- **只用临时实例**（decisions #18）。任何任务、任何完成定义里启动的 daemon、Electron、tmux 都必须是临时的：随机端口、临时配置和 `state_dir`、临时 userData、`--use-mock-keychain`、独立的 `TMUX_TMPDIR`、独立的 `CLAUDE_CONFIG_DIR`。不连接本机正在运行的 daemon（127.0.0.1:8765），不碰默认 socket 上的 `tmux -L vibe-remote`，不用固定的调试端口（如 9222），不直接启动构建产物去读真实的 userData、machines.json 和钥匙串。需要一个开着的应用时，用 `gui-smoke.mjs --keep` 留下的实例。
- daemon 里交给 git 的分支只写成完整引用名 `refs/heads/<名字>`，不调用 `git branch`，不用 `worktree add -b`；git 调用都经 `gitAt` / `gitAtTimeout`（固定 `LC_ALL=C`），不靠匹配 git 的报错文字做判断（design 4.9、7、7.1 第 7 条新规则）。
- 每个任务的完成定义除了自己列的命令，都还包含：`TMUX_TMPDIR=$(mktemp -d) make check` 退出码为 0。
- 新写的 CSS 只用 `var(--…)`，不写颜色字面量（T18 会断言 `:root` 之外没有颜色字面量）；唯一的例外是项目行标签的 `hsl(var(--tag-hue) var(--…) var(--…))`，参数全是变量，不算字面量（design 7.5）。TS 里不写颜色。T18 之前的任务只追加新规则，不改现有规则的颜色和形态。
- 改了侧边栏或对话框结构的任务（T6b、T9、T12、T19）负责同步调整 `.claude/skills/verify/scripts/gui-smoke.mjs`、`gui-chat-smoke.mjs` 里的选择器，用例数和断言不动（decisions #12）。
- 完成定义里的 `gui-smoke.mjs`、`gui-chat-smoke.mjs` 都在仓库根执行，命令前都带 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX)`。脚本自己会 `vite build`，并使用临时 daemon（20000–29999 的随机端口，配置和 `state_dir` 在临时目录）、临时 userData、`--use-mock-keychain` 和 30000–39999 的随机调试端口，不碰本机正在运行的 daemon 和 machines.json。必须带 `TMUX_TMPDIR` 的原因：`gui-smoke.mjs` 的终端 daemon 直接继承环境，脚本只给对话 daemon 设了独立的 tmux 目录（design V16），不带的话它会和本机真实 daemon 共用 `tmux -L vibe-remote`。基线：`gui-chat-smoke.mjs` 有 26 个 `test(` 用例，`gui-smoke.mjs` 有 14 处 `check(`；两个数只能增不能减。
- 浏览器层的测试统一由 dev-test 写，实现任务负责加任务里列出的 `data-testid`。

## 测试计划

层级：「Go 单元」是包内直接调用函数；「Go 集成」是经 `httptest` 或真实 WebSocket 走 `internal/server`；「desktop 单元」是 `desktop/scripts/test-*.mjs`；「浏览器」是用 CDP 驱动构建产物；「协议冒烟」是不经界面、直接对临时 daemon 发 REST 和 WebSocket 帧。「浏览器」和「协议冒烟」两层（多数由 dev-test 写）同样只用临时实例：随机端口的临时 daemon、临时 `state_dir` 和 userData、`--use-mock-keychain`、独立的 `TMUX_TMPDIR`，git 仓库建在临时目录里；不连 127.0.0.1:8765 的真实 daemon。

示例值照 spec：机器 `this-mac`，项目 `devflow`（主目录在 `main`），外部 worktree `.devflow-tmp/worktrees/general-skills`（分支 `change/general-skills`）。

| 场景 | 层级 | 测试名 | 要点 | 谁写 |
|------|------|--------|------|------|
| R1.1 | Go 集成 | `TestProjectsTree` | 主目录 1 个对话会话、`fix-login` 1 个终端会话 → `projects[0].worktrees` 两项，`branch` 为 `main`、`fix-login`，各自的 `sessions` 含对应会话 id | T4 |
| R1.1 | desktop 单元 | `test-tree.mjs › two_worktrees_each_with_session`、`test-sidebar.mjs › renders_three_levels` | 树里 1 个项目 2 个 worktree 节点；DOM 里 2 个 `worktree-row`，两个 `session-row` 各在自己的 `.worktree-group` 里，带 `data-ui` 和 `data-dot` | T5、T6b |
| R1.1 | 浏览器 | R1.1 一个项目两个 worktree 都有会话 | `this-mac` 下有 `devflow`，其下两行显示 `main` 和 `fix-login`，会话行有界面类型图标和状态点 | dev-test |
| R1.2 | desktop 单元 | `test-tree.mjs › single_worktree_is_flat`、`test-sidebar.mjs › flat_project_has_no_worktree_row` | `new-api` 只有主目录、2 个会话 → `flat` 为真、`branchLabel` 是当前分支；DOM 里没有 `worktree-row`，`project-branch` 的文字是分支名 | T5、T6b |
| R1.2 | 浏览器 | R1.2 项目只有一个 worktree | 2 个会话直接列在 `new-api` 下，项目行显示分支名 | dev-test |
| R1.3 | Go 单元 | `TestResolveHomeNonGit` | 非 git 目录 `notes` → `Home{Project: 目录, Path: 目录, Git: false}` | T2 |
| R1.3 | Go 集成 | `TestProjectsNonGitProject` | `git:false`，`worktrees` 为 `[]`，会话在项目级 `sessions` 里，没有 `error` | T4 |
| R1.3 | desktop 单元 | `test-tree.mjs › non_git_project`、`test-sidebar.mjs › non_git_has_no_worktree_entries` | `flat` 为真、没有 `branchLabel`；DOM 里没有 `project-branch`、`project-new-worktree`、`project-menu` | T5、T6b |
| R1.3 | 浏览器 | R1.3 不在 git 仓库里的目录 | 会话在名为 `notes` 的项目下，没有 worktree 层和分支名 | dev-test |
| R1.4 | desktop 单元 | `test-tree.mjs › duplicate_names_get_numbers` | 同一 worktree 下 3 个 `title` 都是 `devflow` 的会话，按创建顺序得到 `devflow`、`devflow 2`、`devflow 3`；改过名的不加序号 | T5 |
| R1.4 | 浏览器 | R1.4 同一 worktree 下多个未改名的会话 | `main` 下先后开 3 个会话，3 行显示名互不相同 | dev-test |
| R1.5 | Go 集成 | `TestProjectsOrderStable` | 3 个项目共 8 个会话，连续请求 40 次，响应体逐字节相同；项目按小写名称、主目录在前其余按分支名、会话按 `created` 再按 id | T4 |
| R1.5 | Go 集成 | `TestCreatedSurvivesRestartTmux`、`TestProjectsOrderSurvivesRestart` | 同一 worktree 下先后建 2 个终端会话，用新的 `Manager` 找回（相当于 daemon 重启）→ 两个会话的 `created` 与重启前相同（来自 tmux 选项 `@vibe_remote_created`），`/api/v1/projects` 里的先后不变（d23）。`TestCreatedSurvivesRestartTmux` 在 `TZ=Asia/Shanghai` 下再跑一遍：重启前后都是 `…+08:00`，读回的 UTC 时间已转成本地时区 | T2、T4 |
| R1.5 | desktop 单元 | `test-tree.mjs › keeps_daemon_order`、`legacy_order_sorted` | 新 daemon：不重排；旧 daemon：在桌面端按同样规则排，打乱输入 40 次结果相同 | T5 |
| R1.5 | 浏览器 | R1.5 顺序稳定 | 等 40 次轮询刷新，每次读侧边栏各行的顺序，全部相同 | dev-test |
| R1.6 | desktop 单元 | `test-tree.mjs › rollup_waiting_only`、`test-sidebar.mjs › collapsed_project_shows_waiting_dot` | 任一会话的点是 `waiting` → `projectRollup` 返回 `waiting`，只有 `idle` 或 `output` → `none`；折叠时项目行有 `project-dot`，展开后项目行没有、会话行 `data-dot="waiting"` | T5、T6b |
| R1.6 | 浏览器 | R1.6 折叠的项目里有会话在等用户 | 折叠 `devflow`，对话会话出现待答的权限请求 → 项目行有「等你处理」的点；展开后会话行有同样的点 | dev-test |
| R1.7 | desktop 单元 | `test-tree.mjs › session_context_and_notification_title`、`test-sidebar.mjs › toolbar_title_parts` | 通知标题 `this-mac · devflow / fix-login · 登录修复`，非 git 时 `this-mac · notes · <会话名>`；标题栏 `title-project`=`devflow`、`title-branch`=`fix-login`、`title-session`=`登录修复`，不含机器名 | T5、T6b |
| R1.7 | 浏览器 | R1.7 标题和通知带上项目与分支 | 顶部标题和后台会话触发的通知标题都含 `devflow`、`fix-login`、`登录修复` | dev-test |
| R1.8 | Go 单元 | `TestListWorktrees` | detached 的一项 `Detached` 为真、`Branch` 为空、`Head` 是 40 位哈希 | T2 |
| R1.8 | desktop 单元 | `test-tree.mjs › detached_label_is_short_hash` | `label` 是 7 位 `head`，不是空串 | T5 |
| R1.8 | 浏览器 | R1.8 worktree 当前不在任何分支上 | 该行显示提交的短哈希 | dev-test |
| R2.1 | Go 集成 | `TestProjectsListsSessionlessAndExternal` | 用 `git worktree add` 直接建的 `change/general-skills`（没有会话）在列表里，`sessions` 为 `[]`，没有 `managed` 和 `main` | T4 |
| R2.1 | desktop 单元 | `test-sidebar.mjs › empty_worktree_row` | 该行下有 `worktree-empty`（文字「没有会话」）和 `worktree-tag-external`；传了回调时有 `worktree-new-session` 按钮 | T6b |
| R2.1 | 浏览器 | R2.1 别的工具建的、没有会话的 worktree | `devflow` 下有一行 `change/general-skills`，标明没有会话，有「新建会话」入口 | dev-test |
| R2.2 | Go 单元 | `TestProjectStoreRoundTrip` | `AddProject` 后重新 `OpenProjectStore`，`Projects()` 仍含该 id | T3 |
| R2.2 | Go 集成 | `TestProjectsSurviveSessionDeletionAndRestart` | 删掉 `devflow` 的全部会话，再用同一个 `state_dir` 新建 `Manager` → `/api/v1/projects` 仍返回 `devflow` 和它的 2 个 worktree | T4 |
| R2.2 | 浏览器 | R2.2 项目的会话全部删除后 | 重启桌面端、重启 daemon 各一次，`devflow` 和 2 个 worktree 仍在侧边栏 | dev-test |
| R2.3 | Go 集成 | `TestRemoveProjectKeepsDisk`、`TestProjectReappearsAfterNewSession` | `POST /api/v1/projects/remove` → 204，列表里没有它；仓库目录、worktree 目录、分支都在；之后在仓库子目录新建会话，项目重新出现 | T4 |
| R2.3 | desktop 单元 | `test-sidebar.mjs › project_menu_remove` | 点 `project-menu` → `project-remove` → 调用 `removeProject` 回调一次，参数是项目 id | T6b |
| R2.3 | 浏览器 | R2.3 从侧边栏移除项目 | 移除后该项目不显示，磁盘不变；再在该仓库新建会话后重新出现 | dev-test |
| R2.4 | Go 集成 | `TestRemoveProjectWithSessions409`、`TestRemoveProjectNotFound` | 还有会话 → 409 `project_has_sessions`，清单不变；不在清单里 → 404 `project_not_found` | T4 |
| R2.4 | desktop 单元 | `test-sidebar.mjs › project_remove_disabled_with_sessions` | `project-remove` 是 `disabled`，旁边的说明是 `sidebar.project.removeBlocked` 的文字 | T6b |
| R2.4 | 浏览器 | R2.4 项目下有会话时不能移除 | 菜单项不可用，写明要先结束会话 | dev-test |
| R2.5 | Go 集成 | `TestProjectsPrunedWorktreeSessionsMoveUp` | 会话还在时在测试里执行 `git worktree remove --force` → 该 worktree 不在 `worktrees` 里，会话 id 出现在项目级 `sessions` | T4 |
| R2.5 | desktop 单元 | `test-tree.mjs › gone_sessions`、`test-sidebar.mjs › gone_session_meta` | git 项目、没有 `error`、会话在项目级列表里 → `gone` 为真；会话行第二行是 `session-gone`（「目录已不存在」） | T5、T6b |
| R2.5 | 浏览器 | R2.5 worktree 在别处被删掉 | 终端里执行 `git worktree remove` 后下一次刷新该行消失，原来的会话显示在项目下并标明目录已不存在 | dev-test |
| R2.6 | Go 集成 | `TestProjectsHidesWorktreesOutsideAllowedRoots`、`TestProjectsAllowedRootIsSymlink` | 经 `httptest` 用真实的 `config.Config`（`allow` 是 `cfg.ResolveAllowedWorkdir`）：`allowed_roots` 只含仓库目录时，仓库外的 worktree 不在响应里；`allowed_roots` 写的是一个指向仓库父目录的符号链接（相当于把根配成 `/tmp`，git 列出的是 `/private/tmp/…`）时，主目录和 worktree 全部照常列出 | T4 |
| R2.6 | 浏览器 | R2.6 worktree 不在允许的目录范围内 | daemon 的 `allowed_roots` 只含仓库本身，仓库外的 worktree 不出现在侧边栏 | dev-test |
| R2.7 | Go 集成 | `TestProjectsRepoMissing`、`TestProjectsGitFailed` | 清单里的仓库目录被删 → `error:"repo_missing"`；目录在但 git 失败或超时（`gitTimeout` 调成 50 ms，`PATH` 里放一个睡 1 秒的假 git）→ `error:"git_failed"`、`errorMessage` 非空；两种情况 `worktrees` 为 `[]`、会话全在项目级 `sessions` | T4 |
| R2.7 | desktop 单元 | `test-tree.mjs › project_error`、`test-sidebar.mjs › project_error_row_sessions_usable` | `project-error` 显示「读取失败：<原因>」或「仓库目录不存在」；该项目的 `session-row` 仍在，点它调用 `open` 回调 | T5、T6b |
| R2.7 | 浏览器 | R2.7 读不到 worktree 列表 | 删掉仓库目录后项目行显示读取失败和原因，已有会话照常能打开 | dev-test |
| R3.1 | Go 单元 | `TestCreateNamedWorktree` | `Name:"fix-login"`、发起处在 `main` → 分支 `fix-login` 指向 `main` 当前提交，目录是 `<仓库父目录>/devflow-worktrees/fix-login`，返回的 `CreatedWorktree.Home.Project` 是主目录，`OID` 是 `main` 当前提交；新 worktree 里 `git symbolic-ref HEAD` 是 `refs/heads/fix-login`、`git status --porcelain` 为空 | T7 |
| R3.1 | Go 集成 | `TestWSAttachWorktreeName` | attach 带 `mode:"worktree"`、`worktreeName:"fix-login"`、`ui:"chat"` → `ready.branch` 是 `fix-login`；`/api/v1/projects` 里出现该行，`managed:true`，`sessions` 含新会话 | T7 |
| R3.1 | desktop 单元 | `test-worktree-dialogs.mjs › new_worktree_confirm_resolves` | 填 `fix-login`、选「对话」、点 `dialog-confirm` → 先调一次 `planWorktree(主目录, "fix-login")`，再以 `{mode:"worktree", workdir: 主目录, ui:"chat", worktreeName:"fix-login", worktreePath: plan 的 path}` 结束 | T9 |
| R3.1 | 浏览器 | R3.1 新建成功 | 侧边栏 `devflow` 下出现 `fix-login`，其中打开了一个新的对话会话；磁盘上分支和目录都符合 | dev-test |
| R3.2 | Go 单元 | `TestWorktreeDirName`、`TestCreateNamedWorktree/slash` | `change/foo` → 分支 `change/foo`，目录名 `change-foo` | T7 |
| R3.2 | desktop 单元 | `test-worktree-name.mjs › dir_name` | `worktreeDirName("change/foo")` 是 `change-foo` | T9 |
| R3.2 | 浏览器 | R3.2 名字里有斜杠 | 侧边栏显示 `change/foo`，目录名是 `change-foo` | dev-test |
| R3.3 | Go 单元 | `TestValidateWorktreeName`、`TestValidateWorktreeNameRejectsExpansion`、`TestWorktreeNameNeverReachesShell` | 读共用向量 `testdata/worktree-names.json`：空、`a b`、`a..b`、`-x`、`a~b`、`@{-1}`、`@{-2}`、`a@{b`、`HEAD` 都返回 `ErrInvalidWorktreeName`，`-x` 和含 `@{` 的在任何 git 调用之前被拒；仓库有「上一个检出的分支」时 `@{-1}` 仍被拒，那个分支原样还在；`$(touch${IFS}PWNED)` 这类名字不会生成文件 `PWNED` | T7 |
| R3.3 | Go 集成 | `TestPlanWorktree/invalid_name` | `name` 为空或不合法 → `ok:false`、`error:"invalid_worktree_name"`，仓库里没有新分支和目录 | T8 |
| R3.3 | desktop 单元 | `test-worktree-name.mjs › shared_vectors`、`test-session-form.mjs › invalid_name_disables_confirm` | 同一份向量在桌面端得到 `empty` / `whitespace` / `dotdot` / `leading_dash`，`@{-1}`、`@{-2}`、`a@{b` 得到 `invalid`；`wt-name-error` 显示对应文案，`dialog-confirm` 是 `disabled` | T9 |
| R3.3 | 浏览器 | R3.3 名字不合法 | 逐个输入空、含空格、含 `..`、以 `-` 开头、`a~b`、`@{-1}`，对话框内显示原因，确认按钮不可用，磁盘上没有新东西 | dev-test |
| R3.4 | Go 单元 | `TestCreateNamedWorktreeBranchExists`、`TestBranchConflict` | 仓库已有分支 `fix-login` → `ErrWorktreeBranchExists`，目标目录不存在，原分支指向不变。子测试 `dir_file_conflict`：已有 `fix` 时建 `fix/login`、已有 `change/foo` 时建 `change` → 同样是 `ErrWorktreeBranchExists`，错误里的 `Conflict` 分别是 `fix`、`change/foo`，没有新目录，没有调用过 `update-ref`（在第 4 步就被拦下） | T7 |
| R3.4 | Go 集成 | `TestPlanWorktree/branch_exists`、`TestPlanWorktree/branch_conflict` | `ok:false`、`error:"worktree_branch_exists"`，`conflict` 等于 `branch`；已有 `fix` 时 `name=fix/login` → 同一个 `error`，`conflict` 是 `fix`；已有 `change/foo` 时 `name=change` → `conflict` 是 `change/foo` | T8 |
| R3.4 | desktop 单元 | `test-worktree-dialogs.mjs › plan_rejection_keeps_dialog_open` | 确认时 plan 返回 `worktree_branch_exists` → `wt-name-error` 显示「分支 fix-login 已存在」，对话框还在，Promise 未结束；改名后再点能成功。plan 返回 `worktree_branch_exists` 且 `conflict:"fix"`（名字是 `fix/login`）→ 显示的是 `wt.error.branch_conflict`（含 `fix` 和 `fix/login`），不是「分支 fix/login 已存在」 | T9 |
| R3.4 | 浏览器 | R3.4 分支名已存在 | 对话框内提示分支已存在，保持打开，改名后创建成功 | dev-test |
| R3.5 | Go 单元 | `TestCreateNamedWorktreePathExists` | 目标目录已存在（非空、空目录各一例）→ `ErrWorktreePathExists`，没有新分支，目录内容不变 | T7 |
| R3.5 | Go 集成 | `TestPlanWorktree/path_exists` | `ok:false`、`error:"worktree_path_exists"` | T8 |
| R3.5 | 浏览器 | R3.5 目标目录已存在 | 先手工建好 `devflow-worktrees/fix-login` → 提示目录已存在，不创建、不覆盖 | dev-test |
| R3.6 | Go 单元 | `TestCreateNamedWorktreeExcludesUncommitted` | 发起处有 1 个未提交的改动 → 新 worktree 里 `git status --porcelain` 为空，`HEAD` 等于发起处的 `HEAD` | T7 |
| R3.6 | Go 集成 | `TestPlanWorktreeBase` | `base.branch` 是 `main`、`base.head` 是当前提交前 7 位；发起处 detached 时没有 `branch`、`detached:true`；`name` 为空时仍返回 `base` | T8 |
| R3.6 | desktop 单元 | `test-session-form.mjs › base_info_text` | `wt-base-info` 的文字是「基于 main @ a1b2c3d，不包含未提交的改动」，`wt-target-path` 是 plan 的 `path` | T9 |
| R3.6 | 浏览器 | R3.6 发起处有未提交改动 | 对话框写明基于哪个分支的哪个提交、不包含未提交的改动 | dev-test |
| R3.7 | Go 集成 | `TestNamedWorktreeReplaySameID` | 同一个 `newSessionId` 加 `worktreeName:"fix-login"` 先后发 2 次、再并发发 2 次 → `git worktree list` 里只有一个 `fix-login`，`git branch --list fix-login` 一行，会话表里一个会话，两次 `ready.sessionId` 相同 | T7 |
| R3.7 | desktop 单元 | `test-attach-replay.mjs › replay_carries_worktree_name` | `ready` 之前断线，自动重连和手动重试发出的 attach 都带同一个 `newSessionId` 和 `worktreeName` | T7 |
| R3.7 | 浏览器 | R3.7 创建中途断线 | 确认后、就绪前切断连接，重连后只有一个 worktree、一个分支、一个会话 | dev-test |
| R3.8 | Go 单元 | `TestCreateNamedWorktreeGitFailureLeavesNothing` | 把仓库的 `.git/worktrees` 预先建成只读（0555），让 `git worktree add` 在目录和分支都占好之后失败（design V14）→ 返回的错误含 git 的输出；分支 `fix-login` 不存在，目标目录不存在，本次新建的容器目录不存在，`ProjectStore` 里没有记录。子测试 `container_readonly`：容器目录只读 → 占目录就失败，同样什么都不留 | T7 |
| R3.8 | Go 集成 | `TestWSAttachWorktreeCreateFailed` | 同样的失败 → error 帧 `code:"create_failed"`、`fatal:true`、`message` 含 git 输出；`/api/v1/projects` 里没有新行 | T7 |
| R3.8 | 浏览器 | R3.8 创建失败 | 临时仓库的 `.git/worktrees` 只读时确认 → 显示 git 的错误信息，侧边栏不出现新行，磁盘上没有半截目录或分支 | dev-test |
| R3.9 | desktop 单元 | `test-session-form.mjs › picker_worktree_mode_name_segment` | 目录选择器选「创建隔离 Worktree」且 `info.proto` 为 4 → 出现 `wt-name-input`，名字为空时 `dialog-confirm` 是 `disabled`，规则与 R3.2–R3.6 的用例共用同一个名字段 | T9 |
| R3.9 | 浏览器 | R3.9 机器概览里的 Worktree 模式 | 出现名字输入框，空名字时确认按钮不可用，填合法名字后创建出同名分支 | dev-test |
| R3.10 | Go 单元 | `TestResolveAllowedNewPath`、`TestCreateNamedWorktreePathNotAllowed` | `allowed_roots` 只含仓库 → `<仓库父目录>/devflow-worktrees/fix-login` 被拒，返回 `ErrWorktreePathNotAllowed`，错误信息含完整路径；没有新目录和分支；经符号链接祖先指到白名单外的路径同样被拒 | T7 |
| R3.10 | Go 集成 | `TestPlanWorktree/path_not_allowed` | `ok:false`、`error:"worktree_path_not_allowed"`，`message` 含路径 | T8 |
| R3.10 | desktop 单元 | `test-worktree-dialogs.mjs › plan_rejection_keeps_dialog_open`（`path_not_allowed` 分支） | `wt-name-error` 显示「目录不在允许的范围内：<路径>」 | T9 |
| R3.10 | 浏览器 | R3.10 目标目录不在允许的范围内 | `allowed_roots` 只含仓库本身时新建 worktree → 提示不在允许的范围内并写出路径，磁盘不变 | dev-test |
| R4.1 | desktop 单元 | `test-worktree-dialogs.mjs › worktree_session_dialog_shape` | 标题含 `fix-login`；`session-dialog-path` 含 `devflow` 和完整路径；对话框里没有目录列表和会话模式卡片；确认后以 `{mode:"normal", workdir: worktree 路径}` 结束 | T11 |
| R4.1 | 浏览器 | R4.1 在 worktree 行上新建 | 点 `fix-login` 行的「新建会话」，对话框只让选界面和启动选项 | dev-test |
| R4.2 | Go 集成 | `TestCreateInHiddenWorktreeDir` | 在 `<仓库>/.devflow-tmp/worktrees/general-skills` 新建终端会话 → 会话的 `workdir` 是该目录，归属的 worktree 根也是它 | T2 |
| R4.2 | 浏览器 | R4.2 隐藏目录下的 worktree | 在 `change/general-skills` 行新建终端会话，在终端里执行 `pwd` 得到该目录 | dev-test |
| R4.3 | Go 单元 | `TestChatTrust/worktree_of_trusted_main` | `.claude.json` 只信任主目录 → 对它的 worktree 根返回 `trusted` | T10 |
| R4.3 | Go 集成 | `TestFSChatTrustWorktree`、`TestWSCreateChatInWorktreeOfTrustedMain` | `/api/v1/fs?path=<worktree>` 的 `chatTrust` 是 `trusted`；在该目录新建对话会话收到 `ready`（`ui:"chat"`） | T10 |
| R4.3 | 浏览器 | R4.3 主目录已被 claude 信任 | 在 `general-skills` 上新建会话时「对话」可选，创建成功 | dev-test |
| R4.4 | Go 单元 | `TestChatTrust/neither_trusted` | 主目录和 worktree 都没有信任记录 → `untrusted`；新建对话会话被拒，error 帧 `chat_unsupported` | T10 |
| R4.4 | desktop 单元 | `test-chat-availability.mjs › worktree_untrusted_reason` | 传 `opts.mainPath` 时原因是 `picker.ui.chat.reason.worktree_untrusted`，文字含主目录路径；不传时沿用现有文案 | T11 |
| R4.4 | 浏览器 | R4.4 主目录和该 worktree 都未被信任 | 「对话」置灰，原因写明先用终端界面在项目主目录打开一次 claude；「终端」可用 | dev-test |
| R4.5 | Go 集成 | `TestProjectsTwoSessionsOneWorktree` | 同一 worktree 先后新建 2 个不带 `-c` 的会话 → 两个 id 都在该 worktree 的 `sessions` 里，按创建顺序 | T4 |
| R4.5 | 浏览器 | R4.5 同一 worktree 再开一个 | `fix-login` 下出现第二个会话，两个都能输入 | dev-test |
| R4.6 | Go 单元 | `TestChatTrust/worktree_itself_trusted` | 只有 worktree 路径本身被信任、主目录没有 → `trusted` | T10 |
| R4.6 | 浏览器 | R4.6 worktree 本身已被信任 | 「对话」可选 | dev-test |
| R5.1 | Go 单元 | `TestDeleteSessionKeepsWorktreeAndBranch` | `fix-login` 下 1 个会话、分支上 2 个未合并提交 → `Delete` 返回 nil；目录在，分支在，`git rev-list --count main..fix-login` 是 2；`Projects()` 里该行 `sessions` 为 `[]` | T12 |
| R5.1 | desktop 单元 | `test-worktree-dialogs.mjs › delete_session_keeps_worktree_note` | `delete-session-note` 的文字是「worktree fix-login 的目录和分支都会保留…」；初始焦点在 `dialog-cancel`；点 `dialog-confirm` 才返回 true | T12 |
| R5.1 | 浏览器 | R5.1 删除 worktree 里的会话 | 确认框写明 worktree 和分支会保留；确认后会话消失，`fix-login` 行仍在并标明没有会话，磁盘上目录、分支、2 个提交都在 | dev-test |
| R5.2 | Go 单元 | `TestRemoveCleanMergedWorktree` | `managed`、干净、提交已被 `main` 包含，请求带 `deleteBranch:true` → 目录和分支都不存在，结果 `removed:true, branchDeleted:true`，`ProjectStore` 里的记录已删 | T13 |
| R5.2 | Go 集成 | `TestWorktreeStatusEndpoint`、`TestWorktreeRemoveEndpoint/clean` | status：`dirtyFiles:0, unmergedCommits:0, managed:true`，`head` 是 40 位；remove：200，响应体 `{"removed":true,"branchDeleted":true,"endedSessions":[]}` | T13 |
| R5.2 | desktop 单元 | `test-worktree-dialogs.mjs › delete_wt_clean` | `delete-wt-dialog` 的 `data-variant` 是 `clean`；确认后请求里 `deleteBranch:true`，没有 `discardFiles` 和 `dropCommits`，`head` 和 `sessions` 原样带回 | T14 |
| R5.2 | 浏览器 | R5.2 删除干净且已合并的 worktree | 确认后该行消失，磁盘上目录和分支都没有了 | dev-test |
| R5.3 | Go 单元 | `TestDirtyFiles`、`TestRemoveDirtyNeedsConsent` | 改 1 个、暂存 1 个、未跟踪 1 个 → `dirtyFiles` 是 3；不带 `discardFiles` → `WorktreeChangedError`，目录、分支、3 个文件都在；带上 → 目录被删 | T13 |
| R5.3 | desktop 单元 | `test-worktree-dialogs.mjs › delete_wt_files` | `data-variant` 是 `files`；`delete-wt-files` 含「3」；初始焦点在 `dialog-cancel`；确认按钮是 `delete-wt-force`（「仍然删除」）；取消 → 返回 null、没有发出删除请求；点「仍然删除」→ 请求里 `discardFiles:true` | T14 |
| R5.3 | 浏览器 | R5.3 有未提交或未跟踪的文件 | 确认框写明 3 个文件会被丢弃，回车 = 取消且什么都不变；点「仍然删除」后目录被删 | dev-test |
| R5.4 | Go 单元 | `TestDirtyFiles/ignored_only`、`TestIgnoredFiles`、`TestRemoveIgnoredOnlyIsClean` | 只有被忽略的 `node_modules/`（里面 3 个文件，分在 2 层子目录里）和 `.env` → `dirtyFiles` 是 0，`ignoredFiles` 是 4（逐个文件数，目录不折叠）；没有被忽略的文件 → 0；不带 `discardFiles` 就能删掉目录，请求里也没有与 `ignoredFiles` 对应的同意项 | T13 |
| R5.4 | Go 集成 | `TestWorktreeStatusEndpoint/ignored` | status 的响应体里 `dirtyFiles:0`、`ignoredFiles:4`；干净且没有被忽略文件的 worktree 是 `ignoredFiles:0`（键恒在） | T13 |
| R5.4 | desktop 单元 | `test-worktree-dialogs.mjs › delete_wt_ignored_note` | `dirtyFiles:0, ignoredFiles:4`、`managed`、已合并 → `data-variant` 仍是 `clean`，没有 `delete-wt-files`，`delete-wt-ignored` 的文字是「另有 4 个被 git 忽略的文件会一并删除。」，回车 = 删除，请求里没有 `discardFiles`；`ignoredFiles` 是 0 或缺省 → 没有 `delete-wt-ignored`；是 `-1`（daemon 没数出来）→ 这一行的文字是 `wt.delete.ignoredUnknown`，不含数字；`files` 形态下 `ignoredFiles:4` → 两行都在，回车仍是取消 | T14 |
| R5.4 | 浏览器 | R5.4 只有被 git 忽略的文件 | 确认框是「干净」的那一种，没有丢弃文件的警告；另有一句写明被忽略的文件数（与 `node_modules/` 里实际的文件数相同）会一并删除；没有被忽略文件的 worktree 上没有这一句 | dev-test |
| R5.5 | Go 单元 | `TestUnmergedCommits` | 分支上 2 个独有提交 → 2；被另一个本地分支包含后 → 0；被远程跟踪引用包含后 → 0；子测试 `tag_with_same_name`：另有一个同名 tag 指向 `main` 时仍是 2（按完整引用名数，design V10） | T1 |
| R5.5 | Go 单元 | `TestRemoveUnmergedNeedsConsent` | `unmergedCommits` 是 2：不带 `deleteBranch` → 目录被删、分支和 2 个提交都在、`branchDeleted:false`；`deleteBranch:true` 而没有 `dropCommits` → `WorktreeChangedError`，什么都没动；两个都带 → 分支被删 | T13 |
| R5.5 | desktop 单元 | `test-worktree-dialogs.mjs › delete_wt_commits` | `data-variant` 是 `commits`；`delete-wt-commits` 含「2」；`delete-wt-keep-branch` 预选，回车发出的请求没有 `deleteBranch`；改选 `delete-wt-delete-branch` 后请求是 `deleteBranch:true, dropCommits:true` | T14 |
| R5.5 | 浏览器 | R5.5 有未合并的提交 | 确认框写明 2 个未合并提交，默认选「只删目录、保留分支」；确认后目录消失、分支仍在 | dev-test |
| R5.6 | Go 单元 | `TestRemoveEndsSessionsFirst` | `fix-login` 下 2 个运行中的会话：请求的 `sessions` 含这 2 个 id → `endedSessions` 是这 2 个，会话表里没有它们，目录被删；请求里少一个 id → `WorktreeChangedError`，返回的状态里 `sessions` 有 2 个，没有会话被结束 | T13 |
| R5.6 | desktop 单元 | `test-worktree-dialogs.mjs › delete_wt_sessions_line`、`test-sidebar.mjs › remove_result_closes_views` | `delete-wt-sessions` 的文字是「会先结束这 2 个会话。」；请求的 `sessions` 与 status 的相同；删除成功后 `endedSessions` 里的会话视图被关闭 | T14 |
| R5.6 | 浏览器 | R5.6 worktree 下还有会话 | 确认框写明会先结束这 2 个会话；确认后两个会话都结束，worktree 按 R5.2 处理 | dev-test |
| R5.7 | Go 单元 | `TestRemoveMainRefused` | `path` 是主目录 → `ErrWorktreeIsMain`（HTTP 400 `worktree_is_main`），主目录原样 | T13 |
| R5.7 | desktop 单元 | `test-sidebar.mjs › main_worktree_has_no_menu` | 带 `worktree-tag-main` 的那一行没有 `worktree-menu` 按钮 | T6b |
| R5.7 | 浏览器 | R5.7 主目录不能删 | 主目录这一行的操作里没有「删除 worktree」 | dev-test |
| R5.8 | Go 单元 | `TestManagedRequiresPathAndBranch`、`TestManagedLegacyVibeBranch` | 记录的路径相同但当前分支不同 → 不是 `managed`；`<仓库>-worktrees/1794824025040-12b763ac` 加分支 `vibe/1794824025040-12b763ac` → 是；`<仓库>-worktrees/foo` 加分支 `vibe/foo` → 不是（`foo` 满足 `ValidSessionID`，但不是 vibe-remote 生成过的会话 id 形态，d22） | T3 |
| R5.8 | Go 单元 | `TestRemoveExternalNeverDeletesBranch` | 外部 worktree `change/general-skills`，请求带 `deleteBranch:true, dropCommits:true` → 目录被删，分支 `change/general-skills` 仍在，`branchDeleted:false`；它有 3 个未提交文件时同样要 `discardFiles` | T13 |
| R5.8 | desktop 单元 | `test-worktree-dialogs.mjs › delete_wt_external` | `data-variant` 是 `external`；`delete-wt-external` 的文字含「不是由 vibe-remote 创建」和分支名；没有两个单选；请求里没有 `deleteBranch` | T14 |
| R5.8 | 浏览器 | R5.8 不是 vibe-remote 创建的 worktree | 确认框标明不是由 vibe-remote 创建；确认后目录消失，`git branch --list change/general-skills` 仍有一行 | dev-test |
| R5.9 | Go 单元 | `TestRemoveLockedRefusedBeforeEndingSessions`、`TestRemoveSubmoduleCheckoutRefused`、`TestRemoveRefusedWhenNestedWorktree` | 动手之前发现的三种：先 `git worktree lock --reason usb`；worktree 里有初始化过的子模块或嵌入式仓库；里面嵌着这个仓库的另一个 worktree。都返回 `*WorktreeRemoveError`（HTTP 500 `worktree_remove_failed`），`Message` 写明原因（`locked` 和 `usb`；`submodule`；里面那个 worktree 的路径），`EndedSessions` 为空；该 worktree 下的 2 个会话都还在会话表里，目录、分支、`ProjectStore` 记录都在（d26） | T13 |
| R5.9 | Go 集成 | `TestWorktreeRemoveEndpoint/locked` | 500，响应体 `error` 是 `worktree_remove_failed`，`message` 含 `locked`，`endedSessions` 是 `[]`；随后 `GET /api/v1/sessions` 里那 2 个会话都在 | T13 |
| R5.9 | desktop 单元 | `test-worktree-dialogs.mjs › delete_flow_500_reopens_with_error` | `removeWorktree` 抛 500（`endedSessions:[]`）→ 再调一次 `worktreeStatus`，用它返回的状态重新打开同一个确认框，`delete-wt-error` 显示「删除失败：<原因>」，没有 `delete-wt-ended`，`delete-wt-sessions` 仍写着会先结束 2 个会话（它们没有被结束）；用户取消后 `deleteWorktreeFlow` 返回 `{removed:false, endedSessions:[]}` | T14 |
| R5.9 | 浏览器 | R5.9 开始删除之前就能发现的失败 | 把 worktree 锁住（`git worktree lock`）后删除 → 对话框内写明已被锁定；其中的会话没有被结束、仍能输入，worktree 行和磁盘状态不变。另一例：在它的被忽略目录里再建一个 worktree 后删除外层 → 对话框内写明里面还有哪个 worktree，两个 worktree 和里面未提交的文件都在 | dev-test |
| R5.10 | Go 集成 | `TestDeleteCleanWorktreeWithUnmergedCommitsReturns409`（过渡，T12 时删除） | T1 的过渡行为：工作区干净、分支有 2 个未合并提交 → 409 `worktree_preserved`，目录、分支、提交都在 | T1 |
| R5.10 | Go 集成 | `TestDeleteSessionNeverReturnsPreserved` | 只发 `DELETE /api/v1/sessions/{id}`（旧桌面端的做法）：干净加 2 个未合并提交、有未提交文件各一例 → 都是 204，目录和分支都在 | T12 |
| R5.10 | 协议冒烟 | R5.10 旧版桌面端删会话不丢提交 | 用 `change/dual-mode` 基线的 `ws-smoke.mjs` 连本次测试自己起的临时 daemon（由本分支构建，随机端口，临时配置和 `state_dir`，独立的 `TMUX_TMPDIR`）：`git show change/dual-mode:.claude/skills/verify/scripts/ws-smoke.mjs > "$TMP/ws-smoke-base.mjs" && VR_TOKEN=<临时 daemon 的 token> node "$TMP/ws-smoke-base.mjs" 127.0.0.1:<临时 daemon 的端口> <它的 allowed_roots 里的临时目录>`。目标地址是脚本的第一个参数，必须填临时 daemon 的，不能是 127.0.0.1:8765。再用同一个 token 对一个 worktree 会话发 `DELETE /api/v1/sessions/{id}`：删除成功，worktree 目录和分支都保留 | dev-test |
| R5.11 | Go 单元 | `TestUnmergedCommits/detached` | `branch` 传空：detached 的 `HEAD` 上 2 个不属于任何分支的提交 → 2 | T1 |
| R5.11 | Go 单元 | `TestRemoveDetachedNeedsConsent` | status：`detached:true, unmergedCommits:2`；不带 `dropCommits` → `WorktreeChangedError`；带上 → 目录被删。没有这样的提交且干净 → 不带任何同意项就能删 | T13 |
| R5.11 | desktop 单元 | `test-worktree-dialogs.mjs › delete_wt_detached`、`delete_wt_detached_clean` | 有提交：`data-variant` 是 `detached`，文字是「这 2 个提交删除后不再属于任何分支，无法恢复。」，初始焦点在 `dialog-cancel`，`delete-wt-force` 发出 `dropCommits:true`；没有提交：`data-variant` 是 `clean`，文字是 `wt.delete.cleanDetached`，请求没有同意项 | T14 |
| R5.11 | 浏览器 | R5.11 worktree 不在任何分支上 | 确认框写明这 2 个提交删除后不再属于任何分支，回车 = 取消；点「仍然删除」才删除 | dev-test |
| R5.12 | Go 单元 | `TestRemoveGitFailureKeepsState`、`TestRemovePartialFailureReported`、`TestRemoveSessionEndFailureStops` | 动手之后的三种。(1) `PATH` 前面的 git 包装脚本让 `worktree remove` 以非 0 退出并输出一行错误（什么都不删）→ `*WorktreeRemoveError`，`Message` 含这行输出，`EndedSessions` 是该 worktree 下的 2 个会话（它们已经不在会话表里）；目录、分支、`ProjectStore` 记录都在。这个用例的名字指的是「目录和分支保持原样」，会话是已结束的。(2) worktree 里有一个 0555 的子目录 → git 已注销这个 worktree、目录剩一部分：`Message` 含 git 的输出和剩余目录的路径，分支还在，下一次 `Projects()` 里这一行消失。(3) 第 2 个会话结束失败（测试钩子让它的删除返回错误）→ `*WorktreeRemoveError`，`Message` 含那个会话的 id，`EndedSessions` 只有第 1 个；没有执行 `git worktree remove`，目录还在 | T13 |
| R5.12 | Go 集成 | `TestWorktreeRemoveEndpoint/git_failure`、`/changed_after_sessions_ended` | git 包装脚本让 `worktree remove` 失败 → 500，`message` 含 git 的输出，`endedSessions` 含那个会话的 id；会话结束期间 HEAD 变了 → 409，响应体同时有 `status`（新的 `head`）和非空的 `endedSessions` | T13 |
| R5.12 | desktop 单元 | `test-worktree-dialogs.mjs › delete_flow_500_after_sessions_ended`、`delete_flow_500_partial_shows_failure`、`delete_flow_409_after_sessions_ended_then_cancel` | 500 带 `endedSessions` 2 个，随后的 `worktreeStatus` 返回状态（`sessions:[]`）→ 重新打开的确认框有 `delete-wt-error`（git 的输出）和 `delete-wt-ended`（「已结束 2 个会话。」），没有 `delete-wt-sessions`；取消 → `{removed:false, endedSessions: 这 2 个 id}`。500 之后 `worktreeStatus` 返回 404 → 出现 `delete-wt-failed`：有 `delete-wt-error`、`delete-wt-ended`、`delete-wt-partial`（含路径，写明分支没有删除），只有「关闭」一个按钮；关闭后返回 `{removed:false, endedSessions: 这 2 个 id}`。409 带 `endedSessions` → 重新确认的框有 `delete-wt-changed` 和 `delete-wt-ended`；取消 → 返回值不是 `null`，`endedSessions` 是那些 id | T14 |
| R5.12 | 浏览器 | R5.12 已经开始删除之后的失败 | 临时 daemon 的 `PATH` 前面放一个 git 包装脚本，让 `worktree remove` 以非 0 退出并输出一行错误：对话框内显示这行错误和「已结束 N 个会话」；这些会话的视图被关闭，worktree 行还在并标「没有会话」，目录和分支都在。另一例：worktree 里放一个 0555 的子目录后删除 → 显示 git 的错误，写明目录还剩一部分和它的路径、分支保留；刷新后这一行消失，磁盘上剩余的目录和分支都在 | dev-test |
| R6.1 | desktop 单元 | `test-session-form.mjs › continue_note_shown`、`test-worktree-dialogs.mjs › continue_note_counts` | 已有会话数是 1 且勾选 id 为 `continue` 的选项 → `continue-note` 出现，文字是 `wt.session.continueNote`，`dialog-confirm` 不是 `disabled`；取消勾选后消失。两个入口用同一个口径（d24）：工作目录等于将要启动的目录、且没有结束的会话数；Worktree 模式和新建 worktree 对话框传 0。`test-tree.mjs › count_active_sessions_at`（T5）：`workdir` 相等的运行中会话算，子目录里的、`state` 是 `ended` 的不算 | T15 |
| R6.1 | 浏览器 | R6.1 目录里已有会话在用最近那段对话 | `main` 已有一个对话会话，在同一 worktree 新建并勾选 `-c` → 显示说明，确认按钮可点 | dev-test |
| R6.2 | desktop 单元 | `test-session-form.mjs › continue_note_hidden_without_sessions` | 已有会话数是 0 且勾选 `continue` → DOM 里没有 `continue-note` | T15 |
| R6.2 | 浏览器 | R6.2 目录里没有会话 | 没有会话的 worktree 上勾选 `-c` → 不显示说明 | dev-test |
| R7.1 | desktop 单元 | `test-shortcuts.mjs › match_digits`、`pick_index` | ⌘3 → `{kind:'index', n:3}`；⌘0、⌘⌥3、⌃⌘3 不匹配；5 个会话时 ⌘3 → 下标 2，⌘7 → null；12 个会话时 ⌘9 → 下标 8 | T16 |
| R7.1 | 浏览器 | R7.1 按序号切换 | 5 个可见会话，按 ⌘3 打开第 3 个；按 ⌘7 不动 | dev-test |
| R7.2 | desktop 单元 | `test-shortcuts.mjs › pick_prev_next_wraps` | 共 5 个：当前下标 4 按「下一个」→ 0；当前 0 按「上一个」→ 4；当前 -1 时「下一个」→ 0、「上一个」→ 4；共 0 个 → null | T16 |
| R7.2 | 浏览器 | R7.2 上一个 / 下一个 | 在第 5 个按 ⌘⇧] 回到第 1 个；⌘⇧[ 反向循环 | dev-test |
| R7.3 | desktop 单元 | `test-shortcuts.mjs › capture_blocks_propagation` | 焦点在 textarea 上派发 ⌘3：`defaultPrevented` 为真，textarea 自己的 keydown 监听没有被调用，`open(2)` 被调用一次；派发普通键 `a` 时监听照常被调用 | T16 |
| R7.3 | 浏览器 | R7.3 焦点在终端或输入框里 | 焦点在 xterm 里按 ⌘3：切换成功，发往 daemon 的 `data` 帧为 0 字节；焦点在对话输入框里按 ⌘⇧]：切换成功，输入框内容不变 | dev-test |
| R7.4 | desktop 单元 | `test-shortcuts.mjs › blocked_does_not_intercept` | `blocked()` 为真 → `open` 没有被调用，`defaultPrevented` 为假 | T16 |
| R7.4 | 浏览器 | R7.4 对话框打开时 | 新建会话对话框、删除确认框开着时按 ⌘2、⌘⇧]，当前会话不变 | dev-test |
| R7.5 | desktop 单元 | `test-tree.mjs › visible_sessions_skip_collapsed` | 3 个项目各 2 个会话，折叠第 2 个项目 → 结果是第 1、3 个项目的 4 个会话，顺序从上到下；折叠的机器整台跳过 | T5 |
| R7.5 | 浏览器 | R7.5 折叠的项目 | 折叠一个项目后按 ⌘⇧] 一圈，不会停在其中的会话上 | dev-test |
| R8.1 | desktop 单元 | `test-theme-tokens.mjs › chat_shape_rules`；现有的 `test-chat-view.mjs`、`test-chat-markdown.mjs`、`test-chat-diff.mjs`、`test-chat-render-guard.mjs` | `.chat-instance` 一段里用户消息的规则用 `var(--accent-soft)`、右对齐、圆角 17px，输入框圆角 17px；T19 的提交不改 `desktop/src/renderer/chat/` 下任何 `.ts`，现有 4 个对话测试原样通过 | T19 |
| R8.1 | 浏览器 | R8.1 对话会话 | 有来回消息、工具调用和权限请求的对话会话：用户消息是右对齐气泡，输入框是圆角卡片，权限卡片和工具块按效果页 M1；Markdown、代码块复制、diff、链接行为与 `gui-chat-smoke.mjs` 现有用例一致 | dev-test |
| R8.2 | desktop 单元 | `test-theme-tokens.mjs › terminal_theme_from_css_vars`；现有的 `test-terminal-selection.mjs` | `terminalTheme()` 的 `background`、`foreground`、`cursor`、`selectionBackground` 分别等于 `--term-bg`（`#FFFFFF`）、`--term-fg`（`#1C1B22`）、`--term-cursor`（`#6B54D3`）、`--term-selection`（`#D9D2F4`）；16 个 ANSI 色与改动前 `index.ts` 里的值逐个相同 | T18 |
| R8.2 | 浏览器 | R8.2 终端会话 | 终端底色、前景、光标、选区是新主题色；远程输出的字节原样显示（现有 `gui-smoke.mjs` 的透传用例通过） | dev-test |
| R8.3 | 浏览器 | R8.3 现有功能入口都在 | 跑 `gui-smoke.mjs` 和 `gui-chat-smoke.mjs`：全部通过；与 `change/dual-mode` 基线逐个对比，用例数不减少（`gui-chat-smoke.mjs` 基线 26 个 `test(`，`gui-smoke.mjs` 基线 14 处 `check(`）、断言不放宽，只有选择器有改动 | dev-test |
| R8.4 | desktop 单元 | `test-theme-tokens.mjs › tag_contrast_all_hues`；`test-tree.mjs › project_hue_stable` | 用 `:root` 里的四个 `--tag-*` 值，对色相 0–359 逐个算项目行标签文字对标签底色的对比度，最小值 ≥ 4.5；`projectHue` 对同一个 id 恒返回同一个 0–359 的整数 | T18、T5 |
| R8.4 | desktop 单元 | `test-theme-tokens.mjs › contrast_table`、`dot_shapes_differ` | 从 `styles.css` 的 `:root` 解析变量，按 `evidence/contrast-m1.txt` 的 35 对计算：正文和按钮文字 ≥ 4.5，次要文字 ≥ 3，三种状态点对 `--bg-sidebar` ≥ 3；`.session-unread.output`（空心）、`.idle`（实心）、`.waiting`（实心加光圈）的形状属性两两不同 | T18 |
| R8.4 | 浏览器 | R8.4 可读性 | 在运行中的应用里读真实元素的 `color` 和实际背景色（含 `color-mix` 算出来的），达到同样的比值；三种状态点在侧边栏上同时出现时形状可区分 | dev-test |
| R8.5 | desktop 单元 | `test-dialog-layout.mjs` | `dirpicker.ts`、`worktree-dialogs.ts` 里每个对话框只往 `.modal` 里放标题、`.modal-body`、`.modal-footer` 三个直接子元素 | T9（T11、T12、T14 新增的对话框自动被它覆盖） |
| R8.5 | 浏览器 | R8.5 小窗口和双语 | 新写 `.claude/skills/verify/scripts/shell-layout.mjs`：视口 800×500，中英文各一遍，打开侧边栏（三层加长分支名）、新建会话对话框、新建 worktree 对话框、删除确认框的每种形态、斜杠菜单；对话框整体在窗口内，主按钮在窗口内且 `elementFromPoint` 命中它，没有设省略号的文字 `scrollWidth <= clientWidth`，同一行相邻元素的矩形不相交 | dev-test |
| R8.6 | desktop 单元 | `test-theme-tokens.mjs › window_background_matches_bg_app` | `desktop/src/main/index.ts` 的 `backgroundColor` 等于 `styles.css` 的 `--bg-app`，值是 `#EFEFF4` | T18 |
| R8.6 | 浏览器 | R8.6 启动不闪 | 冷启动后第一帧截图的窗口底色是 `#EFEFF4`，没有旧的米色（`#F5F4EF`）或深色 | dev-test |
| R9.1 | desktop 单元 | `test-tree.mjs › legacy_groups_by_session_fields`、`capability_transitions` | `projects` 为 `null`：`mode:"worktree"` 的会话归到 `sourceRepo` 项目下的 `worktreeRoot` 行（`label` 是 `branch`），其余按 `workdir` 归位，不出现没有会话的 worktree；`nextCapability`：数组 → `v4`，`null` → `legacy`，`Error` → 保持上一个 | T5 |
| R9.1 | desktop 单元 | `test-chat-availability.mjs › proto3_daemon_supports_chat` | `info.proto` 是 3、`chat.supported` 为真 → 对话可用（用 `CHAT_MIN_PROTO` 判断，不因 `PROTOCOL_VERSION` 升到 4 而置灰） | T4 |
| R9.1 | desktop 单元 | `test-sidebar.mjs › legacy_note_and_disabled_entries` | 能力状态是 `legacy`：有 `machine-legacy-note`；`project-new-worktree` 和 `worktree-delete` 是 `disabled`，提示是「需要升级这台机器的 vibe-remoted」；`unknown`：同样置灰，没有说明 | T6b |
| R9.1 | desktop 单元 | `test-session-form.mjs › picker_proto3_has_no_name_segment` | `info.proto` 是 3 时目录选择器的 Worktree 模式没有 `wt-name-input`，确认后返回值里没有 `worktreeName` | T9 |
| R9.1 | desktop 单元 | `test-worktree-dialogs.mjs › delete_session_legacy_note` | `legacyWorktree` 为真 → `delete-session-note` 的文字是 `session.delete.legacyWorktree`（写明旧版会在工作区干净时一并删除 worktree 和分支），同时传了 `worktreeLabel` 也以它为准 | T12 |
| R9.1 | desktop 单元 | `test-legacy-daemon.mjs` | 渲染进程入口连一个假的协议 3 daemon（`/api/v1/projects` 返回 404，`info.proto` 是 3）：侧边栏按项目和 worktree 分组；有说明条；两个入口置灰；删除 worktree 会话的确认框是旧版文案；409 `worktree_preserved` 仍显示「Worktree 已保留」 | T17 |
| R9.1 | 浏览器 | R9.1 新桌面端 + 旧 daemon | 用 `change/dual-mode` 构建的 daemon（协议 3）：侧边栏分组显示已有会话，不显示没有会话的 worktree；新建 worktree、删除 worktree 置灰并提示升级；机器概览的 Worktree 模式没有名字输入框、分支自动命名；删除 worktree 会话的确认框是旧版文案；新建、输入、重连照常 | dev-test |
| R9.2 | Go 集成 | `TestAttachWorktreeWithoutNameKeepsLegacyNaming` | attach 带 `mode:"worktree"`、没有 `worktreeName` → 分支 `vibe/<会话id>`，目录 `<仓库父目录>/<仓库名>-worktrees/<会话id>`，`ready` 的字段与协议 3 相同 | T7 |
| R9.2 | Go 集成 | `TestTerminalFramesUnchangedV3`（现有，测试文件和 golden 一个字不改）、`TestV3ClientFlowAgainstV4Daemon` | 终端会话的帧除 `proto` 外逐字节不变；只用协议 3 的帧和端点走一遍新建、接入、重命名、删除，全部成功 | 现有、T17 |
| R9.2 | 协议冒烟 | R9.2 旧桌面端 + 新 daemon | 用 `change/dual-mode` 基线的 `ws-smoke.mjs`（取法和命令同 R5.10 一行：第一个参数是临时 daemon 的 `127.0.0.1:<随机端口>`，token 经 `VR_TOKEN` 传入）和基线桌面端构建产物的 `gui-smoke.mjs`（它自己起临时 daemon 和临时 userData，命令前带独立的 `TMUX_TMPDIR`；把它的 daemon 换成本分支构建的二进制）连新 daemon：新建、接入、删除照常；Worktree 模式新建成功，分支是 `vibe/<会话id>`。两者都不连 127.0.0.1:8765 | dev-test |
| 性能 | Go 集成 | `TestProjectsOneGitCallPerProject`、`TestSessionsEndpointRunsNoGit` | 20 个项目各 5 个 worktree：一次 `/api/v1/projects` 恰好启动 20 个 git 进程、同时在跑的不超过 8 个；`/api/v1/sessions` 启动 0 个 git 进程。这 20 个不含补归属的调用：环境里没有归属为空的会话。子测试 `unresolved_session`：再加 1 个一直补不上归属的会话（工作目录上层有一个空的 `.git` 目录）→ 每一轮多出的 git 进程不超过 3 个（补归属的 2 个 `rev-parse`，加上它临时项目的那一次列表），连续 3 轮每轮的总数相同，不累积（design 5.4） | T4 |
| 性能 | 协议冒烟 | 性能：20 项目 × 5 worktree | 临时 daemon 上各请求 15 次，`/api/v1/projects` 的中位数 ≤ 200 ms，`/api/v1/sessions` 的中位数与没有这些项目时相差 ≤ 200 ms；数字记进 test-report.md | dev-test |
| 安全 | Go 集成 | `TestNewEndpointsRequireToken` | `GET /api/v1/projects`、`POST /api/v1/projects/remove`、`GET /api/v1/worktrees/plan`、`GET /api/v1/worktrees/status`、`POST /api/v1/worktrees/remove` 不带或带错 token 都是 401；每个端点落地时往这张表里加一行 | T4、T8、T13 |

### 容易出问题的情况

| 情况 | 合理的预期 | 测试 | 谁写 |
|------|------------|------|------|
| 新建命名 worktree，`ready` 之前断线，客户端带同一个 `newSessionId` 和 `worktreeName` 重放（自动重连、手动重试、两次并发） | 只有一个 `fix-login` worktree、一个分支、一个会话；第二次 attach 收到同一个 `sessionId` 的 `ready`，不是 `worktree_branch_exists` | `TestNamedWorktreeReplaySameID`、`test-attach-replay.mjs › replay_carries_worktree_name` | T7 |
| 两个不同的 `newSessionId` 并发新建同名 worktree `fix-login` | 恰好一个成功；另一个收到 fatal `worktree_branch_exists`；成功那个的分支和目录完好，`git worktree list` 里只有一个 `fix-login`；用 `-race` 跑 20 轮结果相同 | `TestConcurrentCreateSameNameOneWins` | T7 |
| 目录和分支都占好之后 `git worktree add` 失败（`.git/worktrees` 不可写，design V14；V3 实测旧做法 `worktree add -b` 这时会留下分支） | 返回 `create_failed` 和 git 的错误输出；`git show-ref refs/heads/fix-login` 找不到；目标目录不存在；本次新建的空容器目录被删掉；`ProjectStore` 里没有记录 | `TestCreateNamedWorktreeGitFailureLeavesNothing` | T7 |
| 目标目录已经存在但是空的（V3 实测 git 会直接用它） | daemon 自己拒绝：`worktree_path_exists`；空目录还在、没有被 git 用掉，没有新分支 | `TestCreateNamedWorktreePathExists/empty_dir` | T7 |
| worktree 建好之后会话启动失败（例如对话进程起不来） | worktree 目录和分支被撤销（`CreatedWorktree.Undo`），`ProjectStore` 的创建记录被删掉，侧边栏不出现新行。撤销在项目锁内做：撤销期间并发新建同一仓库的另一个名字，两边的结果都正确（失败的那个什么都不留，另一个的目录、分支、容器目录完好） | `TestNamedWorktreeRolledBackWhenSessionStartFails`（含 `concurrent_create`） | T7 |
| 用户看到确认框之后、点确认之前，worktree 里多了一个未提交的文件 | 409 `worktree_changed`，响应体里的 `status.dirtyFiles` 是 1；目录、分支、文件都在，没有会话被结束；桌面端用新状态重新弹确认框，`delete-wt-changed` 可见 | `TestRemoveChangedSinceStatus/new_file`、`test-worktree-dialogs.mjs › delete_flow_409_reconfirms` | T13、T14 |
| 确认框打开之后分支上多了一个提交（`head` 变了） | 409 `worktree_changed`，`status.head` 是新的哈希；什么都没删 | `TestRemoveChangedSinceStatus/head_moved` | T13 |
| 确认框打开之后该 worktree 下又新建了一个会话 | 409 `worktree_changed`，`status.sessions` 含新会话；没有任何会话被结束 | `TestRemoveChangedSinceStatus/new_session` | T13 |
| 重查通过之后、`git worktree remove` 执行之前出现新文件，git 拒绝删除 | daemon 不看报错文字，失败后重查：文件数变了 → 409 `worktree_changed` 加最新状态，不是 500；目录还在 | `TestRemoveGitRefusesNewFiles` | T13 |
| daemon 重启后，会话的归属还在 | 终端会话：重启后 `Projects()` 里它仍在原来的 worktree 行下（tmux 用户选项 `@vibe_remote_project`、`@vibe_remote_home`）；在终端里 `cd /tmp` 之后也不换位置。对话会话：从 `chat-sessions.json` 读回 `project`、`home` | `TestHomeSurvivesRestartTmux`、`TestHomeDoesNotFollowCd`、`TestChatRecordHomeRoundTrip` | T2 |
| daemon 重启后，「由 vibe-remote 创建」的记录和项目清单还在 | 用同一个 `state_dir` 重新打开：`fix-login` 仍是 `managed:true`，会话已删光的 `devflow` 仍在列表里 | `TestProjectStoreRoundTrip`、`TestProjectsSurviveSessionDeletionAndRestart` | T3、T4 |
| 升级前留下的会话没有归属字段 | `Projects()` 对还没有归属的会话补一次（补不上就下一次再试）：worktree 会话归到 `@vibe_remote_worktree_root`，其余按当时的 `pane_current_path` 推导；补出来的 git 项目进清单；对话记录在 `LoadChats` 里补并落盘 | `TestBackfillHomeForLegacyTmuxSessions`、`TestBackfillHomeForLegacyChatRecords` | T4 |
| `state_dir` 不可写 | daemon 正常启动，终端会话照常；`/api/v1/projects` 只返回现存会话所在的项目；新建命名 worktree 成功，本次运行期间是 `managed:true`；重启后它变成外部 worktree，能删目录、分支保留 | `TestProjectsWithUnwritableStateDir`、`TestMemoryProjectStore`、`TestNamedWorktreeWithMemoryStore`、`TestRemoveExternalNeverDeletesBranch` | T4、T3、T7、T13 |
| `projects.json` 损坏或 `version` 不是 1 | 文件被改名为 `projects.json.corrupt-<unix 时间>`，按空清单启动，日志有一行说明；之后的写入生成新的 `projects.json` | `TestProjectStoreCorruptFileRenamed` | T3 |
| 清单里的仓库目录被删除，但它下面还有会话 | 项目行 `error:"repo_missing"`，会话全部在项目级 `sessions` 里，仍能打开、输入、删除；其他项目不受影响 | `TestProjectsRepoMissing`、`test-sidebar.mjs › project_error_row_sessions_usable` | T4、T6b |
| git 卡住不返回 | 5 秒后该项目按 `git_failed` 返回，其余项目正常；连续轮询 3 次后 git 进程不堆积 | `TestProjectsGitFailed`、`TestGitTimeoutKillsProcess` | T4、T2 |
| 仓库有一个 worktree 在 `allowed_roots` 之外 | 列表里没有它；对它调 status 或 remove 返回 404 `worktree_not_found`，而且 daemon 没有对这个路径运行 git | `TestProjectsHidesWorktreesOutsideAllowedRoots`、`TestRemoveOnlyListedWorktrees/outside_allowed_roots` | T4、T13 |
| remove 的 `path` 不是 daemon 读到的 worktree（任意目录、主目录里的子目录、带 `..` 的路径） | 404 `worktree_not_found`，磁盘不变 | `TestRemoveOnlyListedWorktrees` | T13 |
| 伪造 `.git` 文件，让一个目录自称是受信任仓库的 worktree | `ChatTrust` 返回 `untrusted`，在里面新建对话会话被拒 | `TestChatTrust/forged_gitfile` | T10 |
| 协议 3 的桌面端删除 worktree 会话（只发 `DELETE /api/v1/sessions/{id}`） | 204；目录和分支都在；之后在新桌面端的侧边栏里这一行标「没有会话」，可以继续用或单独删除 | `TestDeleteSessionNeverReturnsPreserved`、`TestV3ClientFlowAgainstV4Daemon` | T12、T17 |
| 同一个 worktree 下有 2 个会话，删掉其中一个 | 另一个会话脚下的目录还在，仍能输入 | `TestDeleteOneOfTwoSessionsKeepsWorktree` | T12 |
| 用户在 vibe-remote 建的 worktree 里切到了别的分支，然后删除它 | 不再是 `managed`：只删目录，原来的分支和切过去的分支都保留 | `TestManagedRequiresPathAndBranch`、`TestRemoveExternalNeverDeletesBranch/switched_branch` | T3、T13 |
| 两次轮询之间新建或删除了会话，`/api/v1/sessions` 和 `/api/v1/projects` 的内容对不上 | 树里引用了、会话列表里没有的 id 被跳过；会话列表里有、树里没有引用的会话按旧版规则临时归位；不抛错，下一轮恢复一致 | `test-tree.mjs › tolerates_stale_ids`、`unreferenced_session_placed_by_legacy_rule` | T5 |
| `/api/v1/projects` 某一轮请求失败（网络抖动） | 能力状态和侧边栏的树保持上一轮的样子，不闪成旧版分组，也不清空 | `test-tree.mjs › capability_transitions`、`test-sidebar.mjs › keeps_tree_when_projects_request_fails` | T5、T6b |
| 侧边栏正在内联重命名时到了下一轮刷新 | 不重绘，输入框和已输入的字还在（现有保护保留） | `test-sidebar.mjs › no_rerender_while_renaming` | T6a（T6b 保持通过） |
| 名字输入框连续输入，较早的 `planWorktree` 请求比较晚的后返回 | 界面显示最后一次输入对应的结果 | `test-session-form.mjs › last_plan_wins` | T9 |
| 名字是 `@{-1}`、`@{-2}`（git 把它展开成上一个检出的分支），仓库里确实有上一个检出的分支 `prev`，上面有 1 个只在它上面的提交 | `invalid_worktree_name`，一次会改东西的 git 调用都没有；`prev` 和它的提交原样还在；桌面端不问 daemon 就显示「git 不接受这个分支名」 | `TestValidateWorktreeNameRejectsExpansion`、`test-worktree-name.mjs › shared_vectors` | T7、T9 |
| daemon 交给 git 的参数里出现短分支名（会被展开、被当成选项、或被解析成同名 tag） | 走完新建成功、新建失败后撤销、会话启动失败后撤销、删除 worktree 并删分支这 4 条路径，git 包装脚本记下的全部参数里：没有 `branch` 子命令，没有 `-b` / `-B`；名字只以这几种形式出现：`refs/heads/<名字>`、`refs/heads/<名字>/`（`for-each-ref` 的前缀模式）、`--exclude=<名字>`、`branch.<名字>`、`check-ref-format --branch <名字>`，以及 `-m` 后面的说明文字 `worktree: attached to refs/heads/<名字>` | `TestGitNeverGetsShortBranchName`（T7 写前 3 条路径，T13 补第 4 条） | T7、T13 |
| 校验通过之后、占分支之前，daemon 之外有人建了同名分支（或同名目录） | `worktree_branch_exists`（或 `worktree_path_exists`）；对方的分支仍指向对方的提交、对方的目录和里面的文件原样还在；本次占到的另一样东西已撤销 | `TestCreateRaceWithExternalBranch`、`TestCreateRaceWithExternalDir`（包内测试钩子卡在第 5 步之后） | T7 |
| 撤销创建时，分支已经被人往前提交过（会话启动失败前，有人在新 worktree 里提交了一次） | 目录被注销并删除；分支保留、仍指向那个新提交；返回的错误里写明分支没有删。分支已经不在、目录已经被删时，撤销不报错。daemon 之外的 `git worktree add` 用掉了本次占到的空目录（占分支之后、`worktree add` 之前）：新建失败（`create_failed`），对方的 worktree 和里面的文件原样还在，本次的分支被删掉，返回的错误写明目录没有删 | `TestUndoOnlyRemovesOwnArtifacts` | T7 |
| 删除 worktree 并删分支时，另有一个同名 tag，或这个分支还被别的 worktree 检出着，或分支在确认之后又多了提交 | 同名 tag：只删 `refs/heads/<名字>`，tag 和其他分支都在；被别处检出：目录已删，`branchDeleted:false`，`branchError` 写明那个路径，分支还在；多了提交：409 `worktree_changed`，什么都没删；分支名以 `-` 开头（别的工具建的 `-x`，登记成了 `managed`）：只删 `refs/heads/-x`，git 的参数里没有单独的 `-x` | `TestRemoveDeletesBranchByFullRef` | T13 |
| `allowed_roots` 配的是符号链接（`/tmp`），git 列出的是规范路径（`/private/tmp/…`） | 主目录和 worktree 照常列出；status 和 remove 用规范路径照常工作 | `TestProjectsAllowedRootIsSymlink`、`TestWorktreeStatusEndpoint/symlink_root` | T4、T13 |
| status / remove 的 `path` 字面在 `allowed_roots` 内，但经符号链接指向根外的一个真实 worktree | 404 `worktree_not_found`；git 包装脚本的调用记录为 0；根外的 worktree 原样 | `TestRemoveOnlyListedWorktrees/symlink_escape` | T13 |
| 会话开在子模块里，或开在 `git init --separate-git-dir` 的仓库里（`git worktree list` 第一项是 git 目录，design V11） | 项目 id 是工作目录的顶层（不是 git 目录），项目只有这一个 worktree、标 `main`，会话挂在它下面，不标「目录已不存在」；新建命名 worktree 被拒（plan 返回 `unsupported_repo`，attach 返回 `create_failed`），仓库旁边没有多出目录；不带名字的旧 Worktree 模式照旧成功，建出的 worktree 自成一个项目（id 是它自己，只有一行、标 `main`），它的会话挂在这一行下、不标「目录已不存在」，对它调 remove 返回 400 `worktree_is_main`（H27：要手动清理）；它的 worktree 的对话信任只查目录自己 | `TestResolveHomeSubmodule`、`TestResolveHomeSeparateGitDir`、`TestWorktreeModeHome/single`、`TestProjectsSingleWorktreeRepo`（含 `legacy_worktree_mode`）、`TestCreateNamedWorktreeUnsupportedRepo`、`TestPlanWorktree/unsupported_repo`、`TestChatTrust/submodule`、`TestRemoveSingleRepoRefused` | T2、T4、T7、T8、T10、T13 |
| 轮询在 `git worktree add` 完成之前读了列表，新建随后写了创建记录，轮询再回头清理「不在列表里」的记录 | 新记录不被删：这个 worktree 在下一轮仍是 `managed:true` | `TestProjectsKeepsRecordCreatedDuringPoll`（测试钩子卡在取快照和读列表之间） | T4 |
| 删除 worktree 时，有一个会话正在这个目录里创建、还没登记 | 删除返回 409 `worktree_changed`，目录还在，没有会话被结束，那个会话正常建成；反过来，删除进行中时在它下面新建会话 → `create_failed`，`message` 写明正在删除；删除结束后标记被清掉 | `TestRemoveRefusedWhileSessionStarting`、`TestCreateRefusedWhileWorktreeRemoving`、`TestRemovingMarkClearedAfterFailure` | T13 |
| daemon 的环境是 `LANG=zh_CN.UTF-8`、`LC_ALL=zh_CN.UTF-8`，还带着 `GIT_DIR` | git 子进程拿到的环境里 `LC_ALL=C`、没有 `GIT_DIR` / `GIT_WORK_TREE`；非 git 目录仍判成 `Git:false`；git 的报错是中文时，删除失败的分类不变（新出现的文件 → 409，其余 → 500） | `TestGitEnvIsFixed`、`TestResolveHomeNonGit/zh_locale`、`TestRemoveClassifiesFailureWithoutMessage`（git 包装脚本输出中文报错） | T2、T13 |
| 创建会话时 git 超时或失败 | 会话照常建成；归属留空，不进项目清单；列表里它临时自成一个项目；git 恢复后的下一次 `Projects()` 把它补到正确的项目和 worktree 下，并写回 tmux 选项或对话记录 | `TestCreateSessionWhenGitFailsLeavesHomeEmpty`、`TestBackfillRetriesUntilGitWorks` | T2、T4 |
| `projects.json` 写盘失败（目录中途变成只读） | 调用不 panic、不报错；内存里的清单照常更新；日志有一行 `projects store: write failed`；目录恢复可写后的下一次修改把整份清单写下去 | `TestProjectStoreWriteFailureLogsAndKeepsMemory` | T3 |
| 要删的 worktree 被 `git worktree lock` 锁定，或里面有初始化过的子模块，或有一个提交成 gitlink、自带 `.git` 的嵌入式仓库（agent 在里面 `git clone` 后 `git add .`） | 500 `worktree_remove_failed`，`message` 写明原因，`endedSessions` 为空；该 worktree 下的会话都没有被结束，目录和分支都在；嵌入式仓库里只在本地的提交还在。带不带 `discardFiles` 都一样 | `TestRemoveLockedRefusedBeforeEndingSessions`、`TestRemoveSubmoduleCheckoutRefused`（含 `embedded_repo`） | T13 |
| 要删的 worktree 里嵌着同一仓库的另一个 worktree（建在被忽略的 `.devflow-tmp/worktrees/inner` 下），里面有未跟踪的文件和一个运行中的会话 | 500 `worktree_remove_failed`，`message` 含里面那个 worktree 的路径；外层和里层的目录、分支都在，里层的未跟踪文件还在，里层的会话没有被结束。先删掉里层之后，外层照常能删 | `TestRemoveRefusedWhenNestedWorktree` | T13 |
| detached 的 worktree 上，会话在被结束之前的几秒里提交了一次（重查时未合并提交数还是 0） | 409 `worktree_changed`，`status.head` 是新提交、`unmergedCommits` 是 1，`endedSessions` 是已结束的会话；目录和那个提交都在，没有执行 `git worktree remove` | `TestRemoveHeadMovedWhileEndingSessions`（测试钩子 `testAfterSessionsEnded` 里提交一次）、`test-worktree-dialogs.mjs › delete_flow_409_after_sessions_ended_then_cancel` | T13、T14 |
| daemon 刚重启，会话表还没从 tmux 找回，这时直接查 worktree 的状态或删除它 | status 的 `sessions` 含正在运行的终端会话；删除会先结束它；不先调 `List()` 的 `Projects()` 里它也在自己的 worktree 行下 | `TestWorktreeStatusSeesTmuxSessionsAfterRestart`、`TestProjectsOrderSurvivesRestart` | T13、T4 |
| 结束会话时，其中一个会话刚好自己退出了；或者某个会话结束失败 | 已不存在的视为已结束、继续删除，它的 id 在 `endedSessions` 里；结束失败 → 500，`message` 含那个会话的 id，不执行 `git worktree remove`，`endedSessions` 是在它之前结束的 | `TestRemoveSessionAlreadyGoneContinues`、`TestRemoveSessionEndFailureStops` | T13 |
| `git worktree remove` 删到一半失败（某个子目录不可写）：git 已经注销了这个 worktree，目录还剩一部分 | 500 `worktree_remove_failed`，`message` 含 git 的输出并写明目录还剩一部分；分支没有被删；`endedSessions` 是已结束的会话；下一次 `Projects()` 里这一行消失、创建记录被清掉。桌面端再查状态得到 404，显示失败说明（git 的错误、已结束几个会话、目录还剩一部分和路径、分支保留） | `TestRemovePartialFailureReported`、`test-worktree-dialogs.mjs › delete_flow_500_partial_shows_failure` | T13、T14 |
| 删除请求超过桌面端的超时（3 个忙碌的对话会话，每个停 4 秒） | `removeWorktree` 的超时随会话数放大（3 个会话是 25 秒，上限 60 秒）；真的超时或断网后桌面端再查一次状态：已经 404 → 按删除成功收尾（关视图、刷新）；还在 → 提示「可能还在删除中」并刷新；daemon 在请求断开后照样删完 | `test-rest-projects.mjs › remove_timeout_scales`、`test-worktree-dialogs.mjs › delete_flow_timeout_then_gone`、`delete_flow_timeout_still_there`、`TestRemoveCompletesAfterClientDisconnect` | T13、T14 |
| daemon 重启后，同一 worktree 下两个未改名的终端会话 | 两个会话的 `created` 与重启前相同，先后不变，所以 `fix-login` 和 `fix-login 2` 不对调；升级前建的会话（没有 `@vibe_remote_created`）用 tmux 的 `session_created`；机器的时区不是 UTC 时（`TZ=Asia/Shanghai`）`created` 的字符串同样逐字不变 | `TestCreatedSurvivesRestartTmux`、`TestCreatedFallsBackToTmuxSessionCreated`、`TestProjectsOrderSurvivesRestart` | T2、T4 |
| 删除确认框里既有未提交文件、又有未合并提交 | 初始焦点在取消，回车 = 取消、不发请求（d25）；只有单独的 `commits` 形态回车才是「只删目录、保留分支」 | `test-worktree-dialogs.mjs › delete_wt_files_and_commits`、`delete_wt_enter_key` | T14 |
| 别人手工建的 `devflow-worktrees/foo` 加分支 `vibe/foo` | 不是 `managed`：删除时只删目录，分支 `vibe/foo` 保留 | `TestManagedLegacyVibeBranch` | T3 |
| 分支名与已有分支有「目录/文件」冲突：已有 `fix` 时填 `fix/login`，已有 `change/foo` 时填 `change` | 预检就返回 `ok:false`、`worktree_branch_exists`，`conflict` 是挡住它的那个分支，对话框内显示「已有分支 fix」并保持打开；直接发 attach 时在占分支之前被拦下，没有新目录；预检与新建的结论一致 | `TestBranchConflict`、`TestCreateNamedWorktreeBranchExists/dir_file_conflict`、`TestPlanWorktree/branch_conflict`、`TestPlanMatchesCreate`、`test-worktree-dialogs.mjs › plan_rejection_keeps_dialog_open` | T7、T8、T9 |
| worktree 模式从仓库的子目录发起，而发起处的提交里这一段路径是指向 `allowed_roots` 之外的符号链接（工作区里同名处是个真目录） | 建好之后对最终工作目录的检查不通过：`worktree_path_not_allowed`（fatal），`message` 含这个路径；新 worktree、分支、创建记录都已撤销，链接指向的目录里没有启动任何会话。只查 worktree 根的实现过不了这个用例 | `TestCreateWorktreeMappedWorkdirEscapesViaSymlink`、`TestWSWorktreeErrorsAreFatal/mapped_workdir_escape` | T7 |
| worktree 里只有被忽略的文件：`node_modules/` 下 1200 个文件和一个 `.env` | status 是 `dirtyFiles:0, ignoredFiles:1201`；确认框是「干净」的形态，多一句「另有 1201 个被 git 忽略的文件会一并删除」；不需要任何同意项就能删；删除时这个数变了也不会 409 | `TestIgnoredFiles`、`TestRemoveIgnoredOnlyIsClean`、`test-worktree-dialogs.mjs › delete_wt_ignored_note` | T13、T14 |

## 任务

顺序：T1 是可以单独合并的先行修复；T2–T6b 跑通最小闭环（daemon 下发项目和 worktree → 侧边栏分组显示），其中 T6a 只搬家、不依赖别的任务，可以最先做；T7–T9 新建命名 worktree；T10–T11 在已有 worktree 里开会话；T12–T14 会话与 worktree 分开收尾；T15 `-c` 说明；T16 快捷键；T17 降级核对；T18–T19 视觉 M1；T20 规则文件（c3 已同意，放在最后是因为它引用前面任务写好的测试名）。

`desktop/src/renderer/index.ts` 只在 T6a 做一次结构性改动（把侧边栏原样搬到 `sidebar.ts`），T6b 在搬好的文件里做三层结构，之后的任务每个只往里加一个回调和一小段接线。`desktop/src/renderer/styles.css` 在 T6b–T15 只追加新规则，T18 统一换配色，T19 统一换形态。

### T1 先行修复：分支有未合并提交时，删会话不删分支
- 状态：完成
- 文件：修改 `vibe-remoted/internal/session/worktree.go`（新增 `UnmergedCommits`；`CleanupWorktree` 里两处会执行 `git branch -D` 的路径之前先查）；测试 `vibe-remoted/internal/session/worktree_test.go`、`vibe-remoted/internal/server/worktree_test.go`。不改桌面端、不改协议、不改任何现有测试。
- 接口：
  - 使用：`gitAt(dir, args...)`、`WorktreePreservedError`、`RollbackWorktree(meta)`（都是现有的）
  - 提供：`UnmergedCommits(dir, branch string) (int, error)`，`branch` 为空表示 `dir` 的 `HEAD`；命令见 design 第 3 节「未合并提交数」。分支写成完整引用名 `refs/heads/<branch>`，不用短名：有同名 tag 时短名会被解析成 tag，把未合并的提交数成 0（design V10）
- 场景：R5.5（H9 的判定）、R5.10（过渡行为，d5）、R5.11（detached 的计数）
- 测试：
  - `TestUnmergedCommits`：分支 `fix-login` 上 2 个独有提交 → 2；另建一个本地分支指向它之后 → 0；只被 `refs/remotes/origin/fix-login` 包含 → 0；子测试 `detached`：`branch` 传空，detached 的 `HEAD` 上 2 个不属于任何分支的提交 → 2；子测试 `tag_with_same_name`：分支 `fix-login` 有 2 个独有提交，另建一个同名 tag 指向 `main` → 仍是 2
  - `TestCleanupKeepsCleanWorktreeWithUnmergedCommits`：工作区干净、分支有 2 个未合并提交 → 返回 `*WorktreePreservedError`；目录在，分支在，`git rev-list --count main..<分支>` 是 2
  - `TestCleanupKeepsBranchWhenWorktreeDirMissing`：worktree 目录已被 `rm -rf`、分支有 2 个未合并提交 → 返回 `*WorktreePreservedError`，分支在
  - `TestCleanupFailsClosedWhenUnmergedCheckFails`：`UnmergedCommits` 执行失败（`meta.SourceRepo` 指向不存在的目录）→ 返回错误，目录和分支都没有被删
  - `TestDeleteCleanWorktreeWithUnmergedCommitsReturns409`（server）：`DELETE /api/v1/sessions/{id}` → 409，响应体 `error` 是 `worktree_preserved`，`worktreeRoot`、`branch` 是该会话的值
  - 现有的 `TestWorktreeCleanCleanupRemovesWorktreeAndBranch`、`TestWorktreeDirtyCleanupPreservesBoth`、`TestWorktreeIgnoredFileIsPreserved`、`TestDeleteDirtyWorktreeReturnsStructuredConflict` 不改、照常通过
- 完成定义：
  - `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/session ./internal/server -run 'TestUnmergedCommits|TestCleanup|TestWorktree|TestDelete'` 输出两行 `ok`
  - 这个任务是单独的一个提交，`git show --stat HEAD` 只列出上面 3 个文件；提交可以不带后续任务直接挑到 `change/dual-mode` 上。验证方法：在 `.devflow-tmp/worktrees/` 下另建一个临时 worktree，从 `change/dual-mode` 开一个临时分支，把这个提交挑过去，在那里执行 `TMUX_TMPDIR=$(mktemp -d) make check`，通过后删掉这个临时 worktree 和临时分支。不切主目录的分支，不改 `change/dual-mode` 本身
- 依赖：无

### T2 daemon：读 worktree 列表，创建会话时记下归属
- 状态：完成
- 文件：修改 `vibe-remoted/internal/session/worktree.go`（`Worktree`、`ListWorktrees`、`Home`、`ResolveHome`、`gitAtTimeout`、包级变量 `gitTimeout`；`gitAt` 和 `gitAtTimeout` 共用一个建命令的函数，固定 git 的运行环境）；`vibe-remoted/internal/session/runner.go`（`RunnerConfig.Project/Home/Created`、`Runner.Home()`、`start` 里写 tmux 用户选项 `@vibe_remote_project`、`@vibe_remote_home`、`@vibe_remote_created`、`list-sessions` 格式串加到 13 列、`parseTmuxSessionLine` 接受 8、9、13 列）；`vibe-remoted/internal/session/manager.go`（`CreateOptions.Home`、创建时算归属、reconcile 找回会话时读回归属和创建时间）；`vibe-remoted/internal/session/chat_manager.go`（创建对话会话时算归属并写进记录，`Handoff` 把对话会话的归属传给新终端会话）；`vibe-remoted/internal/chat/store.go`（`Record.Project`、`Record.Home`，`omitempty`，`version` 仍是 1）。测试 `worktree_test.go`、`runner_test.go`、`manager_test.go`、`chat_manager_test.go`、`vibe-remoted/internal/chat/store_test.go`
- 接口：
  - 使用：`gitAt`、`CreateWorktree(sourceWorkdir, sessionID)`（现有签名，本任务不改）、`WorktreeMetadata`
  - 提供：`type Worktree struct { Path, Branch, Head string; Detached, Bare, Prunable, Locked bool; LockReason string }`；`ListWorktrees(dir string) ([]Worktree, error)`；`type Home struct { Project, Path, Repo string; Git, Single bool }`；`ResolveHome(dir string) (Home, error)`；`gitAtTimeout(dir string, args ...string)`；`(r *Runner) Home() (project, home string)`；`RunnerConfig.Created time.Time`；`CreateOptions.Home *Home`；`chat.Record.Project`、`chat.Record.Home`
  - `ResolveHome` 的三种结果（design 4.9）：不是仓库 → `Home{Git:false}`、`nil`；git 失败或超时 → 错误；认不出主目录（列表第一项没标 `bare`、其下也没有 `.git`：子模块、`--separate-git-dir`）→ `Project` = `Path` = `rev-parse --show-toplevel`，`Repo` = 第一项的路径，`Single` 为真。「不是仓库」不靠匹配 git 的报错文字判断：`rev-parse --show-toplevel` 失败且没有超时时，`git rev-parse --is-inside-git-dir` 输出 `true`（在 `.git` 目录或裸仓库里面）→ 按不是仓库处理；否则从目录逐级向上找 `.git`，一个都没有才算不是仓库，有就是错误
  - git 的运行环境（design 4.9）：`LC_ALL=C`；去掉继承来的 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_COMMON_DIR`、`GIT_OBJECT_DIRECTORY`、`GIT_NAMESPACE`
  - `ResolveHome` 返回错误时：会话照常创建，归属两个字段留空（tmux 选项写空串、对话记录不写），由 T4 的补归属在之后重试（design 5.1）
  - 创建时间（d23，design 4.2、5.1）：`start` 把 `r.Created` 以 RFC 3339 纳秒 UTC 写进 `@vibe_remote_created`；找回会话时先用它，解析不了用 `#{session_created}`（unix 秒），都没有才用找回的时刻。读回的时间一律转成本地时区（`.Local()`）再放进 `Runner.Created`：`List()` 用 `Created.Format(time.RFC3339)` 输出，现有会话是本地时区的 `…+08:00`，不转的话重启后会变成 `…Z`（design 5.1）。`/api/v1/sessions` 里 `created` 的格式不变
  - 归属的规则（design 5.1、H19）：普通模式是 `ResolveHome(workdir)`；worktree 模式 `home` 是新 worktree 的根、`project` 取 `ResolveHome(meta.SourceRepo)` 返回的 `Project`；它返回 `Single`（子模块、`--separate-git-dir`）时 `project` 取新 worktree 的根自己，与事后对新 worktree 调 `ResolveHome` 的结果一致（design 4.9，decisions #36）；它报错时两个字段都留空；交接出来的终端会话照抄对话会话的归属；之后不随 `cd` 变。`/api/v1/sessions`、`sessions` 帧、`ready` 帧不加任何字段
- 场景：R1.3、R1.5（重启后顺序不变）、R1.8、R4.2
- 测试：
  - `TestListWorktrees`：第一项是主目录，从链接 worktree 里、从符号链接路径调用时第一项的路径相同且是规范路径；detached 的一项 `Detached` 为真、`Branch` 为空、`Head` 是 40 位；目录被删的一项 `Prunable` 为真；裸仓库第一项 `Bare` 为真；`<仓库>/.devflow-tmp/worktrees/general-skills` 这样的隐藏目录照常列出；`git worktree lock` 过的一项 `Locked` 为真，带 `--reason usb` 的 `LockReason` 是 `usb`
  - `TestResolveHome`：主目录 → `Project` 和 `Path` 都是主目录；主目录的子目录 → `Path` 是主目录；链接 worktree 的子目录 → `Project` 是主目录、`Path` 是该 worktree 的根；`TestResolveHomeNonGit`：`notes` 目录 → `Git` 为假，`Project` 和 `Path` 都是目录本身，错误为 `nil`；子测试 `zh_locale`：测试进程设 `LANG`、`LC_ALL` 为 `zh_CN.UTF-8` 时结果相同
  - `TestResolveHomeSubmodule`、`TestResolveHomeSeparateGitDir`（design V11）：子模块的工作目录、`git init --separate-git-dir` 的工作目录 → `Git` 为真、`Single` 为真，`Project` 和 `Path` 都是工作目录的顶层（不是 git 目录），`Repo` 是 git 目录；它们的链接 worktree 同样是 `Single`，`Project` 是那个 worktree 自己
  - `TestResolveHomeInsideGitDir`：目录是 `<仓库>/.git/hooks`、裸仓库目录本身 → `Git` 为假，错误为 `nil`
  - `TestResolveHomeGitFailure`：目录上一级有一个空的 `.git` 目录（git 认不出的仓库）→ 返回错误，不是 `Git:false`；`gitTimeout` 调成 50 ms 加睡眠的假 git → 返回错误
  - `TestGitEnvIsFixed`：测试进程设 `LC_ALL=zh_CN.UTF-8`、`GIT_DIR=<另一个仓库>/.git`、`GIT_WORK_TREE=/`，`PATH` 前面的 git 包装脚本把自己的环境记进文件 → 记录里 `LC_ALL=C`，没有 `GIT_DIR`、`GIT_WORK_TREE`；`ListWorktrees(<本仓库>)` 的第一项是本仓库，不是 `GIT_DIR` 指的那个
  - `TestCreateSessionWhenGitFailsLeavesHomeEmpty`：创建会话时让 git 超时 → 会话建成，`Home()` 两个值都是空串，不是工作目录本身
  - `TestGitTimeoutKillsProcess`：`gitTimeout` 调成 50 ms，`PATH` 里放一个睡 5 秒的假 git → 1 秒内返回错误，假 git 进程已不存在
  - `TestWorktreeModeHome`：worktree 模式新建 → `runner.Home()` 的 `home` 是新 worktree 的根，`project` 是源仓库主目录。子测试 `single`：发起处是子模块的工作目录、`--separate-git-dir` 的工作目录各一例 → `home` 和 `project` 都是新 worktree 的根（不是发起处的工作目录，也不是 git 目录）
  - `TestCreateInHiddenWorktreeDir`：在 `.devflow-tmp/worktrees/general-skills` 新建普通会话 → `home` 是该目录
  - `TestParseTmuxSessionLineColumns`：8、9、13 列的行都解析成功，13 列时读出 `project`、`home`、两个创建时间；10、11、12 列被拒
  - `TestCreatedSurvivesRestartTmux`（需要 tmux）：先后建 2 个会话，新建一个 `Manager` 找回 → 两个会话 `List()` 里的 `created` 与重启前逐字相同，内存里的 `Created` 相差 0 纳秒。完成定义里另在 `TZ=Asia/Shanghai` 下跑一遍：重启前后都是 `…+08:00`（读回后没有转成本地时区的实现，在这一遍里会得到 `…Z` 而失败；CI 是 UTC，只跑默认时区测不出来）
  - `TestCreatedFallsBackToTmuxSessionCreated`（需要 tmux）：把会话的 `@vibe_remote_created` 清掉（相当于升级前建的会话），等 2 秒后由新的 `Manager` 找回 → `Created` 比找回的时刻早至少 1 秒（来自 `session_created`）
  - `TestHomeSurvivesRestartTmux`（需要 tmux）：建会话后新建一个 `Manager`，`List()` 找回的会话 `Home()` 与重启前相同
  - `TestHomeDoesNotFollowCd`（需要 tmux）：会话里执行 `cd` 到另一个临时目录后由新的 `Manager` 找回 → `workdir` 跟着变成那个目录（现有行为），`Home()` 不变
  - `TestChatRecordHomeRoundTrip`：带 `project`、`home` 的记录写盘再读回相同；没有这两个字段的旧文件能读，字段为空
  - `TestHandoffCopiesHome`：对话会话在 worktree `fix-login` 里，交接出来的终端会话 `Home()` 与它相同（即使 `workdir` 是子目录）
- 完成定义：
  - `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/session ./internal/chat -run 'TestListWorktrees|TestResolveHome|TestGitTimeout|TestGitEnvIsFixed|TestWorktreeModeHome|TestCreateInHidden|TestCreateSessionWhenGitFails|TestParseTmuxSessionLine|TestHome|TestCreated|TestChatRecordHome|TestHandoffCopiesHome'` 输出两行 `ok`
  - `cd vibe-remoted && TZ=Asia/Shanghai TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/session -run 'TestCreatedSurvivesRestartTmux|TestCreatedFallsBackToTmuxSessionCreated'` 输出 `ok`（非 UTC 时区下 `created` 重启前后逐字相同）
  - `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/server -run TestTerminalFramesUnchangedV3` 通过，`git status --short vibe-remoted/internal/server/testdata vibe-remoted/internal/server/golden_test.go` 没有输出
- 依赖：无

### T3 daemon：项目清单和创建记录（projects.json）
- 状态：完成
- 文件：新建 `vibe-remoted/internal/session/projects_store.go`、`vibe-remoted/internal/session/projects_store_test.go`
- 接口：
  - 使用：写盘方式照 `vibe-remoted/internal/chat/store.go`（临时文件、fsync、rename，文件 0600）
  - 提供：`OpenProjectStore(stateDir string) (*ProjectStore, error)`；`NewMemoryProjectStore() *ProjectStore`；`AddProject(id string)`；`RemoveProject(id string) bool`；`Projects() []string`；`type WorktreeRecord struct { Project, Path, Branch, CreatedAt string }`；`AddWorktree(project, path, branch string)`（同一路径已有记录时替换，`CreatedAt` 取当前时间，纳秒精度）；`RemoveWorktree(path string)`；`Worktrees() []WorktreeRecord`（快照）；`RemoveWorktreeIfSame(rec WorktreeRecord) bool`（记录仍与 `rec` 逐字段相同时才删）；`Managed(project, path, branch string) bool`
  - 文件格式见 design 5.2；`Managed` 的两条规则见 design 5.3（第 2 条每次现算，不写文件）。第 2 条里的 `X` 必须是 vibe-remote 生成过的会话 id 形态：`^[0-9]{13}-[0-9a-f]{8}$` 或 `^[0-9]{19}$`，不再用 `ValidSessionID`（d22）。`ProjectStore` 自己的互斥锁是叶子锁，每次修改在锁内同步写盘
  - 写盘失败（design 5.2）：内存照常更新，记一行日志 `projects store: write failed: <错误>`，不 panic、不向调用方报错；下一次修改把整份清单重写
- 场景：R2.2（清单跨重启）、R5.8（`managed` 的判定，H17）
- 测试：
  - `TestProjectStoreRoundTrip`：`AddProject("/r/devflow")`、`AddWorktree("/r/devflow", "/r/devflow-worktrees/fix-login", "fix-login")` 后重新 `OpenProjectStore` 同一目录 → `Projects()` 含该 id，`Managed(…, "fix-login")` 为真；文件权限是 0600；重复 `AddProject` 不产生第二条
  - `TestProjectStoreRemove`：`RemoveProject` 对存在的 id 返回 true 并落盘，对不存在的返回 false；`RemoveWorktree` 之后 `Managed` 为假
  - `TestManagedRequiresPathAndBranch`：记录的路径相同、分支传 `other` → 假；分支传空（detached）→ 假；路径不同、分支相同 → 假
  - `TestManagedLegacyVibeBranch`：没有任何记录时，`path` 是 `/r/devflow-worktrees/1794824025040-12b763ac`、分支是 `vibe/1794824025040-12b763ac` → 真；末段和分支里的 id 是 19 位数字 → 真；分支是 `vibe/另一个id` → 假；末段是 `foo`、分支是 `vibe/foo` → 假；末段是 `1794824025040-12B763AC`（大写）或 `abc123` → 假；容器目录不是 `<主目录名>-worktrees` → 假
  - `TestProjectStoreRemoveWorktreeIfSame`：取快照后把同一路径的记录删掉再 `AddWorktree`（`CreatedAt` 变了）→ 用快照里的旧记录调用返回 false，新记录还在；记录没变时返回 true 并落盘
  - `TestProjectStoreWriteFailureLogsAndKeepsMemory`：打开后把目录改成 0500，`AddProject`、`AddWorktree` → 不 panic，`Projects()`、`Managed(…)` 反映新内容，捕获的日志里有 `projects store: write failed`；目录改回 0700 后再 `AddProject` 另一个 id → 重新打开能读到全部 3 条
  - `TestProjectStoreCorruptFileRenamed`：文件内容不是 JSON、`version` 是 2 各一例 → 打开成功、清单为空，目录里有 `projects.json.corrupt-<数字>`；随后 `AddProject` 写出新的 `projects.json`
  - `TestOpenProjectStoreUnwritableDir`：目录是 0500 → 返回错误
  - `TestMemoryProjectStore`：增删查都可用，不创建任何文件
- 完成定义：`cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/session -run 'TestProjectStore|TestManaged|TestOpenProjectStore|TestMemoryProjectStore'` 输出 `ok`；`grep -n "ValidSessionID" vibe-remoted/internal/session/projects_store.go` 没有输出
- 依赖：无

### T4 协议 4：项目树端点 `GET /api/v1/projects`、`POST /api/v1/projects/remove`
- 状态：完成
- 文件：
  - 新建 `vibe-remoted/internal/session/projects.go`（`Manager` 的方法）、`vibe-remoted/internal/session/projects_test.go`、`vibe-remoted/internal/server/projects.go`（两个处理函数）、`vibe-remoted/internal/server/projects_test.go`
  - 修改 `vibe-remoted/internal/protocol/protocol.go`（`Version = 4`；类型 `ProjectsResponse`、`Project`、`ProjectWorktree`）、`vibe-remoted/internal/server/server.go`（`routes()` 加两条路由）、`vibe-remoted/cmd/vibe-remoted/main.go`（打开 `ProjectStore`，失败时改用内存清单并记一行日志，`mgr.SetProjectStore`）、`vibe-remoted/internal/session/manager.go` 和 `chat_manager.go`（新建会话成功后 `AddProject`；现有 worktree 模式建好后 `AddWorktree`、回滚时 `RemoveWorktree`；都在 `Manager.mu` 之外调用）
  - 修改 `desktop/src/shared/protocol.ts`（`PROTOCOL_VERSION = 4`、`CHAT_MIN_PROTO = 3`、类型 `Project`、`ProjectWorktree`）、`desktop/src/renderer/rest.ts`（`listProjects`、`removeProject`、`RestError`）、`desktop/src/renderer/chat/availability.ts`（比较和文案里的 `want` 都改用 `CHAT_MIN_PROTO`，所以对协议 2 的 daemon 仍然显示「需要协议 3」，`gui-chat-smoke.mjs` 的 R17.2 断言不用改）、`desktop/src/renderer/i18n.ts`（`terminal.oldDaemon`、`picker.oldDaemon` 中英文改成 design 7.4 末尾的新文案）
  - 修改 `docs/protocol.md`（版本表加第 4 行，先写本任务已落地的部分：两个新端点、`/api/v1/info.proto` 为 4、「所有 S→C 帧的字段与 v3 相同」；REST 一节加这两个端点的请求、响应、错误码）
  - 随版本号改的断言（c1 已同意，decisions #11）：`vibe-remoted/internal/server/contract_test.go` 的 `TestInfoAndReadyProto3` 改名 `TestInfoAndReadyProto4`、3 改 4；`vibe-remoted/internal/protocol/protocol_test.go:41` 的 `Version != 3` 改为 4；`.claude/skills/verify/scripts/ws-chat-smoke.mjs:416` 的 `info.proto !== 3` 改为 4。`desktop/scripts/test-chat-client.mjs` 里假 daemon 发的 `proto: 3` 不改
  - 测试 `desktop/scripts/test-chat-availability.mjs`、新建 `desktop/scripts/test-rest-projects.mjs`
- 接口：
  - 使用：`ListWorktrees`、`ResolveHome`、`gitAtTimeout`、`Runner.Home()`、`chat.Record.Project/Home`（T2）；`ProjectStore` 的全部方法（T3）；`checkToken`、`maxRESTBody`、`Manager.syncFromTmux`、`cfg.ResolveAllowedWorkdir`（现有；它就是传给 `Projects` 的 `allow`。不用 `cfg.IsAllowedWorkdir`：它只做字面比较，根配成 `/tmp` 时会把 git 列出的 `/private/tmp/…` 全部滤掉，decisions #17）
  - 提供（Go）：`(m *Manager) SetProjectStore(s *ProjectStore)`；`type AllowFunc func(path string) (canonical string, err error)`；`(m *Manager) Projects(allow AllowFunc) []protocol.Project`；`(m *Manager) RemoveProject(id string) error`，错误是 `ErrProjectNotFound` 或 `ErrProjectHasSessions`
  - 提供（TS）：`listProjects(): Promise<Project[] | null>`（404 → `null`，其他失败抛错）；`removeProject(id: string): Promise<void>`；`class RestError extends Error { status: number; code: string; body: unknown }`；常量 `PROTOCOL_VERSION = 4`、`CHAT_MIN_PROTO = 3`（`chat/availability.ts` 改用后者判断）
  - 行为照 design 4.2、4.3、5.4：`Projects` 开头先调 `syncFromTmux()`（design 4.9；daemon 刚重启时会话表里还没有 tmux 里的会话，不调的话它们不在树里）；每个项目 id 只跑一次 `ListWorktrees`，最多 8 个同时在跑，git 调用不在 `Manager.mu` 里；排序由 daemon 定；数组字段输出 `[]` 不输出 `null`；过滤掉 `prunable`、裸仓库本身、`allow` 报错的；认不出主目录的仓库（列表第一项没标 `bare`、其下也没有 `.git`）只生成一个 `main:true` 的 worktree（design 4.2 的判定表）
  - 清理过期的创建记录按固定顺序做（design 5.2，decisions #20）：先 `store.Worktrees()` 取快照，再读各项目的列表，最后只对快照里、且 `path` 不在所属项目列表中的记录调 `RemoveWorktreeIfSame`。包内测试钩子 `testAfterWorktreeSnapshot func()` 在取完快照、读列表之前调用
  - 每次调用都给还没有归属的会话补归属（5.4：升级前的会话，或创建时 git 失败的），`ResolveHome` 仍报错就留空、下次再试；补出来的 git 项目进清单。补不上的会话这一轮临时自成一个项目（id = 它的工作目录，`git:false`）。不加退避和次数上限：一直补不上的会话每轮重试一次，成本是最多 2 个带超时的 `rev-parse`（design 5.4）
- 场景：R1.1、R1.3、R1.5、R2.1–R2.7（daemon 一侧）、R4.5、R9.1（`CHAT_MIN_PROTO`）、性能、安全
- 测试（除注明的以外都在 `server/projects_test.go`，经 `httptest` 请求）：
  - `TestProjectsTree`、`TestProjectsNonGitProject`、`TestProjectsListsSessionlessAndExternal`、`TestProjectsTwoSessionsOneWorktree`、`TestProjectsPrunedWorktreeSessionsMoveUp`、`TestProjectsHidesWorktreesOutsideAllowedRoots`、`TestProjectsRepoMissing`、`TestProjectsGitFailed`：断言见测试计划 R1.1、R1.3、R2.1、R4.5、R2.5、R2.6、R2.7 各行
  - `TestProjectsResponseShape`：响应体有 `proto: 4`；没有会话的 worktree `sessions` 是 `[]`；detached 的一项有 `detached:true`、没有 `branch` 键；`head` 是 7 位；主目录有 `main:true`；T3 记录过的有 `managed:true`
  - `TestProjectsOrderStable`：3 个项目共 8 个会话，连续 40 次响应体逐字节相同；名称 `Beta`、`alpha`、`gamma` 的顺序是 `alpha`、`Beta`、`gamma`；worktree 顺序是主目录、`a-branch`、`b-branch`、detached
  - `TestProjectsSurviveSessionDeletionAndRestart`：删光会话后用同一个 `state_dir` 新建 `Manager` 和 `ProjectStore` → `devflow` 和 2 个 worktree 仍在
  - `TestRemoveProjectKeepsDisk`、`TestProjectReappearsAfterNewSession`、`TestRemoveProjectWithSessions409`、`TestRemoveProjectNotFound`：断言见测试计划 R2.3、R2.4
  - `TestNonGitProjectDisappearsWithLastSession`：`notes` 的最后一个会话删除后，响应里没有 `notes`（H18）
  - `TestProjectsDropsStaleWorktreeRecord`：记录过的 worktree 被 `git worktree remove` 之后请求一次 → 记录没了；同一路径上再手工建一个同名分支的 worktree，它不是 `managed`
  - `TestProjectsAllowedRootIsSymlink`：`allowed_roots` 是一个指向仓库父目录的符号链接，请求经 `httptest` 走真实的 `config.Config` → 主目录和 2 个 worktree 都在响应里（用 `cfg.IsAllowedWorkdir` 时这个用例会得到空的 `worktrees`）
  - `TestProjectsSingleWorktreeRepo`：会话开在子模块的工作目录里、开在 `--separate-git-dir` 仓库里各一例 → 项目 id 是工作目录的顶层，`name` 是它的末段，`worktrees` 恰好一项（`path` = id，`main:true`，`branch` 是当前分支），会话在这一项的 `sessions` 里；响应里没有任何路径以 `/.git/modules/sub` 结尾。子测试 `legacy_worktree_mode`：在子模块的工作目录里用不带名字的旧 Worktree 模式新建会话 → 响应里多一个项目，id 是新 worktree 的根，`worktrees` 恰好一项（`main:true`，`branch` 是 `vibe/<会话id>`），会话在这一项的 `sessions` 里；发起处那个项目的项目级 `sessions` 里没有它（否则桌面端会标「目录已不存在」）
  - `TestProjectsKeepsRecordCreatedDuringPoll`（session 包）：在 `testAfterWorktreeSnapshot` 里用真实的 git 建一个 worktree 并 `AddWorktree` → 这一次 `Projects()` 返回后记录还在；下一次 `Projects()` 里该行 `managed:true`。对照：记录在快照里、worktree 已被 `git worktree remove` → 记录被删
  - `TestProjectsOrderSurvivesRestart`（session 包，需要 tmux）：同一 worktree 下先后建 2 个终端会话，记下 `Projects()` 里它们的先后；用新的 `Manager` 和同一个 `ProjectStore` 再取一次（新的 `Manager` 上不先调 `List()`，直接调 `Projects()`）→ 两个会话都在原来的 worktree 行下，先后相同
  - `TestBackfillRetriesUntilGitWorks`（session 包）：会话创建时 git 超时（归属为空）→ 第一次 `Projects()`（git 仍超时）里它在一个 `git:false` 的临时项目下，清单里没有这个项目；恢复 git 后的下一次 `Projects()` 里它在仓库项目的主目录行下，归属已写回，项目进了清单
  - `TestBackfillHomeForLegacyTmuxSessions`（session 包，需要 tmux）：会话的 tmux 选项里没有 `@vibe_remote_project` → 第一次 `Projects()` 之后有了，项目进了清单；`TestBackfillHomeForLegacyChatRecords`：没有 `project` 的对话记录经 `LoadChats` 后有了并已落盘
  - `TestProjectsWithUnwritableStateDir`：用 `NewMemoryProjectStore()` → 只返回现存会话所在的项目，不报错
  - `TestProjectsOneGitCallPerProject`（session 包）：20 个仓库各 5 个 worktree，`PATH` 前面放一个记数后转调真实 git 的包装脚本 → 一次 `Projects()` 的调用数是 20，同时在跑的不超过 8（环境里没有归属为空的会话，所以这 20 个不含补归属的调用）；子测试 `unresolved_session`：再加 1 个一直补不上归属的会话（工作目录上层有一个空的 `.git` 目录）→ 每轮多出的调用不超过 3 个，连续 3 轮每轮的总数相同；`TestSessionsEndpointRunsNoGit`：同一环境下 `GET /api/v1/sessions` 的调用数是 0
  - `TestNewEndpointsRequireToken`：两个新端点不带 token、带错 token 都是 401
  - `test-chat-availability.mjs › proto3_daemon_supports_chat`：`info.proto` 是 3 且 `chat.supported` 为真 → `enabled` 为真；`proto2_reason_still_says_3`：`info.proto` 是 2 → 原因文字含「协议 2」和「需要协议 3」；现有用例不改、照常通过
  - `test-rest-projects.mjs`：`fetch` 返回 404 → `listProjects()` 得到 `null`；返回 500 → 抛 `RestError`，`status` 是 500；`removeProject` 遇到 409 → `RestError.code` 是 `project_has_sessions`
- 完成定义：
  - `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/session ./internal/server ./internal/protocol -run 'TestProjects|TestRemoveProject|TestProjectReappears|TestNonGitProject|TestBackfill|TestSessionsEndpointRunsNoGit|TestNewEndpointsRequireToken|TestInfoAndReadyProto4|TestTerminalFramesUnchangedV3|TestProtocolChatFramesJSON'` 输出三行 `ok`
  - `cd desktop && npm run test:chat-availability && npm run test:rest-projects` 都以退出码 0 结束
  - `git diff --stat HEAD~1 -- vibe-remoted/internal/server/testdata vibe-remoted/internal/server/golden_test.go` 没有输出
  - `grep -rn "IsAllowedWorkdir" vibe-remoted/internal/server vibe-remoted/internal/session vibe-remoted/cmd --include='*.go' | grep -v _test.go` 没有输出
  - 按 `/protocol-sync` 核对：`Project`、`ProjectWorktree` 的 JSON 名在三处一致
- 依赖：T2、T3

### T5 桌面端：把会话和项目树合并成三层树（tree.ts，纯函数）
- 状态：完成
- 文件：新建 `desktop/src/renderer/tree.ts`、`desktop/scripts/test-tree.mjs`；修改 `desktop/package.json`（加 `test:tree`）
- 接口：
  - 使用：`SessionInfo`、`Project`（`desktop/src/shared/protocol.ts`，T4）；`Dot`（`desktop/src/renderer/chat/activity.ts`，现有）
  - 提供：`TreeSession`、`TreeWorktree`、`TreeProject`、`Capability`；`buildTree(sessions, projects)`；`visibleSessions(machines, collapsedProjects)`；`projectRollup(project, dotOf)`；`sessionContext(tree, id)`；`notificationTitle(machineName, ctx)`；`nextCapability(prev, result)`；`projectHue(id)`（项目 id 的 FNV-1a 32 位哈希对 360 取模，T6b 用它给项目行标签定色相）；`countActiveSessionsAt(sessions, dir)`（`workdir` 等于 `dir` 且 `state` 不是 `ended` 的会话数，T15 用，d24）。签名见 design 4.10，规则见 4.10 末尾的「`buildTree` 的规则」。文件里不引用 DOM
- 场景：R1.1–R1.8（树的一侧）、R2.5、R2.7、R7.5、R9.1（旧 daemon 的分组和能力状态）
- 测试（`test-tree.mjs`）：
  - `two_worktrees_each_with_session`、`single_worktree_is_flat`、`non_git_project`、`detached_label_is_short_hash`、`gone_sessions`、`project_error`：断言见测试计划 R1.1、R1.2、R1.3、R1.8、R2.5、R2.7 各行
  - `duplicate_names_get_numbers`：同一 worktree 下 `title` 都是 `devflow` 的 3 个会话 → `devflow`、`devflow 2`、`devflow 3`；中间那个改名为 `登录修复` → `devflow`、`登录修复`、`devflow 2`；不同 worktree 下同名的不互相编号
  - `keeps_daemon_order`：输入的项目、worktree、会话 id 顺序原样保留；`legacy_order_sorted`：`projects` 为 `null` 时把同一组会话打乱 40 次，结果都相同，顺序符合 design 4.2 的规则
  - `legacy_groups_by_session_fields`：`mode:"worktree"`、`sourceRepo:"/r/devflow"`、`worktreeRoot:"/r/devflow-worktrees/x"`、`branch:"vibe/x"` 的会话在项目 `/r/devflow` 的 worktree `vibe/x` 下，`managed` 为真；`workdir:"/r/devflow/src"` 的普通会话在同一项目的主目录行；`workdir:"/r/devflow-worktrees/x/sub"` 的普通会话在 `vibe/x` 行；`workdir:"/tmp/notes"` 自成一个项目
  - `tolerates_stale_ids`：树里引用的 id 不在会话列表里 → 跳过、不抛错；`unreferenced_session_placed_by_legacy_rule`：会话列表里有、树里没有引用的会话按旧版规则归位，全树里只出现一次
  - `rollup_waiting_only`：会话的点是 `idle`、`output` → `none`；有一个 `waiting` → `waiting`
  - `visible_sessions_skip_collapsed`：断言见测试计划 R7.5；另外 worktree 层和扁平项目的会话按从上到下的顺序给出
  - `session_context_and_notification_title`：`sessionContext` 返回 `{project:"devflow", branch:"fix-login", name:"登录修复"}`；通知标题是 `this-mac · devflow / fix-login · 登录修复`；非 git 是 `this-mac · notes · todo`；找不到 id 返回 `null`
  - `capability_transitions`：`unknown` 加数组 → `v4`；`v4` 加 `null` → `legacy`；`v4` 加 `Error` → `v4`；`unknown` 加 `Error` → `unknown`
  - `project_hue_stable`：同一个 id 调用 100 次结果相同，是 0–359 的整数；`/r/devflow` 和 `/r/new-api` 的结果不同；空串不抛错
  - `count_active_sessions_at`：`/r/devflow` 下 1 个运行中的终端会话、1 个 `state:"ended"` 的对话会话、1 个 `workdir` 是 `/r/devflow/src` 的会话 → `countActiveSessionsAt(sessions, '/r/devflow')` 是 1，对 `/r/devflow/src` 是 1，对 `/r/other` 是 0
- 完成定义：`cd desktop && npm run typecheck && npm run test:tree` 退出码 0，输出里每个用例一行 `ok - <用例名>`
- 依赖：T4

### T6a 桌面端：侧边栏渲染原样搬到 `sidebar.ts`（只搬不改）
- 状态：完成
- 文件：
  - 新建 `desktop/src/renderer/sidebar.ts`：从 `index.ts` 原样搬来 `renderSidebar` 的函数体（现 1100–1282 行）、`startInlineRename`（1288–1334 行）、`rendererIcon`（98 行起）。新建 `desktop/scripts/test-sidebar.mjs`、`desktop/scripts/fixtures/sidebar-flat.html`（搬之前生成的 DOM 快照）
  - 修改 `desktop/src/renderer/index.ts`：`renderSidebar()` 变成薄函数（`renamingActive` 为真时直接返回，否则用模块状态拼出 `SidebarModel`、把现有的处理逻辑包成 `SidebarActions`，调 `sidebar.ts`）；其余用到 `rendererIcon` 的地方改为从 `sidebar.ts` 导入。修改 `desktop/package.json`（`test:sidebar`）
  - 不改：`styles.css`、`i18n.ts`、`chat/` 下的文件、两份 gui 冒烟脚本、任何现有测试
- 接口：
  - 使用：`index.ts` 现有的模块状态和函数（`machines`、`machineSessions`、`machineOnline`、`collapsedMachines`、`views`、`sessionDots`、`activeKey`、`overviewMachineKey`、`reloadingSessions`、`openExisting`、`closeSession`、重载和打开机器概览的现有逻辑）
  - 提供：`renderSidebar(container: HTMLElement, model: SidebarModel, actions: SidebarActions): void`；`rendererIcon(name)`（导出，签名不变）
  - `SidebarModel`（本任务的形状，T6b 在它上面扩）：`machines: { machine, key, online, collapsed, sessions: SessionInfo[] }[]`、`activeKey`、`overviewMachineKey`、`dotOf(machineKey, sessionId): Dot`、`isOpen(viewKey): boolean`、`isReloading(viewKey): boolean`
  - `SidebarActions`（本任务的形状）：`open(machine, session)`、`openOverview(machine)`、`rename(machine, session, name)`、`setRenaming(active: boolean)`、`reload(machine, session)`、`deleteSession(machine, session)`、`toggleMachine(machineKey)`。确认框（重载、删除的 `window.confirm`）仍在 `index.ts` 的回调里，原样不动
  - `sidebar.ts` 不从 `index.ts` 导入任何东西（否则是循环引用）：状态只经 `model` 读，改动只经 `actions` 发出。生成的 DOM、class、属性、事件行为与搬之前逐字节相同
- 场景：无新场景（纯重构）；守住 R8.3（现有功能入口都在）
- 测试（`test-sidebar.mjs`，jsdom，经 `loadIndex()` 驱动 `index.ts`）：
  - `flat_dom_snapshot_unchanged`：固定的一组数据（2 台机器；3 个会话：一个终端、一个状态点是 `waiting` 的对话、一个当前打开的；一台机器折叠）下 `#machine-list` 的 `innerHTML` 与 `fixtures/sidebar-flat.html` 逐字节相同。**先写这个用例并用还没搬的代码生成快照**（`UPDATE_SNAPSHOT=1 npm run test:sidebar`），单独提交；再搬代码，搬完后不带 `UPDATE_SNAPSHOT` 通过
  - `no_rerender_while_renaming`：内联重命名的输入框存在时触发一轮刷新 → 输入框还是同一个节点，已输入的字还在
  - `inline_rename_commits`：双击会话名 → 出现输入框；改成 `登录修复` 按回车 → `rename` 回调收到这个名字一次；按 Esc → 不调用
  - `actions_fire_once`：点会话行 → `open` 一次；点关闭按钮并接受确认 → `deleteSession` 一次；点机器的折叠按钮 → `toggleMachine` 一次
- 完成定义：
  - `cd desktop && npm run typecheck && npm test` 退出码 0
  - 在仓库根执行 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs` 和 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-chat-smoke.mjs`，都以退出码 0 结束、没有 FAIL 行；`git diff --stat $(git merge-base HEAD change/dual-mode) -- .claude/skills/verify/scripts/gui-smoke.mjs .claude/skills/verify/scripts/gui-chat-smoke.mjs` 在本任务前后的输出相同（本任务没有改这两个脚本）
  - 本任务是两个提交：先是快照用例加快照文件（此时 `npm run test:sidebar` 已经通过），再是搬家；第二个提交的 `git show --stat HEAD` 只列出 `index.ts`、`sidebar.ts`、`test-sidebar.mjs`，其中 `index.ts` 净减少不少于 200 行，`git show HEAD -- desktop/scripts/fixtures/` 没有输出（快照没有被改）
  - `grep -n "from './index'" desktop/src/renderer/sidebar.ts` 没有输出
- 依赖：无

### T6b 桌面端：三层侧边栏、标题和通知标题（最小闭环完成）
- 状态：完成
- 文件：
  - 修改 `desktop/src/renderer/sidebar.ts`（T6a 搬好的 `renderSidebar` 改成三层结构；新增 `renderToolbarTitle`）、`desktop/scripts/test-sidebar.mjs`（T6a 的快照用例 `flat_dom_snapshot_unchanged` 和它的快照文件在这里删除：DOM 按 design 7.4 改成三层，由下面的用例接替；T6a 的另外 3 个用例保留并保持通过）；新建 `desktop/src/renderer/menu.ts`（定位在按钮下方的列表，Esc 和点外面关闭）
  - 修改 `desktop/src/renderer/index.ts`：`renderSidebar` 这个薄函数改为拼新的 `SidebarModel`；新增模块状态 `machineTrees`、`machineCaps`、`collapsedProjects`（存 `localStorage` 的 `vibe-remote.collapsed-projects`）；`refreshAllMachines` 每台机器并行多发一个 `listProjects()`，结果经 `nextCapability` 和 `buildTree` 更新状态（design 6.4）；`setActive` 同时展开当前会话所在的项目；`updateStatusBar` 的标题改用 `renderToolbarTitle`；3 处 `notifyDesktop` 的标题改用 `notificationTitle`；`sessionDisplayTitle` 优先取树里的 `name`
  - 修改 `desktop/src/renderer/styles.css`（末尾追加「项目树」一段：`.project-group`、`.project-row`、`.project-tag`、`.worktree-group`、`.worktree-row`、`.worktree-empty`、`.worktree-tag`、`.session-meta`、`.machine-note`、`.row-actions`、菜单；`:root` 里追加 `--tag-bg-s: 62%`、`--tag-bg-l: 90%`、`--tag-fg-s: 48%`、`--tag-fg-l: 30%` 四个变量）、`desktop/src/renderer/i18n.ts`（`sidebar.project.*`、`sidebar.worktree.*`、`sidebar.session.*`、`sidebar.legacy.*`）、`desktop/scripts/chat-test-util.mjs`（`loadIndex()` 的 `__test` 多导出 `machineTrees`、`machineCaps`）、`desktop/package.json`（`test:sidebar`）、`.claude/skills/verify/scripts/gui-smoke.mjs` 和 `gui-chat-smoke.mjs`（只调选择器）
- 接口：
  - 使用：`renderSidebar` 的签名、`SidebarModel`、`SidebarActions`、`rendererIcon`（T6a）；`buildTree`、`projectRollup`、`sessionContext`、`notificationTitle`、`nextCapability`、`projectHue`、`TreeProject`、`TreeWorktree`、`Capability`（T5）；`listProjects`、`removeProject`、`RestError`（T4）
  - 提供：`renderToolbarTitle(container, ctx, fallback)`；`renderSidebar(container, model, actions)` 的签名不变，`SidebarModel` 和 `SidebarActions` 扩成下面的形状
  - `SidebarModel`：T6a 的字段里，每台机器的 `sessions` 换成 `cap: Capability` 和 `tree: TreeProject[]`；另加 `collapsedProjects: Set<string>`。其余字段（`activeKey`、`overviewMachineKey`、`dotOf`、`isOpen`、`isReloading`）不变
  - `SidebarActions`：T6a 的 7 个（`open`、`openOverview`、`rename`、`setRenaming`、`reload`、`deleteSession`、`toggleMachine`）不变，新增 `toggleProject(machineKey, projectId)`、`removeProject(machine, project)`，以及三个可缺省的 `newSession?(machine, project, worktree)`、`newWorktree?(machine, project)`、`deleteWorktree?(machine, project, worktree)`。可缺省的回调没传时，对应的按钮和菜单项不渲染；本任务的 `index.ts` 只传前 9 个，后三个分别由 T11、T9、T14 接上
  - 渲染规则照 design 7.4「侧边栏」的 DOM：`flat` 的项目没有 `.worktree-group`；会话行保留现有的 class 和 `data-session-id`、`data-ui`、`data-dot`；`gone` 的会话第二行显示「目录已不存在」；项目折叠且 `projectRollup` 是 `waiting` 时项目行显示点（d11）
  - 项目行的两个字母标签（design 7.4，decisions #26）：文字是项目名的前两个字符（大写）；颜色只有色相随项目变，`sidebar.ts` 只做 `el.style.setProperty('--tag-hue', String(projectHue(project.id)))`，不在 TS 里写任何颜色；CSS 规则是 `.project-tag { background: hsl(var(--tag-hue) var(--tag-bg-s) var(--tag-bg-l)); color: hsl(var(--tag-hue) var(--tag-fg-s) var(--tag-fg-l)); }`
  - 置灰规则：`cap` 不是 `v4` 时 `project-new-worktree`、`worktree-delete` 是 `disabled`，提示文字是 `sidebar.legacy.needUpgrade`；`cap` 是 `legacy` 时机器行下多一条 `machine-legacy-note`；项目的 worktree 列表里没有主目录（被白名单滤掉）时 `project-new-worktree` 也是 `disabled`；项目下有会话时 `project-remove` 是 `disabled` 并带 `sidebar.project.removeBlocked` 的说明；主目录那一行没有 `worktree-menu`
  - 扁平项目行上的 `project-new-session`（d19）：git 项目把它唯一的 worktree 传给 `newSession`；非 git 项目传一个由项目本身拼成的节点（`path` = 项目 id，`label` = 项目名）；有 `error` 的项目不渲染这个按钮
  - `removeProject` 回调在 `index.ts` 里调 `rest.removeProject(id)`，成功后立刻刷新这台机器；409 `project_has_sessions` 在状态栏显示 `sidebar.project.removeBlocked`
- 场景：R1.1–R1.8、R2.1–R2.5、R2.7（界面一侧）、R5.7、R9.1（说明条和置灰）
- data-testid：`machine-legacy-note`、`project-row`、`project-branch`、`project-error`、`project-dot`、`project-new-session`、`project-new-worktree`、`project-menu`、`project-remove`、`worktree-row`、`worktree-tag-main`、`worktree-tag-external`、`worktree-new-session`、`worktree-menu`、`worktree-delete`、`worktree-empty`、`session-row`、`session-gone`、`title-project`、`title-branch`、`title-session`
- 测试（`test-sidebar.mjs`，jsdom；前 13 个直接调 `renderSidebar`，后 3 个经 `loadIndex()` 驱动 `index.ts`；T6a 的 `no_rerender_while_renaming`、`inline_rename_commits`、`actions_fire_once` 原样保留）：
  - `renders_three_levels`、`flat_project_has_no_worktree_row`、`non_git_has_no_worktree_entries`、`empty_worktree_row`、`gone_session_meta`、`project_error_row_sessions_usable`、`collapsed_project_shows_waiting_dot`、`project_menu_remove`、`project_remove_disabled_with_sessions`、`main_worktree_has_no_menu`、`legacy_note_and_disabled_entries`：断言见测试计划 R1.1、R1.2、R1.3、R2.1、R2.5、R2.7、R1.6、R2.3、R2.4、R5.7、R9.1 各行
  - `project_tag_hue_via_css_var`：`project-row` 里的 `.project-tag` 文字是 `DE`（项目 `devflow`）；它的 `style` 里只有 `--tag-hue` 一个属性，值等于 `projectHue(项目 id)`；没有内联的 `color`、`background`。另外读 `src/renderer/sidebar.ts` 的文本：不含 `hsl(`、`rgb(`，也不含 `#` 开头的 3–8 位十六进制颜色
  - `optional_actions_hide_entries`：不传 `newSession`、`newWorktree`、`deleteWorktree` 时，DOM 里没有 `worktree-new-session`、`project-new-session`、`project-new-worktree`、`worktree-menu`
  - `toolbar_title_parts`：打开 `devflow` / `fix-login` 下的 `登录修复` → `#toolbar-title` 里依次是 `title-project`=`devflow`、`title-branch`=`fix-login`、`title-session`=`登录修复`；非 git 项目没有 `title-branch`；没有打开会话时显示机器名
  - `keeps_tree_when_projects_request_fails`：第一轮 `listProjects` 成功、第二轮抛错 → `machineCaps` 仍是 `v4`，`project-row` 的数量不变
  - `collapsed_projects_persist`：折叠 `devflow` 后 `localStorage` 的 `vibe-remote.collapsed-projects` 含 `<machineKey>|<项目 id>`；重新加载后仍是折叠的；`setActive` 打开其中的会话会把它展开
- 完成定义：
  - `cd desktop && npm run typecheck && npm run test:sidebar && npm run test:i18n-parity && npm run test:chat-activity && npm run test:chat-render-guard` 退出码 0
  - 在仓库根执行 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs` 和 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-chat-smoke.mjs`，都以退出码 0 结束、没有 FAIL 行；`git diff HEAD~1 -- .claude/skills/verify/scripts/` 里只有选择器字符串的改动，`grep -c "^test(" .claude/skills/verify/scripts/gui-chat-smoke.mjs` 仍是 26，`grep -c "check(" .claude/skills/verify/scripts/gui-smoke.mjs` 不小于 14
- 依赖：T4、T5、T6a

### T6c 返工：三层侧边栏行的排版
- 状态：完成
- 来源：主会话核对 T6b 截图（`.devflow-tmp/build-shots/t6b-sidebar.png`）。默认宽度的侧边栏里：会话行的名字被挤没（有的行只看到「终端 · 回合结束」，选中的会话名只剩一个字，有一行「对话」徽标压在名字上）；项目名 `new-api` 被截成「ne…」、worktree `change/general-skills` 被截成「change/gen…」，而右侧还有空间。jsdom 的 `test-sidebar.mjs` 没有布局，看不到这类问题
- 文件：
  - 新建 `.claude/skills/verify/scripts/sidebar-layout.mjs`（可共用的侧边栏布局测量 `sidebarLayout(cdp)`，以及造数据用的 `makeSidebarRepos`、`startSession`）
  - 修改 `.claude/skills/verify/scripts/gui-smoke.mjs`（新增一步「三层侧边栏」：在 `/tmp` 下的临时目录里建一个带 4 个 worktree 的仓库（一个分支名很长、一个没有会话）、两个单 worktree 仓库（其中一个停在很长的分支上）、一个非 git 目录，在其中开 8 个终端会话（两个改成长名字，中英文各一），给两个后台会话各发一个 hook 事件让它们带状态点，然后量；对话用例之后带着对话会话再量一次；`VR_SIDEBAR_SHOT=<文件>` 时存一张侧边栏截图。临时目录随用例结束删除）
  - 修改 `desktop/src/renderer/styles.css`（只在末尾「项目树」一段就地改或追加侧边栏行的布局规则，不动配色）；根因在 DOM 结构时才改 `desktop/src/renderer/sidebar.ts`，并保证 design 7.4 的侧边栏 DOM 不变、T19 的两行会话条目能在这个结构上实现
- 场景：R1.1–R1.4（界面一侧：项目、worktree、会话的名字和状态看得见）、R8.5（默认宽度下不重叠、不无故省略）
- 测试（浏览器层，真实渲染；先写、确认修复前失败）：`gui-smoke.mjs` 新增 3 处 `check(`
  - `sidebar shows the projects, worktrees and sessions under test`：至少 9 个会话行，worktree 行里有 `fix-login` 和长分支名
  - `sidebar rows are readable at the default width (names, badges, state text, dots)`：`sidebarLayout` 的问题列表为空。它对每个可见的项目行、worktree 行、会话行检查：行和行内各部分不超出侧边栏左右边界；同一行里名字、类型图标、类型徽标、状态文字、状态点、分支、标签、操作按钮的矩形两两不相交；会话名的可见宽度大于 0，并且要么完整显示、要么至少有 4 个字宽；名字被省略（`scrollWidth > clientWidth`）时它所在的那一行不能还有超过 2px 的空白；没有设省略号的文字不被裁掉。静止时量一遍，再把鼠标依次移到每个可见的行上各量一遍（行上的操作按钮在悬停时才占位置）
  - `sidebar rows stay readable with a chat session listed`：对话用例建出对话会话之后再量一次，问题列表为空
- 完成定义：
  - 修复前：`TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs` 里新增的布局检查是 FAIL，输出里列出被挤没的名字和重叠的部分（关键输出记进报告）
  - 修复后：同一条命令和 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-chat-smoke.mjs` 都以退出码 0 结束、没有 FAIL 行；`grep -c "check(" .claude/skills/verify/scripts/gui-smoke.mjs` 不小于 17，`grep -c "^test(" .claude/skills/verify/scripts/gui-chat-smoke.mjs` 仍是 26
  - `cd desktop && npm run typecheck && npm run test:sidebar` 退出码 0（`test-sidebar.mjs` 不改）
  - 用真实的 Electron 临时实例截一张三层侧边栏的图（`VR_SIDEBAR_SHOT=…/.devflow-tmp/build-shots/t6c-sidebar.png`），名字、徽标、状态都看得清
- 依赖：T6b

### T7 daemon 和客户端连接层：attach 带 `worktreeName` 新建命名 worktree
- 状态：完成
- 文件：
  - 修改 `vibe-remoted/internal/session/worktree.go`（`ValidateWorktreeName`、`WorktreeDirName`、`WorktreeSpec`、`CreatedWorktree` 和它的 `Undo`、`CreateWorktree` 换成新签名并按 design 6.1 的 10 步重写、`BranchConflict`、`BranchExistsError`、5 个错误变量）；新建 `vibe-remoted/internal/session/testdata/worktree-names.json`（名字规则的共用向量，每条 `{name, ok, reason, local}`，`reason` 取桌面端的 `empty` / `whitespace` / `dotdot` / `leading_dash` / `invalid`；`local:true` 表示桌面端不问 daemon 也必须得到同一个 `reason`）
  - 修改 `vibe-remoted/internal/session/manager.go`（`CreateOptions.WorktreeName`；按仓库取的互斥锁，键是 `Home.Repo`，锁的先后照 6.1；`AddWorktree` 挪到 6.1 第 10 步；会话启动失败时重新取仓库锁，在锁内调 `Undo` 并删记录，再放锁（design 6.1，decisions #34）；现有的 3 处 `RollbackWorktree(meta)` 都换成 `created.Undo()`）、`vibe-remoted/internal/session/chat_manager.go`（`ChatCreateOptions.WorktreeName`，同样的锁和撤销，现有的 3 处 `RollbackWorktree(meta)` 同样换掉）、`vibe-remoted/internal/config/config.go`（`ResolveAllowedNewPath`）、`vibe-remoted/internal/server/ws.go` 和 `ws_chat.go`（把 `frame.WorktreeName` 传下去；`ValidateWorkdir` 改传 `cfg.ResolveAllowedNewPath`；4 个错误映射成 fatal 的 error 帧；带 `handoffFrom` 时忽略 `worktreeName`）
  - 修改 `vibe-remoted/internal/protocol/protocol.go`（`AttachFrame.WorktreeName`，错误码常量 `invalid_worktree_name`、`worktree_branch_exists`、`worktree_path_exists`、`worktree_path_not_allowed`）、`desktop/src/shared/protocol.ts`（`AttachFrame.worktreeName?`）、`desktop/src/renderer/client.ts`（`AttachOptions.worktreeName`，存进 `AttachIntent`，`sendAttach` 原样带上）、`docs/protocol.md`（attach 帧的字段表、error 帧的代码表、版本表第 4 行补 `attach.worktreeName` 和 4 个错误码）
  - 测试：`vibe-remoted/internal/session/worktree_test.go`、`manager_test.go`、`idempotent_test.go`、`shutdown_test.go`（只改它用来卡住创建的回调，decisions #51）、`vibe-remoted/internal/config/config_test.go`、`vibe-remoted/internal/server/worktree_test.go`、`desktop/scripts/test-attach-replay.mjs`。直接调用 `CreateWorktree` 的现有测试（`worktree_test.go` 10 处、`manager_test.go` 1 处）只改调用写法，断言不动。`RollbackWorktree`、`CleanupWorktree` 和它们现有的测试本任务不动（T13 删除）；本任务之后创建路径不再调用 `RollbackWorktree`
- 接口：
  - 使用：`ResolveHome`、`Home.Repo` / `Home.Single`、`ListWorktrees`、`gitAt`（T2）；`ProjectStore.AddWorktree` / `RemoveWorktree`（T3）；`Manager.beginCreate`（现有，同 id 的幂等）
  - 提供：`ValidateWorktreeName(repoDir, name string) error`；`WorktreeDirName(name string) string`；`type WorktreeSpec struct { Source, SessionID, Name string; AllowPath func(string) error }`；`type CreatedWorktree struct { Meta WorktreeMetadata; Workdir string; Home Home; OID string; NewContainer bool }`；`CreateWorktree(spec WorktreeSpec) (CreatedWorktree, error)`；`(c CreatedWorktree) Undo() error`；`BranchConflict(repoDir, name string) (string, error)`；`type BranchExistsError struct { Branch, Conflict string }`（`errors.Is(err, ErrWorktreeBranchExists)` 为真）；`ErrInvalidWorktreeName`、`ErrWorktreeBranchExists`、`ErrWorktreePathExists`、`ErrWorktreePathNotAllowed`、`ErrUnsupportedRepo`；`CreateOptions.WorktreeName`、`ChatCreateOptions.WorktreeName`；`(c *Config) ResolveAllowedNewPath(path string) (string, error)`；TS 的 `AttachOptions.worktreeName?: string`
  - 名字的规则（design 4.1）：本地规则多一条「不含 `@{`」；`git check-ref-format --branch <名字>` 除了退出码为 0，输出还必须与输入逐字相等
  - 创建的做法（design 6.1，decisions #16）：`os.Mkdir` 占目录 → `git update-ref -m 'branch: Created from HEAD' refs/heads/<分支> <OID> ""` 占分支 → `git worktree add --detach <目录> <OID>` → `git -C <目录> symbolic-ref -m 'worktree: attached to refs/heads/<分支>' HEAD refs/heads/<分支>`。不用 `git worktree add -b`，不调用 `git branch`；交给 git 的分支只写成 `refs/heads/<名字>`。两个 `-m` 是 reflog 的说明文字；HEAD 那一条不能写成 `checkout: moving from … to …`，否则新 worktree 里的 `@{-1}` 会指向发起处的提交（design V22，d28）。包内测试钩子：`testAfterCreateChecks func()` 在第 5 步之后、第 7 步之前调用；`testBeforeWorktreeAdd func()` 在第 8 步之后、第 9 步之前调用
  - 第 4 步的分支检查用 `BranchConflict`（design 6.1，decisions #35）：同名分支、名字的某个 `/` 前缀是已有分支、`refs/heads/<名字>/` 下已有分支，三种都返回挡住它的那个分支名；`CreateWorktree` 据此返回 `*BranchExistsError`，error 帧是 `worktree_branch_exists`，`message` 写明与哪个分支冲突。第 8 步 `update-ref` 失败后也用它重查
  - 白名单查两次（design 6.1 第 3、10 步，decisions #33）：建之前对 worktree 根调 `AllowPath`；建好、子目录也建出来之后，对会话最终的工作目录再调一次 `AllowPath`（路径已存在，`ResolveAllowedNewPath` 会解析整条路径上的符号链接），不通过 → 撤销并返回 `ErrWorktreePathNotAllowed`，错误信息含这个路径
  - `Manager` 先在锁外 `ResolveHome(Source)` 拿到锁的键（`Home.Repo`），再在锁内调 `CreateWorktree`（它自己会再解析一次，以锁内的结果为准）。会话启动失败时的撤销回到仓库锁里做：重新取锁 → `Undo` 并删创建记录 → 放锁；这时只持有创建占位，不在 `opMu`、`Manager.mu` 内。design 6.1 第 10 步末尾的 `beginStart` 登记、以及「放锁之后才调 `done()`」由 T13 加：本任务时还没有删除 worktree 的端点，不存在要与之互斥的操作
  - `Undo`（design 6.1「撤销」）只清本次占到的东西，第 7–10 步的失败也走同一个包内函数（按已经占到了什么决定做哪几步，包含本次新建的容器目录）：读列表，这个目录的项是本次的（检出的分支就是本次的分支，或 detached 且 HEAD 等于 OID）才 `git worktree remove --force`，不是本次的就不动它、也不删目录，并在返回的错误里写明；目录用不递归的 `os.Remove`（非空就保留并写进错误），不用 `os.RemoveAll`；`git update-ref -d refs/heads/<分支> <OID>`，分支已不在视为已撤销，指向别的提交则保留并在返回的错误里写明；容器目录是本次建的且为空才删。不匹配 git 的报错文字。可以重复调用
  - `Home.Single` 为真（子模块、`--separate-git-dir`）而带了名字 → `ErrUnsupportedRepo`，error 帧是 `create_failed`（fatal），`message` 写明原因；不带名字的旧路径照旧可用，这时返回的 `CreatedWorktree.Home` 是 `{Project: 新 worktree 的根, Path: 新 worktree 的根, Repo: 同一个 git 目录, Git: true, Single: true}`（design 4.9，decisions #36）。从本任务起，worktree 模式会话的归属直接取 `CreatedWorktree.Home`（`project` = `Home.Project`，`home` = `Home.Path`），取代 T2 里临时用的 `ResolveHome(meta.SourceRepo)`，两者结果相同
  - `Name` 为空时保持旧行为：分支 `vibe/<会话id>`，目录 `<所在 worktree 根的父目录>/<根目录名>-worktrees/<会话id>`；两条路径都先过 `AllowPath` 再建（6.1 第 3 步）。因此不带名字的旧路径在目录不被允许时，error 帧的代码从 `create_failed` 变成 `worktree_path_not_allowed`（仍是 fatal，旧桌面端照样显示 `message` 并停止重连）；现有的 `TestManagerCreateWorktreeRollsBackWhenWorkdirRejected` 不改、照常通过（它断言报错、被检查的路径在容器目录下、没有残留；它分不出「只在建之前查」和「建之后也查」，后者由 `TestCreateWorktreeMappedWorkdirEscapesViaSymlink` 守着）
- 场景：R3.1、R3.2、R3.3、R3.4、R3.5、R3.6、R3.7、R3.8、R3.10（daemon 一侧）、R9.2（缺省命名）
- 测试：
  - `TestValidateWorktreeName`：逐条读 `testdata/worktree-names.json`；向量至少含 `""`、`"a b"`、制表符、`"a..b"`、`"-x"`、`"-"`、`"a~b"`、`"a.lock"`、`"HEAD"`、`"@{-1}"`、`"@{-2}"`、`"@{u}"`、`"a@{b"`（都不通过）和 `"fix-login"`、`"change/foo"`、`"功能/登录"`、`"@"`、`"refs/heads/x"`（都通过）
  - `TestValidateWorktreeNameRejectsExpansion`：仓库先后检出过 `prev`（上面有 1 个独有提交）和 `main`，所以 `@{-1}` 指 `prev` → `ValidateWorktreeName(repo, "@{-1}")` 返回 `ErrInvalidWorktreeName`，git 包装脚本的调用记录为 0（本地规则就拦住了）；另用包内函数单独测第 2 条规则：跳过本地规则直接做 git 那一步，`@{-1}` 仍被拒（输出 `prev` 与输入不相等）。之后用 `WorktreeName:"@{-1}"` 走一遍 `Manager.Create` → 报 `ErrInvalidWorktreeName`，`prev` 仍指向原来的提交
  - `TestGitNeverGetsShortBranchName`：`PATH` 前面的 git 包装脚本把每次调用的参数记进文件后转调真实 git。走 3 条路径：`fix-login` 新建成功；`.git/worktrees` 只读导致新建失败并撤销；会话启动失败后撤销。记录里没有以 `branch` 为子命令的调用，没有 `-b`、`-B` 参数；出现 `fix-login` 的参数只有这几种：`refs/heads/fix-login`、`refs/heads/fix-login/`（`for-each-ref` 的前缀模式）、目录路径（末段恰好同名）、`check-ref-format --branch` 后面的 `fix-login`、紧跟在 `-m` 后面的说明文字 `worktree: attached to refs/heads/fix-login`
  - `TestCreateRaceWithExternalBranch`、`TestCreateRaceWithExternalDir`：在 `testAfterCreateChecks` 里用真实的 git 建分支 `fix-login`（指向另一个提交 X），或建目录并在里面放一个文件 → 返回 `ErrWorktreeBranchExists` / `ErrWorktreePathExists`；分支仍指向 X，目录和文件原样；另一样本次占到的东西已撤销（没有新目录或新分支；容器目录是本次新建的时，它也没有留下）
  - `TestUndoOnlyRemovesOwnArtifacts`：(a) 新建成功后在新 worktree 里提交一次再 `Undo` → 目录没了、列表里没有它，分支 `fix-login` 还在并指向新提交，返回的错误提到分支没有删；(b) 新建成功后直接 `Undo` → 目录、分支、本次新建的容器目录都没了，再 `Undo` 一次返回 nil；(c) 容器目录本来就在、里面有别的 worktree → `Undo` 后容器和别的 worktree 都在；(d) 先把目录 `rm -rf` 再 `Undo` → 返回 nil，列表里没有残留的登记；(e) 在 `testBeforeWorktreeAdd` 里（本次已占到空目录和分支）用真实的 git 执行 `git worktree add <同一目录> theirs` 并在里面写一个文件 `precious.txt` → `CreateWorktree` 返回错误（`create_failed`）；`precious.txt` 还在，`git worktree list` 里这个目录仍是 `theirs` 的 worktree，本次的分支 `fix-login` 不存在，返回的错误写明目录没有删；git 包装脚本的记录里没有对这个目录的 `worktree remove`
  - `TestBranchConflict`：仓库有分支 `fix`、`change/foo`，并 `git pack-refs --all` 过 → `BranchConflict(repo, "fix")` 是 `fix`；`"fix/login"`、`"fix/a/b"` 是 `fix`；`"change"` 是 `change/foo`；`"ok/name"`、`"fixed"`、`"change-foo"` 是空串；git 包装脚本的记录里只有 `show-ref`、`for-each-ref` 两种子命令（都是只读的）
  - `TestCreateNamedWorktreeBranchExists/dir_file_conflict`：断言见测试计划 R3.4；另外仓库旁边没有新建的容器目录
  - `TestCreateNamedWorktreeReflog`：新建 `fix-login` 后，`git reflog show --format=%gs refs/heads/fix-login` 的第一行是 `branch: Created from HEAD`；新 worktree 里 `git reflog show --format=%gs HEAD` 的第一行是 `worktree: attached to refs/heads/fix-login`；新 worktree 里 `git rev-parse --verify @{-1}` 失败（没有「上一个检出的分支」，与 `git worktree add -b` 建出来的相同）
  - `TestCreateWorktreeMappedWorkdirEscapesViaSymlink`：仓库的 HEAD 里 `linkdir` 是指向 `allowed_roots` 之外一个临时目录的符号链接；工作区里把它换成真目录（未提交）。从 `<仓库>/linkdir` 发起 worktree 模式（带名字、不带名字各一例；`AllowPath` 用真实 `config.Config` 的 `ResolveAllowedNewPath`）→ 返回 `ErrWorktreePathNotAllowed`，错误信息含 `<新 worktree>/linkdir`；新 worktree 的目录、分支、`ProjectStore` 记录都不存在；链接指向的那个目录里没有多出任何东西。对照：`linkdir` 指向 `allowed_roots` 之内的目录 → 成功，`workdir` 是 `<新 worktree>/linkdir`
  - `TestCreateNamedWorktreeUnsupportedRepo`：发起处是子模块的工作目录、`--separate-git-dir` 的工作目录 → `ErrUnsupportedRepo`；上层仓库的 `.git/modules/` 旁边和工作目录旁边都没有新目录，没有新分支。同样两处不带名字 → 成功，分支是 `vibe/<会话id>`，目录在 `<工作目录的父目录>/<工作目录名>-worktrees/` 下，返回的 `Home.Project` 和 `Home.Path` 都是新 worktree 的根、`Home.Single` 为真
  - `TestWorktreeNameNeverReachesShell`：`PATH` 前面放一个把参数逐个记进文件的 git 包装脚本；名字 `-x` → 记录文件是空的（git 一次都没被调用）；名字 `$(touch${IFS}PWNED)` → 仓库和临时目录里都没有文件 `PWNED`，记录里有一个参数恰好是 `refs/heads/$(touch${IFS}PWNED)`
  - `TestWorktreeDirName`：`change/foo` → `change-foo`；`a/b/c` → `a-b-c`；`fix-login` 不变
  - `TestCreateNamedWorktree`、子测试 `slash`、`TestCreateNamedWorktreeBranchExists`、`TestCreateNamedWorktreePathExists`（含 `empty_dir`）、`TestCreateNamedWorktreeExcludesUncommitted`、`TestCreateNamedWorktreePathNotAllowed`、`TestCreateNamedWorktreeGitFailureLeavesNothing`：断言见测试计划 R3.1、R3.2、R3.4、R3.5、R3.6、R3.10、R3.8 各行
  - `TestCreateNamedWorktreeFromLinkedWorktree`：发起处是链接 worktree `fix-login` → 新 worktree 基于 `fix-login` 的 `HEAD`，目录仍在 `<主目录的父目录>/<主目录名>-worktrees/` 下
  - `TestCreateNamedWorktreeSubdir`：`Source` 是 `<仓库>/src/app` → 返回的 `workdir` 是 `<新 worktree>/src/app` 且目录存在
  - `TestResolveAllowedNewPath`：白名单内不存在的路径 → 通过并返回规范路径；白名单外 → 错误；白名单内的符号链接祖先指向白名单外 → 错误；已存在的路径与 `ResolveAllowedWorkdir` 结果相同
  - `TestConcurrentCreateSameNameOneWins`：两个不同的会话 id 并发 `Create`、`WorktreeName` 都是 `fix-login`，跑 20 轮 → 每轮恰好一个成功，另一个 `errors.Is(err, ErrWorktreeBranchExists)`；成功那个的目录和分支完好
  - `TestNamedWorktreeReplaySameID`：同一个 `ID` 加 `WorktreeName:"fix-login"` 先后 `Create` 2 次、再并发 2 次 → 返回同一个会话，`git worktree list` 里一个 `fix-login`，没有 `ErrWorktreeBranchExists`
  - `TestNamedWorktreeRolledBackWhenSessionStartFails`：让会话启动失败（做法同现有的 `TestManagerCreateWorktreeRollsBackWhenRunnerStartFails`）且 `WorktreeName` 是 `fix-login` → `Create` 报错；分支和目录都不存在；`Managed(…)` 为假。终端会话、对话会话各一例。子测试 `concurrent_create`：用测试钩子让撤销停在「已取到仓库锁、还没删容器目录」处，此时并发新建同一仓库的另一个名字 `other`（它在等锁）→ 放行后 `fix-login` 什么都不留，`other` 建成，它的目录、分支和容器目录都在；用 `-race` 跑 20 轮结果相同
  - `TestNamedWorktreeWithMemoryStore`：用 `NewMemoryProjectStore()` 新建 `fix-login` → 成功，`Managed(…)` 为真；换一个新的内存清单（相当于重启）→ `Managed(…)` 为假
  - `TestWSAttachWorktreeName`、`TestWSAttachWorktreeCreateFailed`、`TestAttachWorktreeWithoutNameKeepsLegacyNaming`（server）：断言见测试计划 R3.1、R3.8、R9.2 各行
  - `TestWSWorktreeErrorsAreFatal`（server）：名字不合法（`a b`、`@{-1}` 各一例）、分支已存在、目录已存在、目录不在白名单内 4 种 → error 帧的 `code` 分别是 4 个新代码，`fatal` 都是 true，`worktree_path_not_allowed` 的 `message` 含完整路径；不带 `worktreeName` 而目录不在白名单内 → 同样是 `worktree_path_not_allowed`、`fatal:true`；已有分支 `fix` 时 `worktreeName` 是 `fix/login` → `worktree_branch_exists`、`fatal:true`，`message` 含 `fix`；子测试 `mapped_workdir_escape`：从提交里是符号链接（指向白名单外）的子目录发起 → `worktree_path_not_allowed`、`fatal:true`，仓库旁边没有留下 worktree 和分支
  - `TestHandoffIgnoresWorktreeName`（server）：attach 同时带 `handoffFrom` 和 `worktreeName` → 交接成功，没有新 worktree
  - `test-attach-replay.mjs › replay_carries_worktree_name`：`attach(…, { worktreeName: 'fix-login' })` 后在 `ready` 前断线 → 自动重连和 `replayIntent()` 发出的 attach 都带同一个 `newSessionId` 和 `worktreeName`；`ready` 之后的重连不再带 `worktreeName`（此时是接入已有会话）
- 完成定义：
  - `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/session ./internal/config ./internal/server -run 'TestValidateWorktreeName|TestWorktreeNameNeverReachesShell|TestGitNeverGetsShortBranchName|TestWorktreeDirName|TestCreateNamedWorktree|TestCreateWorktreeMappedWorkdir|TestBranchConflict|TestCreateRace|TestUndo|TestResolveAllowedNewPath|TestConcurrentCreateSameName|TestNamedWorktree|TestWSAttachWorktree|TestAttachWorktreeWithoutName|TestWSWorktreeErrorsAreFatal|TestHandoffIgnoresWorktreeName|TestTerminalFramesUnchangedV3|TestWorktree'` 输出三行 `ok`
  - `cd desktop && npm run typecheck && npm run test:attach-replay` 退出码 0
  - `grep -n '"-b"\|"-B"\|RemoveAll' vibe-remoted/internal/session/worktree.go` 没有输出（撤销不递归删目录）；`grep -n 'RollbackWorktree(' vibe-remoted/internal/session/manager.go vibe-remoted/internal/session/chat_manager.go` 没有输出
  - 按 `/protocol-sync` 核对：`attach.worktreeName` 和 4 个错误码在三处一致
- 依赖：T2、T3、T4

### T8 协议 4：新建前的只读预检 `GET /api/v1/worktrees/plan`
- 状态：完成
- 文件：修改 `vibe-remoted/internal/session/projects.go`（`PlanWorktree`）、`vibe-remoted/internal/session/worktree.go`（把 `CreateWorktree` 的第 1–5 步提成包内函数 `precheckWorktree`，预检和新建共用，decisions #56）、`vibe-remoted/internal/server/projects.go`（处理函数）、`vibe-remoted/internal/server/server.go`（路由）、`vibe-remoted/internal/protocol/protocol.go`（`WorktreePlan`，含可缺省的 `conflict`；`WorktreeBase`）、`desktop/src/shared/protocol.ts`（`WorktreePlan`）、`desktop/src/renderer/rest.ts`（`planWorktree`）、`docs/protocol.md`（端点说明，版本表第 4 行补这个端点）；测试 `vibe-remoted/internal/session/projects_test.go`、`vibe-remoted/internal/server/projects_test.go`、`desktop/scripts/test-rest-projects.mjs`
- 接口：
  - 使用：`ResolveHome`、`Home.Single`、`ListWorktrees`、`gitAtTimeout`（T2）；`ValidateWorktreeName`、`WorktreeDirName`、`BranchConflict`、5 个错误变量、`cfg.ResolveAllowedNewPath`（T7）；`cfg.ResolveAllowedWorkdir`（现有）
  - 提供：`(m *Manager) PlanWorktree(workdir, name string, allowPath func(string) error) (protocol.WorktreePlan, error)`；TS `planWorktree(workdir: string, name: string): Promise<WorktreePlan>`
  - 响应和错误照 design 4.4：检查的顺序和结果与 `CreateWorktree` 的第 1–5 步相同，全部是只读的（`BranchConflict` 里的 `show-ref` 和 `for-each-ref`、`os.Lstat`），不创建任何东西；`worktree_branch_exists` 时响应多一个 `conflict`（挡住这个名字的已有分支：同名时等于 `branch`，「目录/文件」冲突时是另一个分支，如 `fix`、`change/foo`）；`name` 为空时仍返回 `project`、`projectName`、`base`，`ok:false`、`error:"invalid_worktree_name"`；`Home.Single` 为真 → `ok:false`、`error:"unsupported_repo"`，有 `project`、`base`，没有 `branch`、`path`；`ResolveHome` 返回错误（git 失败或超时）→ `PlanWorktree` 返回错误，HTTP 500 `git_failed`；`workdir` 不在白名单内 → HTTP 403，缺 `workdir` → 400
- 场景：R3.3、R3.4、R3.5、R3.6、R3.10（对话框的即时校验）
- 测试：
  - `TestPlanWorktree`（server，子测试）：`ok` → `ok:true`、`branch:"fix-login"`、`path` 以 `/devflow-worktrees/fix-login` 结尾、`projectName:"devflow"`；`slash` → `branch:"change/foo"`、`path` 以 `/change-foo` 结尾；`invalid_name`（空、`a b`、`@{-1}` 各一例）、`branch_exists`（`conflict` 等于 `branch`）、`branch_conflict`（已有 `fix` 时 `name=fix/login` → `error:"worktree_branch_exists"`、`conflict:"fix"`；已有 `change/foo` 时 `name=change` → `conflict:"change/foo"`）、`path_exists`、`path_not_allowed`、`not_git`、`unsupported_repo`（子模块的工作目录）→ `ok:false` 和对应的 `error`，`not_git` 时没有 `project` 和 `base`，`unsupported_repo` 时有 `base`、没有 `path`
  - `TestPlanWorktreeBase`：断言见测试计划 R3.6
  - `TestPlanWorktreeCreatesNothing`：上面每个子测试之后，`git worktree list` 的行数、`git branch --list` 的输出、`<仓库>-worktrees` 目录是否存在都和调用前相同
  - `TestPlanMatchesCreate`（session）：对同一组输入（合法、分支已存在、已有 `fix` 时的 `fix/login`、已有 `change/foo` 时的 `change`、目录已存在、不在白名单内），`PlanWorktree` 的 `error` 与随后 `CreateWorktree` 返回的错误一一对应；`ok:true` 时 `path`、`branch` 与实际建出来的相同
  - `TestPlanWorktreeHTTPErrors`：`workdir` 在白名单外 → 403；缺 `workdir` → 400；git 超时（`gitTimeout` 调成 50 ms 加睡眠的假 git）→ 500 `git_failed`，不是 `not_git`；`TestNewEndpointsRequireToken` 加上这个端点 → 401
  - `test-rest-projects.mjs › plan_encodes_query`：`planWorktree('/r/a b', 'change/foo')` 请求的 URL 里两个参数都经过 URL 编码；HTTP 403 → 抛 `RestError`，`status` 是 403
- 完成定义：
  - `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/session ./internal/server -run 'TestPlan|TestNewEndpointsRequireToken'` 输出两行 `ok`
  - `cd desktop && npm run typecheck && npm run test:rest-projects` 退出码 0
  - 按 `/protocol-sync` 核对：`WorktreePlan` 的字段（含可缺省的 `conflict`）在三处一致
- 依赖：T7

### T9 桌面端：新建 worktree 对话框，目录选择器的 Worktree 模式加名字
- 状态：完成
- 文件：
  - 新建 `desktop/src/renderer/worktree-name.ts`、`desktop/src/renderer/session-form.ts`、`desktop/src/renderer/worktree-dialogs.ts`（本任务只有 `openNewWorktreeDialog`）；新建测试 `desktop/scripts/test-worktree-name.mjs`、`test-session-form.mjs`、`test-worktree-dialogs.mjs`、`test-dialog-layout.mjs`
  - 修改 `desktop/src/renderer/dirpicker.ts`（界面卡片和启动选项改用 `session-form.ts` 的两个段，行为不变；Worktree 模式且 `info.proto >= 4` 时在模式卡片下方加名字段，此时不显示 `picker.modeNote`；`PickedSession` 加可缺省的 `worktreeName`、`worktreePath`）、`desktop/src/renderer/index.ts`（给 `SidebarActions` 传 `newWorktree`；新建会话时把 `picked.worktreeName` 放进 `attach` 的 `AttachOptions`；`client.onError` 收到 4 个新错误码时状态栏用 `worktreeErrorText`）、`desktop/src/renderer/styles.css`（追加「名字段」的规则）、`desktop/src/renderer/i18n.ts`（`wt.new.*`、`wt.name.*`、`wt.error.*`）、`desktop/package.json`（4 个 `test:*`）、`.claude/skills/verify/scripts/gui-smoke.mjs` 和 `gui-chat-smoke.mjs`（目录选择器的选择器有变时同步）
- 接口：
  - 使用：`planWorktree`、`WorktreePlan`、`RestError`（T8、T4）；`AttachOptions.worktreeName`（T7）；`TreeProject`、`SidebarActions.newWorktree`（T5、T6b）；`chatAvailability`、`activateModal`、`openDirPicker`（现有）
  - 提供（`worktree-name.ts`）：`validateWorktreeName(name)`、`worktreeDirName(name)`、`worktreeErrorText(code, ctx)`，签名见 design 4.10。`validateWorktreeName` 的本地规则与 daemon 的第 1 条相同，含 `@{` 的返回 `invalid`。规则按固定顺序判断、返回第一个不满足的原因（T7 定的顺序，decisions #53，与 `vibe-remoted/internal/session/worktree.go` 的 `worktreeNameProblem` 相同）：空 → `empty`；含空白（空格、制表符、换行、全角空格）→ `whitespace`；含 `..` → `dotdot`；以 `-` 开头 → `leading_dash`；含 `@{` 或其它控制字符 → `invalid`。`worktreeErrorText` 的对应关系：`invalid_worktree_name` → `wt.name.invalid`；`worktree_branch_exists` 且 `ctx.conflict` 有值、不等于 `ctx.branch` → `wt.error.branch_conflict`（「目录/文件」冲突，decisions #35）；`worktree_branch_exists`、`worktree_path_exists`、`worktree_path_not_allowed`、`unsupported_repo`、`not_git` → 同名的 `wt.error.*`；其他代码 → `null`。名字段显示 plan 的拒绝原因时 `ctx` 是 `{ branch: 输入的名字, path: plan.path, conflict: plan.conflict }`；`index.ts` 处理 attach 的 error 帧时 `ctx` 取自对话框的返回值：`branch` = `worktreeName`，`path` = `worktreePath`（error 帧没有 `conflict`，这时显示「分支 … 已存在」；只有确认之后才出现的竞态会走到这里）
  - 提供（`session-form.ts`，三个段都返回 `{ el: HTMLElement, … }`，由调用方放进 `.modal-body`）：
    - `createUiSection(opts: { onChange(): void }): { el; value(): SessionUI; setAvailability(a: ChatAvailability): void }`：终端和对话两张卡片及置灰原因，保留现有的 `picker-ui-terminal`、`picker-ui-chat`、`picker-ui-chat-reason`
    - `createFlagsSection(opts: { existingSessions: number }): { el; setFlags(flags: ClaudeFlagInfo[]): void; value(): string[]; setExistingSessions(n: number): void }`：`existingSessions` 在本任务里只存下来、不影响显示，T15 用它显示 `-c` 说明
    - `createNameSection(opts: { plan(name: string): Promise<WorktreePlan>; onChange(): void }): { el; value(): string; ready(): boolean; confirm(): Promise<WorktreePlan | null> }`：输入停顿 250 ms 后调 `plan`，以最后一次请求的结果为准；`ready()` = 本地校验通过且最近一次 plan 是 `ok`；`confirm()` 立刻再调一次 `plan`，不通过时把原因显示在名字下方并返回 `null`
  - 提供（`worktree-dialogs.ts`）：`openNewWorktreeDialog(machine, project: TreeProject): Promise<(PickedSession & { worktreeName: string; worktreePath: string }) | null>`：发起处是项目的主目录行；标题和副标题用 `wt.new.title` / `wt.new.subtitle`；确认按钮的文字是 `wt.new.confirm`；`confirm()` 返回 `null` 时对话框保持打开。对话框一打开就用空名字调一次 `plan` 取 `base`；返回 `unsupported_repo` 或 `not_git` 时在 `wt-name-error` 显示对应文案，`wt-name-input` 和 `dialog-confirm` 都是 `disabled`（design 7.4）
- 场景：R3.1–R3.6、R3.9、R3.10（界面一侧）、R9.1（协议 3 时没有名字段）、R8.5（对话框结构）
- data-testid：`wt-name-input`、`wt-name-error`、`wt-base-info`、`wt-target-path`、`dialog-confirm`、`dialog-cancel`
- 测试：
  - `test-worktree-name.mjs`：`shared_vectors` 读 `../vibe-remoted/internal/session/testdata/worktree-names.json`，`local:true` 的每一条（含 `@{-1}`、`@{-2}`、`a@{b` → `invalid`）`validateWorktreeName` 返回同一个 `reason`；`ok:true` 的每一条返回 `null`；`ok:false` 而 `local` 不为真的（如 `a~b`，要靠 git 判断）不要求桌面端拦住；`dir_name` 见测试计划 R3.2；`error_text`：`worktreeErrorText('worktree_branch_exists', {branch:'fix-login'})` 和带 `conflict:'fix-login'` 时都是「分支 fix-login 已存在」，`worktreeErrorText('worktree_branch_exists', {branch:'fix/login', conflict:'fix'})` 是 `wt.error.branch_conflict` 的文字（含 `fix/login` 和 `fix`），`worktreeErrorText('invalid_worktree_name', {})` 是「git 不接受这个分支名」，`worktreeErrorText('unsupported_repo', {})` 是 `wt.error.unsupported_repo` 的文字，`create_failed` 和不认识的代码返回 `null`
  - `test-session-form.mjs`：`invalid_name_disables_confirm`、`base_info_text`、`picker_worktree_mode_name_segment`、`picker_proto3_has_no_name_segment`、`last_plan_wins`：断言见测试计划 R3.3、R3.6、R3.9、R9.1 和「容易出问题的情况」各行；`detached_base_text`：`base.detached` 为真 → 文字是 `wt.new.baseDetached`；`picker_normal_mode_unchanged`：普通模式确认后返回 `{workdir, flags, mode:"normal", ui}`，没有 `worktreeName`
  - `test-worktree-dialogs.mjs`：`new_worktree_confirm_resolves`、`plan_rejection_keeps_dialog_open`（`worktree_branch_exists`、带 `conflict:"fix"` 的 `worktree_branch_exists`、`worktree_path_exists`、`worktree_path_not_allowed` 四个分支）：断言见测试计划 R3.1、R3.4、R3.10；`new_worktree_cancel`：点 `dialog-cancel` 或按 Esc → 返回 `null`，没有发出 attach；`new_worktree_unsupported_repo`：打开时 plan 返回 `ok:false, error:"unsupported_repo"` → `wt-name-error` 是对应文案，输入框和 `dialog-confirm` 都是 `disabled`，只能取消
  - `test-dialog-layout.mjs`：`worktree-dialogs.ts` 和 `dirpicker.ts` 里每个对话框只往 `.modal` 里放标题、`.modal-body`、`.modal-footer`；现有的 `test-picker-layout.mjs` 不改、照常通过
- 完成定义：
  - `cd desktop && npm run typecheck && npm run test:worktree-name && npm run test:session-form && npm run test:worktree-dialogs && npm run test:dialog-layout && npm run test:picker-layout && npm run test:i18n-parity` 退出码 0
  - 在仓库根执行 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs`，以退出码 0 结束、没有 FAIL 行（其中包含 `picker-layout.mjs` 对新建会话对话框在 500/700/803 高度下的测量）
- 依赖：T6b、T7、T8

### T10 daemon：对话界面的信任规则认「主目录已被信任的 worktree 根」
- 状态：完成
- 文件：新建 `vibe-remoted/internal/session/trust.go`、`vibe-remoted/internal/session/trust_test.go`；修改 `vibe-remoted/internal/server/ws_chat.go`（`wsCreateChat` 里的 `chat.WorkdirTrusted(workdir)` 换成 `session.ChatTrust(workdir)`）、`vibe-remoted/internal/server/server.go`（`handleFS` 的 `chatTrust` 同样换）、`docs/protocol.md`（`/api/v1/fs` 的 `chatTrust` 说明改成 design 7.3 的规则，版本表第 4 行补「`/api/v1/fs.chatTrust` 的 worktree 规则」）；测试 `vibe-remoted/internal/server/ws_chat_test.go`、`fs_test.go`。`protocol.go`、`protocol.ts`、`rest.ts` 里 `chatTrust` 的取值不变，核对后类型和常量不需要改；三处的版本说明注释（`protocol.go`、`protocol.ts` 的 v4 一行，`rest.ts` 里 `chatTrust` 的字段注释）跟着版本表补一句（decisions #59）
- 接口：
  - 使用：`chat.WorkdirTrusted(dir)`、`chat.TrustState`（现有，`vibe-remoted/internal/chat/trust.go`，不改）；`ListWorktrees`（T2）
  - 提供：`ChatTrust(dir string) chat.TrustState`，5 步规则照 design 7.3；`dir` 是规范路径。第 2 步多一个拒绝条件：列表第一项认不出是主目录（没标 `bare`、它的路径下也没有 `.git`：子模块、`--separate-git-dir`）→ `untrusted`
  - worktree 模式新建对话会话时查的仍是所选的源目录（现有行为不变）
- 场景：R4.3、R4.4、R4.6
- 测试：
  - `TestChatTrust`（子测试，`CLAUDE_CONFIG_DIR` 指向临时目录里的 `.claude.json`）：
    - `self_trusted`：目录自己有 `hasTrustDialogAccepted:true` → `trusted`
    - `worktree_of_trusted_main`：只有主目录被信任 → 它的 worktree 根（含隐藏目录下的 `.devflow-tmp/worktrees/general-skills`）→ `trusted`
    - `worktree_itself_trusted`：主目录没有记录、worktree 路径自己有 → `trusted`
    - `neither_trusted` → `untrusted`
    - `main_false`：主目录的记录是 `hasTrustDialogAccepted:false` → worktree 是 `untrusted`
    - `self_false_main_trusted`：worktree 自己的记录是 `false`、主目录被信任 → `trusted`（7.3 第 1 步只在 `trusted` 或 `unknown` 时直接返回）
    - `subdir_of_worktree`：主目录被信任，查 `<worktree>/src` → `untrusted`
    - `subdir_of_main`：主目录被信任，查 `<主目录>/src` → `untrusted`
    - `main_not_via_worktree`：只有某个链接 worktree 被信任，查主目录 → `untrusted`
    - `sibling_worktree_trusted`：只有另一个 worktree 被信任 → `untrusted`
    - `parent_of_main_trusted`：只有主目录的父目录被信任 → `untrusted`
    - `forged_gitfile`：一个目录里放 `.git` 文件，内容指向受信任仓库的 `.git/worktrees/x` → `untrusted`
    - `bare_repo`：裸仓库的 worktree，裸仓库目录被信任 → `untrusted`
    - `submodule`、`separate_git_dir`：子模块（或 `--separate-git-dir` 仓库）的链接 worktree，子模块的工作目录和它的 git 目录都被信任 → `untrusted`；这个 worktree 自己被信任 → `trusted`
    - `prunable`：列表里标了 `prunable` 的路径 → `untrusted`
    - `config_missing`：没有 `.claude.json` → `unknown`，而且没有调用 git（`PATH` 里的记数包装脚本记录为 0）
    - `non_git_untrusted`：不在 git 仓库里、没有记录 → `untrusted`
  - `TestFSChatTrustWorktree`（server）：`GET /api/v1/fs?path=<worktree>` 的 `chatTrust` 是 `trusted`；`path=<worktree>/src` 是 `untrusted`
  - `TestWSCreateChatInWorktreeOfTrustedMain`（server，假 claude）：在该 worktree 新建对话会话 → 收到 `ui:"chat"` 的 `ready`
  - `TestWSCreateChatWorktreeUntrusted`（server）：主目录和 worktree 都没有记录 → error 帧 `code:"chat_unsupported"`、`fatal:true`、`message` 含 `workdir_untrusted`；现有的 `TestCreateChatUntrustedWorkdir` 不改、照常通过
- 完成定义：
  - `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/session ./internal/server ./internal/chat -run 'TestChatTrust|TestFSChatTrust|TestWSCreateChatInWorktree|TestWSCreateChatWorktreeUntrusted|TestCreateChatUntrustedWorkdir|TestWorkdirTrusted|TestNoCredentialAccess'` 输出三行 `ok`
  - `grep -rn "chat.WorkdirTrusted" vibe-remoted/internal/server` 没有输出（两处使用点都换成了 `session.ChatTrust`）
- 依赖：T2

### T11 桌面端：在已有 worktree 里新建会话
- 状态：完成
- 文件：修改 `.claude/skills/verify/scripts/sidebar-layout.mjs`（悬停时行高不变的检查，decisions #61）、`desktop/src/renderer/worktree-dialogs.ts`（加 `openWorktreeSessionDialog`）、`desktop/src/renderer/chat/availability.ts`（`chatAvailability` 加第 4 个可缺省参数 `opts?: { mainPath?: string }`）、`desktop/src/renderer/index.ts`（给 `SidebarActions` 传 `newSession`：打开对话框，确认后走现有的新建会话流程）、`desktop/src/renderer/styles.css`（追加对话框副标题里路径一行的规则）、`desktop/src/renderer/i18n.ts`（`wt.session.title` / `subtitle` / `confirm`、`picker.ui.chat.reason.worktree_untrusted`、`label.dir`、`label.branch`）；测试 `desktop/scripts/test-worktree-dialogs.mjs`、`test-chat-availability.mjs`
- 接口：
  - 使用：`createUiSection`、`createFlagsSection`（T9）；`rest.info()`、`rest.listDir(path)` 的 `chatTrust`（现有；规则由 T10 放宽）；`TreeProject`、`TreeWorktree`、`Capability`、`SidebarActions.newSession`（T5、T6b）
  - 提供：`openWorktreeSessionDialog(machine, project: TreeProject, worktree: TreeWorktree, opts?: { sessionCountAt?(workdir: string): number }): Promise<PickedSession | null>`（`opts` 本任务只留出参数，T15 才用）：标题 `wt.session.title`（带 worktree 的 `label`），副标题 `wt.session.subtitle`（项目名和完整路径）；只有界面段和启动选项段；确认后返回 `{ workdir: worktree.path, flags, mode: 'normal', ui }`
  - 提供：`chatAvailability(info?, error?, trust?, opts?)`：`trust` 是 `untrusted` 且传了 `opts.mainPath` 时，原因用 `picker.ui.chat.reason.worktree_untrusted`（带主目录路径），其余情况与现在相同
  - `opts.mainPath` 只在两个条件同时成立时传：这台机器的能力状态是 `v4`，且目标是某个 git 项目的非主目录 worktree；值是该项目主目录行的 `path`（design 7.3 末段）
- 场景：R4.1、R4.2、R4.4（界面一侧）、R4.5、R8.5（对话框结构）
- data-testid：`session-dialog-path`、`dialog-confirm`、`dialog-cancel`（界面段沿用 `picker-ui-terminal`、`picker-ui-chat`、`picker-ui-chat-reason`）
- 测试：
  - `test-worktree-dialogs.mjs › worktree_session_dialog_shape`：断言见测试计划 R4.1；另外 `rest.listDir` 被调用一次，参数是 worktree 的路径
  - `worktree_session_hidden_dir`：`path` 是 `/Users/mac/github/devflow/.devflow-tmp/worktrees/general-skills` → 确认后 `workdir` 原样是这个路径
  - `worktree_session_chat_disabled_reason`：`chatTrust` 是 `untrusted`、能力状态 `v4`、非主目录 → `picker-ui-chat` 是 `disabled`，`picker-ui-chat-reason` 的文字含主目录路径 `/Users/mac/github/devflow`；`picker-ui-terminal` 可选
  - `worktree_session_main_row_uses_existing_reason`：目标是主目录行，或能力状态是 `legacy` → 原因是现有的 `workdir_untrusted` 文案
  - `flat_project_new_session`：非 git 项目传入由项目拼成的节点 → 确认后 `workdir` 是项目 id
  - `test-chat-availability.mjs › worktree_untrusted_reason`：断言见测试计划 R4.4；现有用例不改、照常通过
- 完成定义：
  - `cd desktop && npm run typecheck && npm run test:worktree-dialogs && npm run test:chat-availability && npm run test:dialog-layout && npm run test:i18n-parity` 退出码 0
  - 在仓库根执行 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs`，以退出码 0 结束、没有 FAIL 行
- 依赖：T6b、T9、T10

### T12 删除会话不再动 worktree 和分支；删除确认换成应用内对话框
- 状态：完成
- 文件：
  - 修改 `vibe-remoted/internal/session/manager.go`（`Delete` 去掉对 `CleanupWorktree` 的调用）、`vibe-remoted/internal/session/chat_manager.go`（`deleteChat` 同样）、`vibe-remoted/internal/server/server.go`（`handleDeleteSession` 删掉 409 `worktree_preserved` 的分支）、`docs/protocol.md`（`DELETE /api/v1/sessions/{id}`：协议 4 起一律 204、不清理 worktree；版本表第 4 行补这一条）。`protocol.go`、`protocol.ts` 没有类型变化；`rest.ts` 的 `DeleteSessionError` 保留（还可能连着旧 daemon）
  - 按 spec 改写断言的现有测试（decisions #11，新旧断言见 design 7.1 的表）：`chat_manager_test.go` 的 `TestChatWorktreeAndFlags` 末段；`manager_test.go` 的 `TestManagerDeleteRecoveredCleanWorktreeRemovesGitResources`（改名 `…KeepsGitResources`）和 `TestManagerDeleteDirtyWorktreeStopsSessionAndPreservesGitResources`；`server/worktree_test.go` 的 `TestDeleteDirtyWorktreeReturnsStructuredConflict`（改名 `TestDeleteSessionNeverReturnsPreserved`）。T1 的过渡测试 `TestDeleteCleanWorktreeWithUnmergedCommitsReturns409` 删除，它的断言（目录、分支、2 个提交都在）并入 `TestDeleteSessionNeverReturnsPreserved`
  - 开发中补进来的两个现有测试（只改搭环境和触发确认的方式，断言不动，decisions #63、#64）：`vibe-remoted/internal/server/projects_test.go` 的 `TestProjectsDropsStaleWorktreeRecord`、`desktop/scripts/test-sidebar.mjs` 的 `actions_fire_once`
  - 修改 `desktop/src/renderer/worktree-dialogs.ts`（加 `confirmDeleteSession`）、`desktop/src/renderer/index.ts`（删除会话的回调把 `window.confirm(t('session.deleteConfirm'))` 换成 `confirmDeleteSession`；`closeSession` 原样保留，包括 409 `worktree_preserved` 的处理）、`desktop/src/renderer/styles.css`（追加确认框说明段的规则）、`desktop/src/renderer/i18n.ts`（加 `session.delete.title` / `body` / `confirm` / `keepsWorktree` / `legacyWorktree`，删 `session.deleteConfirm`；`session.worktreePreserved` 保留）、`.claude/skills/verify/scripts/gui-smoke.mjs` 和 `gui-chat-smoke.mjs`（两个脚本现在都经 REST 删除会话、不经过界面上的确认框，`gui-chat-smoke.mjs` 里接受系统对话框的处理是给交接和重载用的，保留；本任务只在选择器受影响时调整）；测试 `desktop/scripts/test-worktree-dialogs.mjs`
- 接口：
  - 使用：`Manager.Projects`（T4，测试里核对行还在）；`sessionContext`、`Capability`、`TreeWorktree`（T5）；`SidebarActions.deleteSession`（T6a，本任务把它在 `index.ts` 里的回调从 `window.confirm` 换成 `confirmDeleteSession`）；`activateModal`（现有）
  - 提供：`confirmDeleteSession(opts: { name: string; worktreeLabel?: string; legacyWorktree: boolean }): Promise<boolean>`：初始焦点在 `dialog-cancel`（d18）；`worktreeLabel` 只在会话挂在非主目录的 worktree 行下时传；`legacyWorktree` = 这台机器的能力状态不是 `v4` 且会话的 `mode` 是 `worktree`；两句说明不同时出现，`legacyWorktree` 优先
  - 重载、交接、删除机器的 `window.confirm` 不动（d15）
- 场景：R5.1、R5.10、R8.5（对话框结构）、R9.1（旧版 daemon 的删除文案）、R9.2（旧桌面端的删除照常工作）
- data-testid：`delete-session-dialog`、`delete-session-note`、`dialog-confirm`、`dialog-cancel`
- 测试：
  - `TestDeleteSessionKeepsWorktreeAndBranch`（session）：终端会话、对话会话各一例，worktree 干净且分支有 2 个未合并提交 → `Delete` 返回 nil；目录在，分支在，提交数是 2；`Projects()` 里该 worktree 行还在、`sessions` 为 `[]`、`managed:true`
  - `TestDeleteSessionNeverReturnsPreserved`（server）：干净加 2 个未合并提交、有 1 个未提交文件、只有被忽略的文件 3 种 → 都是 204，响应体为空，目录和分支都在
  - `TestDeleteOneOfTwoSessionsKeepsWorktree`（session）：同一 worktree 下 2 个会话，删掉一个 → 另一个仍在会话表里，它的 `workdir` 目录存在
  - `TestDeleteSessionWhenWorktreeDirGone`（session）：worktree 目录已被外部删除 → `Delete` 返回 nil，分支还在（删会话不再清理 worktree）
  - 改写的 3 个 session 测试：断言按 design 7.1 的表
  - `test-worktree-dialogs.mjs`：`delete_session_keeps_worktree_note`、`delete_session_legacy_note`：断言见测试计划 R5.1、R9.1；`delete_session_plain`：两个参数都不传说明 → 没有 `delete-session-note`，正文是 `session.delete.body`；`delete_session_enter_cancels`：对话框打开后直接按回车 → 返回 false
  - `test:preserved-notice`（`desktop/package.json` 里现有的检查）不改、照常通过
- 完成定义：
  - `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/session ./internal/server -run 'TestDeleteSession|TestDeleteOneOfTwo|TestManagerDelete|TestChatWorktreeAndFlags|TestTerminalFramesUnchangedV3'` 输出两行 `ok`
  - `grep -n "worktree_preserved" vibe-remoted/internal/server/server.go` 没有输出；`grep -rn "CleanupWorktree(" vibe-remoted/internal/session/manager.go vibe-remoted/internal/session/chat_manager.go` 没有输出
  - `cd desktop && npm run typecheck && npm run test:worktree-dialogs && npm run test:preserved-notice && npm run test:i18n-parity && npm run test:dialog-layout` 退出码 0
  - 在仓库根执行 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs` 和 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-chat-smoke.mjs`，都以退出码 0 结束、没有 FAIL 行，`grep -c "^test(" .claude/skills/verify/scripts/gui-chat-smoke.mjs` 仍是 26
- 依赖：T1、T4、T6b、T9

### T13 协议 4：worktree 的状态和删除（`GET /api/v1/worktrees/status`、`POST /api/v1/worktrees/remove`）
- 状态：完成
- 文件：
  - 修改 `vibe-remoted/internal/session/worktree.go`（`DirtyFiles`、`IgnoredFiles`、`HasSubmoduleCheckouts`、`ErrWorktreeNotFound`、`ErrWorktreeIsMain`、`ErrWorktreeBusy`、`WorktreeChangedError`、`WorktreeRemoveError`；删除 `CleanupWorktree`、`WorktreePreservedError`、`RollbackWorktree`、`isMissingBranchError`、`isMissingWorktreeError`）、`vibe-remoted/internal/session/projects.go`（`WorktreeStatus`、`RemoveWorktree`，步骤照 design 6.2 的 10 步；`Projects` 之外的这两个方法也在读会话之前调 `syncFromTmux()`）、`vibe-remoted/internal/session/manager.go` 和 `chat_manager.go`（`startingDirs`、`removingRoots` 两张表和 `beginStart`；终端、对话两条创建路径在工作目录确定之后、启动进程之前调它，Worktree 模式在放开仓库锁之前对新 worktree 里的工作目录调它，交接出来的终端会话同样；T7 写的「会话启动失败 → 重新取仓库锁 → 锁内撤销 → 放锁」之后才调 `done()`，design 6.1）、`vibe-remoted/internal/server/projects.go`（两个处理函数）、`vibe-remoted/internal/server/server.go`（路由）
  - 修改 `vibe-remoted/internal/protocol/protocol.go`（`WorktreeStatus`，含恒有值的 `ignoredFiles`；`WorktreeRemoveRequest`、`WorktreeRemoveResult`）、`desktop/src/shared/protocol.ts`（同名类型）、`desktop/src/renderer/rest.ts`（`worktreeStatus`、`removeWorktree`、`removeTimeoutMs`；`timedFetch` 加第 3 个可缺省参数 `timeoutMs`，缺省仍是 8 秒）、`docs/protocol.md`（两个端点的请求、响应、错误码，含 409 和 500 响应体里的 `endedSessions`、`worktree_remove_failed` 的两类来源；版本表第 4 行补全，补完后与 design 第 4 节开头那句一致）
  - 测试：新建 `vibe-remoted/internal/session/worktree_remove_test.go`；修改 `vibe-remoted/internal/session/worktree_test.go`、`vibe-remoted/internal/server/projects_test.go`、`desktop/scripts/test-rest-projects.mjs`
  - 按 spec 改写的现有测试（decisions #11，design 7.1）：`TestWorktreeCleanCleanupRemovesWorktreeAndBranch` → `TestRemoveCleanMergedWorktree`；`TestWorktreeDirtyCleanupPreservesBoth` → `TestRemoveDirtyNeedsConsent`；`TestWorktreeIgnoredFileIsPreserved` → `TestRemoveIgnoredOnlyIsClean`。T1 的 `TestCleanupKeepsCleanWorktreeWithUnmergedCommits`、`TestCleanupKeepsBranchWhenWorktreeDirMissing`、`TestCleanupFailsClosedWhenUnmergedCheckFails` 随 `CleanupWorktree` 删除，由 `TestRemoveUnmergedNeedsConsent` 和 `TestRemoveFailsClosedWhenRecheckFails` 取代；`TestUnmergedCommits` 保留。`TestWorktreeRollbackToleratesMissingWorktreeOrBranch` 随 `RollbackWorktree` 的删除改名为 `TestUndoToleratesMissingWorktreeOrBranch`、改调 `Undo`，断言不变（目录已被删时连续撤销两次都不报错，decisions #27）。测试里当清理用的 `defer CleanupWorktree(meta)` 改为 `defer created.Undo()`
- 接口：
  - 使用：`ListWorktrees`、`Worktree.Locked` / `LockReason`、`ResolveHome`、`Home.Repo` / `Home.Single`、`gitAt`、`gitAtTimeout`（T2）；`UnmergedCommits`（T1）；`ProjectStore.Managed` / `RemoveWorktree`（T3）；`AllowFunc`（T4）；按仓库的互斥锁、`CreatedWorktree.Undo`（T7）；`Manager.Delete`（T12 之后不再碰 worktree）、`ErrSessionNotFound`、`Manager.syncFromTmux`（现有）；会话归属（T2）
  - 提供：`DirtyFiles(worktreeDir string) (int, error)`；`IgnoredFiles(worktreeDir string) (int, error)`（`git -c core.fsmonitor=false ls-files --others --ignored --exclude-standard` 的行数：逐个文件数，目录不折叠，design 第 3 节）；`HasSubmoduleCheckouts(worktreeDir string) (bool, error)`（与 git 自己的两段判断相同：`git rev-parse --absolute-git-dir` 得到的目录下有 `modules/`；或 `git ls-files --stage` 里有模式 `160000` 的条目且 `<worktreeDir>/<该路径>/.git` 存在，design 4.9）；`(m *Manager) WorktreeStatus(path string, allow AllowFunc) (protocol.WorktreeStatus, error)`；`(m *Manager) RemoveWorktree(req protocol.WorktreeRemoveRequest, allow AllowFunc) (protocol.WorktreeRemoveResult, error)`；`ErrWorktreeNotFound`、`ErrWorktreeIsMain`、`ErrWorktreeBusy`、`type WorktreeChangedError struct { Status protocol.WorktreeStatus; EndedSessions []string }`、`type WorktreeRemoveError struct { Message string; EndedSessions []string }`；TS `worktreeStatus(path): Promise<WorktreeStatus>`、`removeWorktree(req): Promise<WorktreeRemoveResult>`、`removeTimeoutMs(sessionCount: number): number`、`timedFetch(input, init?, timeoutMs?)`（第 3 个参数是新加的，缺省仍是 8 秒）
  - HTTP 的映射照 design 4.5、4.6：`ErrWorktreeNotFound` → 404 `worktree_not_found`；`ErrWorktreeIsMain` → 400 `worktree_is_main`；`*WorktreeChangedError` → 409 `worktree_changed`，响应体多 `status` 和 `endedSessions`；`*WorktreeRemoveError` → 500 `worktree_remove_failed`，`message` 是它的 `Message`，响应体多 `endedSessions`；`endedSessions` 恒输出数组（没有时是 `[]`）；状态查询的 git 失败 → 500 `git_failed`。`ErrWorktreeBusy` 只出现在创建会话的路径上，error 帧是 `create_failed`（fatal）
  - `WorktreeStatus` 多一个恒有值的 `ignoredFiles`（c4 已采纳，design 4.5）：来自 `IgnoredFiles`；只有这一项查询失败或超时时，status 照常返回，`ignoredFiles` 记成 `-1`（d31；其它几项失败仍是 500 `git_failed`）。它只是说明：`RemoveWorktree` 不拿它和请求比对，也没有对应的同意项
  - `WorktreeStatus` 和 `RemoveWorktree` 在读会话之前先调 `syncFromTmux()`（design 4.9、6.2 第 3 步，decisions #30）：`RemoveWorktree` 是在取到仓库锁之后、不持有 `Manager.mu` 时调
  - `server` 传的 `allow` 是 `cfg.ResolveAllowedWorkdir`（解析符号链接，decisions #17）。`path` 先过 `allow`：报错，或返回的规范路径与 `path` 不逐字相等 → 直接 404，不对它运行 git；通过后只和 daemon 读到的列表做相等比较，传给 git 的路径和分支取自列表
  - 删除与在建会话互斥（design 6.2 第 4 步、4.9 末段，decisions #22）：`startingDirs` 里有工作目录等于 `path` 或在它下面的 → 409 `worktree_changed`，不做改动；否则在同一个 `Manager.mu` 临界区里把 `path` 记进 `removingRoots`，函数返回时（成功、失败都）移除。`beginStart(workdir)` 发现工作目录在某个 `removingRoots` 下 → `ErrWorktreeBusy`；通过之后再 `os.Stat` 一次工作目录，不存在 → `create_failed`。交接在停对话进程之前调 `beginStart`，被拒绝时对话会话继续运行
  - 结束会话之前先拦三种情况（6.2 第 6 步，d26、decisions #29、#31）：列表里这一项 `Locked`；`HasSubmoduleCheckouts` 为真（带不带 `discardFiles` 都拒绝）；第 2 步读到的列表里另有不是 `prunable` 的项，路径以 `path` 加 `/` 开头（嵌套的 worktree，`Message` 写明它的路径和分支、要先删它）。都返回 `*WorktreeRemoveError`，`EndedSessions` 为空，不动任何会话
  - 结束会话（6.2 第 7 步，decisions #30、#32）：逐个 `Manager.Delete`，结束一个记一个；`errors.Is(err, ErrSessionNotFound)` 视为已结束并记入；其它错误 → `*WorktreeRemoveError`，`Message` 含那个会话的 id，不执行 `git worktree remove`。全部结束后 `git -C <path> rev-parse HEAD`，与请求的 `head` 不等 → `*WorktreeChangedError`（最新状态）；命令失败 → `*WorktreeRemoveError`。从这一步起返回的两种错误都带上已经结束的会话
  - `git worktree remove` 失败后不看报错文字（6.2 第 8 步，decisions #21）：重读列表、重查状态，这一项还在且 `head` 变了、或出现了没被同意丢弃的文件 → `*WorktreeChangedError`；其余 → `*WorktreeRemoveError`，这一项已不在列表里时 `Message` 另外写明目录还剩一部分和它的路径；两种错误的 `EndedSessions` 都是第 7 步结束的会话
  - 删分支（6.2 第 9 步，decisions #16）：别的 worktree 还检出着它 → 不删，`branchError` 写明路径；否则 `git update-ref -d refs/heads/<分支> <请求里的 head>`，成功后 `git config --remove-section branch.<分支>`（退出码忽略）。不调用 `git branch`
  - 处理函数用不随请求取消的 context 执行删除：桌面端断开后照样做完（decisions #23）
  - 包内测试钩子：`testAfterRemovingMarked func()`（第 4 步记好 `removingRoots` 之后、第 5 步之前，这时会话都还没被结束）；`testAfterSessionsEnded func()`（第 7 步结束全部会话之后、核对 HEAD 之前）；`testBeforeWorktreeRemove func()`（核对通过之后、`git worktree remove` 之前）；`testEndSession func(id string) error`（非空时代替 `Manager.Delete` 结束会话，用来制造「某个会话结束失败」）
- 场景：R5.2–R5.9、R5.11、R5.12（daemon 一侧）、安全、可靠性
- 测试（除注明的以外都在 `worktree_remove_test.go`）：
  - `TestDirtyFiles`：改 1、暂存 1、未跟踪 1 → 3；子测试 `ignored_only` → 0；`clean` → 0；`TestDirtyFilesDoesNotRunFsmonitor`：仓库配置 `core.fsmonitor` 指向一个会创建标记文件的脚本 → 调用后标记文件不存在；`TestIgnoredFiles`：`.gitignore` 忽略 `node_modules/`、`.env`、`vendor/`；`node_modules/a/1.js`、`node_modules/a/b/2.js`、`node_modules/c/3.js`、`.env` → 4（逐个文件，目录不折叠）；再在 `vendor/lib` 里 `git init` 并放一个文件 → 5（嵌套的仓库算 1）；另有 1 个未跟踪但没被忽略的文件 → 仍是 5，`DirtyFiles` 是 1；什么都没有 → 0；同样不运行 `core.fsmonitor` 指的脚本
  - `TestWorktreeStatus`：`head` 是 40 位；`managed`、`main`、`branch` 正确；`sessions` 含该 worktree 下运行中的会话和已结束的对话会话；detached 时 `detached:true`、没有 `branch`；`ignoredFiles` 等于 `IgnoredFiles` 的结果，没有被忽略的文件时是 0；子测试 `ignored_timeout`：`gitTimeout` 调成 50 ms，`PATH` 前面的 git 包装脚本只在子命令是 `ls-files` 时睡 1 秒 → 返回的状态没有错误，`ignoredFiles` 是 -1，`dirtyFiles`、`unmergedCommits`、`head` 照常；照这份状态删除成功
  - `TestRemoveCleanMergedWorktree`、`TestRemoveDirtyNeedsConsent`、`TestRemoveIgnoredOnlyIsClean`、`TestRemoveUnmergedNeedsConsent`、`TestRemoveEndsSessionsFirst`、`TestRemoveMainRefused`、`TestRemoveExternalNeverDeletesBranch`（含 `switched_branch`）、`TestRemoveDetachedNeedsConsent`、`TestRemoveGitFailureKeepsState`、`TestRemoveLockedRefusedBeforeEndingSessions`：断言见测试计划 R5.2–R5.9、R5.11、R5.12 和「容易出问题的情况」各行。`TestRemoveIgnoredOnlyIsClean` 另外断言：确认框打开之后被忽略的文件又多了几个，删除照样成功（`ignoredFiles` 不参与比对）
  - `TestRemoveChangedSinceStatus`：子测试 `new_file`、`head_moved`、`new_session`，都返回 `*WorktreeChangedError`，其中的 `Status` 是最新值，目录、分支、会话都没有变化
  - `TestRemoveGitRefusesNewFiles`：用 `testBeforeWorktreeRemove` 在重查之后、`git worktree remove` 之前往 worktree 里写一个文件 → 返回 `*WorktreeChangedError`（不是 500），其中的 `Status.DirtyFiles` 是 1，目录还在
  - `TestRemoveClassifiesFailureWithoutMessage`：同上，但 `PATH` 前面的 git 包装脚本把 `worktree remove` 的报错换成一句中文（模拟装了翻译的 git）→ 仍是 `*WorktreeChangedError`；没有新文件而包装脚本让它失败 → `*WorktreeRemoveError`，`Message` 含那句中文
  - `TestRemoveSubmoduleCheckoutRefused`：worktree 里初始化过子模块（它的 git 目录下有 `modules/`），不带和带 `discardFiles` 各一例 → `*WorktreeRemoveError`，`Message` 含 `submodule` 和 `git worktree remove --force`，`EndedSessions` 为空；该 worktree 下的会话还在，目录、分支、子模块里只在本地的那个提交都在。子测试 `embedded_repo`：在 worktree 里 `git init sub`、在 `sub` 里提交一次、回到 worktree 里 `git add sub` 并提交（git 目录下没有 `modules/`，`DirtyFiles` 是 0），另放 1 个未跟踪文件 → `HasSubmoduleCheckouts` 为真；不带、带 `discardFiles` 都返回 `*WorktreeRemoveError`，`sub` 和它里面的提交都在。对照：只有 gitlink、目录里没有 `.git` 的 worktree → `HasSubmoduleCheckouts` 为假，照常删除
  - `TestRemoveRefusedWhenNestedWorktree`：`outer` 是 `managed` 的 worktree，仓库的 `.gitignore` 忽略 `.devflow-tmp/`；用真实的 git 在 `outer/.devflow-tmp/worktrees/inner` 再建一个 worktree，里面有 1 个未跟踪文件，并有 1 个归属 `inner` 的运行中会话。`WorktreeStatus(outer)` 是 `dirtyFiles:0, unmergedCommits:0`，照它发删除请求 → `*WorktreeRemoveError`，`Message` 含 `inner` 的路径，`EndedSessions` 为空；`outer`、`inner` 的目录和分支都在，`inner` 的未跟踪文件在，`inner` 的会话还在会话表里；git 包装脚本的记录里没有 `worktree remove`。先删 `inner` 再删 `outer` → 都成功。对照：`inner` 的目录已被 `rm -rf`（列表里是 `prunable`）→ 不拦，`outer` 照常删除
  - `TestRemoveHeadMovedWhileEndingSessions`：detached 的 worktree 下有 1 个会话，status 是 `unmergedCommits:0`；在 `testAfterSessionsEnded` 里往 worktree 里提交一次（工作区因此是干净的）→ `*WorktreeChangedError`，`Status.Head` 是新提交、`Status.UnmergedCommits` 是 1，`EndedSessions` 含那个会话；目录还在，新提交可以 `git cat-file -e`，包装脚本的记录里没有 `worktree remove`。有分支的 worktree 同样返回 `*WorktreeChangedError`，分支指向新提交
  - `TestRemoveSessionAlreadyGoneContinues`：S 里 2 个会话，`testEndSession` 对第 1 个返回包了 `ErrSessionNotFound` 的错误（相当于它刚好自己退出）→ 删除成功，`endedSessions` 含 2 个 id
  - `TestRemoveSessionEndFailureStops`：`testEndSession` 对第 2 个返回别的错误 → `*WorktreeRemoveError`，`Message` 含第 2 个会话的 id，`EndedSessions` 只有第 1 个；目录还在，没有执行 `git worktree remove`
  - `TestWorktreeStatusSeesTmuxSessionsAfterRestart`（需要 tmux）：worktree 下建 1 个终端会话后换一个新的 `Manager`（同一个 tmux、同一个 `ProjectStore`），不调 `List()`，直接 `WorktreeStatus` → `sessions` 含它；照这份状态 `RemoveWorktree` → `endedSessions` 含它，tmux 里这个会话没了，目录被删
  - `TestRemovePartialFailureReported`：worktree 里有一个 0555 的子目录（里面有已提交的文件）→ `*WorktreeRemoveError`，`Message` 含 git 的输出和剩余目录的路径，`EndedSessions` 是这个 worktree 下原有的那个会话；分支还在；下一次 `Projects()` 的响应里没有这一行，`Managed(…)` 为假
  - `TestRemoveRefusedWhileSessionStarting`：用测试钩子让一个普通会话的创建停在 `beginStart` 之后、登记之前，此时删除它所在的 worktree → `*WorktreeChangedError`，目录还在，没有会话被结束；放行后那个会话建成，`Projects()` 里它在该 worktree 行下。Worktree 模式新建出来的 worktree 同样（卡在 worktree 建好之后、会话登记之前）
  - `TestCreateRefusedWhileWorktreeRemoving`：在 `testAfterRemovingMarked` 里（删除进行中，这个 worktree 的会话还没被结束）往该 worktree 新建终端会话、对话会话、以及从其中的对话会话交接 → 都返回 `ErrWorktreeBusy`；交接被拒的那一刻那个对话会话的状态不是 `ended`、进程还在（随后它作为请求里的会话被这次删除结束）；server 层对应的 error 帧是 `create_failed`、`fatal:true`。在 `testBeforeWorktreeRemove` 里（会话已全部结束）再新建一次，同样被拒
  - `TestRemovingMarkClearedAfterFailure`：删除以 409、500 结束之后，在同一个 worktree 里新建会话成功（标记已移除）
  - `TestRemoveDeletesBranchByFullRef`：(a) 仓库另有一个同名 tag `fix-login` → 删除后 `refs/heads/fix-login` 没了，`refs/tags/fix-login` 和其他分支都在；(b) 另一个 worktree 用 `git checkout --ignore-other-worktrees` 也检出着 `fix-login` → `removed:true, branchDeleted:false`，`branchError` 含那个路径，分支还在；(c) 分支配置里有 `branch.fix-login.remote` → 删除后 `git config --get-regexp '^branch\.fix-login\.'` 没有输出；(d) 用 `git update-ref refs/heads/-x <OID> ""`、`git worktree add --detach`、`git symbolic-ref HEAD refs/heads/-x` 建一个分支名是 `-x` 的 worktree（名字校验不放行它，但别的工具建得出来；名字就叫 `@{-1}` 的分支 git 自己不让建，design V21），用 `AddWorktree` 登记为 `managed`，分支上有 1 个未合并提交 → status 的 `unmergedCommits` 是 1；带 `deleteBranch`、`dropCommits` 删除后 `refs/heads/-x` 没了，其它分支都在；git 包装脚本的记录里没有任何一次调用把 `-x` 当成单独的参数（只出现 `refs/heads/-x`、`--exclude=-x`、`branch.-x`）
  - `TestGitNeverGetsShortBranchName`（T7 的用例补一条路径）：删除 `managed` 的 worktree 并删分支 → 包装脚本的记录里没有以 `branch` 为子命令的调用
  - `TestRemoveSingleRepoRefused`：`path` 是子模块的工作目录 → `ErrWorktreeIsMain`（400），磁盘不变
  - `TestRemoveCompletesAfterClientDisconnect`（server）：请求发出后立刻取消客户端的 context（该 worktree 下有 1 个会话）→ 稍后目录不存在、会话不在会话表里
  - `TestRemoveOnlyListedWorktrees`：`path` 分别是任意临时目录、主目录的子目录、`<worktree>/../<worktree>` 这种没有规范化的写法、子测试 `outside_allowed_roots`（真实存在但 `allow` 不放行的 worktree）、子测试 `symlink_escape`（`allowed_roots` 内的一个符号链接指向根外的真实 worktree，`path` 传这个链接的路径；`allow` 用真实 `config.Config` 的 `ResolveAllowedWorkdir`）→ 都是 `ErrWorktreeNotFound`，磁盘不变；`outside_allowed_roots` 和 `symlink_escape` 里 git 包装脚本的调用记录为 0。`WorktreeStatus` 对同样的输入结果相同
  - `TestRemoveFailsClosedWhenRecheckFails`：重查时 git 失败（`gitTimeout` 调成 50 ms 加睡眠的假 git）→ 返回错误，没有会话被结束，目录和分支都在
  - `TestRemoveBranchDeleteFailureReported`：git 包装脚本让 `update-ref -d` 失败 → 结果 `removed:true, branchDeleted:false`，`branchError` 非空，目录已删
  - `TestRemoveCleansRecordAndEmptyContainer`：删除后 `Managed(…)` 为假；`<仓库>-worktrees` 目录为空时被删掉，里面还有另一个 worktree 时保留；外部 worktree 的上一级是别的空目录（不是容器目录）时，那个目录不被删
  - `TestWorktreeStatusEndpoint`、`TestWorktreeRemoveEndpoint`（server）：子测试 `clean`（200，响应体 `{"removed":true,"branchDeleted":true,"endedSessions":[]}`）、`main`（400）、`not_found`（404）、`changed`（409，响应体有 `status.dirtyFiles`，`endedSessions` 是 `[]`）、`changed_after_sessions_ended`（409，`status.head` 是新提交，`endedSessions` 非空）、`git_failure`（500，`message` 含 git 的输出，`endedSessions` 含被结束的会话）、`locked`（500，`message` 含 `locked`，`endedSessions` 是 `[]`）、`ignored`（status 的 `ignoredFiles` 是 4；干净的 worktree 是 0，键恒在）、`symlink_root`（`allowed_roots` 是指向仓库父目录的符号链接，`path` 用 git 列出的规范路径 → status 200、remove 200）；`TestNewEndpointsRequireToken` 加上这两个端点
  - `test-rest-projects.mjs › remove_timeout_scales`：`removeTimeoutMs(0)` 是 10000、`(3)` 是 25000、`(20)` 是 60000；`removeWorktree` 发请求时传给 `timedFetch` 的超时是 `removeTimeoutMs(req.sessions.length)`，其他方法仍是 8000；`fetch` 超时 → 抛出的不是 `RestError`
  - `test-rest-projects.mjs › remove_409_carries_status`：`removeWorktree` 遇到 409 → 抛 `RestError`，`code` 是 `worktree_changed`，`body.status.dirtyFiles`、`body.endedSessions` 可读；`remove_500_carries_ended_sessions`：500 → `RestError.code` 是 `worktree_remove_failed`，`body.endedSessions` 是数组，`message` 可读
- 完成定义：
  - `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/session ./internal/server -run 'TestDirtyFiles|TestIgnoredFiles|TestWorktreeStatus|TestRemove|TestRemoving|TestCreateRefusedWhileWorktreeRemoving|TestWorktreeRemoveEndpoint|TestUnmergedCommits|TestUndo|TestGitNeverGetsShortBranchName|TestNewEndpointsRequireToken|TestManagedRequiresPathAndBranch'` 输出两行 `ok`
  - `grep -rn "CleanupWorktree\|WorktreePreservedError\|RollbackWorktree\|isMissingBranchError\|isMissingWorktreeError" vibe-remoted/` 没有输出
  - `grep -rnE '"branch", *"-[dDmM]"|"-b"|"-B"|strings\.Contains\((message|err\.Error\(\))' vibe-remoted/internal/session/worktree.go vibe-remoted/internal/session/projects.go` 没有输出（不调用 `git branch`，不匹配报错文字）
  - `cd desktop && npm run typecheck && npm run test:rest-projects` 退出码 0
  - 按 `/protocol-sync` 核对：三个类型的字段、五个新端点的方法和路径在三处一致；`docs/protocol.md` 版本表第 4 行与 design 第 4 节开头列的内容逐项相同
- 依赖：T1、T2、T3、T4、T7、T12

### T14 桌面端：删除 worktree 的确认和流程
- 状态：完成
- 文件：修改 `desktop/src/renderer/worktree-dialogs.ts`（加 `confirmDeleteWorktree`、`showDeleteWorktreeFailure`、`deleteWorktreeFlow`）、`desktop/src/renderer/index.ts`（给 `SidebarActions` 传 `deleteWorktree`：跑 `deleteWorktreeFlow`，返回不是 `null` 时关闭 `endedSessions` 里各会话的视图并立刻刷新这台机器，不管 `removed` 是真是假）、`desktop/src/renderer/styles.css`（追加确认框里警告段、单选、错误条的规则）、`desktop/src/renderer/i18n.ts`（`wt.delete.*`）；测试 `desktop/scripts/test-worktree-dialogs.mjs`、`test-sidebar.mjs`，以及开发中加的测试入口 `desktop/scripts/worktree-dialogs-entry.ts`（decisions #69）
- 接口：
  - 使用：`worktreeStatus`、`removeWorktree`（超时已随会话数放大）、`WorktreeStatus`、`WorktreeRemoveRequest`、`WorktreeRemoveResult`、`RestError`（T13、T4）；`SidebarActions.deleteWorktree`、`TreeWorktree`（T6b、T5）；`activateModal`（现有）
  - 提供：`confirmDeleteWorktree(status: WorktreeStatus, opts: { label: string; changed: boolean; error?: string; ended?: number }): Promise<WorktreeRemoveRequest | null>`；`showDeleteWorktreeFailure(opts: { label: string; message: string; ended: number; path: string }): Promise<void>`；`type DeleteWorktreeOutcome = { removed: boolean; endedSessions: string[] }`；`deleteWorktreeFlow(rest, target: { path: string; label: string }, notify: (text: string) => void): Promise<DeleteWorktreeOutcome | null>`
  - 确认框的形态、默认按钮、同意项照 design 6.2 的表和它下面那一段：`data-variant` 按 `files` > `detached` > `commits` > `external` > `clean` 取第一个成立的；显示了 `files` 或 `detached`（有提交）的警告时初始焦点在 `dialog-cancel`、确认按钮是 `delete-wt-force`；`commits` 的两个单选预选 `delete-wt-keep-branch`；几种情况同时成立时各段都显示、同意项取并集；只要显示了 `files` 或 `detached`（有提交）的警告，回车 = 取消，H22 对 R5.5 的约定只在单独的 `commits` 形态成立（d25）；请求里的 `path`、`head`、`sessions` 原样取自传入的 `status`。两行叠加的说明都不影响形态、默认按钮、回车和同意项：`status.ignoredFiles > 0` 时多一行 `delete-wt-ignored`（`wt.delete.ignored`，R5.4；字段是 0 或缺省时没有，是 `-1` 时文字换成 `wt.delete.ignoredUnknown`）；`opts.ended > 0` 时多一行 `delete-wt-ended`（`wt.delete.ended`，R5.12）
  - 流程照 design 6.2 的表（decisions #32）：`worktreeStatus` → 确认 → `removeWorktree`。流程里记着「有没有发出过删除请求」和 `ended`（各次响应里 `endedSessions` 的并集；删除时 404、超时后确认已删除的，并上那次请求里的 `sessions`）
    - 200 → `{removed:true, endedSessions: ended}`，带 `branchError` 时 `notify(wt.delete.branchKept)`
    - 409 `worktree_changed` → 用响应里的 `status` 再弹一次确认（`changed:true`，`ended` 的个数）
    - 500 `worktree_remove_failed` → 再调一次 `worktreeStatus(path)`：返回了状态 → 用这份最新状态重新打开确认框（`error` 是响应的 `message`，带 `ended` 的个数）；404 → `showDeleteWorktreeFailure`（响应的 `message`、`ended` 的个数、`path`），关闭后返回 `{removed:false, endedSessions: ended}`；这次查询也失败 → `notify(wt.delete.failed)` 并返回同样的值
    - 查状态时 404（还没发出过删除请求）→ `notify(wt.delete.gone)` 并返回 `null`；删除时 404 → 同样提示并返回 `{removed:true, endedSessions: ended}`
    - 请求超时或断网（抛出的不是 `RestError`）→ 再调一次 `worktreeStatus`：404 → `{removed:true, endedSessions: ended}`，否则 `notify(wt.delete.timeout)` 并返回 `{removed:false, endedSessions: ended}`
    - 用户在确认框里取消：从未发出过删除请求 → `null`；发出过 → `{removed:false, endedSessions: ended}`（会话可能已被结束，调用方要关视图并刷新）
  - `showDeleteWorktreeFailure`（design 7.4）：`data-testid="delete-wt-failed"`，标题 `wt.delete.failedTitle`；正文是 `delete-wt-error`（「删除失败：<git 的输出>」）、`delete-wt-ended`（`ended > 0` 时）、`delete-wt-partial`（`wt.delete.partial`，带路径，写明分支没有删除）；只有一个按钮 `dialog-cancel`（`wt.delete.close`），结构同其它对话框（标题、`.modal-body`、`.modal-footer`）
- 场景：R5.2–R5.9、R5.11、R5.12（界面一侧）、R8.5（对话框结构）
- data-testid：`delete-wt-dialog`（带 `data-variant`）、`delete-wt-files`、`delete-wt-commits`、`delete-wt-sessions`、`delete-wt-external`、`delete-wt-keep-branch`、`delete-wt-delete-branch`、`delete-wt-force`、`delete-wt-changed`、`delete-wt-error`、`delete-wt-ignored`、`delete-wt-ended`、`delete-wt-failed`、`delete-wt-partial`、`dialog-confirm`、`dialog-cancel`
- 测试（`test-worktree-dialogs.mjs`，除最后一个）：
  - `delete_wt_clean`、`delete_wt_files`、`delete_wt_commits`、`delete_wt_external`、`delete_wt_detached`、`delete_wt_detached_clean`、`delete_wt_sessions_line`、`delete_wt_ignored_note`、`delete_flow_500_reopens_with_error`、`delete_flow_500_after_sessions_ended`、`delete_flow_500_partial_shows_failure`、`delete_flow_409_after_sessions_ended_then_cancel`、`delete_flow_409_reconfirms`：断言见测试计划 R5.2、R5.3、R5.5、R5.8、R5.11、R5.6、R5.4、R5.9、R5.12 和「容易出问题的情况」各行
  - `delete_wt_files_and_commits`：`managed`、`dirtyFiles:3`、`unmergedCommits:2` → `data-variant` 是 `files`，`delete-wt-files` 和 `delete-wt-commits` 都在，初始焦点在 `dialog-cancel`，单选预选保留分支；对话框打开后直接按回车 → 返回 `null`，`removeWorktree` 没有被调用（d25）；点 `delete-wt-force` → 请求是 `discardFiles:true`，没有 `deleteBranch`；改选删分支后再点 → `discardFiles:true, deleteBranch:true, dropCommits:true`
  - `delete_wt_files_managed_merged`：`managed`、`dirtyFiles:3`、`unmergedCommits:0` → 点 `delete-wt-force` 的请求是 `discardFiles:true, deleteBranch:true`
  - `delete_wt_external_detached`：不是 `managed`、detached、干净 → `delete-wt-external` 的文字是 `wt.delete.externalDetached`，请求没有同意项
  - `delete_wt_enter_key`：`clean` 形态回车 = 删除；`files` 和 `detached`（有提交）形态回车 = 取消；单独的 `commits` 形态回车 = 只删目录的请求（H22）；`files` 加 `commits`、`detached` 加 `files` 同时成立时回车 = 取消（d25）
  - `delete_flow_404_notifies_gone`：`worktreeStatus` 返回 404 → 没有弹确认框，`notify` 收到「这个 worktree 已经不存在」，返回 `null`
  - `delete_flow_branch_error`：结果带 `branchError:"x"` → `notify` 收到「目录已删除，分支没删掉：x」，返回 `{removed:true, endedSessions}`
  - `delete_flow_timeout_then_gone`：`removeWorktree` 抛 `AbortError`（不是 `RestError`），随后的 `worktreeStatus` 返回 404 → 返回 `{removed:true, endedSessions: 请求里的 2 个 id}`，没有弹错误框
  - `delete_flow_timeout_still_there`：`removeWorktree` 抛 `AbortError`，随后的 `worktreeStatus` 返回 200（或也抛错）→ `notify` 收到 `wt.delete.timeout` 的文字，返回 `{removed:false, endedSessions:[]}`（之前的响应里有已结束的会话时是它们的并集）
  - `delete_flow_500_then_cancel`：500（`endedSessions:[]`）之后在重新打开的确认框里点取消 → 返回 `{removed:false, endedSessions:[]}`（不是 `null`）；`delete_flow_500_status_query_fails`：500 之后的 `worktreeStatus` 抛网络错误 → `notify` 收到 `wt.delete.failed` 的文字，返回 `{removed:false, endedSessions: 响应里的 id}`
  - `delete_flow_cancel_before_any_request`：第一次确认框就取消 → 返回 `null`，`removeWorktree` 没有被调用；`delete_flow_409_then_cancel`：一次 409（`endedSessions:[]`）之后取消 → 返回 `{removed:false, endedSessions:[]}`（发出过删除请求就不返回 `null`）
  - `delete_flow_ended_union`：第一次请求 409 带 `endedSessions:["a"]`，第二次 500 带 `endedSessions:["b"]`，之后取消 → 返回的 `endedSessions` 是 `["a","b"]`（不重复）
  - `test-sidebar.mjs › remove_result_closes_views`（经 `loadIndex()`）：`fix-login` 下打开着 2 个会话，流程返回 `endedSessions` 含这 2 个 id → 两个视图都被关闭，`views` 里没有它们，随后发出了一次 `listProjects` 和 `listSessions`；流程返回 `{removed:false, endedSessions: 这 2 个 id}`（会话已结束、worktree 没删成）时同样关闭这两个视图并刷新；流程返回 `{removed:false, endedSessions:[]}` 时不关任何视图，但同样发出一次刷新；返回 `null` 时不刷新
- 完成定义：
  - `cd desktop && npm run typecheck && npm run test:worktree-dialogs && npm run test:sidebar && npm run test:dialog-layout && npm run test:i18n-parity` 退出码 0
  - 在仓库根执行 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs`，以退出码 0 结束、没有 FAIL 行
- 依赖：T6b、T12、T13

### T15 新建对话框里写明 `-c` 的后果
- 状态：完成
- 文件：修改 `desktop/src/renderer/session-form.ts`（`createFlagsSection` 按 `existingSessions` 显示说明）、`desktop/src/renderer/dirpicker.ts`（`openDirPicker` 加第 3 个可缺省参数 `opts?: { sessionCountAt?(workdir: string): number }`，每次列出目录后把结果传给启动选项段；Worktree 模式下传 0）、`desktop/src/renderer/worktree-dialogs.ts`（`openWorktreeSessionDialog` 用 `opts.sessionCountAt(worktree.path)` 的结果，没传时是 0；`openNewWorktreeDialog` 传 0）、`desktop/src/renderer/index.ts`（调 `openDirPicker` 和 `openWorktreeSessionDialog` 时传同一个 `sessionCountAt`：`(dir) => countActiveSessionsAt(这台机器的会话, dir)`）、`desktop/src/renderer/styles.css`（追加说明条的规则）、`desktop/src/renderer/i18n.ts`（`wt.session.continueNote`）；测试 `desktop/scripts/test-session-form.mjs`、`test-worktree-dialogs.mjs`
- 接口：
  - 使用：`createFlagsSection`、`setExistingSessions`（T9）；`openWorktreeSessionDialog` 的第 4 个参数 `opts.sessionCountAt`（T11）；`countActiveSessionsAt`（T5）；`machineSessions`（`index.ts` 现有）
  - 「已有会话数」的口径在两个入口相同（d24，更正 d17）：这台机器上工作目录等于将要启动的目录、且没有结束的会话数。worktree 行上的入口不再用 worktree 节点的会话数（它包含子目录里的会话和已结束的对话会话）
  - 提供：说明的显示条件（d13、d24、H20）：勾选了 id 为 `continue` 的启动选项，且 `existingSessions > 0`。确认按钮不因此置灰。机器没有 id 为 `continue` 的启动选项时永远不显示
- 场景：R6.1、R6.2
- data-testid：`continue-note`
- 测试：
  - `test-session-form.mjs › continue_note_shown`、`continue_note_hidden_without_sessions`：断言见测试计划 R6.1、R6.2
  - `continue_note_default_checked`：`continue` 的 `default` 为真且已有会话数是 2 → 对话框一打开就有说明
  - `continue_note_other_flag`：只勾选别的启动选项 → 没有说明
  - `picker_count_follows_directory`：目录选择器从 `/r/devflow`（`sessionCountAt` 返回 1）进到 `/r/devflow/src`（返回 0）→ 说明消失；切到 Worktree 模式 → 说明消失
  - `test-worktree-dialogs.mjs › continue_note_counts`：`openWorktreeSessionDialog` 在 `sessionCountAt(worktree.path)` 返回 1 时显示说明、返回 0 时不显示（即使 `worktree.sessions` 里有 2 个会话：一个在子目录、一个已结束）；不传 `opts` 时不显示；`openNewWorktreeDialog` 勾选 `continue` 也不显示
  - `test-sidebar.mjs › new_session_count_uses_workdir`（经 `loadIndex()`）：`fix-login` 行下有 1 个 `workdir` 等于 worktree 根的运行中会话和 1 个已结束的对话会话，点 `worktree-new-session` 并勾选 `continue` → 有 `continue-note`；只剩已结束的那个时 → 没有
- 完成定义：`cd desktop && npm run typecheck && npm run test:session-form && npm run test:worktree-dialogs && npm run test:sidebar && npm run test:picker-layout && npm run test:i18n-parity` 退出码 0
- 依赖：T5、T9、T11

### T16 切换会话的快捷键（⌘1–9、⌘⇧[、⌘⇧]）
- 状态：待办
- 文件：新建 `desktop/src/renderer/shortcuts.ts`、`desktop/scripts/test-shortcuts.mjs`；修改 `desktop/src/renderer/index.ts`（启动时 `installShortcuts(window, …)`：`blocked` = 页面上有 `.modal-overlay` 或正在内联重命名；`count` 和 `activeIndex` 来自 `visibleSessions(…)`；`open` 调 `openExisting`）、`desktop/package.json`（`test:shortcuts`）、`.claude/skills/verify/scripts/gui-smoke.mjs`（只在 `--keep` 分支多打印一行 `--keep: Electron pid <pid>`，值是脚本自己 `spawn` 的 Electron 子进程的 pid，供下面的真实键盘确认核对前台应用。这一行不是断言，不改任何检查）
- 接口：
  - 使用：`visibleSessions`（T5）；`machineTrees`、`collapsedProjects`、折叠的机器集合、`renamingActive`、`openExisting`（`index.ts`，T6b 和现有）
  - 提供：`type ShortcutAction`；`matchShortcut(e)`；`pickTarget(count, activeIndex, action)`；`installShortcuts(target: Window, deps: { blocked(): boolean; count(): number; activeIndex(): number; open(index: number): void }): () => void`。签名见 design 4.10，规则见 6.5：只在 `window` 的 keydown 捕获阶段监听；匹配且没有被 `blocked` 时 `preventDefault()` 加 `stopPropagation()`；被 `blocked` 时不切换也不拦截
- 场景：R7.1–R7.5
- 测试（`test-shortcuts.mjs`）：
  - `match_digits`、`pick_index`、`pick_prev_next_wraps`、`capture_blocks_propagation`、`blocked_does_not_intercept`：断言见测试计划 R7.1–R7.4
  - `match_brackets`：⌘⇧`BracketRight` → `next`，⌘⇧`BracketLeft` → `prev`；不带 ⇧ 的 ⌘`BracketRight`、带 ⌥ 或 ⌃ 的都不匹配；用 `code` 判断，`key` 是 `{` 或 `}` 时同样匹配
  - `index_out_of_range_still_intercepted`：5 个会话时按 ⌘7 → `open` 没有被调用，`defaultPrevented` 为真（按键不会落进终端）
  - `uninstall_removes_listener`：调用返回的卸载函数后再派发 ⌘3 → `open` 没有被调用
  - `skips_collapsed_via_index`（经 `loadIndex()`）：2 个项目各 2 个会话，折叠第 1 个项目，当前打开第 2 个项目的第 2 个会话，派发 ⌘⇧] → 打开的是第 2 个项目的第 1 个会话
- 完成定义：
  - `cd desktop && npm run typecheck && npm run test:shortcuts && npm run test:tree && npm run test:terminal-clipboard` 退出码 0
  - 真实键盘确认一次（design V7 留下的风险：CDP 注入的按键不经过 macOS 的原生菜单分发）：在仓库根执行 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs --keep`，用它留下的临时实例（临时 daemon、临时 userData、`--use-mock-keychain`、独立的 tmux；不另起应用，不连本机真实的 daemon），结束后对脚本按 Ctrl+C 让它清理。发按键之前必须确认最前面的应用就是这个临时实例，按 pid 比，不按进程名比（用户自己用 `npm run dev` 开着的 vibe-remote 进程名同样是 `Electron`，按键会发给他真实的应用）：`osascript -e 'tell application "System Events" to get unix id of first process whose frontmost is true'` 的输出必须等于脚本打印的 `--keep: Electron pid <pid>` 里的 pid。相等才执行 `osascript -e 'tell application "System Events" to keystroke "2" using command down'` 和 `osascript -e 'tell application "System Events" to key code 30 using {command down, shift down}'`，每条之前都重新比一次 pid；期望会话切换、终端里没有多出字符。结果写进 design.md 第 10 节「变更」。pid 不相等（最前面的不是它），或 `osascript` 因为没有辅助功能权限报错时，不发按键，在第 10 节记「真实键盘待人工确认」并交给 dev-test 的测试报告，不算本任务未完成
- 依赖：T5、T6b

### T17 新旧版本互连：整体核对（R9）
- 状态：待办
- 文件：新建 `desktop/scripts/test-legacy-daemon.mjs`、`vibe-remoted/internal/server/compat_test.go`；修改 `desktop/package.json`（`test:legacy-daemon`）、`docs/protocol.md`（在「协议版本」一节下加「版本互连」小节：新桌面端连协议 3 的 daemon 时怎么降级、旧桌面端连协议 4 的 daemon 时哪些行为变了，内容照 spec R9.1、R9.2 和 design 4.1、4.7、6.4）。各个降级分支已经写在 T4（`CHAT_MIN_PROTO`）、T5（分组）、T6b（说明条和置灰）、T9（名字段）、T11（置灰原因）、T12（删除文案）里（d20）；这两个测试发现缺口时，在对应的文件里补上
- 接口：
  - 使用：`loadIndex()`、`indexDom()`（`desktop/scripts/chat-test-util.mjs`，T6b 扩过）；`nextCapability`、`buildTree`（T5）；`confirmDeleteSession`（T12）；`CHAT_MIN_PROTO`（T4）；`closeSession` 里的 409 处理（现有）
  - 提供：无新接口
- 场景：R9.1、R9.2
- 测试：
  - `test-legacy-daemon.mjs`（渲染进程入口连一个假 daemon：`/api/v1/info` 返回 `proto: 3` 且 `chat.supported` 为真，`/api/v1/projects` 返回 404，`/api/v1/sessions` 返回 3 个会话：`/r/devflow` 的普通会话、`sourceRepo:"/r/devflow"` 且 `branch:"vibe/1794824025040-12b763ac"` 的 worktree 会话、`/tmp/notes` 的普通会话）：
    - `groups_by_session_fields`：侧边栏有 2 个 `project-row`（`devflow`、`notes`）；`devflow` 下有 2 个 `worktree-row`；没有 `worktree-empty`
    - `note_and_disabled_entries`：有 `machine-legacy-note`；`project-new-worktree` 是 `disabled`；`worktree-delete` 是 `disabled`，提示是「需要升级这台机器的 vibe-remoted」
    - `chat_still_available`：新建会话对话框里 `picker-ui-chat` 可选（协议 3 支持对话）
    - `worktree_mode_sends_no_name`：目录选择器选 Worktree 模式 → 没有 `wt-name-input`；确认后发出的 attach 帧没有 `worktreeName` 键
    - `delete_confirm_is_legacy_text`：点 worktree 会话的删除 → `delete-session-note` 的文字是 `session.delete.legacyWorktree`；普通会话的确认框没有 `delete-session-note`
    - `preserved_409_still_shown`：`DELETE` 返回 409 `worktree_preserved`（带 `worktreeRoot`、`branch`）→ 状态栏显示「Worktree 已保留 · <路径> · 分支 <分支>」
    - `old_daemon_warning_text`：收到 `proto: 3` 的 `ready` → 状态栏的文字是改写后的 `terminal.oldDaemon`，含「3」和「4」
    - `upgrade_in_place`：下一轮 `/api/v1/projects` 改为返回 200 和项目数组 → 说明条消失，两个入口可用（d7）
  - `TestV3ClientFlowAgainstV4Daemon`（server，真实 WebSocket，`use_tmux:true`：重命名把名字存在 tmux 用户选项里，无 tmux 时 `SetName` 直接报错、会得到 500；命令前带独立的 `TMUX_TMPDIR`）：只用协议 3 的帧和端点：`auth` → 收到 `sessions` → attach（新建，`mode:"worktree"`，没有 `ui`、没有 `worktreeName`）→ `ready` 的键集合与 `testdata/v2-golden` 里 `ready` 的键集合相同，`branch` 是 `vibe/<会话id>` → `POST …/rename` 返回 204（成功时没有响应体，`server.go:367`），随后 `GET /api/v1/sessions` 里它的 `title` 是新名字 → `GET /api/v1/sessions` 每条的键都在协议 3 的字段表里 → `DELETE` 返回 204 → worktree 目录和分支都在
  - `TestTerminalFramesUnchangedV3`：不改，照常通过
- 完成定义：
  - `cd desktop && npm run typecheck && npm run test:legacy-daemon` 退出码 0
  - `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/server -run 'TestV3ClientFlowAgainstV4Daemon|TestTerminalFramesUnchangedV3'` 输出 `ok`
  - `git diff --stat $(git merge-base HEAD change/dual-mode) -- vibe-remoted/internal/server/testdata vibe-remoted/internal/server/golden_test.go` 没有输出
- 依赖：T9、T11、T12、T14

### T18 视觉 M1（一）：配色变量、终端主题、窗口底色
- 状态：待办
- 文件：新建 `desktop/src/renderer/theme.ts`、`desktop/scripts/test-theme-tokens.mjs`；修改 `desktop/src/renderer/styles.css`（`:root` 里现有变量换成 design 7.5 表里的值，补上表里标「新」的变量；`:root` 之外现有的 59 处十六进制或 `rgba()` 全部换成变量或 `color-mix(in srgb, var(--…) N%, var(--…))`；T6b 加的 `.project-tag` 规则和四个 `--tag-*` 变量保持原样（值照 design 7.5 的表）；三种状态点的规则按 H23；文件开头两处 `Claude Desktop-inspired` 注释改为指向本需求的 M1）、`desktop/src/renderer/index.ts`（`makeTerminal` 里写死的 theme 换成 `terminalTheme()`）、`desktop/src/main/index.ts`（`backgroundColor` 改为 `#EFEFF4`）、`desktop/package.json`（`test:theme-tokens`）
- 接口：
  - 使用：xterm 的 `ITheme`（现有依赖）
  - 提供：`terminalTheme(): ITheme`：`background`、`foreground`、`cursor`、`selectionBackground` 在调用时用 `getComputedStyle(document.documentElement)` 读 `--term-bg`、`--term-fg`、`--term-cursor`、`--term-selection`（去掉首尾空白）；16 个 ANSI 色是这个文件里的常量，值照搬 `index.ts` 现在的（d14）
  - 本任务只换颜色，不改布局、圆角、间距、阴影的形态（那些在 T19）；`--radius`、`--radius-card`、`--radius-item`、`--sidebar-width`、三个 `--shadow-*` 变量在这里定义好值，T19 才开始在新规则里用到后两类
- 场景：R8.2、R8.4、R8.6
- 测试（`test-theme-tokens.mjs`，读 `src/renderer/styles.css` 和 `src/main/index.ts` 的文本，另用 jsdom 跑 `theme.ts`）：
  - `root_values_match_design`：design 7.5 表里每个变量在 `:root` 里的值与表相同（例如 `--accent` 是 `#6B54D3`，`--bg-app` 和 `--bg-sidebar` 是 `#EFEFF4`，`--text-muted` 是 `#6A6779`）
  - `no_color_literals_outside_root`：去掉 `:root { … }` 块和注释之后，`styles.css` 里匹配 `#[0-9a-fA-F]{3,8}\b`、`rgba?\(` 的次数是 0；`hsla?\(` 只允许一种写法：括号里的每个参数都是 `var(--…)`（项目行标签的 `hsl(var(--tag-hue) var(--tag-bg-s) var(--tag-bg-l))` 和对应的文字色），参数里出现任何数字都算字面量。用例自带两个反例确认检查有效：`hsl(210 50% 40%)` 和 `hsl(var(--tag-hue) 62% 90%)` 都被判为字面量
  - `tag_contrast_all_hues`：从 `:root` 读出 `--tag-bg-s`、`--tag-bg-l`、`--tag-fg-s`、`--tag-fg-l`（值是 `62%`、`90%`、`48%`、`30%`），对色相 0–359 逐个把 `hsl()` 换算成 sRGB 后算 WCAG 对比度，最小值 ≥ 4.5（`evidence/contrast-tag.txt`：最小 4.62，在色相 60）；把 `--tag-fg-l` 换成效果页原来的 `32%` 重算，最小值小于 4.5（确认这个用例拦得住）
  - `contrast_table`：对 `evidence/contrast-m1.txt` 里标 `ok` 的 35 对（前景变量、背景变量、最低比值写成测试里的一张表）算 WCAG 对比度，全部不低于各自的最低值；其中正文 `--text-primary` 对 `--bg-primary` ≥ 4.5，`--on-accent` 对 `--accent` ≥ 4.5，`--text-muted` 对 `--bg-sidebar` ≥ 3，`--dot-new`、`--dot-idle`、`--dot-wait` 对 `--bg-sidebar` ≥ 3
  - `dot_shapes_differ`：`.session-unread.output` 有 `border` 且背景透明；`.session-unread.idle` 背景是 `var(--dot-idle)`、没有 `box-shadow`；`.session-unread.waiting` 背景是 `var(--dot-wait)` 且有 3px 的 `box-shadow` 光圈；三者直径都是 8px
  - `window_background_matches_bg_app`：`src/main/index.ts` 里 `backgroundColor` 的值等于 `styles.css` 的 `--bg-app`，是 `#EFEFF4`
  - `terminal_theme_from_css_vars`：jsdom 里把 `styles.css` 的 `:root` 块放进 `<style>` → `terminalTheme()` 的四个值是 `#FFFFFF`、`#1C1B22`、`#6B54D3`、`#D9D2F4`；改掉 `--term-bg` 后再调用，`background` 跟着变
  - `ansi_colors_unchanged`：`terminalTheme()` 的 16 个 ANSI 色与测试里写死的一份改动前的值（从本任务开始前的 `index.ts` 抄出）逐个相同
  - 现有的 `test-terminal-selection.mjs`、`test-terminal-layout.mjs` 不改、照常通过
- 完成定义：
  - `cd desktop && npm run typecheck && npm run test:theme-tokens && npm run test:terminal-selection && npm run test:terminal-layout && npm run test:chat-view` 退出码 0
  - 在仓库根执行 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs` 和 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-chat-smoke.mjs`，都以退出码 0 结束、没有 FAIL 行
- 依赖：T14、T15（它们是最后往 `styles.css` 追加规则的任务；先让追加的规则都在，再统一换颜色）

### T19 视觉 M1（二）：形态
- 状态：待办
- 文件：修改 `desktop/src/renderer/styles.css`（按效果页 `docs/changes/2026-11-16-project-worktrees/pages/prototype/index.html` 的 M1：`#main-area` 是外边距 10px、`--radius-card`、带边框和 `--shadow-card` 的浮起卡片，标题栏在卡片里、没有底边线；侧边栏宽 `--sidebar-width`、顶部 124px 的 `--sidebar-glow` 渐变；项目行、worktree 行、两行的会话行、选中行用 `--bg-selected` 和 `--radius-item`；`.chat-instance` 一段里用户消息是右对齐气泡（`--accent-soft`，圆角 17px），输入框是圆角 17px 的卡片、发送按钮是圆形，权限卡片、工具行、代码块、diff 按效果页；对话框用 `--shadow-lift` 和 `--scrim`）、`desktop/scripts/test-theme-tokens.mjs`（加形态用例）、`CLAUDE.md` 第 12 行（只改 c2 同意的那一句：「（侧边栏/状态栏对标 Claude Desktop）」改为「（侧边栏、标题、状态栏，外观以 `docs/changes/2026-11-16-project-worktrees` 选定的 M1 方案为准）」）、`.claude/skills/verify/scripts/gui-smoke.mjs` 和 `gui-chat-smoke.mjs`（只在选择器受影响时调整；另外 `gui-smoke.mjs` 的 `--keep` 分支多打印一行 `--keep: CDP 127.0.0.1:<cdpPort>`，供下面的截图步骤找到临时实例的调试端口。这一行不是断言，不改任何检查）
- 接口：
  - 使用：T18 定义的全部 CSS 变量；T6b、T9、T11、T12、T14、T15 追加的 class 和 `data-testid`
  - 提供：无新接口。不改 `desktop/src/renderer/chat/` 下任何 `.ts`，不改 DOM 结构和 `data-testid`；新规则继续只用变量
- 场景：R8.1、R8.3（现有功能入口都在）、R8.5（对话框结构不变）
- 测试：
  - `test-theme-tokens.mjs › main_area_is_card`：`#main-area` 的规则里有 `border-radius: var(--radius-card)`、`box-shadow: var(--shadow-card)`、`margin: 10px`
  - `chat_shape_rules`：`.chat-instance` 一段里用户消息那条规则的背景是 `var(--accent-soft)`、`border-radius` 是 17px、靠右对齐；输入框容器的 `border-radius` 是 17px
  - `no_color_literals_outside_root`（T18 的用例）仍然通过
  - `test-dialog-layout.mjs`、`test-picker-layout.mjs`、`test-slash-menu-layout.mjs`、`test-terminal-layout.mjs`、`test-chat-view.mjs`、`test-chat-markdown.mjs`、`test-chat-diff.mjs`、`test-chat-render-guard.mjs` 不改、照常通过
- 完成定义：
  - `cd desktop && npm run typecheck && npm test` 退出码 0
  - `git diff --stat HEAD~1 -- desktop/src/renderer/chat/ desktop/src/renderer/index.html` 没有输出
  - 在仓库根执行 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs` 和 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-chat-smoke.mjs`，都以退出码 0 结束、没有 FAIL 行（两者内含 `picker-layout.mjs` 和 `slash-menu-layout.mjs` 的测量）；`grep -c "^test(" .claude/skills/verify/scripts/gui-chat-smoke.mjs` 仍是 26；`git diff $(git merge-base HEAD change/dual-mode) -- .claude/skills/verify/scripts/gui-smoke.mjs .claude/skills/verify/scripts/gui-chat-smoke.mjs` 里没有被删掉或放宽的断言
  - `sed -n 12p CLAUDE.md` 含「M1 方案为准」；`git diff HEAD~1 -- CLAUDE.md` 只有这一行
  - 截图只用临时实例（decisions #18）：在仓库根执行 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs --keep`，它起的是临时 daemon（随机端口、临时 `state_dir`）、临时 userData、`--use-mock-keychain` 和随机的调试端口；从输出的 `--keep: CDP 127.0.0.1:<端口>` 读出端口，经 CDP 的 `Page.captureScreenshot` 截 3 张图（有三层的侧边栏加终端会话、对话会话、删除 worktree 确认框），和效果页 M1 并排存进 `evidence/m1-*.png`；截完对脚本按 Ctrl+C 让它清理。截图用的仓库放在哪（decisions #37）：脚本起了两个临时 daemon，终端 daemon 的配置来自 `vibe-remoted.tmux.json`，`allowed_roots` 是 `["/tmp"]`；只有对话 daemon 的根在脚本打印的 `work dir` 下（`<work dir>/chat-proj`）。所以「三层侧边栏加终端会话」用的仓库建在 `R=$(mktemp -d /tmp/vr-shot-XXXXXX)` 下（例如 `$R/devflow`，它的 worktree 容器 `$R/devflow-worktrees` 也在 `$R` 里），在终端 daemon 那台临时机器上开会话；对话会话直接开在 `<work dir>/chat-proj`（对话 daemon 唯一被信任的目录）。截完先在应用里（或经临时 daemon 的 `DELETE /api/v1/sessions/{id}`）删掉这次建的会话，再对脚本按 Ctrl+C，最后 `rm -rf "$R"`；`<work dir>` 由脚本自己删除。这一步不直接执行任何 `tmux` 命令。不用固定端口 9222，不直接启动构建产物（那样会读真实的 userData、machines.json 和钥匙串），不连 127.0.0.1:8765。没有显示器、脚本起不来时不截图，在 design.md 第 10 节记「M1 截图待 dev-test」，不算本任务未完成
- 依赖：T18

### T20 更新约束 AI 的规则文件（CLAUDE.md、`.devflow.yml`、protocol-sync skill）
- 状态：待办
- 文件：修改 `CLAUDE.md`（除 T19 改的那一句以外：协议版本 4 与 5 个新端点、`attach.worktreeName` 和 4 个错误码；会话归属和 `projects.json`；终端会话的创建时间存在 `@vibe_remote_created`；删会话不再动 worktree 和分支；交给 git 的分支只写完整引用名、git 环境固定 `LC_ALL=C`；`allowed_roots` 的检查一律用解析符号链接的 `ResolveAllowedWorkdir`（安全模型一节里「`config.IsAllowedWorkdir` 用 `filepath.Rel`」那句改掉）；对话界面信任规则的 worktree 条款；客户端侧边栏的三层模型、`tree.ts` / `sidebar.ts`、`/api/v1/projects` 轮询与能力状态；`state_dir` 一节加 `projects.json`；删除 worktree 的规矩：结束会话之前拦下锁定、子模块或嵌入式仓库、嵌套 worktree 三种，之后的失败带 `endedSessions` 如实报告；worktree 模式的工作目录白名单在建之前和建之后各查一次）。用户已同意改这三个规则文件（c3，decisions #28）、`.devflow.yml`（`invariants` 新增 7 条，规则原文和检查命令照 design 7.1「本次新增 7 条」的表；涉及 Go 测试的命令前带 `TMUX_TMPDIR=$(mktemp -d)`）、`.claude/skills/protocol-sync/SKILL.md`（第 4 步后面加一段 v4 的核对项：`attach.worktreeName`；`Project`、`ProjectWorktree`、`WorktreePlan`、`WorktreeStatus`、`WorktreeRemoveRequest`、`WorktreeRemoveResult`；5 个新端点的方法、路径、错误码（含 plan 的 `unsupported_repo` 和可缺省的 `conflict`、status 的 `ignoredFiles`、remove 的 409 和 500 响应体里的 `endedSessions`、`worktree_remove_failed` 的两类来源）；4 个新的 error 帧代码都是 fatal；版本表第 4 行和 `Version` / `PROTOCOL_VERSION` = 4、`CHAT_MIN_PROTO` = 3）
- 接口：
  - 使用：T3、T7、T10、T12、T13 写好的测试名（7 条规则的检查命令里引用）
  - 提供：无
- 场景：无（不改产品行为；让规则文件与代码一致）
- 测试：
  - `.devflow.yml` 新增的 7 条 `check` 命令逐条执行，全部退出码 0（涉及 `./internal/session`、`./internal/server` 的命令前带 `TMUX_TMPDIR=$(mktemp -d)`）
  - 按改好的 protocol-sync 第 4 步核对一遍三处协议，无差异
- 完成定义：
  - `grep -c "rule:" .devflow.yml` 比改动前多 7（改动前是 11）
  - `grep -n "当前为 3\|worktree 模式查所选的源目录本身（不是仓库根，也不是新 worktree）。只读这一个字段" CLAUDE.md` 没有输出（旧表述已更新）
  - `git diff --stat HEAD~1` 只列出这 3 个文件
- 依赖：T3、T4、T6b、T7、T8、T10、T12、T13

## 进度

（dev-build 每完成一个任务追加一行）

| 任务 | 完成时间 | 提交 | 测试 |
|------|----------|------|------|
| T1 | 2026-11-19 11:01 | 948a65b | `go test -race ./internal/session ./internal/server -run 'TestUnmergedCommits\|TestCleanup\|TestWorktree\|TestDelete'` 两行 `ok`；`make check` exit 0；cherry-pick 到 change/dual-mode 后 `make check` exit 0 |
| T2 | 2026-11-19 11:40 | eb6143b | 三条完成命令全 `ok`（含 `-race`、`TZ=Asia/Shanghai`、golden 未动）；`make check` exit 0 |
| T3 | 2026-11-19 11:52 | 37336f8 | `go test -race ./internal/session -run 'TestProjectStore\|TestManaged\|TestOpenProjectStore\|TestMemoryProjectStore'` `ok`；`grep ValidSessionID` 无输出；`make check` exit 0 |
| T4 | 2026-11-19 12:40 | b60351d | 三组完成命令全绿（Go `-race` 三包 `ok`、`test:chat-availability`+`test:rest-projects` 退出 0、golden/IsAllowedWorkdir 核对通过）；`make check` exit 0 |
| T5 | 2026-11-19 14:35 | 28f6d19 | `npm run typecheck` 退出 0；`npm run test:tree` 18 个用例 `ok`；`TMUX_TMPDIR=… make check` exit 0 |
| T6a | 2026-11-19 15:40 | 57413e3（快照）、b746d2b（搬家） | `npm run typecheck`+`npm test` 退出 0（`test:sidebar` 4 用例 `ok`，快照逐字节不变）；`gui-smoke.mjs`、`gui-chat-smoke.mjs` 全绿、无 FAIL（两脚本 vs merge-base 无 diff）；`TMUX_TMPDIR=… make check` exit 0。`index.ts` 净减少 155 行（完成定义估计 ≥200，见 decisions #45） |
| T6b | 2026-11-19 16:30 | fac25a9 | `typecheck`+`test:sidebar`(19)+`test:i18n-parity`(266)+`test:chat-activity`(6)+`test:chat-render-guard`(15) 全退出 0；`npm test` 退出 0；`TMUX_TMPDIR=… make check` exit 0；`gui-smoke.mjs`、`gui-chat-smoke.mjs` 全绿无 FAIL（两脚本未改、`^test(`=26、`check(`=14） |
| T6c | 2026-11-19 14:38 | 81dab8d | 修复前 `gui-smoke.mjs` 新检查 FAIL（`session "fix": name has no visible width`、`session "new-api": name shows only 8px of 47px`、对话行 `name shows only 26px of 56px`）；修复后 `gui-smoke.mjs` 33 行 PASS、0 FAIL，`gui-chat-smoke.mjs` 29 行 PASS、0 FAIL；`typecheck`+`test:sidebar`(19) 退出 0；`TMUX_TMPDIR=… make check` exit 0（第一次在 `internal/chat` 卡住超时，重跑通过，decisions #50）；`check(`=17、`^test(`=26；截图 `.devflow-tmp/build-shots/t6c-sidebar*.png` |
| T7 | 2026-11-19 15:20 | da251b7（失败的测试和接口骨架）、4657f4b（实现）、e35aa2c（协议三处、桌面端连接层、记录） | 完成定义的 `go test -race -count=1 ./internal/session ./internal/config ./internal/server -run '…'` 三行 `ok`（49 个用例和子用例 PASS，无 SKIP；并发用例各 20 轮）；`go test -race ./...` 全包 `ok`；`npm run typecheck`+`test:attach-replay` 退出 0；两条 grep 无输出；`attach.worktreeName` 和 4 个错误码在 protocol.go / protocol.ts / protocol.md 三处一致；`TMUX_TMPDIR=… make check` exit 0 |
| T8 | 2026-11-19 15:28 | d378972 | 完成定义的 `go test -race -count=1 ./internal/session ./internal/server -run 'TestPlan\|TestNewEndpointsRequireToken'` 两行 `ok`；`npm run typecheck`+`test:rest-projects`(6) 退出 0；`WorktreePlan` / `WorktreeBase` 的字段和可缺省性在 protocol.go / protocol.ts / protocol.md 三处一致，路由、`rest.ts`、端点表一致；`TMUX_TMPDIR=… make check` exit 0；`gui-smoke.mjs` 33 行 PASS、`gui-chat-smoke.mjs` 29 行 PASS，都无 FAIL |
| T9 | 2026-11-19 15:54 | df32cea（失败的测试和接口骨架）、0a6ef68（实现）、e092c9c（记录） | 完成定义的 `typecheck`+`test:worktree-name`(3)+`test:session-form`(9)+`test:worktree-dialogs`(6)+`test:dialog-layout`+`test:picker-layout`+`test:i18n-parity`(285 键) 全退出 0；`npm test` 退出 0；`TMUX_TMPDIR=… make check` exit 0；`gui-smoke.mjs` 33 行 PASS（含目录选择器 500/700/803 三档、侧边栏布局在每一行悬停时再量一遍：项目行的「新建 worktree」按钮已出现）、`gui-chat-smoke.mjs` 29 行 PASS，都无 FAIL；真实 Electron 临时实例里新建 worktree 对话框（中文正常态、出错态、长冲突文案、英文出错态）和目录选择器的 Worktree 模式在 800×500、800×700、1100×803 下主按钮都在对话框和窗口内且点得到，截图 `.devflow-tmp/build-shots/t9-*.png` |
| T10 | 2026-11-19 16:07 | 468e871（失败的测试和骨架）、55cb1fa（实现、协议文档、记录） | 完成定义的 `go test -race -count=1 ./internal/session ./internal/server ./internal/chat -run 'TestChatTrust\|TestFSChatTrust\|TestWSCreateChatInWorktree\|TestWSCreateChatWorktreeUntrusted\|TestCreateChatUntrustedWorkdir\|TestWorkdirTrusted\|TestNoCredentialAccess'` 三行 `ok`（`TestChatTrust` 24 个子用例全 PASS）；`grep -rn "chat.WorkdirTrusted" vibe-remoted/internal/server` 无输出；逐条去掉实现里的判断做了 4 次变异核对，对应的反例用例都会失败；`chatTrust` 的取值在 protocol.go / protocol.ts / rest.ts / protocol.md 一致；`TMUX_TMPDIR=… make check` 第一次在 `internal/chat` 的 `TestStopAccountsForEveryQueuedMessage/restart` 失败（假 claude 启动时以 139 退出，本任务没有改这个包），单独跑这个包 3 次、重跑 `make check` 都通过（decisions #60） |
| T11 | 2026-11-19 16:18 | 192baa4（测试和实现）、54eac74（悬停行高的修复和检查、记录） | 完成定义的 `typecheck`+`test:worktree-dialogs`(12)+`test:chat-availability`(12)+`test:dialog-layout`+`test:i18n-parity`(291 键) 全退出 0；`npm test` 退出 0；`TMUX_TMPDIR=… make check` exit 0；`gui-smoke.mjs` 33 行 PASS、`gui-chat-smoke.mjs` 29 行 PASS，都无 FAIL。侧边栏布局检查新增「悬停时行高不变」：去掉修复时 `gui-smoke.mjs` 两处侧边栏检查 FAIL（`worktree row "fix-login" changes height from 20.5px to 24px`），加上后通过。真实 Electron 临时实例：在 worktree 行新建会话的对话框（对话可用、对话置灰带主目录原因的中英文）在 800×500、800×700、1100×803 下主按钮都在对话框和窗口内且点得到；隐藏目录下的 worktree 里建出对话会话（主目录被信任、该路径自己没有信任记录），同一 worktree 再开一个终端会话，两个名字不同；截图 `.devflow-tmp/build-shots/t11-*.png` |
| T12 | 2026-11-19 16:45 | 8df3bd1（daemon 一侧和改写的测试）、12bf2c0（确认框、接线、决定记录） | 完成定义的 `go test -race -count=1 ./internal/session ./internal/server -run 'TestDeleteSession\|TestDeleteOneOfTwo\|TestManagerDelete\|TestChatWorktreeAndFlags\|TestTerminalFramesUnchangedV3'` 两行 `ok`（实现之前新写和改写的 8 个用例全部 FAIL：409 `worktree_preserved`、目录或分支被删）；`go test -race ./...` 全包 `ok`；两条 grep 无输出；`typecheck`+`test:worktree-dialogs`(16)+`test:preserved-notice`+`test:i18n-parity`(295 键)+`test:dialog-layout` 退出 0，`npm test` 退出 0；`TMUX_TMPDIR=… make check` exit 0；`gui-smoke.mjs` 33 行 PASS、`gui-chat-smoke.mjs` 29 行 PASS，都无 FAIL，`^test(`=26、`check(`=17。真实 Electron 临时实例 800×500：删除会话确认框中英文各一张，两个按钮都在对话框和窗口内且点得到，初始焦点和默认描边在「取消」，回车后对话框关闭、会话数不变；截图 `.devflow-tmp/build-shots/t12-delete-session-zh-800x500.png`、`t12-delete-session-en-800x500.png` |
| T13 | 2026-11-19 17:32 | 0243312（失败的测试、协议类型和骨架）、aabb724（实现、REST、协议三处）、f798a28（变异核对后补的两个用例）、本行所在的提交（记录） | 完成定义的 `go test -race -count=1 ./internal/session ./internal/server -run 'TestDirtyFiles\|TestIgnoredFiles\|TestWorktreeStatus\|TestRemove\|TestRemoving\|TestCreateRefusedWhileWorktreeRemoving\|TestWorktreeRemoveEndpoint\|TestUnmergedCommits\|TestUndo\|TestGitNeverGetsShortBranchName\|TestNewEndpointsRequireToken\|TestManagedRequiresPathAndBranch'` 两行 `ok`；加上并发和 attach 的用例共 105 个用例和子用例 PASS、0 FAIL、0 SKIP（实现之前新写和改写的 41 个顶层用例全部 FAIL）；`go test -race ./...` 全包 `ok`；两条 grep 无输出；`typecheck`+`test:rest-projects`(11) 退出 0；三个类型的字段和可缺省性、五个新端点的方法和路径在 protocol.go / protocol.ts / rest.ts / server.go / protocol.md 一致，版本表第 4 行与 design 第 4 节开头逐项相同；`TMUX_TMPDIR=… make check` exit 0。变异核对：逐条去掉 30 处判断各跑一遍对应用例（白名单相等、`allow` 本身、必须在列表里的两层、主目录、`Single`、`managed`、两处 HEAD 核对、`update-ref -d` 的旧值、别处检出、嵌套 worktree、子模块、嵌入式仓库、锁定、会话比对、两种同意项、`--force`、失败后重查分类、两个方向的互斥、标记清除、会话结束失败、两处 tmux 对账、被忽略文件不算改动、`core.fsmonitor`、`-1`、T12 的删会话不动 worktree），28 处单独去掉即被发现；「必须是列出的 worktree 根」的两层各自单去时由另一层兜住、两层一起去掉被 `TestRemoveOnlyListedWorktrees` 发现；并发用例发现不了「去掉互斥」，那一条由卡时序的两个用例发现（decisions #67）。变异改动没有提交 |
| T14 | 2026-11-19 17:55 | 4aec1d1（测试、确认框、流程、接线）、911a02a（验证中发现的 daemon 缺口：删到一半剩下的目录查状态应是 404，#68）、e20ef60（默认按钮的样式）、cc179f8（决定和设计变更的记录）、本行所在的提交 | 完成定义的 `typecheck`+`test:worktree-dialogs`(46)+`test:sidebar`(20)+`test:dialog-layout`+`test:i18n-parity`(326 键) 退出 0（实现之前 `confirmDeleteWorktree is not a function`；`remove_result_closes_views` 在去掉 `index.ts` 接线时 FAIL）；`npm test` 退出 0；在 cc179f8 上：`TMUX_TMPDIR=… make check` exit 0，`gui-smoke.mjs` 33 行 PASS、`gui-chat-smoke.mjs` 29 行 PASS，都无 FAIL，`^test(`=26、`check(`=17。真实 Electron 临时实例（`allowed_roots` 只有 `/tmp` 下的临时目录）800×500 中英文：干净带被忽略文件、未提交文件、未合并提交、外部 worktree、下面有 2 个会话、文件加提交、detached、被锁定后带错误重开、409 后重新确认（正文滚动）、删到一半的失败说明，每个框都在窗口内，按钮都在框内且点得到，默认焦点与 design 一致；端到端：新建命名 worktree → 在会话里提交一次 → 删会话（目录、分支、提交都在）→ 删 worktree 回车执行「只删目录、保留分支」→ 目录没了、`git worktree list` 里没有它、分支仍指向那次提交。截图 `.devflow-tmp/build-shots/t14-*.png` |
| T15 | 2026-11-19 18:11 | 10723d8、本行所在的提交（记录） | 实现之前新写的 7 个用例里 `continue_note_shown`、`continue_note_counts`、`new_session_count_uses_workdir` 分别在三个测试脚本里第一个 FAIL（说明条不存在、`sessionCountAt` 没被调用）；实现之后完成定义的 `typecheck`+`test:session-form`(15)+`test:worktree-dialogs`(47)+`test:sidebar`(21)+`test:picker-layout`+`test:i18n-parity`(327 键) 退出 0，`npm test` 退出 0；`TMUX_TMPDIR=… make check` exit 0（在 10723d8 的代码上）。真实 Electron 临时实例（`allowed_roots` 只有 `/tmp` 下的临时目录）800×500 中英文：目录选择器和 worktree 行的新建会话对话框，目录里已有一个会话、勾了「续上次会话」→ 说明条出现、文字不溢出、整条在对话框正文里可见，对话框和两个按钮都在窗口内且点得到，确认按钮可用；取消勾选后说明消失；进到没有会话的子目录后说明消失。截图 `.devflow-tmp/build-shots/t15-*.png`（4 张） |

更正：T5 实际完成于 2026-11-19 12:39，T6a 13:11，T6b 14:04（以提交时间为准）。此后各行的时间用 `date '+%F %H:%M'` 取。

## 后续

spec「推迟到以后」的条目：

- E2 一个窗口里并排看 2 个会话（分屏）。
- E3 多个 macOS 窗口。
- E4 worktree 行上常驻显示「有未提交改动 / 领先 N 个提交」（本次只在删除确认时现查；放进列表会让 100 个 worktree 的列表超出 200 ms，见 decisions #7）。
- 为已存在的分支创建 worktree（本次新建 worktree 总是新建分支）。
- 新建 worktree 时选择基于哪个分支（本次固定基于发起处当前 HEAD）。

设计中发现、不在本次范围的改进：

- `internal/server` 的现有测试 `TestAttachIgnoresCommandFields`（`ws_chat_test.go`）在 `-race` 全包并发下偶发 panic（`argv[0]` index out of range）：它 `os.Stat` 看到假 claude 的 ArgvLog 文件存在后立即 `ReadFile`，存在「文件已建、内容还没写完」的读竞态。与本次改动无关（T1 单独跑 3 次全包、`make check` 复跑均通过）。以后可以在读取前等日志首行非空再解析。

- daemon 在 `git worktree add` 成功之后、会话登记之前崩溃：重放会得到 `worktree_branch_exists`，那个 worktree 以「没有会话」的行留在侧边栏；在 `worktree add` 和 `symbolic-ref` 两条命令之间崩溃，则留下一个 detached 的 worktree（按「外部」显示）和一个没被检出的同名分支（design 6.1 的已知窄窗口）。以后可以在启动时对账，或让重放认领自己刚建的 worktree。
- 有初始化过的子模块或嵌入式仓库的 worktree 不能从界面删除（d26、decisions #31），只能在终端里 `git worktree remove --force`。以后可以把子模块里未推送的提交数也查出来放进确认框，再放开。
- 里面嵌着同一仓库另一个 worktree 的 worktree，要先删里层才能删外层（decisions #29）。别的仓库的 worktree、或一个普通的 git 仓库嵌在被忽略的目录里时，daemon 认不出来：它在「被忽略的文件」那句说明里只算 1 个，会随外层一起删除。以后可以在被忽略的目录里找 `.git`，单独列出来。
- 子模块和 `--separate-git-dir` 的仓库里不能新建命名 worktree（decisions #19，spec H27）；它们的链接 worktree（包括旧的自动命名 Worktree 模式在其中建出来的）在侧边栏里各自显示成一个单独的项目，不能从界面删除，目录和 `vibe/<会话id>` 分支要手动清理。以后可以认出这类仓库真正的工作目录，把它们的 worktree 归到同一个项目下。
- 被锁定的 worktree、有子模块的 worktree、里面嵌着别的 worktree 的 worktree，现在要点了删除才知道删不了；可以让 status 带上这几个标志，在确认框打开时就说明。
- 会话行显示「最近活动的相对时间」（效果页 M1 上有，d10 去掉了）：需要协议给会话加最近活动时间，终端会话目前没有来源。
- 折叠的项目行把三种状态都上卷、取最紧急的一种（d11 只上卷「等你处理」）。
- 重载、交接、删除机器的系统 `confirm` 也换成应用内对话框（d15 只换了删除会话）。
- 给终端重新配一套 16 个 ANSI 色（d14 保留现值）；状态点压在选中行底色上的对比度不到 3:1（当前打开的会话不显示状态点，所以现在不会出现）。
- `/api/v1/info` 给每个启动选项下发「是否续接」字段，`-c` 说明就不必依赖 id 恰好叫 `continue`（d13）。
- `state_dir` 不可写时，命名 worktree 的创建记录重启后丢失、按「外部」处理（方向安全但会留下分支）。可以把记录另存一份到仓库的 git 配置，或在界面上提示 `state_dir` 不可写。
- 把 `/protocol-sync` 的三处比对做成脚本并接进 `make check`，协议漂移就能自动发现。
- 新建 worktree 对话框确认之后才出现的竞态错误（另一台桌面刚建了同名分支）只显示在状态栏（design 第 1 节方案 A 的代价）；其中「目录/文件」冲突的那一种，error 帧不带 `conflict`，状态栏只能写成「分支 … 已存在」。以后可以把这类错误带回对话框，并给 error 帧加上冲突的分支。
- 新流程建出的分支不跟随 `branch.autoSetupMerge`，`post-checkout` 钩子运行时 HEAD 还是 detached（design 6.1 第 9 步，d28）。有用户依赖这两点时，可以在 `symbolic-ref` 之后补写上游配置，或再触发一次钩子。
- `/api/v1/projects` 的补归属对一直失败的会话每轮重试、没有退避（design 5.4）。实际遇到大量这种会话时再加。
- 查 `go test -race ./...` 里 `internal/chat` 偶发卡住的原因（T6c 时 `make check` 卡了 10 分钟被外层超时杀掉，当时没有留下 goroutine 堆栈；单独跑这个包 18 秒通过，重跑 `make check` 通过；decisions #50）。下次遇到时给卡住的 `chat.test` 发 `SIGQUIT` 把堆栈留下来。
- 界面卡片（终端 / 对话）的键盘焦点环和「已选中」的描边是同一种样子（都是 `--accent` 的 2px 框）：对话框打开时焦点在「终端」上，用键盘或脚本选了「对话」之后两张卡片看起来都被选中。目录选择器原来就是这样，新对话框沿用了同一个段。T19 换形态时把两种状态做出区别。
- 扁平的 git 项目行上点「新建会话」，对话框标题用的是分支名（「在 dev 新建会话」），项目名在副标题里；可以考虑这种情况标题用项目名。
- 查 `internal/chat` 的 `TestStopAccountsForEveryQueuedMessage/restart` 偶发失败的原因（T10 时 `make check` 里出现 1 次：`claude exited during startup (code 139)`，假 claude 在重启后以 SIGSEGV 退出；单独跑 3 次和重跑 `make check` 都通过，decisions #60）。
- `UnmergedCommits`（T1 写的）走的是不带超时的 `gitAt`：查状态和删除前重查时，这一条 `git rev-list` 卡住会让请求一直不返回（其余几条都有 5 秒超时）。可以改走 `gitAtTimeout`，超时按 `git_failed` 处理。
- 并发用例 `TestConcurrentRemoveAndCreateOneWins` 发现不了「去掉删除与新建的互斥」这种改动（窗口太窄，12 轮撞不上），那一条现在靠两个卡时序的用例守着（decisions #67）。可以给它加一个只在测试里生效的让步点，把窗口撑开。
- 当前打开的会话被删除（删会话或删它所在的 worktree）而又没有别的已打开会话时，主区域是空白的，没有回到机器概览或空状态（`closeSession` 原来就是这样，T14 的收尾沿用了它）。
- 「删到一半失败」的说明框里，daemon 的 `message` 已经写了「目录还剩一部分、分支没删」，下面 `wt.delete.partial` 又说了一遍。可以让 daemon 的 `message` 只带 git 的输出，或在界面上合成一段。
- 删除 worktree 的确认框只写「会先结束这 N 个会话」，没有列出是哪几个（效果页上列了名字和类型）。可以把会话名列出来。
- 查 `gui-chat-smoke` R7 偶发失败的原因（AskUserQuestion 表单：`answers echoed: on": "Pick a fruit"`；T6b 提交后 3 次里失败 1 次，decisions #47）。
