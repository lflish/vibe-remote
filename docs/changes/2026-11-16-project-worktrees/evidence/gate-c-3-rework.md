# 关口 C 放行后的返工（T29–T32）的实验记录

用户对关口 C 的汇总回复 `all` 之后改的四处（decisions #153 起）。这里是改之前、改之后的数据和各个实验的做法；结论各有一行记在 decisions.md。所有命令都带独立的 `TMUX_TMPDIR`，测试仓库都在 `t.TempDir()` 或 `/tmp` 下。

## 1. T29（d71）：按行读的 worktree 列表

### 1.1 只按形状判断挡不住的拆法

汇总里写的改法是「按行读时遇到不认识的行、或 `worktree` 行前面不是空行，就丢掉相邻条目」。把它实现出来（`parseWorktreeList` 按行读时的形状和顺序规则），再把第二道（对照 `<git 公共目录>/worktrees/*/gitdir`）临时关掉，回归用例 `TestFallbackListNeverInventsAWorktree` 15 个子用例里仍有 6 个失败，`TestFallbackListFailsWhenTheMainDirectoryCannotBeRead` 3 个里 1 个失败：

```text
--- FAIL: TestFallbackListNeverInventsAWorktree/blank_line                   a\n\nworktree <别处>
--- FAIL: TestFallbackListNeverInventsAWorktree/whole_entry                  a\nHEAD <40 位>\nbranch refs/heads/main\n\nworktree <别处>
--- FAIL: TestFallbackListNeverInventsAWorktree/whole_entry_then_text        a\nHEAD <40 位>\ndetached\n\nfoo
--- FAIL: TestFallbackListNeverInventsAWorktree/names_the_main_directory     a\n\nworktree <主目录>
--- FAIL: TestFallbackListNeverInventsAWorktree/names_a_real_worktree        a\n\nworktree <另一个真 worktree>
--- FAIL: TestFallbackListNeverInventsAWorktree/names_a_real_worktree_whole  a\nHEAD <40 位>\ndetached\n\nworktree <另一个真 worktree>
--- FAIL: TestFallbackListFailsWhenTheMainDirectoryCannotBeRead/whole_entry  主目录在 devflow\nHEAD <40 位>\nbranch refs/heads/main\n\nworktree /nowhere，旁边另有一个仓库 devflow
```

原因：路径里换行之后的内容由起名字的人决定，可以正好是 git 会写的行，连空行（条目的分隔）也可以有。`a\nHEAD <40 位>\nbranch refs/heads/main\n\nworktree <别处>` 按行读出来是两个形状完全正确的条目：`…/a`（在 main 上）和 `<别处>`（带着真 worktree 的 HEAD 和分支）。只看行分不出来。

反过来，只留第二道、把形状规则关掉：上面两个用例全部通过（失败的只有专测形状的 `TestParseWorktreeListByLine`）。所以起作用的是第二道，形状规则是第一层筛子。

### 1.2 修复前后

修复前（提交 `4b61f20` 的代码加回归用例）：

```text
--- FAIL: TestFallbackListNeverInventsAWorktree            15 个子用例失败 13 个（通过的 2 个：several_newlines、newline_at_end）
    例：text（a\nfoo）读到 {Path:…/devflow-worktrees/a Branch:odd …}
--- FAIL: TestFallbackListFailsWhenTheMainDirectoryCannotBeRead   3 个子用例全部失败
    例：blank_line 读到 [{Path:/nowhere Branch:main …} …]，没有报错
--- FAIL: TestParseWorktreeListByLine                      25 个子用例全部失败
```

修复后：`go test -count=1 ./internal/session -run 'TestFallbackList|TestParseWorktreeList|TestListWorktrees|TestChatTrust'` → `ok`；`go test -race -count=1 -timeout 20m ./internal/session ./internal/server` → `ok`（360 s、70 s）。

### 1.3 变异核对（临时改动，没有提交）

| 改动 | 失败的用例 |
|------|-----------|
| 不对照登记的路径（只留形状规则），第一项也不核对 | 上面 1.1 的 7 个 |
| 形状规则关掉（只留对照） | `TestParseWorktreeListByLine` 的 25 个子用例；`TestFallbackList*` 全部通过 |
| 同一路径出现两次仍然保留 | `TestFallbackListNeverInventsAWorktree/names_a_real_worktree`、`/names_a_real_worktree_whole` |
| 第一项不核对是不是这个仓库 | `TestFallbackListFailsWhenTheMainDirectoryCannotBeRead/whole_entry` |
| `worktree` 行前面不是空行时不连前一项一起去掉 | `TestParseWorktreeListByLine/worktree_line_after_head` |
| 第一项不完整时仍返回后面的项 | `TestParseWorktreeListByLine` 的 25 个子用例（每个都有「放在第一项的位置」的一半） |

### 1.4 真的旧版 git（2.34.1）

在自己的临时目录里从源码构建（`make NO_GETTEXT=1 NO_OPENSSL=1 NO_CURL=1 NO_EXPAT=1 NO_TCLTK=1 NO_PERL=1 NO_PYTHON=1`，不安装、不改全局配置，用源码目录里的 `bin-wrappers/git` 放在 `PATH` 最前面）。`git --version` → `git version 2.34.1`；它对 `worktree list --porcelain -z` 以 129 退出，所以 `ListWorktrees` 走的是真的退回路径，不是包装脚本模拟的。

| 运行 | 结果 |
|------|------|
| `go test -count=1 -timeout 10m -v ./internal/session -run 'TestFallbackList\|TestParseWorktreeList\|TestListWorktrees\|TestChatTrust\|TestProjects\|TestResolveHome\|TestManaged\|TestUndo\|TestWorktreeStatus'` | `ok`（63 s）；127 行 PASS、0 个 FAIL；3 个 SKIP（`TestListWorktreesPathWithNewline` 的 `newline`、`newline_at_end`、`nul_like`：它们断言「带换行的路径列得出来」，只在认 `-z` 的 git 上成立，跳过条件没有改）。新加的三个用例（15 + 3 + 25 个子用例）全部 PASS |
| `go test -count=1 -timeout 20m -v ./internal/session ./internal/server` | session 包 2 个失败，server 包 `ok`；658 行 PASS；8 个 SKIP（上面 3 个，`TestSessionCreatedInAnOddlyNamedDirectoryIsStillRead` 的 `newline`、`newline_and_tab`，`unborn` 的 3 个——与第 1 轮返工时的 8 个相同） |

两个失败都不是这次改动引入的：

- `TestRemoveWorktreeWhenTmuxIsNotInstalled`：2.36 之前的 git 在 `PATH` 里没有 `false` 程序时往 stderr 写 `error: cannot run false`，被算进未提交文件数。第 1 轮返工时在基准 `91e0fab` 上同样失败（evidence/gate-c-1-rework.md 第 3 节），记在 tasks.md「后续」。
- `TestProjectStoreRemoveWorktreeIfSame`：已知偶发（不带 `-race` 时先删再加同一条记录的两次时间戳落在同一微秒；关口 C 第 2 轮验证者实测 200 次失败 33 次）。在 2.34.1 上带 `-race` 单独重跑 5 次：`ok`。

`TestProjectsOneGitCallPerProject`（一轮 `Projects()` 正好每个项目一个 git 进程）在 2.34.1 上通过：对照登记的路径只读文件，不另起 git 进程。
