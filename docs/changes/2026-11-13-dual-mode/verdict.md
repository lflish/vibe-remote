# 验证结论 · 双模式会话（终端 + 对话）· 机器关口 C 第 3 轮

- 结论：通过，有备注
- 提交：0edb03bd2da92d4513b93d2de957fef371f6e7f2
- 验证快照：{"schema":1,"docs_dir":"docs/changes","head":"0edb03bd2da92d4513b93d2de957fef371f6e7f2","head_tree":"7045e554bc63150ae3c89f739d502bc49c139688a5d84b075208f68d76417e84","target":"7d25cbdeee006f7ad5bdf01879848274a383bb69","target_tree":"4d0d58c229e8bd52a71ea65ae7e10f56c3fa665383b7f15a91e05944ed9b569b"}
- 验证者：两名，都没写过被验代码，各自在独立的 worktree 里对同一提交验证。非界面部分：codex（GPT-6）；界面部分：同模型的全新验证者（Claude Fable 5）。
- 日期：2026-11-20
- 拦下的问题：0 个。备注：codex 2 条，界面 1 个不拦的问题 + 8 条备注。
- 放松检查：两份结论都核对了 `16fd611..0edb03b` 的测试改动，没有删测试、放宽断言、调大超时或加忽略规则（各自的「放松检查」一节）。
- 未决的 `c<n>`：无（c1–c7 都已有处理结果，见 decisions.md）。

这是本文件的汇总部分，由协调者（主会话）整理；两份结论的全文原样收在后面。此前两轮的结论在 `verdict-history.md`「关口 C 第 1 轮」「关口 C 第 2 轮」。

## 这一轮验的是什么

这是**范围受限的复验**（decisions #50）：只验 `16fd611..0edb03b` 的返工改动——X9（`-c` 的 cwd 检查漏掉已有历史，第 2 轮 codex 拦下的 P4）和 X10（改名之后、点开「等你处理」的会话之后的键盘焦点，第 2 轮界面验证者的备注 3、4）——以及它们可能带来的新问题。

其余场景沿用第 2 轮（提交 `16fd611`）两名验证者各自的结论：

- 界面部分：第 2 轮的结论是「通过，有备注」。
- 非界面部分：第 2 轮除 P4 外没有拦的问题；P4 这一轮用原反例复验，**已解决**。

`16fd611..0edb03b` 里非 `docs/changes/` 的改动是 13 个文件（codex 的结论「差异范围」一行），协议文件没有动。

## 分工

| 部分 | 验证者 | 做了什么 | 结论 |
|------|--------|----------|------|
| 非界面 | codex（GPT-6），worktree `.devflow-tmp/verify-dm` | gofmt、vet、typecheck、`npm test`；`go test -race` 全量；不变规则「同一 claude 会话 id 最多一个进程」的 check；`ws-chat-smoke`；P4 原反例三层复验（库、WebSocket、终端新建）；X9 的边界实验（JSON 写法、路径、读时追加、耗时、会话隔离、三个占用入口）；X10 的 jsdom 实验 6 组；文档与协议核对；测试改动审计 | 通过，有备注（P4 已解决；备注 2 条） |
| 界面 | 同模型的全新验证者（Claude Fable 5），worktree `.devflow-tmp/verify-dm-gui` | `gui-smoke` 2 次、`gui-chat-smoke` 2 次；真实 Electron 里经 CDP 发真实指针 / 按键事件，手工复验 X10 的各条路径（A–K 节），与基准 `16fd611` 逐项对照，X7 / X8 / X6 / `-c` 新建的回归抽查 | 通过，有备注（1 个不拦的问题；备注 8 条） |

## 协调者补跑的两组测试

codex 的沙箱禁止执行 `ps`，依赖进程身份确认的两组测试在它那里没能运行（它如实记为「尚未验证」，没有算通过）：

- `TestOrphanCleanup`（5 个子用例）
- `TestLoadChatsMarksDaemonRestart`

协调者在同一提交 `0edb03b` 的 `verify-dm` 副本上用 `go test -race -count=1` 补跑了这两组，**全部通过**（2026-11-20；记录在协调者的裁决 `rulings-3.md`，该文件在本机 `.devflow-tmp/gate-c-dm3/`，不入库）。开发方在同一份代码上的全量运行里这两组也通过（test-report.md「汇总」里单独带 `-v` 跑的那两段输出）。

## 关口 C 三轮

| 轮次 | 被测提交 | 非界面（codex） | 界面（同模型的全新验证者） | 拦下的问题 | 之后 |
|------|----------|-----------------|----------------------------|------------|------|
| 第 1 轮 | `e869add` | 不通过：3 个问题 | 不通过：2 个问题 | 5 个（X3、X4、X5、X7、X8） | 返工 T14–T20（另修了备注里的 X6 和测试修正） |
| 第 2 轮 | `16fd611` | 不通过：1 个问题（P4，X4 的修复引入） | 通过，有备注 | 1 个（X9） | 返工 T21、T22（X9；顺手修界面备注 3、4，记为 X10） |
| 第 3 轮（范围受限） | `0edb03b` | 通过，有备注 | 通过，有备注 | 0 个 | 机器关口 C 放行 |

验证者轮次：c6 批准 2 轮（第 1、2 轮），第 3 轮按 decisions #50 追加。

## 备注怎么处理的

这一轮之后不再改代码（任何非 `docs/changes/` 的改动都会让上面的验证快照失效）。备注全部记进文档：

| 来源 | 备注 | 去向 |
|------|------|------|
| 界面 问题 1（不拦） | 用鼠标点卡片按钮、「否 + 说明」、提问卡片「提交回答」作答后，焦点停在页面上，不到输入框 | tasks.md「后续」；decisions #54 更正 #53 的 (b) |
| 界面 备注 1、2 | 卡片一出现就拿走键盘，单个数字键就是回答：正在别处打字时来了权限请求，接着敲的 `1` 会允许这条请求（第 1 轮起就有的行为） | tasks.md「后续」第一条（优先级最高）；decisions d15：这一版不改，合并后第一个修 |
| 界面 备注 3 | 改名中点击另一个会话，点击被吞——不只本机 daemon，往返 20 ms 左右的近距离远程机器同样 | tasks.md「后续」那条的适用范围已改准 |
| 界面 备注 4 | 三个 X10 GUI 用例用 `Input.insertText` 判断「字进了当前会话」，探针不可靠 | tasks.md「后续」 |
| 界面 备注 5 | tasks.md T22 里「有对话框打开时不抢焦点」只对「改名结束时」成立 | T22 那句已补上范围 |
| 界面 备注 6 | 卡片拿到焦点时没有可见的焦点外框 | tasks.md「后续」 |
| 界面 备注 7 | 提问卡片没有数字快捷键（Tab / 空格 / 方向键可用） | 不处理（不是问题） |
| 界面 备注 8 | 黄点出现的同一瞬间点击可能被侧边栏重建吞掉 | 并入 tasks.md「后续」里「侧边栏重建吞点击」那条 |
| codex 备注 1 | `-c` 的扫描没有总量上限：80 份各 50 MiB 的合成历史，一次新建约 23 秒（期间其它会话毫秒级响应） | tasks.md「后续」；decisions #55 更正 #52 |
| codex 备注 2 | 筛行与逐行解析不严格等价：键写成 `CWD` / `Cwd` 时筛掉。claude 写的是小写 `cwd` | decisions #55；不改代码 |
| 两份结论的待验证项 | 真实输入法组字、真实的 ⌘Tab / Dock 切换、原生通知点击（未签名包只有降级）、真实 claude、远程 Linux、冷盘 | test-report.md「未覆盖和遗留」；汇总页 |

## 证据

- 界面验证者的截图共 80 张（手工 40 张 + 冒烟脚本 40 张）、驱动脚本和 4 份冒烟日志在本机 `.devflow-tmp/gate-c-dm3/`（不入库）。和上表的备注直接有关的 5 张收进了 `evidence/verdict-c3/`：`a01-direct-opened-from-yellow-dot.png`（从黄点点开后的权限卡片）、`b01-head-card-while-typing.png`（输入框里打字时来了卡片）、`e01-head-manager-open-card-arrives.png`（机器管理对话框开着时来了卡片）、`d01-head-renaming-while-card-arrives.png`（改名中来了卡片，改名框保持焦点）、`c02-local60-chat-after-click-other.png`（改名中点另一个会话，没有切换）。
- codex 的实验源码和摘要日志在本机 `/tmp/vr-dm3-audit-GgHISd`（不入库）。
- 两份结论收入前用 `grep -nE 'VIBE_REMOTE_TOKEN=[0-9a-f]{8}|Bearer [A-Za-z0-9_-]{16}'` 核对过，没有匹配。

下面原样收入两份结论的全文。

---

# 关口 C 第 3 轮 · 验证结论全文（一）：非界面部分（codex）

- 结论：通过，有备注
- 提交：0edb03bd2da92d4513b93d2de957fef371f6e7f2
- 验证快照：{"schema":1,"docs_dir":"docs/changes","head":"0edb03bd2da92d4513b93d2de957fef371f6e7f2","head_tree":"7045e554bc63150ae3c89f739d502bc49c139688a5d84b075208f68d76417e84","target":"7d25cbdeee006f7ad5bdf01879848274a383bb69","target_tree":"4d0d58c229e8bd52a71ea65ae7e10f56c3fa665383b7f15a91e05944ed9b569b"}
- 环境版本（开始）：`git rev-parse HEAD` → `0edb03bd2da92d4513b93d2de957fef371f6e7f2`；`git status --short` → 空输出（退出码 0）。
- 验证者：Codex，GPT-6；独立验证者，未编写本次被测代码。全程在指定 worktree 验证，不修改已跟踪文件。
- 范围：仅复验 `16fd611..HEAD` 的 X9/P4、X10 及其新风险；其余场景沿用第 2 轮本人结论。真实 Electron 窗口与真实按键由另一名验证者负责。

## 检查（逐项追加）

- `cd vibe-remoted && gofmt -l .`：空输出，通过；`go vet ./...`：空输出，退出码 0，通过。原 worktree 的已缓存检查可运行；后续 /tmp 副本需写新缓存时受限，已按要求改用 GOCACHE=/tmp/vr-dm3-gocache。
- `cd desktop && npm run typecheck && npm test`：退出码 0，25 个脚本通过；`test-chat-view checks passed (22)`、`test-sidebar-rename checks passed (15)`、`source bytes check passed (31 files, no NUL)`。没有安装依赖。
- 工具版本：Go 1.26.2 darwin/arm64、Node v22.22.2、npm 10.9.7。
- `ps -axo pid,comm`：没有运行，原因：沙箱返回 `operation not permitted: ps`。全量 race 检查中孤儿清理测试因同一限制失败；这些不计产品问题，也不计通过。后续将精确排除受限的两组，继续运行其他用例。

