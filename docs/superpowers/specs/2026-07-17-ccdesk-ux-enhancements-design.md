# ccdesk 体验增强设计（第一期后续）

- 日期：2026-07-17
- 状态：设计已定稿，待实现
- 范围：四块 UI 优化 / 功能查漏补缺
- 前置：第一期（Mac 桌面可用版）已交付；本设计在既有架构上增量

---

## 0. 总览

本次做四块相对独立的增强，全部维护「纯字节透传」核心铁律——没有任何一处解析 claude 的 PTY 输出。

| # | 特性 | 触碰层 | 违反纯字节透传? |
|---|------|--------|:---:|
| 1 | 机器管理 UI（CRUD + 空状态引导 + 测试连接） | 纯客户端 + preload | 否 |
| 2 | 会话命名（默认名 + 双击内联重命名，存 tmux） | 服务端 + 协议 + 客户端 | 否 |
| 3 | 后台会话提示（A 圆点兜底 + C hook 事件增强） | 服务端 + 协议 + 客户端 + hook | 否（hook 带外上报，不碰 PTY 流） |
| 4 | 重连体验（状态栏细节 + 终端横幅） | 纯客户端 | 否 |

**唯一新基建**：第 3C 块引入的「通用事件端点 `/api/v1/events` + Manager pub/sub 路由表」。它复用现有 HTTP server / Bearer token / tailscale-only 绑定，用 `kind` 字段留扩展口，是未来带外事件（token 用量、工具调用等）的地基。其余三块都是在既有结构上填坑位（`SessionInfo.Title` 早留好、`cmd.Env` 是统一注入点）。

### 关键设计原则：hook 不违反纯字节透传

铁律禁止的是「解析 PTY 输出内容来推断状态」。hook 是 claude 通过官方机制**带外主动上报**，PTY 那条字节流链路一个字节都不碰。这是本质不同的两回事。因此用 hook 上报会话状态不仅可行，而且是「正确的做法」。

### 实现顺序

纯客户端的先做（快速见效），服务端改动的后做（打通「服务端加操作」这条路），最重、含并发的事件基建最后：

| 阶段 | 块 | 依赖 |
|------|-----|------|
| 1 | 机器管理 UI | 无，纯客户端 |
| 2 | 重连体验 | 无，纯客户端 |
| 3 | 会话命名 | 打通「服务端加操作」 |
| 4 | 圆点兜底（3A） | 无 |
| 5 | 事件基建（3C，注入留空） | 最重，含并发 |

---

## 1. 机器管理 UI

### 目标

现在 `machines.json` 只能手改文件重启，空状态是干巴巴一句「No machines configured」。目标：app 内完整 CRUD + 空状态引导 + 加机器时测试连接。

### 数据流（主进程是唯一写盘方）

preload 已暴露 `getMachines()` / `saveMachines()`（主进程读写 userData 下 `machines.json`）。CRUD 全部复用这条通道，renderer 不直接碰文件：

```
renderer 表单 ──IPC saveMachines(machines[])──► main 进程 ──► 写 machines.json
renderer 启动 ──IPC getMachines()──────────────► main 进程 ──► 读 machines.json
测试连接    ──renderer 直接 fetch /healthz+/info──► 目标 ccdeskd（不经主进程）
```

### UI 结构

- **入口**：侧边栏 header 加一个齿轮图标按钮 → 打开「机器管理」modal（复用现有 `.modal` 样式体系，和目录选择器同款）。
- **机器管理 modal**：
  - 机器列表：每行 名字 + `addr:port` + 状态点 + 编辑/删除按钮
  - 底部「+ 添加机器」→ 展开表单（名字 / 地址 / 端口 / token）
  - 编辑 = 同一表单预填
  - 删除 = 二次确认
- **表单字段与校验**（客户端侧）：
  - 名字：非空
  - 地址：非空（不强校验 tailscale 段——那是服务端 `bind_addr` 的职责，客户端只管连）
  - 端口：1–65535，默认 8765
  - token：非空
  - **测试连接**按钮：`GET /healthz` 通 + `GET /api/v1/info`（带 token）返回 200 → 绿「连接成功 · hostname」；失败 → 红，分辨「不可达 / token 错」

