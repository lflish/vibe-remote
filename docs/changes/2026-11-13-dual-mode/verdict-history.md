# 关口 B 历史结论

## 第 1 轮（b0810b3，codex）：不通过


- 结论：不通过（核心前置未闭合；完整历史缩减和未经确认的失败降级；旧接口、完成命令及测试名问题；F7单进程方案缺口）。
- 验证者：codex（独立模型）
- 对照：70场景→设计→任务/测试，见11.3表。
- 重跑的前置验证：`env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT node driver.mjs v3`，exit0，2ms确认中断，error_during_execution后同进程STILL_ALIVE，见11.2。
- 评审错误处理情况：已处理20/21（文字一致性），未完全处理#11.2，见11.5。
- 未决定、只能由用户决定的事：c2/c3；坚持缩减历史、V9/V13改验收或扩大H12例外才另需用户决定，按原spec修订无需新问。
- 备注：13任务依赖无环；11条规则皆有入口，但6条规则中的7个Go命令缺cwd，protocol-sync为手动核对；原文和代码保持不变。

### 11.1 结论与范围

**机器关口B结论：不通过。** 本次是方案验证，没有进入开发；规划的测试不等于已经通过。70个验收场景都有命名落点，但存在语义矛盾与断言缺漏，不能判定70条全部满足。两轮21条修订均有文字落点，其中20条在文字层面闭合，1条因旧接口残留未完全闭合；c3的确认状态另列，不混入文字修订计数。

阻挡项：
1. 核心协议前置验证尚未闭合：V9（规则回传与落盘）、V11/V12/V14/V18/V21/V22等仍待实测；V13（权限请求15分钟不超时）也未测。只复核或重跑V1–V8无法替代这些结果。
2. R1.5/H6/H13要求完整结构化历史，而D:379限制最近2000行或16MiB，T:405把更早历史加载放在后续。该历史缩减尚未由用户确认。
3. D:551的V9失败预案将“不再询问”缩减为setMode或退回R5.2b；D:555的V13失败预案改R5.4为“已超时”与重试。这两条改变已确认验收，不能作为机器自行采用的失败处理。
4. WithOp修订后，T:248、252、253、278仍使用旧Stop/Restart接口，与D:121、296–298冲突。
5. T13完成命令存在已运行证实的参数缺失，且测试计划与任务清单中的GUI用例名称尚未对齐，详见任务核对表。
6. F7单进程方案缺口：普通终端由daemon自动以-c先运行U时不登记占用，随后对话-c仍可claim同U并spawn，未覆盖H12要求的自动启动路径；这是方案规则的反例，非未来代码已运行复现，详见11.4。

R5.2b仅有setMode建议时是否增加第三项列为需澄清的语义备注，不作为唯一阻挡。忙时本端尚无上一条消息的发送策略、孤儿清理的退出确认、H3能力检测、斜杠命令双来源等属于需补定义/测试的风险，不能断言未来代码已发生故障。

以下D/T/S行号引用均指本节追加前的design.md前624行、tasks.md和spec.md。全节由两个独立只读核对片段及协调者实测证据汇总。核对worktree为`/Users/mac/github/vibe-remote/.devflow-tmp/verify-b0810b3`，HEAD=`b0810b3c5939a38922e696c498e79b3e10dd3e07`，核对前后已跟踪代码无改动。

### 11.2 实际证据与验证边界

协调者在probe目录仅重跑一次`env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT node driver.mjs v3`，stdout为`done v3`，退出码0。本汇总者只读取其日志和验证记录，没有再运行claude或其他V探针。

重跑记录：`/Users/mac/github/vibe-remote/.devflow-tmp/probe/gate-b/v3-rerun.ndjson`，共53行；原记录保存在同目录`v3-original.ndjson`；断言结果在`v3-verification.json`，`assertions=PASS`。

| 重跑V3行号 | 实际时间/内容 | 说明 |
|---|---|---|
| 11 | 3835ms，first delta | 已开始流式回复 |
| 35 | 5341ms，发interrupt | 中断操作 |
| 36 | 5343ms，control_response success，still_queued=[] | 2ms确认 |
| 37 | 5346ms，完整部分assistant | 中断时冲刷已生成内容 |
| 38 | 5347ms，user中断标记 | 与实际日志形状一致 |
| 39 | 5348ms，result error_during_execution、is_error=true、terminal_reason=aborted_streaming | 当前回合被中断 |
| 40 | 5348ms，下一条user | 原进程接收下一回合 |
| 51 | 9580ms，result success/STILL_ALIVE | 原会话继续工作；两回合session_id同为5deab170-2a09-49e4-abad-339c908f400e |
| 52–53 | stdin.end；10030ms exit0 | 关闭stdin后正常退出 |

原V3 L35–L40顺序为11677→11678→11679→11680→11681ms，L51为success/STILL_ALIVE、L53为exit0；与新结果相符。

| 文件 | SHA256 |
|---|---|
| driver.mjs | 3293261c9788237a6693581c3e1606d3e02e76609d864c63f175071c8b589ab9 |
| v3-original.ndjson | 43dd63b5e0f2fa8e76a9d31088b4111346b6eec12bfb5f8ccbf06ff210eb32ef |
| v3-rerun.ndjson | 6244a53a38dfbd3d8adfbbd2f59a36d2f6eb0ef2a75434adca98e97bc9c25cad |

协调者还以Python实际解析原日志并抽查以下事实，没有重跑这些V：

| 项 | 原日志证据 | 结论边界 |
|---|---|---|
| V1 | v12 L6静默前4条hook行，L7initialize、L8response；各日志init必需字段 | 支持initialize可选和init字段，不能替代新增能力缺失处理 |
| V2 | v2 L31/L70 can_use_tool字段；L32allow updatedInput，L71deny message，L43/L86success、L88exit0 | 权限信封和allow/deny形状成立；未验证V9规则真正落盘 |
| V3 | 原日志及唯一一次重跑，见上表 | 中断后原进程存活；未验证V12待答状态中断或V14排队语义 |
| V4 | v4b L1 resume UUID，L7init与L16 PINEAPPLE result同ID，L18exit0；同UUID真实JSONL16行类型顺序与evidence/probe-stream-json.md:148–150一致 | resume同会话和历史格式成立；不证明无限历史截断满足完整性 |
| V5 | L12pause、L16resume、L67积压50行、L69stdin.end、L174success、L175exit0 | 读端暂停/EOF行为成立 |
| V6 | v6a L308 ExitPlanMode+requires_user_interaction、L309allow、L353success；v6b L47 AskUserQuestion、L48updatedInput.answers、L59success | 计划批准及单选回答形状成立，其他分支仍需各自前置验证 |
| V7 | L2 set_permission_mode、L6success、L43DONE，无can_use_tool | acceptEdits切换实测成立 |
| V8 | 复核上述日志的用户消息输出 | 仅日志复核结论，不另调用模型 |

V1–V7日志均为claude 2.1.210，含成功result和exit0。其余V未运行：V9–V23（表内V20排在V23之后）均保留各自待验证状态；不能写成全部前置通过。

协调者实际运行T13原样命令`node .claude/skills/verify/scripts/ws-smoke.mjs`，退出码2，输出`usage: VR_TOKEN=<token> node ws-smoke.mjs <host:port> [workdir]`，没有访问服务。该脚本:8、11–16明确要求target/token。应在任务中写明测试daemon地址、token和workdir，例如`VR_TOKEN=<测试token> node .claude/skills/verify/scripts/ws-smoke.mjs <测试host:port> <测试workdir>`；这里仅给占位符，不写真实token。

现有代码查询均在指定worktree完成：git rev-parse HEAD如上，git status --short空；根执行go env GOMOD=/dev/null，唯一go.mod在vibe-remoted/。没有执行未来的chat测试，也没有以尚未实现的测试不存在作为失败依据。


### 11.3 全部70个场景逐行核对

