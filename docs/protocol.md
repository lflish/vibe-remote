# vibe-remote 通信协议 v1

## 概述

vibe-remote 使用 **JSON 分帧 WebSocket** 实现桌面客户端与远程 `vibe-remoted` 之间的双向通信。
每条 WebSocket 消息是一个 JSON 对象，以 `type` 字段区分消息类型。
PTY 字节数据使用 base64 编码传输（`data` 帧）。

连接地址：`ws://<host-ip>:<port>/ws`（`<host-ip>` 为服务端所绑私有网段地址，如 tailscale IP 或 LAN IP）

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
  "rows": 40,
  "workdir": "/home/user/project",
  "flags": ["continue", "skip-perms"],
  "mode": "worktree"
}
```

- `sessionId` 为空字符串或省略：创建新会话
- `workdir`：仅新建时有效，指定 claude 工作目录。省略则用服务端默认值
- `flags`：可选，仅新建会话有效。客户端勾选的 claude 启动 flag id 列表；服务端按 `claude_flags` 白名单查表，把对应参数拼到 `claude_cmd` 后（未知 id 忽略）
- `mode`：可选，仅新建会话有效。`normal` 表示直接使用 `workdir`，`worktree` 表示服务端从所选目录所在 Git 仓库创建隔离 Worktree。省略或空值时按 `normal` 处理，以兼容旧客户端

### ready (S→C)

确认 attach 成功。

```json
{
  "type": "ready",
  "sessionId": "1720000000000",
  "workdir": "/home/user/project-worktrees/1720000000000/subdir",
  "mode": "worktree",
  "sourceWorkdir": "/home/user/project/subdir",
  "sourceRepo": "/home/user/project",
  "worktreeRoot": "/home/user/project-worktrees/1720000000000",
  "branch": "vibe/1720000000000"
}
```

`mode` 始终由服务端返回权威值。`normal` 会话只需返回 `mode: "normal"`；`worktree` 会话还返回：

- `sourceWorkdir`：用户选择的原始目录
- `sourceRepo`：原始 Git 仓库根目录
- `worktreeRoot`：该会话创建的 Worktree 根目录
- `branch`：该 Worktree 使用的分支

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

### ping / pong (双向)

保活。客户端每 25 秒发 ping，服务端回 pong。

```json
{"type": "ping"}
{"type": "pong"}
```

### exit (S→C)

会话进程退出。

```json
{"type": "exit", "code": 0}
```

### error (S→C)

错误通知。

```json
{"type": "error", "message": "session not found"}
```

### notify (S→C)

带外会话事件（如 claude hook 经 events 端点上报）。`kind` 为开放枚举，客户端忽略不认识的 kind。

```json
{"type": "notify", "sessionId": "1720000000000", "kind": "waiting", "message": "需要确认权限"}
```

- `kind: "idle"`：claude 完成一次响应（Stop hook）
- `kind: "waiting"`：claude 需要权限确认/等待输入（Notification hook）

## 辅助 REST API

每台 vibe-remoted 各自暴露，鉴权方式：`Authorization: Bearer <token>`

| Method | Path | 说明 |
|--------|------|------|
| GET | `/healthz` | 存活探针（无需鉴权） |
| GET | `/api/v1/info` | 机器信息：`{version, hostname, tmux_enabled, default_workdir, allowed_roots, claude_flags}`。`version` 是 daemon 构建版本（`-ldflags "-X main.version=..."` 注入，未注入为 `"dev"`），与 `vibe-remoted --version` 输出一致；`claude_flags` 只含 `id/label/default`，不下发 `arg` |
| GET | `/api/v1/sessions` | 会话列表 |
| DELETE | `/api/v1/sessions/{id}` | 关闭指定会话 |
| POST | `/api/v1/sessions/{id}/rename` | 重命名会话，body `{"name":"..."}`，名字存 tmux 用户选项 |
| POST | `/api/v1/sessions/{id}/reload` | 在原 tmux 会话和工作目录中重启 CLI，并继续最近的对话 |
| GET | `/api/v1/fs?path=<dir>` | 列目录（仅目录项），供远程目录选择器用。返回 `{path, parent, entries}`：`parent` 是规范化后的上级目录，**仅在其本身也可列出时才返回**，已在 `allowed_roots` 顶层时为空串。客户端据此隐藏「上一级」，避免点出必然的 403（`allowed_roots` 配的是符号链接解析前的路径如 `/tmp`，而 `path` 是规范化后的 `/private/tmp`，客户端无法自行比较） |
| POST | `/api/v1/events` | 带外事件上报，body `{sessionId,kind,message?}`，路由为该会话的 notify 帧。鉴权见下文，与其它端点不同 |

请求体（rename、events）上限 64 KiB，超出返回 413。rename：会话不存在返回 404，tmux 设置失败等其它错误返回 500。

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
