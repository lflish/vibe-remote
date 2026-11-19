# 评审待验证项的最小实验（review.md「待验证项」13 条）

时间：2026-11-20。被测：`ba9caa4` 的产品代码（没有改动）。所有实验都在 `/tmp` 下自建的目录里做：临时 daemon（随机端口、临时配置和 `state_dir`、各自的 `TMUX_TMPDIR`、`allowed_roots` 只有临时目录）、临时 git 仓库；没有连接本机正在运行的 daemon，没有在默认 tmux socket 目录上执行过任何命令。

结论一览：

| # | 待验证项 | 结论 |
|---|----------|------|
| 1 | M1 的整体画面（X11） | 已排除（形态断言 + 截图对照；已记录的 5 处外观差异仍在） |
| 2 | 800×500 中英文下各对话框的真实布局（X12） | 已排除 |
| 3 | 冷启动首帧（X14） | 已排除到「第一次绘制完成的那一帧」；创建到首次绘制之间的屏幕像素仍缺条件（要录屏） |
| 4 | 真实键盘 | 仍缺条件：需要人在打包后的 app 里按键 |
| 5 | git 低于 2.31 | 已排除（git 2.30.2） |
| 6 | 全新 tmux 环境、没有 tmux 程序 | 已排除 |
| 7 | 对账四条规则的三种状态 | 已排除（经 REST 各走一遍；代码与 CLAUDE.md 的四条逐句对过） |
| 8 | `TMUX_TMPDIR` 指向不存在的目录时 tmux 的行为 | 仍缺条件（要能随意使用默认 tmux 目录的环境）；读源码有新发现：tmux 3.0a 不回退到 `/tmp` |
| 9 | 百万级未合并提交时 `rev-list --count` 的 30 秒时限 | 已排除（100 万个提交 3.9 秒） |
| 10 | `git worktree remove` 到时限被杀之后的状态 | 已排除（实际杀了一次） |
| 11 | 行菜单跟随重建、「正在删除…」的行，真实窗口 | 已排除 |
| 12 | Electron 的 ICU 与 Go 的 Unicode 表 | 已排除（被拒码位集合相同，各 172 个） |
| 13 | 没有归属、也没有 `@vibe_remote_workdir` 的旧终端会话 | 已排除（会话被算进去并被结束） |

没有复现出缺陷，所以没有 X 编号。

---

## 1. M1 的整体画面（R8.1、R8.2）

做了什么：`gui-worktree-smoke.mjs` 的 R8.1 在临时实例（假 claude）里走一轮含工具调用和权限请求的对话，R8.2 开一个终端会话；两个用例除了截图，还断言形态和实际画出来的像素。

```
PASS R8.1 a chat session in the M1 look — user bubble #E3DEF7 r17 at the right of the column; assistant text from its left; input card r17; permission card r14; main card r14 with a shadow on #EFEFF4
PASS R8.2 a terminal session: shell and the four terminal colors follow the theme — painted: background #FFFFFF (98%), 18576 px near #1C1B22, cursor 512 px of #6B54D3, selection 10923 px of #D9D2F4; remote text and color shown as sent
```

R8.2 还对整窗截图数了旧配色和深色的像素（`#F5F4EF`、`#E6E1D8`、`#1E1E1E`、`#000000`，各不到 0.2%）。

逐块对照（`R8.1.png`、`R8.2.png` 对效果页 M1，即 `m1-chat.png`、`m1-terminal.png` 左半边）：

