# 测试报告：按项目和 worktree 组织会话，并更换视觉风格

日期：2026-11-21　分支：change/project-worktrees　提交：b6dea2c（被测的代码；其后的提交只在 `docs/changes/` 下加运行记录、证据和文档）

> ⚠️ **这是第 5 轮全量运行：c10–c13 裁决之后，修掉「侧边栏要显示的内容没变也重建」（任务 T34）并撤掉测试里的「重做」之后。** 第 4 轮（合并 `change/dual-mode`，被测 `4c1e78c`）留下四项待裁决，协调者按用户的授权裁决：c10 不接受用重做过检查、改为修原因；c11、c12 接受；c13 的规则文件都加 / 保留。这一轮做了什么、修复前后的数据、变异核对，见下面「c10–c13 裁决之后的返工（T34）」一节。仓库里的 `verdict.md` 仍是关口 C 第 2 轮的（被测 `482ab63`）；合并和 T34 之后的代码都没有做独立验证。
> ⚠️ 端到端测试：**已完成**。`gui-chat-smoke.mjs` 完整运行 5 次、`gui-worktree-smoke.mjs` 完整运行 5 次、`gui-smoke.mjs` 2 次，三份接口冒烟各 1 次。
> 浏览器环节：适用（桌面应用，裸 CDP；没有用 Playwright，跟随项目已有的做法）。
> 测试环境：e2e_env = local。被测的是临时 daemon（终端会话跑 `/bin/bash`，对话会话跑假 claude）和本机的 git 2.50.1、tmux 3.6a，**不是真实的 claude，也不是远程 Linux**。
> **GUI 的 12 次运行、接口的 3 次、18 条命令型规则全部一次通过**：每次运行每个用例都是 PASS，没有「重做」的 `NOTE`（脚本里已经没有这段逻辑），已知偶发清单里的用例一次都没有出现。
> ⚠️ **`make check` 第一次没有通过**（2026-11-20 18:50，机器负载 27–34）：Go 的 `TestRemoveGitFailureKeepsState` 失败 1 次（daemon 自己给一次 git 调用的 5 秒时限到了），桌面端那一半因此没有运行。这一轮没有改 `vibe-remoted/` 下的任何文件；该用例随后单独跑 10 次全过，带 `-v` 的整套 Go 测试全过（468 个顶层测试），2026-11-21 重跑 `make check` 退出 0。按偶发处理，列入清单，见「c10–c13 裁决之后的返工（T34）」的「运行过程中的失败」。
> **没有等用户裁决的检查改动**。这一轮没有删除、跳过、放宽任何断言，没有调大超时，没有加重试；撤掉了第 4 轮加的重做和「等侧边栏安静」。有 4 个已有用例改了准备步骤（让重建真的发生），断言原样，清单在同一节。
> 全程机器上有别的应用占着 CPU（load average 17–38），每条结果旁边记了当时的负载（`evidence/t34/full-run.txt`）。

## 汇总

| 类别 | 通过 | 失败 | 跳过 | 合计 | 第 4 轮（`7b295b0` 上的数量） |
|------|------|------|------|------|------|
| 单元 + 集成：Go（`make check` 里的 `go test -race -count=1 ./...`） | 5 个包全部 `ok`；带 `-v` 另跑的一遍：468 个顶层测试函数（session 251、server 101、chat 99、config 15、protocol 2）和 458 个子用例全部 PASS | 0（第一次 `make check` 里有 1 个用例失败 1 次，见上） | 0 | 468 | 468 |
| 单元：桌面端（`make check` 里的 `npm test`，37 步） | 384 行 `ok` | 0 | 0 | 384 | 365 行、36 步 |
| 端到端（浏览器）：`gui-worktree-smoke.mjs` 第 1–5 次 | 每次 72 / 72 个用例（75 行 PASS） | 0 | 0 | 72 | 71 个用例（74 行） |
| 端到端（浏览器）：`gui-smoke.mjs` 第 1 / 2 次 | 46 / 46 行 PASS（脚本里 `check(` 30 处） | 0 / 0 | 0 | 46 | 46 行（`check(` 30） |
| 端到端（浏览器）：`gui-chat-smoke.mjs` 第 1–5 次 | 每次 37 行 PASS（`^test(` 34 个），每次 0 行 `NOTE` | 0 | 0 | 37 | 37 行（`^test(` 34）；第 2 次有 1 行「重做」的 `NOTE` |
| 端到端（接口）：`ws-smoke.mjs` / `ws-chat-smoke.mjs` / `ws-worktree-smoke.mjs` | 12 / 9 / 9 | 0 | 0 | 30 | 12 / 9 / 9 |
| `.devflow.yml` 的不变规则（19 条） | 18 条命令原样执行，退出码全是 0，没有 `(cached)`；第 2 条是 `/protocol-sync` skill，见下 | 0 | 0 | 19 | 19 条 |

数量对照：每一类都不少于 `7b295b0` 上的数量。

- Go：468，一个不多一个不少（这一轮没有改 Go）。
- 桌面端单元：365 + 新脚本 `test-sidebar-refresh` 的 17 + `test-sidebar-rename` 新增的 1 个用例在两种位置各跑一遍的 2（34 → 36）= 384；另有不输出 `ok` 行的 `test-source-bytes`（40 个文件）。
- `gui-worktree-smoke.mjs`：71 + `T34.quiet` = 72。`gui-chat-smoke.mjs`、`gui-smoke.mjs` 的用例数不变；`gui-chat-smoke.mjs` 相对合并进来的 `64e8b5e` 没有少一行断言（R8.3 每次运行都机械地比，5 次都通过）。

`NOTE` 行清单（12 次 GUI 运行 + 3 次接口运行）：

- `gui-chat-smoke.mjs` 5 次：0 行。
- `gui-worktree-smoke.mjs` 5 次：0 行。
- `gui-smoke.mjs` 2 次：每次 4 行，都是脚本每次都打印的测量值（`notification outcome in this build: fallback`、侧边栏 284 px 下各行的宽度、800×500 下行菜单的位置、800×500 下标题各段的宽度），两次的内容相同。
- 三份接口冒烟：0 行。
- 没有任何一行含「doing it again」「重做」。

都在 `b6dea2c` 的代码上运行（`make check` 的那次通过、GUI、接口冒烟、规则是 2026-11-21 17:08–17:46；带 `-v` 的 Go 整套是 2026-11-20 18:58），一个一个跑；每条命令带独立的 `TMUX_TMPDIR`（`/tmp/vr-t34-XXXXXX` 下各自的子目录）和同一个空的 `CLAUDE_CONFIG_DIR`（每个脚本跑完都看过它仍是空的）；临时 daemon 的 `allowed_roots` 只有自己在 `/tmp` 下建的目录；需要旧版 daemon 的两份脚本用的是从 `git archive main` / `git archive 6d88e45` 导出到 `/tmp` 后构建的二进制（`VR_MAIN_DAEMON`、`VR_BASE_DAEMON`），没有对项目仓库做 `git worktree add`。每次启动 Electron 前都看过没有别的测试实例。

已知偶发的用例（`gui-smoke.mjs` 的「drag-select + ⌘C」、第 4 步等选区目标、第 9 步状态点；`gui-chat-smoke.mjs` 的 R1.1、R7、R13.2 / R14.2、`X7-send`；`gui-worktree-smoke.mjs` 的 `M.X7`；`TestStopAccountsForEveryQueuedMessage/restart`、`TestProjectsOneGitCallPerProject/unresolved_session`、`TestProjectStoreRemoveWorktreeIfSame`、`TestWorktreeStatus/ignored_timeout`）**在这一轮通过的那些运行里一次都没有出现**。这一轮新列入清单的一个：`TestRemoveGitFailureKeepsState`（高负载下 git 调用超过 daemon 的 5 秒时限）。

运行命令和结果（完整输出在 `evidence/final-run/`，覆盖了第 4 轮的同名文件；多次运行的第 2–5 次是 `*-2.txt` … `*-5.txt`；逐次的通过数在 `evidence/t34/full-run.txt`，每跑完一个脚本提交一次）：

```
$ TMUX_TMPDIR=<临时目录> CLAUDE_CONFIG_DIR=<空的临时目录> make check                     # 2026-11-21 17:08，负载 22 → 31
cd vibe-remoted && go vet ./...
cd vibe-remoted && go test -race -count=1 ./...
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	20.519s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/config	2.419s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/protocol	1.930s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	78.599s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	395.930s
cd desktop && npm run typecheck
> tsc --noEmit
cd desktop && npm test
…（384 行 ok，0 行 not ok / FAIL）
test-sidebar-rename checks passed (36)
test-sidebar-refresh checks passed (17)
source bytes check passed (40 files, no NUL)
exit=0
files in the empty claude config dir afterwards: 0

$ 同一条命令，2026-11-20 18:50，负载 27–34（evidence/final-run/make-check-first-attempt-failed.txt）
--- FAIL: TestRemoveGitFailureKeepsState (6.44s)
    worktree_remove_test.go:714: err = *fmt.wrapError read repository: git rev-parse --show-toplevel: no answer within 5s: context deadline exceeded, want *WorktreeRemoveError
FAIL	github.com/lflish/vibe-remote/vibe-remoted/internal/session	427.723s
exit=2                                              # 桌面端那一半没有运行

$ cd vibe-remoted && TMUX_TMPDIR=<临时目录> CLAUDE_CONFIG_DIR=<空的临时目录> go test -race -count=10 -timeout 10m -v ./internal/session -run 'TestRemoveGitFailureKeepsState$'
ok  	…/internal/session	22.257s                 # 10 行 --- PASS（1.50–4.13 s）

$ cd vibe-remoted && TMUX_TMPDIR=<临时目录> CLAUDE_CONFIG_DIR=<空的临时目录> go test -race -count=1 -v -timeout 25m ./...     # 为了数通过和跳过另跑的一遍（evidence/final-run/go-test-v-summary.txt）
ok  	…/internal/chat	17.721s
ok  	…/internal/config	2.287s
ok  	…/internal/protocol	1.846s
ok  	…/internal/server	75.376s
ok  	…/internal/session	391.860s
exit=0                                              # 顶层 PASS 468 / FAIL 0 / SKIP 0；子用例 PASS 458 / FAIL 0 / SKIP 0

$ TMUX_TMPDIR=<临时目录> CLAUDE_CONFIG_DIR=<空的临时目录> VR_MAIN_DAEMON=<从 main 构建的 daemon> node .claude/skills/verify/scripts/gui-chat-smoke.mjs --no-build          # ×5
run 1: exit 0, 37 PASS, 0 FAIL, 0 NOTE
run 2: exit 0, 37 PASS, 0 FAIL, 0 NOTE
run 3: exit 0, 37 PASS, 0 FAIL, 0 NOTE
run 4: exit 0, 37 PASS, 0 FAIL, 0 NOTE
run 5: exit 0, 37 PASS, 0 FAIL, 0 NOTE
…
PASS X8 double click on an open chat session (current, then background) renames it; the name is not sent to claude; the sidebar keeps updating — …
PASS X8 double click on an open terminal session (current ×3, background ×2) renames it; nothing is typed into the shell — 5 renames, last "bg box 2"
PASS X10 after renaming a chat session (Enter, Esc, a click on another session) the next keys go into the current session, without a click — …
PASS X10 after renaming a terminal session (Enter, Esc) the next keys go into the terminal, without a click — …
…
all GUI chat checks passed

$ TMUX_TMPDIR=<临时目录> CLAUDE_CONFIG_DIR=<空的临时目录> VR_BASE_DAEMON=<从 6d88e45 构建的 daemon> node .claude/skills/verify/scripts/gui-worktree-smoke.mjs --no-build          # ×5
run 1: exit 0, 75 PASS, 0 FAIL, 0 NOTE
run 2: exit 0, 75 PASS, 0 FAIL, 0 NOTE
run 3: exit 0, 75 PASS, 0 FAIL, 0 NOTE
run 4: exit 0, 75 PASS, 0 FAIL, 0 NOTE
run 5: exit 0, 75 PASS, 0 FAIL, 0 NOTE
…
PASS R8.3 the two existing GUI scripts keep every case of the version before this change — gui-smoke.mjs: 14 → 30 cases (14 in the merged 64e8b5e), no asserting line removed; 1 of the version before replaced by that branch itself; gui-chat-smoke.mjs: 26 → 34 cases (34 in the merged 64e8b5e), no asserting line removed; 1 of the version before replaced by that branch itself (…)
…
PASS under a worktree row: double click renames a chat and a terminal session, the name is not typed into the session, and the next keys go into it without a click (chat sessions X8, X10) — …
PASS under a worktree row: a chat session that got more than a screen in the background is at the bottom with the newest message when opened again, and a message typed then shows (chat sessions X7) — …
PASS the sidebar is left alone while what it shows stays the same: no change to it across two polls of every machine; with a poll asked for every 150 ms, 20 real clicks switch the session and 10 real double clicks start a rename, none lost (T34) — 0 changes to the sidebar across two polls of 5 machines; with a poll every 150 ms: 20 of 20 clicks switched the session, 10 of 10 double clicks started a rename (…)     # 5 次都是 0 / 20 / 10
…
72 cases: R1 8/8, R2 7/7, R3 11/11, R4 6/6, R5 12/12, R6 2/2, R7 5/5, R8 6/6, R9 2/2, other 13/13
all GUI worktree checks passed

$ TMUX_TMPDIR=<临时目录> CLAUDE_CONFIG_DIR=<空的临时目录> node .claude/skills/verify/scripts/gui-smoke.mjs --no-build          # ×2
run 1: exit 0, 46 PASS, 0 FAIL, 4 NOTE
run 2: exit 0, 46 PASS, 0 FAIL, 4 NOTE
all GUI checks passed

$ VR_TOKEN=<临时 token> node .claude/skills/verify/scripts/ws-smoke.mjs 127.0.0.1:<随机端口> <临时目录>     # 自建的临时 daemon：从这份代码 go build，随机端口，/bin/bash，独立的 state_dir、tmux 目录和空的 claude 配置目录，allowed_roots 只有这个临时目录
all checks passed
exit=0                                              # 12 行 PASS

$ node .claude/skills/verify/scripts/ws-chat-smoke.mjs
exit=0                                              # 9 行 PASS

$ node .claude/skills/verify/scripts/ws-worktree-smoke.mjs
exit=0                                              # 9 行 PASS

$ .devflow.yml 的 invariants：18 条 check 命令原样交给 zsh，环境里加 GOFLAGS=-count=1、各自的 TMUX_TMPDIR 和空的 CLAUDE_CONFIG_DIR（evidence/final-run/invariants.txt）
1 exit=0   3 exit=0   4 exit=0   5 exit=0   6 exit=0   7 exit=0   8 exit=0   9 exit=0   10 exit=0   11 exit=0
12 exit=0   13 exit=0   14 exit=0   15 exit=0   16 exit=0   17 exit=0   18 exit=0   19 exit=0
```