- 首次全量命令：`cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d /tmp/vr-dm3-XXXXXX) go test -race -count=1 -timeout 20m ./...`，退出码 1；失败仅 `TestOrphanCleanup`（三个子用例，含 pid 91742）与 `TestLoadChatsMarksDaemonRestart`（等待 orphan gone 超时）。config/protocol/server 包通过。失败原因是沙箱禁止 ps，不能完成基于进程身份的孤儿确认。
- `.devflow.yml` check 比较：`git show 16fd611:.devflow.yml` 对照 HEAD；原有 11 个名字无删除，新增 7 个：`TestLatestSessionChecksTranscriptCwd`、`TestLatestSessionReadsUntilFirstCwd`、`TestLatestSessionComparesCanonicalCwd`、`TestTerminalContinueIgnoresOtherDirectorySharingProjectDir`、`TestContinueIgnoresOtherDirectorySharingProjectDir`、`TestTerminalContinueFindsLateOrAliasedCwd`、`TestContinueFindsLateOrAliasedCwd`。`cd vibe-remoted && go test ./internal/chat ./internal/session ./internal/server -list Test` 验证这 7 个均存在，且精确匹配顶层测试名。
- `verification_snapshot.py snapshot --repo . --docs-dir docs/changes --head 0edb03bd2da92d4513b93d2de957fef371f6e7f2 --target 7d25cbdeee006f7ad5bdf01879848274a383bb69`：退出码 0，输出与所给快照逐字相同。
- 差异范围：`git diff 16fd611..HEAD -- . ':!docs/changes'` 实际为 13 个文件，未包含 docs/protocol.md；按实际全部差异审查，未因文件数描述差异漏验。

- 受限后的完整补跑：`cd vibe-remoted && TMPDIR=/tmp TMUX_TMPDIR=$(mktemp -d /tmp/vr-dm3-XXXXXX) go test -race -count=1 -timeout 20m -skip '^(TestOrphanCleanup|TestLoadChatsMarksDaemonRestart)$' ./...`：退出码 0；chat 18.440 s、config 1.539 s、protocol 1.717 s、server 21.437 s、session 26.371 s。只排除这两组，包含 `TestOrphanOwnerBlocksReloadUntilGone` 在内的其他测试全过，无 race 报告。
- 不变规则 check 原样执行（从 `.devflow.yml` 提取整条命令，前置独立 TMUX_TMPDIR）：退出码 1，原因仍是 `TestOrphanCleanup` 的 ps 环境限制；`&&` 后第二段没有运行。然后原样保留两段 `-run` 名字，第一段仅加 `-skip '^TestOrphanCleanup$'`、第二段重新运行，三包均通过（session 5.854 s、server 10.517 s）。原有测试与新增测试均没有删名或放宽断言；受限孤儿清理没有记为通过。
- `TMPDIR=/tmp TMUX_TMPDIR=$(mktemp -d /tmp/vr-dm3-XXXXXX) node .claude/skills/verify/scripts/ws-chat-smoke.mjs`：退出码 0，9 项 PASS，结尾 `all chat checks passed`。临时 daemon / 假 claude 从本 worktree 构建，随机监听端口、独立 state / CLAUDE_CONFIG_DIR / tmux，allowed_roots 仅脚本自己的临时目录；未连接真实 8765 服务。
- /tmp 副本首次独立反例构建没有运行：默认 Go 缓存不能写入新缓存项，返回 `operation not permitted`；设置 `GOCACHE=/tmp/vr-dm3-gocache` 后重新构建并运行成功。副本由本 worktree 的 vibe-remoted 完整复制，新增的仅独立测试，旧反例源码只读复制；未执行其与本轮无关的消息回放测试，也未写回上一轮临时目录。

## P4 的复验（已解决）

命令（cwd 为 `/tmp/vr-dm3-audit-GgHISd/experiment/vibe-remoted`）：`GOCACHE=/tmp/vr-dm3-gocache TMPDIR=/tmp TMUX_TMPDIR=$(mktemp -d /tmp/vr-dm3-XXXXXX) go test -race -count=1 -timeout 5m ./internal/chat ./internal/session ./internal/server -run '^TestIndependent(DirectoryEdges|ContinueLateCwdAndSymlinkWS|ContinueBothCollisionDirsWS|TerminalContinueLateCwd)$' -v`。退出码 0。原第 2 轮反例原样复用，实际关键输出：

- 库：`cwd at line 101 got="late" found=true`；`cwd at line 1001 got="late" found=true`；符号链接别名与真实目录两种查询均选中 `symlink-history`。
- WebSocket：第 101 行（204281 字节）`got=56445ae6-1ef8-48e2-8077-3ea53901bae3 expected=56445ae6-1ef8-48e2-8077-3ea53901bae3`；第 1001 行（2041188 字节）`got=7b93cf7e-5e78-4d96-a3ad-63cf4e32d1c1 expected=7b93cf7e-5e78-4d96-a3ad-63cf4e32d1c1`。记录别名/查询真实、记录别名/查询别名、记录真实/查询别名三个路径全部 got=expected。
- 终端新建：`actual argv=[.../claude --resume 4fb5c24c-10bf-4eb7-a1f5-68edc406052e]`，与历史 id 相同，不再生成新 id。
- P2 回归：`collision a-b => "own-0"`、`collision b => "own-1"`、`collision a.b => "own-2"`；WebSocket 两个碰撞目录也各自接回自己的 id，无接错目录。
- 开发方回归测试守的是同一缺陷：chat 层直接检查第 101 / 1001 行、超长行之后继续找 cwd、别名放在自己的项目目录与别名项目目录；server 层通过 WebSocket 检查 ready.claudeSessionId；session 层检查终端新建和重载的 --resume 参数及 claim。全量 race 与不变规则补跑中这些新增测试均通过。

## X9 边界实验

在 /tmp 副本运行 `GOCACHE=/tmp/vr-dm3-gocache TMPDIR=/tmp go test -count=1 -timeout 5m ./internal/chat -run '^TestDM3(JSONDifferential|CanonicalPaths|AppendDuringRead|Timing)$' -v`，退出码 0。参考读取器去掉 mayHaveCwdKey，用同一 readLine 与 Go JSON 解码器比较返回值；预期的大小写差异单独记录，没有算作等价。

- 普通 cwd、全转义键、单字母转义键、十六进制大小写的转义形式与参考一致。cwd 值为 null / 数字 / 对象 / 空字符串时均跳过、读取后续真实字符串；nested cwd 不选；值中出现 cwd 不当成字段。
- 空白、CRLF、无末尾换行、空行、非 JSON、BOM、超过 16 MiB 的行后紧接 cwd 均与参考一致。BOM 本行被两者拒绝，不阻止读取下一条合法记录；超过 MaxLine 仅跳过该行。
- 严格等价例外：字面键 CWD、Cwd、cWd，Go struct JSON 解码不区分字段大小写，筛行却跳过；三项均 `filtered="" reference=".../work" equal=false`。标准 claude 的顶层字段为小写 cwd，给定反例及小写/转义键不受影响，不能据此认定标准 claude 场景失败；详见备注。
- 文件正在读时追加：50 MiB 前缀开始扫描后 2 ms，另一个 goroutine 追加 cwd，实际 `append while scanning -> ".../work"`，成功。EOF 后再追加属于下次读取，当前调用不等待未来记录。
- alias cwd 放在自己的项目目录里，首轮直接找到，跳过本目录的回退无漏选；别名项目目录由回退找到。不同真实目录、cwd 为文件、cwd 已删、悬空链接均不被认成当前有效工作目录。child/..、末尾 /、符号链接后 /.. 正确解析；解析失败保留 Clean 字面路径，未合并不同有效目录。
- 本机大小写不敏感卷：`A/a sameFile=true`；canonical(A) 为 .../A、canonical(a) 为 .../a；记录 a、查询 A 得 `id="" found=false`。会漏续同一目录的不同大小写写法，没有接错其他目录；请求侧原本 EvalSymlinks、记录侧原本 Clean 都保留大小写，属于既有边界。

## X9 耗时与会话隔离

独立 Timing 实验：自造数据、热页缓存、不带 race，每项连续 3 次。200 文件布局用 199 个硬链接复用 1 MiB 数据，读取字节数不变，属于缓存友好的合成数据，不冒充冷盘或独立物理文件。

| 布局 | 最快 / 最慢 | 判断 |
|---|---:|---|
| 50 MiB、约 300 字节行、cwd 在末行 | 38.0 / 39.6 ms | 与开发方 37–39 ms 同量级 |
| 50 MiB、约 300 字节行、无 cwd | 37.4 / 40.8 ms | 与开发方 39–40 ms 同量级 |
| 50 MiB、约 2000 字节行、末行 / 无 cwd | 15.9–18.8 / 19.2–21.2 ms | 同为几十毫秒 |
| 50 MiB、约 20000 字节行、末行 / 无 cwd | 15.4–16.9 / 13.5–14.1 ms | 同为几十毫秒 |
| 200 文件，199 个别目录 cwd 在首行 | 27.4 / 33.3 ms | 与开发方 15–24 ms 同量级 |
| 同上，199 个 cwd 在末行 | 198.2 / 221.3 ms | 与开发方 154–164 ms 同量级 |
| 同上，199 个完全无 cwd | 200.6 / 233.5 ms | 同为几百毫秒 |

- 大规模独立实验：GOCACHE=/tmp/vr-dm3-gocache TMPDIR=/tmp TMUX_TMPDIR=$(mktemp -d /tmp/vr-dm3-XXXXXX) go test -count=1 -timeout 3m ./internal/server -run '^TestDM3SlowScanIsolation$' -v，退出码 0。80 份约 50 MiB 的合法 JSONL（用硬链接节省空间），均在字符串值中有 cwd、没有顶层 cwd，迫使每行解析；最旧的小文件才有工作目录。实际 logical=4015 MiB physical=50 MiB elapsed=22.785115875s gotExpected=true。确实可能秒级乃至几十秒，50/199 MiB 的测量不是无限数据的上限。
- 扫描同时访问同一临时 daemon：三次 REST list 均 200，耗时 0.176–0.560 ms；另一客户端 WebSocket 鉴权加不带 continue 的对话新建为 11.18 / 16.99 / 11.31 ms，三次均能发送并收到回复。没有让其他会话卡住 10 s；WebSocket 握手在扫描前完成，attach 自身没有完成 deadline，约 22.8 s 后返回正确 id。按本轮规则记性能备注，不拦。
- 调用与锁：CreateChat 按 id 占位后，在 Manager.mu 之外扫描，然后 claimClaudeLocked → chat.Start；终端新建也先扫描再 claim 再 spawn；terminalReloadPlan 取元数据后释放 Manager.mu 才扫描。扫描不持有 Manager.mu、chat.Session.mu 或 Runner.mu；Create 的 creating 占位只让同一 id 的新建/重放等待。终端重载实际替换进程时才取得 Runner.mu，在此之前已完成扫描。先 claim 后 spawn 的顺序未改变。