| 块 | 效果页 M1 | 实际 | 一致 |
|----|-----------|------|------|
| 窗口底色、侧边栏 | 冷灰底，顶部淡紫渐变 | `#EFEFF4`，顶部淡紫渐变 | 是 |
| 主区域 | 白色圆角卡片浮在底色上 | 白色，圆角 14px，有阴影，四周留边 | 是 |
| 侧边栏条目 | 两行：名字 + 类型 / 状态；选中是浅紫底 | 同 | 是 |
| 顶部标题 | 项目标签 + 项目 / 分支 / 会话名 | 项目标签 + 项目 / 分支 · 会话名 | 分隔符是「·」（tasks.md「后续」已记） |
| 用户消息 | 右对齐浅紫气泡 | `#E3DEF7` 气泡，圆角 17px，贴内容列右缘 | 是 |
| 助手消息 | 无气泡，从左起 | 同 | 是 |
| 工具行 | 一行，左侧按工具类型的图标，可展开 | 一行，左侧是状态点，可展开 | 图标不同（「后续」已记） |
| 权限卡片 | 圆角卡片，警示图标，命令框，编号选项，首选项紫底 | 同；「Esc 中断」在卡片底部 | 位置不同（「后续」已记） |
| 输入框 | 圆角卡片，与内容列同宽 | 圆角 17px，与内容列同宽 | 是 |
| 终端 | 白底深字，紫色光标，淡紫选区 | 像素实测 `#FFFFFF` / `#1C1B22` / `#6B54D3` / `#D9D2F4` | 是；效果页底部的一行状态没有做（「后续」已记） |

结论：已排除。没有旧配色残留，没有走样的块；与效果页的差异是开发阶段已经写进 tasks.md「后续」的那几处，没有新增。局限：逐块对照是看截图做的，不是像素比对。

## 2. 800×500、中英文下各对话框的真实布局（R8.5）

做了什么：新写 `dialog-layout.mjs`（对话框在窗口内；页脚每个按钮在窗口和对话框内，中心点 `elementFromPoint` 命中它，文字不被截；同一父元素的子元素两两不相交；文字横向被截必须带省略号，不能画到对话框外；只有正文滚动、页脚不动）。R8.5 把窗口模拟成 800×500，中文、英文各一轮，依次量 13 个画面。

```
PASS R8.5 the smallest window, 800×500, in Chinese and in English — 26 measurements at 800×500, no problem: zh-CN sidebar (80 rows); zh-CN picker, worktree mode, name refused; zh-CN new session in a worktree, chat off; zh-CN new worktree, usable name; zh-CN new worktree, name refused; zh-CN delete session; zh-CN delete worktree: clean; zh-CN delete worktree: files; zh-CN delete worktree: commits; zh-CN delete worktree: detached; zh-CN delete worktree: external; zh-CN delete worktree: failed, re-opened; zh-CN slash menu (13 commands); en sidebar (80 rows); en …（英文同样 13 项）
```

另外两个失败说明的对话框在各自的用例里量（中文）：R5.9 带错误重开的确认框、R5.12 的「删到一半」说明框（`delete-wt-failed`），都没有问题。

反向检查：把 `.modal` 的 `max-height` 改成不随窗口高度（临时副本），R8.5 报 19 个问题（对话框 `140,-200..660,700` 超出窗口、按钮在窗口外）。

结论：已排除。没覆盖的一种：`delete-wt-failed` 说明框的英文版（要真的删坏一个 worktree 才出现，只在中文下量了一次）。截图 `R8.5.png`（英文、800×500、文件加提交的确认框）。

## 3. 冷启动首帧（R8.6）

做了什么：临时实例的主进程用 `--inspect-brk` 停在第一条语句，装上记录器再放行：窗口一创建就读它的原生底色；`ready-to-show`（页面第一次绘制完成）时 `capturePage()` 取整帧。全新的临时 userData，每次运行都是冷启动。

```
PASS R8.6 a cold start shows the theme from the first frame — window background #EFEFF4 right after it was created (visible: true), first paint 94 ms after the window was created: gutters and sidebar #EFEFF4, card #FFFFFF, 0% dark pixels (text), none of the previous beige
```

断言：窗口创建后和首次绘制时的原生底色都是 `#EFEFF4`；首帧里主卡片周围的留边和侧边栏下半是 `#EFEFF4`（紧挨卡片的两条留边容差 12，因为卡片阴影落在上面），卡片中心是 `#FFFFFF`；旧米色不成片（不到 0.5%），深色像素不到 3%。截图 `R8.6.png` 就是那一帧。反向检查：把主进程的 `backgroundColor` 改成 `#1E1E1E`，用例失败（`got "#1E1E1E", want "#EFEFF4"`）。

