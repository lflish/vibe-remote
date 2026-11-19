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