## 三个占用入口的独立复验

在 /tmp 副本运行 GOCACHE=/tmp/vr-dm3-gocache TMPDIR=/tmp TMUX_TMPDIR=$(mktemp -d /tmp/vr-dm3-XXXXXX) go test -race -count=1 -timeout 2m ./internal/server -run '^TestDM3LateAliasBusyEntrypoints$' -v，退出码 0。先让对话会话持有 claude id，再把其 JSONL 改成第 1001 行才有 cwd、cwd 为真实目录的符号链接别名：

- 对话新建：existing=true got=chat-997291000-1 owner=chat-997291000-1 livePids=1，复用原会话。
- 终端新建：code=claude_session_busy fatal=true，拒绝。
- 终端重载：HTTP=409 code=claude_session_busy ownerMatch=true livePids=1，拒绝且原进程仍唯一。
- 没有重复进程 VIOLATION、没有 race；原占用行为未被 X9 改变。


## X10 的非界面验证

命令：cd desktop && node /tmp/vr-dm3-audit-GgHISd/x10-independent.mjs。实际 index.ts + ChatView 在 jsdom 运行，复用项目夹具，新增 6 组独立实验；退出码 0，checks passed (6)。初次准备脚本用了错误相对路径而没有运行，修正后运行此命令。

- 改名时来权限请求：焦点留在改名框；向当前焦点实发 1/2/3 的 keydown，responses=0；Enter / Esc 结束后焦点在待答卡片。
- .modal-overlay 打开、改名结束：没有聚焦背后的会话。模态框 field/button 已聚焦的情形也由原项目新增测试通过。
- 当前会话的新卡片在模态框打开时出现：实测 stealsFocus=true。第 2 轮代码也无条件聚焦新卡片；tasks.md 后续及 decisions #53 已记录，不计新问题或阻拦项。
- 卡片消失时另一个 input 聚焦：仍在该 input。后台会话卡片出现/消失：当前聊天输入框保持焦点。
- 当前是终端、后台对话卡片出现：helper textarea 保持焦点；终端改名 Esc 后也回到 helper，终端收到的改名键为 0。
- 真实 Electron 按键由另一名验证者负责；jsdom 事件只证明事件路由与焦点决策，不冒充真实窗口输入或布局验证。


## 文档与协议核对

- CLAUDE.md 的新增句子逐项对应代码：项目目录编码以 / 和 . 替换成 -（EncodeProjectDir）；自己的候选按 mtime 降序（newest）；每个文件读取首个合法非空顶层 cwd（transcriptCwd）；两侧 EvalSymlinks、失败回退 Clean（canonicalDir）；没有 cwd 的文件不选；首轮未找到后排除 own 目录、汇总其余候选、按 mtime 降序取最近 10 份（cwdFallbackScan）。对话新建和终端 continue 新建/重载都调用 LatestSessionForWorkdir。新增句子与实际支持的 claude JSONL 行为相符。
- git diff 16fd611..HEAD -- vibe-remoted/internal/protocol desktop/src/shared desktop/src/renderer/rest.ts docs/protocol.md：空输出。Go 的帧/错误码定义、TS 类型、REST 客户端、协议文档均未改；X9 改的是现有 continue 对候选 id 的选择，原有 ready.existing、fatal busy、409 行为保持，独立三入口实验与 v2 黄金帧测试已证明。X10 改焦点路由，仍由原卡片事件发送原 chat_respond/chat_interrupt 帧。不需要新增或改写协议字段。
- 补充 JSON 转义值实验：同一 /tmp 副本运行 GOCACHE=/tmp/vr-dm3-gocache TMPDIR=/tmp go test -count=1 -timeout 1m ./internal/chat -run '^TestDM3JSONDifferential/(value-upperhex|value-lowerhex)$' -v；两个子用例均 equal=true，退出码 0。cwd 的 c/w/d Unicode 码点本身不含 A–F，另以路径中斜杠的 002F / 002f 实测十六进制字母大小写。

## 放松检查

- git diff 16fd611..HEAD -- 'desktop/scripts/*.mjs' '*_test.go' '.claude/skills/verify/scripts/*'：Go 三个测试文件只增加用例（148 / 63 / 71 行，无删除）；未删原有断言、未放宽期望、未调大已有超时。
- HTMLInputElement 挂到 jsdom 全局是补齐浏览器构造器，让卡片快捷键里 instanceof HTMLInputElement 能真的执行；没有替换判断或返回值，没有削弱原测试。
- test-sidebar-rename 顶部假的全局 WebSocket 用来通过实际 openChatSession 接线并记录发出的帧；原来的 fake client 测试仍使用原夹具，原 9 个用例和断言都保留。它没有证明真实网络，网络由独立 ws-smoke/Go WebSocket 用例覆盖。
- 新 GUI X10-rename-chat 的一个分支把 rename HTTP 请求人为延迟 500 ms：所有原 X8/其他用例不受影响，最终断言没有降低。这是新增用例的覆盖范围限制：证明远端较慢响应时的“点击另会话 → 保存 → 切换 → 下一次输入”，不能证明本机快速响应下指针按下至松开间侧边栏重建不会吞掉点击。已在 tasks.md 后续记录；本轮未运行 GUI，真实按键由另一名验证者负责。
- 本验证仅因 ps 环境限制按用户明确要求跳过两组；原 check 和全量命令已先执行并如实保留失败，不把跳过项算通过。无其他放松检查。

## 场景

| 场景 | 验证方式 | 结果 |
|---|---|---|
| R1.5 对话 -c 接该目录历史 | 原 P4 库与 WebSocket 反例；101/1001 行、别名、转义/损坏/超长行边界；新增回归测试 | 成立，P4 已解决 |
| R15.1 会话选择/改名以及终端 -c | 原终端反例、终端新建/重载回归、独立 jsdom 改名焦点；P2 编码碰撞反例 | 非界面部分通过；真实按键由另一名验证者负责 |
| R18.2 配置 continue | 全量补跑、专门不变规则、解析与三个入口实际调用；旧 flag/命令解析代码未变 | 沿用第 2 轮基础行为；本轮 late/alias 查找正确 |
| R2.6/单进程约束 | late+alias 已被占用时独立 WS 对话新建、终端新建、REST 终端重载；原并发/交接/重载专门测试 | 复用 / fatal busy / 409，只有一个进程 |
| R5 权限卡片键盘路径 | jsdom 向改名焦点派发 1/2/3；切到待答会话、卡片消失、模态框和其他输入框测试 | 本轮非界面部分通过；真实窗口由另一名验证者负责 |
| R16.3 后台黄点后点开/回答 | 实际 openChatSession 回调；后台卡片不抢焦点、打开后给卡片、回答后给输入框；npm 新用例 | 非界面部分通过；真实点击/按键由另一名验证者负责 |
| R17 终端回归 | npm 原终端脚本、Go 原用例和黄金帧；jsdom 终端聚焦；continue 占用 | 已运行部分通过；GUI 原用例沿用第 2 轮 |
| 其余 R1–R19 场景 | 本轮未重做全套 | 沿用第 2 轮本人结论（除 P4 外没有阻拦项） |

## 完成条件

| 条件 | 判断 | 依据 |
|---|---|---|
| 本轮解决 P4，无新增需拦的用户问题 | 成立 | 原反例三层复验、边界实验和三个占用入口均通过；秒级扫描记备注 |
| R1–R19 全部验收 | 本轮受影响的非界面部分成立；其余沿用第 2 轮；界面尚未在本报告验证 | 范围受限复验，真实 Electron 由另一名验证者负责 |
| gui-smoke 新增对话端到端 / 真实按键 | 由另一名验证者负责 | 按分工未运行 gui-smoke、gui-chat-smoke，未启动 Electron |
| make check 对应检查 | 可运行部分成立，完整检查尚未验证 | gofmt/vet/typecheck/npm 通过；全量 race 的两组孤儿检查缺 ps 条件，其他全部通过；未额外声称 make check 全绿 |
| protocol-sync 三处一致 | 沿用第 2 轮成立 | 协议相关差异为空，行为未改变字段；黄金帧及 WS 检查通过 |
| 原终端断言原样通过 | 已运行非界面部分成立 | 原断言无削弱，npm、race 补跑通过，GUI 由另一个验证者负责 |

## 问题

没有新增阻拦问题。备注 2 项，均不拦：

1. 扫描无总量上限，大量缺 cwd、且必须做 JSON 解码的历史能让该次 -c 新建等待几十秒。严重程度：低。证据：80 × 50 MiB 热缓存合成历史，22.785 s；同一 daemon 的其他会话仍可毫秒级握手、新建、发消息。按用户“秒级记备注、其他会话卡住 10 s 才考虑拦”的标准不拦。宜避免把 50/199 MiB 的合成数字称为无界数据的最坏上限。
2. 筛行与 Go 逐行解码不严格等价：字面键 CWD/Cwd/cWd 被筛掉，Go 原 struct 解码会读取。严重程度：低，兼容边界；不拦。证据：三个独立差分用例 filtered 空、reference 为真实目录。原 P4 及标准 claude 小写 cwd 均正确；未证明真实 claude 会产出这些大小写字段，不声称用户当前会遇到失败。开发记录中“完全相同”的表述需限定为小写 cwd 及它的 JSON 转义写法。

## 待验证项

- TestOrphanCleanup、TestLoadChatsMarksDaemonRestart：当前沙箱禁止 ps，仍尚未验证；在允许读取进程身份的环境原样跑完整 race 与不变规则。不是产品缺陷，不算通过。
- 本轮真实 Electron、X10 真实按键由另一名验证者负责；本报告不代替其结论。
- 冷盘、机械盘/网络盘、真实 claude JSONL 与远程 Linux 仍沿用第 2 轮待验证项；不是本轮阻拦理由。
- 模态框打开时卡片抢焦点、低延迟重建侧边栏吞点击均已在 tasks.md 后续，本轮观察与该记录一致，不计新问题。