布局测量脚本（`picker-layout.mjs`、`slash-menu-layout.mjs`、`sidebar-layout.mjs`、`shell-layout.mjs`、`dialog-layout.mjs`）不是能单独运行的命令，是三份 GUI 冒烟导入的模块，在上面的运行里都执行了：目录选择器在 500 / 700 / 803 px 高的窗口里（终端和对话各 3 行 PASS）、侧边栏默认宽度下各行可读、800×500 下的行菜单 / 标题 / `-c` 的说明（`gui-smoke.mjs`）；斜杠菜单在 800×500 和 1280×800（`gui-chat-smoke.mjs`）；R8.5 在 800×500、中英文各量 13 个画面共 26 次测量（`gui-worktree-smoke.mjs`）。对应的单元测试 `test-picker-layout`、`test-slash-menu-layout`、`test-dialog-layout` 在 `npm test` 里。

关于不变规则：

- 19 条，与第 4 轮相同。这一轮只改了第 4 条「同一 claude 会话 id 任何时刻最多一个 claude 进程」的 check：末尾多了一个用例名 `TestContinueInWorktreesSharingProjectDir`（c13 的裁决，decisions #171、#177），别的名字没有动；这条 check 原样运行 exit 0，带 `-v` 看到该用例 `--- PASS`。
- 第 2 条「协议三处一致」的 check 是 `/protocol-sync` skill，不是命令。这一轮没有改协议涉及的任何文件（`git diff --stat 7b295b0..HEAD -- vibe-remoted desktop/src/shared desktop/src/renderer/rest.ts docs/protocol.md` 为空），版本仍是 4；skill 的三处逐项比对没有重做（`evidence/final-run/protocol-sync.txt` 末尾）。
- 加 `GOFLAGS=-count=1` 是为了让 `go test` 真的运行，输出里没有 `(cached)`。第 13 条的命令里 `./internal/server` 那一半输出 `[no tests to run]`（点名的测试都在 session 包里，命令原文如此，前几轮相同）。

## 场景对照

58 行，取自 `evidence/scenario-matrix.md`。「结果」是这一轮（代码 `bbc2e9b`）`gui-worktree-smoke.mjs` 运行里同名用例的结果：58 个场景编号逐个在这次的输出里找到了 `PASS` 行（`evidence/final-run/gui-worktree-smoke.txt`）；表里点名的 Go 和桌面端测试在同一轮的 `make check` 里运行。截图是第 1 轮最终运行（`5d8878c`）存的，这一轮只新存了两张（`evidence/R3.8.hook.png`、`evidence/X1.redraw.png`）——返工对桌面端的改动只有终端会话的点亮规则（`index.ts` 的一段和新文件 `terminal-activity.ts`），各场景的画面不变。这一轮只改了 R3.8 一行（多了钩子失败的那一种）。

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
| R3.8 创建失败 | Go 单元：`TestCreateNamedWorktreeGitFailureLeavesNothing`、`TestCreateFailedByPostCheckoutHookLeavesNothing`（post-checkout 钩子失败，T30）、`TestUndoLeavesAWorktreeSomeoneElseAddedWhileTheAddRan`（不动别人的）；Go 集成：`TestWSAttachWorktreeCreateFailed`；e2e：`gui-worktree-smoke.mjs` › R3.8、R3.8.hook | 单元 / 集成 / 浏览器 | 通过 | evidence/R3.8.png、evidence/R3.8.hook.png |
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

58 个场景：58 个通过，0 个失败，0 个未覆盖。场景之外的用例（同一次运行）：`NFR.perf`、`X11.menu`、`X11.removing`、`X2.rename`、`X3.keys`、`X6.scroll`、`X8.menu` 通过。tasks.md 测试计划里点名的 Go 测试 `TestProjectsSingleWorktreeRepo`（含 `legacy_worktree_mode`）是第 1 轮补上的（提交 `246b437`，三个子用例通过；两处故意改坏的实现下它会失败）。

关口 C 第 1 轮的验证者对这张表的判断（`verdict-history.md`）：非界面部分的验证者逐个读了 58 个场景的断言，其中 R2.1、R3.5、R3.8、R4.2、R5.6、R5.9、R5.12 这 7 行标了「普通情况的守护通过，新增的反例不通过」，对应 X9–X14（X15 是预检端点的状态码，不在场景表里），回归测试见下面「关口 C 第 1 轮返工」；界面部分的验证者用真实指针和按键亲手走了其中 50 个，没有发现脚本通过而实际不符的场景。

## 交付预览

- 产物：**截图替代**。项目没有录屏能力（`dev-preview` skill 不存在），没有视频。关键流程留了一组按步骤编号的截图 `evidence/flow-01.png` … `flow-12.png`，每一步核对了什么写在 `evidence/flow-run.txt`。
- 来源：2026-11-20，本机（macOS，Electron 临时实例，1280×800），被测提交 `85a18cc` 的桌面端构建和 daemon（与 `5d8878c` 的代码相同）；操作全部是经 CDP 发给这个临时实例的真实指针和按键事件（`Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`），不是 DOM 的 `click()`。
- 返工之后：这组截图是第 1 轮录的，daemon 是返工之前的。返工改的是 daemon 里创建失败的撤销、删除 worktree 时对会话和分支的复核、读 tmux 和 worktree 列表的方式、预检端点的一个状态码，这条流程经过的画面没有变；这一轮没有重录，流程里的每一种操作（新建 worktree、删会话、删 worktree、移除项目、切换）在这一轮的 `gui-worktree-smoke.mjs` 里各有用例通过。
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

（第 1 轮做的，修复后的代码是 `5d8878c`；返工只改 daemon，这一轮没有重做。关口 C 第 1 轮的界面验证者之后又用真实指针和按键独立走了一遍，58 个场景里走了 50 个，X2、X3、X6、X8 的修复在真实窗口里都生效，另提了 7 条备注，见 `verdict-history.md`。关口 C 放行后的返工把 X1 改掉了（T31，用户确认 c7），其余没有变。）

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
| X1 | 中 | 新建或重命名任何一个终端会话时，本窗口里其它打开着的后台终端会话全部亮起「有新消息」 | 已修复 `525ab9f`（T31；用户确认 c7：后台终端会话收到字节后屏幕内容没变就不亮），回归测试 `test-terminal-activity`（11 例）、`gui-worktree-smoke › X1.redraw` |
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
- 处理：**已修复 `525ab9f`（T31）**。用户在关口 C 的汇总里确认改点亮规则：后台终端会话收到字节后，xterm 屏幕上的文字没有变就不亮。字节仍原样、无条件写进 xterm，只做前后是否相同的比较，不解析内容。修复前真实应用的用例失败（A 切到后台、另一个会话被打开后 A 就亮了：`got ["output","none"], want ["none","none"]`），修复后 12 帧重绘不亮、改名不亮、真的打印一行才亮（`evidence/X1.redraw.png`、`evidence/gate-c-3-rework.md` 第 3 节）。（当时的记录：未修复，c7 交给用户。基准 `6d88e45` 的点亮规则逐字相同、每次新建执行 7 次 `set-option`（现在 11 次），按代码判断基准上同样会亮。）

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

## 关口 C 第 1 轮返工

第 1 轮独立验证（被测 `91e0fab`，两份结论全文在 `verdict-history.md`）：非界面部分的验证者（codex）结论「不通过」，拦下 7 个问题（P1–P7），在测试阶段的编号上接着编为 X9–X15；界面部分的验证者结论「通过，有备注」（N1–N7，记在 tasks.md「后续」）。7 个问题全部采纳，返工任务 T21–T27，另有「放松检查」一节的两条备注（T28）。返工只改了 daemon（`vibe-remoted/internal/session`、`internal/server/projects.go`）、它的测试、`docs/protocol.md` 三行、`CLAUDE.md` 和 `.devflow.yml`；桌面端和三份 GUI 脚本没有改动。每个修复都是先把验证者的反例写成回归测试并确认失败、再修、再做变异核对（修复前的失败输出和变异结果在 tasks.md「进度」的 T21–T28 各行和 `evidence/gate-c-1-rework.md`）。

「这次运行的结果」取自这一轮带 `-v` 的那遍 Go 全套（`evidence/final-run/go-test-v-summary.txt`，逐个用例的 PASS 行）和对应不变规则的命令；同一批用例在 `make check` 里又跑了一遍（包一级的 `ok`）。

| 编号 | 问题（验证者的编号、程度） | 修复提交 | 回归测试 | 这次运行的结果 |
|------|----------------------------|----------|----------|----------------|
| X9 | P1，严重：创建失败的撤销把另一个进程在同一路径上建的 worktree（同分支，或 detached 在同一提交）当成本次建的，强制删除，对方的文件和分支一起丢 | `f86be13` | `TestUndoLeavesAWorktreeSomeoneElseAddedAtTheSamePath`（`same_branch`、`detached_at_the_same_commit`、`added_before_the_branch_was_claimed`）；`TestUndoAfterWorktreeAddFailedOnItsOwn`（2 个子用例）；被时限杀掉仍认领：`TestWorktreeAddKilledDuringCheckoutIsUndone` | 全部 PASS（3 + 2 个子用例，无跳过）；第 18 条规则 exit 0 |
| X10 | P2，严重：删除 worktree 的途中 tmux 的 socket 文件被删，`kill-session` 失败被吞，目录照删，没结束的会话被报成已结束 | `6282332` | `TestRemoveWorktreeStopsWhenASessionDidNotEnd`；`TestRemoveWorktreeConfirmsSessionsAgainstTmux`（2 个子用例） | 全部 PASS；第 15 条规则 exit 0；`ws-worktree-smoke.mjs` 的「the socket file is removed while the server runs」PASS（500，什么都没删） |
| X11 | P3，严重：会话所在目录的名字里有换行或制表符时，tmux 列表的行解析不了或字段错位，读取仍算成功，删除 worktree 漏掉活着的会话 | `44c049d` | `TestSessionWhoseProcessIsInAnOddlyNamedDirectoryIsStillRead`（5 种目录名 × 重启与否，10 个子用例）；`TestSessionCreatedInAnOddlyNamedDirectoryIsStillRead`（5 个子用例）；`TestTmuxReadFailsWhenARecordDoesNotParse`；改写的 `TestParseTmuxSessionLine*` 6 个 | 全部 PASS（15 个子用例，无跳过）；第 15 条规则 exit 0 |
| X12 | P4，一般：tmux 报错里 socket 的路径含 `no sessions` 字样时被当成「没有会话」 | `465945a` | `TestIsNoTmuxServerGoesByTheWholeLine`；`TestSocketPathSayingNoSessionsIsNotAnEmptySet` | 全部 PASS；第 15 条规则 exit 0 |
| X13 | P5，一般：结束会话之后只复核 HEAD 的提交，期间切到同一提交上的另一个分支或 detach，仍删目录和原分支 | `f94ea31` | `TestRemoveBranchSwitchedWhileEndingSessions`（`other_branch_at_the_same_commit`、`detached_at_the_same_commit`）；原有的 `TestRemoveHeadMovedWhileEndingSessions`、`TestWorktreeRemoveEndpoint/changed_after_sessions_ended` | 全部 PASS；第 15 条规则 exit 0 |
| X14 | P6，一般：路径里有换行的外部 worktree 列不出来、查不了状态 | `771dcc6` | `TestListWorktreesPathWithNewline`（6 个子用例，列出、查状态、在其中开会话并一起删除）；`TestListWorktreesFallsBackWithoutZ`；`TestParseWorktreeList` | 全部 PASS（本机 git 2.50.1 认 `-z`，带换行的子用例没有跳过）；第 13 条规则 exit 0。旧版 git 上的退回模式这一轮没有重跑，结果是返工时的（见「未覆盖和遗留」的「旧版 git」） |
| X15 | P7，一般：预检端点对白名单内但不存在的目录返回 403「不在允许范围内」，与文档不符 | `694e3f5` | `TestPlanMissingWorkdirIs400` | PASS |
| 备注 1（T28） | `TestGitTimeoutKillsProcess` 在验证者那里 4 次都 SKIP，等于没有断言 | `3c9cff8` | 同名用例（先把假 git 运行一次，pid 没写出来算失败，不再跳过） | PASS，没有 SKIP；第 19 条规则 exit 0 |
| 备注 2（T28，c6） | `TestGitEnvKeepsInheritedConfig` 的跳过条件比「git 低于 2.31」宽：探测命令自己失败也会跳过 | `3c9cff8` | 同名用例的两个子用例（探测失败算测试失败） | `GIT_CONFIG_PARAMETERS`、`GIT_CONFIG_COUNT` 都是 PASS，没有 SKIP（git 2.50.1）；要不要保留这个条件跳过仍等用户决定（c6） |

