# daemon 侧（Go）独立评审 — change/project-worktrees @ e278f87（基准 6d88e45）

结论：没有发现「删到白名单外 / 主目录 / 别人的分支」或「信任规则比 H7 宽」这一级的问题（这两个方向的反例全部被拒，见「覆盖范围」）。下面 9 个已证实的问题都是「一般」，其中 5 个是明确错误。建议的处理先后：第 2、5 条（删除 worktree 时漏掉其中的会话；撤销删了分支却留下 worktree）→ 第 1 条（创建记录被误删）→ 第 6、3 条 → 其余取舍项。现有 Go 测试在 `-race` 下全绿（独立 `TMUX_TMPDIR`），这些问题现有测试都测不到。

## 已证实的问题

### [一般] `Projects()` 会把仍然存在的 vibe-remote 创建记录删掉，worktree 从此永久变成「外部」（分支再也不能从界面删）

- 位置：`vibe-remoted/internal/session/projects.go:104-113`（清理过期记录），配合 `:124-139`（项目读失败时 `Worktrees` 为空）、`:59-73`（候选项目只来自清单和现存会话）
- 根因：清理的判据是「记录的 path 不在**本轮读到的任何列表**里」，而不是「它所属项目的列表**本轮读成功了**且里面没有它」。只要记录所属的项目本轮没被读、或读失败，记录就被 `RemoveWorktreeIfSame` 删掉并落盘。design 5.2 的论证（「快照里有记录 ⇒ 列表里一定有它」）默认了项目一定在候选集里且读成功。
- 证据（临时 daemon，`claude_cmd=/bin/bash`，`allowed_roots` 只有 `/private/tmp/vr-review-*/roots`，独立 `TMUX_TMPDIR`/`state_dir`）。三种触发方式都复现：
  1. **新建与轮询抢跑**（仓库此前没开过会话 = 不在项目清单里，机器概览的 Worktree 模式、旧桌面端、「移除项目」之后都是这种）：attach `{mode:"worktree", worktreeName:"w1"}` 发出后 0.30 s 发**一次** `GET /api/v1/projects`，6 个偏移量里这一个命中：之后 `projects` 里 `repoW030-worktrees/w1` 没有 `managed`，`projects.json` 的 `worktrees` 为 `[]`。窗口是 `AddWorktree`（`manager.go:470`）到会话登记 + `recordCreated`（`manager.go:408`）之间，即 tmux / claude 的启动时间（本机无登录 shell 时整个 attach 约 0.5 s；`login_shell:true` 更长），每 5 秒一轮的轮询落进去就中。
  2. **一次瞬时的 git 失败**：`chmod 000 repoW005/.git` → `GET /projects`（该项目 `error:"git_failed"`）→ `chmod 755` → 再 `GET /projects`：`w1` 由 `managed=True` 变成 `managed=False`，不再恢复。5 秒超时（`gitTimeout`）、仓库所在卷暂时没挂载（`repo_missing`）同理。
  3. **从侧边栏移除项目再回来**（R2.3）：删掉会话 → `POST /projects/remove` 204 → `GET /projects`（项目不在）→ 在主目录新建会话 → `GET /projects`：项目回来了，`repoW010-worktrees/w1` 是 `managed=False`。磁盘上 `git worktree list` 里它一直在、分支 `w1` 没变。
- 应有的结果：H17「daemon 记下自己创建的 worktree（路径和分支），会话删除后仍记得」；R2.3「磁盘上的仓库、worktree、分支都不变；…项目重新出现」；R5.2 删除干净且已合并的 worktree 时「目录和分支都被删除」。实际：这些 worktree 被标成「外部」，删除时只删目录，每删一个留下一个分支，且没有任何提示说明为什么。方向是安全的（不会多删），所以定为一般。
- 依据：spec H17、R2.3、R5.2；清单「并发 — 读-判断-写」「正确性 — 错误路径」
- 改法：`Projects()` 里只在「记录的 `Project` 本轮读了列表、`err == nil`、列表里确实没有这个 path」时才删记录；记录的项目不在候选集里时不删（或把记录里的项目也并进要读的集合，只用来核对、不显示）。注意判断要用 git 原始列表而不是经过 `allow`、`Prunable` 过滤后的 `p.Worktrees`（否则白名单配置一改也会误删）。补三个用例：项目不在清单里时并发轮询、项目读失败一轮、移除项目后再加回。
- 类别：明确错误

