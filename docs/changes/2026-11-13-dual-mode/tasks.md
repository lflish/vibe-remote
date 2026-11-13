# 任务：双模式会话（终端 + 对话）

依据：spec.md、design.md　共 13 个任务　更新：2026-11-13（工程评审 15 条 + 复审 10 条 + 关口 B 意见 + 第二批前置验证已修订）

## 测试计划

层级说明：**Go** = `cd vibe-remoted && go test -race`（对话相关全部用 design 9.2 的假 claude）；**TS** = `desktop/scripts/test-*.mjs`（esbuild 打包 + `node:assert/strict`，进 `npm test`）；**协议冒烟** = `.claude/skills/verify/scripts/ws-chat-smoke.mjs`（临时 daemon + 假 claude，真实 WS/REST）；**浏览器** = CDP 驱动构建产物（gui-smoke 同款）；**真机** = 本机真 claude 2.1.210 手工/脚本核对。

| 场景 | 层级 | 测试名 | 要点 | 谁写 |
|------|------|--------|------|------|
| R1.1 | Go | TestAttachWithoutUIStaysTerminal | 不带 `ui` 的新建 → 终端 Runner，`ready` 无 `ui` 字段 | T6 |
| R1.1 | 浏览器 | R1.1 默认新建终端会话 | 对话框「界面」默认终端，新建后是 xterm | dev-test |
| R1.2 | Go | TestWSChatCreateReady | `ui:"chat"` 新建 → `ready.ui=chat`、`chat_sync reset`、`chat_state idle` | T6 |
| R1.2 | 浏览器 | chat session created via picker | 在第二台（假 claude）机器上经目录选择器选「对话」新建，侧边栏条目带 `data-ui=chat`，`chat-view` 可见、`chat-input` 可用 | T13 |
| R1.2 / R3.1 | 浏览器 | chat reply rendered | 发 `echo hi` → `chat-msg-user` 出现，随后 `chat-msg-assistant` 含 `hi` | T13 |
| R1.3 | Go | TestInfoChatNotClaude | `claude_cmd=/bin/bash` → `chat.supported=false, reason=not_claude` | T6 |
| R1.3 | TS | test-chat-availability: not_claude | 置灰并给出「对话界面只支持 claude」key | T11 |
| R1.3 | 浏览器 | R1.3 bash 机器对话卡片置灰 | `picker-ui-chat` disabled，`picker-ui-chat-reason` 文案正确 | dev-test |
| R1.4 | Go | TestInfoChatTooOld | `FAKE_CLAUDE_VERSION=1.0.51` → `reason=claude_too_old`，带两个版本号 | T6 |
| R1.4 | TS | test-chat-availability: old daemon / too old | `proto=2` 或无 `chat` 字段 → 「升级 vibe-remoted」；too_old → 「升级 claude」 | T11 |
| R1.4 | 浏览器 | R1.4 版本过旧时对话卡片置灰 | 说明升级对象 | dev-test |
| R1.5 | Go | TestCreateContinueResumesLatest | 目录有两份 JSONL → argv 含 `--resume <较新 uuid>`、不含 `-c` | T5 |
| R1.5 | Go | TestSyncHistoryBeforeCutoff | 同步先发 cutoff 前历史（`h:true`），再发缓冲，二者不重叠 | T4 |
| R1.5 | Go | TestHistoryFullStream | 3000 行 JSONL → `chat_sync.historyCount=3000`，3000 条 `h:true` 帧按原顺序全部到达（无省略），以 200 帧为一批写出 | T4 |
| R1.5 | TS | test-chat-window | 3000 条历史 → 初始窗口为最新 300 条；`expandUp` 每次多 200 条直到 0；贴底时新消息跟随、不贴底时窗口不动 | T9 |
| R1.5 | 浏览器 + 真机 | R1.5 勾 -c 显示完整历史 | 历史含工具块，新消息接在后面；3000 条历史时首屏只生成最新 300 条 DOM，上滑到顶可一直加载到第一条 | dev-test |
| R1.6 | Go | TestBypassLocksMode | 带 `--dangerously-skip-permissions` → `permissionLocked=true`、`permissionMode=bypassPermissions`，`chat_set_mode` ack `mode_locked`，Bash/Edit/Write 不发 can_use_tool | T3 |
| R1.6 / R7 | Go | TestBypassStillAsksQuestions | bypass 会话里 `ask` 与 `plan` 仍产生待答请求（`chat_state.pending` 含它，V18），回答后继续；同一会话的 `perm touch x` 不产生待答 | T3 |
| R1.6 / R7 | TS | test-chat-session: bypass still shows question cards | `permissionLocked:true` 时 AskUserQuestion / ExitPlanMode 待答照常生成提问/计划卡片状态，工具权限提示不出现 | T8 |
| R1.6 | 浏览器 | R1.6 bypass 固定 | 切换器只有 bypass | dev-test |
| R1.7 | Go | TestChatWorktreeAndFlags | worktree 模式 cwd = worktree 目录；argv 含勾选 flag 的 arg | T5 |
| R2.1 | Go | TestChatCreateReplaySameID | 同 `newSessionId` 第二次 attach（含创建中并发）→ 同一会话，pid 目录无 VIOLATION | T5 |
| R2.1 | 协议冒烟 | chat: replay before ready | ready 前断开重放 → 列表只有一个会话 | T13 |
| R2.2 | Go | TestReloadWaitsForOldProcess | reload 时旧 pid 退出后才出现新 pid；VIOLATION 不存在 | T5 |
| R2.3 | Go | TestHandoffStopsChatFirst | 交接后对话进程已退出，终端会话 argv 才写入 | T6 |
| R2.4 | Go | TestTwoClientsShareProcess | 两个 WS 各发一条 → 两边都收到两条回显、顺序一致，进程数 1 | T6 |
| R2.4 | 协议冒烟 | chat: two clients | 同上，经真实 daemon | T13 |
| R2.5 | Go | TestLoadChatsMarksDaemonRestart | store 中 running 记录加载后为 `ended/daemon_restart`，名字保留 | T5 |
| R2.5 | Go | TestOrphanCleanup | 记录的 pid 仍活且命令行含 claude 会话 id → 被结束并确认消失（`kill(pid,0)` 为 ESRCH）后才记 `daemon_restart`；`FAKE_CLAUDE_STUBBORN=1` 的孤儿：`$FAKE_CLAUDE_SIGNAL_LOG` 有 `SIGTERM ignored`、最终被 SIGKILL；命令行不含该 id 的进程不碰 | T4 |
| R2.5 | 协议冒烟 | chat: daemon restart → ended | 重启 daemon 后接入：`chat_state.ended.reason=daemon_restart`，历史来自 JSONL；reload 后可继续 | T13 |
| R2.6 | Go | TestContinueReusesRunningSession | 第二个 `-c` 新建 → `ready{sessionId=原会话, existing:true}`，进程数 1 | T5 |
| R2 | Go | TestConcurrentContinueCreatesOneProcess | 两个不同 `newSessionId` 的 `-c` 新建并发（`-race`）→ 只起一个进程；第二个得到 `existing:true` 或 `claude_session_busy`，无 VIOLATION | T5 |
| R2 | Go | TestRestartRefusedWhenUResumedElsewhere | X 已结束；Y 以 `-c` 接上 X 的 U 并在运行 → 重启 X 返回 `claude_session_busy`，Y 不受影响 | T5 |
| R2 | Go | TestReloadVsDeleteSerialized | 同一对话会话并发 reload 与 delete（`-race`）→ 最终会话不存在、无存活进程、`claudeOwners` 无残留 | T5 |
| R2 / R14 | Go | TestHandoffVsReloadOneWins | 并发交接与重载（`-race`，重复 20 次）→ 任何时刻该 U 的进程 ≤1、无 VIOLATION；终态 ∈ {对话会话 `handed_off` 且终端会话持有 U，对话会话重载后运行且交接返回 `claude_session_busy`}；重载 REST 一律 202，第二次重载不再起第二次重启 | T6 |
| R2 / d14 | Go | TestTerminalContinueClaimsLatest | 目录已有 JSONL U；终端会话以 continue 语义新建 → `claudeOwners[U]=终端会话 id`、tmux 选项 `@vibe_remote_claude_u=U`；随后对话 `-c` 新建 → `claude_session_busy`，message 含终端会话名，无第二个进程；重建 Manager 并 reconcile 后占用恢复；删除终端会话（或 kill 其 tmux 会话后 reconcile）→ 释放，对话 `-c` 成功；不带 continue 的终端会话不占用 | T5 |
| P1 / d11 | Go | TestTerminalContinueBusyWhenChatOwns | 同目录对话会话运行中，终端会话带 continue flag 新建 → `claude_session_busy`（fatal，消息含对话会话名），失败的新建不留下占用；没有对话会话时终端新建/重载的可见行为与 v2 相同（多出的 tmux 用户选项不影响 PTY 输出） | T5（Manager）、T6（attach 错误帧与 reload 409） |
| R14 | Go | TestHandedOffTerminalReloadUsesResume | 交接创建的终端会话重载 → respawn 命令含 `--resume U`（无 JSONL 时 `--session-id U`），不含 `-c`；删除该终端会话或其 tmux 会话消失后 U 被释放，原对话会话可重新启动 | T6 |
| R3.1 | Go | TestSendEchoAndStream | `chat_send` → 合成回显（带 `vr_client_msg_id`）→ stream_event → assistant → result，状态 running→idle | T3 |
| R3.1 | TS | test-chat-session: echo → stream → result | 用户消息立即出现，预览逐段增长，result 后 idle | T8 |
| R3.2 | TS | test-chat-markdown: gfm | 标题/列表/表格/行内代码/代码块渲染出对应标签 | T9 |
| R3.2 | 浏览器 | R3.2 Markdown 与复制按钮 | 代码块等宽，复制按钮写剪贴板 | dev-test |
| R3.3 | TS | test-chat-markdown: raw html escaped | `<script>`、`<img onerror>` 以文本出现；`javascript:` 链接不生成 href | T9 |
| R3.3 | TS | test-chat-render-guard | `chat/` 下除 `markdown.ts` 外无 `innerHTML`/`insertAdjacentHTML`/`outerHTML =` | T9 |
| R3.3 | 浏览器 | R3.3 回复含脚本与链接 | 无 alert、无 onerror 属性；点 https 链接走 `open-external`，窗口 URL 不变 | dev-test |
| R3.4 | Go | TestSendRejectsEmpty | 空白文本 ack `empty`，stdin 无写入 | T3 |
| R3.4 | TS | test-chat-queue: empty not sent | 空白输入不入队不发送 | T8 |
| R4.1–R4.4 | TS | test-chat-session: tool pairing | 多个 tool_result 在同一 user 消息里全部按 id 回填；`is_error` → 失败状态 | T8 |
| R4.3 | TS | test-chat-diff（移植 50 行用例） | Edit/Write/MultiEdit 行级 diff 正确 | T8 |
| R4.1–R4.4 | 浏览器 | R4 工具块 | Read/Grep 折叠可展开；Bash 显示命令与输出；Edit 有 `chat-diff`；失败为错误状态 | dev-test |
| R5.1 | Go | TestRespondAllowOnce | allow 后工具执行；同命令下次仍 can_use_tool | T3 |
| R5.1 | 浏览器 | permission allow once resumes | 发 `perm touch x` → `chat-perm` 出现 → 点 `chat-perm-allow` → 提示关闭、回复继续出现 | T13 |
| R5.2 | Go | TestRespondAlwaysWithSuggestion | allow+建议 → 假 claude 记规则，下次同命令不再询问；daemon 未写任何文件 | T3 |
| R5.2 | TS | test-chat-permission: describeSuggestion | addRules/localSettings → 「对 <目录> 里的 `npm test` 不再询问」与保存位置 key | T8 |
| R5.2 | 真机 | R5.2 规则写进远程设置 | 真 claude 下 `.claude/settings.local.json` 出现规则，再请求不弹 | dev-test |
| R5.2b | TS | test-chat-permission: no suggestions | 无建议 → 选项只有 allow/deny | T8 |
| R5.3 | Go | TestRespondDenyWithMessage | deny+message → 假 claude 回「denied: 先别改这个文件」，有 `vr_resolved denied` | T3 |
| R5.4 | Go | TestPendingWaitsWithoutClient | 无订阅者时请求在待答表保持 2 s，进程存活，无自动回答 | T3 |
| R5.5 / R6.4 | Go | TestResyncRestoresPending | 断开 → 期间来 can_use_tool → 重连 `chat_state.pending` 含它；回答后继续；另一例为 ExitPlanMode：`pending[0].request.input.plan` 与原计划全文逐字节相同，三种回答（批准自动接受/批准逐个确认/继续完善）各自都能在重连后提交成功 | T6 |
| R5.5 | 协议冒烟 | chat: pending survives reconnect | 同上 | T13 |
| R5.6 | TS | test-chat-session: submitting reverts | 提示「提交中」后收到 reset 同步且 pending 仍在 → 恢复为未回答 | T8 |
| R5.6 | 浏览器 | R5.6 回答送达前断线 | CDP 断网后点允许 → 重连后提示仍可答，答后继续 | dev-test |
| R5.7 | Go | TestRespondFirstWins | 同一 requestId 两次回答 → 第二次 ack `request_not_pending`，stdin 只有一条 control_response | T3 |
| R5.7 | Go | TestTwoClientsRespondRace | 两个 WS 并发回答 → 恰好一个 ok | T6 |
| R5.7 | 浏览器 | R5.7 已在别处处理 | 第二端显示「已在别处处理」 | dev-test |
| R5.8 | Go | TestCancelRequestResolves | 假 claude `cancel`（没有进行中的 interrupt）→ 待答表清空，`vr_resolved cancelled`；之后回答 ack `request_not_pending` | T3 |
| R5.8 | TS | test-chat-session: cancelled | 提示标「已取消」不可答 | T8 |
| R6.1 | Go | TestPlanApproveSetsMode | allow+`setMode:acceptEdits` → stdin 上 control_response 之后**紧接着**就是 set_permission_mode（中间不等任何输出）；最终 `chat_state.permissionMode=acceptEdits`，之后 `tool Write` 不询问 | T3 |
| R6.2 | Go | TestPlanApproveManual | 从 default 进入 plan：allow 不带 setMode → 模式随 claude 的 `system/status` 变为 default，stdin 无 set_permission_mode；从 acceptEdits 进入 plan：同样操作后 `permissionMode=acceptEdits`（claude 恢复原模式，V22），切换器如实显示 | T3 |
| R6.3 | Go | TestPlanReviseStaysPlan | deny+意见 → 模式仍 plan，stdin 无 set_permission_mode，假 claude 回「revising: …」并再次发 ExitPlanMode（V11），新的待答出现在 `chat_state.pending` | T3 |
| R6 | 浏览器 | R6 计划审阅三选项 | 三个选项行为与切换器同步 | dev-test |
| R7.1/R7.2 | TS | test-chat-permission: buildAnswer question | 单选/多选/其他 → `updatedInput.answers` 形状 | T8 |
| R7.1 | Go | TestAskAnswersRoundTrip | 假 claude 复述的答案与发送一致 | T3 |
| R7.3 | TS | test-chat-permission: questionComplete | 有题未答 → false 并返回缺失题号 | T8 |
| R7 | 浏览器 | R7 提问表单 | 未答完提交禁用并标红 | dev-test |
| R8.1 | Go | TestInterruptStopsTurn | `slow` 中 `chat_interrupt` → 收到 `error_during_execution/aborted_streaming` 的 result、idle、进程存活、可再发 | T3 |
| R8.1 | TS | test-chat-session: interrupted result | `error_during_execution`+`aborted_streaming` 与 `aborted_tools` → 回复都标「已中断」、无错误卡片；`[Request interrupted by user]` 与 `[Request interrupted by user for tool use]` 都不渲染为用户气泡 | T8 |
| R10.1 | TS | test-chat-parser: string-content user messages | content 为字符串的 user 消息：对话摘要 → 「对话已压缩」可折叠块；`<local-command-stdout>…</local-command-stdout>` → 命令输出块；`compact_boundary` → 分隔线；都不产生用户气泡（样本取自 V20 日志） | T8 |
| R8.2 | Go | TestInterruptResolvesPending | 有待答时中断 → stdin 上只有一条 interrupt、**没有** deny 的 control_response；假 claude 回 `control_cancel_request` 后待答清空、记 `vr_resolved interrupted`；回合以 `aborted_tools` 结束，工具未执行，进程存活 | T3 |
| R8.3 | Go | TestInterruptIdleNoop | idle 中断 → ack ok，stdin 无写入 | T3 |
| R8 | 浏览器 | R8 Esc / 停止 | 标「已中断」 | dev-test |
| R9.1–R9.3 | TS | test-chat-queue | 忙时两条排队按序发；删除不发；中断退回输入框 | T8 |
| R9 | 浏览器 | R9 排队 | 「排队中」显示与撤回 | dev-test |
| R10.1 | TS | test-chat-session: slash commands from state | `chat_state.slashCommands` 过滤前缀 | T8 |
| R10.2 | TS | test-chat-queue: terminal-only command | `/login` 被拦并返回 `terminalOnly` | T8 |
| R10 | 浏览器 | R10 斜杠菜单 | 输入 `/` 出菜单可过滤；`/theme` 提示交接 | dev-test |
| R11.1 | Go | TestSetModeUpdatesState | set_mode → 成功后广播新模式 | T3 |
| R11.2 | Go | TestBypassLocksMode | 见 R1.6 | T3 |
| R11 | 浏览器 | R11 模式切换器 | Shift+Tab 循环；bypass 时只读并说明 | dev-test |
| R12.1 / R13.3 | Go | TestChatDisconnectKeepsProcess | WS 关闭后进程存活，未发 `exit`，列表 state 不是 ended | T6 |
| R12.2 | Go | TestResyncIncremental50 | 断线期间 `burst 50` → 重连带 since 收到恰好 50 条、seq 连续、无重复 | T6 |
| R12.2 | 协议冒烟 | chat: resync 50 | 同上 | T13 |
| R12.2 / 非功能 | 浏览器（计时） | 补发 500 条渲染 ≤2 s | 假 claude `burst 500` 期间 CDP 断网 → 恢复 → 从重连 `ready` 到 `chat-resync-divider` 出现且最后一条消息渲染完成 ≤2000 ms，记录实测值 | dev-test |
| R12.3 | Go | TestRingOverflowReset | `burst 1200` 后带旧 since 重连 → `reset:true, omitted=缓冲淘汰数`，其后 1000 条有序 | T3 |
| R12.3 | TS | test-chat-session: omitted marker | reset 同步带 omitted → 插入省略标记 | T8 |
| R12.4 | Go | TestResyncMidStreamTail | `slow` 中途断开重连 → 收到尾巴里 seq>since 的增量，之后完整 assistant | T3 |
| R12.4 | TS | test-chat-session: preview merged by message.id | 预览 + 补发增量 + 完整块 → 该回复只出现一次、文本完整 | T8 |
| R12 | 浏览器 | R12 断线重连分隔线 | `chat-resync-divider` 与「已补回 N 条」 | dev-test |
| R13.1 | TS | test-chat-session: turn error | `fail` 结果 → 消息带 error，可取「重试」文本 | T8 |
| R13.1 | 浏览器 | R13.1 重试 | 点重试重发上一条 | dev-test |
| R13.2 | Go | TestCrashEmitsExitAndEnded | `crash 1` → `vr_exit{code:1,stderrTail}`、`exit` 帧、`chat_state.ended.reason=exited`、待答记 exited | T3/T6 |
| R13.2 | 浏览器 | R13.2 会话已结束 | `chat-ended` 有「重新启动」「新建终端会话接上」 | dev-test |
| H3 | Go | TestInitCapabilitiesMissingDegrades | `FAKE_CLAUDE_CAPS=""`（无 capabilities）或只有 `msg_lifecycle_v1` → 会话不结束，`chat_state.degraded=["interrupt_receipt"]`，日志一次；中断照常生效（入队即 ack，回合以 result 结束）；有 `interrupt_receipt_v1` 时 `degraded` 不出现 | T3 |
| R10.1 | Go | TestSlashCommandsPrecedence | initialize 回复先到 → `slashCommands` 为它（带 description）；之后每回合的 init 不覆盖；initialize 失败 → 用 init 列表；initialize 迟到成功 → 替换为它 | T3 |
| R13.4 | Go | TestInitVersionTooOldEnds | `FAKE_CLAUDE_INIT_VERSION=1.0.0` 或 `none` → ended `version_unsupported`，连接不断 | T3 |
| R13.4 | 浏览器 | R13.4 版本过旧 | 显示需要的版本与交接按钮，不重连 | dev-test |
| R14.1 | Go | TestHandoffCreatesTerminalWithResume | 终端 argv 含 `--resume <uuid>`，不含 `-c`，保留其它 flag；对话 `ended.handed_off` + `handedOffTo` | T6 |
| R14.1 | 协议冒烟 | chat: handoff | 新终端会话 PTY 中能看到假 claude 打印的 resume id | T13 |
| R14.2 | Go | TestHandoffInterruptsRunningTurn | `slow` 中交接 → 先 interrupt 再停进程 | T6 |
| R14.2 | 浏览器 | R14.2 交接确认 | 回合进行中弹确认 | dev-test |
| R15.1 | Go | TestChatRenamePersists | rename 后另一个 WS 连接收到的 `sessions` 列表与 REST 列表都显示新名字；重建 Manager（模拟重启）名字仍在 | T5 |
| R15.2 | Go | TestChatDeleteKeepsJSONL | 删除后进程退出、记录消失、JSONL 文件仍在 | T5 |
| R15.3 | Go | TestReloadRefusedWhenHandedOff | 交接出去的终端会话活着 → reload 409 `claude_session_busy` | T5 |
| R16.1–R16.3 | TS | test-chat-activity | chat 帧/`result`/`pending`/REST `activitySeq`/`state` → 灰/绿/黄与是否通知 | T11 |
| R16.3 | 浏览器 | R16.3 等你处理通知（通知可用） | 非活动对话会话收到权限请求 → 黄点 + `[notify] shown` 日志；点通知切到该会话 | dev-test |
| R16.3 | 浏览器 | R16.3 等你处理通知（降级，d12） | 未签名构建 `[notify] fallback`：Dock 弹跳 + 角标 + 黄点，当前会话**不**自动切换；窗口聚焦后角标清除 | dev-test |
| R16.4 | 协议冒烟 | chat: state without hooks | 无 hook 配置，`/api/v1/sessions` 的 state 随 running/waiting/idle 变化 | T13 |
| 非功能 | 真机（手工计量） | 首字延迟 | 局域网下同一台远程机，对话模式「发送 → 第一个可见字」与终端里直接用 claude 各测 5 次取中位数，差值写进 test-report（要求 ≤200 ms，只记录不硬卡） | dev-test |
| R17.1 | 全量 | make check + gui-smoke 原有用例 | 原断言不改 | T13 |
| R17.2 | TS | test-chat-availability: proto 2 | 见 R1.4 | T11 |
| R17.2 | 浏览器 | R17.2 新桌面连旧 daemon | 用 main 分支构建的 daemon，终端正常，对话卡片提示升级 | dev-test |
| R17.3 | Go | TestTerminalAttachToChatIsUIMismatch | 不带 ui 接入对话会话 → `error{code:ui_mismatch,fatal:true}` | T6 |
| R18.1 | Go | TestInfoAndReadyProto3 | info 与 ready 的 `proto=3` | T1 |
| R18.2 | 检查 | /protocol-sync | 三处无差异，版本表第 3 行 | T13 |
| R19.1 | 检查 | grep CLAUDE.md | 含「终端模式」「对话模式」「只支持 claude」三处描述 | T13 |

