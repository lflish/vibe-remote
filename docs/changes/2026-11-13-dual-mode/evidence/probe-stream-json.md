# 前置验证：daemon 以 stream-json 无头驱动 claude（2026-11-13）

- 环境：本机 macOS，`claude` 2.1.210（`~/.local/bin/claude`），Node 22.22.2
- 驱动：`.devflow-tmp/probe/driver.mjs`（spawn + stdin/stdout NDJSON + 自动应答 control_request）；完整日志 `.devflow-tmp/probe/logs/*.ndjson`（每行 `{_t: ms, _dir: in|out|meta, msg}`）
- 工作目录：`.devflow-tmp/probe/ws/`（已 `git init`）
- 启动时 unset `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT`（嵌套保护）
- 基础命令（全部 V 均用此形状，按需追加参数）：

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --permission-prompt-tool stdio [--strict-mcp-config] \
  [--permission-mode default|plan] [--session-id <uuid>] [--resume <uuid>]
```

## 结果总览

| V | 项目 | 结果 |
|---|------|------|
| V1 | system/init 内容；initialize 是否必需 | ✅ init 字段齐全；**initialize 非必需**（V2–V7 均未发送，全部正常） |
| V2 | 权限往返 allow / deny | ✅ `can_use_tool` 到达，allow 执行、deny 时 claude 收到 is_error tool_result 并放弃 |
| V3 | interrupt | ✅ 立即确认；result `error_during_execution`；进程存活，继续接收新消息 |
| V4 | `--session-id` → 新进程 `--resume` | ✅ 回答 PINEAPPLE；同一 session_id、同一 JSONL 文件续写 |
| V5 | 暂停读 stdout；回合中关 stdin | ✅ 暂停期间进程继续生成，恢复读时积压行一次性涌入；关 stdin 后**跑完当前回合**再 exit 0 |
| V6 | ExitPlanMode / AskUserQuestion | ✅ 两者都以 `can_use_tool` 到达（带 `requires_user_interaction: true`）；答案通过 `updatedInput.answers` 回传 |
| V7 | `set_permission_mode` 中途切换 | ✅ 切到 acceptEdits 后 Write 不再弹 `can_use_tool` |

模型：`--model claude-haiku-4-5-20251001` **flag 被接受**，但本机网关返回
`503 No available channel for model claude-haiku-4-5-20251001`（10 次重试约 3 分钟后才给 result，见 `logs/v12-haiku-503.ndjson`）。
`--model sonnet` 的单次检查 45s 内无输出（判断为同样在重试），已放弃。实际全部用默认模型（init 报 `claude-fable-5-1[1m]`）。
有效模型回合共 12 次（v12×2, v2×2, v3×2, v4×2, v5, v6a, v6b, v7）。为省 token，V2 起加了 `--strict-mcp-config`（不加载 MCP 工具，单回合约 $0.2–0.9）。

---

## V1 — system/init 与 initialize ✅

命令：`node driver.mjs v12`（启动后静默 4s → 发 initialize → 发两条用户消息）。日志 `logs/v12.ndjson`。

**1. 不发任何输入时**：4s 内只出现 4 行 `system/hook_started|hook_progress|hook_response`（本机全局 SessionStart hook，`~/.config/iterm2/cc-status`），**没有 `system/init`**。hook 行已带 `session_id`。

**2. initialize**（spawn 后 4004ms 发送，4ms 后返回）：

```json
→ {"type":"control_request","request_id":"init-1","request":{"subtype":"initialize"}}
← {"type":"control_response","response":{"subtype":"success","request_id":"init-1","response":{
     "commands":[{"name":"baoyu-post-to-wechat","description":"…","argumentHint":""}, …263 项],
     "agents":[{"name":"claude","description":"…"}, …10 项],
     "output_style":"default","available_output_styles":["default", …4 项],
     "models":[{"value":"default","resolvedModel":"claude-opus-4-8[1m]","displayName":"Default (recommended)","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"],…},
               {"value":"opus[1m]",…},{"value":"claude-fable-5-1[1m]",…},{"value":"sonnet",…},{"value":"sonnet[1m]",…},{"value":"haiku","resolvedModel":"claude-haiku-4-5-20251001",…}],
     "account":{"tokenSource":"ANTHROPIC_AUTH_TOKEN","apiProvider":"firstParty"},
     "pid":85071,
     "remote_control_auto_enable":false,"remote_control_auto_on_by_default":false,"ide_rc_auto_enable_gate":false}}}
