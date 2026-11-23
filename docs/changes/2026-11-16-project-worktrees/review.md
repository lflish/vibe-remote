# 评审：按项目和 worktree 组织会话，并更换视觉风格

日期：2026-11-20　范围：`6d88e45..949c9b2`（`949c9b2` 是最后一个改代码和规则文件的提交；本报告所在的提交在它之后，只加评审报告、证据和记录）　评审者：三轮，都没有写过被评审的代码——

- 第一轮（评审对象 `e278f87`）：daemon 侧和桌面端各一个同一模型的全新子 agent（各自起临时 daemon / 临时 Electron 实例做实验）；横切面由 codex 做（其他模型，只读静态评审：检查有没有被放松、协议三处是否一致、规则文件的说法、58 个场景的自动化覆盖）。
- 第二轮（复评第一轮的修复，`e278f87..c74e715`）：同一模型的全新子 agent。
- 第三轮（核对第二轮的修复，`c74e715..3b01cf3`）：同一模型的全新子 agent。

评审原文和裁决在 `evidence/review/`（8 个文件，原样复制；复制前查过，里面没有 token 一类的敏感串）。

结论：已证实且未处理的严重问题 0 个；待验证项 13 个

| 统计 | 严重 | 一般 |
|------|------|------|
| 已修复 | 2 | 50 |
| 交给用户决定 | 0 | 1 |
| 不采纳 | 0 | 2 |

数字的来历（逐条见下文）：

- 第一轮 daemon 侧 16 条：9 条已证实（都修了）、可维护性 5 条（4 条采纳并修、1 条不采纳）、待验证项 2 条（做最小实验后都被证实并修）。
- 第一轮桌面端 14 条：11 条已证实（都修了）、待验证项 3 条（2 条被证实并修，1 条是基准提交上就有的问题、不采纳）。
- 第一轮横切面 14 条：11 条已修或加强了测试，3 条是浏览器层的检查，转为下面的待验证项（不计入上表）。
- 第二轮 10 条：2 条严重、8 条一般，都修了。
- 第三轮 3 条：2 条一般、1 条待验证项，都在这次修了。
- 「交给用户决定」的 1 条是修复过程中的一处检查放松（c6），不在评审原文的条目里。
- 合计：已修复 2 + 50，不采纳 2，转待验证 3，共 57 条，与五份评审文件的条目数相符（16 + 14 + 14 + 10 + 3）。

## 已修复

每条：编号（与裁决文件一致）、问题、提交、回归测试。问题的位置、复现方式和修复前的输出见 `evidence/review/` 里对应的评审文件；修复前测试失败的输出见 decisions.md 对应的行。

### 严重（2 条，都是第一轮修复引入的回归，由第二轮复评发现）

- [严重] R1 `vibe-remoted/internal/session/projects.go`（`sessionTableCurrent`）、`runner.go`（`isNoTmuxServer`）：tmux 的 socket 文件还不存在（重启后没开过终端会话、只用对话界面）或没装 tmux 时，任何 worktree 都删不掉，恒 500。第一轮「待验证 1」的修法（`6c77d1c`：对账没应用就拒绝）把这种稳定状态也当成了对账失败；同一请求在基准 `e278f87` 上是 200。证据：全新 `TMUX_TMPDIR` 的临时 daemon 上 `POST /api/v1/worktrees/remove` → 500 `could not read the running sessions from tmux…`，日志 `error connecting to …/tmux-501/vibe-remote (No such file or directory)`。→ socket 文件不存在、找不到 tmux 程序都算「没有终端会话」，只有 server 在而查询失败才算对账失败（提交 `1d9a6f1`；回归测试 `TestRemoveWorktreeWhenTmuxHasNoSocketYet`、`TestRemoveWorktreeWhenTmuxIsNotInstalled`、`TestRemoveWorktreeRefusedWhenTmuxSocketDoesNotAnswer`、`TestLiveTmuxSessionsTellsNothingRunningFromAFailedQuery`、`TestTmuxSocketPathIsWhereTmuxPutsIt`）。这个修法又放得太宽，第三轮的 T1、T2 把它收窄，见下。
- [严重] R2 `vibe-remoted/internal/session/worktree.go`（`gitEnv`、`DirtyFiles`、`IgnoredFiles`）：git 低于 2.31 的机器上，查看 worktree 状态又会运行仓库配置的 `core.fsmonitor` 程序。第一轮 G4 的修法（`3dfa974`）改用 `GIT_CONFIG_COUNT` 环境变量并删掉了原有的 `-c`，而这个环境变量 git 2.31 才认。证据：从源码构建的 git 2.30.2 上 `TestReadOnlyGitRunsNoRepositoryProgram`、`TestCreateAndRemoveWorktreeDoNotRunFsmonitor`、原有的 `TestDirtyFilesDoesNotRunFsmonitor`、`TestGitEnvKeepsInheritedConfig` 4 个 FAIL，基准上 `TestDirtyFilesDoesNotRunFsmonitor` PASS。→ 每条 git 命令行最前面带 `-c core.fsmonitor=false`，环境变量那一套去掉（提交 `cef5e4d`；回归测试 `TestFsmonitorStaysOffOnGitWithoutConfigEnvironment`、`TestEveryGitCallTurnsFsmonitorOff`，原 4 个用例在 2.30.2 和本机 2.50.1 上都通过）。