（第 2 轮时的记录）那一轮整套 Go 测试 0 个 SKIP（454 个顶层、386 个子用例）。修复带来的行为变化（design.md 第 10 节「关口 C 第 1 轮返工」、decisions #140–#151、d68–d70）里，用户可能碰到的有两处：post-checkout 钩子失败的仓库里新建命名 worktree 会留下一个 detached 的 worktree（d70；**T30 已改掉，见下一节**）；单独删会话仍不确认 tmux 里的会话是否真的结束（d68，只有删除 worktree 的途中才确认）。这一节表里的回归测试在这一轮（`bbc2e9b`）仍然全部 PASS，其中 `TestUndoAfterWorktreeAddFailedOnItsOwn/post_checkout_hook_fails` 的断言按 c8 改了（见下一节）。

返工的这 8 个提交没有再做独立代码评审（review.md 里没有返工之后的记录），由关口 C 第 2 轮的独立验证者把关（结论：通过，有备注，归档在 `verdict-history.md`）。

## 关口 C 放行后的返工

关口 C 第 2 轮（被测 `482ab63`，验证者是同一模型的全新 agent；结论「通过，有备注」，全文归档在 `verdict-history.md` 的「第 2 轮（提交 482ab63）」）之后，用户对汇总回复 `all`：放行，进入发布之前先改四处（decisions #153）——d71 按默认现在改、c8 改、c7 改点亮规则、c9 写明支持的 git 版本；c6 保留。返工任务 T29–T32，每个都是先写回归测试并确认失败、再修、做变异核对、单独提交。修复前的失败输出、实验、变异核对和旧版 git 上的实测在 `evidence/gate-c-3-rework.md`。

「这次的结果」取自这一轮带 `-v` 的那遍 Go 全套（`evidence/final-run/go-test-v-summary.txt`）、`make check` 里的 `npm test`、`gui-worktree-smoke.mjs` 和对应不变规则的命令。

| 编号 | 问题 | 修复提交 | 回归测试 | 这次的结果 |
|------|------|----------|----------|------------|
| T29（d71，验证结论 N-1） | git 不认 `worktree list -z`（低于 2.36）时按行读列表，路径带换行的 worktree 被读成另一个路径上的一项（`…/a\nfoo` → `…/a`；`…/a\nworktree /别处/evil` → `/别处/evil`），那个目录随后通过对话界面的信任规则 | `7f4d4e1`、`bbc2e9b`（后者只把公共目录按文件系统解析） | `TestFallbackListNeverInventsAWorktree`（15 种拆法：伪造的路径不在列表里、`ChatTrust` 是 untrusted、`WorktreeStatus` 是 not found）；`TestFallbackListFailsWhenTheMainDirectoryCannotBeRead`（3 种）；`TestParseWorktreeListByLine`（25 种形状）；原有的 `TestParseWorktreeList`、`TestListWorktreesFallsBackWithoutZ`、`TestListWorktreesPathWithNewline`、`TestChatTrust` 没有改 | 全部 PASS（43 个新子用例）；第 13、17 条规则 exit 0。真的 git 2.34.1 上：列表、信任、撤销相关的用例 139 行 PASS、0 FAIL、3 个 SKIP（断言「带换行的路径列得出来」的那 3 个，只在认 `-z` 的 git 上成立，跳过条件没有改） |
| T30（c8，验证结论 N-2） | post-checkout 钩子失败时 git 把 `worktree add` 报成失败而 worktree 已建完，「创建失败」留下一个 detached 的 worktree；项目不在侧边栏时看不见，同名重试只看到「目录已存在」 | `72456fe` | `TestCreateFailedByPostCheckoutHookLeavesNothing`（命名、从链接 worktree 发起、容器是符号链接）；`TestUndoLeavesAWorktreeSomeoneElseAddedWhileTheAddRan`（7 个子用例：别人在 add 运行期间在别的路径、在同一路径上建的不动；add 之前就在的不动；git 拒绝在已登记的路径上再 add；钩子以 128 退出时保守地留下）；X9 的三个反例 `TestUndoLeavesAWorktreeSomeoneElseAddedAtTheSamePath` 一个字没改；`TestWorktreeAddKilledDuringCheckoutIsUndone`；真实应用：`gui-worktree-smoke › R3.8.hook` | 全部 PASS；第 18 条规则 exit 0；`R3.8.hook`：两次失败都带钩子的原话、目录 / 登记 / 分支 / 侧边栏的行都不留，钩子去掉后同名建成。git 2.34.1 上同样通过 |
| T31（c7，探索 X1） | 新建或重命名任何终端会话时，其它打开着的后台终端会话都亮「有新消息」（tmux 每次 `set-option` 把所有客户端整屏重画一遍） | `525ab9f` | `desktop/scripts/test-terminal-activity.mjs`（11 例：真的 xterm 加真的 tmux 重绘字节，80×24 和 200×60，切成 4096 / 1000 / 7 / 1 字节都不算变化；文字变了、屏幕滚动了算变化；光标和颜色不算；字节原样按序写入；前台会话、hook 状态、attach 之后的重绘不受影响）；真实应用：`gui-worktree-smoke › X1.redraw` | `test-terminal-activity checks passed (11)`；`X1.redraw`：另一台桌面新建并重命名一个会话，后台会话收到 12 帧重绘，不亮；给它自己改名，不亮；它打印一行，亮「终端 · 有新消息」。原有的 `gui-smoke.mjs` 第 9 步（hook 状态点）、`gui-worktree-smoke` 的 R8.4（三种点，其中「有新消息」来自真实输出）、R1.6、R1.7 照常通过 |
| T32（c9） | 没有写明支持的 git 版本 | `e5f52f0`（只改文档） | 无 | README.md、README.zh-CN.md 的前置条件，CLAUDE.md「前置条件与联调」，design「升级步骤」第 3 步都写着：推荐 git 2.36 及以上（`worktree list -z`）；2.31–2.35 可用，路径带换行的 worktree 不会列出；低于 2.31 不支持（列表不标 `locked` / `prunable`）。没有加运行时的版本检查（d76） |

用户能看到的行为变化：

- **T29**（只在 git 低于 2.36 的机器上）：路径带换行的 worktree 仍不列出，但它的路径被拆出来的任何一段都不再被当成 worktree——不出现在侧边栏、不通过对话界面的信任规则、查不到状态。被拆出来的一段恰好是同一仓库另一个真 worktree 的路径时，那个 worktree 也不列出；主目录自己的路径带换行的仓库读不了（项目行显示读取失败，原因写明要 git 2.36）。git 2.36 及以上的行为没有变。
- **T30**：post-checkout 钩子失败（例如仓库装了 git-lfs 的钩子而 daemon 的 PATH 里没有 `git-lfs`）时，新建 worktree 仍然失败、错误里仍带钩子的输出，但不再留下 worktree、目录和分支，同名可以再试。别人在同一路径上建的 worktree 照旧不动。钩子自己以 128 退出时仍会留下（「后续」）。
- **T31**：后台终端会话只在屏幕上的文字变了（或屏幕滚动了）时才亮「有新消息」；别处新建、重命名会话引起的重绘不再点亮。只变颜色不变文字的输出不会点亮（d74）。hook 带来的「回合结束 / 等你处理」、对话会话的点、当前正在看的会话的规则都没有变。
- **T32**：没有行为变化。

实现比汇总里写的改法多出来的两处（都记了口味型决定，用户可以改）：

- T29（d72）：汇总写的是「按行读时遇到不认识的行、或 `worktree` 行前面不是空行，就丢掉相邻条目」。只按行的形状判断挡不住——换行后面可以正好是 git 会写的行，连空行也可以，拼得出另一个路径上形状完全正确的一项（只做形状规则时 15 种拆法里仍有 6 种读出伪造的条目）。所以加了第二道：每一项的路径必须正好是仓库登记的反向指针（`<git 公共目录>/worktrees/*/gitdir`）之一。形状规则照做，作为第一层。
- T30（d73）：用户确认的是「失败后只认领新出现的、指向本次目录的那一条登记」。别人的 add 插在「记下登记」和「本次的 add 自己检查路径」之间时，它的登记同样是新出现的、同样指向本次的目录，本次的 add 因此以 128 退出；只按确认的规则做，这种情况下别人的 worktree 会被删（两个子用例证实）。所以多一个条件：add 以 git 自己放弃时的退出码（128 / 129）结束时不认领。

为这次返工改变的已有断言，只有一处：

| 用例 | 原来 | 现在 | 依据 |
|------|------|------|------|
| `TestUndoAfterWorktreeAddFailedOnItsOwn/post_checkout_hook_fails`（`gate_c_test.go`） | 钩子 `exit 2` 之后：没有执行过 `git worktree remove`；worktree 留在原处（detached 在本次的提交上），`message` 里有路径和 `not removed`（或者 git 自己已经收回）；分支不留；`message` 带钩子的原话 | worktree、目录都不留（`git worktree list` 里没有、路径不存在）；分支不留；`message` 带钩子的原话 | 用户确认 c8（decisions #153、#157）：R3.8 在这一类失败下的结果就是要变；原断言描述的是 d70 的旧结果 |

没有删除或跳过的测试，没有放宽的断言，没有调大的超时，没有新增的忽略规则或条件跳过。`chat-test-util.mjs` 的 `loadIndex` 多了一个默认关闭的 `realXterm` 选项（给新测试用），原有调用的行为不变。T31 没有改任何已有断言：没有哪一条断言描述的是「重绘也亮」的旧行为。

这 5 个代码提交（`7f4d4e1`、`72456fe`、`525ab9f`、`bbc2e9b`，加文档提交 `e5f52f0` 里对 verify skill 的一处用例数）没有做独立代码评审，由下一轮独立验证者把关。


## 合并 change/dual-mode

实际的分叉点是 `6d88e45`（`git merge-base`）；分叉之后本分支 202 个提交，对话模式 21 个提交（到 `64e8b5e`）。`git merge --no-ff change/dual-mode`，合并提交 `c28c001`。`docs/changes/2026-11-13-dual-mode/` 本分支没有改过，整个是对话模式的版本（`git diff --stat change/dual-mode..HEAD -- docs/changes/2026-11-13-dual-mode` 为空）。

### git 报的冲突（5 个文件）

| 文件 | 取舍 |
|------|------|
| `desktop/src/renderer/index.ts`（5 处） | 取本分支的结构：`notifyTitleFor`、`expandActiveProject`、`buildSidebarModel`、`sidebarActions`。对话模式那边的旧 `renderSidebar` 循环体（约 170 行）和旧 `startInlineRename` 不要——本分支已经把它们搬到 `sidebar.ts`。保留对话模式新增的 `focusView`、`focusAfterRename`、`selectOpenSession` |
| `desktop/package.json` | `test` 清单取并集：本分支的 34 步后面接 `test:sidebar-rename`、`test:source-bytes`；两个脚本定义都在 |
| `desktop/scripts/chat-test-util.mjs` | `__test` 导出取并集（本分支的 `machineTrees`、`machineCaps`、`machineProjects`、`refreshAllMachines`、`pollMachines` + 对话模式的 `rests`、`ChatView`） |
| `.claude/skills/verify/scripts/gui-smoke.mjs` | bash daemon 的配置两边都要：本分支的 `claude_flags`，对话模式的「`default_workdir` / `allowed_roots` 只给本次运行的目录」 |
| `docs/changes/README.md` | 两个需求各一行，对话模式那行取它的（已验证 / 待人工合并） |

自动合并、没有冲突的：`CLAUDE.md`（continue 改写那一条）、`.devflow.yml`（第 4 条的 check）、`.claude/skills/verify/SKILL.md`（X 用例的说明）、`docs/protocol.md`（3 处）、`i18n.ts`、`chat/` 下 5 个文件、4 个 `test-chat-*`、Go 的 7 个文件、`gui-chat-smoke.mjs`。`CHANGELOG.md` 两边在分叉之后都没有改过。

### 没有报冲突、但语义上要处理的