### [一般] `<仓库名>-worktrees` 是符号链接时，新 worktree 记成了非规范路径：会话挂不到它下面、删除它时不结束其中的会话、撤销清不掉

- 位置：`vibe-remoted/internal/session/worktree.go:552-553`（`claim.root` 由字符串拼出）、`:581-589` 与 `manager.go:446-451`（`AllowPath` 把 `ResolveAllowedNewPath` 返回的规范路径丢掉，只用 err）、`worktree.go:669-675`（`Meta.WorktreeRoot` / `Home.Path` 用未解析的 `claim.root`）、`:707-709`（撤销时 `wt.Path != c.root` 永远不相等）
- 触发条件：容器目录 `<主目录的父目录>/<主目录名>-worktrees` 本身是指向白名单内另一处的符号链接（例如把 worktree 放到大盘上）。git 登记和列出的是解析后的真实路径，daemon 记下的是没解析的那个，两边所有的相等比较都对不上。
- 证据 1（临时 daemon，REST + WebSocket）：`ln -s roots/bigdisk/repoC-wts roots/repoC-worktrees` 后 attach `{mode:"worktree", worktreeName:"feat"}`：
  - `ready.worktreeRoot` = `…/roots/repoC-worktrees/feat`；`git worktree list` = `…/roots/bigdisk/repoC-wts/feat`。
  - `GET /api/v1/projects`：该 worktree 没有 `managed`、`sessions: []`；会话 id 落在项目级 `sessions` 里（桌面端按 `gone` 显示「目录已不存在」，而它正在运行）。`projects.json` 里没有它的创建记录（下一轮轮询就被清掉）。
  - `GET /api/v1/worktrees/status?path=…/bigdisk/repoC-wts/feat` → `"sessions":[]`；随后 `POST /api/v1/worktrees/remove`（`sessions:[]`）→ `200 {"removed":true,"branchDeleted":false,"endedSessions":[]}`。目录没了，`/api/v1/sessions` 里那个会话还在，tmux 里 `vibe-remote-…cccccc01` 仍活着、`pane_current_path` 指向已删除的目录。
- 证据 2（我自己的临时副本里加的测试，直接调 `CreateWorktree` 再 `Undo`，模拟会话启动失败后的撤销）：`Undo()` 返回 `directory …/repo-worktrees/feat not removed: … directory not empty`；之后 `git worktree list` 是 `/bigdisk/feat 0000000 [feat]`，`git branch --list` 只剩 `main`——worktree 和目录都留着，它检出的分支却被 `update-ref -d` 删了。
- 证据 3（同一根因的第二种触发，daemon 跑在 macOS 上时）：attach 的 `worktreeName` 是 NFD 写法的 `café`（从 Finder 复制的文件名就是这种）。仓库 `core.precomposeunicode=true`（macOS 上 `git init` 的默认值），git 把分支和路径都登记成 NFC 的 `café`；`ready.branch` / `ready.worktreeRoot` 仍是 NFD。`GET /projects`：该 worktree `managed=False`、`sessions: []`，会话落在项目级。也就是说「`check-ref-format --branch` 的输出与输入逐字相等」并不保证 git 之后登记的名字与输入逐字相等。
- 应有的结果：R5.6（删除 worktree 时确认框写明并先结束其中的会话）、R1.1（会话列在所属 worktree 下）、R3.8 / 非功能「创建失败要回滚（不留半截目录或分支）」、H17。
- 依据：spec R5.6、R3.8、H17；清单「正确性和边界」「数据安全 — 状态变更不是原子的」
- 改法：`precheckWorktree` 里把 `AllowPath` 改成返回规范路径（`ResolveAllowedNewPath` 本来就算出来了），`claim.container` / `claim.root` 用规范形式；或者 `git worktree add` 成功后用 `filepath.EvalSymlinks(claim.root)` 重写 `claim.root`，再生成 `Meta`、`Home`、创建记录，`undo` 也按它比较。更稳妥的做法是 `worktree add` + `symbolic-ref` 之后读一次 `ListWorktrees`，以 git 实际登记的那一项（路径和分支）为准——这样符号链接和 Unicode 归一化两种情况都覆盖，找不到对应项就按失败撤销。补一个「容器是符号链接」的用例，断言 `ready.worktreeRoot` 等于 `git worktree list` 里的路径、`status.sessions` 含该会话、`Undo` 后列表和分支都干净。
- 类别：明确错误

