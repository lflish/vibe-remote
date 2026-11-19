# 第二轮独立复评：评审修复（project-worktrees，e278f87..c74e715）

评审对象：`/Users/mac/github/vibe-remote/.devflow-tmp/worktrees/project-worktrees`，HEAD `c74e715`。

## 上一轮问题的修复核对

结论先说：上一轮的 9 + 7 + 11 条和 5 个待验证项里，绝大多数按裁决修好了；但有 **2 处修复引入了回归**（待验证 1 的修法、G4 的修法），另有 5 处修复带出了新的失败路径或同类漏网（G1、G2、G5、D7、git 时限）。下面逐条，新问题的细节在下一节。

daemon 侧
- G1：已解决（裁决列的三种触发方式和「白名单外」各有用例，均通过）。同一后果还有第四种触发方式（目录有一轮读不到），是 design 里写明的取舍，见下文。
- G2：部分解决。路径和分支以 git 登记的为准，符号链接容器和 NFD 名字的用例通过；新加的「读回」这一步自己失败时，撤销留下目录却删了分支，见下文。
- G3：已解决。先开会话、后在上层 `git init` 的目录按非 git 项目显示，仓库的真主目录不再挂在它下面。
- G4：部分解决。git ≥ 2.31 上所有调用都不运行 `core.fsmonitor`；git < 2.31 上反而比修复前更差（回归），规则文字也比代码宽，见下文两条。
- G5：已解决（开在被忽略目录里的独立仓库的会话现在会被算进去并结束）。但 daemon 重启后「工作目录」变成进程当前目录，会把挂在别处的会话算进来，见下文。
- G6：已解决。没有提交的 worktree 能查状态、能删；预检返回 `no_commits`，桌面端禁用名字输入框并写明原因。
- G7：已解决。动手前拒绝，`message` 写明是哪个目录和手动命令，桌面端把它显示在重开的确认框里（英文原文）。6 万个未跟踪文件时这次 `git status` 约 90 ms，不构成超时风险。被忽略目录（如被忽略的 `node_modules`）里的仓库不受影响；未被忽略的 `node_modules` 里带 `.git` 的依赖、克隆进来的参考仓库会让这个 worktree 只能按提示先挪走该目录或手动删除——这是裁决选的方向。
- G8：已解决。桌面端只在 `branch && status.managed` 时带 `deleteBranch`，409 带回的 `status` 与 daemon 判断用的是同一份，重开的确认框不会再带它，没有「409 → 重开 → 再 409」的循环。
- G9：已解决。两边对全部单个码位的结论逐一比对相同（各拒绝 253 个），共用向量通过。提示文案把原因说成「git 不接受」，见下文。
- X1：已解决（缺 `path` / `head` / `sessions` → 400；`sessions: []` 不算缺）。
- X2：已解决（整个请求体计入 64 KiB，对象之后有内容 → 400）。
- X3：已解决（文档改成代码实际保证的两步，`TestWorktreePathChecksBeforeGit` 守着）。
- X4：部分解决，按 d47：新建会话时名字的本地规则在任何 git 之前；预检仍先看目录，文档写明了两边先后不同。
- X5、X7：已解决（文档）。
- 待验证 1（重启后对账被丢弃）：注入的查询失败已解决；但修法把「tmux 的 socket 还不存在」也当成失败，导致 worktree 恒删不掉——**回归，严重**，见下文。
- 待验证 2（git 卡住不放锁）：已解决（每个 git 都带时限，锁会放开）。`worktree add` 在检出中途被杀后的残留清不掉，见下文。

