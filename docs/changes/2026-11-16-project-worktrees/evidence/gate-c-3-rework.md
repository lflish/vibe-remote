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

## 2. T30（c8）：创建后的钩子失败时不再留下 worktree

### 2.1 修复前后

修复前（提交 `7f4d4e1` 的代码加回归用例；钩子内容照 git-lfs 的钩子在找不到 `git-lfs` 时的写法，`exit 2`）：

```text
--- FAIL: TestCreateFailedByPostCheckoutHookLeavesNothing/named
    the undo left something behind: create worktree: git worktree add --detach …/devflow-worktrees/fix-login <oid>: exit status 2: Preparing worktree (detached HEAD 167d98f) …
    …/devflow-worktrees/fix-login is still there: [.git README]
    git still has a worktree registered: [fix-login]
    git lists more than the main directory
    attempt 1: the container this create made is left
--- FAIL: TestCreateFailedByPostCheckoutHookLeavesNothing/from_a_linked_worktree     left behind: directory true, branch ""
--- FAIL: TestCreateFailedByPostCheckoutHookLeavesNothing/container_is_a_symlink     同上（目录在解析后的路径上）
--- FAIL: TestUndoAfterWorktreeAddFailedOnItsOwn/post_checkout_hook_fails            the worktree of the failed create is left at … (listed: true)
--- FAIL: TestUndoLeavesAWorktreeSomeoneElseAddedWhileTheAddRan/at_another_path      this create's own worktree, directory or branch is left
--- FAIL: TestUndoLeavesAWorktreeSomeoneElseAddedWhileTheAddRan/git_refuses_a_second_add_at_a_registered_path   this create's own worktree is left
```

真实应用（`gui-worktree-smoke.mjs --only=R3.8`，daemon 换成从 `7f4d4e1` 构建的，`VR_DAEMON=…`）：

```text
PASS R3.8 git fails while creating — …
FAIL R3.8 the post-checkout hook fails while creating — attempt 1: the daemon says it left something behind: 错误：create session: create worktree: git worktree add --detach …/failrepo-worktrees/hooked <oid>: exit status 2: …
2 cases: R3 1/2
```

修复后：

- `go test -count=1 ./internal/session -run 'TestCreateFailedByPostCheckoutHook|TestUndo|TestCreate|TestWorktreeAddKilled|TestGitNeverGetsShortBranchName|…'` → `ok`；`go test -race -count=1 -timeout 20m ./internal/session ./internal/server` → `ok`（371 s、72 s）。
- 第 1 轮 X9 的三个反例（`TestUndoLeavesAWorktreeSomeoneElseAddedAtTheSamePath` 的 `same_branch`、`detached_at_the_same_commit`、`added_before_the_branch_was_claimed`）一个字没改，仍然通过；`TestWorktreeAddKilledDuringCheckoutIsUndone` 仍然通过。
- 真实应用：`PASS R3.8 the post-checkout hook fails while creating — two attempts failed with the hook's message and left nothing (no directory, no registration, no branch, no row); with the hook gone the same name was created`，`2 cases: R3 2/2`。
- 真的 git 2.34.1 上：`-run 'TestCreateFailedByPostCheckoutHook|TestUndo|TestWorktreeAddKilled|TestCreate'` → `ok`（44 s）。

### 2.2 「新出现且指向本次目录」单独不够

任务说明里的设想：本次的 add 失败、别人同时在同一路径上建成，在 git 的互斥下不会同时成立。实验结果是只对了一半。

- 本次的 add 先登记了路径，别人后到：git 拒绝后到的。用例 `git_refuses_a_second_add_at_a_registered_path` 从 post-checkout 钩子里（也就是本次的 add 还在运行、登记已经写好的时候）对同一路径再做一次 `git worktree add --detach`，它以非零退出；随后钩子失败，本次的 worktree 被认领并清掉。
- 别人的 add 插在「记下登记」和「本次的 add 自己检查路径」之间：别人建成，本次的 add 因为路径已被登记而以 128 退出。这时别人的登记是新出现的、指向本次的目录，状态也可以对得上（检出本次刚建的分支，或 detached 在同一提交）。用例 `at_the_same_path_on_the_same_branch`、`at_the_same_path_detached_at_the_same`（别人的 add 由包装脚本在本次的 `git worktree add` 进程里、真 git 运行之前执行）在「只按新出现且指向本次目录」的实现上失败：