### [一般] 会话建在非 git 子目录、之后上层目录才 `git init`：项目树把真正的主目录列成一个可删的「外部」worktree，运行中的会话被标成「目录已不存在」，这个假项目还被写进 `projects.json`

- 位置：`vibe-remoted/internal/session/projects.go:141-183`（`buildProject`：只要 `ListWorktrees(id)` 成功就当成 git 项目，不核对 `id` 是不是列表第一项）、`:96-100`（随后 `AddProject(id)` 落盘）
- 证据（临时 daemon）：`mkdir roots/plain/sub` → 在 `plain/sub` 新建终端会话（此时 `git:false`，正常）→ `git init roots/plain && git commit` → `GET /api/v1/projects`：
  `{"id":"…/plain/sub","name":"sub","git":true,"worktrees":[{"path":"…/plain","branch":"main","head":"74d11b1","sessions":[]}],"sessions":["…dddddd01"]}`
  主目录 `plain` 既没有 `main` 也没有 `managed`（按 design 4.2 / 7.4，桌面端会把它画成「外部」、菜单里有「删除 worktree」；桌面端我没有实际跑）；会话在项目级 `sessions` 里（design 4.10 的 `gone` =「目录已不存在」）。删掉会话后这个项目仍在，`projects.json` 的 `projects` 里多了 `…/plain/sub`。daemon 这头没有删错东西：对 `…/plain` 查 status 返回 `"main":true`，remove 会被 `worktree_is_main` 拒绝。
- 应有的结果：R1.3 / H18（非 git 目录的项目随最后一个会话消失，只有 git 项目进清单，项目的身份是仓库主目录的规范路径）；R5.7（主目录没有「删除 worktree」）。
- 依据：spec R1.3、R5.7、H18；清单「新取值是否处理完整」
- 改法：`buildProject` 在列表读成功后核对身份：第一项是主目录（非 bare、其下有 `.git`）而 `wts[0].Path != id` 时，这个 id 不是项目——按 `git:false` 处理（会话留在项目级、不进清单），或者把这些会话的归属重算一次并入真正的项目；`Projects()` 里 `AddProject` 只对 `id` 等于列表第一项（或 `Single` 规则下的顶层）的项目调用。
- 类别：明确错误（影响面小：需要「先开会话、后在上层建仓库」）

### [一般] 仓库配置的 `core.fsmonitor` 程序仍会被 daemon 触发：一次被 409 拒绝、「什么都不改」的删除请求也会运行它

- 位置：`vibe-remoted/internal/session/worktree.go:322`（`HasSubmoduleCheckouts` 里的 `ls-files --stage -z` 没带 `-c core.fsmonitor=false`）；`projects.go:743`（`git worktree remove` 内部会在该 worktree 里再跑一次 `git status`）；`worktree.go:640`（`worktree add` 的检出）。`worktree.go:285-290`、design 第 3 节写的是「`core.fsmonitor` 是 status 唯一会执行外部程序的配置，关掉」，只关了 `DirtyFiles` / `IgnoredFiles` 两处。
- 证据（临时 daemon）：`git -C repoF config core.fsmonitor <记录调用的脚本>`，然后逐个端点看脚本的日志行数：
  - `GET /projects`、`/worktrees/plan`、`/worktrees/status`、`/fs`：0 行（符合预期）。
  - `POST /worktrees/remove`，`head` 故意给全 0（必然 409 `worktree_changed`，`endedSessions:[]`）：日志多 2 行 `fsmonitor hook ran in T/roots/repoF-fx`（一次 git 调用，先试 v2 再试 v1）。
  - 真正的删除：再多 6 行（`repoF-fx` 两次、`repoF` 一次）。新建命名 worktree：再多 2 行（在新 worktree 里）。