## 不变规则完整命令记录

前置 TMPDIR=/tmp 与独立 TMUX_TMPDIR 后原样执行：

```sh
cd vibe-remoted && go test -race ./internal/chat -run 'TestSingleProcess|TestOrphanCleanup|TestLatestSessionChecksTranscriptCwd|TestLatestSessionReadsUntilFirstCwd|TestLatestSessionComparesCanonicalCwd' && go test -race ./internal/session ./internal/server -run 'TestReloadWaitsForOldProcess|TestChatCreateReplaySameID|TestContinueReusesRunningSession|TestConcurrentContinueCreatesOneProcess|TestRestartRefusedWhenUResumedElsewhere|TestHandoffVsReloadOneWins|TestReloadVsDeleteSerialized|TestTerminalContinueBusyWhenChatOwns|TestTerminalContinueClaimsLatest|TestTerminalContinueIgnoresOtherDirectorySharingProjectDir|TestContinueIgnoresOtherDirectorySharingProjectDir|TestTerminalContinueFindsLateOrAliasedCwd|TestContinueFindsLateOrAliasedCwd'
```

结果：退出码 1，只因 TestOrphanCleanup 的 ps 限制；第二段受 && 影响没有运行。保留相同两个 -run 列表，第一段另加 -skip '^TestOrphanCleanup$' 后通过（chat 2.566 s），再运行完整第二段通过（session 5.854 s、server 10.517 s）。

## 结束核对与清理

- 所有本次 exec 会话均已结束：全量 race 和原样 invariant 的退出码为 1（已解释的环境限制）；补跑、WebSocket 冒烟、原 P4 反例、JSON/路径/耗时实验、三个占用入口、jsdom 实验均退出码 0。
- 冒烟脚本退出前已 await 临时 daemon 的退出，假 claude 的停止由 Manager.Shutdown / 测试 cleanup 确认。测试失败日志中的 pid 91742、94586 用 os.kill(pid, 0) 查询均为 ProcessLookupError（已退出）；没有发现不能结束的本次 PID。结束时 ps -axo pid,comm 仍被沙箱拒绝，所以没有声称做了全系统进程枚举。
- 从本次日志识别出的独立 tmux 目录 vr-dm3-96snKh、vr-dm3-fYYFUX 分别带对应 TMUX_TMPDIR 查询，均 no server running。没有查询或操作默认 socket 目录，没有向非本次启动的进程发信号。
- 自造的 JSONL/慢扫描数据在 /tmp 的 t.TempDir 内，测试结束由清理函数删除；保留 /tmp/vr-dm3-audit-GgHISd 的测试源码与摘要日志供复核、/tmp/vr-dm3-gocache 为编译缓存。上一轮临时目录只读，没有改写。首次指定全量 Go 命令沿用系统临时目录，补跑与本轮独立实验统一 TMPDIR=/tmp；均没有读取真实 claude 配置或用户会话数据。
- 临时副本与 HEAD 的 70 个已跟踪 daemon 文件逐字比较，差异为 []；额外文件只有独立实验测试源码，因此实际被测产品代码与本 worktree HEAD 一致。
- 环境版本（结束）：git rev-parse HEAD → 0edb03bd2da92d4513b93d2de957fef371f6e7f2；git status --short → 空输出；git diff --exit-code HEAD -- . → 空输出、退出码 0。已跟踪文件未改变，提交未漂移。
- 最终范围结论：通过，有备注；P4 已解决；新增阻拦问题 0 条，备注 2 条。其余场景沿用关口 C 第 2 轮本人结论；真实界面结论由另一名验证者提供。


---

# 关口 C 第 3 轮 · 验证结论全文（二）：界面部分（同模型的全新验证者）

# 独立验证结论（界面部分，关口 C 第 3 轮，范围受限的复验）

- 结论：**通过，有备注**（X10 说的两件事——改名结束后键盘回到当前会话、点开带待答卡片的会话后键盘在卡片上——在真实应用里都做到了，改名中来权限请求不再被名字里的数字误答；没有发现这一轮新引入的问题。1 个不拦的问题：用鼠标点卡片按钮、用「否 + 说明」或提问卡片的「提交回答」作答后，焦点仍停在页面上，和返工说明写的不完全一致。详见「问题」「备注」）
- 提交：0edb03bd2da92d4513b93d2de957fef371f6e7f2
- 验证快照：`{"schema":1,"docs_dir":"docs/changes","head":"0edb03bd2da92d4513b93d2de957fef371f6e7f2","head_tree":"7045e554bc63150ae3c89f739d502bc49c139688a5d84b075208f68d76417e84","target":"7d25cbdeee006f7ad5bdf01879848274a383bb69","target_tree":"4d0d58c229e8bd52a71ea65ae7e10f56c3fa665383b7f15a91e05944ed9b569b"}`
- 验证者：Claude（Anthropic，模型 Fable 5，`claude-fable-5-2[1m]`），同模型的全新验证者；没写过这段代码，没有派子 agent。只负责界面部分；X9（Go 侧）由另一名验证者负责。
- 范围：只判断 `16fd611..0edb03b` 的改动在界面上有没有做到它说的、有没有引入用户会遇到的新问题；其余场景沿用第 2 轮界面结论。

## 环境版本

worktree：`/Users/mac/github/vibe-remote/.devflow-tmp/verify-dm-gui`（detached）。被测应用是从这个 worktree 构建的（`npx vite build` → `desktop/dist/`，由冒烟脚本执行）。

```
开始时
$ git rev-parse HEAD
0edb03bd2da92d4513b93d2de957fef371f6e7f2
$ git status --short
（无输出）
```

Electron 44.7.0，Node v22.22.2，Go 1.26.2，macOS（darwin/arm64）。

## 检查

两份 GUI 冒烟逐个运行（脚本自己先 `npx vite build` 构建 `desktop/dist/`），每次各带独立的 `TMUX_TMPDIR=$(mktemp -d /tmp/vr-dmg3-XXXXXX)` 和一个空的临时 `CLAUDE_CONFIG_DIR`，开跑前用 `ps -axo pid,comm | grep 'Electron$'` 确认没有别的 Electron 测试实例。协议 2 的基准 daemon：`git archive 7d25cbd vibe-remoted | tar -x -C /tmp/vr-dmg3-lGPeDW/main-src` 后 `go build`，经 `VR_MAIN_DAEMON` 传入（没有用脚本默认的 `git worktree add`）。

| # | 命令 | 结果 |
|---|------|------|
| 1 | `node .claude/skills/verify/scripts/gui-smoke.mjs` | 30 PASS / 0 FAIL，exit 0 |
| 2 | 同上 | 30 PASS / 0 FAIL，exit 0 |
| 3 | `DEVFLOW_EVIDENCE_DIR=<gate-c-dm3/shots/script> VR_MAIN_DAEMON=<上面构建的 daemon> node .claude/skills/verify/scripts/gui-chat-smoke.mjs` | 37 PASS / 0 FAIL，exit 0（含 `X10-prompt`、`X10-rename-chat`、`X10-rename-terminal` 三条新用例） |
| 4 | 同上 | 37 PASS / 0 FAIL，exit 0 |

- 4 次都一次通过，已知偶发的 R1.1、R7、R13.2 / R14.2 这次没有出现，所以没有重跑记录；`gui-smoke` 的拖选用例两次都没有触发重做（日志里没有 `NOTE drag-select`）。
- 日志：`gate-c-dm3/scripts-gui/logs/`（`gui-141539.log`、`gui-141553.log`、`chat-141602.log`、`chat-141702.log`、`run-smokes.out`）；脚本截图在 `gate-c-dm3/shots/script/`。
- `make check`、Go 测试、协议层：不在我的分工（另一名验证者负责），没有运行。

## 手工验证用的临时实例

2 个临时 daemon + 1 个我自己的 TCP 代理 + 1 个 Electron，全部在 `/tmp/vr-dmg3-lGPeDW/` 下：`v-term`=/bin/bash；`v-chat`=假 claude（`claude_flags`：`-c`、`--dangerously-skip-permissions`）；`v-proxy`=放在 `v-chat` 前面的 TCP 代理（同一个 daemon，可加往返延迟，用来模拟远程 daemon）。各自独立的 `TMUX_TMPDIR`、`state_dir`、`CLAUDE_CONFIG_DIR`，`allowed_roots` 只有该目录下的子目录；Electron 用临时 userData + `--use-mock-keychain` + 随机调试端口，窗口 1280×800。夹具沿用第 2 轮验证者的 `harness.mjs` / `lib.mjs`（复制到我自己的目录后改）。所有操作经裸 CDP 的 `Input.dispatchMouseEvent`（按下 / 松开，侧边栏单击按住 60 ms）、`Input.dispatchKeyEvent`、`Input.insertText` 发给这个实例；「另一台桌面」是直连 daemon 的 WebSocket 客户端，用来在后台会话里触发权限请求。「焦点」一列是当时的 `document.activeElement`：`chat-perm` / `chat-plan` / `chat-question` = 卡片本身，`chat-input` = 对话输入框，`xterm-helper-textarea` = 终端，`BODY` = 不在任何地方。驱动脚本在 `gate-c-dm3/scripts-gui/`（不含 token）。

## X10 的复验

### A. 后台对话会话出现待答卡片（黄点）→ 真实单击侧边栏打开 → 不点卡片直接按键

每次都是：当前会话是 `main`，另一个客户端在后台会话里触发请求，等侧边栏该会话变黄点，700 ms 后真实单击它的名字，400 ms 后记录焦点并直接按键；卡片关闭后不点击、直接 `insertText` + 回车发下一条。脚本 `a01.mjs`、`a02.mjs`。

