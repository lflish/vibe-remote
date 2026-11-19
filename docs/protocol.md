# vibe-remote 通信协议

## 概述

vibe-remote 使用 **JSON 分帧 WebSocket** 实现桌面客户端与远程 `vibe-remoted` 之间的双向通信。
每条 WebSocket 消息是一个 JSON 对象，以 `type` 字段区分消息类型。
PTY 字节数据使用 base64 编码传输（`data` 帧）。

连接地址：`ws://<host-ip>:<port>/ws`（`<host-ip>` 为服务端所绑私有网段地址，如 tailscale IP 或 LAN IP）

## 协议版本

当前协议版本为 **4**。服务端在 `ready` 帧和 `/api/v1/info` 中以 `proto` 字段报告；早于此字段的 daemon 不返回 `proto`，客户端按 `1` 处理。

| 版本 | 变化 |
|------|------|
| 1 | 初始版本（隐式） |
| 2 | `attach.newSessionId`（新建会话幂等）、`error.code` / `error.fatal`、`proto` 字段本身、服务端 WebSocket 心跳 |
| 3 | 对话界面：`attach.ui` / `epoch` / `since` / `handoffFrom`，`chat` / `chat_sync` / `chat_state` / `chat_ack`（含 send 的 `duplicate` / `completed`）/ `chat_send` / `chat_respond` / `chat_interrupt` / `chat_set_mode` 帧，`ready.ui` / `claudeSessionId` / `existing` / `handoffFrom`，`sessions[].ui` / `state` / `activitySeq` / `epoch` / `endReason`，`/api/v1/info.chat`（含 `?recheck=1`），`/api/v1/fs` 的 `chatTrust`，对话会话 reload 返回 202，错误码 `ui_mismatch` / `chat_unsupported` / `claude_session_busy` / `shutting_down`。终端会话的 `ready` / `sessions` / `data` / `exit` / `error` 帧除 `proto` 值外与 v2 逐字节相同 |
| 4 | `attach.worktreeName`，`GET /api/v1/projects`，`POST /api/v1/projects/remove`，`GET /api/v1/worktrees/plan`，`GET /api/v1/worktrees/status`，`POST /api/v1/worktrees/remove`，`DELETE /api/v1/sessions/{id}` 不再清理 worktree（不再返回 409 `worktree_preserved`），`/api/v1/fs.chatTrust` 的 worktree 规则（主目录被信任的 worktree 根也是 `trusted`，新建对话会话的 attach 同样放行），错误码 `invalid_worktree_name` / `worktree_branch_exists` / `worktree_path_exists` / `worktree_path_not_allowed`。所有 S→C 帧的字段与 v3 相同 |

兼容规则：新增字段在接收端一律可选；未知帧类型、未知 `notify.kind`、未知 `error.code` 均忽略（未知 code 只按 `fatal` 处理）。客户端发现 `proto` 低于自身版本时应提示用户更新 daemon——旧 daemon 会接受请求但**静默忽略**不认识的字段。

### 版本互连

桌面端和 daemon 可以各自升级，相邻的两个版本（3 和 4）互连时降级工作，不报错。

**协议 4 的桌面端 + 协议 3 的 daemon**

桌面端怎么认出旧 daemon：每轮轮询请求 `GET /api/v1/projects`，旧 daemon 没有这个路径，返回 404；新建会话的对话框另看 `/api/v1/info.proto`。daemon 原地升级或降级后，下一轮轮询就会发现，不需要重连。请求失败（断网、超时、5xx）不算旧 daemon：保持上一轮的判断。

| 功能 | 协议 3 的 daemon 上怎么表现 |
|------|------------------------------|
| 侧边栏分组 | 没有项目树，改用 `sessions[]` 自带的字段分组：`mode:"worktree"` 的会话归到项目 `sourceRepo` 下的 worktree `worktreeRoot`（显示 `branch`）；其余会话，工作目录在某个 `worktreeRoot` 之下的归到那个 worktree，等于某个 `sourceRepo` 或在它之下的归到该项目的主目录一行，都不是的按工作目录各成一个项目。结果不依赖 `sessions[]` 的先后（旧 daemon 每次返回的顺序不同）。没有会话的 worktree 无从得知，不显示；主目录一行没有分支名 |
| 新建命名 worktree、删除 worktree | 入口置灰，提示升级 vibe-remoted；桌面端不向旧 daemon 发 `attach.worktreeName`（会被静默忽略，建出自动命名的 worktree），也不请求 `/api/v1/worktrees/*` |
| 目录选择器的 Worktree 模式 | 没有名字输入框；attach 只带 `mode:"worktree"`，分支和目录由 daemon 自动命名（`vibe/<会话id>`） |
| 删除 worktree 模式的会话 | daemon 会在工作区干净时一并删除 worktree 和分支，否则保留并返回 409 `worktree_preserved`（会话已关闭）。桌面端在确认框里如实写明，并照常处理这个 409 |
| 对话界面 | 照常可用（它是协议 3 的功能）；`chatTrust` 是旧规则：只看目录本身的信任记录，不认「主目录已被信任的 worktree 根」 |
| 其余（新建、接入、输入、重命名、重载、交接、通知、重连） | 与协议 3 的桌面端相同 |

桌面端在目录选择器里和收到 `proto` 较低的 `ready` 之后各提示一次「daemon 的协议版本低于桌面端」。

**协议 3 的桌面端 + 协议 4 的 daemon**

协议 4 没有改动任何已有的帧：S→C 帧的字段与协议 3 相同（终端会话的帧除 `proto` 的值外逐字节相同），`attach` 只多了一个可缺省的字段，原有 REST 端点的请求和成功响应不变。旧桌面端不知道新端点，也不需要它们。

| 旧桌面端的操作 | 协议 4 的 daemon 上的结果 |
|----------------|----------------------------|
| 新建、接入、输入、重命名、重载 | 不变 |
| 用 Worktree 模式新建（attach 没有 `worktreeName`） | 照常成功，分支仍是 `vibe/<会话id>`，目录仍是 `<根目录名>-worktrees/<会话id>` |
| 删除会话 | 一律 204，不再返回 409 `worktree_preserved`。**行为变了**：worktree 的目录和分支都保留（旧 daemon 会在工作区干净时一并删除）。留下的 worktree 旧桌面端看不到，可以用协议 4 的桌面端或手动 `git worktree remove` 清理 |
| 在某个目录新建对话会话 | 多放行一种目录：主目录已被 claude 信任的 worktree 根（`chatTrust` 和 attach 用同一条规则） |