| # | 发现了什么 | 怎么处理 | 哪个用例守着 |
|---|-----------|----------|--------------|
| 1 | **X6**：对话模式把「当前对话会话在窗口失焦时有待答请求也显示黄点」写在旧侧边栏的循环里，git 把它连同整个旧循环放进了冲突块；新侧边栏的 `renderSession` 仍是「当前会话一律不显示」。window `focus` 监听和点亮逻辑在 `index.ts`，自动合入了 | 判断搬到 `sidebar.ts` 的 `renderSession`：状态点和第二行的状态文字共用一个 `showState` | 合并后、改之前 `test-chat-activity` 的 X6 用例失败（`'none' !== 'waiting'`）；改后通过。真实应用：`gui-chat-smoke` 的 `X6`，`gui-worktree-smoke` 的 `M.X6`（worktree 行下） |
| 2 | **X8 / X10 的改名**：两套做法。本分支：`sidebar.ts` 里 `startInlineRename` + `actions.setRenaming`，点击处理里 `e.detail > 1` 的第二次点击不打开；对话模式：`index.ts` 里 `selectOpenSession`（点当前会话不重建）、`startInlineRename` 里「标签不在文档里就不开始」、结束时 `focusAfterRename`、`focusView` 在改名期间不抢键盘。合并后 `setActive` 里的 `focusView` 是生效的，其余几处落在被丢掉的旧代码里 | 合成一套：点击路径用本分支的（保留 `detail > 1`），`SidebarActions.open` 接 `selectOpenSession`；`sidebar.ts` 的 `startInlineRename` 加上「不在文档里就不开始」；`setRenaming(false)` 里重建之后调 `focusAfterRename`。`renamingActive` 只有 `index.ts` 的一个，改名入口只有 `sidebar.ts` 的一个 | 合并后、改之前 `test-sidebar-rename` 在新侧边栏上 15 个里 6 个失败（`evidence/merge-dual-mode/before-port-test-sidebar-rename.txt`）；改后 15 个在两种位置都过。真实应用：`gui-chat-smoke` 的 `X8-chat`、`X8-terminal`、`X10-rename-chat`、`X10-rename-terminal`，`gui-worktree-smoke` 的 `X2.rename`、`M.X8` |
| 3 | **`focusAfterRename` 与本分支的「重建后找回焦点」相冲**（合并后才出现，两边单独都没有）：点另一个会话的名字结束改名之后，本分支的侧边栏会把焦点还给那个名字按钮，对话模式的 `focusAfterRename` 看到焦点不在 `body` 上就不动——键盘停在侧边栏上，接着打的字哪也不去 | `focusView` 在改名期间被调用时记一笔（`focusHeldByRename`），`focusAfterRename` 据此在焦点停在侧边栏控件上时也把键盘交给当前会话；Tab 离开改名框不算。单独提交 `0734e1a` | 真实应用里先失败：`X10-rename-chat`（`the keyboard was on: session-label`）。补了会失败的单元用例「rename committed by pressing another session's name (which takes the focus)」，修后通过；另加「rename left with Tab」，变异核对（总是从侧边栏拿走焦点）失败 |
| 4 | **删除对话会话的确认文案**：对话模式改的是 `window.confirm(deleteConfirmText(…))`；本分支的删除入口是应用内确认框 `confirmDeleteSession`，合并后那句话没有任何调用处 | 对话会话的确认框正文换成那句话（`session.delete.chatBody`），`confirmDeleteSession` 多一个 `chat` 参数；没有调用处的 `chat.delete.confirm`、`deleteConfirmText` 删掉。删 worktree 的确认框（`delete-wt-dialog`）说的是 worktree 和里面的会话数，不分对话和终端，没有改 | `test-sidebar-rename` 的 delete confirmation 用例（改写过，见下）；`test-worktree-dialogs` 的 4 个 `delete_session_*` 不变 |
| 5 | **`gui-smoke.mjs` 的侧边栏布局用例**（本分支加的）把测试仓库建在 `/tmp` 下；对话模式把 bash daemon 的 `allowed_roots` 收到本次运行的目录之后，这些仓库它够不着 | 仓库建在 bash daemon 自己的目录里（`makeSidebarRepos(termWorkdir)`） | `gui-smoke.mjs` 的「sidebar shows the projects, worktrees and sessions under test」 |
| 6 | **X4 / X9 在 worktree 会话上**：读代码确认三个调用处用的是同一个 `chat.LatestSessionForWorkdir`，传的都是会话自己的工作目录（`manager.go:382` 终端新建，新建 worktree 时是新 worktree 里的目录；`manager.go:856` 重载，`runner.CurrentWorkdir()`；`chat_manager.go:251` 对话新建，worktree 模式不查）。没有要改的 | 补 `TestContinueInWorktreesSharingProjectDir`：分支 `fix/login` 和 `fix.login` 的 worktree 目录是同一个 claude 项目目录 | 该测试；变异核对（不看 `cwd`）失败：`this claude conversation is already open in session "fix-login"` |
| 7 | `gui-worktree-smoke.mjs` 的 **R8.3**（旧脚本的断言行不减少）以分叉点的版本为基准，而对话模式自己在返工里换掉了两行 | 见 decisions c11：再对照合并进来的版本 | R8.3 自己 |
| 8 | `test-source-bytes`（NUL 字节）遍历整个 `desktop/src`，本分支新增的 `sidebar.ts`、`tree.ts`、`worktree-dialogs.ts` 等都在内（40 个文件）；`test-chat-render-guard` 只看 `chat/`（15 个文件），本分支没有往 `chat/` 里加会写 HTML 的文件 | 不用改 | 两个检查本轮通过 |

### 对话模式返工的每一项在合并后是否生效

| 返工 | 是否生效 | 依据 |
|------|----------|------|
| X3 流式途中重连只显示一条回复 | 生效（直接合入，`chat/session.go`、`chat/session.ts`） | `TestTailOverflowKeepsMessageStart`、`test-chat-session` 20 个，本轮通过 |
| X4 / X9 `-c` 按 JSONL 的 `cwd` 认领 | 生效；worktree 会话走同一个函数、目录传得对 | 对话模式的 7 个 Go 测试 + `TestContinueInWorktreesSharingProjectDir`（新增，变异核对过） |
| X5 `docs/protocol.md` 的 `chat_ack` | 两边的修改都在 | `evidence/final-run/protocol-sync.txt` |
| X6 窗口失焦时当前会话的黄点 | 生效（要搬，上表 1） | `test-chat-activity`；`gui-chat-smoke` `X6`；`gui-worktree-smoke` `M.X6`（新增）。变异核对：`showState` 改回「当前会话一律不显示」→ `M.X6` 失败（`timeout: yellow dot on the row of the session shown`） |
| X7 不贴底时发消息 / 后台收到内容后切回 | 生效（直接合入，`chat/window.ts`、`chat/view.ts`；`setActive` 里 `view.show()` 是唯一的调用处，合并后还在） | `test-chat-view` 22、`test-chat-window` 3；`gui-chat-smoke` `X7-send`、`X7-background`；`gui-worktree-smoke` `M.X7`（新增）。变异核对：去掉 `show()` 里的 `if (this.pinned) this.toBottom = true` → `M.X7` 失败（`the view is 785px above the newest message`） |
| X8 已打开的会话双击改名 | 生效（要合成一套，上表 2） | `test-sidebar-rename`；`gui-chat-smoke` `X8-chat`、`X8-terminal`；`gui-worktree-smoke` `X2.rename`、`M.X8`（新增） |
| X10 改名后和点开待答会话后的键盘 | 生效（要接线，上表 2、3） | `test-sidebar-rename` 的 X10 用例；`gui-chat-smoke` `X10-prompt`、`X10-rename-chat`、`X10-rename-terminal`；`gui-worktree-smoke` `M.X8`、`M.X10`（新增）。变异核对：`setRenaming(false)` 不调 `focusAfterRename` → `M.X8` 失败（`where the keyboard is after Enter: got "nowhere"`）；`ChatView.focus()` 不看卡片 → `M.X10` 失败（`got "session-label", want "chat-perm"`） |
| 删除对话会话的确认文案 | 生效（搬进应用内确认框，上表 4） | `test-sidebar-rename` delete confirmation |
| `prompts.ts` 的 NUL 字节和源码字节检查 | 生效，覆盖到本分支的新文件 | `test-source-bytes`：40 个文件 |
| `TestOrphanCleanup` 的等待上限 | 直接合入 | 本轮通过 |
| 拖选用例的加固、bash daemon 的 `allowed_roots` | 在（冲突里两边都留，上表 5） | `gui-smoke.mjs` 两次运行「drag-select … ⌘C」都通过，没有打印重量的 `NOTE` |

### 补的用例

| 用例 | 测什么 | 变异核对 |
|------|--------|----------|
| `gui-worktree-smoke.mjs` `M.X8` | worktree 行 `fix-login` 下：真实双击改名对话会话（回车保存，名字没发给 claude）→ 不点击直接打字，字进了这个会话；Esc 不改名、键盘也回来；同一行下的终端会话双击改名 → 不点击直接敲命令，命令在终端里执行 | 去掉 `focusAfterRename` 的调用 → 失败 |
| `M.X10` | worktree 行下的后台对话会话来权限请求 → 行上黄点和「等你处理」→ 真实点击点开 → 键盘在卡片上 → 按 `1` 卡片关闭、回合继续 → 键盘在输入框 | `ChatView.focus()` 不看卡片 → 失败 |
| `M.X6` | worktree 行下的对话会话是当前会话、应用真的隐藏时来权限请求 → 它的行显示黄点和「等你处理」→ 窗口回到前台后消失 | `showState` 去掉例外 → 失败 |
| `M.X7` | worktree 行下的对话会话在后台收到 40 条消息 → 点回来贴着底、最新一条在屏幕上、键盘在输入框 → 直接打字，消息和回复都显示 | 去掉 `show()` 里回到底部那一行 → 失败 |
| `test-sidebar-rename`：每个用例在「项目行下 / worktree 行下」各跑一遍 | 对话模式的 15 个用例在两种 DOM 层级上都成立 | —（同一批断言） |
| `test-sidebar-rename`：「rename committed by pressing another session's name (which takes the focus)」「rename left with Tab」 | 上一节第 3 行 | 见上一节第 3 行 |
| `TestContinueInWorktreesSharingProjectDir` | 上一节第 6 行 | 不看 `cwd` → 失败 |

四个 `M.*` 的变异核对是在 `desktop/` 的副本里各放一处缺陷、单独构建后用 `VR_DESKTOP_DIR` 跑的（`evidence/merge-dual-mode/mutation-checks-worktree-row-cases.txt`），副本已删，仓库里的代码没有动。截图 `evidence/merge-dual-mode/M.X6.png`、`M.X7.png`、`M.X8.png`、`M.X10.png`，以及对话模式 7 个 X 用例在三层侧边栏上的画面 `X7-send.png` … `X10-rename-terminal.png`。

### 被改写的测试

| 用例 | 原来 | 现在 | 断言是否原样 |
|------|------|------|--------------|
| `test-sidebar-rename` 的 `setup()`（全部 15 个用例共用） | 只给 `machineSessions` 和带 `renameSession` / `listSessions` 的 REST 替身；终端替身没有 `screen` | 另给项目树（`machineProjects`、`machineCaps = 'v4'`、`listProjects`），会话按用例所在的位置挂在项目的主目录或 worktree `fix-login` 下；终端替身多一个 `screen.forget()`（本分支的 `setActive` 会调）；多一条断言「会话行确实挂在这一层下面」 | 原样。定位用的类名（`.session-item`、`.session-label`、`.session-label-text`、`.session-rename-input`、`.session-close`）两边相同，没有改 |
| `test-sidebar-rename`「delete confirmation…」 | 把 `window.confirm` 换成记录参数的函数，点两行的删除按钮，断言两次的参数分别等于 `chat.delete.confirm`、`session.deleteConfirm` 代入名字；词典断言：对话文案含 `JSONL` 和 `{name}`、不含「当前画面会丢失」；终端文案含「当前画面会丢失」 | 点删除按钮后读应用内确认框（`delete-session-dialog`）的标题和正文，点取消；断言标题 = `session.delete.title` 代入名字，正文 = `session.delete.chatBody`（对话）/ `session.delete.body`（终端）；没有弹系统确认框；拒绝后什么都没删。词典断言：对话正文含 `JSONL`、不含「当前画面会丢失 / 无法撤销」；标题含 `{name}`；终端正文含「无法撤销」、不含 `JSONL` | **不完全原样**：「对话写明记录留在 JSONL、不说丢失」「拒绝后不删」原样；**「终端会话的确认写着当前画面会丢失」换成了「写着无法撤销」**——本分支的确认框（R5.1，T12）早就把终端的那句话换成了「会话会结束，远程进程会被终止，无法撤销」，`session.deleteConfirm` 这个键在本分支已经不存在。记为 decisions c12，等用户裁决 |
| `gui-chat-smoke.mjs` 的 `pointOf`（所有真实点击共用） | 取元素中心，要求该点命中元素 | 元素在侧边栏列表里时先 `scrollIntoView({ block: 'nearest' })` 再取；要求不变 | 原样 |
| `gui-chat-smoke.mjs` 的改名双击（`renameByDoubleClick`、`X10-rename-chat` 两处、`X10-rename-terminal` 一处） | `realClick(…, 2)` | **第 5 轮：恢复成 `realClick(…, 2)`，与 `64e8b5e` 相同。** 第 4 轮曾改成 `doubleClickName(…)`（先等侧边栏 300 ms 没有重建；被吞时打印 `NOTE` 重做，最多两次）；c10 的裁决不接受，T34 修掉原因之后撤掉（decisions #168、#176） | 原样，没有重做 |
| `gui-chat-smoke.mjs` `X7-send` 的最后一条断言 | — | 断言之前加了一段只在它将要失败时打印位置的 `NOTE` | 原样（就是对话模式的那一行） |
| `gui-smoke.mjs`、`gui-chat-smoke.mjs`、`gui-worktree-smoke.mjs` 的 daemon 启动 | 没有自己 claude 配置目录的 daemon 不设 `CLAUDE_CONFIG_DIR` | 给一个本次运行的空目录 | 不涉及断言 |
| `gui-smoke.mjs` 侧边栏布局用例的夹具 | 仓库建在 `/tmp` | 建在 bash daemon 自己的目录 | 原样 |
| `gui-worktree-smoke.mjs` `R8.3` | 两份旧脚本对照分叉点 `6d88e45` 的版本：用例数不减，每一行断言都在 | 再对照合并进来的 `64e8b5e`：它的每一行断言都在，用例数不少于两个版本；分叉点版本的断言行只有在对话模式自己已经没有时才允许不在（现在各 1 行：R5.6 的永真断言、拖选目标的等待） | **改了判断的口径**（decisions c11，等用户裁决） |

**第 5 轮的更新**：上表里「等用户裁决」的三处都有了裁决（decisions #168–#170）——改名双击的重做已撤（上表已改）；R8.3 同时对照分叉点和合并进来的版本，接受，照现在的做法；「终端会话的删除确认」那条断言换成对照 `session.delete.body`，接受。现在 `gui-chat-smoke.mjs` 相对 `64e8b5e` 只有三处不同：每个 daemon 的空 `CLAUDE_CONFIG_DIR`、点击前把侧边栏里的目标行滚进可见区（`pointOf`）、`X7-send` 失败时才打印的 `NOTE`。

对话模式的脚本相对 `64e8b5e`：`gui-smoke.mjs`、`gui-chat-smoke.mjs` 里带 `check(` / `assert(` / `test(` / `waitFor(` / `fail(` 的行一行不少（R8.3 每次运行都机械地比）。没有删除、跳过任何用例，没有调大任何超时。

**认为不再有意义、留给用户裁决的用例**：没有整个用例。有一条断言（上表第 2 行「终端会话的删除确认写着当前画面会丢失」，c12）和一个被删掉的词条（`chat.delete.confirm`，d77）属于这一类：它们测的 / 服务的是 `window.confirm` 那个确认框，本需求有意把它换成了应用内确认框。