### 容易出问题的情况

| 情况 | 合理的预期 | 测试 | 谁写 |
|------|------------|------|------|
| 同一 `newSessionId` 两个 attach 同时到达 | 只建一个会话、一个进程 | TestChatCreateConcurrentSameID | T5 |
| 回答时 stdin 写队列已满 | 待答保持，ack `chat_busy`，不显示已回答 | TestRespondQueueFullKeepsPending | T3 |
| 看门狗之后迟到的 `result` | `ignoreResults` 吸收，`outstanding` 不变成负数，转发时带 `vr_stale:true`，客户端不拿它配对 | TestLateResultAfterStaleTurn、test-chat-queue: stale result not paired | T3、T8 |
| 中断时写队列已满 | ack `chat_busy`，待答请求一个都不改，不发任何 deny | TestInterruptQueueFullKeepsPending | T3 |
| 计划批准时 control_response 入队成功、紧随的 set_permission_mode 入队失败 | 广播 `vr_notice set_mode_failed` | TestPlanSetModeQueueFull | T3 |
| 交接与删除、重载同时到达 | `WithOp` 串行，后到者重查状态，不死锁 | TestWithOpSerializesHandoffDelete | T6 |
| 回合一直没有 `result`（claude 异常） | 10 分钟无输出且无待答 → `vr_notice stale_turn`，回到 idle，后续可发送；有待答时不计时 | TestOutstandingRecoversAfterStaleTurn | T3 |
| interrupt 时有排队消息 | `still_queued` 为 `[]` 也不影响计数；排队消息在中断后作为下一回合执行，`outstanding` 逐条归零 | TestStillQueuedIgnored | T3 |
| 计划批准后立刻切 acceptEdits | allow 之后立刻发，claude 恢复原模式的 status 与之并存，最终为 acceptEdits | TestPlanApproveSetsMode | T3 |
| `--resume` 的记录在检查后被删 | claude 输出 `result{errors}` 并 exit 1 → 重载记 `ended.reason=restart_failed`、`message` 为 `errors[0]`；新建返回 `create_failed` | TestResumeMissingTranscriptFails | T3 |
| 重载一个从未写出 JSONL 的会话 | 用 `--session-id`，不用 `--resume` | TestRestartWithoutTranscriptUsesSessionID | T3 |
| 多个改动并发写 store | 文件最终等于最后一次快照 | TestStoreConcurrentSaveKeepsLatest | T5 |
| `claude_cmd` 为 `~/.local/bin/claude` | 展开为 `$HOME/.local/bin/claude` 后能真正启动 | TestAssembledCommandRuns | T2 |
| 同步进行中断线 | 下次 attach 不带 epoch/since，走 reset | test-chat-client: 同步中途断线后重连仍走 reset | T7 |
| 已确认的对话会话自动重连 / Retry | attach 带 `ui:'chat'` | test-chat-client: 已确认的对话会话重连带 ui:'chat' | T7 |
| 别的桌面在发消息、本端排队 | 本端按「自己上一条已配到 result」发送，不被全局状态卡住 | test-chat-queue: own-result gating | T8 |
| 本端还没发过消息、别的桌面的回合在跑 | 入队，`status` 回到 idle 后再发 | test-chat-queue: first send while busy queues | T8 |
| 未信任目录新建对话（c3） | `chat_unsupported/workdir_untrusted`，终端不受影响 | TestCreateChatUntrustedWorkdir | T6 |
| 订阅者写满 1024 帧缓冲 | 该连接被断开（1013），重连补齐，不静默丢帧 | TestSlowSubscriberDisconnected | T3 |
| 订阅时恰好有新消息到达 | backlog 与实时帧无缺无重 | TestSubscribeAtomicBacklog（并发 burst 下比对 seq） | T3 |
| 回答与 `control_cancel_request` 同时到 | 只有一个 `vr_resolved` | TestRespondVsCancelRace | T3 |
| 多个待答请求并存 | 全部在 `pending`，可分别回答 | TestMultiplePending | T3 |
| 重载时有客户端在线 | 连接不断，收到 `reset` 同步，新 epoch | TestReloadPushesResetSync | T6 |
| 客户端带旧 epoch 重连 | `reset:true` | TestStaleEpochResets | T3 |
| 登录 shell 往 stdout 打印非 JSON | 跳过并计数，不中断 | TestNonJSONLinesSkipped | T3 |
| 没有订阅者时 claude 大量输出 | daemon 照常排空 stdout，进程不阻塞（V16） | TestDrainWithoutSubscribers | T3 |
| 停进程时还有排队消息 | 先 interrupt 再关 stdin，排队消息不再执行 | TestStopInterruptsBeforeClosingStdin | T3 |
| `system/init` 每回合重发 | 只更新元信息，不清缓冲、不改 epoch | TestInitResentEachTurnUpdatesMeta | T3 |
| 全局 hook 产生 `system/hook_*` 行 | 透传，客户端忽略，不影响状态 | TestHookLinesPassThrough | T3 |
| daemon 从 claude 会话里启动（继承 `CLAUDECODE`） | 对话进程环境里没有 `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` | TestChatEnvStripsNestedGuard | T5 |
| 客户端 allow 时没带 `updatedInput` | daemon 补原 input，claude 正常执行 | TestRespondFillsUpdatedInput | T3 |
| 「不再询问」建议里混有 setMode | addRules 存在时只回传 addRules+addDirectories，不切模式 | test-chat-permission: suggestion grouping | T8 |
| 单行超过 16 MiB | 丢弃并发 `vr_notice line_dropped`，后续正常 | TestOversizeLineDropped | T3 |
| claude 发来未知 `control_request` | 立即回 error，不挂起 | TestUnknownControlRequestAnswered | T3 |
| `updatedPermissions` 不是 claude 给的建议 | ack `foreign_rule`，不写 stdin | TestRespondRejectsForeignRule | T3 |
| 用户消息含 emoji/CJK | stdin 与回显 UTF-8 原样 | TestSendUTF8 | T3 |
| 同一 `clientMsgId` 重发 | 只写一次 stdin | TestSendDedupClientMsgID | T3 |
| 交接 attach 重放 | 只建一个终端会话 | TestHandoffReplayIdempotent | T6 |
| worktree 对话会话交接后删除对话会话 | worktree 保留（归终端会话） | TestDeleteAfterHandoffKeepsWorktree | T5 |
| `chat-sessions.json` 损坏 | 改名隔离，以空表启动 | TestStoreCorruptQuarantined | T4 |
| 写 store 中途崩溃 | 旧文件完好（临时文件 + rename） | TestStoreAtomicWrite | T4 |
| `claude_cmd` 含 `|`、`$()`、反引号 | `shell_syntax`，对话不可用，终端不受影响 | TestParseRejectsShellSyntax | T2 |
| `claude_cmd` 为 CLAUDE.md 示例 `claude --dangerously-skip-permissions -c` | exe=claude、bypass、continue；对话参数去掉 `-c` | TestParseClaudeMdExample | T2 |
| `claude_cmd` 自带 `-p`/`--resume` | `conflicting_args` | TestParseRejectsConflictingArgs | T2 |
| 参数含空格与单引号 | 交接命令引号正确，shell 还原后 argv 一致 | TestHandoffCommandQuoting | T2 |
| attach 帧夹带 `command`/`args` 字段 | 被忽略，argv 只来自配置 | TestAttachIgnoresCommandFields | T6 |
| 终端会话 v2 帧 | 除 `proto` 外与 v2 逐字节一致 | TestTerminalFramesUnchangedV3 | T6 |
| 对话进程环境 | 只有 hook token，没有主 token | TestChatEnvHookTokenOnly | T5 |
| daemon SIGTERM | 所有对话进程退出，记录 `daemon_restart` | TestShutdownStopsChats | T5 |
| JSONL 目录编码不符 | 按 `cwd` 回退找到 | TestFindTranscriptAndLatest | T2 |
| 窗口隐藏、定时器节流 | 对话连接与终端一样不被看门狗误断 | 现有 test-client-liveness（对话 intent 复跑一遍） | T7 |
| 收到 `exit` 帧后重载 | 对话视图仍能重新接入（不清 sessionId） | test-chat-client: exit keeps session | T7 |
| 工具输出里有 HTML | 以文本显示 | test-chat-render-guard + 浏览器 R3.3 | T9 |