桌面端
- X6：已解决。
- D1：已解决。读了 `refreshAllMachines` 的全部调用点：动作触发的刷新和机器列表编辑仍开启新一代，旧应答（含刚重命名、刚删除之前发出的轮询）被丢弃；同一代内按序号应用。没有找到旧数据盖掉新数据的路径。
- D2、D3、D6、D11：已解决（在 `c74e715` 上跑 `gui-smoke.mjs`：46 行 PASS、退出码 0）。
- D4：已解决。info 最晚 8 秒后失败（REST 超时），之后普通模式可确认、Worktree 模式置灰并说明；等待的这 8 秒里按钮是灰的、没有文字说明（可接受）。旧 daemon 的 info 正常返回，不受影响。
- D5：已解决。
- D7：部分解决。请求失败、超时、409、404 各路径都清标记；成功后标记清得比刷新早，行会短暂变回可点，见下文。
- D8、D10：已解决。
- D9：已解决。只有焦点原本就在侧边栏里时才找回（终端、对话输入框、对话框里的焦点不受影响，重命名期间不重建）；菜单项沿用打开时的状态，点下去的动作都由 daemon 重新校验（移除项目 → 409，删除 → 重查状态 / `removingWorktrees` 防重），没有发现会造成损失的路径。
- 待验证 1（404 时关掉所有视图）、待验证 2（唯一列出的 worktree 不是主目录）：已解决。
- 待验证 3（目录名以 `;` 结尾）：按裁决认定为原有问题，记了后续，未修。

被改动的已有断言（问题 3）：`TestRemoveRefusedWhenNestedWorktree`、`TestRemoveExternalNeverDeletesBranch` 及 `switched_branch`、`delete_flow_remove_404`、删除请求体多 `branch` 的几处，都有对应的裁决（G5、G8、待验证 1），改后比原来更严。逐个看了 `*_test.go`、`desktop/scripts/*.mjs`、`gui-smoke.mjs` 里被删掉或改写的行，没有发现报告之外被改弱的断言、被删的用例、调大的超时或新增的跳过。

## 新发现的问题（按严重程度排序）

### [严重] tmux 的 socket 文件还不存在时，任何 worktree 都删不掉（恒 500）
- 位置：`vibe-remoted/internal/session/projects.go:603-613`（`sessionTableCurrent`）、`projects.go:683-686`；根因在 `vibe-remoted/internal/session/runner.go:142-146`（`isNoTmuxServer` 只认 `no server running` / `no sessions`）。
- 证据：临时 daemon（`use_tmux:true`，独立端口、`state_dir`、全新的 `TMUX_TMPDIR`，`allowed_roots` 只有 `/tmp/vr-r2-*/roots`），仓库里 `git worktree add -b feat ../repo-worktrees/feat`，没有开过任何终端会话：
  - `GET /api/v1/worktrees/status` → 200，`sessions: []`。
  - `POST /api/v1/worktrees/remove {path, head, sessions: []}` → **HTTP 500** `{"endedSessions":[],"error":"worktree_remove_failed","message":"could not read the running sessions from tmux, so the sessions in this worktree are not known; nothing was removed. Try again"}`，目录还在。重试结果相同。
  - daemon 日志：`tmux list-sessions failed: exit status 1 (stderr="error connecting to …/tmux-501/vibe-remote (No such file or directory)")`。tmux 3.6a 对「socket 文件不存在」说的是 `error connecting to … (No such file or directory)`，不是 `no server running`（后者只在 socket 文件还在、server 已退出时出现）。
  - 同一份配置、同一个仓库换成基准 `e278f87` 构建的 daemon：同一请求 → **HTTP 200** `{"removed":true,…}`。
  - 对照（同一个新 daemon）：先让 socket 文件存在（`tmux -L vibe-remote new-session -d 'sleep 0.3'` 结束后 `list-sessions` 报 `no server running on …`）→ 删除 200；`PATH=/usr/bin:/bin`（没有 tmux）启动 daemon → 删除 500，日志 `exec: "tmux": executable file not found in $PATH`。
  - 触发面：机器重启后（`/tmp` 随重启清空的系统上，`/tmp/tmux-<uid>/` 里的 socket 没了）到第一次开终端会话之前；只用对话界面的用户（对话会话不经过 tmux，socket 永远不会被建出来）；`use_tmux:true` 而机器上没装 tmux（`exec` 找不到程序，同样不是 `ExitError`）。这几种情况下「Try again」永远不会成功，界面上没有任何出路。