### 运行过程中的失败

最终代码上的一轮全过；到那之前的失败，按出现的先后：

1. 合并后、移植之前的单元测试：`test-sidebar-rename` 6 个、`test-chat-activity` 1 个失败——这就是上面「语义上要处理的」第 1、2、4 行，是预期中的（合并把修复放进了不再调用的代码）。
2. 第一次跑 `gui-chat-smoke.mjs`：`X10-rename-chat` 失败，`sidebar item x10r: something else is on top of it`。测试的定位问题：三层侧边栏更长，目标行在可见区之外。改了 `pointOf`。
3. 接着 `X10-rename-chat` 失败 `the keyboard was on: session-label`——**合并带来的真问题**（「语义」第 3 行），修了（`0734e1a`）。
4. `X8-chat` / `X8-terminal` 多次失败 `no focused rename input 600 ms later (focus is on session-label)`。原因查清了（`evidence/merge-dual-mode/trace-rebuild-*.txt` 是当时在页面里记下的事件顺序）：双击的第二次按下和松开之间侧边栏重建了 7–10 次，按着的那个名字被换掉，`click` / `dblclick` 没有发出。这是对话模式「后续」里的已知问题，没有修（任务要求不修）；测试里加了重做（c10）。**`X7-send` 失败 1 次**（`at the bottom the newest reply is missing; last message: x7 from elsewhere`，7 个 X 用例连跑的 5 次里的第 4 次）：单独连跑 12 次、之后的 4 次全量运行都没有再出现，**没有查到原因**（d80）。
5. 第一次跑完整的 `gui-worktree-smoke.mjs`：`R8.3` 失败（「语义」第 7 行，c11）；第二次另有 `M.X8` 失败 1 次（刚建完会话紧跟着的刷新吞掉了双击，同第 4 条的原因；`M.*` 用例改成点击前等侧边栏 400 ms 没有重建，此后含 `M.X8` 的 17 次运行没有再出现）。
6. **`M.X7` 失败 1 次**（`where the keyboard is after opening the session: got "nowhere", want "chat-input"`，一次完整运行里）：之后只跑 M 用例 7 次、X 和 M 用例一起 5 次、完整运行 2 次都没有再出现，**没有查到原因**。用例里加了只在这种时候打印的焦点记录。如果是真的，用户看到的是「点开一个后台对话会话后要先点一下输入框才能打字」。
7. 发现 #164（测试 daemon 读真实的 `~/.claude.json`）时停掉了正在跑的一次 `gui-worktree-smoke.mjs`（给它发 SIGTERM，脚本自己清理），那一次没有结果。

### 对话模式的已知问题在三层侧边栏上

对话模式 tasks.md「后续」里与侧边栏有关的三条，在合并后的构建上各实测一次（`evidence/merge-dual-mode/known-issues-probes.txt`，探针代码 `known-issues-probes.mjs.txt`；都没有修）：

| 已知问题 | 在三层侧边栏上 |
|----------|----------------|
| 待答卡片一出现就拿走键盘，接着敲的数字可能误批准 | **同样存在，行为相同**（与侧边栏无关）。在对话输入框里打着半句话时来了卡片：键盘到了卡片上，`1` 回答了它，草稿还在。机器管理对话框开着、在文本框里打到 `10.0.` 时来了卡片：键盘被拿到卡片上，`1` 批准了请求，文本框里没有多出字符 |
| 改名时点另一个会话，这次点击被吞 | **同样存在**：本机 daemon、按住 60 ms，5 次里 0 次切换成功（对话模式在本机上也是 0/5），名字每次都保存了。**有一处不同**：对话模式那边被吞之后键盘回到原来的会话；这里键盘停在被点的那个会话名上（侧边栏重建后把焦点还给了它），原来的会话仍然显示着，接着打的字哪也不去（不会打进看不见的会话）。再点一次即可。**第 5 轮（T34 之后）：仍然存在**，实测 10 次里 8 次没有切换，名字每次都保存了（`evidence/t34/probes-after-t34.txt`）：按下时改名框失焦提交，改名请求和刷新约 60 ms 内回来，名字变了、列表重建一次，这时按键还没松开。这是内容确实在变的一瞬间，T34 不管这种 |
| 侧边栏重建吞点击 | **同样存在，改名用的双击更容易碰到**。一次刷新在这里是每台机器两次重建（会话列表、项目树），测试里 5 台机器是 10 次、前后约 50 ms（对话模式是 5 次、几毫秒）；新建会话或改名之后紧跟着就有一次刷新。加重做之前 `X8-chat` / `X8-terminal` 在多次运行里因此失败；加之后含这两个用例的 9 次运行里重做了 3 次。「黄点一出现就去点」这一种：这一次实测 8 次点击 8 次都打开了（对话模式那边是 30 次丢 5 次、20 次丢 1 次）；只测了一轮，不能说它没有了。**第 5 轮（T34 之后）：「内容没变也重建」这一部分已修**——两轮轮询里列表 0 次改动，轮询不停的情况下 20 次真实单击、10 次真实双击一次不丢（`T34.quiet`，5 次完整运行每次如此）；重做已撤，含 `X8-chat` / `X8-terminal` 的 18 次运行（7 个 X 用例 13 次、完整 5 次）没有一次失败。内容确实在变的那一瞬间的重建仍会吞掉正好跨在它两边的点击 |

## c10–c13 裁决之后的返工（T34）

### 裁决和落实

| 项 | 裁决 | 落实 |
|----|------|------|
| c10 改名的真实双击被侧边栏重建吞掉时重做 | 不接受；改为修原因 | 任务 T34（提交 `15a37b2`）：侧边栏要显示的内容没变就不重建。`gui-chat-smoke.mjs` 里的 `SIDEBAR_WATCH`、`sidebarQuiet()`、`doubleClickName()` 删除，四处调用恢复成 `64e8b5e` 的 `realClick(…, 2)`；`gui-worktree-smoke.mjs` 的 M 用例点击前「等侧边栏 400 ms 没有重建」一并去掉（decisions #176、d82） |
| c11 R8.3 同时对照分叉点和合并进来的版本 | 接受 | 不动；decisions #169 |
| c12 终端会话删除确认的断言换了内容 | 接受 | 不动；decisions #170 |
| c13 规则文件 | 都加 / 保留 | `CLAUDE.md` 两段（其中与 T34 有关的句子按现在的代码写）、`.devflow.yml` 第 4 条 check 加一个用例名、verify skill 的三处保留并把 `NOTE` 重做那一条改掉（提交 `1a99f46`、`15a37b2`；decisions #171、#177） |

### T34 修了什么

一轮刷新里每台机器的会话列表和项目树两个应答各自调用 `renderSidebar()`，每次都把 `#machine-list` 整棵清空重建，数据一个字没变也一样；5 台机器每 5 秒 10 次。鼠标按下和松开之间落进一次重建，两次事件落在两个不同的元素上，`click`（或双击的第二次点击和 `dblclick`）发不出来。

改动只在 `desktop/src/renderer/index.ts` 的 `renderSidebar()`：每次照常建模型，算一个指纹，与上次渲染的指纹相同、且各台机器的配置对象还是同一批时返回，不碰 DOM。不防抖、不加定时器。`sidebar.ts` 没有改。

指纹里有什么（`sidebarFingerprint`）：语言；`activeKey`；`overviewMachineKey`；每台机器的名字、key、在线状态、是否折叠、能力；每个项目的全部字段和是否折叠；每个 worktree 的全部字段和是否正在删除；每个会话的显示名、`gone`、会话信息、状态点、是否正在重载。另外单独比较各台机器的配置对象是不是同一批（行上的处理函数拿着它，含 token；不进字符串）。改名一开始就作废记下的指纹。故意不在指纹里的：对话会话的 `activitySeq`、`epoch`、`state`（界面不显示、处理函数不读，它们的意义已折成状态点；decisions d81）。

逐行核对 `sidebar.ts` 渲染时读了什么：只有模型（字段、`dotOf`、`isReloading`、`isRemoving`、`collapsedProjects`）和 `t()`。`isOpen` 只在点击时读；`document.activeElement` 和行菜单的锚点只在重建时用来找回焦点和菜单；窗口有没有焦点（X6 的黄点）`sidebar.ts` 不读，它经 `index.ts` 的 `nextDot` 进了状态点；没有相对时间、主题之类由脚本决定的内容，悬停和焦点的显隐是 CSS。

### 修复前后

| | 修复前（`beccc60` + 新用例） | 修复后 |
|--|------|------|
| 单元 `test-sidebar-refresh` | FAIL：`after a poll: elements of the sidebar were replaced`（去掉 3 个「不重建」的用例，其余 14 个「变了要更新」的用例都过——它们描述的是原来就有的行为） | `checks passed (17)` |
| 真实应用 `T34.quiet`：5 台机器安静状态下跨过两轮轮询，`#machine-list` 子树的改动次数（`MutationObserver`，`childList` + `subtree`） | **120 次**（两轮 × 5 台机器 × 2 个应答 = 20 次重建；每次重建是 1 条清空记录加 5 条追加机器分组的记录，按此推算） | **0 次**（第一次运行和 5 次完整运行每次都是 0） |
| 同一用例：每 150 ms 触发一次应用自己的轮询，20 次真实单击切换会话（按住 60 ms） | 丢 16 次 | 20 / 20 |
| 同一用例：10 次真实双击改名（按住 60 ms、间隔 90 ms；终端和对话会话，前台和后台） | 丢 7 次 | 10 / 10 |

输出在 `evidence/t34/unit-before-fix.txt`、`gui-before-fix.txt`、`gui-after-fix.txt`。

### 变异核对

每种缺陷都放在 `desktop/` 的副本里，不动工作区（`evidence/t34/mutations.txt`）。

| 缺陷 | 失败的用例 |
|------|------------|
| 去掉指纹比较（每次都重建） | 单元「the same data again … leaves every element in place」；真实应用 `T34.quiet`（`changed 120 times …; 19 of 20 clicks …; 9 of 10 double clicks …`） |
| 指纹里漏掉状态点 | 「a chat session that is not open keeps working」（`the dot new activity lights`） |
| 漏掉语言 | 「switching the language redraws the sidebar」 |
| 漏掉「正在删除」 | 「a worktree being deleted says so」 |
| 漏掉当前会话 / 概览机器 | 「the session shown, and the machine overview」 |
| 漏掉项目折叠 / 机器折叠 | 「state dots of chat sessions not open here …」/「folding and unfolding」 |
| 漏掉「正在重载」 | 「a reload in flight disables the row's reload button」 |
| 漏掉在线状态 / 能力 | 「a machine goes offline and comes back; a daemon turns out to be an old one」 |
| 不比较机器配置对象 | 「a machine edited in the manager …」（新连接的 auth 帧带的是旧 token） |
| 改名开始时不作废指纹 | 「a rename ended with Esc puts the name back」 |
| 把 `activitySeq` / `epoch` / `state` 放回指纹 | 「a chat session that is not open keeps working … nothing is rebuilt」 |
| 漏掉机器名 | **没有用例失败**：机器管理每次保存交回的都是新对象，被「不比较机器配置对象」那一项盖住；名字仍放在指纹里，让指纹自己说得清显示了什么 |
| （焦点用例）重建时把焦点还给「上一个有过焦点的侧边栏控件」 | `test-sidebar-rename`「a sidebar rebuild after a session was opened from its name leaves the keyboard in the session」 |

### 撤掉重做之后的稳定性

| 运行 | 次数 | 结果 |
|------|------|------|
| `gui-chat-smoke.mjs` 的 7 个 X 用例（`X7-send`、`X7-background`、`X8-chat`、`X8-terminal`、`X10-prompt`、`X10-rename-chat`、`X10-rename-terminal`），撤掉重做之后立刻 | 3 | 每次 10 行 PASS、0 FAIL、0 NOTE |
| 同一组，T34 之后连跑（`X7-send` 的复现尝试） | 10 | 每次 10 行 PASS、0 FAIL、0 NOTE |
| `gui-chat-smoke.mjs` 完整 | 5 | 每次 37 行 PASS、0 FAIL、0 NOTE |
| `gui-worktree-smoke.mjs --only=M.X7`（`M.X7` 的复现尝试，`evidence/t34/m-x7-20-runs.txt`） | 20 | 每次 4 行 PASS、0 FAIL、0 NOTE |
| `gui-worktree-smoke.mjs --only=T34,M,X11,X8,X2,X1,X3,X6` | 1 | 12 / 12 |
| `gui-worktree-smoke.mjs` 完整 | 5 | 每次 72 / 72 用例、75 行 PASS、0 NOTE |
| `gui-smoke.mjs` 完整 | 2 | 每次 46 行 PASS |

`X8-chat`、`X8-terminal`、`X10-rename-*` 各跑了 18 次，`M.X8` 6 次，`T34.quiet` 6 次，没有一次失败。第 4 轮不重做时 `X8-chat` / `X8-terminal` 约 2/5 的运行失败。

### 被改动的已有测试

**断言：无**（没有删除、改写、放宽任何一条断言，没有调大超时，没有加重试）。改了准备步骤或去掉等待的：