## 任务

### T1 协议 v3 类型与文档
- 状态：待办
- 文件：修改 `vibe-remoted/internal/protocol/protocol.go`、`desktop/src/shared/protocol.ts`、`desktop/src/renderer/rest.ts`（类型部分）、`docs/protocol.md`；测试新建 `vibe-remoted/internal/protocol/protocol_test.go`，`vibe-remoted/internal/server/contract_test.go` 补用例
- 接口：
  - 提供（Go）：`Version = 3`；`TypeChat/TypeChatSync/TypeChatState/TypeChatAck/TypeChatSend/TypeChatRespond/TypeChatInterrupt/TypeChatSetMode`；`AttachFrame` 加 `UI`、`Epoch`、`Since`、`HandoffFrom`（均 `omitempty`）；`ReadyFrame` 加 `UI`、`ClaudeSessionID`、`Existing`、`HandoffFrom`；`SessionInfo` 加 `UI`、`State`、`ActivitySeq`、`Epoch`、`EndReason`；`ChatFrame{Seq uint64; H bool; Msg json.RawMessage}`、`ChatSyncFrame`、`ChatStateFrame`、`PendingRequest`、`ChatEnded`、`ChatAckFrame`、`ChatSendFrame`、`ChatRespondFrame`、`ChatSetModeFrame`；错误码 `ErrCodeUIMismatch`、`ErrCodeChatUnsupported`、`ErrCodeClaudeSessionBusy`；`UITerminal/UIChat` 常量
  - 提供（TS）：同名类型与 `PROTOCOL_VERSION = 3`；`MachineInfo.chat?: {supported; reason?; claudeVersion?; minClaudeVersion}`
  - 文档：design 4.1–4.10 全部帧、字段、错误码、REST 变化、版本表第 3 行