- 应有的结果：按 design 第 3 节和代码注释的意图，daemon 为了「看一眼状态」而跑的 git 不执行仓库自己指定的程序；R5.9「开始删除之前就能发现的失败…磁盘状态都不变」的那几步检查应该是纯只读的。实际：删除请求的预检（在与请求比对之前、任何同意项生效之前）就会执行 `.git/config` 里指定的程序。
- 影响评估：`.git/config` 不随 clone 传播，要有人能写这个仓库的 `.git/config` 才能利用；新建 worktree 本来就会跑 `post-checkout` 钩子（design 6.1 已写明）。所以这是「注释和设计声称已关、实际只关了一半」的加固缺口，不是新的越权。
- 依据：design 第 3 节（未提交文件数一行）、7「错误处理和安全」；清单「不可信输入」
- 改法：在 `gitEnv()` 里统一注入 `GIT_CONFIG_COUNT=1`、`GIT_CONFIG_KEY_0=core.fsmonitor`、`GIT_CONFIG_VALUE_0=false`（会传给 `worktree remove` 派生的子进程），或让 `gitAt` / `gitAtTimeout` 一律在参数最前面加 `-c core.fsmonitor=false`；删掉 `DirtyFiles` / `IgnoredFiles` 里各自的 `-c`。补一个用例：仓库配了 `core.fsmonitor` 时走一遍 status + 被拒绝的 remove，断言脚本没被调用。
- 类别：取舍（是否要把「daemon 的 git 不跑仓库指定的程序」作为一条规则守住；要守的话改法只有上面这一种）

### [一般] 删除 worktree 时，工作目录在它里面、但归属算在别处的会话不会被结束，确认框也不会提到

- 位置：`vibe-remoted/internal/session/projects.go:480-493`（`sessionsIn`：只收 `home == root`，或「完全没有归属且 workdir 在 root 下」的会话）
- 触发条件：会话的工作目录在被删的 worktree 里面，但 `ResolveHome` 把它归到了别的根——最常见的是 worktree 里被忽略的目录下有一个独立的 git 仓库（`vendor/lib`、`node_modules/<某个 git 依赖>`、别的工具放进来的检出），会话开在那个目录里。
- 证据（临时 daemon）：命名 worktree `repoN-worktrees/feat`（`.gitignore` 里有 `vendor/`）；`git init feat/vendor/lib` 并提交一次；在 `feat/vendor/lib` 新建终端会话 `…22222222`。
  - `GET /worktrees/status?path=…/feat` → `"dirtyFiles":0,"unmergedCommits":0,"ignoredFiles":1,"sessions":[]`
  - 按确认框会发的内容 `POST /worktrees/remove {"sessions":[],"deleteBranch":true}` → `200 {"removed":true,"branchDeleted":true,"endedSessions":[]}`
  - 目录已不存在；`/api/v1/sessions` 里 `…22222222`（workdir `…/feat/vendor/lib`）仍在，进程的当前目录已被删除。
- 应有的结果：R5.6「worktree 下还有会话 → 确认框写明会先结束这些会话；确认后会话结束」。design 6.2 第 3 步自己给的理由是「同样会因为目录被删而失去脚下的目录」，这个理由对归属在别处的会话同样成立。（嵌套仓库本身随外层一起删、只算 1 个被忽略文件，是 tasks.md「后续」里已记录的已知限制；会话没被结束这一点不在其中。）
- 依据：spec R5.6；清单「需求和设计一致性」
- 改法：`sessionsIn` 改成按目录判断：`within(root, s.home) || within(root, s.workdir)`（`home` 为空时只看 `workdir`），与 `beginStart` / `markRemoving` 用的 `within(root, workdir)` 口径一致。补用例：会话开在 worktree 内被忽略的嵌套仓库里，`status.sessions` 含它，删除时它被结束。
- 类别：明确错误

### [一般] 分支还没有任何提交的 worktree（`git worktree add --orphan`）查状态恒为 500，无法从界面删除；以它为发起处时预检说可以建、真正新建失败

- 位置：`vibe-remoted/internal/session/projects.go:507-514`（`worktreeState` 对 unborn 分支照样调 `UnmergedCommits`）、`worktree.go:770-786`；`projects.go:801-839`（`PlanWorktree` 不覆盖「发起处没有提交」）
- 证据（临时 daemon，git 2.50）：`git -C repoO worktree add --orphan -b unborn ../repoO-unborn`（列表里 `HEAD 0000…0`、`branch refs/heads/unborn`）。
  - `GET /worktrees/status?path=…/repoO-unborn` → `500 {"error":"git_failed","message":"count unmerged commits: git rev-list --count refs/heads/unborn … fatal: ambiguous argument 'refs/heads/unborn': unknown revision…"}`；`POST /worktrees/remove` 走同一段，同样失败。
  - `GET /worktrees/plan?workdir=…/repoO-unborn&name=q` → `{"ok":true,…,"base":{"branch":"unborn","head":"0000000"}}`；随后 attach → `create_failed`「resolve source commit: … Needed a single revision」（没有残留）。刚 `git init`、还没有提交的仓库走的是同一条路。