旧桌面端看到 `proto: 4` 高于自身版本时不提示（它只在对方更旧时提示）。

## 连接生命周期

```
Client                              Server (vibe-remoted)
  |                                    |
  |--- WebSocket connect ------------->|
  |                                    |
  |--- auth {token} ------------------>|  (必须是首帧，10s 超时)
  |                                    |
  |--- attach {sessionId?,cols,rows} ->|  (sessionId 空=新建)
  |                                    |
  |<-- ready {sessionId,workdir,mode,...} -|  (确认；worktree 元数据按需返回)
  |                                    |
  |<-- data {payload:base64} ----------|  (PTY 输出，流式)
  |--- data {payload:base64} --------->|  (键盘输入)
  |--- resize {cols,rows} ------------>|  (终端尺寸变化)
  |--- ping -------------------------->|
  |<-- pong ---------------------------|
  |                                    |
  |<-- exit {code} --------------------|  (会话进程退出)
  |--- [close] ----------------------->|  (客户端断开，PTY detach，tmux 存活)
```

## 帧类型

### auth (C→S)

首帧，必须在连接后 10 秒内发送。

```json
{"type": "auth", "token": "your-static-token"}
```

### attach (C→S)

请求打开或恢复会话。

```json
{
  "type": "attach",
  "sessionId": "1720000000000",
  "cols": 120,
  "rows": 40
}
```

新建会话：

```json
{
  "type": "attach",
  "newSessionId": "1720000000000-9f3a1c2e",
  "cols": 120,
  "rows": 40,
  "workdir": "/home/user/project",
  "flags": ["continue", "skip-perms"],
  "mode": "worktree"
}
```

- `sessionId` 非空：恢复已有会话（断线重连）。其余新建字段被忽略
- `sessionId` 为空字符串或省略：创建新会话
- `newSessionId`：可选，仅新建时有效（v2）。客户端为新会话预先生成的 id，使新建**幂等**：attach 发出后、`ready` 返回前断线时，客户端用**同一个** `newSessionId` 重放 attach，服务端发现该 id 的会话已存在（或仍在创建中）就直接接入它，而不是再建一个——否则 worktree 模式下会留下孤儿 worktree 和分支。必须匹配 `^[A-Za-z0-9_-]{1,64}$`，否则返回 `invalid_session_id`。省略时由服务端生成 id（旧客户端）
- `workdir`：仅新建时有效，指定 claude 工作目录。省略则用服务端默认值
- `flags`：可选，仅新建会话有效。客户端勾选的 claude 启动 flag id 列表；服务端按 `claude_flags` 白名单查表，把对应参数拼到 `claude_cmd` 后（未知 id 忽略）
- `mode`：可选，仅新建会话有效。`normal` 表示直接使用 `workdir`，`worktree` 表示服务端从所选目录所在 Git 仓库创建隔离 Worktree。省略或空值时按 `normal` 处理，以兼容旧客户端
- `ui`（v3）：`"terminal"` 或 `"chat"`，省略 = `terminal`（旧客户端）。新建时决定会话类型；接入已有会话时必须与会话类型一致，否则返回 `ui_mismatch`。客户端在 `ready` 之后的自动重连与手动重试里继续带上 `ui:"chat"`
- `epoch` / `since`（v3）：仅 `ui:"chat"` 接入已有会话。客户端上次**完整收到**的位置（某个 epoch 的同步结束标志 `chat_state` 之后才有资格报告），在每次发送 attach 的那一刻读取。两者都给出、`epoch` 等于当前 epoch、且 `since` ≥ 缓冲区最早 `seq`−1 时走增量补发，否则走整体重同步（`reset`）
- `handoffFrom`（v3）：仅新建且 `ui:"terminal"`。要交接的对话会话 id：daemon 停掉该对话进程，再新建一个终端会话以 `--resume <claude 会话 id>`（无对话记录时 `--session-id`）接上。此时 `workdir`/`flags`/`mode` 被忽略，全部取自对话会话。只属于创建意图，`ready` 之后的重放只用 `sessionId`
- `worktreeName`（v4）：可选，仅新建且 `mode:"worktree"` 时有效，其余情况忽略（含带 `handoffFrom` 时）。非空：新分支名就是它，基于 `workdir` 当前的 HEAD（不含未提交的改动），目录是 `<项目主目录的父目录>/<主目录名>-worktrees/<名字，/ 换成 ->`。空或省略：v3 的行为，分支 `vibe/<会话 id>`，目录 `<workdir 所在 worktree 根的父目录>/<根目录名>-worktrees/<会话 id>`。名字的规则：非空；不含空白和控制字符；不含 `..`；不以 `-` 开头；不含 `@{`；不含不显示的格式字符（Unicode 的 Cf 类，如零宽空格 U+200B、方向控制 U+202E、U+FEFF）和行 / 段分隔符（Zl、Zp）；UTF-8 编码不超过 250 字节；并且 `git check-ref-format --branch <名字>` 接受它、输出与输入逐字相等。不满足 → `invalid_worktree_name`。`ready` 之前的重放要带同一个 `newSessionId` 和同一个 `worktreeName`；`ready` 之后的重放只用 `sessionId`。`ready` / `sessions` 没有新字段：命名 worktree 的会话用已有的 `mode` / `sourceWorkdir` / `sourceRepo` / `worktreeRoot` / `branch`，`branch` 的值就是名字。v3 的 daemon 会静默忽略这个字段（建出 `vibe/<会话 id>`），客户端要先看 `proto`

客户端可能夹带的其它字段（如 `command`、`args`）一律忽略：启动命令只由服务端配置拼成。

幂等重放时，若会话已存在，第二次 attach 的 `workdir`/`flags`/`mode` 被忽略，以首次创建为准。

### ready (S→C)

确认 attach 成功。

```json
{
  "type": "ready",
  "sessionId": "1720000000000",
  "workdir": "/home/user/project-worktrees/1720000000000/subdir",
  "proto": 4,
  "mode": "worktree",
  "sourceWorkdir": "/home/user/project/subdir",
  "sourceRepo": "/home/user/project",
  "worktreeRoot": "/home/user/project-worktrees/1720000000000",
  "branch": "vibe/1720000000000"
}
```

`proto` 是服务端协议版本（见「协议版本」），旧 daemon 不返回。`mode` 始终由服务端返回权威值。`normal` 会话只需返回 `mode: "normal"`；`worktree` 会话还返回：

