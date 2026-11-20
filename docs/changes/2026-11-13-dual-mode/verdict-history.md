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


# 关口 C 历史结论

## 关口 C 第 1 轮（提交 e869add，2026-11-20，不通过）

- 总结论：**不通过**。两名独立验证者都没写过被验代码，各自在独立的 worktree 里对同一提交 `e869add` 验证。
- 分工：
  - 非界面部分：codex（GPT-6）。Go 测试、`make check` 的各步骤、协议冒烟、`.devflow.yml` 命令型 invariants、/protocol-sync 核对、diff 与断言审计、探索实验。结论不通过，确认问题 3 个（P1 长回复 reset 补发后显示两次；P2 `-c` 接上别的目录的对话；P3 `docs/protocol.md` 漏了 `chat_ack.message`），另有 2 条测试备注（R5.6 用例里的永真断言；`TestOrphanCleanup/stubborn_needs_SIGKILL` 的等待没有上限）。
  - 界面部分：同模型的全新验证者（Claude Fable 5）。真实 Electron，经 CDP 发真实指针 / 滚轮 / 按键事件；gui-smoke 5 次、gui-chat-smoke 1 次。结论不通过，问题 2 个（P1 不贴底时发消息不显示；P2 已打开的对话会话改不了名、新名字被当成消息发出、侧边栏随后冻结），另有 13 条备注。
- 裁决（主会话）：全部采纳，编号接着此前的 X2：X3（codex P1）、X4（codex P2）、X5（codex P3）、X6（R16.3 当前会话 + 窗口失焦的黄点，先查依据再定）、X7（界面 P1）、X8（界面 P2），加测试修正。返工任务见 tasks.md 的 T14–T20。
- 截图：`evidence/verdict-c1/`（8 张，界面验证者手工验证时截的，说明 X7 和 X8）。
- 下面原样收入两份结论的全文（收入前核对过不含 token）。

---

# 关口 C 第 1 轮 · 验证结论全文（一）：非界面部分（codex）

# 双模式会话独立验证结论

- 结论：**不通过**（3 条确认问题：2 条功能问题、1 条协议文档错误；环境限制及GUI待汇总另列，不冒充产品缺陷）。

- 提交：e869add03fd79e7735d45b740aa57d9af4c1b240
- 验证快照：{"schema":1,"docs_dir":"docs/changes","head":"e869add03fd79e7735d45b740aa57d9af4c1b240","head_tree":"b58c4926876d6dca94d03f0e017504a74b2a24ec80eff298d3a5f37737ec1751","target":"7d25cbdeee006f7ad5bdf01879848274a383bb69","target_tree":"4d0d58c229e8bd52a71ea65ae7e10f56c3fa665383b7f15a91e05944ed9b569b"}
- 验证者：Codex（GPT-6），独立验证者，未编写被验代码。
- 环境版本（开始）：`git rev-parse HEAD` 输出 `e869add03fd79e7735d45b740aa57d9af4c1b240`；`git status --short` 输出为空（干净）。环境 local，cwd 为指定 verify-dm worktree。
- 安全边界：所有 tmux 检查使用独立 TMUX_TMPDIR；不启动 Electron；不访问真实 8765；不修改已跟踪文件；临时数据仅 /tmp。

## 检查（第一批）

- `cd vibe-remoted && gofmt -l .`：exit 0，无文件输出。登录 shell 的 fnm 曾提示无法写 multishell 目录，命令本身正常；之后全部使用非登录 shell。
- `cd vibe-remoted && GOCACHE=/tmp/vr-dm-gocache go vet ./...`：exit 0，无输出。
- `cd desktop && npm run typecheck && npm test`：exit 0，全部测试脚本通过，没有安装依赖。
- `TMUX_TMPDIR=$(mktemp -d /tmp/vr-dm-XXXXXX) GOCACHE=/tmp/vr-dm-gocache CLAUDE_CONFIG_DIR=/tmp/vr-dm-safe-config TMPDIR=/tmp node /Users/mac/github/vibe-remote/.devflow-tmp/verify-dm/.claude/skills/verify/scripts/ws-chat-smoke.mjs`：exit 0，临时端口 29309，临时数据 /private/tmp/vr-chat-IEc8xd。

```text
work dir /private/tmp/vr-chat-IEc8xd
daemon up on 127.0.0.1:29309, claude 2.1.210 (fake)
PASS chat: create — id=1795143180589-44313287
PASS chat: replay before ready — one session, one process
PASS chat: two clients — both saw both, same order, one process
PASS chat: pending survives reconnect — request 4f149e55-8e66-4d7b-bf57-4b2f1a839106 answered after reconnect
PASS chat: resync 50 — backlog 54, seq 14..67
PASS chat: handoff — terminal 1795143181040-28dee999 runs --resume 658e8c18-ae12-4377-ad2c-24dacdb679dd
PASS chat: daemon restart → ended — history 2, reloaded and replying
PASS chat: state without hooks — idle → running → idle → waiting → idle
PASS chat: delete keeps jsonl — process gone, transcript kept

all chat checks passed
```
- `ps -axo pid,ppid,pgid,etime,command`：没有运行，原因：沙箱返回 `operation not permitted: ps`；不能据此宣称进程清单为空。

## 探索实验（已完成部分）

- 将 daemon 源码复制到 `/tmp/vr-dm-experiment/vibe-remoted`，只在副本增加 `independent_test.go`；原 worktree 无改动。
- 命令：在临时副本运行 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-dm-XXXXXX) TMPDIR=/tmp GOCACHE=/tmp/vr-dm-gocache CLAUDE_CONFIG_DIR=/tmp/vr-dm-safe-config go test -race -v -count=1 -timeout 2m ./internal/chat -run '^TestIndependent'`。第一次误在 repo 根执行返回“cannot find main module”，改在临时模块目录执行；没有修改检查来让复现通过。
- 流式尾巴实验实际输出：`reset=true omitted=0 retained-deltas=20000 message_start=0 total-generated-deltas=20001`，`reset lost message identity: message_start=0, want 1`。起了 fake claude 后从实际 Session 注入协议消息，触发 TailMax 淘汰；没有伪造补发数组。
- 再从原 worktree 用 esbuild 把 `desktop/src/renderer/chat/session.ts` 打包到 `/tmp/vr-dm-session.mjs`，Node 读取上述真实补发帧，再送完整 assistant 与 result。实际输出：`assistantCount: 2`；无 id 的残片长度 20000，`id=long-reply` 的完整回复长度 20001。
- 问题 P1：**长回复 reset 补发后重复显示残片和完整回复**。严重程度：中；拦：是。证据：`internal/chat/session.go:931` 淘汰流式开头但不保留累积快照、不更新 reset 判断或省略数；`desktop/src/renderer/chat/session.ts:574` 无 message_start 时创建无 id 的预览，随后完整消息按 id 创建第二条。R12.4 应为“一条回复完整显示一次，没有半截重复”，实际两条。既有 `TestResyncMidStreamTail` 只发 60 个增量，`test-chat-session` 的 preview merged 只覆盖保留 message_start 的短回复，均未守此边界。

## 运行环境备注（孤儿用例）

- 全量 Go 与单进程 invariant 均卡在 `TestOrphanCleanup/stubborn_needs_SIGKILL`：macOS 沙箱禁止 `ps`，`cmdlineMentions` 因此不能确认假 claude 身份，清理不发信号，而用例直接 `<-gone` 没有本地等待上限。
- 根据本次测试生成的 argv.log、会话 UUID、pid marker、创建时间和进程组核对，两个停住的假 claude 为 PID 52310、56480。尝试仅清理这两个自启动进程，`os.killpg(..., SIGKILL)` 和 `os.kill(..., SIGKILL)` 均被沙箱拒绝：`PermissionError: [Errno 1] Operation not permitted`。没有向其他进程发信号；此处不能声称清理完成，后续继续核对。

- 目录碰撞实验：在临时副本运行 `go test -race -v -count=1 -timeout 2m ./internal/chat -run '^TestIndependentLatest'`（带独立 TMUX_TMPDIR 和临时 CLAUDE_CONFIG_DIR），exit 1。规范化后的 `a-b` 与 `a/b` 编码相同，仅 B 有 JSONL、A 没有历史，`LatestSessionForWorkdir(projects,A)` 却返回 B 的 UUID。初版实验忘了规范化 macOS `/tmp`，没有复现；改为真实 daemon 使用的 canonical path 后复现。
- 再运行 `go test -race -v -count=1 -timeout 2m ./internal/server -run '^TestIndependentContinue'`（同样隔离），通过真实临时 WebSocket 新建 A + flag `continue`。实际输出：`selected-workdir=/private/tmp/TestIndependentContinueDirectoryCollisionWS4276680393/001/a-b history-cwd=/private/tmp/TestIndependentContinueDirectoryCollisionWS4276680393/001/a/b claude-id=4c90eead-5716-4caf-8fb5-2cc6c3453083 other-directory-id=4c90eead-5716-4caf-8fb5-2cc6c3453083`，exit 1。
- 问题 P2：**不同工作目录的 `-c` 会接错对话**。严重程度：中；拦：是。`internal/chat/transcript.go:31` 的编码把 `/`、`.` 都替成 `-`；`:102` 在编码目录有文件时直接选最新 id，没有按 JSONL 的 cwd 核对。这会显示并继续另一个目录的历史，且终端 continue 同样调用该函数。R1.5 和 H6 应为“该目录最近一次对话”；实际 A 无历史却继续 B。既有 TestCreateContinueResumesLatest、TestFindTranscriptAndLatest 不覆盖编码碰撞。

## 检查（分包与 invariants）

- 全部 Go 命令使用 `GOCACHE=/tmp/vr-dm-gocache`；`CLAUDE_CONFIG_DIR=/tmp/vr-dm-safe-config` 防止访问真实 claude 配置；`TMPDIR=/tmp`；下面 TMUX_TMPDIR 为通过环境传给整个 check 的独立目录，涵盖 `&&` 后的所有命令。
- `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d /tmp/vr-dm-XXXXXX) go test -race -count=1 -timeout 3m ./internal/session ./internal/server ./internal/config ./internal/protocol`：exit 1；session 仅 TestLoadChatsMarksDaemonRestart 因 `ps` 被禁而失败（timeout waiting for orphan gone）；其余三个包通过。输出：

```text
2026/11/20 10:57:49 warning: failed to kill tmux session vibe-remote-recovered: exit status 1
2026/11/20 10:57:49 warning: failed to kill tmux session vibe-remote-recovered-clean: exit status 1
--- FAIL: TestLoadChatsMarksDaemonRestart (15.22s)
    chat_manager_test.go:513: timeout waiting for orphan gone
FAIL
FAIL	github.com/lflish/vibe-remote/vibe-remoted/internal/session	33.863s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	17.870s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/config	1.830s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/protocol	2.011s
FAIL
```
- `cd vibe-remoted && go test -race -count=1 -timeout 3m -v ./internal/chat -run <除 TestOrphanCleanup 外全部测试的精确正则>`：exit 0，共 93 个顶层测试（以实际日志命令计数为准）；原始正则命令完整记录如下。这是对被环境阻塞包的剩余用例补跑，不替代失败的全量检查。

```text
命令：['go', 'test', '-race', '-count=1', '-timeout', '3m', '-v', './internal/chat', '-run', '^(TestDroppedMessageResendWithSameIDIsDelivered|TestResendDuplicateReportsCompleted|TestResendAfterWatchdogReportsCompleted|TestStoreRoundTrip|TestStorePermissions|TestStoreCorruptQuarantined|TestStoreAtomicWrite|TestHistoryFiltersSidechainAndMeta|TestHistoryFullStream|TestSyncHistoryBeforeCutoff|TestBypassLocksMode|TestBypassStillAsksQuestions|TestRespondAllowOnce|TestRespondAlwaysWithSuggestion|TestRespondDenyWithMessage|TestPendingWaitsWithoutClient|TestRespondFirstWins|TestCancelRequestResolves|TestPlanApproveSetsMode|TestPlanApproveManual|TestPlanReviseStaysPlan|TestAskAnswersRoundTrip|TestSetModeUpdatesState|TestRespondQueueFullKeepsPending|TestPlanSetModeQueueFull|TestRespondVsCancelRace|TestMultiplePending|TestRespondRejectsForeignRule|TestRespondFillsUpdatedInput|TestRespondRejectsBadInput|TestLockedSessionCanApprovePlan|TestRespondSetModeRespectsLock|TestRespondSetModeOnlyForPlan|TestParseVersion|TestProbeCachesAndRecheck|TestWorkdirTrusted|TestFindTranscriptAndLatest|TestProjectsDir|TestNoCredentialAccess|TestSendEchoAndStream|TestSendRejectsEmpty|TestSendUTF8|TestSendDedupClientMsgID|TestSendWhenNotRunning|TestInterruptStopsTurn|TestInterruptIdleNoop|TestInterruptResolvesPending|TestInterruptQueueFullKeepsPending|TestRingOverflowReset|TestResyncMidStreamTail|TestStaleEpochResets|TestSubscribeAtomicBacklog|TestSlowSubscriberDisconnected|TestPendingSurvivesRingEviction|TestCrashEmitsExitAndEnded|TestInitVersionTooOldEnds|TestInitCapabilitiesMissingDegrades|TestSlashCommandsPrecedence|TestInitResentEachTurnUpdatesMeta|TestHookLinesPassThrough|TestNonJSONLinesSkipped|TestOversizeLineDropped|TestUnknownControlRequestAnswered|TestDrainWithoutSubscribers|TestOutstandingRecoversAfterStaleTurn|TestLateResultAfterStaleTurn|TestStillQueuedIgnored|TestStopIsIdempotent|TestStopTimings|TestStopAccountsForEveryQueuedMessage|TestReaderJoinBeforeSettle|TestExitCallbackNoSessionLock|TestSingleProcessRestart|TestRestartWithoutTranscriptUsesSessionID|TestResumeMissingTranscriptFails|TestParseClaudeMdExample|TestParseNotClaude|TestParseRejectsShellSyntax|TestParseRejectsConflictingArgs|TestHandoffCommandQuoting|TestCommandFromConfigOnly|TestAssembledCommandRuns|TestParseOptionValuesAreNotFlags|TestHandoffKeepsContinueLikeOptionValues|TestChatArgvKeepsPromptValueContinue|TestDaemonArgsGoBeforeDashDash|TestValueOptionsCoverClaudeHelp|TestStopKillsTermIgnoringDescendantHoldingStdout|TestMainTokenEnvNotInheritedByProbe|TestMainTokenEnvFilteredFromChatProcess|TestFakeClaudeEcho|TestFakeClaudeMatchesProbe|TestFakeClaudeBehaviours)$']
PASS
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	15.599s
```
- `cd vibe-remoted && go test -race -count=1 -timeout 2m ./internal/chat -run '^TestOrphanCleanup/(ended_records_unchanged|unrelated_process_untouched|ended_and_confirmed_gone|survivor_keeps_the_claim)$'`：exit 1，实际失败是 ended_and_confirmed_gone 与 survivor_keeps_the_claim（分别“orphan still running after cleanup”“orphans []”），原因同为 `ps` 不可用；另外两个子例通过。未修改或跳过任何源码。
- 单进程 invariant 的 `&&` 后半段因前半段阻塞未到达，另以**原样后半段**单独补跑：

```sh
cd vibe-remoted && go test -race ./internal/session ./internal/server -run 'TestReloadWaitsForOldProcess|TestChatCreateReplaySameID|TestContinueReusesRunningSession|TestConcurrentContinueCreatesOneProcess|TestRestartRefusedWhenUResumedElsewhere|TestHandoffVsReloadOneWins|TestReloadVsDeleteSerialized|TestTerminalContinueBusyWhenChatOwns|TestTerminalContinueClaimsLatest'
```

ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	5.337s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	9.119s
exit 0。
- 命令型 invariants 已完成结果（下方日志的 `$ TMUX_TMPDIR=…` 是 runner 的环境标注；runner 将变量传给整个 shell，实际 check 仍原样执行，变量并非只附在 cd 上）：

```text
$ TMUX_TMPDIR=/tmp/vr-dm-1jne0een cd vibe-remoted && go test -race ./internal/server -run TestTerminalFramesUnchangedV3
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	1.882s
exit=0

$ TMUX_TMPDIR=/tmp/vr-dm-8l_kvjc_ cd vibe-remoted && go test -race ./internal/server -run TestChatDisconnectKeepsProcess
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	4.179s
exit=0

$ TMUX_TMPDIR=/tmp/vr-dm-3y52ivih cd vibe-remoted && go test -race ./internal/chat -run TestPendingSurvivesRingEviction
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	1.912s
exit=0

$ TMUX_TMPDIR=/tmp/vr-dm-kx0zfhc7 cd vibe-remoted && go test -race ./internal/chat -run TestRespondRejectsForeignRule
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	1.878s
exit=0

$ TMUX_TMPDIR=/tmp/vr-dm-q2opch4a cd vibe-remoted && go test ./internal/chat -run TestCommandFromConfigOnly && go test ./internal/server -run TestAttachIgnoresCommandFields
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	0.459s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	1.045s
exit=0

$ TMUX_TMPDIR=/tmp/vr-dm-np2essyc cd desktop && npm run test:chat-markdown && npm run test:chat-render-guard

> vibe-remote@0.1.3 test:chat-markdown
> node scripts/test-chat-markdown.mjs

ok - test-chat-markdown: DOMPurify runs on the injected window
ok - test-chat-markdown: gfm
ok - test-chat-markdown: code block copy button
ok - test-chat-markdown: raw html escaped
ok - test-chat-markdown: sanitizer drops what markdown-it might let through
ok - test-chat-markdown: links get no target and are intercepted
test-chat-markdown checks passed (6)

> vibe-remote@0.1.3 test:chat-render-guard
> node scripts/test-chat-render-guard.mjs

chat render guard passed (15 files)
exit=0

$ TMUX_TMPDIR=/tmp/vr-dm-_wggcbn2 cd vibe-remoted && go test ./internal/session -run TestChatEnvHookTokenOnly
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	1.201s
exit=0

$ TMUX_TMPDIR=/tmp/vr-dm-kjhkm2y4 cd vibe-remoted && go test ./internal/chat -run TestNoCredentialAccess
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	0.264s
exit=0

```

- 项目 verify 的终端协议冒烟：从本 worktree `go build -o /tmp/<自建目录>/daemon ./cmd/vibe-remoted`，Python 启动 `/bin/bash` 临时 daemon，allowed_roots 只含自建 project，独立 tmux；运行 `VR_TOKEN=<临时 token> node .claude/skills/verify/scripts/ws-smoke.mjs 127.0.0.1:55961 /private/tmp/vr-dm-ws-term-lvx24ttn/project`：exit 0，12/12。随后 TERM 并 Wait 临时 daemon、清理自己的 tmux server。首次临时 config 错写 tmux（正确字段 use_tmux），daemon 拒绝未知字段，exit 1；修正验证脚本配置后完成。

```text
port=55961 data=/private/tmp/vr-dm-ws-term-lvx24ttn
PASS /healthz
PASS /api/v1/info version=dev
PASS session A ready id=1795143558338-382e667c
PASS A sees its own VIBE_REMOTE_SESSION_ID
PASS A got a hook token distinct from the main token
PASS hook token → events 204
PASS notify frame delivered to session A
PASS hook token rejected for another sessionId
PASS hook token rejected on /api/v1/info
PASS B sees its own VIBE_REMOTE_SESSION_ID (no env bleed from A)
PASS deleted 1795143558338-382e667c
PASS deleted 1795143558441-f430d69c