```

initialize 响应里**没有** CLI 版本号/协议版本。

**3. 不发 initialize**：v2/v3/v4/v5/v6a/v6b/v7 均直接发 `user` 或 `set_permission_mode`，全部正常工作 → initialize 是可选的（只用于拿 commands/models 列表）。

**4. system/init**（在**第一条 user 消息被处理时**才发出，spawn 后约 1.3s〔无 MCP〕/ 4.4s〔有 8 个 MCP〕；**每个回合都重发一次**）：

```json
{"type":"system","subtype":"init","cwd":"/Users/mac/github/vibe-remote/.devflow-tmp/probe/ws",
 "session_id":"940fd4e1-9e04-4044-b807-b3d336dbe928",
 "tools":[…109 项: "Task","AskUserQuestion","Bash",…],
 "mcp_servers":[{"name":"plugin:chrome-devtools-mcp:chrome-devtools","status":"connected"},{"name":"plugin:context7:context7","status":"needs-auth"},…8 项],
 "model":"claude-fable-5-1[1m]","permissionMode":"default",
 "slash_commands":[…263 项],"apiKeySource":"none","claude_code_version":"2.1.210","output_style":"default",
 "agents":[…],"skills":[…231 项],"plugins":[{"name":"chrome-devtools-mcp","path":"…","source":"…"},…],
 "capabilities":["interrupt_receipt_v1","msg_lifecycle_v1"],
 "analytics_disabled":true,"product_feedback_disabled":true,"uuid":"…",
 "memory_paths":{"auto":"/Users/mac/.claude/projects/-Users-mac-github-vibe-remote--devflow-tmp-probe-ws/memory/"},
 "fast_mode_state":"off"}
```

- 版本：`claude_code_version`（字段名确认）；`capabilities` **存在**。
- 其它出现过的 `system` 子类型：`status`（`{"status":"requesting"}` / 模式变化时 `{"status":null,"permissionMode":"…"}`）、`api_retry`（`attempt/max_retries/retry_delay_ms/error_status`）、`thinking_tokens`、`hook_started/hook_progress/hook_response`。

**意外**：v12 第一轮里 `echo PROBE_OK` **没有**触发 `can_use_tool`——只读 Bash 命令在 default 模式下被自动放行。V2 因此改用 `touch …`。

## V2 — 权限往返 ✅

命令：`node driver.mjs v2`，日志 `logs/v2.ndjson`。`--permission-prompt-tool stdio` **被 2.1.210 接受**（`--help` 中不显示，属隐藏参数），无报错。

**allow**：

```json
← {"type":"control_request","request_id":"4a95857b-4585-4064-baec-9fff857e3ac0","request":{
     "subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash",
     "input":{"command":"touch probe_a.txt && echo PROBE_OK","description":"Create probe_a.txt and print PROBE_OK"},
     "description":"Create probe_a.txt and print PROBE_OK",
     "permission_suggestions":[
       {"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch probe_a.txt && echo PROBE_OK"}],"behavior":"allow","destination":"localSettings"},
       {"type":"addDirectories","directories":["/Users/mac/github/vibe-remote/.devflow-tmp/probe/ws"],"destination":"session"},
       {"type":"setMode","mode":"acceptEdits","destination":"session"}],
     "blocked_path":"/Users/mac/github/vibe-remote/.devflow-tmp/probe/ws/probe_a.txt",
     "tool_use_id":"toolu_01QdNVRUVAGkd2ZKQFen4gGS"}}
→ {"type":"control_response","response":{"subtype":"success","request_id":"4a95857b-…","response":{
     "behavior":"allow","updatedInput":{"command":"touch probe_a.txt && echo PROBE_OK","description":"Create probe_a.txt and print PROBE_OK"}}}}
← {"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01Qd…","type":"tool_result","content":"PROBE_OK","is_error":false}]},
   "tool_use_result":{"stdout":"PROBE_OK","stderr":"","interrupted":false,…}, …}
← {"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"Output: `PROBE_OK`","stop_reason":"end_turn",
   "session_id":"657c3a26-…","total_cost_usd":0.8825,"permission_denials":[],"terminal_reason":"completed",…}
```

时序：assistant tool_use（6654ms）→ control_request（7050ms）→ 应答同毫秒 → tool_result（7738ms）。

**deny**（第二回合，同一进程）：

```json
→ {"type":"control_response","response":{"subtype":"success","request_id":"714b1c4e-…","response":{
     "behavior":"deny","message":"User declined: probe says no."}}}
← {"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"User declined: probe says no.","is_error":true,"tool_use_id":"toolu_01Qry…"}]},
   "tool_use_result":"Error: User declined: probe says no.", …}