- `sourceWorkdir`：用户选择的原始目录
- `sourceRepo`：原始 Git 仓库根目录
- `worktreeRoot`：该会话创建的 Worktree 根目录
- `branch`：该 Worktree 使用的分支

v3 对话会话另带（终端会话一律省略，因此终端 `ready` 与 v2 逐字节相同）：

- `ui`：`"chat"`
- `claudeSessionId`：该会话对应的 claude 会话 UUID（JSONL 文件名）
- `existing`：仅当新建请求被转为接入另一个已有会话时为 `true`（勾 `-c` 指向的 claude 会话已在会话 X 里运行，`sessionId` 返回 X）
- `handoffFrom`：终端会话由交接创建时回显原对话会话 id

对话会话的 `ready` 之后紧跟对话同步序列（见「对话界面」）。

### data (双向)

PTY 字节流，base64 编码。

```json
{"type": "data", "payload": "SGVsbG8gV29ybGQ="}
```

- C→S：键盘输入（包括 Ctrl+C = `\x03`）
- S→C：PTY 输出（终端转义序列、颜色等全部透传）

### resize (C→S)

客户端终端尺寸变化。

```json
{"type": "resize", "cols": 150, "rows": 50}
```

### sessions (S→C)

会话列表推送。

```json
{
  "type": "sessions",
  "list": [
    {
      "id": "1720000000000",
      "title": "project",
      "workdir": "/home/user/project-worktrees/1720000000000/subdir",
      "created": "2024-07-01T12:00:00Z",
      "mode": "worktree",
      "sourceWorkdir": "/home/user/project/subdir",
      "sourceRepo": "/home/user/project",
      "worktreeRoot": "/home/user/project-worktrees/1720000000000",
      "branch": "vibe/1720000000000"
    }
  ]
}
```

v3 对话会话的条目另带（终端条目一律省略）：

| 字段 | 说明 |
|------|------|
| `ui` | `"chat"` |
| `state` | 同 `chat_state.status`：`idle` / `running` / `waiting` / `ended` |
| `activitySeq` | 当前 epoch 的最大 `seq`；与 `epoch` 一起比较，变化 = 有新消息 |
| `epoch` | 当前 epoch |
| `endReason` | 已结束时的原因（同 `chat_state.ended.reason`） |

`title` 规则与终端一致（自定义名 → workdir 末段 → id）。

### ping / pong (双向)

保活。客户端每 25 秒发 ping，服务端回 pong。

```json
{"type": "ping"}
{"type": "pong"}
```

**存活检测**（v2）。半开连接（合盖、切网络、NAT 超时）不会触发任何关闭事件，因此两端都主动判死：

- 服务端：attach 之前，连续 90 秒收不到任何帧即断开；relay 阶段每 30 秒发一次 **WebSocket 协议层** ping（不是上面的 JSON ping——空闲终端可能长时间没有任何 JSON 帧），20 秒内无 pong 即断开。断开只 detach PTY，tmux 会话照常存活。
- 客户端：任何收到的帧都算存活证明。连续两次 ping 之间**一个帧都没收到**（即连续 2 个 ping 无回应）就判定连接已死，主动关闭并进入重连。按「未回应的 ping 数」而非「静默秒数」计算是刻意的：窗口隐藏/最小化时 Chromium 把定时器节流到约每分钟一次，ping 本身就会间隔 60 秒，固定的静默超时会把健康的后台会话反复断开。

### exit (S→C)

会话进程退出。

```json
{"type": "exit", "code": 0}
```

### error (S→C)

错误通知。服务端发出后通常紧接着关闭连接。

```json
{"type": "error", "message": "attach session: session \"1720000000000\" not found", "code": "session_not_found", "fatal": true}
```

- `message`：给人看的描述
- `code`（v2）：稳定的机器可读原因，开放集合
- `fatal`（v2）：`true` 表示原样重试不可能成功，客户端必须**停止重连**并丢弃待重放的 attach；缺省/`false` 表示可能是暂时故障，客户端照常退避重连。旧 daemon 不带此字段，客户端按非 fatal 处理

| code | fatal | 含义 |
|------|-------|------|
| `auth_failed` | ✓ | token 错误，或首帧不是 auth |
| `auth_timeout` | | 10 秒内未收到 auth 帧 |
| `invalid_workdir` | ✓ | workdir 不在 `allowed_roots` 内 |
| `invalid_mode` | ✓ | 未知的 `mode` |
| `invalid_session_id` | ✓ | `newSessionId` 格式非法 |
| `create_failed` | ✓ | 新建失败（如 worktree 模式选了非 Git 目录；git 执行失败，`message` 含 git 的错误输出；带 `worktreeName` 而仓库是子模块或用了独立的 git 目录；worktree 模式的发起处还没有任何提交；v4：工作目录所在的 worktree 正在被删除，或工作目录已不存在） |
| `session_not_found` | ✓ | 要恢复的会话已不存在（被删除、tmux 被杀，或 daemon 未启用 tmux） |
| `attach_failed` | | 会话存在但接入失败（PTY/tmux 暂时故障） |
| `ui_mismatch` | ✓ | v3：接入的会话类型与 `attach.ui` 不符（含旧桌面接入对话会话）；`attach.ui` 不是 `terminal` / `chat`；交接（`handoffFrom`）却带 `ui:"chat"` |
| `chat_unsupported` | ✓ | v3：新建对话但不可用；`message` 含原因（取值同 `/api/v1/info` 的 `chat.reason`，另有 `workdir_untrusted`） |
| `claude_session_busy` | ✓ | v3：要启动的 claude 会话正在另一个会话里运行（对话 `-c`、交接、重启，或终端会话带 continue 时被运行中的对话会话占用）；`message` 写明持有者会话名 |
| `shutting_down` | | v3：daemon 正在退出，不再新建对话会话；客户端保留 attach（同一个 `newSessionId`）退避重连，daemon 重启后照常新建 |
| `invalid_worktree_name` | ✓ | v4：`worktreeName` 不满足名字的规则 |
| `worktree_branch_exists` | ✓ | v4：仓库已有同名本地分支，或名字与已有分支不能并存（已有 `fix` 时建 `fix/login`，已有 `change/foo` 时建 `change`）；`message` 写明与哪个分支冲突 |
| `worktree_path_exists` | ✓ | v4：新 worktree 的目标目录已存在（空目录也算） |
| `worktree_path_not_allowed` | ✓ | v4：目标目录不在 `allowed_roots` 内；或 worktree 建好之后，会话实际的工作目录（`workdir` 是仓库子目录时映射到新 worktree 里的那个）解析符号链接后不在 `allowed_roots` 内。`message` 含完整路径。不带 `worktreeName` 的 worktree 模式遇到这种情况同样返回这个代码（v3 是 `create_failed`） |