- 第一步（改协议之前单独提交）：在 HEAD 上新增 `vibe-remoted/internal/server/golden_test.go`，其中 `TestTerminalFramesUnchangedV3` 用现有测试夹具（tmux + `/bin/bash`）跑一遍终端 attach，把 `ready`（normal / worktree）、`sessions`、`exit`、`error{session_not_found}` 帧序列化后与 `testdata/v2-golden/*.json` 比较。`sessions` 帧只比较 `workdir` 位于本测试临时目录下的条目（共享的 `tmux -L vibe-remote` 上可能有别的会话），按 `id` 排序后再比；所有帧中的时间戳、会话 id、临时路径先归一化为固定占位符（如 `<TS>`、`<ID1>`、`<TMP>/…`）；`VR_WRITE_GOLDEN=1` 时改为写入。先以 `VR_WRITE_GOLDEN=1 go test ./internal/server -run TestTerminalFramesUnchangedV3` 生成并提交 v2 黄金文件（`proto` 比较时归一化，时间戳/id/路径用夹具固定值替换），之后的所有任务都只比较不写入
- 场景：R18.1、R18.2（部分）、R17.1
- 测试：
  - `TestTerminalFramesUnchangedV3`：黄金文件生成后，协议改到 v3 仍逐字节一致（除 `proto`）
  - `TestInfoAndReadyProto3`：`/api/v1/info` 与终端 attach 的 `ready.proto` 都是 3
  - `TestProtocolChatFramesJSON`：各新帧 `json.Marshal` 的键名与 design 4.x 一致（`clientMsgId`、`requestId`、`setMode`、`historyCount`…），终端 `ReadyFrame` 不出现 `ui` 键
- 完成定义：`testdata/v2-golden/` 已在独立提交里生成；`cd vibe-remoted && go test ./internal/protocol/... ./internal/server -run 'Proto3|ChatFramesJSON|TerminalFramesUnchangedV3'`；`cd desktop && npm run typecheck`；`make check` 全绿
- 依赖：无

### T2 命令行解析、版本比较与假 claude
- 状态：待办
- 文件：新建 `vibe-remoted/internal/chat/cmdline.go`、`cmdline_test.go`、`probe.go`、`probe_test.go`、`transcript.go`、`transcript_test.go`、`trust.go`、`trust_test.go`、`fakeclaude/main.go`、`chattest/chattest.go`、`testdata/probe-stream.jsonl`
- 接口：
  - 提供：`ParseClaudeCmd(cmd string) (Parsed, reason string)`（`Parsed{Exe string; Args []string; Continue, Bypass bool; PermissionMode string}`，H7/H14，design 4.9 的 reason）；`ChatArgv(p Parsed, claudeSessionID string, resume bool) []string`；`ShellJoin(argv []string) string`；`HandoffCommand(exe string, args []string, u string, resume bool) string`（resume=false 时用 `--session-id u`）；`ParseVersion(s string) (v [3]int, ok bool)`、`VersionAtLeast(v, min)`、`const MinClaudeVersion = "2.1.210"`；`Prober`（后台探测、10 分钟缓存、`Recheck()`、`Get(ctx, wait time.Duration)`）
  - 提供：`ExpandHome(word string) string`（开头 `~`、`~/` → daemon 用户 `$HOME`，在拼接与引号之前调用，登录 shell 与 argv 两条路径都用）
  - 提供（纯文件函数，供 T3 使用）：`ProjectsDir() string`、`FindTranscript(projectsDir, u string) (path string, ok bool)`、`LatestSessionForWorkdir(projectsDir, workdir string) (uuid string, ok bool)`（目录编码 `/`、`.` → `-`，找不到时按 `cwd` 回退）
  - 提供（**待 c3 确认**）：`type TrustState string`（`trusted`/`untrusted`/`unknown`）；`WorkdirTrusted(workdir string) TrustState`：文件为 `$CLAUDE_CONFIG_DIR/.claude.json`（设置时）否则 `~/.claude.json`；只看规范化目录本身的 `projects[<目录>].hasTrustDialogAccepted`；无记录 → untrusted；文件缺失或无法解析 → unknown；只读该字段
  - 提供（测试辅助）：`chattest.TrustDir(t, configDir, dir)`：在临时 `$CLAUDE_CONFIG_DIR/.claude.json` 里把临时工作目录标为已信任（chattest、ws-chat-smoke、gui-smoke 都用同样的文件格式）
  - 提供（测试辅助）：`chattest.FakeClaude(t) (dir string)`（`sync.Once` 里 `go build -o <tmp>/claude ./internal/chat/fakeclaude`）
  - 假 claude 行为：design 9.2 全部指令与环境变量
