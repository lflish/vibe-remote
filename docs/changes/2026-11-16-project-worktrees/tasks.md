# 任务：按项目和 worktree 组织会话，并更换视觉风格

依据：spec.md、design.md　共 20 个任务　更新：2026-11-18

## 约定

这些约定对所有任务生效，任务里不再重复。

- 接口的名字和签名以 design.md 第 4 节为准；任务里只写用到和提供的名字，章节号（如 4.2、6.1）都指 design.md。
- 改协议的任务（T4、T7、T8、T10、T12、T13）在同一个任务里把三处一起改完：`vibe-remoted/internal/protocol/protocol.go`、`desktop/src/shared/protocol.ts` 与 `desktop/src/renderer/rest.ts`、`docs/protocol.md`。这些任务的完成定义都包含「按 `/protocol-sync` 的核对清单逐项核对，三处无差异」。
- 新增的界面文案，中英文键在用到它的任务里一起加进 `desktop/src/renderer/i18n.ts`，键名和中文原文照 design 7.4「文案」表；`cd desktop && npm run test:i18n-parity` 必须通过。
- 新增的 desktop 测试脚本放 `desktop/scripts/`，写法同现有脚本（`chat-test-util.mjs` 的 `load()` 用 esbuild 打包后导入；需要 DOM 的用 jsdom），并在 `desktop/package.json` 里加 `test:<名字>` 且接进 `test` 这一串，所以 `make check` 会跑到。下文写成 `test-tree.mjs › 用例名`。
- Go 测试里的 git 仓库一律建在 `t.TempDir()` 里。涉及 tmux 的 Go 测试，命令前带独立的 `TMUX_TMPDIR=$(mktemp -d)`，不和本机正在用的 vibe-remote 会话共用 socket。完整检查因此写成 `TMUX_TMPDIR=$(mktemp -d) make check`。
- 每个任务的完成定义除了自己列的命令，都还包含：`TMUX_TMPDIR=$(mktemp -d) make check` 退出码为 0。
- 新写的 CSS 只用 `var(--…)`，不写颜色字面量（T18 会断言 `:root` 之外没有颜色字面量）；T18 之前的任务只追加新规则，不改现有规则的颜色和形态。
- 改了侧边栏或对话框结构的任务（T6、T9、T14、T19）负责同步调整 `.claude/skills/verify/scripts/gui-smoke.mjs`、`gui-chat-smoke.mjs` 里的选择器，用例数和断言不动（decisions #12）。
- 浏览器层的测试统一由 dev-test 写，实现任务负责加任务里列出的 `data-testid`。

## 测试计划

层级：「Go 单元」是包内直接调用函数；「Go 集成」是经 `httptest` 或真实 WebSocket 走 `internal/server`；「desktop 单元」是 `desktop/scripts/test-*.mjs`；「浏览器」是用 CDP 驱动构建产物；「协议冒烟」是不经界面、直接对临时 daemon 发 REST 和 WebSocket 帧。

示例值照 spec：机器 `this-mac`，项目 `devflow`（主目录在 `main`），外部 worktree `.devflow-tmp/worktrees/general-skills`（分支 `change/general-skills`）。

