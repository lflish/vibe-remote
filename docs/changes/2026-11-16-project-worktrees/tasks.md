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
| R5.4 | Go 单元 | `TestDirtyFiles/ignored_only`、`TestRemoveIgnoredOnlyIsClean` | 只有被忽略的 `node_modules/` → `dirtyFiles` 是 0；不带 `discardFiles` 就能删掉目录 | T13 |
| R5.4 | 浏览器 | R5.4 只有被 git 忽略的文件 | 确认框是「干净」的那一种，没有丢弃文件的警告 | dev-test |
| R5.5 | Go 单元 | `TestUnmergedCommits` | 分支上 2 个独有提交 → 2；被另一个本地分支包含后 → 0；被远程跟踪引用包含后 → 0 | T1 |
| R5.5 | Go 单元 | `TestRemoveUnmergedNeedsConsent` | `unmergedCommits` 是 2：不带 `deleteBranch` → 目录被删、分支和 2 个提交都在、`branchDeleted:false`；`deleteBranch:true` 而没有 `dropCommits` → `WorktreeChangedError`，什么都没动；两个都带 → 分支被删 | T13 |
| R5.5 | desktop 单元 | `test-worktree-dialogs.mjs › delete_wt_commits` | `data-variant` 是 `commits`；`delete-wt-commits` 含「2」；`delete-wt-keep-branch` 预选，回车发出的请求没有 `deleteBranch`；改选 `delete-wt-delete-branch` 后请求是 `deleteBranch:true, dropCommits:true` | T14 |
| R5.5 | 浏览器 | R5.5 有未合并的提交 | 确认框写明 2 个未合并提交，默认选「只删目录、保留分支」；确认后目录消失、分支仍在 | dev-test |
| R5.6 | Go 单元 | `TestRemoveEndsSessionsFirst` | `fix-login` 下 2 个运行中的会话：请求的 `sessions` 含这 2 个 id → `endedSessions` 是这 2 个，会话表里没有它们，目录被删；请求里少一个 id → `WorktreeChangedError`，返回的状态里 `sessions` 有 2 个，没有会话被结束 | T13 |
| R5.6 | desktop 单元 | `test-worktree-dialogs.mjs › delete_wt_sessions_line`、`test-sidebar.mjs › remove_result_closes_views` | `delete-wt-sessions` 的文字是「会先结束这 2 个会话。」；请求的 `sessions` 与 status 的相同；删除成功后 `endedSessions` 里的会话视图被关闭 | T14 |
| R5.6 | 浏览器 | R5.6 worktree 下还有会话 | 确认框写明会先结束这 2 个会话；确认后两个会话都结束，worktree 按 R5.2 处理 | dev-test |
| R5.7 | Go 单元 | `TestRemoveMainRefused` | `path` 是主目录 → `ErrWorktreeIsMain`（HTTP 400 `worktree_is_main`），主目录原样 | T13 |
| R5.7 | desktop 单元 | `test-sidebar.mjs › main_worktree_has_no_menu` | 带 `worktree-tag-main` 的那一行没有 `worktree-menu` 按钮 | T6 |
| R5.7 | 浏览器 | R5.7 主目录不能删 | 主目录这一行的操作里没有「删除 worktree」 | dev-test |
| R5.8 | Go 单元 | `TestManagedRequiresPathAndBranch`、`TestManagedLegacyVibeBranch` | 记录的路径相同但当前分支不同 → 不是 `managed`；`<仓库>-worktrees/<会话id>` 加分支 `vibe/<会话id>` → 是；`<仓库>-worktrees/foo` 加分支 `vibe/foo`（`foo` 不满足 `ValidSessionID`）→ 不是 | T3 |
| R5.8 | Go 单元 | `TestRemoveExternalNeverDeletesBranch` | 外部 worktree `change/general-skills`，请求带 `deleteBranch:true, dropCommits:true` → 目录被删，分支 `change/general-skills` 仍在，`branchDeleted:false`；它有 3 个未提交文件时同样要 `discardFiles` | T13 |
| R5.8 | desktop 单元 | `test-worktree-dialogs.mjs › delete_wt_external` | `data-variant` 是 `external`；`delete-wt-external` 的文字含「不是由 vibe-remote 创建」和分支名；没有两个单选；请求里没有 `deleteBranch` | T14 |
| R5.8 | 浏览器 | R5.8 不是 vibe-remote 创建的 worktree | 确认框标明不是由 vibe-remote 创建；确认后目录消失，`git branch --list change/general-skills` 仍有一行 | dev-test |
| R5.9 | Go 单元 | `TestRemoveGitFailureKeepsState` | 先 `git worktree lock` 让 `git worktree remove` 失败 → HTTP 500 `worktree_remove_failed`，`message` 含 git 的输出；目录、分支、`ProjectStore` 记录都在 | T13 |
| R5.9 | desktop 单元 | `test-worktree-dialogs.mjs › delete_flow_500_reopens_with_error` | `removeWorktree` 抛 500 → 同一个确认框再次打开，`delete-wt-error` 显示「删除失败：<git 的输出>」；`deleteWorktreeFlow` 在用户取消后返回 null | T14 |
| R5.9 | 浏览器 | R5.9 删除失败 | 把 worktree 锁住后删除 → 对话框内显示 git 的错误信息，worktree 行和磁盘状态不变 | dev-test |
| R5.10 | Go 集成 | `TestDeleteCleanWorktreeWithUnmergedCommitsReturns409`（过渡，T12 时删除） | T1 的过渡行为：工作区干净、分支有 2 个未合并提交 → 409 `worktree_preserved`，目录、分支、提交都在 | T1 |
| R5.10 | Go 集成 | `TestDeleteSessionNeverReturnsPreserved` | 只发 `DELETE /api/v1/sessions/{id}`（旧桌面端的做法）：干净加 2 个未合并提交、有未提交文件各一例 → 都是 204，目录和分支都在 | T12 |
| R5.10 | 协议冒烟 | R5.10 旧版桌面端删会话不丢提交 | 用 `change/dual-mode` 基线的 `ws-smoke.mjs` 的删除步骤连新 daemon：删除成功，worktree 目录和分支都保留 | dev-test |
| R5.11 | Go 单元 | `TestUnmergedCommits/detached` | `branch` 传空：detached 的 `HEAD` 上 2 个不属于任何分支的提交 → 2 | T1 |
| R5.11 | Go 单元 | `TestRemoveDetachedNeedsConsent` | status：`detached:true, unmergedCommits:2`；不带 `dropCommits` → `WorktreeChangedError`；带上 → 目录被删。没有这样的提交且干净 → 不带任何同意项就能删 | T13 |
| R5.11 | desktop 单元 | `test-worktree-dialogs.mjs › delete_wt_detached`、`delete_wt_detached_clean` | 有提交：`data-variant` 是 `detached`，文字是「这 2 个提交删除后不再属于任何分支，无法恢复。」，初始焦点在 `dialog-cancel`，`delete-wt-force` 发出 `dropCommits:true`；没有提交：`data-variant` 是 `clean`，文字是 `wt.delete.cleanDetached`，请求没有同意项 | T14 |
| R5.11 | 浏览器 | R5.11 worktree 不在任何分支上 | 确认框写明这 2 个提交删除后不再属于任何分支，回车 = 取消；点「仍然删除」才删除 | dev-test |
| R6.1 | desktop 单元 | `test-session-form.mjs › continue_note_shown`、`test-worktree-dialogs.mjs › continue_note_counts` | 已有会话数是 1 且勾选 id 为 `continue` 的选项 → `continue-note` 出现，文字是 `wt.session.continueNote`，`dialog-confirm` 不是 `disabled`；取消勾选后消失。`openWorktreeSessionDialog` 传该 worktree 的会话数；目录选择器普通模式传 `workdir` 等于当前所列目录的会话数；Worktree 模式和新建 worktree 对话框传 0 | T15 |
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
| R8.3 | 浏览器 | R8.3 现有功能入口都在 | 跑 `gui-smoke.mjs` 和 `gui-chat-smoke.mjs`：全部通过；与 `change/dual-mode` 基线逐个对比，用例数不减少（`gui-chat-smoke.mjs` 基线 26 个 `test(`）、断言不放宽，只有选择器有改动 | dev-test |
| R8.4 | desktop 单元 | `test-theme-tokens.mjs › contrast_table`、`dot_shapes_differ` | 从 `styles.css` 的 `:root` 解析变量，按 `evidence/contrast-m1.txt` 的 35 对计算：正文和按钮文字 ≥ 4.5，次要文字 ≥ 3，三种状态点对 `--bg-sidebar` ≥ 3；`.session-unread.output`（空心）、`.idle`（实心）、`.waiting`（实心加光圈）的形状属性两两不同 | T18 |
| R8.4 | 浏览器 | R8.4 可读性 | 在运行中的应用里读真实元素的 `color` 和实际背景色（含 `color-mix` 算出来的），达到同样的比值；三种状态点在侧边栏上同时出现时形状可区分 | dev-test |
| R8.5 | desktop 单元 | `test-dialog-layout.mjs` | `dirpicker.ts`、`worktree-dialogs.ts` 里每个对话框只往 `.modal` 里放标题、`.modal-body`、`.modal-footer` 三个直接子元素 | T19 |
| R8.5 | 浏览器 | R8.5 小窗口和双语 | 新写 `.claude/skills/verify/scripts/shell-layout.mjs`：视口 800×500，中英文各一遍，打开侧边栏（三层加长分支名）、新建会话对话框、新建 worktree 对话框、删除确认框的每种形态、斜杠菜单；对话框整体在窗口内，主按钮在窗口内且 `elementFromPoint` 命中它，没有设省略号的文字 `scrollWidth <= clientWidth`，同一行相邻元素的矩形不相交 | dev-test |
| R8.6 | desktop 单元 | `test-theme-tokens.mjs › window_background_matches_bg_app` | `desktop/src/main/index.ts` 的 `backgroundColor` 等于 `styles.css` 的 `--bg-app`，值是 `#EFEFF4` | T18 |
| R8.6 | 浏览器 | R8.6 启动不闪 | 冷启动后第一帧截图的窗口底色是 `#EFEFF4`，没有旧的米色（`#F5F4EF`）或深色 | dev-test |
| R9.1 | desktop 单元 | `test-tree.mjs › legacy_groups_by_session_fields`、`capability_transitions` | `projects` 为 `null`：`mode:"worktree"` 的会话归到 `sourceRepo` 项目下的 `worktreeRoot` 行（`label` 是 `branch`），其余按 `workdir` 归位，不出现没有会话的 worktree；`nextCapability`：数组 → `v4`，`null` → `legacy`，`Error` → 保持上一个 | T5 |
| R9.1 | desktop 单元 | `test-chat-availability.mjs › proto3_daemon_supports_chat` | `info.proto` 是 3、`chat.supported` 为真 → 对话可用（用 `CHAT_MIN_PROTO` 判断，不因 `PROTOCOL_VERSION` 升到 4 而置灰） | T4 |
| R9.1 | desktop 单元 | `test-sidebar.mjs › legacy_note_and_disabled_entries` | 能力状态是 `legacy`：有 `machine-legacy-note`；`project-new-worktree` 和 `worktree-delete` 是 `disabled`，提示是「需要升级这台机器的 vibe-remoted」；`unknown`：同样置灰，没有说明 | T6 |
| R9.1 | desktop 单元 | `test-session-form.mjs › picker_proto3_has_no_name_segment` | `info.proto` 是 3 时目录选择器的 Worktree 模式没有 `wt-name-input`，确认后返回值里没有 `worktreeName` | T9 |
| R9.1 | desktop 单元 | `test-worktree-dialogs.mjs › delete_session_legacy_note` | `legacyWorktree` 为真 → `delete-session-note` 的文字是 `session.delete.legacyWorktree`（写明旧版会在工作区干净时一并删除 worktree 和分支），同时传了 `worktreeLabel` 也以它为准 | T12 |
| R9.1 | desktop 单元 | `test-legacy-daemon.mjs` | 渲染进程入口连一个假的协议 3 daemon（`/api/v1/projects` 返回 404，`info.proto` 是 3）：侧边栏按项目和 worktree 分组；有说明条；两个入口置灰；删除 worktree 会话的确认框是旧版文案；409 `worktree_preserved` 仍显示「Worktree 已保留」 | T17 |
| R9.1 | 浏览器 | R9.1 新桌面端 + 旧 daemon | 用 `change/dual-mode` 构建的 daemon（协议 3）：侧边栏分组显示已有会话，不显示没有会话的 worktree；新建 worktree、删除 worktree 置灰并提示升级；机器概览的 Worktree 模式没有名字输入框、分支自动命名；删除 worktree 会话的确认框是旧版文案；新建、输入、重连照常 | dev-test |
| R9.2 | Go 集成 | `TestAttachWorktreeWithoutNameKeepsLegacyNaming` | attach 带 `mode:"worktree"`、没有 `worktreeName` → 分支 `vibe/<会话id>`，目录 `<仓库父目录>/<仓库名>-worktrees/<会话id>`，`ready` 的字段与协议 3 相同 | T7 |
| R9.2 | Go 集成 | `TestTerminalFramesUnchangedV3`（现有，测试文件和 golden 一个字不改）、`TestV3ClientFlowAgainstV4Daemon` | 终端会话的帧除 `proto` 外逐字节不变；只用协议 3 的帧和端点走一遍新建、接入、重命名、删除，全部成功 | 现有、T17 |
| R9.2 | 协议冒烟 | R9.2 旧桌面端 + 新 daemon | 用 `change/dual-mode` 基线的 `ws-smoke.mjs` 和基线桌面端构建产物的 `gui-smoke.mjs` 连新 daemon：新建、接入、删除照常；Worktree 模式新建成功，分支是 `vibe/<会话id>` | dev-test |
| 性能 | Go 集成 | `TestProjectsOneGitCallPerProject`、`TestSessionsEndpointRunsNoGit` | 20 个项目各 5 个 worktree：一次 `/api/v1/projects` 恰好启动 20 个 git 进程、同时在跑的不超过 8 个；`/api/v1/sessions` 启动 0 个 git 进程 | T4 |
| 性能 | 协议冒烟 | 性能：20 项目 × 5 worktree | 临时 daemon 上各请求 15 次，`/api/v1/projects` 的中位数 ≤ 200 ms，`/api/v1/sessions` 的中位数与没有这些项目时相差 ≤ 200 ms；数字记进 test-report.md | dev-test |
| 安全 | Go 集成 | `TestNewEndpointsRequireToken` | `GET /api/v1/projects`、`POST /api/v1/projects/remove`、`GET /api/v1/worktrees/plan`、`GET /api/v1/worktrees/status`、`POST /api/v1/worktrees/remove` 不带或带错 token 都是 401；每个端点落地时往这张表里加一行 | T4、T8、T13 |

