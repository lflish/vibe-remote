# 第三轮独立核对：第二轮复评的修复（project-worktrees，c74e715..3b01cf3）

对象：`/Users/mac/github/vibe-remote/.devflow-tmp/worktrees/project-worktrees`，HEAD `3b01cf3`。

总结：R2、R3、R4、R6、R7、R8、R10 没有发现问题。R1 放得太宽：有两条已证实的路径，tmux 会话活着却被判成「没有任何会话」，删除 worktree 时漏掉会话；另有一条只有源码依据的待验证项。

## 已证实的问题

### [一般] tmux server 还活着、只是 socket 文件被删掉时，对账当成「没有任何会话」：worktree 被删而里面的会话没结束，会话也从列表里消失

- 位置：`vibe-remoted/internal/session/runner.go:174-184`（`noTmuxServerPossible`）、`runner.go:208-210`；后果在 `manager.go:623-628`（`syncFromTmux` 把表里的终端会话当幽灵删掉并释放 claude 会话占用）和 `projects.go:697-705`（`RemoveWorktree`）。
- 证据：
  - shell（独立 `TMUX_TMPDIR`，tmux 3.6a）：起一个会话后 `rm <dir>/tmux-501/vibe-remote`，`tmux -L vibe-remote list-sessions` 输出 `error connecting to …/tmux-501/vibe-remote (No such file or directory)`、退出码 1；server 进程仍在。`kill -USR1 <server pid>` 后 socket 重建，`list-sessions` 又列出 `vibe-remote-probe`。
  - 副本里的临时用例 `TestR3SocketFileGoneServerAlive`（`3b01cf3`，独立 `TMUX_TMPDIR`）：在 worktree `feat` 里用 `Manager.Create` 建终端会话，然后 `os.Remove(tmuxSocketPath())`：
    ```
    before: status.sessions=[1795104136862-c6d0c1e2]
    liveTmuxSessions() = map[], true
    Manager.List() has 0 sessions
    session 1795104136862-c6d0c1e2 still in the table: false
    after: status.sessions=[]
    RemoveWorktree = {Removed:true … EndedSessions:[]}, err=<nil>; directory still there=false
    after SIGUSR1 (socket recreated): tmux session alive=true, …/devflow-worktrees/feat
    ```
  - 修复前（`c74e715`）同一状态下 `liveTmuxSessions` 返回失败（`error connecting` 不匹配 `isNoTmuxServer`），删除返回 500、内存表保留。这一条是读代码得出的，没有在 `c74e715` 上实跑。
- 依据：裁决 R1 的前提是「socket 文件不存在时不可能有终端会话」。这个前提在 server 运行中 socket 文件被删时不成立；tmux 为此专门提供 SIGUSR1 重建 socket。spec R5 系列要求删除 worktree 前先结束其中的会话；CLAUDE.md 要求同一 claude 会话 id 任何时刻最多一个进程，而这里占用被释放、终端里的 claude 还在跑。
- 触发面：有人或脚本清 `/tmp`（`rm -rf /tmp/*`、会删 socket 的清理工具）。systemd-tmpfiles 跳过在用的 socket，tmpwatch / tmpreaper 默认不删 socket，所以不是每台机器都会遇到；这部分是凭记忆，没有逐个核实。
- 改法（择一或组合）：
  1. 「socket 不存在 ⇒ 空表」只在 daemon 自己也没有终端会话的证据时才用：`syncFromTmux` 里如果内存表还有终端会话，就按查询失败处理（不清表、删除返回 500）。这能挡住同一个 daemon 运行期间的情况。
  2. 重启后的情况要另一份证据：daemon 起会话时把 tmux server 的 pid（`#{pid}`）记进 `state_dir`；socket 不存在而该 pid 仍是 tmux 进程时按查询失败处理，日志里写明「socket 文件丢了，可对该 pid 发 SIGUSR1」。
  3. 不做 2 的话，把「重启后 socket 文件被删而 server 还活着」写成已知限制。
  - 补一个「server 活着、socket 文件被删」的用例。
- 类别：检查放松

### [一般] daemon 的 PATH 里找不到 tmux、而上一次运行留下的 tmux 会话还活着时，同样被判成「没有任何会话」

- 位置：`vibe-remoted/internal/session/runner.go:175-177`（`errors.Is(err, exec.ErrNotFound)` 直接返回 true，不看 socket）。
- 证据：副本里的临时用例 `TestR3NoTmuxOnPathButServerAlive`：`m1` 在 worktree `feat` 里建终端会话；把 PATH 换成只有 git（沿用现有的 `onlyGitOnPath`），新建 `m2` 模拟换了环境重启的 daemon：
  ```
  status.sessions=[]
  RemoveWorktree = {Removed:true … EndedSessions:[]}, err=<nil>; directory still there=false
  tmux session 1795104211313-0351413c alive=true
  ```
