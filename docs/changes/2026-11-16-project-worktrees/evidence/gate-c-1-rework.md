# 关口 C 第 1 轮返工：实验和修复前后的输出

评审对象 `91e0fab`，验证结论的 P1–P7 编号为 X9–X15。环境：macOS（darwin/arm64）、Go 1.26.2、git 2.50.1、tmux 3.6a；所有 tmux 都在独立的 `TMUX_TMPDIR` 下，仓库都在 `t.TempDir()` 或 `/tmp` 下。

## 1. X11：按行解析、当前目录放最后一列，挡不住别的列里的制表符

把「13 列 + `pane_current_path` 在最后、`strings.SplitN(line, "\t", 14)`」套在一个开在 `…/devflow-worktrees/tab<TAB>wrap` 这个 worktree 里的会话上（`home`、`@vibe_remote_workdir`、当前目录三列都是这个路径）：

```text
columns=14
home="/x/devflow-worktrees/tab" (want "/x/devflow-worktrees/tab\twrap")
created="wrap"
sessionCreated="2026-11-20T04:00:00Z"
startDir="1795000000" (want "/x/devflow-worktrees/tab\twrap")
pane="/x/devflow-worktrees/tab\twrap\t/x/devflow-worktrees/tab\twrap"
```

列数对得上，内容错位：`home` 不在这个 worktree 里，创建目录是一串数字。daemon 重启后这个会话不算在它的 worktree 里，删除 worktree 会漏掉它。所以改用每次读取现造的随机标记分隔字段和记录（decisions d69）。

修复前的代码在真实 tmux 上（`TestSessionWhoseProcessIsInAnOddlyNamedDirectoryIsStillRead`、`TestSessionCreatedInAnOddlyNamedDirectoryIsStillRead`，12 个子用例全部失败）：

```text
newline/same_daemon:      liveTmuxSessions() = map[], true; want the one session, read
tab/same_daemon:          session read as {workdir:…/002/tab name:wrap mode: sourceWorkdir:normal …}
tab_then_slash/…:         session read as {workdir:…/002/a name:/b mode: sourceWorkdir:normal …}
created in …/tab<TAB>wrap: session in the worktree read as {workdir:…/devflow-worktrees/tab name:wrap mode: sourceWorkdir:normal …}
```

## 2. X10：杀掉最后一个会话之后，tmux 有一瞬间既不给列表也不说「没有 server」

结束会话之后立刻再读一次 tmux 的第一版实现，在「socket 恢复后再删一次」这一步失败：

```text
tmux list-sessions failed: exit status 1 (stderr="server exited unexpectedly\n")
RemoveWorktree after the socket came back: could not end session …: tmux could not be read after it was asked to end the session
```

tmux server 失去最后一个会话后正在退出，这时连上去的 `list-sessions` 得到 `server exited unexpectedly`；100 ms 后再读是 `no server running on …`（第 ② 条，空集合）。所以确认用的读取失败时再试，共 3 次、间隔 100 ms；socket 文件真的不见了时三次都失败，结论不变。改后同一组用例 `-count=3` 通过。

## 3. X14：旧版 git 上的实测

在自己的临时目录里从源码构建了两个 git（`make NO_GETTEXT=1 NO_OPENSSL=1 NO_CURL=1 NO_EXPAT=1 NO_TCLTK=1 NO_PERL=1 NO_PYTHON=1`，不安装，用源码目录里的 `bin-wrappers/git`，放在 `PATH` 最前面）：2.30.2（Debian 11）和 2.34.1（Ubuntu 22.04）。两个都不认 `-z`：