以上四个 v4 的错误发生时，daemon 不留下这次创建的目录和分支。

对话会话运行中的失败（版本过旧、进程崩溃、重启失败）不走 `error` 帧，而是 `chat_state.ended` + `vr_exit` 消息 + `exit` 帧，连接保持，客户端不重连。

### notify (S→C)

带外会话事件（如 claude hook 经 events 端点上报）。`kind` 为开放枚举，客户端忽略不认识的 kind。

```json
{"type": "notify", "sessionId": "1720000000000", "kind": "waiting", "message": "需要确认权限"}
```

- `kind: "idle"`：claude 完成一次响应（Stop hook）
- `kind: "waiting"`：claude 需要权限确认/等待输入（Notification hook）

## 对话界面（v3）

对话会话（`ui:"chat"`）由 daemon 以 `claude -p --input-format stream-json --output-format stream-json` 无头驱动，**只支持 claude**。daemon 只解析每行 stream-json 的信封字段，消息体原样放进 `chat` 帧；终端会话的纯字节透传不受影响。以下帧只出现在 `ready.ui == "chat"` 的连接上。

### 同步序列（S→C）

`ready` 之后、以及进程被重载/重启（epoch 变化）时，daemon 依次发：

1. `chat_sync`

   ```json
   {"type":"chat_sync","epoch":"a1b2c3d4","reset":true,"omitted":0,"historyCount":3120,"backlog":57}
   ```

   - `epoch`：本进程的随机标识；进程重载/重启后变化
   - `reset`：`true` = 客户端清空对话区按本次内容重建；`false` = 增量，保留已有内容
   - `omitted`：本 epoch 内因缓冲（1000 条 / 32 MiB）淘汰的完整消息数（`reset` 时有意义）
   - `historyCount`：随后发送的 JSONL 历史**完整**条数（不截断；`reset` 时才有）
   - `backlog`：随后发送的缓冲消息条数（增量时即「已补回 N 条」）
2. `historyCount` 条 `chat` 帧，`seq: 0`、`h: true`，从旧到新（每 200 帧一批流式发送）
3. `backlog` 条 `chat` 帧（`seq > since` 的完整消息与当前回复的流式尾巴，按 `seq` 升序）
4. 一条 `chat_state`（同步结束标志）。客户端只有收到当前 epoch 的这条之后，下次 attach 才可报告 `epoch`/`since`

### chat (S→C)

```json
{"type":"chat","seq":1043,"msg":{ …claude stdout 的一行原样，或 daemon 合成的消息… }}
```

- `seq`：本 epoch 内单调递增，所有出站消息（含 `stream_event`）都占号；历史帧为 `0` 并带 `"h":true`。客户端丢弃 `seq ≤ 已见最大 seq` 的帧（历史帧除外）
- `msg` 来自 claude 时原样转发：`system`（`init` 每回合重发，只当元信息更新；`status`、`api_retry`、`compact_boundary`、`hook_*` 及未知子类型）、`assistant`、`user`（tool_result；中断标记文本；`/compact` 产生的 content 为字符串的 user 消息）、`stream_event`、`result`、`control_request`（`can_use_tool`）、`control_cancel_request`。`keep_alive` 与 daemon 自己发出的控制请求的 `control_response` 不转发。看门狗之后迟到的 `result` 顶层加 `"vr_stale": true`
- daemon 合成的消息：

| `msg.type` | 字段 | 含义 |
|------------|------|------|
| `user`（回显） | `message:{role:"user",content:[{type:"text",text}]}`, `vr_client_msg_id` | daemon 写入 stdin 的用户消息，供所有连接的桌面显示（claude 不回显） |
| `vr_resolved` | `request_id`, `outcome`: `allowed` / `denied` / `cancelled` / `interrupted` / `exited` | 某个待答请求被解决 |
| `vr_notice` | `code`: `line_dropped` / `stale_turn` / `set_mode_failed` / `dropped_on_stop`（开放集合；`stderr` 保留，当前不发送，stderr 尾巴在 `vr_exit` 里）, `text`, `clientMsgId?` | 超长行被丢弃（>16 MiB）、回合看门狗判定某条消息不会再有 `result`、计划批准后的模式切换未能入队、停进程时某条已写入的消息没有执行完 |
| `vr_exit` | `code`, `reason`, `stderrTail` | 进程结束（带 stderr 最后 8 KiB） |

### chat_state (S→C)

任何字段变化都向全部连接广播一次完整状态（不入缓冲），也是同步序列的结束标志。

```json
{"type":"chat_state","status":"waiting","permissionMode":"default","permissionLocked":false,
 "pending":[{"requestId":"r-17","seq":1040,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"npm test"},"permission_suggestions":[],"tool_use_id":"toolu_…"}}],
 "slashCommands":[{"name":"compact","description":"…"}],"claudeVersion":"2.1.210","claudeSessionId":"0b6c…",
 "ended":null}
```

| 字段 | 说明 |
|------|------|
| `status` | `idle` / `running` / `waiting`（有待答请求）/ `ended` |
| `permissionMode` | `default` / `acceptEdits` / `plan` / `bypassPermissions`，以 claude 报告为准 |
| `permissionLocked` | 启动参数含 `--dangerously-skip-permissions` 或 `--permission-mode bypassPermissions`；此时 `chat_set_mode` 返回 `mode_locked`；回答非计划请求时带 `setMode` 也返回 `mode_locked`，回答计划（`ExitPlanMode`）时 `setMode` 被静默忽略、回答照常转给 claude。AskUserQuestion / ExitPlanMode 仍会作为待答请求出现（桌面端对锁定会话的计划卡片只给「批准」一个不切模式的选项 + 继续完善） |
| `pending` | **权威**的待答请求列表 `[{requestId, seq, request}]`（`request` 为 claude 的 `can_use_tool` 请求原样），不受缓冲淘汰影响；客户端的提示只按它显示 |
| `degraded` | 可选；缺少的 claude 能力（目前只有 `interrupt_receipt`），仅用于诊断 |
| `slashCommands` | `[{name, description?, argumentHint?}]`；`initialize` 回复的命令列表优先，其次每回合 `system/init` 的 `slash_commands` |
| `claudeVersion` / `claudeSessionId` | claude 版本与会话 UUID |
| `ended` | `null` 或 `{reason, code?, message?, handedOffTo?, stderrTail?, claudeVersion?, minClaudeVersion?}`；`reason` ∈ `exited` / `daemon_restart` / `handed_off` / `version_unsupported` / `stopped` / `restart_failed`。重载进行中先广播 `stopped`，新进程起来后广播 `idle`、`ended:null` 与新 epoch 的 reset 同步；启动失败广播 `restart_failed` + `message` |