### 容易出问题的情况

| 情况 | 合理的预期 | 测试 | 谁写 |
|------|------------|------|------|
| 新建命名 worktree，`ready` 之前断线，客户端带同一个 `newSessionId` 和 `worktreeName` 重放（自动重连、手动重试、两次并发） | 只有一个 `fix-login` worktree、一个分支、一个会话；第二次 attach 收到同一个 `sessionId` 的 `ready`，不是 `worktree_branch_exists` | `TestNamedWorktreeReplaySameID`、`test-attach-replay.mjs › replay_carries_worktree_name` | T7 |
| 两个不同的 `newSessionId` 并发新建同名 worktree `fix-login` | 恰好一个成功；另一个收到 fatal `worktree_branch_exists`；成功那个的分支和目录完好，`git worktree list` 里只有一个 `fix-login`；用 `-race` 跑 20 轮结果相同 | `TestConcurrentCreateSameNameOneWins` | T7 |
| git 先建出分支、随后失败（目标的父目录不可写；design 前置验证 V3 实测会留下分支） | 返回 `create_failed` 和 git 的错误输出；`git show-ref refs/heads/fix-login` 找不到；目标目录不存在；本次新建的空容器目录被删掉；`ProjectStore` 里没有记录 | `TestCreateNamedWorktreeGitFailureLeavesNothing` | T7 |
| 目标目录已经存在但是空的（V3 实测 git 会直接用它） | daemon 自己拒绝：`worktree_path_exists`；空目录还在、没有被 git 用掉，没有新分支 | `TestCreateNamedWorktreePathExists/empty_dir` | T7 |
| worktree 建好之后会话启动失败（例如对话进程起不来） | worktree 目录和分支被回滚，`ProjectStore` 的创建记录被删掉，侧边栏不出现新行 | `TestNamedWorktreeRolledBackWhenSessionStartFails` | T7 |
| 用户看到确认框之后、点确认之前，worktree 里多了一个未提交的文件 | 409 `worktree_changed`，响应体里的 `status.dirtyFiles` 是 1；目录、分支、文件都在，没有会话被结束；桌面端用新状态重新弹确认框，`delete-wt-changed` 可见 | `TestRemoveChangedSinceStatus/new_file`、`test-worktree-dialogs.mjs › delete_flow_409_reconfirms` | T13、T14 |
| 确认框打开之后分支上多了一个提交（`head` 变了） | 409 `worktree_changed`，`status.head` 是新的哈希；什么都没删 | `TestRemoveChangedSinceStatus/head_moved` | T13 |
| 确认框打开之后该 worktree 下又新建了一个会话 | 409 `worktree_changed`，`status.sessions` 含新会话；没有任何会话被结束 | `TestRemoveChangedSinceStatus/new_session` | T13 |
| 重查通过之后、`git worktree remove` 执行之前出现新文件，git 以「contains modified or untracked files」拒绝 | 409 `worktree_changed` 加最新状态，不是 500；目录还在 | `TestRemoveGitRefusesNewFiles` | T13 |
| daemon 重启后，会话的归属还在 | 终端会话：重启后 `Projects()` 里它仍在原来的 worktree 行下（tmux 用户选项 `@vibe_remote_project`、`@vibe_remote_home`）；在终端里 `cd /tmp` 之后也不换位置。对话会话：从 `chat-sessions.json` 读回 `project`、`home` | `TestHomeSurvivesRestartTmux`、`TestHomeDoesNotFollowCd`、`TestChatRecordHomeRoundTrip` | T2 |
| daemon 重启后，「由 vibe-remote 创建」的记录和项目清单还在 | 用同一个 `state_dir` 重新打开：`fix-login` 仍是 `managed:true`，会话已删光的 `devflow` 仍在列表里 | `TestProjectStoreRoundTrip`、`TestProjectsSurviveSessionDeletionAndRestart` | T3、T4 |
| 升级前留下的会话没有归属字段 | 第一次 `Projects()` 时补一次：worktree 会话归到 `@vibe_remote_worktree_root`，其余按当时的 `pane_current_path` 推导；补出来的 git 项目进清单；对话记录在 `LoadChats` 里补并落盘 | `TestBackfillHomeForLegacyTmuxSessions`、`TestBackfillHomeForLegacyChatRecords` | T4 |
| `state_dir` 不可写 | daemon 正常启动，终端会话照常；`/api/v1/projects` 只返回现存会话所在的项目；新建命名 worktree 成功，本次运行期间是 `managed:true`；重启后它变成外部 worktree，能删目录、分支保留 | `TestProjectsWithUnwritableStateDir`、`TestMemoryProjectStore` | T4、T3 |
| `projects.json` 损坏或 `version` 不是 1 | 文件被改名为 `projects.json.corrupt-<unix 时间>`，按空清单启动，日志有一行说明；之后的写入生成新的 `projects.json` | `TestProjectStoreCorruptFileRenamed` | T3 |
| 清单里的仓库目录被删除，但它下面还有会话 | 项目行 `error:"repo_missing"`，会话全部在项目级 `sessions` 里，仍能打开、输入、删除；其他项目不受影响 | `TestProjectsRepoMissing`、`test-sidebar.mjs › project_error_row_sessions_usable` | T4、T6 |
| git 卡住不返回 | 5 秒后该项目按 `git_failed` 返回，其余项目正常；连续轮询 3 次后 git 进程不堆积 | `TestProjectsGitFailed`、`TestGitTimeoutKillsProcess` | T4、T2 |
| 仓库有一个 worktree 在 `allowed_roots` 之外 | 列表里没有它；对它调 status 或 remove 返回 404 `worktree_not_found`，而且 daemon 没有对这个路径运行 git | `TestProjectsHidesWorktreesOutsideAllowedRoots`、`TestRemoveOnlyListedWorktrees/outside_allowed_roots` | T4、T13 |
| remove 的 `path` 不是 daemon 读到的 worktree（任意目录、主目录里的子目录、带 `..` 的路径） | 404 `worktree_not_found`，磁盘不变 | `TestRemoveOnlyListedWorktrees` | T13 |
| 伪造 `.git` 文件，让一个目录自称是受信任仓库的 worktree | `ChatTrust` 返回 `untrusted`，在里面新建对话会话被拒 | `TestChatTrust/forged_gitfile` | T10 |
| 协议 3 的桌面端删除 worktree 会话（只发 `DELETE /api/v1/sessions/{id}`） | 204；目录和分支都在；之后在新桌面端的侧边栏里这一行标「没有会话」，可以继续用或单独删除 | `TestDeleteSessionNeverReturnsPreserved`、`TestV3ClientFlowAgainstV4Daemon` | T12、T17 |
| 同一个 worktree 下有 2 个会话，删掉其中一个 | 另一个会话脚下的目录还在，仍能输入 | `TestDeleteOneOfTwoSessionsKeepsWorktree` | T12 |
| 用户在 vibe-remote 建的 worktree 里切到了别的分支，然后删除它 | 不再是 `managed`：只删目录，原来的分支和切过去的分支都保留 | `TestManagedRequiresPathAndBranch`、`TestRemoveExternalNeverDeletesBranch/switched_branch` | T3、T13 |
| 两次轮询之间新建或删除了会话，`/api/v1/sessions` 和 `/api/v1/projects` 的内容对不上 | 树里引用了、会话列表里没有的 id 被跳过；会话列表里有、树里没有引用的会话按旧版规则临时归位；不抛错，下一轮恢复一致 | `test-tree.mjs › tolerates_stale_ids`、`unreferenced_session_placed_by_legacy_rule` | T5 |
| `/api/v1/projects` 某一轮请求失败（网络抖动） | 能力状态和侧边栏的树保持上一轮的样子，不闪成旧版分组，也不清空 | `test-tree.mjs › capability_transitions`、`test-sidebar.mjs › keeps_tree_when_projects_request_fails` | T5、T6 |
| 侧边栏正在内联重命名时到了下一轮刷新 | 不重绘，输入框和已输入的字还在（现有保护保留） | `test-sidebar.mjs › no_rerender_while_renaming` | T6 |
| 名字输入框连续输入，较早的 `planWorktree` 请求比较晚的后返回 | 界面显示最后一次输入对应的结果 | `test-session-form.mjs › last_plan_wins` | T9 |