- 应有的结果：R2.1 / R5.2（列出的 worktree 能删）；R3.3「git 不接受 → 对话框内显示原因，确认按钮不可用」。design 4.4 已声明预检不覆盖「发起处还没有提交」，所以后一半是已知取舍，前一半（删不掉）不是。
- 依据：spec R5.2、R5.9；清单「正确性和边界 — 空值、零」
- 改法：`worktreeState` 里 `wt.Head` 全 0（或 `show-ref --verify refs/heads/<分支>` 退出码 1）时把 `UnmergedCommits` 记 0、不调 `rev-list`；`deleteWorktreeBranch` 对不存在的引用本来就是空操作。`PlanWorktree` 可顺带在 `base.head` 全 0 时返回一个 `ok:false` 的原因。
- 类别：明确错误（前一半）/ 取舍（预检那一半）

### [一般] worktree 里未跟踪的独立 git 仓库在确认框上只算「1 个文件」，同意丢弃后它的全部提交一起消失

- 位置：`vibe-remoted/internal/session/worktree.go:288-294`（`DirtyFiles` 按 `status --porcelain` 的行数计）、`:313-337`（`HasSubmoduleCheckouts` 只认 `modules/` 和索引里的 gitlink）
- 证据（临时 daemon）：在 `repoJ-worktrees/n1` 里 `git init scratch` 并提交 3 次（没有 `git add scratch`）。`GET /worktrees/status` → `dirtyFiles:1, unmergedCommits:0`；`POST /worktrees/remove {discardFiles:true}` → 200，`scratch` 连同 3 个只存在于那里的提交被删。动手前的三种拦截都没有命中。
- 应有的结果：R5.3「确认框写明有 N 个文件会被丢弃」的 N 应该让用户知道丢的是什么；design 6.2 第 6 步拦子模块 / 嵌入式仓库的理由（「其中只在本地的提交不在确认框的数字里」）对这种没 `git add` 过的仓库同样成立。tasks.md「后续」只记了「嵌在**被忽略**目录里」的情况（算 1 个被忽略文件）；这一种走的是「未跟踪」，用户至少要点一次「仍然删除」，但数字是 1。
- 依据：spec R5.3、R5.9；design 6.2 第 6 步
- 改法：`HasSubmoduleCheckouts` 再加一段：`status --porcelain -z --untracked-files=all` 里以 `/` 结尾的未跟踪项（git 只对嵌入式仓库这样输出）且其下有 `.git` → 同样在动手前拒绝并给出手动命令；或者在 status 里单列一个字段让确认框写明。
- 类别：取舍（拒绝删除、还是在确认框里说明，两种都合理）

### [一般] 确认之后分支被切换：用户同意的「目录和分支都删」被静默降级成只删目录，响应里没有任何说明

- 位置：`vibe-remoted/internal/session/projects.go:701-705`（只比对 `head`、会话、文件、提交数；`deleteBranch` 在 `st.Managed` 变成 false 时被悄悄忽略）、`:761-764`（此时不写 `BranchError`）
- 证据（临时 daemon）：status 显示 `branch:n0, managed:true, 干净, 0 个未合并提交`；之后在该 worktree 里 `git switch -c other`（HEAD 不变，会话里随手就能做）；`POST /worktrees/remove {deleteBranch:true}` → `200 {"removed":true,"branchDeleted":false,"endedSessions":[…]}`，没有 `branchError`。仓库里 `n0` 和 `other` 两个分支都留着。
- 应有的结果：design 4.6 / protocol.md 写的是「与用户确认的不一致就 409」「分支该删而没删成时为 false 并带 `branchError`」。这里确认框说的是「目录和分支都会删除」，结果既没有 409 也没有 `branchError`，桌面端无从提示。不丢东西，方向安全。
- 依据：design 6.2 第 5 步、4.6；清单「错误处理 — 失败时响应是否如实」
- 改法：请求带了 `deleteBranch:true` 而重查后的 `managed` 为 false 或 `branch` 为空时返回 409 `worktree_changed`（什么都不动，让确认框按最新状态重弹）；或至少在 200 里给 `branchError` 写明「这个 worktree 现在检出的是 <分支>，不是 vibe-remote 创建时的分支，分支没有删除」。要做得彻底，请求里再带上确认时看到的 `branch` 一起比对。
- 类别：取舍