### chat_send / chat_respond / chat_interrupt / chat_set_mode (C→S)

只在 `ui:"chat"` 的 `ready` 之后有效。每条都会得到一个 `chat_ack`。

```json
{"type":"chat_send","clientMsgId":"m-17","text":"run the tests"}
{"type":"chat_respond","requestId":"r-17","response":{"behavior":"allow","updatedInput":{…}},"setMode":"acceptEdits"}
{"type":"chat_interrupt"}
{"type":"chat_set_mode","mode":"plan"}
```

- `chat_send`：`text` 去首尾空白后为空 → `empty`；超过 256 KiB 或 `clientMsgId` 超过 64 字符 → `too_large`；写队列满 → `chat_busy`；`clientMsgId` 在最近 256 个已接受的消息里 → ok + `duplicate:true` + `completed`（是否不会再有它的 `result`），不重复写入（这份记录与缓冲区分开，缓冲淘汰后照样认得）；记了 `dropped_on_stop` 的消息不算已接受，同 id 重发会写入新进程；进程不在 → `chat_not_running`
- `chat_respond`：`response` = `{behavior:"allow"|"deny", updatedInput?, updatedPermissions?, message?, interrupt?}`，不是这个形状 → `invalid_response`。请求不在待答表 → `request_not_pending`（已在别处处理）；`updatedPermissions` 每一项必须与该请求 `permission_suggestions` 中某一项相同，否则 `foreign_rule`；allow 缺 `updatedInput` 时 daemon 补上原 input；进程不在 → `chat_not_running`；写队列满 → `chat_busy`（待答保持不变）。`setMode` 只允许 `acceptEdits` / `default`，否则 → `invalid_mode`；只用于回答计划（`ExitPlanMode` 请求），回答其他请求时带 `setMode` → `invalid_mode`（`permissionLocked` 时为 `mode_locked`），这两种情况都不回答，待答保持不变。`setMode` 紧接在回复之后发给 claude（计划批准用）；`permissionLocked` 时回答计划所带的 `setMode` 被静默丢弃（不发 `set_permission_mode`，`ok:true`，模式不变），回答本身照常转给 claude
- `chat_interrupt`：不在运行 → ok 不做事；否则向 claude 发一条 interrupt。待答请求由 claude 自己取消（记 `vr_resolved interrupted`），daemon 不替它回 deny；写队列满 → `chat_busy`
- `chat_set_mode`：`mode` ∉ {`default`, `acceptEdits`, `plan`} → `invalid_mode`；`permissionLocked` → `mode_locked`；进程不在 → `chat_not_running`；写队列满 → `chat_busy`；成功后经 `chat_state` 广播新模式

### chat_ack (S→C)

只发给发起方。不用 `error` 帧（`error` 意味着随后断开）。

```json
{"type":"chat_ack","op":"respond","ref":"r-17","ok":false,"code":"request_not_pending"}
```

- `op`：`send` / `respond` / `interrupt` / `set_mode`
- `ref`：回显 `clientMsgId`（send）、`requestId`（respond）或所请求的 `mode`（set_mode）；interrupt 不带
- `duplicate` / `completed`（只用于 `op:"send"`）：`duplicate:true` 表示这个 `clientMsgId` 已被接受过、这次没有再写入；此时 `completed` 总是给出，`true` = 这条消息不会再有 `result`（已见到它的 `result`，或已被看门狗放弃、记了 `stale_turn`——之后迟到的 `result` 带 `vr_stale`，不算它的），`false` = 仍在执行、它的 `result` 还会来。新消息的 ack 不带这两个字段
- `code`（`ok:false` 时，开放集合）：`empty` / `too_large` / `chat_not_running` / `request_not_pending` / `foreign_rule` / `chat_busy` / `invalid_mode` / `invalid_response` / `mode_locked`

### 断线与订阅

- WS 断开从不停止对话进程，也不发 `exit`；daemon 持续读取 claude 输出到缓冲区，重连带 `epoch`/`since` 补发
- 某个连接的发送缓冲（1024 帧）写满时，daemon 以状态码 1013 断开它，客户端重连补齐，不静默丢帧
- 多个连接可同时接入同一对话会话，看到相同的消息序列；同一待答请求先答先生效

## 辅助 REST API

每台 vibe-remoted 各自暴露，鉴权方式：`Authorization: Bearer <token>`