← {"type":"assistant",…"content":[{"type":"text","text":"I'm not allowed to run that command — the request was declined (\"probe says no\"), so I won't retry."}]}
← {"type":"result","subtype":"success","is_error":false,"result":"I'm not allowed …","total_cost_usd":1.0029,…}
```

deny 的 `message` 原样成为 tool_result 内容；回合正常结束（`subtype: success`），`probe_b.txt` 未创建。
注意：`result.total_cost_usd` 是**进程内累计值**（0.88 → 1.00），不是单回合。

## V3 — interrupt ✅

命令：`node driver.mjs v3`，日志 `logs/v3.ndjson`。首个 `content_block_delta` 后 1.5s 发 interrupt（此时已输出到 96）。

```json
→ {"type":"control_request","request_id":"int-1","request":{"subtype":"interrupt"}}
← {"type":"control_response","response":{"subtype":"success","request_id":"int-1","response":{"still_queued":[]}}}      // +1ms
← {"type":"assistant","message":{…"content":[{"type":"text","text":"1\n2\n…\n96"}]…}}                                     // 已生成的部分被冲刷为完整 assistant
← {"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},…}
← {"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":2,"stop_reason":null,
   "total_cost_usd":0,"modelUsage":{},"permission_denials":[],"terminal_reason":"aborted_streaming",…}                   // +4ms
→ {"type":"user","message":{"role":"user","content":"Reply with exactly: STILL_ALIVE"}}
← {"type":"result","subtype":"success","result":"STILL_ALIVE",…}
```

进程存活，下一条消息正常处理，最后 stdin 关闭后 exit 0。interrupt 应答带 `still_queued`（排队中但未执行的用户消息）。

## V4 — 会话续接 ✅

命令：`node driver.mjs v4`（v4a: `--session-id 3e817b00-067c-4d43-be75-409202cde9e5`；v4b: `--resume 3e817b00-…`），日志 `logs/v4a.ndjson`、`logs/v4b.ndjson`。

```
v4a  init.session_id = 3e817b00-…   result: "OK"           exit 0
v4b  init.session_id = 3e817b00-…   result: "PINEAPPLE"    exit 0     ← 恢复后 session_id 不变（未分叉）
```

JSONL：`~/.claude/projects/-Users-mac-github-vibe-remote--devflow-tmp-probe-ws/3e817b00-067c-4d43-be75-409202cde9e5.jsonl`
（目录名 = cwd 绝对路径把 `/` 和 `.` 换成 `-`）。两个进程**续写同一文件**，共 16 行，行类型依次：
`queue-operation, queue-operation, attachment, user, attachment, attachment, last-prompt, assistant, last-prompt, queue-operation, queue-operation, attachment, user, assistant, last-prompt, mode`。
首行：`{"type":"queue-operation","operation":"enqueue","timestamp":"2026-11-13T09:55:04.381Z","sessionId":"3e817b00-…","content":"Remember the word PINEAPPLE. Reply with just: OK"}`

## V5 — 断开读取 / 回合中关 stdin ✅

命令：`node driver.mjs v5`（数到 600），日志 `logs/v5.ndjson`。

```
 6070 首个 delta 到达 → stdout.pause()
 7084 paused-probe  cpu=0.9% state=S  linesSoFar=9
 8096 paused-probe  cpu=0.7% state=S  linesSoFar=9
 9109 paused-probe  cpu=0.5% state=S  linesSoFar=9
 9109 stdout.resume → 300ms 内涌入 50 行（9110ms 同一时刻收到数字 2…181 的 45 个 delta）
 9410 stdin.end（此时 result 尚未出现）
 9121…15904 后续 delta 以正常 ~65ms 节奏继续到达（182…600）
15918 assistant 完整消息；16446 result subtype=success（600 全部数完）
16907 exit code=0
```

- 暂停读取期间 claude 继续生成（输出积压在管道缓冲区里，恢复读时一次性到达）。CPU 很低是正常的（流式 I/O 等待）。**未测试到管道写满**：3s 的量（约 1KB）远小于管道缓冲区；长时间不读、输出超过约 64KB 时 claude 的 stdout 写会阻塞 → daemon 必须**始终排空 stdout**（写入自己的缓冲区），不能靠"不读"来暂停。
- 回合中关闭 stdin：**不会立即退出**，跑完当前回合、发出 `result`，约 0.46s 后 exit 0。
- 补充（`logs/v12-haiku-503.ndjson`）：第一回合仍在重试时又写入了第二条 user 消息，然后关闭 stdin → claude 在第一条 result 之后**继续执行排队的第二条**（再次发 `system/init`）。即：关闭 stdin = "执行完队列再退出"。要立刻停止必须先 `interrupt`（或 kill）。

## V6 — ExitPlanMode / AskUserQuestion ✅

**V6a** `node driver.mjs v6a`（`--permission-mode plan`），日志 `logs/v6a.ndjson`。
claude 先跑只读 Bash（`ls`，未询问），再 Write 计划文件到 `~/.claude/plans/<slug>.md`（plan 模式下写计划文件**不询问**），然后：

```json
← {"type":"control_request","request_id":"2218c139-…","request":{
     "subtype":"can_use_tool","tool_name":"ExitPlanMode","display_name":"ExitPlanMode",
     "input":{"plan":"# Plan: Add README.md to this repo\n\n## Context\n…","planFilePath":"/Users/mac/.claude/plans/make-a-2-step-plan-peaceful-iverson.md"},
     "tool_use_id":"toolu_014V8JCQHBavaYEStZ4o7uKT","requires_user_interaction":true}}
→ {"type":"control_response","response":{"subtype":"success","request_id":"2218c139-…","response":{"behavior":"allow","updatedInput":{<原 input 原样>}}}}
← {"type":"system","subtype":"status","status":null,"permissionMode":"default",…}        // 批准后模式自动切回 default，并广播
← {"type":"user",…"content":[{"type":"tool_result","content":"User has approved your plan. You can now start coding. …## Approved Plan:\n# Plan: …"}]}
← {"type":"result","subtype":"success","num_turns":4,…}
```

ExitPlanMode **没有** `permission_suggestions` / `description`，但有 `requires_user_interaction: true`。（探针生成的计划文件已删除。）

**V6b** `node driver.mjs v6b`（default 模式），日志 `logs/v6b.ndjson`：

```json
← {"type":"control_request","request_id":"08a1493f-…","request":{
     "subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion",
     "input":{"questions":[{"question":"Do you prefer tea or coffee?","header":"Beverage",
              "options":[{"label":"Tea","description":"You prefer tea."},{"label":"Coffee","description":"You prefer coffee."}],
              "multiSelect":false}]},
     "tool_use_id":"toolu_01Gr2ybL7Jr3wh2qoBfTx43r","requires_user_interaction":true}}
→ {"type":"control_response","response":{"subtype":"success","request_id":"08a1493f-…","response":{
     "behavior":"allow","updatedInput":{"questions":[<原样>],"answers":{"Do you prefer tea or coffee?":"Tea"}}}}}
← {"type":"user",…"content":[{"type":"tool_result","content":"Your questions have been answered: \"Do you prefer tea or coffee?\"=\"Tea\". You can now continue with these answers in mind.","tool_use_id":"toolu_01Gr…"}],
   "tool_use_result":{"questions":[…],"answers":{"Do you prefer tea or coffee?":"Tea"}}}
← {"type":"result","subtype":"success","result":"You chose tea.",…}
```

可用的答案格式：`updatedInput = {...原 input, answers: {<question 原文>: <所选 option 的 label>}}`（multiSelect 的多选格式未测试）。

## V7 — set_permission_mode ✅

命令：`node driver.mjs v7`（`--permission-mode default`，**在第一条 user 消息之前**发送），日志 `logs/v7.ndjson`。

```json
→ {"type":"control_request","request_id":"mode-1","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}
← {"type":"control_response","response":{"subtype":"success","request_id":"mode-1","response":{"mode":"acceptEdits"}}}   // 1084ms（进程仍在启动中；stdin 已被缓冲）
← {"type":"system","subtype":"status","permissionMode":"acceptEdits",…}
← system/init permissionMode="acceptEdits"
← assistant tool_use Write {"file_path":".../ws/note.txt","content":"hello\n"}
← user tool_result "File created successfully at: …/note.txt"      // 中间没有任何 can_use_tool
← result subtype=success "DONE"
```

切到 acceptEdits 后 Write 不再询问。（作为对照，V2 中 default 模式下写文件的 Bash `touch` 是会询问的，并给出 `setMode: acceptEdits` 建议；未单独在 default 模式下测 Write 以节省调用。）

## 未测 / 局限

- 没有测**不加** `--permission-prompt-tool stdio` 的情况（该参数被接受，所以按任务说明没有降级测试；为节省调用也未额外测）。
- 未测 `updatedPermissions`（把 `permission_suggestions` 回传以"始终允许"）——suggestion 的 `destination: "localSettings"` 意味着会写入项目里的 `.claude/settings.local.json`。
- 未测管道写满时的阻塞、未测 multiSelect 问题、未测 resume 一个正被另一进程使用的会话。
- 本机全局 hooks（iTerm2 cc-status）会在流中产生 `system/hook_*` 行，并在非 iTerm 环境下报 "No session is showing that tmux pane"（无害）。远程 Linux 上的 hooks 情况会不同。

## 对 daemon 设计的意义

1. **启动命令**：`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --permission-mode <m> --session-id <uuid>`（新建）/ `--resume <uuid>`（恢复）。由 daemon 生成 uuid v4 传给 `--session-id`，即可在 init 之前就知道 session_id、知道 JSONL 路径（`~/.claude/projects/<cwd 中 / 和 . 换成 ->/<uuid>.jsonl`），恢复时 id 不变。环境中去掉 `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`。
2. **initialize 可选**：不需要握手就能发 user / set_permission_mode。只在需要 slash 命令、模型列表、账号信息时发 `{"type":"control_request","request_id":…,"request":{"subtype":"initialize"}}`。**版本探测**用 `system/init.claude_code_version`（第一回合才出现）或启动前 `claude --version`；功能探测看 `system/init.capabilities`（目前为 `interrupt_receipt_v1`、`msg_lifecycle_v1`）。init 每回合都会重发 → 当成"更新会话元信息"处理，而不是"会话开始"。
3. **必须实现的控制帧形状**（已验证、可直接照抄）：
   - 入站 `control_request.request.subtype = "can_use_tool"`：字段 `tool_name, display_name, input, description?, permission_suggestions?, blocked_path?, tool_use_id, requires_user_interaction?`；顶层有 `request_id`（uuid）。
   - 允许：`{"type":"control_response","response":{"subtype":"success","request_id":ID,"response":{"behavior":"allow","updatedInput":<input>}}}`（`updatedInput` 要带上，原样回传即可）。
   - 拒绝：`…"response":{"behavior":"deny","message":"<原因>"}` → 回合继续，claude 看到一个 is_error 的 tool_result。
   - AskUserQuestion：allow 并带 `updatedInput.answers = {question 原文: option label}`。ExitPlanMode：allow = 批准计划，之后会收到 `system/status.permissionMode`。
   - 出站 `interrupt` → 应答 `{"still_queued":[…]}`；`set_permission_mode` → 应答 `{"mode":…}`。
4. **权限 UI 只针对 `can_use_tool`**：只读工具（`echo`、`ls`、Read）在 default 模式下不会询问；带 `requires_user_interaction: true` 的（AskUserQuestion / ExitPlanMode）应渲染为专门的交互卡片，而不是普通的"允许/拒绝"。
5. **待处理的权限请求会挂住回合**：tool 在 control_response 回来之前不会执行（探针里总是立即应答，**没有测试长时间不应答是否超时**）。daemon 应在客户端断开期间**保存未应答的 can_use_tool**，重连时补发；否则回合会卡住。
6. **中断结果**：`result.subtype = "error_during_execution"`、`is_error: true`、`terminal_reason: "aborted_streaming"`，之前还会有一条带部分文本的 `assistant` 和一条 `user` "[Request interrupted by user]"。UI 应把它显示为"已中断"，而不是报错。进程保持存活。
7. **stdin 关闭 ≠ 停止**：claude 会跑完当前回合以及队列里的消息，然后 exit 0。要"关闭会话"应先 `interrupt`，再关 stdin，超时后再 kill。客户端断开时 daemon 应**保持管道打开并持续读 stdout 到缓冲区**（回合在后台继续完成；不读会在约 64KB 后让 claude 写阻塞）。
8. **回合边界 / 状态**：一个回合以 `result` 结束；`system/status {"status":"requesting"}` 表示正在请求 API；`api_retry` 可用来显示"网关重试中"（haiku 那次 503 重试了约 3 分钟才出 result）。`total_cost_usd` 是进程内累计值。流中有多种未知 `system` 子类型（hook_*、thinking_tokens…）→ 协议层必须容忍并透传/忽略未知类型。
9. **排队**：回合进行中写入新的 user 消息会被排队（JSONL 里有 `queue-operation enqueue/dequeue`），当前回合结束后自动执行。可以利用这一点，不需要 daemon 自己做输入队列；interrupt 应答里的 `still_queued` 会告诉你还有哪些在排队。

---

## 第二批（V9–V23）

同一驱动（`driver.mjs`，新增场景 `v9 v12b v13 v14 v11 v18b v21 v23`），同样 unset `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`，全部带 `--strict-mcp-config`，默认模型。每个场景用独立 cwd（`.devflow-tmp/probe/ws9`、`ws12`…），避免 `.claude/settings.local.json` 互相影响。日志 `logs/<场景>.ndjson`。
模型回合合计 **14**：v13×1、v9×4（含 /compact）、v12b×3（其中 V14 第一次尝试作废，见 V14）、v14×2、v11×2、v18b×1、v23×1；v21 与 v23-parent 不产生模型调用。

| V | 结果 | 一句话 |
|---|------|--------|
| V9 | ✅ | `updatedPermissions`=[addRules, addDirectories] → 规则写进 `<cwd>/.claude/settings.local.json`，同一命令第二次不再询问；只回 `[setMode]` → 立刻 `system/status{permissionMode:"acceptEdits"}` |
| V10 | ✅ | 多选答案用 `"Apple, Banana"`、自填文字用任意字符串都被接受，tool_result 原样复述 |
| V11 | ✅ | deny ExitPlanMode → claude 改计划文件后再次发 ExitPlanMode；期间没有模式变化（仍 plan） |
| V12 | ✅ | 待答时 interrupt → claude **自己**先发 `control_cancel_request`，不需要先回答；回合以 `aborted_tools` 结束，进程存活 |
| V13 | ✅ | 不回答的 `can_use_tool` 挂了 15 分钟（900 s）没有超时、没有任何输出；之后 allow，工具照常执行，回合 success |
| V14 | ✅（有意外） | 回合中写入的第二条消息**会执行**（不被丢弃），但 interrupt 回复的 `still_queued` 是 `[]`，**不列出**它 |
| V18 | ✅ | `init.permissionMode = "bypassPermissions"`；`touch` 不询问；但 AskUserQuestion **仍然**以 `can_use_tool` 到达 |
| V19 | ✅ | 形状 `{"type":"control_cancel_request","request_id":"<被取消的 can_use_tool 的 request_id>"}` |
| V20 | ✅ | `/compact` 作为普通 user 文本即执行（`status:"compacting"` → `compact_boundary` → `result`，`num_turns:0`）；`slash_commands` 无 `login`/`logout`/`theme` |
| V21 | ✅ | `--resume <不存在的 uuid>`：stderr 一行 + stdout 一条 `result{error_during_execution, errors:[…]}`，exit 1，约 1 s |
| V22 | ✅（与设计假设不同） | 两种时机最终都是 `acceptEdits`、Write 不询问；但计划批准后 claude 切回的是**进入 plan 之前的模式**，不一定是 `default` |
| V23 | ✅（安全相关） | `-p` 在**从未信任**的目录里直接加载项目 `.claude/settings.json`，SessionStart 与 PreToolUse hook 都执行，无任何信任提示，也不写信任记录 |

### V13 — 15 分钟后才回答（`logs/v13.ndjson`，cwd `ws13`，后台进程）

```
  5093 ← can_use_tool Bash "touch v13_done.txt && echo V13_OK"
         （之后 900 s 内 claude 没有输出任何一行：没有 keep_alive、没有 control_cancel_request）
905116 → allow（原 input）
905843 ← tool_result "V13_OK"
910207 ← result success, duration_ms 909144, duration_api_ms 7226
910657   exit 0；v13_done.txt 存在
```

### V9 — updatedPermissions 回传（`logs/v9.ndjson`，cwd `ws9`）

```json
→ {"type":"control_response","response":{"subtype":"success","request_id":"5311dad4-…","response":{
     "behavior":"allow","updatedInput":{"command":"touch v9x.txt","description":"Create empty file v9x.txt"},
     "updatedPermissions":[
       {"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch v9x.txt"}],"behavior":"allow","destination":"localSettings"},
       {"type":"addDirectories","directories":[".../ws9"],"destination":"session"}]}}}
