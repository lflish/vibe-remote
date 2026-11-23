# 场景对照表：按项目和 worktree 组织会话，并更换视觉风格

> 最终运行（提交 `5d8878c`，65 个用例，含这一轮新增的 X2.rename、X3.keys、X6.scroll、X8.menu）的结果见 `../test-report.md` 的「场景对照」（关口 C 第 1 轮返工之后又在 `3c9cff8` 上全量运行了一遍，58 个场景的结果相同，报告里写的是那一次）；下面是测试阶段前半写下的对照表，状态一列是当时的。

生成于测试阶段前半（补齐测试）。被测提交：`ba9caa4` 的产品代码（这一步没有改产品代码），测试脚本为本目录所在提交。

列的含义：「已有测试」是开发阶段写的单元 / 集成测试（名字取自 tasks.md 的测试计划，已逐个核对存在于代码里）；「端到端」是在真实应用（CDP 驱动构建产物）或真实 daemon（REST / WebSocket）上跑的用例；状态取自最后两次完整运行。

- `gui-worktree-smoke.mjs`：最后两次完整运行都是 61 个用例通过、0 个失败（各约 1 分 55 秒），见 `gui-worktree-smoke-run.txt`。
- `ws-worktree-smoke.mjs`：9 个用例，本机 git 2.50.1 和临时安装的 git 2.30.2 上都通过，见 `ws-worktree-smoke-git-*.txt`。
- 每个 `gui-worktree-smoke.mjs` 用例都在一个故意放进缺陷的构建上确认过会失败，见 `reverse-checks.md`。