实验中的一个现象（不是缺陷）：有的首帧里旧 daemon 机器下的说明条已经画出来了，它的暖色底（`#F3EDE5`）边缘有 189 个像素落在旧米色 `#E6E1D8` 的容差里，所以「没有旧配色」按面积判断，不按单个像素。

结论：能证明到「第一次绘制完成的那一帧」为止，已排除。仍缺的：窗口出现到第一次绘制之间（本机约 0.1 秒）屏幕上实际合成的画面，这要录屏才取得到；这段时间显示的是原生底色，而它已读到是 `#EFEFF4`。

## 4. 真实键盘（R7.1–R7.4）

仍缺条件：不允许向系统前台发按键，CDP 的按键不经过 macOS 的菜单分发和输入法。自动化能证明的：按键事件到达页面时，应用在 `window` 的捕获阶段拦下（`preventDefault`，之后的监听一个都收不到）、会话按侧边栏顺序切换、终端发往远程 0 字节、对话输入框的草稿不变；对话框打开时不拦截、不切换（R7.1–R7.5，`gui-smoke.mjs` 第 11 步）。

需要人做的步骤（打包后的 app，`cd desktop && npm run build -- --dir`，开 `release/mac-*/vibe-remote.app`，连一台有 5 个以上会话的机器）：

1. 焦点在终端里：按 ⌘3 → 切到侧边栏从上往下第 3 个会话；按 ⌘⇧] / ⌘⇧[ → 下一个 / 上一个，到头循环；终端里没有多出字符。
2. 焦点在对话输入框里（先打几个字）：按 ⌘⇧]、⌘1 → 会话切换；切回来草稿还在、没有多出 `}` 或 `1`。
3. 会话数少于 9 时按 ⌘9 → 不动。折叠一个项目后按 ⌘⇧] 转一圈 → 不停在其中的会话上。
4. 打开新建会话对话框、删除确认框各一次，按 ⌘2、⌘⇧] → 不切换。
5. 换成中文输入法（拼音）再做第 1、2 步 → 结果相同，输入法候选窗不弹出。
6. 看菜单栏：这些键没有触发系统或应用菜单里的任何一项（例如「显示上一个标签页」）。

## 5. git 低于 2.31

做了什么：从源码构建 git 2.30.2 并**安装**到临时目录（`make prefix=<临时目录> install`），放在 PATH 最前面。

(a) `.devflow.yml`「daemon 运行的 git 不运行 core.fsmonitor 指定的程序」那条规则的六个测试：

```
$ PATH=<git 2.30.2 prefix>/bin:$PATH git --version; git --exec-path
git version 2.30.2
<git 2.30.2 prefix>/libexec/git-core
$ PATH=<git 2.30.2 prefix>/bin:$PATH TMUX_TMPDIR=$(mktemp -d) go test -race -count=1 -timeout 10m -v ./internal/session -run '<the six tests of the rule>'
--- PASS: TestReadOnlyGitRunsNoRepositoryProgram (1.42s)
--- PASS: TestCreateAndRemoveWorktreeDoNotRunFsmonitor (1.01s)
    review_fixes_test.go:735: this git does not read GIT_CONFIG_COUNT (it is older than 2.31): there is nothing of this form to keep
--- PASS: TestGitEnvKeepsInheritedConfig (0.10s)
    --- PASS: TestGitEnvKeepsInheritedConfig/GIT_CONFIG_PARAMETERS (0.01s)
    --- SKIP: TestGitEnvKeepsInheritedConfig/GIT_CONFIG_COUNT (0.00s)
--- PASS: TestFsmonitorStaysOffOnGitWithoutConfigEnvironment (1.86s)
--- PASS: TestEveryGitCallTurnsFsmonitorOff (1.34s)
--- PASS: TestDirtyFilesDoesNotRunFsmonitor (0.78s)
PASS
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	7.972s
```

