> 机器关口 C 第 2 轮（返工复验），2026-11-20，被测提交 `482ab63`。本轮先派的验证者是 codex（另一个模型），它的运行约 4 分钟后被其平台的内容安全过滤中止，没有产出结论；按 `verify.models` 的顺序退到同一模型的全新验证者，下面是它的结论全文。第 1 轮（提交 `91e0fab`，不通过）的两份结论在 `verdict-history.md`。验证者的实验源码和完整输出不在仓库里，位于本机 `.devflow-tmp/gate-c2/same-evidence/`。

# 关口 C 第 2 轮独立验证结论（同模型的全新验证者）

- 结论：**通过，有备注**。第 1 轮的 7 个问题和 2 条测试备注，原反例原样重跑全部不再出现；全部检查通过；三份界面冒烟在最终代码上首次运行即全过。新发现 5 条（N-1 – N-5），都发生在很少见的环境或输入下，按本轮给定的标准（用户会遇到的才拦）都不拦，但 N-1、N-2 我认为风险被低估，建议合并前处理或交用户决定——见「问题」。
- 提交：482ab63df9ec109e0f991834b5e267cd118ffbfb
- 验证快照：{"schema":1,"docs_dir":"docs/changes","head":"482ab63df9ec109e0f991834b5e267cd118ffbfb","head_tree":"81f7194080ef794484d8e6eefa77c0cef647e44dbaa60bb506c272aabcd6ed80","target":"6d88e45f511b92b84d46bca1ffd917afae548221","target_tree":"b58c4926876d6dca94d03f0e017504a74b2a24ec80eff298d3a5f37737ec1751"}
- 验证者：Claude（Fable 5，模型 id `claude-fable-5-2[1m]`），独立验证者，没有写过这段代码，没有派发子 agent。codex 本轮不可用（运行被其平台的内容安全过滤中止，没有产出结论），按 verify.models 的顺序退到同一模型的全新验证者。
- 问题数量：5 条新发现（0 条拦；2 条建议合并前处理），另有 2 条说明。

## 环境版本

开始时（`/Users/mac/github/vibe-remote/.devflow-tmp/verify-482ab63`）：

```
$ git rev-parse HEAD
482ab63df9ec109e0f991834b5e267cd118ffbfb
$ git status --short
（空）
$ git diff --stat 91e0fab..HEAD -- desktop .claude
（空：桌面端和 .claude 自第 1 轮的提交起没有改动）
```

结束时（停掉我启动的全部进程、删掉临时目录和两个临时 worktree 之后）：

```
$ git rev-parse HEAD
482ab63df9ec109e0f991834b5e267cd118ffbfb
$ git status --short
（空）
$ git diff --name-only; git diff --cached --name-only
（空）
$ git status --short --ignored | grep -v node_modules
!! desktop/dist/        ← 界面冒烟的构建产物（被忽略）
```

工具：go 1.26.2 darwin/arm64、node v22.22.2、git 2.50.1 (Apple Git-155)、tmux 3.6a。

运行的都是这个提交：检查和脚本在上述 worktree 里运行，脚本各自从它构建临时 daemon、假 claude 和桌面端；我自己的 Go 实验在 `git worktree add --detach /tmp/vr-v2c-*/wt 482ab63` 的副本里（只新增测试文件，没有改产品代码），daemon 实测的二进制是从上述 worktree `go build` 到 `/tmp` 的（脚本打印 `daemon built from 482ab63…`）。对照用的 `91e0fab` 副本同样是临时 worktree。

安全约束：没有访问 8765；没有对默认 tmux socket 目录执行任何命令；所有用到 tmux 的命令都带独立的 `TMUX_TMPDIR`；临时 daemon 的 `allowed_roots` 只有我在 `/tmp` 下建的目录；没有向不是我启动的进程发信号；token 没有进入任何输出或文件。结束时 `ps` 里只剩用户自己的 tmux（1401、5607、85201）和用户的 daemon；我建的 `/tmp/vr-v2*` 目录、两个临时 worktree 都已删除（`git worktree list` 里没有它们）。`/tmp/vr-api-*`、`/tmp/vr-codex-*`、`/tmp/vr-diff-copy` 是第 1 轮留下的，只读过、没有动。

证据：实验源码和各条命令的完整输出在 `/Users/mac/github/vibe-remote/.devflow-tmp/gate-c2/same-evidence/`（不在仓库里；已扫描过，没有 token）。

## 检查

每条都在最终代码上由我重跑，一个一个跑。