### [一般] 预检放行、新建才失败的名字；以及能造出显示上无法分辨的分支名

- 位置：`vibe-remoted/internal/session/worktree.go:391-416`（`worktreeNameProblem`）、`:509-579`（`precheckWorktree`）
- 证据（`GET /worktrees/plan` 对 66 个名字逐个试，再对其中一个真正新建）：
  - 252 个 `x`：plan 返回 `ok:true`；attach 得到 `create_failed`「…/refs/heads/xxx….lock': File name too long」（没有残留，目录和分支都撤干净了）。300 个：plan 说 `worktree_path_not_allowed`（其实是 `Lstat` 的 ENAMETOOLONG 被包成了「不在允许范围内」，原因写错了）。
  - `a` + U+200B（零宽空格）+ `b`、`a` + U+202E（从右到左覆盖）+ `b`、`a` + U+FEFF + `b`：plan 都是 `ok:true`。`unicode.IsControl` 只管 Cc，这些是 Cf。结果是可以建出和已有分支看上去一模一样、或显示顺序被翻转的分支名和目录名。
- 应有的结果：R3.3（名字不合法时对话框内显示原因、确认按钮不可用）；design 4.4 说预检与新建对同一个名字结论一致（已声明不覆盖磁盘满、无提交，未声明长度）。
- 依据：spec R3.3；清单「不可信输入」
- 改法：本地规则加两条并写进共用向量 `testdata/worktree-names.json`（桌面端同步）：名字的任一 `/` 分段超过 250 字节 → `invalid`；含 `unicode.Cf` / `unicode.Zl` / `unicode.Zp` 类字符 → `invalid`。`precheckWorktree` 里 `AllowPath` 的非「不在范围内」错误（ENAMETOOLONG 等）不要映射成 `worktree_path_not_allowed`。
- 类别：取舍

## 可维护性 / 文档（不需要运行证据，类别均为「取舍」）

- `vibe-remoted/internal/session/manager.go:272-288`：`createTerminalLocked` 的说明注释（「createTerminalLocked starts terminal session id…」和 `-c` 改写那两段）现在贴在 `resolveSessionHome` 头上——新函数被插在了注释和它原来的函数之间，`createTerminalLocked`（:302）自己没有注释了。改法：把 `resolveSessionHome` 连同它的注释挪到 `createTerminalLocked` 的注释之前。
- `vibe-remoted/internal/config/config.go:44-47`：`StateDir` 的注释仍只说「the chat session table」「不可写时对话界面不可用」。现在这个目录还放 `projects.json`，不可写时的另一个后果是创建记录只在内存、重启后命名 worktree 按「外部」处理。改法：注释补上这两句（CLAUDE.md 已写）。
- `vibe-remoted/internal/session/worktree.go:27-29`：注释说不带超时的 `gitAt` 只用于「creation and cleanup path」，实际 `UnmergedCommits`（:777，查状态和删除前重查都走它）和 `RemoveWorktree` 的 `git worktree remove`（`projects.go:743`）也用它。改法：改注释，或按 tasks.md「后续」已记的那条把 `UnmergedCommits` 换成 `gitAtTimeout`。
- `vibe-remoted/internal/session/projects.go:599-773`：`RemoveWorktree` 约 175 行，「动手前的三种拦截」「与请求比对」「结束会话并复核 HEAD」「git 删除失败后的分类」四段各自独立。改法：拆成四个包内函数，主函数只留顺序（清单：超过 80 行的函数）。
- `vibe-remoted/internal/server/projects.go:62-74`：`workdir` 指向一个文件时 `GET /worktrees/plan` 返回 500 `git_failed`（git 的「cannot change to … Not a directory」）。改法：`ResolveAllowedWorkdir` 之后 `os.Stat` 一下，不是目录就 400 `invalid_request`。

## 待验证项

### [一般] daemon 刚重启、会话表还没从 tmux 找回时，对账被丢弃会让删除 worktree 漏掉其中正在运行的终端会话

