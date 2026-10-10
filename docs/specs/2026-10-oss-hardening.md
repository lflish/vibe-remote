# Spec：开源就绪加固（2026-10）

来源：2026-10-10 的项目评估（daemon / desktop 代码审查 + 仓库、CI/CD 核查）。
分支：`chore/oss-hardening`。

## 目标

1. 修掉影响正确性和凭据安全的 P0 问题。
2. 让外部用户能低门槛部署 daemon（发布 Linux 二进制、systemd 示例、版本可查、配置可校验）。
3. CI/CD 规范化：只有一个检查入口，CI 能真正拦住问题，tag 驱动可复现的发布。
4. 把常用的项目检查流程沉淀为可共享的项目级 skills。

## 非目标（本次不做，原因见末尾「后续事项」）

- Electron 大版本升级
- 代码签名 / 公证
- 开启 `main` 分支保护（属于仓库设置，需维护者确认）
- 侧边栏增量渲染重构
- 改 appId
- Windows/Linux 桌面端
- 认证失败限速

## A. P0 修复

| ID | 问题 | 方案 | 验收 |
|---|---|---|---|
| A1 | `client.ts` 的 `connect()` 关旧 socket 时没有解绑 handler，旧 `onclose` 再次触发重连，形成循环 | 关闭前把旧 ws 的四个 handler 都置 null；回调内再加一层判断，`ws !== this.ws` 时忽略 | 新增 `scripts/test-client-reconnect.mjs`：用 fake WebSocket 模拟连接中途 connect()，断言只排一次重连 |
| A2 | `machines.json` 明文存 token，权限 0644 | 主进程用 `safeStorage` 加密 token，字段名 `tokenEnc`（base64）；`safeStorage` 不可用时回退明文并打 warning。文件一律以 0600 写入，读取时对已有文件 `chmod 0600`。读到旧版明文 `token` 时，下次写入自动迁移。renderer 拿到的仍是明文 token，IPC 接口不变 | 单测覆盖加密/解密/迁移/回退逻辑（抽成纯函数）；写入后文件权限为 0600 |
| A3 | 主 token 注入 claude 环境（`VIBE_REMOTE_TOKEN`） | 改为注入按会话派生的 hook token：`HMAC-SHA256(mainToken, "events:"+sessionID)` 的 hex。变量名保持 `VIBE_REMOTE_TOKEN`，现有 hook 脚本无需改动。`/api/v1/events` 接受主 token，或与 body 中 `sessionId` 匹配的派生 token；其它端点只接受主 token | 测试：派生 token 能调 events；用它调 events 时 sessionId 不符被拒；用它调 `/api/v1/info` 返回 401 |
| A4 | tmux 会话继承第一个客户端的环境（已实测确认），`VIBE_REMOTE_SESSION_ID` 串号 | `new-session` 和 `respawn-pane` 都用 `-e KEY=VAL` 显式传入每个 `VIBE_REMOTE_*` 变量 | tmux 集成测试：同一 socket 上建两个会话，各自读到自己的 SESSION_ID |
| A5 | 未提交的新测试依赖已在运行的 tmux server | 测试里先起一个临时会话，用 `t.Cleanup` 清理，再执行 `display-message` | 在没有 tmux server 的机器上 `go test -race ./...` 全绿 |

## B. Daemon 健壮性与可运维性