| 命令 | 结果 |
|------|------|
| `cd vibe-remoted && gofmt -l .` | 退出 0，无输出 |
| `cd vibe-remoted && go vet ./...` | 退出 0，无输出 |
| `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d /tmp/vr-v2-XXXXXX) go test -race -count=1 -timeout 25m ./...` | 退出 0。五行 `ok`：`internal/chat` 18.7 s、`config` 3.1 s、`protocol` 2.7 s、`server` 63.4 s、`session` 316.6 s |
| `cd desktop && npm run typecheck` | 退出 0 |
| `cd desktop && npm test` | 退出 0；311 行 `ok`，0 行 `not ok` |
| `.devflow.yml` 的 18 条命令型 `check`，原样交给 zsh，前面加 `GOFLAGS=-count=1` | 18 条都退出 0，没有一行 `(cached)`。第 13 条的 `./internal/server` 是 `[no tests to run]`（那几个用例都在 session 包，与第 1 轮相同）。71 个用例名逐个在源码里核对过，都存在 |
| `/protocol-sync`（第 2 条） | `protocol.go`、`protocol.ts`、`rest.ts` 自 91e0fab 起无改动（`git diff --stat` 为空），字段沿用第 1 轮逐项核对的结果。返工改的三处说明对着处理代码和临时 daemon 的实际应答核对：预检的 400（三种 `message` 与 `handleWorktreePlan` 逐字相同，实测见下）、删除的 409（`RemoveWorktree` 重读列表项，比较 `Head` / `Branch` / `Detached` 三样）、删除的 500（`endSessionConfirmed` 没确认结束 → `endedSessions` 只含已确认的、其后的会话不再结束；重读不到 → 500）都与代码一致。一处边角不一致见 N-5 |
| `node .claude/skills/verify/scripts/ws-worktree-smoke.mjs` | 退出 0，9 PASS / 0 FAIL |
| `node .claude/skills/verify/scripts/ws-chat-smoke.mjs` | 退出 0，9 PASS / 0 FAIL |
| `ws-smoke.mjs`（对我自建的临时 daemon：随机端口、`/bin/bash`、独立 `state_dir` 和 tmux 目录、`allowed_roots` 只有自建目录） | 退出 0，12 PASS / 0 FAIL |
| `TMUX_TMPDIR=… node …/gui-smoke.mjs` | 第 1 次：46 PASS / 0 FAIL，退出 0 |
| `TMUX_TMPDIR=… node …/gui-chat-smoke.mjs` | 第 1 次：29 PASS / 0 FAIL，退出 0 |
| `node …/gui-worktree-smoke.mjs`（完整构建） | 第 1 次：68 行 PASS / 0 FAIL，`65 cases: R1 8/8, R2 7/7, R3 10/10, R4 6/6, R5 12/12, R6 2/2, R7 5/5, R8 6/6, R9 2/2, other 7/7`，退出 0 |

三份界面冒烟都没有失败用例，所以没有重跑。

额外跑的一次（不在要求里，为了列出跳过的用例）：`go test -count=1 -v`（**不带 `-race`**）跑五个包，839 行 PASS、**0 个 SKIP**（本机上 c6 和 `TestGitTimeoutKillsProcess` 都执行了断言），但 `TestProjectStoreRemoveWorktreeIfSame` 失败。这是 tasks.md「后续」里记过两次的已知偶发（先删再加同一条记录，两次时间戳落在同一微秒）；返工没有动这个文件。单独重跑 200 次：不带 `-race` 失败 33 次，带 `-race` 失败 0 次。`make check` 用的是 `-race`，所以要求的检查是通过的；见「问题」的说明 1。

## 第 1 轮问题的复验

做法：把第 1 轮验证者留在 `/tmp/vr-codex-tmux-n588mgcz/…/codex_probe_test.go`（tmux 的四个反例、同提交切分支）和 `/tmp/vr-diff-copy/…/independent_diff_test.go`（撤销删掉别人的 worktree、换行路径）的反例**一个字不改**复制进 482ab63 的临时副本（辅助函数和测试钩子的名字都还在，直接能编译），独立 `TMUX_TMPDIR` 下运行：

`TMPDIR=/tmp TMUX_TMPDIR=<独立目录> go test -count=1 -timeout 5m -v ./internal/session -run '^(TestCodex|TestIndependent)'` → 退出 0，全部 PASS（在 91e0fab 上它们是 FAIL）。P7 用临时 daemon 实测。每条再读开发方加的回归用例，看它守的是不是同一个缺陷。

