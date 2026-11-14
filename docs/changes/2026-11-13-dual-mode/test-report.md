# 测试报告：双模式会话（终端 + 对话）

日期：2026-11-14　分支：change/dual-mode　提交：c2799e6（测试与证据）；修复 a56684f

> 浏览器测试：已用本机构建产物 + CDP 完成（项目自己的 harness：`gui-smoke.mjs` 同款启动方式，临时 daemon、临时 userData、`--use-mock-keychain`；不用 Playwright，`.devflow.yml` 的 `cloud_browser: forbidden`）。
> 测试环境：e2e_env = local。独立验证（第 8 节、机器关口 C）不在本轮范围，结论见之后的 verdict.md。
> **未做**：需要真 claude / 远程 Linux 的 4 项（R5.2 规则落盘、首字延迟、R1.5 真机那一半、V17 远程 Linux），以及原生通知显示（未签名构建只能走 Dock 降级），原因见「未覆盖和遗留」。

## 汇总

| 类别 | 通过 | 失败 | 跳过 | 合计 |
|------|------|------|------|------|
| 单元 + 集成（Go，`go test -race ./...`，make check 内） | 257 个顶层测试（170 个子测试），5 个包 | 0 | 0 | 257 |
| 单元（TS，`npm test`，make check 内） | 116 个用例，20 个脚本 + preserved-notice 检查 | 0 | 0 | 116 |
| 协议冒烟（终端 `ws-smoke.mjs`） | 12 | 0 | 0 | 12 |
| 协议冒烟（对话 `ws-chat-smoke.mjs`） | 9 | 0 | 0 | 9 |
| 浏览器（`gui-smoke.mjs`，原有终端用例 + T13 的 3 个对话用例） | 24 | 0 | 0 | 24 |
| 浏览器（`gui-chat-smoke.mjs`，本轮新增） | 27（25 个场景用例 + 启动 + 无渲染异常） | 0 | 0 | 27 |

运行命令和结果（HEAD c2799e6，依次运行，互不并发）：

```
$ make check
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	20.621s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/config	3.376s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/protocol	2.670s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	20.240s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	24.879s
…（desktop typecheck；20 个 test 脚本）
ok - test-chat-view: terminal-only notice: closed when the session ends, relabelled on a locale switch (X1)
…
test-chat-activity checks passed (6)
exit=0

$ VR_TOKEN=… node .claude/skills/verify/scripts/ws-smoke.mjs 127.0.0.1:$PORT /tmp   # 临时 /bin/bash daemon，独立 TMUX_TMPDIR
PASS /healthz … PASS deleted 1794631543327-9e680e3e
all checks passed

$ node .claude/skills/verify/scripts/ws-chat-smoke.mjs
PASS chat: create / replay before ready / two clients / pending survives reconnect / resync 50 /
     handoff / daemon restart → ended / state without hooks / delete keeps jsonl
all chat checks passed

$ node .claude/skills/verify/scripts/gui-smoke.mjs
… 24 × PASS（含 drag-select under mouse reporting + ⌘C copies the text）
NOTE notification outcome in this build: fallback
all GUI checks passed

$ DEVFLOW_EVIDENCE_DIR=docs/changes/2026-11-13-dual-mode/evidence node .claude/skills/verify/scripts/gui-chat-smoke.mjs --no-build
PASS 5 daemons up (gui-term gui-main gui-chat gui-old-claude gui-old-init)
PASS R1.3 … PASS R13.4 …（27 × PASS）
PASS R12/R12.2 … divider "已补回断线期间 504 条消息"; ready → rendered 54 ms
all GUI chat checks passed
```

稳定性：`gui-chat-smoke.mjs` 修好自身两处测试写法问题（见「修复记录」末两行）后连续 5 次全过，加上最终带证据的 1 次共 6 次。R12.2 各次实测 39–54 ms。

## 场景对照

层级：Go = `go test -race`；TS = `desktop/scripts/test-*.mjs`；冒烟 = ws-chat-smoke；浏览器 = gui-chat-smoke（除非注明 gui-smoke）。所有 Go 测试名已对照 `go test -v` 输出逐个确认存在且通过。