| 场景 | 设计章节及行号 | 实现任务及行号 | 测试名称及计划行号 | 核对结果 |
|---|---|---|---|---|
| R1.1 默认终端 | §4.2 D150；§4.12 D337 | T6 T289；T11 T360–367 | `TestAttachWithoutUIStaysTerminal` T11；“R1.1 默认新建终端会话” T12 | 有落点 |
| R1.2 新建对话 | §4.2–4.3 D150–164；§6.2 D404–413；§4.12 D332–339 | T6 T289–304；T9 T335–346；T13 T381–391 | `TestWSChatCreateReady` T13；gui-smoke T14、T388 | 有落点，gui 测试名不一致 |
| R1.3 非 claude 置灰 | §4.9 D271；§6.2 D408；§4.12 D337 | T2 T201–228；T6 T289–304；T11 T360–367 | `TestInfoChatNotClaude` T15；`test-chat-availability: not_claude` T16；浏览器 T17 | 有落点 |
| R1.4 版本过旧置灰 | §1.7 D61–67；§4.9 D271 | T2 T205、T224；T6 T289–304；T11 T360–367 | `TestInfoChatTooOld` T18；`test-chat-availability: old daemon / too old` T19；浏览器 T20 | 有落点 |
| R1.5 `-c` 完整历史 | §5.3 D375–379；§6.2 D409–411；§4.4 D179–183 | T4 T258–271；T5 T274–286；T8 T324–332 | `TestCreateContinueResumesLatest` T21；`TestSyncHistoryBeforeCutoff` T22；完整历史浏览器/真机 T23 | **与历史上限矛盾，见 F1** |
| R1.6 bypass 固定 | §4.6 D220–221；§4.7 D235；§6.2 D411 | T3 T232–254；T10 T349–357 | `TestBypassLocksMode` T24；“R1.6 bypass 固定” T25 | 有落点，真实行为依赖 V18 |
| R1.7 worktree/flag | §4.2 D155；§6.2 D408–412 | T5 T276–280 | `TestChatWorktreeAndFlags` T26 | 有落点 |
| R2.1 ready 前重放 | 第2节 D112；§4.2 D155；§6.2 D407 | T5 T280–281；T7 T311–317；T13 T385–387 | `TestChatCreateReplaySameID` T27；`chat: replay before ready` T28；客户端重放 T317 | 有落点 |
| R2.2 重载先停旧进程 | 第2节 D114–123；§4.9 D262；§6.4 D425 | T3 T243；T5 T279–281；T6 T301 | `TestReloadWaitsForOldProcess` T29；`TestSingleProcessRestart` T243；`TestReloadChatReturns202` T301 | 有落点 |
| R2.3 交接先停进程 | §6.4 D425；§6.5 D431–434 | T6 T294–300 | `TestHandoffStopsChatFirst` T30 | 有落点 |
| R2.4 两桌面同进程 | 第2节 D112–117；§4.5 D201；§4.7 D232；§5.2 D369 | T6 T295–296；T13 T385–387 | `TestTwoClientsShareProcess` T31；`chat: two clients` T32 | 有落点 |
| R2.5 daemon 重启 | §1.1 D15；§6.6 D441–443；§5.3 D377 | T4 T260–267；T5 T279–281；T13 T387 | `TestLoadChatsMarksDaemonRestart` T33；`TestOrphanCleanup` T34；`chat: daemon restart → ended` T35 | 有落点；孤儿退出等待需补定义/测试，见 F4 |
| R2.6 两个 `-c` 同对话 | 第2节 D114–117；§4.3 D166；§6.2 D409 | T5 T279–281；T12 T372、T376 | `TestContinueReusesRunningSession` T36；并发用例 T37 | 有落点 |
| R3.1 发送及流式 | §4.5 D193–201；§4.7 D232；§4.12 D320–321、D331–335 | T3 T239–241；T8 T329–331；T9 T341–346 | `TestSendEchoAndStream` T43；`test-chat-session: echo → stream → result` T44 | 有落点 |
| R3.2 Markdown | 第3节 D131–135；§4.12 D331 | T9 T337、T340–346 | `test-chat-markdown: gfm` T45；“R3.2 Markdown 与复制按钮” T46 | 有落点 |
| R3.3 HTML/脚本及外链 | 第3节 D131–134；§4.12 D331、D337；§7 D486 | T9 T337、T343–345 | `test-chat-markdown: raw html escaped` T47；`test-chat-render-guard` T48；浏览器 T49 | 有落点 |
| R3.4 空输入 | §4.7 D232；§6.8 D457 | T3 T239–241；T8 T329–331；T9 T341 | `TestSendRejectsEmpty` T50；`test-chat-queue: empty not sent` T51 | 有落点 |
| R4.1 Read/Grep | §4.12 D320–323、D333 | T8 T326、T329–331；T9 T337、T341 | `test-chat-session: tool pairing` T52；“R4 工具块” T54 | 有落点 |
| R4.2 Bash | §4.12 D320–321、D333 | T8 T329–331；T9 T337、T341 | `test-chat-session: tool pairing` T52；“R4 工具块” T54 | 有落点 |
| R4.3 Edit/Write diff | §4.12 D323、D333 | T8 T326、T329–331；T9 T337、T341 | `test-chat-diff（移植 50 行用例）` T53；“R4 工具块” T54 | 有落点 |
| R4.4 工具错误 | §4.12 D320–321、D333 | T8 T329–331；T9 T341 | `test-chat-session: tool pairing` T52；“R4 工具块” T54 | 有落点 |
| R5.1 允许一次 | §4.7 D233；§6.7 D449 | T3 T239–241；T10 T353–356 | `TestRespondAllowOnce` T55 | 有落点 |
| R5.2 允许并保存规则 | §4.7 D233；§6.7 D449；§7 D484 | T3 T239–241、T255；T8 T329–331；T10 T353–355 | `TestRespondAlwaysWithSuggestion` T56；`test-chat-permission: describeSuggestion` T57；真机落盘 T58 | **V9 失败回退违背场景，见 F2** |
| R5.2b 无保存建议 | §6.7 D449 | T8 T329–331；T10 T353–355 | `test-chat-permission: no suggestions` T59 | 有落点；仅有setMode时第三项语义需澄清，见 F2 |
| R5.3 拒绝并说明 | §4.5 D202；§4.7 D233；§6.7 D449 | T3 T239–241；T10 T353–355 | `TestRespondDenyWithMessage` T60 | 有落点 |
| R5.4 断线期间等待 | §4.6 D222；§5.2 D365、D369；§6.4 D425 | T3 T239–241、T250；T13 T392 | `TestPendingWaitsWithoutClient` T61；V13 D555 | **前置未证实，且失败方案擅改需求，见 F6** |
| R5.5 重连恢复权限 | §4.4 D171–183；§4.6 D222；§6.7 D453 | T6 T295–296；T10 T355；T13 T387 | `TestResyncRestoresPending` T62；`chat: pending survives reconnect` T63 | 有落点 |
| R5.6 回答未送达断线 | §4.7 D233；§6.7 D453 | T3 T249；T8 T329–331；T10 T356 | `test-chat-session: submitting reverts` T64；浏览器 T65；`TestRespondQueueFullKeepsPending` T132、T249 | 有落点 |
| R5.7 重复回答 | §4.5 D202；§4.7 D233、D238；§6.7 D453 | T3 T239–241；T6 T295–296；T10 T356 | `TestRespondFirstWins` T66；`TestTwoClientsRespondRace` T67；浏览器 T68 | 有落点 |
| R5.8 请求取消 | §4.5 D195、D202；§6.7 D453 | T3 T239–241；T8 T329–331；T10 T356 | `TestCancelRequestResolves` T69；`test-chat-session: cancelled` T70 | 有落点，真实取消形状尚待 V19 |
| R6.1 批准 acceptEdits | §4.7 D233；§6.7 D450 | T3 T239–241、T246、T255；T10 T353–355 | `TestPlanApproveSetsMode` T71、T139；计划浏览器 T74 | 有落点，关键时序尚待 V22 |
| R6.2 批准手动 | §4.6 D220；§6.7 D450 | T3 T239–241；T10 T353–355 | `TestPlanApproveManual` T72；计划浏览器 T74 | 有落点 |
| R6.3 继续完善 | §6.7 D450；V11 D553 | T3 T239–241、T255；T10 T353–355 | `TestPlanReviseStaysPlan` T73；计划浏览器 T74 | 有落点，真实模式保持尚待 V11 |
| R6.4 断线计划 | §4.6 D222；§6.7 D450、D453 | T6 T295–296；T10 T355 | `TestResyncRestoresPending` T62 | **计划专用恢复断言未明确，见 F5** |
| R7.1 单选、多选 | §6.7 D451；§4.12 D322 | T3 T239–241；T8 T328–331；T10 T353–355 | `test-chat-permission: buildAnswer question` T75；`TestAskAnswersRoundTrip` T76；表单浏览器 T78 | 有落点，多选真实格式尚待 V10 |
| R7.2 自填答案 | §6.7 D451 | T8 T328–331；T10 T353–355 | `test-chat-permission: buildAnswer question` T75 | 有落点，自填真实格式尚待 V10 |
| R7.3 未答完禁止提交 | §6.7 D451 | T8 T328–331；T10 T353–355 | `test-chat-permission: questionComplete` T77；“R7 提问表单” T78 | 有落点 |
| R8.1 生成中中断 | §4.7 D234；§4.12 D320、D335 | T3 T239–241；T8 T329–331；T10 T353–355 | `TestInterruptStopsTurn` T79；`test-chat-session: interrupted result` T80；浏览器 T83 | 有落点 |
| R8.2 等权限时中断 | §4.5 D202；§4.7 D234 | T3 T239–241、T245、T255；T10 T355 | `TestInterruptResolvesPending` T81；队列满 T134、T245 | 有落点，真实控制顺序尚待 V12 |
| R8.3 空闲 Esc | §4.7 D234；§4.12 D335 | T3 T239–241；T10 T355 | `TestInterruptIdleNoop` T82；浏览器 T83 | 有落点 |
| R9.1 忙时排队 | §6.8 D457–458 | T8 T328–331；T10 T353–355 | `test-chat-queue` T84；“R9 排队” T85；own-result 用例 T145、T331 | 有落点；本端首发门控需补定义/测试，见 F3 |
| R9.2 撤回排队 | §6.8 D457 | T8 T328–331；T10 T353–355 | `test-chat-queue` T84；“R9 排队” T85 | 有落点 |
| R9.3 中断退回队列 | §6.8 D459 | T8 T328–331；T10 T353–355 | `test-chat-queue` T84 | 有落点 |
| R10.1 斜杠列表 | §4.6 D223；§4.12 D321、D335 | T8 T328–331；T10 T353–355 | `test-chat-session: slash commands from state` T86；浏览器 T88 | 有落点；initialize 与 init 列表关系需明确，见备注 |
| R10.2 终端专用命令 | §6.8 D461 | T8 T328–331；T10 T355；T12 T376 | `test-chat-queue: terminal-only command` T87；浏览器 T88 | 有落点 |
| R11.1 模式切换 | §4.6 D220；§4.7 D235；§4.12 D335 | T3 T239–241；T10 T353–355 | `TestSetModeUpdatesState` T89；浏览器 T91 | 有落点 |
| R11.2 bypass 只读 | §4.6 D221；§4.7 D235 | T3 T239–241；T10 T355 | `TestBypassLocksMode` T90；浏览器 T91 | 有落点 |
| R12.1 断线保活 | §1.1 D15；§5.2 D371；§6.4 D425 | T3 T238；T6 T295–296 | `TestChatDisconnectKeepsProcess` T92；`TestDrainWithoutSubscribers` T154 | 有落点 |
| R12.2 有序补发 | §1.3 D31；§4.4 D177–183；§6.3 D417–421 | T3 T238；T6 T295–296；T7 T311–315；T12 T376；T13 T387 | `TestResyncIncremental50` T93；`chat: resync 50` T94；500条计时 T95 | 有落点；计时起点见备注 |
| R12.3 缓冲超限省略 | §4.4 D178；§5.2 D363；§6.3 D417 | T3 T239–241；T8 T329–331；T12 T372、T376 | `TestRingOverflowReset` T96；`test-chat-session: omitted marker` T97 | 有落点 |
| R12.4 流式中途断线 | §1.3 D31；§5.2 D364；§6.3 D419–420 | T3 T239–241；T8 T329–331；T12 T376 | `TestResyncMidStreamTail` T98；`test-chat-session: preview merged by message.id` T99 | 有落点 |
| R13.1 回合错误重试 | §4.12 D320；§7 D469 | T8 T329–331；T12 T372、T376 | `test-chat-session: turn error` T101；“R13.1 重试” T102 | 有落点 |
| R13.2 真退出与恢复 | §4.5 D206；§4.6 D224；§4.10 D283；§7 D470 | T3 T239–241；T6 T295–296；T7 T318；T12 T372–377 | `TestCrashEmitsExitAndEnded` T103；浏览器 T104；`test-chat-client: exit keeps session` T318 | 有落点 |
| R13.3 断线不发 exit | §6.4 D425 | T6 T295–296 | `TestChatDisconnectKeepsProcess` T92 | 有落点 |
| R13.4 init 版本不支持 | §4.10 D283；§6.1 D402；§7 D470 | T3 T239–241；T12 T372–377 | `TestInitVersionTooOldEnds` T105；浏览器 T106 | 有落点 |
| R14.1 交给终端 | §1.5 D49–52；§6.5 D429–435 | T2 T205、T218；T6 T294–300；T12 T372–376；T13 T387 | `TestHandoffCreatesTerminalWithResume` T107；`chat: handoff` T108 | 有落点 |
| R14.2 运行中交接确认 | §6.4 D425；§6.5 D431、D437 | T6 T295–296；T12 T372 | `TestHandoffInterruptsRunningTurn` T109；浏览器 T110 | 有落点 |
| R15.1 重命名持久、多端 | §4.9 D261；§5.1 D354；§4.12 D337 | T4 T265；T5 T279–281；T12 T372、T376 | `TestChatRenamePersists` T111 | 持久化有断言；其他桌面显示新名未明确验证，见 F5 |
| R15.2 删除保留 JSONL | §4.9 D260；§6.4 D425 | T5 T279–281；T12 T372、T376；T13 T387 | `TestChatDeleteKeepsJSONL` T112；`chat: delete keeps jsonl` T387 | 有落点；协议冒烟名称未进测试计划 |
| R15.3 重载保留历史续聊 | §1.5 D52；§4.4 D185；§4.9 D262；§5.3 D377 | T3 T243、T252；T5 T279–281；T6 T301；T12 T372 | `TestReloadWaitsForOldProcess` T29；`TestReloadRefusedWhenHandedOff` T113；`TestReloadChatReturns202` T301 | 成功重载后的历史与续聊断言不完整，见 F5 |
| R16.1 灰点及打开清除 | §4.8 D248–249；§4.12 D337、D339 | T11 T362–366 | `test-chat-activity` T114 | 有落点 |
| R16.2 回合结束绿点 | §4.8 D247；§6.1 D395；§4.12 D337 | T11 T362–366 | `test-chat-activity` T114 | 有落点 |
| R16.3 黄点与通知 | §4.6 D222；§4.12 D337 | T11 T362–366 | `test-chat-activity` T114；通知可用浏览器 T115；通知降级浏览器 T116 | 有落点，降级不自动切会话与已确认场景一致 |
| R16.4 无 hook 状态 | §1.2 D23；§4.6 D219–226；§4.8 D247–249 | T11 T362–365；T13 T385–387 | `chat: state without hooks` T117 | 有落点 |
| R17.1 原测试不改断言 | §4.1 D144；§7.1 D493–494 | T1 T192–198；T5 T286；T6 T304；T9 T346；T13 T383、T391 | `make check + gui-smoke 原有用例` T119；黄金帧 T175 | 有落点；T13 终端冒烟命令不可运行，见 F8 |
| R17.2 新桌面连旧 daemon | §4.9 D271；§4.2 D150 | T7 T318；T11 T365–367 | `test-chat-availability: proto 2` T120；旧 daemon 浏览器 T121 | 有落点 |
| R17.3 旧桌面连新 daemon | §4.1 D144；§4.2 D150；§4.10 D277 | T1 T192–197；T5 T279；T6 T295–296 | `TestTerminalAttachToChatIsUIMismatch` T122；`TestTerminalFramesUnchangedV3` T175、T195 | 有落点 |
| R18.1 proto=3 | §4.1 D144 | T1 T189–196 | `TestInfoAndReadyProto3` T123、T196 | 有落点 |
| R18.2 三处一致 | §4.1 D144；§7.1 D495 | T1 T187–191；T13 T383、T389 | `/protocol-sync` T124、T389 | 有落点 |
| R19.1 CLAUDE.md | §8 D533；总体结构 D71–94 | T13 T383、T390 | `grep CLAUDE.md` T125；`grep -n "对话模式" CLAUDE.md` T390 | 修改内容有落点；单条 grep 不足以核实全部三项描述 |

#### 行为矛盾、断言缺漏与待补风险