all checks passed
exit=0
```

- 环境工具版本：`go version` → `go1.26.2 darwin/arm64`；`node --version` → `v22.22.2`；`npm --version` → `10.9.7`。npm test 实际执行 23 个脚本，全部通过。
- 原始全量命令 `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d /tmp/vr-dm-XXXXXX) go test -race -count=1 -timeout 20m ./...`（另有 GOCACHE、临时 CLAUDE_CONFIG_DIR、TMPDIR）：执行后卡在 chat 包 TestOrphanCleanup/stubborn_needs_SIGKILL 的 `<-gone`；已读代码并用其他子例确认是沙箱 ps 限制，约 8 分钟后通过本次 exec 会话的 Ctrl+C 中止，exit 130，**没有跑完，不能记通过**。全部其他包和 chat 剩余 93 个顶层用例已分包跑完。session 包的同类 TestLoadChatsMarksDaemonRestart 失败已单列。
- 单进程 invariant 的原样前半段 `cd vibe-remoted && go test -race ./internal/chat -run 'TestSingleProcess|TestOrphanCleanup'` 同样卡住，通过其自启动 exec 会话的 Ctrl+C 中止，exit 130；不是成功。该 invariant 的后半段另跑原样命令通过。其余 invariants 原始 runner 在此阻塞后也中止，余下命令此前已逐条原样补跑通过。

## protocol-sync 独立核对

应用项目 `.claude/skills/protocol-sync/SKILL.md`：完整读取 protocol.go、protocol.ts、rest.ts、docs/protocol.md，并检查 server.routes 与 handler。下表的字段均逐项核对 JSON 名、类型、可选性；TS 的 ready.proto? 与 info.chat?/claudeVersion? 是兼容旧接收端，Go 新生产者始终给值，允许此宽松。

| 帧 / 对象 / 端点 | Go 与 TS 的字段核对 | 文档核对 |
|---|---|---|
| auth | type、token 相同 | 相同 |
| attach | sessionId?、newSessionId?、cols/rows（uint16↔number）、workdir?、flags?、mode?、ui?、epoch?、since?、handoffFrom? 相同 | 相同 |
| ready | sessionId/workdir/proto/mode、worktree 元数据?、ui?/claudeSessionId?/existing?/handoffFrom? 相同 | 相同；“终端省略所有 chat 字段”只适用于普通终端，交接终端有 handoffFrom 的例外在下文明确 |
| data | type/payload（base64 字符串）相同 | 相同 |
| resize | type、cols/rows 相同 | 相同 |
| sessions / SessionInfo | list；id/title/workdir/created/mode、worktree 元数据?、ui?/state?/activitySeq?/epoch?/endReason? 相同 | 相同 |
| ping / pong | type 相同（Go 用 Frame 信封） | 相同 |
| exit | type/code 相同 | 相同 |
| error | type/message/code?/fatal? 相同 | 12 个错误码与 handler fatal 参数相同 |
| notify / EventRequest | type（仅帧）、sessionId/kind/message? 相同 | 相同；未知 kind 不做错误处理 |
| chat | type/seq/h?/msg，RawMessage↔对象 | 相同 |
| chat_sync | type/epoch/reset/omitted/historyCount/backlog 相同 | 相同 |
| chat_state | type/status/permissionMode/permissionLocked/pending/degraded?/slashCommands/claudeVersion/claudeSessionId/ended 相同 | 相同 |
| PendingRequest | requestId/seq/request 相同 | 相同 |
| SlashCommand | name/description?/argumentHint? 相同 | 相同 |
| ChatEnded | reason/code?/message?/handedOffTo?/stderrTail?/claudeVersion?/minClaudeVersion? 相同 | 相同 |
| chat_ack | type/op/ref?/ok/code?/message?/duplicate?/completed? 相同 | **遗漏 message?，见 P3** |
| chat_send | type/clientMsgId/text 相同 | 相同 |
| chat_respond / ChatResponse | type/requestId/response/setMode?；behavior/updatedInput?/updatedPermissions?/message?/interrupt? 相同 | 相同 |
| chat_interrupt | type 相同 | 相同 |
| chat_set_mode | type/mode 相同 | 相同 |
| GET /healthz | 无鉴权；存活探针 | 相同 |
| GET /api/v1/info（?recheck=1） | version/proto/hostname/tmux_enabled/default_workdir/allowed_roots/claude_flags/chat；chat supported/reason?/claudeVersion/minClaudeVersion；flag 不下发 arg | 相同 |
| GET /api/v1/sessions | Bearer；返回 sessions/list | 相同 |
| DELETE /api/v1/sessions/{id} | Bearer；204/404/409 worktree_preserved + message/worktreeRoot/branch | 相同 |
| POST /api/v1/sessions/{id}/rename | Bearer；body name，204/404/500，64KiB 限制 | 相同 |
| POST /api/v1/sessions/{id}/reload | Bearer；204 terminal、202 chat、409 busy error/owner/message、404 | 相同 |
| GET /api/v1/fs | Bearer；path/entries/parent?/chatTrust? | 相同 |
| POST /api/v1/events | 主 token 或对应 session hook token；sessionId/kind/message?；204/401/400/413 | 相同 |

开放集合另外核对：ack 9 码、vr_resolved 5 outcomes、vr_notice 的 line_dropped/stale_turn/set_mode_failed/dropped_on_stop（stderr 保留）、vr_exit、vr_client_msg_id、vr_stale、ended.reason 6 值、chat.reason 7 值（含 workdir_untrusted）、chatTrust 3 值；实现、TS 和文档取值一致。未知 WS 帧两端忽略；TS 运行时 endedView 有 default，未知 error.code 只按 fatal 处理。版本号 Go/TS=3，文档第 3 行存在。

- 问题 P3：**协议文档遗漏 chat_ack.message，R18.2 未成立**。严重程度：低；拦：是（需求明确要求三处无差异，用户指定文档错误可判不通过）。证据：`internal/protocol/protocol.go:314` 为 `Message string json:"message,omitempty"`；`desktop/src/shared/protocol.ts:252` 为 `message?: string`；`docs/protocol.md:325–336` 的 chat_ack 字段说明没有 message。nackMsg 的 too_large/invalid_response 实际会产出它，ChatView 会读它。test-report 已承认该遗漏，却把 R18.2 和完成条件记为通过；这一项应补文档后重核对。此问题不会改变当前 Go/TS 互通结果。

## 场景逐项核对（R1–R10）

说明：以下测试名由测试报告提供索引后，读取实际测试代码核对断言。Go 的非孤儿用例均已在本轮 race 分包运行，TS 脚本均在本轮 npm test 运行；“通过”仅指所述已运行的范围，不代替真实 Electron 验收。所有 GUI 行均只读代码，**运行由另一名验证者负责**；没有启动 Electron 或运行两个 GUI 脚本。测试脚本名的根目录为 desktop/scripts/，GUI 根目录为 .claude/skills/verify/scripts/。

| 场景 | 守护测试、真实断言、是否运行 | 结果 |
|---|---|---|
| R1.1 默认终端 | Go TestAttachWithoutUIStaysTerminal 断言省略 ui 得到 terminal ready；已运行。GUI R1.1 断言新会话仅一个、ui=terminal、没有 chat view、active 侧栏是 terminal；运行由另一名验证者负责。 | 非 GUI 通过；默认选择及真实界面待其汇总 |
| R1.2 新建对话 | Go TestWSChatCreateReady 断言 ready.ui=chat、claude UUID、sync/state 正常；WS chat:create 已运行。gui-smoke chat session created via picker 等待可用输入框和 chat 侧栏；运行由另一名验证者负责。 | 非 GUI 通过；真实界面待其汇总 |
| R1.3 非 claude 置灰 | TestInfoChatNotClaude、TestParseNotClaude 拒绝 bash/codex；test-chat-availability not_claude 断言不可选和正确文案 key，均已运行。GUI R1.3 断言精确中文、disabled、点击仍未选、默认终端；运行由另一名验证者负责。 | 非 GUI 通过 |
| R1.4 旧 claude / daemon | TestInfoChatTooOld、TestParseVersion 断言最低 2.1.210；availability 分别断言 proto2/缺 chat 升级 daemon、too_old 升级 claude 并带两版本，已运行。GUI R1.4/R17.2 精确原因和卡片禁用；运行由另一名验证者负责。 | 非 GUI 通过 |
| R1.5 -c 最近完整历史 | TestCreateContinueResumesLatest 校验最新 UUID、argv 用 resume 且无 continue；TestHistoryFullStream/TestSyncHistoryBeforeCutoff 保留工具与历史顺序；test-chat-window 守 300 首屏和逐批到 0，已运行。GUI R1.5 核对 2000 条 user/assistant（3000 JSONL 行）、Read 工具、第一条可上滑找到、后续消息接尾、resume UUID；运行由另一名验证者负责。独立 a-b / a/b 实验从真实 WS 接错历史。 | **不通过，P2**；真 claude JSONL 保真部分仍未验证 |
| R1.6 固定 bypass | TestBypassLocksMode 拒绝切模式、Bash/Edit/Write 不询问；TestBypassStillAsksQuestions 守 Ask/Plan 不被跳过，已运行。GUI R1.6 断言菜单只有 bypass、禁用、原因、无工具权限卡；运行由另一名验证者负责。 | 非 GUI 通过 |
| R1.7 worktree / flag | TestChatWorktreeAndFlags 校验真实进程 cwd 在新 worktree，argv 的 model 与 append-system-prompt 值，分支和目录元数据，删除清理，已运行。 | 通过（本地 fake） |
| R2.1 ready 前重放 | TestChatCreateReplaySameID/TestChatCreateConcurrentSameID 断言相同 session 指针/id、只一条启动记录；WS replay before ready 一会话一进程；test-chat-client create replay 断言重连保留 newSessionId/ui，均已运行。 | 通过 |
| R2.2 重载先退旧进程 | TestReloadWaitsForOldProcess 1ms 采样 overlap=false、新 pid 不同、旧 pid gone、owner 不变；TestSingleProcessRestart/fake 违反唯一性日志为空、StopTimings，已运行。信号存在性测试的沙箱返回有限，fake 的 pid marker/唯一性日志与 Wait 是交叉证据。 | 本地正常重载通过；异常孤儿见 R2.5 |
| R2.3 交接先停 | TestHandoffStopsChatFirst 校验 terminal 启动前对话 pid marker 已消失/无并存；handoff WS 冒烟用相同 UUID resume，均已运行。 | 通过 |
| R2.4 两桌面共享 | TestTwoClientsShareProcess 两端各看到两条 user/reply，顺序相同，只有一 pid/启动；WS two clients 同断言，已运行。 | 通过 |
| R2.5 daemon 重启 | WS daemon restart→ended 校验优雅退出后历史可读、ended/reload 续聊，已运行通过。TestLoadChatsMarksDaemonRestart 失败 timeout waiting for orphan gone；TestOrphanCleanup 卡住及两个子例失败，ps 沙箱被禁。 | **异常重启孤儿路径尚未验证**；不把环境失败认作已证实产品缺陷 |
| R2.6 双 -c 同一对话 | TestContinueReusesRunningSession/TestConcurrentContinueCreatesOneProcess 断言 existing、相同 session、owner 和一个启动，已运行。 | 已有同目录正常身份通过；目录选择边界 P2 仍拦 |
| R3.1 发送与流式 | TestSendEchoAndStream 验证 user echo、多个 delta、完整 assistant、result/idle；test-chat-session echo→stream→result 和 test-chat-view structure and send 校验立即气泡及一条回复，已运行。gui-smoke chat reply rendered 等待 user/reply；运行由另一名验证者负责。 | 非 GUI 通过 |
| R3.2 Markdown | test-chat-markdown gfm / code block copy button 在真实 jsdom 上断言标题列表表格行内代码和按钮写剪贴板，已运行。GUI R3.2 补字体等宽和 Electron 剪贴板值；运行由另一名验证者负责。 | 非 GUI 通过；真实字体/剪贴板待其汇总 |
| R3.3 HTML / 脚本 / 链接 | markdown 测试先断言 DOMPurify.isSupported=true，再断言 script/img/on* 无活节点、危险 href 无、raw 文本存在、点击链接被拦并转 IPC；render-guard 扫 HTML sinks；主进程只放行 URL protocol 白名单；已运行。GUI R3.3 stub open-external 并断言 https 参数、URL 未变、无 dialogs；运行由另一名验证者负责。 | 非 GUI 通过；系统浏览器实际拉起未覆盖（IPC 白名单代码已核对） |
| R3.4 空输入 | TestSendRejectsEmpty 断言拒绝且无 stdin 写；test-chat-queue empty not sent 断言空白无发帧，已运行。 | 通过 |
| R4.1 Read / Grep | test-chat-session tool pairing 断言按 tool_use_id 配对和结果内容；test-chat-view 断言 Read 路径、折叠和输出为 text；permission summarize 测 Grep 搜索词，已运行。GUI R4 断言 Read/Grep 默认折叠可展开；运行由另一名验证者负责。 | 非 GUI 通过 |
| R4.2 Bash | tool pairing/view 断言 command、result、失败 error 状态及展开，已运行。GUI R4 测成功 Bash 与 echo 命令，运行由另一名验证者负责；GUI 的成功输出依赖工具文本抽取，TS pairing 对内容作精确断言。 | 非 GUI 通过 |
| R4.3 Edit / Write | test-chat-diff 分别断言 Edit 旧新、Write 全新增、行号；view 断言 add/del 节点及文件参数，已运行。GUI R4 只测 Edit 的颜色类/展开，不单独测 Write；运行由另一名验证者负责。 | 逻辑/DOM 通过；真实分色待其汇总 |
| R4.4 工具出错 | pairing 断言 is_error→isError=true 和错误文本；view 断言 Bash.error、默认展开并可见 exit 1，已运行。GUI R4 failed Bash 同测；运行由另一名验证者负责。 | 非 GUI 通过 |
| R5.1 允许一次 | TestRespondAllowOnce 断言 tool 跑、resolved=allowed，第二次同请求仍待答；view 断言 response.allow 和原 input；已运行。gui-smoke allow once resumes 等卡消失和 done Bash；运行由另一名验证者负责。 | 非 GUI 通过 |
| R5.2 允许并不再询问 | TestRespondAlwaysWithSuggestion 检查 updatedPermissions 转发、fake 第二次不问、daemon 未创建工作区 .claude；permission describe/grouping 守范围、destination、规则只来自建议；已运行。fake 写 FAKE_CLAUDE_RULES，并非真实 .claude/settings.local.json。 | **部分成立；真实 claude 落盘尚未验证**，不能记整个场景通过 |
| R5.2b 无建议 | permission no suggestions 返回 null；view 只渲染可用选项，已运行。 | 通过（逻辑/DOM） |
| R5.3 拒绝并说明 | TestRespondDenyWithMessage 断言 claude 复述意见、resolved=denied；permission buildAnswer 精确 deny/message，view 拒绝按钮送相同说明，已运行。 | 通过（本地 fake/DOM） |
| R5.4 断线等待 | TestPendingWaitsWithoutClient 在无订阅者下等 2s，断言 pending 同 id、waiting、pid alive、control_response=0，已运行；读实现没有权限等待超时器。 | 通过；2s 有界实验加代码核对支撑“不自动答”，未作无期限实测 |
| R5.5 重连待答重现 | TestResyncRestoresPending/tool 断线后创建请求、attach 后同 pending、答后 done Bash；TestPendingSurvivesRingEviction 独立 pending 不被 1000 环淘汰；WS pending survives reconnect，已运行。 | 通过 |
| R5.6 回答送达前掉线 | session submitting reverts 断言 reset 和 incremental 后重回 open；RespondQueueFullKeepsPending 守写队列未接收不能 resolved，已运行。GUI R5.6 丢出站帧、submitting→open、再次答后 tool ok；运行由另一名验证者负责。其“回答未送达时未执行工具”的一条断言永真，见放松检查。 | 状态机通过；GUI 只部分覆盖 spec，须保留此缺口 |
| R5.7 重复回答 | TestRespondFirstWins/TestTwoClientsRespondRace 校验第二次 nack=request_not_pending、claude 只收一次 response；view handledElsewhere 文案，已运行。GUI R5.7 扣入站帧后答、显示已在别处处理、vr_resolved=1；运行由另一名验证者负责。 | 非 GUI 通过 |
| R5.8 请求取消 | TestCancelRequestResolves 断言 cancelled、pending 为空、后答 rejected；session cancelled/view 状态关闭，已运行。 | 通过 |
| R6.1 批准自动编辑 | TestPlanApproveSetsMode 断言 response 后 set_permission_mode=acceptEdits、Write 不再问、最终模式；permission plan opt1 精确帧；已运行。GUI R6 等 acceptEdits；运行由另一名验证者负责。 | 非 GUI 通过 |
| R6.2 批准逐个确认 | TestPlanApproveManual 校验 default、之后 Write pending；permission opt2 精确帧；已运行。GUI R6 等 default；运行由另一名验证者负责。 | 非 GUI 通过 |
| R6.3 继续完善 | TestPlanReviseStaysPlan 断言 deny+意见被复述、不发模式切换、plan 保持；permission opt3 不带 setMode；已运行。GUI R6 等意见和新 requestId，但只记录 midMode 未断言 plan；运行由另一名验证者负责。 | Go 断言补齐 GUI 模式盲点，本地通过 |
| R6.4 离线计划 | TestResyncRestoresPending/plan 的三种选项核对重连全文非空且等于原计划、响应效果，已运行。 | 通过（WS/fake）；实际卡片排版由另一名验证者负责 |
| R7.1 单选多选 | TestAskAnswersRoundTrip 复述各答案；permission buildAnswer question 精确 answers map；view question prompt 单/多选提交，已运行。GUI R7 Banana/Blue，运行由另一名验证者负责。 | 非 GUI 通过 |
| R7.2 其他答案 | 同上精确自由文本 Purple with green stripes；GUI R7 my own colour 复述，运行由另一名验证者负责。TS/Go 已运行。 | 非 GUI 通过 |
| R7.3 未答完不可提交 | permission questionComplete 精确 complete=false/missing 索引；view question prompt 检查按钮 disabled；已运行。GUI R7 两题未答均标红、答一题只剩另一题、答齐可提交；运行由另一名验证者负责。 | 非 GUI 通过 |
| R8.1 回复中断 | TestInterruptStopsTurn 断言 interrupt control 请求、result interrupted、idle 可续聊；session interrupted result/view stop，已运行。GUI R8 Esc 和按钮各增加一中断标记并再发；运行由另一名验证者负责。 | 非 GUI 通过 |
| R8.2 权限等待中断 | TestInterruptResolvesPending 校验 interrupted、pending 清空且工具未执行；GUI R8 Esc 关闭卡、标中断、工具不为 ok；运行由另一名验证者负责。Go 已运行。 | 非 GUI 通过 |
| R8.3 空闲 Esc | TestInterruptIdleNoop 无 control 请求/状态变化；GUI R8 transcript 长度与另一端 chat 帧数不变；运行由另一名验证者负责。Go 已运行。 | 非 GUI 通过 |
| R9.1 忙时两条有序排队 | test-chat-queue busy: two queued messages go in order, one per result 精确一回合放一条及 FIFO；view 两项排队，已运行。GUI R9 在发两条后删除一条，只能证明保留一条发送，不能单靠 GUI 证明两条均依序发；运行由另一名验证者负责。 | 逻辑 FIFO 通过 |
| R9.2 撤回 | queue remove 断言 withdrawn 永不发送；view withdraw，已运行。GUI R9 q-two userCount=0；运行由另一名验证者负责。 | 非 GUI 通过 |
| R9.3 中断退回输入框 | queue interrupt 精确返回全部队列/不自动发送；view input 值，已运行。GUI R9 input 包含 q-three、userCount=0；运行由另一名验证者负责。 | 非 GUI 通过 |
| R10.1 斜杠列表 | TestSlashCommandsPrecedence 守 init 来源/优先级；session state slashCommands；view 过滤、选择、标题与滚动；静态 slash-menu-layout，已运行。GUI R10 精确 compact/review/fake-skill、/re 过滤和 Enter /review；#40 另测两尺寸长行、title、方向键可见、鼠标选中；运行由另一名验证者负责。 | 非 GUI 通过；真实布局待其汇总 |
| R10.2 终端专用命令 | queue terminal-only 对 login/theme 阻止发送；view 提示/交接入口、X1 结束关闭和换语言重标，已运行。GUI R10 /theme userCount=0、精确提示按钮；运行由另一名验证者负责。 | 非 GUI 通过 |

## 场景逐项核对（R11–R19）

| 场景 | 守护测试、真实断言、是否运行 | 结果 |
|---|---|---|
| R11.1 切换权限模式 | TestSetModeUpdatesState 核对发 set_permission_mode 后状态更新；Plan 两测试校验新模式对 Write 的作用；view mode switcher 精确发送模式，已运行。GUI R11 Shift+Tab 三态循环、菜单和 acceptEdits 下 Write 无提示；运行由另一名验证者负责。 | 非 GUI 通过 |
| R11.2 bypass 只读 | TestBypassLocksMode 拒绝 setMode、无模式请求写入；view locked 模式选项，已运行。GUI R1.6 只有 bypass、按钮 disabled、说明原因；运行由另一名验证者负责。 | 非 GUI 通过 |
| R12.1 断线继续运行 | TestChatDisconnectKeepsProcess 关闭 WS 后对话继续生成、进程仍在、再次 attach 可用且无真 exit；WS 离线补发实验同样不依赖 hook，已运行。 | 通过 |
| R12.2 50 条有序补发 | TestResyncIncremental50 校验 reset=false、first seq=since+1、len=backlog、连续且不重复 seq、assistant=50；WS resync50 已运行。GUI R12 离线另一 WS 发 burst500 后分隔线≥500、末500条依次1..500、之后续聊；运行由另一名验证者负责。GUI order.slice(-500) 不单独证明更早没有重复，Go 连续 seq/TS 去重补充支持。 | 非 GUI 50 条通过；500 条真实渲染待其汇总 |
| R12.3 超缓冲省略 | TestRingOverflowReset 用1200条完整消息，精确 omitted=204、backlog=1000、seq 连续；session omitted marker 检查200标记位置、空 backlog 也显示标记，已运行。 | 完整消息环场景通过；流式尾巴边界见 P1 |
| R12.4 流式中途重连 | TestResyncMidStreamTail 校验60次增量的 incremental 连续 seq 和一个完整 assistant；session preview merged 在保留 message_start 时校验一条全文，已运行。独立真实 Session reset 尾巴淘汰后，实际 renderer 状态出现无id残片+带id全文。 | **不通过，P1** |
| R13.1 回合错误重试 | session turn error 精确 error 与 retryText（含多消息FIFO）；view ended/retry 检查重新发送，已运行。GUI R13.1 显示529错误、重试使上一 userCount 增1、再次出现错误；运行由另一名验证者负责。 | 非 GUI 通过 |
| R13.2 真退出恢复入口 | TestCrashEmitsExitAndEnded/TestCrashEmitsExitAndEndedWS 校验一 exit、code=1、vr_exit、ended.reason=exited；view ended banner/restart tracking 校验入口和重启后状态，已运行。GUI R13.2 结束中文、stderr、按钮、输入禁用、重启后续聊；运行由另一名验证者负责。 | 非 GUI 通过 |
| R13.3 断线无 exit | TestChatDisconnectKeepsProcess、WS 断线保活已运行，退出仅由进程结束路径产生。 | 通过 |
| R13.4 init 不支持 | TestInitVersionTooOldEnds 覆盖缺版本和低版本，校验 ended/version 信息；view ended states 有终端交接入口，已运行。GUI R13.4 精确最低版本、交接和3s sockets数不变/无reconnect横幅；运行由另一名验证者负责。 | 非 GUI 通过；真实窗口不重连待其汇总 |
| R14.1 新终端接上 | TestHandoffCreatesTerminalWithResume/TestHandedOffTerminalReloadUsesResume 检查相同工作目录、resume同UUID、continue移除、原对话handed_off；WS handoff 等终端 fake interactive resume，已运行。 | 通过（fake 能验证命令和身份；真实 claude 历史显示未覆盖） |
| R14.2 忙时确认再交接 | TestHandoffInterruptsRunningTurn 检查先interrupt/Stop再terminal启动；TestHandoffStopsChatFirst 辅助唯一性，已运行。GUI R14.2 确认文字含“中断当前回合”、终端有resume UUID、原chat ended/输入禁用；运行由另一名验证者负责。 | 非 GUI 通过；确认框交互待其汇总 |
| R15.1 重命名持久化 | TestChatRenamePersists 去ANSI/空白后名字为my chat，shutdown+新Manager加载仍一致；TestChatRenameDeleteREST 守REST改名与list，已运行。双击及多桌面界面刷新只有旧探索文字，当前GUI脚本无独立完整场景。 | 远程落盘/列表通过；双击和另一真实桌面显示尚未在本轮验证 |
| R15.2 删除保留JSONL | TestChatDeleteKeepsJSONL 校验进程退出、Manager/list/store移除、transcript仍在；WS delete keeps jsonl 同测，已运行。侧栏删除交互由另一名验证者负责。 | 非 GUI 通过 |
| R15.3 重载历史续聊 | TestReloadChatReturns202/TestReloadPushesResetSync 校验202、reset新epoch、历史、续聊；TestReloadWaitsForOldProcess 校验先退旧；HandedOff拒绝重载，已运行。 | 非 GUI 通过；侧栏交互由另一名验证者负责 |
| R16.1 灰点 | test-chat-activity chat frame / machine overview 与 index DOM integration 断言后台dot=output、active无点；已运行。真实侧栏打开后清除需GUI/探索，运行由另一名验证者负责。 | 非 GUI 通过 |
| R16.2 绿点 | activity result turns it green 精确后台 idle/当前 none、REST running→idle 同测，已运行。 | 非 GUI 通过；真实显示由另一名验证者负责 |
| R16.3 黄点与通知 | activity pending prompt、fallback does not switch、overview hidden-chat 集成断言后台黄点/notify=true、fallback不切、click才open；已运行。GUI R16.3 真实黄点、fallback日志/Dock角标、不自动切换、模拟notification-click后打开；运行由另一名验证者负责。原生通知显示不在脚本可证明范围；当前会话但窗口未聚焦的黄点覆盖边界见待验证项。 | 后台路径逻辑通过；原生通知/真实窗口及边界尚未验证 |
| R16.4 不需hook | activity REST 断言activitySeq/epoch/state变更驱动点与通知；WS state without hooks 观察idle→running→idle→waiting→idle，已运行。 | 通过 |
| R17.1 现有回归 | gofmt/vet/typecheck/npm test通过；Go全量未跑完，已分包完成非孤儿用例，session孤儿例失败。原终端断言diff无删改。gui-smoke 原有测试本轮没有运行，运行由另一名验证者负责；旧报告1次drag-select失败不能记无失败。 | **全量通过尚未成立**，环境受阻/GUI待汇总 |
| R17.2 新桌面旧daemon | availability proto2与缺chat断言升级daemon且终端未禁用，已运行。GUI R17.2 使用main构建旧daemon，卡片精确文案及终端输入回显；运行由另一名验证者负责。 | 逻辑通过；旧daemon真实互连待其汇总 |
| R17.3 旧桌面新daemon | TestTerminalAttachToChatIsUIMismatch 对无ui的旧attach返回明确fatal ui_mismatch；TestAttachWithoutUIStaysTerminal 保持默认终端；TestTerminalFramesUnchangedV3 对普通/worktree ready、sessions、exit、error的v2黄金字节除proto外相同，已运行。data原字节/base64和现有PTY回归也运行。 | 协议层通过；未用旧Electron实机，不声称全交互验证 |
| R18.1 proto3 | TestInfoAndReadyProto3 分别断言info与terminal ready proto=3；WSChat ready 同测，已运行。 | 通过 |
| R18.2 三处无差异 | 按protocol-sync完整手工核对四文件和handlers，Go/TS字段一致、版本表有3，但文档缺chat_ack.message。 | **不通过，P3** |
| R19.1 架构文档 | 读CLAUDE.md:7–16，分别说明默认终端/PTY纯字节不解析、daemon stream-json/桌面结构化渲染、仅claude；grep/rg命中后读取上下文核对限定范围。 | 通过 |

## 完成条件

总体完成条件：**不成立**。

| spec 的完成条件 | 判定 | 依据 |
|---|---|---|
| R1–R19 全部场景用 verify skill 跑通 | **不成立** | R1.5/R12.4 已复现违例，R18.2 文档错误；真实claude权限落盘、异常孤儿、若干真机范围未验证；GUI另方尚未汇总。 |
| gui-smoke 新增对话端到端通过 | **尚未验证（本验证者）** | 已读创建/回复/允许一次三个有效GUI用例；依分工不执行，运行由另一名验证者负责。 |
| make check 全绿 | **尚未验证** | 没有单独执行字面make check，已按用户清单执行它的gofmt/vet/typecheck/npm步骤及带20m timeout的race全量；全量中止/孤儿子例失败，不能记全绿。避免再启动同一受阻用例造成额外无法清理的fake。 |
| protocol-sync 三处一致 | **不成立** | P3。两端实现一致不能代替文档一致。 |
| 原终端测试不改断言照样通过 | **尚未验证（已运行部分通过）** | npm/非孤儿Go终端回归通过且原断言未删改；原gui-smoke由另方执行，已知drag-select失败须保留调查结论。 |

非功能：500条≤2秒由另一名验证者测；旧报告46ms只证明当时ready到DOM末项这一指标，不能移作本轮e869add的结果。真实远程首字相对CLI延迟、Linux启动没有运行，属于已列明限制。安全检查的已运行范围与未验证范围另列，未发现sanitizer/命令字段注入的新绕过。

## 差异与探索审阅

- 命令：`git diff 7d25cbd...HEAD` 及按子系统读取 diff；`git show b88f4ae`。实际 `--stat` 为160文件（含流程文档和截图），b88f4ae 为12文件、3个产品TS/CSS文件加fakeclaude与测试。没有通过评审报告的“已修复”描述来代替当前实现核对。
- **单进程与操作串行化**：读 chat_manager 的 claudeOwners 先claim后spawn、会话 WithOp/opMu、ReloadChat 的 reload 标记、handoff/delete 的持锁顺序、旧进程 Wait/reader join 后 restart。TestHandoffVsReloadOneWins、TestReloadVsDeleteSerialized、TestRestartRefusedWhenUResumedElsewhere、TestTerminalContinueBusyWhenChatOwns/ClaimsLatest、TestOrphanOwnerBlocksReloadUntilGone 都在非孤儿分包运行通过，断言只有一方成功、旧进程释放前不启动第二个、占用UUID时拒绝。未复现正常操作的双进程。异常daemon退出后的真实孤儿清理在本沙箱**未证成**，优雅重启WS不是它的替代验证。
- **epoch/seq/reset 与待答**：读 Subscribe 的锁内历史切点/环快照/订阅原子注册、TS applySync/applyChat 完整sync才保存位置和seq去重。TestStaleEpochResets、TestSubscribeAtomicBacklog、TestSlowSubscriberDisconnected、chat-client“同步中途断线后重连仍走reset”均已运行。pending 另表不随ring/tail淘汰，TestPendingSurvivesRingEviction 实际压满完整消息环仍恢复同requestId，可答。未发现这一条造成权限请求丢失；但流式尾巴既非1000完整消息环也非累积快照，20000帧上限触发P1。
- **模型输出进入DOM**：检查 markdown.ts、tools.ts、prompts.ts、view.ts 和主进程IPC。Markdown html:false后使用绑定真实window的DOMPurify；只有sanitize结果写innerHTML；工具参数、工具输出、diff和标题用textContent，复制取text。主进程用new URL判protocol，只放行http/https/mailto；will-navigate/window.open锁仍在。已运行恶意HTML/javascript/data/vbscript测试和15文件sink守卫，未找到新绕过。静态sink守卫不能等同任意未来字符串拼接的安全证明，结论限当前代码。
- **客户端影响命令**：ParseCommand/ChatArgv/HandoffCommand 按服务端配置组合，attach只取flag白名单id；TestAttachIgnoresCommandFields 的真实WS恶意command/args/exe/未知flag最终argv都未出现，已运行。TestCommandFromConfigOnly、HandoffCommandQuoting、AssembledCommandRuns、取值选项和`--`分隔回归已运行；未发现客户端命令注入。
- **工作区信任**：WorkdirTrusted读取临时CLAUDE_CONFIG_DIR中的hasTrustDialogAccepted；config路径检查后使用canonical目录，单独检查目录本身，父目录信任不继承，missing/corrupt为unknown并拒绝。TestWorkdirTrusted、TestCreateChatUntrustedWorkdir（含worktree）已运行。worktree准入看来源目录是用户批准设计/decisions #32 的规则；reload不重复准入也已在设计写明，不据此构造额外绕过问题。代码会读取全配置字节再只解码信任字段，凭据“不读取”的静态测试只守不访问凭据字段/专用凭据文件；本轮只用合成配置，没有接触真实 ~/.claude.json。
- **终端互通**：黄金测试按路径/id/时间与proto做必要归一化后逐字节比对v2帧，不会吞新增chat字段；终端ui省略测试、data原字节/base64回归通过。旧客户端无ui打开chat返回fatal ui_mismatch。新客户端旧daemon完整Electron交互按分工待另一名验证者；本轮不访问真实daemon或8765。

## b88f4ae 布局与拖选失败判断

- 新建picker的header/body/footer分层和modal-body滚动，使路径和选项不被flex压扁。picker-layout实际测500/700/803px的modal、主按钮边界、elementFromPoint命中和路径高度，不只是调用element.click。静态 test-picker-layout 与slash-menu-layout以及view滚动断言已在npm test通过；真实尺寸运行由另一名验证者负责。
- 机器管理对话框（machines.ts:61–89）仍是modal下直接header/list/error/footer；新 `.modal-body > *` 与 `.modal-body > .modal-list` 都不匹配它，通用header/footer新增flex:none及modal更大max-height没有静态明显破坏。机器列表仍自身滚动。没有专门量测机器管理多条机器/编辑错误状态的当前GUI断言，因此它的实际边界仍交另一名验证者，不能凭picker量测记机器对话框全通过。
- slash的列布局限定在`.slash-menu .mi`，名称单行截断、描述最多两行，title保留全文；`revealSlashItem`重建后按item尺寸恢复/调整scrollTop，view测试模拟尺寸断言方向键选中可见。通用mode菜单未使用这种small描述行，未发现被改成slash排列。
- gui-smoke的drag-select前新增pickerLayout尺寸模拟，恢复仅等innerHeight，没有等待xterm fit/resize/PTY重绘稳定；因此存在增加布局异步工作和测试时序干扰的机制。拖选测试先等待screenText包含目标（可能命中命令回显），再用当前DOM精确行取坐标，之后八次CDP移动和按键分多次调用；tmux/PTY重绘可能在定位后发生，坐标没有再次确认。
- 报告失败原文 `"SELECT_ME_PLEASE\nbash-3.2$ \n"` 仍包含正确目标，却多选下一提示符行，指向选区跨行；不是凭据/其他剪贴板内容污染的证据。b88f没有修改终端、xterm选区和剪贴板产品代码。旧轮3次1败、新轮2次1败、另一旧轮27次无失败，不是受控对照，**不能证明b88f提高失败率，也不能证实为产品缺陷**。时序问题是有依据的候选解释，不写成已定位根因。按用户分工不做GUI实验，最终须保留该偶发失败及另一验证者的结论。

## 放松检查审计

- 执行并读取：`git diff 7d25cbd...HEAD -- '*_test.go' 'desktop/scripts/*.mjs' '.claude/skills/verify/scripts/*'`；完整输出保存在 `/tmp/vr-dm-test-diff.txt`。相对基准的测试删除行只有gui-smoke的4行：2行说明、import、旧单机器machines.json准备；现有Go/desktop测试断言没有删除或放宽，旧超时没有调大，没找到新忽略配置。terminal-selection新增依赖精确pin断言。
- **新增永真断言**：gui-chat-smoke.mjs:623 `assert(!text0.endsWith('done Bash') || true, '')` 永远通过，未守R5.6“回答未送达时工具不执行”。同例open恢复/再次答后tool ok有有效断言；daemon待答与队列满测试也提供支持，但不能把这条永真断言当证据。属于新增测试的覆盖缺口，未单独证实产品错误，不计入3条产品/文档问题。
- **新增条件跳过**：golden_test.go 的 TestTerminalFramesUnchangedV3、ws_chat_test.go 的测试fixture在找不到tmux时t.Skip；`VIBE_REMOTE_REQUIRE_TMUX=1` 则改为失败。本机已安装tmux并实际运行黄金/WS用例，因此此条件本轮没有触发。新chat等待上限为15s，属于新增测试的有界等待，没有扩大旧测试超时；孤儿stubborn的`<-gone`反而无局部上限，依赖Go全局timeout。
- GUI通知例 `if (focusedAfter)` 才检查角标清除，避免macOS无法拉前台时误断言；但该分支没触发时只能说没有验证角标清除。通知点击是模拟IPC，不证明操作系统原生通知显示。GUI R6第三选项不assert midMode、R12只核对末500条也已在场景表写清，未抹去覆盖边界。
- 本轮对chat包用精确正则排除受阻顶层孤儿例后补跑，且单列失败/卡住的原命令，没有改测试源码或把补跑结果冒充全量成功；全部原测试文件保持HEAD内容。

## 评审待验证项与测试报告“未覆盖和遗留”复核

- review.md 的正式待用户决定/不采纳项均为无；遗留的拖选偶发和沙箱ps限制是本轮需要核对的两项。b88f产品改动不在9b42ff0的旧评审范围，本轮已读其12文件diff、相关共用modal/mode-menu代码和测试，未用“低于再评审门槛”免除检查。
- 读取历史原始证据（只读、未在该目录运行命令）：`/Users/mac/github/vibe-remote/.devflow-tmp/dual-test-out/` 中make-check.log、go-test-v.log、invariants-summary.txt、gui-smoke-run1/run2.log、gui-chat-smoke-run1.log。原make check日志末尾exit=0，正常环境的孤儿用例/LoadChats日志通过；这支持review的“正常环境通过”陈述，但不能覆盖本轮受限制环境。invariants日志10条exit=0，protocol-sync在该runner NOT-RUN，随后报告人工核对，文档遗漏确实还存在。
- 原GUI日志真实包含第一次drag-select失败原文和exit=1、第二次通过exit=0；picker六项布局两轮均PASS；gui-chat末尾exit=0且R12有46ms、R16.3有fallback和聚焦后角标清除、模拟点击。这些数据与test-report一致。`git diff --stat 6d88e45..HEAD` 只有docs/changes文件/截图，产品代码相同，因此不是报告测了另一版产品；但历史运行不是本验证者的独立GUI运行，本轮仍依分工等待另一名验证者。
- 真claude规则写盘：fakeclaude使用独立FAKE_CLAUDE_RULES，只模拟规则保存/下一回合不再问；daemon转发测试与UI建议测试都通过，仍不能证明实际设置落盘。设计探针V9/evidence确实记录真claude 2.1.210曾写settings.local.json并取消再次询问；它是协议前置验证，不是当前daemon→desktop整链路验收，测试报告保留未做是准确的。
- 真JSONL完整工具历史：合成3000行与fake的JSONL断言能证明加载/过滤/窗口/配对；真实claude其他字段/较新版格式不由这些断言覆盖，报告“真机部分未做”有依据。但报告R1.5整项“通过”的常规目录断言不能挡P2。
- 远程Linux、真实首字延迟、签名包原生通知显示/点击、DMG安装后降级行为均未在本轮运行；分别需要相应环境、模型调用或系统通知支持，不能推测结果。原生notification-click模拟只证明IPC路由，fallback日志和Dock角标证明未签名降级这一条。
- 网络模拟：GUI通过包装WebSocket丢/扣帧，“另一桌面”是WS客户端，脚本确实没有两台真实桌面；本轮WS断线是真关闭临时连接，但未模拟物理断网/休眠。旧截图中多数来自2026-11-14，只有报告列的7张在2026-11-20更新；不把旧截图当当前GUI独立证据。
- `.devflow.yml autonomy:L1` 与本需求文档L2不一致、旧daemon提示无内边距X2是报告明列的遗留；前者流程配置而非产品行为，本验证不变更流程；后者基准main已有且不拦本改动。X1终端专用提示结束/换语言的回归在本轮npm通过。
- **报告结论需纠正**：protocol-sync“通过但遗漏message”与三处无差异互相冲突，计P3；R1.5/R12.4常规测试通过不能推出边界场景通过，计P2/P1。不把报告记录过的偶发失败删掉，也不把未做范围改成通过。

## 待验证项（不计入确认问题）

1. 真实Electron：由另一名验证者负责全部GUI运行；额外留意机器管理共用modal、小尺寸错误/编辑状态、drag-select定位后是否重绘，以及500条的当前渲染时间。此文件不合并尚未收到的GUI结论。
2. 真claude完整链路：R5.2规则真实落盘、真实JSONL工具历史和远程Linux启动；原生通知显示和真实点击；实际物理断线/休眠。这些都有明确覆盖边界，不能用fake或IPC模拟代替。
3. 异常daemon退出的孤儿清理：在允许ps与向自启动进程发信号的环境重跑原全量和单进程invariant；本轮有卡住/失败及未清理fake，不能据WS优雅重启宣称已证明。
4. R16.3条件覆盖：activity.ts的shown按isActive无条件隐藏点；test-chat-activity对`isActive=true, windowFocused=false`明确期望`dot:none, notify:true`，而spec“窗口没有聚焦，或非当前会话”描述要求黄点。GUI R16.3只测非当前会话，未覆盖这个分支；需由GUI验证者从实际窗口入口核对当前会话在失焦时的侧栏表现。这里只列有依据的待验证偏差，不当作已跑出的GUI反例。
5. drag-select根因：有坐标/重绘时序机制与失败原文支持，但本轮未跑GUI、未做前后受控实验；仍不能判定产品缺陷或b88f失败率提高。

## 补充检查与证据定位

- 补齐三个无测试文件包的构建检查：在vibe-remoted运行 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-dm-XXXXXX) TMPDIR=/tmp GOCACHE=/tmp/vr-dm-gocache CLAUDE_CONFIG_DIR=/tmp/vr-dm-safe-config go test -race -count=1 -timeout 2m ./cmd/vibe-remoted ./internal/chat/chattest ./internal/chat/fakeclaude`：exit=0，三包均 `[no test files]`。没有派生被测进程。
- 第1条命令型invariant `cd desktop && npm test` 原样runner执行，exit=0（独立环境标注TMUX_TMPDIR=/tmp/vr-dm-nkjn128y）；其余每条原命令及结果在“分包与invariants”已列。没有执行install或真实local.start/make smoke。
- 本轮完整日志：`/tmp/vr-dm-npm.log`（23项脚本含preserved-notice）、`vr-dm-vet.log`、`vr-dm-go.log`（全量中止）、`vr-dm-go-split.log`、`vr-dm-chat-split.log`、`vr-dm-orphan-subcases.log`、`vr-dm-invariants.log`、`vr-dm-invariants-rest.log`、`vr-dm-owners-check.log`、`vr-dm-ws.log`、`vr-dm-ws-term.log`、`vr-dm-ws-term-daemon.log`；均在/tmp，无需到原worktree找新测试文件。
- 反例：`/tmp/vr-dm-experiment/vibe-remoted/internal/chat/independent_test.go`、`internal/server/independent_test.go` 是临时源码副本上的独立用例；`vr-dm-experiment.log` 是P1及初版未规范化的目录实验，修正目录实验为`vr-dm-collision.log`/`vr-dm-collision-ws.log`。P1原Session补发帧是`vr-dm-tail-frames.json`，实际renderer逻辑打包是`vr-dm-session.mjs`，结果是`vr-dm-tail-ui.log`。首次未复现的目录实验没有被删除或当成通过证据。
- P1除spec R12.4外也违反design 5.2声明的“尾巴截断记tailTruncated”；当前Session只有tail/tailBytes，无该标记。d8批准上限不等于批准截断后显示残片和全文两条。