- 依据：spec 的删除 worktree 场景（R5 系列：没有会话、没有改动的 worktree 应能直接删除）；rulings 待验证 1 的裁决是「对账没应用时重试一次，仍不成功就在动手前返回 500」，前提是「没应用」只代表瞬时故障——这里它是稳定状态。清单「错误路径：外部调用失败」。
- 改法：`liveTmuxSessions` 把「socket 不存在」（`error connecting to … (No such file or directory)`，或更稳妥地：先 `os.Stat` socket 路径 / 判断 `ENOENT`）和「tmux 可执行文件不存在」都当作「没有任何 tmux 会话」返回 `(空表, true)`；这两种情况下不可能有终端会话。只有「server 在、查询失败」才算对账失败。补一个 `use_tmux:true` + 全新 `TMUX_TMPDIR` 的删除用例（现有 `TestRemoveWorktreeAfterRestartNeedsTheSessionsFromTmux` 只覆盖了注入的查询失败）。
- 类别：明确错误（本批修复引入的回归）

### [严重] git 低于 2.31 的机器上，G4 的改法让「看一眼 worktree 状态」重新执行仓库配置里的 `core.fsmonitor` 程序（相对 e278f87 是回归）
- 位置：`vibe-remoted/internal/session/worktree.go:70-91`（`gitEnv` 只靠 `GIT_CONFIG_COUNT/KEY/VALUE`）、`worktree.go:331`、`worktree.go:343`（`DirtyFiles` / `IgnoredFiles` 原有的 `-c core.fsmonitor=false` 被删掉）。
- 证据：`GIT_CONFIG_COUNT` 是 git 2.31 才有的；更早的 git 直接忽略这三个环境变量。在临时目录里从源码构建了 git 2.30.2（Debian 11 的版本；Ubuntu 20.04 是 2.25.1），用它跑待审代码已有的用例（不改任何文件，`PATH=<git-2.30.2>:$PATH GIT_EXEC_PATH=<git-2.30.2>`）：
  - `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=false git config --get core.fsmonitor` → 2.30.2 无输出、退出码 1；`git -c core.fsmonitor=false config --get core.fsmonitor` → `false`；本机 git 2.50.1 两种写法都是 `false`。
  - HEAD `c74e715`：`TestReadOnlyGitRunsNoRepositoryProgram` FAIL（`WorktreeStatus ran the repository's core.fsmonitor program`）、`TestCreateAndRemoveWorktreeDoNotRunFsmonitor` FAIL（`removing a worktree ran …`）、**原有的** `TestDirtyFilesDoesNotRunFsmonitor` FAIL（`the repository's core.fsmonitor program was run`）、`TestGitEnvKeepsInheritedConfig` FAIL。
  - 基准 `e278f87`（`git archive` 到临时目录）同一个 git 2.30.2：`TestDirtyFilesDoesNotRunFsmonitor` PASS。
  - 也就是：修复前，删除确认框的状态查询在任何 git 版本上都不运行这个程序；修复后在 2.16–2.30 的 git 上又会运行。仓库里没有任何地方写明最低 git 版本（`docs/`、CLAUDE.md、README 都没有）。
- 依据：rulings G4（「在 git 环境里统一关掉」+ 新增不变规则）；`.devflow.yml` 新增的规则「daemon 运行的 git 不执行仓库配置指定的程序」——它的 check 在这类机器上不通过；清单「外部影响和不变规则：项目 invariants 的检查命令都还能通过」。实际可利用面有限（要能写该仓库的 `.git/config`），但这是把已有的保护换成了一个在常见 LTS 发行版上不生效的写法。
- 改法：`gitWithin` 里把 `-c core.fsmonitor=false` 作为 git 的参数加在最前（`git -c core.fsmonitor=false -C <dir> …`）：所有版本都认，git 会经 `GIT_CONFIG_PARAMETERS` 传给自己起的子进程（`worktree remove` 里的 status），环境变量那一套可以保留也可以去掉。或者在启动时探测 git 版本、低于 2.31 就退回逐条 `-c`，并把最低版本写进文档。
- 类别：明确错误（本批修复引入的回归）