| 用例 | 原来 | 现在 | 依据 |
|------|------|------|------|
| `test-sidebar-rename`「a rename that cannot start (its label is no longer in the document) …」 | 调一次 `renderSidebar()` 当作「轮询把标签换掉了」 | 先让 shell 会话的目录变一下再调 | 没有变化就不重建；用例要的是标签被换掉。后面的断言（`stale.isConnected === false` 等）原样 |
| `test-sidebar` 的 `remove_result_closes_views` 里「重建之后标记还在」 | 调一次 `renderSidebar()` | 先让一个会话在别处改了名再调；多断言一条「这一行确实换了」 | 同上；不改的话这一步空过 |
| `gui-worktree-smoke.mjs` `X11.menu`、`X8.menu` 的 `rebuilt()` | 只刷新 | 先经 REST 给同一台机器上的另一个会话改名（等于别的桌面改了名）再刷新 | 同上；两条「the refresh did not rebuild the row」断言原样 |
| `gui-worktree-smoke.mjs` `M.X8`、`M.X10` | 点击 / 双击之前等侧边栏 400 ms 没有重建（第 4 轮加的） | 不等 | 等安静和重做一样是在绕开吞点击（decisions d82） |
| `gui-worktree-smoke.mjs` `M.X7` | 后台那一串消息结束后等侧边栏 400 ms 没有重建，再点击 | 等这一行显示「回合结束」的点，再点击 | 脚本那条连接收到回合结束，不等于应用自己那条连接也收到并画完了点；等的是应用的一个具体状态 |
| `gui-chat-smoke.mjs` 的改名双击 4 处 | 第 4 轮：`doubleClickName(…)`（等安静 + 重做） | `realClick(…, 2)`，与 `64e8b5e` 相同 | c10 的裁决 |
| `test-sidebar.mjs` 的一处注释 | 「每个应答都整体重建」 | 「要显示的内容变了才重建」 | 注释跟着事实 |

### 两个没有复现出来的偶发

- **`M.X7`**（点开后台对话会话后键盘 `nowhere`，第 4 轮见过 1 次）。怀疑的路径——会话已经拿到键盘，随后一次侧边栏重建把焦点「还给」侧边栏——**读代码不成立，不是 bug**：`sidebar.ts` 的 `renderSidebar` 用 `identify(container, document.activeElement)` 取要找回的焦点，焦点不在侧边栏容器里时返回 `null`，重建后不调用任何 `focus()`；重建只清空并重填 `#machine-list`，碰不到会话视图里的元素。补了单元用例守着这一点（提交 `5fc55e1`；对话输入框、待答卡片、终端三种，另有「点下去到会话拿到键盘之间的那次重建，焦点留在被点的名字上」），做了变异核对。然后把 `M.X7` 单独连跑 20 次：全部通过，0 行 `NOTE`；加上完整运行共 26 次没有出现。`nowhere`（焦点在 `body` 上）说明持有焦点的元素被移走或隐藏了，是什么把它移走的没有查到。留在偶发清单里。
- **`X7-send`**（最新回复不在屏幕上，第 4 轮见过 1 次）。它所在的那组用例连跑 10 次、撤掉重做后 3 次、完整 5 次，共 18 次没有出现，`NOTE` 没有被触发过，没有现场数据。没有改任何东西，如实记为未复现的偶发。

### T34 之后的两个探针

一次性的，不进套件（`evidence/t34/probes-after-t34.txt`）。发现的两件事都没有修：

- 改名时点另一个会话：10 次里 8 次没有切换（见「合并 change/dual-mode」的已知问题表）。
- **机器概览页仍然每个应答重画一次**：正在看的那台机器每 5 秒 2 次（11 秒里 4 次，同一段时间侧边栏 0 次改动）。其中项目树那一次是本需求加的（基准上每台机器每轮一次），而概览页不显示项目树的内容。页面上的按钮和 T34 之前的侧边栏是同一种问题；有没有真的丢点击没有测。T34 的范围是侧边栏，没有动它，请协调者决定要不要追加（decisions d83）。

### 运行过程中的失败

1. `test-sidebar-rename`「a rename that cannot start…」在 T34 的修复之后失败 1 次（`true !== false`，`stale.isConnected`）：用例靠「没变也重建」模拟轮询。改了准备步骤（上表第 1 行）。
2. `make check` 第一次（2026-11-20 18:50）：`TestRemoveGitFailureKeepsState` 失败，`err = … git rev-parse --show-toplevel: no answer within 5s: context deadline exceeded, want *WorktreeRemoveError`。当时 load average 27–34（机器上有别的应用占着 CPU；这次测试只有这一个进程组在跑）。原因是清楚的：用例把 git 换成一个 shell 包装脚本，`RemoveWorktree` 的第一条 git 调用在 daemon 自己的 5 秒时限内没有返回，于是得到的是「读仓库失败」而不是用例等的「git 删除失败」。这一轮没有改 `vibe-remoted/`。随后：该用例单独 `-count=10` 10 次通过（1.5–4.1 秒）；带 `-v` 的整套 468 个顶层测试通过；第二次 `make check`（19:06，负载 38）在会话中断时被终止，没有结果；2026-11-21 17:08 的 `make check` 退出 0。与已在清单里的 `TestWorktreeStatus/ignored_timeout` 是同一类（负载高时一次普通的 git 调用超过时限），没有改断言，没有调时限。
3. 此外没有失败。GUI 的 12 次完整运行、接口冒烟、规则都是第一次就通过。


## 待验证项

来自 review.md 的 13 条。实验是测试阶段前半做的（`evidence/pending-checks.md`，被测 `ba9caa4`），第 1 轮探索时对第 11 条有新的发现（X8）。关口 C 第 1 轮的两名验证者把这 13 条各看了一遍（`verdict-history.md` 两份结论的「待验证项」）：与这里不同的是第 7 条（被推翻了一部分），第 9、10、13 条由验证者独立重做后排除，第 3、4、8 条仍缺条件。这一轮（返工复验）没有重做这些实验，只按返工的结果更新了第 5、7 条。

| 来源（review.md「待验证项」） | 做的实验 | 结果 | 证据 |
|------------------------------|----------|------|------|
| 1，`test-theme-tokens.mjs:322`：M1 的整体画面 | 临时实例里走一轮含工具调用和权限请求的对话、开一个终端会话，断言形态和实际像素，截图与效果页逐块对照 | 已排除（已记录的几处外观差异仍在；这一轮多记一处：detached 行的图标） | evidence/R8.1.png、R8.2.png |
| 2，`test-dialog-layout.mjs:14`：800×500 中英文下各对话框 | `dialog-layout.mjs` 在 800×500、中英文各量 13 个画面 | 已排除；这一轮在真实缩小的窗口里又看了一遍英文的四种删除确认框 | evidence/R8.5.png |
| 3，`main/index.ts:102`：冷启动首帧 | 主进程停在第一条语句，记录窗口原生底色和第一次绘制完成的整帧 | 已排除到「第一次绘制完成的那一帧」；窗口出现到首次绘制之间（约 0.1 秒）屏幕上实际合成的像素**仍缺条件**（要录屏） | evidence/R8.6.png |
| 4，`shortcuts.ts:48`：真实键盘 | CDP 按键：捕获阶段拦截、切换、终端 0 字节、草稿不变 | **仍缺条件**：缺的是真实键盘经过 macOS 菜单分发和输入法的那一段（不允许向系统前台发按键）。下一步：人在打包后的 app 里按一遍，步骤见「未覆盖和遗留」 | 运行输出（R7.1–R7.5） |
| 5，`worktree.go:90`：git 低于 2.31 | 从源码构建并安装 git 2.30.2：那条规则的 6 个测试、`ws-worktree-smoke.mjs` 9 例 | 那条规则（fsmonitor）在 2.30.2 上已排除；更早的版本没有测。返工时又从源码构建 2.30.2 和 2.34.1 跑了 session、server 两个包的整包测试：返工没有带来新的失败，但两个旧版本上各有用例失败（基准上就有），原因是旧 git 的行为差别，见「未覆盖和遗留」的「旧版 git」 | evidence/ws-worktree-smoke-git-2.30.2.txt；evidence/gate-c-1-rework.md 第 3 节 |
| 6，`runner.go:209`：全新的 tmux 环境、没有 tmux 程序 | 临时 daemon 经 REST 删除没有会话的 worktree，3 种环境 | 已排除 | evidence/final-run/ws-worktree-smoke.txt |
| 7，`runner.go:209`、`manager.go:130`：对账四条规则 | 经 REST 走三种状态，每例读回磁盘和 tmux；代码与 CLAUDE.md 逐句对过；旧提交的 daemon 上用例会失败 | **关口 C 第 1 轮推翻了一部分**：普通的三种状态成立（验证者的接口冒烟同样通过），但验证者另找到三条绕过四条规则的路——结束会话失败被吞（X10）、目录名里的换行和制表符让列表读错（X11）、socket 路径里的 `no sessions` 字样（X12）。三条都已修复，回归测试这一轮通过（见「关口 C 第 1 轮返工」）；修复后的规则还要第 2 轮的独立验证者再看 | 同上；verdict-history.md 的 P2–P4 |
| 8，`runner.go:51`：`TMUX_TMPDIR` 指向不存在的目录时 tmux 把 socket 放在哪 | 只读了 tmux 3.2a、3.0a 的源码 | **仍缺条件**：缺一个可以随意使用默认 tmux 目录的环境（容器）。源码显示 3.0a 不回退到 `/tmp`（报错退出），与 `tmuxSocketPath` 不一致，后果的方向是拒绝删除。下一步：容器里用 tmux 3.0、3.1、3.2 各跑一次 `TMUX_TMPDIR=/nonexistent tmux -L vibe-remote new-session -d`，并在文档里写明 `TMUX_TMPDIR` 必须指向存在的目录（升级步骤里已写） | evidence/pending-checks.md 第 8 条 |
| 9，`worktree.go:46`：百万级未合并提交 | `git fast-import` 造 100 万个提交，量 `rev-list --count` 和 status | 已排除（3.9 秒）；关口 C 第 1 轮验证者独立重做：100 万个提交 4.2 秒 | evidence/pending-checks.md 第 9 条 |
| 10，`worktree.go:47`：`git worktree remove` 到时限被杀 | 把时限改成 4 秒的临时构建加一个不返回的 git 包装 | 已排除；关口 C 第 1 轮验证者用 2 秒时限独立重做，同样排除 | evidence/pending-checks.md 第 10 条 |
| 11，`sidebar.ts:140`、`index.ts:99`：行菜单跟随重建、「正在删除…」的行 | 上一步：`X11.menu`、`X11.removing`（DOM 点击）。这一轮：用真实指针打开菜单再刷新 | 「正在删除…」已排除；**行菜单跟随重建复现出问题（X8），已修复**，原用例和新用例都通过 | evidence/X8.png、运行输出 |
| 12，`worktree-name.ts:19`：Electron 的 ICU 与 Go 的 Unicode 表 | 渲染进程和 Go 各跑全部码位 | 已排除（各拒绝 172 个，集合相同） | evidence/pending-checks.md 第 12 条 |
| 13，`projects.go:318`：没有归属也没有 `@vibe_remote_workdir` 的旧终端会话 | 手工起一个不带任何选项的 tmux 会话再启动 daemon，直接查状态并删除 | 已排除；关口 C 第 1 轮验证者独立重做，同样排除 | evidence/final-run/ws-worktree-smoke.txt |

## 修复记录

| 问题 | 提交 | 回归测试 | 复测 |
|------|------|----------|------|
| X2 双击已打开的会话不能改名 | `3f80670` | `test-sidebar › double_click_renames_a_session_that_is_open`；`gui-worktree-smoke › X2.rename` | 两个用例修复前失败、修复后通过；这一轮全量运行通过 |
| X8 行菜单在刷新后跳开 | `6bd5d5a` | `test-sidebar › menu_button_is_marked_expanded_while_its_menu_is_open`；`gui-worktree-smoke › X8.menu` | 同上；原有的 `X11.menu`、`X11.removing`、R2.3、R2.4、R5.x 通过 |
| X3 行菜单不能用键盘操作 | `dc55d84` | `test-sidebar › row_menu_from_the_keyboard`；`gui-worktree-smoke › X3.keys` | 同上 |
| X6 快捷键切换后行不在可见区 | `85a18cc` | `test-shortcuts › switching_reveals_the_row_via_index`；`gui-worktree-smoke › X6.scroll` | 同上；R7.1–R7.5 通过 |
| 计划里的 Go 测试缺失 | `246b437` | `TestProjectsSingleWorktreeRepo`（`submodule`、`separate_git_dir`、`legacy_worktree_mode`） | 通过；两处故意改坏的实现下失败 |
| X9 创建失败的撤销删掉别人在同一路径上建的 worktree（关口 C 第 1 轮 P1） | `f86be13` | `TestUndoLeavesAWorktreeSomeoneElseAddedAtTheSamePath`、`TestUndoAfterWorktreeAddFailedOnItsOwn`、`TestWorktreeAddKilledDuringCheckoutIsUndone` | 修复前 3 + 1 个子用例失败（对方的文件被删、分支被删），修复后通过；去掉 `c.added` 的变异下 4 个子用例失败；这一轮通过 |
| X10 结束会话失败仍删目录并报成已结束（P2） | `6282332` | `TestRemoveWorktreeStopsWhenASessionDidNotEnd`、`TestRemoveWorktreeConfirmsSessionsAgainstTmux` | 修复前 3 个用例失败（`err = <nil>`），修复后通过；去掉两个判断的变异下都失败；这一轮通过 |
| X11 目录名里的换行、制表符让 tmux 列表读错（P3） | `44c049d` | `TestSessionWhoseProcessIsInAnOddlyNamedDirectoryIsStillRead`、`TestSessionCreatedInAnOddlyNamedDirectoryIsStillRead`、`TestTmuxReadFailsWhenARecordDoesNotParse`、`TestParseTmuxSessionLine*` | 修复前 12 个子用例失败，修复后通过；两种变异（解析失败改成跳过、标记改回制表符）下失败；这一轮通过 |
| X12 socket 路径里的 `no sessions` 被当成没有会话（P4） | `465945a` | `TestIsNoTmuxServerGoesByTheWholeLine`、`TestSocketPathSayingNoSessionsIsNotAnEmptySet` | 修复前失败，修复后通过；「整行等于」改回「包含」的变异下失败；这一轮通过 |
| X13 结束会话之后不复核分支（P5） | `f94ea31` | `TestRemoveBranchSwitchedWhileEndingSessions` | 修复前 2 个子用例失败（`err = <nil>`），修复后通过；去掉分支和 detached 的复核后失败；这一轮通过 |
| X14 路径带换行的 worktree 列不出来（P6） | `771dcc6` | `TestListWorktreesPathWithNewline`、`TestListWorktreesFallsBackWithoutZ`、`TestParseWorktreeList` | 修复前 3 个带换行的子用例和退回用例失败，修复后通过；4 种变异各有用例失败；这一轮通过（git 2.50.1） |
| X15 预检端点把不存在的目录报成不在允许范围内（P7） | `694e3f5` | `TestPlanMissingWorkdirIs400` | 修复前失败（403），修复后通过；去掉「落在白名单之内」的判断后白名单外的路径变成 400，用例失败；这一轮通过 |
| T28 两个测试的跳过条件（验证结论的两条备注；不改产品行为） | `3c9cff8` | `TestGitTimeoutKillsProcess`、`TestGitEnvKeepsInheritedConfig` | 改之前 8 次运行 8 次 SKIP，改之后 `-race -count=3` 没有 SKIP；SIGKILL 换成信号 0 的变异下失败；这一轮两个都是 PASS、没有 SKIP |
| T29 旧版 git 的退回模式下带换行的路径被读成另一项（关口 C 第 2 轮 N-1，d71） | `7f4d4e1`、`bbc2e9b` | `TestFallbackListNeverInventsAWorktree`、`TestFallbackListFailsWhenTheMainDirectoryCannotBeRead`、`TestParseWorktreeListByLine` | 修复前 15 个子用例失败 13 个、3 个全失败、25 个全失败；修复后通过；6 种变异各有用例失败；真的 git 2.34.1 上通过；这一轮通过 |
| T30 post-checkout 钩子失败时留下 worktree（N-2，c8） | `72456fe` | `TestCreateFailedByPostCheckoutHookLeavesNothing`、`TestUndoLeavesAWorktreeSomeoneElseAddedWhileTheAddRan`、`gui-worktree-smoke › R3.8.hook` | 修复前 3 + 2 个子用例失败、GUI 用例对着修复前的 daemon 失败；修复后通过；4 种变异各有用例失败；X9 的三个反例原样通过；这一轮通过 |
| T31（X1）后台终端会话在重绘时亮「有新消息」（c7） | `525ab9f` | `test-terminal-activity`（11 例）、`gui-worktree-smoke › X1.redraw` | 修复前真实应用的用例失败；旧规则下单元测试失败；修复后通过；8 种变异各有用例失败；这一轮通过 |
| T34 侧边栏内容没变也整体重建，吞掉点击和双击（c10 的裁决） | `15a37b2` | `test-sidebar-refresh`（17 例）、`gui-worktree-smoke › T34.quiet`；`test-sidebar-rename` 的焦点用例（`5fc55e1`） | 修复前单元用例失败、真实应用两轮轮询 120 次改动、20 次单击丢 16 次、10 次双击丢 7 次；修复后 0 / 0 / 0；15 种单元变异 14 种各有用例失败、1 种被另一项盖住，真实应用 1 种变异失败；这一轮 5 次完整运行每次通过 |