### 一般：第一轮 daemon 侧（15 条）

- [一般] G1 `session/projects.go`：`Projects()` 把仍然存在的创建记录删掉，worktree 永久变成「外部」（三种触发方式）→ 只在所属项目本轮读成功且 git 的列表里没有这个路径时才清（提交 `d72f618`，`TestProjectsKeepsRecordOfExistingWorktree`）。
- [一般] G2 `session/worktree.go`、`manager.go`：容器目录是符号链接、或名字是 NFD 写法时，新 worktree 记成 git 没登记的路径 / 名字：会话挂不到它下面、删除时不结束其中的会话、撤销清不掉 → 建好后读一次列表，以 git 登记的为准（提交 `ac1d169`，`TestCreateWorktreeUnderSymlinkedContainer`、`TestUndoUnderSymlinkedContainer`、`TestCreateWorktreeRecordsGitsSpellingOfTheName`）。
- [一般] G3 `session/projects.go`（`buildProject`）：先开会话、后在上层 `git init`，项目树把真正的主目录列成可删的「外部」worktree → 项目 id 必须是列表第一项，否则按非 git 项目（提交 `0842128`，`TestProjectsDirectoryInsideLaterRepositoryIsNotAProject`）。
- [一般] G4 `session/worktree.go`：`core.fsmonitor` 只关了一半，被 409 拒绝的删除请求也会运行它 → 所有 git 调用统一关闭（提交 `3dfa974`，做法后被 `cef5e4d` 换掉，见 R2；`TestReadOnlyGitRunsNoRepositoryProgram`、`TestCreateAndRemoveWorktreeDoNotRunFsmonitor`、`TestGitEnvKeepsInheritedConfig`）。
- [一般] G5 `session/projects.go`（`sessionsIn`）：删除 worktree 时，工作目录在它里面、归属算在别处的会话不被结束 → 按目录判断（提交 `a8b4253`，`TestRemoveEndsSessionsAttributedElsewhere`；「目录」后经 R7 定为创建时的目录）。
- [一般] G6 `session/projects.go`、`worktree.go`：分支还没有提交的 worktree 查状态恒 500、删不掉；以它为发起处时预检放行、新建失败 → 没有提交时未合并提交数记 0；预检多一个原因 `no_commits`（提交 `6a77457`，`TestStatusAndRemoveUnbornWorktree`、`TestPlanRefusesSourceWithoutCommits`；桌面端的对应处理 `56f4d66`，`no_commits_turns_the_name_field_off`）。
- [一般] G7 `session/worktree.go`：worktree 里未跟踪的独立 git 仓库在确认框上只算 1 个文件，同意丢弃后它的提交一起消失 → 动手前拒绝并写明目录和手动处理办法（提交 `355f043`，`TestRemoveUntrackedRepositoryRefused`、`TestUntrackedRepositories`）。
- [一般] G8 `session/projects.go`：确认后分支被切换，「目录和分支都删」静默降级成只删目录 → 409 `worktree_changed`，请求带确认时看到的 `branch`（提交 `0c6f398`，桌面端 `b2d2233`；`TestRemoveBranchSwitchedAfterConfirmation`，两端的衔接 `TestWorktreeRemoveBranchMismatchCarriesStatus`）。
- [一般] G9 `session/worktree.go`、`desktop/src/renderer/worktree-name.ts`：超长名字、零宽和方向控制字符通过预检 → 两条本地规则，两边和共用向量一起改（提交 `26356ce`、`13dfbd1`、`ebdc958`、`5996d09`；`TestWorktreeNameLengthAndInvisibleCharacters`、`TestTooLongPathIsNotReportedAsNotAllowed`、`TestValidateWorktreeName`、桌面端 `name_length_and_invisible_characters`）。
- [一般] 可维护性 1、2、3、5（4 条，一个提交）`session/manager.go`、`config/config.go`、`session/worktree.go`、`server/projects.go`：注释错位、`StateDir` 注释不全、`gitAt` 注释与用法不符、`workdir` 是文件时预检返回 500 → 注释改准，后一种返回 400（提交 `c811720`，`TestPlanWorktreeWorkdirIsAFile`）。
- [一般] daemon 待验证 1（已证实）`session/projects.go`：daemon 刚重启、对账被丢弃时，删除 worktree 漏掉其中正在运行的终端会话 → 对账没应用时重试一次，仍不成功在动手前返回 500（提交 `6c77d1c`，`TestRemoveWorktreeAfterRestartNeedsTheSessionsFromTmux`；它带出的回归见 R1）。
- [一般] daemon 待验证 2（已证实）`session/worktree.go`、`projects.go`：不带超时的 git 卡住时仓库锁不释放，同一仓库之后的新建和删除全部挂起 → 每个 git 调用都带时限（5 秒 / 30 秒 / 5 分钟）（提交 `5a34678`，`TestStuckGitReleasesTheRepositoryLock`）。

### 一般：第一轮桌面端（13 条）