```

回合 1 结束后 `ws9/.claude/settings.local.json`（claude 自建目录和文件）：

```json
{ "permissions": { "allow": [ "Bash(touch v9x.txt)" ] } }
```

回合 2 同一条 `touch v9x.txt`：tool_use → tool_result，**没有 `can_use_tool`**（计数仍为 1）。
回合 3 `touch v9y.txt`（新命令，再次询问），只回 setMode：

```json
→ …"response":{"behavior":"allow","updatedInput":{…},"updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}
← {"type":"system","subtype":"status","status":null,"permissionMode":"acceptEdits",…}     // 同一毫秒
```

之后的 `system/init.permissionMode` 为 `acceptEdits`。`addDirectories`（destination `session`）不落盘。

### V10 — 多选 + 自填（`logs/v18b.ndjson`，与 V18 同一回合）

```json
← can_use_tool AskUserQuestion input.questions = [
    {"question":"Which fruits do you like?","header":"Fruits","options":[{"label":"Apple",…},{"label":"Banana",…},{"label":"Cherry",…}],"multiSelect":true},
    {"question":"Favorite color?","header":"Color","options":[{"label":"Red",…},{"label":"Blue",…}],"multiSelect":false}]
→ updatedInput.answers = {"Which fruits do you like?":"Apple, Banana","Favorite color?":"Purple with green stripes"}
← tool_result: "Your questions have been answered: \"Which fruits do you like?\"=\"Apple, Banana\", \"Favorite color?\"=\"Purple with green stripes\". You can now continue with these answers in mind."
← 最终回复: Which fruits do you like? — "Apple, Banana" / Favorite color? — "Purple with green stripes"
```

答案值就是一个字符串，claude 不校验它是否是选项 label。多选用 `", "` 连接，「其他」直接放文字。

### V11 + V22 — 计划拒绝与批准后切模式（`logs/v11.ndjson`，cwd `ws11`，`--permission-mode plan`）

第 1 回合（a.txt）：

```
11401 ← can_use_tool ExitPlanMode #1
11401 → deny "Not yet: the file content must be \"a2\" instead of \"a\". Revise the plan and call ExitPlanMode again."
11403 ← tool_result is_error:true（内容 = deny message）
16761 ← tool_use Edit ~/.claude/plans/<slug>.md         // plan 模式下改计划文件不询问；期间无 system/status
19548 ← can_use_tool ExitPlanMode #2（改过的计划）
19548 → allow；同一 tick 再发 set_permission_mode acceptEdits      ← V22 第一种时机：立刻发
19549 ← control_response {"mode":"acceptEdits"}
19549 ← system/status permissionMode="acceptEdits"
19915 ← tool_result "User has approved your plan…"                // 之后没有再出现切回 default 的 status
22338 ← tool_use Write a.txt（content "a2"）→ 无 can_use_tool，直接写入
25593 ← result success
```

第 2 回合：先 `set_permission_mode plan`（回 `{mode:"plan"}` + status plan），再要 b.txt 的计划；驱动设计为「等到 `status.permissionMode=="default"` 再发 acceptEdits」：

```
34339 ← can_use_tool ExitPlanMode → allow（不立即切）
34340 ← system/status permissionMode="acceptEdits"      ← 自动切回的是进入 plan 前的模式（acceptEdits），不是 default
34777 ← tool_result "User has approved your plan…"
37219 ← Write b.txt → 无 can_use_tool
```

因为 `default` 从未出现，驱动等待的 `set_permission_mode` **一直没有发出**；最终模式仍是 acceptEdits。结论：

- 批准后的自动切换 = 恢复进入 plan 之前的模式（V6a 是 default 只是因为那次从 default 进入）；`system/status` 先于 ExitPlanMode 的 `tool_result`（与 V6a 一致）。
- 批准后立刻发 `set_permission_mode`：没有被覆盖（claude 根本没有再发切换），最终 acceptEdits。
- 设计里「等 claude 自己切回 **default** 之后再发」会在「从非 default 进入 plan」时永远等不到 → 应改为等**批准后的第一条 `system/status`（任意 permissionMode）或 ExitPlanMode 的 tool_result**，或者直接立刻发。

### V12 + V19 — 待答时 interrupt（`logs/v12b.ndjson`，cwd `ws12`）

```
5652 ← control_request can_use_tool (request_id 211c6da5-1c36-49ed-9b57-b91624feacec)   // 不回答
7652 → {"type":"control_request","request_id":"int-12","request":{"subtype":"interrupt"}}
7653 ← {"type":"control_cancel_request","request_id":"211c6da5-1c36-49ed-9b57-b91624feacec"}
7653 ← {"type":"control_response","response":{"subtype":"success","request_id":"int-12","response":{"still_queued":[]}}}
7654 ← user tool_result is_error:true "The user doesn't want to proceed with this tool use. The tool use was rejected … STOP what you are doing and wait for the user to tell you how to proceed."
7655 ← user text "[Request interrupted by user for tool use]"
7655 ← result {"subtype":"error_during_execution","is_error":true,"stop_reason":"tool_use","terminal_reason":"aborted_tools",
               "permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_01US…","tool_input":{…}}],…}