### [一般] `git worktree add` 到时限被杀后，撤销清不掉，留下一个界面上既删不掉、也不能重建的 worktree
- 位置：`vibe-remoted/internal/session/worktree.go:752-754`（`gitWithin(gitTreeTimeout, … "worktree", "add" …)` 失败后 `claim.undo()`）、`worktree.go:876-879`（撤销用 `worktree remove --force`，单个 `--force` 删不掉被锁的项）；`projects.go:729-736`（删除时见 `Locked` 一律拒绝）。
- 证据：在自己的副本（`/tmp/vr-r2-*/copy`，`c74e715`）里加临时用例 `TestR2KillDuringWorktreeAdd`：仓库里配一个不返回的 smudge 过滤器（检出卡在写文件的中途，与现有 `TestStuckGitReleasesTheRepositoryLock/worktree_add_during_create` 不同——那个用例的假 git 在真正的 git 启动之前就睡着了，杀掉时磁盘上什么都还没有），`gitTreeTimeout` 调到 3 秒，`Manager.Create(… WorktreeName:"slow")`：
  - 返回：`create worktree: git worktree add --detach …/devflow-worktrees/slow …: no answer within 3s: context deadline exceeded; cleanup: worktree … not removed: git worktree remove --force …: exit status 128: fatal: cannot remove a locked working tree, lock reason: initializing … ; directory … not removed: … directory not empty`
  - `git worktree list --porcelain`：`worktree …/slow` / `HEAD 7dedeb5…` / `detached` / **`locked initializing`**；目录里有 `.git`、`.gitattributes`、`README`（检出了一半）；`.git/worktrees/slow/` 里留着 `locked` 和 **`index.lock`**；分支 `slow` 已被撤销删掉；没有创建记录。
  - 再用同名新建：`worktree directory already exists`（预检也是 `worktree_path_exists`）。
  - `WorktreeStatus` 正常返回（detached、`dirtyFiles:7`、`managed:false`），侧边栏会多出一行 detached 的「外部」worktree；`RemoveWorktree`（带 `discardFiles`）→ `this worktree is locked with git worktree lock (reason: initializing); unlock it first: git worktree unlock <path>`。
  - git 在 `worktree add` 期间自己给新 worktree 写 `locked`（内容 `initializing`），正常结束才删；被 SIGKILL 时来不及清。
- 依据：本批修复把「git 不返回」从「一直等」改成「5 分钟后杀掉并撤销」（rulings 待验证 2：「超时按失败处理并释放锁」）；CLAUDE.md 新写的「失败时 `Undo` 只撤销本次占到的东西……清不掉的留在原处并写进 `message`」——这里留下的全是本次自己占到的东西，却清不掉；用户只能上远程机器手动 `git worktree unlock`。清单「错误路径：外部调用失败、超时」。
- 改法：`worktreeClaim.undo()` 里，对认定是本次自己的那一项（目录是本次 `os.Mkdir` 占到的，且 detached 在本次的提交上 / 在本次的分支上）用 `git worktree remove --force --force`（两个 `--force` 才能删被锁的项；这一项是不是自己的仍按现在的状态判断，不看 git 的文字）；补一个「检出中途被杀」的用例（smudge 过滤器或 post-checkout 之前的等待）。
- 类别：明确错误（本批修复引入的新路径；daemon 自己在 `worktree add` 中途崩溃时也是同样的残留，那是原有情况）

### [一般] G2 新加的「建好后读一次列表」读不成时，撤销留下目录却删了分支：剩下一个「还没有提交」的 worktree
- 位置：`vibe-remoted/internal/session/worktree.go:764-767`（`claim.registered()` 失败 → `claim.undo()`）、`worktree.go:860-864`（撤销里列表读不到只记一条 problem，继续往下）、`worktree.go:892-894`（不管 worktree 删没删掉都 `update-ref -d` 分支）。
- 证据：副本里的临时用例 `TestR2ReadBackFails`：假 git 在 `symbolic-ref` 之后让 `worktree list` 失败（相当于刚检出完一个大目录、机器正忙时这一次 5 秒超时），`CreateWorktree(… Name:"feat")`：
  - 返回 `read the new worktree back: git worktree list --porcelain: … ; cleanup: registration of …/feat not checked: … ; directory …/feat not removed: … directory not empty`——没有提到分支。
  - 之后真实的 `git worktree list --porcelain`：`worktree …/devflow-worktrees/feat` / `HEAD 0000000000000000000000000000000000000000` / `branch refs/heads/feat`；`branchOID(feat) = ""`（分支被撤销删了）；在留下的目录里 `git status --short --branch`：`## No commits yet on feat`，`A  README`、`A  a.txt`。
  - 也就是：worktree 本身建成功了，只因为多读的这一次没读成，结果是目录原样留下、它检出的分支被删掉。之后有人在这个目录里提交，会得到一个没有历史的根提交。