## 环境版本（结束）与清理核对

在最后一个补充分包检查之后，分别在指定verify-dm worktree执行：

- `git rev-parse HEAD`：exit=0，输出 `e869add03fd79e7735d45b740aa57d9af4c1b240`。
- `git status --short`：exit=0，输出为空。
- `git diff --exit-code`：exit=0，输出为空（已跟踪文件未变）。
- `git diff --cached --exit-code`：exit=0，输出为空（索引未变）。
- 额外 `git rev-parse HEAD^{tree}` 输出Git原始SHA-1 tree `fb20f1321ad7283d9663704d34c7127cebcb9579`。它不是验证快照的SHA-256代码摘要；读verification_snapshot.py后实际执行 `python3 /Users/mac/github/devflow/dev-workflow/scripts/verification_snapshot.py snapshot --repo /Users/mac/github/vibe-remote/.devflow-tmp/verify-dm --docs-dir docs/changes --head e869add03fd79e7735d45b740aa57d9af4c1b240 --target 7d25cbdeee006f7ad5bdf01879848274a383bb69`：exit=0，输出与首部用户给定JSON逐字相同。
- 结论文件自检：spec的70个子场景均有一行对应核对，缺失[]，确认问题定义3条。该自检只检查报告完整性，不作为产品测试。