| 场景 | 标题 | 已有测试（单元 / 集成） | 端到端用例 | 证据 | 状态 |
|------|------|--------------------------|------------|------|------|
| R1.1 | 一个项目两个 worktree 都有会话 | Go 集成：`TestProjectsTree`<br>desktop 单元：`test-tree.mjs › two_worktrees_each_with_session`、`test-sidebar.mjs › renders_three_levels` | `gui-worktree-smoke.mjs` › R1.1 | `R1.1.png` | 通过 |
| R1.2 | 项目只有一个 worktree | desktop 单元：`test-tree.mjs › single_worktree_is_flat`、`test-sidebar.mjs › flat_project_has_no_worktree_row` | `gui-worktree-smoke.mjs` › R1.2 | `R1.2.png` | 通过 |
| R1.3 | 不在 git 仓库里的目录 | Go 单元：`TestResolveHomeNonGit`<br>Go 集成：`TestProjectsNonGitProject`<br>desktop 单元：`test-tree.mjs › non_git_project`、`test-sidebar.mjs › non_git_has_no_worktree_entries` | `gui-worktree-smoke.mjs` › R1.3 | 运行输出 | 通过 |
| R1.4 | 同一 worktree 下多个未改名的会话 | desktop 单元：`test-tree.mjs › duplicate_names_get_numbers` | `gui-worktree-smoke.mjs` › R1.4 | `R1.4.png` | 通过 |
| R1.5 | 顺序稳定 | Go 集成：`TestProjectsOrderStable`、`TestCreatedSurvivesRestartTmux`、`TestProjectsOrderSurvivesRestart`<br>desktop 单元：`test-tree.mjs › keeps_daemon_order` | `gui-worktree-smoke.mjs` › R1.5 | 运行输出 | 通过 |
| R1.6 | 折叠的项目里有会话在等用户 | desktop 单元：`test-tree.mjs › rollup_waiting_only`、`test-sidebar.mjs › collapsed_project_shows_waiting_dot` | `gui-worktree-smoke.mjs` › R1.6 | `R1.6.png` | 通过 |
| R1.7 | 标题和通知带上项目与分支 | desktop 单元：`test-tree.mjs › session_context_and_notification_title`、`test-sidebar.mjs › toolbar_title_parts` | `gui-worktree-smoke.mjs` › R1.7 | `R1.7.png` | 通过 |
| R1.8 | worktree 当前不在任何分支上 | Go 单元：`TestListWorktrees`<br>desktop 单元：`test-tree.mjs › detached_label_is_short_hash` | `gui-worktree-smoke.mjs` › R1.8 | `R1.8.png` | 通过 |
| R2.1 | 别的工具建的、没有会话的 worktree | Go 集成：`TestProjectsListsSessionlessAndExternal`<br>desktop 单元：`test-sidebar.mjs › empty_worktree_row` | `gui-worktree-smoke.mjs` › R2.1 | `R2.1.png` | 通过 |
| R2.2 | 项目的会话全部删除后 | Go 单元：`TestProjectStoreRoundTrip`<br>Go 集成：`TestProjectsSurviveSessionDeletionAndRestart` | `gui-worktree-smoke.mjs` › R2.2 | `R2.2.png` | 通过 |
| R2.3 | 从侧边栏移除项目 | Go 集成：`TestRemoveProjectKeepsDisk`、`TestProjectReappearsAfterNewSession`<br>desktop 单元：`test-sidebar.mjs › project_menu_remove` | `gui-worktree-smoke.mjs` › R2.3 | `R2.3.png` | 通过 |
| R2.4 | 项目下有会话时不能移除 | Go 集成：`TestRemoveProjectWithSessions409`、`TestRemoveProjectNotFound`<br>desktop 单元：`test-sidebar.mjs › project_remove_disabled_with_sessions` | `gui-worktree-smoke.mjs` › R2.4 | `R2.4.png` | 通过 |
| R2.5 | worktree 在别处被删掉 | Go 集成：`TestProjectsPrunedWorktreeSessionsMoveUp`<br>desktop 单元：`test-tree.mjs › gone_sessions`、`test-sidebar.mjs › gone_session_meta` | `gui-worktree-smoke.mjs` › R2.5 | `R2.5.png` | 通过 |
| R2.6 | worktree 不在允许的目录范围内 | Go 集成：`TestProjectsHidesWorktreesOutsideAllowedRoots`、`TestProjectsAllowedRootIsSymlink` | `gui-worktree-smoke.mjs` › R2.6 | 运行输出 | 通过 |
| R2.7 | 读不到 worktree 列表 | Go 集成：`TestProjectsRepoMissing`、`TestProjectsGitFailed`<br>desktop 单元：`test-tree.mjs › project_error`、`test-sidebar.mjs › project_error_row_sessions_usable` | `gui-worktree-smoke.mjs` › R2.7 | `R2.7.png` | 通过 |
| R3.1 | 新建成功 | Go 单元：`TestCreateNamedWorktree`<br>Go 集成：`TestWSAttachWorktreeName`<br>desktop 单元：`test-worktree-dialogs.mjs › new_worktree_confirm_resolves` | `gui-worktree-smoke.mjs` › R3.1；ws-worktree-smoke「named worktree → session → delete」 | `R3.1.png` | 通过 |
| R3.2 | 名字里有斜杠 | Go 单元：`TestWorktreeDirName`、`TestCreateNamedWorktree/slash`<br>desktop 单元：`test-worktree-name.mjs › dir_name` | `gui-worktree-smoke.mjs` › R3.2；ws-worktree-smoke「named worktree → session → delete」（`change/foo` → `change-foo`） | `R3.2.png` | 通过 |
| R3.3 | 名字不合法 | Go 单元：`TestValidateWorktreeName`、`TestValidateWorktreeNameRejectsExpansion`、`TestWorktreeNameNeverReachesShell`<br>Go 集成：`TestPlanWorktree/invalid_name`<br>desktop 单元：`test-worktree-name.mjs › shared_vectors`、`test-session-form.mjs › invalid_name_disables_confirm` | `gui-worktree-smoke.mjs` › R3.3 | `R3.3.png` | 通过 |
| R3.4 | 分支名已存在 | Go 单元：`TestCreateNamedWorktreeBranchExists`、`TestBranchConflict`<br>Go 集成：`TestPlanWorktree/branch_exists`、`TestPlanWorktree/branch_conflict`<br>desktop 单元：`test-worktree-dialogs.mjs › plan_rejection_keeps_dialog_open` | `gui-worktree-smoke.mjs` › R3.4 | `R3.4.png` | 通过 |
| R3.5 | 目标目录已存在 | Go 单元：`TestCreateNamedWorktreePathExists`<br>Go 集成：`TestPlanWorktree/path_exists` | `gui-worktree-smoke.mjs` › R3.5 | `R3.5.png` | 通过 |
| R3.6 | 发起处有未提交改动 | Go 单元：`TestCreateNamedWorktreeExcludesUncommitted`<br>Go 集成：`TestPlanWorktreeBase`<br>desktop 单元：`test-session-form.mjs › base_info_text` | `gui-worktree-smoke.mjs` › R3.6 | `R3.6.png` | 通过 |
| R3.7 | 创建中途断线 | Go 集成：`TestNamedWorktreeReplaySameID`<br>desktop 单元：`test-attach-replay.mjs › replay_carries_worktree_name` | `gui-worktree-smoke.mjs` › R3.7 | `R3.7.png` | 通过 |
| R3.8 | 创建失败 | Go 单元：`TestCreateNamedWorktreeGitFailureLeavesNothing`<br>Go 集成：`TestWSAttachWorktreeCreateFailed` | `gui-worktree-smoke.mjs` › R3.8 | `R3.8.png` | 通过 |
| R3.9 | 机器概览里的 Worktree 模式 | desktop 单元：`test-session-form.mjs › picker_worktree_mode_name_segment` | `gui-worktree-smoke.mjs` › R3.9 | `R3.9.png` | 通过 |
| R3.10 | 目标目录不在允许的范围内 | Go 单元：`TestResolveAllowedNewPath`、`TestCreateNamedWorktreePathNotAllowed`<br>Go 集成：`TestPlanWorktree/path_not_allowed`<br>desktop 单元：`test-worktree-dialogs.mjs › plan_rejection_keeps_dialog_open` | `gui-worktree-smoke.mjs` › R3.10 | `R3.10.png` | 通过 |
| R4.1 | 在 worktree 行上新建 | desktop 单元：`test-worktree-dialogs.mjs › worktree_session_dialog_shape` | `gui-worktree-smoke.mjs` › R4.1 | `R4.1.png` | 通过 |
| R4.2 | 隐藏目录下的 worktree | Go 集成：`TestCreateInHiddenWorktreeDir` | `gui-worktree-smoke.mjs` › R4.2 | `R4.2.png` | 通过 |
| R4.3 | 主目录已被 claude 信任 | Go 单元：`TestChatTrust/worktree_of_trusted_main`<br>Go 集成：`TestFSChatTrustWorktree`、`TestWSCreateChatInWorktreeOfTrustedMain` | `gui-worktree-smoke.mjs` › R4.3 | `R4.3.png` | 通过 |
| R4.4 | 主目录和该 worktree 都未被信任 | Go 单元：`TestChatTrust/neither_trusted`<br>desktop 单元：`test-chat-availability.mjs › worktree_untrusted_reason` | `gui-worktree-smoke.mjs` › R4.4 | `R4.4.png` | 通过 |
| R4.5 | 同一 worktree 再开一个 | Go 集成：`TestProjectsTwoSessionsOneWorktree` | `gui-worktree-smoke.mjs` › R4.5 | `R4.5.png` | 通过 |
| R4.6 | worktree 本身已被信任 | Go 单元：`TestChatTrust/worktree_itself_trusted` | `gui-worktree-smoke.mjs` › R4.6 | 运行输出 | 通过 |
| R5.1 | 删除 worktree 里的会话 | Go 单元：`TestDeleteSessionKeepsWorktreeAndBranch`<br>desktop 单元：`test-worktree-dialogs.mjs › delete_session_keeps_worktree_note` | `gui-worktree-smoke.mjs` › R5.1 | `R5.1.png` | 通过 |
| R5.2 | 删除干净且已合并的 worktree | Go 单元：`TestRemoveCleanMergedWorktree`<br>Go 集成：`TestWorktreeStatusEndpoint`、`TestWorktreeRemoveEndpoint/clean`<br>desktop 单元：`test-worktree-dialogs.mjs › delete_wt_clean` | `gui-worktree-smoke.mjs` › R5.2；ws-worktree-smoke「named worktree → session → delete」「tmux: …」5 例 | `R5.2.png` | 通过 |
| R5.3 | 有未提交或未跟踪的文件 | Go 单元：`TestDirtyFiles`、`TestRemoveDirtyNeedsConsent`<br>desktop 单元：`test-worktree-dialogs.mjs › delete_wt_files` | `gui-worktree-smoke.mjs` › R5.3 | `R5.3.png` | 通过 |
| R5.4 | 只有被 git 忽略的文件 | Go 单元：`TestDirtyFiles/ignored_only`、`TestIgnoredFiles`、`TestRemoveIgnoredOnlyIsClean`<br>Go 集成：`TestWorktreeStatusEndpoint/ignored`<br>desktop 单元：`test-worktree-dialogs.mjs › delete_wt_ignored_note` | `gui-worktree-smoke.mjs` › R5.4 | `R5.4.png` | 通过 |
| R5.5 | 有未合并的提交 | Go 单元：`TestUnmergedCommits`、`TestRemoveUnmergedNeedsConsent`<br>desktop 单元：`test-worktree-dialogs.mjs › delete_wt_commits` | `gui-worktree-smoke.mjs` › R5.5；ws-worktree-smoke「named worktree → session → delete」（409 → 带同意项删除） | `R5.5.png` | 通过 |
| R5.6 | worktree 下还有会话 | Go 单元：`TestRemoveEndsSessionsFirst`<br>desktop 单元：`test-worktree-dialogs.mjs › delete_wt_sessions_line`、`test-sidebar.mjs › remove_result_closes_views` | `gui-worktree-smoke.mjs` › R5.6；ws-worktree-smoke「tmux: the socket file is removed…」「a terminal session from before the upgrade…」 | `R5.6.png` | 通过 |
| R5.7 | 主目录不能删 | Go 单元：`TestRemoveMainRefused`<br>desktop 单元：`test-sidebar.mjs › main_worktree_has_no_menu` | `gui-worktree-smoke.mjs` › R5.7 | 运行输出 | 通过 |
| R5.8 | 不是 vibe-remote 创建的 worktree | Go 单元：`TestManagedRequiresPathAndBranch`、`TestManagedLegacyVibeBranch`、`TestRemoveExternalNeverDeletesBranch`<br>desktop 单元：`test-worktree-dialogs.mjs › delete_wt_external` | `gui-worktree-smoke.mjs` › R5.8 | `R5.8.png` | 通过 |
| R5.9 | 开始删除之前就能发现的失败 | Go 单元：`TestRemoveLockedRefusedBeforeEndingSessions`、`TestRemoveSubmoduleCheckoutRefused`、`TestRemoveRefusedWhenNestedWorktree`<br>Go 集成：`TestWorktreeRemoveEndpoint/locked`<br>desktop 单元：`test-worktree-dialogs.mjs › delete_flow_500_reopens_with_error` | `gui-worktree-smoke.mjs` › R5.9 | `R5.9.png` | 通过 |
| R5.10 | 任何版本的桌面端删会话都不丢提交 | Go 集成：`TestDeleteSessionNeverReturnsPreserved` | `gui-worktree-smoke.mjs` › R5.10；同一用例只发 `DELETE /api/v1/sessions/{id}`；R9.2 里基准提交的 `ws-smoke.mjs` | 运行输出 | 通过 |
| R5.11 | worktree 不在任何分支上 | Go 单元：`TestUnmergedCommits/detached`、`TestRemoveDetachedNeedsConsent`<br>desktop 单元：`test-worktree-dialogs.mjs › delete_wt_detached` | `gui-worktree-smoke.mjs` › R5.11 | `R5.11.png` | 通过 |
| R5.12 | 已经开始删除之后的失败 | Go 单元：`TestRemoveGitFailureKeepsState`、`TestRemovePartialFailureReported`、`TestRemoveSessionEndFailureStops`<br>Go 集成：`TestWorktreeRemoveEndpoint/git_failure`<br>desktop 单元：`test-worktree-dialogs.mjs › delete_flow_500_after_sessions_ended` | `gui-worktree-smoke.mjs` › R5.12 | `R5.12.png` | 通过 |
| R6.1 | 目录里已有会话在用最近那段对话 | desktop 单元：`test-session-form.mjs › continue_note_shown`、`test-worktree-dialogs.mjs › continue_note_counts` | `gui-worktree-smoke.mjs` › R6.1 | `R6.1.png` | 通过 |
| R6.2 | 目录里没有会话 | desktop 单元：`test-session-form.mjs › continue_note_hidden_without_sessions` | `gui-worktree-smoke.mjs` › R6.2 | 运行输出 | 通过 |
| R7.1 | 按序号切换 | desktop 单元：`test-shortcuts.mjs › match_digits` | `gui-worktree-smoke.mjs` › R7.1；gui-smoke.mjs 第 11 步 | `R7.1.png` | 通过 |
| R7.2 | 上一个 / 下一个 | desktop 单元：`test-shortcuts.mjs › pick_prev_next_wraps` | `gui-worktree-smoke.mjs` › R7.2；gui-smoke.mjs 第 11 步 | 运行输出 | 通过 |
| R7.3 | 焦点在终端或输入框里 | desktop 单元：`test-shortcuts.mjs › capture_blocks_propagation` | `gui-worktree-smoke.mjs` › R7.3；gui-smoke.mjs 第 11 步 | 运行输出 | 通过 |
| R7.4 | 对话框打开时 | desktop 单元：`test-shortcuts.mjs › blocked_does_not_intercept` | `gui-worktree-smoke.mjs` › R7.4；gui-smoke.mjs 第 11 步 | 运行输出 | 通过 |
| R7.5 | 折叠的项目 | desktop 单元：`test-tree.mjs › visible_sessions_skip_collapsed` | `gui-worktree-smoke.mjs` › R7.5；gui-smoke.mjs 第 11 步 | `R7.5.png` | 通过 |
| R8.1 | 对话会话 | desktop 单元：`test-theme-tokens.mjs › chat_shape_rules`、`test-chat-view.mjs`、`test-chat-markdown.mjs`、`test-chat-diff.mjs`、`test-chat-render-guard.mjs` | `gui-worktree-smoke.mjs` › R8.1；gui-chat-smoke.mjs（Markdown、代码块复制、diff、链接的行为：R3.2、R3.3、R4） | `R8.1.png` | 通过 |
| R8.2 | 终端会话 | desktop 单元：`test-theme-tokens.mjs › terminal_theme_from_css_vars`、`test-terminal-selection.mjs` | `gui-worktree-smoke.mjs` › R8.2；gui-smoke.mjs（PTY 透传、选区、⌘C / ⌘V） | `R8.2.png` | 通过 |
| R8.3 | 现有功能入口都在 | — | `gui-worktree-smoke.mjs` › R8.3；`gui-smoke.mjs` 46 行 PASS、`gui-chat-smoke.mjs` 29 行 PASS（各自运行） | 运行输出 | 通过 |
| R8.4 | 可读性 | desktop 单元：`test-theme-tokens.mjs › tag_contrast_all_hues`、`test-tree.mjs › project_hue_stable`、`test-theme-tokens.mjs › contrast_table` | `gui-worktree-smoke.mjs` › R8.4 | `R8.4.png` | 通过 |
| R8.5 | 小窗口和双语 | desktop 单元：`test-dialog-layout.mjs` | `gui-worktree-smoke.mjs` › R8.5；gui-smoke.mjs（picker-layout、sidebar-layout、shell-layout），gui-chat-smoke.mjs（slash-layout）；R5.9、R5.12 用例里各量一次失败说明的对话框 | `R8.5.png` | 通过 |
| R8.6 | 启动不闪 | desktop 单元：`test-theme-tokens.mjs › window_background_matches_bg_app` | `gui-worktree-smoke.mjs` › R8.6 | `R8.6.png` | 通过 |
| R9.1 | 新桌面端 + 旧 daemon | desktop 单元：`test-tree.mjs › legacy_groups_by_session_fields`、`test-chat-availability.mjs › proto3_daemon_supports_chat`、`test-sidebar.mjs › legacy_note_and_disabled_entries`、`test-session-form.mjs › picker_proto3_has_no_name_segment`、`test-worktree-dialogs.mjs › delete_session_legacy_note`、`test-legacy-daemon.mjs` | `gui-worktree-smoke.mjs` › R9.1；gui-chat-smoke.mjs R17.2（协议 2 的 daemon） | `R9.1.png` | 通过 |
| R9.2 | 旧桌面端 + 新 daemon | Go 集成：`TestAttachWorktreeWithoutNameKeepsLegacyNaming`、`TestTerminalFramesUnchangedV3`、`TestV3ClientFlowAgainstV4Daemon` | `gui-worktree-smoke.mjs` › R9.2；同一用例运行基准提交的 `ws-smoke.mjs`（12 行 PASS） | 运行输出 | 通过 |