## 任务

顺序：T1 是可以单独合并的先行修复；T2–T6 跑通最小闭环（daemon 下发项目和 worktree → 侧边栏分组显示）；T7–T9 新建命名 worktree；T10–T11 在已有 worktree 里开会话；T12–T14 会话与 worktree 分开收尾；T15 `-c` 说明；T16 快捷键；T17 降级核对；T18–T19 视觉 M1；T20 规则文件（等 c3）。

`desktop/src/renderer/index.ts` 只在 T6 做一次结构性改动（把侧边栏搬到 `sidebar.ts`），之后的任务每个只往里加一个回调和一小段接线。`desktop/src/renderer/styles.css` 在 T6–T15 只追加新规则，T18 统一换配色，T19 统一换形态。

### T1 先行修复：分支有未合并提交时，删会话不删分支
- 状态：待办
- 文件：修改 `vibe-remoted/internal/session/worktree.go`（新增 `UnmergedCommits`；`CleanupWorktree` 里两处会执行 `git branch -D` 的路径之前先查）；测试 `vibe-remoted/internal/session/worktree_test.go`、`vibe-remoted/internal/server/worktree_test.go`。不改桌面端、不改协议、不改任何现有测试。
- 接口：
  - 使用：`gitAt(dir, args...)`、`WorktreePreservedError`、`RollbackWorktree(meta)`（都是现有的）
  - 提供：`UnmergedCommits(repoDir, branch string) (int, error)`，`branch` 为空表示 `repoDir` 的 `HEAD`；命令见 design 第 3 节「未合并提交数」