| 编号 | 发现 | 依据与具体影响 |
|---|---|---|
| F1 | 完整历史被截断 | spec R1.5 L98、H6 L465、H13 L472要求 `-c` 和 daemon 重启后重建完整结构化历史。D379 设2000行/16MiB上限，T269还要求3000行只返回最后2000行，T405将更早历史加载推迟。这些不是 H2补充 L477允许“无补发位置的新客户端只拿缓冲”的情形：`-c` 和重启后加载有独立完整历史要求。当前浏览器用例 T23未包含超限历史，无法发现此矛盾。 |
| F2 | 无保存建议时仍显示额外权限选项；落盘失败回退不满足需求 | R5.2b L191–194要求无可保存建议时只有允许/拒绝。D449在“只有 setMode 建议”时增加“本会话内允许所有编辑”；该选项不保存规则，但session建议是否属于R5.2b语义需澄清；该争议作为备注，不作唯一阻挡。D580的假 claude `mode` 分支允许直接构造该情况，但T59只测试“完全无建议”，漏掉“有建议但不可保存”。此外V9 D551规定落盘失败就只保留setMode或走R5.2b，无法满足已确认R5.2的远程规则落盘要求。 |
| F3 | 已知忙时，本端首次发送如何排队没有定义 | R9.1要求claude忙时两条输入均先排队。D457明确不看全局status，只按“本端上一条已回显并配到result”门控。另一台桌面已启动长回合、本端尚无上一条消息时，初始条件没有定义，可能直接发送第一条；这是初始状态未明确的方案风险，未运行复现，不断言未来代码已发生问题。T145/T331只处理本端已有未完成消息与别端结果穿插，没有覆盖此首发状态。需明确“已知忙”与H16允许的同时发送竞态的区别并补用例。 |
| F4 | 重启后的孤儿进程清理没有确认退出步骤 | R2.5要求打开旧会话时旧claude已经不在。D441对遗留进程仅发SIGTERM，随即标记ended，没有像正常停止D425那样等退出、超时SIGKILL再确认。这是退出确认未明确的方案风险；若遗留进程忽略SIGTERM，后续重启可能与它并存。未运行复现，不断言未来实现已发生问题，应补退出等待和抗SIGTERM测试。`TestOrphanCleanup` T34只写“被结束”，没有明确定义抗SIGTERM与确认退出断言。 |
| F5 | 部分测试覆盖共享基础机制，未覆盖完整场景 | T62把R5.5/R6.4共用一个测试，但步骤只有普通can_use_tool恢复，未明确恢复ExitPlanMode全文与三个选项；T111只验证重建Manager后名称保留，未验证另一桌面显示新名；R15.3的直接计划T113是拒绝重载，T29检查进程顺序、T301检查202/epoch/idle，没有明确断言成功重载后的历史含工具块且可继续对话。 |
| F6 | 前置实测不足，且失败处置擅自改变已确认场景 | V9/V10/V11/V12/V13/V14/V18/V19/V22仍待验证，分别关系到落盘、答案格式、计划模式、中断、权限等待等必要行为。应把“未证实”与“已有覆盖”分别记录。特别是V13 D555要求超时后直接把R5.4改为“已超时并重试、记decisions”，这修改了spec L202“不超时”的验收条件，不能仅由机器记录决定。 |

斜杠列表还有一处需明确：R10.1要求列表来自`system/init.slash_commands`；D223以`initialize.commands`为主要来源、init仅作失败回退。T86只测试已构造好的`chat_state.slashCommands`，不能证明两种来源的可用命令一致。这是来源及验证口径不清，不宜仅凭命名判定实现错误。

#### 测试名称和计划同步

不完全一致。T3/T5/T6/T8/T11通过“测试计划中标本任务的全部用例”继承测试名称，因此不能把计划里的名字未在任务正文重复列出当作遗漏。但以下差异是真实的：

| 位置 | 不一致 |
|---|---|
| T14与T388 | 测试计划写gui-smoke“`chat: 新建对话会话并收到回复`”，任务列`chat session created via picker`、`chat reply rendered`、`permission allow once resumes`三个名称。 |
| T387 | `chat: create`、`chat: delete keeps jsonl`没有作为协议冒烟名称进入测试计划。 |
| T197等 | 任务新增了22个Go测试名称，测试计划没有列出，详见下面清单。 |
| T319、T331、T343、T356、T366、T377 | 任务新增`chat_ack routed`、`fixture lines`、`own-result gating`之外的部分细化用例、`links get no target and are intercepted`、`prompt state transitions`、`workdir untrusted`、`fallback does not switch`、`ended states`等，未全部同步到测试计划。 |
| T390与T125 | 计划的文档检查要求三项描述，任务实际grep只查“对话模式”，名称及断言口径均未完全对齐。 |

任务正文独有的22个Go名称如下；这些是计划未同步，不代表任务没有测试：

| 任务 | 测试计划未列出的名称 |
|---|---|
| T1 | `TestProtocolChatFramesJSON`（T197） |
| T2 | `TestParseNotClaude`（T215）、`TestWorkdirTrusted`（T220）、`TestCommandFromConfigOnly`（T222）、`TestParseVersion`（T223）、`TestProbeCachesAndRecheck`（T224）、`TestFakeClaudeEcho`（T225）、`TestFakeClaudeMatchesProbe`（T226）、`TestNoCredentialAccess`（T227） |
| T3 | `TestPendingSurvivesRingEviction`（T242）、`TestSingleProcessRestart`（T243）、`TestExitCallbackNoSessionLock`（T244）、`TestStopIsIdempotent`（T248）、`TestStopTimings`（T253） |
| T4 | `TestHistoryFiltersSidechainAndMeta`（T268）、`TestHistoryLimit`（T269）、`TestStorePermissions`（T270） |
| T5 | `TestListMergesChatAndTmux`（T282）、`TestOwnersReleasedOnExit`（T284）、`TestLoadChatsReclaimsHandoff`（T285） |
| T6 | `TestHandoffReplayNoSelfWait`（T298）、`TestReloadChatReturns202`（T301） |

#### 完成命令与依赖核查

- T1–T8、T10–T12都有可执行的主要验证命令；额外的提交、原断言保留等完成条件并不因为不是命令就构成缺陷。
- **F8：T13 T391的`node .claude/skills/verify/scripts/ws-smoke.mjs`缺必需参数。** 现有[ws-smoke.mjs](/Users/mac/github/vibe-remote/.devflow-tmp/verify-b0810b3/.claude/skills/verify/scripts/ws-smoke.mjs:8)要求`VR_TOKEN`和`host:port`。我仅运行了这个缺参调用，它在入口校验退出，没有连接daemon或启动claude；实际退出码为 **2**，输出`usage: VR_TOKEN=<token> node ws-smoke.mjs <host:port> [workdir]`。应给出临时终端daemon、token、端口的完整调用方式。
- T13的新`ws-chat-smoke`命令使用`VR_TOKEN=…`占位符，同时任务要求脚本自行启动临时daemon，需要明确token由脚本生成还是调用方传入。
- T9 T346将`&& npm run build`拆成单独代码片段；单独执行语法检查返回 **1**，`parse error near '&&'`。这是书写歧义，应合并为完整命令。另外gui脚本在仓库根目录，需明确从`cd desktop`返回根目录后运行。
- 补发计时T95从重连`ready`开始，未计入重连请求到ready的阶段。spec L452没有细化计时起点，应统一测量口径；“首字延迟只实测记录、不硬卡”与spec一致，**没有问题**。
- 依赖解析覆盖13个任务，未发现环。有效拓扑顺序为：`T1 → T2 → T7 → T3 → T8 → T4 → T9 → T5 → T10 → T6 → T11 → T12 → T13`。这只是一个合法排序，不表示相邻任务都有直接依赖。

场景核对者只读核对及验证脚本入口校验，没有运行claude或V探针；本节追加由汇总者按明确授权执行。


### 11.4 全部13任务的依赖、完成命令和测试名检查

| 任务 | 依赖及原行号 | 主要完成命令及原行号 | 名称及断言口径核对 |
|---|---|---|---|
| T1 | 无，T:199 | T:198：cd vibe-remoted && go test ./internal/protocol/... ./internal/server -run 'Proto3\|ChatFramesJSON\|TerminalFramesUnchangedV3'；cd desktop && npm run typecheck；make check | TestInfoAndReadyProto3在T:123、196一致；黄金帧测试在T:175、195一致；TestProtocolChatFramesJSON仅任务T:197新增 |
| T2 | T1，T:230 | T:228：cd vibe-remoted && go test -race ./internal/chat/...；go vet ./... | T:214–227有具体测试；部分新增名字未同步计划只是备注；V23与c3尚未闭合 |
| T3 | T2，T:256 | T:254：cd vibe-remoted && go test -race -count=3 ./internal/chat/... | 继承计划标T3用例；T:248、252、253旧Stop/Restart接口未清理；V9/V11/V12/V14/V18/V21/V22未测 |
| T4 | T3，T:272 | T:271：cd vibe-remoted && go test -race ./internal/chat/... | T:269截断测试与完整历史验收矛盾；孤儿退出确认须补定义/断言 |
| T5 | T4，T:287 | T:286：cd vibe-remoted && go test -race ./internal/session/... ./internal/config/...；现有manager_test/idempotent_test断言不改 | 继承计划标T5用例；store/owners并发验证具体；其他桌面显示新名称断言未明确 |
| T6 | T5，T:305 | T:304：cd vibe-remoted && go test -race ./...；现有ws_test/contract_test/hardening_test断言不改 | 继承标T6用例；T:301验证202幂等；计划恢复全文三选项、成功重载历史+续聊断言未明确 |
| T7 | T1，T:322 | T:321：cd desktop && npm run typecheck && npm test | T:314–320有同步、重连、重放、exit、ack用例；部分细化名字未同步计划 |
| T8 | T1、T2，T:333 | T:332：cd desktop && npm run typecheck && npm test | 继承标T8用例；T:331有own-result/stale-result配对；本端首次发送而全局已忙需补定义/测试；V10未测 |
| T9 | T7、T8，T:347 | T:346：cd desktop && npm ci && npm run typecheck && npm test；后段单独写&& npm run build；node .claude/skills/verify/scripts/gui-smoke.mjs | 真实DOMPurify及渲染守卫具体；build片段书写歧义、GUI须从仓库根运行 |
| T10 | T9，T:358 | T:357：cd desktop && npm run typecheck && npm test && npm run build | T:356有prompt transitions；复用T8不等于计划全文三选项恢复断言已满足；setMode第三项需澄清 |
| T11 | T10、T6，T:368 | T:367：cd desktop && npm run typecheck && npm test && npm run build | 继承标T11用例；T:366有untrusted/fallback；c3信任小分支待用户 |
| T12 | T11，T:379 | T:378：cd desktop && npm run typecheck && npm test && npm run build | T:377有ended states按钮集合；成功重载后历史与继续发消息不能由ended测试替代 |
| T13 | T12，T:393 | T:391：make check；VR_TOKEN=… node .claude/skills/verify/scripts/ws-chat-smoke.mjs；node .claude/skills/verify/scripts/ws-smoke.mjs；node .claude/skills/verify/scripts/gui-smoke.mjs | ws-smoke缺target/token，实跑exit2；GUI计划T:14与任务T:388名字不同；T:390单项grep不能验证R19三项全文；c2只暂停登记 |

逐项依赖解析有13个节点，无环；合法拓扑顺序为T1→T2→T7→T3→T8→T4→T9→T5→T10→T6→T11→T12→T13，相邻节点不必有直接依赖。Go命令cwd为vibe-remoted/，npm为desktop/，make和.claude脚本为仓库根。任务新增22个Go测试未同步计划只是计划完整性备注，不据此认定没有覆盖；共有测试名称也不自动证明共有场景的全部断言成立。

#### F7：普通终端先运行的单进程方案反例

R2与S:471的H12按claude会话U保证唯一，H12只排除终端中用户自行手敲claude -c。D:115、465规定daemon自动新建的普通终端只查claudeOwners、不claim或登记U：普通终端通过配置/flag的-c先启动U时，没有运行中的chat，检查通过且owners仍为空；随后对话-c在D:409解析同U，claim成功并在D:411 spawn。按这套规则，两条自动启动路径可指向同U。反向“chat先运行→终端检查忙”不能覆盖这个顺序；并发check→claim也缺原子保证。

现有源码支持路径前提：config.go:308–322拼勾选flag，:329–338为reload拼continue/-c；manager.go:143–164按vibe会话id幂等，:192–212构造NewRunner，:222–225随后登记；runner.go:204–226的NewRunner立即start，:327执行PTY启动。不同vibe会话id不按claude U互斥。这是方案反例及需补定义/测试项，没有运行额外V，也不宣称未来代码已复现。需补daemon自动终端身份/占用保证；如果改为扩大已确认H12豁免范围，才由用户确认。#11.5文字承接计数仍为闭合，语义保证另行核对。


### 11.5 两轮21项修订逐条核对

decisions.md:26 的第一轮15项含11条明确错误及 d10/d11/d12/c3；decisions.md:31 的第二轮有10条明确修订。以下21条均有具体落点，20条在文字层面闭合，#11.2未完全闭合。c3的用户确认独立列出，不混入这21条的文字闭合计数。