- 场景：R1.3、R1.4（daemon 侧判定）、R14.1（命令拼接）
- 测试：
  - `TestParseClaudeMdExample`：`claude --dangerously-skip-permissions -c` → Exe=claude, Bypass, Continue, Args=[`--dangerously-skip-permissions`]
  - `TestParseNotClaude`：`/bin/bash`、`codex` → `not_claude`；`/usr/local/bin/claude`、`~/.local/bin/claude` → 通过
  - `TestParseRejectsShellSyntax`：含 `|`、`;`、`$(`、反引号 → `shell_syntax`
  - `TestParseRejectsConflictingArgs`：`-p`、`--print`、`--resume x`、`--session-id x`、`--output-format json` → `conflicting_args`
  - `TestHandoffCommandQuoting`：args 含 `--append-system-prompt "it's a b"` → `sh -c` 还原后 argv 与输入一致，有记录时末尾 `--resume <uuid>`、无记录时 `--session-id <uuid>`，无 `-c`
  - `TestAssembledCommandRuns`：临时 HOME 下把假 claude 放到 `$HOME/.local/bin/claude`，`claude_cmd="~/.local/bin/claude"`；分别以登录 shell（`/bin/sh -lc 'exec …'`）和直接 argv 两种方式**真正执行**拼出的对话命令，假 claude 的 `$FAKE_CLAUDE_ARGV_LOG` 记录到完整参数
  - `TestWorkdirTrusted`：`hasTrustDialogAccepted:true` → trusted；`false` → untrusted；目录本身无记录、只有父目录 true → **untrusted**（只看目录本身，design 第 7 节；V24 证实继承后才放宽）；无记录 → untrusted；文件不存在或 JSON 损坏 → unknown（不报错）；设置 `CLAUDE_CONFIG_DIR` 时读该目录下的文件
  - `TestFindTranscriptAndLatest`：两个项目目录各放 JSONL，`FindTranscript` 按 uuid 找到；`LatestSessionForWorkdir` 返回 mtime 最新者；目录编码不符时按首行 `cwd` 回退
  - `TestCommandFromConfigOnly`：`ChatArgv` 输出只由 Parsed 与常量构成（固定输入的黄金值）
  - `TestParseVersion`：`2.1.210 (Claude Code)` → [2,1,210]；`2.1.209` < 最低；`garbage` → !ok
  - `TestProbeCachesAndRecheck`：假 claude 版本经 env 改变，未 recheck 时值不变，recheck 后更新；不存在的 exe → `claude_not_found`
  - `TestFakeClaudeEcho`：直接驱动假 claude：不发 initialize 也能工作；每回合先 `system/init`；`echo` 的 stream_event 与完整 assistant 同 `message.id`、顺序与探针日志一致
  - `TestFakeClaudeMatchesProbe`：本任务从探针日志 `.devflow-tmp/probe/logs/` 的 v2/v3/v6a/v6b/v7 与第二批 v9（含 /compact）/v11/v12b/v14/v18b/v21 生成 `vibe-remoted/internal/chat/testdata/probe-stream.jsonl`（去除个人路径与长列表，随代码提交）；对其中每种消息，假 claude 输出的键集合与实测样本一致（防止假 claude 与真 claude 漂移）
  - `TestNoCredentialAccess`：扫描 `vibe-remoted/internal/**/*.go`（不含本测试文件），出现 `.credentials` 或 `ANTHROPIC_API_KEY` 即失败
- 完成定义：`cd vibe-remoted && go test -race ./internal/chat/...`；`go vet ./...`
- 前置：V23 已实测（`-p` 不看信任、直接执行项目 hooks）；可选补测 V24（交互式 claude 的父目录信任继承），结果追加进 evidence，成立才把查找放宽为逐级向上
- 依赖：T1

### T3 对话进程监护（chat.Session）
- 状态：待办
- 文件：新建 `vibe-remoted/internal/chat/session.go`（含 `WithOp`/`OpHandle.StopLocked`/`OpHandle.RestartLocked`、`reloading` 标志）、`control.go`、`session_test.go`、`control_test.go`；参考移植 `69d8c70:vibe-remoted/internal/session/persistent.go` 的 `tailWriter`、`userMessageLine`、`permissionResponseLine`、`interruptLine`（丢弃其「中断即杀进程」和「每次 attach 起进程」逻辑）
- 接口：
  - 使用：T2 的 `FindTranscript`（`RestartLocked` 选 `--resume`/`--session-id`）
  - 提供：design 4.11 的 `Start/Subscribe/Send/Respond/Interrupt/SetMode/WithOp/Snapshot` 与 `OpHandle.StopLocked/RestartLocked`（`opMu` 不可重入；锁顺序 creating 占位 → opMu → Manager.mu → Session.mu → store.mu，禁止反向）；`Ack{OK bool; Code, Message string}`；常量 `RingMax=1000`、`RingBytesMax=32<<20`、`TailMax=20000`、`SubBuffer=1024`、`MaxLine=16<<20`、`InitializeWait=10s`（只影响命令列表来源，不影响状态）
  - 行为：design 4.4–4.7、5.2、6.1、6.3、6.4、第 7 节的进程/行处理规则
- 场景：R1.6、R3.1、R3.4、R5.1–R5.4、R5.7、R5.8、R6.1–R6.3、R7.1、R8.1–R8.3、R11.1、R11.2、R12.3、R12.4、R13.2、R13.4
- 测试（均用假 claude，`-race`）：
  - 测试计划中标 T3 的全部用例，另加：
  - `TestPendingSurvivesRingEviction`：待答请求后 `burst 1200` → `Snapshot().Pending` 仍含该请求，reset 同步的 `chat_state.pending` 含它
  - `TestSingleProcessRestart`：连续 5 次 `RestartLocked`，期间并发发起同目录 `-c` 新建（经测试用的 owners 表）→ pid 目录无 VIOLATION，每次 epoch 不同；重启全程 U 的 owner 不变，`-c` 新建拿到 `existing` 或 `claude_session_busy`，从不另起进程
  - `TestExitCallbackNoSessionLock`：退出回调在独立 goroutine 执行，执行期间 `Session.mu` 可被另一 goroutine 立即获取（`TryLock` 断言），且回调只取 Manager 侧锁（用测试钩子记录）
  - `TestInterruptQueueFullKeepsPending`：有 2 个待答请求、写队列已满 → `chat_interrupt` ack `chat_busy`，两个请求仍在待答表、stdin 没有任何 deny；腾出 1 个空位后再中断 → 只写入一条 interrupt，假 claude 对两个请求各回 `control_cancel_request`，两个都记 `vr_resolved interrupted`
  - `TestPlanSetModeQueueFull`：写队列只剩 1 个空位时以 `setMode:acceptEdits` 批准计划 → control_response 入队、待答解决，set_permission_mode 入队失败 → 广播 `vr_notice set_mode_failed`，`permissionMode` 保持 claude 报告的值
  - `TestLateResultAfterStaleTurn`：`swallow` 触发 stale_turn 后假 claude 再补发一个 `result` → `outstanding` 仍为 0（不为负）、`ignoreResults` 归零、转发的消息带 `vr_stale:true`；期间只有 `keep_alive` 行时看门狗照常计时
  - `TestStopIsIdempotent`：3 个 goroutine 各自 `WithOp(func(ops){ ops.StopLocked("stopped") })` → 被 `opMu` 串行化，进程只结束一次，`Wait` 不重复调用，后两次立即返回
  - `TestRespondQueueFullKeepsPending`：用测试钩子把写队列塞满 → `Respond` ack `chat_busy`，`Snapshot().Pending` 仍含该请求，无 `vr_resolved`；队列腾出后再答成功
  - `TestOutstandingRecoversAfterStaleTurn`：测试里把看门狗时长注入为 200 ms；假 claude 收到 `swallow` 不发 result → 收到 `vr_notice stale_turn`（带该 `clientMsgId`）、状态 idle；另起一例有待答请求时不触发
  - `TestStillQueuedIgnored`：`slow` 中再写两条后 interrupt（假 claude 的 `still_queued` 为 `[]`）→ `outstanding` 仍为 3，中断回合的 result 后为 2，排队的两条依次执行完才 idle（V14）
  - `TestBypassStillAsksQuestions`、`TestResumeMissingTranscriptFails`（见测试计划；后者用测试钩子在 `FindTranscript` 之后删除 JSONL，假 claude 按 V21 输出 `result{errors}` + stderr 并 exit 1）
  - `TestRestartWithoutTranscriptUsesSessionID`：会话从未写出 JSONL 时 `WithOp(func(ops){ ops.RestartLocked(spec) })` 的 argv 含 `--session-id U` 而非 `--resume`；有 JSONL 时为 `--resume U`
  - `TestStopTimings`：假 claude `FAKE_CLAUDE_STUBBORN=1`（忽略 interrupt、stdin EOF 与 SIGTERM）→ `WithOp(func(ops){ ops.StopLocked("stopped") })` 在 5 s 内返回；`$FAKE_CLAUDE_SIGNAL_LOG` 含 `SIGTERM ignored`（证明走过 SIGTERM 阶段）且进程已被 SIGKILL 结束
  - `TestInitCapabilitiesMissingDegrades`、`TestSlashCommandsPrecedence`（见测试计划）
