# 评审：双模式会话（终端 + 对话）

日期：2026-11-14　范围：7d25cbd..9b42ff0，约 115 个文件　评审者：codex（Go daemon、Electron 客户端两路，独立模型）+ Claude 全新子 agent（横切：协议三处一致、检查放松、invariants、安全、文档、冒烟）；复核轮：Claude 全新子 agent

结论：无未处理的严重问题

| 统计 | 严重 | 一般 |
|------|------|------|
| 已修复 | 12（第 1 轮 11 + 复核 1） | 11（第 1 轮 8 + 复核 3） |
| 交给用户决定 | 0 | 0 |
| 不采纳 | 0 | 0 |

每个问题都由协调者按评审者给出的命令重新运行并复现后才采纳；每个修复先写回归测试（确认失败）再修，单独提交。

## 已修复（第 1 轮，基线 8b6dbf6）

Go daemon（codex）：
- [严重] `VIBE_REMOTED_TOKEN` 环境变量配置的主 token 进入对话进程 / 版本探测 / 终端 tmux 环境（横切评审同时发现）→ main 读完即 Unsetenv、子进程环境显式过滤、tmux 全局环境清除（f3c667c，回归 `TestMainTokenEnvNeverReachesChildren` 等）
- [严重] 父进程退出但同组子进程占着 stdout 时 Stop 永久卡在读协程 join → 停止时限同时覆盖进程退出与 EOF，超时升级 SIGKILL 进程组（e594256）
- [严重] Shutdown 与进行中的 CreateChat 并发丢会话记录 → closing 标志 + 等待在途创建后再最终落盘（084693f）
- [严重] dropped_on_stop 结算后同 id 重发被去重吞掉 → 结算时同步移除去重记录（8f3e14d）
- [严重] 非 tmux 且非登录 shell 时交接把整条命令当 argv[0] → 保留结构化 argv（432d234）
- [严重] 命令解析把参数值当控制选项（`--append-system-prompt -c` 等）→ 按选项位置分类 + 取值选项表（518d0ae）
- [严重] chat_respond 带 setMode 可绕过 bypass 锁定 → Respond 校验锁定、setMode 只对 ExitPlanMode（1b795b0）
- [一般] 裸终端退出后占用不释放 → 进程 Wait 后释放 claim（bf8fed3）

Electron 客户端（codex）：
- [严重] 新建失败（ready 前 fatal）的视图挡住同机后续新建 → 临时键 + 失败即销毁（d0bcb64）
- [严重] 连点重发重复入队并卡住队列 → 按 id 去重、复用气泡（95febab）
- [严重] 缓冲溢出后已完成消息被误标未送达、重发卡队列 → 新增 chat_ack `duplicate/completed`（Go 6f0121b，客户端 963024a）
- [严重] 机器概览显示时隐藏对话的待答请求无黄点无通知 → 概览显示即无当前会话（32534f9）
- [一般] 分批历史最终全量进 DOM → reset 同步期间固定最新 300 条窗口（1c80dad）
- [一般] `__proto__` 题干答案丢失 → 无原型对象构建 answers（27e9a7a）

横切（same）：
- [一般] invariant #4 的命令跑不到 TestOrphanCleanup → 修检查命令（bd364a5）
- [一般] protocol.md 各帧 ack 码不全、vr_resolved.message 从不发送、worktree 信任措辞与 decisions #32 不一致 → 文档修正（a83279e）
- [一般] README / README.zh-CN / SECURITY 未随对话模式与 state_dir 更新 → 补齐（7c7344c）

## 已修复（复核轮，基线 83e11dc）
- [严重] G7 修法让固定 bypass 的会话无法批准计划（R6.1/R6.2 回归）→ 锁定会话忽略 setMode 照常放行 allow，客户端锁定时只给单个「批准」选项（4b374b4，`TestLockedSessionCanApprovePlan`）
- [一般] `completed` 在 Go/TS 两端语义不一致（看门狗放弃的消息重发后队列卡死）→ 放弃即视为已结束（96b3e22）
- [一般] 关闭期间的创建被标 fatal create_failed → 新增非 fatal `shutting_down`（1ce9767，三处协议同步）
- [一般] 取值选项表漏 `-n/--effort/--debug-file/--file/--plugin-url/…` → 补齐并用 `claude --help` 快照测试守住（9b42ff0，`TestValueOptionsCoverClaudeHelp`）

## 交给用户决定
无。

## 不采纳
无。

## 备注（进后续 / 交 dev-test）
- gui-smoke 的既有终端用例「drag-select under mouse reporting + ⌘C copies the text」偶发失败（3 次运行中 1 次：选区多复制了若干空行），两次重跑 24/24 通过。未改动该测试；交 dev-test 判断是时序抖动还是对话样式影响了终端布局。
- 评审者在沙盒内跑 `go test -race -count=2 ./...` 时 TestOrphanCleanup 因沙盒禁 `ps` 超时，属环境限制，正常环境通过。
- npm audit：生产依赖 0 漏洞；开发依赖 13 个既有告警（electron/vite/undici），与 main 基线相同，非本次引入。

## 测试复跑（修复后，HEAD 9b42ff0）
- `make check`：exit 0（Go 5 个包 race 全过；desktop typecheck + 21 个测试脚本全过）
- `node .claude/skills/verify/scripts/ws-chat-smoke.mjs`：9/9 PASS
- `node .claude/skills/verify/scripts/gui-smoke.mjs`：24/24 PASS（×2），另 1 次见备注
- 复核轮新增回归：TestLockedSessionCanApprovePlan、TestResendAfterWatchdogReportsCompleted、TestValueOptionsCoverClaudeHelp 均 PASS
