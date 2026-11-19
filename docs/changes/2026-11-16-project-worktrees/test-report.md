# 测试报告：按项目和 worktree 组织会话，并更换视觉风格

日期：2026-11-20　分支：change/project-worktrees　提交：5d8878c（被测的代码；其后的提交只加文档、证据和记录）

> ⚠️ 端到端测试：**已完成**。58 个验收场景每个都有在真实应用里运行的用例（CDP 驱动构建产物，本机有界面的 Electron 临时实例），最终运行 65 个用例全部通过；另有不带界面的接口冒烟 30 行全部通过。
> 浏览器环节：适用（桌面应用，裸 CDP；没有用 Playwright，跟随项目已有的做法）。
> 测试环境：e2e_env = local。被测的是临时 daemon（终端会话跑 `/bin/bash`，对话会话跑假 claude）和本机的 git 2.50.1、tmux 3.6a，**不是真实的 claude，也不是远程 Linux**。独立验证（关口 C）还没有做，结论见之后的 verdict.md。
> 这一轮探索式检查发现 8 个问题，修了 4 个（都在桌面端，都不涉及删除、信任规则和协议），1 个交给用户决定（c7），3 个记入后续。

## 汇总

| 类别 | 通过 | 失败 | 跳过 | 合计 |
|------|------|------|------|------|
| 单元 + 集成：Go（`make check` 里的 `go test -race ./...`） | 5 个包全部 `ok`（`go test -list` 列出 440 个顶层测试函数：session 230、server 98、chat 95、config 15、protocol 2） | 0 | 没有统计（没有带 `-v`） | 5 个包 |
| 单元：桌面端（`make check` 里的 `npm test`，33 个脚本） | 311 | 0 | 0 | 311 |
| 端到端（浏览器）：`gui-worktree-smoke.mjs` | 65 | 0 | 0 | 65（61 个按场景命名的 + 这一轮新增的 4 个） |
| 端到端（浏览器）：`gui-smoke.mjs` | 46 行 PASS | 0 | 0 | 46（脚本里 `check(` 30 处，未减少） |
| 端到端（浏览器）：`gui-chat-smoke.mjs` | 29 行 PASS | 0 | 0 | 29（脚本里 `test(` 26 处，未减少） |
| 端到端（接口）：`ws-smoke.mjs` / `ws-chat-smoke.mjs` / `ws-worktree-smoke.mjs` | 12 / 9 / 9 | 0 | 0 | 30 |
| `.devflow.yml` 的不变规则（19 条） | 18 条命令退出码 0；第 2 条是 `/protocol-sync` skill，机械可比的部分核对无差异 | 0 | 0 | 19 |

都在提交 `5d8878c` 的代码上运行，一个一个跑，各带独立的 `TMUX_TMPDIR`。已知偶发的用例（`gui-smoke.mjs` 的「drag-select + ⌘C」、第 4 步等选区目标、第 9 步状态点；`gui-chat-smoke.mjs` 的 R1.1、R7、R13.2 / R14.2；`TestStopAccountsForEveryQueuedMessage/restart`、`TestProjectsOneGitCallPerProject/unresolved_session`、`TestProjectStoreRemoveWorktreeIfSame`、`TestWorktreeStatus/ignored_timeout`）**这一轮都没有出现，没有重跑**。

运行命令和结果（完整输出在 `evidence/final-run/`）：

```
$ TMUX_TMPDIR=<临时目录> make check
cd vibe-remoted && go vet ./...
cd vibe-remoted && go test -race ./...
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	19.784s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/config	2.396s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/protocol	3.366s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	65.312s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	269.152s
cd desktop && npm run typecheck
> tsc --noEmit
cd desktop && npm test
…（311 行 ok，0 行 FAIL）
test-theme-tokens checks passed (16)
exit=0

$ TMUX_TMPDIR=<临时目录> node .claude/skills/verify/scripts/gui-smoke.mjs
…
PASS the switching keys pressed in a focused terminal send no bytes to the remote
PASS ordinary keys typed afterwards still reach the remote shell
PASS no uncaught renderer exceptions

all GUI checks passed
exit=0                                              # 46 行 PASS

$ TMUX_TMPDIR=<临时目录> node .claude/skills/verify/scripts/gui-chat-smoke.mjs --no-build
…
PASS R14.2 handoff while a turn runs asks first, then continues in a terminal — dialog "Claude 正在回复，交给终端会中断当前回合。继续吗？"; terminal: fake-claude interactive resume=21ca14a8-…
PASS R13.4 init reports an old claude → ended with required version, no reconnect — claude 版本过旧（1.0.0），对话界面需要 2.1.210 或更新…
PASS no uncaught renderer exceptions

all GUI chat checks passed
exit=0                                              # 29 行 PASS

$ DEVFLOW_EVIDENCE_DIR=docs/changes/2026-11-16-project-worktrees/evidence node .claude/skills/verify/scripts/gui-worktree-smoke.mjs --no-build
PASS 5 daemons up (this-mac proto 4, lab-mac proto 4, keep-mac proto 4, narrow-mac proto 4, old-mac proto 3)
PASS app started with 5 machines (zh), hooks installed
…
PASS double-clicking the name of a session that is open here renames it (exploration X2) — double click → input with "new-api" → typed a name, Enter: daemon and sidebar have it; on the session shown: input, Esc keeps the name
PASS a row menu opened with the pointer stays at its button when the sidebar is rebuilt (exploration X8) — opened with the pointer: 3px under its button; still there after two rebuilds (pointer on the button, then on the item); the item opens the confirmation
PASS the row menus work from the keyboard alone (exploration X3) — Tab to "more", Enter: focus on "删除 worktree"; arrows stay; Esc and Tab close it and the focus is on a button; Enter on the item opens the confirmation; Esc closes that
PASS switching with the keys scrolls the session's row into view (exploration X6) — … ⌘⇧[ to the last and ⌘1 to the first both bring the row into view
PASS performance: 20 projects × 5 worktrees add at most 200 ms to the lists — median of 15: /api/v1/projects 110.4 ms; /api/v1/sessions 6.8 ms on an empty daemon, 7.9 ms with 20 projects × 5 worktrees and 20 sessions
PASS no uncaught renderer exceptions

65 cases: R1 8/8, R2 7/7, R3 10/10, R4 6/6, R5 12/12, R6 2/2, R7 5/5, R8 6/6, R9 2/2, other 7/7

all GUI worktree checks passed
exit=0

$ VR_TOKEN=<临时 token> node .claude/skills/verify/scripts/ws-smoke.mjs 127.0.0.1:<随机端口> <临时目录>     # 自建的临时 daemon，allowed_roots 只有这个临时目录
…
PASS deleted 1795116911771-b72982a5
PASS deleted 1795116911965-620a044d

all checks passed
exit=0                                              # 12 行 PASS

$ node .claude/skills/verify/scripts/ws-chat-smoke.mjs
all chat checks passed
exit=0                                              # 9 行 PASS

$ node .claude/skills/verify/scripts/ws-worktree-smoke.mjs
all worktree checks passed
exit=0                                              # 9 行 PASS

$ .devflow.yml 的 invariants：18 条 check 命令原样执行（evidence/final-run/invariants.txt），每条 exit=0
$ node <核对脚本>        # /protocol-sync 里可以机械比对的部分（evidence/final-run/protocol-sync.txt）
types compared: 29 (146 fields); Go types with no TS interface of the same name: Frame, SessionMetadata, DataFrame, EventRequest
routes: 14 (…)
version: go 4, ts 4, docs table has a row for it: true
no differences
```

关于不变规则的两点说明：