### 空状态引导

`machines.length === 0` 时，主区不再是那句话，而是引导卡片：
- 标题「添加第一台机器」+ 一句话说明（机器需在同一 tailnet、跑着 ccdeskd）
- 一个「添加机器」主按钮 → 直接打开添加表单
- 小字提示：地址填 tailscale IP（100.x）或 MagicDNS 名；token 与 ccdeskd 配置里的 `token` 一致

### 生效方式与删除语义

- **保存后不重启 app**：renderer 内部重建 `rests` map + 触发一次 `refreshAllMachines()`。已打开的会话 WS 不受影响（绑在各自 SessionView 上）。
- **删除机器 = 客户端概念**：只从客户端清单移除 + 关闭该机器的本地 SessionView，**不杀远程 claude 会话**（tmux 里照活）。理由：删清单条目不该有「远程销毁」副作用；重新加回这台机器时会话还在。杀会话仍走会话项的 × 按钮。

### 涉及文件

- `desktop/src/renderer/machines.ts`（新增）：机器管理 modal + 表单 + 测试连接逻辑
- `desktop/src/renderer/index.ts`：接入齿轮入口、空状态改造、保存后热重载机器列表
- `desktop/src/renderer/styles.css`：表单控件样式（现在只有 modal 骨架，没 input 样式）
- preload / main：`getMachines`/`saveMachines` 已存在，大概率无需改

---

## 2. 会话命名

### 存储：tmux 用户选项（单一事实来源）

会话名挂在 tmux 会话上，用 tmux 的用户自定义选项（`@` 前缀）：

```
写: tmux -L ccdesk set-option -t ccdesk-<id> @ccdesk_name "<name>"
读: tmux -L ccdesk show-options -t ccdesk-<id> -qv @ccdesk_name
```

跟着 tmux 生命周期走：服务端重启、换客户端、多客户端都一致；`Manager.List` 的 reconcile 里一并读回。`use_tmux: false` 降级模式没有 tmux，退回用 workdir 末段做名字（内存态，不持久化）——降级模式固有限制，可接受。

### 默认名规则（读取时算出，不落库）

新建会话时不主动写 `@ccdesk_name`。`List()` 组装 `Title` 时：
1. 若 `@ccdesk_name` 有值 → 用它
2. 否则 → workdir 末段（`/home/user/proj` → `proj`）
3. workdir 也空 → 短 id

即默认名读取时算出，只有用户显式重命名才写 tmux。这样默认名始终跟随 workdir。

### 协议改动（两端手动对齐）

- `SessionInfo.Title` **已有字段**，现在 `List()` 写死 `Title: r.ID`，改成按上面规则填。客户端 `SessionInfo.title` 已存在——「显示名字」这半程几乎零协议改动。
- **重命名走 REST**：新增 `POST /api/v1/sessions/{id}/rename`，body `{name}`。理由：重命名是「对会话资源的管理操作」，和现有 `DELETE /api/v1/sessions/{id}`、`GET /api/v1/sessions` 同属 REST 会话管理族，语义一致；不占用 WS 数据通道。

### 名字净化（安全）

服务端 `Rename` 做净化：截断到 200 字符 + 剥离控制字符（`\r\n\t` 和 ANSI 转义）。`set-option` 用参数化传值，不拼 shell（防注入）。客户端也做基础 trim。双保险。空输入 = 清除自定义名，回落默认名（删除 `@ccdesk_name` 或写空后走默认规则）。

### 客户端交互：双击内联重命名

- 侧边栏 `.session-label` 双击 → 就地变 `<input>`（预填当前名），Enter 提交 / Esc 取消 / 失焦提交。
- 提交 → `rest.renameSession(id, name)` → 成功后 `refreshAllMachines()`（名字从服务端权威读回，保证多端一致）。

### 涉及文件