- 场景：R5.5（H9 的判定）、R5.10（过渡行为，d5）、R5.11（detached 的计数）
- 测试：
  - `TestUnmergedCommits`：分支 `fix-login` 上 2 个独有提交 → 2；另建一个本地分支指向它之后 → 0；只被 `refs/remotes/origin/fix-login` 包含 → 0；子测试 `detached`：`branch` 传空，detached 的 `HEAD` 上 2 个不属于任何分支的提交 → 2
  - `TestCleanupKeepsCleanWorktreeWithUnmergedCommits`：工作区干净、分支有 2 个未合并提交 → 返回 `*WorktreePreservedError`；目录在，分支在，`git rev-list --count main..<分支>` 是 2
  - `TestCleanupKeepsBranchWhenWorktreeDirMissing`：worktree 目录已被 `rm -rf`、分支有 2 个未合并提交 → 返回 `*WorktreePreservedError`，分支在
  - `TestCleanupFailsClosedWhenUnmergedCheckFails`：`UnmergedCommits` 执行失败（`meta.SourceRepo` 指向不存在的目录）→ 返回错误，目录和分支都没有被删
  - `TestDeleteCleanWorktreeWithUnmergedCommitsReturns409`（server）：`DELETE /api/v1/sessions/{id}` → 409，响应体 `error` 是 `worktree_preserved`，`worktreeRoot`、`branch` 是该会话的值
  - 现有的 `TestWorktreeCleanCleanupRemovesWorktreeAndBranch`、`TestWorktreeDirtyCleanupPreservesBoth`、`TestWorktreeIgnoredFileIsPreserved`、`TestDeleteDirtyWorktreeReturnsStructuredConflict` 不改、照常通过