测试进程清理：正常完成的WS脚本和终端临时daemon supervisor已走Stop/Wait/自己的tmux清理，临时副本用例也走fixture cleanup。Go全量/原invariant卡住时通过**各自exec会话**Ctrl+C结束，exit130。沙箱禁止ps，不能全局列进程证明所有派生进程为空。

**清理尚未完成的明确例外**：结束时Python `os.getpgid` 与本轮pid marker核对仍得到：

```text
PID 52310: pgid=52310; 本轮测试pid marker存在=True
PID 56480: pgid=56480; 本轮测试pid marker存在=True
```

两者为本轮TestOrphanCleanup/stubborn_needs_SIGKILL启动的fake claude，所属UUID/marker已在前文列明。前述仅针对这两只自启动进程的SIGKILL尝试被沙箱EPERM拒绝，stdin EOF也不使stubborn退出；原exec会话已结束，无法通过该会话清理独立进程组。没有进一步尝试越过沙箱，也没有对任何真实daemon/tmux或非本轮进程发信号。因此“本轮全部测试进程已退出”**不成立**，需在允许清理自有进程的环境处理这两只fake；这是本轮执行环境限制，不另算产品问题。临时证据保留在/tmp便于核对。

本轮没有访问127.0.0.1:8765、没有使用默认tmux目录、没有启动Electron、没有修改已跟踪文件或真实claude/app用户数据，没有commit/push/checkout。唯一新建交付文件是本verdict（其余为/tmp临时实验与日志）。

最终判定：**不通过，确认问题3条**（P1长回复reset重复；P2 -c跨目录接错历史；P3协议文档遗漏）。


---

# 关口 C 第 1 轮 · 验证结论全文（二）：界面部分（同模型的全新验证者）

# 独立验证结论（界面部分）

- 结论：**不通过**（2 个用户会遇到、与 spec 不符的界面问题 P1、P2；其余写成备注）
- 提交：e869add03fd79e7735d45b740aa57d9af4c1b240
- 验证快照：`{"schema":1,"docs_dir":"docs/changes","head":"e869add03fd79e7735d45b740aa57d9af4c1b240","head_tree":"b58c4926876d6dca94d03f0e017504a74b2a24ec80eff298d3a5f37737ec1751","target":"7d25cbdeee006f7ad5bdf01879848274a383bb69","target_tree":"4d0d58c229e8bd52a71ea65ae7e10f56c3fa665383b7f15a91e05944ed9b569b"}`
- 验证者：Claude（Anthropic，模型 Fable 5，`claude-fable-5-2[1m]`），独立验证者，没写过这段代码，没有派子 agent。界面场景由我负责；Go 测试、`make check`、协议冒烟、diff 与断言核对由另一名验证者负责，我没有重复。

## 环境版本

worktree：`/Users/mac/github/vibe-remote/.devflow-tmp/verify-dm-gui`（detached）。

```
开始时
$ git rev-parse HEAD
e869add03fd79e7735d45b740aa57d9af4c1b240
$ git status --short
（无输出）

结束时
$ git rev-parse HEAD
e869add03fd79e7735d45b740aa57d9af4c1b240
$ git status --short
（无输出）
```

Electron 44.7.0，Node v22.22.2，Go 1.26.2，macOS（darwin/arm64）。没有改任何已跟踪文件，没有提交。

## 检查

