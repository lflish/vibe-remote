# vibe-remote

[English](./README.md) ｜ **简体中文**

一个 macOS「远程 Claude 终端」客户端：Claude Code CLI 在远程机器的 PTY
中运行，Electron 桌面端像本地终端一样展示并交互。

> **项目状态：**早期公开预览。目前唯一支持的客户端是 macOS 桌面端；本仓库刻意只保留
> 远程 PTY→tmux 终端这一条产品线。

vibe-remote 是独立开源项目，与 Anthropic 无隶属或背书关系。Claude 和 Claude Code
归其各自权利人所有。

协议细节见 [docs/protocol.md](./docs/protocol.md)。

## 架构

```
桌面端 (Electron + xterm.js)  ──ws(JSON分帧)──►  vibe-remoted (Go)  ──►  PTY→tmux→claude
    「哑终端」，纯字节透传                          每台机器一个        字节流双向透传
```

- **纯字节透传**：不解析 claude 输出，PTY 字节流原样双向透传，流式/颜色/光标 0 失真还原。
- **tmux 持久化**：客户端断开后 claude 会话存活，重连恢复现场。
- **无中心 Hub**：每台机器各跑一个 vibe-remoted，客户端直连。服务端绑私有网段地址（LAN / tailscale），静态 token 为准入核心；跨网/加密可交给 Tailscale。

## v0.1.2 更新

- 终端文本恢复可选中、可复制：拖拽选中、⌘C 复制、⌘V 粘贴。claude 会开启鼠标上报，此前会导致 xterm 关闭自身选区，复制到的是空内容。按住 ⌥ 时鼠标拖拽/点击交给远端应用；滚轮始终可用。
- 内联重命名不再被 5s 会话轮询覆盖，重命名失败时回退到服务端标题。

## v0.1.1 更新

- 首次打开终端时，只有在 xterm 容器真正可见并完成布局后才测量尺寸，避免终端初始偏小，用户不需要再手动拉窗口触发填充。
- 增加首次终端布局时序的回归检查。
- 仓库已收敛为桌面单端：工作区中的 mobile、web、共享包和 portal 遗留目录已删除。

## 主要特性
- **会话命名 / 后台提示**：双击重命名，后台会话有输出/待输入时侧边栏亮圆点。
- **断线重连**：状态栏显示重连进度，活动会话顶部断线横幅 + Retry。
- **claude 参数预设**：服务端配 `claude_flags` 白名单，新建会话时页面多选（如 `-c` 续会话、跳过权限），per-session 生效。
- **app 内机器管理**：增删改机器 + 测试连接，不用手改 `machines.json`。
- **复制 / 粘贴**：拖拽选中 + ⌘C 复制、⌘V 粘贴，即使 claude 开着鼠标上报也可用。按住 ⌥ 可把拖拽/点击交给远端应用，滚轮始终直达。

## 目录结构

```
vibe-remoted/    Go 服务端（单二进制）
desktop/    Electron + xterm.js 客户端
docs/       协议文档
```

## 快速开始

1. 复制 `vibe-remoted.example.json`，在仓库外创建私有配置，并设置随机 token、
   监听地址和目录白名单。
2. 在远程机器构建并启动 `vibe-remoted`。
3. 用 `make dev-desktop` 启动桌面端。
4. 在 app 内的机器管理器中添加远程机器。

不要把 `vibe-remoted` 直接暴露到公网。部署前请阅读 [SECURITY.md](./SECURITY.md)。

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
  "bind_addr": "192.168.x.x",      // 私有网段地址(RFC1918/loopback/link-local
                                    //   /tailscale 100.64.0.0/10)，校验强制
  "port": 8765,
  "token": "your-secure-token",     // 静态鉴权 token，准入核心边界（常量时间校验）
  "default_workdir": "/home/user",
  "allowed_roots": ["/home/user"],  // workdir 白名单，防越权
  "use_tmux": true,                 // false = 降级直跑 claude（无持久化）
  "claude_cmd": "claude",           // 基础命令，整串传给 shell
  "claude_reload_cmd": "claude -c", // 单个会话“重新加载”时执行的命令
  "claude_flags": [                 // 可选：客户端新建会话时可多选的启动参数
    { "id": "continue",   "label": "续上次会话 (-c)", "arg": "-c",                             "default": false },
    { "id": "skip-perms", "label": "跳过权限确认",     "arg": "--dangerously-skip-permissions", "default": false }
  ],
  "login_shell": true,              // 通过登录 shell 启动，加载用户环境
                                    //   （PATH、fnm/nvm 等），默认 true
  "shell": "",                      // 登录 shell 路径，空=用 $SHELL 或 /bin/bash
  "allow_insecure_bind": false      // true 才允许绑公网地址(不建议)；wildcard 恒拒
}
```

**追加启动参数**：`claude_cmd` 是整条命令串，直接追加参数即可，例如
`"claude_cmd": "claude --dangerously-skip-permissions -c"`。因为通过登录 shell
以 `<shell> -lic 'exec <claude_cmd>'` 启动，参数按 shell 规则解析。

**参数预设（`claude_flags`）**：可选。配一组 `{id, label, arg, default}`，客户端新建会话时
在目录选择器里按 `label` 多选，服务端按 `id` 查白名单把 `arg` 拼到 `claude_cmd` 后
（**per-session**，每个会话独立）。客户端只传 id、服务端查表 = 零命令注入；`default` 控制初始勾选。
不配则退化为直接用 `claude_cmd`。

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
cd desktop && npm ci
```

