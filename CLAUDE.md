# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目本质

vibe-remote 是一个「远程 Claude 终端」桌面工具：真正的 `claude` CLI 始终跑在**远程 Linux** 上。新建会话时选两种界面之一（建好后不能互换）：

- **终端模式**（默认）：PTY→tmux→claude，桌面端（Electron + xterm.js）只是**哑终端**，通过 WebSocket 双向透传 PTY 字节流。
- **对话模式**：daemon 以 `claude -p --input-format stream-json --output-format stream-json …` 直接持有 claude 进程，桌面端渲染结构化消息（消息、工具块、diff、权限/计划/提问卡片），交互参考 Claude Code 的 VS Code 插件。

**核心设计约束 —— 终端模式纯字节透传**：终端模式下客户端**绝不解析** claude 的输出。PTY 字节流（含 ANSI 转义、颜色、光标控制、box-drawing）原样双向搬运，所以流式/颜色/重绘全部 0 失真「免费」还原。任何「解析终端输出来做富文本」的想法都违背此架构 —— 终端模式下的「富文本」指的是**外壳 UI 的精致度**（侧边栏、标题、状态栏，外观以 `docs/changes/2026-11-16-project-worktrees` 选定的 M1 方案为准），不是解析终端内容。这条约束是终端模式成立的前提，改动时优先维护它。

**第二条数据通路 —— 对话模式（只支持 claude）**：结构化消息来自 claude 的 stream-json，而不是解析 PTY。daemon 只读信封字段（`type`、`message.id`、`request_id`、`result`…）来缓冲、补发和管理待答请求，消息体原样转发；解析与渲染在客户端 `desktop/src/renderer/chat/`。模型输出只经 `chat/markdown.ts`（markdown-it `html:false` → DOMPurify）进 DOM，`chat/` 下只有它能写 `innerHTML`（`test-chat-render-guard` 守着）；工具输出、diff 一律 `textContent`；链接经主进程 `open-external`（只放行 http/https/mailto）用系统浏览器打开。对话模式只支持 claude：`claude_cmd` 第一个词的文件名不是 `claude`、含 shell 语法、自带 `-p`/`--resume` 等冲突参数，或 claude 版本低于 2.1.210 时，`/api/v1/info.chat.supported=false`，新建对话框把「对话」卡片置灰并写明原因。

终端模式是 **agent 无关**的：把 `claude_cmd` 换成 `codex` 或任意交互式 CLI 都照常工作（tmux 持久化、重连、resize、Ctrl+C 全部通用）。对话模式不是：它依赖 claude 的 stream-json 与 control protocol。

## 常用命令

```bash
make check                     # 唯一检查入口（CI/CONTRIBUTING/release 都只调它）：gofmt + vet + test -race + desktop typecheck + npm test
make dist-daemon               # 交叉编译 linux/darwin × amd64/arm64 → dist/（版本经 -ldflags 注入）

# 服务端（Go）
make server                    # 构建 → bin/vibe-remoted
make dev-server                # go run，读 ../vibe-remoted.json
cd vibe-remoted && go test ./...    # 单元测试（config 包含路径越权 + bind 校验）
cd vibe-remoted && go test ./internal/config -run TestValidateBindAddr   # 跑单个测试
cd vibe-remoted && go vet ./...

# 交叉编译部署到远程 Linux（远程通常无 Go）
cd vibe-remoted && GOOS=linux GOARCH=amd64 go build -o ../bin/vibe-remoted-linux-amd64 ./cmd/vibe-remoted
scp bin/vibe-remoted-linux-amd64 dev:~/vibe-remoted

- 客户端（Electron）
cd desktop && npm install
cd desktop && npm run dev       # Vite + Electron 热重载
cd desktop && npm run typecheck # tsc --noEmit
cd desktop && npm run build     # tsc + vite build + electron-builder → dist/*.dmg

make smoke                      # curl localhost:8765/healthz
```

打包时用国内镜像加速 electron 二进制：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

**Electron ≥42 不再在 `npm install` 时下载二进制**：首次 `require('electron')` / 运行时才同步下载（GitHub 慢时看似卡死）。新环境先跑 `ELECTRON_MIRROR=… npx install-electron --no` 预下载。electron-builder 打包时另行下载，同样需要 `ELECTRON_MIRROR`。

**桌面通知走主进程**（`main/index.ts` 的 `notify()`）：Electron ≥42 的 macOS 通知改用 UNUserNotificationCenter，**只对已签名 app 生效**。未签名 DMG 里 renderer `new Notification()` 静默失败（show/error 都不触发），主进程 Notification 会发 `failed`（UNErrorDomain 1），于是降级为 Dock 弹跳 + 角标（窗口聚焦时清除）。不要改回 renderer 的 web Notification。