8756   进程存活，下一条消息正常执行
```

- 不需要先回答；cancel 在 interrupt 应答**之前**发出（同一毫秒）。
- 与普通流式中断不同：文本是 `[Request interrupted by user for tool use]`，`terminal_reason:"aborted_tools"`，被取消的工具出现在 `permission_denials` 里。
- 工具执行**进行中**（不是等权限）的 interrupt 也一样是 `aborted_tools` + 拒绝文本 tool_result（V14 日志，`sleep 25` 被打断）。

### V14 — 排队消息与 interrupt（`logs/v14.ndjson`，cwd `ws14`）

第一次尝试（v12b 后半）作废：数数回合太快，第二条消息写入时第一回合已结束，被中断的是第二条本身。重做：

```
4567 ← tool_use Bash "sleep 25 && echo SLEPT"            // sleep 被视为只读，未询问
6068 → user "Reply with exactly: QUEUED_RAN"              // 工具执行中写入
7575 → interrupt
7599 ← control_response {"still_queued":[]}               // ← 空，没有列出排队的消息
7607 ← tool_result is_error "The user doesn't want to proceed…"; 7608 user "[Request interrupted by user for tool use]"
7609 ← result#1 error_during_execution / aborted_tools
7999 ← system/init（新回合）
9404 ← assistant "QUEUED_RAN"; 9809 ← result#2 success "QUEUED_RAN"
```

JSONL 里对应 `queue-operation enqueue`（15:11:42.173，"Reply with exactly: QUEUED_RAN"）→ 中断 → `dequeue`（15:11:43.711）→ user → assistant。
结论：排队的消息**不会被 interrupt 丢弃**，会在中断后作为下一个回合执行；`still_queued` 不能用来统计 stdin 排队的用户消息（本例为空）。

### V18 — `--dangerously-skip-permissions`（`logs/v18b.ndjson`，cwd `ws18`）

```
2178 ← system/init permissionMode="bypassPermissions"
5973 ← tool_use Bash "touch v18.txt && echo V18" → 6993 tool_result "V18"      // 无 can_use_tool
10702 ← control_request can_use_tool AskUserQuestion … "requires_user_interaction":true   // 仍然询问
```

### V20 — `/compact`（`logs/v9.ndjson` 第 4 回合）

```json
→ {"type":"user","message":{"role":"user","content":"/compact"}}
← {"type":"system","subtype":"status","status":"compacting",…}                           // 立即
← {"type":"system","subtype":"status","status":null,"compact_result":"success",…}         // +18.9 s
← {"type":"system","subtype":"init",…,"permissionMode":"acceptEdits"}
← {"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual","pre_tokens":56462,"post_tokens":1575,…}}
← {"type":"user","message":{"role":"user","content":"This session is being continued from a previous conversation … Summary: …"}}   // content 是字符串
← {"type":"user","message":{"role":"user","content":"<local-command-stdout>Compacted </local-command-stdout>"}}
← {"type":"result","subtype":"success","num_turns":0,"result":"",…}
```

注意：这里 claude **会**输出 `content` 为字符串的 user 消息（摘要、`<local-command-stdout>`），与 V8「只有 tool_result 与中断标记」不同——客户端渲染时要识别这两种（摘要可折叠显示，local-command-stdout 当作命令输出）。
`slash_commands`（v2 日志，263 项）包含 `clear compact config context init model review`，**不含** `login`、`logout`、`theme`。

### V21 — resume 不存在的会话（`logs/v21.ndjson`）

```
 572 stderr: "No conversation found with session ID: 8e71ce56-bbbc-4c8b-bd90-921c49276c62\n"
 573 stdout: {"type":"result","subtype":"error_during_execution","duration_ms":0,"is_error":true,"num_turns":0,
              "session_id":"8e71ce56-…","total_cost_usd":0,"permission_denials":[],
              "errors":["No conversation found with session ID: 8e71ce56-bbbc-4c8b-bd90-921c49276c62"]}
 974 exit code=1
