# 测试报告：双模式会话（终端 + 对话）

日期：2026-11-20　分支：change/dual-mode-fix2（从 change/dual-mode 的 16fd611 开出，修完快进合并回去）　提交：f03e9d9（最后一个改代码 / 测试的提交；全部检查在其后的文档提交 0403bd3 上运行，两者的代码和测试相同）

被测检出：worktree `.devflow-tmp/verify-dm`，分支 `change/dual-mode-fix2`。全部构建和测试都在这里运行。

> ⚠️ **这是关口 C 第 2 轮返工后的全量运行。** 关口 C 第 2 轮（提交 16fd611）：界面部分通过、有备注；非界面部分（codex）不通过，拦下 1 个问题——X4 的修复引入的回归，`-c` 的 cwd 检查漏掉已有历史（返工里记为 X9）。另外顺手修了界面验证者的备注 3、4（改名之后、点开「等你处理」的会话之后键盘焦点停在页面上，记为 X10）。结论全文和指定小节在 verdict-history.md「关口 C 第 2 轮」。本报告是这 2 个修复之后重新跑的全部检查。
> ⚠️ 端到端测试：**已完成本机能做的部分**——协议冒烟（ws-smoke、ws-chat-smoke）和界面测试（gui-smoke、gui-chat-smoke，本机构建产物 + CDP，会弹出临时窗口）。**环境是临时 daemon + 假 claude（`vibe-remoted/internal/chat/fakeclaude`），不是真实的 claude，也不是远程 Linux。**
> **未做**：需要真 claude / 远程 Linux 的 4 项（R5.2 规则落盘、首字延迟、R1.5 真机那一半、V17 远程 Linux），以及原生通知的显示（未签名构建只能走 Dock 降级）。原因见「未覆盖和遗留」。
> **最终代码上的运行没有失败**：make check、两份协议冒烟、10 条命令型不变规则全部通过；两份 GUI 冒烟各连续运行 2 次，全部通过，已知的偶发项一次都没有出现。**过程中有 1 次失败**：X10 修复后第一次运行新写的 `X10-rename-chat` 用例失败 1 次，原因在测试自身的时序，已改，见「运行过程中的失败」。
> 浏览器环节：适用（项目自己的 CDP harness，不用 Playwright；`.devflow.yml` 的 `cloud_browser: forbidden`）。返工新增的界面用例用 CDP 的真实输入事件（`Input.dispatchMouseEvent` 的滚轮 / 按下 / 松开 / `clickCount`、`insertText`、按键），不是 DOM 的 `.click()`。
> 测试环境：e2e_env = local；独立验证（机器关口 C 的下一轮，只验这次返工的改动，decisions #50）不在本报告范围。

## 汇总

| 类别 | 通过 | 失败 | 跳过 | 合计 |
|------|------|------|------|------|
| 单元 + 集成（Go，`go test -race -count=1 ./...`，make check 内） | 265 个顶层测试（另有 189 个子测试），5 个包 | 0 | 0 | 265 |
| 单元（TS，`npm test`，make check 内） | 141 个用例，24 个脚本 + preserved-notice 检查 | 0 | 0 | 141 |
| 协议冒烟（终端 `ws-smoke.mjs`，自建临时 daemon） | 12 | 0 | 0 | 12 |
| 协议冒烟（对话 `ws-chat-smoke.mjs`） | 9 | 0 | 0 | 9 |
| 浏览器（`gui-smoke.mjs`）第 1 / 2 次 | 30 / 30 | 0 / 0 | 0 | 30 |
| 浏览器（`gui-chat-smoke.mjs`）第 1 / 2 次 | 37 / 37（34 个用例：23 个带 R 编号的场景 + 2 个布局 + 8 个返工新增 X6、X7 ×2、X8 ×2、X10 ×3 + 建主会话 1 项；另有启动 2 项、无渲染异常 1 项，按 PASS 行计） | 0 / 0 | 0 | 37 |
| 不变规则（`.devflow.yml` invariants，命令型 10 条，原样运行，加 `GOFLAGS=-count=1`） | 10 | 0 | 0 | 10 |
| 不变规则第 2 条（/protocol-sync） | 三处一致（本轮没有动协议文件） | — | — | — |

数量变化（相对上一版报告，5ce6f55 / 16fd611）：
- Go 顶层测试 261 → 265（chat 96 → 98、server 55 → 56、session 94 → 95；config 14、protocol 2 不变），子测试 172 → 189：新增 TestLatestSessionReadsUntilFirstCwd（6 个子用例）、TestLatestSessionComparesCanonicalCwd（6 个）、TestContinueFindsLateOrAliasedCwd（5 个）、TestTerminalContinueFindsLateOrAliasedCwd。没有删除。
- TS 用例 133 → 141：test-chat-view 20 → 22、test-sidebar-rename 9 → 15。没有删除，没有改动已有断言。
- gui-smoke 的 PASS 行 30 → 30（脚本没有改）；gui-chat-smoke 的 `test(` 31 → 34，PASS 行 34 → 37。

运行命令和结果（依次运行，互不并发；每条都带独立的 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-x9-XXXXXX)`，GUI 冒烟另给一个空的临时 `CLAUDE_CONFIG_DIR`；启动 Electron 前用 `ps -axo pid,comm | grep 'Electron$'` 确认没有别的测试实例——每次都没有，没有等待；原始输出在本机临时目录，不入库）：

```
$ GOFLAGS=-timeout=15m make check                # 0403bd3，exit=0
cd vibe-remoted && go vet ./...
cd vibe-remoted && go test -race -count=1 ./...
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	22.684s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/config	3.096s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/protocol	3.644s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	24.128s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	28.314s
cd desktop && npm run typecheck                  # tsc --noEmit，无输出
cd desktop && npm test
attach-replay regression checks passed
terminal layout regression checks passed
picker layout regression checks passed
slash menu layout regression checks passed
terminal clipboard regression checks passed
terminal selection regression checks passed
client-reconnect regression checks passed
client-liveness regression checks passed
machine-store checks passed
i18n parity checks passed (247 keys)
chat client checks passed (9)
test-chat-parser checks passed (15)
test-chat-session checks passed (20)
test-chat-permission checks passed (11)
test-chat-diff checks passed (8)
test-chat-queue checks passed (15)
test-chat-markdown checks passed (6)
chat render guard passed (15 files)
test-chat-window checks passed (3)
test-chat-view checks passed (22)
test-chat-availability checks passed (9)
test-chat-activity checks passed (8)
test-sidebar-rename checks passed (15)
source bytes check passed (31 files, no NUL)
exit=0

$ go test -race -count=1 -timeout 20m -v ./...   # 只为数测试个数
顶层 --- PASS 265，子测试 --- PASS 189，FAIL 0，SKIP 0；exit=0

$ go test -race -count=1 -timeout 5m -v ./internal/chat -run TestOrphanCleanup     # 关口 C 第 2 轮 codex 在沙箱里因为不能执行 ps 没能验证的两组，单独再跑一次
--- PASS: TestOrphanCleanup (0.00s)
    --- PASS: TestOrphanCleanup/ended_records_unchanged (0.00s)
    --- PASS: TestOrphanCleanup/ended_and_confirmed_gone (0.80s)
    --- PASS: TestOrphanCleanup/unrelated_process_untouched (0.98s)
    --- PASS: TestOrphanCleanup/stubborn_needs_SIGKILL (2.80s)
    --- PASS: TestOrphanCleanup/survivor_keeps_the_claim (3.79s)
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	5.335s
$ go test -race -count=1 -timeout 5m -v ./internal/session -run TestLoadChatsMarksDaemonRestart
--- PASS: TestLoadChatsMarksDaemonRestart (0.34s)
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	1.865s

$ VR_TOKEN=… node .claude/skills/verify/scripts/ws-smoke.mjs 127.0.0.1:<随机端口> <本次运行自己的目录>   # 临时 /bin/bash daemon，allowed_roots 只有该目录，独立 TMUX_TMPDIR
PASS /healthz
PASS /api/v1/info version=dev
PASS session A ready id=1795154322908-c298480b
PASS A sees its own VIBE_REMOTE_SESSION_ID
PASS A got a hook token distinct from the main token
PASS hook token → events 204
PASS notify frame delivered to session A
PASS hook token rejected for another sessionId
PASS hook token rejected on /api/v1/info
PASS B sees its own VIBE_REMOTE_SESSION_ID (no env bleed from A)
PASS deleted 1795154322908-c298480b
PASS deleted 1795154323076-b84ef9bd
all checks passed
exit=0

$ node .claude/skills/verify/scripts/ws-chat-smoke.mjs
PASS chat: create — id=1795154325088-42c1b6ef
PASS chat: replay before ready — one session, one process
PASS chat: two clients — both saw both, same order, one process
PASS chat: pending survives reconnect — request d6181efd-5c87-4644-92a3-ae412d3ddddc answered after reconnect
PASS chat: resync 50 — backlog 54, seq 14..67
PASS chat: handoff — terminal 1795154325516-cab80d2a runs --resume 307236cb-d8f5-41dd-9f4c-1a4cef39139f
PASS chat: daemon restart → ended — history 2, reloaded and replying
PASS chat: state without hooks — idle → running → idle → waiting → idle
PASS chat: delete keeps jsonl — process gone, transcript kept
all chat checks passed
exit=0

