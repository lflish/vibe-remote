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