- 完成定义：
  - `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/session ./internal/server -run 'TestUnmergedCommits|TestCleanup|TestWorktree|TestDelete'` 输出两行 `ok`
  - 这个任务是单独的一个提交，`git show --stat HEAD` 只列出上面 3 个文件；提交可以不带后续任务直接挑到 `change/dual-mode` 上，挑过去后 `make check` 通过
- 依赖：无

### T2 daemon：读 worktree 列表，创建会话时记下归属
- 状态：待办
- 文件：修改 `vibe-remoted/internal/session/worktree.go`（`Worktree`、`ListWorktrees`、`Home`、`ResolveHome`、`gitAtTimeout`、包级变量 `gitTimeout`）；`vibe-remoted/internal/session/runner.go`（`RunnerConfig.Project/Home`、`Runner.Home()`、`start` 里写 tmux 用户选项 `@vibe_remote_project` 和 `@vibe_remote_home`、`list-sessions` 格式串加到 11 列、`parseTmuxSessionLine` 接受 8、9、11 列）；`vibe-remoted/internal/session/manager.go`（`CreateOptions.Home`、创建时算归属、reconcile 找回会话时读回两个选项）；`vibe-remoted/internal/session/chat_manager.go`（创建对话会话时算归属并写进记录，`Handoff` 把对话会话的归属传给新终端会话）；`vibe-remoted/internal/chat/store.go`（`Record.Project`、`Record.Home`，`omitempty`，`version` 仍是 1）。测试 `worktree_test.go`、`runner_test.go`、`manager_test.go`、`chat_manager_test.go`、`vibe-remoted/internal/chat/store_test.go`
- 接口：
  - 使用：`gitAt`、`CreateWorktree(sourceWorkdir, sessionID)`（现有签名，T7 才改）、`WorktreeMetadata`
  - 提供：`type Worktree struct { Path, Branch, Head string; Detached, Bare, Prunable bool }`；`ListWorktrees(dir string) ([]Worktree, error)`；`type Home struct { Project, Path string; Git bool }`；`ResolveHome(dir string) Home`；`gitAtTimeout(dir string, args ...string)`；`(r *Runner) Home() (project, home string)`；`CreateOptions.Home *Home`；`chat.Record.Project`、`chat.Record.Home`
  - 归属的规则（design 5.1、H19）：普通模式是 `ResolveHome(workdir)`；worktree 模式 `home` 是新 worktree 的根、`project` 是 `ResolveHome(meta.SourceRepo).Project`；交接出来的终端会话照抄对话会话的归属；之后不随 `cd` 变。`/api/v1/sessions`、`sessions` 帧、`ready` 帧不加任何字段