- 依据：rulings G2（「找不到对应项按失败撤销」）；CLAUDE.md「`Undo` 只撤销本次占到的东西……清不掉的留在原处并写进错误的 `message`」——这里 message 没说分支已删，留下的状态也不是「原处」。清单「错误路径」「状态变更不是原子的」。
- 改法：(1) 撤销里，worktree 没能确认已删除（列表读不到、`worktree remove` 失败）时不要删分支，把「目录和分支都留着」写进 message；(2) 读回失败不必直接判创建失败：重试一次，仍读不到时可以退回 `filepath.EvalSymlinks(claim.root)` + 原分支名（比撤销一个已经建好的 worktree 损失小）。补一个「读回失败」的用例。
- 类别：明确错误（G2 的修复引入的新失败路径；撤销「先删分支不看 worktree 删没删掉」是原有写法，这条新路径让它更容易走到）

### [一般] `.devflow.yml` 新增的规则「daemon 运行的 git 不执行仓库配置指定的程序」写得比代码能保证的宽
- 位置：`.devflow.yml` 最后一条 `rule`（本批新增）；`vibe-remoted/internal/session/worktree.go:63-69` 的注释（「the daemon's looking at a repository must not run one」）。
- 证据：
  - 只读的状态查询会运行仓库配置的 clean 过滤器。副本里的临时用例 `TestR2StatusRunsCleanFilter`：worktree 里 `.gitattributes` 写 `*.txt filter=probe`，仓库配置 `filter.probe.clean=<记录脚本>`，提交 `a.txt` 后只改它的 mtime（相当于编辑器原样保存一次），调用 `Manager.WorktreeStatus` → `dirty=0`，记录文件出现（`the repository's clean filter ran: true`）。git 为了判断文件有没有变，要用过滤器重算一遍内容。
  - 写操作更不用说：`git worktree add` 会运行 smudge 过滤器和 post-checkout hook（上面 `TestR2KillDuringWorktreeAdd` 就是让仓库配置的 smudge 程序在 daemon 的 `worktree add` 里跑了 3 秒；`gitWithin` 自己的注释也写着「a hook, a pager」）。
  - 规则的 check 只测了 `core.fsmonitor` 一种。
- 依据：rulings G4 的原话是「daemon 的**只读** git 调用不执行仓库配置指定的程序」，落到 `.devflow.yml` 时去掉了「只读」；即使加回去，clean 过滤器这一条也不成立。清单「新增的规则有没有配检查」「文档」。
- 改法：把规则改成它实际守住的那件事：「daemon 运行的 git 不运行 `core.fsmonitor` 指定的程序」；过滤器和 hook 属于 git 自己的行为，在 design / CLAUDE.md 里写一句不在保证范围内。若确实要「只读调用不执行任何仓库程序」，需要另行设计（git 没有一次性关掉过滤器的开关），不是这条规则现在的 check 能证明的。
- 类别：明确错误（规则文字与代码不符；CLAUDE.md 那一句只说 `core.fsmonitor`，是对的）

### [一般] 删除成功后、刷新回来之前，「正在删除…」的行变回一条可以点的普通行
- 位置：`desktop/src/renderer/worktree-dialogs.ts:627-630`（`finally` 里 `setInFlight(false)`，早于调用方的刷新）、`desktop/src/renderer/index.ts:1373-1380`（标记清掉并 `renderSidebar()` 之后才 `await refreshAllMachines(true, mk)`）。
- 证据：副本里的临时脚本 `desktop/scripts/r2-removing.mjs`（jsdom + `loadIndex()`，假 daemon；删除应答 200 之后让 `/api/v1/projects` 的应答晚到）：
  - `removal request in flight: removing=true, tag="正在删除…", new-session disabled=true, "+ 新建会话" disabled=true`
  - `removal answered 200, refresh of /projects still under way: removing=no, tag="", new-session disabled=false, "+ 新建会话" disabled=false`
  - `refresh answered: the row is gone`
  - 中间这一段的长度就是 `/api/v1/projects` 的耗时：平时几十毫秒，同一台机器上有仓库的 git 卡住时是 5 秒（D1 修的正是这种情况）。这段时间里点「新建会话」会在一个已经不存在的目录上走新建流程。