| 场景 | 测试 | 层级 | 结果 | 证据 |
|------|------|------|------|------|
| R1.1 默认新建终端会话 | TestAttachWithoutUIStaysTerminal；浏览器 R1.1 | Go + 浏览器 | 通过 | evidence/R1.1.png |
| R1.2 新建对话会话 | TestWSChatCreateReady；gui-smoke「chat session created via picker」；冒烟 chat: create | Go + 浏览器 + 冒烟 | 通过 | gui-smoke 输出 |
| R1.3 claude_cmd 不是 claude | TestInfoChatNotClaude、TestParseNotClaude；test-chat-availability；浏览器 R1.3 | Go + TS + 浏览器 | 通过 | evidence/R1.3.png |
| R1.4 claude / daemon 过旧 | TestInfoChatTooOld、TestParseVersion；test-chat-availability；浏览器 R1.4（1.0.51）、R17.2（协议 2） | Go + TS + 浏览器 | 通过 | evidence/R1.4.png、R17.2-picker.png |
| R1.5 勾 -c 显示完整历史 | TestCreateContinueResumesLatest、TestSyncHistoryBeforeCutoff、TestHistoryFullStream；test-chat-window；浏览器 R1.5（3000 行 JSONL：首屏 300 条，9 次上滑到第一条，共 2000 条消息含工具块；argv 为 `--resume <最新>`、无 `-c`；新消息接在后面） | Go + TS + 浏览器 | 通过（真 claude 部分未做，见遗留） | evidence/R1.5.png、R1.5-top.png |
| R1.6 bypass 固定 | TestBypassLocksMode、TestBypassStillAsksQuestions；浏览器 R1.6 | Go + 浏览器 | 通过 | evidence/R1.6.png |
| R1.7 worktree + flag | TestChatWorktreeAndFlags | Go | 通过 | — |
| R2.1 ready 前重放 | TestChatCreateReplaySameID、TestChatCreateConcurrentSameID；冒烟 replay before ready | Go + 冒烟 | 通过 | — |
| R2.2 重载旧进程先退 | TestReloadWaitsForOldProcess、TestSingleProcessRestart、TestStopTimings | Go | 通过 | — |
| R2.3 交接对话先停 | TestHandoffStopsChatFirst | Go | 通过 | — |
| R2.4 两台桌面 | TestTwoClientsShareProcess；冒烟 two clients | Go + 冒烟 | 通过 | — |
| R2.5 daemon 重启 | TestLoadChatsMarksDaemonRestart、TestOrphanCleanup；冒烟 daemon restart；探索（GUI 内重启 daemon → 「vibe-remoted 已重启」+ 重新启动） | Go + 冒烟 + 探索 | 通过 | evidence/explore-daemon-restart.png |
| R2.6 两个 -c 同一对话 | TestContinueReusesRunningSession、TestConcurrentContinueCreatesOneProcess | Go | 通过 | — |
| R3.1 发送与流式 | TestSendEchoAndStream；test-chat-session；gui-smoke「chat reply rendered」 | Go + TS + 浏览器 | 通过 | — |
| R3.2 Markdown | test-chat-markdown gfm；浏览器 R3.2（h1/列表/表格/行内代码/等宽代码块 SF Mono，复制按钮写入剪贴板 `fmt.Println("hi")`） | TS + 浏览器 | 通过 | evidence/R3.2.png |
| R3.3 原始 HTML / 脚本 / 链接 | test-chat-markdown、test-chat-render-guard；浏览器 R3.3（无 script/img/onerror，原文以文本显示；`javascript:` 不生成链接；点 https 链接 → 主进程 open-external 收到 `https://example.com`（已 stub，不真开浏览器），窗口 URL 不变，无对话框） | TS + 浏览器 | 通过 | evidence/R3.3.png |
| R3.4 空输入 | TestSendRejectsEmpty；test-chat-queue；探索（空白 + 回车不发送，连按两次回车只发一条） | Go + TS + 探索 | 通过 | — |
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
| R10.1 斜杠列表 | TestSlashCommandsPrecedence；test-chat-session；浏览器 R10（`/` 列出 compact/review/fake-skill，`/re` 过滤，回车填入 `/review `） | Go + TS + 浏览器 | 通过 | evidence/R10.png |
| R10.2 终端专用命令 | test-chat-queue terminal-only；test-chat-view X1；浏览器 R10（`/theme` 不发送，提示 + 「新建终端会话接上」） | TS + 浏览器 | 通过 | evidence/R10-terminal-only.png |
| R11.1 切换模式 | TestSetModeUpdatesState；浏览器 R11（Shift+Tab default→acceptEdits→plan→default；菜单选 acceptEdits 后 Write 不再询问） | Go + 浏览器 | 通过 | evidence/R11.png |
| R11.2 bypass 只读 | TestBypassLocksMode；浏览器 R1.6（菜单只有 bypass、禁用、附原因） | Go + 浏览器 | 通过 | evidence/R1.6.png |
| R12.1 断线期间继续 | TestChatDisconnectKeepsProcess | Go | 通过 | — |
| R12.2 补发 50 / 500 条 | TestResyncIncremental50；冒烟 resync 50；浏览器 R12（离线期间另一端发 `burst 500`，重连后分隔线「已补回断线期间 504 条消息」，burst 1…500 按序无重复） | Go + 冒烟 + 浏览器 | 通过 | evidence/R12.png |
| R12.2 非功能：500 条渲染 ≤2 s | 浏览器 R12 计时：从重连 `ready` 到出现新分隔线且最后一条 `burst 500` 已渲染 | 浏览器（计时） | 通过：54 ms（各次 39–54 ms） | evidence/R12.png |
| R12.3 超出缓冲 | TestRingOverflowReset；test-chat-session omitted marker | Go + TS | 通过 | — |
| R12.4 流式中途断线 | TestResyncMidStreamTail；test-chat-session preview merged | Go + TS | 通过 | — |
| R13.1 回合出错重试 | test-chat-session turn error；浏览器 R13.1（错误内容 + 重试 → 重发上一条，再次出错卡片） | TS + 浏览器 | 通过 | evidence/R13.1.png |
| R13.2 进程退出 | TestCrashEmitsExitAndEnded(+WS)；浏览器 R13.2（「会话已结束：claude 进程退出（代码 1）」+ stderr 尾巴，重新启动 / 新建终端会话接上；重新启动后可续聊） | Go + 浏览器 | 通过 | evidence/R13.2.png |
| R13.3 只有真退出才发 exit | TestChatDisconnectKeepsProcess | Go | 通过 | — |
| R13.4 启动后版本不支持 | TestInitVersionTooOldEnds；浏览器 R13.4（init 报 1.0.0 → 「claude 版本过旧（1.0.0），需要 2.1.210」+ 重新检测 + 交接；3 s 内无新连接、无重连横幅） | Go + 浏览器 | 通过 | evidence/R13.4.png |
| R14.1 交接 | TestHandoffCreatesTerminalWithResume、TestHandedOffTerminalReloadUsesResume；冒烟 handoff | Go + 冒烟 | 通过 | evidence/R14.2.png |
| R14.2 回合进行中交接 | TestHandoffInterruptsRunningTurn；浏览器 R14.2（运行中点交接 → 确认框「…会中断当前回合」→ 终端显示 `fake-claude interactive resume=<id>`；对话会话 handed_off、输入框禁用） | Go + 浏览器 | 通过 | evidence/R14.2.png、R14.2-chat.png |
| R15.1 重命名 | TestChatRenamePersists；探索（双击改名含 `<i>`、emoji，REST 与 chat-sessions.json 一致） | Go + 探索 | 通过 | — |
| R15.2 删除 | TestChatDeleteKeepsJSONL；冒烟 delete keeps jsonl；探索（侧边栏删除 → 进程消失、JSONL 保留） | Go + 冒烟 + 探索 | 通过 | — |
| R15.3 重载 | TestReloadChatReturns202、TestReloadRefusedWhenHandedOff；探索（侧边栏重载 → 历史保留、续聊） | Go + 探索 | 通过 | — |
| R16.1 灰点 / R16.2 绿点 | test-chat-activity；探索（后台会话收到流式输出为 output，回合结束变 idle） | TS + 探索 | 通过 | — |
| R16.3 等你处理（降级，d12） | test-chat-activity；浏览器 R16.3（应用隐藏、当前会话为另一个时收到权限请求：黄点、`[notify] fallback`、Dock 角标 `•`、当前会话不自动切换；窗口真正获得焦点后角标清除） | TS + 浏览器 | 通过 | evidence/R16.3-fallback.png |
| R16.3 等你处理（通知可用） | 浏览器 R16.3：点通知 = 主进程发 `notification-click`（模拟点击）→ 打开该会话、显示提示 | 浏览器（部分） | 部分通过：点击路径已验证；原生通知「显示」需签名构建，未做 | evidence/R16.3-click.png |
| R16.4 不需 hook | test-chat-activity REST；冒烟 state without hooks | TS + 冒烟 | 通过 | — |
| R17.1 原有回归 | make check、gui-smoke 原有用例（断言未改） | 全量 | 通过 | — |
| R17.2 新桌面连旧 daemon | test-chat-availability proto 2；浏览器 R17.2（main 分支构建的 daemon：对话卡片「协议 2…请升级 vibe-remoted」，旧 daemon 提示，终端会话可用） | TS + 浏览器 | 通过 | evidence/R17.2-picker.png、R17.2.png |
| R17.3 旧桌面连新 daemon | TestTerminalAttachToChatIsUIMismatch、TestTerminalFramesUnchangedV3 | Go | 通过（未用旧桌面实机打开） | — |
| R18.1 proto 3 | TestInfoAndReadyProto3 | Go | 通过 | — |
| R18.2 三处一致 | protocol.go `Version = 3`、protocol.ts `PROTOCOL_VERSION = 3`、protocol.md 版本表第 3 行；T13 的 /protocol-sync | 检查 | 通过 | — |
| R19.1 CLAUDE.md | grep：「终端模式」「对话模式」「只支持 claude」均在 | 检查 | 通过 | — |