- [一般] D1 `desktop/src/renderer/index.ts`（`refreshAllMachines`）：一个仓库的 git 卡住时整台机器的项目树不再刷新 → 应答按「机器 × 请求种类」的序号应用，轮询不作废上一轮（提交 `3c33d32`，`slow_answers_survive_the_next_poll`）。
- [一般] D2 `desktop/src/renderer/menu.ts`：最后一行的「⋯」菜单画到窗口外（800×500 必现）→ 放不下时翻到按钮上方（提交 `838cd97`，`shell-layout.mjs` 的 `rowMenuLayout`、`row_menu_stays_inside_the_window`）。
- [一般] D3 `desktop/src/renderer/styles.css`：标题里长分支把会话名挤成「l…」→ 分支先让位（提交 `7450d3f`，`shell-layout.mjs` 的 `titleLayout`）。
- [一般] D4 `desktop/src/renderer/dirpicker.ts`：`/api/v1/info` 没回来时 Worktree 模式可确认，建出没名字的 worktree → 确认按钮等 info，info 失败时 Worktree 模式不可用（提交 `b81dd50`，`picker_waits_for_machine_info`、`picker_info_failed`）。
- [一般] D5 `desktop/src/renderer/sidebar.ts`：折叠的机器会话归零后再也展不开 → 没有任何项目时才禁用箭头（提交 `9f9a64c`，`collapsed_machine_without_sessions_can_expand`）。
- [一般] D6 `.claude/skills/verify/scripts/gui-smoke.mjs`：快捷键的两条冒烟断言分不出按键有没有被拦截 → 新增 3 条直接断言拦截的检查，原断言保留；在去掉拦截的变异构建上核对过（提交 `02406b0`，gui-smoke 第 11 步）。
- [一般] D7 `desktop/src/renderer/worktree-dialogs.ts`、`index.ts`：删除请求发出后没有「正在删除」的表示，行和菜单照常可用 → 行显示「正在删除…」，入口置灰（提交 `9fc9420`，`remove_result_closes_views`、`delete_flow_reports_request_in_flight`）。
- [一般] D8 `desktop/src/renderer/worktree-dialogs.ts`：输完名字立刻回车没有反应 → 回车不等防抖和预检（提交 `ef7da8d`，`new_worktree_enter_right_after_typing`）。
- [一般] D9 `desktop/src/renderer/sidebar.ts`：每轮轮询整体重建，键盘焦点丢失、开着的菜单失去锚点 → 重建后找回焦点和菜单（提交 `0bfb4ee`，`focus_survives_a_rebuild`、`open_menu_follows_its_row_through_a_rebuild`）。
- [一般] D10 `desktop/src/renderer/sidebar.ts`、`index.ts`：能力状态 `unknown` 时把协议 4 的 daemon 说成「旧版」，删会话确认框写着 worktree 会被一并删除 → `unknown` 用中性文案（提交 `198afd7`，`unknown_is_not_called_old`、`delete_session_unknown_daemon_note`、`legacy_note_and_disabled_entries`）。
- [一般] D11 `desktop/src/renderer/session-form.ts`：800×500 下 `-c` 的说明落在可见区域之外 → 勾选时滚进可见区（提交 `eadca33`，`shell-layout.mjs` 的 `continueNoteLayout`、`continue_note_is_scrolled_into_view_when_ticked`）。
- [一般] 桌面端待验证 1（已证实）`desktop/src/renderer/worktree-dialogs.ts`：删除 worktree 得到 404 时把确认框里的会话都当成已结束并关掉视图 → 404 不关任何视图（提交 `fdfd8bb`，`delete_flow_remove_404`、`remove_result_closes_views` 的 404 一段）。
- [一般] 桌面端待验证 2（已证实）`desktop/src/renderer/tree.ts`、`sidebar.ts`：唯一列出的 worktree 不是主目录时没有删除入口 → 这种项目保留 worktree 行（提交 `c4b1771`，`single_worktree_that_is_not_main_keeps_its_row`、`single_worktree_that_is_not_main_has_a_row_and_a_menu`）。

### 一般：第一轮横切面（11 条）