| 卡片 / 按键 | 次数 | 打开后的焦点 | 按键结果 | 卡片关闭后直接打字 |
|---|---|---|---|---|
| 权限（无建议）按 `1` | 3 | 3/3 在卡片（`chat-perm`） | 3/3 卡片关闭、工具 `Bash:ok`、回复 `done Bash` | 3/3 焦点在 `chat-input`，消息发出并得到回复 |
| 权限（带「不再询问」）按 `2` | 3 | 3/3 在卡片 | 3/3 卡片关闭、工具执行，假 claude 记下规则 `Bash(echo …)` | 3/3 同上 |
| 权限（带建议）按 `3`（否） | 3 | 3/3 在卡片 | 按 3 后焦点进「说明」文本框；在里面敲「原因」+ 数字键 1 2 3 → 文本框内容 `原因123`，卡片仍是 `open`（数字是文字，没有被当成选项）；回车 → 卡片关闭，claude 回 `denied: 原因123` | **0/3**：焦点在 `BODY`，打的字没有进任何地方（见问题 1） |
| 权限（无建议）按 `2`（否）+ 回车 | 3 | 3/3 在卡片 | 3/3 焦点进说明框，回车后卡片关闭、工具标失败 | **0/3**：焦点在 `BODY`（见问题 1） |
| 权限 按 `Esc` | 3 | 3/3 在卡片 | 3/3 卡片关闭，「Bash 的请求已中断 / 已中断」，工具没有执行 | 3/3 焦点在 `chat-input`，消息发出 |
| 权限 鼠标点「是」 | 3 | 3/3 在卡片 | 3/3 卡片关闭、工具执行 | **0/3**：焦点在 `BODY`（见问题 1） |
| 权限 鼠标点说明框、打字、点「否」 | 3 | 3/3 在卡片 | 说明框里敲「先别动」+ 数字键 2 → `先别动2`（是文字）；3/3 `denied: 先别动2` | **0/3**：焦点在 `BODY`（见问题 1） |
| 计划 按 `1` | 3 | 3/3 在卡片（`chat-plan`） | 3/3 `plan approved`，模式变「自动编辑」 | 3/3 焦点在 `chat-input`，消息发出 |
| 计划 按 `2` | 1 | 在卡片 | `plan approved`，模式「编辑前询问」 | 焦点在 `chat-input`，消息发出 |
| 计划 按 `3`（继续完善） | 1 | 在卡片 | 焦点进说明框，敲「把第二步拆细」+ 数字键 1 2 → `把第二步拆细12`（文字，卡片仍 `open`）；回车 → 对话里出现 `revising: 把第二步拆细12`，新的计划卡片出现且**焦点直接在新卡片上**，直接按 1 → `plan approved` | 焦点在 `chat-input`，消息发出 |
| 计划 按 `Esc` | 1 | 在卡片 | 「ExitPlanMode 的请求已中断」 | 焦点在 `chat-input`，消息发出 |
| 提问（单选 + 多选 + 「其他」）全键盘 | 3 | 3/3 在卡片（`chat-question`） | 在卡片上按 1、2：什么都没发生（提问卡片没有数字选项，没有选中任何项、提交仍禁用）。Tab 顺序：单选组 → 第 1 题「其他」文本框 → Red → Blue → Green → 第 2 题「其他」复选框 → 「其他」文本框 → 「提交回答」；空格勾选、↓ 在单选组里移动。在「其他」文本框里敲「青色」+ 数字键 1 2 → 内容 `青色12`，并自动勾上「其他」（**数字是输入的文字**）。Tab 到提交按钮按回车（2 次）/ 空格（1 次）→ claude 收到 `"Pick a fruit"="Banana"`（第 2 次是「其他」里的 `榴莲7`）、`"Pick colors"="Red, Green, 青色12"` | **0/3**：焦点在 `BODY`（见问题 1） |
| 提问 按 `Esc`（焦点在卡片 1 次、在「其他」文本框里打字时 1 次） | 2 | 在卡片 | 2/2「AskUserQuestion 的请求已中断」 | 2/2 焦点在 `chat-input`，消息发出 |

- 截图：`a01-direct-opened-from-yellow-dot`（从黄点点开后的权限卡片；卡片本身的焦点没有可见的外框，「是」的底色是主选项样式）、`a01-direct-card-with-always`、`a01-direct-deny-note-digits`、`a01-direct-after-esc`、`a02-direct-plan-opened-from-yellow-dot`、`a02-direct-plan-revised-card`、`a02-direct-question-opened-from-yellow-dot`、`a02-direct-question-filled-by-keyboard`。
- 第 2 轮备注 4（点开「等你处理」的会话后 1 / 2 / Esc 没反应）：**已解决**，三种卡片共 32 次打开（权限 21、计划 6、提问 5），焦点 32/32 在卡片上，键盘可直接回答。
- 打开带黄点会话的第一次单击：等 700 ms 再点的 17 次里丢 0 次。另有一轮我没有等、在黄点出现的同一瞬间就点，那一轮 30 次切换会话的单击（15 次回 `main`、15 次打开黄点会话，没有分开统计）共丢了 5 次——侧边栏正在重建时按下和松开落在不同元素上（`tasks.md`「后续」已记录的既有问题，这一轮没有改侧边栏重建）。

同样的操作经 `v-proxy`（每个方向加 100 ms，往返约 200 ms，模拟远程 daemon）各 3 次：按 `1` 3/3、按 `Esc` 3/3 的结果与本机相同（焦点在卡片 → 回答 → 焦点到 `chat-input` → 直接打字发出）；鼠标点「是」3/3 仍是卡片关闭后焦点在 `BODY`。

### B. 当前会话（已在前台）来了权限请求：焦点原来在输入框里，正打着半句话

当前会话 `q1`，真实点击输入框后打「半句话N 把超时改成」，另一个客户端触发权限请求。5 次（脚本 `b01.mjs`，截图 `b01-head-card-while-typing`）：

| # | 卡片出现后 | 接着按键 | 卡片关闭后 | 不点击接着打「 接着打完」+ 回车 |
|---|---|---|---|---|
| 1（按 1） | 焦点从 `chat-input` 到卡片；输入框被卡片替换（看不见），草稿还在 | 敲字母 x、y：没有任何反应（卡片仍 `open`，草稿没变，这两个字母丢了）；按 1 → 允许 | 焦点回到 `chat-input`，草稿「半句话1 把超时改成」还在 | 发出的消息是「半句话1 把超时改成 接着打完」 |
| 2（按 Esc） | 同上 | x、y 丢了；Esc → 请求中断 | 焦点回到 `chat-input`，草稿还在 | 发出「半句话2 把超时改成 接着打完」 |
| 3（按 2 + 说明 + 回车） | 同上 | x、y 丢了；2 → 说明框 →「不行」回车 → 拒绝 | 焦点在 `BODY`，草稿还在（见问题 1） | 字没有进任何地方，回车没有发出；要先点一下输入框 |
| 4（没注意到卡片，继续敲数字 1、0，本想打「10」） | 同上 | **敲 1 = 允许**：卡片关闭、工具执行（`Bash:ok`） | 焦点回到 `chat-input` | 0 进了输入框：「半句话4 把超时改成0 接着打完」（见备注 2，基准上相同） |
| 5（按 1） | 同 1 | 同 1 | 同 1 | 发出「半句话5 把超时改成 接着打完」 |

结论：卡片出现时把键盘从输入框拿走（这是 16fd611 就有的行为，这一轮没改）；草稿 5/5 保留；用 1 / Esc 回答后焦点 4/4 回到输入框、草稿还在、可以接着打；用「否 + 说明」回答后焦点在 `BODY`（问题 1）。

### C. 连续两个待答请求（`multi`，两个 Bash 请求同时待答）

在当前会话里打 `multi` 回车，5 次（`b01.mjs`，截图 `b01-head-multi-first-card`、`b01-head-multi-second-card`）：

| 第一个请求怎么答 | 次数 | 第二张卡片出现后的焦点 | 不点击直接按 1 | 之后直接打字 |
|---|---|---|---|---|
| 按 1 | 3 | 3/3 在新卡片（`chat-perm`，命令 `echo two`；第一张标「还有 1 个请求」） | 3/3 卡片关闭，回复 `multi done` | 3/3 焦点 `chat-input`，发出 |
| 按 2 + 说明 + 回车（拒绝） | 1 | 在新卡片 | 关闭，`multi done` | 发出 |
| 鼠标点「是」 | 1 | 在新卡片 | 关闭，`multi done` | 发出 |

### D. 改名结束后的键盘焦点（第 2 轮备注 3）

真实双击（按下 40 ms、间隔 90 ms）打开改名框，⌘A 后 `insertText` 新名字；之后**不点击**直接打字。脚本 `c01.mjs`，截图 `c01-head-chat-renaming`、`c01-head-chat-typed-after-enter`、`c01-head-term-typed-after-enter`。

| 会话 | 结束方式 | 次数 | 名字 | 结束后的焦点 | 直接打字的结果 |
|---|---|---|---|---|---|
| 对话（当前会话 `ren1`） | 回车 | 3 | 3/3 保存（侧边栏 + REST） | 3/3 `chat-input`（当前会话） | 3/3 消息出现在当前会话并得到回复 |
| 对话 | Esc | 3 | 3/3 没变 | 3/3 `chat-input` | 3/3 同上；没打完的名字没有留在输入框里 |
| 对话 | 改名中点击对话输入框 | 3 | 3/3 保存（失焦即提交） | 3/3 `chat-input`（点到哪里就在哪里） | 3/3 消息出现在当前会话 |
| 对话 | 改名中点击对话区空白处 | 3 | 3/3 保存 | 3/3 `chat-input`（点的地方不能聚焦，焦点被交回当前会话） | 3/3 消息出现在当前会话 |
| 终端（当前会话 `alpha`） | 回车 | 3 | 3/3 保存 | 3/3 终端（`xterm-helper-textarea`） | 3/3 命令在终端里执行（`TE1_42_alpha` 等） |
| 终端 | Esc | 3 | 3/3 没变 | 3/3 终端 | 3/3 命令执行 |
| 终端 | 改名中点击终端区域 | 3 | 3/3 保存 | 3/3 终端 | 3/3 命令执行 |

- 对话 12 次改名：对话里没有任何一条用户消息是名字；另一个客户端看到的 user 帧正好是我打的 12 条 `echo`（名字没有被发给 claude）。终端 9 次改名：shell 屏幕里没有出现任何名字。
- 第 2 轮备注 3（改名回车 / Esc 后焦点在 `BODY`）：**已解决**，18/18。

### E. 改名中点击另一个会话（提交改名并切换）——第 4 步要求的「不延迟」实测

改名框开着、已打好新名字，对另一个会话的名字做**一次**真实点击（不重试），1.2 秒后看结果，再不点击直接打字。脚本 `c02.mjs`，截图 `c02-local60-chat-after-click-other`。