- 完成定义：`cd vibe-remoted && go test -race -count=3 ./internal/chat/...`
- 前置：V9、V11、V12、V14、V18、V19、V21、V22 已实测（evidence 第二批），design 已按结果调整；本任务按 design 4.7（中断只发一条 interrupt）、5.2（逐条计数）、6.7（批准后立刻切模式）实现
- 依赖：T2

### T4 JSONL 历史、会话表持久化、孤儿清理
- 状态：待办
- 文件：新建 `vibe-remoted/internal/chat/history.go`、`history_test.go`、`store.go`、`store_test.go`、`orphan.go`、`orphan_test.go`（Linux 读 `/proc/<pid>/cmdline`，darwin 用 `ps -o command= -p`）；参考 `69d8c70:vibe-remoted/internal/session/history.go`（`ReadHistory` 重写为原样行 + 截止点；目录定位已在 T2 的 `transcript.go`）
- 接口：
  - 使用：T2 的 `ProjectsDir/FindTranscript/LatestSessionForWorkdir`
  - 提供：`StreamHistory(path string, cutoff int64, batch int, emit func(lines [][]byte) error) (count int, err error)`（完整、不截断，按批回调，d13）与 `CountHistory(path, cutoff) (int, error)`（给 `historyCount`）；`Store{Load() ([]Record, error); Save([]Record) error}`、`Record`（design 5.1）；`CleanupOrphans(recs []Record) []Record`（SIGTERM → 最多 2 s → SIGKILL → 最多 1 s 确认 `kill(pid,0)` 为 ESRCH；仍存活则返回该记录的 `orphan:<pid>` 占用，design 6.6）
  - `chat.Session` 接入：启动前记录 `cutoff`，`Subscribe` 的 reset 路径先放历史
- 场景：R1.5（完整历史）、R2.5（含孤儿退出确认）、R15.1（存储层）
- 测试：
  - `TestSyncHistoryBeforeCutoff`、`TestOrphanCleanup`、`TestStoreCorruptQuarantined`、`TestStoreAtomicWrite`（见测试计划）
  - `TestHistoryFiltersSidechainAndMeta`：`isSidechain:true`、`isMeta:true`、`summary`、`file-history-snapshot` 行不出现
  - `TestHistoryFullStream`（见测试计划）：另断言读取是流式的——以 `testing.AllocsPerRun`/内存采样确认不会一次性载入整份文件（或用 `io.Reader` 计数器断言按批读取）
  - `TestStorePermissions`：文件 0600、目录 0700
- 完成定义：`cd vibe-remoted && go test -race ./internal/chat/...`
- 依赖：T3

### T5 Manager 集成：新建、列表、改名、删除、重载、启动与退出
- 状态：待办
- 文件：修改 `vibe-remoted/internal/session/runner.go`（`liveTmuxSessions` 的 `-F` 格式与 `parseTmuxSessionLine` 多读一列 `@vibe_remote_claude_u`，`tmuxSessionInfo` 加 `claudeU`；现有 `tmux_helpers_test.go`、`hardening_test.go` 断言不改，只补新列的用例）、`vibe-remoted/internal/session/manager.go`（`chats` map、`Create` 按 `UI` 分支、`List` 合并、`Delete`/`Rename`/`Reload` 分派、`LoadChats`、`Shutdown`、`ChatGet`）、`vibe-remoted/internal/config/config.go`（`StateDir`、`Load` 默认值）、`vibe-remoted/cmd/vibe-remoted/main.go`（建 store、`LoadChats`、启动 `Prober`、退出时 `Shutdown`）、`vibe-remoted.example.json`（`state_dir` 示例注释用法见 CLAUDE.md）；测试新建 `vibe-remoted/internal/session/chat_manager_test.go`，`config_test.go` 补用例
- 接口：
  - 使用：`chat.Start`、`(*chat.Session).WithOp` + `OpHandle.StopLocked/RestartLocked`、`chat.Store`、`CreateWorktree/RollbackWorktree/CleanupWorktree`（现有）
  - 提供：`claudeOwners` + `claimClaude/releaseClaude`（design 第 2 节，所有 spawn 之前 claim）；`Delete`/`Reload` 各调用一次 `WithOp`（不嵌套）；`Reload` 的同步检查（`Manager.mu` 下，不碰 `opMu`）、`reloading` 幂等与后台重查（已删除 → 不做；已交接 → 只广播 `handed_off`）；终端会话的占用：交接创建的终端会话持有 U；以 continue 语义新建/重载的终端会话按当时 `LatestSessionForWorkdir` 尽力占用 U（design 6.9，d14）；两者都写 tmux 选项 `@vibe_remote_claude_u`，reconcile 恢复条目时据此重新 claim、tmux 会话消失时释放；`(*Manager).persist()` + 单一 persist 协程（最新快照胜出）；终端新建/重载的 continue 冲突检查与尽力占用（design 6.9，d11、d14）；`CreateOptions{UI, ChatArgs …}`；`(*Manager).Create` 对话分支（design 6.2，含 R2.6 `existing`）；`(*Manager).ChatGet(id) (*chat.Session, bool)`；`(*Manager).Reload` 对话分支（同步检查后后台执行，进度经 `chat_state`；U 被占 → `ErrClaudeSessionBusy`；失败 → `ended.reason=restart_failed`，d10）；`(*Manager).LoadChats(store)`；`(*Manager).Shutdown(ctx)`；`List()` 条目带 design 4.8 字段；`lookupOrRecover`/`Attach` 遇对话 id 返回 `ErrUIMismatch`
- 场景：R1.5、R1.7、R2.1、R2.2、R2.5、R2.6、R15.1–R15.3
- 测试：测试计划中标 T5 的全部用例（含 `-race` 并发用例 `TestConcurrentContinueCreatesOneProcess`、`TestRestartRefusedWhenUResumedElsewhere`、`TestReloadVsDeleteSerialized`，以及 `TestTerminalContinueBusyWhenChatOwns` 的 Manager 部分），另加：
  - `TestListMergesChatAndTmux`：tmux reconcile 不删对话条目、对话条目不进 tmux 查询
  - `TestStoreConcurrentSaveKeepsLatest`：16 个 goroutine 并发改名/新建/删除后 `Shutdown` → 读回文件等于内存最终状态
  - `TestOwnersReleasedOnExit`：对话进程 `crash` 后 `claudeOwners` 不再含 U；删除会话后不含其任何 U
  - `TestLoadChatsReclaimsHandoff`：交接出去的终端会话 tmux 仍在（带 `@vibe_remote_claude_u`）→ 重建 Manager 并 reconcile 后 claim 恢复，重启原对话会话返回 `claude_session_busy`
  - `TestTerminalContinueClaimsLatest`（见测试计划）
- 完成定义：`cd vibe-remoted && go test -race ./internal/session/... ./internal/config/...`；现有 `manager_test.go`、`idempotent_test.go` 不改断言通过
- 依赖：T4

### T6 WebSocket 对话通路与 REST
- 状态：待办
- 文件：修改 `vibe-remoted/internal/server/ws.go`（`wsAttach` 按 `ui`/`handoffFrom` 分派；新增 `wsChatRelay`；把现有 ping 循环抽成 `pingLoop` 供两条 relay 共用，终端行为不变）、`vibe-remoted/internal/server/server.go`（`handleInfo` 加 `chat`、`?recheck=1`；reload/rename/delete 对话分支与 409）；测试新建 `vibe-remoted/internal/server/ws_chat_test.go`，`contract_test.go`、`ws_test.go` 补用例
- 接口：
  - 使用：`Manager.Create/ChatGet/Reload/Rename/Delete`、`chat.Session.Subscribe/Send/Respond/Interrupt/SetMode`
  - 提供：design 4.2–4.10 的线上行为；交接流程 design 6.5（`Manager.Handoff(chatID, newID string) (*Runner, error)` 与 `createTerminalLocked(id, opts)` 放在 manager.go，由本任务实现：交接已持有 `newSessionId` 的 creating 占位，所以新建终端会话走 `createTerminalLocked`、不再 `beginCreate`；交接对 C 只调用一次 `WithOp`）；由交接创建的终端会话的重载命令用 `HandoffCommand(exe, args, U, FindTranscript(U) 是否存在)`
- 场景：R1.2、R1.3、R1.4、R2.3、R2.4、R5.5、R5.7、R12.1、R12.2、R13.2、R13.3、R14.1、R14.2、R17.3
- 测试：测试计划中标 T6 的全部用例；`TestTerminalFramesUnchangedV3`（与 T1 提交的 `testdata/v2-golden/` 比较）；`TestAttachIgnoresCommandFields`；另加：
  - `TestHandoffVsReloadOneWins`（`-race`，见测试计划：断言「任何时刻 ≤1 个进程、无 VIOLATION、终态 ∈ {handed_off, 重载后运行}」，不再要求「恰好一个成功」）
  - `TestHandoffReplayNoSelfWait`：交接 attach 在 `createTerminalLocked` 期间重放同一 `newSessionId` → 重放等待后接入同一终端会话，原请求不因等待自己的 creating 占位而卡死（2 s 内完成）
  - `TestWithOpSerializesHandoffDelete`：并发交接与删除 → 不死锁（5 s 内完成）；删除先到 → 交接 `session_not_found`；交接先到 → 删除 C 不碰交接出去的终端会话
  - `TestHandedOffTerminalReloadUsesResume`（见测试计划）
  - `TestReloadChatReturns202`：REST 202 立即返回（<500 ms，假 claude `slow` 中）；重载进行中再调一次 → 也是 202 且 pid 目录只出现一次新进程；订阅者依次收到 `ended.reason=stopped` → 新 epoch 的 reset 同步 → `idle`；重载成功后的 reset 同步含重载前的全部历史（`historyCount` 等于重载前 JSONL 的 user/assistant 行数），随后 `chat_send` 能收到新回复；假 claude 启动失败时收到 `ended.reason=restart_failed` 与 message
  - `TestCreateChatUntrustedWorkdir`（待 c3 确认）：临时 `$CLAUDE_CONFIG_DIR/.claude.json` 未信任该目录、或文件不存在（unknown）→ 都是 `error{code:chat_unsupported, fatal:true}`，message 含 `workdir_untrusted`；worktree 模式检查源仓库；`/api/v1/fs` 返回 `chatTrust`
  - `TestTerminalContinueBusyWhenChatOwns` 的 attach/REST 部分：attach 收到 fatal `claude_session_busy`，终端 reload 返回 409