### 开发运行

```bash
npm run dev      # Vite + Electron 热重载
```

### 部署到远程 Linux

桌面端与 `vibe-remoted` 必须保持兼容版本。修改 Go daemon 或 WebSocket/REST 协议后，应先交叉编译并替换远程二进制，再从桌面端测试：

```bash
cd vibe-remoted
go test ./...
GOOS=linux GOARCH=amd64 go build -o /tmp/vibe-remoted-linux-amd64 ./cmd/vibe-remoted
scp /tmp/vibe-remoted-linux-amd64 dev:/home/<user>/vibe-remoted.new
ssh dev 'systemctl --user stop vibe-remoted.service && install -m 0755 /home/<user>/vibe-remoted.new /home/<user>/vibe-remoted && rm -f /home/<user>/vibe-remoted.new && systemctl --user start vibe-remoted.service'
```

桌面端机器管理器中应填写 daemon 实际监听的 NAT/内网地址和 token。Windows/虚拟机 NAT 场景下，SSH 地址可能与 daemon 的监听地址不同。部署后检查所有客户端使用的接口：

```bash
curl http://<daemon-address>:8765/healthz
curl -H 'Authorization: Bearer <token>' http://<daemon-address>:8765/api/v1/info
curl -H 'Authorization: Bearer <token>' http://<daemon-address>:8765/api/v1/sessions
```



首次运行后，点侧边栏「机器管理」在 app 内增删改机器 + 测试连接（推荐）。每台填
`name / addr / port / token`。多台机器时，点侧边栏机器名选中它，新建会话即落在选中的机器上。

配置底层存于 Electron userData 下的 `machines.json`（一般无需手改）：

```json
[
  { "name": "机器A", "addr": "192.168.1.x 或 100.x.x.x", "port": 8765, "token": "your-secure-token" }
]
```

macOS 路径通常为 `~/Library/Application Support/vibe-remote/machines.json`。

### 打包 (.dmg)

```bash
npm run build    # tsc + vite build + electron-builder
```

本地构建产物未签名，macOS 可能要求在系统设置中手动允许打开。目前尚未提供官方签名发行包。

## 前置条件

- 客户端与目标机网络互通即可：同一 **Tailscale tailnet**（推荐，自带加密+跨网）
  或同一**可信局域网**（LAN 内 `ws://` 明文，仅在可信网络使用）。
- 目标机器需安装 `claude` 和 `tmux`；只有从源码构建 daemon 时才需要 Go。
- 走 Tailscale 时，Mac 端需运行（`tailscale up`）。

## 本地开发冒烟（无需远程机）

macOS 本身有 PTY + tmux，可本地起 vibe-remoted 冒烟。用 `claude_cmd: "/bin/bash"` 代跑即可验证透传链路
（纯字节透传不关心跑什么命令）。

### 本机自连自测（make dev-local）

Mac 同时当服务端与客户端，跑真 `claude` 走完整链路：

```bash
make dev-local   # 动态取本机 tailscale IP，绑真地址启动（不走 allow_insecure_bind）
```

它会打印客户端要填的 `addr:port` 和一次性 token。在桌面端「机器管理」里
添加这台机器，即可端到端验证透传 / tmux 持久化 / 重连。
前提：本机已 `tailscale up` 且装有 `tmux` + `claude`。

## 参与贡献与安全问题

欢迎贡献。开发流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)；安全漏洞请按
[SECURITY.md](./SECURITY.md) 私下报告，不要直接创建公开 issue。

## 开源协议

[MIT](./LICENSE) © 2026 lflish