**GUI 回归**：`node .claude/skills/verify/scripts/gui-smoke.mjs` 用 CDP 驱动构建产物（临时 daemon + 临时 userData + `--use-mock-keychain`，不碰真实 machines.json / 钥匙串），覆盖迁移、新建会话、输入、鼠标上报下拖选 ⌘C、⌘V、导航锁、通知、断线重连、三层侧边栏的布局、切换会话的快捷键；`gui-chat-smoke.mjs` 覆盖对话会话的验收场景。升级 Electron / 改终端、剪贴板、侧边栏或样式后必跑。**本机有真实 daemon 在跑时，命令前带独立的 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX)`**（`go test`、`make check` 同理）：脚本里跑终端会话的那台临时 daemon 不自己设这个变量，不带的话它和本机的 `tmux -L vibe-remote` 共用一个 socket。

### 远程 daemon 部署同步

桌面端与 `vibe-remoted` 必须保持兼容版本。修改 Go daemon 或协议后，先交叉编译再替换远程二进制；仅重启旧 daemon 不会更新协议。Windows/虚拟机 NAT 场景下，SSH Host 地址可能与 daemon 实际监听的 NAT 地址不同，桌面端应填写能实际返回 `/healthz`、`/api/v1/info`、`/api/v1/sessions` 的地址。



```text
desktop/       Electron + xterm.js macOS 客户端
vibe-remoted/  Go daemon：REST + WebSocket + PTY/tmux 会话生命周期
docs/          协议与发布文档
```

当前仓库只维护上述桌面终端产品线。iOS、Android、web 客户端、共享 React 包和 portal 均不属于当前版本；旧实现若需研究只能从 Git 历史恢复。



### 会话持久化模型（PTY → tmux → claude）

单一事实来源是 **tmux**，不是服务端内存。每个 vibe-remote 会话 = 一个 tmux 会话 `vibe-remote-<id>`，跑在**专用 socket** `tmux -L vibe-remote` 上（隔离用户自己的 tmux；`set -g status off` 让 claude 拿到全高 PTY —— 否则 status 栏吃掉 1 行导致错行）。

- 客户端断开 → `Runner.DetachEpoch` 关 PTY，**tmux + claude 存活**。
- 客户端重连 → `Runner.AttachExisting` 新起 PTY 重新 `tmux attach` + `refresh-client` 强制全屏重绘 → 现场恢复。
- 服务端重启后内存 map 空 → `Manager.List` / `Manager.Attach` 靠 `tmux list-sessions` / `has-session` 找回会话（`liveTmuxSessions` 查 `pane_current_path` 回填 workdir）。
- `Manager.List` 以 tmux 为准**双向 reconcile**：map 有 tmux 无的删（幽灵会话），tmux 有 map 无的补建恢复条目（隐形会话）。查询失败时回退内存 map，避免瞬时故障误删。
- 会话的创建时间和归属也存在 tmux 用户选项里（和 `@vibe_remote_name`、`@vibe_remote_mode` 等一起在 `start` 里写）：`@vibe_remote_created`（RFC 3339 纳秒 UTC）、`@vibe_remote_project`、`@vibe_remote_home`。找回会话时创建时间取 `@vibe_remote_created`，没有才退到 tmux 自带的 `session_created`，读回后转成本地时区（否则重启后 `/api/v1/sessions` 的 `created` 从 `+08:00` 变成 `Z`）。`list-sessions` 的格式串是 13 列，`parseTmuxSessionLine` 只接受 8、9、13 列——加列时两处一起改。

相关文件：`vibe-remoted/internal/session/runner.go`（PTY/tmux 生命周期）、`manager.go`（会话表 + reconcile）。

### 对话会话模型（对话模式：daemon 直接持有 claude 进程）

对话会话**不在 tmux 里**：stream-json 走 stdin/stdout 管道，daemon（`vibe-remoted/internal/chat/session.go`）直接持有进程，并**始终排空 stdout**（管道写满 claude 会阻塞）。

- 客户端断开**不停进程、不发 exit**；进程只因删除、重载、交接、daemon 退出或自己退出而结束。只有真退出才发 `exit` 帧 + `chat_state.ended`。
- 断线补发：每个 epoch（每次起进程 +1）内所有出站消息带递增 `seq`，内存环形缓冲 1000 条 / 32 MiB（流式尾巴另存）。重连 attach 带 `epoch`+`since` 且仍在缓冲内 → 增量补发；否则 `reset` 同步：先发 claude 的 JSONL 历史（完整、分批 200 帧流式读，`h:true`），再发缓冲，最后一条 `chat_state` 是同步结束标志。待答的权限请求（`chat_state.pending`）不受缓冲淘汰影响。
- 持久化：`<state_dir>/chat-sessions.json` 只记会话元数据（名字、workdir、拆好的参数、claude 会话 id、状态），**不存消息**；历史以 claude 自己的 JSONL（`$CLAUDE_CONFIG_DIR/projects` 或 `~/.claude/projects`）为准。daemon 重启后对话进程不存活：记录改为 `ended/daemon_restart`（孤儿进程先确认杀掉），「重新启动」= reload，用 `--resume <同一 id>` 接上（无 JSONL 时 `--session-id`）。
- **同一 claude 会话 id 任何时刻最多一个进程**：`Manager.claudeOwners` 先 claim 后 spawn；重载/交接/删除共用 `Session.WithOp`（不可重入），停进程 = interrupt → 等本回合 result ≤2 s → SIGTERM 进程组 → 1 s 内 claude 没退出或 stdout 没到 EOF（组里有忽略 SIGTERM 的后代占着）→ SIGKILL 进程组 → `Wait` → join 读协程（≤1 s），确认旧进程退出后才起新进程。对话 `-c` 指向的 claude 会话已在别的对话会话里 → `ready.existing`；被终端会话持有 → fatal `claude_session_busy`。
- 交接（「新建终端会话接上」）：attach 带 `handoffFrom`，daemon 先停对话进程，再新建终端会话运行 `claude <原参数> --resume <id>`（命令只在服务端拼），原对话会话标 `ended/handed_off`。该终端会话持有这个 claude 会话 id（tmux 选项 `@vibe_remote_claude_u`，reconcile 跨重启恢复），被删除或 tmux 会话消失时释放。
- **终端会话的 continue 改写**：daemon 自己以 continue 语义（`claude_cmd`/勾选 flag 带 `-c`/`--continue`）启动的终端会话，启动前把 `-c` 改写为 `--resume <该目录最近一次对话 id>`（没有记录时为 daemon 生成的 `--session-id <uuid>`）并原子占用，这样同一段对话不会被终端和对话两边同时打开；与运行中的对话会话冲突时新建返回 fatal `claude_session_busy`、重载返回 409。其余终端会话的命令原样不动。

相关文件：`vibe-remoted/internal/chat/`（`session.go` 进程监护与缓冲、`control.go` control protocol、`history.go` JSONL、`store.go` 会话表、`cmdline.go` 命令拆词与拼接、`probe.go` 版本探测、`trust.go` 工作区信任）、`internal/session/manager.go`（对话会话表、占用表、交接）、`internal/server/ws.go`（`wsChatRelay`）。

### 项目与 worktree（会话归属、项目清单、命名 worktree）

侧边栏按「机器 → 项目 → worktree → 会话」组织。项目 = 一个 git 仓库的主目录（非 git 目录各自成项目），树由 daemon 的 `GET /api/v1/projects` 给出（`internal/session/projects.go`）：每个项目只跑一次 `git worktree list`（8 路并发、5 秒超时），**不在列表里跑 `git status`**（100 个 worktree 时会让每 5 秒一轮的轮询超时；改动数只在删除确认时现查）。

- **会话归属在创建时算一次，之后不随 `cd` 变**：`project`（项目 id = 主目录）和 `home`（所在 worktree 根；非 git 时是工作目录）。终端会话存 tmux 选项，对话会话存 `chat-sessions.json` 的 `project`/`home`。创建时 git 失败（超时等）就**不写归属**、留空，之后每次 `Projects()` 重试补上——写错一次会把 git 仓库里的会话永久记成非 git 项目。
- **`<state_dir>/projects.json`**（`projects_store.go`）记两样：开过会话的 git 项目清单（`POST /api/v1/projects/remove` 只是从清单移除，不碰磁盘；项目下还有会话时 409），和 **vibe-remote 自己创建的 worktree**（路径 + 分支）。后者决定 `managed`：只有记录里路径和当前分支都对得上的 worktree（以及升级前留下的 `…-worktrees/<会话id>` + `vibe/<会话id>`，id 必须是 daemon 生成过的形态）才算自己建的，**只有 `managed` 的 worktree 才可能连分支一起删**；宁可判成「外部」。`ProjectStore` 的锁是叶子锁，持有 `Manager.mu` 时不调它（`Manager.mu` 下不做文件 IO）。
- **删会话不再碰 worktree**（协议 4）：`Manager.Delete` / `deleteChat` 只结束会话，worktree 的目录和分支都留着，以「没有会话」的行留在侧边栏；`DELETE /api/v1/sessions/{id}` 不再返回 409 `worktree_preserved`（桌面端仍处理它，因为协议 3 的 daemon 还会返回）。
- **新建 worktree**（`worktree.go` 的 `CreateWorktree`；attach 带 `mode:"worktree"`，协议 4 可再带 `worktreeName` = 新分支名）：同一仓库的新建和删除在 `Manager.repoLocks` 下串行。目录和分支都用「不存在才创建」的操作去占（`os.Mkdir`、`git update-ref refs/heads/<名> <OID> ""`），再 `git worktree add --detach` + `symbolic-ref HEAD`；失败时 `CreatedWorktree.Undo` **只撤销本次占到的东西**（靠状态判断：这一项是不是本次的分支 / 本次的提交），别人同时建的同名目录或分支原样不动。`GET /api/v1/worktrees/plan` 的预检和真正新建走同一个 `precheckWorktree`，两边不会给出不同结论。
- **删除 worktree**（`projects.go` 的 `RemoveWorktree`，`POST /api/v1/worktrees/remove`）：桌面端先 `GET /api/v1/worktrees/status` 取数字弹确认框，再把「看到的 `head`、会被结束的会话、同意了什么（`discardFiles` / `deleteBranch` / `dropCommits`）」带回来；daemon 删除前重查，与确认时不一致就 409 `worktree_changed`（带最新状态），**只做用户同意过的事**。动手之前先拦三种，什么都不改就返回 500 `worktree_remove_failed`：被 `git worktree lock` 锁定、里面有初始化过的子模块或嵌入式仓库的检出、里面嵌着同一仓库的另一个 worktree（外层的 `git status` 看不到它，删外层会把它连未提交文件一起带走）。通过之后才逐个结束会话，结束完**再核对一次 HEAD**（会话正是最可能在这几秒里提交的东西），再 `git worktree remove`（只有同意丢弃文件时才 `--force`）。从结束会话起的每一种失败都在响应里带 `endedSessions` 如实报告——会话结束了撤不回。主目录不能删。
- **删除与新建互斥**：`startingDirs`（正在创建会话的工作目录）和 `removingRoots`（正在删除的 worktree 根）都在 `Manager.mu` 下；删除时有会话正在其中创建 → 409，删除期间在其中新建会话 → fatal `create_failed`。锁的先后固定：创建占位（`beginCreate`）→ 仓库锁 → `chat.Session.opMu` → `Manager.mu` → `ProjectStore` 的锁。
- **交给 git 的东西**：分支一律写成完整引用名 `refs/heads/<名>`（短名会被 git 展开：`@{-1}` 是「上一个检出的分支」，同名 tag 会抢走解析），daemon **不调用 `git branch`、不用 `worktree add -b/-B`**；git 的环境固定 `LC_ALL=C` 并去掉继承来的 `GIT_DIR` 等变量（`worktree.go` 的 git 环境）；**不靠匹配 git 的报错文字做判断**（分支在不在看 `show-ref` 退出码，worktree 在不在看列表，删除为什么失败靠重查状态）——远程机器的 git 可能是翻译过的。子模块和 `--separate-git-dir` 的仓库（`git worktree list` 第一项是 git 目录而不是主目录，`Home.Single`）里不能新建命名 worktree，它们的 worktree 也不能从界面删除。

相关文件：`vibe-remoted/internal/session/worktree.go`（git 读写、名字校验、创建与撤销）、`projects.go`（项目树、状态、删除、预检）、`projects_store.go`（`projects.json`）、`trust.go`（对话界面的信任规则）；桌面端 `tree.ts`、`sidebar.ts`、`worktree-dialogs.ts`、`session-form.ts`。设计与取舍见 `docs/changes/2026-11-16-project-worktrees/`。

### epoch 代际（防重连竞态）

`Runner.epoch` 每次装新 PTY（start / AttachExisting）+1。relay（`ws.go:wsRelay`）在 attach 后捕获自己的 epoch，teardown 时调 `DetachEpoch(epoch)` —— **只在仍拥有当前 epoch 时才关 PTY**，避免旧连接慢速 teardown 误关新重连已装的 PTY。Read/Write 用 `ptmxSnapshot()` 锁内快照后再阻塞操作，避免阻塞的 Read 卡死 Resize/Detach。改动 runner 的 PTY 生命周期时务必保持 race build 通过（`go build -race`）。

### exit 帧语义

`wsRelay` 用 `detaching atomic.Bool` 区分「我方主动 detach（会话在 tmux 里还活着）」vs「claude 进程真退出」。**只有真退出才发 exit 帧**。正常客户端断开不能发 exit（否则客户端会以为会话死了）。

### 协议（单一事实来源：docs/protocol.md）

JSON 分帧 WebSocket，帧靠 `type` 区分，PTY 字节走 base64（`data` 帧）；对话会话走 `chat_sync`/`chat`/`chat_state`/`chat_ack`（S→C）与 `chat_send`/`chat_respond`/`chat_interrupt`/`chat_set_mode`（C→S），只在 `ui:"chat"` 的 `ready` 之后有效。Go 端 `vibe-remoted/internal/protocol/protocol.go` 与 TS 端 `desktop/src/shared/protocol.ts` **必须手动保持对齐**（无代码生成）—— 改协议时两端都要改，并同步 `docs/protocol.md`。

握手时序：`auth`（首帧，10s 超时）→ 服务端推 `sessions` 列表 → 客户端可空闲浏览（ping/pong 保活，**无 attach 超时**，但 90s 无任何帧即断）→ `attach`（空 sessionId=新建，带 workdir + 客户端生成的 `newSessionId`；worktree 模式可带 `worktreeName`）→ `ready`（带 `proto`）→ 双向 `data`。

**协议版本**：`protocol.Version`（Go）/ `PROTOCOL_VERSION`（TS）当前为 4。3 = 对话模式：`attach.ui/epoch/since/handoffFrom`、`chat*` 帧、`ready.ui`、`sessions[].ui/state/activitySeq/epoch/endReason`、`info.chat`。4 = 项目与 worktree：`attach.worktreeName`、`/api/v1/projects`、`/api/v1/projects/remove`、`/api/v1/worktrees/plan|status|remove` 五个端点、删会话不再清理 worktree、`chatTrust` 的 worktree 规则；**4 没有改任何 S→C 帧**，终端会话的帧除 `proto` 外仍与 v2 逐字节相同（`TestTerminalFramesUnchangedV3` 守着，`TestV3ClientFlowAgainstV4Daemon` 用协议 3 的字面帧走一遍协议 4 的 daemon）。`ready` 和 `/api/v1/info` 下发 `proto`（旧 daemon 不发 = 1）。帧/端点新增对端可能依赖的行为时 +1，并更新 protocol.md 的版本表。旧 daemon 会**静默忽略**新字段（例如把带 `worktreeName` 的 attach 建成自动命名的 worktree），所以客户端要先看版本、把入口置灰并提示用户，而不是假设功能存在。**功能各自按自己的最低版本判断**：对话界面用 `CHAT_MIN_PROTO`（3），不要拿 `PROTOCOL_VERSION` 比——否则每升一次版本都会把上一版 daemon 的对话界面误判成不支持。桌面端与相邻版本的 daemon 互连时怎样降级，见 protocol.md 的「版本互连」。

**错误帧 `code` + `fatal`**：`fatal: true` = 原样重试不可能成功（`session_not_found`、`invalid_workdir`、`auth_failed`…），客户端清空待重放的 attach 并**停止重连**。只有真正的暂时故障（`attach_failed`）才不标 fatal。新增错误路径时务必选对——标错 fatal 会让可恢复的会话被放弃，漏标会让死会话无限重连。v3 新增的 `ui_mismatch`（会话类型与 attach 的 `ui` 不符，含旧桌面接入对话会话）、`chat_unsupported`、`claude_session_busy` 都是 fatal；v4 新增的 `invalid_worktree_name`、`worktree_branch_exists`、`worktree_path_exists`、`worktree_path_not_allowed` 也都是 fatal（换个名字才可能成功）；`shutting_down`（daemon 正在退出时新建对话）不是，客户端带同一个 `newSessionId` 退避重连。对话帧的失败用只发给发起方的 `chat_ack{ok:false, code}`，**不用** `error` 帧（`error` 的语义是「随后断开」）；对话会话运行中的失败（进程退出、版本过旧、重启失败）走 `chat_state.ended`，连接保持、客户端不重连。

**存活检测**：服务端 relay 阶段发 WebSocket 协议层 ping（30s/20s 超时），客户端看门狗在**连续 2 个 ping 都没换来任何入站帧**时判死重连。半开连接不会触发 onclose，别删这两层。客户端**不能**改成「N 秒无数据」的静默超时：窗口隐藏时 Chromium 把定时器节流到约 1 次/分钟，健康的后台会话会被反复断开（`test-client-liveness.mjs` 的 throttled 用例守着这点）。

辅助 REST（除 `/healthz` 外均需 Bearer token）：`/api/v1/info`（v3 带 `chat` 可用性，`?recheck=1` 重新探测 claude 版本）、`/api/v1/sessions`、`GET /api/v1/projects`（v4，项目树；旧 daemon 404，桌面端据此回退到按会话字段分组）、`POST /api/v1/projects/remove`（v4）、`GET /api/v1/worktrees/plan`（v4，新建前的只读预检）、`GET /api/v1/worktrees/status` 与 `POST /api/v1/worktrees/remove`（v4；remove 逐个结束会话，可能比别的请求慢得多，桌面端给它单独的超时 `10 s + 5 s × 会话数`、上限 60 s，超时后再查一次 status 定结果，daemon 那边不随请求断开而中止）、`DELETE /api/v1/sessions/{id}`（v4 起只结束会话）、`POST /api/v1/sessions/{id}/rename`、`POST /api/v1/sessions/{id}/reload`（对话会话返回 202，结果经 `chat_state` 广播；claude 会话被别人持有 → 409 `claude_session_busy`）、`/api/v1/fs?path=`（远程目录选择器，受 workdir 白名单约束；v3 带 `chatTrust`，v4 起认 worktree 规则）、`POST /api/v1/events`。`/healthz` 故意免鉴权（存活探针），只回 `ok`、不含任何信息。

### 客户端会话模型

`desktop/src/renderer/index.ts` 的 **SessionView** 抽象：每个打开的终端会话 = **独立 WebSocket（VibeRemoteClient）+ 独立 xterm 实例**；对话会话是 **ChatView**（`chat/view.ts`：同样独立的 VibeRemoteClient + 由 `ChatSession` 状态机驱动的消息列表，DOM 只为最新的 300 条生成、上滑再加载）。对话会话的侧边栏点（灰=新消息、绿=回合结束、黄=等你处理）来自结构化消息与 REST 的 `activitySeq/state`，不依赖 hook；等你处理时发桌面通知，点通知打开该会话，未签名包降级为 Dock 弹跳 + 角标、**不自动切换会话**。切换会话 = 显示/隐藏对应 term-instance，未聚焦会话由 tmux 服务端保活。所有机器级 Map 用 **`addr:port`（machineKey）** 做 key（不是 addr，防同主机多端口冲突）。侧边栏靠 REST 每 5s 轮询各机器的会话列表和项目树（`listSessions()` 与 `listProjects()` 并行、各自发布）。

**侧边栏是三层树**：`tree.ts` 的 `buildTree(会话, 项目树)` 是纯函数，`sidebar.ts` 只管渲染（不从 `index.ts` 导入任何东西：状态经 `SidebarModel` 读、改动经 `SidebarActions` 发出），`index.ts` 负责接线。每台机器有一个**能力状态** `machineCaps`：`listProjects()` 返回数组 = `v4`；404（返回 `null`）= `legacy`；请求失败 = **保持上一轮**（断网不等于旧 daemon）；从未成功过 = `unknown`。`legacy` / `unknown` 下新建和删除 worktree 的入口置灰，`legacy` 时树由 `sessions[]` 自带的 `mode/sourceRepo/worktreeRoot/branch` 分组——**分组结果不能依赖 `sessions[]` 的先后**（旧 daemon 每次返回的顺序不同，依赖顺序侧边栏就会在两次轮询之间跳）。只有一个 worktree 的项目和非 git 目录不显示 worktree 层；同一 worktree 下没改过名的会话从第二个起带序号；折叠状态存 `localStorage`（`vibe-remote.collapsed-machines` / `vibe-remote.collapsed-projects`）。⌘1–9、⌘⇧[ / ⌘⇧] 按侧边栏从上到下可见的会话切换（`shortcuts.ts`，捕获阶段拦截，按键不会落进终端；有对话框或正在重命名时不拦）。

**外观**：颜色只在 `styles.css` 的 `:root` 里定义（M1 方案），其余规则一律用变量或 `color-mix()`；`test-theme-tokens.mjs` 守着变量值、`:root` 之外没有颜色字面量、正文 / 按钮 / 次要文字和状态点的对比度，以及主进程窗口的 `backgroundColor` 等于 `--bg-app`（冷启动不闪）。终端只有底色、前景、光标、选区四个颜色跟主题（`theme.ts` 读 `--term-*`），16 个 ANSI 色是常量。对话框一律是 `.modal` 里放标题、`.modal-body`、`.modal-footer` 三样，只有 body 滚动——矮窗口（最小 800×500）下按钮才不会被挤出去（`test-dialog-layout`、`picker-layout.mjs` 守着）。

`client.ts` 重连：指数退避，`reconnectAttempt` 在收到 **`ready`（连接确认健康）后才归零**（不是 onopen —— 否则坏 token 每秒锤服务端）。重连按 `lastCols/lastRows` re-attach，`pendingAttach` **必须带 workdir**（曾因丢 workdir 导致新会话总落默认目录）。

**新建会话幂等**：新建时客户端在 `attach()` 里就生成 `newSessionId`（`<ms>-<8hex>`），`ready` 前断线的重放（自动退避和手动 Retry 都走 `replayIntent()`）带**同一个** id（命名 worktree 还要带同一个 `worktreeName`），服务端 `Manager.Create` 见 id 已存在/创建中就转为 attach。曾经的 bug：id 由服务端生成，重放 = 再建一个，worktree 模式留下孤儿 worktree + 分支。`Manager.beginCreate` 用 `creating` map 串行化同 id 的并发 Create（防两次 `CreateWorktree`）。

### UTF-8 字节处理（易踩坑）

`atob()` 返回 Latin-1，直接 `term.write(string)` 会把多字节 UTF-8（box-drawing/emoji/CJK）拆成乱码。**必须** base64 → `Uint8Array` → `term.write`（xterm 自己按 UTF-8 解码）；输入方向用 `TextEncoder` 编码后再 base64。见 `index.ts` 的 `base64ToBytes`/`bytesToBase64`。

### 终端选区与复制（易踩坑）

claude 开启**鼠标上报**（DOM 上表现为 `.xterm` 带 `enable-mouse-events`），xterm 的 `SelectionService` 检测到 `areMouseEventsActive` 就会 `disable()` 自己的选区、把拖拽全转发给应用 —— 此时 `getSelection()` **恒为空串**，⌘C 复制到的是空内容。而 xterm 的逃生口在 macOS 上**不是 Shift**：

```js
shouldForceSelection(e) { return isMac ? e.altKey && macOptionClickForcesSelection : e.shiftKey; }
```

`makeTerminal()` 因此设 **`mouseEventsRequireAlt: true`**（语义反转：默认可拖拽选中，仅按 ⌥ 时把鼠标事件转发给 claude；**wheel 事件豁免**，所以 claude 内滚动照常），并保留 `macOptionClickForcesSelection: true` 作降级。

⚠️ `mouseEventsRequireAlt` **只存在于 xterm 6.1.0-beta**（5.5.0 完全没有此选项，设了会被静默忽略），所以 `@xterm/xterm` / `@xterm/addon-fit` 在 package.json 里**锁精确版本、不带 `^`** —— 浮动范围会无声回退这个修复。`scripts/test-terminal-selection.mjs` 守住这三点（选项已设 + typings 已声明 + 版本已锁死）。

复制/粘贴走 `terminal-clipboard.ts`：⌘C/⌘V 经 preload 桥到主进程 `clipboard`（Electron 原生剪贴板，不用 `navigator.clipboard`）。注意 `attachCustomKeyEventHandler` 必须**同步返回**，剪贴板 IPC 只能在返回后异步收尾。



`login_shell: true`（默认）时 runner 用 `<shell> -lic 'exec <claudeCmd>'` 启动，加载完整用户环境（PATH、fnm/nvm 等）。治本 —— 契合「跟在 shell 里敲 claude 一致」。远程若用 fnm 管理 node，不走登录 shell 会报 `node: command not found`。

## 安全模型

- vibe-remoted **绑私有网段地址**：`config.validateBindAddr` 放行 RFC1918 / loopback / link-local / IPv6 ULA / tailscale CGNAT 段（`isPrivateBindIP`，用 `net.IP.IsPrivate` + CGNAT 补丁），拒绝**公网 IP**（需 `allow_insecure_bind: true` 逃生舱）和**所有通配地址**（`0.0.0.0`/`::`，恒拒，逃生舱也不放行）。
- **静态 token 是准入核心边界**：WS `auth` 帧 + REST `Authorization: Bearer`，均用 `crypto/subtle.ConstantTimeCompare` 常量时间校验（token 现在是主防线，防时序侧信道）。
- workdir 白名单：一律用 `config.ResolveAllowedWorkdir`（先 `EvalSymlinks` 再比较，还不存在的路径用 `ResolveAllowedNewPath`），**不要用只做字面比较的 `IsAllowedWorkdir`** 做访问判断——指向白名单之外的符号链接能骗过它。`/api/v1/fs`、attach 的 workdir、项目树里的每个 worktree、`worktrees/*` 的 `path` 都受约束。worktree 模式要查两次：建之前查 worktree 根，**建好之后再查会话最终的工作目录**（源目录是子目录时映射到新 worktree 里的那个）——提交里的符号链接能让它落到白名单之外，不通过就撤销并返回 `worktree_path_not_allowed`。
- **daemon 能删目录和分支，范围收得很死**：`worktrees/status|remove` 的 `path` 先过白名单（绝对、规范、解析后与传入值逐字相等；不通过就 404，这一步不运行任何 git），再由 daemon 在该路径上做只读的仓库发现（`rev-parse --show-toplevel`、`worktree list`），它必须正好是该仓库 `git worktree list` 里的一项、且不是主目录，否则 404 / 400；两步都过了才运行读状态和删除的命令（`TestWorktreePathChecksBeforeGit`）；要删的分支取自 daemon 读到的列表而不是请求；不是 vibe-remote 创建的 worktree 分支永远不删；未提交文件、未合并提交只有在请求里带了对应的同意项时才会丢。
- 客户端传来的 `worktreeName` 先过本地规则（非空、无空白和控制字符、无 `..`、不以 `-` 开头、不含 `@{`、不含不显示的格式字符、UTF-8 不超过 250 字节），再过 `git check-ref-format --branch`（输出须与输入逐字相等）；之后只以完整引用名等带固定前缀的形式出现在 git 参数里，经 `exec.Command` 逐个传递，不经过 shell。**新建会话时本地规则在任何 git 调用之前**（`session.CheckWorktreeNameLocal`：`wsAttach` / `wsCreateChat` 入口查一次，`createOwnWorktree` 再查一次），所以 git 出错或卡住不会盖掉「名字不合法」。预检端点 `worktrees/plan` 不同：它先对 `workdir` 做只读的仓库发现（名字不合法时也要给出 `project` 和 `base`），但名字在过本地规则之前不进入任何 git 参数。测试 daemon 的 `allowed_roots` 只给临时目录，别覆盖真实仓库。
- **工作区信任（对话模式）**：`claude -p` 不弹信任确认、会直接执行项目 `.claude/settings.json` 里的 hook。daemon 因此只在 claude 已信任的目录新建对话会话：读 `$CLAUDE_CONFIG_DIR/.claude.json`（否则 `~/.claude.json`）里 `projects[<目录本身>].hasTrustDialogAccepted`，只认 `true`；无记录、`false`、文件缺失或损坏一律拒绝（`chat_unsupported`/`workdir_untrusted`），提示先用终端界面在该目录打开一次 claude。协议 4 起另认一种（`session.ChatTrust`，`/api/v1/fs` 的 `chatTrust` 和新建对话的 attach 用同一个函数）：目录是某个仓库**自己的 `git worktree list` 列出的 worktree 根**，且该仓库的**主目录这一个路径**被信任。「是不是它的 worktree」只认仓库的列表（来自主目录 `.git/worktrees/*/gitdir`），不看目录里的 `.git` 文件，也不用 `rev-parse --git-common-dir`——那两样目录自己就能伪造；主目录的父目录、子目录、别的 worktree 被信任都不算；主目录本身、worktree 里的子目录、裸仓库 / 子模块 / `--separate-git-dir` 仓库的 worktree 仍只查自己。worktree 模式查所选的源目录（不是新 worktree）。只读这一个字段。
- 对话模式的启动命令只由服务端配置拼成（`claude_cmd` + 白名单 flag + 常量，参数逐个单引号转义）；客户端只传 flag id、会话 id、`handoffFrom`。「不再询问」只回传 claude 自己给出的规则建议（JSON 相等校验），daemon 不写任何 `.claude` 设置文件、不读 claude 凭据。对话进程同样只拿 hook token。
- 传输为明文 `ws://`（无 `wss://`）：绑 tailscale IP 时由 WireGuard 加密，绑 LAN IP 时为明文——**仅在可信网络使用**。Origin 检查跳过（Electron 跨 origin）+ permissive CORS，均以 token + 私有网段不可达公网为前提。**Tailscale 仍是推荐方案**（自带加密+跨网），只是不再强制。