和待验证项写的期望一致：check 通过，`TestGitEnvKeepsInheritedConfig` 只跳过 `GIT_CONFIG_COUNT` 那个子用例。

(b) 临时 daemon 端到端（`ws-worktree-smoke.mjs`，`VR_GIT` 指向这个 git；完整输出见 `ws-worktree-smoke-git-2.30.2.txt`）：新建命名 worktree → 在其中开会话 → 删除（目录和分支都删）；第二个带 2 个未合并提交，不带同意项是 409，带 `deleteBranch` + `dropCommits` 后目录和分支都没了；9 个用例全部通过。

(c) 本需求用到的 git 命令在 2.30.2 上的行为（同一份脚本的第一个用例）：

```
PASS git: the commands the daemon relies on — update-ref <ref> <oid> "" creates only; worktree add --detach + symbolic-ref HEAD are listed with the branch; locked: --force refused ("fatal: cannot remove a locked working tree, lock reason: initializing"), --force --force removes it
```

即：被锁的 worktree 一个 `--force` 被拒、两个 `--force` 才删得掉，2.30.2 和 2.50.1 相同；`check-ref-format --branch`、`update-ref` 的「旧值为空才创建」和 `-d <旧值>`、`worktree list --porcelain`、`rev-list --count … --not --exclude=<分支> --branches --remotes`、`status --porcelain -z`、`ls-files --others --ignored --exclude-standard`、`for-each-ref` 前缀模式都可用。

结论：已排除。没测比 2.30.2 更早的版本（Ubuntu 20.04 是 2.25），支持的最低 git 版本仍未写进文档（tasks.md「后续」已有这一条）。

做实验时踩到的一处（与产品无关）：直接用构建目录里没安装的 `git` 跑，`TestEveryGitCallTurnsFsmonitorOff` 会失败（`git was run as ["status" "--porcelain" "--ignore-submodules=none"]`）。原因是没安装的 git 找不到自己的 exec-path，`git worktree remove` 内部再起 `git status` 时走 PATH，被测试里记录参数的包装脚本记了一笔；`core.fsmonitor` 仍是关的（`TestCreateAndRemoveWorktreeDoNotRunFsmonitor` 通过）。安装后不再出现。这一点写进了 verify skill。

## 6. 全新的 tmux 环境、没有 tmux 程序

做了什么：`ws-worktree-smoke.mjs` 各起一台临时 daemon，经 REST 删除一个没有会话的 worktree。

```
PASS tmux: a fresh socket directory, chat sessions only — 200 {"removed":true,"branchDeleted":false,"endedSessions":[]}; no socket at <work>/fresh/t/tmux-501/vibe-remote before or after; the chat session still runs
PASS tmux: no tmux program on the daemon's PATH — 200 {"removed":true,"branchDeleted":false,"endedSessions":[]} with use_tmux: true and no tmux in <work>/gitbin:/usr/bin:/bin:/usr/sbin:/sbin
PASS tmux: the server has exited and left its socket file — tmux says "no server running on <work>/exited/t/tmux-501/vibe-remote" (socket file left behind): 200 {"removed":true,"branchDeleted":false,"endedSessions":[]}
```

(a) 全新的 `TMUX_TMPDIR`、只开对话会话：200，目录被删，前后都没有出现 tmux 的 socket 文件（没有起 tmux server），对话会话还在。(b) `use_tmux: true`、PATH 里没有 tmux：200，目录被删。另加一例：server 已退出、socket 文件还留着（tmux 回答 `no server running`，即四条规则的第 ② 种）：200。

结论：已排除。

## 7. 对账的四条规则（三种状态）

做了什么：同一份脚本，经 REST 走删除；每例都读回磁盘和 tmux。