58 个场景里有真实应用端到端用例的：58 个。没有只靠单元 / 集成测试的场景，也没有无法自动测试的场景；下面几处是自动化到不了的部分，另有说明。

## 场景之外的行

| 项 | 已有测试 | 端到端用例 | 状态 |
|----|----------|------------|------|
| 非功能：性能（20 项目 × 5 worktree，≤ 200 ms） | Go 集成：`TestProjectsOneGitCallPerProject`、`TestSessionsEndpointRunsNoGit` | `gui-worktree-smoke.mjs` › NFR.perf：median of 15: /api/v1/projects 108.4 ms; /api/v1/sessions 6.5 ms on an empty daemon, 7.7 ms with 20 projects × 5 worktrees and 20 sessions | 通过 |
| 非功能：安全（新端点要 token；名字不经 shell；只删列出的、白名单内的 worktree） | Go 集成：`TestNewEndpointsRequireToken`；`.devflow.yml` 的 7 条规则各自的 check | R2.6（白名单外的 worktree：status 404）、R3.10、R5.7（400 `worktree_is_main`）在真实 daemon 上各走一次 | 通过 |
| 非功能：可靠性（创建失败回滚；删除前失败原样；删除后失败如实报告） | 见 R3.8、R5.9、R5.12 的已有测试 | R3.8、R5.9、R5.12；待验证项 10（git 被时限杀掉）见 `pending-checks.md` | 通过 |
| 评审待验证项 11（行菜单跟随重建；「正在删除…」的行） | `test-sidebar.mjs › focus_survives_a_rebuild` 等 | `gui-worktree-smoke.mjs` › X11.menu、X11.removing | 通过 |
| tasks.md「容易出问题的情况」：子模块、`--separate-git-dir` 仓库的项目树 | `TestProjectsSingleWorktreeRepo`（含 `legacy_worktree_mode`）当时在代码里不存在，测试阶段后半已补上（提交 `246b437`）；同一行的其余 7 个测试都在 | 补：`ws-worktree-smoke.mjs`「a repository whose main directory git does not name」 | 通过 |
| tasks.md「容易出问题的情况」其余 51 行 | 105 个测试名逐个核对，除上一行外都存在 | 其中 R3.7、R5.9、R5.12、tmux 对账的几种状态另有端到端用例 | — |