$ .devflow.yml 的 10 条命令型 invariants，逐条原样运行（前面加 GOFLAGS=-count=1，各自独立的 TMUX_TMPDIR）
cd desktop && npm test                                                        exit=0
…/internal/server -run TestTerminalFramesUnchangedV3                          exit=0
…/internal/chat -run 'TestSingleProcess|TestOrphanCleanup|TestLatestSessionChecksTranscriptCwd|TestLatestSessionReadsUntilFirstCwd|TestLatestSessionComparesCanonicalCwd' && …/internal/session ./internal/server -run '<原有 9 个 + X4 的 2 个 + X9 的 2 个用例>'   exit=0（本轮改过的 check，decisions #51）
…/internal/server -run TestChatDisconnectKeepsProcess                         exit=0
…/internal/chat -run TestPendingSurvivesRingEviction                          exit=0
…/internal/chat -run TestRespondRejectsForeignRule                            exit=0
…/internal/chat -run TestCommandFromConfigOnly && …/internal/server -run TestAttachIgnoresCommandFields   exit=0
cd desktop && npm run test:chat-markdown && npm run test:chat-render-guard    exit=0
…/internal/session -run TestChatEnvHookTokenOnly                              exit=0
…/internal/chat -run TestNoCredentialAccess                                   exit=0
10/10 exit 0

$ node .claude/skills/verify/scripts/gui-smoke.mjs      # 第 1 次（第 2 次的 PASS 行相同，30 项，exit=0）
PASS daemon up on 127.0.0.1:26547
PASS chat daemon (fake claude) up on 127.0.0.1:20629
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
PASS drag-select under mouse reporting + ⌘C copies the text
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
all GUI checks passed
exit=0