两份 GUI 冒烟逐个运行，每次各带独立的 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-dmg-XXXXXX)`，开跑前都确认没有别的 Electron 测试实例（第 4 次等了一轮）。

| # | 命令 | 结果 |
|---|------|------|
| 1 | `node .claude/skills/verify/scripts/gui-smoke.mjs` | 30 PASS / 0 FAIL，exit 0 |
| 2 | 同上 | 30 PASS / 0 FAIL，exit 0 |
| 3 | 同上 | 30 PASS / 0 FAIL，exit 0 |
| 4 | 同上 | 30 PASS / 0 FAIL，exit 0 |
| 5 | 同上 | 30 PASS / 0 FAIL，exit 0 |
| 6 | `DEVFLOW_EVIDENCE_DIR=<gate-c-dm/shots/script> VR_MAIN_DAEMON=<见下> node .claude/skills/verify/scripts/gui-chat-smoke.mjs` | 29 PASS / 0 FAIL，exit 0（R12.2：补发 504 条，ready → 渲染完 72 ms） |

- 日志：`gate-c-dm/logs/gui-smoke-{1..5}.log`、`logs/gui-chat-smoke-1.log`；脚本截图 33 张在 `shots/script/`。
- 没有失败用例，所以没有「重跑区分偶发 / 稳定」的记录。
- `gui-chat-smoke.mjs` 默认用 `git worktree add … main` 构建协议 2 的 daemon：会改共享仓库的 worktree 元数据，而且用的是本地 `main` 分支，不一定是基准提交。我改用 `git archive 7d25cbd` 把源码导出到自己的临时目录构建，经脚本自带的 `VR_MAIN_DAEMON` 传入（只读，确实是基准）。

### drag-select 用例（`drag-select under mouse reporting + ⌘C copies the text`）

- 5 次运行 **0 次失败**；我另外用真实拖拽手工做了一次（见场景表），也通过。没能复现。
- 判断：**测试自身的时序问题，没有发现产品缺陷的迹象**；机制没有用实验坐实，依据和不确定之处如下：
  1. 失败时的输出 `"SELECT_ME_PLEASE\nbash-3.2$ \n"` 是「目标行 + 其后两行」。用例里按下、拖动、松开用的是同一个 y，所以只能是按下到松开之间屏幕内容上移了两行（重绘 / 滚动），不是选区逻辑把范围算错。
  2. 用例的同步点偏弱：`waitFor(screenText().includes('SELECT_ME_PLEASE'))` 会被**回显的命令行本身**满足（命令里就有这串字），并不等 `clear; echo` 画完、提示符稳定；随后只靠「⌥ 悬停直到出现 `enable-mouse-events`」间接等待。
  3. 这次改动没有碰终端、xterm 配置、剪贴板代码（`git diff 7d25cbd..HEAD`：`terminal-clipboard.ts` / `terminal-layout.ts` 无改动；`index.ts` 里终端相关只多了 `ui:'terminal'` 字段和一处 `view?.ui === 'terminal'` 判断；xterm 版本没变）。
  4. 针对「b88f4ae 加的窗口高度模拟会不会让终端建好后再变一次尺寸」做了实验：在自己的实例里照 `pickerLayout` 的顺序设 500 / 700 / 803 再恢复，然后新建终端并发同一条命令，每 30ms 采样终端行数和容器高度 5 秒，3 轮都是一建好就 51 行、之后没有变化——没有看到产品侧的迟到重排。
- 建议（不拦）：量行位置前先等屏幕稳定（例如等到目标行下一行出现提示符），拖选前后各读一次目标行位置，不一致就重量。

## 手工验证用的临时实例

4 个临时 daemon + 1 个 Electron，全部在 `/tmp/vr-dmg-BxPFK6/` 下（已删除）：`v-term`=/bin/bash；`v-chat`=假 claude（`claude_flags`：`-c`、`--dangerously-skip-permissions`；`FAKE_CLAUDE_LONG_COMMANDS=1`）；`v-oldclaude`=假 claude 报 1.0.51；`v-olddaemon`=基准 7d25cbd 构建的协议 2 daemon。各自独立的 `TMUX_TMPDIR`、`state_dir`、`CLAUDE_CONFIG_DIR`，`allowed_roots` 只有该目录下的子目录；Electron 用临时 userData + `--use-mock-keychain` + 随机调试端口。所有操作经裸 CDP 的 `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText` 发给这个实例（点击前先做命中测试：元素中心必须真的点得到）；断网用我自己放在 daemon 前面的 TCP 代理（经机器管理界面把它加成第 5 台机器 `v-proxy`）；「另一台桌面」是直连 daemon 的 WebSocket 客户端。驱动脚本留在 `gate-c-dm/scripts-gui/`（不含 token），截图在 `gate-c-dm/shots/`（`m` 开头是手工的）。

## 问题

### P1（拦）对话不在底部时发消息：自己的消息和 Claude 的回复都不显示，滚到底也不出来

- **复现 B（单个会话，真实滚轮 + 真实键盘；做了 1 次，复现）**：新建对话会话 → 发 `burst 30`（内容超过一屏）→ 滚轮上滑 300px → 点输入框输入 `echo 看得到吗` 回车。
  - 实际：输入框清空，但对话里没有这条用户消息，也没有回复（等 3 秒，DOM 里用户消息数仍是 1）。daemon 已收到并回复（另一个 WebSocket 客户端能看到回复）。滚轮滚到最底再等 3 秒，仍然没有。再发一条 `echo 第二条`，两条消息和两条回复才一起出现。截图 `m47-BUG-B-1…4`。
- **复现 A（R16 的主流程，全程不手动滚动；后台期间内容增高超过 48px 的 4 次全部复现）**：对话会话贴底 → 发一个持续几秒、产出超过一屏内容的回合（`slow 150 20` + 排队的 `burst 30`）→ 点别的会话去干活 → 侧边栏该会话变绿点（回合结束）→ 点回来。
  - 实际：视图停在离开时的位置，离末尾还有 947px，没有「下面有新消息」的提示（点已清掉）。直接发 `echo 回来后 1`：输入框清空，消息和回复都不显示；滚到底仍没有；再发一条才一起出现。截图 `m49-BUG-A-1…3`。另有 2 次尝试不算数：1 次后台期间只来了一段不换行的回复（增高不到 48px，按下面写的原因本来就不触发），1 次切走的那次点击没生效、会话其实没进后台（见备注 11）。
  - 同一状态下的其它表现：发 `fail` 后既没有用户消息也没有错误卡片（`m43x-after-fail`，同一会话的另一个视图里都有）；来了提问卡片，但卡片上方的对话还停在旧位置，看不到 Claude 提问前说了什么（`m58`）。
- 按 spec 应有：R3.1「用户消息立即出现在对话里，claude 的回复随生成逐段出现」；R16.1 / R16.2 之后打开后台会话接着对话。
- 原因（读代码确认）：`chat/view.ts` 的 `render()` 用 `atBottom()`（距底 <48px）决定虚拟列表窗口是否跟随，`chat/window.ts` 的 `follow()` 在不贴底时不动 `win.end`，所以新消息（包括用户自己刚发的）不生成 DOM；`onScroll()` 只处理滚到顶部，滚回底部不会触发重新渲染，要等下一次会话更新。后台会话的容器是 `display:none`，期间 `scrollTop` 设不上去，切回来时停在旧位置（内容增高 >48px 就不再贴底），于是不手动滚动也会进入这个状态。
- 影响：消息其实发出去了，界面上却像丢了；用户很可能重发，claude 会收到两遍指令。回复还在流式输出时滚到底能恢复（有帧触发渲染），回合已结束时滚到底也不恢复。
- 严重程度：中高（核心发送流程，看起来像丢消息；没有数据丢失）。**拦**。
- 为什么自动化没发现：`test-chat-window` 断言的正是「不贴底时窗口不动」；gui-chat-smoke 的用例都在贴底状态下发送（多处先 `scrollBottom()`），也没有「后台收到内容再切回来」的用例。

### P2（拦）已打开的对话会话双击改名不生效；接着输入的新名字被当成消息发给 Claude；侧边栏随后停止更新（R15.1）

- 步骤（真实指针，按人的节奏：按下 40ms、两次间隔 90ms）：侧边栏里双击一个**已打开**的对话会话的名字（当前会话或后台会话都一样）→ 输入「登录页重构」→ 回车。
- 实际：
  1. 改名输入框最多闪现约 18ms 就消失（12 次尝试 0 次可用，其中 5 次按上面的人手节奏、7 次是无间隔的双击），焦点落在对话输入框。
  2. 输入的名字进了对话输入框，回车后作为用户消息发给了 claude（对话里多出「登录页重构」和它的回复）；侧边栏名字和 REST `title` 都没变。截图 `m67-BUG-rename-*`。
  3. 只双击一次之后，侧边栏就不再更新：点别的会话，主区域切过去了，侧边栏高亮还停在原会话；后台会话有新回合也不出状态点（`m70-BUG-sidebar-frozen-after-rename-attempt`）。在一个从没打开过的会话上成功进入改名再按 Esc 才恢复。
- 对照：从没打开过的对话会话双击 → 输入框出现并聚焦，可改名。已打开的**终端**会话在本提交上 8 次里 3 次可用；我把基准 7d25cbd 的桌面端构建出来对同一个 daemon 试了 4 次，也是 2 次可用、2 次不可用——终端会话的这个竞态是基准就有的，不是这次引入的；对话会话上因为多了输入框抢焦点，变成每次都不可用。
- 按 spec 应有：R15.1「用户双击侧边栏名字改名 → 新名字保存在远程」；R15「对话会话和终端会话一样支持重命名」。
- 原因（读代码）：双击的两次 click 各触发一次 `openExisting` → `setActive` → `renderSidebar()`（换掉被点的标签）和 `ChatView.show()`（`requestAnimationFrame(() => this.composer.focus())`）。`startInlineRename` 要么作用在已被换掉的旧标签上（输入框没进文档、`renamingActive` 一直为 true，`renderSidebar` 从此直接返回），要么刚聚焦就被输入框抢走焦点、`blur` 即收起。
- 影响：用户自己建的对话会话都是已打开的，等于界面上改不了名；新名字会被当作指令发给真实的 claude，触发一个没想要的回合；侧边栏冻结后当前会话高亮和 R16 的状态点不再更新（实测）；按代码 `renderSidebar()` 整个被跳过，新建 / 删除会话也不会刷新（这一点没有单独试），直到碰巧恢复或重启应用。
- 严重程度：中。**拦**。测试报告对 R15.1 写的是「Go + 探索：通过」，自动化只有存储层（`TestChatRenamePersists`），没有界面用例。

### 备注（不拦）

1. **R16.3 当前会话 + 窗口失焦时没有黄点**：关掉焦点模拟、让自己的窗口失焦后，当前会话收到权限请求 → 发了通知（`[notify] fallback: v-chat · second`），但侧边栏该会话不显示黄点（`activity.ts` 里当前会话一律不显示点）。spec R16.3 字面是「窗口没有聚焦，或该会话不是当前打开的会话 → 侧边栏显示黄点，并发桌面通知」。低。
2. **拒绝后的工具块标的是「失败」**：R5.3 拒绝并说明后，Edit 块状态为「失败」、输出是用户写的说明；没有单独的「已拒绝」标记（claude 的回复里有 `denied: …`）。低。
3. **已结束的对话会话在侧边栏没有标记**：交接 / daemon 重启后，侧边栏条目和运行中的一样，只有打开后才看到横幅和「会话已结束」。R14.1 写的是「原对话会话标为已结束」。低。
4. **删除对话会话的确认文案沿用终端的说法**：「…当前画面会丢失，且无法撤销」；对话会话的历史（JSONL）其实保留（实测删除前后 JSONL 文件数 5 → 5）。低。
5. **小窗口里长命令把权限按钮挤到卡片折叠线以下**：800×500 时卡片高度封顶 310px、内部可滚，2200 字符的命令占满可见区，「是 / 否」要在卡片里滚动才看得到；键盘 1 / 2 / 3 和 Esc 可用。提问卡片同理（提交按钮要滚到底）。低。
6. **断线期间状态没有收起**：断线后输入区仍显示「停止 Esc」和「思考中…」，同时提示「未连接：输入会保留，恢复后再发送」。低。
7. **重新启动 / 重载后权限模式回到「编辑前询问」**：崩溃前是「自动编辑」，重启后是默认模式。符合新进程的实际状态，但用户可能没注意到。低。
8. **`ExitPlanMode` / `AskUserQuestion` 在对话里显示成原始 JSON 摘要**（`{"plan":"# Plan…`），卡片本身渲染正常。外观问题。低。
9. **从 JSONL 重建的历史里，出错的回合只有用户消息、没有错误卡片**（重开应用或 `-c` 后）。低。
10. **状态点只靠颜色区分**（`aria-hidden`，没有 title）。低。
11. **侧边栏每 5 秒整体重建（每台机器一次）**：按下和松开之间如果刚好重建，这次点击会丢（我强制让按下跨过一次重建，4 次里 4 次丢）。人手点击约 100ms，估算每次点击约 2% 的概率。应是基准就有的做法（没有在基准上单独验证），机器越多越明显。低。
12. **`desktop/src/renderer/chat/prompts.ts` 里有 3 个原始 NUL 字节**（第 208 行附近的 `'\0other'` 写成了真正的 0x00）。系统 `grep` 把整个文件当二进制（「Binary file … matches」），代码搜索会悄悄漏掉这个文件——我的几次搜索就是这样漏掉它的。建议改成转义写法。属于代码卫生，转给另一名验证者 / 作者。低。
13. **过程记录**：手工验证途中我的临时窗口被外部最小化并移动过（期间页面不渲染、截图超时）。我经该实例自己的主进程把它恢复后重做了受影响的步骤；结论里的数据都来自窗口可见时的运行。

## 场景（亲手走过的）

每行：场景 → 怎么验证（操作）→ 看到的结果 → 截图（`shots/` 下，省略 `.png`）。除特别说明外都是真实指针 / 按键事件。

| 场景 | 怎么验证 | 结果 | 截图 |
|------|----------|------|------|
| R1.1 默认终端 | v-term 上点「打开现有目录」，没碰「界面」，点进 alpha，点「在此打开」 | 终端卡片默认选中；建出终端会话（侧边栏 `terminal:alpha`），shell 提示符出现 | m01, m02 |
| R1.3 claude_cmd 不是 claude | 同一对话框看对话卡片；用真实指针点置灰的卡片 | 置灰，原因「对话界面只支持 claude：这台机器的 claude_cmd 不是 claude」；点了不会选中 | m01 |
| R1.4 claude 过旧 | v-oldclaude 打开对话框，真实指针点对话卡片 | 置灰，「远程 claude 版本 1.0.51 低于对话界面要求的 2.1.210，请升级 claude」；点不中 | m05 |
| R1.4/R17.2 daemon 过旧 | v-olddaemon（协议 2）打开对话框 | 置灰，「这台机器的 vibe-remoted（协议 2）不支持对话界面（需要协议 3），请升级 vibe-remoted」，另有旧 daemon 提示 | m06 |
| 目录未被信任 | v-chat 进入没写进假 `.claude.json` 的 `untrusted` 目录 | 置灰，「先用终端界面在该目录打开一次 claude 以信任此目录」；先选了对话再进该目录 → 「在此打开」被禁用 | m07, m08 |
| 建好后不能互换 | 看对话框文案；悬停终端 / 对话会话条目找切换入口 | 对话框写明「界面创建后不能在原会话上更换…」；会话条目只有「重新加载」「删除」两个按钮，没有切换界面的入口 | m01, m39 |
| 新建对话框布局 800×500 / 1325×803 / 1440×900（真实窗口 `setContentSize`） | 每个尺寸各打开一次，进 30 个子目录的 `many`，依次选终端 / 对话 / Worktree，量对话框、路径栏、按钮；滚轮滚动中间内容；真实指针点「取消」 | 三个尺寸、三种选择下：对话框都在窗口内；路径栏 33/33px 未被压扁；「取消 / 在此打开」都在窗口内且中心点命中按钮本身；中间内容可滚（800×500 时 349/742px）；点「取消」关闭 | m09-picker-* |
| 终端：输入、输出、中文 | 真实指针点终端，insertText + Enter：`echo TERM_$((20+3))_OK 中文✓` | 回显 `TERM_23_OK 中文✓` | m02 |
| 终端：拖选 + ⌘C | 真实拖拽选中 `COPY_TARGET_LINE` 一行，⌘C | 剪贴板 = `COPY_TARGET_LINE`（事后已写回原内容） | m02 |
| 终端：⌘V | 剪贴板放 `echo PASTED_$((3*3))_OK`，⌘V + Enter | 输出 `PASTED_9_OK` | — |
| 终端：断线横幅与恢复 | 停掉 v-term daemon → 再启动 | 横幅「连接已断开，正在重连… 立即重试」出现；daemon 回来后自动消失，原 tmux 会话里之前的输出还在，可继续输入 | m03, m04 |
| 机器管理对话框（共用样式） | 1440×900 与 800×500：打开列表 → 编辑 → 「测试连接」→ 取消 → 「+ 添加机器」填错端口 → 测试 → 取消 → 完成（全部真实指针） | 两个尺寸下对话框都在窗口内、无裁切，所有按钮可点；测试连接显示「连接成功」；错误端口提示「端口需在 1–65535 之间」；Token 输入框是 password 类型（截图里是圆点） | m10–m13 |
| R1.2 新建对话会话 | v-chat → 进 main → 点「对话」卡片 → 「在此打开」 | 侧边栏出现带「对话」标记的 `main`，右侧对话界面，输入框可用；REST 列表 `ui:chat state:idle` | m14 |
| R3.4 空输入 | 输入框空着按 Enter；输入 3 个空格按 Enter | 没有发出任何消息 | — |
| R3.1/R3.2 Markdown | 发 `md` | 标题（17px 粗体）、圆点列表 2 项、带边框表格、行内代码、代码块（SF Mono、语言标签 go、「复制」按钮）；点「复制」→ 剪贴板 `fmt.Println("hi")`，按钮变「已复制」 | m15 |
| R3.3 原始 HTML / 脚本 / javascript: 链接 | 同一条回复；真实指针点 `ok` 链接和 `[x](javascript:…)` 文字 | `<script>`、`<img onerror>` 以纯文本显示，DOM 里 0 个 script / img / onerror；`javascript:` 没有变成链接；`ok` 链接经主进程 open-external 打开（已打桩，收到 `https://example.com`），窗口没有跳转、没有弹窗、没有新窗口 | m15 |
| R4.1 Read / Grep | 发 `tool Read`、`tool Grep`；真实指针点摘要展开再折叠 | 默认折叠，摘要显示 `README.md` / `TODO`；展开后有输入、输出；再点折叠 | m16 |
| R4.2/R4.4 Bash 与失败 | `tool Bash`（允许后）、`tool Bash fail` | 成功的块显示命令；失败的块自动展开、标「失败」、显示 `Error: Bash failed` | m21 |
| R4.3 Edit / Write diff | `tool Edit`、`tool Write` | 文件名 + `+1 −1` 统计，删行浅红、增行浅绿 | m20, m21 |
| R5.1 允许一次 | `tool Bash` → 点「是」；再发一次 | 命令执行；第二次仍然询问 | m17 |
| R5.2 不再询问 | 点「是，并且对 …/main 里的 echo fake 不再询问」；再发第三次 | 执行；假 claude 的规则日志（代表远程）写入 `Bash(echo fake)`；第三次不再询问；卡片脚注写明规则写入远程 `.claude/settings.local.json` | m17 |
| R5.2b 无建议 | `perm ls -la` | 只有「是 / 否」两项；按键盘 `1` 即允许 | m18 |
| R5.3 拒绝并说明 | `tool Edit` → 在「告诉 Claude 换个做法」里输入「先别改这个文件」→ 点「否」 | claude 回 `denied: 先别改这个文件`；Edit 块标「失败」，输出是这句说明（见备注 2） | m19, m20 |

（场景表续）

| 场景 | 怎么验证 | 结果 | 截图 |
|------|----------|------|------|
| R5（setMode 建议） | `tool Edit` → 「是，本会话内允许所有编辑」 | 编辑执行，模式切到「自动编辑」，随后 `tool Write` 不再询问 | m21 |
| R6.1/R6.2/R6.3 计划评审 | `plan` → 填「请把第二步拆细」点「继续完善计划」→ 新计划卡片 → 点 1；再 `plan` → 点 2 | 计划以 Markdown 渲染 + 3 个选项；完善后 claude 收到意见并重新提交；选 1 → 模式「自动编辑」且 Write 不再询问；选 2 → 模式「编辑前询问」且 Write 重新询问 | m23, m24, m25 |
| R7.1/R7.2/R7.3 提问表单 | `ask`：什么都不选点提交；选 Banana；多选 Red+Blue+其他「青色（自己填的）」；第二轮单选题只填其他「榴莲」 | 没答完时提交按钮禁用（真实点击无效）、未答题标红并列出「还没回答：第 1, 2 题」；答完后 claude 收到 `Banana` / `Red, Blue, 青色（自己填的）`；第二轮收到 `榴莲` / `Blue` | m26, m27, m28 |
| R11.1 菜单切换 | 点模式按钮 → 菜单里点「编辑前询问」 | 菜单三项（当前项带 ✓），切换后按钮文字同步 | m22 |
| R8.1 Esc / 停止按钮 | `slow 200 60` 流式输出中按 Esc；再来一次用真实指针点「停止」；之后再发一条 | 两次都立即停住并标「已中断」，会话回到空闲；随后的消息正常回复 | m29, m30 |
| R8.2 有权限请求时 Esc | `perm touch r82.txt` → 卡片出现 → Esc | 卡片关闭，记录「Bash 的请求已中断」+「已中断」，工具块为失败（没执行） | m31 |
| R8.3 空闲 Esc | 空闲时在输入框按 Esc | 对话内容没有任何变化 | — |
| R9.1/R9.2 排队与移除 | 忙碌时连发 3 条；真实指针点第二条的 × | 三条显示「排队中」；移除后只剩两条；回合结束后按顺序发出第一、第三条，被移除的没发 | m32 |
| R9.3 中断时排队内容回输入框 | 忙碌时排两条 → Esc | 两条都回到输入框（空行分隔），队列清空，都没有发出 | m33 |
| R10.1 斜杠菜单 800×500 与 1440×900（真实窗口尺寸） | 输入 `/`；↓ 走完 13 项再 ↑ 走回；滚轮滚动后真实指针点一行；`/dev` 过滤 + ↓ + Enter；Esc；点输入框下的 `/` 按钮 | 两个尺寸下：菜单在窗口和对话区内、无横向滚动；13 行里命令名全部单行（过长的省略号 + title），描述在名字下方且 ≤2 行，无描述的行更矮；键盘走 26 步选中项始终在可视区内；点击 / Enter 把命令填进输入框（不发送）；过滤正确；Esc 关闭 | m34, m35, m36 |
| R10.2 终端专用命令 | 输入 `/theme`、`/login` 回车 | 不发送，提示「/theme 只能在终端界面使用」+「新建终端会话接上」按钮 | m37 |
| R11.1 Shift+Tab | 输入框里连按 Shift+Tab | 编辑前询问 → 自动编辑 → 计划模式 → 编辑前询问 循环，焦点留在输入框 | m38 |
| R12.1/R12.2/R12.4 断线补发（真实断网：在 daemon 前放了一个我自己的 TCP 代理，经机器管理界面把它加成一台机器） | 流式回复到第 6 个数字时切断代理全部连接；断线期间从另一个 WebSocket 客户端发 `burst 50`；恢复代理，真实指针点「立即重试」 | 横幅「连接已断开，正在重连… 立即重试」，状态栏「正在重连…」，输入框下「未连接：输入会保留，恢复后再发送」；daemon 侧会话保持 running；重连后被切断的那条回复完整显示一次（1–40，无半截重复），分隔线「— 本地连接在此中断，远程会话未受影响 — 已补回断线期间 61 条消息」，50 条 burst 按序无重复 | m40, m41 |
| R5.4/R5.5 断线期间的权限请求 | 断线期间另一端发 `perm touch offline.txt` | 请求一直挂着（没有自动允许 / 拒绝）；重连后卡片重新出现，点「是」后 claude 继续 | m42 |
| R16.1/R16.3 侧边栏点（附带观察） | 同一会话在另一台机器条目下处于后台 | 有新消息时灰点，等待权限时黄点 | m40, m41 |
| R13.1 回合出错与重试 | 发 `fail`；真实指针点「重试」 | 卡片「本轮回复失败 / API Error: 529 Overloaded / 重试」；点重试后同一条用户消息再发一次并再次出错 | m43 |
| R13.2 进程退出与重新启动 | 发 `crash 3`；点「重新启动」；再发消息 | 横幅「会话已结束：claude 进程退出（代码 3）」+ stderr 三行 + 「重新启动 / 新建终端会话接上」，输入框禁用，没有重连横幅（连接保持）；重启后历史还在、能继续对话；假 claude 的启动参数是 `--resume <建会话时的同一个 id>` | m44, m45 |
| R14.2 回合进行中交接 | `slow 300 100` 进行中输入 `/theme` → 点提示里的「新建终端会话接上」→ 确认框先点取消、再点确定 | 确认框「Claude 正在回复，交给终端会中断当前回合。继续吗？」；取消 → 回合继续、什么都没变；确定 → 同目录出现终端会话，屏幕显示 `fake-claude interactive resume=<同一 id>`，可输入；`ps` 里该会话的对话进程已不在，只有终端里的 `claude --resume` | m51, m52 |
| R14.1 原对话会话 | 点回原对话会话 | 横幅「已交给终端会话接着做，这里不能再发消息」+「打开终端会话」，输入框禁用；REST `ended/handed_off`；点「打开终端会话」切到那个终端会话 | m53 |
| R16.1 新消息灰点 | `second` 在后台，另一个 WebSocket 客户端发 `slow 300 12` | 流式期间灰点（rgb(140,154,166)） | m54 |
| R16.2 回合结束绿点 | 同上，回合结束 | 绿点（rgb(79,124,77)）；打开会话后点消失 | m55 |
| R16.3 等你处理（会话不是当前会话） | 后台会话收到 `perm rm -rf build` | 黄点；应用日志 `[notify] fallback: v-chat · second`（未签名构建走 Dock 降级），Dock 角标 `•`；当前会话没有被切走；点开后卡片在，点「否」→ 工具块失败「The user declined this request.」 | m56, m57 |
| R16.3 等你处理（当前会话、窗口失焦） | 关掉 CDP 焦点模拟并让自己的窗口失焦（`document.hasFocus()=false`），当前会话收到权限请求 | 发出通知 `[notify] fallback: v-chat · second`；侧边栏不显示黄点（见备注 1） | m59 |

（场景表续 2）

| 场景 | 怎么验证 | 结果 | 截图 |
|------|----------|------|------|
| R1.5 对话 + `-c` | `hist` 目录预置 400 轮带工具块的 JSONL；选对话、勾 `-c`、打开；真实滚轮上滑到第一条再滚回底部；发一条 | 332ms 出现最新一条；首屏只生成最新 150 轮（300 条消息）的 DOM；滚轮 18 次到第一条，400 轮全部生成（含 400 个 Read 工具块）；回到底部再发，消息接在历史后面；假 claude 的参数是 `--resume <id>`、没有 `-c` | m60, m61, m62 |
| R2.6 同目录再建一个 `-c` 对话 | 上一个还在运行时，同目录再选对话 + `-c` 打开 | 没有新会话、没有新进程（会话数 4 → 4），切到已有的那个，状态栏「这段对话已在“hist”里打开，已切换过去」 | m63 |
| R1.6 / R11.2 跳过权限 | 选对话 + 勾 `--dangerously-skip-permissions`；点模式按钮；Shift+Tab；发 `tool Bash`、`tool Edit` | 模式显示「跳过权限」；菜单只有这一项且禁用，说明「会话以 --dangerously-skip-permissions 启动，权限模式固定…不能切换」；Shift+Tab 不变；两个工具都直接执行、没有弹权限卡片 | m64 |
| R1.7 Worktree + 对话 + flag | 从「创建隔离 Worktree」进，选 git 仓库 `repo`、对话、勾跳过权限 | claude 在新 worktree 目录 `repo-worktrees/<id>` 里启动（`git worktree list` 多了一个分支 `vibe/<id>`），模式为跳过权限（flag 生效），能对话 | m65, m66 |
| R15.3 重载 | 回合进行中，悬停会话条目点重载按钮，确认 | 确认框「重新启动对话会话“second”？…正在生成的回复会被中断」；完成后提示「对话会话已重新启动」，历史保留，能继续对话；进程换了 pid，参数带 `--resume` | m68 |
| R15.2 删除 | 回合进行中，点 ×：先取消、再确定 | 取消 → 会话还在、回合继续；确定 → 从侧边栏消失，REST 列表里没有了，对话进程少一个，JSONL 文件数不变（5 → 5） | m69 |
| R15.1 重命名 | 双击已打开的对话会话名字 | **不通过，见 P2** | m67-BUG-*, m70-BUG-* |
| R2.5 daemon 重启 | 回合进行中停掉 `v-chat` daemon，再启动 | 断线横幅 + 状态栏「正在重连…（第 1 次）」；daemon 退出时对话进程全部结束；回来后三个对话会话都是 `ended/daemon_restart`，横幅「会话已结束：vibe-remoted 重启过 / 重新启动 / 新建终端会话接上」；点「重新启动」后历史还在、能继续（`--resume`）；同一 daemon 上的终端会话（tmux）还在 | m73, m74 |
| 重开应用后再打开对话会话 | 刷新渲染进程（相当于重开应用），再点开运行中的和已交接的对话会话 | 侧边栏列出全部会话；运行中的会话历史完整（38 条用户消息，和刷新前一致）、贴底、能继续发；已交接的会话显示交接横幅、输入框禁用；对话进程在刷新期间没有退出 | m71, m72 |
| R17.3 旧桌面连新 daemon（基准 7d25cbd 构建的桌面端） | 旧桌面连 `v-term` / `v-chat`，打开终端会话，再点一个对话会话 | 终端会话正常；点对话会话 → 终端区显示「[错误：session … is a chat session] [无法恢复，已停止重连…]」，状态「未连接」，没有被当成终端会话打开 | m83 |
| 中英文切换 | 输入框里留草稿后点 EN；英文下触发权限 / 提问卡片和结束横幅；卡片打开时切回中文；英文下 800×500 打开新建对话框 | 草稿保留；对话界面外壳没有残留中文；卡片、横幅都有英文；卡片打开时切换语言，卡片还在并换了语言；英文对话框在 800×500 下按钮可点、路径栏 33/33 | m75–m78 |
| 小窗口里的卡片（800×500） | 依次触发提问、计划、长命令权限卡片 | 卡片封顶 310px 并可滚动，对话区剩 96–100px；计划卡片的三个选项和输入框都直接点得到；提问 / 长命令卡片要在卡片里滚动才到按钮（备注 5）；都能用真实点击答完 | m79, m80, m81 |
| 快速连续操作 | 60ms 内连点两次「是」；一条消息后连按 3 次回车；Shift+Enter 换行后发送 | 回合正常继续、没有报错提示（没有另外核对 daemon 只收到一次回答）；只发出一条；Shift+Enter 换行不发送，多行消息原样显示 | — |
| 流式输出中缩放窗口 | `slow 100 60` 期间真实窗口 1440×900 → 1325×803 → 800×500 → 1440×900 | 结束后仍贴底，回复完整（到 60） | m82 |
| 两个视图看同一会话（接近 R2.4） | 同一会话同时经 `v-chat` 和 `v-proxy` 两个条目打开，另有一个 WebSocket 客户端发消息 | 各端都显示全部消息；`ps` 里该会话只有一个对话进程 | m40, m41 |

### 只由脚本覆盖、没有亲手走的

- R5.6 回答送达前断线（gui-chat-smoke；注意该用例里有一条永真断言，见「放松检查」）；R5.7 另一端先答 →「已在别处处理」；R5.8 请求被 claude 取消（GUI 脚本也没有这个用例，我也没走）。
- R12.2 的 500 条 ≤2 秒（脚本：504 条 72ms；我手工只做了 61 条）；R12.3 超出缓冲上限的「更早的 N 条已省略」（GUI 脚本没有，我也没走）。
- R13.4 init 报告版本过旧；R16.3 点击通知打开会话（脚本经主进程发 `notification-click` 模拟）和聚焦后清角标；R17.2 在协议 2 的 daemon 上新建并使用终端会话（我只看了它的对话卡片置灰原因）。
- gui-smoke 的旧 machines.json 加密迁移、导航锁 / `window.open`、hook 事件通知。

## 完成条件（界面部分）

| 完成条件 | 判断 | 依据 |
|----------|------|------|
| R1–R19 的全部场景用 verify skill 跑通 | **不成立** | 脚本本身全过（gui-smoke 30/30 ×5，gui-chat-smoke 29/29），但亲手验证有两处与 spec 不符：R3.1（不贴底时发的消息和回复不显示，P1）和 R15.1（已打开的对话会话改不了名，P2）。其余我走过的界面场景（R1、R3.2–R3.4、R4、R5.1–R5.5、R6、R7、R8、R9、R10、R11、R12.1 / .2 / .4、R13.1 / .2、R14、R15.2 / .3、R16、R2.5、R2.6、R17.3）与 spec 一致，R16.3 有一处字面差异（备注 1） |
| gui-smoke 新增的对话模式端到端用例通过 | 成立 | 5 次运行里 `chat session created via picker`、`chat reply rendered`、`permission allow once resumes` 和 6 条对话框布局检查都通过 |
| 现有终端会话测试：gui-smoke 原有用例不改断言照样通过 | 成立（界面运行部分） | 5 次运行原有用例全过；手工验证终端的输入、输出、拖选复制、粘贴、断线横幅与恢复都正常。断言有没有被删改由另一名验证者核对 diff |
| `make check` 全绿、protocol-sync 三处一致、`npm test`、`go test -race` | 尚未验证（不在我的分工） | 由另一名验证者负责 |
| b88f4ae 的两处布局修复 | 成立 | 新建对话框：真实窗口 800×500 / 1325×803 / 1440×900 × 终端 / 对话 / Worktree，路径栏未被压扁、「取消 / 在此打开」始终在窗口内且点得到、中间可滚；机器管理对话框两种尺寸正常。斜杠菜单：800×500 与 1440×900 下名字单行、描述 ≤2 行、键盘上下 26 步选中项始终可见 |

## 待验证项（仍需人工或缺条件）

- **真实的 claude**：真实的流式节奏、真实 JSONL 历史的显示、R5.2 规则真的写进远程 `.claude/settings.local.json`（假 claude 只记到 `$FAKE_CLAUDE_RULES`）、首字延迟。
- **远程 Linux**：登录 shell / fnm 环境下对话模式启动 claude；跨机器网络下的断线重连（我只在本机用 TCP 代理切断连接）。
- **原生通知**：未签名构建一律走 Dock 降级，我核对的是应用发出的通知标题（`机器名 · 会话名`）和角标；签名包里通知的显示与点击、打包后 DMG 的行为没有验证。聚焦后清角标只由脚本覆盖。
- **真实输入法**：我用的是 `insertText`，没有经过输入法组字；代码里发送和卡片里的回车都判断了 `isComposing`，没有实测。
- **P1 的修复方式由作者定**，修后至少要有这几条回归：不贴底时发送 → 消息出现；后台会话收到超过一屏内容后切回 → 能看到最新内容 / 发送后出现；滚回底部 → 立即补齐。
- R5.8、R12.3 的界面表现（见「只由脚本覆盖」）。

## 放松检查

- `gui-chat-smoke.mjs` 第 623 行（R5.6 用例）：`assert(!text0.endsWith('done Bash') || true, '')` 恒为真，没有守住「回答没送达时工具不执行」。这是新写的用例里的空断言，不是改旧断言。
- `gui-smoke.mjs` 相对基准：我读到的改动是新增对话用例、对话框布局检查和第二个 daemon 的准备；没有看到原有用例的断言被删改（逐行核对由另一名验证者负责）。
- drag-select 用例没有被改动或放松（5/5 通过，判断见上）。
- 其余没有发现：没有跳过的用例、没有调大到失去意义的超时、截图目录由我指到自己的 `shots/script/`，没有改动 worktree 里已跟踪的截图。

## 清理

- 我启动的进程全部已停：临时 Electron、4 个临时 daemon、TCP 代理、基准桌面端实例；`ps` 里没有引用我临时目录的进程，没有残留的假 claude；我用过的各个 `TMUX_TMPDIR` 下都确认「no server running」。没有碰用户的 daemon（8765）、默认 tmux socket 目录、`/Applications/vibe-remote.app`、`~/.claude.json`、真实 userData。
- 已删除我建的 7 个临时目录（`/tmp/vr-dmg-BxPFK6`、`-QHWdJu`、`-6TQRb9`、`-r0kCCt`、`-fM5LaT`、`-THw5oA`、`-64lPsT`）；脚本自己的 `vr-gui-*` / `vr-gc-*` / `vr-gt-*` 由脚本清理。
- 剪贴板：手工复制测试后都写回了原内容；`gui-smoke.mjs` 自己也会写回。钥匙串里有一个 `vibe-remote Safe Storage` 条目：脚本日志里没有「removed … keychain item」的提示（脚本只在自己新建了才删并提示），我的实例用的是 `--use-mock-keychain`，所以判断它原本就在；没有动。
- 留下的证据都在 `gate-c-dm/`：`logs/`、`shots/`（手工 106 张 + `script/` 下脚本的 33 张）、`scripts-gui/`（手工验证的驱动脚本）。


## 关口 C 第 2 轮（提交 16fd611，2026-11-20，不通过）

- 总结论：**不通过**（界面部分通过、有备注；非界面部分不通过，1 个问题）。两名独立验证者都没写过被验代码，各自对同一提交 `16fd611` 验证。c6 批准的 2 轮到这一轮用完。
- 分工：
  - 非界面部分：codex（GPT-6）。Go 测试、`make check` 的各步骤、协议冒烟、`.devflow.yml` 命令型 invariants、/protocol-sync 核对、第 1 轮问题的复验、返工 diff 与断言审计、独立反例。结论**不通过**：确认问题 1 个（P4：`-c` 的 cwd 检查漏掉已有历史——X4 的修复引入的 100 行扫描上限，以及记录侧的 `cwd` 没有规范化），2 条不拦的备注（X7 之后对话视图的 DOM 不回收；拖选用例重拖时第一次手势不受最终断言约束）。第 1 轮的 P1（X3）、P3（X5）和两条测试备注复验为已解决，P2（X4）部分解决。孤儿进程清理的两组测试（`TestOrphanCleanup`、`TestLoadChatsMarksDaemonRestart`）在它的沙箱里因为不能执行 `ps` 没能验证。
  - 界面部分：同模型的全新验证者（Claude Fable 5）。真实 Electron，经 CDP 发真实指针 / 滚轮 / 按键事件；gui-smoke 2 次（30/30）、gui-chat-smoke 2 次（34/34）。结论**通过，有备注**：第 1 轮的 P1（X7）、P2（X8）、失焦黄点（X6）、X3 的界面一侧都复验为已解决；7 条备注都不拦。
- 裁决（主会话，`rulings-2.md`）：P4 采纳，返工里记为 X9；界面备注 3、4（改名之后、点开「等你处理」的会话之后的键盘焦点）顺手修，记为 X10；其余备注记进 tasks.md「后续」。返工任务见 tasks.md 的 T21、T22。
- 下面原样收入界面部分结论的全文，和非界面部分结论的指定小节原文（收入前核对过不含 token）。非界面部分的结论共 1749 行，大部分是命令输出，全文在本机 `/Users/mac/github/vibe-remote/.devflow-tmp/gate-c-dm2/verdict-codex.md`（不在仓库里）；它的反例和日志在本机 `/tmp/vr-dm2-dwgum0pa/`（不保证还在）。

---

# 关口 C 第 2 轮 · 验证结论（一）：非界面部分（codex）——指定小节的原文

> 以下为 开头的结论到「环境版本」（原文第 1–21 行）

# 双模式会话第 2 轮独立验证（非 Electron 界面）

- 结论：**不通过**（1 条确认的阻挡问题 P4：continue 的 cwd 检查漏掉已有历史；2 条非阻挡备注）。
- 提交：16fd61151f8f94643288ea59de2123e8787ae8ef
- 验证快照：{"schema":1,"docs_dir":"docs/changes","head":"16fd61151f8f94643288ea59de2123e8787ae8ef","head_tree":"fac0863bba8ff71b644c9791e74cfba8e0e6b922ccfefef1cb0627ccef174da7","target":"7d25cbdeee006f7ad5bdf01879848274a383bb69","target_tree":"4d0d58c229e8bd52a71ea65ae7e10f56c3fa665383b7f15a91e05944ed9b569b"}
- 验证者：Codex，GPT-6；独立验证者，未参与被测代码编写。
- 范围：全部非 Electron 场景；真实 Electron 界面由另一名验证者负责，见其结论。

## 环境版本

开始：工作目录 `/Users/mac/github/vibe-remote/.devflow-tmp/verify-dm`。

```text
$ git rev-parse HEAD
16fd61151f8f94643288ea59de2123e8787ae8ef
$ git status --short
（空输出，工作区干净）
```

测试使用自建临时数据与独立 TMUX_TMPDIR；首轮 Go 使用系统临时区、随后强制 /tmp（见隔离设置补充）；不访问真实 daemon、不启动 Electron。检查日志与反例放 /tmp，完成一项立即追加结果。以下记录持续更新。

> 以下为 「第 1 轮问题的复验（已完成部分）」（原文第 1034–1041 行）

## 第 1 轮问题的复验（已完成部分）

- P1 / X3：**已解决（原反例及指定扩展范围）**。原 `independent_test.go` 仅改证据输出路径，20001 个 x 增量的实际补发为 `reset=true omitted=0 retained-deltas=20000 message_start=1`；原来是 0。新 HEAD 的 `chat/session.ts` 用 esbuild 打包到 /tmp，读真实 Session 补发帧再收完整 assistant，实际 `assistantCount=1 id=long-reply length=20001`，精确全文断言通过。
- P1 多内容块：真实 Session 注入同一 message.id 下「前文 / Read 工具调用 / 20050 个尾字」；超限后 reset 一次、再加 500 字 reset 第二次、以及带合法 epoch/since 的连续两次 **incremental** 补发。实际三组最终 `assistantCount=1 parts=text/tool_use/text`，前文、工具 id、尾巴 20050/20550 字全部精确相等。过程中短预览允许只含保留的尾段，完整消息到达后取代它，未残留第二条。证据：`extended-chat.log`、三个 JSON 帧序列、`real-frame-renderer-replay.log`（本报告检查段给出完整路径）。
- P2 / X4：原 a-b / a/b 反例**已解决**。函数实际 `same-project-key=true selected-other-cwd=false`；真实 WS 的 A 新建带 continue 返回新 UUID，与 B 的 UUID 不同。扩展：a-b、a/b、a.b 三目录同编码且各有历史时均选自己；cwd 在第 2、100 行均找到；alias 查询 + canonical cwd 均找到。
- P2 的扩展边界出现失败：cwd 首次在第 101/1001 行、或 JSONL cwd 使用符号链接别名时，函数 `found=false`；不能把它们记为通过。该阶段随后已补真实 WS / 终端入口反例，结果见 P4 和补充复验。
- 测试备注 2（无限等待）：**已解决等待无上限的问题**。原全量及原单进程 invariant 都在 stubborn 子例等待 15 秒后返回带 PID 和 ps 限制说明的失败，而不是卡到全局 20 分钟超时。实际本机 `/bin/ps -p 89666 -o pid,lstart,command` 被沙箱拒绝（exit 127、`operation not permitted`）。孤儿清理功能本轮未证成，环境失败不计产品问题。

> 以下为 「第 1 轮问题的复验（补充）」（原文第 1372–1376 行）

## 第 1 轮问题的复验（补充）

- P2 / X4：**部分解决**。原跨目录接错与三个真实目录同编码各取自己已通过；cwd 在前 100 行、规范 cwd 的正常路径也通过。前 100 行无 cwd 但后来有合法 cwd 的记录无法 continue，真实 WS 和终端都已证明新建 UUID，合并为本轮问题 P4。符号链接记录也漏选（合成格式范围），不另加问题条数。
- P3 / X5：**已解决**。Go `ChatAckFrame` 的 `message,omitempty`、TS `message?: string` 与 docs/protocol.md:337 的可选字段一致；`ok` 也有明确说明。逐一查 `nackMsg`：too_large（正文及 clientMsgId）、invalid_response（非对象/非法 behavior）、invalid_mode（非计划请求带 setMode）符合新文字。view.ts 的 `why=ack.message || ack.code` 显示路径符合说明。`chat_sync` 的尾巴截断/保留 message_start/完整回复取代预览说明已由真实 Session → 当前 TS 的三组实验佐证。未引入新的协议字段，版本仍为 3。

> 以下为 「问题（确认，立即记录）」（原文第 1166–1175 行）

## 问题（确认，立即记录）

### P4：continue 的 cwd 筛选会漏掉已有对话（P2 / X4 部分解决）

- 严重程度：中；**拦：是**。R1.5 / H6 要求该目录最近一次对话，R17 要求终端 continue 保持语义；现在该目录确有可用 JSONL，带 `-c` 却新建 UUID，历史为空。原跨目录误接已挡住，尚未完整满足 continue。
- 证据一（新引入的 100 行边界）：`internal/chat/transcript.go:157` 只读前 100 行。临时目录中 JSONL 前 100 行为合法 queue-operation、第 101 行为 cwd 等于当前目录的 user。真实 WS 新建 + continue：已有 UUID `579fc997-0969-429a-94d0-e171e9e59e30`，实际 `267f4abe-f764-4436-b724-38e6e75fc82e`；2 MiB / cwd 在第 1001 行也返回另一新 UUID。精确断言 exit 1，见 `directory-edges-ws.log`。
- 证据二（终端同路径）：真实 Manager + tmux 新建终端 `claude -c`，已有 UUID `5150b36c-8928-4a45-95ea-29c728b2f6a2`，实际 argv `[/tmp/vibe-remote-fakeclaude-352857972/claude --session-id 65cfacba-2582-46b7-84da-c61e518296e4]`，没有 resume 旧对话。exit 1，见 `directory-edge-terminal.log`。`manager.go:271` 新建及 `:595` 重载、`chat_manager.go:238` 对话新建共用修后的函数。
- 同一问题的符号链接边界：查找把传入 workdir EvalSymlinks，但 `transcriptCwd` 只 Clean 记录里的 cwd。用 alias 指向真实目录、JSONL 记录 cwd=alias，真实 WS 无论输入 alias 或 canonical 都返回新 UUID；cwd=canonical、输入 alias 的对照通过。记录在 `directory-edges-ws.log`。此证据使用合法的合成 JSONL，未运行真实 claude 验证其是否会写 alias；不声称真实 claude 必然产生这种记录。
- 开发方的 X4 回归测试守住了原碰撞：共享编码目录中按各自 cwd 选历史、无 cwd 不认领、第一行 queue 后第二行有 cwd、大文件的第 2 行有 cwd；**没有守 cwd 在第 101 行以后或 cwd 别名的等价比较**。decisions #46 的「宁可开新对话」是实现裁决，不能把已有 cwd 的文件因人为扫描界限当成无 cwd；本验证未改需求或测试预期。

> 以下为 「P4 因果对照（确认返工引入）」（原文第 1504–1507 行）

## P4 因果对照（确认返工引入）

另建 `/tmp/vr-dm2-dwgum0pa/old-function-control/vibe-remoted`，保留 HEAD 的其余代码和**同一份反例/精确断言**，只把 `internal/chat/transcript.go` 换成 `git show e869add:…` 的原文件；不切分支、不改 worktree。真实 WS 的 cwd 第 101/1001 行用例全部通过；终端 argv 为 `--resume <原 UUID>`，通过。HEAD 原文件下同一输入两路均失败。见 `late-cwd-old-function-control.log`。这证明 100 行筛选界限引入了回归；旧函数仍有跨目录碰撞，不能以此对照宣称旧实现正确或推荐回退修复。

> 以下为 「完成条件」（原文第 1589–1600 行）

## 完成条件（整体提交；本验证者负责非 Electron 部分）

| spec 完成条件 | 判定 | 依据 |
|---|---|---|
| R1–R19 全部场景用 verify skill 跑通 | **不成立** | R1.5 / R17 continue 的 P4 已证实；GUI 由另一名验证者负责，见其结论；孤儿环境限制及真机范围不能算通过 |
| gui-smoke 新增对话端到端用例通过 | **尚未验证（本验证者）** | 按分工没有运行 gui-smoke.mjs / gui-chat-smoke.mjs、没有启动 Electron。由另一名验证者负责，见其结论 |
| make check 全绿 | **尚未验证（沙箱限制）** | 字面 make check 未另起一次（它会重复受阻孤儿测试）；其全部组成步骤已按用户清单重跑：gofmt/vet/typecheck/npm 通过，原 race 全量失败仅 ps 身份识别/孤儿清理两组，排除后全部其他通过。不称为全绿，也不把环境失败当产品错误；独立新反例不在原 check 中，暴露 P4 |
| protocol-sync 三处一致 | **成立** | 本轮完整字段/REST 手工核对，chat_ack.message/ok 及尾巴文字一致；proto=3；P3 修复 |
| 现有终端测试不改断言照样通过 | **尚未验证（完整条件）** | npm 原终端、Go 原终端、黄金字节和实际终端 WS smoke 通过；原 mouse/clipboard 断言保留（只改定位）；continue 新边界 P4 需修；gui-smoke 原有用例由另一名验证者负责，见其结论 |

非功能：500 条 ≤2s 的真实 Electron 渲染、真实远程首字延迟、Linux 运行未由本验证者运行，不推测结果；真 claude / Linux 所需范围按用户要求作为待验证项，不单独拦。命令/HTML/token/工作区信任等已运行安全回归未见新增绕过。

> 以下为 「非阻挡备注」（原文第 1601–1605 行）

## 非阻挡备注

1. **X7 的 DOM 会持续扩张**：5000 历史初始 300 DOM，上滑状态收到 1000 条后 1300 DOM，再上滑加载 200 为 1500；follow 固定 start/end=total，没有回收旧 DOM 的机制。原贴底 follow 已有此增长，本次扩到不贴底时。首屏/reset 的 300 上限仍成立；本轮未证明这会超过 spec 的 500 条 / 2s 门槛，不另计阻挡产品问题。后续应实测长时间对话，评估保留阅读锚点同时回收不可见 DOM。
2. **拖选重新定位的覆盖边界**：最终 clipboard 字符级断言保持，但在屏幕变化时可重新量/重拖 2 次，实际屏幕变化中首次手势结果不受最终断言约束。开发报告称稳定屏幕 4 次通过且重拖没触发；本验证没有运行 Electron，不宣称消除既有偶发。此项属测试证据边界，不另计产品问题。

> 以下为 「待验证项」（原文第 1606–1612 行）

## 待验证项

- 真实 Electron 全部场景及 500 条渲染门槛：由另一名验证者负责，见其结论；特别是 X7、X8、X6 及原拖选偶发。
- 允许 ps 与自启动进程信号的环境中的异常孤儿回收（TestOrphanCleanup、TestLoadChatsMarksDaemonRestart）。本轮失败/排除保留；优雅 daemon restart smoke 已通过，但不能替代异常退出证明。
- 真实 claude 的规则写盘、实际 JSONL 的完整工具与更晚 cwd/alias 出现条件；远程 Linux/Pdeathsig、真实 CLI 首字延迟；系统原生通知显示/点击、物理断网/休眠。没有运行，原因：按本轮隔离规则只用 fake claude、本地环境/无真实 Electron。依用户要求不以这些条件拦。
- c7 已记录为用户决定（加强 invariants 加上 X4 回归）；tasks.md 后续事项沿用，不因它们未做判不通过。现有回归已运行，P4 是新证明的行为失败，不能由 c7 抵消。

> 以下为 「放松检查审计（已完成）」（原文第 1412–1424 行）

## 放松检查审计（已完成）

审计命令：`git diff e869add..HEAD -- '*_test.go' 'desktop/scripts/*.mjs' '.claude/skills/verify/scripts/*'`；完整 diff 保存 `/tmp/vr-dm2-dwgum0pa/test-diff.txt`，逐一核对所有删除行和新增断言。

- `test-chat-window` 的旧 `follow(..., false)===旧窗口` 改为固定 start、末端跟到 total。这是 decisions #43 / X7 的已记录行为修复，旧断言本来在守会让消息不可见的窗口，新的视图用例继续精确验证「scrollTop 不变」和「滚到底可见最新」。不归为降低要求。
- `test-chat-activity` 的 `isActive=true, windowFocused=false` 从 none 改为 waiting：spec R16.3 字面明确要求，decisions #47 已查证无相反裁决；通知仍为 true，seen 后清点仍有独立断言。不是放宽。
- orphan 的 `<-gone` 改成 15s 失败；原 stubborn 运行时 ≤4s 的断言仍保留。没有把原 4s 调大为 15s；原等待无上限现在更严格。本轮实际验证了它能及时失败。
- R5.6 永真 `… || true` 已删除，改为工具块无结果、回复未继续、另一端无 resolved/tool_result 三条具体断言；没有删实际要求。
- gui-smoke 拖选的 mouse reporting 断言及最终复制文本逐字等于 `SELECT_ME_PLEASE` 都保留。新增稳定定位与至多 3 次重新量坐标/重拖（只在 screen/y 变化时），没有复制断言失败后重跑整例。旧 10s 等待未调大，但新增多次稳定等待可能延长整例时长，且重新拖会遮住「屏幕变化期间手势」的结果，保留非阻挡测试边界备注；正常稳定屏幕断言未变。
- 两份冒烟 bash daemon 的 allowed_roots 从整个 /tmp 缩到本次自建目录，default_workdir 同步移动：旧脚本没有断言必须浏览 /tmp 任意兄弟目录；终端新建、恢复、reload、跨环境、token 和鼠标选择的要求仍在该目录内成立。没有让原越界安全断言成为永真（原 GUI 脚本本就没有这项断言）；config / REST fs / attach 越界回归在 Go 中仍运行。测试隔离更严格，不算放松。
- 其余 Go / desktop 测试没有删除用例、放宽断言、提高旧超时或新增忽略；package.json 只把 sidebar-rename/source-bytes 加进原完整 test 链。prompts.ts 的 NUL 变为 `\0` 转义保持运行时 sentinel 相同；i18n parity/source bytes 均通过。
- 本验证者的两个 `-skip` 是用户明确允许的沙箱排除，原失败和未执行范围单列；不把跳过测试算通过。c7 是加强检查的待用户事项，没有改配置，不拦本轮。

---

# 关口 C 第 2 轮 · 验证结论全文（二）：界面部分（同模型的全新验证者）

# 独立验证结论（界面部分，关口 C 第 2 轮）

- 结论：**通过，有备注**（第 1 轮拦下的 P1、P2 和备注里的失焦黄点、X3 的界面一侧都已解决；没有发现新的要拦的问题；7 条备注见「问题」）
- 提交：16fd61151f8f94643288ea59de2123e8787ae8ef
- 验证快照：`{"schema":1,"docs_dir":"docs/changes","head":"16fd61151f8f94643288ea59de2123e8787ae8ef","head_tree":"fac0863bba8ff71b644c9791e74cfba8e0e6b922ccfefef1cb0627ccef174da7","target":"7d25cbdeee006f7ad5bdf01879848274a383bb69","target_tree":"4d0d58c229e8bd52a71ea65ae7e10f56c3fa665383b7f15a91e05944ed9b569b"}`
- 验证者：Claude（Anthropic，模型 Fable 5，`claude-fable-5-2[1m]`），独立验证者，没写过这段代码，没有派子 agent。界面场景由我负责；Go 测试、`make check`、协议层由另一名验证者负责，我没有重复。

## 环境版本

worktree：`/Users/mac/github/vibe-remote/.devflow-tmp/verify-dm-gui`（detached）。

```
开始时
$ git rev-parse HEAD
16fd61151f8f94643288ea59de2123e8787ae8ef
$ git status --short
（无输出）

结束时
$ git rev-parse HEAD
16fd61151f8f94643288ea59de2123e8787ae8ef
$ git status --short
（无输出）
```

Electron 44.7.0，Node v22.22.2，Go 1.26.2，macOS（darwin/arm64）。没有改任何已跟踪文件，没有提交；只多了被忽略的构建产物 `desktop/dist/`。

## 检查

两份 GUI 冒烟逐个运行，每次各带独立的 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-dmg2-XXXXXX)`（另给一个空的临时 `CLAUDE_CONFIG_DIR`），开跑前用 `ps -axo pid,comm | grep 'Electron$'` 确认没有别的 Electron 测试实例。

| # | 命令 | 结果 |
|---|------|------|
| 1 | `node .claude/skills/verify/scripts/gui-smoke.mjs` | 30 PASS / 0 FAIL，exit 0 |
| 2 | 同上 | 30 PASS / 0 FAIL，exit 0 |
| 3 | `DEVFLOW_EVIDENCE_DIR=<gate-c-dm2/shots/script> VR_MAIN_DAEMON=<git archive 7d25cbd 构建的 daemon> node .claude/skills/verify/scripts/gui-chat-smoke.mjs` | 34 PASS / 0 FAIL，exit 0 |
| 4 | 同上 | 34 PASS / 0 FAIL，exit 0 |

- 日志：`gate-c-dm2/logs/gui-125051.log`、`gui-125105.log`、`chat-125114.log`、`chat-125207.log`；脚本截图在 `shots/script/`。
- 没有失败用例，所以没有「重跑区分偶发 / 稳定」的记录。
- 协议 2 的 daemon：`git archive 7d25cbd vibe-remoted` 导出到我自己的临时目录构建，经 `VR_MAIN_DAEMON` 传入，没有动共享仓库的 worktree 元数据。

## 手工验证用的临时实例

2 个临时 daemon + 1 个我自己的 TCP 代理 + 1 个 Electron，全部在 `/tmp/vr-dmg2-6miAe3/` 下：`v-term`=/bin/bash；`v-chat`=假 claude（`claude_flags`：`-c`、`--dangerously-skip-permissions`；`FAKE_CLAUDE_LONG_COMMANDS=1`）；`v-proxy`=放在 `v-chat` 前面的 TCP 代理（同一个 daemon，用来真实断网）。各自独立的 `TMUX_TMPDIR`、`state_dir`、`CLAUDE_CONFIG_DIR`，`allowed_roots` 只有该目录下的子目录；Electron 用临时 userData + `--use-mock-keychain` + 随机调试端口。所有操作经裸 CDP 的 `Input.dispatchMouseEvent`（按下 / 松开 / 滚轮）、`dispatchKeyEvent`、`insertText` 发给这个实例，点击前做命中测试；「另一台桌面」是直连 daemon 的 WebSocket 客户端。驱动脚本在 `gate-c-dm2/scripts-gui/`（不含 token），截图在 `gate-c-dm2/shots/`。

## 第 1 轮问题的复验

### P1（X7）不贴底时发消息不显示 / 后台会话切回不贴底 → **已解决**

| 操作 | 实际看到的 | 截图 |
|------|------------|------|
| **复现 B ×3**：`burst 30`（超过一屏）→ 真实滚轮上滑 300px（距底 300 / 301 / 301px）→ 点输入框输入 `echo 看得到吗 N` 回车 | 3/3：自己的消息 100ms 内出现，回复出现，视图回到底部（距底 0–1px），最后一条回复在可视区内 | p1b-1, p1b-2 |
| **复现 A ×3**：贴底 → `slow 150 20` + 排队的 `burst 30` → 点终端会话 alpha → 等该会话的点 `none→灰→绿` → 点回来 → 直接发 `echo 回来后 N` | 3/3：切回即贴底（距底 1px，内容高度比离开时多 1100px，最后一条 `burst 30` 可见），点已清；随后发的消息 87–98ms 出现，回复出现 | p1a-1, p1a-2, p1a-3 |
| 变体：上滑 600px 阅读时，别处（另一个 WebSocket 客户端）来了 12 条消息，又来一条流式回复 | 视图不动（scrollTop 5689 始终不变）；新内容已生成在下方。**界面上没有任何「下面有新内容」的迹象**（没有提示条 / 按钮，当前会话也不显示点）——见备注 1 | p1v1 |
| 变体：再用滚轮滚回底部 | 立即看到最新内容（距底 1px，最后一条完整可见），不需要再发消息 | p1v2 |
| 变体：离开时不贴底（上滑 700px）→ 后台来 25 条（绿点）→ 切回 | 保持原位置（scrollTop 6115 → 6115）；滚轮到底能看到 `burst 25` | p1v3 |
| 变体：上滑时自己发 `fail` | 回到底部，用户消息和「本轮回复失败 / API Error: 529 Overloaded / 重试」卡片都可见 | p1v4a |
| 变体：上滑时别处发 `fail` | 视图不动；滚到底错误卡片在 | p1v4b |
| 变体：贴底时来权限卡片 / 提问卡片（对话区从 698px 缩到 595 / 268px） | 仍贴底（距底 0px），卡片在窗口内；答完 / Esc 后仍贴底 | p1v5a, p1v5d |
| 变体：上滑时别处触发权限 / 提问卡片 | 卡片出现在底部，对话区保持原位置（不被拽到底）；点「否」后位置也不变。阅读位置没有丢，但卡片对应的工具块在下方看不到，要自己滚下去（同备注 1） | p1v5b, p1v5c |
| 变体：`-c` 接 400 轮历史（首屏 150 轮）→ 滚轮每次 1500px 上滑到第一条，途中别处来了一条新消息 | 44 次滚轮到第一条，窗口按 150→151→251→351→401 轮扩展，期间 0 次被拽向底部；滚到最顶（scrollTop 0，第一条是「历史提问 #0001」）和最底（5 次大滚轮，距底 1px，能看到途中来的那条）都正常；再发一条接在历史后面；假 claude 的参数是 `--resume`、没有 `-c` | p1v6-hist-* |
| 变体：流式输出时边打 5 行草稿（输入框逐行长高）/ 连排 3 条消息 | 一直贴底跟随（距底 0px） | p1v8 |
| 变体：流式输出中缩放窗口 1440×900 → 1325×803 → 800×500 → 1100×700 → 1440×900 | 结束时贴底、回复完整（到 60）。**中途窗口一次变矮 ≥48px 后不再跟随**（1325×803 时距底 97px，800×500 时 400px），要滚到底或发消息才恢复——见备注 2（第 1 轮的代码同样如此，不是返工引入的） | p1v7 |

### P2（X8）已打开的会话双击改不了名 → **已解决**

真实双击：`mousePressed`/`mouseReleased`，clickCount 1、2，按下 40ms、两次间隔 90ms；双击后 1.2 秒内每 60ms 采样一次「改名输入框在且持有焦点」。每类 5 次（第 1、2、3、5 次输入新名字回车，第 4 次输入后按 Esc）。

| 会话 | 输入框出现并保持焦点 | 回车后侧边栏 + REST `title` | Esc 后名字不变 | 对话多出消息 / 输入框进字 / 终端进字 |
|------|----------------------|------------------------------|----------------|--------------------------------------|
| 已打开、在前台的对话会话 | 5/5（采样全程持有焦点） | 4/4 都变了 | 1/1 | 无 |
| 已打开、在后台的对话会话（双击同时把它切到前台） | 5/5 | 4/4 | 1/1 | 无 |
| 已打开、在前台的终端会话 | 5/5 | 4/4 | 1/1 | 无 |
| 已打开、在后台的终端会话 | 5/5 | 4/4 | 1/1 | 无 |
| 从没打开过的对话会话（用 WebSocket 另建） | 5/5 | 4/4 | 1/1 | 无；改名后仍没有被打开 |
| 从没打开过的终端会话 | 5/5 | 4/4 | 1/1 | 无 |

- 30 次之后侧边栏照常更新：点终端会话 → 点对话会话，高亮跟着走；另一个客户端在后台对话会话里跑完一个回合 → 该会话出现绿点。截图 `p2-*-typing`、`p2-*-renamed`、`p2-sidebar-after-all`。
- 改名输入框开着时：
  - 点别处（对话区）→ 输入框收起，已输入的名字**被保存**（失焦即提交，代码注释里写明的既有行为）。
  - 点另一个会话 → 名字保存，切到那个会话；但**键盘焦点停在页面上（`BODY`），直接打字没有反应**，要再点一下输入框——见备注 3（`p2v-b`）。
  - 后台会话来了新回合、经过两次 5 秒列表刷新（共 11.5 秒）→ 输入框和已输入的字一直在、焦点不丢；期间侧边栏暂停重建（后台会话的点要等改名结束才出现，结束后立即变绿）（`p2v-cd`）。
  - 正在改名的当前会话自己来了新消息 → 输入框不受影响，消息照常显示在对话里。
- 单击当前会话的名字（不改名）：不出现输入框；对话会话的键盘焦点在对话输入框，终端会话在终端，直接打字都进了该会话。
- 改名回车 / Esc 之后键盘焦点在 `BODY`（不回到会话），要点一下才能继续打字——同备注 3。

### X6 当前会话 + 窗口失焦时的黄点（R16.3）→ **已解决**

关掉 CDP 的焦点模拟，经主进程把我自己的应用真的隐藏（`app.hide()`，`document.hasFocus()=false`），3 次：

| 操作 | 实际看到的 | 截图 |
|------|------------|------|
| 当前对话会话收到权限请求（2 次）/ 提问（1 次） | 侧边栏该会话 `data-dot=waiting`，点可见（7×7，rgb(150,100,38)）；应用日志 `[notify] fallback: v-chat · second`，Dock 角标 `•`；当前会话没有被切走 | x6-3 |
| 窗口显示但不聚焦（`showInactive`） | 黄点还在 | x6-3 |
| 窗口重新聚焦 | 点消失、角标清空，卡片还在、可回答 | x6-1-after-focus |
| 其它会话 | 后台对话会话的灰 / 绿点、终端会话的灰点都没变（规则不变另见场景表 R16） | x6-3 |

附带观察（不是缺陷）：侧边栏既有样式是「鼠标悬停在某一行上时隐藏该行的点、让出位置给 ×」，所以指针正好停在当前会话那一行时看不到黄点（`x6-1-…-unfocused` 就是这样拍的）；指针移开后可见。

### X3 长回复重连后显示两次（R12.4）→ **已解决**（界面侧）

| 操作 | 实际看到的 | 截图 |
|------|------------|------|
| A（较短回复，真实断网）：经 `v-proxy` 打开会话，`slow 100 60` 流到第 20 个 / 第 1 个数字时切断代理的全部连接，3 秒后恢复，点「立即重试」；2 次 | 横幅「连接已断开…」+「未连接：输入会保留，恢复后再发送」；重连后回复只有 1 条、1–60 完整有序；分隔线「— 本地连接在此中断，远程会话未受影响 — 已补回断线期间 34 / 33 条消息」 | x3a-1, x3a-2 |
| B（超过 daemon 流式尾巴上限）：假 claude 的 `slow 1 23000` 能产出 23000 个增量（上限 20000；daemon 日志确认「the stream tail of the current reply is over its limit…」）。另一个客户端发起，daemon 产出 20620 个增量后才在界面里第一次打开这个会话（reset 同步，中途加入） | 加入时预览从第 890 个数字开始（尾巴最旧的部分已淘汰，设计如此）；回复结束后界面里是 **1 条**完整回复（1–23000，顺序正确），用户消息 2 条 / 助手消息 2 条（另一条是此前的 echo）；一直开着的另一个视图同样是 1 条完整回复、贴底 | x3b-1, x3b-2 |
| C（同上，但视图一直开着）：经 `v-proxy` 发 `slow 1 23000`，流到 394 个数字时切断，等 daemon 超过 20800 个增量后恢复并重连 | 重连后预览中间暂时缺一段（395 到约 800，补发只有尾巴里还留着的部分）；回复结束后是 **1 条**完整回复（1–23000），助手消息只多 1 条 | x3c-1, x3c-2 |

没有再出现「一条残片 + 一条完整回复」。尾巴上限这一侧的协议细节（`message_start` 保留并补发）由另一名验证者在协议层核对。

### 删除对话会话的确认文案 → **已解决**，与实际行为一致

真实指针悬停会话行、点 ×，先取消抓文案，中英文各一次：

- 中文（对话）：「删除对话会话“third”？远程 claude 进程会被终止，会话从列表中移除。对话记录仍保留在远程 claude 的历史文件（JSONL）里，不会被删除。」
- English (chat): "Delete chat session "third"? The remote claude process will be killed and the session removed from the list. The conversation itself stays in claude's history files (JSONL) on the remote machine; it is not deleted."
- 终端会话的文案没变（中文「…远程 Claude 进程会被终止、当前画面会丢失，且无法撤销。」/ English "…its current screen lost. This cannot be undone."）。
- 行为：取消 → 两个会话都还在。回合进行中确认删除 → 侧边栏消失（另一个机器条目下的同一会话也消失），REST 列表里没有了，假 claude 进程 10 → 9，JSONL 文件数 6 → 6（历史保留）。截图 `r-after-delete`。

## 场景（回归抽查，亲手走过的）

除特别说明外都是真实指针 / 滚轮 / 按键事件；截图在 `shots/` 下（省略 `.png`）。

| 场景 | 操作 | 结果 | 截图 |
|------|------|------|------|
| 新建终端会话 | 机器 v-term →「打开现有目录」→ 进 alpha →「在此打开」 | 侧边栏出现 `terminal:alpha`，shell 提示符出现 | n01 |
| 新建对话会话 | v-chat → 进 main → 点「对话」卡片 →「在此打开」；发 `echo 你好` | 侧边栏带「对话」标记，输入框可用，回复 `你好` | n02 |
| 新建会话对话框 800×500 | 真实窗口 800×500：普通 / 普通+对话 / Worktree / Worktree+对话 四种状态量按钮；真实点击「取消」；再真实点击「在此打开」建一个对话会话 | 四种状态：对话框在窗口内，路径栏 33/33，「取消 / 在此打开」都在窗口内且中心点命中，中间可滚（349/658–742）；取消关闭；建出 `chat:fourth` | r-picker-800x500-*, r-new-chat-800x500 |
| Markdown 渲染 | `md` | h1、2 项列表、表格、行内代码、代码块 SF Mono + 「复制」按钮；`<script>` / `<img onerror>` 以文本显示，DOM 里 0 个 script / img；`javascript:` 不成链接，只有 `ok→https://example.com` | r-md |
| 工具块 | `tool Read` → 点块头展开再折叠；`tool Edit` / `tool Write` | 默认折叠（33px → 130px → 33px）；Edit / Write 有 diff 块（`- old line` / `+ new line`，颜色本轮没有再量）；被拒绝的 Edit 标「失败」并展开 | r-tool-read-expanded |
| 权限：允许一次 | `tool Bash` → 点「是」；再发一次 | 执行（`done Bash`）；第二次仍询问 | r-perm-card |
| 权限：不再询问 | 第二次点「是，并且对 …/work 里的 echo fake 不再询问」；第三次 | 执行；假 claude 记下规则 `Bash(echo fake)`；第三次不再弹卡片 | — |
| 权限：拒绝并说明 | `tool Edit` → 输入「先别改这个文件」→ 点「否」 | claude 回 `denied: 先别改这个文件`，对话继续 | r-perm-deny-note |
| 权限：无建议 + 键盘 | `perm ls -la` | 只有「是 / 否」；按 `1` 即允许 | — |
| 计划评审 | `plan` → 填「请把第二步拆细」点「继续完善计划」→ 新卡片点 1；再 `plan` 点 2 | 计划按 Markdown 渲染 + 3 个选项；完善后重新提交；选 1 → 「自动编辑」且随后 Write 不询问；选 2 → 「编辑前询问」 | r-plan-card |
| 提问表单 | `ask`：没答时看提交按钮；选 Banana、Blue + 其他「青色」，提交 | 没答完时提交禁用、两题都标未答；claude 收到 `Banana` / `Blue, 青色` | r-question-filled |
| Esc 中断 | `slow 200 60` 流到 7 时按 Esc；再发一条；空闲时按 Esc | 立即停住标「已中断」；随后的消息正常回复；空闲 Esc 无变化 | r-esc-interrupted |
| 排队 | 忙时连发 3 条，点第二条的 ×；另一轮排 2 条后按 Esc | 三条「排队中」→ 剩两条 → 回合结束后按序发出第一、第三条；Esc 后两条回到输入框（空行分隔），没有发出 | r-queue |
| 斜杠菜单 | 1440×900 和 800×500：输入 `/`，↓ 13 次（含回绕）再 ↑ 13 次；真实点击第 3 行；`/dev` + ↓ + Enter；Esc | 13 项，菜单在窗口内、无横向滚动；27 步里选中行始终完整可见；点击 / Enter 把命令填进输入框、不发送；过滤出 4 条 `/dev-*`；Esc 关闭 | r-slash-* |
| Shift+Tab | 输入框里连按 3 次 | 编辑前询问 → 自动编辑 → 计划模式 → 编辑前询问，焦点留在输入框 | — |
| 断线补发的分隔线 | 见 X3 的 A；另：视图在后台时代理断开、期间来 40 条、后台自动重连，再切回 | 分隔线「— 本地连接在此中断，远程会话未受影响 — 已补回断线期间 N 条消息」；切回时贴底、最后一条 `burst 40` 可见 | x3a-2, x-offline-in-background-back |
| 进程退出后重新启动 | `crash 3` → 点「重新启动」→ 再发 | 横幅「会话已结束：claude 进程退出（代码 3）」+ stderr 三行 + 两个按钮，输入框禁用，没有重连横幅；重启后历史还在（18 条用户消息）、贴底、能继续；参数带 `--resume` | r-crash-ended |
| 交接到终端 | 输入 `/theme` 回车 → 点提示里的「新建终端会话接上」 | 提示「/theme 只能在终端界面使用」；同目录出现终端会话，屏幕 `fake-claude interactive resume=<id>`；原对话会话 REST `ended/handed_off`，横幅「已交给终端会话接着做，这里不能再发消息 / 打开终端会话」，输入框禁用 | r-terminal-only-hint, r-handoff-terminal, r-handoff-chat-ended |
| 终端：输入 | 点终端，输入 `echo TERM_$((20+3))_OK 中文✓` | 回显 `TERM_23_OK 中文✓` | — |
| 终端：拖选 + ⌘C | 真实拖拽选中 `COPY_TARGET_LINE` 一行，⌘C | 剪贴板 = `COPY_TARGET_LINE` | r-term-drag-select |
| 终端：⌘V | 剪贴板放 `echo PASTED_$((3*3))_OK`，⌘V + Enter | 输出 `PASTED_9_OK`（剪贴板事后写回原文本） | r-term-after-paste |
| R16 后台会话的点（窗口聚焦） | 另一个客户端在后台会话里：流式 → 回合结束 → 权限请求；等 6 秒；点开；再试 3 次 | 灰 rgb(140,154,166) → 绿 rgb(79,124,77) → 黄 rgb(150,100,38) + `[notify] fallback: v-chat · second`，当前会话没被切走；一次列表刷新后仍是黄点；点开后卡片在、贴底、点消失 | x-background-yellow-dot, x-opened-waiting-session |
| 对话区文字选择与复制 | 真实拖拽选中一条回复；应用菜单有 Edit▸Copy（⌘C）；经主进程触发同一个复制动作 | 选区正确，剪贴板得到所选文字（CDP 的按键不经过原生菜单快捷键，所以没法直接按 ⌘C 验证） | x-transcript-selection |

