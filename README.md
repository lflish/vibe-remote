# vibe-remote

一个跨端的「远程 Claude 终端」客户端：远程 Linux 机器上跑 Claude Code CLI，
桌面端像用本地 shell 一样连上去交互，体验跟直接在 shell 里敲 `claude` 完全一致。

详见 [REQUIREMENTS.md](./REQUIREMENTS.md) 和 [docs/protocol.md](./docs/protocol.md)。

## 架构

```
桌面端 (Electron + xterm.js)  ──ws(JSON分帧)──►  vibe-remoted (Go)  ──►  PTY→tmux→claude
    「哑终端」，纯字节透传                          每台机器一个        字节流双向透传
```

- **纯字节透传**：不解析 claude 输出，PTY 字节流原样双向透传，流式/颜色/光标 0 失真还原。
- **tmux 持久化**：客户端断开后 claude 会话存活，重连恢复现场。
- **无中心 Hub**：每台机器各跑一个 vibe-remoted，客户端直连；NAT 穿透/加密交给 Tailscale。

## 目录结构

```
vibe-remoted/    Go 服务端（单二进制）
desktop/    Electron + xterm.js 客户端
docs/       协议文档
```

## 服务端 vibe-remoted

### 构建

```bash
make server          # 产出 bin/vibe-remoted
# 或
cd vibe-remoted && go build -o ../bin/vibe-remoted ./cmd/vibe-remoted
```

### 配置

复制 `vibe-remoted.example.json` 并按机器修改：

```json
{
  "bind_addr": "100.x.x.x",        // tailscale 地址(100.64.0.0/10)，校验强制
  "port": 8765,
  "token": "your-secure-token",     // 静态鉴权 token
  "default_workdir": "/home/user",
  "allowed_roots": ["/home/user"],  // workdir 白名单，防越权
  "use_tmux": true,                 // false = 降级直跑 claude（无持久化）
  "claude_cmd": "claude --dangerously-skip-permissions",  // 命令+参数，整串传给 shell
  "login_shell": true,              // 通过登录 shell 启动，加载用户环境
                                    //   （PATH、fnm/nvm 等），默认 true
  "shell": "",                      // 登录 shell 路径，空=用 $SHELL 或 /bin/bash
  "allow_insecure_bind": false      // true 才允许绑非 tailscale 地址(不建议)
}
```

**追加启动参数**：`claude_cmd` 是整条命令串，直接追加参数即可，例如
`"claude_cmd": "claude --dangerously-skip-permissions -c"`。因为通过登录 shell
以 `<shell> -lic 'exec <claude_cmd>'` 启动，参数按 shell 规则解析。

也可用环境变量覆盖：`VIBE_REMOTED_BIND_ADDR`、`VIBE_REMOTED_TOKEN`。

### 运行

```bash
./bin/vibe-remoted --config vibe-remoted.json
```

### 测试

```bash
cd vibe-remoted && go test ./...   # 单元测试（含路径越权防护）
```

## 客户端 desktop

### 安装依赖

```bash
cd desktop && npm install
```

### 开发运行

```bash
npm run dev      # Vite + Electron 热重载
```

### 机器清单配置

首次运行后，编辑 Electron userData 目录下的 `machines.json`：

```json
[
  { "name": "机器A", "addr": "100.x.x.x", "port": 8765, "token": "your-secure-token" }
]
```

macOS 路径通常为 `~/Library/Application Support/vibe-remote/machines.json`。

### 打包 (.dmg)

```bash
npm run build    # tsc + vite build + electron-builder
```

## 前置条件

- 所有机器（含客户端）在同一 Tailscale tailnet。
- 目标 Linux 具备 `claude`、`tmux`、`go`。
- Mac 端 Tailscale 需运行（`tailscale up`）。

## 本地开发冒烟（无需远程机）

macOS 本身有 PTY + tmux，可本地起 vibe-remoted 冒烟。用 `claude_cmd: "/bin/bash"` 代跑即可验证透传链路
（纯字节透传不关心跑什么命令）。
