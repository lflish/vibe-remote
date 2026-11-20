# 测试报告：双模式会话（终端 + 对话）

日期：2026-11-20　分支：change/dual-mode　提交：6d88e45（最新代码，含 b88f4ae）

被测检出：测试副本 `.devflow-tmp/dual-test`，detached 在 163b2c9。163b2c9 与 6d88e45 之间只改了 `docs/changes/` 下 4 个文档（`git diff --stat 6d88e45..163b2c9 -- . ':!docs/changes'` 为空），代码相同。全部构建和测试都在这个副本里运行。

> ⚠️ 端到端测试：**已完成本机能做的部分**——协议冒烟（ws-smoke、ws-chat-smoke）和界面测试（gui-smoke、gui-chat-smoke，本机构建产物 + CDP，会弹出临时窗口）都在最新代码上重新运行。**环境是临时 daemon + 假 claude（`vibe-remoted/internal/chat/fakeclaude`），不是真实的 claude，也不是远程 Linux。**
> **未做**：需要真 claude / 远程 Linux 的 4 项（R5.2 规则落盘、首字延迟、R1.5 真机那一半、V17 远程 Linux），以及原生通知的显示（未签名构建只能走 Dock 降级）。原因见「未覆盖和遗留」。
> **本轮出现 1 次已知偶发失败**：gui-smoke 第 1 次运行「drag-select under mouse reporting + ⌘C」失败（29 过 1 败，退出码 1），按约定重跑 1 次全过（30 过，退出码 0）。两次结果都列在下面，没有改测试。
> 浏览器环节：适用（项目自己的 CDP harness，不用 Playwright；`.devflow.yml` 的 `cloud_browser: forbidden`）。
> 测试环境：e2e_env = local；独立验证（机器关口 C）不在本报告范围，结论见之后的 verdict.md。

## 汇总

| 类别 | 通过 | 失败 | 跳过 | 合计 |
|------|------|------|------|------|
| 单元 + 集成（Go，`go test -race -count=1 ./...`，make check 内） | 257 个顶层测试（另有 170 个子测试），5 个包 | 0 | 0 | 257 |
| 单元（TS，`npm test`，make check 内） | 117 个用例，22 个脚本 + preserved-notice 检查 | 0 | 0 | 117 |
| 协议冒烟（终端 `ws-smoke.mjs`） | 12 | 0 | 0 | 12 |
| 协议冒烟（对话 `ws-chat-smoke.mjs`） | 9 | 0 | 0 | 9 |
| 浏览器（`gui-smoke.mjs`）第 1 次 | 29 | 1（已知偶发：drag-select + ⌘C） | 0 | 30 |
| 浏览器（`gui-smoke.mjs`）第 2 次（重跑） | 30 | 0 | 0 | 30 |
| 浏览器（`gui-chat-smoke.mjs`，运行 1 次） | 29（23 个带 R 编号的场景用例 + 2 个布局用例 + 启动和准备 3 项 + 无渲染异常 1 项，按 PASS 行计） | 0 | 0 | 29 |
| 不变规则（`.devflow.yml` invariants，命令型 10 条） | 10 | 0 | 0 | 10 |
| 不变规则第 2 条（/protocol-sync，人工核对） | 帧、字段、版本一致；1 处文档遗漏（见下） | — | — | — |

Go 的数字来源：`go test -list '.*' ./...` 列出 257 个顶层测试（chat 94、config 14、protocol 2、server 54、session 93）；`go test -count=1 -timeout=10m -v ./...` 实际输出 257 行顶层 `--- PASS`、170 行子测试 `--- PASS`，没有 FAIL 和 SKIP。与上一轮（c2799e6）数量相同：b88f4ae 没有改 Go 测试。
TS 比上一轮多 2 个脚本（test-picker-layout、test-slash-menu-layout）和 1 个用例（test-chat-view「slash menu rows…」），都来自 b88f4ae。
gui-smoke 比上一轮多 6 项（终端和对话两种状态下各 3 档窗口高度的对话框布局），gui-chat-smoke 多 2 项（对话框布局、斜杠菜单布局），都来自 b88f4ae。

运行命令和结果（依次运行，互不并发；每条用到 tmux 的命令都带独立的 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-dm-XXXXXX)`；原始输出在本机 `.devflow-tmp/dual-test-out/`，不入库）：

```
$ make check                                   # make-check.log，2026-11-20 10:30:52–10:31:57
cd vibe-remoted && go vet ./...
cd vibe-remoted && go test -race -count=1 ./...
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	31.901s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/config	6.297s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/protocol	6.681s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	28.826s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	37.126s
cd desktop && npm run typecheck                 # tsc --noEmit，无输出
cd desktop && npm test
attach-replay regression checks passed
terminal layout regression checks passed
picker layout regression checks passed          # b88f4ae 新增
slash menu layout regression checks passed      # b88f4ae 新增
terminal clipboard regression checks passed
terminal selection regression checks passed
client-reconnect regression checks passed
client-liveness regression checks passed
machine-store checks passed
i18n parity checks passed (246 keys)
chat client checks passed (9)
test-chat-parser checks passed (15)
test-chat-session checks passed (18)
test-chat-permission checks passed (11)
test-chat-diff checks passed (8)
test-chat-queue checks passed (15)
test-chat-markdown checks passed (6)
chat render guard passed (15 files)
test-chat-window checks passed (3)
ok - test-chat-view: slash menu rows: description only when there is one, full text in titles, selection scrolled into view   # b88f4ae 新增
ok - test-chat-view: terminal-only notice: closed when the session ends, relabelled on a locale switch (X1)
test-chat-view checks passed (17)
test-chat-availability checks passed (9)
test-chat-activity checks passed (6)
exit=0

$ go test -count=1 -timeout=10m -v ./...        # go-test-v.log，只为数测试个数
ok  	…/internal/chat	17.278s
ok  	…/internal/config	0.477s
ok  	…/internal/protocol	1.244s
ok  	…/internal/server	17.521s
ok  	…/internal/session	24.481s
顶层 --- PASS 257，子测试 --- PASS 170，FAIL 0，SKIP 0；exit=0

$ node .claude/skills/verify/scripts/ws-chat-smoke.mjs      # ws-chat-smoke.log
daemon up on 127.0.0.1:27073, claude 2.1.210 (fake)
PASS chat: create — id=1795141954333-713de0a2
PASS chat: replay before ready — one session, one process
PASS chat: two clients — both saw both, same order, one process
PASS chat: pending survives reconnect — request a074c038-… answered after reconnect
PASS chat: resync 50 — backlog 54, seq 14..67
PASS chat: handoff — terminal 1795141954767-c5d1dc05 runs --resume 65652375-…
PASS chat: daemon restart → ended — history 2, reloaded and replying
PASS chat: state without hooks — idle → running → idle → waiting → idle
PASS chat: delete keeps jsonl — process gone, transcript kept
all chat checks passed
exit=0