```
PASS tmux: the socket file is removed while the server runs — socket gone: 500 "could not read the running sessions from tmux, so the sessions in this worktree are not known; nothing was removed: tmux's socket file <work>/nosock/t/tmux-501/vibe-remote is gone while the daemon remembers terminal sessions. If tmux is still running, sending SIGUSR1 to the tmux server process makes it create the socket again; otherwise restart the daemon", endedSessions [], directory, branch and session untouched; after SIGUSR1 to the server (pid of this run): 200 {"removed":true,"branchDeleted":false,"endedSessions":["1795111407327-edd242cb"]}
PASS tmux: no tmux program on PATH but its socket is there — status listed sessions []; remove: 500 "could not read the running sessions from tmux, so the sessions in this worktree are not known; nothing was removed: the tmux program was not found on the daemon's PATH, but tmux's socket <work>/pathless/t/tmux-501/vibe-remote is there: terminal sessions may be running behind it. Put tmux on the daemon's PATH and restart the daemon", endedSessions [], directory, branch and the tmux session untouched
```

(a) server 活着、socket 文件被删、表里有终端会话：500 `worktree_remove_failed`，`endedSessions` 是 `[]`，目录、分支、会话都在，tmux server 进程还活着，`message` 写明 socket 文件不见了、对 tmux server 发 SIGUSR1 可以重建；对这台临时 daemon 自己的 tmux server 发 SIGUSR1 之后 socket 文件重新出现，再删除是 200，会话被结束。(b) PATH 里没有 tmux 而 socket 在（先用有 tmux 的 PATH 起 daemon 开会话，停掉，再用没有 tmux 的 PATH 起同一台）：500，`endedSessions` 是 `[]`，目录、分支和 tmux 会话都在，`message` 写明找不到 tmux 程序但 socket 在。(c) 全新环境：见第 6 条，200。

(b) 里顺带看到的（tasks.md「后续」已记，不是新问题）：这时 `GET /api/v1/worktrees/status` 的 `sessions` 是 `[]`——查状态不看对账有没有成功，确认框会少列会话；删除被 500 拦住，所以不丢东西。

读代码：`runner.go` 的 `readTmuxSessions` 与 CLAUDE.md「删除 worktree」一段的四条逐句对过，一致（① tmux 回答了；② `isNoTmuxServer`；③ 运行失败或找不到程序，且 socket 不存在，且表里没有终端会话；④ 其余）。

反向检查（同一份脚本对着旧提交构建的 daemon，`VR_DAEMON=`）：

```
# 6c77d1c（第二轮评审的 R1：socket 不存在一律拒绝）
FAIL tmux: a fresh socket directory, chat sessions only — removing a worktree without sessions: got [500,{"endedSessions":[],"error":"worktree_remove_failed","message":"could not read the running sessions from tmux, so the sessions in this worktree are not known; nothing was removed. Try again"}], want [200,{"removed":true,"bran…
FAIL tmux: no tmux program on the daemon's PATH — removing a worktree without sessions: got [500,{"endedSessions":[],"error":"worktree_remove_failed","message":"could not read the running sessions from tmux, so the sessions in this worktree are not known; nothing was removed. Try again"}], want [200,{"removed":true,"branchDelete…
FAIL tmux: the socket file is removed while the server runs — the message does not say what happened and what to do: could not read the running sessions from tmux, so the sessions in this worktree are not known; nothing was removed. Try again
FAIL tmux: no tmux program on PATH but its socket is there — the message does not say why: could not read the running sessions from tmux, so the sessions in this worktree are not known; nothing was removed. Try again
# 1d9a6f1（第三轮评审的 T1、T2：放得太宽）
FAIL tmux: the socket file is removed while the server runs — removing the worktree with its session, the socket file gone: got [200,null,[]], want [500,"worktree_remove_failed",[]]
FAIL tmux: no tmux program on PATH but its socket is there — removing the worktree: got [200,null,[]], want [500,"worktree_remove_failed",[]]
```

结论：已排除。这只是测试工程师做的实验，不代替关口 C 独立验证者再看一遍。

## 8. `TMUX_TMPDIR` 指向不存在的目录时 tmux 把 socket 放在哪

仍缺条件：这个实验会让 tmux 在默认目录 `/tmp/tmux-<uid>/` 下创建 socket，本机不允许在那里跑 tmux。要在容器或别的可以随意使用默认 tmux 目录的环境里做：`TMUX_TMPDIR=/nonexistent tmux -L vibe-remote new-session -d`，看 socket 落在哪；再用发行版自带的 tmux 3.0、3.1、3.2 各做一次。