- 场景：R1.3、R1.8、R4.2
- 测试：
  - `TestListWorktrees`：第一项是主目录，从链接 worktree 里、从符号链接路径调用时第一项的路径相同且是规范路径；detached 的一项 `Detached` 为真、`Branch` 为空、`Head` 是 40 位；目录被删的一项 `Prunable` 为真；裸仓库第一项 `Bare` 为真；`<仓库>/.devflow-tmp/worktrees/general-skills` 这样的隐藏目录照常列出
  - `TestResolveHome`：主目录 → `Project` 和 `Path` 都是主目录；主目录的子目录 → `Path` 是主目录；链接 worktree 的子目录 → `Project` 是主目录、`Path` 是该 worktree 的根；`TestResolveHomeNonGit`：`notes` 目录 → `Git` 为假，`Project` 和 `Path` 都是目录本身
  - `TestGitTimeoutKillsProcess`：`gitTimeout` 调成 50 ms，`PATH` 里放一个睡 5 秒的假 git → 1 秒内返回错误，假 git 进程已不存在
  - `TestWorktreeModeHome`：worktree 模式新建 → `runner.Home()` 的 `home` 是新 worktree 的根，`project` 是源仓库主目录
  - `TestCreateInHiddenWorktreeDir`：在 `.devflow-tmp/worktrees/general-skills` 新建普通会话 → `home` 是该目录
  - `TestParseTmuxSessionLineColumns`：8、9、11 列的行都解析成功，11 列时读出 `project`、`home`；10 列被拒
  - `TestHomeSurvivesRestartTmux`（需要 tmux）：建会话后新建一个 `Manager`，`List()` 找回的会话 `Home()` 与重启前相同
  - `TestHomeDoesNotFollowCd`（需要 tmux）：会话里执行 `cd /tmp` 后由新的 `Manager` 找回 → `workdir` 变成 `/tmp`（现有行为），`Home()` 不变
  - `TestChatRecordHomeRoundTrip`：带 `project`、`home` 的记录写盘再读回相同；没有这两个字段的旧文件能读，字段为空
  - `TestHandoffCopiesHome`：对话会话在 worktree `fix-login` 里，交接出来的终端会话 `Home()` 与它相同（即使 `workdir` 是子目录）
- 完成定义：
  - `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/session ./internal/chat -run 'TestListWorktrees|TestResolveHome|TestGitTimeout|TestWorktreeModeHome|TestCreateInHidden|TestParseTmuxSessionLine|TestHome|TestChatRecordHome|TestHandoffCopiesHome'` 输出两行 `ok`
  - `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/server -run TestTerminalFramesUnchangedV3` 通过，`git status --short vibe-remoted/internal/server/testdata vibe-remoted/internal/server/golden_test.go` 没有输出
- 依赖：无

### T3 daemon：项目清单和创建记录（projects.json）
- 状态：待办
- 文件：新建 `vibe-remoted/internal/session/projects_store.go`、`vibe-remoted/internal/session/projects_store_test.go`
- 接口：
  - 使用：`ValidSessionID(id)`（现有，`manager.go`）；写盘方式照 `vibe-remoted/internal/chat/store.go`（临时文件、fsync、rename，文件 0600）
  - 提供：`OpenProjectStore(stateDir string) (*ProjectStore, error)`；`NewMemoryProjectStore() *ProjectStore`；`AddProject(id string)`；`RemoveProject(id string) bool`；`Projects() []string`；`AddWorktree(project, path, branch string)`；`RemoveWorktree(path string)`；`Managed(project, path, branch string) bool`
  - 文件格式见 design 5.2；`Managed` 的两条规则见 design 5.3（第 2 条每次现算，不写文件）。`ProjectStore` 自己的互斥锁是叶子锁，每次修改在锁内同步写盘