## 探索式检查

检查的界面（桌面视口 1512×868，另在 820×600 下看了对话界面与新建对话框；zh 与 en 两种语言）：新建会话对话框「界面」一节（5 台机器各自的可用性与原因）、对话界面（发送 / 流式 / 工具块 / diff / Markdown / 链接）、权限 / 计划 / 提问卡片、中断 / 排队 / 斜杠 / 模式切换、断线与补发分隔线、结束状态与交接、侧边栏圆点与通知降级、对话会话改名 / 删除 / 重载、GUI 内重启 daemon（daemon_restart → 重新启动）、终端会话（新建、输入、窗口缩放后 `stty size` 从 32×62 变 46×119、复制粘贴由 gui-smoke 覆盖）。输入了 `<b>`、`<script>`、emoji、引号：用户气泡与回复都按纯文本显示。控制台无未捕获异常。

| 编号 | 程度 | 问题 | 处理 |
|------|------|------|------|
| X1 | 低 | 回合进行中输入 `/theme` 后交接：对话会话已结束，但「/theme 只能在终端界面使用 [新建终端会话接上]」提示仍挂在结束横幅下；切换语言后它仍是旧语言。复现：对话会话运行 `slow 300 100` → 输入 `/theme` 回车 → 点提示里的「新建终端会话接上」并确认 → 回到对话会话 → 点 EN。截图 evidence/X1-before.png | 已修复 a56684f，回归测试 test-chat-view「terminal-only notice: closed when the session ends, relabelled on a locale switch (X1)」（先失败后通过） |