- [一般] X1 `vibe-remoted/internal/server/projects.go`：删除请求不校验必填字段，缺 `sessions` 仍可成功删除 → 缺 `path` / `head` / `sessions` 是 400（提交 `fe9ad8d`，`TestWorktreeRemoveRequiresConfirmedFields`）。
- [一般] X2 `vibe-remoted/internal/server`：首个 JSON 之后的超长内容不保证 413 → 整个请求体计入上限，对象之后有内容是 400（提交 `39c4d77`，`TestWorktreeRemoveBodyLimitAndTrailingData`）。
- [一般] X3 `docs/protocol.md`、`CLAUDE.md`：声称拒绝未登记的 worktree 路径之前不运行 git，代码先做仓库探测 → 文档改成代码实际保证的两步，并加用例守住（提交 `5968e57`，`TestWorktreePathChecksBeforeGit`）。
- [一般] X4 `vibe-remoted/internal/server/ws.go`、`session/manager.go`：名字以 `-` 开头时仍先运行 git → 新建会话时本地规则在任何 git 调用之前（提交 `44ec9b9`，`TestAttachRefusesBadWorktreeNameBeforeAnyGit`、`TestCreateRefusesBadWorktreeNameBeforeAnyGit`；预检那一半没有改，见「不采纳」后的说明）。
- [一般] X5 `docs/protocol.md`、`CLAUDE.md`：承诺「创建失败绝不留目录和分支」漏了例外 → 如实写（提交 `19c2b55`，文档，无测试）。
- [一般] X6 `desktop/src/shared/protocol.ts`、`rest.ts`：项目列表响应的类型漏 `proto`、`projects` 可缺省 → 两个字段必填，缺 `projects` 数组按请求失败处理（提交 `9dccd90`，`test-rest-projects` 的 `listProjects: a 200 without the projects array is an error, not an empty tree`）。
- [一般] X7 `docs/protocol.md`：新端点没列全错误枚举 → 补全（提交 `38c47f5`，文档，无测试）。
- [一般] X8 `desktop/scripts/test-tree.mjs`：顺序稳定性的测试数据太少 → 3 个项目、8 个会话、手写期望（提交 `5c8e848`，`order_three_projects_eight_sessions_new_daemon`、`order_three_projects_eight_sessions_old_daemon`、`rows_are_drawn_in_the_daemons_order`）。
- [一般] X9 `desktop/scripts/test-sidebar.mjs`：没断言会话类型图标 → 逐行核对类型和图标（提交 `a7f6546`，`renders_three_levels`）。
- [一般] X10 `desktop/scripts/test-sidebar.mjs`：折叠项目只断言点存在 → 断言是「等你处理」那一种（提交 `a7f6546`，`collapsed_project_shows_waiting_dot`）。
- [一般] X13 `desktop/scripts/test-theme-tokens.mjs`：对比度表没覆盖按钮实际的合成背景 → 按样式表的层叠结果算（提交 `95fea76`，`button_text_contrast_from_the_stylesheet`）。

### 一般：第二轮（8 条）

- [一般] R3 `session/worktree.go`（`worktreeClaim.undo`）：`git worktree add` 到时限被杀后留下 `locked initializing` 的残留，撤销清不掉 → 认定是本次的那一项用两个 `--force` 删（提交 `53e0aff`，`TestWorktreeAddKilledDuringCheckoutIsUndone`）。
- [一般] R4 `session/worktree.go`：新建后读回失败时，撤销留下目录却删了分支 → 读回失败先重试；没能确认 worktree 已移除就不删分支（提交 `2506ed0`，`TestCreateWorktreeReadBackFails`）。
- [一般] R5 `.devflow.yml`、`session/worktree.go` 的注释：新规则「不执行仓库配置指定的程序」写得比代码能保证的宽 → 收窄为「不运行 `core.fsmonitor` 指定的程序」，写明过滤器和 hook 不在其内（提交 `1810f6a`；规则的检查命令原样通过）。
- [一般] R6 `desktop/src/renderer/worktree-dialogs.ts`、`index.ts`：删除成功后、刷新回来之前，「正在删除…」的行变回可点 → 成功时标记留到刷新结束（提交 `1d322a6`，`delete_flow_says_whether_the_worktree_is_gone_when_the_request_is_over`、`remove_result_closes_views` 新增一段）。
- [一般] R7 `session/projects.go`（`sessionsIn`）、`manager.go`：daemon 重启前后对同一个会话「在不在这个 worktree 里」结论不同 → 创建时的工作目录存进 tmux 选项 `@vibe_remote_workdir`（提交 `b456156`，`TestSessionsOfAWorktreeGoByWhereTheyWereCreatedAcrossRestart`、`TestStartDirSurvivesRestartTmux`）。
- [一般] R8 `session/projects.go`：目录有一轮读不到（`prunable`）时创建记录被清 → 只在 git 的列表里完全没有这个路径时才清（提交 `0da017a`，`TestProjectsKeepsRecordWhileGitStillListsTheWorktree`）。
- [一般] R9 `CLAUDE.md`：说「列表里确实没有才清」，代码在 `prunable` 时也清 → 随 R8 的代码改动成立（提交 `0da017a`，同一用例）。
- [一般] R10 `session/worktree.go`、`desktop/src/renderer/worktree-name.ts`、`i18n.ts`：名字新规则的提示说成「git 不接受这个分支名」→ 各有原因码和文案 `invisible`、`too_long`（提交 `be731b6`，`TestValidateWorktreeName` 的共用向量、`TestWorktreeNameLengthAndInvisibleCharacters`、桌面端 `name_length_and_invisible_characters`）。

### 一般：第三轮（3 条，本次修；T1、T2 是 R1 的修法 `1d9a6f1` 放得太宽带出来的）