- 第 2 条「协议三处一致」的 check 是 `/protocol-sync` skill，不是命令。这一轮没有改 `protocol.go`、`protocol.ts`、`rest.ts`、`docs/protocol.md`（`git diff a3d07cc..HEAD` 对这四个文件为空）。做了能机械比对的部分：Go 的 29 个带 JSON 标签的类型与同名 TS 接口逐字段比（字段名、可缺省性，共 146 个字段）、每个字段名在 `docs/protocol.md` 里出现、`server.go` 的 14 条路由在文档和 `rest.ts` 里出现、版本号两边都是 4。桌面端有意读成可缺省的两个字段（`ReadyFrame.proto`、`ChatInfo.claudeVersion`，旧 daemon 不发）不算差异，基准提交上就是这样。错误码表、`chat_ack` 码这类开放集合没有重新逐项核对（上一次完整核对在开发阶段，decisions #112）。
- 第 13 条的命令里 `./internal/server` 那一半输出 `[no tests to run]`：两个测试名都在 session 包里，命令原文如此，没有改。

## 场景对照

58 行，取自 `evidence/scenario-matrix.md`，「结果」是最终那次 `gui-worktree-smoke.mjs` 运行里同名用例的结果；截图是这次运行存的（覆盖了上一步的同名文件）。