这次补读了 tmux 源码（`tmux.c` 的 `make_label`，取自 GitHub 的对应 tag）：

- **3.2a**：`expand_paths(TMUX_SOCK, …, ignore_errors=1)`，`realpath` 失败的一项被跳过，落到下一项 `/tmp/`。与 3.6a、与 `tmuxSocketPath` 的算法一致。
- **3.0a**（Ubuntu 20.04 自带）：`TMUX_TMPDIR` 非空就只用它：`base = $TMUX_TMPDIR/tmux-<uid>`，`realpath` 失败时原样使用，随后 `mkdir(base)` 失败，tmux 报错退出。**不回退到 `/tmp`**。与 `tmuxSocketPath`（解析不了就用 `/tmp`）不一致。
- 3.1c 没读到（下载失败），不知道分界在 3.1 还是 3.2。

3.0a 上这种不一致的后果（推演，没有实跑）：`TMUX_TMPDIR` 指向不存在的目录时，tmux 根本起不来，这台 daemon 开不了终端会话；daemon 去看的是 `/tmp/tmux-<uid>/vibe-remote`。那里没有文件且表里没有终端会话 → 按「没有会话」处理，正确；那里恰好有别的 daemon（没设 `TMUX_TMPDIR`）留下的 socket → 按对账失败处理，这台 daemon 上删 worktree 一律 500。方向是拒绝，不会删掉会话脚下的目录。建议：不改代码，在文档里写明 `TMUX_TMPDIR` 必须指向存在的目录；是否处理留给后续。

## 9. 百万级未合并提交

做了什么：`git fast-import` 造一条有 100 万个提交、不被任何其他分支包含的分支 `big`（约 10 秒，`.git` 157 MB），给它建一个 worktree。

```
$ time git rev-list --count refs/heads/big --not --exclude=big --branches --remotes     # 连跑 3 次
1000000 real 3.89 user 3.82 sys 0.04
1000000 real 3.90 user 3.82 sys 0.04
1000000 real 3.89 user 3.82 sys 0.04
# 临时 daemon（allowed_roots 只有这个临时目录）
GET /api/v1/worktrees/status → 200 in 4024 ms: branch big, unmergedCommits 1000000, dirtyFiles 0, managed false
GET /api/v1/worktrees/status → 200 in 3980 ms: branch big, unmergedCommits 1000000, dirtyFiles 0, managed false
GET /api/v1/worktrees/status → 200 in 3973 ms: branch big, unmergedCommits 1000000, dirtyFiles 0, managed false
```

结论：已排除。3.9 秒，低于期望的 10 秒（30 秒时限的三分之一），数字正确。顺带：这样的 worktree 上查状态要 4 秒，桌面端 REST 的超时是 8 秒，确认框会晚 4 秒出来。

## 10. `git worktree remove` 到时限被杀

做了什么：从 HEAD 的临时 `git worktree` 构建一台只把 `gitTreeTimeout` 从 5 分钟改成 4 秒的 daemon（临时副本，用完即删，没有提交）；它的 PATH 前面放一个 git 包装脚本：遇到 `worktree remove` 就先删掉那个 worktree 里的 `.git` 文件，然后起一个 `sleep 60` 不返回。worktree 里有一个运行中的终端会话。

```
before: status.sessions ["1795109711574-33ddf7ac"], branch topic-a
POST /api/v1/worktrees/remove → 500 after 4265 ms
{"endedSessions":["1795109711574-33ddf7ac"],"error":"worktree_remove_failed","message":"git worktree remove <root>/wt/a: no answer within 4s: context deadline exceeded; git no longer lists this worktree, but part of its directory is left at <root>/wt/a; the branch was not deleted"}
endedSessions is the session that was running there: true
status again → 404 {"error":"worktree_not_found","message":"not a worktree this daemon can see"}
sessions left on the daemon: []
disk: directory there (["README.md"]); git worktree list: worktree <root>/repo | HEAD c80689f8988cb6c922b88a4456be9fa047c12e95 | branch refs/heads/main |  | worktree <root>/wt/a | HEAD c80689f8988cb6c922b88a4456be9fa047c12e95 | branch refs/heads/topic-a | prunable gitdir file points to non-existent location; branch topic-a: there
/api/v1/projects worktrees: ["<root>/repo"]
the git that did not return (a shell and the sleep it started): shell gone, its child gone
```