- `ccdeskd/internal/session/runner.go`：`SetName`/`readName`
- `ccdeskd/internal/session/manager.go`：`List()` Title 规则 + `Rename()`
- `ccdeskd/internal/server/server.go`：rename 端点
- `desktop/src/renderer/rest.ts`：`renameSession()`
- `desktop/src/renderer/index.ts`：双击内联编辑逻辑
- `desktop/src/renderer/styles.css`：内联 input 样式
- `docs/protocol.md`：补 rename 端点

---

## 3. 后台会话提示

分两层渐进增强：A 纯客户端圆点兜底（永远可用），C hook 事件增强（配了 hook 才生效）。两层数据结构统一——C 到来的事件写同一个 view 状态字段，把 `unread: boolean` 扩展成 `activity: 'none' | 'output' | 'idle' | 'waiting'`。C 是纯增量，不重写 A。

### 3A. 圆点兜底（纯客户端）

**核心洞察**：非活动会话的 WS 一直连着，`client.onData` 一直在往它自己的 xterm 写字节。「后台会话有新输出」客户端本来就知道，只是没可视化。A 层把这个已有信号点亮成圆点，零服务端、零协议改动。

**机制**：`SessionView` 加状态字段。

```
client.onData 触发（有 PTY 字节到达）
   ├─ 若该 view 是 activeKey → 不标记
   └─ 若该 view 非活动 → 标记有新输出 → 重绘侧边栏该项圆点

setActive（切到某会话） → 清除该 view 标记 → 清除圆点
```

**避免误报**：会话刚 attach 时 tmux 全量重绘一屏（`refresh-client`）会触发一大波 `onData`。在 `onReady`（其中已 `term.clear()`）之后设一个**短暂抑制窗口（500ms，可调参数）**，窗口内的 `onData` 不计入活动标记——把「attach 重绘」和「真·新输出」区分开。窗口只影响圆点，不影响 xterm 正常显示字节。

**UI**：侧边栏 `.session-item` 右侧（close 按钮左边）加 `.session-unread` 圆点，颜色用主题 accent 蓝（`--accent`），和机器状态点（绿/红）区分。圆点占位固定，× 在 hover 时淡入到圆点右侧，不跳动。

**涉及文件**：`desktop/src/renderer/index.ts`（状态字段 + onData 标记 + 抑制窗口 + setActive 清除 + renderSidebar 画圆点）、`desktop/src/renderer/styles.css`（`.session-unread`）。

### 3C. hook 事件增强

#### 全链路

```
远程: claude 触发 Stop/Notification hook
   │  hook 脚本读环境变量 $CCDESK_SESSION_ID / $CCDESK_EVENTS_URL / $CCDESK_TOKEN
   │  curl -s -X POST $CCDESK_EVENTS_URL
   │     -H "Authorization: Bearer $CCDESK_TOKEN"
   │     -d '{"sessionId":"<id>","kind":"idle"|"waiting"}'
   ▼
ccdeskd: POST /api/v1/events（复用 HTTP server + Bearer 鉴权 + tailscale 绑定）
   │  校验 token、校验 sessionId 存在
   │  mgr.PublishEvent(sessionId, event)
   ▼
Manager pub/sub 路由表: sessionId → [订阅者]
   ▼
该会话的 wsRelay（attach 时订阅，teardown 时退订）
   │  收到 event → wsjson.Write notify 帧
   ▼
客户端: onNotify → 该 view.activity = 'idle'|'waiting'
        → 侧边栏圆点升级语义色 +（可选）Electron 桌面通知
```

语义约定：`Stop` hook → `idle`（跑完了，在等你看）；`Notification` hook → `waiting`（需权限确认/等输入，要你介入）。

#### 新基建 1：通用事件端点

`POST /api/v1/events`，Bearer 鉴权。body：
```json
{ "sessionId": "<id>", "kind": "idle" | "waiting", "message": "可选" }
```
`kind` 留扩展口（未来 token 用量、工具调用等带外事件都走这个端点，只加 kind + payload，传输层零改）。未知 `kind` 服务端接受并透传，客户端不认识就忽略——向前兼容。