$ DEVFLOW_EVIDENCE_DIR=docs/changes/2026-11-13-dual-mode/evidence VR_MAIN_DAEMON=<基准 7d25cbd 构建的 daemon> node .claude/skills/verify/scripts/gui-chat-smoke.mjs   # 第 1 次（第 2 次同样 37 项全过，exit=0；R12.2 计时 39 / 47 ms）
PASS 5 daemons up (gui-term:22841 gui-main:23627 gui-chat:29089 gui-old-claude:21668 gui-old-init:23709)
PASS app started with 5 machines (zh), network hook installed
PASS R1.3 bash machine: chat card disabled with the reason — 对话界面只支持 claude：这台机器的 claude_cmd 不是 claude
PASS R1.1 default new session is a terminal session — session 1795154156458-87b38417
PASS R1.4 claude too old: chat card disabled, upgrade claude — 远程 claude 版本 1.0.51 低于对话界面要求的 2.1.210，请升级 claude
PASS new-session dialog: buttons reachable in 500/700/803px-high windows — 500px ok, 700px ok, 803px ok
PASS R17.2 new desktop + protocol-2 daemon: terminal works, chat card says upgrade vibe-remoted — 这台机器的 vibe-remoted（协议 2）不支持对话界面（需要协议 3），请升级 vibe-remoted; picker note: 这台机器的 vibe-remoted（dev，协议 2）比桌面端（协议 3）旧：断线时可能重复创建会话。建议先更新 daemon。
PASS R1.5 chat + -c shows the full 3000-line history, windowed — session 1795154158937-3b622782; first screen 300 messages; 9 scrolls to the first; total 2000
PASS R1.6/R11.2 bypass: mode fixed, no permission prompts — menu bypassPermissions (会话以 --dangerously-skip-permissions 启动，权限模式固定为「跳过权限」，不能切换。)
PASS X7 scrolled up with the wheel: a typed message and its reply show; replies do not drag the view; reaching the bottom shows them — gap after sending 1px; history kept at 1667px while a reply arrived
PASS X7 background session got more than a screen: back at the bottom with the newest, a typed message shows; left scrolled up → same place — back at the bottom (gap 1px) after 40 messages in the background; scrolled-up place kept (3075px)
PASS X8 double click on an open chat session (current, then background) renames it; the name is not sent to claude; the sidebar keeps updating — current → "登录页重构", background → "x8 第二个名字"; no chat traffic; sidebar dot and switch still work
PASS X8 double click on an open terminal session (current ×3, background ×2) renames it; nothing is typed into the shell — 5 renames, last "bg box 2"
PASS X10 a background chat session asks for permission (yellow dot): a real click opens it, then 1 answers / Esc interrupts without clicking the card, and typing goes on in the input — opened from the yellow dot: keyboard on chat-perm; 1 → done Bash, next message typed without a click; Esc → request interrupted
PASS X10 after renaming a chat session (Enter, Esc, a click on another session) the next keys go into the current session, without a click — Enter, Esc and click-elsewhere: the next message was typed without a click each time
PASS X10 after renaming a terminal session (Enter, Esc) the next keys go into the terminal, without a click — Enter and Esc: the next command was typed without a click
PASS main chat session created (dir main) — 1795154187339-37681799
PASS R3.2 markdown + code copy button — font "SF Mono"
PASS R3.3 raw html/script inert, links go to the system browser — links [["ok","https://example.com"]]; open-external got ["https://example.com"]
PASS R4 tool blocks: Read/Grep folded, Bash output, Edit diff, failure — Read:ok Grep:ok Bash:ok Edit:ok:open Bash:error:open
PASS R5.6 answer lost before reaching the daemon → prompt open again after reconnect — submitting → reconnect → open → allow → ran
PASS R5.7 second answer → "handled elsewhere", claude gets one answer — vr_resolved allowed
PASS R6 plan review: approve+acceptEdits, approve+manual, revise — opt1→acceptEdits, opt2→default, opt3→revised (mode while revising: default)
PASS R7 AskUserQuestion form: incomplete → disabled, single/multi/other → answers — Banana / Blue + "my own colour"
PASS R8 Esc and stop interrupt; Esc on a prompt; Esc idle does nothing — Esc + stop → 已中断; prompt Esc → tool error; idle Esc no-op
PASS R9 queue while busy: queued, remove, interrupt returns to the input — queued ×2, removed one, interrupt put "echo q-three" back
PASS R10 slash menu and terminal-only commands — menu /compact /review /fake-skill /baoyu-post-to-wechat /dev-build /dev-design /dev-release /dev-requirements /posthog:signals-scout-customer-analytics-billing-and-usage /reverse-engineering-with-code-eval-and-ida-domain:ida-domain-scripting /unbroken-description /very-long-comman…
PASS slash menu with long names and descriptions: rows readable in 800x500 and 1280x800 windows, selection stays in view — 800x500: menu 474x290, 13 rows (4 whole) ok; 1280x800: menu 560x400, 13 rows (6 whole) ok
PASS R11.1 permission mode: Shift+Tab cycle and menu — Shift+Tab acceptEdits→plan→default; menu default,acceptEdits,plan
PASS R12/R12.2 offline, 500 messages meanwhile → divider, render ≤2000 ms — divider "— 本地连接在此中断，远程会话未受影响 —已补回断线期间 504 条消息"; ready → rendered 39 ms
PASS R13.1 turn error shows retry; retry resends — 本轮回复失败API Error: 529 Overloaded重试
PASS R16.3 waiting in a background session: yellow dot, notification / Dock fallback, click opens it — window focused before: true; notify fallback; badge while hidden "•", after focus() "" (window focused: true); click → main opened
PASS R16.3 current session while the window is in the background: yellow dot on it + notification; cleared once the window is focused again — [notify] fallback: gui-chat · main; dot waiting while in the background, none after focus
PASS R13.2 claude exits → ended banner, restart works — 会话已结束：claude 进程退出（代码 1）fake claude crash line 1
PASS R14.2 handoff while a turn runs asks first, then continues in a terminal — dialog "Claude 正在回复，交给终端会中断当前回合。继续吗？"; terminal: fake-claude interactive resume=1437fb27-d518-4865-94f8-673de4d5168b
PASS R13.4 init reports an old claude → ended with required version, no reconnect — claude 版本过旧（1.0.0），对话界面需要 2.1.210 或更新已升级，重新检测新建终端会话接上
PASS no uncaught renderer exceptions
all GUI chat checks passed
exit=0
```

说明：
- `gui-chat-smoke.mjs` 默认用 `git worktree add … main` 构建协议 2 的 daemon，会改共享仓库的 worktree 元数据；本轮和关口 C 的界面验证者一样，用 `git archive 7d25cbd vibe-remoted` 把基准源码导出到自己的临时目录构建，经脚本自带的 `VR_MAIN_DAEMON` 传入。
- 两次 gui-chat-smoke 都带 `DEVFLOW_EVIDENCE_DIR`；只提交了新增用例的 3 张截图（`X10-prompt.png`、`X10-rename-chat.png`、`X10-rename-terminal.png`），其余被覆盖的旧截图已还原、没有替换。
- gui-smoke 2 次运行里拖选用例的「屏幕动了、重新量」提示（`NOTE drag-select: …`）一次都没有出现。

## 运行过程中的失败

最终代码（f03e9d9 / 0403bd3）上的全部运行没有失败。之前的运行里有 1 次（不算各用例「修复前必须失败」的那几次，那些记在下一节）：

| 何时 | 失败 | 原因 | 处理 |
|------|------|------|------|
| X10 修复之后、提交之前，第一次运行 `VR_ONLY=X8-chat,X8-terminal,X10-prompt,X10-rename-chat,X10-rename-terminal`（5 个用例里 4 过 1 败） | 本轮新写的 `X10-rename-chat`：`timeout (5000ms): x10s is the current session`（改名输入框开着时真实点击另一个会话，名字保存了，但没有切过去） | 测试自身的时序 + 一个已知的既有问题。daemon 在 127.0.0.1，改名请求在鼠标松开之前（40 ms 内）就返回，侧边栏随即重建，按下和松开落在不同的元素上，这次点击被吞掉——就是 tasks.md「后续」里记的「侧边栏重建时按下和松开之间的点击会丢」。关口 C 第 2 轮界面验证者手工做同一操作时切过去了（它的点击带自动重试）。X10 的代码在这种情况下的行为是对的：键盘回到仍然是当前会话的那个会话 | 用例里把这一步的改名请求延迟 500 ms（包一层 `fetch`，只对 `/rename`，做完还原），模拟远程 daemon 的往返时间，这样点击先于重建完成，走到「改名提交期间切换会话 → 改名结束后键盘交给新的当前会话」这条要测的路径。之后带 `VR_ONLY` 运行 1 次、全量 2 次都通过。「点击被吞」本身没有在这一轮修，补记进 tasks.md「后续」 |

已知偶发项本轮的情况：
- gui-smoke「drag-select + ⌘C」：2 次运行都通过，重量提示没有触发。
- gui-chat-smoke 的 R1.1、R7、R13.2 / R14.2：2 次全量运行都没有出现。
- `internal/chat` 的 `TestStopAccountsForEveryQueuedMessage/restart`：本轮 chat 包带 `-race` 完整运行了 3 次（X9 修复后 1 次、make check 1 次、`-v` 1 次；不变规则里的子集不算），没有出现。

## 关口 C 返工（第 1 轮、第 2 轮）

每个问题：先写能复现它的测试并看到它失败，再修，再做变异核对（去掉修复的关键一处，回归测试必须失败；变异不提交）。

表里 X7 到「备注 4」各行是第 1 轮返工（5ce6f55）时的记录，原样保留；它们的回归测试在本轮最终代码上全部重新运行并通过。最后两行 X9、X10 是第 2 轮返工。

| 问题 | 修复提交 | 回归测试（单元 / 真实应用） | 修复前的失败 | 结果（X9、X10 为本轮；其余为第 1 轮返工时） |
|------|----------|------------------------------|--------------|----------|
| **X7** 对话不在底部时发消息，自己的消息和回复都不显示，滚到底也不出来；后台会话收到超过约 48px 内容后切回也进入这个状态（R3.1） | 6f9153f | 单元：test-chat-window「new messages: the window always reaches the newest, its start stays put」，test-chat-view「X7 scrolled up: sending…」「X7 scrolled up: new replies do not drag the view…」「X7 background session…」（jsdom 上给对话区装了假的布局）。真实应用：gui-chat-smoke `X7-send`、`X7-background`（CDP 真实滚轮、点击、按键） | test-chat-window：`end: 3000` ≠ `3005`；test-chat-view：`own message is in the transcript`（[] ≠ ['echo can you see this']）、`the newest message is rendered below`、`left at the bottom → at the bottom on return`（2600 ≠ 4600）；X7-send：`timeout (5000ms): own message shown after sending while scrolled up`；X7-background：`back from the background the view is 1420px above the newest message` | 全过（最终 3 次全量都过）。变异：show() 不回底 / 发送不回底 / 窗口不跟到最新 → 各有用例失败 |
| **X8** 已打开的会话双击改不了名：输入框一闪而过，新名字进了对话输入框并被发给 claude，侧边栏随后冻结；终端会话约一半次数不可用（R15.1） | 3feaf67 | 单元：test-sidebar-rename（新脚本，index.ts 跑在 jsdom 上，真的 ChatView；对话 / 终端 × 当前 / 后台 × 两种点击节奏，Esc / 失焦，标签不在文档里时不冻结）。真实应用：gui-chat-smoke `X8-chat`、`X8-terminal`（`Input.dispatchMouseEvent` clickCount 1、2，按下 40 ms、间隔 90 ms） | test-sidebar-rename 第 1 个用例：`the rename input is in the sidebar`；X8-chat：`double click on "x8": no focused rename input 600 ms later (focus is on c-in)`；X8-terminal：`… (focus is on xterm-helper-textarea)` | 全过（最终 3 次全量共 6 次对话改名、15 次终端改名都成功）。变异：当前会话的点击仍走 setActive / focusView 不看改名状态 / 输入框没进文档仍置标志 → 各有用例失败 |
| **X3** 长回复在流式途中重连（reset 同步）后显示两次：一条没有 id 的残片 + 一条完整回复（R12.4） | d67ae4e | daemon：TestTailOverflowKeepsMessageStart（真实 Session，注入 20050 个增量 / 11 个 1 MiB 的增量触发淘汰，核对订阅得到的补发帧）。桌面端：test-chat-session「X3 reset sync mid-reply: a long reply shows once, complete」「X3 id-less preview: joins the message its complete blocks belong to…」（含验证者的帧序列）。这是协议层的问题，界面上没有单独的用例 | Go：`replayed tail starts with content_block_delta, want the message_start of long-reply`（两个子用例）；TS：`no id-less fragment next to the complete reply`（2 ≠ 1，即验证者看到的 `assistantCount: 2`） | 全过。变异：完整消息不认领无 id 预览 / 已有该 id 时不并入 → 各有用例失败；daemon 侧的变异就是修复前的代码 |
| **X4** 带 `-c` 新建会话时接上另一个目录的对话（`…/a-b` 与 `…/a/b` 在 claude 那里是同一个项目目录）；终端的 continue 改写同样（R1.5、H6） | f3e0366 | TestLatestSessionChecksTranscriptCwd（chat 包）、TestContinueIgnoresOtherDirectorySharingProjectDir（经 WebSocket 带 `continue` 新建）、TestTerminalContinueIgnoresOtherDirectorySharingProjectDir（终端 `-c`） | `workdir a-b with no conversation got bbbbbbbb-… — the conversation of a/b`；`-c in …/a-b (no conversation of its own) resumed …, the conversation of …/a/b`；终端 argv `[claude --resume <a/b 的 id>]` | 全过。变异：没有 cwd 的记录也认领 → 用例失败 |
| **X6** 当前会话在窗口失焦时收到待答请求：发了通知但侧边栏没有黄点（R16.3）。查证：spec 字面要求黄点，design 和 decisions 没有相反的决定（d12 写的降级是「Dock 弹跳 + 角标 + 侧边栏黄点」）→ 按 spec 修 | 6580bcf | 单元：test-chat-activity「pending prompt turns it yellow and notifies」（改 1 条断言）、「current session, window in the background: the yellow dot stays until it is seen or handled」、「current chat session, window in the background: its prompt shows yellow in the sidebar and notifies; focusing the window clears it」。真实应用：gui-chat-smoke `X6`（应用真的隐藏、页面失焦） | test-chat-activity：`dot: 'none'` ≠ `'waiting'`；X6：`timeout (10000ms): yellow dot on the current session` | 全过。变异：聚焦不清点 / 侧边栏照旧隐藏当前会话的点 / 通知结果回来把点去掉 → 各有用例失败 |
| **X5** `docs/protocol.md` 的 chat_ack 漏了可选字段 `message`（R18.2） | af47ac8 | /protocol-sync 对 chat_ack 的逐字段核对 | 文档缺 1 个字段 | 三处一致 |
| **测试备注 1** R5.6 用例里有一条永真断言 | 793eb80 | 改为三条真的断言：工具块还没有结果、claude 没有继续、另一端没有看到回答或工具结果 | 变异（假 claude 在收到回答前就产出工具结果）：`the tool block already has a result although the answer was never delivered` | 通过 |
| **测试备注 2** `TestOrphanCleanup/stubborn_needs_SIGKILL` 在不允许 `ps` 的环境里无限等待 | 793eb80 | 两处 `<-gone` 改为最多等 15 s 并报出原因（正常 1–3 s，用例自己断言 ≤ 4 s）。产品代码不变 | 把一个总是失败的假 `ps` 放在 PATH 最前面：16 s 后失败并写明「…where ps is not permitted the process is never signalled」，不再挂住；假 claude 由清理函数杀掉 | 正常环境通过 |
| **drag-select 加固** | 793eb80 | 量坐标前等屏幕稳定（正好是输出的那一行 + 下一行回到提示符 + 相隔 150 ms 两次看到的屏幕和位置相同）；拖完复核，屏幕动过就打印 NOTE、重新量、重新拖（最多 3 次）。最后的断言不变 | —（此前的偶发失败没有复现过） | 4 次运行都通过，未触发重量 |
| **备注 12** `prompts.ts` 里 3 个原始 NUL 字节 | 9135f77 | test-source-bytes（`desktop/src` 下任何文件含 NUL 字节即失败） | `raw NUL byte in source … prompts.ts:208 / :209 / :231` | 通过（31 个文件） |
| **备注 4** 删除对话会话的确认文案沿用终端的说法 | 9135f77 | test-sidebar-rename「delete confirmation: chat says the conversation stays in claude's history, terminal says the screen is lost (zh and en)」 | `chat.delete.confirm (zh)` 不存在 | 通过。变异：对话会话仍用终端文案 → 失败 |
| **X9**（第 2 轮，codex P4，拦）`-c` 的 cwd 检查漏掉已有历史：X4 的修复只读 JSONL 的前 100 行找 `cwd`，开头有很多不带 `cwd` 的记录（如 `queue-operation`）时，该目录明明有可以续上的对话，带 `-c` 却新开了一段；终端会话的 continue 改写同样（argv 变成 `--session-id <新 id>`）。记录的 `cwd` 是符号链接别名而请求用规范路径时也漏选（R1.5、H6、R17） | 81024f1（`chat/transcript.go`） | chat 包：TestLatestSessionReadsUntilFirstCwd（`cwd` 在第 101 行 / 第 1001 行约 2 MiB / 一行超过 16 MiB 之后 / 嵌套在更早记录里的 `cwd` 不算 / 键带 `\u` 转义 / 3000 行都没有 `cwd` → 不认领）、TestLatestSessionComparesCanonicalCwd（记录的是别名：文件在别名的项目目录里、在规范目录的项目目录里；记录规范路径、用别名查；同一路径的不规范写法；指向别的目录的链接不认领；已不存在的目录按字面比较）。入口一，经 WebSocket 带 `continue` 新建对话会话：TestContinueFindsLateOrAliasedCwd（5 个子用例，验证者的 5 种情况）。入口二，终端会话的 continue 改写：TestTerminalContinueFindsLateOrAliasedCwd（新建：第 101 行；重载进 `-c`：第 1001 行；新建：记录的是别名）。X4 原有的 3 个回归用例没有改动 | chat 包：`LatestSessionForWorkdir = "", false; want found=true`（第 101 行、第 1001 行、超长行之后 3 个子用例；别名的 3 个子用例）。WebSocket：`-c in …/real-dir (transcript of 8586 bytes, cwd … on line 101) started <新 id> instead of continuing <原 id>`（5 个子用例里 4 个失败，与验证者的 `directory-edges-ws.log` 相同；「记录规范路径、用别名打开」修复前就通过）。终端：`terminal -c with the cwd on line 101: argv [claude --session-id <新 id>], want --resume <原 id>` | 全过：`go test -race ./internal/chat ./internal/session ./internal/server` ok，X4 的 3 个用例原样通过。变异（各自还原）：加回 100 行上限 → 三个包里第 101 / 1001 行的用例都失败（终端的新建和重载各报一条）；记录侧不解析符号链接 → 三个包里别名用例都失败；筛行时不认 `\u` 转义 → 「cwd key written with escapes」失败。`.devflow.yml` 改后的不变规则 check 原样运行通过 |
| **X10**（第 2 轮，界面备注 3、4，不拦，顺手修）改名结束后键盘焦点停在页面上（`BODY`），要再点一下才能打字；从侧边栏点开「等你处理」的会话后焦点也在 `BODY`，卡片上写的 1 / 2 / Esc 按了没反应（R16.3 的主流程、R15.1） | f03e9d9（`index.ts`、`chat/view.ts`） | 单元（index.ts 跑在 jsdom 上，对话视图经 `openChatSession` 打开）：test-sidebar-rename 新增 6 个——改名回车 / Esc 后键盘回到当前对话会话的输入框、当前终端会话的终端；改名时点另一个会话，键盘到那个会话；改名时点进别处的输入框或对话框，键盘留在那里（对话框开着时会话不抢焦点）；点开有待答卡片的会话，键盘在卡片上，按 1 回答、Esc 中断，卡片消失后键盘到输入框；当前会话在改名时来了卡片，改名输入框不丢焦点、名字里的数字不会回答卡片。test-chat-view 新增 2 个（`ChatView.focus()`；`onFocusRequest`）。真实应用（CDP 真实点击、双击、按键、`insertText`，动作和按键之间不点击）：gui-chat-smoke `X10-prompt`（后台对话会话出现权限请求、黄点 → 真实点击侧边栏打开 → 直接按 1 → 回合继续 → 直接打字发下一条；再来一次 → 直接按 Esc → 请求显示为已中断、工具没有执行）、`X10-rename-chat`（双击改名：回车 / Esc / 点另一个会话之后直接打字，消息出现在当前会话，改名的那个会话没有收到）、`X10-rename-terminal`（回车 / Esc 之后直接敲命令，终端里有输出，名字没有被敲进 shell） | 单元：test-sidebar-rename 新增 6 个里 5 个失败（`Enter: the keyboard is in the chat input` 实际是 `HTMLBodyElement`；`… in the terminal`；`the keyboard is in the session that was clicked`；点开待答会话和改名时来卡片两个用例；「点进别处 / 对话框」那个修复前就通过，它守的是不能抢焦点）；test-chat-view：`view.focus is not a function`。真实应用三条都失败：`the card to close after pressing 1 without clicking it (the keyboard was on: BODY (nowhere))`、`"echo typed after rename" to show up in the renamed session — typed without a click (the keyboard was on: BODY (nowhere))`、`X10_42_TYPED on the terminal — typed without a click (the keyboard was on: BODY (nowhere))` | 全过：`npm run typecheck && npm test` 全绿，两次全量 gui-chat-smoke 里 3 个 X10 用例和 X8 的 2 个用例都通过；`test-sidebar-rename` 原有 9 个用例原样通过。变异 8 处各有用例失败（各自还原）：`focusView` 只给输入框；回车提交后不交回；Esc 后不交回；新卡片自己聚焦（不经 `focusView`）；卡片消失后不交给输入框（单元 3 个用例 + 真实应用 `X10-prompt`：`the message typed right after answering (the keyboard was on: BODY (nowhere))`）；交回时不看焦点已在别处；交回时不看对话框；去掉 `focusView` 里 X8 的改名保护（X8 的用例失败） |

### 改动的已有断言

只有 2 条已有断言被改，都是因为它们写的正是被判为缺陷的行为：

| 文件 | 原来 | 现在 | 依据 |
|------|------|------|------|
| `desktop/scripts/test-chat-window.mjs` | `follow(w, 3005, false)` 等于 `w`（「scrolled up: window does not move」）；同一用例里另外 3 条 `follow(…, true / false)` 的期望值不变，只是去掉了第三个参数 | `follow(up, 3005)` 等于 `{ start: 2500, end: 3005 }`：上滑时窗口**起点**不动（阅读位置不变），**末端**跟到最新；用例改名为「the window always reaches the newest, its start stays put」 | X7 的裁决 (3)：不贴底时窗口也要包含最新消息，滚到底能看到（R3.1）。「上滑阅读时新回复不拽动视图」这一半行为保留，改由 test-chat-view「X7 scrolled up: new replies do not drag the view…」和浏览器 X7-send 用滚动位置来断言 |
| `desktop/scripts/test-chat-activity.mjs` | `nextDot('none', {kind:'prompt'}, {isActive:true, windowFocused:false})` 等于 `{ dot: 'none', notify: true }` | `{ dot: 'waiting', notify: true }` | X6：spec R16.3「窗口没有聚焦，或该会话不是当前打开的会话 → 侧边栏显示黄点，并发桌面通知」 |

第 2 轮返工（X9、X10）改动的已有断言：**无**。新增的都是新用例；被改动的已有测试文件只有夹具层面的两处：`desktop/scripts/chat-test-util.mjs` 和 `test-chat-view.mjs` 给 jsdom 页面多挂一个全局 `HTMLInputElement`（卡片的按键处理要用它判断「是不是在文本框里打字」，此前没有任何用例走到按键这条路径）；`test-sidebar-rename.mjs` 的「点进别处」用例名字改了并加了一段（原有断言保留）。`gui-chat-smoke.mjs` 只增加用例、目录名和数字键的键码表。

其余改动都是新增。没有删除测试、没有跳过、没有调大已有的超时、没有加忽略规则。`TestOrphanCleanup` 是把无界等待改成有界；gui-smoke 拖选用例的最终断言（复制内容逐字等于 `SELECT_ME_PLEASE`）没有变；gui-chat-smoke R5.6 是把一条永真断言换成真的。测试夹具的改动：`chat-test-util.mjs` 的窗口焦点改为可控、导出 `rests` 和 `ChatView`；两份 GUI 冒烟的 bash daemon 目录由 `/tmp` 改为本次运行自己的目录。

### X9 的耗时（实测）

去掉行数上限后，一次 `-c` 查找最多要把候选 JSONL 读到第一个 `cwd` 为止。本机实测（darwin/arm64，Go 1.26.2，不带 `-race`，文件在页缓存里；方法和全部数字在 `evidence/x9-cwd-scan-timing.txt`，每项连续 5 次取最快 / 最慢）：

| 情况 | 最终实现 | 对照：每一行都做 JSON 解析（第一版，没有提交） |
|------|----------|-----------------------------------------------|
| 一份 50 MiB、`cwd` 在最后一行 | 28–39 ms（每行约 300 / 2000 / 20000 字节三种） | 242–301 ms |
| 一份 50 MiB、完全没有 `cwd` | 28–40 ms | 484–601 ms（同一份文件被目录扫描和回退扫描各读一遍） |
| 一个目录 200 份历史（各 1 MiB），最新 199 份属于别的目录、`cwd` 在第 1 行 | 15–24 ms | 15 ms |
| 同上，但那 199 份的 `cwd` 都在最后一行，或完全没有 `cwd`（要读完 199 MiB） | 154–164 ms | 1.08 s |

- 第一版里有到秒级的数字（最后一行，1.08 s）。瓶颈是逐行 JSON 解析（约 200 MiB/s）。最终实现加了两处只为耗时、不改变结果的处理：一行里既没有 `"cwd"` 字样、也没有 `\u` 转义的，不可能有这个键，不解析；回退扫描跳过该目录自己的项目目录（里面的文件刚刚都看过）。之后没有到秒级的数字。
- **没有设任何界限**（行数、字节数、文件数都没有），也没有加缓存。依据：最坏的合成情况是 0.15 s 左右；一行里含 `"cwd"` 字样或 `\u` 转义却没有顶层 `cwd` 的记录仍会被解析，整份文件全是这种行时退回每行解析的速度（50 MiB 约 0.25–0.3 s，只读一遍）。
- 没有测的：冷盘读取（没有清页缓存的权限；50 MiB 在 SSD 上的顺序读一般是几十毫秒）、远程 Linux 上的机械盘或网络盘。真实 claude 的 JSONL 里用户 / 助手记录都带 `cwd`，通常前几行就能读到，上面的 50 MiB / 199 MiB 是为量上限造的。

### X10 改了哪些文件的哪些函数

改动集中在两处产品文件（其上还叠着另一个需求的分支，合并时只需看这些位置）：

| 文件 | 位置 | 改动 |
|------|------|------|
| `desktop/src/renderer/index.ts` | `focusView` | 对话会话由 `view.composer.focus()` 改为 `view.focus()`（1 行）+ 注释 |
| 同上 | 新函数 `focusAfterRename`（紧跟 `focusView`） | 改名结束后把键盘交回当前会话：焦点已在别处、或有对话框（`.modal-overlay`）开着时不动 |
| 同上 | `startInlineRename` 里的 `commit`（`finally` 末尾）和 `cancel`（末尾） | 各加一行 `focusAfterRename()` |
| 同上 | `openChatSession` 里设置回调的那一组 | 加 `view.onFocusRequest = () => { if (view.key === activeKey) focusView(view); }` |
| `desktop/src/renderer/chat/view.ts` | 新的可选回调 `onFocusRequest`、新方法 `focus()`、私有方法 `requestFocus()` | `focus()`：有待答卡片给卡片，否则给输入框；`requestFocus()`：有回调交给回调，没有就自己 `focus()` |
| 同上 | `renderPrompt` | 新卡片出现时由直接 `card.el.focus()` 改为 `requestFocus()`；卡片消失时若键盘在卡片上，`requestFocus()`（交给输入框） |

`setActive`、`selectOpenSession`、`renderSidebar`、`composer.ts`、`prompts.ts` 没有改。比裁决多做的两处（都在上表 `renderPrompt` 一行，decisions #53）：新卡片不再无条件抢焦点（改名进行中不抢），卡片消失后把键盘交给输入框（否则按 1 回答完，焦点同样停在 `BODY`，变异核对在真实应用里看到了）。

### 对外行为的变化（第 2 轮返工）

- `-c`：该目录有对话就续上，不论它的 JSONL 开头有多少不带 `cwd` 的记录；记录的目录和所选目录按「是不是同一个目录」比较（解析符号链接）。整份 JSONL 都读不到 `cwd` 的仍不认领。
- 侧边栏改名结束（回车 / Esc / 点别处提交）后，键盘回到当前会话（对话输入框、待答卡片或终端），除非你已经点进了别的输入框或对话框。
- 从侧边栏打开一个有待答卡片的对话会话，键盘在卡片上：1 / 2 / 3、Esc 可以直接按；回答之后键盘到输入框。
- 协议、配置、数据格式：没有变化。

### 对外行为的变化（第 1 轮返工）

- 对话区：发出消息（或点重试）后视图回到底部；不贴底时新内容照样生成在下方，滚到底就能看到；后台会话切回时，离开时贴底的回到底部。
- 侧边栏：点击当前会话的名字不再重建侧边栏，只把键盘交还给它；改名进行中，会话视图不抢焦点。
- R16.3：当前对话会话在窗口失焦时收到待答请求，侧边栏该会话显示黄点，窗口重新聚焦后清掉。
- `-c`：只续上记录在该目录里的对话；JSONL 里读不到 `cwd` 的记录不认领（开新对话）。
- 删除对话会话的确认文案（中英文）。
- 协议：没有字段增减，协议版本仍是 3。daemon 行为上的一处变化：流式尾巴截断时保留并补发 `message_start`（protocol.md 已写）。

## 场景对照

层级：Go = `go test -race`；TS = `desktop/scripts/test-*.mjs`；冒烟 = ws-chat-smoke；浏览器 = gui-chat-smoke（除非注明 gui-smoke）。表里出现的 Go 测试名已对照本轮 `go test -v` 输出确认存在且 `--- PASS`；TS 用例名对照了本轮 make check 的输出。标 **（返工）** 的是关口 C 第 1 轮返工新增或改动的，标 **（返工 2）** 的是第 2 轮返工新增的。

证据列说明：`X10-prompt.png`、`X10-rename-chat.png`、`X10-rename-terminal.png` 是本轮（2026-11-20，f03e9d9）新增的截图；`X7-send.png`、`X7-background.png`、`X8-chat.png`、`X8-terminal.png` 是第 1 轮返工（2026-11-20，5ce6f55）的；`R1.3.png`、`R1.4.png`、`R17.2-picker.png`、`R10.png`、`picker-layout.png`、`slash-layout-*.png` 是 2026-11-20 上午（6d88e45）的；其余是 2026-11-14（a56684f）的。本轮所有对应用例都重新运行并通过，旧截图没有替换。`evidence/verdict-c1/` 下 8 张是关口 C 第 1 轮界面验证者拍下的修复前画面。

| 场景 | 测试 | 层级 | 结果 | 证据 |
|------|------|------|------|------|
| R1.1 默认新建终端会话 | TestAttachWithoutUIStaysTerminal；浏览器 R1.1 | Go + 浏览器 | 通过 | evidence/R1.1.png |
| R1.2 新建对话会话 | TestWSChatCreateReady；gui-smoke「chat session created via picker」；冒烟 chat: create | Go + 浏览器 + 冒烟 | 通过 | gui-smoke 输出 |
| R1.3 claude_cmd 不是 claude | TestInfoChatNotClaude、TestParseNotClaude；test-chat-availability；浏览器 R1.3 | Go + TS + 浏览器 | 通过 | evidence/R1.3.png |
| R1.4 claude / daemon 过旧 | TestInfoChatTooOld、TestParseVersion；test-chat-availability；浏览器 R1.4（1.0.51）、R17.2（协议 2） | Go + TS + 浏览器 | 通过 | evidence/R1.4.png、R17.2-picker.png |
| R1（#39）新建对话框在小窗口里可用 | gui-smoke「dir picker fits a 500/700/803px-high window」「dir picker with chat chosen fits …」；浏览器「new-session dialog: buttons reachable in 500/700/803px-high windows」；test-picker-layout | TS + 浏览器 | 通过 | evidence/picker-layout.png |
| R1.5 勾 -c 显示完整历史 | TestCreateContinueResumesLatest、TestSyncHistoryBeforeCutoff、TestHistoryFullStream；**（返工，X4）** TestLatestSessionChecksTranscriptCwd、TestContinueIgnoresOtherDirectorySharingProjectDir、TestTerminalContinueIgnoresOtherDirectorySharingProjectDir（`…/a-b` 与 `…/a/b` 共用 claude 项目目录时各自只续自己的对话）；**（返工 2，X9）** TestLatestSessionReadsUntilFirstCwd、TestLatestSessionComparesCanonicalCwd、TestContinueFindsLateOrAliasedCwd、TestTerminalContinueFindsLateOrAliasedCwd（`cwd` 在第 101 / 1001 行、记录的是符号链接别名时照样续上；对话新建和终端 continue 改写两个入口）；test-chat-window；浏览器 R1.5（3000 行 JSONL：首屏 300 条，9 次上滑到第一条，共 2000 条消息含工具块；argv 为 `--resume <最新>`、无 `-c`；新消息接在后面） | Go + TS + 浏览器 | 通过（真 claude 部分未做，见遗留） | evidence/R1.5.png、R1.5-top.png |
| R1.6 bypass 固定 | TestBypassLocksMode、TestBypassStillAsksQuestions；浏览器 R1.6 | Go + 浏览器 | 通过 | evidence/R1.6.png |
| R1.7 worktree + flag | TestChatWorktreeAndFlags | Go | 通过 | — |
| R2.1 ready 前重放 | TestChatCreateReplaySameID、TestChatCreateConcurrentSameID；冒烟 replay before ready | Go + 冒烟 | 通过 | — |
| R2.2 重载旧进程先退 | TestReloadWaitsForOldProcess、TestSingleProcessRestart、TestStopTimings | Go | 通过 | — |
| R2.3 交接对话先停 | TestHandoffStopsChatFirst | Go | 通过 | — |
| R2.4 两台桌面 | TestTwoClientsShareProcess；冒烟 two clients | Go + 冒烟 | 通过 | — |
| R2.5 daemon 重启 | TestLoadChatsMarksDaemonRestart、TestOrphanCleanup；冒烟 daemon restart；探索（上一轮：GUI 内重启 daemon → 「vibe-remoted 已重启」+ 重新启动） | Go + 冒烟 + 探索 | 通过 | evidence/explore-daemon-restart.png |
| R2.6 两个 -c 同一对话 | TestContinueReusesRunningSession、TestConcurrentContinueCreatesOneProcess | Go | 通过 | — |
| R3.1 发送与流式 | TestSendEchoAndStream；test-chat-session；gui-smoke「chat reply rendered」；**（返工，X7）** test-chat-window「…the window always reaches the newest…」、test-chat-view 3 个 X7 用例、浏览器 X7-send（真实滚轮上滑后输入并发送 → 消息和回复出现并回到底部；上滑时别处来的回复不拽动视图；滚到底直接看到）、X7-background（后台收到 40 条后切回 → 贴底可见，随即发送的消息出现；离开时不贴底 → 原位不动，最新消息已在下方） | Go + TS + 浏览器 | 通过 | evidence/X7-send.png、X7-background.png |
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
| R5.6 回答送达前断线 | test-chat-session submitting reverts；浏览器 R5.6（丢弃出站帧后点允许 → 「提交中」→ 断开 → 重连后恢复为未回答 → **（返工）此时工具块还没有结果、claude 没有继续、另一端没有看到回答或工具结果** → 再答 → 工具执行） | TS + 浏览器 | 通过 | evidence/R5.6.png |
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
| R12.4 流式中途断线 | TestResyncMidStreamTail；test-chat-session preview merged；**（返工，X3）** TestTailOverflowKeepsMessageStart（超过 20000 条 / 8 MiB 的回复：reset 与增量同步的补发帧里 `message_start` 始终在、只有 1 个，`message_stop` 后清空）、test-chat-session 两个 X3 用例（验证者的帧序列 → 1 条完整回复；无 id 预览并入已有消息；被中断的预览不被下一条回复吞掉） | Go + TS | 通过 | — |
| R13.1 回合出错重试 | test-chat-session turn error；浏览器 R13.1（错误内容 + 重试 → 重发上一条，再次出错卡片） | TS + 浏览器 | 通过 | evidence/R13.1.png |
| R13.2 进程退出 | TestCrashEmitsExitAndEnded、TestCrashEmitsExitAndEndedWS；浏览器 R13.2（「会话已结束：claude 进程退出（代码 1）」+ stderr 尾巴，重新启动 / 新建终端会话接上；重新启动后可续聊） | Go + 浏览器 | 通过 | evidence/R13.2.png |
| R13.3 只有真退出才发 exit | TestChatDisconnectKeepsProcess | Go | 通过 | — |
| R13.4 启动后版本不支持 | TestInitVersionTooOldEnds；浏览器 R13.4（init 报 1.0.0 → 「claude 版本过旧（1.0.0），对话界面需要 2.1.210 或更新」+ 重新检测 + 交接；3 s 内无新连接、无重连横幅） | Go + 浏览器 | 通过 | evidence/R13.4.png |
| R14.1 交接 | TestHandoffCreatesTerminalWithResume、TestHandedOffTerminalReloadUsesResume；冒烟 handoff | Go + 冒烟 | 通过 | evidence/R14.2.png |
| R14.2 回合进行中交接 | TestHandoffInterruptsRunningTurn；浏览器 R14.2（运行中点交接 → 确认框「Claude 正在回复，交给终端会中断当前回合。继续吗？」→ 终端显示 `fake-claude interactive resume=<id>`；对话会话 handed_off、输入框禁用） | Go + 浏览器 | 通过 | evidence/R14.2.png、R14.2-chat.png |
| R15.1 重命名 | TestChatRenamePersists；**（返工，X8）** test-sidebar-rename（已打开的对话 / 终端会话，当前与后台，两种点击节奏；Esc、失焦；标签不在文档里时不冻结）、浏览器 X8-chat（真实双击：当前会话改名、后台会话改名并切过去；名字没有进对话、另一端没有收到消息；之后侧边栏的点和切换照常）、X8-terminal（当前 ×3、后台 ×2，shell 里没有被输入名字）；**（返工 2，X10）** test-sidebar-rename 的 4 个改名用例、浏览器 X10-rename-chat / X10-rename-terminal（改名回车 / Esc / 点另一个会话之后不点击直接打字，字进当前会话） | Go + TS + 浏览器 | 通过 | evidence/X8-chat.png、X8-terminal.png、X10-rename-chat.png、X10-rename-terminal.png |
| R15.2 删除 | TestChatDeleteKeepsJSONL；冒烟 delete keeps jsonl；**（返工）** test-sidebar-rename「delete confirmation…」（对话会话的确认文案写明记录保留在 claude 的 JSONL，终端会话的文案不变）；探索（2026-11-14：侧边栏删除 → 进程消失、JSONL 保留） | Go + TS + 冒烟 + 探索 | 通过 | — |
| R15.3 重载 | TestReloadChatReturns202、TestReloadRefusedWhenHandedOff；探索（上一轮：侧边栏重载 → 历史保留、续聊） | Go + 探索 | 通过 | — |
| R16.1 灰点 / R16.2 绿点 | test-chat-activity；探索（上一轮：后台会话收到流式输出为 output，回合结束变 idle） | TS + 探索 | 通过 | — |
| R16.3 等你处理（降级，d12） | test-chat-activity；浏览器 R16.3（应用隐藏、当前会话为另一个时收到权限请求：黄点、`[notify] fallback`、Dock 角标 `•`、当前会话不自动切换）；**（返工，X6）** test-chat-activity 两个用例 + 浏览器 X6（当前会话、应用隐藏且页面失焦时收到权限请求：该会话显示黄点并发通知，通知结果回来后黄点仍在，窗口重新聚焦后清掉）；**（返工 2，X10）** test-sidebar-rename「X10 opening a session whose prompt is waiting…」「X10 a prompt that arrives … while it is being renamed…」、test-chat-view 2 个 X10 用例、浏览器 X10-prompt（后台会话黄点 → 真实点击打开 → 不点卡片直接按 1 回合继续、按 Esc 请求中断 → 接着直接打字） | TS + 浏览器 | 通过（本轮 2 次运行窗口都重新获得了焦点，「聚焦后角标清除」断言到了：隐藏时角标 `•`，聚焦后为空） | evidence/R16.3-fallback.png |
| R16.3 等你处理（通知可用） | 浏览器 R16.3：点通知 = 主进程发 `notification-click`（模拟点击）→ 打开该会话、显示提示 | 浏览器（部分） | 部分通过：点击路径已验证；原生通知「显示」需签名构建，未做 | evidence/R16.3-click.png |
| R16.4 不需 hook | test-chat-activity REST；冒烟 state without hooks | TS + 冒烟 | 通过 | — |
| R17.1 原有回归 | make check、gui-smoke 原有用例。第 1 轮返工改动的已有断言共 2 条（见「关口 C 返工」一节），都不是终端会话的；第 2 轮返工没有改动已有断言；**（返工 2，X9）** 终端会话的 continue 改写由 TestTerminalContinueFindsLateOrAliasedCwd 守住；gui-smoke 的拖选用例加固了取坐标的方式，最后的断言没有变 | 全量 | 通过（gui-smoke 2 次运行各 30 项全过） | — |
| R17.2 新桌面连旧 daemon | test-chat-availability proto 2；浏览器 R17.2（main 分支构建的 daemon：对话卡片「协议 2…请升级 vibe-remoted」，旧 daemon 提示，终端会话可用） | TS + 浏览器 | 通过 | evidence/R17.2-picker.png、R17.2.png |
| R17.3 旧桌面连新 daemon | TestTerminalAttachToChatIsUIMismatch、TestTerminalFramesUnchangedV3 | Go | 通过（未用旧桌面实机打开） | — |
| R18.1 proto 3 | TestInfoAndReadyProto3 | Go | 通过 | — |
| R18.2 三处一致 | **（返工，X5）** `docs/protocol.md` 的 chat_ack 补上 `message`（和 `ok`）；`protocol.go` / `protocol.ts` / `rest.ts` 自 e869add 以来没有改动（`git diff` 为空），`Version = 3`、`PROTOCOL_VERSION = 3`、版本表第 3 行 | 检查 | 通过 | 下一节 |
| R19.1 CLAUDE.md | grep：「终端模式」「对话模式」「只支持 claude」均在 | 检查 | 通过 | — |

## /protocol-sync 核对（不变规则第 2 条）

下表是 2026-11-20 上午按 `.claude/skills/protocol-sync/SKILL.md` 的步骤对 `protocol.go`、`protocol.ts`、`rest.ts`、`docs/protocol.md`（及 `routes()`、错误码、ack 码）做的完整核对；关口 C 第 1 轮的 codex 验证者独立做了同样的核对，唯一的差异是 `chat_ack.message`（X5）。本轮：
- 第 2 轮返工没有动协议：`git diff 16fd611..HEAD -- vibe-remoted/internal/protocol desktop/src/shared desktop/src/renderer/rest.ts docs/protocol.md` 为空。以下两条是第 1 轮返工时的核对。
- `protocol.go`、`protocol.ts`、`rest.ts` 自 e869add 以来没有改动（`git diff e869add..HEAD -- vibe-remoted/internal/protocol desktop/src/shared/protocol.ts desktop/src/renderer/rest.ts` 为空），协议版本仍是 3。
- `docs/protocol.md` 改了两处：chat_ack 补上 `message`（写明随 `too_large`、`invalid_response`、回答非计划请求带 `setMode` 的 `invalid_mode` 给出）和 `ok`；同步序列第 3 步补一句流式尾巴上限的行为（超出时丢最旧的增量但保留 `message_start`，X3）。chat_ack 一节按步骤逐字段重新核对：`type` / `op`（4 个值）/ `ref?` / `ok` / `code?`（9 个码，与 `Ack*` 常量和 `internal/chat` 实际返回的一致）/ `message?` / `duplicate?` / `completed?`，三处一致。

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
| `chat_ack`：op、ref?、ok、code?、message?、duplicate?、completed? | 是 | 是 | 是（af47ac8 补上 `message` 和 `ok`） | 是 |
| `chat_send` / `chat_respond`（`ChatResponse`、setMode?）/ `chat_interrupt` / `chat_set_mode` | 是 | 是 | 是 | 是 |
| 开放集合：ack 码 9 个（与 `Ack*` 常量和 `internal/chat` 实际返回的一致）、`vr_resolved` 结果 5 个、`vr_notice` 码 4 个、`vr_exit`、`vr_client_msg_id`、`vr_stale`、`ended.reason` 6 个、`chat.reason` 6 个 + `workdir_untrusted`、`chatTrust` 3 个、`degraded` 的 `interrupt_receipt` | 是 | 是 | 是 | 是 |
| REST：8 个端点的方法和路径、`info` 的字段（含 `chat`、`?recheck=1`）、`fs` 的 `chatTrust` / `parent`、reload 的 204 / 202 / 409 `{error:"claude_session_busy", owner, message}`、delete 的 409 `worktree_preserved` | `routes()` + 各 handler | `rest.ts` | 端点表 | 是 |

结论：三处一致（帧、字段、可选性、开放集合、REST、版本号）。上一版报告记的 1 处文档遗漏已补。

## 交付预览

- 产物：本轮没有录制操作录屏。可看的是 `evidence/` 下的逐用例截图（由 gui-chat-smoke 在断言通过的位置截取），本轮新增 `X10-prompt.png`（从黄点点开后的权限卡片，第 1 个选项带焦点框，按键之前截的）、`X10-rename-chat.png`、`X10-rename-terminal.png`；第 1 轮返工的 `X7-*.png`、`X8-*.png` 和修复前的画面 `evidence/verdict-c1/`（8 张）保留。
- 来源：本轮截图 2026-11-20，本机（macOS，Electron 44.7.0），被测代码 f03e9d9。
- 覆盖范围：临时 daemon + 假 claude，不是真实服务。
- 核验：`X10-prompt.png` 看过，画面里没有 token；能看到本机 `/private/tmp/vr-gc-…` 下的临时目录名。

## 探索式检查

本轮（第 2 轮返工后）没有重新做人工探索；下面的检查范围和 X1、X2 是此前的记录，原样保留。关口 C 第 2 轮的界面验证者又用真实输入做了一遍手工验证和一段探索（结论在 verdict-history.md「关口 C 第 2 轮」），它的备注 3、4 即本轮的 X10，其余 5 条进了 tasks.md「后续」。关口 C 第 1 轮的界面验证者用真实指针 / 滚轮 / 按键事件做了一遍完整的手工验证（结论在 verdict-history.md），它拦下的 X7、X8 和提到的 X6 已修，其余备注进了 tasks.md「后续」。

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
| X7（关口 C 第 1 轮）不贴底时发消息不显示 | 6f9153f（`chat/window.ts`、`chat/view.ts`） | test-chat-window、test-chat-view ×3、浏览器 X7-send / X7-background | 本轮全过 |
| X8（关口 C 第 1 轮）已打开的会话双击改不了名 | 3feaf67（`index.ts`、`chat/view.ts`） | test-sidebar-rename ×8、浏览器 X8-chat / X8-terminal | 本轮全过 |
| X3（关口 C 第 1 轮）长回复重连后显示两次 | d67ae4e（`chat/session.go`、`chat/session.ts`） | TestTailOverflowKeepsMessageStart、test-chat-session X3 ×2 | 本轮全过 |
| X4（关口 C 第 1 轮）`-c` 接上别的目录的对话 | f3e0366（`chat/transcript.go`） | TestLatestSessionChecksTranscriptCwd、TestContinueIgnoresOtherDirectorySharingProjectDir、TestTerminalContinueIgnoresOtherDirectorySharingProjectDir | 本轮全过 |
| X6（关口 C 第 1 轮）当前会话窗口失焦时没有黄点 | 6580bcf（`chat/activity.ts`、`index.ts`） | test-chat-activity ×2（1 条已有断言改动）、浏览器 X6 | 本轮全过 |
| X5（关口 C 第 1 轮）protocol.md 漏 `chat_ack.message` | af47ac8（文档） | /protocol-sync 对 chat_ack 的核对 | 一致 |
| 删除对话会话的确认文案、`prompts.ts` 的原始 NUL 字节 | 9135f77 | test-sidebar-rename「delete confirmation…」、test-source-bytes | 本轮全过 |
| X9（关口 C 第 2 轮）`-c` 的 cwd 检查漏掉已有历史（X4 的修复引入） | 81024f1（`chat/transcript.go`；`.devflow.yml` 的 check、`CLAUDE.md` 一句） | TestLatestSessionReadsUntilFirstCwd、TestLatestSessionComparesCanonicalCwd、TestContinueFindsLateOrAliasedCwd、TestTerminalContinueFindsLateOrAliasedCwd | 本轮全过 |
| X10（关口 C 第 2 轮备注 3、4）改名之后、点开待答会话之后键盘焦点停在页面上 | f03e9d9（`index.ts`、`chat/view.ts`） | test-sidebar-rename ×6、test-chat-view ×2、浏览器 X10-prompt / X10-rename-chat / X10-rename-terminal | 本轮全过 |

a56684f 和 b88f4ae 各改 2–3 个产品文件，都没有接口变化，未超过再评审门槛（>5 个文件或改接口）。**b88f4ae 没有单独做过独立代码评审**（review.md 的范围到 9b42ff0 为止），由机器关口 C 的独立验证覆盖。

关口 C 两轮返工的每一项另见「关口 C 返工」一节。第 1 轮返工的 7 个提交已由关口 C 第 2 轮的两名验证者验过（结论见 verdict-history.md）；第 2 轮返工的 2 个修复提交（81024f1、f03e9d9）没有做独立代码评审，由机器关口 C 的下一轮独立验证覆盖。

## gui-smoke「drag-select under mouse reporting + ⌘C」

历史：review.md 记录 3 次里 1 次失败；c2799e6 上 27 次没有复现；6d88e45 上 2 次里 1 次失败（复制到的是目标行加它下面两行：目标文字对，选区多拖了提示符行和一个空行）；关口 C 第 1 轮界面验证者 5 次 + 1 次手工拖选都通过，判断是测试自身的时序（按下到松开之间屏幕上移），并用实验排除了「b88f4ae 的窗口高度模拟让终端建好后再变一次尺寸」。

第 1 轮返工时按它的建议加固了测试（793eb80）：原来用「屏幕上出现 `SELECT_ME_PLEASE`」作同步点，而敲进去的命令本身就含这串字，`clear; echo` 还没执行完就可能开始量坐标；现在等到「有一行正好是输出、下一行回到提示符、相隔 150 ms 两次看到的屏幕内容和该行位置都相同」，拖完再量一次，变了就重新量、重新拖并打印 NOTE。这只是让测试自己的坐标不过期：最后复制到的内容仍必须逐字等于 `SELECT_ME_PLEASE`，重量会留下 NOTE 行。产品代码（终端、xterm 配置、剪贴板）没有动。加固后 4 次运行都通过、没有触发重量；此前的失败本来就复现不出来，所以这不构成「已消除」的证明。

关口 C 第 2 轮：界面验证者 2 次运行都通过、没有触发重量；codex 指出一个覆盖边界——屏幕变化时可以重新量、重拖最多 2 次，第一次手势的结果不受最终断言约束（已补记进 tasks.md「后续」）。本轮（f03e9d9）脚本没有改，2 次运行都通过、没有触发重量。

## 未覆盖和遗留

未做（需真机 / 真 claude，不能在本机用假 claude 代替；与此前相同）：
- **R5.2 规则写进远程设置**：需要真 claude 2.1.210 收到 `updatedPermissions` 后写 `.claude/settings.local.json`；假 claude 只把规则记在 `$FAKE_CLAUDE_RULES`。
- **首字延迟（非功能，≤200 ms，只记录）**：需要局域网另一台远程机并消耗真实模型调用。
- **R1.5 真机部分**：真 claude 写出的 JSONL 历史（含工具块）的显示。X9 之后不再依赖 `cwd` 出现在开头多少行以内；仍然依赖「属于这个目录的 JSONL 里至少有一条记录带顶层的 `cwd`」（设计阶段的探针和假 claude 的记录里用户 / 助手消息都带），真 claude 其他版本的记录格式没有另外验证，也没有验证真 claude 会不会把 `cwd` 记成符号链接别名（X9 的别名用例用的是合成的 JSONL）；整份文件读不到 `cwd` 时的后果是不续接、开新对话。
- **X9 的耗时**：只在本机 SSD、页缓存命中的条件下测过（见「X9 的耗时」）；冷盘和远程 Linux 没有测。
- **R17 / V17 远程 Linux**：对话模式在远程 Linux（登录 shell、fnm 等）上启动 claude。
- **R16.3 原生通知显示**：未签名构建一律降级（`[notify] fallback`），「通知显示 → 点击」只能用主进程发 `notification-click` 模拟；本轮 2 次运行窗口都重新获得了焦点，「聚焦后角标清除」这次断言到了。
- **X3 的界面表现**：由 daemon 和 `ChatSession` 的单元测试覆盖；关口 C 第 2 轮的界面验证者在真实应用里用 23000 个增量的回复看过（只显示一次），本报告的脚本没有这条用例。
- **真实输入法**：新用例用 `Input.insertText`，没有经过输入法组字；改名输入框、卡片上的数字键在组字过程中的表现没有测。
- **X10 没有覆盖的组合**：计划卡片、提问卡片的键盘（1 / 2 / 3）只由 `ChatView.focus()` 的单元用例间接覆盖（三种卡片共用同一个根元素和按键处理），真实应用用例用的是权限卡片；从通知点击打开会话后的焦点没有单独的用例（走的是同一个 `setActive → focusView`）。

关口 C 第 2 轮 codex 提到的两点：
- **孤儿进程清理的两组测试**（`TestOrphanCleanup`、`TestLoadChatsMarksDaemonRestart`）在它的沙箱里因为不能执行 `ps` 没能验证。**在这里它们通过**：本机允许 `ps`，make check 里通过，另外单独带 `-v` 各跑了一次（输出见「汇总」：`TestOrphanCleanup` 的 5 个子用例含 `stubborn_needs_SIGKILL`、`survivor_keeps_the_claim` 都 PASS，`TestLoadChatsMarksDaemonRestart` PASS），不变规则第 4 条的命令里也包含 `TestOrphanCleanup`。远程 Linux 上的同一行为（V17）仍未做。
- **对话视图的 DOM 不回收**（X7 之后，新消息到达时窗口末端一直跟到最新，上滑阅读时也是：5000 条历史首屏 300 条 DOM，再来 1000 条变成 1300 条）：本轮没有改，也没有测长时间对话后的渲染耗时；首屏和重连后的 300 条上限仍成立（test-chat-view、R1.5 / R12.2 用例守着）。记在 tasks.md「后续」。

遗留：
- **第 2 轮返工的 2 个修复提交没有做独立代码评审**，由机器关口 C 的下一轮独立验证覆盖（decisions #50：c6 批准的 2 轮已用完，按 #42 再用 1 轮，范围只限这次返工的改动）。
- **c7 已处理**（decisions #51，按 #42）：`.devflow.yml` 里「同一 claude 会话 id 最多一个进程」那条不变规则的 check 加上了 X4 的 3 个和 X9 的 4 个回归测试（只增加用例名），原样运行通过；`CLAUDE.md` 讲终端会话 continue 改写的那一条末尾补了「该目录最近一次对话」如何按 JSONL 记录的工作目录核对。
- 关口 C 第 2 轮的其余备注都不拦，记在 tasks.md「后续」：上滑阅读时没有「下面有新内容」的提示、窗口一次变矮 ≥48px 后流式输出不再跟随、断线分隔线把流式增量也数成「消息」、超过尾巴上限后中途加入时预览不完整、指针停在当前会话那一行时看不到黄点、拖选用例重拖时第一次手势不受最终断言约束。
- X10 做的过程中看到、没有在这一轮改的两处（已记进「后续」）：对话框（新建会话、机器管理）开着时当前会话来了新的待答卡片，卡片会把键盘从对话框里拿走（既有行为；X10 只挡住了改名输入框这一种）；改名时点击另一个会话，daemon 在本机时这次点击会被随后的侧边栏重建吞掉（名字保存了、没有切换，键盘回到原来的当前会话）。
- 关口 C 第 1 轮界面验证者的其余 9 条备注（拒绝后的工具块标「失败」、已结束的对话会话在侧边栏没有标记、小窗口里长命令把权限按钮挤到折叠线以下、断线期间状态没有收起、重启后权限模式回到默认、计划 / 提问工具显示成原始 JSON 摘要、重建的历史里出错回合没有错误卡片、状态点只靠颜色区分、侧边栏每 5 秒重建会丢点击）仍在 tasks.md「后续」。
- X2：旧 daemon 提示在新建对话框里没有内边距（main 上就有，低）。
- gui-smoke 的终端 daemon 仍靠运行时传入 `TMUX_TMPDIR` 隔离（脚本自己没有设）。
- 浏览器用例里的断线、丢帧、扣帧由渲染进程内包装的 `WebSocket` 模拟，不是真的断网；「另一台桌面」是脚本里的 WebSocket 客户端。
- `.devflow.yml` 里的 `autonomy: L1` 没有随本需求的等级调整而改（不属于本步可改的范围）。

## 验收核对（第 7 节）

按 2026-11-20 第 2 轮返工后的状态重新核对。

| 方面 | 检查 | 结果 |
|------|------|------|
| 完整 | tasks.md 的 T1–T22 状态都是「完成」，没有「阻塞」；R1–R19 每个场景都有测试和结果，返工涉及的行标了「返工」「返工 2」；关口 C 两轮拦下的 6 个问题和 X6、X10、测试备注各有一行；未做项单列 | 通过（4 项真机未做 + 原生通知显示） |
| 正确 | make check 退出 0（Go 265 个顶层测试、TS 141 个用例）；ws-smoke 12/12、ws-chat-smoke 9/9；gui-smoke 30/30 ×2；gui-chat-smoke 37/37 ×2；R12.2 500 条 39 / 47 ms ≤ 2000 ms；最低版本 2.1.210、协议 3、各条界面文案按 spec 原文断言；每个返工问题的回归测试都见过「修复前失败、修复后通过」并做过变异核对 | 通过。最终代码之前有 1 次新用例自身的失败，已记录 |
| 一致 | 设计与实现的差异记在 design.md「变更」的两段返工记录；决定在 decisions.md #43–#53、c7；protocol.md 与两端代码一致（本轮没有动协议） | 通过 |
| 干净 | worktree `git status --short` 为空；本轮改动的产品代码里没有新增 `console.*` / `debugger`（`git diff 16fd611..HEAD -- desktop/src vibe-remoted/internal/chat/transcript.go` 核对）；变异、探针和耗时测量用的临时测试都已还原或删除；本轮建的临时目录和进程已清理 | 通过 |
| 改全 | 协议、配置、数据格式没有变，`vibe-remoted.example.json`、`docs/protocol.md` 不用改；verify skill 的说明加了 3 个 X10 用例和 `VR_ONLY` 的写法；没有新增界面文案（i18n 247 个键不变）；`.devflow.yml` 不变规则第 4 条的 check 加了 X4、X9 的回归测试；`CLAUDE.md` 一条补充；升级步骤：无新增（X9 在 daemon 一侧，X10 在桌面端一侧，各自更新后生效）；invariants 10 条命令型全部 exit=0，第 2 条 /protocol-sync 一致 | 通过 |

spec「完成条件」逐条：

| 条件 | 状态 | 依据 |
|------|------|------|
| R1–R19 的全部场景用 verify skill 跑通 | 本机能做的全部通过；4 项需要真 claude / 远程 Linux 的和原生通知显示未做 | 场景对照表；ws-chat-smoke 9/9、gui-chat-smoke 37/37 ×2 |
| gui-smoke 新增的对话模式端到端用例通过 | 通过（2 次运行里 3 个对话用例都通过） | 「chat session created via picker」「chat reply rendered」「permission allow once resumes」 |
| `make check` 全绿 | 通过 | exit=0，Go 5 个包 ok，npm test 24 个脚本 |
| protocol-sync 检查三处一致 | 通过（本轮没有动协议文件） | /protocol-sync 一节 |
| 现有终端会话测试（`npm test`、`go test -race`、gui-smoke 原有用例）不改断言照样通过 | 通过。终端会话的断言没有改；两轮返工改动的已有断言共 2 条，都是对话模式的、都在第 1 轮；gui-smoke 脚本本轮没有改，2 次运行全过 | make check 输出；gui-smoke ×2；测试文件的删除行核对 |