- [一般] T1 `session/runner.go`（原 `noTmuxServerPossible`）：tmux server 活着、socket 文件被删时被判成「没有任何会话」：会话从表里消失、claude 会话占用被释放、删除 worktree 漏掉会话。证据：修复前 `TestSocketFileGoneWhileTheTmuxServerRuns` 输出 `liveTmuxSessions() = map[], true; want a failed reading: the socket file is gone and the daemon remembers a terminal session`。→「socket 不存在 ⇒ 没有会话」只在会话表里没有终端会话时成立；否则按查询失败处理，500 的 `message` 和日志写明 socket 文件不见了、对 tmux server 发 SIGUSR1 可以重建、否则重启 daemon（提交 `5f4551a`，`TestSocketFileGoneWhileTheTmuxServerRuns`、`TestMissingSocketIsNotAnEmptySetWhileTheTableHasTerminalSessions`）。
- [一般] T2 `session/runner.go`：daemon 的 PATH 里找不到 tmux、而 socket 文件还在时被判成「没有任何会话」。证据：修复前 `TestRemoveWorktreeRefusedWhenTmuxIsNotOnPathButItsSocketIsThere` 输出 `liveTmuxSessions() = map[], true; want a failed reading: there is no tmux program but its socket is there`。→ 找不到程序时也看 socket 文件和会话表（提交 `e6ad485`，`TestRemoveWorktreeRefusedWhenTmuxIsNotOnPathButItsSocketIsThere`、`TestNoTmuxProgramIsAnEmptySetOnlyWithoutSocketAndWithoutTerminalSessions`）。
- [一般] T3（第三轮的待验证项，按裁决直接修）`session/runner.go:51`（`tmuxSocketPath`）：`TMUX_TMPDIR` 指向不存在或解析不了的目录时，算出的 socket 路径与 tmux 实际用的不一致。→ 先 `filepath.EvalSymlinks`，失败退到 `/tmp`（提交 `2bc01fe`，`TestTmuxSocketPathResolvesTheDirectoryLikeTmux`，只断言算出的字符串）。依据只有 tmux 3.6a 的源码，实机行为列在待验证项第 8 条。

第三轮修复后的变异核对（临时改动，未提交；各跑与对账有关的 12 个用例）：去掉「表里有终端会话就算失败」→ 3 个用例 FAIL（`TestSocketFileGoneWhileTheTmuxServerRuns`、`TestMissingSocketIsNotAnEmptySetWhileTheTableHasTerminalSessions`、`TestNoTmuxProgramIsAnEmptySetOnlyWithoutSocketAndWithoutTerminalSessions/table_has_a_terminal_session`）；改回「找不到 tmux 就算空表、不看 socket」→ 2 个用例 FAIL（`TestRemoveWorktreeRefusedWhenTmuxIsNotOnPathButItsSocketIsThere`、`TestNoTmuxProgramIsAnEmptySetOnlyWithoutSocketAndWithoutTerminalSessions` 的两个子用例）；去掉「socket 不存在才算空表」→ 4 个用例 FAIL（`TestLiveTmuxSessionsTellsNothingRunningFromAFailedQuery/socket_path_does_not_answer`、`TestRemoveWorktreeRefusedWhenTmuxSocketDoesNotAnswer`、`TestRemoveWorktreeRefusedWhenTmuxIsNotOnPathButItsSocketIsThere`、`TestNoTmuxProgramIsAnEmptySetOnlyWithoutSocketAndWithoutTerminalSessions/socket_file_is_there`）。

被改动的已有断言（三轮合计；没有删除、跳过、放宽或调大超时的）：

- 第一轮 daemon 侧 3 处（`TestRemoveRefusedWhenNestedWorktree` 的外层 `sessions`、`TestRemoveExternalNeverDeletesBranch` 主体及其 `switched_branch` 子用例），依据 G5、G8；桌面端 2 类（`delete_flow_remove_404` 的 `endedSessions`、删除请求体多 `branch` 的几处字面期望），依据待验证 1、G8；合并对接 1 处（`name_length_and_invisible_characters` 里「按段算」的一条反过来，decisions #108）。第二轮复评逐个看过，结论是改后比原来更严。
- 第二轮：`TestGitEnvKeepsInheritedConfig` 拆成两个子用例并带条件跳过（见 c6）；`TestParseTmuxSessionLineColumns` 增加 14 列；共用向量的 `reason` 把 `invalid` 细分。第三轮核对过，没有发现被改弱的断言。
- 第三轮 1 处：`TestTmuxSocketPathIsWhereTmuxPutsIt`，原来期望 socket 路径在 `TMUX_TMPDIR` 的字面值下（`/tmp/vr-tmux-…/tmux-<uid>/vibe-remote`），现在期望在解析后的目录下（macOS 上是 `/private/tmp/vr-tmux-…`）；依据 T3（tmux 自己用的、报出来的就是解析后的路径）。其余断言不变。

## 交给用户决定

- c6 [一般] 检查放松：`TestGitEnvKeepsInheritedConfig`（`vibe-remoted/internal/session/review_fixes_test.go`，提交 `cef5e4d`）拆成两个子用例，其中依赖 `GIT_CONFIG_COUNT` 的那个在 git 不认这个环境变量（低于 2.31）时跳过；同时新增不依赖它的 `GIT_CONFIG_PARAMETERS` 子用例。看到的理由：前提（git 读 `GIT_CONFIG_COUNT`）在旧版 git 上不成立，原用例在 2.30.2 上修前修后都失败，与 daemon 的行为无关（decisions d58）；2.31 及以上原断言一条不少，本机 2.50.1 上没有跳过。（推荐：保留。若认为这算跳过测试，去掉那个探测即可，代价是旧 git 上这条规则的检查恒失败。）