$ VR_TOKEN=… node .claude/skills/verify/scripts/ws-smoke.mjs 127.0.0.1:$PORT <临时目录>   # ws-smoke.log；临时 /bin/bash daemon，随机端口
PASS /healthz
PASS /api/v1/info version=dev
PASS session A ready id=1795141995406-23581b40
PASS A sees its own VIBE_REMOTE_SESSION_ID
PASS A got a hook token distinct from the main token
PASS hook token → events 204
PASS notify frame delivered to session A
PASS hook token rejected for another sessionId
PASS hook token rejected on /api/v1/info
PASS B sees its own VIBE_REMOTE_SESSION_ID (no env bleed from A)
PASS deleted 1795141995406-23581b40
PASS deleted 1795141995688-ef2b4c02
all checks passed
exit=0

$ TMUX_TMPDIR=… node .claude/skills/verify/scripts/gui-smoke.mjs      # 第 1 次，gui-smoke-run1.log，10:38:03–10:38:16
PASS daemon up on 127.0.0.1:22855
PASS chat daemon (fake claude) up on 127.0.0.1:27372
electron 44.7.0
PASS app started and lists the machine
PASS legacy plaintext token encrypted on launch
PASS dir picker lists the remote directory
PASS dir picker fits a 500px-high window
PASS dir picker fits a 700px-high window
PASS dir picker fits a 803px-high window
PASS terminal attached and shows the remote shell prompt
PASS exactly one session created on the daemon
PASS terminal fills its container on first layout
PASS keystrokes reach the remote shell and output renders
PASS remote mouse reporting is active and ⌥ routes the mouse to the app
PASS without ⌥ the mouse stays with xterm selection
FAIL drag-select under mouse reporting + ⌘C copies the text — "SELECT_ME_PLEASE\nbash-3.2$ \n"
PASS ⌘V pastes the native clipboard into the remote shell
PASS navigation away from the app is blocked
PASS window.open is denied
PASS events endpoint accepted the hook event
PASS waiting event raises a desktop notification titled with the session name
NOTE notification outcome in this build: fallback
PASS reconnect banner appears when the daemon goes away
PASS client reconnects after the daemon restarts
PASS the same tmux session is usable after reconnect
PASS dir picker with chat chosen fits a 500px-high window
PASS dir picker with chat chosen fits a 700px-high window
PASS dir picker with chat chosen fits a 803px-high window
PASS chat session created via picker
PASS chat reply rendered
PASS permission allow once resumes
PASS no uncaught renderer exceptions
1 check(s) FAILED
exit=1

$ TMUX_TMPDIR=… node .claude/skills/verify/scripts/gui-smoke.mjs      # 第 2 次（重跑），gui-smoke-run2.log，10:38:26–10:38:36
… 30 × PASS（同上 30 项，含 drag-select under mouse reporting + ⌘C copies the text）
NOTE notification outcome in this build: fallback
all GUI checks passed
exit=0