| Method | Path | 说明 |
|--------|------|------|
| GET | `/healthz` | 存活探针（无需鉴权） |
| GET | `/api/v1/info` | 机器信息：`{version, proto, hostname, tmux_enabled, default_workdir, allowed_roots, claude_flags, chat}`。`version` 是 daemon 构建版本（`-ldflags "-X main.version=..."` 注入，未注入为 `"dev"`），与 `vibe-remoted --version` 输出一致；`proto` 是协议版本（v2 起）；`claude_flags` 只含 `id/label/default`，不下发 `arg`；`chat`（v3）见下文，`?recheck=1` 强制重新探测 claude 版本 |
| GET | `/api/v1/sessions` | 会话列表（条目字段同 `sessions` 帧，含 v3 对话字段） |
| GET | `/api/v1/projects` | （v4）本机项目树：`{proto, projects:[{id, name, git, error?, errorMessage?, worktrees:[{path, branch?, head, detached?, main?, managed?, sessions:[id]}], sessions:[id]}]}`。数组字段恒为 `[]`。旧 daemon 没有此路径，返回 404（客户端据此回退到按会话分组） |
| POST | `/api/v1/projects/remove` | （v4）从项目清单移除一个项目，body `{"id":"..."}`，不碰磁盘。成功 204；清单里没有该 id → 404 `{"error":"project_not_found"}`；仍有会话归属它 → 409 `{"error":"project_has_sessions"}` |
| GET | `/api/v1/worktrees/plan?workdir=<目录>&name=<名字>` | （v4）新建 worktree 之前的只读预检，不创建任何东西；检查的内容与 attach 带 `worktreeName` 新建时在动手之前做的相同。先后只有一处不同：attach 最先查名字里不需要 git 就能判断的规则（此时 daemon 还没有运行任何 git，不通过就是 `invalid_worktree_name`），预检先看 `workdir`（名字不合法时也要给出 `project` 和 `base`）；所以目录和名字都有问题时，两边报的可能不是同一个原因。见下文「`/api/v1/worktrees/plan`」 |
| GET | `/api/v1/worktrees/status?path=<worktree 根目录>` | （v4）一个 worktree 现在的状态：删除确认框上的数字从这里来。见下文「`/api/v1/worktrees/status` 和 `/api/v1/worktrees/remove`」 |
| POST | `/api/v1/worktrees/remove` | （v4）删除一个 worktree（不能是主目录），按请求里的同意项决定是否丢弃文件、是否连分支一起删。删除前 daemon 重查状态，与确认时不一致返回 409。见下文 |
| DELETE | `/api/v1/sessions/{id}` | 关闭指定会话，成功 204，不存在 404。对话会话：停进程、删记录，claude 的 JSONL 对话记录保留。v4 起不再碰 worktree：worktree 模式会话的目录和分支都保留，不再返回 409 `worktree_preserved`（删除 worktree 是单独的操作）。v3 及更早的 daemon 会在工作区干净时一并删除 worktree 和分支，有未提交改动时保留并返回 409 `{"error":"worktree_preserved","message","worktreeRoot","branch"}`（会话本身已关闭），客户端仍要处理这种响应 |
| POST | `/api/v1/sessions/{id}/rename` | 重命名会话，body `{"name":"..."}`，终端会话名字存 tmux 用户选项，对话会话存 daemon 的 `chat-sessions.json` |
| POST | `/api/v1/sessions/{id}/reload` | 终端会话：在原 tmux 会话和工作目录中重启 CLI，并继续最近的对话，成功 204。对话会话（v3）：立即返回 **202**，在后台停进程后以同一 claude 会话重新启动，进度与结果经 `chat_state` 广播（重载中再调用也是 202）；该 claude 会话正被别的会话持有 → 409 `{"error":"claude_session_busy","owner":"<会话 id>","message":"…"}`；会话不存在 → 404。持有 claude 会话的终端会话（交接创建或带 continue 启动）在其被别人持有时同样 409；daemon 未启用 tmux 时终端会话 reload 返回 409 `{"error":"…"}` |
| GET | `/api/v1/fs?path=<dir>` | 列目录（仅目录项），供远程目录选择器用。返回 `{path, parent, entries, chatTrust}`：`chatTrust`（v3）为能否在该目录新建对话会话：`trusted` / `untrusted` / `unknown`，只有 `trusted` 可以。v3 只看 claude 对该目录本身的信任记录；v4 起另认一种情况：该目录是某个仓库的 worktree 根（以该仓库自己的 `git worktree list` 为准，不看目录里的 `.git` 文件），且仓库主目录（精确到这一个路径）被 claude 信任。主目录本身、worktree 里的子目录、裸仓库 / 子模块 / `--separate-git-dir` 仓库的 worktree 仍只看自己的记录；信任文件缺失或损坏是 `unknown`。新建对话会话的 attach 用同一条规则（worktree 模式查所选的源目录），不满足时是 fatal 的 `chat_unsupported`（`workdir_untrusted`）；`parent` 是规范化后的上级目录，**仅在其本身也可列出时才返回**，已在 `allowed_roots` 顶层时为空串。客户端据此隐藏「上一级」，避免点出必然的 403（`allowed_roots` 配的是符号链接解析前的路径如 `/tmp`，而 `path` 是规范化后的 `/private/tmp`，客户端无法自行比较） |
| POST | `/api/v1/events` | 带外事件上报，body `{sessionId,kind,message?}`，路由为该会话的 notify 帧。鉴权见下文，与其它端点不同 |

请求体（rename、events、worktrees/remove）上限 64 KiB，超出返回 413。worktrees/remove 的请求体必须恰好是一个 JSON 对象：整个请求体（含对象之后的内容）都计入上限，对象之后除空白外还有别的内容返回 400 `invalid_request`。rename：会话不存在返回 404，tmux 设置失败等其它错误返回 500。

### `/api/v1/info` 的 `chat`（v3）

```json
{"chat":{"supported":false,"reason":"claude_too_old","claudeVersion":"1.0.51","minClaudeVersion":"2.1.210"}}
```

- `supported`：能否在这台机器上新建对话会话
- `reason`（不支持时）：`not_claude`（`claude_cmd` 第一个词不是 claude）、`shell_syntax`（`claude_cmd` 含管道、`$()` 等 shell 语法）、`conflicting_args`（`claude_cmd` 自带 `-p`/`--print`/`--input-format`/`--output-format`/`--permission-prompt-tool`/`--resume`/`-r`/`--session-id`/`--fork-session`）、`claude_not_found`、`claude_too_old`、`state_dir_unwritable`
- `claudeVersion`：探测到的 claude 版本；探测尚未完成时为空串（此时 `supported:true`，由启动后的 `system/init` 兜底）
- `minClaudeVersion`：对话界面要求的最低 claude 版本

旧 daemon 没有 `chat` 字段且 `proto < 3`：客户端提示升级 vibe-remoted。

### `/api/v1/worktrees/plan`（v4）

`workdir` 是发起处（项目行上发起时是项目主目录，目录选择器的 Worktree 模式里是当前目录），必填，受 `allowed_roots` 约束；`name` 是想用的名字，可以为空（只取 `base`）。两个参数都要 URL 编码。

```json
{ "ok": true,
  "project": "/Users/mac/github/devflow", "projectName": "devflow",
  "base": { "branch": "main", "head": "a1b2c3d" },
  "branch": "fix-login",
  "path": "/Users/mac/github/devflow-worktrees/fix-login" }
```