- 依据：同上一条。裁决 R1 说的是「机器上没装 tmux」，代码判断的是「daemon 当前的 PATH 里没有 tmux」，两者不是一回事。
- 触发面：macOS 上 tmux 在 `/opt/homebrew/bin`，launchd 的默认 PATH 不含它；先在交互 shell 里跑 daemon 并开过会话，再改成 launchd / systemd 启动，就是这个状态。此时 daemon 也开不了新终端会话，用户会发现部署有问题，但在发现之前删 worktree 会漏掉旧会话。
- 改法：`exec.ErrNotFound` 时也看 socket：socket 不存在才算空表；socket 文件在就按查询失败处理，并在日志和 500 的 message 里写明「找不到 tmux 程序，但有 tmux socket」。给 `TestRemoveWorktreeWhenTmuxIsNotInstalled` 配一个「socket 在」的反例。
- 类别：检查放松

## 待验证项

### `TMUX_TMPDIR` 指向不存在（或 `realpath` 解析不了）的目录时，daemon 算出的 socket 路径与 tmux 实际用的不一致

- 位置：`vibe-remoted/internal/session/runner.go:47-53`（`tmuxSocketPath`）。
- 依据：tmux 3.6a 的 `tmux.c`：`make_label` 调 `expand_paths(TMUX_SOCK, &paths, &n, 0)`；`expand_paths` 在 `realpath()` 失败时 `free(expanded); continue;` 跳过这一项，取下一项 `/tmp/`。本机 tmux 二进制里的搜索串是 `$TMUX_TMPDIR:/tmp/`（`strings` 确认）。所以这种配置下 tmux 用 `/tmp/tmux-<uid>/vibe-remote`，`tmuxSocketPath()` 算的是 `$TMUX_TMPDIR/tmux-<uid>/vibe-remote`，`os.Stat` 恒为 ENOENT。
- 后果（推演）：这种配置下，`list-sessions` 任何带退出码的失败都会被当成空表，包括 server 活着的失败（如升级 tmux 后旧 server 报协议版本不符）。
- 为什么没验证：复现要让 tmux 落到默认目录 `/tmp/tmux-501/`，约束禁止在那里执行 tmux 命令。`TestTmuxSocketPathIsWhereTmuxPutsIt` 只覆盖了 `TMUX_TMPDIR` 存在的情况。老版本 tmux 的行为没有读源码。
- 改法：`tmuxSocketPath` 先对 `TMUX_TMPDIR` 做 `filepath.EvalSymlinks`，失败就退到 `/tmp`，与 tmux 一致；或者 `TMUX_TMPDIR` 非空但解析不了时不走「socket 不存在」这条捷径。

## 五个问题的结论

1. **R1：放得太宽，见上面两条和一条待验证项。** 其余检查没有问题：
   - 「只在查询失败之后才看 socket」成立：`os.Stat` 只在 `err != nil` 且是 `ExitError` 时执行。
   - `os.Stat` 的失败只有 ENOENT 算「不存在」；无权限、路径中间是文件（ENOTDIR）、socket 路径是目录或普通文件都按查询失败处理。
   - `TMUX_TMPDIR` 为空与未设置等价（与 tmux 一致）；尾斜杠被 `filepath.Join` 清掉；macOS 上 `/tmp` 与 `/private/tmp` 经 `os.Stat` 跟随符号链接是同一个文件。
   - uid 两边都是真实 uid。所有 tmux 调用都经 `tmuxCmd`（`-L vibe-remote`，没有 `-S`），环境是 daemon 自己的环境去掉主 token，`TMUX_TMPDIR` 原样传下去；`extraEnv` 在产品代码里恒为空（`main.go` 只设 `ProjectsDir`）。

2. **R3、R4：没有问题。**
   - 两个 `--force` 只用在「目录是本次 `os.Mkdir` 占到的，且该项在本次的分支上或 detached 在本次的提交上」的那一项。别人的 worktree 要被误认，需要在本次 `Mkdir` 之后的毫秒级窗口里用同一路径和同一分支（或同一提交）抢建，这是修复前就有的认定规则（V20）；新增的只是这种情况下对方的锁也挡不住。
   - 「没确认移除就不删分支」在 `undo()` 的四条路径上都成立：列表读到且删除成功 → 删分支；删除失败 → 留；列表读不到且目录还在 → 留；列表读到但没有这一项 → 删（git 已不登记）。
   - 读回重试后没有「退回自己拼的路径」的分支：要么用 git 登记的值，要么撤销。
   - 附带说明，不算问题：撤销留下 worktree 和分支时，`undoOwnWorktree` 仍会清创建记录，所以这个残留按「外部」显示，分支要手动删，message 里已写明两者都留着。
   - `TestCreateWorktreeReadBackFails`、`TestWorktreeAddKilledDuringCheckoutIsUndone` 通过。