| 问题 | 重跑的反例和实际输出 | 开发方的回归用例 | 结论 |
|------|----------------------|------------------|------|
| P1（X9）撤销删掉别人的 worktree | 同分支：`external file data="someone else's work" read_error=<nil>; branch=<oid>`，message 带 `directory … not removed: git lists a worktree in it, and this create, whose own git worktree add did not go through, cannot take it for its own; branch fix-login kept: the worktree in … is on it`。detached 同提交：文件同样还在 | `TestUndoLeavesAWorktreeSomeoneElseAddedAtTheSamePath`（同分支、detached 同提交、建分支之前被占三例，另用记录参数的 git 断言没有执行过 `worktree remove`）、`TestUndoAfterWorktreeAddFailedOnItsOwn`：同一时序、同一断言，还多守了一条同类路径 | 已解决 |
| P2（X10）结束会话失败仍删目录、假报已结束 | `result={Removed:false … EndedSessions:[]} error=*session.WorktreeRemoveError could not end session …: tmux kill-session failed (exit status 1), and tmux could not be read … The worktree was not removed directoryExists=true`；SIGUSR1 后 `tmux session alive=true; reported ended=[]` | `TestRemoveWorktreeStopsWhenASessionDidNotEnd`（同一反例，另验证 socket 恢复后同一请求成功）、`TestRemoveWorktreeConfirmsSessionsAgainstTmux`（读失败、仍在列表两例） | 已解决 |
| P3（X11）工作目录里的换行 / 制表符使会话漏掉或错位 | 两例都是 `parsedSessionCount=1 ok=true`、`status.sessions=[<id>]`、`removal={Removed:true … EndedSessions:[<id>]} tmuxAlive=false` | `TestSessionWhoseProcessIsInAnOddlyNamedDirectoryIsStillRead`（5 种名字 × 重启前后）、`TestSessionCreatedInAnOddlyNamedDirectoryIsStillRead`、`TestTmuxReadFailsWhenARecordDoesNotParse` | 已解决（UTF-8 环境下；非 UTF-8 的 locale 见 N-4） |
| P4（X12）socket 路径里有 `no sessions` | `liveTmux count=0 ok=false`；`removal={Removed:false … EndedSessions:[]} error=could not read the running sessions from tmux … directoryExists=true sessionAlive=true` | `TestIsNoTmuxServerGoesByTheWholeLine`、`TestSocketPathSayingNoSessionsIsNotAnEmptySet`（同一反例） | 报告的反例已解决；同一判断方式留下一个更偏的变体，见 N-3 |
| P5（X13）结束会话期间切到同提交的分支 / detach | other、detached 两例都是 `error=*session.WorktreeChangedError … dir=true originalBranch=<oid>` | `TestRemoveBranchSwitchedWhileEndingSessions`（同两例，另断言 `endedSessions` 如实、应答里的状态是切换后的） | 已解决 |
| P6（X14）路径带换行的 worktree 列不出来 | `list=[… {Path:…/external\nworktree …}]`、`WorktreeStatus=<nil>` | `TestListWorktreesPathWithNewline`（6 种名字，含在里面开会话、删除）、`TestListWorktreesFallsBackWithoutZ`、`TestParseWorktreeList` | 认 `-z` 的 git（2.36 起）上已解决。退回模式（更早的 git）是已记录的已知限制，但实际表现比记录的更差，见 N-1 |
| P7（X15）不存在的白名单内目录报成越权 | 临时 daemon：`missing, in the allowed root: 400 {"error":"invalid_request","message":"workdir does not exist"}`；文件 → 400 `workdir is not a directory`；白名单外（存在 / 不存在 / 经 `..`）、悬空链接、指向白名单外的链接（目标存在 / 不存在）→ 全是 403；无 token → 401 | `TestPlanMissingWorkdirIs400`（同一探测，另守「白名单外不回答存在与否」） | 已解决（一处边角见 N-5） |
| 备注 1：`TestGitTimeoutKillsProcess` 每次都 SKIP | `go test -race -v`：PASS，没有 SKIP；`-race -count=5`：5 次 PASS。用例里原来的 `t.Skip` 换成了 `t.Fatal` | — | 已解决 |
| 备注 2：c6 的跳过条件比「git < 2.31」宽 | 探测改成 `git config --get --default not-read vibe.inherited`，命令失败或输出别的都是 `t.Fatalf`；本机两个子用例 PASS、没有 SKIP | — | 已解决（这个跳过本身留不留仍是用户的 c6） |

我没有只看开发方的用例：每条都另外做了自己的反例（下面「问题」和「排除了的」）。

## 场景

受返工影响的场景：