## 配置

服务端读 JSON（`vibe-remoted.example.json` 为模板），可用 `VIBE_REMOTED_BIND_ADDR`/`VIBE_REMOTED_TOKEN` 覆盖。**追加 claude 启动参数**：`claude_cmd` 是整条命令串，直接写 `"claude --dangerously-skip-permissions -c"`，按 shell 规则解析。

**可选 `claude_flags`**（`[{id,label,arg,default}]`）：客户端新建会话时在目录选择器里按 `label` 多选启动 flag，服务端按 `id` 查白名单把 `arg` 拼到 `claude_cmd` 后（**per-session**，每个会话独立；客户端只传 id、服务端查表拼接 = 零命令注入；`/api/v1/info` 只下发 id/label/default，不含 arg；冲突不去重、按声明顺序全拼）。`default` 控制初始勾选。`ResolveClaudeCmd`（`config.go`）是拼接入口，空 flags 时回退原 `claude_cmd`（向后兼容）。

**`state_dir`**（可选）：对话会话表 `chat-sessions.json` 和项目清单 `projects.json` 所在目录（0700，文件 0600），默认是配置文件旁的 `vibe-remoted-state/`，相对路径按配置文件目录解析。不可写时对话模式不可用（`info.chat.reason=state_dir_unwritable`），终端模式照常；项目清单退回只在内存里，重启后命名 worktree 的创建记录会丢，它们按「外部」显示（仍能删目录、不会删分支）。`vibe-remoted.example.json` 里的 `"state_dir": ""` 即取默认值。