评审中按口味定下、用户可以改的决定（详见 decisions.md 对应的行；都已按所写的做）：

- d42 发起处没有任何提交时，预检返回 `ok:false`、原因 `no_commits`；attach 仍是 `create_failed`。
- d43 确认后分支被切换、或带 `deleteBranch` 而它已不是 `managed`：409 `worktree_changed`，不再「只删目录、悄悄留下分支」。
- d44 worktree 里有没被跟踪的独立 git 仓库时，删除在动手前被拒绝（不是在确认框里说明后放行）。
- d45 `core.fsmonitor` 在 git 环境里统一关闭，并新增一条不变的规则（做法后被 #115 改成命令行参数，规则的文字被 #120 收窄）。
- d46 名字的本地规则加两条：含 Cf / Zl / Zp 类字符、整个名字超过 250 字节（比裁决的「按 `/` 分段」更严）。
- d47 新建会话时名字的本地规则在任何 git 调用之前；预检仍是先看目录、再查名字。
- d50 `/api/v1/info` 失败时，目录选择器的 Worktree 模式不能确认（不是「允许创建并注明将自动命名」）。
- d51 能力状态 `unknown` 用一句中性文案同时覆盖「还在读」和「读失败」；删会话确认框把新旧两种结果都写出来。
- d52 名字输入框里回车不等防抖和预检（取代 d33 的一半）。
- d53 标题里分支先让位、最小宽度 3em；一两个字符的分支名后面会多出几像素空白。
- d54 `-c` 的说明只在用户勾选的那一刻滚进可见区，对话框打开时默认已勾选不自动滚动。
- d55 删除请求在途时，worktree 行的标签位置换成「正在删除…」，入口置灰。
- d56 「唯一列出的 worktree 不是主目录时保留 worktree 行」对旧 daemon 的分组树同样生效。
- d57 `no_commits` 的文案写「这里还没有任何提交」，这种应答不显示「基于 … @ …」那一行。
- d58 `TestGitEnvKeepsInheritedConfig` 的拆分和条件跳过（即上面的 c6）。
- d59 创建记录只在 git 的列表里完全没有这个路径时才清，`prunable` 的保留（推翻 #82 的半句）。
- d60 `deleteWorktreeFlow` 的回调多一个参数说明 worktree 是不是已经没了，标记由调用方在刷新结束后清。
- d61 名字的两条 vibe-remote 自己的规则各有原因码和文案（`invisible`、`too_long`）；带 ZWJ 的 emoji、波斯文必需的 ZWNJ、方向标记被拒绝是已知代价。
- d62 已知限制，不加机制：daemon 重启后（会话表为空）tmux 的 socket 文件被外部删掉而 server 还活着，仍被当成「没有会话」；放弃的做法是持久化 tmux server 的 pid。

（decisions.md 里没有 d48、d49 这两个编号。）

## 待验证项

交给 dev-test。都没有据此改代码，也不计入上面的缺陷数。