| 场景 | 怎么验证的 | 结果 |
|------|-----------|------|
| R2.1（列出全部 worktree，含外部的）、R4.2（在任何已有 worktree 里开会话） | GUI：`PASS R2.1 …`、`PASS R4.2 …`；路径带换行 / 制表符 / 引号 / 反斜线的 worktree：第 1 轮反例 + 全量 Go 里的 `TestListWorktreesPathWithNewline`；临时 daemon 上 `/api/v1/projects` 列出 `…/trusted-worktrees/a\nfoo`、`worktrees/status` 200 | 通过（git ≥ 2.36；更早的 git 见 N-1） |
| R2 其余（R2.2–R2.7） | GUI 7/7 | 通过 |
| R3.5（目标目录已存在：不创建、不覆盖） | GUI：`PASS R3.5 … 目录已存在：…/occupied`；P1 的两个反例（创建途中目录被别人占走）不再删对方的文件 | 通过 |
| R3.8（创建失败：显示 git 的错误，不留半截，不出现新行） | GUI：`PASS R3.8 git fails while creating …`（`.git/worktrees` 不可写）；我的实验：smudge 过滤器失败 → 目录、登记、分支都没有留下，可以再建 | 通过；post-checkout 钩子失败这一种会留下一个 worktree（d70，已记录），见 N-2 |
| R5.6（先结束会话再删）、R5.12（部分失败如实报告） | GUI：`PASS R5.6 … both ended, their views closed, worktree removed`、`PASS R5.12 …`；P2 / P3 / P4 的反例；我的负载实验：24 个满载进程下 25 轮「2 个会话的 worktree、最后一个会话结束时 tmux server 退出」，0 轮失败，最慢一次 1.8 s（期间日志里有 23 次 `server exited unexpectedly`，都被重读接住） | 通过 |
| R5.9（动手前的拒绝）及「确认后变了就 409」 | GUI：`PASS R5.9 …`；P5 的两个反例；我的 4 个变体：新建同提交的分支、分支被改名、分支引用被外部移动 → 都是 409，目录在；切走又切回同一分支（没有变化）→ 照常删除，没有误报 | 通过 |
| R5 其余 | GUI 12/12 | 通过 |
| R9.2（旧桌面端 + 新 daemon） | GUI：`PASS R9.2 … ws-smoke.mjs of 6d88e45: 12 PASS, 0 FAIL; worktree mode without a name → vibe/<id>`；全量 Go 里的 `TestV3ClientFlowAgainstV4Daemon`；invariant 第 3 条 `TestTerminalFramesUnchangedV3`；读 tmux 的格式串是 daemon 每次读取时自己给的（`-F`），不存在 tmux 里，升级前已在运行的会话照常读到（`ws-worktree-smoke` 的「a terminal session from before the upgrade is counted and ended」PASS、第 1 轮的旧会话反例 PASS） | 通过 |

其余场景（R1、R3 其余、R4 其余、R6、R7、R8、R9.1）：桌面端代码自 91e0fab 起没有改动，沿用第 1 轮界面验证者的结论（通过，有备注 N1–N7；58 个场景里 50 个用真实指针和按键亲手走过）；daemon 改了，所以三份界面冒烟在最终代码上由我重跑了一遍：65 个用例全过（R1 8/8、R3 10/10、R4 6/6、R6 2/2、R7 5/5、R8 6/6、R9 2/2）。这一轮我没有用真实指针重走界面。

## 完成条件

| 条件 | 判断 | 依据 |
|------|------|------|
| R1–R9 的全部场景在 GUI 冒烟里通过 | 成立 | `gui-worktree-smoke.mjs` 在 482ab63 上 65 个用例全过 |
| `make check` 通过 | 成立 | `make check` 的五条命令（gofmt、vet、`go test -race -count=1 ./...`、typecheck、`npm test`）逐条运行，都退出 0（没有调用 `make` 本身，Makefile 里就是这五条） |
| `gui-smoke.mjs`、`gui-chat-smoke.mjs` 用例数量不减少、断言不放宽 | 成立 | 两份脚本自 91e0fab 起没有改动；第 1 轮已与基线逐行比过（`check(` 14 → 30，`test(` 26 → 26，旧断言都在）；本轮运行 46 / 0、29 / 0 |
| 协议在 `protocol.go` / `protocol.ts` / `docs/protocol.md` 三处一致 | 成立 | 见「检查」的 `/protocol-sync` 一行；P7 指出的那处不一致已改并实测。N-5 是文档没写到的一个边角，不影响这条的判断 |

## 问题

5 条新发现，都有自己运行出来的证据。按本轮的标准（用户会遇到的才拦）**都不拦**。要说明的是：第 1 轮验证者对触发条件同样少见的 P4（目录名里有 `no sessions`）、P6（路径带换行）判了拦，按那个标准 N-1 和 N-3 也会被拦；我的判断依据写在每条里，由关口和用户取舍。

### N-1 [一般，不拦，建议合并前改] 旧 git 的退回模式下，路径带换行的 worktree 不是「列不出来」，而是被读成另一个路径上的一项，那个目录会通过对话界面的信任规则