| ID | 方案 |
|---|---|
| B1 | 用 `http.Server`，设 `ReadHeaderTimeout: 10s`、`IdleTimeout: 120s`。不设 Read/WriteTimeout，避免断开 WS 长连接 |
| B2 | 监听地址和 events URL 都改用 `net.JoinHostPort`，修复 IPv6 |
| B3 | 收到 SIGINT/SIGTERM 时 `Shutdown`（5s 超时）。tmux 会话不受影响 |
| B4 | `--version` flag，版本通过 `-ldflags "-X main.version=..."` 注入，默认 `dev`。`/api/v1/info` 增加 `version` 字段，同步更新 protocol.md 和 TS 类型 |
| B5 | 配置校验：<br>- 未知字段报错（`DisallowUnknownFields`）<br>- token 至少 16 字符，且不能等于示例值；不足 32 字符时 warn<br>- `allowed_roots` 非空且每个都存在<br>- `default_workdir` 在 `allowed_roots` 内<br>- `claude_cmd` 非空<br>- flag 的 id/arg 非空且 id 不重复<br>- 配置文件缺失时打 warning（仍允许纯环境变量启动） |
| B6 | 请求大小限制：<br>- REST body 用 `MaxBytesReader` 限制为 64 KiB<br>- events 的 `kind` ≤ 64 字节、`message` ≤ 4 KiB<br>- WS 认证前读取上限 64 KiB，认证后放开到 4 MiB |
| B7 | Runner 元数据加独立的 `metaMu`。`Metadata()`、`applyTmuxSessionMetadata` 以及所有读写 Mode/Source*/WorktreeRoot/Branch/Workdir 的地方都走它。`start()` 写 ptmx/cmd/epoch 时持有 `r.mu` |
| B8 | `Manager.Attach` 恢复会话时，在写锁内再查一次 map，已存在就复用，避免并发恢复出两个 Runner |
| B9 | `Manager.List` 在持锁之外执行 tmux 查询，持锁只做 reconcile 和快照 |
| B10 | worktree 模式下，`CreateWorktree` 得到的 workdir 要用调用方传入的校验函数（`ResolveAllowedWorkdir`）复查，不通过就回滚并报错 |
| B11 | `SetName` 改走 `setTmuxOption`（带 `--`）。rename 接口：not found 返回 404，其余错误返回 500。reload 沿用当前 per-session flags 的问题记入后续事项，本次不改 |
| B12 | 测试补齐：<br>- REST 鉴权矩阵（除 `/healthz` 外全部 401）<br>- WS 握手（错误 token、首帧不是 auth、错误 workdir）<br>- fs 软链逃逸<br>- 配置校验<br>- JoinHostPort（IPv6）<br>- hook token |

## C. 桌面端

| ID | 方案 |
|---|---|
| C1 | `will-navigate` 只允许 dev server URL，`setWindowOpenHandler` 一律 deny |
| C2 | 调试端口只在 `!app.isPackaged` 时开启 |
| C3 | 主进程校验 `machines.json` 和 `save-machines` 的输入：必须是数组，元素含 name/addr/port(1–65535)/token。读到坏文件时备份为 `.bak` 并返回空列表。renderer 的 `init()` 失败时显示错误，而不是白屏 |
| C4 | 桌面通知标题用会话名。默认语言跟随 `navigator.language`（`zh*` 用中文，其余英文），用户已保存的选择优先。英文 aria-label 去掉全角冒号 |
| C5 | `package.json`：<br>- devDependencies 锁成 lockfile 中的精确版本<br>- 显式声明 `esbuild`<br>- 新增 `npm test`，汇总所有回归脚本 |
| C6 | `package-lock.json` 的 `resolved` 从 npmmirror 改为 `registry.npmjs.org`（tarball 路径和 integrity 相同）。国内用户仍可用 `npm config set registry` 走镜像 |

## D. CI/CD