| 项目 | 修订内容 | 设计具体行号与文字 | 任务具体行号与承接 | 结论 |
|---|---|---|---|---|
| #10原1 | 占用表、操作互斥 | D:114–123：claudeOwners、先claim后spawn、WithOp、锁顺序 | T:237、243–244、279，T:37–40并发测试 | 闭合；新版接口残留另计#11.2 |
| #10原2 | jsdom真实净化 | D:134、331：jsdom 29.1.1、可注入window | T:337、343：真实DOMPurify、先断言isSupported | 闭合 |
| #10原3 | 无JSONL用session-id | D:52、411、432：有记录resume，无记录session-id | T:205、218、252：统一命令签名、有无记录测试 | 闭合 |
| #10原4 | 回答先入队 | D:233：入队成功才删待答；满则chat_busy | T:132、249：TestRespondQueueFullKeepsPending | 闭合 |
| #10原5 | 同步结束后位置有效 | D:155：结束chat_state后才报告位置；中途断线清空 | T:311、314–316：发送时取位置、中断reset、保留ui | 闭合 |
| #10原6 | 计划批准后切模式 | D:450：等system/status或tool_result；5秒兜底 | T:71、139、255：最终模式测试、V22前置实测 | 闭合 |
| #10原7 | outstanding自愈 | D:234、369、457：still_queued、看门狗、本端结果配对 | T:137–138、145、250–251、331 | 闭合 |
| #10原8 | 持久化单路径最新者胜 | D:125、354：唯一persist协程、最新快照槽 | T:141、279、283：最终文件等于最终内存状态 | 闭合 |
| #10原9 | 展开~ | D:476：引号前展开、两条启动路径 | T:206、219：ExpandHome及真正启动测试 | 闭合 |
| #10原14 | 黄金帧先于协议改动 | D:612 | T:192、195、198、296：先独立生成提交、以后只比不写 | 闭合 |
| #10原15 | 补非功能测试 | D:613 | T:95、118、392：500条≤2000ms；首字延迟各测5次 | 闭合 |
| #11.1 | 重启不释放占用 | D:115、117、298、425：restart保留U全程占用 | T:243：并发-c时owner不变、无VIOLATION | 闭合 |
| #11.2 | 不可重入WithOp | D:118、121、123、296–298：一次WithOp、Locked内部接口、退出回调无Session锁 | T:234、237、244、279、294有新接口；T:248、252、253、278仍写Stop/Restart | 未完全闭合 |
| #11.3 | 交接不二次beginCreate | D:308、431、433：createTerminalLocked | T:294、298：不再beginCreate、测试自己等待问题 | 闭合 |
| #11.4 | reloading幂等202 | D:262：同步标志、后台重查、结束清标志 | T:279、301：重复请求只启动一次 | 闭合 |
| #11.5 | 仅交接终端持有U | D:115、117、262、434、465：普通终端只检查、交接用固定U | T:41–42、279、294、300、303 | 闭合 |
| #11.6 | unknown未信任、测试造文件 | D:263、408、478–483：统一语义和三个测试环境 | T:208–209、220、302、365–366、383 | 闭合；GUI文件路径见备注，c3另列 |
| #11.7 | 中断先入队 | D:233–234：N+1一次入队；失败不改待答 | T:134–135、245–246：容量不足、延后模式入队失败 | 闭合 |
| #11.8 | 迟到result标vr_stale | D:205、369：ignoreResults吸收、不减成负、keep_alive不计活动 | T:133、247、331：daemon标记、客户端不配对 | 闭合 |
| #11.9 | T2/T3/T4依赖理顺 | D:103、302–309：纯transcript函数、统一命令签名 | T:203、205、207；T:236、256；T:260–264、272 | 闭合 |
| #11.10 | 黄金sessions只比测试条目 | D:624 | T:192：本测试临时workdir过滤、按id排序 | 闭合 |

旧接口残留的明确改法：T:248、253通过WithOp调StopLocked，T:252通过WithOp调RestartLocked；T:278使用列表统一为chat.Start、Session.WithOp、OpHandle.StopLocked/RestartLocked，不另造包装接口解释旧文字。

| 第一轮其余4项 | 记录 | 设计 | 任务 | 状态 |
|---|---|---|---|---|
| d10原11 | decisions:27 | D:262、425：202、广播结果、2s/1s/1s | T:279、301、372 | 已展开 |
| d11原12 | decisions:28 | D:465、279：终端continue冲突检查、fatal错误 | T:41、279、303 | 已展开 |
| d12原13 | decisions:29 | D:337：降级不自动切换 | T:116、362、366 | 已展开 |
| c3原10 | decisions:30 | D:408、477–483：信任准入 | T:208–220、229、302、365–366 | 方案已展开，待用户 |

### 11.6 全部11条不变规则检查入口

共11条，9新增、2已有。所有行有入口，但protocol-sync是手动skill，6条规则中的7条Go命令省略cwd，不能直接从仓库根执行。

| D行 | 规则 | 文档检查入口 | cwd/限制 |
|---|---|---|---|
| 493 | 终端纯字节透传 | cd desktop && npm test | 仓库根 |
| 494 | v2帧不变 | cd vibe-remoted && go test -race ./internal/server -run TestTerminalFramesUnchangedV3 | 仓库根 |
| 495 | 协议三处一致 | /protocol-sync skill | 手动核对，不是shell自动检查 |
| 496 | 同U最多一个进程 | cd vibe-remoted && go test -race ./internal/chat -run TestSingleProcess && go test -race ./internal/session ./internal/server -run 'TestReloadWaitsForOldProcess\|TestChatCreateReplaySameID\|TestContinueReusesRunningSession\|TestConcurrentContinueCreatesOneProcess\|TestRestartRefusedWhenUResumedElsewhere\|TestHandoffVsReloadOneWins\|TestReloadVsDeleteSerialized\|TestTerminalContinueBusyWhenChatOwns' | 仓库根；第二段继承模块cwd；表格内\|是Markdown转义，shell正则使用普通竖线 |
| 497 | 断开不停进程 | go test -race ./internal/server -run TestChatDisconnectKeepsProcess | vibe-remoted/ |
| 498 | 待答不淘汰 | go test -race ./internal/chat -run TestPendingSurvivesRingEviction | vibe-remoted/ |
| 499 | 规则来自建议 | go test -race ./internal/chat -run TestRespondRejectsForeignRule | vibe-remoted/ |
| 500 | 服务端拼命令 | go test ./internal/chat -run TestCommandFromConfigOnly；go test ./internal/server -run TestAttachIgnoresCommandFields | 两条均在vibe-remoted/ |
| 501 | 模型输出净化 | cd desktop && npm run test:chat-markdown && npm run test:chat-render-guard | 仓库根；真实jsdom DOMPurify |
| 502 | 不注入主token | go test ./internal/session -run TestChatEnvHookTokenOnly | vibe-remoted/ |
| 503 | 不读凭据 | go test ./internal/chat -run TestNoCredentialAccess | vibe-remoted/ |

实际从核对worktree根执行go env GOMOD=/dev/null；rg --files -g go.mod -g go.work仅vibe-remoted/go.mod。现有Makefile:17–27含全包Go race和npm test，T:309、326、337、346安排接入新TS测试；protocol-sync不在make check中自动执行。

### 11.7 现有代码事实核对

核对worktree=/Users/mac/github/vibe-remote/.devflow-tmp/verify-b0810b3，HEAD=b0810b3c5939a38922e696c498e79b3e10dd3e07，核对前后git diff --name-only HEAD及git status --short均无输出。本核对未运行claude或V探针。

| 查询事实 | 实际文件行号 | 结论 |
|---|---|---|
| REST超时 | desktop/src/renderer/rest.ts:8–11、63–75 | 超时确为8000ms；202属于成功响应 |
| beginCreate等待 | vibe-remoted/internal/session/manager.go:233–256 | 同id占位存在则等通道，二次beginCreate会自己等待 |
| 默认reload命令 | vibe-remoted/internal/config/config.go:329–338 | 显式覆盖优先，否则continue参数，最后-c |
| 当前GUI仅单daemon | .claude/skills/verify/scripts/gui-smoke.mjs:156–173 | 当前构建启动单daemon、登记单machine，T13已安排另起第二个 |
| 通知降级 | desktop/src/main/index.ts:200–237、114 | Dock弹跳/角标成立，聚焦清角标；现有点击只show/focus，需新增tag回传 |
| 现有锁顺序 | vibe-remoted/internal/session/manager.go:24–26 | Manager→Runner→metaMu，新增chat锁序需扩展注释 |
| Go模块位置 | go env GOMOD；rg --files -g go.mod -g go.work | 根GOMOD=/dev/null，唯一模块vibe-remoted/go.mod |

### 11.8 备注、未决事项和执行边界

- H3能力检测未落明确判断/测试：S:462要求capabilities检测；D:543、574仅probe和fake描述，D:402仅版本门槛。补实现可自行修，若删已确认H3才需用户决定。
- T:40并发交接/重载详细终态与D:262、431的串行重查如何对应尚需实现时验证；无运行复现，只记风险不作阻拦。
- T:383 GUI部分同时设置CLAUDE_CONFIG_DIR又写临时~/.claude.json；应澄清为D:478、T:208约定的$CLAUDE_CONFIG_DIR/.claude.json。本条不单独阻拦。
- T:253要求stubborn被SIGKILL，而D:590只规定忽略interrupt和EOF；夹具应明确是否忽略SIGTERM，或测试核对实际停止阶段。
- 未决编号仅c2（登记9条invariants，decisions:25、D:505、T:383）和c3（信任准入，decisions:30、D:477–483）。前者只暂停规则登记，后者只暂停T2/T6/T11信任小分支。
- 协议升3与CLAUDE.md架构修改已获R18/R19及关口A授权（S:428–448、498，decisions:18–19），不重复问Q/c1。T13仅给protocol-sync补新帧核对清单属于落实R18.2，不额外列c；真正改变兼容约束才须用户决定。验证skill纯操作说明按dev-test例外处理。
- 若坚持削减完整历史、V9降级或V13超时修改已确认验收，必须由用户确认；按原spec补设计和实现可自行修，不凭空新增c编号。



#### 记录保全

本节只追加design.md末尾，未改前624行，也未改spec.md/tasks.md/decisions.md/evidence/probe-stream-json.md或代码。追加程序按evidence/gate-b-document-baseline.json核对原design前80206字节SHA256为2e4029202b027d30eab775669b59f5144e445dcb511a0c9ec83c4475574608b6，并在写入后再次核对前缀及另外四份文档哈希。没有进入开发，没有提交。未决编号仅c2/c3；坚持历史缩减、V9降级/V13超时改验收等改变已确认需求的决定必须用户确认，按原spec修订方案可以直接推进。

## 第 2 轮（4679886，codex）：不通过


- 结论：**不通过**。上一轮 6 个阻挡项中，1–5 的主要问题已闭合，6（F7）只部分闭合；另外发现 R6.2 的模式选择违背已确认验收，以及停进程测试预期与 V14/夹具行为冲突。具体原因见下文。核心第二批探针已有证据，不再以「V9–V23 全部未测」作为阻挡理由。
- 验证者：**codex（独立模型），第 2 轮**。本验证者未参与设计。
- 验证范围：只读提交 `46798868b65eb01d3e15f67ea96998457c195552` 的 worktree、需求/设计/任务/裁决及现有探针日志。**没有重跑任何探针，没有调用外部模型，没有运行未来尚未实现的测试**；实际执行的是 Python 日志断言、任务依赖/名称解析和 `zsh -n -c` 命令语法检查。
- 行号约定：D = 本文件追加前的第 1–656 行；T = `tasks.md`；S = `spec.md`；E = `evidence/probe-stream-json.md`；C = `decisions.md`；H = `verdict-history.md`。日志行号均为 `.devflow-tmp/probe/logs/` 下原文件的物理行号。

### 11.1 阻挡项闭合情况：6 条逐条核对