$ TMUX_TMPDIR=… DEVFLOW_EVIDENCE_DIR=docs/changes/2026-11-13-dual-mode/evidence node .claude/skills/verify/scripts/gui-chat-smoke.mjs   # gui-chat-smoke-run1.log，10:39:05–10:39:43
PASS 5 daemons up (gui-term:25090 gui-main:24891 gui-chat:29864 gui-old-claude:27132 gui-old-init:20437)
PASS app started with 5 machines (zh), network hook installed
PASS R1.3 bash machine: chat card disabled with the reason — 对话界面只支持 claude：这台机器的 claude_cmd 不是 claude
PASS R1.1 default new session is a terminal session — session 1795142352289-4b12cd65
PASS R1.4 claude too old: chat card disabled, upgrade claude — 远程 claude 版本 1.0.51 低于对话界面要求的 2.1.210，请升级 claude
PASS new-session dialog: buttons reachable in 500/700/803px-high windows — 500px ok, 700px ok, 803px ok
PASS R17.2 new desktop + protocol-2 daemon: terminal works, chat card says upgrade vibe-remoted — 这台机器的 vibe-remoted（协议 2）不支持对话界面（需要协议 3），请升级 vibe-remoted; picker note: …
PASS R1.5 chat + -c shows the full 3000-line history, windowed — session 1795142355049-1d179acf; first screen 300 messages; 9 scrolls to the first; total 2000
PASS R1.6/R11.2 bypass: mode fixed, no permission prompts — menu bypassPermissions (…权限模式固定为「跳过权限」，不能切换。)
PASS main chat session created (dir main) — 1795142358630-98ddc002
PASS R3.2 markdown + code copy button — font "SF Mono"
PASS R3.3 raw html/script inert, links go to the system browser — links [["ok","https://example.com"]]; open-external got ["https://example.com"]
PASS R4 tool blocks: Read/Grep folded, Bash output, Edit diff, failure — Read:ok Grep:ok Bash:ok Edit:ok:open Bash:error:open
PASS R5.6 answer lost before reaching the daemon → prompt open again after reconnect — submitting → reconnect → open → allow → ran
PASS R5.7 second answer → "handled elsewhere", claude gets one answer — vr_resolved allowed
PASS R6 plan review: approve+acceptEdits, approve+manual, revise — opt1→acceptEdits, opt2→default, opt3→revised (mode while revising: default)
PASS R7 AskUserQuestion form: incomplete → disabled, single/multi/other → answers — Banana / Blue + "my own colour"
PASS R8 Esc and stop interrupt; Esc on a prompt; Esc idle does nothing — Esc + stop → 已中断; prompt Esc → tool error; idle Esc no-op
PASS R9 queue while busy: queued, remove, interrupt returns to the input — queued ×2, removed one, interrupt put "echo q-three" back
PASS R10 slash menu and terminal-only commands — menu /compact /review /fake-skill …（共 13 条）; "/re" → /review /reverse-engineering-with-code-eval-and-ida-domain:ida-domain-scripting
PASS slash menu with long names and descriptions: rows readable in 800x500 and 1280x800 windows, selection stays in view — 800x500: menu 474x290, 13 rows (4 whole) ok; 1280x800: menu 560x400, 13 rows (6 whole) ok
PASS R11.1 permission mode: Shift+Tab cycle and menu — Shift+Tab acceptEdits→plan→default; menu default,acceptEdits,plan
PASS R12/R12.2 offline, 500 messages meanwhile → divider, render ≤2000 ms — divider "— 本地连接在此中断，远程会话未受影响 —已补回断线期间 504 条消息"; ready → rendered 46 ms
PASS R13.1 turn error shows retry; retry resends — 本轮回复失败API Error: 529 Overloaded重试
PASS R16.3 waiting in a background session: yellow dot, notification / Dock fallback, click opens it — window focused before: false; notify fallback; badge while hidden "•", after focus() "" (window focused: true); click → main opened
PASS R13.2 claude exits → ended banner, restart works — 会话已结束：claude 进程退出（代码 1）fake claude crash line 1 …
PASS R14.2 handoff while a turn runs asks first, then continues in a terminal — dialog "Claude 正在回复，交给终端会中断当前回合。继续吗？"; terminal: fake-claude interactive resume=d49a2139-…
PASS R13.4 init reports an old claude → ended with required version, no reconnect — claude 版本过旧（1.0.0），对话界面需要 2.1.210 或更新…
PASS no uncaught renderer exceptions
all GUI chat checks passed
exit=0
```

说明：
- `gui-chat-smoke.mjs` 本轮只运行了 1 次并全过；它的已知偶发项（R1.1、R7，以及焦点跑偏时界面语言被切成英文导致的 R13.2 / R14.2）这一次都没有出现。上一轮「连续 6 次全过」的稳定性数据是 c2799e6 上的，本轮没有重做多次运行。
- 运行 gui-chat-smoke 时加了 `DEVFLOW_EVIDENCE_DIR`（脚本只有在设了它时才写截图），没有加 `--no-build`（脚本自己重新 `vite build`）。
- 不变规则 10 条命令的逐条退出码在 `invariants-summary.txt`（2026-11-20 10:33:34–10:34:27，全部 exit=0）。

## b88f4ae 的改动与回归断言

上一版报告（c2799e6 / a56684f）之后，分支上只多了一次代码改动 b88f4ae（decisions #39、#40，用户试用时发现的两处布局问题）。它改了 12 个文件：

| 文件 | 性质 |
|------|------|
| `desktop/src/renderer/dirpicker.ts`、`desktop/src/renderer/styles.css` | 产品：新建会话对话框改为标题和按钮固定、中间滚动（#39） |
| `desktop/src/renderer/chat/composer.ts`、`desktop/src/renderer/styles.css` | 产品：斜杠菜单名字一行、描述在下方最多两行、菜单加宽、选中项随键盘滚动进可视区（#40） |
| `vibe-remoted/internal/chat/fakeclaude/main.go` | 测试替身：`FAKE_CLAUDE_LONG_COMMANDS` 开关，给出长名字、长描述的命令 |
| `desktop/scripts/test-picker-layout.mjs`、`test-slash-menu-layout.mjs`（新）、`test-chat-view.mjs`（+1 用例）、`desktop/package.json` | 静态守卫，进 `npm test` |
| `.claude/skills/verify/scripts/picker-layout.mjs`、`slash-menu-layout.mjs`（新）、`gui-smoke.mjs`、`gui-chat-smoke.mjs` | 界面布局断言 |

产品文件 3 个（`dirpicker.ts`、`composer.ts`、`styles.css`），没有接口和协议变化；`protocol.go` / `protocol.ts` / `rest.ts` / `docs/protocol.md` 自上一版报告以来没有改动。

回归断言（本轮全部通过）：
- **对话框布局**（`picker-layout.mjs`，gui-smoke 6 项 + gui-chat-smoke 1 项）：把窗口高度模拟成 500 / 700 / 803px，逐档断言对话框整体在窗口内、内容没有被裁掉（`scrollHeight ≤ clientHeight`）、「在此打开」按钮在对话框和窗口之内、按钮中心点命中的就是按钮本身（能点到）、路径栏没有被压扁。gui-smoke 在终端状态和选了「对话」的状态各测一遍；gui-chat-smoke 测最高的状态（选了对话、两个启动选项、带说明文字）。
- **斜杠菜单布局**（`slash-menu-layout.mjs`，gui-chat-smoke 1 项）：窗口模拟成 800×500 和 1280×800，假 claude 给出 13 条命令（含 150 字符以上的名字和多句描述），逐行断言名字只占一行、不画到行外、不压到描述上；描述在名字下方、最多两行；被截断的名字和描述带完整内容的 `title`；菜单在对话区和窗口之内、不横向滚动、至少完整显示 3 行；用方向键绕列表一圈再越过两端，每一步选中项都在可视区内，回到第一条时列表滚回顶部；点击选中指针下的那一行。
- **静态守卫**（`npm test`）：test-picker-layout、test-slash-menu-layout 两个脚本，test-chat-view 新增「slash menu rows: description only when there is one, full text in titles, selection scrolled into view」。

「修复前失败、修复后通过」的记录在 decisions #39、#40 和 `git show b88f4ae` 的提交说明里；本轮没有把代码退回修复前去重现失败。修复前的画面可以在 git 历史里看：c2799e6 版本的 `evidence/R17.2-picker.png`（868px 高的窗口里路径栏被压扁、目录列表之后的启动选项和按钮不在对话框内）。

## 场景对照

层级：Go = `go test -race`；TS = `desktop/scripts/test-*.mjs`；冒烟 = ws-chat-smoke；浏览器 = gui-chat-smoke（除非注明 gui-smoke）。表里出现的 60 个 Go 测试名已对照本轮 `go test -v` 输出逐个确认存在且 `--- PASS`；TS 用例名对照了本轮 make-check.log。

证据列说明：`R1.3.png`、`R1.4.png`、`R17.2-picker.png`、`R10.png`、`picker-layout.png`、`slash-layout-*.png` 是本轮（2026-11-20，6d88e45 的代码）的截图；其余截图是 2026-11-14（a56684f 的代码）那一轮的，本轮对应用例重新运行并通过，但没有替换截图。

| 场景 | 测试 | 层级 | 结果 | 证据 |
|------|------|------|------|------|
| R1.1 默认新建终端会话 | TestAttachWithoutUIStaysTerminal；浏览器 R1.1 | Go + 浏览器 | 通过 | evidence/R1.1.png |
| R1.2 新建对话会话 | TestWSChatCreateReady；gui-smoke「chat session created via picker」；冒烟 chat: create | Go + 浏览器 + 冒烟 | 通过 | gui-smoke 输出 |
| R1.3 claude_cmd 不是 claude | TestInfoChatNotClaude、TestParseNotClaude；test-chat-availability；浏览器 R1.3 | Go + TS + 浏览器 | 通过 | evidence/R1.3.png |
| R1.4 claude / daemon 过旧 | TestInfoChatTooOld、TestParseVersion；test-chat-availability；浏览器 R1.4（1.0.51）、R17.2（协议 2） | Go + TS + 浏览器 | 通过 | evidence/R1.4.png、R17.2-picker.png |
| R1（#39）新建对话框在小窗口里可用 | gui-smoke「dir picker fits a 500/700/803px-high window」「dir picker with chat chosen fits …」；浏览器「new-session dialog: buttons reachable in 500/700/803px-high windows」；test-picker-layout | TS + 浏览器 | 通过 | evidence/picker-layout.png |
| R1.5 勾 -c 显示完整历史 | TestCreateContinueResumesLatest、TestSyncHistoryBeforeCutoff、TestHistoryFullStream；test-chat-window；浏览器 R1.5（3000 行 JSONL：首屏 300 条，9 次上滑到第一条，共 2000 条消息含工具块；argv 为 `--resume <最新>`、无 `-c`；新消息接在后面） | Go + TS + 浏览器 | 通过（真 claude 部分未做，见遗留） | evidence/R1.5.png、R1.5-top.png |
| R1.6 bypass 固定 | TestBypassLocksMode、TestBypassStillAsksQuestions；浏览器 R1.6 | Go + 浏览器 | 通过 | evidence/R1.6.png |
| R1.7 worktree + flag | TestChatWorktreeAndFlags | Go | 通过 | — |
| R2.1 ready 前重放 | TestChatCreateReplaySameID、TestChatCreateConcurrentSameID；冒烟 replay before ready | Go + 冒烟 | 通过 | — |
| R2.2 重载旧进程先退 | TestReloadWaitsForOldProcess、TestSingleProcessRestart、TestStopTimings | Go | 通过 | — |
| R2.3 交接对话先停 | TestHandoffStopsChatFirst | Go | 通过 | — |
| R2.4 两台桌面 | TestTwoClientsShareProcess；冒烟 two clients | Go + 冒烟 | 通过 | — |
| R2.5 daemon 重启 | TestLoadChatsMarksDaemonRestart、TestOrphanCleanup；冒烟 daemon restart；探索（上一轮：GUI 内重启 daemon → 「vibe-remoted 已重启」+ 重新启动） | Go + 冒烟 + 探索 | 通过 | evidence/explore-daemon-restart.png |
| R2.6 两个 -c 同一对话 | TestContinueReusesRunningSession、TestConcurrentContinueCreatesOneProcess | Go | 通过 | — |
| R3.1 发送与流式 | TestSendEchoAndStream；test-chat-session；gui-smoke「chat reply rendered」 | Go + TS + 浏览器 | 通过 | — |
| R3.2 Markdown | test-chat-markdown gfm；浏览器 R3.2（h1/列表/表格/行内代码/等宽代码块 SF Mono，复制按钮写入剪贴板 `fmt.Println("hi")`） | TS + 浏览器 | 通过 | evidence/R3.2.png |
| R3.3 原始 HTML / 脚本 / 链接 | test-chat-markdown、test-chat-render-guard；浏览器 R3.3（无 script/img/onerror，原文以文本显示；`javascript:` 不生成链接；点 https 链接 → 主进程 open-external 收到 `https://example.com`（已 stub，不真开浏览器），窗口 URL 不变，无对话框） | TS + 浏览器 | 通过 | evidence/R3.3.png |
| R3.4 空输入 | TestSendRejectsEmpty；test-chat-queue；探索（上一轮：空白 + 回车不发送，连按两次回车只发一条） | Go + TS + 探索 | 通过 | — |
| R4.1–R4.4 工具块 | test-chat-session tool pairing、test-chat-diff；浏览器 R4（Read/Grep 折叠可展开，Bash 显示命令与输出，Edit 有分色 diff，失败 Bash 为 error 并展开） | TS + 浏览器 | 通过 | evidence/R4.png |
| R5.1 允许一次 | TestRespondAllowOnce；gui-smoke「permission allow once resumes」 | Go + 浏览器 | 通过 | — |
| R5.2 允许并不再询问 | TestRespondAlwaysWithSuggestion；test-chat-permission describeSuggestion / only setMode | Go + TS | 通过（真 claude 落盘未做，见遗留） | — |
| R5.2b 无建议 | test-chat-permission no suggestions | TS | 通过 | — |
| R5.3 拒绝并说明 | TestRespondDenyWithMessage | Go | 通过 | — |
| R5.4 断线期间请求等待 | TestPendingWaitsWithoutClient | Go | 通过 | — |
| R5.5 重连后重现请求 | TestResyncRestoresPending、TestPendingSurvivesRingEviction；冒烟 pending survives reconnect | Go + 冒烟 | 通过 | — |
| R5.6 回答送达前断线 | test-chat-session submitting reverts；浏览器 R5.6（丢弃出站帧后点允许 → 「提交中」→ 断开 → 重连后恢复为未回答 → 再答 → 工具执行） | TS + 浏览器 | 通过 | evidence/R5.6.png |
| R5.7 重复回答 | TestRespondFirstWins、TestTwoClientsRespondRace；浏览器 R5.7（另一端先答；本端扣住入站帧后点允许 → 显示「Bash 的请求已在别处处理」，claude 只收到一次回答） | Go + 浏览器 | 通过 | evidence/R5.7.png |
| R5.8 claude 取消 | TestCancelRequestResolves；test-chat-session cancelled | Go + TS | 通过 | — |
| R6.1–R6.4 计划审阅 | TestPlanApproveSetsMode、TestPlanApproveManual、TestPlanReviseStaysPlan、TestResyncRestoresPending；test-chat-permission；浏览器 R6（选项 1 → acceptEdits，选项 2 → default，选项 3 + 意见 → 「revising: …」并重新出现计划卡片） | Go + TS + 浏览器 | 通过 | evidence/R6.png、R6-revise.png |
| R7.1–R7.3 提问表单 | TestAskAnswersRoundTrip；test-chat-permission；浏览器 R7（未答完提交禁用、两题标红；答一题后只剩一题标红；单选 + 多选 + 其他 → claude 复述 Banana / Blue / my own colour） | Go + TS + 浏览器 | 通过 | evidence/R7.png |
| R8.1–R8.3 中断 | TestInterruptStopsTurn、TestInterruptResolvesPending、TestInterruptIdleNoop；test-chat-session；浏览器 R8（Esc 与停止按钮都标「已中断」后可再发；提示卡片上 Esc → 「Bash 的请求已中断」，工具未执行；空闲 Esc 无任何帧与界面变化） | Go + TS + 浏览器 | 通过 | evidence/R8.png |
| R9.1–R9.3 排队 | test-chat-queue；浏览器 R9（两条「排队中」，删一条后只发另一条；中断时排队消息退回输入框、不发送） | TS + 浏览器 | 通过 | evidence/R9.png、R9-interrupt.png |
| R10.1 斜杠列表 | TestSlashCommandsPrecedence；test-chat-session slash commands from state；test-chat-view「slash menu and terminal-only commands」「slash menu rows…」；test-slash-menu-layout；浏览器 R10（`/` 列出的 13 条里有 compact / review / fake-skill，`/re` 过滤后每一条都以 `/re` 开头，回车填入 `/review `）；浏览器「slash menu with long names and descriptions…」（#40：800×500 与 1280×800 两档窗口下名字一行、描述在下方最多两行、不出行、不出菜单、截断带 title、方向键绕一圈选中项始终可见、点击选中） | Go + TS + 浏览器 | 通过 | evidence/R10.png、slash-layout-800x500.png、slash-layout-1280x800.png |
| R10.2 终端专用命令 | test-chat-queue terminal-only；test-chat-view X1；浏览器 R10（`/theme` 不发送，提示 + 「新建终端会话接上」） | TS + 浏览器 | 通过 | evidence/R10-terminal-only.png |
| R11.1 切换模式 | TestSetModeUpdatesState；浏览器 R11（Shift+Tab default→acceptEdits→plan→default；菜单选 acceptEdits 后 Write 不再询问） | Go + 浏览器 | 通过 | evidence/R11.png |
| R11.2 bypass 只读 | TestBypassLocksMode；浏览器 R1.6（菜单只有 bypass、禁用、附原因） | Go + 浏览器 | 通过 | evidence/R1.6.png |
| R12.1 断线期间继续 | TestChatDisconnectKeepsProcess | Go | 通过 | — |
| R12.2 补发 50 / 500 条 | TestResyncIncremental50；冒烟 resync 50；浏览器 R12（离线期间另一端发 `burst 500`，重连后分隔线「已补回断线期间 504 条消息」，burst 1…500 按序无重复） | Go + 冒烟 + 浏览器 | 通过 | evidence/R12.png |
| R12.2 非功能：500 条渲染 ≤2 s | 浏览器 R12 计时：从重连 `ready` 到出现新分隔线且最后一条 `burst 500` 已渲染 | 浏览器（计时） | 通过：本轮 46 ms（上一轮各次 39–54 ms） | gui-chat-smoke 输出 |
| R12.3 超出缓冲 | TestRingOverflowReset；test-chat-session omitted marker | Go + TS | 通过 | — |
| R12.4 流式中途断线 | TestResyncMidStreamTail；test-chat-session preview merged | Go + TS | 通过 | — |
| R13.1 回合出错重试 | test-chat-session turn error；浏览器 R13.1（错误内容 + 重试 → 重发上一条，再次出错卡片） | TS + 浏览器 | 通过 | evidence/R13.1.png |
| R13.2 进程退出 | TestCrashEmitsExitAndEnded、TestCrashEmitsExitAndEndedWS；浏览器 R13.2（「会话已结束：claude 进程退出（代码 1）」+ stderr 尾巴，重新启动 / 新建终端会话接上；重新启动后可续聊） | Go + 浏览器 | 通过 | evidence/R13.2.png |
| R13.3 只有真退出才发 exit | TestChatDisconnectKeepsProcess | Go | 通过 | — |
| R13.4 启动后版本不支持 | TestInitVersionTooOldEnds；浏览器 R13.4（init 报 1.0.0 → 「claude 版本过旧（1.0.0），对话界面需要 2.1.210 或更新」+ 重新检测 + 交接；3 s 内无新连接、无重连横幅） | Go + 浏览器 | 通过 | evidence/R13.4.png |
| R14.1 交接 | TestHandoffCreatesTerminalWithResume、TestHandedOffTerminalReloadUsesResume；冒烟 handoff | Go + 冒烟 | 通过 | evidence/R14.2.png |
| R14.2 回合进行中交接 | TestHandoffInterruptsRunningTurn；浏览器 R14.2（运行中点交接 → 确认框「Claude 正在回复，交给终端会中断当前回合。继续吗？」→ 终端显示 `fake-claude interactive resume=<id>`；对话会话 handed_off、输入框禁用） | Go + 浏览器 | 通过 | evidence/R14.2.png、R14.2-chat.png |
| R15.1 重命名 | TestChatRenamePersists；探索（上一轮：双击改名含 `<i>`、emoji，REST 与 chat-sessions.json 一致） | Go + 探索 | 通过 | — |
| R15.2 删除 | TestChatDeleteKeepsJSONL；冒烟 delete keeps jsonl；探索（上一轮：侧边栏删除 → 进程消失、JSONL 保留） | Go + 冒烟 + 探索 | 通过 | — |
| R15.3 重载 | TestReloadChatReturns202、TestReloadRefusedWhenHandedOff；探索（上一轮：侧边栏重载 → 历史保留、续聊） | Go + 探索 | 通过 | — |
| R16.1 灰点 / R16.2 绿点 | test-chat-activity；探索（上一轮：后台会话收到流式输出为 output，回合结束变 idle） | TS + 探索 | 通过 | — |
| R16.3 等你处理（降级，d12） | test-chat-activity；浏览器 R16.3（应用隐藏、当前会话为另一个时收到权限请求：黄点、`[notify] fallback`、Dock 角标 `•`、当前会话不自动切换；本轮窗口获得焦点后角标清除） | TS + 浏览器 | 通过 | evidence/R16.3-fallback.png |
| R16.3 等你处理（通知可用） | 浏览器 R16.3：点通知 = 主进程发 `notification-click`（模拟点击）→ 打开该会话、显示提示 | 浏览器（部分） | 部分通过：点击路径已验证；原生通知「显示」需签名构建，未做 | evidence/R16.3-click.png |
| R16.4 不需 hook | test-chat-activity REST；冒烟 state without hooks | TS + 冒烟 | 通过 | — |
| R17.1 原有回归 | make check、gui-smoke 原有用例（断言未改：分支相对 main 的 `gui-smoke.mjs` 只删了 4 行，都是注释、import 和 machines.json 准备；原有 `test-*.mjs` 和 `_test.go` 没有删改行） | 全量 | 通过（gui-smoke 的 drag-select 用例本轮 2 次运行里 1 次失败，见「偶发失败」一节） | — |
| R17.2 新桌面连旧 daemon | test-chat-availability proto 2；浏览器 R17.2（main 分支构建的 daemon：对话卡片「协议 2…请升级 vibe-remoted」，旧 daemon 提示，终端会话可用） | TS + 浏览器 | 通过 | evidence/R17.2-picker.png、R17.2.png |
| R17.3 旧桌面连新 daemon | TestTerminalAttachToChatIsUIMismatch、TestTerminalFramesUnchangedV3 | Go | 通过（未用旧桌面实机打开） | — |
| R18.1 proto 3 | TestInfoAndReadyProto3 | Go | 通过 | — |
| R18.2 三处一致 | 本轮按 /protocol-sync 的步骤重新核对（见下一节）：`Version = 3`、`PROTOCOL_VERSION = 3`、protocol.md 版本表第 3 行 | 检查 | 通过（1 处文档遗漏，不影响线上格式） | 下一节 |
| R19.1 CLAUDE.md | grep：「终端模式」「对话模式」「只支持 claude」均在 | 检查 | 通过 | — |