```text
--- FAIL: TestUndoLeavesAWorktreeSomeoneElseAddedWhileTheAddRan/at_the_same_path_on_the_same_branch
--- FAIL: TestUndoLeavesAWorktreeSomeoneElseAddedWhileTheAddRan/at_the_same_path_detached_at_the_same
    their file in …/fix-login: "", open …/precious.txt: no such file or directory; a failed create deleted someone else's work
```

所以多一个条件：add 的退出码是 128（git 自己放弃）或 129（用法错误）时不认领。git 拒绝路径发生在它登记任何东西之前，这样退出的 add 没有留下过自己的登记；钩子的退出码 git 原样传出（git-lfs 的钩子是 2）。分不开的只剩「钩子自己以 128 退出」，那时 worktree 留下（用例 `hook_ends_with_the_status_git_gives_up_with` 记着这个结果，tasks.md「后续」）。

### 2.3 变异核对（临时改动，没有提交）

| 改动 | 失败的用例 |
|------|-----------|
| 不看退出码（只按「新出现且指向本次目录」） | `…WhileTheAddRan/at_the_same_path_on_the_same_branch`、`/at_the_same_path_detached_at_the_same`、`/hook_ends_with_the_status_git_gives_up_with` |
| add 之前就在的登记也算 | `…WhileTheAddRan/registered_before_the_add_whatever_status_it_ends_with` |
| 新出现的登记多于一条也认领 | `…WhileTheAddRan/two_registrations_of_the_path_appeared` |
| 永不认领（改之前的行为） | `TestCreateFailedByPostCheckoutHookLeavesNothing` 3 个、`TestUndoAfterWorktreeAddFailedOnItsOwn/post_checkout_hook_fails`、`…WhileTheAddRan/at_another_path`、`/git_refuses_a_second_add_at_a_registered_path` |

## 3. T31（c7）：后台终端会话在屏幕内容没变时不亮「有新消息」

### 3.1 tmux 的重绘是什么样的

在自己的 tmux server 上（独立的 `TMUX_TMPDIR`，`tmux -L vibe-remote`，一个 pty 里的客户端 attach 到一个打印了标题行、100 行彩色文字和提示符的会话），执行 `tmux set-option -t <会话> @vibe_remote_name …`（daemon 新建、重命名会话时做的事），记录客户端收到的字节（tmux 3.6a）：

| 尺寸 | attach 时收到 | 每次 `set-option` 之后收到 | 其中清屏（`ESC[…J`） | 其中清到行尾（`ESC[K`） |
|------|--------------|---------------------------|---------------------|------------------------|
| 80×24 | 4228 字节 | 1976 字节（三次都是） | 0 | 24（每行一个，在文字之后） |
| 200×60 | 10276 字节 | 5000 字节（三次都是） | 0 | 60 |

开头是 `ESC[?25l ESC[?12l ESC[?25h ESC[?25l ESC[31m ESC[H`，然后每一行「文字、`ESC[39m`、`ESC[K`、下一行的颜色、`\r\n`」。也就是光标回到左上角、逐行原地重写、不先清屏。daemon 每次从 PTY 最多读 4096 字节，200×60 的一次重绘会分成两帧。

用真的 xterm（`@xterm/xterm` 6.1.0-beta.302，不 `open` 也能解析）把重绘切成整块、4096、1000、7、1 字节的片段写入，每一片处理完之后屏幕文字都与重绘前相同（`desktop/scripts/test-terminal-activity.mjs` 的两个用例；捕获的字节在 `desktop/scripts/fixtures/tmux-redraw.json`）。所以比较可以在每一帧之后立刻做，不需要等输出停下来（decisions d75）。

### 3.2 修复前后

真实应用（`gui-worktree-smoke.mjs --only=X1.redraw`；修复前 = 把 `desktop/src/renderer/index.ts` 的改动暂存起来再构建）：

```text
修复前
FAIL a background terminal session shows "new messages" only when its screen changed (exploration X1, c7)
     — dots before anything happened (A in the background, B shown): got ["output","none"], want ["none","none"]
1 cases: other 0/1

修复后
PASS a background terminal session shows "new messages" only when its screen changed (exploration X1, c7)
     — 12 data frames repainted the background session when another session was created and renamed: no dot;
       renamed itself: no dot; it printed a line: "终端 · 有新消息"
1 cases: other 1/1
```