| 字段 | 类型 | 可缺省 | 说明 |
|------|------|--------|------|
| `ok` | bool | | 以当前状态用这个名字新建，动手之前的检查是否都能通过。之后才会出现的失败（例如磁盘满）预检不覆盖 |
| `error` | string | ✓ | `ok:false` 时的原因，按这个先后只给出第一个：`not_git`（`workdir` 不在 git 仓库里）、`unsupported_repo`（仓库是子模块或用了独立的 git 目录，不能在其中新建命名 worktree）、`no_commits`（`workdir` 所在的 worktree 还没有任何提交——刚 `git init` 的仓库，或分支还没有提交的 worktree；新 worktree 要基于一个提交）、`invalid_worktree_name`（含名字为空）、`worktree_path_not_allowed`、`worktree_branch_exists`、`worktree_path_exists`。前三个与名字无关，换什么名字都一样；后四个与 attach 的 error 帧代码同名同义（attach 遇到前三种情况是 `create_failed`） |
| `message` | string | ✓ | `ok:false` 时给人看的说明；`worktree_path_not_allowed` 时含完整路径，`worktree_branch_exists` 时写明与哪个分支冲突 |
| `conflict` | string | ✓ | 只在 `worktree_branch_exists` 时有：挡住这个名字的已有分支。等于 `branch` 是同名分支已存在；不等是两个名字不能并存（名字 `fix/login` 被已有的 `fix` 挡住，名字 `change` 被已有的 `change/foo` 挡住） |
| `project`、`projectName` | string | ✓ | 项目 id（主目录）和名字；`not_git` 时没有 |
| `base` | object | ✓ | 新 worktree 将基于什么：`{branch?, head, detached?}`，`workdir` 所在 worktree 当前的分支和提交前 7 位；不在任何分支上时没有 `branch`、`detached:true`。`not_git` 时没有；`no_commits` 时 `head` 是 `0000000` |
| `branch`、`path` | string | ✓ | 将要创建的分支和目录；名字通过了规则才有（`not_git`、`unsupported_repo`、`no_commits`、`invalid_worktree_name` 时没有） |

HTTP 错误：缺 `workdir` → 400 `{"error":"invalid_request"}`；`workdir` 不在 `allowed_roots` 内 → 403（响应体同 `/api/v1/fs`）；`workdir` 在 git 仓库里但 git 执行失败或超时 → 500 `{"error":"git_failed","message"}`。旧 daemon 没有此路径，返回 404。

### `/api/v1/worktrees/status` 和 `/api/v1/worktrees/remove`（v4）

删除 worktree 分两步：先查状态（界面按它显示确认框），再带着「用户看到了什么、同意了什么」发删除。daemon 在删除前重查一遍，只做用户同意过的事。

两个端点的 `path` 都必须是 worktree 的根目录，写成规范路径（就是 `/api/v1/projects` 里那一项的 `path`）。它先过 `allowed_roots`（解析符号链接后必须与传入的值逐字相等），再必须是 daemon 自己从所属仓库的 `git worktree list` 里读到的一项；不满足的一律 404 `worktree_not_found`，不对这个路径运行 git。客户端传来的路径和分支名不经过 shell；要删的分支取自 daemon 读到的列表，只以完整引用名 `refs/heads/<分支>` 交给 git。

`GET /api/v1/worktrees/status?path=…`：

```json
{ "path": "/Users/mac/github/devflow-worktrees/fix-login",
  "project": "/Users/mac/github/devflow",
  "branch": "fix-login", "head": "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
  "main": false, "managed": true,
  "dirtyFiles": 3, "unmergedCommits": 2, "ignoredFiles": 1204,
  "sessions": ["1794824025040-12b763ac", "1794824031111-0a1b2c3d"] }
```

| 字段 | 类型 | 可缺省 | 说明 |
|------|------|--------|------|
| `path`、`project` | string | | worktree 根目录；所属项目的 id |
| `branch` | string | ✓ | 检出的分支；不在任何分支上时没有 |
| `head` | string | | 完整的 40 位提交哈希，删除时原样带回。分支还没有任何提交时是全 0（此时 `unmergedCommits` 为 0，照常可以删除） |
| `detached` | bool | ✓ | 不在任何分支上 |
| `main` | bool | | 是主目录（主目录可以查状态，不能删） |
| `managed` | bool | | 由 vibe-remote 创建。只有这种 worktree 的分支可以随它一起删 |
| `dirtyFiles` | number | | 未提交或未跟踪的文件数，不含被 git 忽略的 |
| `unmergedCommits` | number | | 有分支：该分支上不被任何其他本地分支或远程跟踪分支包含的提交数；不在分支上：`HEAD` 上不被任何本地分支或远程跟踪分支包含的提交数 |
| `ignoredFiles` | number | | 被 git 忽略、会随目录一起删除的文件数（逐个文件数，目录不折叠；嵌在被忽略目录里的另一个 git 仓库算 1）。恒有值；`-1` 表示没数出来（这一项超时或失败不影响其它字段）。它只是给人看的说明：没有对应的同意项，删除时 daemon 不比对它 |
| `sessions` | string[] | | 会随这个 worktree 一起结束的会话：归属它的（含已结束的对话会话），以及还没有归属、工作目录在它下面的。恒为数组 |

错误：缺 `path` → 400 `{"error":"invalid_request"}`；404 `worktree_not_found`（见上；仓库是子模块或用了独立的 git 目录时也是它；删除删到一半、git 已经不再登记而目录还剩一部分时也是它）；git 执行失败或超时 → 500 `{"error":"git_failed","message"}`。

`POST /api/v1/worktrees/remove`，请求体：