3. **R7：没有问题。**
   - `@vibe_remote_workdir` 与其他选项一起在 `start()` 里写，写失败就 `Kill` 并返回错误。
   - 14 列解析：空值得到空串；值里的制表符因为是最后一列被原样保留；值里的换行会把 `startDir` 截断（实测 `/a\nb/c` 读成 `/a`），但目录名带换行时第 2 列 `pane_current_path` 早已让整行解析不了，是原有限制，不是本批引入的。
   - G5 的原始场景升级后不会漏：建在嵌套仓库里的会话，归属 `home` 本身就在 worktree 内，`created_in_a_nested_repository_session_from_before_the_option` 子用例通过。真正只能靠创建目录的是「既没有归属也没有该选项」的旧会话，它靠 `backfillTerminal` 补归属，补不上才漏，可以接受；CLAUDE.md 已写「旧会话只按归属算」。
   - 对话会话用 `rec.workdir`（只写一次）；交接出来的终端会话以 `rec.Workdir` 建，`startDir` 等于原对话的创建目录；worktree 模式的会话取映射后的目录。

4. **R2：没有问题。** `vibe-remoted` 非测试代码里 git 只有一个调用点（`worktree.go:106`，在 `gitWithin` 内）；`chat/`、`server/`、`config/`、`cmd/` 里没有 `"git"` 字面量，其余 `exec.Command` 是 claude、shell、`ps`、tmux。`-c` 和 `-C` 都是 git 的全局选项，先后对所有子命令成立。`TestEveryGitCallTurnsFsmonitorOff`、`TestFsmonitorStaysOffOnGitWithoutConfigEnvironment` 通过。

5. **R6、R8、R10 及被改动的断言：没有问题。**
   - R6：成功时标记留到 `refreshAllMachines` 的 `finally` 才清；失败、409、取消仍立即清。
   - R8：`listsWorktree` 只在 git 列表里完全没有该路径时清记录，与 CLAUDE.md 一致。
   - R10：Go 与 TS 的规则先后一致，中英文文案齐全。
   - `TestGitEnvKeepsInheritedConfig` 的跳过只在该 git 不读 `GIT_CONFIG_COUNT` 时发生（本机 2.50.1 没有跳过），并新增了 `GIT_CONFIG_PARAMETERS` 子用例。
   - `TestParseTmuxSessionLineColumns` 只增加 14 列；共用向量的 `reason` 是把 `invalid` 细分。
   - git 包装脚本从位置参数 `$3 $4` 改成 `$GIT_SUB`，是命令行多了 `-c` 的必要跟进。没有发现被改弱的断言。

## 覆盖范围

- **读过的代码**：范围内 Go 产品代码的全部 diff；`runner.go` 的 tmux 调用、解析和 `start()`；`manager.go` 的 `syncFromTmux`、`lookupOrRecover`、`applyTmuxSessionMetadata`、`reconcileTmuxSessions`、`createTerminalLocked`、`createOwnWorktree`、`undoOwnWorktree`；`chat_manager.go` 的 `Handoff`；`projects.go` 的 `WorktreeStatus`、`sessionTableCurrent`、`RemoveWorktree` 前半、`sessionsIn`、`collectSessions`；`worktree.go` 的 `CreateWorktree`、`registered`、`undo`；桌面端 5 个文件的 diff；原有测试文件的 diff 和 `review_round2_test.go` 约七成。
- **跑过的实验**（都在 `/tmp/vr-r3-*`，独立 `TMUX_TMPDIR`，已清理，没有留下进程）：
  - shell 里「删 socket 文件 → 查询失败 → SIGUSR1 恢复」；
  - `3b01cf3` 副本里三个临时用例（socket 文件被删、PATH 无 tmux、选项值含制表符和换行）；
  - 副本里原样运行 19 个相关的已有用例，全部通过、无跳过。
  - 待审 worktree 的 `git status --short` 为空。
- **没有做的**：
  - 没有跑全量 `go test`、桌面端测试和 `gui-smoke`。
  - `backfillTerminal` 的正文没有读，问题 3 里关于旧会话补归属的说法依据的是调用处和注释。
  - `TMUX_TMPDIR` 不存在时的路径不一致只有源码依据。
  - 没有用低于 2.31 的真实 git 复测 R2，只跑了已有的模拟用例。
  - `refreshAllMachines` 的正文和 R6 的桌面端用例没有读。
  - `docs/protocol.md`、`spec.md`、`decisions.md` 没有逐条核对，只对照了 CLAUDE.md 和两份 round2 文件。