| daemon | 按住时长 | 会话 | 次数 | 名字保存 | 切过去了 | 焦点 | 直接打字进了哪里 |
|---|---|---|---|---|---|---|---|
| 本机直连 | 60 ms（接近人手） | 对话 `ren1` → 点 `ren2` | 5 | 5/5 | **0/5** | `chat-input`（仍是当前会话 `ren1`） | 5/5 进了屏幕上显示的 `ren1` 的输入框 |
| 本机直连 | 60 ms | 终端 `alpha` → 点 `beta` | 5 | 5/5 | **0/5** | 终端（`alpha`） | 5/5 命令在屏幕上显示的 `alpha` 里执行 |
| 本机直连 | 0 ms（CDP 连发按下 / 松开） | 对话 | 5 | 5/5 | 5/5 | `chat-input`（`ren2`） | 5/5 进了 `ren2`（新的当前会话） |
| 本机直连 | 0 ms | 终端 | 5 | 5/5 | 5/5 | 终端（`beta`） | 5/5 在 `beta` 里执行 |
| 经代理，往返约 100 ms | 60 ms | 对话 | 5 | 5/5 | 5/5 | `chat-input`（`ren2`） | 5/5 进了 `ren2` |
| 经代理，往返约 20 ms | 100 ms | 对话 | 5 | 5/5 | **0/5** | `chat-input`（`ren1`） | 5/5 进了 `ren1` |
| 经代理，往返约 20 ms | 60 ms | 对话 | 5 | 5/5 | **0/5** | 同上 | 同上 |
| 经代理，往返约 50 ms | 60 ms | 对话 | 5 | 5/5 | 5/5 | `chat-input`（`ren2`） | 5/5 进了 `ren2` |
| 经代理，往返约 50 ms | 120 ms（慢一点的点击） | 对话 | 5 | 5/5 | 3/5 | 切过去的 3 次在 `ren2`，没切过去的 2 次在 `ren1` | 都进了屏幕上显示的那个会话 |

如实描述：这次点击有没有生效，取决于「改名请求 + 列表刷新（两次往返）」和「松开鼠标」谁先完成。daemon 近（本机、往返 20 ms；往返 50 ms 时按得慢一点也会）而按住时间是人手的 60–120 ms 时，侧边栏在松开之前就重建了，点击被吞：名字保存了，**没有切换会话**，高亮和主区域都还是原来的会话，键盘也回到这个会话，所以字不会打进看不见的会话——用户看到的是「点了没反应」，再点一次即可。往返时间超过按住时长的一半左右（往返 100 ms、按住 60 ms）时点击生效，切换后键盘在新会话里。基准 16fd611 上同样被吞（见「基准对照」），不是这一轮引入的。

### F. 改名进行中、当前会话来了权限请求

当前会话 `dlg1` 正在改名（改名框里已有「名字N-」），另一个客户端在这个会话里触发权限请求。3 次（`d01.mjs`，截图 `d01-head-renaming-while-card-arrives`、`d01-head-after-rename-card-focused`）：

| # | 卡片出现后 1.5 秒（每 100 ms 采样） | 在名字里敲数字键 1 2 3 | 结束改名 | 之后不点击 |
|---|---|---|---|---|
| 1 | 15/15 次采样改名框都在且持有焦点；卡片已显示在主区域 | 改名框 `名字1-123`；卡片仍 `open`，工具仍是等待确认，daemon 侧 0 个回答 | 回车 → 名字保存为 `名字1-123`，焦点到卡片（`chat-perm`） | 按 1 → 卡片关闭、工具执行；再直接打字 → 发出 |
| 2 | 同上 15/15 | `名字2-123`；0 个回答 | 回车 → 保存，焦点到卡片 | 按 Esc → 请求中断；直接打字 → 发出 |
| 3 | 同上 15/15 | `名字3-123`；0 个回答 | Esc → 名字不变（改名的 Esc 没有中断请求，卡片仍 `open`），焦点到卡片 | 按 1 → 执行；直接打字 → 发出 |

名字里的 1 / 2 / 3 **没有**被当成对权限请求的回答（3/3）；改名结束后卡片直接可用键盘回答（3/3）。

### G. 改名进行中、后台会话来了权限请求或新消息

当前会话 `dlg1` 正在改名，后台会话 `p1` 来了权限请求（2 次，其中 1 次跨过一次 5 秒列表刷新，共观察 6.5 秒）或一条新消息（1 次）。3/3：改名框全程持有焦点（63/63、15/15、15/15 次采样），敲的 1、2 进了名字（`后台1-12` 等），`p1` 的请求在 daemon 侧仍是 `waiting`（没有被回答）；当前会话没有被切走。改名期间侧边栏暂停重建，`p1` 的黄点在回车之后才出现（第 2 轮已记录的既有行为）。回车后焦点在当前会话的 `chat-input`，直接打字发到当前会话。随后点开 `p1`：焦点在卡片，按 Esc 关闭。

### H. 有对话框打开时

`e01.mjs`，截图 `e01-head-manager-open-card-arrives`、`e01-head-picker-open-request-arrives`。

| 情况 | 次数 | 实际结果 |
|---|---|---|
| 新建会话对话框开着，刚才的会话来了权限请求 | 3 | 对话框只能从机器概览页打开，此时没有「当前会话」（所有会话视图都隐藏）。3/3：焦点一直在对话框里（`picker-ui-terminal`），敲 1、2 没有回答请求（daemon 侧 0 个回答），Esc 关的是对话框；该会话在侧边栏亮黄点。之后点开它，焦点在卡片，Esc 可用 |
| 删除确认框（系统 `confirm`）开着，当前会话来了权限请求 | 2 | 确认框期间页面不处理消息；取消后卡片出现，焦点在卡片，直接按 1 → 执行（2/2） |
| 机器管理对话框开着（会话视图仍在后面显示），正在「地址」栏打字，当前会话来了权限请求 | 3 | **3/3 卡片把焦点从对话框的文本框里拿走**（`modal:INPUT` → `chat-perm`）。接着敲 `1`（本想把地址打成 10.0.1.2）→ **权限请求被允许**（卡片关闭、工具执行，daemon 侧 1 个回答），地址栏仍是 `10.0.`。基准 16fd611 上是否相同见「基准对照」 |
| 机器管理对话框开着，当前会话的卡片被别处回答而消失 | 2 | 2/2 焦点留在对话框的文本框里，接着打的字进了文本框（`机器甲1`）；关闭对话框后焦点在侧边栏的齿轮按钮上（对话框既有的「还原到打开前的焦点」，不在会话里） |

### I. 窗口失焦再聚焦；切到别的会话再切回来

关掉 CDP 的焦点模拟，经主进程把我自己的应用真的隐藏再显示（`app.hide()` → `app.show()` + `app.focus()`，最接近 ⌘H 后点 Dock 图标）。`f01.mjs`（`head-appshow` 一轮）、`f02.mjs`，截图 `f01-head-appshow-back-to-window-card-focused`。

| 情况 | 次数 | 失焦前焦点 | 回来后焦点 | 不点击直接操作 |
|---|---|---|---|---|
| 对话会话、无卡片、输入框里有草稿 | 3 | `chat-input` | 3/3 `chat-input` | 真实按键 k、j 和 `insertText` 都接在草稿后面 |
| 应用隐藏期间当前会话来了权限请求 | 3 | `chat-input` | 3/3 在卡片（隐藏期间 `activeElement` 还是输入框，窗口回来后变成卡片）；隐藏期间该会话亮黄点 | 按 1（2 次）→ 执行；按 Esc（1 次）→ 中断；随后直接打字都发出 |
| 卡片已在且持有焦点，再失焦 / 聚焦 | 1 | 卡片 | 卡片 | 按 1 → 执行 |
| 终端会话 | 2 | 终端 | 2/2 终端 | 命令执行 |

- 其它离开 / 回来的方式（各 1 次）：`w.blur()` → `w.focus()`、最小化 → 还原，焦点都留在输入框，真实按键进输入框。
- 驱动方式带来的一个现象（不是用户路径）：应用隐藏时如果直接对窗口调 `w.show()`（而不是 `app.show()`），回来后 `activeElement` 变成侧边栏第一个按钮，真实按键不进会话。这是 Chromium / AppKit 在窗口这样被显示时的「初始焦点」，和 X10 的代码无关；用 `app.show()` 不出现。第一轮我用了这种方式，那一轮的结果作废，没有计入上表。

| 切换会话 | 次数 | 结果 |
|---|---|---|
| 有卡片的会话（权限 / 提问 / 计划各 1 次）：切到别的会话（终端 1 次、对话 2 次）再真实单击切回 | 3 | 切走后焦点在目标会话（终端 / `chat-input`）；切回后 3/3 焦点在卡片；不点击直接按 1 / Esc / 2 → 卡片关闭；随后直接打字发出 |
| 没有卡片、输入框里有草稿：切走再切回 | 3 | 切到终端后直接敲命令在终端执行；切回后 3/3 焦点在 `chat-input`，草稿还在，直接打字接在草稿后面 |

### J. 终端会话（X10 改了 `focusView`）

`g01.mjs`、`g02.mjs`，截图 `g01-head-term-drag-select-after-rename`。2 次：

- 真实单击侧边栏打开终端会话：焦点在终端，直接敲 `echo OPENn_$((6*7))_OK 中文✓` → 输出 `OPENn_42_OK 中文✓`（2/2）。
- 双击改名 + 回车后**不点击终端**：焦点在终端；直接敲命令打开鼠标上报（`printf '\033[?1000h\033[?1006h'`；另行核对：打开后按住 ⌥ 悬停 `.xterm` 才带 `enable-mouse-events`，不按 ⌥ 不带），真实拖选一行 + ⌘C → 剪贴板正好是 `COPY_TARGET_n`（2/2，另一次单独核对 1/1）；⌘V + 回车 → `PASTEDn_9_OK`（2/2）。
- 改名后直接敲命令见 D 节（终端 9/9）。剪贴板的文本内容测前读出、测后写回。

## 回归抽查

`r01.mjs`，截图 `r01-head-x7-sent-while-scrolled-up`、`r01-head-x8-background-rename`、`r01-head-continue-late-cwd-history`、`r01-head-x6-after-focus`。