客户端机器清单在 Electron userData 下的 `machines.json`（macOS: `~/Library/Application Support/vibe-remote/machines.json`），格式 `[{name, addr, port, token}]`。

## 前置条件与联调

- 客户端和服务端需通过 Tailscale 或可信私有网络互通。
- 目标 Linux 需 `claude` + `tmux`（不需要 Go，可部署预编译二进制）。
- **本地无远程机冒烟**：macOS 本身有 PTY+tmux，用 `claude_cmd: "/bin/bash"` 代跑即可验证透传链路（纯字节透传不关心跑什么）。对话模式不能用 bash 代跑，测试一律用假 claude（`vibe-remoted/internal/chat/fakeclaude`，`go build -o <dir>/claude`，文件名必须是 claude）：`node .claude/skills/verify/scripts/ws-chat-smoke.mjs` 自建带假 claude 的临时 daemon 跑协议冒烟，gui-smoke 的对话用例同理。测试配置 `vibe-remoted.local.json`（无 tmux）/ `vibe-remoted.tmux.json`。
- **GUI 调试**：`VIBE_REMOTE_DEBUG_PORT=9222` 开 CDP 端口，用 CDP over WebSocket 驱动/检查 renderer（chrome-devtools MCP 在此 Electron 版本有调用故障，改用裸 CDP）。`VIBE_REMOTE_NO_DEVTOOLS=1` 禁自动开 DevTools。