| ID | 方案 |
|---|---|
| D1 | Makefile 新增唯一检查入口：<br>- `make check` = `check-server` + `check-desktop`<br>- `check-server`：gofmt -l 必须为空、vet、`test -race ./...`<br>- `check-desktop`：typecheck + `npm test`<br>CONTRIBUTING、releasing.md、CI 和 skills 都只引用 `make check` |
| D2 | `ci.yml`：<br>- 触发：`push`（main）+ `pull_request` + `workflow_dispatch`<br>- `concurrency` 取消旧运行，每个 job 设 `timeout-minutes`<br>- 显式安装 tmux，并设 `VIBE_REMOTE_REQUIRE_TMUX=1`，让 tmux 缺失时测试失败而不是 skip<br>- 加跑 govulncheck<br>- desktop job 跑 `npm test` + `vite build`<br>- 新增 macOS job，执行 `electron-builder --dir` 做打包冒烟 |
| D3 | 新增 `release.yml`，推送 `v*` tag 时触发：<br>- 校验 tag 与 `desktop/package.json` 版本一致<br>- 跑 `make check`<br>- 构建 daemon：linux/darwin × amd64/arm64，注入版本号<br>- 在 macOS runner 上构建 arm64/x64 DMG<br>- 生成 `SHA256SUMS` + build provenance attestation<br>- 用 `gh release create --draft` 建草稿 release，由维护者审核后发布<br>只用 GitHub 官方 actions |
| D4 | `dependabot.yml`：覆盖 gomod、npm、github-actions，每周检查。`@xterm/*` 忽略（版本是刻意锁定的） |
| D5 | `go.mod` 升到受支持的 Go 版本（1.26；1.25 已停止安全修复，govulncheck 会报 stdlib 漏洞），CONTRIBUTING 同步 |
| D6 | 新增 `CHANGELOG.md`，承接 README 中的 What's new；README 只保留链接 |

## E. 文档与部署

- E1：`docs/deploy/vibe-remoted.service`，systemd user unit 示例，`KillMode=process` 并附注释说明原因。README 增加「下载预编译 daemon + systemd 部署」小节。
- E2：README 和 SECURITY 写明边界：token 等同于 shell 访问；hook token 的作用范围；token 长度要求。
- E3：`vibe-remoted.example.json` 的 flag label 改为英文。
- E4：protocol.md 同步 `version` 字段和 events 鉴权规则。

## F. 项目级 skills（`.claude/skills/`，纳入版本控制）

- `.gitignore` 放行 `.claude/skills/`。外部安装的 `redesign-existing-projects` 和 `settings.local.json` 继续忽略。
- 新增以下 skill：

| skill | 作用 |
|---|---|
| `check` | 运行 `make check`，解读失败原因 |
| `protocol-sync` | 逐项比对 `protocol.go`、`protocol.ts`、`docs/protocol.md` 的帧类型和字段 |
| `verify` | 本地端到端冒烟：tmux + `/bin/bash` 配置起 daemon，用 curl 覆盖 REST/WS；需要时用 CDP 驱动 Electron |
| `deploy-daemon` | 交叉编译、替换远程二进制、重启、校验三个端点。设 `disable-model-invocation: true`，只能手动触发 |
| `release` | 按 releasing.md 执行：版本号、CHANGELOG、tag，然后盯 release workflow |

## 后续事项（未纳入本次）

- **Electron 33 → 受支持的大版本**：需要人工做 GUI 回归，覆盖选区/剪贴板/布局。
- **签名与公证**：需要 Apple Developer 账号，release.yml 已预留 secrets 接入点。
- **开启 `main` 分支保护**：要求 CI 通过才能合入，需维护者确认。
- **侧边栏增量渲染**：解决每 5s 轮询导致的焦点丢失。
- **reload 保留 per-session flags**：需要把 flags 持久化到 tmux option。
- **认证失败限速**：当前靠 token 最小长度兜底。

## 验收

- 本地 `make check` 全绿，包括 race 测试和 tmux 集成测试。
- `go build` 交叉编译 linux/amd64 成功，`--version` 输出正确。
- 本地冒烟：用 tmux 配置起 daemon，curl 检查 `/healthz`、`/api/v1/info`（含 version）；两个会话的 `VIBE_REMOTE_SESSION_ID` 各自独立；hook token 调 events 成功。
- workflow 文件通过 YAML 语法检查（actionlint 可用时也跑一遍）。