- 位置：`vibe-remoted/internal/session/worktree.go` 的 `parseWorktreeList`（按行解析时不认识的行直接跳过）；说法在 CLAUDE.md「项目与 worktree」第一段、decisions #146、design 第 10 节、tasks.md「后续」的「已知限制（X14）」。
- 这些地方写的是：按行读时，路径被拆成的两半「一个没有 HEAD、一个路径不是绝对路径」，都被去掉。这只对第二半以 `worktree` 开头的名字成立——回归用例 `TestParseWorktreeList` 只测了第 1 轮反例用的那一个名字 `external\nworktree`。
- 实验（`same-evidence/v2_probe_test.go` 的 `TestV2FallbackNewlinePath`；git 用一个对 `worktree list … -z` 回答 129、其余原样转给真 git 的包装脚本，即模拟 2.36 之前的 git；另在临时 daemon 上经 REST 重做，`same-evidence/daemon-probe.txt`）：
  - worktree 建在 `…/devflow-worktrees/a\nfoo`，旁边另有一个普通目录 `…/devflow-worktrees/a`（不是 worktree，里面放了一个指向该仓库管理目录的 `.git` 文件——目录的主人自己就能写，design V4）。只有主目录被信任。
  - 认 `-z` 的 git：列表是主目录和 `…/a\nfoo`；`ChatTrust(…/a) = untrusted`；`worktrees/status` 对 `…/a` 是 404。
  - 退回模式：列表是主目录和 **`…/a`（branch=nl）**；`ChatTrust(…/a) = trusted`；`GET /api/v1/fs?path=…/a` 返回 `chatTrust: "trusted"`；`/api/v1/projects` 里它是一行；`worktrees/status` 200（`dirtyFiles: 2`）；真正的 worktree `…/a\nfoo` 是 404。
  - 第二种名字 `…/a\nworktree /别处/evil`（换行后面接一个绝对路径）：退回模式下列表里出现的是 **`/别处/evil`**——任意一个绝对路径；`ChatTrust` 同样是 `trusted`。
  - 删除没有造成损失：对伪造的那一项 `RemoveWorktree` 得到 git 的 `'…' is not a working tree`，目录里的文件还在。
- 应有的结果：`.devflow.yml` 的规则「对话界面的信任只认目录本身，或仓库自己列出的 worktree 根」；文档自己写的「不当成 worktree」。
- 为什么不拦：要触发得同时有 2.36 之前的 git（Ubuntu 22.04 自带的 2.34 属于这一类）和一个路径里带换行的 worktree 登记在**已被信任的**仓库里。能往受信任仓库的 `.git/worktrees` 里写登记的人，本来就能在任意目录建一个真正的 worktree 并放上自己的 `.claude/settings.json`，所以它没有让谁多得到什么权限；普通用户碰不到。91e0fab 上任何版本的 git 都是这样，返工把 2.36 及以后的修好了。
- 为什么说风险被低估：这是一条写进 `.devflow.yml` 的安全规则的反例，而文档和决策记录把它写成了已经挡住。改法很小（按行读时，一个条目里出现不认识的行，或 `worktree` 行前面不是空行，就把相邻的条目都丢掉），至少要把文档改成实际的行为。

### N-2 [一般，不拦（已记录的已知限制 d70），建议交用户决定] post-checkout 钩子失败时，「创建失败」会留下一个 worktree；项目不在侧边栏时它在界面里看不见

- 临时 daemon 实测（`daemon-probe.txt`）：仓库的 post-checkout 钩子 `exit 2`（内容照 git-lfs 的钩子在找不到 `git-lfs` 时的写法）。新建命名 worktree `fix-login`：
  - 应答：`{"type":"error","code":"create_failed","fatal":true,"message":"… exit status 2: … git-lfs was not found on your path; cleanup: directory …/hooked-worktrees/fix-login not removed: git lists a worktree in it, and this create, whose own git worktree add did not go through, cannot take it for its own"}`。
  - 磁盘：目录在（`.git`、`README`），`git worktree list` 里是 detached 的一项，分支 `fix-login` 没有留下。没有会话。
  - 同名再建：预检 `{"ok":false,"error":"worktree_path_exists"}`，attach 是 fatal `worktree_path_exists`（带同一个 `newSessionId` 重放也是）。换一个名字 `second`：再留下一个。
  - 这个仓库此前没有开过会话时，`GET /api/v1/projects` 里**没有这个项目**（实测 `projects: []`）——从机器概览的「创建隔离 Worktree」走到这里，残留在侧边栏里看不见，同名重试只会看到「目录已存在」。项目已在侧边栏时，它是一行「外部」的 detached worktree（与 R3.8「侧边栏不出现新行」的字面不符）。
  - 能从接口删掉：`worktrees/status` 200（`detached:true, managed:false, dirtyFiles:0`），`worktrees/remove` 200，目录和登记都没了；钩子修好后同名能建。没有「同名永远建不了」的路径。