- 依据：rulings D7（「与 `reloadingSessions` 同样的做法；防重复提交」）；用户在意的「刚删掉的 worktree 又闪回来」。
- 改法：成功（`outcome.removed`）时把标记留到 `refreshAllMachines(true, mk)` 结束之后再清（失败 / 409 / 取消仍在重开确认框之前清）；或者成功时先从 `machineProjects` 里摘掉这一行再渲染。
- 类别：明确错误

### [一般] G5 改成按工作目录判断后，daemon 重启前后对同一个会话给出不同结论：重启后会结束一个侧边栏上挂在别处的会话
- 位置：`vibe-remoted/internal/session/projects.go:519-532`（`sessionsIn` 的 `within(root, s.workdir)` 现在对所有会话生效）；`manager.go:773-778`（`applyTmuxSessionMetadata`：找回的会话 `Workdir` 取 tmux 的 `pane_current_path`，是进程**现在**的目录，不是创建时的目录）。
- 证据：副本里的临时用例 `TestR2RecoveredSessionThatChangedIntoWorktree`（独立 `TMUX_TMPDIR`）：仓库 `devflow` 有 worktree `feat`；终端会话建在主目录，命令是 `sh -c 'cd <feat> && exec sleep 60'`（相当于 `claude_cmd` 是 bash / codex 时用户 `cd` 了一下）。
  - 同一个 daemon：会话 `workdir = project = home = …/devflow`；`WorktreeStatus(feat).sessions = []`。
  - 新建一个 Manager（模拟 daemon 重启）：项目树里这个会话仍在主目录行下（`devflow main=true sessions=[id]`，`feat sessions=[]`），`WorktreeStatus(feat).sessions = [id]`；按确认框的做法把 status 原样带回 → `Removed:true EndedSessions:[id]`，tmux 会话没了。
  - 桌面端确认框只写数量（`wt.delete.sessions`：「会先结束这 {n} 个会话。」，`worktree-dialogs.ts:410`），不列是哪几个；这一行在侧边栏上显示「没有会话」，用户看不出被结束的是主目录下那个会话。
  - e278f87 的 `sessionsIn` 只对「还没有归属」的会话看工作目录，有归属的会话不会因为 `cd` 被算进来。
- 依据：spec H19（「会话归属哪个 worktree 按创建时的目录定，不随进程里 `cd` 变化……否则 R5.6 也会结束错会话」）；rulings G5 要补的是「归属在别处、目录在它里面的会话」。修复让「目录」在重启后变成了进程当前目录，重启前后行为不一致。对 `claude` 本身影响小（它的进程不换目录），终端模式是 agent 无关的，换成 shell 类的命令就会遇到。
- 改法：二选一并写进 spec / design：(a) 按创建时的目录——把创建时的工作目录也存进 tmux 选项（和 `@vibe_remote_home` 一起），找回会话时用它而不是 `pane_current_path` 参与 `sessionsIn`；(b) 明确按「进程当前目录」——那就在运行中的 daemon 里也读 `pane_current_path`（两种情况结论一致），并让确认框列出会话名字（至少对不在这一行下的会话）。补一个重启后的用例。
- 类别：取舍（需要先定口径：H19 与 G5 裁决的说法在这里相冲突）

### [一般] worktree 的目录有一轮轮询读不到（磁盘没挂上、目录被临时挪开）时创建记录仍被清，回来后永久变成「外部」
- 位置：`vibe-remoted/internal/session/projects.go:229-236`（`listsWorktreeDir` 把 `Prunable` 当成「没有」）、`projects.go:114-124`。
- 证据：副本里的临时用例 `TestR2DirectoryAwayForOnePoll`：`newRemoveFixture` 的 `fix-login`（`Managed:true`）→ `os.Rename(root, root+".aside")` → `Projects()` 一次 → 改回原名 → `Projects()`：`Managed:false`，`records []`。git 的列表里这一项始终在（只是那一轮带 `prunable`），分支也在；之后这个 worktree 的分支再也不能从界面删。
- 依据：rulings G1（「误删仍存在的创建记录」，要求三种触发方式各补用例）；这是同一后果的第四种触发方式。修复后的注释自己写的是「not having looked is not the worktree being gone, and a dropped record turns the worktree "external" for good」。G2 的场景（容器目录是指向另一块盘的符号链接）正好让它不罕见：那块盘有一轮没挂上，下面所有 worktree 的记录一次清光。design 第 10 节（decisions #82）写明「或已是 `prunable`」时清，所以这是有意的取舍，不是漏写。
- 改法：只在 git 的列表里**完全没有**这个路径时才清记录（`prunable` 的项保留记录：它不显示、也删不了，留着没有副作用；用户 `git worktree prune` 之后列表里没有了再清）。或者保持现状，在 tasks.md「后续」记一条。
- 类别：取舍