## 像真实用户那样再用一段时间（探索）

在一个新的对话会话里连续干活，记下的情况（都没有报错，渲染进程全程 0 个未捕获异常，Electron 和两个 daemon 的日志里没有 error / panic）：

- 流式输出途中滚轮上滑 120px 看前文 → 不会被后续输出拽回（1.5 秒内位置不变）；滚回底部后继续跟随。只上滑 30px（在 48px 的贴底范围内）会被拉回底部，符合预期。
- 上滑后在两个会话之间快速来回切 4 次 → 阅读位置不变。写到一半的草稿切走再切回还在，焦点回到输入框，直接回车能发。
- 上滑时排队一条消息 / 上滑到错误卡片点「重试」→ 视图回到底部，消息和回复都看得到。
- 回合进行中、上滑状态下点侧边栏的重载 → 确认框 → 重启后贴底、历史保留、能接着发。
- 改名：很长的名字在侧边栏里省略号截断、× 仍点得到；清空名字回车 → 恢复为目录名。
- 卡住 / 看不懂的地方：见备注 1、3、4（上滑时不知道下面来了新内容；改名后要再点一下才能打字；点开「等你处理」的会话后卡片上写着的 1 / 2 / Esc 按了没反应）。

## 完成条件（界面部分）

| 完成条件 | 判断 | 依据 |
|----------|------|------|
| R1–R19 的全部场景用 verify skill 跑通 | **成立**（界面部分） | gui-chat-smoke 34/34 ×2（含返工新增的 X6、X7 ×2、X8 ×2）、gui-smoke 30/30 ×2。第 1 轮与 spec 不符的三处本轮亲手复验都已符合：R3.1（P1）、R15.1（P2）、R16.3（失焦黄点）；R12.4（X3）界面上只显示一次。本轮亲手重走并与 spec 一致的：R1.1 / R1.2 / R1.5、R3.1–R3.3、R4、R5.1–R5.3 / R5.2b、R6.1–R6.3、R7、R8、R9、R10、R11.1、R12.1 / R12.2（44 条）/ R12.4、R13.1 / R13.2、R14.1、R15.1–R15.3、R16.1–R16.3。本轮只由脚本覆盖、没有亲手重走的：R1.3 / R1.4 / R17.2（置灰原因）、R1.6 / R11.2、R5.6 / R5.7、R12.2 的 500 条、R13.4、R14.2 的确认框；本轮脚本和手工都没有覆盖、沿用第 1 轮在 e869add 上的手工结果的：R1.7、R2.5（界面内重启 daemon）、R2.6、R17.3、R5.4 / R5.5。返工没有改动这些路径的代码（`git diff e869add..HEAD -- desktop/src` 只涉及滚动、侧边栏点击 / 焦点、活动点、流式预览合并、文案）。 |
| gui-smoke 新增的对话模式端到端用例通过 | 成立 | 2 次运行里 `chat session created via picker`、`chat reply rendered`、`permission allow once resumes` 和 6 条对话框布局检查都通过 |
| 现有终端会话测试：gui-smoke 原有用例不改断言照样通过 | 成立（界面运行部分） | 2 次运行原有用例全过；手工验证终端的输入、拖选复制、粘贴、改名、单击聚焦都正常。相对第 1 轮，gui-smoke 只改了两处：bash daemon 的目录收窄到本次运行自己的目录；拖选用例量坐标前等屏幕稳定、屏幕变动时最多重做 3 次，最后的断言（复制内容逐字等于 `SELECT_ME_PLEASE`）没有变 |
| `make check` 全绿、protocol-sync 三处一致、`npm test`、`go test -race` | 尚未验证（不在我的分工） | 由另一名验证者负责 |