```json
{ "path": "/Users/mac/github/devflow-worktrees/fix-login",
  "head": "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
  "sessions": ["1794824025040-12b763ac", "1794824031111-0a1b2c3d"],
  "branch": "fix-login",
  "discardFiles": true, "deleteBranch": false, "dropCommits": false }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | 是 | 要删的 worktree |
| `head` | string | 是 | 确认框打开时 status 返回的 `head` |
| `sessions` | string[] | 是 | 确认框上告诉用户会被结束的会话（status 的 `sessions`）。没有会话时是 `[]`，不能省略或传 `null` |
| `discardFiles` | bool | 否 | 用户同意丢弃未提交和未跟踪的文件 |
| `branch` | string | 否 | 确认框打开时 status 返回的 `branch`（当时不在任何分支上就不带）。带了就与现在检出的分支比对，不同返回 409。不带时 daemon 不做这项比对（较早的桌面端不带） |
| `deleteBranch` | bool | 否 | 用户选择连分支一起删。只对 `managed` 且在分支上的 worktree 有意义：重查时它不是 `managed` 或不在分支上（例如确认之后被切到了别的分支）→ 409，什么都不删，不会「只删目录、悄悄留下分支」。不是 vibe-remote 创建的 worktree，分支一律保留，删它时不要带这一项 |
| `dropCommits` | bool | 否 | 用户同意让未合并的提交不再属于任何分支 |

| 响应 | 什么时候 |
|------|----------|
| 200 `{"removed":true,"branchDeleted":true,"endedSessions":["…"]}` | 目录已删。`branchDeleted`：分支是否也删了；该删而没删成（例如还被别的 worktree 检出着）时为 `false` 并带 `branchError`（string）。`endedSessions`：被结束的会话 |
| 400 `invalid_request` | 请求体不是合法的 JSON；缺必填字段：`path`、`head` 为空或没有，`sessions` 没有或是 `null`（没有会话时传 `[]`）。`message` 写明缺哪一个。什么都没动 |
| 400 `worktree_is_main` | `path` 是主目录；仓库是子模块或用了独立的 git 目录时，它唯一的 worktree 也按主目录对待 |
| 404 `worktree_not_found` | 见上 |
| 409 `worktree_changed`，响应体多 `status`（上面 status 的结构，最新状态）和 `endedSessions` | 重查后与用户确认的不一致，没有删除。结束会话之前发现的（`endedSessions` 是 `[]`，什么都没动）：`head` 变了；请求带了 `branch` 而现在检出的分支不同；请求带 `deleteBranch` 而这个 worktree 现在不是 `managed` 或不在分支上；有不在请求 `sessions` 里的会话，或有会话正在这个 worktree 里创建；有未提交文件而 `discardFiles` 不为真；会让未合并提交失去分支而 `dropCommits` 不为真。结束会话之后才发现的（`endedSessions` 是已经结束的会话，目录和分支都还在）：会话在被结束之前又提交了一次；git 拒绝删除后再查，出现了没被同意丢弃的文件。客户端用 `status` 重新确认 |
| 500 `worktree_remove_failed`，响应体多 `endedSessions` | 结束会话之前就能确定删不了（`endedSessions` 是 `[]`，会话、目录、分支都没动；不管同意项是什么都拒绝）：worktree 被 `git worktree lock` 锁定；里面有初始化过的子模块或嵌入式仓库的检出；里面还嵌着这个仓库的另一个 worktree；里面有一个没被它跟踪的独立 git 仓库（git 把它算成 1 个未跟踪文件，`dirtyFiles` 不包含它里面的提交；`message` 写明是哪个目录、怎么手动处理）。已经动手之后的失败（`endedSessions` 是已经结束的会话）：某个会话没能结束；git 删除失败。`message` 是原因或 git 的错误输出；git 已经注销了这个 worktree、目录只删了一部分时，`message` 另外写明剩下的路径，分支不删 |
| 500 `git_failed`，响应体带 `endedSessions: []` | 重查状态时 git 执行失败或超时；什么都没动 |

409、500 的响应体例子：`{"error":"worktree_changed","message":"…","status":{…},"endedSessions":["1794824025040-12b763ac"]}`、`{"error":"worktree_remove_failed","message":"…","endedSessions":[]}`。`endedSessions` 恒为数组；轮到它之前已经自己退出的会话也算已结束。

删除期间，在这个 worktree 里新建会话（含交接）会收到 fatal 的 `create_failed`，`message` 写明它正在被删除；反过来，有会话正在其中创建时，删除返回 409。

这个请求可能比别的 REST 请求慢得多（逐个结束会话，一个对话会话停进程最长约 4 秒；大目录的删除也要时间）。桌面端给它单独的超时 `10 秒 + 5 秒 × sessions 的个数`，上限 60 秒。客户端超时或断开后，daemon 仍会把这次删除做完；客户端此时应再查一次 status 来确定结果（404 = 已删除）。

旧 daemon 没有这两个路径，返回 404（对 `status` 而言与 `worktree_not_found` 的区别是响应体里没有 `error` 字段；客户端按 `/api/v1/projects` 是否 404 判断版本，不在旧 daemon 上调用它们）。

### `/api/v1/events` 鉴权与限制

接受两种 Bearer token：

- 主 token（与其它端点相同）：可上报任意 `sessionId`。
- **hook token**：`hex(HMAC-SHA256(key=主token, msg="events:"+sessionId))`，只对 body 中**同一个** `sessionId` 有效。用于其它会话、或用于其它任何端点（含 WS `auth`）一律 401。

服务端先解析 body 再校验（hook token 依赖 `sessionId`）。未通过鉴权时总是返回 401，即使 body 格式错误，因此 400/413 只会回给已鉴权的调用方。`kind` 最长 64 字节，`message` 最长 4096 字节，超出返回 400；缺 `sessionId` 或 `kind` 也返回 400。成功返回 204。

### 会话环境变量（供 hook 使用）

每个会话启动时，daemon 向 CLI 进程注入：

| 变量 | 值 |
|------|----|
| `VIBE_REMOTE_SESSION_ID` | 会话 id |
| `VIBE_REMOTE_EVENTS_URL` | `http://<bind_addr>:<port>/api/v1/events`（IPv6 地址带方括号） |
| `VIBE_REMOTE_TOKEN` | 该会话的 **hook token**（不是主 token）。变量名沿用旧版，现有 hook 脚本无需改动 |

tmux 模式下，上述变量通过 `tmux new-session` / `respawn-pane` 的 `-e` 逐个显式传入，否则同一 tmux server 上后建的会话会沿用首个会话的值。CLI 能读到的环境，它启动的所有子进程也都能读到，所以这里只放权限仅限上报本会话事件的 hook token。hook 示例：

```sh
curl -fsS -X POST "$VIBE_REMOTE_EVENTS_URL" \
  -H "Authorization: Bearer $VIBE_REMOTE_TOKEN" \
  -d "{\"sessionId\":\"$VIBE_REMOTE_SESSION_ID\",\"kind\":\"idle\"}"
```

## 安全

- vibe-remoted 绑定私有网段地址（RFC1918 / loopback / link-local / tailscale
  100.64.0.0/10），拒绝公网 IP（需 `allow_insecure_bind`）和 wildcard（恒拒），不暴露公网
- 静态 token 是准入核心边界：WS `auth` 帧 + REST `Authorization: Bearer`，均常量时间校验
- WebSocket 使用 `ws://`（明文）：走 Tailscale 时由 WireGuard 加密；LAN 内为明文，仅在可信网络使用
- 推荐叠 Tailscale(WireGuard) 获得传输加密与跨网可达