看过但不算问题（记录以免重复排查）：
- 新建对话框打开时「终端」卡片同时带选中边框和焦点环（同色）。只有脚本用 `.click()` 选「对话」而焦点留在「终端」时才会出现两张卡片都描边；鼠标点击或键盘选择时焦点随选中项移动。沿用原有 `.modal-mode-card` 样式。
- 交接后终端会话与对话会话同名（都取目录名 `main`），侧边栏靠图标和「对话」徽标区分。符合「默认名跟随 workdir」。
- 重载 / 重启后假 claude 的 `burst`、回合错误不在 JSONL 里，所以重建的历史里没有它们；真 claude 的 assistant 消息都会写 JSONL，`result` 本来就不写。属于假 claude 的保真度，不是产品问题。

## 修复记录

| 问题 | 提交 | 回归测试 | 复测 |
|------|------|----------|------|
| X1 终端专用命令提示在会话结束后残留、不随语言切换 | a56684f（`composer.ts`、`view.ts`） | test-chat-view X1 | npm test 全过；gui-chat-smoke 全过 |
| （测试自身）gui-chat-smoke R16.3 之后窗口未真正回到前台时 rAF 暂停，提示卡片未及时移除，`sendChat` 的回车落在别的元素上（曾把语言切成 EN），R13.2 / R14.2 偶发失败（4/6） | c2799e6 前已改进脚本：恢复窗口时 `app.focus({steal:true})` 并等一帧 rAF；`sendChat` 先确认输入框真的拿到焦点 | 修后连续 6 次全过 | — |
| （测试自身）R16.3 角标清除只在窗口确实获得焦点时断言（macOS 不保证后台启动的应用能被拉到前台） | 同上 | 3 次获得焦点的运行中角标都清除 | — |

修复只涉及 2 个产品文件、无接口变化，未超过再评审门槛（>5 个文件或改接口）。

## gui-smoke「drag-select under mouse reporting + ⌘C」偶发失败的定性

review.md 备注：3 次中 1 次失败（多复制了空行）。本轮未改该测试，共运行 24 次：

| 条件 | 次数 | 该用例失败 | 其他失败 |
|------|------|------------|----------|
| 正常（对话 daemon 照常在，gui-smoke 始终启动它） | 10 | 0 | 0 |
| 10 核全部 `yes` 压满 CPU | 8 | 0 | 0 |
| 同时跑 `go test -race ./...`（3 轮） | 6 | 0 | 2 次运行各 2 项：「exactly one session created — got 5 / got 8」「waiting event … null」 |
| 加上本轮其余 gui-smoke 运行 | 3 | 0 | 0 |

