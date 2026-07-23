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
  |<-- ready {sessionId,workdir} ------|  (确认，之后开始字节流)
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
  "flags": ["continue", "skip-perms"]
}
```

- `sessionId` 为空字符串或省略：创建新会话
- `workdir`：仅新建时有效，指定 claude 工作目录。省略则用服务端默认值
- `flags`：可选，仅新建会话有效。客户端勾选的 claude 启动 flag id 列表；服务端按 `claude_flags` 白名单查表，把对应参数拼到 `claude_cmd` 后（未知 id 忽略）

### attach 帧的 mode 字段（headless 线）

`attach` 帧可带 `mode` 字段：
- 省略或 `"tui"`：现有行为，创建/续接 PTY→tmux→claude TUI 会话。
- `"headless"`：进入 headless 聊天线。服务端不启 tmux，而是每收到一个 `data` 帧
  （base64 编码的用户 prompt）就在 `workdir` 下起一次
  `claude -c -p --output-format stream-json --include-partial-messages --verbose`
  （prompt 经 stdin 传入），把 claude 的 NDJSON 输出**按行**作为 `data` 帧转发；
  进程退出后等待下一个 `data` 帧。workdir 仍受 allowed_roots 白名单约束。

### ready (S→C)

确认 attach 成功。

```json
{"type": "ready", "sessionId": "1720000000000", "workdir": "/home/user/project"}
```

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
    {"id": "1720000000000", "title": "1720000000000", "workdir": "/home/user/project", "created": "2024-07-01T12:00:00Z"}
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
| GET | `/api/v1/info` | 机器信息（主机名、tmux 状态、默认目录等） |
| GET | `/api/v1/sessions` | 会话列表 |
| DELETE | `/api/v1/sessions/{id}` | 关闭指定会话 |
| POST | `/api/v1/sessions/{id}/rename` | 重命名会话，body `{"name":"..."}`，名字存 tmux 用户选项 |
| GET | `/api/v1/fs?path=<dir>` | 列目录（仅目录项），供远程目录选择器用 |
| POST | `/api/v1/events` | 带外事件上报，body `{sessionId,kind,message?}`，路由为该会话的 notify 帧 |

### GET /api/v1/history（会话历史，headless 聊天线）

`GET /api/v1/history?path=<workdir>&limit=<n>`（Bearer 鉴权 + workdir 白名单）。
读取该 workdir 对应 claude 会话 jsonl（`~/.claude/projects/<编码目录>/*.jsonl`，取最近修改的一个），
返回最近 `limit`（默认 50）轮对话，oldest-first：
`{"turns":[{"role":"user"|"assistant","text":"..."}]}`。
仅提取 user 纯文本 prompt 与 assistant 的 text 片段（tool_result / thinking / 附件等跳过）。
无会话时返回 `{"turns":[]}`。

## 安全

- vibe-remoted 绑定私有网段地址（RFC1918 / loopback / link-local / tailscale
  100.64.0.0/10），拒绝公网 IP（需 `allow_insecure_bind`）和 wildcard（恒拒），不暴露公网
- 静态 token 是准入核心边界：WS `auth` 帧 + REST `Authorization: Bearer`，均常量时间校验
- WebSocket 使用 `ws://`（明文）：走 Tailscale 时由 WireGuard 加密；LAN 内为明文，仅在可信网络使用
- 推荐叠 Tailscale(WireGuard) 获得传输加密与跨网可达