1. [一般] `desktop/scripts/test-theme-tokens.mjs:322`（横切面 X11）→ 对话区 M1 的完整形态（工具块、权限卡片、用户和助手消息、输入框）只有少数 CSS 属性被断言，整体画面走样时自动化发现不了；终端实际绘制的四个主题色同理。关联：R8.1、R8.2。已有：`chat_shape_rules` 的属性断言、开发时的并排截图；缺：运行中的整体画面检查。最小操作：临时实例（假 claude）里走一轮含工具调用和权限请求的对话，截图与效果页 M1 逐块对照；终端会话截图核对底色、前景、光标、选区 → 各容器的背景、边框、圆角、间距与效果页一致，没有旧配色残留。
2. [一般] `desktop/scripts/test-dialog-layout.mjs:14`、`.claude/skills/verify/scripts/shell-layout.mjs`（横切面 X12）→ 800×500、中英文下，各对话框的真实布局没有完整量过（现有检查量的是行菜单、标题、`-c` 说明和目录选择器的高度）；后果是按钮被挤出窗口或文字截断到看不出内容。关联：R8.5。最小操作：临时实例固定 800×500，zh / en 各一轮，依次打开新建会话、新建 worktree、删除会话、删除 worktree 的 clean / files / commits / detached / external 形态和失败说明 → 对话框在窗口内，主按钮 `elementFromPoint` 命中，没有不带省略号的截断和元素重叠。
3. [一般] `desktop/src/main/index.ts:102`（横切面 X14）→ 冷启动只验证了源码里窗口底色等于 `--bg-app`，没有验证首帧；后果是启动时闪一下旧米色或深色。关联：R8.6。最小操作：独立临时 userData 冷启动，录屏或连续截取窗口首次显示前后的帧 → 没有出现 `#EFEFF4` 以外的整屏底色。
4. [一般] `desktop/src/renderer/shortcuts.ts:48` → 切换会话的快捷键只经 CDP 发键验证过，CDP 的按键不经过 macOS 的菜单分发和输入法；后果是系统菜单抢走按键，或按键落进终端 / 输入框。关联：R7.1–R7.4。最小操作：打包后的 app 里用真实键盘按 ⌘1–⌘9、⌘⇧[、⌘⇧]，焦点分别在终端里和对话输入框里，再在对话框打开时按一遍 → 会话按侧边栏顺序切换，终端和输入框里没有多出字符；对话框打开时不切换。
5. [一般] `vibe-remoted/internal/session/worktree.go:90`（`gitFixedArgs`）→ git 低于 2.31 的机器本机没有，R2 的修复是用临时从源码构建的 2.30.2 和一个模拟旧版的包装测的；后果是这类机器（Debian 11、Ubuntu 20.04）上 `core.fsmonitor` 被运行，或新建 / 删除 worktree 用到旧 git 没有的行为。关联：`.devflow.yml` 的规则「daemon 运行的 git 不运行 core.fsmonitor 指定的程序」；R3、R5。最小操作：在 git 低于 2.31 的环境（容器即可）里跑那条规则的 check 命令，再用临时 daemon 走一遍新建命名 worktree → 在其中开会话 → 删除 worktree（含「目录和分支都删」）→ check 通过且 `TestGitEnvKeepsInheritedConfig` 只跳过 `GIT_CONFIG_COUNT` 那个子用例；端到端各步成功，磁盘上没有残留。
6. [一般] `vibe-remoted/internal/session/runner.go:209`（`readTmuxSessions` 的第 ③ 种）→ 从没开过终端会话的全新环境、以及没有 tmux 程序的机器，只在本机用独立的 `TMUX_TMPDIR` 和改 PATH 模拟过；后果是这类机器上任何 worktree 都删不掉（R1 的原问题）。关联：R5.2；`.devflow.yml` 的规则「未经同意不丢文件和提交」。最小操作：(a) 全新的 `TMUX_TMPDIR`、只开对话会话的临时 daemon；(b) 没装 tmux 的环境里 `use_tmux:true` 的临时 daemon；各删除一个没有会话的 worktree → 都是 200、目录被删，过程中没有起 tmux server。
7. [一般] `vibe-remoted/internal/session/runner.go:209`、`manager.go:130` → 第三轮修复后的对账四条规则没有再经过独立评审（T1–T3 改的是「删不删会话脚下的目录」这条关键保证）。关联：R5.6；CLAUDE.md「删除 worktree」一段的四条规则。最小操作：请关口 C 的独立验证者在独立的 `TMUX_TMPDIR` 下各验证一次：(a) server 活着而 socket 文件被删（表里有终端会话）；(b) PATH 里没有 tmux 而 socket 在；(c) 全新环境（没有 socket、表为空）→ (a)(b) 删除返回 500、`endedSessions` 为空、目录、分支和会话都在，`message` 说明原因，(a) 在对自己的 server 发 SIGUSR1 之后删除成功并结束会话；(c) 删除成功。另请读一遍 `readTmuxSessions` 对照 CLAUDE.md 的四条。
8. [一般] `vibe-remoted/internal/session/runner.go:51`（`tmuxSocketPath`）→ `TMUX_TMPDIR` 指向不存在的目录时 tmux 退到 `/tmp`，这一点只有 tmux 3.6a 的源码依据（约束不允许在默认目录上跑 tmux）；老版本 tmux 没有读源码。若实际行为不同，daemon 会看错 socket 文件在不在。关联：同第 7 条。最小操作：在可以随意使用默认 tmux 目录的环境（容器）里，`TMUX_TMPDIR=/nonexistent tmux -L vibe-remote new-session -d`，看 socket 落在哪 → 在 `/tmp/tmux-<uid>/vibe-remote`；发行版自带的较老 tmux（如 3.0、3.2）结果相同。
9. [一般] `vibe-remoted/internal/session/worktree.go:46`（`gitCountTimeout`，30 秒）→ 超大仓库（百万级提交、分支上有大量未合并提交）上数未合并提交可能超过时限，正常的删除变成 500 `git_failed`；第二轮复评没有这样的仓库可测。关联：R5.5；decisions #93。最小操作：用 `git fast-import` 造一条有 100 万个未合并提交的分支，量 `git rev-list --count <主分支>..<分支>` 的耗时，并对它的 worktree 查一次 status → 耗时低于 10 秒（时限的三分之一），status 返回正确的数字。
10. [一般] `vibe-remoted/internal/session/worktree.go:47`（`gitTreeTimeout`）、`projects.go`（`RemoveWorktree` 里 git 删除失败后的分类）→ `git worktree remove` 到时限被杀之后的状态只做过代码推演，没有实际杀过。关联：R5.12（已经开始删除之后的失败如实报告）。最小操作：把 `gitTreeTimeout` 调到几秒，用一个删到一半就不返回的 git 包装（先删掉 worktree 里的 `.git` 文件再睡）触发一次删除 → 响应是 500，带真实的 `endedSessions`，`message` 写明剩下的路径；再查状态与磁盘一致，分支没有被删。
11. [一般] `desktop/src/renderer/sidebar.ts:140`、`index.ts:99`（`removingWorktrees`）→ 行菜单跟随重建（D9）和「正在删除…」的行（D7、R6）只在 jsdom 用例和 gui-smoke 里验证过，没有在真实窗口里操作过；后果是重建后菜单项点了没反应，或删除中的行短暂变回可点。关联：R5.6、R8.3。最小操作：临时实例里打开某一行的「⋯」菜单，等过一轮 5 秒轮询后点菜单项；再用延迟代理把 `POST /api/v1/worktrees/remove` 和随后的 `/api/v1/projects` 各拖 5 秒，删除一个 worktree → 菜单项的动作照常执行；从确认到该行消失，行一直显示「正在删除…」且入口置灰。
12. [一般] `desktop/src/renderer/worktree-name.ts:19`（`/[\p{Cf}\p{Zl}\p{Zp}]/u`）→ Electron 自带的 ICU 与 Go 的 Unicode 表版本不同时，两边对个别码位的结论可能不同（第二轮用的是 Node 22 对照，结论相同：各拒绝 253 个）；后果是名字本地提示通过、确认时才被 daemon 拒绝，或反过来。关联：R3.3。最小操作：在临时实例的渲染进程里（CDP）对全部码位跑一遍这个正则，与 Go 一侧的结果比 → 被拒的码位集合相同。
13. [一般] `vibe-remoted/internal/session/projects.go:318`（`backfillTerminal`）→ 既没有归属、也没有 `@vibe_remote_workdir` 的旧终端会话（升级前建的），要等 `Projects()` 补上归属才会被算进 worktree 的会话；第三轮没有读这个函数的正文。后果是升级后马上删 worktree 时漏掉这种会话。关联：R5.6、H19。最小操作：在独立的 `TMUX_TMPDIR` 下手工起一个 `vibe-remote-<id>` 的 tmux 会话（工作目录在某个 worktree 里，不设任何 `@vibe_remote_*` 选项），新起临时 daemon，不先请求 `/api/v1/projects`，直接查该 worktree 的 status 并删除 → status 的 `sessions` 含这个会话，删除时它被结束；若不含，记为缺陷。