| 项目 | 次数 | 实际结果 |
|---|---|---|
| X7 不贴底时发消息 | 2 | `burst 30` 后真实滚轮上滑到距底 300px，点输入框打字回车 → 自己的消息和回复都出现，视图回到底部（距底 0 / 1px），最后一条回复在可视区（2/2） |
| X8 已打开的会话双击改名 | 1 + D 节 21 次 | 已打开的后台对话会话：真实双击 → 改名框出现并持有焦点，回车后 REST 名字已变、该会话成为当前会话、焦点在它的输入框；对话里没有用户消息，另一个客户端没有收到任何新对话帧（名字没有被当成消息发出去）。D 节的 12 次对话改名、9 次终端改名同样没有把名字发进会话 |
| X6 失焦时当前会话的黄点 | 2 | 应用真的隐藏（`document.hasFocus()=false`）时当前会话收到权限请求：该会话 `data-dot=waiting` 且点可见（rgb(150,100,38)），日志 `[notify] fallback: v-chat · q1`，Dock 角标 `•`，当前会话没有被切走；窗口回来后点消失、角标清空，焦点在卡片，直接按 1 → 执行（2/2）。I 节的 3 次同样看到隐藏期间的黄点 |
| 界面上带「-c」新建对话会话：目录 `late`（我造的 JSONL，前 150 行是不带 `cwd` 的 `queue-operation` 记录，之后 12 轮对话） | 1 | 新建对话框里进目录 → 点「对话」→ 勾选 `-c` →「在此打开」：界面上显示出 12 条历史用户消息（第一条「晚到的历史提问 #1」，最后有「晚到的历史回答 #12」）；假 claude 的启动参数是 `… "--resume","<这份 JSONL 的 id>"`，没有 `-c`、没有 `--session-id`；再发一条接在历史后面（用户消息 13 条，回复正常，贴底） |
| 同上：目录 `hist`（400 轮历史） | 1 | 界面显示出历史（首屏生成最近 150 轮，最后一条「历史提问 #0400」「历史回答 #400」，贴底）；参数是 `--resume <id>` |

X9 修的那条读取上限在界面流程上表现正常（`cwd` 第一次出现在第 151 行的历史能接上）；Go 侧的边界由另一名验证者负责。

## X10 的复验（续）

### K. 用真实按键事件重做「不点击直接打字」（对上面各节的校正）

做到一半时发现一个会让结论偏乐观的测量问题：A–I 节里「直接打字」用的是 CDP 的 `Input.insertText`，它**不是可靠的焦点探针**——文字会落进页面里持有选区的那个文本框，即使 `document.activeElement` 是 `BODY` 或某个按钮，并且落进去之后把焦点也带过去（`h02.mjs`：鼠标点「是」后焦点在 `BODY`，`insertText` 3/3 仍然进了对话输入框并能回车发出；`f02.mjs`：焦点在侧边栏按钮上时 `insertText` 进了输入框，而真实按键没有进）。所以上面各节以「焦点」一列（`document.activeElement`）为准，并用**只发真实按键事件**（逐字符 `Input.dispatchKeyEvent`，`h03.mjs`、`n01.mjs`）把关键路径重做了一遍：

| 路径（都是从黄点真实单击打开，或真实双击改名；之后不点击） | 次数 | 之后的焦点 | 真实按键敲一条消息 / 命令并回车 |
|---|---|---|---|
| 权限卡片 按 `1` | 3 | `chat-input` | 3/3 字进输入框，消息发出 |
| 权限卡片 按 `Esc` | 2 | `chat-input` | 2/2 发出 |
| 计划卡片 按 `1`；提问卡片 按 `Esc` | 各 1 | `chat-input` | 2/2 发出 |
| 权限卡片 鼠标点「是」 | 3 | `BODY` | **0/3**：输入框是空的，没有发出 |
| 权限卡片 按 `2` → 说明框 → 回车（拒绝） | 3 | `BODY` | **0/3** |
| 提问卡片 Tab / 空格选好，在「提交回答」上按回车 | 3 | `BODY` | **0/3** |
| 计划卡片 鼠标点选项 1 | 1 | `BODY` | **0/1** |
| 对话会话改名（名字也用真实按键输入）+ 回车 ×3 / Esc ×2 / 点对话区空白 ×1 | 6 | `chat-input` | 6/6 发出，名字没有进对话 |
| 对话会话改名中点另一个会话（按下即松开，点击没被吞） | 2 | `chat-input`（新的当前会话） | 2/2 消息出现在切过去的会话 |
| 终端会话改名 + 回车 ×3 / Esc ×2 | 5 | 终端 | 5/5 敲 `uname` 回车，终端多一行 `Darwin`；shell 里没有出现名字 |
| 通知点击打开待答会话（主进程发 `notification-click`，之前在对话 / 终端会话各 1 次） | 2 | 卡片 → 按 1 后 `chat-input` | 2/2 按 1 执行，随后真实按键打字发出 |

`h01.mjs` 逐帧记录了回答前后的焦点变化，原因很清楚：回答一发出，卡片进入 `submitting`，卡片上的按钮和文本框都被 `disabled`；Chromium 会把焦点从变成 disabled 的元素上移走（`activeElement` 变成 `BODY`）。等卡片消失时，`renderPrompt` 里的「键盘在卡片上才交给输入框」判断已经不成立。按 1 / 2（不再询问）/ Esc 时焦点在卡片的根元素上（它不会被 disabled），所以这几条路径是好的。jsdom 不模拟这条规则，所以单元测试看不到。

## 基准对照（16fd611 的桌面端）

为了分清「既有」和「这一轮引入」，把 16fd611 的 `desktop/` 用 `git archive` 导出到我自己的临时目录构建（`node_modules` 用符号链接指向 worktree 里的那份，只读），daemon 和假 claude 用 HEAD 的（这一轮 daemon 侧只改了 `-c` 的查找，与这些场景无关）。脚本 `z01.mjs` 和上面各脚本带 `base16` 标签的运行。

| 场景 | 16fd611 | HEAD |
|---|---|---|
| 从黄点点开待答会话 | 2/2 焦点 `BODY`，按 1 没反应，要先点一下卡片 | 32/32 焦点在卡片，按键可用 |
| 改名 + 回车 | 焦点 `BODY`，打字没有发出（1/1；改名中点另一个会话 5/5 也是 `BODY`） | 焦点回到当前会话 |
| 回答卡片之后（按 1 / Esc） | 6/6 焦点 `BODY` | 焦点到输入框 |
| 回答卡片之后（否 + 说明） | 1/1 焦点 `BODY`（鼠标点按钮在基准上没有单独测；基准的代码里没有任何交还焦点的逻辑） | 焦点 `BODY`（没变，见问题 1） |
| 当前会话打字时来权限请求 | 卡片拿走焦点，敲 `1` = 允许（1/1） | 相同（1/1）——既有行为 |
| **改名进行中当前会话来权限请求** | 3/3：卡片把焦点从改名框拿走，改名框立刻收起（名字按当时的内容被保存），接着敲的 `1` **回答了权限请求**（工具执行） | 3/3：改名框保持焦点，数字进名字，0 个回答 —— 这一轮修好的 |
| **机器管理对话框开着、当前会话来权限请求** | 3/3：卡片把焦点从对话框的文本框里拿走，敲 `1` 回答了权限请求 | 3/3 相同 —— **既有行为**，不是这一轮引入的 |
| 机器管理对话框开着、卡片被别处回答而消失 | 2/2 焦点留在对话框 | 2/2 相同 |
| 改名中点击另一个会话（本机 daemon，按住 60 ms） | 5/5 点击被吞（名字保存、没切换），焦点 `BODY` | 5/5 点击被吞，焦点回到仍是当前的那个会话 —— 点击被吞是既有问题 |
| 窗口失焦再聚焦（4 种离开 / 回来方式） | 与 HEAD 相同（包括 `w.show()` 那个驱动方式带来的现象） | — |
| 单击侧边栏会话（按住 60 ms）丢失率 | 安静时 0/20；后台会话的点刚变化时 0/20；当前会话回合刚结束就点 0/20 | 0/20；1/20；0/20 |

基准上的截图：`d01-base16-renaming-while-card-arrives`（改名框已被卡片顶掉）、`e01-base16-manager-open-card-arrives`、`b01-base16-card-while-typing`、`c02-base16-local60-chat-after-click-other`。其余未在正文引用的截图（`a01-proxy200ms-*`、`c02-rtt*`、`c02-local0-*`、`s01-setup`、作废那一轮的 `f01-head-back-to-window-card-focused`）是对应各轮的现场画面。

## 这一轮测试方面的改动（第 4 步）

`git diff 16fd611..HEAD -- 'desktop/scripts/*.mjs' '.claude/skills/verify/scripts/*'`：4 个文件，+404 / −7。

- **被删掉的 7 行都是被超集替换**：`VR_ONLY` 的注释多写了 `X10-*`；按键表多了数字键 `1`；临时目录列表多了 `x10t`、`x10`、`x10b`、`x10r`、`x10s`；两处 jsdom 全局多挂 `HTMLInputElement`；`test-sidebar-rename` 的 `setup()` 返回值多了 `openChat`、`close`、`key`。**没有断言被改弱或删除，没有超时被调大**，已有用例的正文没有动。
- 新增：`gui-chat-smoke` 3 个用例（`X10-prompt`、`X10-rename-chat`、`X10-rename-terminal`），`test-sidebar-rename` 6 个，`test-chat-view` 2 个。我的 2 次全量运行里 3 个 GUI 用例都通过。
- **`X10-rename-chat` 把改名请求延迟 500 ms，有没有掩盖真实问题**：没有掩盖 X10 的问题，但它绕开了一个真实存在的既有问题，开发方的记录是准确的，只是范围写窄了。
  - 不延迟、本机 daemon、真实点击按住 60 ms（脚本自己的 `realClick` 是 40 ms）：我做了 5 次对话 + 5 次终端，**10/10 点击被吞**——名字保存了，没有切换会话，键盘回到仍然显示着的原会话，字进的是屏幕上那个会话。没有出现「字打进了看不见的会话」「名字被发给 claude / 敲进 shell」「界面高亮和主区域不一致」。
  - 基准 16fd611 上同样 5/5 被吞（当时键盘还停在 `BODY`），所以不是 X10 引入的；X10 让这种情况下的键盘位置更合理。
  - 影响：用户改名时直接去点另一个会话，这一下没反应，要再点一次；名字不会丢。**「后续」里写的是「daemon 在本机时」，实际范围更大**：只要「改名 + 列表刷新」两次往返在松开鼠标之前完成就会发生——往返 20 ms（同一局域网、Tailscale 直连）时按住 60 ms 和 100 ms 都是 0/5 切换成功，往返 50 ms 时按住 60 ms 5/5 成功、按住 120 ms 只有 3/5。也就是多数「近」的远程机器都会遇到，不只是本机。我的判断：低，不够拦（操作可重做、没有数据后果、是既有问题且已记录），但建议把「后续」那条的适用范围改准，修的时候和「侧边栏重建吞点击」一起处理。
  - 延迟只包在这一步（`fetch` 里只对 `/rename`，`finally` 里还原），前面的回车 / Esc 两步没有延迟。