| 场景 | 层级 | 测试名 | 要点 | 谁写 |
|------|------|--------|------|------|
| R1.1 | Go 集成 | `TestProjectsTree` | 主目录 1 个对话会话、`fix-login` 1 个终端会话 → `projects[0].worktrees` 两项，`branch` 为 `main`、`fix-login`，各自的 `sessions` 含对应会话 id | T4 |
| R1.1 | desktop 单元 | `test-tree.mjs › two_worktrees_each_with_session`、`test-sidebar.mjs › renders_three_levels` | 树里 1 个项目 2 个 worktree 节点；DOM 里 2 个 `worktree-row`，两个 `session-row` 各在自己的 `.worktree-group` 里，带 `data-ui` 和 `data-dot` | T5、T6 |
| R1.1 | 浏览器 | R1.1 一个项目两个 worktree 都有会话 | `this-mac` 下有 `devflow`，其下两行显示 `main` 和 `fix-login`，会话行有界面类型图标和状态点 | dev-test |
| R1.2 | desktop 单元 | `test-tree.mjs › single_worktree_is_flat`、`test-sidebar.mjs › flat_project_has_no_worktree_row` | `new-api` 只有主目录、2 个会话 → `flat` 为真、`branchLabel` 是当前分支；DOM 里没有 `worktree-row`，`project-branch` 的文字是分支名 | T5、T6 |
| R1.2 | 浏览器 | R1.2 项目只有一个 worktree | 2 个会话直接列在 `new-api` 下，项目行显示分支名 | dev-test |
| R1.3 | Go 单元 | `TestResolveHomeNonGit` | 非 git 目录 `notes` → `Home{Project: 目录, Path: 目录, Git: false}` | T2 |
| R1.3 | Go 集成 | `TestProjectsNonGitProject` | `git:false`，`worktrees` 为 `[]`，会话在项目级 `sessions` 里，没有 `error` | T4 |
| R1.3 | desktop 单元 | `test-tree.mjs › non_git_project`、`test-sidebar.mjs › non_git_has_no_worktree_entries` | `flat` 为真、没有 `branchLabel`；DOM 里没有 `project-branch`、`project-new-worktree`、`project-menu` | T5、T6 |
| R1.3 | 浏览器 | R1.3 不在 git 仓库里的目录 | 会话在名为 `notes` 的项目下，没有 worktree 层和分支名 | dev-test |
| R1.4 | desktop 单元 | `test-tree.mjs › duplicate_names_get_numbers` | 同一 worktree 下 3 个 `title` 都是 `devflow` 的会话，按创建顺序得到 `devflow`、`devflow 2`、`devflow 3`；改过名的不加序号 | T5 |
| R1.4 | 浏览器 | R1.4 同一 worktree 下多个未改名的会话 | `main` 下先后开 3 个会话，3 行显示名互不相同 | dev-test |
| R1.5 | Go 集成 | `TestProjectsOrderStable` | 3 个项目共 8 个会话，连续请求 40 次，响应体逐字节相同；项目按小写名称、主目录在前其余按分支名、会话按 `created` 再按 id | T4 |
| R1.5 | desktop 单元 | `test-tree.mjs › keeps_daemon_order`、`legacy_order_sorted` | 新 daemon：不重排；旧 daemon：在桌面端按同样规则排，打乱输入 40 次结果相同 | T5 |
| R1.5 | 浏览器 | R1.5 顺序稳定 | 等 40 次轮询刷新，每次读侧边栏各行的顺序，全部相同 | dev-test |
| R1.6 | desktop 单元 | `test-tree.mjs › rollup_waiting_only`、`test-sidebar.mjs › collapsed_project_shows_waiting_dot` | 任一会话的点是 `waiting` → `projectRollup` 返回 `waiting`，只有 `idle` 或 `output` → `none`；折叠时项目行有 `project-dot`，展开后项目行没有、会话行 `data-dot="waiting"` | T5、T6 |
| R1.6 | 浏览器 | R1.6 折叠的项目里有会话在等用户 | 折叠 `devflow`，对话会话出现待答的权限请求 → 项目行有「等你处理」的点；展开后会话行有同样的点 | dev-test |
| R1.7 | desktop 单元 | `test-tree.mjs › session_context_and_notification_title`、`test-sidebar.mjs › toolbar_title_parts` | 通知标题 `this-mac · devflow / fix-login · 登录修复`，非 git 时 `this-mac · notes · <会话名>`；标题栏 `title-project`=`devflow`、`title-branch`=`fix-login`、`title-session`=`登录修复`，不含机器名 | T5、T6 |
| R1.7 | 浏览器 | R1.7 标题和通知带上项目与分支 | 顶部标题和后台会话触发的通知标题都含 `devflow`、`fix-login`、`登录修复` | dev-test |
| R1.8 | Go 单元 | `TestListWorktrees` | detached 的一项 `Detached` 为真、`Branch` 为空、`Head` 是 40 位哈希 | T2 |
| R1.8 | desktop 单元 | `test-tree.mjs › detached_label_is_short_hash` | `label` 是 7 位 `head`，不是空串 | T5 |
| R1.8 | 浏览器 | R1.8 worktree 当前不在任何分支上 | 该行显示提交的短哈希 | dev-test |
| R2.1 | Go 集成 | `TestProjectsListsSessionlessAndExternal` | 用 `git worktree add` 直接建的 `change/general-skills`（没有会话）在列表里，`sessions` 为 `[]`，没有 `managed` 和 `main` | T4 |
| R2.1 | desktop 单元 | `test-sidebar.mjs › empty_worktree_row` | 该行下有 `worktree-empty`（文字「没有会话」）和 `worktree-tag-external`；传了回调时有 `worktree-new-session` 按钮 | T6 |
| R2.1 | 浏览器 | R2.1 别的工具建的、没有会话的 worktree | `devflow` 下有一行 `change/general-skills`，标明没有会话，有「新建会话」入口 | dev-test |
| R2.2 | Go 单元 | `TestProjectStoreRoundTrip` | `AddProject` 后重新 `OpenProjectStore`，`Projects()` 仍含该 id | T3 |
| R2.2 | Go 集成 | `TestProjectsSurviveSessionDeletionAndRestart` | 删掉 `devflow` 的全部会话，再用同一个 `state_dir` 新建 `Manager` → `/api/v1/projects` 仍返回 `devflow` 和它的 2 个 worktree | T4 |
| R2.2 | 浏览器 | R2.2 项目的会话全部删除后 | 重启桌面端、重启 daemon 各一次，`devflow` 和 2 个 worktree 仍在侧边栏 | dev-test |
| R2.3 | Go 集成 | `TestRemoveProjectKeepsDisk`、`TestProjectReappearsAfterNewSession` | `POST /api/v1/projects/remove` → 204，列表里没有它；仓库目录、worktree 目录、分支都在；之后在仓库子目录新建会话，项目重新出现 | T4 |
| R2.3 | desktop 单元 | `test-sidebar.mjs › project_menu_remove` | 点 `project-menu` → `project-remove` → 调用 `removeProject` 回调一次，参数是项目 id | T6 |
| R2.3 | 浏览器 | R2.3 从侧边栏移除项目 | 移除后该项目不显示，磁盘不变；再在该仓库新建会话后重新出现 | dev-test |
| R2.4 | Go 集成 | `TestRemoveProjectWithSessions409`、`TestRemoveProjectNotFound` | 还有会话 → 409 `project_has_sessions`，清单不变；不在清单里 → 404 `project_not_found` | T4 |
| R2.4 | desktop 单元 | `test-sidebar.mjs › project_remove_disabled_with_sessions` | `project-remove` 是 `disabled`，旁边的说明是 `sidebar.project.removeBlocked` 的文字 | T6 |
| R2.4 | 浏览器 | R2.4 项目下有会话时不能移除 | 菜单项不可用，写明要先结束会话 | dev-test |
| R2.5 | Go 集成 | `TestProjectsPrunedWorktreeSessionsMoveUp` | 会话还在时在测试里执行 `git worktree remove --force` → 该 worktree 不在 `worktrees` 里，会话 id 出现在项目级 `sessions` | T4 |
| R2.5 | desktop 单元 | `test-tree.mjs › gone_sessions`、`test-sidebar.mjs › gone_session_meta` | git 项目、没有 `error`、会话在项目级列表里 → `gone` 为真；会话行第二行是 `session-gone`（「目录已不存在」） | T5、T6 |
| R2.5 | 浏览器 | R2.5 worktree 在别处被删掉 | 终端里执行 `git worktree remove` 后下一次刷新该行消失，原来的会话显示在项目下并标明目录已不存在 | dev-test |
| R2.6 | Go 集成 | `TestProjectsHidesWorktreesOutsideAllowedRoots` | `allow` 只放行仓库目录时，仓库外的 worktree 不在响应里 | T4 |
| R2.6 | 浏览器 | R2.6 worktree 不在允许的目录范围内 | daemon 的 `allowed_roots` 只含仓库本身，仓库外的 worktree 不出现在侧边栏 | dev-test |
| R2.7 | Go 集成 | `TestProjectsRepoMissing`、`TestProjectsGitFailed` | 清单里的仓库目录被删 → `error:"repo_missing"`；目录在但 git 失败或超时（`gitTimeout` 调成 50 ms，`PATH` 里放一个睡 1 秒的假 git）→ `error:"git_failed"`、`errorMessage` 非空；两种情况 `worktrees` 为 `[]`、会话全在项目级 `sessions` | T4 |
| R2.7 | desktop 单元 | `test-tree.mjs › project_error`、`test-sidebar.mjs › project_error_row_sessions_usable` | `project-error` 显示「读取失败：<原因>」或「仓库目录不存在」；该项目的 `session-row` 仍在，点它调用 `open` 回调 | T5、T6 |
| R2.7 | 浏览器 | R2.7 读不到 worktree 列表 | 删掉仓库目录后项目行显示读取失败和原因，已有会话照常能打开 | dev-test |
| R3.1 | Go 单元 | `TestCreateNamedWorktree` | `Name:"fix-login"`、发起处在 `main` → 分支 `fix-login` 指向 `main` 当前提交，目录是 `<仓库父目录>/devflow-worktrees/fix-login`，返回的 `Home.Project` 是主目录 | T7 |
| R3.1 | Go 集成 | `TestWSAttachWorktreeName` | attach 带 `mode:"worktree"`、`worktreeName:"fix-login"`、`ui:"chat"` → `ready.branch` 是 `fix-login`；`/api/v1/projects` 里出现该行，`managed:true`，`sessions` 含新会话 | T7 |
| R3.1 | desktop 单元 | `test-worktree-dialogs.mjs › new_worktree_confirm_resolves` | 填 `fix-login`、选「对话」、点 `dialog-confirm` → 先调一次 `planWorktree(主目录, "fix-login")`，再以 `{mode:"worktree", workdir: 主目录, ui:"chat", worktreeName:"fix-login", worktreePath: plan 的 path}` 结束 | T9 |
| R3.1 | 浏览器 | R3.1 新建成功 | 侧边栏 `devflow` 下出现 `fix-login`，其中打开了一个新的对话会话；磁盘上分支和目录都符合 | dev-test |
| R3.2 | Go 单元 | `TestWorktreeDirName`、`TestCreateNamedWorktree/slash` | `change/foo` → 分支 `change/foo`，目录名 `change-foo` | T7 |
| R3.2 | desktop 单元 | `test-worktree-name.mjs › dir_name` | `worktreeDirName("change/foo")` 是 `change-foo` | T9 |
| R3.2 | 浏览器 | R3.2 名字里有斜杠 | 侧边栏显示 `change/foo`，目录名是 `change-foo` | dev-test |
| R3.3 | Go 单元 | `TestValidateWorktreeName`、`TestWorktreeNameNeverReachesShell` | 读共用向量 `testdata/worktree-names.json`：空、`a b`、`a..b`、`-x`、`a~b` 都返回 `ErrInvalidWorktreeName`，`-x` 在任何 git 调用之前被拒；`$(touch${IFS}PWNED)` 这类名字不会生成文件 `PWNED` | T7 |
| R3.3 | Go 集成 | `TestPlanWorktree/invalid_name` | `name` 为空或不合法 → `ok:false`、`error:"invalid_worktree_name"`，仓库里没有新分支和目录 | T8 |
| R3.3 | desktop 单元 | `test-worktree-name.mjs › shared_vectors`、`test-session-form.mjs › invalid_name_disables_confirm` | 同一份向量在桌面端得到 `empty` / `whitespace` / `dotdot` / `leading_dash`；`wt-name-error` 显示对应文案，`dialog-confirm` 是 `disabled` | T9 |
| R3.3 | 浏览器 | R3.3 名字不合法 | 逐个输入空、含空格、含 `..`、以 `-` 开头、`a~b`，对话框内显示原因，确认按钮不可用，磁盘上没有新东西 | dev-test |
| R3.4 | Go 单元 | `TestCreateNamedWorktreeBranchExists` | 仓库已有分支 `fix-login` → `ErrWorktreeBranchExists`，目标目录不存在，原分支指向不变 | T7 |
| R3.4 | Go 集成 | `TestPlanWorktree/branch_exists` | `ok:false`、`error:"worktree_branch_exists"` | T8 |
| R3.4 | desktop 单元 | `test-worktree-dialogs.mjs › plan_rejection_keeps_dialog_open` | 确认时 plan 返回 `worktree_branch_exists` → `wt-name-error` 显示「分支 fix-login 已存在」，对话框还在，Promise 未结束；改名后再点能成功 | T9 |
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
| R3.8 | Go 单元 | `TestCreateNamedWorktreeGitFailureLeavesNothing` | 容器目录 `devflow-worktrees` 预先建成只读（0555）让 `git worktree add` 失败 → 返回的错误含 git 的输出；分支 `fix-login` 不存在，目标目录不存在，`ProjectStore` 里没有记录 | T7 |
| R3.8 | Go 集成 | `TestWSAttachWorktreeCreateFailed` | 同样的失败 → error 帧 `code:"create_failed"`、`fatal:true`、`message` 含 git 输出；`/api/v1/projects` 里没有新行 | T7 |
| R3.8 | 浏览器 | R3.8 创建失败 | 容器目录只读时确认 → 显示 git 的错误信息，侧边栏不出现新行，磁盘上没有半截目录或分支 | dev-test |
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