- 关联：R5.6；design 4.9「先和 tmux 对账」
- 已查到的依据：`projects.go:547`、`:621` 调 `m.syncFromTmux()` 后不看返回值。`manager.go:598-628`：tmux 查询失败、或查询期间 `m.gen` 变了（任何一次并发的新建 / 删除 / 找回），这一轮对账整个丢弃（返回 `false`）。重启后表是空的，这时 `sessionsIn(path)` 为空，删除照常进行，不结束那些会话。平时不会出现：表一旦对过一次账就是全的，之后新建的会话直接登记。
- 缺什么：没能在黑盒下撞出「重启后第一次对账恰好被丢弃」。我做的重启实验里（重启后 0.6 s 直接查 status）对账成功、会话都找回来了。
- 最小实验：session 包里新建一个 `Manager`（空表）指向已有 tmux 会话所在的 worktree，让第一次 tmux 查询失败（`manager.go:606` 调的 `m.liveTmuxSessions` 如果是可替换的接缝就用它，否则在那一刻让 `TMUX_TMPDIR` 指向一个连不上的 socket），调 `RemoveWorktree(sessions: [])`。目录被删而 tmux 会话还在 → 确认；返回错误或 409 → 排除。确认的话，改法是对账没被应用时重试一次，仍不成功就在动手前返回 500。

### [一般] 不带超时的 git 卡住时，仓库锁和「正在删除」标记不释放，同一仓库此后的新建和删除全部挂起

- 关联：非功能要求「可靠性」；design 7「git 调用用 `exec.CommandContext`…卡住的 git 会让轮询无限堆积」
- 已查到的依据：`RemoveWorktree` 在持有 `lockRepo(home.Repo)`（`projects.go:610`）和 `removingRoots`（:650）期间调用不带超时的 `gitAt`：`UnmergedCommits`（`worktree.go:777`）、`git worktree remove`（`projects.go:743`）、`update-ref -d`（:789）。`CreateWorktree` 的 `gitAt`（`worktree.go:604-645`）同样在仓库锁内。git 卡在不响应的网络盘或一个等输入的 `post-checkout` 钩子上时，后来的 attach（worktree 模式）在 `lockRepo` 上无限等，客户端既收不到 `ready` 也收不到 `error`；`/worktrees/remove` 同样不返回。tasks.md「后续」只记了 `UnmergedCommits` 让单个请求不返回，没有记锁的连带影响。
- 缺什么：没有模拟卡住的 git 去量连带影响（需要一个只对 `worktree remove` / `rev-list` 挂起的假 git）。带超时的那一半我验证过：20 个项目的 git 全部挂起时 `Projects()` 约 0.9 s 返回（超时设 300 ms），子进程和孙进程 24 个全部被回收，goroutine 数不变。
- 最小实验：PATH 里放一个对 `rev-list` 睡 60 秒的假 git，对一个 worktree 发一次 `/worktrees/remove`（它在仓库锁内调 `UnmergedCommits`；`/worktrees/status` 不取仓库锁），同时对同一仓库发 worktree 模式的 attach；attach 在 10 秒内没有任何帧 → 确认。

## 覆盖范围

读过的材料：`spec.md` 全文；`design.md` 第 1–7.3 节、第 9 节 V10–V24、第 10 节；`tasks.md` 的「后续」；评审清单；worktree 根的 `CLAUDE.md`。代码通读：`session/worktree.go`、`projects.go`、`projects_store.go`、`trust.go`、`server/projects.go`；`manager.go`、`chat_manager.go`、`runner.go`、`chat/store.go`、`config/config.go`、`main.go`、`server.go`、`ws.go`、`ws_chat.go`、`protocol.go` 读的是相对 `6d88e45` 的 diff 加上相关函数全文（`Create`、`createTerminalLocked`、`createOwnWorktree`、`undoOwnWorktree`、`beginCreate`、`lookupOrRecover`、`syncFromTmux`、`Delete`、`CreateChat`、`deleteChat`、`Handoff`、`wsAttach`、`wsCreateChat`）。被改动的现有测试只看了删改的断言（都对得上 design 7.1 列的改写，没有发现放松）；新增测试文件没有逐个读。

做过的实验（两台临时 daemon：端口 18931 `claude_cmd=/bin/bash`、18932 假 claude；各自独立的 `state_dir`、`TMUX_TMPDIR`、`CLAUDE_CONFIG_DIR`，`allowed_roots` 只有 `/private/tmp/vr-review-*/roots*`；另在 `/tmp` 下的临时副本 worktree 里加过两个临时测试文件。全部已停止并删除，待审 worktree 未改动，HEAD 仍是 `e278f87`）：