- 完成定义：`cd vibe-remoted && go test -race ./...`；现有 `ws_test.go`、`contract_test.go`、`hardening_test.go` 不改断言通过
- 依赖：T5

### T7 客户端连接层支持对话帧
- 状态：待办
- 文件：修改 `desktop/src/renderer/client.ts`；新建 `desktop/scripts/test-chat-client.mjs`；`desktop/package.json` 加 `test:chat-client` 并接进 `test`
- 接口：
  - 提供：`attach(sessionId, cols, rows, workdir?, flags?, mode?, opts?: {ui?: 'terminal'|'chat'; handoffFrom?: string})`（`AttachIntent` 持久保存 `ui`，`handoffFrom` 只在创建意图里）；`chatPosition?: () => {epoch: string; seq: number} | null`（每次发 attach 时调用；只有收到当前 epoch 的同步结束 `chat_state` 后才返回非空）；回调 `onChatSync/onChat/onChatState/onChatAck`；`sendChat(text, clientMsgId)`、`respond(requestId, response, setMode?)`、`interrupt()`、`setMode(mode)`；`onReady` 增加第四参 `ready: ReadyFrame`
- 场景：R2.1（客户端重放）、R12.2（since 发送）、R13.2（exit 不清会话）
- 测试（fake WebSocket + 假定时器，仿 test-client-reconnect.mjs）：
  - `test-chat-client: chat attach carries ui and position at send time`：第一次 attach 无 epoch/since；收到同步结束 `chat_state` 与之后 3 条 chat 后断线重连 → attach 带 `epoch`、`since=最后 seq`
  - `test-chat-client: 同步中途断线后重连仍走 reset`：收到 `chat_sync` 与部分 backlog、未收到结束 `chat_state` 即断线 → 重连 attach 不带 `epoch`/`since`；收到 `chat_sync{reset:true}` 或 epoch 变化时 `lastSeq` 清零
  - `test-chat-client: 已确认的对话会话重连带 ui:'chat'`：`ready` 之后的自动重连与 `reconnectNow()` 的 attach 都带 `ui:'chat'` 和原 `sessionId`；交接创建的终端会话在 `ready` 之后重放不再带 `handoffFrom`
  - `test-chat-client: create replay keeps newSessionId and ui`：ready 前断线 → 重放帧 `newSessionId` 相同、`ui:"chat"`
  - `test-chat-client: exit keeps session`：对话会话收到 `exit` 后重连仍以原 `sessionId` attach；终端会话行为不变（原断言）
  - `test-chat-client: chat_ack routed`：ack 交给 `onChatAck`，不触发 `onError`
  - 复跑 liveness throttled 用例于对话 intent
- 完成定义：`cd desktop && npm run typecheck && npm test`
- 依赖：T1

### T8 对话状态核心（移植 7 月代码）与发送队列
- 状态：待办
- 文件：新建 `desktop/src/renderer/chat/types.ts`、`parser.ts`、`session.ts`、`permission.ts`、`diff.ts`、`queue.ts`、`index.ts`（按 design 4.12 的移植表）；测试新建 `desktop/scripts/test-chat-parser.mjs`、`test-chat-session.mjs`、`test-chat-permission.mjs`、`test-chat-diff.mjs`、`test-chat-queue.mjs`（由 `69d8c70` 的 parser.test.ts 160 行、session.test.ts 241 行、permission.test.ts 110 行、diff.test.ts 50 行改写，删去 checkpoint/rollback/cost 相关用例）；`package.json` 接入 `npm test`；共享样本复用 T2 生成的 `vibe-remoted/internal/chat/testdata/probe-stream.jsonl`（测试脚本按相对路径 `../vibe-remoted/internal/chat/testdata/probe-stream.jsonl` 读取，不另存一份）
- 接口：
  - 提供：`ChatSession{applySync(sync), applyChat(seq, msg), applyHistory(msg), applyState(state), markSubmitting(requestId), reset(); getState(): ChatState; onUpdate}`；`ChatState{messages, status, permissionMode, permissionLocked, pending, slashCommands, ended, omitted, resyncDividerAt?}`；`permission.ts` 的 `classifyPermissionKind`、`parsePermissionQuestions`、`describeSuggestion`、`buildAnswer`、`questionComplete`；`queue.ts` 的 `SendQueue{enqueue, remove, onEcho(clientMsgId), onResult(), onStaleTurn(clientMsgId), canSend(): boolean, takeBackAll(): string}`（发送条件 = 本端上一条已回显且按 FIFO 配到了 result，design 6.8）、`classifySlash(text, slashCommands) → 'send'|'terminalOnly'`
- 场景：R3.1、R3.4、R4.1–R4.4、R5.2、R5.2b、R5.6、R5.8、R7.1–R7.3、R8.1（显示）、R9.1–R9.3、R10.1、R10.2、R12.3、R12.4、R13.1
- 前置：V10、V20 已实测（多选 `", "` 连接、自填文字原样接受；`/compact` 产生 content 为字符串的 user 消息）
- 测试：测试计划中标 T8 的全部用例（含 `test-chat-parser: string-content user messages`、`test-chat-session: bypass still shows question cards`）；`test-chat-parser: fixture lines`（fixture 每行解析不抛异常、未知类型为 ignored）；`test-chat-queue: own-result gating`（别的桌面的回显与 result 穿插时，本端只在自己那条配到 result 后发下一条；`stale_turn` 也算配对；全局 status 一直 running 不影响判断）；`test-chat-queue: stale result not paired`（带 `vr_stale:true` 的 result 不参与配对）；`test-chat-queue: first send while busy queues`（本端无上一条、`status=running` → 入队；`status` 变 `idle` → 发出）
- 完成定义：`cd desktop && npm run typecheck && npm test`
- 依赖：T1、T2（fixture）

### T9 ChatView 基础：对话区、Markdown、工具块、输入框、外链
- 状态：待办
- 文件：新建 `desktop/src/renderer/chat/view.ts`（含虚拟列表，d13）、`window.ts`、`markdown.ts`、`tools.ts`、`composer.ts`；修改 `desktop/src/renderer/index.ts`（`views` 支持 `ChatView`、`openChatSession()`、`setActive` 分支、侧边栏对话图标与 `data-ui`）、`desktop/src/renderer/styles.css`、`desktop/src/renderer/i18n.ts`、`desktop/src/main/index.ts`（`open-external` IPC：只放行 `http:`/`https:`/`mailto:`）、`desktop/src/main/preload.ts`（`openExternal`）、`desktop/package.json`（`"markdown-it": "15.0.3"`、`"dompurify": "3.4.17"`，devDependency `"jsdom": "29.1.1"`，均为精确版本）；测试新建 `desktop/scripts/test-chat-markdown.mjs`、`test-chat-render-guard.mjs`、`test-chat-window.mjs`
- 接口：
  - 使用：T7 的客户端、T8 的 `ChatSession`
  - 提供：`ChatView{key, machine, sessionId, client, container, activity, ui:'chat', session: ChatSession}`；`createMarkdownRenderer(win = window) → renderMarkdown(text): DocumentFragment`（window 可注入）；design 4.12 的 `data-testid`（本任务涉及的：`chat-view`、`chat-transcript`、`chat-msg-*`、`chat-tool`、`chat-diff`、`chat-input`、`chat-send`、`chat-stop`）
- 场景：R1.2（视图部分）、R3.1–R3.4、R4.1–R4.4
- 测试：
  - `test-chat-markdown`：用 esbuild 打包 `markdown.ts`，`const { window } = new JSDOM('')`，`createMarkdownRenderer(window)`，先断言 `DOMPurify(window).isSupported === true`（防止在无 DOM 环境下假通过）；用例 `gfm`、`raw html escaped`（见测试计划）、`links get no target and are intercepted`（生成的 `<a>` 带 `data-external`）
  - `test-chat-render-guard`：扫描 `src/renderer/chat/*.ts`，除 `markdown.ts` 外出现 `innerHTML`、`outerHTML`、`insertAdjacentHTML`、`document.write` 即失败；`markdown.ts` 中 `innerHTML` 的赋值来源必须是 `DOMPurify.sanitize(` 的返回值
  - `test-terminal-selection.mjs` 现有锁版本检查同时检查 markdown-it/dompurify/jsdom 无 `^`
- 完成定义：在 `desktop/` 下运行 `npm ci && npm run typecheck && npm test && npm run build` 全部成功（`npm test` 含 `test:chat-markdown`（jsdom 上的真实 DOMPurify）与 `test:chat-window`；构建产物里没有 jsdom）；在仓库根运行 `node .claude/skills/verify/scripts/gui-smoke.mjs`，原有用例全部 PASS
- 依赖：T7、T8