| 场景 | 测试 | 层级 | 结果 | 证据 |
|------|------|------|------|------|
| R1.1 一个项目两个 worktree 都有会话 | Go 集成：`TestProjectsTree`；desktop 单元：`test-tree.mjs › two_worktrees_each_with_session`、`test-sidebar.mjs › renders_three_levels`；e2e：`gui-worktree-smoke.mjs` › R1.1 | 单元 / 集成 / 浏览器 | 通过 | evidence/R1.1.png |
| R1.2 项目只有一个 worktree | desktop 单元：`test-tree.mjs › single_worktree_is_flat`、`test-sidebar.mjs › flat_project_has_no_worktree_row`；e2e：`gui-worktree-smoke.mjs` › R1.2 | 单元 / 浏览器 | 通过 | evidence/R1.2.png |
| R1.3 不在 git 仓库里的目录 | Go 单元：`TestResolveHomeNonGit`；Go 集成：`TestProjectsNonGitProject`；desktop 单元：`test-tree.mjs › non_git_project`、`test-sidebar.mjs › non_git_has_no_worktree_entries`；e2e：`gui-worktree-smoke.mjs` › R1.3 | 单元 / 集成 / 浏览器 | 通过 | 运行输出 |
| R1.4 同一 worktree 下多个未改名的会话 | desktop 单元：`test-tree.mjs › duplicate_names_get_numbers`；e2e：`gui-worktree-smoke.mjs` › R1.4 | 单元 / 浏览器 | 通过 | evidence/R1.4.png |
| R1.5 顺序稳定 | Go 集成：`TestProjectsOrderStable`、`TestCreatedSurvivesRestartTmux`、`TestProjectsOrderSurvivesRestart`；desktop 单元：`test-tree.mjs › keeps_daemon_order`；e2e：`gui-worktree-smoke.mjs` › R1.5 | 单元 / 集成 / 浏览器 | 通过 | 运行输出 |
| R1.6 折叠的项目里有会话在等用户 | desktop 单元：`test-tree.mjs › rollup_waiting_only`、`test-sidebar.mjs › collapsed_project_shows_waiting_dot`；e2e：`gui-worktree-smoke.mjs` › R1.6 | 单元 / 浏览器 | 通过 | evidence/R1.6.png |
| R1.7 标题和通知带上项目与分支 | desktop 单元：`test-tree.mjs › session_context_and_notification_title`、`test-sidebar.mjs › toolbar_title_parts`；e2e：`gui-worktree-smoke.mjs` › R1.7 | 单元 / 浏览器 | 通过 | evidence/R1.7.png |
| R1.8 worktree 当前不在任何分支上 | Go 单元：`TestListWorktrees`；desktop 单元：`test-tree.mjs › detached_label_is_short_hash`；e2e：`gui-worktree-smoke.mjs` › R1.8 | 单元 / 浏览器 | 通过 | evidence/R1.8.png |
| R2.1 别的工具建的、没有会话的 worktree | Go 集成：`TestProjectsListsSessionlessAndExternal`；desktop 单元：`test-sidebar.mjs › empty_worktree_row`；e2e：`gui-worktree-smoke.mjs` › R2.1 | 单元 / 集成 / 浏览器 | 通过 | evidence/R2.1.png |
| R2.2 项目的会话全部删除后 | Go 单元：`TestProjectStoreRoundTrip`；Go 集成：`TestProjectsSurviveSessionDeletionAndRestart`；e2e：`gui-worktree-smoke.mjs` › R2.2 | 单元 / 集成 / 浏览器 | 通过 | evidence/R2.2.png |
| R2.3 从侧边栏移除项目 | Go 集成：`TestRemoveProjectKeepsDisk`、`TestProjectReappearsAfterNewSession`；desktop 单元：`test-sidebar.mjs › project_menu_remove`；e2e：`gui-worktree-smoke.mjs` › R2.3 | 单元 / 集成 / 浏览器 | 通过 | evidence/R2.3.png |
| R2.4 项目下有会话时不能移除 | Go 集成：`TestRemoveProjectWithSessions409`、`TestRemoveProjectNotFound`；desktop 单元：`test-sidebar.mjs › project_remove_disabled_with_sessions`；e2e：`gui-worktree-smoke.mjs` › R2.4 | 单元 / 集成 / 浏览器 | 通过 | evidence/R2.4.png |
| R2.5 worktree 在别处被删掉 | Go 集成：`TestProjectsPrunedWorktreeSessionsMoveUp`；desktop 单元：`test-tree.mjs › gone_sessions`、`test-sidebar.mjs › gone_session_meta`；e2e：`gui-worktree-smoke.mjs` › R2.5 | 单元 / 集成 / 浏览器 | 通过 | evidence/R2.5.png |
| R2.6 worktree 不在允许的目录范围内 | Go 集成：`TestProjectsHidesWorktreesOutsideAllowedRoots`、`TestProjectsAllowedRootIsSymlink`；e2e：`gui-worktree-smoke.mjs` › R2.6 | 集成 / 浏览器 | 通过 | 运行输出 |
| R2.7 读不到 worktree 列表 | Go 集成：`TestProjectsRepoMissing`、`TestProjectsGitFailed`；desktop 单元：`test-tree.mjs › project_error`、`test-sidebar.mjs › project_error_row_sessions_usable`；e2e：`gui-worktree-smoke.mjs` › R2.7 | 单元 / 集成 / 浏览器 | 通过 | evidence/R2.7.png |
| R3.1 新建成功 | Go 单元：`TestCreateNamedWorktree`；Go 集成：`TestWSAttachWorktreeName`；desktop 单元：`test-worktree-dialogs.mjs › new_worktree_confirm_resolves`；e2e：`gui-worktree-smoke.mjs` › R3.1；ws-worktree-smoke「named worktree → session → delete」 | 单元 / 集成 / 浏览器 / 接口 | 通过 | evidence/R3.1.png |
| R3.2 名字里有斜杠 | Go 单元：`TestWorktreeDirName`、`TestCreateNamedWorktree/slash`；desktop 单元：`test-worktree-name.mjs › dir_name`；e2e：`gui-worktree-smoke.mjs` › R3.2；ws-worktree-smoke「named worktree → session → delete」（`change/foo` → `change-foo`） | 单元 / 浏览器 / 接口 | 通过 | evidence/R3.2.png |
| R3.3 名字不合法 | Go 单元：`TestValidateWorktreeName`、`TestValidateWorktreeNameRejectsExpansion`、`TestWorktreeNameNeverReachesShell`；Go 集成：`TestPlanWorktree/invalid_name`；desktop 单元：`test-worktree-name.mjs › shared_vectors`、`test-session-form.mjs › invalid_name_disables_confirm`；e2e：`gui-worktree-smoke.mjs` › R3.3 | 单元 / 集成 / 浏览器 | 通过 | evidence/R3.3.png |
| R3.4 分支名已存在 | Go 单元：`TestCreateNamedWorktreeBranchExists`、`TestBranchConflict`；Go 集成：`TestPlanWorktree/branch_exists`、`TestPlanWorktree/branch_conflict`；desktop 单元：`test-worktree-dialogs.mjs › plan_rejection_keeps_dialog_open`；e2e：`gui-worktree-smoke.mjs` › R3.4 | 单元 / 集成 / 浏览器 | 通过 | evidence/R3.4.png |
| R3.5 目标目录已存在 | Go 单元：`TestCreateNamedWorktreePathExists`；Go 集成：`TestPlanWorktree/path_exists`；e2e：`gui-worktree-smoke.mjs` › R3.5 | 单元 / 集成 / 浏览器 | 通过 | evidence/R3.5.png |
| R3.6 发起处有未提交改动 | Go 单元：`TestCreateNamedWorktreeExcludesUncommitted`；Go 集成：`TestPlanWorktreeBase`；desktop 单元：`test-session-form.mjs › base_info_text`；e2e：`gui-worktree-smoke.mjs` › R3.6 | 单元 / 集成 / 浏览器 | 通过 | evidence/R3.6.png |
| R3.7 创建中途断线 | Go 集成：`TestNamedWorktreeReplaySameID`；desktop 单元：`test-attach-replay.mjs › replay_carries_worktree_name`；e2e：`gui-worktree-smoke.mjs` › R3.7 | 单元 / 集成 / 浏览器 | 通过 | evidence/R3.7.png |
| R3.8 创建失败 | Go 单元：`TestCreateNamedWorktreeGitFailureLeavesNothing`；Go 集成：`TestWSAttachWorktreeCreateFailed`；e2e：`gui-worktree-smoke.mjs` › R3.8 | 单元 / 集成 / 浏览器 | 通过 | evidence/R3.8.png |
| R3.9 机器概览里的 Worktree 模式 | desktop 单元：`test-session-form.mjs › picker_worktree_mode_name_segment`；e2e：`gui-worktree-smoke.mjs` › R3.9 | 单元 / 浏览器 | 通过 | evidence/R3.9.png |
| R3.10 目标目录不在允许的范围内 | Go 单元：`TestResolveAllowedNewPath`、`TestCreateNamedWorktreePathNotAllowed`；Go 集成：`TestPlanWorktree/path_not_allowed`；desktop 单元：`test-worktree-dialogs.mjs › plan_rejection_keeps_dialog_open`；e2e：`gui-worktree-smoke.mjs` › R3.10 | 单元 / 集成 / 浏览器 | 通过 | evidence/R3.10.png |
| R4.1 在 worktree 行上新建 | desktop 单元：`test-worktree-dialogs.mjs › worktree_session_dialog_shape`；e2e：`gui-worktree-smoke.mjs` › R4.1 | 单元 / 浏览器 | 通过 | evidence/R4.1.png |
| R4.2 隐藏目录下的 worktree | Go 集成：`TestCreateInHiddenWorktreeDir`；e2e：`gui-worktree-smoke.mjs` › R4.2 | 集成 / 浏览器 | 通过 | evidence/R4.2.png |
| R4.3 主目录已被 claude 信任 | Go 单元：`TestChatTrust/worktree_of_trusted_main`；Go 集成：`TestFSChatTrustWorktree`、`TestWSCreateChatInWorktreeOfTrustedMain`；e2e：`gui-worktree-smoke.mjs` › R4.3 | 单元 / 集成 / 浏览器 | 通过 | evidence/R4.3.png |
| R4.4 主目录和该 worktree 都未被信任 | Go 单元：`TestChatTrust/neither_trusted`；desktop 单元：`test-chat-availability.mjs › worktree_untrusted_reason`；e2e：`gui-worktree-smoke.mjs` › R4.4 | 单元 / 浏览器 | 通过 | evidence/R4.4.png |
| R4.5 同一 worktree 再开一个 | Go 集成：`TestProjectsTwoSessionsOneWorktree`；e2e：`gui-worktree-smoke.mjs` › R4.5 | 集成 / 浏览器 | 通过 | evidence/R4.5.png |
| R4.6 worktree 本身已被信任 | Go 单元：`TestChatTrust/worktree_itself_trusted`；e2e：`gui-worktree-smoke.mjs` › R4.6 | 单元 / 浏览器 | 通过 | 运行输出 |
| R5.1 删除 worktree 里的会话 | Go 单元：`TestDeleteSessionKeepsWorktreeAndBranch`；desktop 单元：`test-worktree-dialogs.mjs › delete_session_keeps_worktree_note`；e2e：`gui-worktree-smoke.mjs` › R5.1 | 单元 / 浏览器 | 通过 | evidence/R5.1.png |
| R5.2 删除干净且已合并的 worktree | Go 单元：`TestRemoveCleanMergedWorktree`；Go 集成：`TestWorktreeStatusEndpoint`、`TestWorktreeRemoveEndpoint/clean`；desktop 单元：`test-worktree-dialogs.mjs › delete_wt_clean`；e2e：`gui-worktree-smoke.mjs` › R5.2；ws-worktree-smoke「named worktree → session → delete」「tmux: …」5 例 | 单元 / 集成 / 浏览器 / 接口 | 通过 | evidence/R5.2.png |
| R5.3 有未提交或未跟踪的文件 | Go 单元：`TestDirtyFiles`、`TestRemoveDirtyNeedsConsent`；desktop 单元：`test-worktree-dialogs.mjs › delete_wt_files`；e2e：`gui-worktree-smoke.mjs` › R5.3 | 单元 / 浏览器 | 通过 | evidence/R5.3.png |
| R5.4 只有被 git 忽略的文件 | Go 单元：`TestDirtyFiles/ignored_only`、`TestIgnoredFiles`、`TestRemoveIgnoredOnlyIsClean`；Go 集成：`TestWorktreeStatusEndpoint/ignored`；desktop 单元：`test-worktree-dialogs.mjs › delete_wt_ignored_note`；e2e：`gui-worktree-smoke.mjs` › R5.4 | 单元 / 集成 / 浏览器 | 通过 | evidence/R5.4.png |
| R5.5 有未合并的提交 | Go 单元：`TestUnmergedCommits`、`TestRemoveUnmergedNeedsConsent`；desktop 单元：`test-worktree-dialogs.mjs › delete_wt_commits`；e2e：`gui-worktree-smoke.mjs` › R5.5；ws-worktree-smoke「named worktree → session → delete」（409 → 带同意项删除） | 单元 / 浏览器 / 接口 | 通过 | evidence/R5.5.png |
| R5.6 worktree 下还有会话 | Go 单元：`TestRemoveEndsSessionsFirst`；desktop 单元：`test-worktree-dialogs.mjs › delete_wt_sessions_line`、`test-sidebar.mjs › remove_result_closes_views`；e2e：`gui-worktree-smoke.mjs` › R5.6；ws-worktree-smoke「tmux: the socket file is removed…」「a terminal session from before the upgrade…」 | 单元 / 浏览器 / 接口 | 通过 | evidence/R5.6.png |
| R5.7 主目录不能删 | Go 单元：`TestRemoveMainRefused`；desktop 单元：`test-sidebar.mjs › main_worktree_has_no_menu`；e2e：`gui-worktree-smoke.mjs` › R5.7 | 单元 / 浏览器 | 通过 | 运行输出 |
| R5.8 不是 vibe-remote 创建的 worktree | Go 单元：`TestManagedRequiresPathAndBranch`、`TestManagedLegacyVibeBranch`、`TestRemoveExternalNeverDeletesBranch`；desktop 单元：`test-worktree-dialogs.mjs › delete_wt_external`；e2e：`gui-worktree-smoke.mjs` › R5.8 | 单元 / 浏览器 | 通过 | evidence/R5.8.png |
| R5.9 开始删除之前就能发现的失败 | Go 单元：`TestRemoveLockedRefusedBeforeEndingSessions`、`TestRemoveSubmoduleCheckoutRefused`、`TestRemoveRefusedWhenNestedWorktree`；Go 集成：`TestWorktreeRemoveEndpoint/locked`；desktop 单元：`test-worktree-dialogs.mjs › delete_flow_500_reopens_with_error`；e2e：`gui-worktree-smoke.mjs` › R5.9 | 单元 / 集成 / 浏览器 | 通过 | evidence/R5.9.png |
| R5.10 任何版本的桌面端删会话都不丢提交 | Go 集成：`TestDeleteSessionNeverReturnsPreserved`；e2e：`gui-worktree-smoke.mjs` › R5.10；同一用例只发 `DELETE /api/v1/sessions/{id}`；R9.2 里基准提交的 `ws-smoke.mjs` | 集成 / 浏览器 / 接口 | 通过 | 运行输出 |
| R5.11 worktree 不在任何分支上 | Go 单元：`TestUnmergedCommits/detached`、`TestRemoveDetachedNeedsConsent`；desktop 单元：`test-worktree-dialogs.mjs › delete_wt_detached`；e2e：`gui-worktree-smoke.mjs` › R5.11 | 单元 / 浏览器 | 通过 | evidence/R5.11.png |
| R5.12 已经开始删除之后的失败 | Go 单元：`TestRemoveGitFailureKeepsState`、`TestRemovePartialFailureReported`、`TestRemoveSessionEndFailureStops`；Go 集成：`TestWorktreeRemoveEndpoint/git_failure`；desktop 单元：`test-worktree-dialogs.mjs › delete_flow_500_after_sessions_ended`；e2e：`gui-worktree-smoke.mjs` › R5.12 | 单元 / 集成 / 浏览器 | 通过 | evidence/R5.12.png |
| R6.1 目录里已有会话在用最近那段对话 | desktop 单元：`test-session-form.mjs › continue_note_shown`、`test-worktree-dialogs.mjs › continue_note_counts`；e2e：`gui-worktree-smoke.mjs` › R6.1 | 单元 / 浏览器 | 通过 | evidence/R6.1.png |
| R6.2 目录里没有会话 | desktop 单元：`test-session-form.mjs › continue_note_hidden_without_sessions`；e2e：`gui-worktree-smoke.mjs` › R6.2 | 单元 / 浏览器 | 通过 | 运行输出 |
| R7.1 按序号切换 | desktop 单元：`test-shortcuts.mjs › match_digits`；e2e：`gui-worktree-smoke.mjs` › R7.1；gui-smoke.mjs 第 11 步 | 单元 / 浏览器 | 通过 | evidence/R7.1.png |
| R7.2 上一个 / 下一个 | desktop 单元：`test-shortcuts.mjs › pick_prev_next_wraps`；e2e：`gui-worktree-smoke.mjs` › R7.2；gui-smoke.mjs 第 11 步 | 单元 / 浏览器 | 通过 | 运行输出 |
| R7.3 焦点在终端或输入框里 | desktop 单元：`test-shortcuts.mjs › capture_blocks_propagation`；e2e：`gui-worktree-smoke.mjs` › R7.3；gui-smoke.mjs 第 11 步 | 单元 / 浏览器 | 通过 | 运行输出 |
| R7.4 对话框打开时 | desktop 单元：`test-shortcuts.mjs › blocked_does_not_intercept`；e2e：`gui-worktree-smoke.mjs` › R7.4；gui-smoke.mjs 第 11 步 | 单元 / 浏览器 | 通过 | 运行输出 |
| R7.5 折叠的项目 | desktop 单元：`test-tree.mjs › visible_sessions_skip_collapsed`；e2e：`gui-worktree-smoke.mjs` › R7.5；gui-smoke.mjs 第 11 步 | 单元 / 浏览器 | 通过 | evidence/R7.5.png |
| R8.1 对话会话 | desktop 单元：`test-theme-tokens.mjs › chat_shape_rules`、`test-chat-view.mjs`、`test-chat-markdown.mjs`、`test-chat-diff.mjs`、`test-chat-render-guard.mjs`；e2e：`gui-worktree-smoke.mjs` › R8.1；gui-chat-smoke.mjs（Markdown、代码块复制、diff、链接的行为：R3.2、R3.3、R4） | 单元 / 浏览器 | 通过 | evidence/R8.1.png |
| R8.2 终端会话 | desktop 单元：`test-theme-tokens.mjs › terminal_theme_from_css_vars`、`test-terminal-selection.mjs`；e2e：`gui-worktree-smoke.mjs` › R8.2；gui-smoke.mjs（PTY 透传、选区、⌘C / ⌘V） | 单元 / 浏览器 | 通过 | evidence/R8.2.png |
| R8.3 现有功能入口都在 | e2e：`gui-worktree-smoke.mjs` › R8.3；`gui-smoke.mjs` 46 行 PASS、`gui-chat-smoke.mjs` 29 行 PASS（各自运行） | 浏览器 | 通过 | 运行输出 |
| R8.4 可读性 | desktop 单元：`test-theme-tokens.mjs › tag_contrast_all_hues`、`test-tree.mjs › project_hue_stable`、`test-theme-tokens.mjs › contrast_table`；e2e：`gui-worktree-smoke.mjs` › R8.4 | 单元 / 浏览器 | 通过 | evidence/R8.4.png |
| R8.5 小窗口和双语 | desktop 单元：`test-dialog-layout.mjs`；e2e：`gui-worktree-smoke.mjs` › R8.5；gui-smoke.mjs（picker-layout、sidebar-layout、shell-layout），gui-chat-smoke.mjs（slash-layout）；R5.9、R5.12 用例里各量一次失败说明的对话框 | 单元 / 浏览器 | 通过 | evidence/R8.5.png |
| R8.6 启动不闪 | desktop 单元：`test-theme-tokens.mjs › window_background_matches_bg_app`；e2e：`gui-worktree-smoke.mjs` › R8.6 | 单元 / 浏览器 | 通过 | evidence/R8.6.png |
| R9.1 新桌面端 + 旧 daemon | desktop 单元：`test-tree.mjs › legacy_groups_by_session_fields`、`test-chat-availability.mjs › proto3_daemon_supports_chat`、`test-sidebar.mjs › legacy_note_and_disabled_entries`、`test-session-form.mjs › picker_proto3_has_no_name_segment`、`test-worktree-dialogs.mjs › delete_session_legacy_note`、`test-legacy-daemon.mjs`；e2e：`gui-worktree-smoke.mjs` › R9.1；gui-chat-smoke.mjs R17.2（协议 2 的 daemon） | 单元 / 浏览器 | 通过 | evidence/R9.1.png |
| R9.2 旧桌面端 + 新 daemon | Go 集成：`TestAttachWorktreeWithoutNameKeepsLegacyNaming`、`TestTerminalFramesUnchangedV3`、`TestV3ClientFlowAgainstV4Daemon`；e2e：`gui-worktree-smoke.mjs` › R9.2；同一用例运行基准提交的 `ws-smoke.mjs`（12 行 PASS） | 集成 / 浏览器 / 接口 | 通过 | 运行输出 |