- 现有测试：`TMUX_TMPDIR=<临时> go test -race -timeout 10m ./internal/...` 全部通过（session 223 s、server 59 s、chat 20 s）。
- 删错东西（方向 1）：对 `/worktrees/remove` 试了 13 种 path——主目录、白名单外、指向白名单外 / 内的符号链接、尾斜杠、`..`、相对路径、大小写不同、`/tmp` 与 `/private/tmp` 两种写法、另一个仓库的主目录、非 git 目录、`.git` 子目录、外部 worktree 带齐三个同意项。除最后一种（只删目录、分支保留，符合 R5.8）外全部 400 / 404，磁盘不变。同意项：不带 `discardFiles` / `dropCommits`、过期的 `head`、漏报会话都返回 409 且什么都没动。`projects.json` 损坏后重启：被改名隔离、按空清单启动，所有命名 worktree 变「外部」；升级认领规则只认 `<主目录>-worktrees/<13 位-8 位十六进制>` + `vibe/<同一 id>`，`vibe/foo` 和放在别处的不认。
- 名字和路径（方向 2）：66 个名字过 `/worktrees/plan`（`@{-1}`、`-x`、`..`、各种空白与控制字符、shell 元字符、`refs/heads/x`、`HEAD`、大小写、`a/b` 对 `a-b`、NFC / NFD、超长）；NFD 名字和 252 字符名字真正新建过。shell 元字符原样成为分支名、没有被执行。
- 并发和撤销（方向 3、5）：10 路并发同名（1 个成功、9 个 `worktree_branch_exists`，无残留）；10 路并发不同名（全部成功，记录齐全）；8 路同一 `newSessionId` 重放（1 个 worktree、1 个会话）；删除与在其中新建会话对撞 24 轮（要么 409 + 会话建成，要么删除成功 + 新建被拒，没有出现「删了但会话活着」）；交接与删除对撞 1 次（删除 409，交接成功）；带运行中对话会话的 worktree 删除（会话结束、进程回收）。没有观察到死锁。
- 信任规则（方向 4）：`/api/v1/fs` 的 `chatTrust` 对 14 种目录、对话 attach 对 8 种情况。主目录的子目录、worktree 里的子目录、未信任仓库的 worktree、裸仓库的 worktree、伪造 `.git` 文件、`.git` 是指向受信任仓库的符号链接、嵌在受信任主目录里的另一个仓库及其 worktree，全部 `untrusted` / 被拒；没有找到比 H7 宽的路径。
- 旧客户端（方向 6）：不带 `worktreeName`、不带 `ui` 的 attach 建出 `vibe/<id>`；带未合并提交和未提交文件时删会话返回 204，目录、分支、提交都在；`worktreeName` 在普通模式下被忽略。
- 性能（方向 7）：30 个项目、128 个 worktree 时 `/api/v1/projects` 中位数 158 ms（此前 10 个项目时 65 ms；本机 git 是 xcrun 转发壳），`/api/v1/sessions` 8 ms 不变；轮询后没有残留的 git 进程；git 全部挂起时超时回收干净、goroutine 不增长。
- 错误处理（方向 8）：5 个新端点不带 token 都是 401；坏请求体 400；非 git、白名单外、空名字、`.git` 内部各自的错误码与 `fatal` 都对得上 design 4.1–4.6。

没来得及看 / 没有覆盖的：

- daemon 在创建流程中途被 `kill -9` 后的残留（design 6.1 已列为已知窄窗口，只做过正常重启）。
- `use_tmux:false` 的路径；子模块和 `--separate-git-dir` 仓库（`Home.Single`）；detached worktree、被锁定的 worktree、初始化过子模块的 worktree 的删除（只读了代码，靠现有测试）。
- Linux 上的行为（大小写敏感文件系统、带翻译的 git）；真实的 claude。
- 重载（终端和对话）与删除 worktree 的并发：只从代码上推了锁序（重载与删除被 `opMu` / tmux 串行化，会话在表里所以会被结束），没有做实验。
- 桌面端对上述响应的处理（不在本次范围）；`docs/protocol.md` 只抽查了 `worktrees/remove` 一节。