## 自动化到不了的部分

- **真实键盘**（R7.1–R7.4，评审待验证项 4）：CDP 的按键不经过 macOS 的菜单分发和输入法，约束也不允许向系统前台发按键。自动化证明到「按键事件到达页面时被应用在捕获阶段拦下、会话切换、终端收到 0 字节、输入框内容不变」；系统菜单会不会先抢走这些键，要人在打包后的 app 里按一遍，步骤见 `pending-checks.md` 第 4 条。
- **原生通知的点击**（R1.7 的通知一半）：未签名构建不显示原生通知（Dock 降级），用例断言的是应用发出的通知标题（`this-mac · devflow / fix-login · 登录修复`，取自渲染进程在主进程返回 `shown` / `fallback` 后记下的一行）；点击原生通知打开会话这一步由 `gui-chat-smoke.mjs` R16.3 用模拟的点击覆盖。
- **R8.6 的「闪」**：能证明的是窗口创建后立刻读到的原生底色是 `#EFEFF4`，以及页面第一次绘制完成那一刻（`ready-to-show`）的整帧画面里底色区域是 `#EFEFF4`、主卡片是白色、没有成片的旧米色或深色。窗口出现到第一次绘制之间屏幕上实际合成的像素取不到（需要录屏）。
- **R8.1 / R8.2 与效果页逐块一致**：用例断言的是形态（气泡在右、输入框和主区域是圆角卡片、四个终端颜色的实际像素），整体观感与效果页的逐块对照是看截图做的，见 `pending-checks.md` 第 1 条。