- 场景：R2.2（清单跨重启）、R5.8（`managed` 的判定，H17）
- 测试：
  - `TestProjectStoreRoundTrip`：`AddProject("/r/devflow")`、`AddWorktree("/r/devflow", "/r/devflow-worktrees/fix-login", "fix-login")` 后重新 `OpenProjectStore` 同一目录 → `Projects()` 含该 id，`Managed(…, "fix-login")` 为真；文件权限是 0600；重复 `AddProject` 不产生第二条
  - `TestProjectStoreRemove`：`RemoveProject` 对存在的 id 返回 true 并落盘，对不存在的返回 false；`RemoveWorktree` 之后 `Managed` 为假
  - `TestManagedRequiresPathAndBranch`：记录的路径相同、分支传 `other` → 假；分支传空（detached）→ 假；路径不同、分支相同 → 假
  - `TestManagedLegacyVibeBranch`：没有任何记录时，`path` 是 `/r/devflow-worktrees/1794824025040-12b763ac`、分支是 `vibe/1794824025040-12b763ac` → 真；分支是 `vibe/另一个id` → 假；`path` 的末段是 `foo bar`（不满足 `ValidSessionID`）→ 假；容器目录不是 `<主目录名>-worktrees` → 假
  - `TestProjectStoreCorruptFileRenamed`：文件内容不是 JSON、`version` 是 2 各一例 → 打开成功、清单为空，目录里有 `projects.json.corrupt-<数字>`；随后 `AddProject` 写出新的 `projects.json`
  - `TestOpenProjectStoreUnwritableDir`：目录是 0500 → 返回错误
  - `TestMemoryProjectStore`：增删查都可用，不创建任何文件
- 完成定义：`cd vibe-remoted && go test -race -count=1 ./internal/session -run 'TestProjectStore|TestManaged|TestOpenProjectStore|TestMemoryProjectStore'` 输出 `ok`
- 依赖：无

### T4 协议 4：项目树端点 `GET /api/v1/projects`、`POST /api/v1/projects/remove`
- 状态：待办
- 文件：
  - 新建 `vibe-remoted/internal/session/projects.go`（`Manager` 的方法）、`vibe-remoted/internal/session/projects_test.go`、`vibe-remoted/internal/server/projects.go`（两个处理函数）、`vibe-remoted/internal/server/projects_test.go`
  - 修改 `vibe-remoted/internal/protocol/protocol.go`（`Version = 4`；类型 `ProjectsResponse`、`Project`、`ProjectWorktree`）、`vibe-remoted/internal/server/server.go`（`routes()` 加两条路由）、`vibe-remoted/cmd/vibe-remoted/main.go`（打开 `ProjectStore`，失败时改用内存清单并记一行日志，`mgr.SetProjectStore`）、`vibe-remoted/internal/session/manager.go` 和 `chat_manager.go`（新建会话成功后 `AddProject`；现有 worktree 模式建好后 `AddWorktree`、回滚时 `RemoveWorktree`；都在 `Manager.mu` 之外调用）
  - 修改 `desktop/src/shared/protocol.ts`（`PROTOCOL_VERSION = 4`、`CHAT_MIN_PROTO = 3`、类型 `Project`、`ProjectWorktree`）、`desktop/src/renderer/rest.ts`（`listProjects`、`removeProject`、`RestError`）、`desktop/src/renderer/chat/availability.ts`（改用 `CHAT_MIN_PROTO`）、`desktop/src/renderer/i18n.ts`（`terminal.oldDaemon`、`picker.oldDaemon` 中英文改成 design 7.4 末尾的新文案）
  - 修改 `docs/protocol.md`（版本表加第 4 行，先写本任务已落地的部分：两个新端点、`/api/v1/info.proto` 为 4、「所有 S→C 帧的字段与 v3 相同」；REST 一节加这两个端点的请求、响应、错误码）
  - 随版本号改的断言（c1 已同意，decisions #11）：`vibe-remoted/internal/server/contract_test.go` 的 `TestInfoAndReadyProto3` 改名 `TestInfoAndReadyProto4`、3 改 4；`vibe-remoted/internal/protocol/protocol_test.go:41` 的 `Version != 3` 改为 4；`.claude/skills/verify/scripts/ws-chat-smoke.mjs:416` 的 `info.proto !== 3` 改为 4。`desktop/scripts/test-chat-client.mjs` 里假 daemon 发的 `proto: 3` 不改
  - 测试 `desktop/scripts/test-chat-availability.mjs`、新建 `desktop/scripts/test-rest-projects.mjs`
- 接口：
  - 使用：`ListWorktrees`、`ResolveHome`、`gitAtTimeout`、`Runner.Home()`、`chat.Record.Project/Home`（T2）；`ProjectStore` 的全部方法（T3）；`checkToken`、`maxRESTBody`、`cfg.IsAllowedWorkdir`（现有）
  - 提供（Go）：`(m *Manager) SetProjectStore(s *ProjectStore)`；`(m *Manager) Projects(allow func(path string) bool) []protocol.Project`；`(m *Manager) RemoveProject(id string) error`，错误是 `ErrProjectNotFound` 或 `ErrProjectHasSessions`
  - 提供（TS）：`listProjects(): Promise<Project[] | null>`（404 → `null`，其他失败抛错）；`removeProject(id: string): Promise<void>`；`class RestError extends Error { status: number; code: string; body: unknown }`
  - 行为照 design 4.2、4.3、5.4：每个项目 id 只跑一次 `ListWorktrees`，最多 8 个同时在跑，git 调用不在 `Manager.mu` 里；排序由 daemon 定；数组字段输出 `[]` 不输出 `null`；过滤掉 `prunable`、裸仓库本身、`allow` 不放行的；成功读到列表而创建记录的 `path` 不在其中时删掉那条记录；第一次调用时给没有归属的旧会话补归属（5.4），补出来的 git 项目进清单