| 上一轮阻挡项 | 本轮核对落点 | 结论 |
|---|---|---|
| 1. 核心 V9–V23 未实测 | D:550、562–577；E:250–268、270–452；T:238、269、345、412。V9–V14、V18–V23 的核心协议观察已有原始日志，抽查详见 11.3。D:568–570 明确保留 V15（风险评估）、V16（T3 实现验证）、V17（远程 Linux/dev-test）待验证，D:576 的 V24 为可选信任继承验证。 | **主要阻挡已闭合**。不能将区间内所有编号写成「全部实测通过」；V15–V17 尚未实测。V22 第二回合没有实际发送模式切换，V9 时间描述差 1 ms，属于证据表述备注。 |
| 2. 2000 行/16 MiB 历史总上限违背完整历史 | D:179–181、333–334、375–381 已取消历史总条数/总字节上限，按 200 帧流式发送；T:24–26、277、283、352、361 承接 `TestHistoryFullStream`、`test-chat-window` 和 3000 条浏览器验收；T:422–425 不再把完整历史加载列为后续。C:33 的 d13 覆盖旧 d8 的历史总上限。 | **已闭合**。保留的是单行 16 MiB 防护（D:381、483），不是原来的整份历史 16 MiB 截断；本轮确认取消的是上一轮的历史总量缩减。 |
| 3. V9/V13 失败预案擅改验收 | D:562、566 改为实测结果；D:642、655 说明不能自行改验收，实测成立后原失败预案不再需要；T:63、65、68、269、412 仍按保存规则/持续等待安排验证。 | **已闭合**。设计正文不再把 R5.2 改成 setMode 降级，也不再把 R5.4 改成超时重试；无需新增未决 c4/c5。 |
| 4. tasks 残留旧 Stop/Restart 接口 | D:121、297–299 定义 `WithOp` + `OpHandle.StopLocked/RestartLocked`；T:246、248–249、260、265–266、292–293、309、314 均承接新版接口。实际对任务正文搜索独立 `Stop(`/`Restart(`，结果为 0。 | **已闭合**。不存在旧公开调用签名残留。 |
| 5. T13 缺参数、GUI 名不一致、7.1 Go 命令缺 cwd | T:406–411 明确仓库根目录、临时终端 daemon 的启动来源、`VR_TOKEN` 和 `127.0.0.1:<端口>`；现有 `ws-smoke.mjs`:8、11–16 要求的两个参数都已给出。T:408 明确新 ws-chat-smoke 自建临时 daemon、无需参数。T:14–15、62 与 T:403 的 3 个 GUI 名逐字相同。D:505、507–511、513–514 所有 Go 命令均含 `cd vibe-remoted &&`。T:361 也明确 desktop 与仓库根各自的 cwd。 | **已闭合**。10 条 shell 规则命令通过语法检查；D:506 的已有 `/protocol-sync` 仍是人工 skill，未写显式 cwd，另列小备注，不当作自动 shell 检查通过。 |
| 6. F7：自动终端 -c 先运行 U 未登记占用 | D:115、117、119、263、280、469–476；T:46、290、293、300 已增加终端 continue 的 claim、tmux 选项及 reconcile 恢复，补 `TestTerminalContinueClaimsLatest`。但是 D:476 与 C:34 把「解析 U 与启动之间 JSONL 变化、claude 实际选到另一个 U」排除在 H12 保证之外。S:471 的例外仅限用户在终端自行手敲 `claude -c`，没有排除 daemon 自动启动竞态。 | **部分闭合，仍阻挡**。登记已解析出的 U 修复了原先稳定顺序的反例，但不能保证 claim 的 U 与实际启动的 U 一致，也不能由 d14 自行扩大已确认 H12 的例外。见 11.2。 |

### 11.2 本轮仍阻挡的问题及证据

1. **R6.2「批准，逐个确认」没有强制切到手动。** S:228–231 明确要求模式切到手动、之后编辑弹权限请求；D:456 却规定选项 2 只 allow、不带 setMode，让 claude 恢复原模式；T:79 的 `TestPlanApproveManual` 甚至把从 acceptEdits 进入 plan 后仍为 acceptEdits 写成正确断言。现有运行证据 `v11.ndjson`:286–290 是从 acceptEdits 切入 plan；:385 只发 allow；:386（34340 ms）自动恢复 acceptEdits；:406（37219 ms）Write b.txt，:410 成功，期间没有 `can_use_tool`。这恰好证明「只 allow」会违背 R6.2。应按原 spec 明确选项 2 的 `setMode:"default"`、控制发送顺序及编辑询问断言；不能用如实显示恢复后的模式替代用户选择的手动模式。该修正可直接按 spec 做，无需新用户裁决。

2. **F7 的实际进程身份仍未固定，d14 扩大了 H12 例外。** 可按 D:471–476 构造方案反例：终端请求先解析最近记录 A 并 claim A；在其 claude 真正启动前，另一个 daemon 对话新建 B，claim B 并写出更新的 JSONL；终端仍执行 `-c`，由 claude 自选最近的 B。此时占用表是「A → 终端、B → 对话」，实际两个自动启动的进程都使用 B。这里没有用户手敲 claude，也没有违反设计的任何 claim 规则。D:476 自己承认实际 U 可能不同，故不能同时成立 D:507 的「同 U 任何时刻最多一个进程」。这是**方案规则反例，未运行 claude，也不声称未来代码已复现**。应在启动前固定实际会话身份并保持原子 claim/失败回滚，或提供其他能守住原 H12 的方案；如果坚持扩大例外，才需要用户另行批准，当前 d14 的口味型裁决不能代替批准。

3. **停进程的测试预期与已采纳的队列语义互相冲突。** T:167 的 `TestStopInterruptsBeforeClosingStdin` 要求「先 interrupt 再关 stdin，排队消息不再执行」。但 D:431 的流程是先 interrupt、等本回合 result，再关 stdin并等待；D:587、608 的假 claude 明确规定 interrupt 后继续执行排队回合、EOF 也会跑完队列。运行证据 `v14.ndjson`:30 写入排队消息；:31–35 中断当前回合、still_queued=[]、aborted_tools；:37 已开始下一回合；:47 success/QUEUED_RAN。第一批 EOF 证据也明确会排空队列（E:244）。当前流程没有定义阻止下一条开始的机制，因此不能把这条测试当作可由现方案保证的完成条件。需要让停止流程、夹具和测试预期一致，并继续保证旧进程确认退出后才重启/交接；不应将正常 interrupt 的计数修正视为该停止问题已解决。

### 11.3 第二批证据抽查：文件 → 核对点 → 结果

实际以 Python 逐行解析 NDJSON，按方向、消息类型、request_id、时间和内容做断言；下列核对均通过，只有列明的表述差异与证据边界。

| 文件 | 核对点与实际日志 | 与证据文档/设计的关系 |
|---|---|---|
| `logs/v9.ndjson` | :27 can_use_tool 给 addRules/addDirectories/setMode；:29 回传的只有 addRules+addDirectories，含原 updatedInput；:40 记录 turn1 的 `settings.local.json` 为 `permissions.allow=["Bash(touch v9x.txt)"]`，当前 `ws9/.claude/settings.local.json` 与该记录完全一致。:41–70 第二回合相同命令正常执行，无 can_use_tool；:71 计数仍为 1。:95 只回 setMode，:96 status=acceptEdits。 | E:281–305 与 D:455、562 的主要描述一致。**小差异**：:95 为 20271 ms、:96 为 20272 ms，实际差 1 ms，并非 E:302/D:562 的「同一毫秒」。session addDirectories 没有出现在落盘结果中。 |
| `logs/v12b.ndjson` | :29（5652 ms）待答请求；:31（7652 ms）直接 interrupt，无先行 control_response/deny；:32（7653 ms）cancel 引用该 can_use_tool 的 request_id；:33（同为 7653 ms）才是 int-12 成功应答。:34–36 为 is_error tool_result、中断文本和 aborted_tools；:38 标记存活；:149 后续回合 success。 | E:353–369 与 D:202、235、565、572 一致。cancel **行序在 interrupt 应答之前**，时间相同。文件后半作废的 V14 尝试未用于 V14 的结论。 |
| `logs/v13.ndjson` | :31（5093 ms）can_use_tool；:34（905116 ms）才 allow，间隔 **900023 ms**。中间 :32–33 只有驱动自己的 meta 记录，没有任何 claude 输出、keep_alive 或 cancel。:35（905843 ms）工具输出 V13_OK；:48（910207 ms）success；:50 exit0；:51 文件存在。 | E:270–278、443 与 D:371、566 一致。证据支持本次 900 秒观测窗口内等待不中断、之后允许成功；不能把有限观测说成已实测无限等待。设计继续保留「有待答时看门狗不计时」，未擅改验收。 |
| `logs/v11.ndjson`：V11 | :102–104 ExitPlanMode 被 deny，意见成为 is_error tool_result；:228 Edit 计划文件；:241 再次 ExitPlanMode，期间无 permissionMode 变化。 | E:320–336 与 D:456、564 一致，支持继续完善后仍在 plan，选项 3 不需再切模式。 |
| `logs/v11.ndjson`：V22 两种时机 | 第一回合 :242 allow、:243 mode-a=acceptEdits 同为 19548 ms；:244–245 确认及 status acceptEdits；:246（19915 ms）批准 tool_result；:265 Write a.txt，无权限询问。第二回合 :385 只 allow；:386 自动恢复 acceptEdits；:387 批准 tool_result；:406/410 Write 成功且无询问；:386–423 没有任何出站 set_permission_mode。 | E:338–351 **准确披露**第二种等待 default 的分支从未发送 mode-b；D:574 方法列「等 status 再发」不准确，应写「等待 default 未触发」。因此这里只验证了立即发送与只 allow 的两个结果，不能宣称已经验证「等 status 后发送」成功。立即发送不被覆盖、恢复进入 plan 前的模式有证据；由此也发现 11.2 的 R6.2 问题。 |
| `logs/v23-untrusted.ndjson` | :1 用独立 CLAUDE_CONFIG_DIR 和 `-p`；:2（405 ms）SessionStart hook；:3 success；:4（3004 ms）SESSIONSTART_RAN 已存在；:5 才发第一条用户消息；:26 工具输出包含 PRETOOLUSE_RAN 和 SESSIONSTART_RAN；:41 exit0；:42 两标记均 true。当前临时 `v23/cfg-untrusted/.claude.json` 的 projects 缺失/null。 | E:425–439 与 D:488–494、575 的 hook 行为一致。**日志直接证明 hook 在首条输入前执行及两种 hook 的标记；日志没有启动前后信任配置快照**，「从未信任/不写记录」由 E:427 的准备说明及保留的临时配置旁证。未把父目录变体当作信任继承已验证。 |
| `logs/v14.ndjson`（补充） | :30（6068 ms）第二条消息写入；:32（7599 ms）still_queued=[]；:35 aborted_tools；:37 新回合；:47（9809 ms）success/QUEUED_RAN；:50 exit0。 | E:371–387 与 D:235、371、567 一致，支持 outstanding 逐条计数，不能按 still_queued 重算；也揭示 T:167 停进程断言尚未闭合。 |
| `logs/v18b.ndjson`（补充 V10/V18） | :7 init=bypassPermissions；:32 Bash touch、:36 输出 V18，未询问权限；:100 AskUserQuestion，requires_user_interaction=true；:101 的答案含 `Apple, Banana` 和自由文字；:102 工具结果复述；:116 success；:118 exit0。 | E:307–318、389–395 与 D:457、563、571 一致。已直接验证的是 **bypass 下 AskUserQuestion**；该日志没有 bypass 下 ExitPlanMode 的实测，不能将 T:28 的夹具计划当成这项真 claude 证据。客户端遇到这类待答仍渲染的策略合理，扩展观察范围作为备注。 |
| `logs/v9.ndjson`（补充 V20） | :108 /compact；:109 compacting；:113 compact_result=success；:114 init；:115 compact_boundary；:116–117 是两条 **content 为字符串**的 user 消息（摘要/local-command-stdout）；:118 success、num_turns=0。 | E:397–411 与 D:195、321、577 一致；客户端与 T:88、345–346 已按字符串 content 调整。 |
| `logs/v21.ndjson`、`logs/v23-parent.ndjson`（补充） | v21 :2 stderr No conversation found、:3 error_during_execution/errors、:4 exit1（974 ms），无 init。v23-parent :2–3 SessionStart success，:4 标记存在，:6 exit0，未发用户输入。 | E:413–439 与 D:417、573、575–576 一致。无记录 resume 的错误形状已承接；父目录变体仅证明 -p 同样执行 hook，**不能区分信任继承**，V24 仍待验证。 |

设计 §9.1 的范围口径（D:550）与实际第二批证据一致；D:562、574 有上述两处文字精度问题。C:35 的「V9–V23 实测全部通过」则比 E 的实际范围更宽，应在后续记录中明确 V15–V17 尚未验证，而不是改旧裁决行。

正文按差异调整的落点逐项核对：

| 必须调整的差异 | 正文与任务落点 | 结果 |
|---|---|---|
| interrupt 不先 deny | D:202、235、431；T:89、144、257、269 | 已调整为一条 interrupt，由 cancel 解决待答。 |
| outstanding 不按 still_queued 重算 | D:235、371；T:148、263、269 | 已调整为写入消息/result 逐条计数。D:620 只在旧变更记录出现旧说法，D:649 明确覆盖；不视为正文残留。 |
| bypass 下 AskUserQuestion 仍渲染 | D:221、321、404；T:28–29、346 | 已调整；AskUserQuestion 有真日志依据，ExitPlanMode 的额外推断边界已注明。 |
| 计划批准后立即 set_permission_mode | D:234、456；T:78、145、149、258、269 | 选项 1 已调整，不再等待 default/status/5 s；**选项 2 尚未按 R6.2 强制 default**。 |
| /compact 的字符串 content user 消息 | D:195、321；T:88、238、345–346 | 已调整为摘要折叠块/命令输出块，处理 compact_boundary，不误作用户气泡。 |

### 11.4 备注闭合情况：逐条核对