## 不采纳

- 第一轮 daemon 侧可维护性 4：`RemoveWorktree`（约 200 行）拆成四个包内函数。理由：现在拆会让刚评审过的删除路径整体变动（rulings.md A、decisions #91）；记在 tasks.md「后续」。
- 第一轮桌面端待验证 3：工作目录名以 `;` 结尾时终端会话建不起来。理由：在基准 `6d88e45` 和当前各试了一次，结果相同（`a;`、`<u>proj&amp;` 失败，其余 10 种名字正常），是原有问题：tmux 把以 `;` 结尾的参数当成命令分隔符；不在本需求修，记在 tasks.md「后续」。

所属条目已计入「已修复」、其中一部分没有照评审的改法做的：

- X4 的预检那一半：预检仍是先看目录、再查名字（改成名字优先要动 `TestPlanWorktree/invalid_name` 守的约定「名字不合法时仍给出 `project`、`base`」，d47）。
- R4 的改法 (2) 后半「读回仍失败时退回 `EvalSymlinks` 的路径、不判创建失败」：裁决选了「重试一次，再失败就撤销并保留分支」（rulings-round2.md，decisions #116）。
- R10 里复评列的仍能通过的 4 个看不见的字符（U+034F、U+3164、U+2800、U+FE0F）：不处理，记后续（rulings-round2.md）。
- 第三轮 T1 的改法 2「持久化 tmux server 的 pid」：不做，记为已知限制（rulings-round3.md，d62）。

## 测试复跑

都在 `949c9b2` 上（之后的提交只加文档）；用到 tmux 的命令各带独立的 `TMUX_TMPDIR`（`/tmp/vr-*`，跑完已删）。

- `TMUX_TMPDIR=<临时目录> make check`：退出码 0。Go 五个包 `ok`（session 273.7 s、server 63.4 s、chat 19.6 s、config 2.4 s、protocol 2.9 s）；桌面端 `typecheck` 通过，`npm test` 307 行 `ok`、没有失败。
- `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs`：退出码 0，46 行 PASS、0 FAIL，`all GUI checks passed`。
- `…/gui-chat-smoke.mjs`（同样的写法）：退出码 0，29 行 PASS、0 FAIL，`all GUI chat checks passed`。
- `…/ws-smoke.mjs`：对着自建的临时 daemon（随机端口、`allowed_roots` 只有 `/tmp/vr-ws-*/roots`、独立的 `state_dir` 和 `TMUX_TMPDIR`、`claude_cmd=/bin/bash`）：退出码 0，12 行 PASS，`all checks passed`。
- `…/ws-chat-smoke.mjs`：退出码 0，9 行 PASS，`all chat checks passed`。
- `.devflow.yml`「未经同意不丢文件和提交」那条规则的 check（加了 5 个新用例后的命令，原样执行）：`ok … internal/session 39.677s`，退出码 0。
- 用例数量没有减少：`gui-smoke.mjs` 的 `check(` 30 处，`gui-chat-smoke.mjs` 的 `^test(` 26 处。
- 已知偶发的用例这一轮都没有出现，没有重跑。
- 第三轮三个修复各自的顺序：先写用例并确认失败（输出见上面 T1–T3 和 decisions #121–#123），再修；T1 提交前另跑过一遍 `./internal/session ./internal/server` 全包（`ok` 267 s、60 s）。