## 状态

首个开源版本聚焦 macOS 桌面客户端和 Go daemon。当前仓库只维护桌面终端线；iOS、Android、web 客户端和共享包不属于当前版本。发行后仍需处理代码签名和 app 图标。

### 第二批体验增强（已完成）

- 机器管理 app 内 UI（CRUD + 空状态引导 + 测试连接），不再手改 machines.json。
- 会话命名：默认名跟随 workdir，双击侧边栏内联重命名，名字存 tmux 用户选项 `@vibe_remote_name`（跟随 tmux 生命周期，重启/多端一致）。
- 后台会话提示：A 圆点兜底（非活动会话有字节到达即亮蓝点，任何 agent 通用）+ C hook 事件增强（notify 帧把圆点升级为 idle 绿/waiting 黄 + 可选桌面通知）。
- 重连体验：状态栏显示重连尝试次数 + 活动会话终端顶部断线横幅 + Retry now。

**事件基建（通用可扩展）**：`POST /api/v1/events`（Bearer 鉴权，body `{sessionId,kind,message?}`）+ Manager pub/sub 路由表 + notify 帧。`kind` 为开放枚举，未来带外事件（token 用量等）复用此通道。claude 进程已注入 `VIBE_REMOTE_SESSION_ID`/`VIBE_REMOTE_EVENTS_URL`/`VIBE_REMOTE_TOKEN`。其中 `VIBE_REMOTE_TOKEN` 是**按会话派生的 hook token**（`HMAC(主token, "events:"+id)`），只能调本会话的 `/api/v1/events`，主 token 绝不进 agent 环境。env 必须经 `tmux new-session/respawn-pane -e` 显式传入 —— tmux server 只捕获首个客户端的环境，不传则后续会话全部串用第一个会话的 SESSION_ID。

**⚠️ 故意留空（本期不实现）**：vibe-remoted 自动生成 hook 配置让 claude 带上（`--settings` 注入方式需真机验证 claude 版本合并语义）。当前靠手动配 hook 或手动 curl events 端点即可验证全链路；日后补「自动注入」一小段，前面基建全不用动。