```

没有发送任何 stdin 也会这样（无模型调用）；之前没有 `system/init`。假 claude 除了 stderr 那行，还应输出这条 `result`。

### V23 — 未信任目录与项目 hooks（`logs/v23-untrusted.ndjson`、`logs/v23-parent.ndjson`）

准备：`CLAUDE_CONFIG_DIR=.devflow-tmp/probe/v23/cfg-*`，其中 `.claude.json` 是 `~/.claude.json` 去掉 `projects`（和 `mcpServers`）的拷贝；认证走环境变量 `ANTHROPIC_AUTH_TOKEN`，所以不需要 credentials。目录 `v23/untrusted`（自己 `git init`）里放 `.claude/settings.json`：SessionStart 与 PreToolUse(Bash) hook 各 `touch "$CLAUDE_PROJECT_DIR/<标记>"`。

```
 405 ← system/hook_started SessionStart:startup          // 未发任何输入就执行了
 425 ← system/hook_response exit_code 0 outcome success
3004   SESSIONSTART_RAN 已存在
5826 ← tool_use Bash "ls" → tool_result "PRETOOLUSE_RAN\nSESSIONSTART_RAN"
8015   退出后：SessionStart=true PreToolUse=true
```

- 没有任何信任提示或报错；跑完后 `cfg-untrusted/.claude.json` 里 `projects` 仍为 null（`-p` 不写信任记录）。
- 父目录信任变体（`projects["…/v23/parent"].hasTrustDialogAccepted=true`，在 `parent/child`（自己 `git init`）里启动，不发消息）：SessionStart 同样执行。由于未信任目录本来就会加载，这个变体**区分不出**父目录信任是否会被子目录继承；`-p` 下信任状态对 hooks 加载没有影响。
- 关闭 stdin 且从未发消息 → 不调用模型，exit 0（可用来零成本触发 SessionStart）。

### 第二批对设计的影响

1. **R5.4 成立**：待答的 `can_use_tool` 不会超时（15 分钟实测），daemon 保存待答请求、重连补发的方案可行；期间 claude 不发任何保活行，daemon 的回合看门狗不能把「有待答请求」判为卡死。
2. **interrupt 时不必先 deny**：claude 自己发 `control_cancel_request{request_id}` 并结束回合（`aborted_tools`），daemon 收到 cancel 后对该请求记 `vr_resolved cancelled/interrupted` 即可。普通中断与「工具中」中断的文本、`terminal_reason` 不同（`aborted_streaming` vs `aborted_tools`），UI 都显示为「已中断」。
3. **`still_queued` 不可靠**：stdin 写入的排队消息不出现在里面，但会在中断后照常执行 → `outstanding` 不应按 `still_queued` 扣减；排队消息一律视为「仍会执行」，靠后续 `result` 配对。
4. **计划批准后的切模式**：claude 恢复的是「进入 plan 前的模式」，不一定是 `default`；立刻发 `set_permission_mode` 未被覆盖。6.7 的「等 status=default」需改为「等批准后的第一条 `system/status`（任意值）或 ExitPlanMode 的 tool_result，再发」，或直接立刻发。
5. **`updatedPermissions` 可用**：addRules 会写 `<cwd>/.claude/settings.local.json`（在用户项目里留下文件，UI 应说明「始终允许」会写入该文件）；setMode 建议立刻切模式并广播 status。
6. **`--dangerously-skip-permissions`**：`permissionMode:"bypassPermissions"`，普通工具不再询问，但 AskUserQuestion 仍然走 `can_use_tool` → 对话 UI 在 bypass 模式下也必须能显示问答卡片。
7. **AskUserQuestion 答案**：值是自由字符串；多选用 `", "` 连接 label，「其他」直接填文字，claude 都原样接受。
8. **slash 命令**：`/compact` 作为文本即可执行，会产生 `status:compacting`、`compact_boundary`、两条 **content 为字符串**的 user 消息（摘要、`<local-command-stdout>`）和 `num_turns:0` 的 result —— 客户端渲染器要处理字符串 content 的 user 消息。`slash_commands` 本身已不含 login/logout/theme。
9. **`--resume` 不存在的 id**：exit 1，stderr 一行 + stdout 一条 `result{error_during_execution, errors:[…]}`，约 1 s；假 claude 应同时输出这条 result。
10. **工作区信任（c3）**：`-p` 完全不看信任状态，未信任目录里的项目 hooks（SessionStart 在启动时、无需任何输入即执行）和 settings 都会加载，也不写信任记录。daemon 若要保护用户，只能自己做信任检查（c3 默认方案成立）；「父目录信任是否继承」在 `-p` 下无从观察。