## /protocol-sync 核对（不变规则第 2 条）

按 `.claude/skills/protocol-sync/SKILL.md` 的步骤只读核对了 `vibe-remoted/internal/protocol/protocol.go`、`desktop/src/shared/protocol.ts`、`desktop/src/renderer/rest.ts`、`docs/protocol.md`，并对照 `server.go` 的 `routes()`、`ws.go` / `ws_chat.go` 的错误码和 `internal/chat` 实际返回的 ack 码。这四个文件自上一版报告（c2799e6）以来没有提交改动。

| 项 | Go | TS | 文档 | 一致 |
|----|----|----|------|------|
| 版本 | `Version = 3` | `PROTOCOL_VERSION = 3` | 「当前协议版本为 3」+ 版本表第 3 行 | 是 |
| 帧类型字符串（19 个：auth、attach、ready、data、resize、sessions、ping、pong、exit、error、notify、chat、chat_sync、chat_state、chat_ack、chat_send、chat_respond、chat_interrupt、chat_set_mode） | `Type*` 常量 | `FrameType` | 各节标题 | 是 |
| `attach`：sessionId?、newSessionId?、cols、rows、workdir?、flags?、mode?、ui?、epoch?、since?、handoffFrom? | `omitempty`（since 为 `*uint64`） | 对应 `?` | 全部列出 | 是 |
| `ready`：sessionId、workdir、proto、mode、sourceWorkdir?、sourceRepo?、worktreeRoot?、branch?、ui?、claudeSessionId?、existing?、handoffFrom? | 是 | `proto?`（接收端对旧 daemon 宽松） | 是 | 是 |
| `sessions[]`：id、title、workdir、created、mode + worktree 字段、ui?、state?、activitySeq?、epoch?、endReason? | 是 | 是 | 是 | 是 |
| `data` / `resize` / `exit` / `ping` / `pong` / `notify` / events 请求体 | 是 | 是 | 是 | 是 |
| `error`：message、code?、fatal?；12 个错误码及 fatal 标记（`ui_mismatch` / `chat_unsupported` / `claude_session_busy` 为 fatal，`shutting_down` / `attach_failed` / `auth_timeout` 不是） | `ErrCode*` + `sendError` 的 fatal 参数 | 开放字符串 + 注释 | 错误码表 | 是 |
| `chat`：seq、h?、msg | 是 | 是 | 是 | 是 |
| `chat_sync`：epoch、reset、omitted、historyCount、backlog | 是 | 是 | 是 | 是 |
| `chat_state`：status、permissionMode、permissionLocked、pending、degraded?、slashCommands、claudeVersion、claudeSessionId、ended；`PendingRequest`、`SlashCommand`、`ChatEnded` 的字段 | 是 | 是 | 是 | 是 |
| `chat_ack`：op、ref?、ok、code?、message?、duplicate?、completed? | 是 | 是 | **没有列出 `message`** | Go 与 TS 一致；文档遗漏 1 个可选字段 |
| `chat_send` / `chat_respond`（`ChatResponse`、setMode?）/ `chat_interrupt` / `chat_set_mode` | 是 | 是 | 是 | 是 |
| 开放集合：ack 码 9 个（与 `Ack*` 常量和 `internal/chat` 实际返回的一致）、`vr_resolved` 结果 5 个、`vr_notice` 码 4 个、`vr_exit`、`vr_client_msg_id`、`vr_stale`、`ended.reason` 6 个、`chat.reason` 6 个 + `workdir_untrusted`、`chatTrust` 3 个、`degraded` 的 `interrupt_receipt` | 是 | 是 | 是 | 是 |
| REST：8 个端点的方法和路径、`info` 的字段（含 `chat`、`?recheck=1`）、`fs` 的 `chatTrust` / `parent`、reload 的 204 / 202 / 409 `{error:"claude_session_busy", owner, message}`、delete 的 409 `worktree_preserved` | `routes()` + 各 handler | `rest.ts` | 端点表 | 是 |