| 上轮备注 | 本轮设计/任务落点 | 结论 |
|---|---|---|
| H3 能力检测没有明确判断/测试（H:299） | D:223、406 定义 capabilities 缺失/缺 interrupt_receipt_v1 的降级及非致命处理；T:113、267 的 `TestInitCapabilitiesMissingDegrades` 分别覆盖缺字段、缺必需项和具备能力。 | **定义和测试计划闭合**；这是方案核对，尚未把未来测试记为已通过。 |
| 孤儿清理必须确认退出，未退出不能放行 U | D:447 明确 TERM→等 2 s→KILL→等 1 s、ESRCH 确认；仍活着保留 orphan 占用并拒绝 reload。T:39、277 对齐退出确认与占用返回。 | **定义闭合**。建议补一个仍存活/不释放 U 的可注入失败用例；现任务对该分支的断言仍不够显式，进后续。 |
| 忙时本端没有上一条消息，发送策略不明确 | D:463 明确首次发送时 running/waiting 先排队、idle 再发；T:157、346 的 `test-chat-queue: first send while busy queues` 对齐。 | **已闭合**。 |
| slash_commands 两个来源及优先级 | D:224 明确 initialize.commands 优先、init 不覆盖、10 s 失败回退及迟到替换；T:114、249、267 的 `TestSlashCommandsPrecedence` 对齐。 | **已闭合**。超时回退已定义，宜在该用例加入 10 s 无回复分支。 |
| 只有 setMode 建议时第二项的语义（上一轮 11.1/11.3 备注） | D:455 明确有 addRules 才保存规则，否则有 setMode 显示「本会话内允许所有编辑」，两者都无则仅允许/拒绝；T:64、66、172、368–369 承接权限构建与分组。 | **语义已闭合**，无需交用户重新定方案；可补 only-setMode 的具名断言。 |
| 并发交接/重载的串行重查与终态（H:300） | D:263、437 明确拿到 WithOp 后重查删除/交接；T:45、312、314、316 要求串行、每时刻≤1进程、无 VIOLATION、202 幂等。 | **定义已闭合，实施时验证**；没有运行新代码，仍不凭推断宣称该并发用例通过。 |
| stubborn 夹具需忽略 SIGTERM，并证明走到 KILL（H:302） | D:604 与 T:39、266 明确忽略 interrupt/EOF/SIGTERM、记录 `SIGTERM ignored`、最终 KILL。 | **行为与断言已补齐，有实现表述备注**：D:604 指定 `signal.Ignore(syscall.SIGTERM)` 后又要求收到该信号写日志，字面实现不能同时做到；需要捕获/消费 SIGTERM 并不退出（例如 signal.Notify），才能留下日志。此技术细节可自行修，不是用户决定。 |
| gui-smoke 的信任文件路径（H:301） | D:489、494；T:220–221、398 统一为各测试独立的临时 `$CLAUDE_CONFIG_DIR/.claude.json`，不写真实 `~/.claude.json`。 | **已闭合**。 |
| 未决编号与授权边界（H:303–305） | C:18–19 及 S:498 证明 c1、R18/R19 已获关口 A 授权；D:516/T:398 暂停 c2 登记，D:488/T:220、317、380–381 暂停 c3 信任小分支；V9/V13 的擅改验收预案已删除。 | **登记的未决仍仅 c2、c3**。坚持新增 H12 例外或改变 R6.2 才需要新用户批准；按原 spec 修正当前错误，不需要增加 c 编号。 |

### 11.5 快速复核

- **依赖无环**：实际解析 T:211、242、270、286、302、320、337、348、362、373、383、394、413，共 13 个任务；有效拓扑顺序为 `T1 → T2 → T7 → T3 → T8 → T4 → T9 → T5 → T10 → T6 → T11 → T12 → T13`。相邻节点不表示一定有直接依赖。
- **完成定义入口**：T1–T8/T10–T12 的 Go/npm 路径明确；T9 明确 desktop 构建与根目录 GUI；T13 明确根目录、参数及临时环境来源。T2:240 的单独 `go vet ./...` 必须继承前一条的 vibe-remoted cwd，T1:204 的黄金帧生成同理，建议把独立代码片段也补齐 cwd。命令可规划执行，不代表当前尚未实现的测试已经通过；T:167 的停止断言仍与方案冲突，见 11.2。
- **测试名一致性**：测试计划里标 Tn 的用例通过各任务「标 Tn 的全部用例」承接；旧 GUI 名问题已修。实际集合比较发现任务额外列出的 21 个 Go 测试尚未回填测试计划，它们已有任务及断言，不是同一场景被改名或没有测试，仅记文档同步备注。`TestPlanApproveManual` 名字一致，但 T:79 的断言违背 R6.2，名字一致不能证明验收一致。
- **7.1 检查入口**：共 11 条规则，10 条有含 cwd 的 shell 命令，逐条运行 `zsh -n -c <命令>` 均退出 0。所有 Go 命令已修正模块 cwd。D:506 的第 3 条仍是 `/protocol-sync` 人工 skill，当前不满足字面上的「每条都有带 cwd 的检查命令」；现有 skill:14–29 定义人工三处核对，T:411 已安排执行，应注明「仓库根执行该 skill，人工核对」，不能用命令语法通过冒充协议一致性已通过。
- **范围**：持久化、虚拟历史窗口、claim/opMu、净化及版本/能力检测都是落实原需求所需机制；没有发现新增模型选择、附件、checkpoint 或新的付费设施。c3 是已登记且暂停的安全准入决定。D:476/C:34 的新增 H12 豁免属于未经确认的需求边界改动，仍阻挡；D:456/T:79 则缩减了 R6.2 验收，仍阻挡。

### 11.6 未决定、只能由用户决定的事

- **c2**：是否把 design §7.1 的新增 9 条 invariants 登记进 `.devflow.yml`（C:25，D:516，T:398）。仅暂停规则文件登记；测试与 make check 接入可按计划实施。
- **c3**：是否采用工作区信任准入检查及对应的 `/fs.chatTrust` 和置灰提示（C:30、36，D:264、414、488–494，T:220、317、380–381）。仅暂停 T2/T6/T11 的信任小分支，测试环境仍须隔离。V23 已证明 hook 执行风险，父目录继承不算已验证。

当前正式未决清单只有以上两项；本轮不擅自创建其他 c 编号。R6.2、F7 和停止测试冲突可按已确认 spec 修正，属于设计返工。若设计者坚持现有验收缩减/H12 豁免，必须另记人类裁决并取得用户批准，不能将其作为已授权默认方案放行。

### 11.7 备注（进「后续」的小问题）

- 修正 E:302/D:562 的「同一毫秒」为实际 1 ms；D:574 的第二种时机写清没有发出 mode-b；对 C:35 追加实际实测范围说明；保留第一批 E:227–228、242、246 的原记录时注明已被第二批补充/覆盖。
- T:28/D:221、404 对 bypass 下 ExitPlanMode 的表述超过 v18b 的直接观察范围；后续验证明确区分 AskUserQuestion 已实测与 ExitPlanMode 待观察。本轮不补跑。
- 将任务额外 21 个 Go 测试同步进测试计划；给 only-setMode、initialize 无回复超时、孤儿仍存活保留 owner 补明确断言。
- D:604 的 stubborn 信号实现用能记录收到 SIGTERM、同时不退出的捕获机制；避免照抄 signal.Ignore 后等待其日志。
- 明确 `/protocol-sync` 的仓库根 cwd 与人工性质；T2 vet/T1 黄金生成的独立片段补 cwd；D:507 命令内的竖线在 Markdown 表格源码中宜转义，防止表格显示错列。

以上仅记录应进入「后续」的小问题，**本验证者没有修改 tasks.md**；11.2 的三项阻挡不得移入后续来放行。

### 11.8 记录保全

本节只追加在原 design.md 第 656 行之后。原前缀 **93724 字节**，SHA256 为 `9e92d497c9c275c8f616fd63a1533a67ddde91a9bf4090eb5a7d11372af85c8d`；追加前后检查该前缀完全一致，同时确认 spec.md、tasks.md、decisions.md、verdict-history.md、evidence/probe-stream-json.md 的哈希没有变化。worktree 验证前后 HEAD 均为 `46798868b65eb01d3e15f67ea96998457c195552`，`git status --short` 及 `git diff --name-only HEAD` 均无输出。未修改仓库代码、未提交、未推进下一阶段。

## 第 3 轮（78ca901，codex）：不通过


- 结论：**不通过**。R6.2 已闭合；F7 的「解析 A、实际启动 B」竞态及 d14 擅自扩大 H12 已修正，但无记录分支仍漏登记新进程的 U；停止流程已改用信号，仍不能保证排队回合绝不产生 result。后二者属于方案规则反例，不能移入备注放行。c4 的局部暂停边界本身正确，不是整份方案不通过的原因。
- 验证者：**codex（独立模型），第 3 轮**。本验证者未参与设计。
- 验证范围：只读提交 `78ca901cc8422eb8b82061b93ce87deec077c9d4` 的 worktree、需求/设计/任务/裁决、前两轮结论及已有原始日志；只向本文件末尾追加结论。没有重跑探针，没有调用模型，没有运行尚未实现的产品测试。实际执行 Python 原始日志断言、文档名称/依赖解析，以及 `zsh -n -c <命令>` 语法检查。
- 行号约定：D = 本文件追加前第 1–666 行；S = spec.md；T = tasks.md；C = decisions.md；E = evidence/probe-stream-json.md；H = verdict-history.md。日志行号为 `.devflow-tmp/probe/logs/` 下原文件的物理行号。引用现有运行证据与下面的方案推理分开，未声称未来代码已复现反例。

### 11.1 阻挡项闭合情况：3 条逐条核对

1. **R6.2「批准，逐个确认」未强制切手动：已闭合（方案与测试计划）。**

   S:228–231 要求切手动并询问之后的编辑。D:234 明确 setMode 只允许 acceptEdits/default，同一次持锁内把 set_permission_mode 紧接在 control_response 后入队；D:456 的选项 2 为 allow + 原 input + `setMode:"default"`，不再依赖 claude 自动恢复的模式。D:598 的假 claude 先恢复进入 plan 前的模式，再接受立即到达的 default 控制请求，之后 Write 按最终模式询问。T:80 的 `TestPlanApproveManual` 覆盖从 acceptEdits 和 default 进入 plan 两种情况，断言最终 default、Write 产生 can_use_tool；T:81 的客户端 buildAnswer 也发送 default，T:283/T:378 分别承接 T3/T8 用例。

   V22 证据与此修订一致：`v11.ndjson`:242–245 为 allow 后同一 tick 发 acceptEdits 并成功；:385–387 为只 allow 后恢复 acceptEdits；:406、410 的 Write 成功，中间没有权限请求。D:577 已准确注明第二回合没有发出等待中的 mode-b，不能把它当作「等 status 再切模式」成功。**已有日志直接验证的是立即切 acceptEdits，不是本轮新增的立即切 default 后 Write 询问**；后者属于依据同一控制接口设计的验证计划，不能记成真 claude 已实测通过。D:234/T:175、288 的写队列部分入队失败仍明确报 set_mode_failed，是已有错误处理分支，不是把选项 2 默认恢复 acceptEdits 当作正确验收。

2. **F7：占用 U 与实际进程 U 不一致，且 d14 扩大 H12：已关闭原竞态与越权例外，但无记录分支仍阻挡。**

   C:38（#15）明确推翻 C:34 的 d14；D:471、479、663 不再把 daemon 自动启动竞态排除在 H12 外。S:471 的例外仍只有用户在终端自行手敲 `claude -c`。D:115、473–475 改为解析 U、原子 claim、实际命令 `--resume U`，失败回滚；T:46 对解析后插入更新 JSONL B 的情况检查实际 argv 仍为 `--resume U`，另一个对话可以 claim B，两个进程身份不同。该子项在 C:39、T:325、350 明确阻塞 c4，尚未获用户批准，也尚未实现。

   **固定身份路径的推理：**解析时选中 A → 在 Manager.mu 下 claim(A, X) → X 的最终 argv 固定为 `--resume A`。JSONL 此后出现更新的 B 只会影响另一次 LatestSessionForWorkdir，不能把 X 改成 B；已有 V4 证据及 D:417 的规则表明不带 fork 的 `--resume A` 继续使用 A。另一个 owner Y 若也解析到 A，claim(A, Y) 按 D:116 失败，不得 spawn；若解析到 B，则使用 B，不能与 X 同用 A。同一 owner 的幂等 claim 本身不是进程锁，同 id 新建重放还依赖 beginCreate（D:112、473；现有 manager.go:151–163、233–256），重载依赖串行替换；现有 runner.go:622–629 在 Runner.mu 下调用 respawn-pane。**因此，已找到 U 的固定 argv 路径排除了前轮 A→B 的身份竞态；原子 claim 也排除了不同 owner 同时获准启动同一 U。**这不等于仅靠一张 owner 表就证明全部进程生命周期已通过。

   **仍存在的方案反例：**D:476 明确无记录时去掉 -c、**不 claim**；D:115 又规定不带 continue 的终端会话不 claim。可以按这些规则依次发生：①目录没有 JSONL，daemon 按该分支启动终端 claude，开启新会话 U；②该终端仍在运行，U 的 JSONL 已写出；③用户通过桌面新建对话并勾 -c，D:378、415 找到 U，而 claudeOwners 无 U，claim 成功；④D:417 启动另一个 `--resume U` 进程。两个进程都由 daemon 启动，没有用户手敲命令，故 S:110、471 的 R2/H12 仍被违反。T:46 当前只检查无记录时去掉 -c、不 claim，没有覆盖终端产生 JSONL 后再开对话这一顺序。这里不依赖解析与启动间文件变化，撤回 d14 也不能消除它。

   需要在该分支同样固定并登记新 U（例如服务端生成 UUID、原子 claim 后以 `--session-id U` 启动），或提供等效且覆盖后续对话 -c 的准入机制，并补对应的双进程防重测试；用户配置参数的改写仍归 c4 处理。不能把 c4 同意现有改写等同于同意新增 H12 例外。终端重载交替占用还应在实现中保留旧 U 至旧进程确认退出、失败保留/回滚原占用；D:263、477 的「成功后释放旧 U」不能被实现为启动前先释放。