### [一般] CLAUDE.md 说创建记录「git 自己的列表里确实没有这个路径时才清」，代码在列表里还有这一项（`prunable`）时也清
- 位置：`CLAUDE.md`「项目与 worktree」一节第二条（「创建记录**只在所属项目本轮读成功、且 git 自己的列表里确实没有这个路径时才清**」）；代码 `projects.go:229-236`。
- 证据：见上面「目录有一轮读不到」那条的实验（列表里这一项一直在，带 `prunable`，记录被清）。design 第 10 节写的是「原始列表里没有这个路径（或已是 `prunable`）」，CLAUDE.md 少了括号里的一半。
- 依据：清单「文档」。
- 改法：随上一条的决定走——代码改成只在列表里完全没有时才清，这句话就对了；保持现状就把「或目录已不在（`prunable`）」补进 CLAUDE.md。
- 类别：取舍

### [一般] 名字的新规则拒绝了几类写法正确的名字，而提示说的是「git 不接受这个分支名」
- 位置：`vibe-remoted/internal/session/worktree.go:478-486`、`desktop/src/renderer/worktree-name.ts:16`、`desktop/src/renderer/i18n.ts:52,405`（`wt.name.invalid`）。
- 证据：两边各跑了一遍同一组名字（Go：副本里的 `TestR2Names`；桌面端：`/tmp` 里的脚本经 `scripts/chat-test-util.mjs` 加载 `worktree-name.ts`），结论一致：
  - 被拒（`invalid`）：带 ZWJ 的 emoji 序列（`fix-` + U+1F468 U+200D U+1F4BB）、波斯文里拼写必需的 ZWNJ（U+200C）、马拉雅拉姆文用 ZWJ 写的字母、希伯来文 / 阿拉伯文里的方向标记（U+200F、U+061C）、阿拉伯数字符号 U+0600。
  - 通过：不带连接符的天城文、希伯来文字母、`❤` + U+FE0F（变体选择符是 Mn 不是 Cf）。
  - 仍然通过的「看不见」字符（规则的目的没有完全达到）：U+034F（组合用字形连接符，Mn）、U+3164（韩文填充符，Lo）、U+2800（盲文空白，So）、U+FE0F 本身。
  - 桌面端对这些名字显示的是 `wt.name.invalid` =「git 不接受这个分支名」，而 git 是接受它们的。
- 依据：rulings G9（「含 Unicode Cf、Zl、Zp 类字符 → invalid」）；被拒是否可以接受需要写明：分支名里出现这几类文字的情况很少，换来的是「两个看上去一样的分支名」不会出现，**可以接受**；但提示把原因说错了，用户会去找 git 的规则。fix-desktop-report 的「后续」里已有一条「可以各给一句更具体的」。
- 改法：加一条文案（如「名字里有不显示的字符（零宽字符或方向控制符）」和「名字太长（最多 250 字节）」），`validateWorktreeName` 给这两种情况各自的原因码（共用向量的 `reason` 跟着改）；规则本身不动。
- 类别：取舍

## 待验证项

没有需要单列的待验证项：上面每条都有运行证据。没有做实验、也没有具体依据说会出错的方向，写在「覆盖范围」的最后。

## 覆盖范围