### T10 权限、计划、提问、中断、排队、斜杠菜单、模式切换
- 状态：待办
- 文件：新建 `desktop/src/renderer/chat/prompts.ts`；修改 `chat/composer.ts`、`chat/view.ts`、`i18n.ts`、`styles.css`
- 接口：
  - 使用：`permission.ts` 的 `describeSuggestion/buildAnswer/questionComplete`、`queue.ts`、`client.respond/interrupt/setMode/sendChat`
  - 提供：design 6.7、6.8 的交互；`data-testid`：`chat-perm`、`chat-perm-allow/always/deny`、`chat-perm-deny-text`、`chat-plan`、`chat-plan-opt-1/2/3`、`chat-question`、`chat-question-submit`、`chat-mode`、`chat-slash-menu`、`chat-queue-item`
- 场景：R5.1–R5.8、R6.1–R6.4、R7.1–R7.3、R8.1–R8.3、R9.1–R9.3、R10.1、R10.2、R11.1、R11.2
- 测试：逻辑已由 T8 覆盖；本任务补 `test-chat-session: prompt state transitions`（pending → submitting → resolved/cancelled/interrupted，以及 `chat_ack request_not_pending` → `handledElsewhere`）
- 完成定义：`cd desktop && npm run typecheck && npm test && npm run build`
- 依赖：T9

### T11 新建对话框「界面」一节、侧边栏状态点与通知
- 状态：待办
- 文件：修改 `desktop/src/renderer/dirpicker.ts`（「界面」卡片，默认终端；对话卡片按 `chat/availability.ts` 置灰并写原因；对话模式下显示 `-c`/bypass 的说明文案，原型场景 4）、`desktop/src/renderer/index.ts`（`startNewSession` 按 ui 分支；REST 轮询比较 `activitySeq`/`epoch`/`state` 更新未打开会话的点；对话视图忽略 `notify` 帧的 idle/waiting；通知带 tag，处理 `notification-click`；通知结果为 `fallback` 时只亮黄点、依赖主进程 Dock 弹跳 + 角标，**不自动切换会话**，d12）、`desktop/src/main/index.ts` 与 `preload.ts`（`notify(title, body, tag?)`，点击时 `webContents.send('notification-click', tag)`）、`i18n.ts`、`styles.css`；新建 `desktop/src/renderer/chat/availability.ts`、`chat/activity.ts`；测试新建 `desktop/scripts/test-chat-availability.mjs`、`test-chat-activity.mjs`
- 接口：
  - 提供：`chatAvailability(info?: MachineInfo, error?: unknown) → {enabled: boolean; reasonKey?: string; upgrade?: 'claude'|'daemon'}`；`nextDot(prev, event, {isActive, windowFocused}) → {dot, notify: boolean}`；`data-testid`：`picker-ui-terminal`、`picker-ui-chat`、`picker-ui-chat-reason`；侧边栏 `data-dot`
- 场景：R1.1、R1.3、R1.4、R16.1–R16.4、R17.2；c3 的目录选择器提示（待 c3 确认；`fs.chatTrust` 不是 `trusted`（含 `unknown`）时对话卡片置灰，原因「先用终端界面在该目录打开一次 claude 以信任此目录」）
- 测试：测试计划中标 T11 的全部用例；`test-chat-availability: workdir untrusted`（待 c3 确认；`chatTrust` 为 `untrusted` 或 `unknown` → 都置灰并给出信任提示 key，只有 `trusted` 可选）；`test-chat-activity: fallback does not switch`（通知结果 fallback 时 `nextDot` 只给黄点、不返回切换动作）；`test-i18n-parity` 自动覆盖新文案
- 完成定义：`cd desktop && npm run typecheck && npm test && npm run build`
- 依赖：T10、T6（info.chat 字段）

### T12 出错与结束状态、重载、交接、改名、删除、补发提示
- 状态：待办
- 文件：修改 `desktop/src/renderer/chat/view.ts`（结束横幅：重新启动 / 已升级重新检测 / 新建终端会话接上；回合错误卡片与重试；`chat-omitted`；`chat-resync-divider`；`existing` 提示）、`desktop/src/renderer/index.ts`（交接：回合进行中先 `confirm`，再 `openSession(machine,'',…, {ui:'terminal', handoffFrom})`；对话会话的重载按钮复用 `reloadSession`（对话会话收到 202 即显示「正在重启」，结果看 `chat_state`：`idle`+新 epoch = 成功，`restart_failed` = 失败并显示 message；不改 `rest.ts` 超时，d10）；改名/删除复用现有 REST；R2.6 ready.existing 时关闭重复视图并切换）、`i18n.ts`、`styles.css`
- 接口：
  - 使用：T7 `attach(..., {handoffFrom})`、`rest.reloadSession/renameSession/deleteSession`、`rest.info({recheck:true})`（`rest.ts` 加可选参数）
  - 提供：`data-testid`：`chat-ended`、`chat-restart`、`chat-handoff`、`chat-retry`、`chat-omitted`、`chat-resync-divider`
- 场景：R2.6（客户端提示）、R10.2（交接入口）、R12.2–R12.4（提示）、R13.1、R13.2、R13.4、R14.1、R14.2、R15.1–R15.3
- 测试：`test-chat-session: reload success keeps history`（重载后 reset 同步重建出与重载前相同的消息列表，`ended` 清空，可继续发送）；`test-chat-session: ended states`（`ended.reason` 各值 → 横幅按钮集合：`exited/daemon_restart/stopped` 有重新启动+交接；`version_unsupported` 有重新检测+交接；`restart_failed` 有重新启动+交接并显示 message；`handed_off` 只有「打开终端会话」）
- 完成定义：`cd desktop && npm run typecheck && npm test && npm run build`
- 依赖：T11

### T13 验证脚本、文档与收尾
- 状态：待办
- 文件：新建 `.claude/skills/verify/scripts/ws-chat-smoke.mjs`（启动临时 daemon：`go build` daemon 与假 claude，配置 `claude_cmd` 指向假 claude 绝对路径、`state_dir` 与 `CLAUDE_CONFIG_DIR` 指向临时目录、`login_shell:false`，并在 `$CLAUDE_CONFIG_DIR/.claude.json` 里把临时工作目录标为已信任）；修改 `.claude/skills/verify/scripts/gui-smoke.mjs`（原有终端用例继续用现在的 `/bin/bash` daemon，断言不改；**另起第二个临时 daemon**：`claude_cmd` 指向假 claude、独立端口、独立 `state_dir` 与 `CLAUDE_CONFIG_DIR`、在第二个 daemon 自己的临时 `$CLAUDE_CONFIG_DIR/.claude.json`（不是真实的 `~/.claude.json`）里把临时工作目录标为已信任；临时 `machines.json` 登记两台机器；新增对话用例：在第二台机器上新建对话会话、发 `echo`、收到回复、`perm` 允许一次；清理时两个 daemon 都关闭）、`.claude/skills/verify/SKILL.md`（对话冒烟用法）、`.claude/skills/protocol-sync/SKILL.md`（对话帧加入核对清单）、`CLAUDE.md`（c1：两条数据通路、「客户端绝不解析」限定终端模式、对话模式只支持 claude、`state_dir`、对话会话持久化模型、协议版本 3）、`docs/protocol.md`（核对）、`CHANGELOG.md`、`.devflow.yml`（invariants 新增 design 7.1 的新规则——等 c2 确认，确认前不改此文件）
- 接口：无新代码接口
- 场景：R1.2、R2.1、R2.4、R2.5、R5.5、R12.2、R14.1、R16.4（协议冒烟）；R17.1、R18.2、R19.1
- 测试：
  - `ws-chat-smoke.mjs` 用例名：`chat: create`、`chat: replay before ready`、`chat: two clients`、`chat: pending survives reconnect`、`chat: resync 50`、`chat: handoff`、`chat: daemon restart → ended`、`chat: state without hooks`、`chat: delete keeps jsonl`；每行 PASS/FAIL，失败退出码非 0；结束时清理自建 tmux 会话与临时目录
  - gui-smoke 对话用例（名字与测试计划完全一致）：`chat session created via picker`、`chat reply rendered`、`permission allow once resumes`
  - `/protocol-sync`：三处无差异
  - CLAUDE.md（R19.1 三项）：在仓库根 `grep -n "终端模式" CLAUDE.md`、`grep -n "对话模式" CLAUDE.md`、`grep -n "只支持 claude" CLAUDE.md` 均有结果，且「绝不解析」所在句含「终端模式」
- 完成定义（以下命令都在仓库根运行）：
  1. `make check` 通过。
  2. `node .claude/skills/verify/scripts/ws-chat-smoke.mjs` 全 PASS（脚本自己构建并启动带假 claude 的临时 daemon，无需参数）。
  3. 按 `.claude/skills/verify/SKILL.md` 第 1 步启动临时终端 daemon（得到 `<端口>` 与 `<测试token>`）后，`VR_TOKEN=<测试token> node .claude/skills/verify/scripts/ws-smoke.mjs 127.0.0.1:<端口> /tmp` 全 PASS（终端不变）。
  4. `node .claude/skills/verify/scripts/gui-smoke.mjs` 全 PASS（原有终端用例与上面 3 个对话用例）。
  5. `/protocol-sync` 报告三处无差异。
- 前置：V13、V20 已实测；V17（远程 Linux）、500 条补发计时、首字延迟实测交给 dev-test
- 依赖：T12

## 进度

（dev-build 每完成一个任务追加一行）

| 任务 | 完成时间 | 提交 | 测试 |
|------|----------|------|------|

## 后续

- 「不再询问」的保存位置可切换（原型里的 ← → 切换 destination）：首版按 claude 建议原样使用（H17），切换留到后续。
- 代码块语法高亮。