## 问题

没有要拦的问题。备注（都不拦）：

1. **上滑阅读时没有「下面有新内容」的提示**。新回复、错误卡片都生成在下方，视图不动（这是对的），但界面上没有任何迹象：没有提示条 / 回到底部按钮，当前会话也不显示点。权限 / 提问卡片会固定出现在底部，所以「等你处理」不会漏；普通回复则要自己滚下去才知道。低，建议加一个「回到底部 / 有新消息」入口。（`p1v1`、`p1v5b`）
2. **窗口一次变矮 ≥48px 后流式输出不再跟随**：缩窗口时对话区变矮但滚动位置不变，被判成「不贴底」，后续输出留在下方，要滚到底或发一条消息才恢复；空闲时缩窗口后别处来的回复同理。逐行长高的输入框、排队条目、底部卡片不受影响（实测一直贴底）。第 1 轮的代码同样如此（`render()` 里的 `atBottom()` 判断没变），不是返工引入的。低。（`p1v7`）
3. **改名之后键盘焦点不回到会话**：改名回车 / Esc 后焦点在页面上（`BODY`），要点一下输入框或终端才能继续打字；改名输入框开着时直接点另一个会话，会话切过去了但同样没有焦点（按代码判断这一条是 X8 的修复带来的：改名期间不让会话视图抢焦点，提交完成后没有把焦点交回去；没有在旧提交上对照实测）。不会把字打到别处，只是多点一下。低。（`p2v-b`）
4. **点开「等你处理」的后台会话后，卡片上的键盘快捷键不生效**：卡片写着「1 是 / 2 否 / Esc 中断」，但从侧边栏点开带待答请求的会话后焦点在 `BODY`，按 1、2、Esc 都没有反应（3/3 次；权限卡片），要先点一下卡片。会话是当前会话时出现的卡片会自动拿到焦点，键盘可用。按代码判断第 1 轮的提交也是这样（卡片只在创建时聚焦一次，后台视图是 `display:none` 聚焦不上；那时切回会话聚焦的是此刻隐藏着的输入框），没有在旧提交上实测。这正是 R16.3「黄点 → 点开 → 回答」的主流程，鼠标可答，所以不拦；建议切回会话时把焦点给卡片。低到中。（`x-switch-to-waiting-key-ignored`）
5. **断线分隔线把流式增量也数成「消息」**：一条长回复途中重连，分隔线写「已补回断线期间 20000 条消息」（实际是同一条回复的 20000 个增量）；60 个数字的短回复写 33 / 34 条。文案问题。低。
6. **长回复超过尾巴上限后中途加入 / 重连，回复结束前的预览不完整**：中途加入时从第 890 个数字开始显示，重连时中间缺一段；回复结束后变成完整的一条。daemon 日志和设计里写明如此，记录在案。低。
7. **指针停在当前会话那一行时看不到它的黄点**：既有样式「悬停时隐藏该行的点，让位给 ×」对新加的「当前会话黄点」同样生效。窗口失焦时指针一般不在那一行，影响很小。低。