结论：线上格式在 Go 与 TS 之间没有差异，版本号三处一致，兼容规则（新字段在接收端可选、未知帧和未知 kind 忽略）成立。**发现 1 处文档遗漏**：`docs/protocol.md` 的「chat_ack」一节没有列出可选字段 `message`（给人看的失败说明）；daemon 实际会发（`internal/chat/session.go` 的 `nackMsg`，如 `too_large`、`invalid_response`），桌面端会读（`chat/view.ts` 的 `ack.message || ack.code`）。两端实现一致，旧新版本互通不受影响；本步不改产品文档，记入遗留。

## 交付预览

- 产物：本轮没有录制操作录屏。可看的是 `evidence/` 下的逐用例截图（由 gui-chat-smoke 在断言通过的位置截取）。
- 来源：本轮截图 2026-11-20，本机（macOS，Electron 44.7.0），被测代码 6d88e45（副本检出 163b2c9）；其余截图 2026-11-14，a56684f。
- 覆盖范围：临时 daemon + 假 claude，不是真实服务。
- 核验：本轮新增和替换的 7 张截图逐张看过，画面里没有 token。`R1.3.png`、`R17.2-picker.png` 的目录列表里能看到本机 `/private/tmp` 下的目录名（与上一轮相同）。

## 探索式检查