- 场景：R1.1、R1.3、R1.5、R2.1–R2.7（daemon 一侧）、R4.5、R9.1（`CHAT_MIN_PROTO`）、性能、安全
- 测试（除注明的以外都在 `server/projects_test.go`，经 `httptest` 请求）：
  - `TestProjectsTree`、`TestProjectsNonGitProject`、`TestProjectsListsSessionlessAndExternal`、`TestProjectsTwoSessionsOneWorktree`、`TestProjectsPrunedWorktreeSessionsMoveUp`、`TestProjectsHidesWorktreesOutsideAllowedRoots`、`TestProjectsRepoMissing`、`TestProjectsGitFailed`：断言见测试计划 R1.1、R1.3、R2.1、R4.5、R2.5、R2.6、R2.7 各行
  - `TestProjectsResponseShape`：响应体有 `proto: 4`；没有会话的 worktree `sessions` 是 `[]`；detached 的一项有 `detached:true`、没有 `branch` 键；`head` 是 7 位；主目录有 `main:true`；T3 记录过的有 `managed:true`
  - `TestProjectsOrderStable`：3 个项目共 8 个会话，连续 40 次响应体逐字节相同；名称 `Beta`、`alpha`、`gamma` 的顺序是 `alpha`、`Beta`、`gamma`；worktree 顺序是主目录、`a-branch`、`b-branch`、detached
  - `TestProjectsSurviveSessionDeletionAndRestart`：删光会话后用同一个 `state_dir` 新建 `Manager` 和 `ProjectStore` → `devflow` 和 2 个 worktree 仍在
  - `TestRemoveProjectKeepsDisk`、`TestProjectReappearsAfterNewSession`、`TestRemoveProjectWithSessions409`、`TestRemoveProjectNotFound`：断言见测试计划 R2.3、R2.4
  - `TestNonGitProjectDisappearsWithLastSession`：`notes` 的最后一个会话删除后，响应里没有 `notes`（H18）
  - `TestProjectsDropsStaleWorktreeRecord`：记录过的 worktree 被 `git worktree remove` 之后请求一次 → 记录没了；同一路径上再手工建一个同名分支的 worktree，它不是 `managed`
  - `TestBackfillHomeForLegacyTmuxSessions`（session 包，需要 tmux）：会话的 tmux 选项里没有 `@vibe_remote_project` → 第一次 `Projects()` 之后有了，项目进了清单；`TestBackfillHomeForLegacyChatRecords`：没有 `project` 的对话记录经 `LoadChats` 后有了并已落盘
  - `TestProjectsWithUnwritableStateDir`：用 `NewMemoryProjectStore()` → 只返回现存会话所在的项目，不报错
  - `TestProjectsOneGitCallPerProject`（session 包）：20 个仓库各 5 个 worktree，`PATH` 前面放一个记数后转调真实 git 的包装脚本 → 一次 `Projects()` 的调用数是 20，同时在跑的不超过 8；`TestSessionsEndpointRunsNoGit`：同一环境下 `GET /api/v1/sessions` 的调用数是 0
  - `TestNewEndpointsRequireToken`：两个新端点不带 token、带错 token 都是 401
  - `test-chat-availability.mjs › proto3_daemon_supports_chat`：`info.proto` 是 3 且 `chat.supported` 为真 → `enabled` 为真；现有的 `proto 2` 用例照常通过
  - `test-rest-projects.mjs`：`fetch` 返回 404 → `listProjects()` 得到 `null`；返回 500 → 抛 `RestError`，`status` 是 500；`removeProject` 遇到 409 → `RestError.code` 是 `project_has_sessions`
- 完成定义：
  - `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 ./internal/session ./internal/server ./internal/protocol -run 'TestProjects|TestRemoveProject|TestProjectReappears|TestNonGitProject|TestBackfillHome|TestSessionsEndpointRunsNoGit|TestNewEndpointsRequireToken|TestInfoAndReadyProto4|TestTerminalFramesUnchangedV3|TestProtocolChatFramesJSON'` 输出三行 `ok`
  - `cd desktop && npm run test:chat-availability && npm run test:rest-projects` 都以退出码 0 结束
  - `git diff --stat HEAD~1 -- vibe-remoted/internal/server/testdata vibe-remoted/internal/server/golden_test.go` 没有输出
  - 按 `/protocol-sync` 核对：`Project`、`ProjectWorktree` 的 JSON 名在三处一致
- 依赖：T2、T3

### T5 桌面端：把会话和项目树合并成三层树（tree.ts，纯函数）
- 状态：待办
- 文件：新建 `desktop/src/renderer/tree.ts`、`desktop/scripts/test-tree.mjs`；修改 `desktop/package.json`（加 `test:tree`）
- 接口：
  - 使用：`SessionInfo`、`Project`（`desktop/src/shared/protocol.ts`，T4）；`Dot`（`desktop/src/renderer/chat/activity.ts`，现有）
  - 提供：`TreeSession`、`TreeWorktree`、`TreeProject`、`Capability`；`buildTree(sessions, projects)`；`visibleSessions(machines, collapsedProjects)`；`projectRollup(project, dotOf)`；`sessionContext(tree, id)`；`notificationTitle(machineName, ctx)`；`nextCapability(prev, result)`。签名见 design 4.10，规则见 4.10 末尾的「`buildTree` 的规则」。文件里不引用 DOM
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
- 完成定义：`cd desktop && npm run typecheck && npm run test:tree` 退出码 0，输出里每个用例一行 `ok - <用例名>`
- 依赖：T4