#### 新基建 2：Manager pub/sub 路由表

```
Manager 新增：
  subs   map[string][]chan protocol.NotifyFrame  // sessionId → 订阅者
  Subscribe(id) (ch, unsubscribe func())          // relay attach 时调
  PublishEvent(id, ev)                            // events 端点调，广播给该 id 所有订阅者
```
- `wsRelay` 启动时 `Subscribe(sessionID)`，起一个 goroutine 把 ch 里的 notify 帧写进 WS；`defer unsubscribe()`。
- 同会话被多客户端打开 → 多个订阅者 → 广播给所有。
- 非阻塞发送（带 buffer 或 select-default），慢客户端不拖垮端点。
- **并发重点**：`subs` map 的锁；退订不泄漏 goroutine；`go build -race` 必过。

#### 新基建 3：协议加 notify 帧

```
Go:  NotifyFrame{ Type:"notify", SessionID, Kind, Message }
TS:  NotifyFrame + 加进 ServerFrame union；FrameType.Notify
```
`docs/protocol.md` 同步。client.ts 加 `onNotify` 回调，`handleMessage` 加 case。

#### 新基建 4：环境变量注入（统一注入点）

runner 的 `cmd.Env` 是唯一注入点（`start` + `AttachExisting` 各一处）。追加：
```
CCDESK_SESSION_ID=<id>
CCDESK_EVENTS_URL=http://<bind_addr>:<port>/api/v1/events
CCDESK_TOKEN=<token>
```
这几个变量本身无副作用，先注入好，hook 脚本要用时现成。hook 是 claude 的子进程，自然继承。

#### ⚠️ 本期不实现：hook 配置自动注入（预留接口）

「让 ccdeskd 自动生成 hook settings 并让 claude 带上」这一环**本期不做，只保留接口**。原因：claude 当前版本的 hook 注入机制（`--settings` 是合并还是覆盖用户已有 hooks、和用户自带参数是否冲突、临时文件生命周期）需真机验证，不拍脑袋写死。

**本期做（基建全落地）**：events 端点、pub/sub 路由表、notify 帧、wsRelay 订阅转发、环境变量注入、客户端 onNotify → 圆点语义色、桌面通知开关。

**本期留空**：ccdeskd 自动生成 hook 配置让 claude 带上。

**留空环节如何验证**：手动在远程配一个 hook（或直接手动 `curl` events 端点），即可验证 events → pub/sub → notify → 圆点升级 → 桌面通知的全链路是通的。等确定注入方式后，只需补「ccdeskd 自动生成 hook 配置」这一小段，前面全不用动。

> 提醒：此处是**故意留空**，非遗漏。后续候选注入方案（待验证）：① `claude --settings <tmpfile>` 附加临时 settings 文件（首选，需验证合并 vs 覆盖语义）；② workdir 的 `.claude/settings.local.json` 注入（会写用户项目目录，不够干净）；③ 探索 `CLAUDE_HOOKS_*` 类环境变量入口。

#### 桌面通知（可选增强）

`kind: "waiting"` 时，除圆点外可选触发 Electron `Notification`（「<会话名> 需要你的确认」）——移动端最救命的场景（锁屏时 claude 卡在权限确认）在这里打下伏笔。第一期做 app 内圆点语义色，桌面通知作为 modal 里一个开关，默认开。macOS 首次触发时系统弹权限请求；用户拒绝则静默降级成只有圆点。开关控制「是否尝试通知」，不控制系统权限。

#### 涉及文件

- `ccdeskd/internal/protocol/protocol.go`：`NotifyFrame` + `TypeNotify`
- `ccdeskd/internal/session/manager.go`：pub/sub 路由表 + `PublishEvent`/`Subscribe`
- `ccdeskd/internal/session/runner.go`：`cmd.Env` 注入三个变量（两处）
- `ccdeskd/internal/server/server.go`：`POST /api/v1/events` 端点
- `ccdeskd/internal/server/ws.go`：`wsRelay` 订阅 + notify 转发 goroutine
- `desktop/src/shared/protocol.ts`：`NotifyFrame`
- `desktop/src/renderer/client.ts`：`onNotify`
- `desktop/src/renderer/index.ts`：活动状态升级 + 桌面通知
- `docs/protocol.md`：notify 帧 + events 端点