本轮没有重新做人工探索；下面的检查范围和 X1 是 2026-11-14 那一轮（a56684f）的记录，原样保留。b88f4ae 涉及的两处界面本轮由布局断言覆盖，并逐张看了新截图。

检查的界面（桌面视口 1512×868，另在 820×600 下看了对话界面与新建对话框；zh 与 en 两种语言）：新建会话对话框「界面」一节（5 台机器各自的可用性与原因）、对话界面（发送 / 流式 / 工具块 / diff / Markdown / 链接）、权限 / 计划 / 提问卡片、中断 / 排队 / 斜杠 / 模式切换、断线与补发分隔线、结束状态与交接、侧边栏圆点与通知降级、对话会话改名 / 删除 / 重载、GUI 内重启 daemon（daemon_restart → 重新启动）、终端会话（新建、输入、窗口缩放后 `stty size` 从 32×62 变 46×119、复制粘贴由 gui-smoke 覆盖）。输入了 `<b>`、`<script>`、emoji、引号：用户气泡与回复都按纯文本显示。控制台无未捕获异常。

| 编号 | 程度 | 问题 | 处理 |
|------|------|------|------|
| X1 | 低 | 回合进行中输入 `/theme` 后交接：对话会话已结束，但「/theme 只能在终端界面使用 [新建终端会话接上]」提示仍挂在结束横幅下；切换语言后它仍是旧语言。复现：对话会话运行 `slow 300 100` → 输入 `/theme` 回车 → 点提示里的「新建终端会话接上」并确认 → 回到对话会话 → 点 EN。截图 evidence/X1-before.png | 已修复 a56684f，回归测试 test-chat-view「terminal-only notice: closed when the session ends, relabelled on a locale switch (X1)」（先失败后通过） |
| X2 | 低 | 本轮看截图时发现：新建对话框里「这台机器的 vibe-remoted（dev，协议 2）比桌面端（协议 3）旧…」这条提示贴着对话框左右边缘，没有和其他小节一样的内边距（evidence/R17.2-picker.png；2026-11-14 的同名截图里也是这样）。这条提示的代码在 main 上就有（`dirpicker.ts` 里 `modal-mode-note` 插在模式区之外），不是本需求引入的，只有连旧 daemon 时才出现 | 未修复，记入后续（本步不改产品代码） |