结论：已排除。响应是 500，带真实的 `endedSessions`，`message` 写明超过时限、目录还剩一部分和它的路径、分支没有删；再查状态是 404（桌面端据此显示「删到一半」的说明框），磁盘与之一致：目录还在，分支还在，会话已结束。没返回的 git（包装脚本和它起的 `sleep`）都被杀掉了。

一处措辞上的出入（不影响结论）：这个实验里 git 自己的列表其实还列着这个 worktree，只是标成 `prunable`（包装脚本删了 `.git` 文件，而真正的 git 是先注销再删目录）；daemon 把 `prunable` 当作不在列表里，所以 `message` 说的是「git no longer lists this worktree」。

## 11. 行菜单跟随重建、「正在删除…」的行（真实窗口）

做了什么：`gui-worktree-smoke.mjs` 的两个用例。X11.menu：把一行滚到可见处，打开它的「⋯」菜单，让应用自己的轮询函数刷新两次（确认行确实被重建），再点菜单项。X11.removing：把 `POST /api/v1/worktrees/remove` 和随后的 `/api/v1/projects` 各拖慢 3 秒（在渲染进程里包了一层 `fetch`），从确认到这一行消失每 150 ms 看一次。

```
PASS an open row menu survives the sidebar being rebuilt and still works (review, pending 11) — after two rebuilds the menu is still 3px from the same button, the sidebar is still scrolled to 1295px, and the item opens the confirmation
PASS a worktree being deleted says so until its row is gone (review, pending 11) — 41 looks over 6371 ms (request and list each delayed 3000 ms): the row always said "正在删除…" with "new session" off, then went away
```

反向检查：重建时直接关菜单 → `the menu closed when the sidebar was rebuilt`；不标记在途的删除 → `24 of 24 samples show an ordinary row while it was being deleted`。

结论：已排除。延迟用的是 3 秒而不是待验证项写的 5 秒（够覆盖一轮 5 秒轮询里的重建：观察持续 6 秒以上）。

## 12. Electron 的 ICU 与 Go 的 Unicode 表

做了什么：在临时实例的渲染进程里（CDP）对全部码位（除代理区）跑 `/[\p{Cf}\p{Zl}\p{Zp}]/u`；Go 一侧用 `unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp)`（`worktree.go` 里用的同一个调用）。

```
count 172 unicode 15.0.0                                   # go run（Go 1.26.2）
renderer: 172 code points rejected; Chrome/152.0.7977.130 Electron/44.7.0
identical sets                                             # diff 两份码位清单
```

结论：已排除。两边被拒的码位集合相同，各 172 个。（第二轮评审写的「各拒绝 253 个」口径不同，可能连空白和控制字符一起数了；这里只比待验证项指的那条正则。）

## 13. 没有归属、也没有 `@vibe_remote_workdir` 的旧终端会话

做了什么：在临时 daemon 自己的 `TMUX_TMPDIR` 下手工起一个 `vibe-remote-1794824025040-12b763ac` 的 tmux 会话（工作目录在一个 worktree 里，不设任何 `@vibe_remote_*` 选项），然后才启动 daemon；不请求 `/api/v1/projects`、`/api/v1/sessions`，直接查这个 worktree 的状态并删除。

```
PASS a terminal session from before the upgrade is counted and ended — status.sessions ["1794824025040-12b763ac"]; remove 200 {"removed":true,"branchDeleted":false,"endedSessions":["1794824025040-12b763ac"]}; directory gone, tmux session ended
```

结论：已排除。status 的 `sessions` 含这个会话，删除时它被结束，目录被删。