---

## 4. 重连体验

现状：`client.ts` 指数退避机制已完备（`ready` 后归零），但用户只能看到状态栏一行 `Reconnecting…`，终端画面冻住。缺的是「让用户看见」。纯客户端改动。

### A. 状态栏细节

`client.ts` 已有 `reconnectAttempt`，透出去。状态栏文案：
- 连接中 → `Connecting…`
- 重连中 → `Reconnecting… (第 N 次)`（N = `reconnectAttempt`）
- 连回来 → 短暂 `Reconnected ✓`（1.5s）再回到正常会话名/状态

`onStateChange` 回调已存在，扩展它带上 attempt 数。

### B. 终端内联横幅

断线瞬间在**活动会话终端顶部**覆盖一条半透明横幅「连接已断开，正在重连…」，`ready` 后自动消失。
- 只对 activeKey 那个会话显示（非活动会话断线不打扰）
- 覆盖层 `position:absolute`，不干扰 xterm 内容，不触发 resize
- 横幅上可选一个「立即重试」按钮 → 调 `client.connect()` 跳过退避等待

**职责分工**：横幅给断线瞬间的强提示（挡在眼前），状态栏给持续细节（第几次）。两者都订阅同一个 `onStateChange`。

### 涉及文件

- `desktop/src/renderer/client.ts`：state 回调带 attempt + 暴露立即重连
- `desktop/src/renderer/index.ts`：横幅 DOM + 状态栏更新
- `desktop/src/renderer/styles.css`：横幅样式

---

## 5. 测试策略

### 服务端（Go，`go test ./...` + `go build -race`）

- `manager_test.go`：`Rename` 写读往返、`List` 的 Title 规则（有自定义名/回落 workdir/回落 id）、pub/sub 的 `Subscribe`/`PublishEvent`/退订不泄漏 goroutine、多订阅者广播
- events 端点：token 校验、未知 sessionId 拒绝、未知 kind 透传
- race build 必过（pub/sub 引入新并发，重点盯 `subs` map 的锁）

### 客户端（`npm run typecheck` + 手动冒烟）

- 纯 UI 逻辑（圆点、横幅、机器表单）以手动冒烟为主，该项目现无前端测试框架，不为此新建
- 圆点抑制窗口、重连横幅走真机联调验证

### 全链路手动冒烟

- 用 `ccdeskd.local.json`（`claude_cmd: /bin/bash`）本地起，`curl` events 端点验证 notify → 圆点升级 → 桌面通知全通
- 机器管理：加/改/删机器不重启即生效；空状态引导
- 会话命名：双击改名 → 重启 ccdeskd → 名字仍在（tmux 持久化验证）
- 重连：真机断网 → 横幅出现 + 状态栏计数 → 恢复

---

## 6. 非目标（本期明确不做）

- hook 配置**自动注入**（留接口，手动验证）
- 快捷键（用户已排除）
- 会话未读**计数**（字节流无计数语义，只做有/无圆点）
- 解析 claude 输出判断状态（违反纯字节透传铁律，已用 hook 事件替代）
- Windows/移动端打包、Tailscale 自动发现（属后续分期）

---

## 附：默认决策记录

1. **删除机器不杀远程会话**：删机器 = 客户端清单移除 + 关本地 view，tmux 会话照活。
2. **名字净化**：服务端截断 200 字符 + 剥控制字符，`set-option` 参数化传值。
3. **桌面通知权限**：Electron `Notification` 触发系统权限请求，拒绝则降级圆点；modal 开关控制「是否尝试」，不控制系统权限。
4. **圆点抑制窗口 500ms**：经验值，标为可调参数，真机若发现 tmux 重绘超时导致漏抑制再调。