第 1 轮（X2、X3、X6、X8）四个修复前的失败输出在 `evidence/exploration-findings.md`，都只动桌面端的 `sidebar.ts`、`menu.ts`、`styles.css`、`index.ts`（一行）和测试，没有涉及删除、撤销、信任规则、协议这些关键路径。X3 的修复把「菜单项的动作」和「关闭菜单」的先后对调了（先关再执行），「删除 worktree」「从侧边栏移除」的入口因此经过了改动，这两条路径的用例（R2.3、R2.4、R5.1–R5.12、`X11.*`、`X3.keys`、`X8.menu`）这一轮全部通过。

关口 C 第 1 轮返工（X9–X15）改的正是关键路径：创建失败的撤销、删除 worktree 时对会话和分支的复核、读 tmux 和 worktree 列表的方式。修复前的失败输出、变异核对和旧版 git 上的实测在 tasks.md「进度」的 T21–T28 各行和 `evidence/gate-c-1-rework.md`，是开发（返工）阶段做的，这一轮没有重做，只做了复测。两轮都没有撤回过修复。

关口 C 放行后的返工（T29–T31）里，T29 和 T30 仍在关键路径上（读 worktree 列表的方式关系到对话界面的信任规则；创建失败的撤销会执行 `git worktree remove --force --force`）。T30 把第 1 轮返工收紧的认领规则放宽了一种情况，X9 的三个反例原样通过、另加了 5 个「不该认领」的子用例守着。T31 动的是桌面端终端数据的写入路径：字节照旧原样写入，只是在后台、没有点的会话上多了写入前后各一次屏幕文字的读取。修复前的失败输出、变异核对在 tasks.md「进度」的 T29–T32 各行和 `evidence/gate-c-3-rework.md`，是开发方自己做的，没有经过独立评审。

T34 只动桌面端 `index.ts` 的 `renderSidebar()` 一处（加上指纹函数约 60 行）和测试，没有涉及删除、撤销、信任规则、协议这些关键路径。它的风险在另一头：指纹漏掉一样渲染读到的状态，界面就会停在旧的样子；`test-sidebar-refresh` 每种变化一条断言守着，变异核对见上。修复前的失败输出和变异核对是开发方自己做的，没有经过独立评审。

## 未覆盖和遗留

- **c10–c13 裁决之后的返工（第 5 轮）新增的遗留**：
  - **T34 之后的代码没有做独立验证，也没有做独立代码评审**（约束是不派子 agent）。`15a37b2`（修复）、`5fc55e1`（焦点用例）、`1a99f46`（规则文件）都只有作者自己看过；合并提交 `c28c001` 之后的全部提交同样。
  - **规则文件是按协调者转达的用户授权改的，请用户在 PR 里看**：`CLAUDE.md` 两处（「GUI 回归」一段末尾的 `CLAUDE_CONFIG_DIR`；「侧边栏是三层树」一段里「什么时候重建」和「改名与键盘」）、`.devflow.yml` 第 4 条 check 加一个用例名、`.claude/skills/verify/SKILL.md`（`NOTE` 的含义、用例数 72、`T34.quiet`、「没有变化的刷新不重建」）。
  - **内容确实在变的那一瞬间的重建仍会吞点击**。实测到的是「改名时点另一个会话」：本机上 10 次里 8 次没有切换（名字都保存了，再点一次即可）。刚建完会话、某个会话的状态点正好在变的那一瞬间同理，没有专门测。
  - **机器概览页每个应答重画一次**（每 5 秒 2 次），按钮有 T34 之前侧边栏的同一种问题，没有修，没有测有没有真的丢点击（decisions d83，请协调者决定）。
  - **两个偶发仍然没有查到原因**：`X7-send`（18 次没有出现）、`M.X7`（26 次没有出现）。`M.X7` 怀疑过的那条路径已排除并有用例守着。
  - **`TestRemoveGitFailureKeepsState` 在机器负载高时失败过 1 次**（daemon 的 5 秒 git 时限），新列入偶发清单。这一轮的全部运行都是在 load average 17–38 的机器上做的。
  - `T34.quiet` 的「轮询进行期间」是脚本每 150 ms 调一次应用自己的轮询函数，比真实的 5 秒密得多；它保证的是「没有变化的应答不打断点击」。
  - 指纹不含对话会话的 `activitySeq` / `epoch` / `state`（d81）：以后有人让行上的处理函数读它们时要放回去。
  - `/protocol-sync` 没有重做（这一轮没有改协议涉及的文件）；探索式检查没有重做；这一轮没有存新的截图（`evidence/t34/` 下都是文本），「交付预览」仍是第 1 轮的截图。
  - 下面第 4 轮那一段里的三条已被这一轮取代：「等用户裁决：c10、c11、c12」（已裁决）、「`CLAUDE.md`、`.devflow.yml` 我没有改」（已按裁决加）、「侧边栏重建吞点击……没有修」（内容没变的那部分已修）。
- **合并对话模式返工之后（第 4 轮）新增的遗留**：
  - **合并后的代码没有做独立验证，也没有做独立代码评审**（这次工作的约束是不派子 agent）。合并提交 `c28c001` 之后的代码 / 测试提交（`0734e1a`、`9fa11a7`、`847dd80`、`41bc280`、`db90678`、`4c1e78c`）都只有作者自己看过。
  - **等用户裁决**：c10（双击被吞时重做）、c11（R8.3 的基准）、c12（终端会话删除确认的那条断言换了内容）。
  - **`CLAUDE.md`、`.devflow.yml` 我没有改**（c13）：合并后逐句对照代码没有发现变成错的句子；缺的两段说明和一条 check 的建议在 tasks.md「后续」，等用户决定。`.claude/skills/verify/SKILL.md` 改了三处，列在 c13 里。
  - **两个没有复现出来的失败**：`gui-chat-smoke.mjs` 的 `X7-send`、`gui-worktree-smoke.mjs` 的 `M.X7`，各 1 次，原因没有查清，现在都会在失败时打印现场。
  - **侧边栏重建吞点击在三层侧边栏上更容易碰到**，没有修（见「合并 change/dual-mode」一节和 tasks.md「后续」）。
  - `/protocol-sync` 没有做完整的手工核对，只核对了合并带来的三处和 `chat_ack`。
  - 探索式检查没有重做：这一轮只对三条已知问题各实测了一次。
  - 「交付预览」的截图仍是第 1 轮的；这一轮新存的截图只有 `evidence/merge-dual-mode/` 下的 11 张。`evidence/R*.png` 仍是此前各轮的。
  - 这一轮在发现 #164 之前的运行里，测试用的临时 daemon 和 Go 测试读过本机真实的 `~/.claude.json`（只读、只看 `hasTrustDialogAccepted`；按代码推断，没有读 `~/.claude/projects`）。最终一轮没有。
  - 本节以下各条是第 3 轮写的，其中「这一轮」指第 3 轮。