3. **停进程与「interrupt 后排队消息仍执行」冲突：时序文字与测试名已同步，绝不完成的断言仍未闭合。**

   D:431 与 C:40（#16）均改为 interrupt → 等当前回合 result ≤2 s → SIGTERM → 等 1 s → SIGKILL → Wait → 清理 stdin；D:608 的假 claude 默认收到 SIGTERM 退出 143，不再依靠 EOF，stubborn 用 signal.Notify 记录并不退出。T:197、296 均采用 `TestStopDoesNotLetQueuedTurnComplete`，T:296 还要求 4 s 内返回、当前回合有中断 result、**从未**收到 queued 回合 result、queued 有 dropped_on_stop、进程退出 143。旧 `TestStopInterruptsBeforeClosingStdin` 在 tasks 中出现次数为 0。D:431、437、440 仍要求旧进程退出后才能重启或交接，未改成中断应答即放行 U。

   但是，D:591 保留「interrupt 后继续执行排队回合」，D:594 的 `echo` 没有等待 daemon 收到上一回合 result 的握手。信号只阻止**生效之后**的继续执行，不能撤回已经产生的 result。方案允许以下事件顺序：claude 输出中断回合 result → claude 从队列取出 `echo queued` 并输出其 result → daemon 读到中断回合 result → daemon 立即发 SIGTERM。即便 daemon 没有故意延迟，两个进程也不共享执行顺序；stdout 中的两条短 result 可以先进入管道，D:373「持续排空」不提供 daemon 必须先于 claude 下一回合获得调度的保证。这一顺序同时遵守 D:431、591、594、608，却违反 T:197、296 和 D:431「即使已开始也不会产生 result」的断言。

   已有运行证据 `v14.ndjson`:30–35 为排队消息、interrupt、当前回合 aborted_tools；:37 开始下一回合，:47 输出 success/QUEUED_RAN。该日志没有 SIGTERM/SIGKILL，**不能证明新停止流程失败，也不能证明新流程保证零 queued result**；它证明的队列自主继续语义正是上述推理的前提。需要明确停止边界：若要求排队回合绝不能完成，必须提供真正阻止队列继续的机制；若按实际进程语义终止，则须一致地记录信号生效前已完成的回合、仅为退出时未配到 result 的消息发 dropped_on_stop，并使测试验证这个边界。不能仅靠「立即」二字或在假 claude 的快速 echo 中人为加延迟证明保证成立。

### 11.2 备注处理情况（对照前轮 11.7）

| 前轮备注 | 本轮落点 | 状态 |
|---|---|---|
| V9 时间精度、V22 第二种时机、实测编号范围、第一批被覆盖说明（H:400） | D:565 已写「1 ms 内」，D:577 写清 mode-b 未触发，D:553、571–573、660、665 区分实际实测与 V15–V17 待测 | **部分处理**：E:302 仍为「同一毫秒」；C:35 的「V9–V23 实测全部通过」未见追加的编号范围更正；E:227–228、242、244、246 旧记录保留，但未显式注明被第二批补充/覆盖。 |
| bypass 下 ExitPlanMode 的直接证据边界（H:401） | D:221、404、580、665 明确 AskUserQuestion 已实测、ExitPlanMode 待可选 V25 | **主要处理**：T:28 与 D:588 仍将 ask/plan 合写并引用 V18，易让读者把假 claude 的 plan 行为当成直接实测；应同步标明边界。 |
| 额外 21 个 Go 测试及三个缺失断言（H:402） | T:139–165 的补充表恰好 21 项；T:65 only-setMode；T:116 无 initialize 回复超时，D:609 提供夹具；T:39 注入不发信号后孤儿仍存活、保留 owner、reload 409，随后消失再放行 | **已处理**。实际集合比较：任务显式列出的 57 个 Go 测试名全部存在于计划的 122 个测试名中，差集为空。 |
| stubborn 的信号记录机制（H:403） | D:608 改 signal.Notify，每次收到 SIGTERM 写 `SIGTERM ignored` 后继续；T:39、297 分别覆盖孤儿清理和停进程升级至 KILL | **已处理**，不再要求 signal.Ignore 后还能接收该信号写日志。 |
| protocol-sync 的 cwd/人工性质、T1/T2 cwd、表格竖线（H:404） | D:509 指明仓库根人工 skill；T:234 黄金生成显式 cd vibe-remoted；T:270 的 go vet 与 go test 在同一 cd 链；D:510 表格中的竖线已转义 | **已处理**。10 条 shell 命令经 zsh -n 检查均退出 0，人工 skill 不算作自动检查已执行。 |

### 11.3 修订交叉复核

- **R6.2 与 V22**：控制顺序、客户端答案、假 claude 和测试预期一致；V22 第二回合未发 mode-b 的边界已披露。没有把旧「恢复 acceptEdits」当成 R6.2 正确行为；具体证据与尚未实测部分见 11.1 第 1 条。
- **停进程三处**：D:431/C:40 的时序、D:608 的信号行为、T:197/296 的新名称一致；D:591/613 保留普通 interrupt/EOF 跑队列的真实语义是正确的。剩余矛盾在于 D:431/T:296 的零 queued result 保证，不在于 EOF 清理顺序或名字，见 11.1 第 3 条。
- **c4 暂停范围**：C:39 明确只阻塞 T5/T6 的 continue 子项；T5 状态仍待办、T:325 明确其余部分照常实现；T:350 仅暂停 T6 的 attach/reload 409 子项；D:115、263、469、479、663 均注明待 c4。没有把对话会话自己的 -c（S:465、473；D:415、417；T:22）或交接的固定 --resume（S:474；D:438、440；T:48、341）错误纳入 c4。D:479/T:325 如实披露确认前终端不改写、不 claim；该阶段可以推进其它开发，不能宣称 F7 已在产品中消失，未决项未处理完不能完成整体验收。
- **任务依赖无环**：实际解析 T:241、272、301、317、334、352、369、380、394、405、415、426、445 共 13 个依赖行。依赖为 T1 无；T2←T1；T3←T2；T4←T3；T5←T4；T6←T5；T7←T1；T8←T1/T2；T9←T7/T8；T10←T9；T11←T10/T6；T12←T11；T13←T12。有效拓扑顺序：`T1 → T2 → T7 → T3 → T8 → T4 → T9 → T5 → T10 → T6 → T11 → T12 → T13`。相邻节点不表示必有直接依赖。
- **测试名一致**：`TestPlanApproveManual`（T:80）、`TestPlanApproveSetsMode`（T:79、179）、`TestStopDoesNotLetQueuedTurnComplete`（T:197、296）、两项 TerminalContinue 测试（T:46–47、325、327、332、350）均被对应任务承接；三个 GUI 名 T:14–15、62 与 T:435 逐字一致。旧 Stop 名已删除；新名一致不代表其断言已可保证。没有运行未来测试，集合比较和语法检查不算产品测试通过。
- **裁决记录**：C:38 已明确推翻 d14，C:40 覆盖旧停进程流程；D:624–625、639–640、647、650、656 为历史变更，后续记录 D:654–665 已说明覆盖，不能重新照旧行实现。D:530 覆盖表仍残留「continue 终端会话尽力占用」，与 D:469 的固定身份术语不一致，列为文字备注。

### 11.4 未决定、只能由用户决定的事

- **c2**：是否把 D:503–519 的新增 9 条不变规则登记到 `.devflow.yml.invariants`（C:25、T:430）。仅暂停规则文件登记；测试及 make check 的接入照常实施。
- **c3**：是否采用工作区信任准入检查及 `/api/v1/fs.chatTrust`、未信任/unknown 时置灰提示（C:30、36；D:264、414、491–497；T:250、262、349、412–413）。仅暂停 T2/T6/T11 的信任子项。V23 支持 hook 风险，父目录继承仍没有直接证明；测试继续使用隔离配置。
- **c4**：是否允许 daemon 对 continue 终端新建/重载改写用户配置参数，固定为解析时的 `--resume U`，以及无记录时的行为（C:39；D:469–479；T:325、350）。仅暂停 T5/T6 的 continue 子项；现有无记录方案应先补齐 11.1 第 2 条的占用缺口，再形成满足 R2 的可审阅方案。批准参数改写不能代替修复唯一性缺口，也不授权扩大 H12。

正式未决清单仍为 **c2、c3、c4**；c1 已于关口 A 获准（C:18–19、S:498）。本验证者不新增或代替用户决定 c 编号；上述无记录身份遗漏与停止断言属于当前方案的技术返工，不因第三轮仍不通过而自动变成已获授权的需求缩减。

### 11.5 备注（进「后续」）

- 同步 E:302 的 1 ms 精度；以追加方式更正 C:35 的实测编号范围；给 E:227–228、242、244、246 的第一批说明加上第二批补充/覆盖指引，保留旧证据。
- 给 T:28/D:588 的 bypass plan 夹具说明补「AskUserQuestion 实测，ExitPlanMode 按收到的请求渲染、V25 待观察」，不把夹具计划当作真 claude 证据。
- 将 D:530 的「尽力占用」改成与 6.9 一致的固定身份描述；D:602 的 slow interrupt 示例 `still_queued:[…]` 宜明确写 `[]`，与 D:591/T:293 的统一夹具规则一致。

以上仅为应进入后续的备注清单，本验证者没有修改 tasks.md。**11.1 第 2 条的无记录身份缺口与第 3 条的停止保证不属于后续，不能靠备注放行。**

### 11.6 记录保全

本节只追加在原 design.md 第 666 行之后。追加前原文 **97775 字节**，SHA256 为 `910b303c5ca89c63843bc18edcb0eddc3ea824fe32d61ecc34eabaeadd5ed7d9`。追加后核对该前缀字节及哈希完全一致，并核对 spec.md、tasks.md、decisions.md、verdict-history.md、evidence/probe-stream-json.md 的哈希未变。worktree 前后 HEAD 均为 `78ca901cc8422eb8b82061b93ce87deec077c9d4`，git status --short 与 git diff --name-only HEAD 均无输出。没有改仓库代码、提交或推进开发阶段。

## 第 4 轮（6a26865，codex，最后一轮）：不通过（剩 2 处条文，已按其改法修正，未再独立验证）


- 结论：**不通过**。第 3 轮的「无记录启动未登记新 U」原反例已修复；「排队回合绝不产生 result」的错误承诺已删除。但本轮新增的同 U 重载失败回滚存在条文冲突，停止流程也缺少「stdout 已读完并处理完」的结算屏障，尚不能证明每条消息恰好得到 result 或 dropped_on_stop 之一。这是方案与断言的核对结论，不是尚未实现的产品故障实测。
- 验证者：**Codex（独立验证者），第 4 轮，最后一轮**。本验证者未参与设计；没有调用其他模型或派子 agent。
- 验证范围：只读提交 `6a268651d1cabd037ec7bae7f137e0598ab081ad` 的 worktree、需求/设计/任务/裁决、前三轮结论和已有原始日志；只向本文件末尾追加结论。没有重跑探针，没有调用模型，没有运行未来产品测试，没有修改代码或推进下一阶段。
- 行号约定：D = 本文件追加前第 1–671 行；S = spec.md；T = tasks.md；C = decisions.md；E = evidence/probe-stream-json.md；H = verdict-history.md。原始日志行号指 `.devflow-tmp/probe/logs/` 下文件的物理行号。

### 11.1 阻挡项闭合情况

**(a) continue 无记录分支：原反例已闭合；新增重载失败回滚未完全自洽。**

D:115、476、668 和 C:42（#18）一致规定：没有 JSONL 时由 daemon 生成 UUID v4，在 Manager.mu 下原子 claim(U, X)，以 `--session-id U` 启动并写入 `@vibe_remote_claude_u=U`，不再采用「去掉 -c、不 claim」。T:46 已扩展到完整顺序「无记录 → 终端启动并占用新 U → 假 claude 交互分支写出 U 的 JSONL → 对话 -c 返回 claude_session_busy，只有一个 U 进程」；D:615 明确提供了写 JSONL 的夹具，T:325、332 承接此测试且保留 c4 阻塞。

固定身份的推理如下：