`tasks.md`「后续」里已记录的第 1 轮备注 2–11 本轮没有重新逐条核对，其中看到仍然如此的：已结束的对话会话在侧边栏没有标记（交接后侧边栏里有两个同名的 `work`，一个终端一个已结束的对话）、被拒绝 / 中断的工具块标「失败」、`AskUserQuestion` 在对话里显示成原始 JSON。

## 待验证项（仍需人工或缺条件）

- **真实的 claude 和远程 Linux**：真实的流式节奏和超长回复（假 claude 的 23000 个增量每个只有几个字符，没有触到 8 MiB 的字节上限那条分支）、真实 JSONL 历史、R5.2 规则真的落盘、跨机器网络下的断线（我只在本机用 TCP 代理切断连接）。
- **原生通知**：未签名构建一律走 Dock 降级；签名包里通知的显示与点击没有验证。
- **真实输入法**：我用的是 `insertText`，没有经过输入法组字；改名输入框和对话输入框在组字过程中的回车没有实测。
- **人手的双击节奏只取了一种**（按下 40ms、间隔 90ms，30 次）；更慢的双击（间隔 300–450ms）和触控板轻点没有试。侧边栏 5 秒重建时恰好落在按下和松开之间的点击会丢（`tasks.md`「后续」已记录），本轮 30 次双击都没有遇到；切换会话的点击我的脚本带自动重试，没有单独统计丢失次数（复现 A 的 6 次切换是 0 次）。
- 备注 4 在第 1 轮提交上是否相同，只读了代码，没有实测。
- 本轮没有亲手重走的场景见「完成条件」第一行。

## 放松检查

- `gui-smoke.mjs` 拖选用例：新增「屏幕变动时重新量坐标、最多重做 3 次」；最后的断言没变。我的 2 次运行都没有触发重做（日志里没有 `NOTE drag-select`）。
- `gui-chat-smoke.mjs`：R5.6 的永真断言已换成 3 条真断言（第 1 轮指出的问题）；新增的 X6 / X7 / X8 用例用的是 CDP 真实输入事件；X6 用例在隐藏应用前显式调用 `blurWebView()`（我手工只用 `app.hide()`，页面同样失焦，结果一致）。
- 没有跳过的用例；截图目录指到我自己的 `shots/script/`，没有改动 worktree 里已跟踪的截图。
- 我自己的手工脚本里有若干处用 JS 做清理和准备（清空对话输入框里上一步留下的草稿、单击聚焦测试前先让焦点离开、把错误卡片滚进视野再真实点击「重试」），都不在被验证的操作路径上；被验证的点击、双击、滚动、输入全部是 CDP 的真实输入事件。
- 其余：无。

## 清理

- 我启动的进程全部已停（harness、临时 Electron、2 个临时 daemon、TCP 代理）；`ps` 里没有引用我临时目录的进程，没有残留的假 claude；两个 `TMUX_TMPDIR` 下都确认「no server running」。没有碰用户的 daemon（8765）、默认 tmux socket 目录、`/Applications/vibe-remote.app`、`~/.claude.json`、真实 userData。
- 已删除我建的 9 个临时目录（`/tmp/vr-dmg2-6miAe3` 和 8 个冒烟用的 `vr-dmg2-*`）；冒烟脚本自己的 `vr-gui-*` / `vr-gc-*` 由脚本清理（我这 4 次的都已不在）。`/tmp` 下另有不少更早的 `vr-gc-*`、`vr-gt-*` 目录不是我建的，没有动。
- 剪贴板：手工复制 / 粘贴测试前读出文本、结束后写回（只能保存和恢复文本内容）；`gui-smoke.mjs` 自己也会写回。
- 留下的证据都在 `gate-c-dm2/`：`logs/`（4 份冒烟日志 + 运行记录）、`shots/`（手工 78 张 + `script/` 下脚本的 37 张）、`scripts-gui/`（手工验证的驱动脚本，不含 token）。