- **没有真实的 claude 和远程 Linux 上的验证**。所有运行都在本机：临时 daemon、`/bin/bash`、假 claude、git 2.50.1、tmux 3.6a、macOS 文件系统。真实 claude 的 stream-json 和信任文件、Linux 上的 tmux 和 git 版本、经 Tailscale 的延迟都没有覆盖。
- **没有真机上的原生通知**。未签名构建不显示原生通知（走 Dock 降级），断言的是应用发出的通知标题；点击原生通知打开会话只有模拟的点击。
- **真实键盘待人工确认**（待验证项 4）。步骤：`cd desktop && npm run build -- --dir`，打开 `release/mac-*/vibe-remote.app`，连一台有 5 个以上会话的机器，然后：
  1. 焦点在终端里：按 ⌘3 → 切到侧边栏从上往下第 3 个会话；⌘⇧] / ⌘⇧[ → 下一个 / 上一个，到头循环；终端里没有多出字符。
  2. 焦点在对话输入框里（先打几个字）：按 ⌘⇧]、⌘1 → 会话切换；切回来草稿还在，没有多出 `}` 或 `1`。
  3. 会话数少于 9 时按 ⌘9 → 不动；折叠一个项目后按 ⌘⇧] 转一圈 → 不停在其中的会话上。
  4. 打开新建会话对话框、删除确认框各一次，按 ⌘2、⌘⇧] → 不切换。
  5. 换成中文输入法（拼音）再做第 1、2 步 → 结果相同，候选窗不弹出。
  6. 看菜单栏：这些键没有触发系统或应用菜单里的任何一项。
  7. Tab 到某个 worktree 行的「⋯」，回车、回车 → 出现删除确认框；Esc 关闭后焦点回到「⋯」。会话多到要滚动时按 ⌘⇧[ → 侧边栏滚到被选中的那一行。
- **冷启动首帧只证明到首次绘制**：窗口创建后的原生底色和第一次绘制完成的整帧都是新主题；两者之间约 0.1 秒屏幕上实际合成的画面没有取到（要录屏）。
- **真正的旧版桌面端没有运行过**：R5.10 / R9.2 是按协议 3 的帧直接发、并运行基准提交的 `ws-smoke.mjs`，没有启动基准提交的桌面端（关口 C 第 1 轮界面验证者同样指出）。
- **旧版 git**。这一轮的全量运行全部在 git 2.50.1 上；返工途中 T29、T30 在从源码构建的真 git 2.34.1 上跑过（列表、信任、撤销相关的用例 139 行 PASS、0 FAIL；session、server 两个包整包运行 658 行 PASS、2 个失败，都是基准上就有的：`TestRemoveWorktreeWhenTmuxIsNotInstalled` 和偶发的 `TestProjectStoreRemoveWorktreeIfSame`；`evidence/gate-c-3-rework.md` 1.4 和第 4 节）。2.30.2 这次没有重跑（已写明不支持）。已知的差别，记在 tasks.md「后续」：
  - **支持的 git 版本已经写明**（T32，用户确认）：推荐 2.36 及以上；2.31–2.35 可用，路径带换行的 worktree 不会列出；低于 2.31 不支持。写在 README.md、README.zh-CN.md、CLAUDE.md 和 design「升级步骤」。daemon 不检查版本、不拦截（d76）。实测过的只有 2.50.1（全过）、2.34.1 和 2.30.2；2.31–2.33、2.35 和更早的（Ubuntu 20.04 是 2.25）没有测。
  - git 低于 2.36 时，`-c core.fsmonitor=false` 的 `false` 被 git 当成一个要运行的程序名。`PATH` 里有 `false`（通常是 `/usr/bin/false`）时无害；找不到时 git 的报错（`error: cannot run false: No such file or directory`）混进输出，被算成未提交文件——方向是多报不少报（多要一次同意，不会少报而丢文件）。`TestRemoveWorktreeWhenTmuxIsNotInstalled` 在两个旧版本上因此失败（用例把 `PATH` 缩到只剩 git）。
  - git 2.30 的 `worktree list --porcelain` 不输出 `locked` 和 `prunable`：被 `git worktree lock` 锁定的 worktree **不会在结束会话之前被拦下**——会话先被结束，git 再拒绝删除，响应如实带 `endedSessions`，目录和分支不丢；这与 spec R5.9「开始删除之前就能发现的失败」在这个版本上不符。目录不见了的 worktree 也认不成 `prunable`。2.30.2 上因此失败的用例：`TestListWorktrees`、`TestRemoveLockedRefusedBeforeEndingSessions`、`TestRemoveRefusedWhenNestedWorktree/prunable`、`TestWorktreeRemoveEndpoint/locked`、`TestChatTrust` 的 3 个子用例（后者另有测试自己用了 2.31 才有的 `rev-parse --path-format=absolute`）。（2.30 现在属于写明不支持的范围。）
  - git 低于 2.36 没有 `worktree list -z`，daemon 退回按行读，这时**路径里有换行的 worktree 不列出**，也就不能在界面里打开和删除（制表符、引号、反斜线不受影响）。T29 之后它被拆出来的任何一段都不会被当成 worktree（验证结论 N-1 的反例不再成立）；代价是被拆出来的一段恰好是另一个真 worktree 的路径时那个也不列出，主目录路径带换行的仓库读不了。对应的 5 个子用例（断言带换行的路径列得出来）在旧版本上仍然跳过。
- **与效果页（M1）的已记录外观差异**。关口 C 第 1 轮的界面验证者说没有找到这份清单（N5）；此前它散在 tasks.md「后续」、design.md 第 10 节和 decisions 里，汇总如下。都是外观，都没有改，功能和 spec 的「那么」不受影响：

  | # | 位置 | 效果页 | 实际 | 记录在 |
  |---|------|--------|------|--------|
  | 1 | 终端会话的卡片底部 | 一行状态：「机器 · 工作目录」和「终端 · tmux 保活」 | 没有这一行（对话会话底部有机器和路径） | 后续（T19）；验证者 N5 (2) |
  | 2 | 对话里的工具行 | 左侧是按工具类型的图标；增删行数分色 | 左侧是运行 / 完成 / 失败的状态点；增删行数不分色 | 后续（T19）；decisions d41 (10) |
  | 3 | 标题 | 分支和会话名之间是「/」 | 是「·」 | 后续（T19） |
  | 4 | 权限卡片的「Esc 中断」 | 在标题右侧 | 在卡片底部 | 后续（T19） |
  | 5 | 新建 worktree 的名字输入框 | 框里有分支图标 | 没有 | 后续（T19） |
  | 6 | 删除 worktree 确认框里的会话 | 列出每个会话的名字和类型 | 只写「会先结束这 N 个会话」 | 后续；验证者 N5 (1) |
  | 7 | 不在任何分支上的 worktree 行 | 提交图标 | 分支图标 | 后续（第 1 轮探索） |
  | 8 | 会话行第一行 | 有相对时间（「3 分钟前」） | 没有（协议里没有最近活动时间） | decisions d10；后续 |
  | 9 | 删除失败的说明 | 中文句子，另有「什么都没改动：…」一行和「现在的状态」小表 | daemon 的英文原因原样显示；删到一半的那种另有一段中文说明 | 验证者 N2；后续 |
  | 10 | 仓库目录不存在的项目行 | 「读取失败」加原因 | 「仓库目录不存在」（其它 git 失败才是「读取失败：<原因>」） | 验证者 N4；design 7.4 的文案表 |
  | 11 | 项目行两字母标签的文字 | 亮度 32% | 30%（32% 时对比度最低 4.15，不到 4.5） | design V17、decisions #26（有意的） |
  | 12 | 机器行 | 显示器形状的图标；离线的机器不显示会话数 | 另一种图标（不是显示器）；离线的机器显示「0」 | **此前没有文字记录**，这一轮从并排截图 `evidence/m1-terminal.png` 上看到 |

  另有一处不是差异而是没核对：红绿灯的位置改成了 (18, 19)，CDP 截图里看不到原生窗口控件，要在打包后的 app 里看一眼。效果页没画到、按 M1 的同一套语言自己定的画面见 decisions d41。
- **关口 C 第 1 轮界面验证者的 7 条备注（N1–N7）** 都不拦，都没有改，记在 tasks.md「后续」：N1 新建会话后侧边栏不滚到新行；N2 删除失败的原因是英文；N3 英文界面「Terminal · New messages」被截断；N4 仓库目录不存在时没有「读取失败」几个字；N5 与效果页的两处外观差别（上表第 1、6 行）；N6 失败说明框开着时背后还是刚被结束的会话；N7 「保留分支」之后界面里接不回去。
- **`TMUX_TMPDIR` 指向不存在的目录时旧版 tmux 的行为**没有实跑（待验证项 8）。
- **c6**：`TestGitEnvKeepsInheritedConfig` 里依赖 `GIT_CONFIG_COUNT` 的子用例在 git 不读这个环境变量（低于 2.31）时跳过。**用户决定保留**（decisions #153）。跳过条件是 T28 收紧过的：只有探测命令成功运行且结果表明 git 不读这个环境变量才跳过，探测失败算测试失败；本机 2.50.1 和 2.34.1 上都不跳过。
- **c7（已处理，T31）**：X1。用户确认改点亮规则，已改并有回归测试。新规则留下的：只在 tmux 3.6a 上看过重绘的字节（逐行原地重写、不先清屏）；别的版本的 tmux 如果先清屏再重画，重绘被切成几帧时点会误亮（等于改之前的行为，不会漏报）；只变颜色不变文字的输出不点亮（d74、d75，记在「后续」）。
- 第 1 轮探索没有修、记入 tasks.md「后续」的：X4、X5、X7，「对话」卡片在信任结果回来之前的文案，daemon 重启后机器状态多停一个退避周期（实测 8.9 秒），目录选择器里用键盘进入子目录后的焦点。第 1 轮返工留下、同样记在「后续」的：单独删会话不确认 tmux 里的会话是否真的结束（d68）。post-checkout 钩子失败留下 worktree（d70）已由 T30 改掉，剩下的一种是钩子自己以 128 退出时仍会留下（d73）。
- **已知的偶发失败**（清单见「汇总」下方）这一轮的全量运行里一次都没有出现，没有重跑；它们的原因仍然没有查清，记录在 tasks.md「后续」。
- `/protocol-sync` 这一轮只确认了返工没有改协议涉及的任何文件（与第 2 轮验证者核对过的提交逐字节相同），错误码等开放集合没有重新逐项核对。
- 第 1 轮返工的 8 个提交和这次返工的 5 个代码提交都没有做独立代码评审（前者由第 2 轮验证者看过，后者等下一轮验证者）。
- 「交付预览」是截图，没有录屏；截图是第 1 轮的，这一轮没有重录。
- 这一轮 `gui-worktree-smoke.mjs` 的截图只存了新加的两张（`evidence/R3.8.hook.png`、`evidence/X1.redraw.png`）；其余 `evidence/R*.png` 仍是第 1 轮 `5d8878c` 上的（各场景的画面没有变）。`evidence/X1.png` 是修复前的画面。
- 独立验证（dev-test 第 8 步，机器关口 C）：第 1 轮不通过；第 2 轮通过，有备注（N-1–N-5），用户放行并要求先改四处；**返工后的第 3 轮还没有做**，由主会话安排。第 2 轮的 N-3（`TMUX_TMPDIR` 的目录名里有换行）、N-4（daemon 继承了非 UTF-8 的 locale）、N-5（预检对「路径中间是一个文件」回答 403）不在用户要改的四处里，没有改，记在 tasks.md「后续」。
- **T31 的耗时是在 Node 和 Electron 的 Node 模式下量的**（同一份 xterm、Electron 自己的 V8），不是在渲染进程里量的：一次比较 80×24 中位数 33–117 µs、200×60 中位数 104–411 µs（`evidence/gate-c-3-rework.md` 3.3）。渲染进程里没有可以从外面拿到的终端对象，没有在那里计时。

## 验收核对

| 方面 | 结论 | 依据 |
|------|------|------|
| 完整 | 成立 | tasks.md 里 34 个任务（T1–T20，含 T6a / T6b / T6c；第 1 轮返工 T21–T28；关口 C 放行后的返工 T29–T32）的状态都是「完成」（T16 注明真实键盘待人工确认），没有「阻塞」，「进度」里各有完成记录；R1–R9 的 58 个场景每个都有单元 / 集成测试（R8.3 除外，它本身就是运行两份冒烟）和真实应用里的用例，这一轮 58 个场景编号都在 `gui-worktree-smoke.mjs` 的输出里有 PASS 行；关口 C 第 1 轮的 7 个问题和这次改的四处各有回归测试（T32 只改文档），这一轮通过 |
| 正确 | 成立 | `make check`、六份冒烟、18 条命令型规则在 `bbc2e9b` 的代码上全过，Go 全套 0 个 SKIP。R3.8 在 post-checkout 钩子失败这一种上现在也成立（T30；钩子以 128 退出的那一种除外）。spec 的文案第 2 轮在 `desktop/src/renderer` 里逐条查到：R3.4「分支 … 已存在」、R3.5「目录已存在」、R3.10「目录不在允许的范围内」、R3.6「不包含未提交的改动」；R5.1「目录和分支都会保留」、R5.3「个文件未提交或未跟踪」+「仍然删除」、R5.4「被 git 忽略的文件会一并删除」、R5.5「只删目录、保留分支」/「目录和分支都删」、R5.8「不是由 vibe-remote 创建」、R5.11「删除后不再属于任何分支」；R6.1「终端界面可能无法启动」（这些句子所在的文件这次返工没有动；第 1 轮在运行中的对话框里读到过，关口 C 的界面验证者也逐个看过）。数值：性能 `/api/v1/sessions` 的用例这一轮通过（上限 200 ms）；名字上限 250 字节、目录命名、最小窗口 800×500 由共用向量和布局用例守着，这一轮通过。**不符合 spec 字面的两处**（都已记录、都不是这一轮新出现的）：R2.7 仓库目录不存在时写的是「仓库目录不存在」而不是「读取失败」（N4）；git 2.30 上被锁定的 worktree 不在结束会话之前被拦下（R5.9，见「旧版 git」） |
| 一致 | 成立 | 开发阶段的调整在 design.md 第 10 节和 decisions.md 里；第 1 轮的四个修复在第 10 节「测试阶段的修复」和 decisions #134、#135、d66、d67；返工的七个修复在第 10 节「关口 C 第 1 轮返工」和 decisions #140–#151、d68–d70，`CLAUDE.md`、`.devflow.yml`（第 13、15、18 条规则的文字和 check）、`docs/protocol.md` 三行随之改了，`.devflow.yml` 里新加进 check 的用例名都存在并在这一轮运行（第 13、15、18、19 条 exit 0）；这次返工的四处在第 10 节「关口 C 放行后的返工」和 decisions #153–#158、d72–d76，`CLAUDE.md`（列表读取、撤销、点亮规则、前置条件四处）、`.devflow.yml`（第 17、18 条规则的文字和 check）、README 两份、verify skill 的用例数随之改了；T31 改的点亮规则在本需求的 spec 里没有对应场景，依据是 spec「问答记录」2026-11-20 的用户确认 |
| 干净 | 成立 | 提交后 `git status --short` 为空；`git diff bbc2e9b..HEAD` 只有 `docs/changes/` 下的文件，代码和测试没有动；这次返工新增的产品代码行（`worktree.go`、`desktop/src/renderer/`）里没有 `console.log`、`debugger`、`fmt.Print`、TODO / FIXME（这一轮 grep，0 处）；`.devflow-tmp/` 不在仓库里。全量运行前后 `git status` 里没有出现 `docs/changes/` 之外的改动（没有脚本改了不该改的文件）。量耗时的脚本和 tmux 捕获脚本没有留在 `desktop/scripts/` 里（前者的源码存在 `evidence/gate-c-3-bench-screen-text.mjs.txt`） |
| 改全 | 成立 | 这次返工没有新增配置项、没有改协议（`git diff b77fcd1..HEAD` 里没有 `vibe-remoted.example.json`、`internal/config`、`internal/protocol`、`desktop/src/shared`、`docs/protocol.md`）。升级步骤在 design.md 第 10 节，第 3 步改成了用户确认的支持范围（T32）；没有新的升级动作：桌面端和 daemon 各自替换即可，T31 只在桌面端、T29 / T30 只在 daemon。没有停用的功能要清。19 条不变规则：18 条命令 exit 0，第 2 条（skill）这一轮确认了没有协议改动，见「汇总」下的说明 |
| 合并（第 4 轮） | 成立，有等裁决的三项 | 两边的测试都在：数量不少于合并前两边各自的数量（「汇总」的对照）；对话模式的两份 GUI 脚本相对 `64e8b5e` 没有少一行断言；`docs/changes/2026-11-13-dual-mode/` 与对话模式的分支逐字节相同；T33 标完成；c10、c11、c12 改动了检查，等用户裁决；合并后的代码没有独立验证。本表以上各行是第 3 轮（`bbc2e9b`）写的，没有重写 |
| T34（第 5 轮） | 成立 | tasks.md 里 T33、T34 都是「完成」（共 36 个任务），没有「阻塞」；c10–c13 四项都有裁决并已落实（decisions #168–#171、#176、#177）；`make check`（重跑后）、GUI 冒烟 12 次、接口冒烟 3 次、18 条命令型规则在 `b6dea2c` 上通过，用例数量不少于 `7b295b0`；没有改动任何已有断言，重做和「等安静」已撤；`git status --short` 为空，`docs/changes/2026-11-13-dual-mode/` 与对话模式的分支逐字节相同；这一轮新增的产品代码（`index.ts` 约 70 行）里没有 `console.log`、`debugger`、TODO。没有改协议、没有新配置项、没有升级动作（只换桌面端）。T34 之后的代码没有独立验证。本表以上各行是此前各轮写的，没有重写 |