读过的代码（当前全文或本批 diff）：
- daemon：`session/worktree.go`、`session/projects.go` 全文；`session/manager.go`、`server/projects.go`、`server/server.go`、`server/ws.go`、`server/ws_chat.go`、`config/config.go`、`protocol/protocol.go` 的 diff 及相关函数（`syncFromTmux`、`liveTmuxSessions`、`isNoTmuxServer`、`applyTmuxSessionMetadata`、`reconcileTmuxSessions`）。
- 桌面端：12 个文件的全部 diff；`tree.ts`、`dirpicker.ts` 的主体、`worktree-dialogs.ts` 的确认框和删除流程全文、`index.ts` 里 `refreshAllMachines` 的 17 个调用点。
- 文档与规则：`rulings.md`、两份修复报告、`docs/protocol.md` / `CLAUDE.md` / `.devflow.yml` / `protocol-sync/SKILL.md` 的 diff，design 第 10 节相关行，spec 的 H19 和 R5 系列；评审清单。上一轮三份评审原文只按需查阅，没有通读。
- 测试 diff：`worktree_remove_test.go`、`worktree_test.go`、`projects_test.go`、`review_fixes_test.go`（session，约九成）读过；桌面端各脚本和 `gui-smoke.mjs` 只看了被删除 / 改写的行和几个用例。`server/review_fixes_test.go` 没有读。

跑过的实验（都在 `/tmp/vr-r2-*` 下，结束后已清理）：
- 临时 daemon（独立端口、`state_dir`、`TMUX_TMPDIR`、`CLAUDE_CONFIG_DIR`，`allowed_roots` 只有临时目录）：HEAD 与基准 `e278f87` 各一份，全新 tmux 目录 / socket 已存在 / 没有 tmux 三种情况下删除 worktree。
- 自己的副本（`git worktree add --detach`，`c74e715`）里的临时 Go 用例 8 个：检出中途被杀、目录一轮读不到、6 万未跟踪文件的耗时、重启后 `cd` 进 worktree 的会话、读回失败、clean 过滤器、名字规则样例、全部码位的规则结论；临时桌面端脚本 2 个（名字规则对照、删除成功后的行状态）。
- 从源码构建 git 2.30.2，用它跑待审代码和基准的 fsmonitor 用例。
- 待审 worktree 上原样运行：`go test -race -timeout 10m ./internal/...`（5 个包全部 ok，session 245 s、server 64 s）；`npm run typecheck && npm test`（退出码 0，306 行 ok）；`gui-smoke.mjs`（46 行 PASS，退出码 0）。`git status --short` 始终为空。

核对过、没有发现问题的方向：G8 的 409 循环；D1 的应答次序（含机器编辑 / 删除后的在途应答、`listSessions` 与 `listProjects` 各自发布时的短暂不一致——`buildTree` 会按旧规则安置没被树引用的会话、跳过已不在列表里的 id）；D4 等 info；D9 的焦点；G7 的耗时；`gitEnv` 对已有 `GIT_CONFIG_*` 的追加（`TestGitEnvKeepsInheritedConfig` 通过；daemon 环境里若另有 `GIT_CONFIG_PARAMETERS` 设了 `core.fsmonitor`，它排在后面会盖过去——只读了 git 的处理次序，没有做实验，也不认为是现实场景）；协议三处（`branch`、`no_commits`、400 / 409 / 413 / 500 各状态码、`ProjectsResponse`）在 `protocol.go`、`protocol.ts` / `rest.ts`、`docs/protocol.md` 与处理代码之间一致。

没来得及看、或没有验证的：
- `rev-list --count` 的 30 秒时限在超大仓库（百万级提交且分支上有大量未合并提交）上会不会让正常的删除变成失败：没有这样的仓库可测；常见情况下只遍历未合并的那一段（修复者写在代码注释里的实测是 2 万个未合并提交 0.08 秒，我没有复测）。
- `git worktree remove` 到 5 分钟被杀后的状态只做了代码推演（`.git` 文件先被删时这一项变成 `prunable`，按「git 已不再列出」处理并报告残留路径），没有实际杀一次。
- tmux 调用本身没有时限（`tmuxCmd(...).Output()`），删除时在仓库锁内调用 `syncFromTmux`；这是原有写法，本批没有改，没有展开。
- 真实布局只依赖 `gui-smoke` 的检查，没有另外人工操作临时实例（D9 的菜单跟随、D7 的行外观没有在真实窗口里看）。
- 桌面端在 Electron 44 自带的 ICU 下的 `\p{Cf}` 集合没有单独核对（用的是 Node 22 / Unicode 17，与 Go 的 Unicode 15 结论相同）。