58 个场景：58 个通过，0 个失败，0 个未覆盖。场景之外的用例（同一次运行）：`NFR.perf`、`X11.menu`、`X11.removing`、`X2.rename`、`X3.keys`、`X6.scroll`、`X8.menu` 通过。tasks.md 测试计划里点名的 Go 测试 `TestProjectsSingleWorktreeRepo`（含 `legacy_worktree_mode`）这一轮补上了（提交 `246b437`，三个子用例通过；两处故意改坏的实现下它会失败）。

## 交付预览

- 产物：**截图替代**。项目没有录屏能力（`dev-preview` skill 不存在），没有视频。关键流程留了一组按步骤编号的截图 `evidence/flow-01.png` … `flow-12.png`，每一步核对了什么写在 `evidence/flow-run.txt`。
- 来源：2026-11-20，本机（macOS，Electron 临时实例，1280×800），被测提交 `85a18cc` 的桌面端构建和 daemon（与 `5d8878c` 的代码相同）；操作全部是经 CDP 发给这个临时实例的真实指针和按键事件（`Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`），不是 DOM 的 `click()`。
- 操作与结果（同一个项目里同时开几条工作线，一条连贯的流程）：

  | 截图 | 这一步 | 核对（界面和磁盘） |
  |------|--------|--------------------|
  | flow-01 | 从机器概览经目录选择器在仓库 `shop` 开第一个终端会话 | 项目 `shop` 出现，标题「shop / main · shop」 |
  | flow-02 | 项目行上点「新建 worktree」，名字 `feature/checkout`，界面选「对话」 | 对话框写出基于 `main @ <提交>`、将创建的目录 `…/shop-worktrees/feature-checkout` |
  | flow-03 | 再建 `fix-cart`、`docs-update`（终端）；点到对话会话发一条消息 | `git worktree list` 是 4 项，4 个分支都在；⌘1、⌘2、⌘⇧]、⌘⇧]、⌘⇧[ 依次落在 shop、docs-update、feature-checkout、fix-cart、feature-checkout |
  | flow-04 | 在 `docs-update`、`fix-cart` 的终端里各自提交（1 个、2 个提交，另留 1 个未跟踪文件） | 磁盘上 `fix-cart` 比 `main` 多 2 个提交，`docs-update` 多 1 个 |
  | flow-05 | 双击 `fix-cart` 会话的名字，就地改名为「购物车修复」 | daemon 上的名字已改（这一步修复前做不了，见 X2） |
  | flow-06 | 删除这个会话：确认框 | 写明「worktree fix-cart 的目录和分支都会保留」，默认焦点在「取消」 |
  | flow-07 | 确认之后 | 会话消失，`fix-cart` 一行标「没有会话」；目录（含未跟踪文件）、分支、2 个提交都在 |
  | flow-08 | 删除 `docs-update`（里面有运行中的会话、1 个未合并提交）：确认框 | 「会先结束这 1 个会话」，预选「只删目录、保留分支」；回车后目录消失、分支 `docs-update` 和它的提交还在、会话已结束 |
  | flow-09 | 删除 `fix-cart`（1 个未跟踪文件、2 个未合并提交）：选「目录和分支都删」 | 默认按钮是「取消」；点「仍然删除」后目录和分支都没了 |
  | flow-10 | 折叠、展开项目和机器 | 折叠项目后 0 个会话行可见，折叠机器后 0 个项目行可见，展开后恢复；剩下 `main` 和 `feature/checkout` |
  | flow-11 | 在另一个仓库 `docs-site` 开一个会话再删掉，打开项目菜单 | 没有会话的项目仍在侧边栏，菜单里「从侧边栏移除」可用 |
  | flow-12 | 移除之后，再从目录选择器在 `docs-site` 开一个会话 | 移除后 daemon 的项目清单里没有它，磁盘上的仓库没有变化；新开会话后项目重新出现 |

  流程里 17 项核对全部成立，渲染进程没有异常和 console 错误。
- 覆盖范围：临时 daemon + `/bin/bash` + 假 claude + 临时 git 仓库，都在 `/tmp` 下；**没有覆盖**真实的 claude、远程 Linux 上的 daemon、打包签名后的 app（原生通知、红绿灯位置）、真实键盘经过 macOS 菜单和输入法的那一段。
- 成片核验：无成片。截图没有剪辑、标注或点击提示；提交前逐张看过，图里和 `flow-run.txt` 里没有 token。

## 探索式检查

检查的入口（视口都是桌面：1280×800 为主，另有 800×500 的最小窗口和 2200 宽）。用真实的 Electron 临时实例（两台临时 daemon：一台有 2 个仓库和 1 个普通目录，一台 23 个项目、其中一个项目 13 个 worktree；`allowed_roots` 只有 `/tmp` 下自建的目录），经裸 CDP 发真实的指针和按键事件：

- 连贯的工作流：即上面「交付预览」那一条，探索时先手工走了一遍（那时发现 X2、X4），修复后再走一遍留截图。
- 状态组合和打断：新建 worktree 对话框开着时停掉 daemon（名字下方显示「没能检查这个名字：Failed to fetch」，确认按钮不可用；daemon 回来后改一个字符即恢复）；删除确认框开着时停掉 daemon 再确认（对话框关闭，状态栏写明没有收到结果、以侧边栏为准，磁盘没变）；删除请求在途（拖慢 3 秒）时切换会话、按 Esc（行一直显示「正在删除…」，删除照常完成）；新建 worktree 时在「创建并打开」上连点两次（只发出一个 attach，只有一个 worktree、一个会话）；两个桌面端实例连同一个 daemon：A 新建 worktree，B 在 2.8 秒后看到；B 打开删除确认框之后 A 在那个 worktree 里提交，B 确认时得到「状态刚刚发生了变化」并按最新情况重开确认框（多出 1 个未合并提交和保留分支的选项），再确认后 A 那边的会话结束、那一行在下一次刷新消失。
- 输入的边界：32 个名字逐个输入（空、空格、`-x`、`a..b`、`@{`、已有分支、与已有分支互为前缀、中文、emoji、`<script>`、`&`、引号、零宽字符、250 / 251 字节、`HEAD`、`~ ^ : ? * [ \`、`.lock`、首尾斜杠、`@`），提示和确认按钮的状态都与规则相符，只有 `@` 一个例外（X5）；实际建了 219 个字符的分支名、`修复/登录-问题`、`fix<script>alert(1)</script>` 三个 worktree，侧边栏、标题、确认框里都按文字显示、超长处省略，没有被当成 HTML；会话名用 `<b>修复&"购物车"</b> 🛒 …`（95 个字符）同样。23 个项目、31 个会话、一个项目 13 个 worktree 时：侧边栏可滚动，`/api/v1/projects` 106 ms，连续 10 轮刷新（两台机器的请求加整体重建）1185 ms；快捷键按可见顺序计数、跨机器连续，连按 12 次 ⌘⇧] 没有丢键也没有字节进终端；发现 X6。
- 窗口：真实窗口缩到 800×500（主进程 `setSize`）：标题里分支先被截断、会话名保留；新建 worktree 对话框只有正文滚动、按钮在窗口内，「对话」卡片和 `-c` 复选框点得到；中文、英文各看了侧边栏、新建 worktree（8 种名字错误）、在 worktree 里新建会话、删除会话（主目录 / worktree）、删除 worktree 的 files / commits / external / detached 四种形态、项目菜单，没有漏翻和截断；菜单开着时缩窗、对话框开着时放大到 2200 宽，位置正常；发现 X8。
- 键盘可达性：只用键盘完成了新建 worktree（输入名字、Tab 到「对话」、空格选中、Tab 到确认、回车）和在 worktree 里新建会话；对话框里 Tab 不会跑到对话框外，焦点环可见，Esc 都能关掉对话框并把焦点还给原来的按钮；删除 worktree 走不通（X3，已修）。
- 视觉：对照效果页 M1 的 8 个画面看了侧边栏（悬停、选中、外部 / 主目录标签、没有会话的行）、标题、对话、终端、各对话框，没有发现新的走样；与效果页的差别只多出一处（不在分支上的 worktree 行用的是分支图标，效果页是提交图标），记入后续。
- 原有功能：终端输入、拖选后 ⌘C、⌘V（读回剪贴板后还原）、断线横幅与自动重连；对话的 Markdown、工具块、权限卡片（真实点击「是」）、斜杠菜单（Esc 关闭）；机器管理对话框（列表里不显示 token）；hook 事件让后台终端会话变成「等你处理」并发出通知（标题是「机器 · 项目 / 分支 · 会话」，未签名包走 Dock 降级）。都正常。daemon 和 Electron 的日志里没有 `could not read the running sessions from tmux`、`projects store: write failed` 这类行。

| 编号 | 程度 | 问题 | 处理 |
|------|------|------|------|
| X1 | 中 | 新建或重命名任何一个终端会话时，本窗口里其它打开着的后台终端会话全部亮起「有新消息」 | 未修复，交给用户决定（c7）。基准上同样，不是本需求引入 |
| X2 | 高 | 已经在本窗口打开过的会话，双击名字不进入改名（只有还没打开过的会话可以） | 已修复 `3f80670` |
| X3 | 中 | 项目菜单、worktree 菜单用键盘打得开但选不了：删除 worktree、从侧边栏移除只能用指针 | 已修复 `dc55d84` |
| X4 | 低 | 删除 worktree 后状态栏报「会话已退出（代码 -1）」，盖在切过去的另一个会话上 | 未修复，记入后续 |
| X5 | 低 | 名字 `@` 预检通过、创建时 git 失败，显示 git 的原始报错（目录和分支没有留下） | 未修复，记入后续 |
| X6 | 中 | 侧边栏放不下全部会话时，用快捷键切过去的会话的行在可见区之外 | 已修复 `85a18cc` |
| X7 | 低 | 正在看的对话会话出现待答请求后切走，该会话和折叠的项目行都不亮「等你处理」 | 未修复（双模式会话的规则，本需求没有改），记入后续 |
| X8 | 中 | 用指针打开行菜单后遇上 5 秒一次的刷新，菜单从按钮下方跳到按钮左边约 180px | 已修复 `6bd5d5a` |

### X1 [中] 新建或重命名终端会话时，其它后台终端会话全部亮起「有新消息」
- 页面：侧边栏（任何有两个以上已打开终端会话的窗口）
- 复现：打开 3 个终端会话 → 在任意项目里新建一个终端会话（或给任何一个会话改名，或另一台桌面这样做）
- 预期：只有真的有新输出的会话亮点
- 实际：其它 3 个会话的行都变成「终端 · 有新消息」。新建后的 0.4 秒内每个会话收到 10 次相同的 431 字节整屏重绘：daemon 用 `tmux set-option` 写会话的名字和归属，tmux 每执行一次就重绘这台 server 上的全部客户端
- 截图：evidence/X1.png；帧记录在 evidence/exploration-findings.md
- 处理：未修复，c7 交给用户。基准 `6d88e45` 的点亮规则逐字相同、每次新建执行 7 次 `set-option`（现在 11 次），按代码判断基准上同样会亮（没有在基准构建上实跑）；要去掉它得改已确认的点亮规则或元数据的存法

### X2 [高] 已打开过的会话双击名字不进入改名
- 页面：侧边栏的会话行
- 复现：点开一个会话 → 在它（或另一个已打开过的会话）的名字上双击
- 预期：名字变成输入框（「双击侧边栏内联重命名」）
- 实际：没有反应，焦点在终端里，接着敲的字进了远程 shell。页面只收到两次 click、没有 dblclick：第一次点击切换会话并重建侧边栏，第二次点击又重建一次，被点的元素离开页面，浏览器不再派发 dblclick。还没在本窗口打开过的会话（打开有 220 ms 延迟）可以改名
- 证据：evidence/exploration-findings.md（事件记录、回归用例修复前的输出）；修复后见 evidence/flow-05.png
- 处理：已修复（提交 `3f80670`，回归测试 `test-sidebar › double_click_renames_a_session_that_is_open`、`gui-worktree-smoke › X2.rename`）。基准上这段逻辑相同；此前所有用例都是直接派发 `dblclick` 事件或走 REST 改名，没有用真实的双击试过

### X3 [中] 行菜单用键盘选不了菜单项
- 页面：侧边栏项目行、worktree 行的「⋯」菜单
- 复现：Tab 到 worktree 行的「⋯」→ 回车（菜单打开）→ 按 ↓ 或 Tab
- 预期：能选到「删除 worktree」
- 实际：焦点留在按钮上，方向键没有反应，Tab 走向侧边栏的下一个按钮，菜单开着却永远选不到（它挂在 `body` 末尾）
- 截图：evidence/X3.png
- 处理：已修复（提交 `dc55d84`，回归测试 `test-sidebar › row_menu_from_the_keyboard`、`gui-worktree-smoke › X3.keys`）。做法见 decisions d66

### X4 [低] 删除 worktree 后状态栏的「会话已退出（代码 -1）」
- 页面：删除一个里面有已打开终端会话的 worktree 之后
- 复现：打开某个 worktree 里的终端会话 → 删除这个 worktree 并确认
- 预期：没有多余提示
- 实际：状态栏显示「会话已退出（代码 -1）」约 6 秒，此时主区域已经切到另一个会话
- 截图：evidence/X4.png
- 处理：未修复，记入后续

### X5 [低] 名字 `@`
- 页面：新建 worktree 对话框
- 复现：名字填 `@` → 显示目标目录、确认可点 → 确认
- 预期：对话框里提前说明不能用，或者创建成功
- 实际：状态栏显示 git 的原始报错（`could not find created worktree '@'`）；目录和分支都没有留下（R3.8 成立），`.git/worktrees/` 里留下一个空的 `-` 目录。纯 git 复现相同：`git worktree add ../@ -b x` 同样失败，是 git 自己不能在名为 `@` 的目录里建 worktree
- 截图：evidence/X5.png
- 处理：未修复，记入后续（要改 Go、桌面端和共用向量三处的名字规则）

### X6 [中] 快捷键切过去的会话的行在可见区之外
- 页面：侧边栏（会话多到需要滚动时）
- 复现：31 个会话，停在第一个 → 按 ⌘⇧[
- 预期：切到最后一个会话，并且看得到它在侧边栏里的位置
- 实际：会话切换了、标题也变了，侧边栏还停在顶部，高亮的行在可见区下沿之下约 2700px 处
- 截图：evidence/X6.png
- 处理：已修复（提交 `85a18cc`，回归测试 `test-shortcuts › switching_reveals_the_row_via_index`、`gui-worktree-smoke › X6.scroll`）

### X7 [低] 离开有待答请求的对话会话后不亮「等你处理」
- 页面：侧边栏
- 复现：打开一个对话会话，让它出现权限确认 → 不回答，切到别的会话（或把项目折叠）
- 预期：那个会话的行、折叠的项目行显示「等你处理」
- 实际：都没有点；点只在请求到达时会话不在前台才亮（R1.6 的场景是这样，通过）
- 截图：evidence/X7.png
- 处理：未修复。规则在 `chat/activity.ts`，是双模式会话定下的，本需求没有改；记入后续

### X8 [中] 行菜单开着时遇到刷新，菜单跳到按钮左边
- 页面：侧边栏项目行、worktree 行的「⋯」菜单
- 复现：用鼠标点开某个 worktree 行的「⋯」→ 等到下一次 5 秒刷新（或让应用刷新一次）
- 预期：菜单留在按钮下方
- 实际：菜单从 x=242 跳到 x=63（按钮左边 179px），正要去点的菜单项从指针下面跑开。行的操作按钮只在悬停或聚焦时占位置，重建出来的行在那一刻两样都不是
- 截图：evidence/X8.png
- 处理：已修复（提交 `6bd5d5a`，回归测试 `test-sidebar › menu_button_is_marked_expanded_while_its_menu_is_open`、`gui-worktree-smoke › X8.menu`）。上一步的 `X11.menu` 用 DOM 的 `click()` 打开菜单，行从头到尾没有悬停过，所以没有发现

没有发现问题的方面：创建和删除的磁盘结果（每一步都读了 `git worktree list`、分支和目录，与界面一致）；确认后连点、断线、两台桌面并发时没有多建、漏删或删错；名字和会话名里的特殊字符没有进入 HTML；800×500 和中英文下没有按钮被挤出窗口或文字重叠；终端和对话的原有功能没有被破坏。

上一步报告顺带提到的三处，判断如下：

- 新建会话对话框里「对话」卡片在目录信息回来之前短暂显示未信任文案：**不算缺陷，记入后续**。本机逐帧采样，这句话显示了约 33 ms（2 帧），随后变成可选；是 `chatAvailability` 原有的行为（目录选择器里也一样），远程链路上会更久，`/api/v1/fs` 失败时会一直留着。
- daemon 的 PATH 里没有 tmux 而 socket 在时，`worktrees/status` 的会话列表为空：**不算缺陷，保留在后续**。确认框会少列会话，但删除被 500 拦住并写明原因（`ws-worktree-smoke` 的「no tmux program on PATH but its socket is there」），不丢东西。
- tasks.md 计划的 `TestProjectsSingleWorktreeRepo` 不存在：**已补上**（提交 `246b437`）。

## 待验证项

来自 review.md 的 13 条，实验是上一步做的（`evidence/pending-checks.md`，被测 `ba9caa4`）；这一轮对第 11 条有新的发现。

| 来源（review.md「待验证项」） | 做的实验 | 结果 | 证据 |
|------------------------------|----------|------|------|
| 1，`test-theme-tokens.mjs:322`：M1 的整体画面 | 临时实例里走一轮含工具调用和权限请求的对话、开一个终端会话，断言形态和实际像素，截图与效果页逐块对照 | 已排除（已记录的几处外观差异仍在；这一轮多记一处：detached 行的图标） | evidence/R8.1.png、R8.2.png |
| 2，`test-dialog-layout.mjs:14`：800×500 中英文下各对话框 | `dialog-layout.mjs` 在 800×500、中英文各量 13 个画面 | 已排除；这一轮在真实缩小的窗口里又看了一遍英文的四种删除确认框 | evidence/R8.5.png |
| 3，`main/index.ts:102`：冷启动首帧 | 主进程停在第一条语句，记录窗口原生底色和第一次绘制完成的整帧 | 已排除到「第一次绘制完成的那一帧」；窗口出现到首次绘制之间（约 0.1 秒）屏幕上实际合成的像素**仍缺条件**（要录屏） | evidence/R8.6.png |
| 4，`shortcuts.ts:48`：真实键盘 | CDP 按键：捕获阶段拦截、切换、终端 0 字节、草稿不变 | **仍缺条件**：缺的是真实键盘经过 macOS 菜单分发和输入法的那一段（不允许向系统前台发按键）。下一步：人在打包后的 app 里按一遍，步骤见「未覆盖和遗留」 | 运行输出（R7.1–R7.5） |
| 5，`worktree.go:90`：git 低于 2.31 | 从源码构建并安装 git 2.30.2：那条规则的 6 个测试、`ws-worktree-smoke.mjs` 9 例 | 已排除（2.30.2）；更早的版本没有测 | evidence/ws-worktree-smoke-git-2.30.2.txt |
| 6，`runner.go:209`：全新的 tmux 环境、没有 tmux 程序 | 临时 daemon 经 REST 删除没有会话的 worktree，3 种环境 | 已排除 | evidence/final-run/ws-worktree-smoke.txt |
| 7，`runner.go:209`、`manager.go:130`：对账四条规则 | 经 REST 走三种状态，每例读回磁盘和 tmux；代码与 CLAUDE.md 逐句对过；旧提交的 daemon 上用例会失败 | 已排除（测试工程师做的实验，不代替关口 C 的独立验证者再看一遍） | 同上 |
| 8，`runner.go:51`：`TMUX_TMPDIR` 指向不存在的目录时 tmux 把 socket 放在哪 | 只读了 tmux 3.2a、3.0a 的源码 | **仍缺条件**：缺一个可以随意使用默认 tmux 目录的环境（容器）。源码显示 3.0a 不回退到 `/tmp`（报错退出），与 `tmuxSocketPath` 不一致，后果的方向是拒绝删除。下一步：容器里用 tmux 3.0、3.1、3.2 各跑一次 `TMUX_TMPDIR=/nonexistent tmux -L vibe-remote new-session -d`，并在文档里写明 `TMUX_TMPDIR` 必须指向存在的目录（升级步骤里已写） | evidence/pending-checks.md 第 8 条 |
| 9，`worktree.go:46`：百万级未合并提交 | `git fast-import` 造 100 万个提交，量 `rev-list --count` 和 status | 已排除（3.9 秒） | evidence/pending-checks.md 第 9 条 |
| 10，`worktree.go:47`：`git worktree remove` 到时限被杀 | 把时限改成 4 秒的临时构建加一个不返回的 git 包装 | 已排除 | evidence/pending-checks.md 第 10 条 |
| 11，`sidebar.ts:140`、`index.ts:99`：行菜单跟随重建、「正在删除…」的行 | 上一步：`X11.menu`、`X11.removing`（DOM 点击）。这一轮：用真实指针打开菜单再刷新 | 「正在删除…」已排除；**行菜单跟随重建复现出问题（X8），已修复**，原用例和新用例都通过 | evidence/X8.png、运行输出 |
| 12，`worktree-name.ts:19`：Electron 的 ICU 与 Go 的 Unicode 表 | 渲染进程和 Go 各跑全部码位 | 已排除（各拒绝 172 个，集合相同） | evidence/pending-checks.md 第 12 条 |
| 13，`projects.go:318`：没有归属也没有 `@vibe_remote_workdir` 的旧终端会话 | 手工起一个不带任何选项的 tmux 会话再启动 daemon，直接查状态并删除 | 已排除 | evidence/final-run/ws-worktree-smoke.txt |

## 修复记录

| 问题 | 提交 | 回归测试 | 复测 |
|------|------|----------|------|
| X2 双击已打开的会话不能改名 | `3f80670` | `test-sidebar › double_click_renames_a_session_that_is_open`；`gui-worktree-smoke › X2.rename` | 两个用例修复前失败、修复后通过；最终全量运行通过 |
| X8 行菜单在刷新后跳开 | `6bd5d5a` | `test-sidebar › menu_button_is_marked_expanded_while_its_menu_is_open`；`gui-worktree-smoke › X8.menu` | 同上；原有的 `X11.menu`、`X11.removing`、R2.3、R2.4、R5.x 通过 |
| X3 行菜单不能用键盘操作 | `dc55d84` | `test-sidebar › row_menu_from_the_keyboard`；`gui-worktree-smoke › X3.keys` | 同上 |
| X6 快捷键切换后行不在可见区 | `85a18cc` | `test-shortcuts › switching_reveals_the_row_via_index`；`gui-worktree-smoke › X6.scroll` | 同上；R7.1–R7.5 通过 |
| 计划里的 Go 测试缺失 | `246b437` | `TestProjectsSingleWorktreeRepo`（`submodule`、`separate_git_dir`、`legacy_worktree_mode`） | 通过；两处故意改坏的实现下失败 |

四个修复前的失败输出在 `evidence/exploration-findings.md`。没有撤回过修复。四个修复都只动桌面端的 `sidebar.ts`、`menu.ts`、`styles.css`、`index.ts`（一行）和测试，**没有涉及删除、撤销、信任规则、协议这些关键路径**；daemon 的代码这一轮没有改（只加了一个测试）。X3 的修复把「菜单项的动作」和「关闭菜单」的先后对调了（先关再执行），「删除 worktree」「从侧边栏移除」的入口因此经过了改动，这两条路径的用例（R2.3、R2.4、R5.1–R5.12、`X11.*`、`X3.keys`、`X8.menu`）在最终运行里全部通过。

## 未覆盖和遗留

- **没有真实的 claude 和远程 Linux 上的验证**。所有运行都在本机：临时 daemon、`/bin/bash`、假 claude、git 2.50.1、tmux 3.6a、macOS 文件系统。真实 claude 的 stream-json 和信任文件、Linux 上的 tmux 和 git 版本、经 Tailscale 的延迟都没有覆盖。
- **没有真机上的原生通知**。未签名构建不显示原生通知（走 Dock 降级），断言的是应用发出的通知标题；点击原生通知打开会话只有模拟的点击。
- **真实键盘待人工确认**（待验证项 4）。步骤：`cd desktop && npm run build -- --dir`，打开 `release/mac-*/vibe-remote.app`，连一台有 5 个以上会话的机器，然后：
  1. 焦点在终端里：按 ⌘3 → 切到侧边栏从上往下第 3 个会话；⌘⇧] / ⌘⇧[ → 下一个 / 上一个，到头循环；终端里没有多出字符。
  2. 焦点在对话输入框里（先打几个字）：按 ⌘⇧]、⌘1 → 会话切换；切回来草稿还在，没有多出 `}` 或 `1`。
  3. 会话数少于 9 时按 ⌘9 → 不动；折叠一个项目后按 ⌘⇧] 转一圈 → 不停在其中的会话上。
  4. 打开新建会话对话框、删除确认框各一次，按 ⌘2、⌘⇧] → 不切换。
  5. 换成中文输入法（拼音）再做第 1、2 步 → 结果相同，候选窗不弹出。
  6. 看菜单栏：这些键没有触发系统或应用菜单里的任何一项。
  7. （这一轮新增）Tab 到某个 worktree 行的「⋯」，回车、回车 → 出现删除确认框；Esc 关闭后焦点回到「⋯」。会话多到要滚动时按 ⌘⇧[ → 侧边栏滚到被选中的那一行。
- **冷启动首帧只证明到首次绘制**：窗口创建后的原生底色和第一次绘制完成的整帧都是新主题；两者之间约 0.1 秒屏幕上实际合成的画面没有取到（要录屏）。
- **没有低于 git 2.30.2 的实测，最低 git 版本没有写进文档**（Ubuntu 20.04 自带 2.25）。升级步骤里写的是「实测过 2.30.2 和 2.50.1」。
- **`TMUX_TMPDIR` 指向不存在的目录时旧版 tmux 的行为**没有实跑（待验证项 8）。
- **c6**（review.md「交给用户决定」）：`TestGitEnvKeepsInheritedConfig` 里依赖 `GIT_CONFIG_COUNT` 的子用例在 git 低于 2.31 时跳过，是否保留这个条件跳过等用户决定。推荐保留。
- **c7**（这一轮新增）：X1，后台终端会话的「有新消息」点在别处新建 / 重命名会话时全部亮起，要不要改点亮规则等用户决定。
- 这一轮没有修、记入 tasks.md「后续」的：X4、X5、X7，「对话」卡片在信任结果回来之前的文案，daemon 重启后机器状态多停一个退避周期（实测 8.9 秒），detached 行的图标，目录选择器里用键盘进入子目录后的焦点。
- **已知的偶发失败**（清单见「汇总」下方）这一轮一次都没有出现，没有重跑；它们的原因仍然没有查清，记录在 tasks.md「后续」。
- `/protocol-sync` 这一轮只做了机械可比的部分（类型字段、路由、版本号），错误码等开放集合没有重新逐项核对；这一轮没有改协议文件。
- 「交付预览」是截图，没有录屏。
- 独立验证（dev-test 第 8 步，机器关口 C）**没有做**，由主会话安排。

## 验收核对

| 方面 | 结论 | 依据 |
|------|------|------|
| 完整 | 成立 | tasks.md「进度」里 T1–T20（含 T6a / T6b / T6c）22 个任务都有完成记录，没有「阻塞」；R1–R9 的 58 个场景每个都有单元 / 集成测试（R8.3 除外，它本身就是运行两份冒烟）和真实应用里的用例，最终运行 58 个通过；测试计划里点名的测试现在都存在 |
| 正确 | 成立 | `make check` 和六份冒烟在 `5d8878c` 上全过。抽查 spec 的文案：R3.4「分支 {branch} 已存在」、R3.5「目录已存在：{path}」、R3.10「目录不在允许的范围内：{path}」、R3.6「基于 main @ 8b50ad8，不包含未提交的改动」；R5.1「worktree … 的目录和分支都会保留」、R5.3「有 {n} 个文件未提交或未跟踪。删除 worktree 会丢弃它们」+「仍然删除」+ 默认取消、R5.4「另有 {n} 个被 git 忽略的文件会一并删除」、R5.5「只删目录、保留分支」（默认）/「目录和分支都删」、R5.8「不是由 vibe-remote 创建：只删目录，分支 … 保留」、R5.11「这 {n} 个提交删除后不再属于任何分支」；R6.1「对话界面会切到已有的那个会话，终端界面可能无法启动。不勾选即可开一段新对话」——`i18n.ts` 里的字符串与 spec 的说法一致，并在运行中的对话框里读到。数值：名字上限 250 字节（250 可用、251 被拒）、目录是 `<仓库名>-worktrees/<名字，斜杠换成连字符>`、最小窗口 800×500、性能（`/api/v1/sessions` 多 1.1 ms，上限 200 ms） |
| 一致 | 成立 | 开发阶段的调整都在 design.md 第 10 节和 decisions.md 里；这一轮的四个修复补进了第 10 节（「测试阶段的修复」）和 decisions #134、#135、d66、d67 |
| 干净 | 成立 | 提交后 `git status --short` 为空；产品代码相对基准新增的行里没有 `console.log`、`debugger`、`fmt.Print`、TODO / FIXME，也没有注释掉的代码段；`.devflow-tmp/` 不在仓库里（`git ls-files` 0 个，写在 `.git/info/exclude`） |
| 改全 | 成立，补了一处 | 没有新增配置项（`state_dir` 早已在 `vibe-remoted.example.json` 里）。**design.md 第 10 节原来没有「升级步骤」，这一轮补上了**：桌面端和 daemon 一起升级、先升 daemon；两种先后顺序各自的中间状态（先升 daemon：旧桌面端照常用，删会话后留下的 worktree 要等升级桌面端才看得到；先升桌面端：分组降级、两个入口置灰，旧 daemon 删 Worktree 会话时仍会连 worktree 和分支一起删，不要久留）；daemon 的 5 个步骤（换二进制、`state_dir` 可写、git / tmux 在 PATH 上、重启、升级桌面端）；升级前留下的会话（自动补归属）、旧 Worktree 模式建的 worktree（按 vibe-remote 创建认领，可从界面删）、别的工具建的（标「外部」）、子模块和 `--separate-git-dir` 仓库里的（手动清理）；回退。19 条不变规则的检查全部通过 |