```text
$ git --version; git worktree list --porcelain -z; echo "exit=$?"
git version 2.30.2
error: unknown switch `z'
usage: git worktree add [<options>] <path> [<commit-ish>]
…
exit=129
$ git --version; git worktree list --porcelain -z >/dev/null 2>&1; echo "exit=$?"
git version 2.34.1
exit=129
```

本机的 2.50.1（`-z` 的格式：属性以 NUL 结尾，条目之间多一个 NUL）：

```text
worktree /private/tmp/…/r|HEAD 429bb9eb…|branch refs/heads/master||
```

整包测试 `go test -count=1 -timeout 20m -v ./internal/session ./internal/server`，分别在返工后的代码和基准 `91e0fab`（`git archive` 导出到临时目录）上跑：

| git | 代码 | 结果 |
|-----|------|------|
| 2.34.1 | 返工后 | session 包 1 个失败、server 包 `ok`；613 个 PASS；跳过 8 个 |
| 2.34.1 | `91e0fab` | session 包同一个失败、server 包 `ok`；573 个 PASS；跳过 4 个 |
| 2.30.2 | 返工后 | 失败的用例与下一行完全相同（`diff` 无输出）；599 个 PASS；跳过 11 个 |
| 2.30.2 | `91e0fab` | `TestChatTrust`（3 个子用例）、`TestListWorktrees`、`TestRemoveLockedRefusedBeforeEndingSessions`、`TestRemoveRefusedWhenNestedWorktree/prunable`、`TestWorktreeRemoveEndpoint/locked`、`TestRemoveWorktreeWhenTmuxIsNotInstalled`、`TestProjectStoreRemoveWorktreeIfSame`（已知偶发） |

- 退回模式的用例在两个旧 git 上都通过：`TestListWorktreesFallsBackWithoutZ`、`TestParseWorktreeList`、`TestListWorktreesPathWithNewline` 的 `tab` / `quote` / `backslash` 三个子用例、`TestSessionCreatedInAnOddlyNamedDirectoryIsStillRead` 的 `tab` / `trailing_tab` / `tab_then_slash`，以及全部用到 worktree 列表的原有用例（`TestProjects*`、`TestCreate*`、`TestUndo*`、`TestRemove*` 中不依赖下面两点的）。
- 新增的跳过只有「路径里有换行」的 5 个子用例（`TestListWorktreesPathWithNewline/newline`、`/newline_at_end`、`/nul_like`，`TestSessionCreatedInAnOddlyNamedDirectoryIsStillRead/newline`、`/newline_and_tab`）：探测命令 `git worktree list --porcelain -z` 以 129 退出才跳过。这就是退回模式的已知限制。其余跳过（`unborn` 三个、2.30.2 上的 `GIT_CONFIG_COUNT` 和 `prunable` 两个）基准上就有；`TestGitTimeoutKillsProcess` 在基准上是 SKIP，返工后（T28）是 PASS。
- 两个旧 git 上都失败的 `TestRemoveWorktreeWhenTmuxIsNotInstalled` 不是这次改动引入的（基准上同样失败）：这个用例把 `PATH` 缩成只有 git，而 2.36 之前的 git 把 `-c core.fsmonitor=false` 的 `false` 当成一个要运行的程序，找不到就往 stderr 写 `error: cannot run false: No such file or directory`；`gitWithin` 用的是 `CombinedOutput`，这两行被 `git status --porcelain` 的行数统计算成了 2 个未提交文件，删除因此是 409。正常的 `PATH` 里有 `/usr/bin/false`，没有这两行。记在 tasks.md「后续」。
- 只在 2.30.2 上失败的那几个，原因是 2.31 之前的 `git worktree list --porcelain` 不输出 `locked` 和 `prunable`（`TestListWorktrees` 的输出：`detached=3 locked=0 prunable=0`），以及测试自己用了 2.31 才有的 `rev-parse --path-format=absolute`。同样是基准上就有的。后果记在 tasks.md「后续」：2.31 之前的 git 上，被锁定的 worktree 不会在结束会话之前被拦下。

返工途中在 2.30.2 上多出来、已经处理掉的三个失败（decisions #146、#149）：`TestProjectsOneGitCallPerProject`（`Projects() ran 28 git processes, want 20`：8 路并发各自探测了一次 `-z`，改成每个 git 只问一次）、`TestListWorktreesFallsBackWithoutZ`（用例要求 `prunable`，2.30.2 不输出）、`TestWorktreeRemoveEndpoint/changed_after_sessions_ended`（触发点数的是 `worktree list` 的调用次数，旧 git 上第一次读取是两次调用）。

## 4. T28：`TestGitTimeoutKillsProcess` 为什么每次都跳过

刚写出来的脚本，第一次执行到第一行要多久（本机，三轮，每轮一个新脚本连续执行三次）：

```text
round 0 exec 0: 390ms   round 0 exec 1: 17ms   round 0 exec 2: 6ms
round 1 exec 0: 406ms   round 1 exec 1: 8ms    round 1 exec 2: 7ms
round 2 exec 0: 697ms   round 2 exec 1: 6ms    round 2 exec 2: 7ms
```

用例的时限是 50 ms，假 git 是用例刚写出来的脚本：时限总是在脚本写出 pid 之前到。原用例 `-count=8`：8 次 SKIP。改成先把假 git 运行一次之后，`-race -count=5`：5 次 PASS，没有 SKIP。

## 5. 全部修完之后的一轮（代码在 `3c9cff8`）

环境同上（git 2.50.1、tmux 3.6a）；每条命令各带一个独立的 `TMUX_TMPDIR`，临时 daemon 的 `allowed_roots` 只有自己在 `/tmp` 下建的目录。

| 检查 | 结果 |
|------|------|
| `TMUX_TMPDIR=<临时目录> make check` | 退出码 0。Go：`internal/chat` 17 s、`config`、`protocol`、`server` 66 s、`session` 319 s 五行 `ok`（`-race -count=1`）；桌面端 `tsc --noEmit` 通过，`npm test` 311 行 `ok`、没有 `not ok` |
| `ws-smoke.mjs`（自己起的临时 daemon：随机端口、`/bin/bash`、独立的 `state_dir` 和 tmux 目录） | 退出码 0，12 PASS、0 FAIL |
| `ws-chat-smoke.mjs` | 退出码 0，9 PASS、0 FAIL |
| `ws-worktree-smoke.mjs` | 退出码 0，9 PASS、0 FAIL |
| `.devflow.yml` 的 18 条命令型规则（第 1、3–19 条），原样交给 zsh | 18 条都是退出码 0（其中第 4 条的 chat 部分和第 6、7、8、13、18、19 条有 `(cached)`：同一份代码上同一条命令刚跑过，Go 直接用了那次的结果） |
| 第 2 条 `/protocol-sync` | 这一轮没有改 `protocol.go`、`protocol.ts`、`rest.ts`（`git diff 91e0fab..HEAD` 里没有这三个文件），字段仍是验证者在 `91e0fab` 上逐项核对过的样子；`docs/protocol.md` 改了三处说明（预检的 400、删除的 409 和 500），都对着实现和用例改的 |

三份 GUI 冒烟（`gui-smoke.mjs`、`gui-chat-smoke.mjs`、`gui-worktree-smoke.mjs`）这一步没有跑：另一名验证者同时在别的副本里做界面验证，由主会话在它结束后安排。

已知偶发的用例这一轮的情况：`make check` 和各次整包运行里都没有出现；只在旧版 git 的两次整包运行里（基准和返工后各一次）出现了 `TestProjectStoreRemoveWorktreeIfSame`。