看过但不算问题（记录以免重复排查）：
- 新建对话框打开时「终端」卡片同时带选中边框和焦点环（同色）。只有脚本用 `.click()` 选「对话」而焦点留在「终端」时才会出现两张卡片都描边（evidence/picker-layout.png 就是这种情况）；鼠标点击或键盘选择时焦点随选中项移动。沿用原有 `.modal-mode-card` 样式。
- 交接后终端会话与对话会话同名（都取目录名 `main`），侧边栏靠图标和「对话」徽标区分。符合「默认名跟随 workdir」。
- 重载 / 重启后假 claude 的 `burst`、回合错误不在 JSONL 里，所以重建的历史里没有它们；真 claude 的 assistant 消息都会写 JSONL，`result` 本来就不写。属于假 claude 的保真度，不是产品问题。

## 修复记录

| 问题 | 提交 | 回归测试 | 复测 |
|------|------|----------|------|
| X1 终端专用命令提示在会话结束后残留、不随语言切换（decisions #37） | a56684f（`composer.ts`、`view.ts`） | test-chat-view X1 | 本轮 npm test、gui-chat-smoke 全过 |
| #39 新建会话对话框在窗口高度约 1090px 以下时路径栏被压扁、启动选项和「取消 / 在此打开」被裁掉点不到（用户试用发现） | b88f4ae（`dirpicker.ts`、`styles.css`）：标题和按钮固定、中间滚动 | gui-smoke / gui-chat-smoke 的 500/700/803px 布局断言（`picker-layout.mjs`）；静态守卫 test-picker-layout | 本轮 gui-smoke 两次运行里 6 项布局断言都通过，gui-chat-smoke 1 项通过，npm test 通过 |
| #40 斜杠命令菜单里长命令名折成多行、压到描述上（用户试用发现） | b88f4ae（`composer.ts`、`styles.css`）：名字一行、描述在下方最多两行、菜单加宽、选中项滚动进可视区；fakeclaude 加 `FAKE_CLAUDE_LONG_COMMANDS` | gui-chat-smoke 的 800×500 / 1280×800 布局断言（`slash-menu-layout.mjs`）；静态守卫 test-slash-menu-layout；test-chat-view「slash menu rows…」 | 本轮 gui-chat-smoke、npm test 通过 |
| （测试自身）gui-chat-smoke R16.3 之后窗口未真正回到前台时 rAF 暂停，提示卡片未及时移除，`sendChat` 的回车落在别的元素上（曾把语言切成 EN），R13.2 / R14.2 偶发失败（4/6） | c2799e6 前已改进脚本：恢复窗口时 `app.focus({steal:true})` 并等一帧 rAF；`sendChat` 先确认输入框真的拿到焦点 | 上一轮修后连续 6 次全过；本轮 1 次运行通过 | — |
| （测试自身）R16.3 角标清除只在窗口确实获得焦点时断言（macOS 不保证后台启动的应用能被拉到前台） | 同上 | 本轮窗口获得了焦点（`window focused: true`），角标清除 | — |

a56684f 和 b88f4ae 各改 2–3 个产品文件，都没有接口变化，未超过再评审门槛（>5 个文件或改接口）。**b88f4ae 没有单独做过独立代码评审**（review.md 的范围到 9b42ff0 为止），由机器关口 C 的独立验证覆盖。

## gui-smoke「drag-select under mouse reporting + ⌘C」偶发失败

本轮数据：2 次运行，第 1 次失败、第 2 次通过。失败时复制到剪贴板的内容是 `"SELECT_ME_PLEASE\nbash-3.2$ \n"`——目标文字是对的，但选区多拖了下一行（提示符行）和一个空行。两次运行之间没有改任何代码或脚本，各用独立的 `TMUX_TMPDIR`，当时没有其他 Electron 测试实例（开跑前用 `ps -axo pid,comm | grep 'Electron$'` 看过）。

历史数据：review.md 记录 3 次里 1 次失败（多复制了空行）；上一轮（c2799e6）在 3 种条件下共 27 次运行没有复现（正常 10、CPU 压满 8、并发 `go test -race` 6、其余 3）。

对上一轮假设的更新：
1. 「共用 `tmux -L vibe-remote` 被外部干扰」解释不了本轮这次失败：本轮 gui-smoke 的终端 daemon 用的是独立的 `TMUX_TMPDIR`，没有别的会话。
2. 复制到的内容是「选区 + 下一行」，剪贴板里没有外来内容，所以是拖选本身跨了行，不是别的程序写了剪贴板。这与上一轮的假设 2（定位目标行与拖选之间画面又重绘了一次，行位置变化）相符，但本轮没有做实验去证实。
3. b88f4ae 在这个用例之前加了窗口高度模拟（`pickerLayout` 依次设 500 / 700 / 803px 再恢复）。它是否提高了这个用例的失败率，没有数据：改动之后只有本轮 2 次运行（1 败），没有做对照实验。