1. 在 U 的 JSONL 写出前，另一对话 -c 若也找不到记录，会生成自己的 UUID 并先 claim；它不会凭空选中终端的 U。即使 UUID 碰巧相同，D:116 的不同 owner 冲突检查仍阻止第二次 spawn。
2. U 的 JSONL 写出后，另一 owner Y 解析到 U，claim(U, Y) 因 U 归 X 而失败，不能 spawn。解析和启动之间新增 JSONL B 也不能改变 X 已固定的 `--session-id U` 或 `--resume U`；Y 若解析到 B，实际启动身份是 B。原第三轮「终端生成 U 后，对话再 claim 同 U」反例不再成立。
3. 重载成功路径在 D:263、478 明确先停旧进程并确认退出，再 `respawn-pane`，不用 `-k` 边杀边起。U′≠U 时先 claim 新 U′，失败什么都不改；成功启动新进程后才释放旧 U。其它 owner 只能在旧进程已退出后取得旧 U，不能与旧进程重叠。U′=U 时应全程保留原 claim，同 owner 的幂等 claim 不能替代生命周期串行化；已有 runner.go:622–629 在 Runner.mu 内串行 respawn，实施 6.9 时必须把完整替换流程纳入该串行范围。新建重放由 D:112、473 与现有 manager.go:151–163、233–256 的 beginCreate 承接。

**新矛盾：D:263、478 的「启动失败 → 释放 U′、旧 U 保持占用」没有限定 U′≠U。** D:478 第①步明确允许 U′=U（交接重载必然如此；T:46 的无记录终端写出 JSONL 后重载也如此），第②步此时没有取得一份新的 claim。代入 U′=U 后，无条件 releaseClaude(U′, X) 就是释放旧 U，与同句「旧 U 保持占用」、D:117 的终端释放规则和 T:46 的「注入启动失败 → U 仍归该终端会话」互相矛盾。原子 owner 表只有一条 U→X，不能同时完成这两个动作。

因此，按「保留原占用」这一意图执行时，以上固定身份及退出确认规则排除了本轮关注路径的同 U 双进程；**当前回滚条文不能直接作为一致的实现依据**。需要把回滚写成「仅当 U′≠U 且本次新增 claim 时释放 U′；U′=U 不释放原 claim」，并让 4.9/6.9 与 T:46 同步。这里没有把错误回滚假定为已发生的产品双进程，也没有扩大 S:471 的 H12 例外。T:48 的交接终端重载仍不属于 c4，不能随整个 6.9 一起暂停。

现有身份依据只读复核：`v4a.ndjson`:16 与 `v4b.ndjson`:16 的 result.session_id 均为 `3e817b00-067c-4d43-be75-409202cde9e5`，Python 断言相等通过。这支持 D:561 的固定身份续接规则；不等于本轮的交互终端/重载测试已经运行。

**(b) 停进程记账：三处目标一致，但保证仍缺一道同步屏障。**

D:431、669 与 C:42 已采用实际进程语义：信号不能撤回已输出的 result，排队回合允许在 SIGTERM 生效前完成；未配到 result 的消息发 dropped_on_stop。D:592、595、603、609 的假 claude 与之兼容：interrupt 后自主跑下一回合，快速 echo 没有等待 daemon 的握手；SIGTERM 默认退出 143，stubborn 捕获信号后继续，最终靠 SIGKILL。T:197、296 两处都改为 `TestStopAccountsForEveryQueuedMessage`，验证正在执行的一条加两条已写入消息逐条「恰好其一」，含 stubborn 变体，不再断言 queued result 必须为零。这三处在**目标与信号行为**上已经一致。

已有日志 `v14.ndjson`:30–32 为写第二条消息、interrupt、空 still_queued；:35 为当前回合 aborted_tools；:37 开下一回合；:47 为 success/QUEUED_RAN。Python 对 :32/:35/:47 的断言通过。该日志未包含停止信号，只证明队列自主继续的前提，既不能证明新 Stop 失败，也不能证明新记账保证已通过。

**未闭合点是「进程退出」不等于「读协程已处理完 stdout」。** D:431 当前顺序为 Wait() 返回 → 关 stdin → 按未配对表发 dropped → 退出回调/可能启动新 epoch；D:373 只规定读协程始终读，D:431 的 EOF 分支也没有要求 Stop 等待它读完且处理完。T:280 引用同一流程，T:296 没有强制此竞态的测试钩子。

可以按已规定的步骤构造以下调度：

1. claude 已向 stdout 写出 m1 的中断 result 和 m2 的排队 result；daemon 处理了 m1，读协程读到 m2 的完整行后、尚未在 Session 内登记时被换出。
2. Stop 发 SIGTERM，进程退出，Wait() 返回；m2 此时仍在未配对表，Stop 按 D:431 为 m2 发 dropped_on_stop。
3. 读协程恢复，把 m2 的 result 正常透传、入缓冲。客户端在 D:463 下已用 dropped 配对 m2，迟到的普通 result 还可能错配给后面的回显。m2 同时具有 result 与 dropped，违背 D:431/T:296 的「恰好其一」。若改为丢掉这条迟到 result，则又违背「信号生效前已输出的 result 正常记录」，并可能让用户重发已经完成的操作。

上述是**离线事件顺序推演**，不是模型/产品探针。实际 Python 演算输出为 `Wait返回 → m2/m3结算dropped → 读协程提交缓存m2 result；双结算=['m2']`。作为本机运行库依据，只读 `/usr/local/go/src/os/exec/exec.go`:1077–1079 明确说明 Cmd.Wait 会在命令退出后关闭 StdoutPipe，并且不得在全部读取完成之前调用 Wait；采用 StdoutPipe 时还可能直接丢失未读输出。即使自行管理管道、避免提前关闭，步骤 1 的「已读、未登记」仍须处理，不能只用进程 Wait 代替读协程结束屏障。

需要在最终 dropped 结算、退出事件和新 epoch 之前，**等待旧 stdout 读协程到 EOF 且完成全部行的处理**，再在 Session.mu 下对剩余未结算消息只结算一次；管道的所有权/关闭顺序须支持这一点。T:296 应用钩子强制「m2 result 已输出或已读入、尚未登记时进程退出」，断言 m2 得 result 且无 dropped，真正未完成的 m3 恰一条 dropped，并检查旧读协程不会把消息记进新 epoch。这样才能从机制证明新边界，不能靠快速 echo 恰好跑在某一侧来证明。

S:287–290 的 R9.3 约束的是尚在客户端队列的消息退回输入框，H16（S:475）明确区分了多端竞态下已写 stdin 的消息。因此，删除尚未实现测试计划里的「排队 result 必须为零」是纠正超过 spec 的承诺，本轮不为此新增需求缩减裁决；以上缺口也不能靠继续放宽「恰好其一」解决。

### 11.2 备注处理（对照第 3 轮 11.5）

| 前轮备注 | 本轮落点 | 状态 |
|---|---|---|
| E:302 的 1 ms 精度 | E:302 已改「1 ms 内」，D:566 一致；原始 `v9.ndjson`:95→96 的 `_t` 差为 1 ms | **已处理** |
| 追加更正 C:35 的第二批实测编号范围 | C:43（#19）明确为 V9–V14、V18–V23，V15–V17 待验证；D:554 一致 | **已处理**，旧行保留符合裁决只追加规则 |
| 第一批 E:227–228、242、244、246 补第二批覆盖/补充指引 | 旧记录保留，第二批 E:250 起及 E:387、445 已提供新事实；旧段未显式标出覆盖关系 | **未处理，只作备注**，不得把旧 still_queued/EOF 建议当成现行规则 |
| T:28/D:588 的 bypass plan 证据边界 | 当前 T:28、D:589 区分 AskUserQuestion/V18 实测与 ExitPlanMode/V25 假定、待观察 | **已处理** |
| R2 覆盖表「尽力占用」同步 6.9 | D:531 已改固定身份 `--resume U`/`--session-id U` 后原子 claim，含退出确认 | **已处理**；第 10 节旧历史用语由 D:668 覆盖 |
| slow 中断例子的 still_queued 写 `[]` | D:603 写明 `[]`，与 D:592/T:293 一致 | **已处理** |

### 11.3 修订交叉复核

- **没有重新引入前三轮已修复的 R6.2、完整历史及 H12 例外问题**：D:234、456、599 与 T:79–81 保留批准后立即切 default/acceptEdits 的顺序，D:381/T:24 保留全部历史，C:38 对 d14 的撤回仍有效。现行修订不能按第 10 节已被覆盖的旧记录实施。新发现的冲突与缺口仅按 11.1 列出；其它未实测的实现风险不据此断言为产品错误。
- **依赖无环**：Python 实际解析 T:241、272、301、317、334、352、369、380、394、405、415、426、445 的 13 条依赖，拓扑结果为 `T1 → T2 → T7 → T3 → T8 → T4 → T9 → T5 → T10 → T6 → T11 → T12 → T13`，相邻项不表示必有直接依赖。新增同 U 重载/停止测试没有增加倒向依赖。
- **Go 测试名一致**：实际集合比较，计划共有 122 个不同 Go 测试名，任务显式列出 57 个，任务减计划差集为空；任务通过「标 Tn 的全部用例」承接其余测试。新 Stop 名在 T:197、296 出现，两个旧 Stop 名均为零次。TerminalContinue 两项和 HandedOffTerminalReload 在 T:46–48、325、327、332、347、350 名称一致。名字对齐不代表 11.1 的断言已经可保证。
- **GUI 名一致**：`chat session created via picker`（T:14/435）、`chat reply rendered`（T:15/435）、`permission allow once resumes`（T:62/435）逐字匹配；其它浏览器验收由 dev-test 承接。
- **7.1 检查入口**：10 条 shell 命令逐条只运行 `zsh -n -c <命令>`，退出码均为 0（D:508–509、511–518）；D:510 清楚标注仓库根的人工 `/protocol-sync`。没有把命令语法通过或测试计划登记算成产品检查通过。

### 11.4 未决定事项（只能由用户决定）

- **c2**：是否把 D:504–520 的新增 9 条 invariants 登记进 `.devflow.yml`（C:25、T:430）。仅暂停规则文件登记；测试和 make check 接入照常推进。
- **c3**：是否采用工作区信任准入及 `/api/v1/fs` 的可选 `chatTrust` 字段、未信任/unknown 时置灰提示（C:30、36；D:264、414、492–498；T:250、262、349、412–413）。当前接口是 `/api/v1/fs` 响应字段，不是新 `/api/v1/fs.chatTrust` 端点。仅暂停 T2/T6/T11 的信任子项；测试配置继续隔离。父目录继承未被 V23 证明，V24 不补跑则保持只看目录本身。
- **c4**：是否允许 daemon 改写终端 continue 参数：有记录改为解析时固定的 `--resume U`，无记录生成并占用 UUID 后用 `--session-id U`，以及相应终端重载行为（C:39 由 C:42 的 #18 补充；D:469–480；T:46–47、325、350）。仅暂停 T5/T6 的 continue 子项；对话 -c 和交接固定 resume 不在暂停范围内。给用户的可审阅方案应以本轮无记录新行为为准，并先消除 11.1 的回滚冲突，不能仍让用户批准旧「无记录去掉 -c」版本。

正式未决仍只有 **c2、c3、c4**；c1 已在关口 A 获准（C:18–19、S:498）。本验证者不新增 c 编号、不代替用户决定。11.1 的回滚条件和 stdout 结算屏障是技术修正；本轮为最后一轮，不自动发起下一轮或继续开发。

### 11.5 备注（进后续）

- 给第一批 E:227–228、242、244、246 加第二批补充/覆盖指引，保留旧证据；特别标出 still_queued 不统计 stdin 队列、EOF 不能替代停止信号。
- 终端重载实现时用现有 Runner 的串行机制覆盖完整「选 U′/claim/停旧确认/respawn/回滚」事务，并核对 tmux 选项在 U′≠U 时的更新及失败恢复；T:46 当前主要断言同 U 重载，跨 U 和 daemon 重启边界宜补验证。此处是实现验证提醒，不声称未来代码已发生竞态。
- stubborn 可能在收到但忽略 SIGTERM 后继续输出；记账应保留旧进程退出前实际读到的完整 result，不能把「发出 SIGTERM」当成可观测的输出截断时刻。现有 T:296 的恰好其一目标无需降低。

本验证者没有修改 tasks.md。**11.1 的回滚条文冲突及 stdout 结算屏障缺口不属于可移入后续放行的备注。**

### 11.6 记录保全

本节只追加在原 design.md 第 671 行之后。原前缀 **101571 字节**，SHA256 为 `3e5b1f73b28b6a80bec3b9962cc02677b4dc88a3f4e188815a7ea2f5bfa0c977`；追加后逐字节核对该前缀，并核对 spec.md、tasks.md、decisions.md、verdict-history.md、evidence/probe-stream-json.md 的哈希未变。worktree 前后 HEAD 均为 `6a268651d1cabd037ec7bae7f137e0598ab081ad`，git status --short 与 git diff --name-only HEAD 均无输出。没有修改或提交仓库代码。
