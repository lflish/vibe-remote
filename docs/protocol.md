# vibe-remote 通信协议 v1

## 概述

vibe-remote 使用 **JSON 分帧 WebSocket** 实现客户端（桌面 / web / iOS）与远程 `vibe-remoted` 之间的双向通信。
每条 WebSocket 消息是一个 JSON 对象，以 `type` 字段区分消息类型。
claude 官方 stream-json 的 NDJSON 输出按行经 base64 编码传输（`data` 帧）。

**唯一数据平面：headless 结构化线**。服务端跑 `claude -p --output-format stream-json`，把 claude
官方 NDJSON 协议按行透传；客户端用 `@vibe-remote/core` 的 parser **解析成结构化消息仅用于显示**
（tool_use ↔ tool_result 配对、thinking、cost），不解析 TUI 像素。会话以 **workdir** 为身份
（`claude -c` 续接该目录最近对话），无 tmux / PTY 会话概念。

连接地址：`ws://<host-ip>:<port>/ws`（`<host-ip>` 为服务端所绑私有网段地址，如 tailscale IP 或 LAN IP）

## 连接生命周期

```
Client                              Server (vibe-remoted)
  |                                    |
  |--- WebSocket connect ------------->|
  |                                    |
  |--- auth {token} ------------------>|  (必须是首帧，10s 超时)
  |                                    |
  |--- attach {workdir?,flags?} ------>|  (指定 claude 工作目录 + 启动 flag)
  |                                    |
  |<-- ready {workdir} ----------------|  (确认，之后开始一次 turn)
  |                                    |
  |--- data {payload:base64} --------->|  (用户 prompt，一条=一次 turn)
  |<-- data {payload:base64} ----------|  (claude NDJSON 输出，按行流式)
  |--- ping -------------------------->|
  |<-- pong ---------------------------|
  |                                    |
  |<-- exit {code} --------------------|  (本次 turn 的 claude 进程退出)
  |--- [close] ----------------------->|  (客户端断开)
```

## 帧类型

### auth (C→S)

首帧，必须在连接后 10 秒内发送。

```json
{"type": "auth", "token": "your-static-token"}
```

### attach (C→S)

请求打开一个 workdir 的聊天线。服务端不启 tmux，而是每收到一个 `data` 帧
（base64 编码的用户 prompt）就在 `workdir` 下起一次
`claude -c -p --output-format stream-json --include-partial-messages --verbose`
（prompt 经 stdin 传入），把 claude 的 NDJSON 输出**按行**作为 `data` 帧转发；
进程退出后等待下一个 `data` 帧。

```json
{
  "type": "attach",
  "workdir": "/home/user/project",
  "flags": ["continue", "skip-perms"]
}
```

- `workdir`：指定 claude 工作目录，受 `allowed_roots` 白名单约束。省略则用服务端默认值
- `flags`：可选。客户端勾选的 claude 启动 flag id 列表；服务端按 `claude_flags` 白名单查表，把对应参数拼到 `claude_cmd` 后（未知 id 忽略）

### ready (S→C)

确认 attach 成功。

```json
{"type": "ready", "workdir": "/home/user/project"}
```

### data (双向)

- C→S：一条用户 prompt（UTF-8 文本经 base64 编码），触发一次 turn
- S→C：claude 官方 stream-json 的 NDJSON 输出，**按行**经 base64 编码转发

```json
{"type": "data", "payload": "SGVsbG8gV29ybGQ="}
```

### ping / pong (双向)

保活。客户端每 25 秒发 ping，服务端回 pong。

```json
{"type": "ping"}
{"type": "pong"}
```

### exit (S→C)

本次 turn 的 claude 进程退出（一次 turn 结束）。

```json
{"type": "exit", "code": 0}
```

### error (S→C)

错误通知。

```json
{"type": "error", "message": "..."}
```

## 辅助 REST API

每台 vibe-remoted 各自暴露，鉴权方式：`Authorization: Bearer <token>`

| Method | Path | 说明 |
|--------|------|------|
| GET | `/healthz` | 存活探针（无需鉴权） |
| GET | `/api/v1/info` | 机器信息（主机名、默认目录、allowed_roots、claude_flags） |
| GET | `/api/v1/fs?path=<dir>` | 列目录（仅目录项），供远程目录选择器用 |
| GET | `/api/v1/history?path=<workdir>&limit=<n>` | 读该 workdir 最近 jsonl，返回最近 turns（详见下节） |

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