没有改这个测试，也没有放松断言。它检查的是终端选区和剪贴板（`mouseEventsRequireAlt`），b88f4ae 没有改终端、xterm 配置和剪贴板代码。是否需要先定位再合并，留给独立验证判断。

## 未覆盖和遗留

未做（需真机 / 真 claude，不能在本机用假 claude 代替；与上一轮相同，本轮没有新增条件去做）：
- **R5.2 规则写进远程设置**：需要真 claude 2.1.210 收到 `updatedPermissions` 后写 `.claude/settings.local.json`；假 claude 只把规则记在 `$FAKE_CLAUDE_RULES`（Go 测试已证明 daemon 原样转发、自己不写文件）。
- **首字延迟（非功能，≤200 ms，只记录）**：需要局域网另一台远程机，对话模式与终端里的 claude 各测 5 次取中位数，并消耗真实模型调用。
- **R1.5 真机部分**：真 claude 写出的 JSONL 历史（含工具块）的显示。本机用 3000 行合成 JSONL 验证了加载、窗口和工具块。
- **R17 / V17 远程 Linux**：对话模式在远程 Linux（登录 shell、fnm 等）上启动 claude；本机只有 macOS。
- **R16.3 原生通知显示**：未签名构建的原生通知必然失败并降级（`[notify] fallback`），「通知显示 → 点击」只能用主进程发 `notification-click` 模拟点击；打包后 DMG 的降级行为也未在 `release/` 里手工核对（verify skill 已写明这一点）。

已知偶发失败及本轮是否出现：
- gui-smoke「drag-select + ⌘C」：**出现 1 次**（2 次运行中的第 1 次），见上一节。
- gui-chat-smoke 的 R1.1、R7，以及焦点跑偏时界面语言被切成英文导致的 R13.2 / R14.2：本轮 1 次运行里都没有出现。

遗留：
- **b88f4ae 没有单独做过独立代码评审**，由机器关口 C 的验证覆盖。
- `docs/protocol.md` 的 chat_ack 一节缺可选字段 `message`（见 /protocol-sync 一节），待补文档。
- X2：旧 daemon 提示在新建对话框里没有内边距（main 上就有，低）。
- 上一轮建议「gui-smoke 的终端 daemon 改用独立 `TMUX_TMPDIR`、失败时打印复制到的原文」：后一半脚本已经做到（本轮失败行里有原文）；前一半脚本本身没改，本轮靠运行时传入 `TMUX_TMPDIR` 隔离。
- 浏览器用例里的断线、丢帧、扣帧由渲染进程内包装的 `WebSocket` 模拟（`window.__vrNet`），不是真的断网；「另一台桌面」是脚本里的 WebSocket 客户端。
- `.devflow.yml` 里的 `autonomy: L1` 没有随本需求的等级调整而改（它在 `docs/changes/` 之外，不属于本步可改的范围）。
- 本轮没有重做人工探索，也没有重做 gui-chat-smoke 的多次稳定性运行。

## 验收核对（第 7 节）

按 2026-11-20 的状态重新核对。

| 方面 | 检查 | 结果 |
|------|------|------|
| 完整 | tasks.md 的 T1–T13 状态都是「完成」，没有「阻塞」；R1–R19 每个场景都有测试和结果（上表），两处布局修复（#39、#40）单列了行；未做项单列 | 通过（4 项真机未做 + 原生通知显示，原因见上） |
| 正确 | make check 退出 0；ws-smoke 12/12、ws-chat-smoke 9/9；gui-chat-smoke 29/29；gui-smoke 重跑 30/30，**第 1 次 29/30（已知偶发的 drag-select）**；最低版本 2.1.210、协议 3、各条界面文案在浏览器用例里按 spec 原文断言（R1.3 / R1.4 / R13.4 / R14.2 等）；R12.2 500 条 46 ms ≤ 2000 ms | 通过，带 1 次偶发失败的记录 |
| 一致 | 设计 4.12 列出的 data-testid 由 test-chat-view 覆盖（本轮通过）；dev-build 的偏差在 decisions.md（#21–#35），测试阶段的做法和两处布局修复在 #36–#40；本轮的流程决定追加在 decisions.md 末尾 | 通过 |
| 干净 | 主目录工作区除本报告这一次提交涉及的 `docs/changes/` 文件外，只有用户自己的 `vibe-remoted.local-tmux.json`（未提交改动）和 `vibe-remoted-state/`（未跟踪），都没有碰；`.devflow-tmp/` 在 `.git/info/exclude` 里，`git ls-files .devflow-tmp` 为空；`desktop/src/renderer/chat/` 下没有 `console.log` / `debugger`；测试副本里除 gui-chat-smoke 写出的截图外没有改动 | 通过 |
| 改全 | `vibe-remoted.example.json` 有 `"state_dir": ""`；`.devflow.yml` 没有 `upgrade_doc`，design.md「变更」里没有单列升级步骤——升级就是替换远程 daemon 二进制（CLAUDE.md「远程 daemon 部署同步」已写，协议版本表有第 3 行）；invariants 11 条：10 条命令型全部 exit=0，第 2 条 /protocol-sync 本轮人工核对，线上格式一致、有 1 处文档遗漏 | 通过（备注：升级步骤未单列成文档；protocol.md 缺 `chat_ack.message`） |

spec「完成条件」逐条：

| 条件 | 状态 | 依据 |
|------|------|------|
| R1–R19 的全部场景用 verify skill 跑通 | 本机能做的全部通过；4 项需要真 claude / 远程 Linux 的和原生通知显示未做 | 场景对照表；ws-chat-smoke 9/9、gui-chat-smoke 29/29 |
| gui-smoke 新增的对话模式端到端用例通过 | 通过（两次运行里 3 个对话用例都通过） | 「chat session created via picker」「chat reply rendered」「permission allow once resumes」 |
| `make check` 全绿 | 通过 | exit=0，Go 5 个包 ok，npm test 22 个脚本 |
| protocol-sync 检查三处一致 | 通过：Go / TS / 文档的帧、字段、版本一致；另有 1 处文档遗漏（`chat_ack.message` 未列），不影响线上格式 | /protocol-sync 一节 |
| 现有终端会话测试（`npm test`、`go test -race`、gui-smoke 原有用例）不改断言照样通过 | `npm test`、`go test -race` 通过，断言未改；gui-smoke 原有用例断言未改，重跑全过，**第 1 次运行 drag-select 用例失败 1 次（已知偶发）** | make-check.log；gui-smoke-run1.log / run2.log；`git diff` 核对原有测试没有删改行 |