- 对照：91e0fab 上同一个实验，两次尝试都是 `dir exists=false listed=false branch=""`（撤销得干干净净）。这是返工为了 P1（不删别人的 worktree）换来的代价，decisions d70 和 tasks.md「后续」都记了。
- 为什么说风险被低估：d70 把风险定为「低」，理由之一是「在侧边栏里看得见、删得掉」——项目不在侧边栏时看不见。会遇到的仓库不算少：装了 git-lfs 钩子、而 daemon 的 PATH 里没有 `git-lfs`（launchd / systemd 启动、不经登录 shell）；husky 之类的钩子要 node，而 node 由 fnm / nvm 管理。这类仓库里每点一次「新建 worktree」都失败并多一个残留。开发方自己写了更好的做法（运行 add 之前记下 `<git 公共目录>/worktrees/` 里已有的登记，只认领新出现的那一个）。它改变了 R3.8 在这一类失败下的结果，建议像 c6、c7 那样让用户知情后决定。

### N-3 [低，不拦] `TMUX_TMPDIR` 的目录名里有换行、其中一行正好是 `no sessions` 时，P4 原样重现

- `isNoTmuxServer` 从「整段里找子串」改成了「逐行比较」，而 socket 路径可以带换行。实验（`TestV2NoSessionsLineFromPath`，目录 `/tmp/vr-a\nno sessions\nb-<随机>`，其余与第 1 轮 P4 的反例相同）：
  `tmux says: "error connecting to /private/tmp/vr-a\nno sessions\nb-…/tmux-501/vibe-remote (No such file or directory)\n"` → `liveTmux count=0 ok=true` → `removal={Removed:true … EndedSessions:[]} error=<nil> directoryExists=false sessionAlive=true`。
- 应有：第 ④ 种（对账失败），500、什么都不动。
- 不拦的理由：`TMUX_TMPDIR` 是启动 daemon 的人自己设的，没有人会在里面放换行。改法：只看 stderr 的**开头**（`error connecting to …` 永远以这几个词开头，后面的路径再怎么写也骗不过），或者 socket 文件不存在时不认第 ② 种。

### N-4 [一般，不拦] daemon 继承了非 UTF-8 的 locale 时，非 ASCII 路径下的会话在 daemon 重启后不算在它的 worktree 里

- tmux 3.6a 在客户端 locale 不是 UTF-8 时，把 `list-sessions` 输出里的非 ASCII 字节、制表符、换行都改写成 `_`（实测：`…/中文 dir` → `…/____ dir`，`tab\tx` → `tab_x`）。`utf8Env` 只在三个 locale 变量都没设时才补 UTF-8，继承来的 `LC_ALL=C` 原样保留。
- 实验（`TestV2InheritedCLocale`，`LC_ALL=C`，仓库在 `…/项目/devflow`）：重启后的 daemon 读到 `home:…/____/devflow-worktrees/feat`，`status.sessions=[]`，`removal={Removed:true … EndedSessions:[]} directoryExists=false tmuxSessionAlive=true`——P3 的后果，换了一个触发条件。纯 ASCII 路径在同样的 locale 下正常。
- 不是返工引入的：同一个实验在 91e0fab 上，ASCII 路径也一样坏（格式串里的制表符被改写，每一行都解析不了）。返工反而修好了 ASCII 的那一半。
- 不拦的理由：这种 locale 下终端里的框线和中文本来就被 tmux 改成 `_`（`utf8Env` 的注释写了），产品的主要功能看得见地是坏的，用户会先去改 locale。`.devflow.yml` 那句「目录名里的制表符和换行不改变读到的归属」只在 UTF-8 环境下成立，没有写这个前提。改法：读 tmux 时加 `-u`（实测 `LC_ALL=C tmux -u … list-sessions` 原样给出 `…/项目`）。

### N-5 [低，不拦] 预检对「路径中间是一个文件」回答 403「不在白名单内」

- `GET /api/v1/worktrees/plan?workdir=<白名单内>/afile/x`（`afile` 是普通文件）→ `403 {"error":"path not in allowed roots"}`。`EvalSymlinks` 给的是 ENOTDIR，不是「不存在」，所以没走新加的 400。docs/protocol.md 写的是不存在 → 400、不在白名单内 → 403，这一种哪边都没写到。目录选择器选不出这样的路径。