修复前在更早的一步就失败了：A 切到后台、B 被打开（attach）之后 A 已经亮了点——同一个原因（收到重绘的字节就亮），还没有走到「新建第三个会话」那一步。

单元测试 `desktop/scripts/test-terminal-activity.mjs`（11 个用例）在「任何字节都算变化」的旧规则下（临时把 `ScreenWatch.changed()` 里的相等判断去掉）：

```text
ok - test-terminal-activity: screenText is the text of the rows on screen, nothing else
FAIL: test-terminal-activity: a tmux repaint of the same screen is not a change (tmux 3.6a, 80×24)
AssertionError [ERR_ASSERTION]: the repaint in pieces of 1976 bytes was taken for new output
```

修复后：`test-terminal-activity checks passed (11)`；`npm run typecheck` 退出 0；`npm test` 退出 0，`ok` 行 311 → 322（新增的 11 行都是这个脚本的）。

### 3.3 一次比较的耗时

脚本：`evidence/gate-c-3-bench-screen-text.mjs.txt`（放到 `desktop/scripts/` 下运行）。每一轮先把整屏重绘写进真的 xterm（每一行都被重写），再单独给 `screenText` 计时，600 轮取后 500 轮。要先重绘再计时的原因：xterm 对每一行的 `translateToString` 有缓存，行没被写过时再取一次只要 3–11 µs——第一版基准对着不变的屏幕反复取，量到的是缓存（1.5–4.5 µs），不是一次比较的真实开销。

| 运行环境 | 尺寸，屏幕内容 | `screenText` 中位数 | p95 | 屏幕文字长度 |
|----------|----------------|---------------------|-----|--------------|
| Electron 44.7.0（`ELECTRON_RUN_AS_NODE=1`，V8 15.2） | 80×24，捕获的屏幕 | 33 µs | 97 µs | 1632 |
| 同上 | 80×24，每个格子都有字 | 99 µs | 240 µs | 1955 |
| 同上 | 200×60，捕获的屏幕 | 104 µs | 312 µs | 4152 |
| 同上 | 200×60，每个格子都有字 | 230 µs | 884 µs | 12071 |
| Node 22.22.2（V8 12.4） | 80×24，捕获的屏幕 | 38 µs | 104 µs | 1632 |
| 同上 | 80×24，每个格子都有字 | 117 µs | 273 µs | 1955 |
| 同上 | 200×60，捕获的屏幕 | 125 µs | 262 µs | 4152 |
| 同上 | 200×60，每个格子都有字 | 411 µs | 1067 µs | 12071 |

对比：同一轮里从 `term.write` 到它的回调（xterm 接收并解析这次重绘，含一次定时器调度）中位数 1.2–1.7 ms。各项的最大值在 2–12 ms（垃圾回收），600 轮里出现个位数次。

什么时候才算：只有后台、还没有点、不在 attach 后 500 ms 内的终端会话收到字节时。前台会话不取快照；点一旦亮了就不再取，直到用户看过它。新建一个会话时每个后台会话收到约 10–12 帧重绘，即每个后台会话约 0.4–1.5 ms（80×24）的总开销。

### 3.4 变异核对（临时改动，没有提交）

| 改动 | 失败的用例 |
|------|-----------|
| M1 任何字节都算变化（旧规则） | `a tmux repaint of the same screen is not a change (80×24)` |
| M2 会话切到前台时不忘掉记下的屏幕 | `index: a repaint does not light the dot…`（`a cursor that moved lit the dot`） |
| M3 attach 清屏时不忘掉记下的屏幕 | `index: after a re-attach reset the screen, the comparison starts over` |
| M4 attach 之后 500 ms 内也比较 | `index: the session shown gets no dot; hook events are not affected` |
| M5 快照不含 `baseY` | `screenText is the text of the rows on screen, nothing else`（`a screen that scrolled is another screen`） |
| M6 快照含光标位置 | `a tmux repaint of the same screen is not a change (80×24)`：`the repaint in pieces of 1000 bytes was taken for new output`——重绘被切开时中途的光标位置和重绘前不同 |
| M7 已经亮着的点（hook 状态）被输出覆盖 | `index: the session shown gets no dot; hook events are not affected`（`output does not take a hook state back to "new messages"`） |
| M8 前台会话也亮点 | `index: a repaint does not light the dot…` |