- 新用例的一个弱点（不拦，见备注 4）：三个 X10 GUI 用例里「接着直接打字」用的是 `Input.insertText`，我实测它在焦点不在输入框时也可能把字送进输入框（K 节）。这三个用例里真正可靠的是 `X10-prompt` 的「真实按键 1 / Esc 关掉卡片」；改名之后那几步「字进了当前会话」的断言比看上去弱（它们没有断言 `document.activeElement`）。我已用真实按键独立重做，结论成立。
- 单元用例跑在 jsdom 上，jsdom 不会把焦点从变成 disabled 的元素上移走，所以「卡片消失后键盘到输入框」只验证了按键路径，按钮路径在真实浏览器里的行为（问题 1）它测不出来。

## 问题

### 问题 1：用鼠标点卡片按钮、用「否 + 说明」、或用提问卡片的「提交回答」作答后，键盘焦点停在页面上（`BODY`），不到输入框

- 复现（任选其一，当前会话或从黄点点开的会话都一样）：
  1. 对话会话出现权限卡片 → 鼠标点「是」（或「不再询问」「否」）；或
  2. 按 `2` / `3`（否）→ 在说明框里打字 → 回车；或
  3. 提问卡片选好答案 → 点「提交回答」（或 Tab 到它按回车 / 空格）；或
  4. 计划卡片鼠标点选项 1 / 2。
  卡片消失后不点击，直接打字。
- 实际结果：`document.activeElement` 是 `BODY`，真实按键打的字不进任何地方，回车没有发出；要先点一下输入框。次数（卡片消失后 `activeElement` 是 `BODY`）：鼠标点「是」13/13（本机 10、经延迟代理 3）、「否」（按键或鼠标，带或不带说明）14/14、提问「提交回答」7/7、计划鼠标点选项 2/2、Tab 到「是」按空格 1/1；其中用真实按键验证「字没有进输入框」的是 K 节的 10 次。用 `1`、`2`（不再询问）、计划的 `1` / `2`、`Esc` 作答没有这个问题（50 余次焦点都到了输入框，其中 K 节 9 次用真实按键打字并发出）。
- 应有结果：按返工说明（任务说明「卡片消失后焦点交给输入框」；`decisions.md` #53 的 (b)「卡片消失时如果键盘在卡片上（**按键或点了卡片上的按钮回答**），把键盘交给输入框」），这些作答方式之后焦点也应在输入框。
- 原因：见 K 节（作答后控件被 disabled，浏览器先把焦点移走，卡片消失时判断不到「键盘在卡片上」）。
- 严重程度：低。和基准 16fd611 相比没有变差（那时所有作答方式之后都是 `BODY`），这一轮修好了按键作答的几条，没修到点按钮 / 说明框 / 提交按钮这几条；后果只是多点一下，字不会进错地方。纯键盘用户用「否 + 说明」拒绝之后要去摸鼠标。
- 是否拦：**不拦**。spec 没有要求作答后的焦点位置（X10 本身是第 2 轮「不拦、顺手修」的备注），用户遇到的情况不比上一轮差。但 `decisions.md` #53 括号里「或点了卡片上的按钮回答」这半句与真实应用不符，建议要么补上（在发出回答的那一刻记下「键盘在卡片里」，卡片消失时据此交给输入框），要么把这半句改掉并记进「后续」。

没有其它问题。

## 备注（都不拦）

1. **对话框开着时新卡片把键盘从对话框里拿走——是既有行为，但「后续」里的记录低估了后果。** 基准 16fd611 上 3/3 同样如此，所以不算这一轮的问题。但后果不只是「键盘被拿走」：卡片上数字键 1 =「是」、2 =「不再询问」（有建议时），而机器管理表单里要填的正是地址、端口、Token 这类带数字的内容。实测 3/3：在「地址」栏打到 `10.0.` 时当前会话来了权限请求，接着敲的 `1` 直接**允许了这条命令**，地址栏里没有多出字符；对话框盖着，用户看不清后面发生了什么（截图 `e01-head-manager-open-card-arrives`：卡片在模糊的遮罩后面）。只有机器管理对话框有这个问题（新建会话对话框只能从概览页打开，那时没有当前会话，实测 3/3 不受影响；删除确认框实测 2/2 不受影响，重载确认框是同一种系统模态框、没有单独测）。建议把「后续」那条的描述补上「可能误批准权限请求」，并提高优先级。
2. **在对话输入框里打字时来了卡片，接着敲的数字会回答卡片**（敲「10」的 `1` = 允许，`0` 之后进了输入框）。同样是既有行为（16fd611 相同，第 1 轮起卡片出现就自动拿焦点），草稿不会丢，这一轮让回答后焦点回到输入框、可以接着打。和备注 1 是同一个根源：卡片一出现就拿走键盘，而单个数字键就是回答。记录在案，建议和备注 1 一起考虑（例如卡片刚出现的短时间内不接受数字键，或焦点在文本框里时不抢）。
3. **改名中点击另一个会话，点击被吞**——既有问题、已在「后续」，范围比记录的大（不只本机 daemon），详见上一节。
4. **新的 X10 GUI 用例用 `Input.insertText` 判断「字进了当前会话」，这个探针不可靠**（K 节）。建议改成断言 `document.activeElement`，或像我的 `typeKeys` 那样逐字符发真实按键事件。
5. `tasks.md` T22 的行为描述里「有对话框打开时不抢焦点」只对「改名结束时」成立；新卡片出现时仍会从对话框里抢（「后续」里有记录）。两处放在一起读容易误解，建议 T22 那句写明范围。
6. 卡片本身拿到焦点时没有可见的焦点外框（「是」的高亮是主选项的固定样式，改名中卡片没有焦点时看起来一样，对比截图 `a01-direct-opened-from-yellow-dot` 和 `d01-head-renaming-while-card-arrives`）。用户无法从画面上分辨此刻按数字键会不会生效。低。
7. 提问卡片没有数字快捷键（按 1、2 没有任何反应），要用 Tab / 空格 / 方向键或鼠标；卡片底部同样写着「Esc 中断」，Esc 可用。不是问题，记录一下全键盘路径是通的（Tab 顺序见 A 节）。
8. 打开带黄点会话的单击：等 0.7 秒再点 43 次里丢 0 次；黄点出现的同一瞬间就点时丢过（那一轮 30 次切换丢 5 次；另一次 20 次里丢 1 次）。既有的「侧边栏重建吞点击」，这一轮没有动。

## 待验证项

- **真实输入法**：改名框、说明框、「其他」文本框里组字过程中的数字键 / 回车没有实测（我只能发按键事件和 `insertText`）。问题 1、备注 1 / 2 在输入法组字状态下的表现未知。
- **真实的系统级切换**：窗口失焦 / 聚焦是经主进程 `app.hide()` / `app.show()` 做的，不是真的 ⌘Tab 或点 Dock（安全约束不允许向系统前台发事件）。`w.show()` 那个现象是否会在某种真实操作下出现，没有条件验证。
- **原生通知点击**：未签名构建只有 Dock 降级；「点通知打开会话后焦点在卡片」是经主进程发 `notification-click` 模拟的（2/2）。
- **真实 claude、远程 Linux**：全部用假 claude 和本机 daemon；远程延迟用我自己的 TCP 代理模拟（往返 20 / 50 / 100 / 200 ms）。
- X9（Go 侧）和 `make check`、协议层不在我的分工；我只确认了界面上 `-c` 新建流程没有被改坏。
- 人手的点击节奏只取了几档（按住 0 / 40–60 / 100 / 120 ms）。

## 放松检查

- `gui-smoke.mjs`、`gui-chat-smoke.mjs` 原样运行，没有跳过用例、没有改脚本；只按要求经 `VR_MAIN_DAEMON` 传入自己构建的协议 2 daemon，并把截图目录指到 `gate-c-dm3/shots/script/`。
- 我自己的脚本里不在被验证路径上的准备 / 清理动作用了 JS：清空输入框里上一步留下的草稿（`clearAllInputs`）、读写剪贴板、经主进程隐藏 / 显示我自己的应用和调窗口大小、发 `notification-click`、让「另一台桌面」的 WebSocket 客户端触发请求或代答。被验证的点击、双击、拖选、按键全部是 CDP 的真实输入事件。
- A–I 节的「直接打字」最初用的是 `Input.insertText`（不可靠，见 K 节）；已用真实按键重做关键路径，以 K 节和各表的「焦点」列为准。I 节第一轮用 `w.show()` 的结果作废重做，已在该节说明。
- 窗口用 1280×800（这台机器的可用高度不够 900）。
- 其余：无。

## 环境版本（结束时）

```
结束时
$ git rev-parse HEAD
0edb03bd2da92d4513b93d2de957fef371f6e7f2
$ git status --short
（无输出）
```

没有改任何已跟踪文件，没有提交；worktree 里只多了被忽略的构建产物 `desktop/dist/`（冒烟脚本构建的，就是被测应用）。基准对照用的 16fd611 构建在我自己的临时目录里，没有动 worktree。

## 清理

- 我启动的进程全部已停并确认退出：3 次 harness（HEAD、基准、HEAD）各自的临时 Electron、2 个临时 daemon、TCP 代理，以及它们起的假 claude（由 daemon 退出时清掉，`ps -axo pid,comm` 里没有残留的 `claude` / `Electron` / 引用我临时目录的进程）；4 个 `TMUX_TMPDIR` 下都确认没有 tmux server。冒烟脚本的 4 次运行各自清理了自己的进程和 `vr-gui-*` / `vr-gc-*` 目录（没有残留）。
- 没有碰用户的 daemon（8765，进程 47914 仍在）、默认 tmux socket 目录（进程 1401、5607、85201 仍在）、`/Applications/vibe-remote.app`、`~/.claude.json`、`~/.claude/projects`、真实 userData；没有用 `osascript` / `cliclick`；没有 push、sudo、`git stash`；没有碰 `verify-dm/` 和 `gate-c-dm2/`（后者只读过脚本）。
- 已删除我建的 9 个临时目录：`/tmp/vr-dmg3-lGPeDW`（夹具、基准构建、脚本工作副本）和 8 个冒烟用的 `/tmp/vr-dmg3-*`（清单在 `scripts-gui/tmpdirs.txt`）。基准构建里指向 worktree `node_modules` 的符号链接先单独解除，worktree 的依赖完好。
- 剪贴板：复制 / 粘贴测试前读出文本、结束后写回（只能保存和恢复文本内容）。
- 留下的证据都在 `gate-c-dm3/`：`verdict-gui.md`（本文件）、`shots/`（手工 40 张 + `script/` 下冒烟脚本的 40 张）、`scripts-gui/`（驱动脚本、`logs/` 下 4 份冒烟日志和运行记录；不含 token）。