### 说明（不是新问题）

1. `TestProjectStoreRemoveWorktreeIfSame` 不带 `-race` 时 200 次失败 33 次（带 `-race` 0 次）。tasks.md 把它记成「机器负载高时各出现过一次」的偶发，实际频率高得多，只是 `make check` 一直带 `-race`。它同时说明 `RemoveWorktreeIfSame` 靠微秒时间戳区分新旧记录不严格（后果是创建记录被多删一次、worktree 变成「外部」，方向安全）。已在「后续」里，建议提前做。
2. 我没有用真正的旧 git 重做 N-1：2.36 之前的 git 是用包装脚本模拟的（只把 `-z` 变成 129，按行的输出来自 git 2.50.1，路径原样带换行——与第 1 轮 P6 的实际输出一致）。开发方在 2.30.2 和 2.34.1 上实测过退回本身。

### 排除了的（做了实验，没有问题）

- tmux 的随机标记（d69）：标记由 `crypto/rand` 的 8 字节生成，每次读取不同；格式串每次由 daemon 经 `-F` 给出，不存在 tmux 里。真实 tmux 上，用户选项和当前目录里的制表符、换行、中文、`ESC`、`\r`、`<vr-0123456789abcdef>` 和 `<vr-…-end>\n` 样子的内容、`#{session_name}`、`#(touch …)` 都原样读回、字段不串位，`#(…)` 没有被执行；别人开在这个 socket 上的会话被跳过、不算读取失败（`TestV2OddFieldValues`，三次读取）。
- 解析失败的处理：所有调用点（`List`、`Attach` 的找回、`Projects`、删除前的对账、结束会话后的确认）都把失败当作「没读到」，不清会话表、不释放占用；没有找到能让解析持续失败的现实输入。
- 结束会话后的确认：见场景表的负载实验；对话会话和不用 tmux 的终端会话走原来的 `Delete`，不受影响（GUI R5.6 是终端 + 对话各一个）。
- 撤销的认领规则：自己的 `worktree add` 中途自己失败（必需的 smudge 过滤器失败）→ git 自己收回，目录、登记、分支都不留，可以再建；被时限杀掉的那一种由 `TestWorktreeAddKilledDuringCheckoutIsUndone` 守着（invariant 第 18 条，通过）。
- `-z` 的退回：只有退出码 129 才退回，其它失败照常报错（`TestListWorktreesFallsBackWithoutZ` 的 128 一例）；「认不认」按 `exec.LookPath("git")` 的结果记，daemon 的 PATH 运行期间不变；git 被原地换成更旧的版本时，下一次读取得到 129 后当场退回。按行读时去掉的只有「路径不是绝对路径」或「没有 HEAD 且不是 bare」的条目，真实的 worktree 两样都有，不会被丢掉。

## 待验证项

| 项 | 影响 | 下一步 |
|----|------|--------|
| 其它版本的 tmux（Ubuntu 22.04 的 3.2a、Debian 12 的 3.3a、Ubuntu 24.04 的 3.4） | 读 tmux 的格式是全部终端会话的入口，返工改了它；我只在 3.6a 上验证过。标记是可打印的 ASCII，看不出哪个版本会改写它，但没有实跑 | 在目标 Linux 上跑一次 `ws-worktree-smoke.mjs` 和 `go test ./internal/session -run 'OddlyNamed|TmuxReadFails'` |
| 真正的旧 git（2.30 / 2.34） | 退回模式我用包装脚本模拟（见说明 2）；开发方的实测在 `evidence/gate-c-1-rework.md` 第 3 节，我没有重建旧 git 复核 | 修 N-1 时在真的 2.34 上跑一遍 |
| 真实键盘经 macOS 菜单和输入法（R7） | 沿用第 1 轮：CDP 的按键不经过原生菜单分发 | 人在打包后的 app 里按一遍（test-report.md 有步骤） |
| 冷启动首帧之前约 0.1 秒、原生通知的点击、真正的旧版桌面端、真实 claude 和远程 Linux | 沿用第 1 轮界面验证者的待验证项，这一轮没有新的证据 | 同第 1 轮 |
| 真实指针重走界面 | 这一轮界面只跑了三份冒烟（大多数用例用 DOM 的 `click()`）；桌面端代码没变，第 1 轮用真实指针走过 50 个场景 | 不需要，除非桌面端再改 |

已交给用户决定的 c6（旧 git 上跳过 `GIT_CONFIG_COUNT` 子用例）、c7（新建或重命名终端会话时后台会话全亮「有新消息」）：这一轮没有新的证据改变它们；c6 的跳过条件已收紧，本机不跳过。