结论：没有复现（0/27），对话 daemon 每次都在，看不出与它相关；对话代码不碰终端渲染与剪贴板。
假设（按可能性）：
1. **测试环境被外部干扰**：gui-smoke 的终端 daemon 用的是开发者共享的 `tmux -L vibe-remote`（没有独立 `TMUX_TMPDIR`），剪贴板也是真实系统剪贴板。同时跑 Go 测试时已实测到串扰（daemon reconcile 把 Go 测试的 tmux 会话当成自己的，「got 5 / got 8」）；评审时若有并行的测试或其他程序写剪贴板 / 在同一 tmux server 上建会话，就会影响选区或复制结果。
2. **时序**：`clear; echo SELECT_ME_PLEASE` 之后定位行与拖选之间若 tmux 再次重绘（鼠标模式刚打开），行位置变化会让拖选跨行。CPU 压满下也未出现，可能性较低。
建议（不在本轮改，记后续）：gui-smoke 的终端 daemon 改用独立 `TMUX_TMPDIR`（gui-chat-smoke 已这样做），并在失败时打印复制到的原文，以便下次能定位。

## 未覆盖和遗留

未做（需真机 / 真 claude，不能在本机用假 claude 代替）：
- **R5.2 规则写进远程设置**：需要真 claude 2.1.210 收到 `updatedPermissions` 后写 `.claude/settings.local.json`；假 claude 只把规则记在 `$FAKE_CLAUDE_RULES`（Go 测试已证明 daemon 原样转发、自己不写文件）。
- **首字延迟（非功能，≤200 ms，只记录）**：需要局域网另一台远程机，对话模式与终端里的 claude 各测 5 次取中位数，并消耗真实模型调用。
- **R1.5 真机部分**：真 claude 写出的 JSONL 历史（含工具块）的显示。本机用 3000 行合成 JSONL 验证了加载、窗口和工具块。
- **R17 / V17 远程 Linux**：对话模式在远程 Linux（登录 shell、fnm 等）上启动 claude；本机只有 macOS。
- **R16.3 原生通知显示**：未签名构建的原生通知必然失败并降级（`[notify] fallback`），「通知显示 → 点击」只能用主进程发 `notification-click` 模拟点击；打包后 DMG 的降级行为也未在 `release/` 里手工核对（verify skill 已写明这一点）。

遗留：
- gui-smoke 终端 daemon 共用 `tmux -L vibe-remote`（见上节），建议后续改为独立 `TMUX_TMPDIR`。
- 浏览器用例里的断线、丢帧、扣帧由渲染进程内包装的 `WebSocket` 模拟（`window.__vrNet`），不是真的断网；「另一台桌面」是脚本里的 WebSocket 客户端。

## 验收核对（第 7 节）

| 方面 | 检查 | 结果 |
|------|------|------|
| 完整 | T1–T13 状态均为「完成」，无阻塞；R1–R19 每个场景都有测试和结果（上表），未做项单列 | 通过（4 项真机未做 + 原生通知显示，原因见上） |
| 正确 | make check、ws-smoke、ws-chat-smoke、gui-smoke、gui-chat-smoke 全过；最低版本 2.1.210、协议 3、各条界面文案在浏览器用例里按 spec 原文断言（R1.3/R1.4/R13.4/R14.2 等）；R12.2 500 条 54 ms ≤ 2000 ms | 通过 |
| 一致 | 设计 4.12 列出的 data-testid 都存在（test-chat-view 逐个覆盖），浏览器用例用到其中大部分（未用：chat-omitted、chat-perm-always、chat-perm-deny/-text，对应场景由 Go/TS 覆盖）；dev-build 的偏差已在 decisions.md（#21–#35）；本轮新增的测试做法记在 decisions.md | 通过 |
| 干净 | 本轮提交后工作区只剩用户自己的 `vibe-remoted.local-tmux.json`（按要求不碰）；`.devflow-tmp/` 在 `.git/info/exclude`，未入库；chat/ 下无 `console.log` / `debugger` | 通过 |
| 改全 | `vibe-remoted.example.json` 已有 `"state_dir": ""`；`.devflow.yml` 无 `upgrade_doc`，design.md「变更」里没有单列升级步骤——升级就是替换远程 daemon 二进制（CLAUDE.md「远程 daemon 部署同步」已写，协议版本表有第 3 行）；invariants 的检查命令都在 make check 的 `go test -race ./...` / `npm test` 里通过，/protocol-sync 由 T13 运行、本轮复核版本号三处一致 | 通过（备注：升级步骤未单列成文档） |