tasks.md「后续」里我认为风险被低估的：d70（N-2）、X14 的已知限制（N-1：实际不是「列不出来」）、`TestProjectStoreRemoveWorktreeIfSame`（说明 1）。「单独删会话不确认 tmux 是否真的结束了它」（d68）我同意开发方的判断：它是 tmux 没了之后清掉表里会话的出路，删会话不删目录。

## 放松检查

返工改动的已有断言，逐个看过 `git diff 91e0fab..HEAD -- '*_test.go'`（9 个文件，+1261 / −63；`func Test…` 的集合：91e0fab 有 440 个，现在 454 个，**没有删掉的**，新增 14 个）：

| 改动 | 判断 |
|------|------|
| `TestParseTmuxSessionLine…` 六个用例（`PreservesMetadataFields`、`KeepsEmptyTrailingFields`、`RejectsEmptySessionID`、`RejectsMalformedFieldCount`、`Columns`、`ReadsClaudeU`）：输入从制表符分隔的一行改成带标记的回答；8、9、13 列从「能解析」改成「拒绝」；id 为空的会话从「解析失败」改成「不算进集合、其余照常读」 | 行为按裁决改变（decisions #141、#142：格式串和解析在同一个二进制里，列数必须正好 14），不是放松。`Columns` 还多了「1、15 列被拒」「字段里的制表符和换行原样保留」「截断的回答、多出来的文字被拒」几条 |
| `TestGitTimeoutKillsProcess`：`t.Skip("fake git did not record a pid")` 换成 `t.Fatal`；先把假 git 运行一次；pid 没写出来就重试，最多 20 次 | 加强。时限 50 ms 和「不到 1 秒」两个数没动；本机 `-race -count=5` 5 次 PASS、0 次 SKIP |
| `TestGitEnvKeepsInheritedConfig/GIT_CONFIG_COUNT`（c6）：探测命令失败、或输出不是 `kept` / `not-read`，从「跳过」改成「失败」 | 加强。现在只在「探测成功且 git 不读 `GIT_CONFIG_COUNT`」时跳过；本机输出 `kept`，执行了断言 |
| `TestWorktreeRemoveEndpoint/changed_after_sessions_ended`：让提交落地的触发点从 `rev-parse HEAD` 改成第三次成功的 `worktree list` | 跟着 X13 的实现改（复核不再调用 `rev-parse HEAD`）；断言（409、`endedSessions` 如实、目录和分支都在）没动 |
| `installCountingGitConcurrency`（测试辅助函数）：开始计数之前先用新装的 git 读一次列表、清空计数 | 断言没动。在认 `-z` 的 git 上不改变任何计数；旧 git 上把「每个 git 只发生一次的探测」排除在「一轮轮询的开销」之外，有依据（decisions #149） |

新增的条件跳过两处：`requireWorktreeListZ`（只有探测以 129 退出才跳过带换行的子用例，别的失败是 `t.Fatalf`；本机不跳过）；`TestPlanMissingWorkdirIs400` 在系统不支持符号链接时跳过后半段（本机不跳过）。本机不带 `-race` 的 `-v` 全量里 0 个 SKIP。

`.devflow.yml`：三条规则的 `check` 只增加了用例名（新加的 14 个用例里的 13 个，外加原有的 `TestWorktreeAddKilledDuringCheckoutIsUndone`；第 14 个 `TestPlanMissingWorkdirIs400` 在全量里跑），没有去掉的；规则文字跟着返工改写。其中「目录名里的制表符和换行不改变读到的归属」少了「UTF-8 环境下」这个前提（N-4），「对话界面的信任…」那条在旧 git 上有反例（N-1）——这两处是规则文字比实际保证的多，不是检查被放松。

覆盖面上的缺口（不是放松）：`TestParseWorktreeList` 对「按行读时路径带换行」只测了 `external\nworktree` 一个名字，所以没有发现 N-1；`TestIsNoTmuxServerGoesByTheWholeLine` 没有路径带换行的例子（N-3）。

除此之外：无。

## 最后核对

- 开始和结束时 `git rev-parse HEAD` 都是 `482ab63df9ec109e0f991834b5e267cd118ffbfb`，`git status --short` 都为空；没有改动任何已跟踪的文件，没有提交。被忽略的构建产物只有 `desktop/dist/`。
- 我启动的进程都已退出（临时 daemon、它们各自 socket 目录下的 tmux server、Electron、负载实验的 24 个 shell 循环）；`/tmp/vr-v2*` 目录、两个临时 worktree（482ab63 和 91e0fab 各一个）已删除。本文件和 `same-evidence/` 是我在 `/Users/mac/github/vibe-remote/.devflow-tmp/gate-c2/` 下新增的全部内容。
