# 裁决记录 · 双模式会话（终端 + 对话）

规则见 dev-workflow/references/decisions.md。只追加，不修改旧行。

| # | 阶段 | 决定 | 类型 | 依据 | 理由 | 放弃的选项 | 定错的代价 | 处理结果 |
|---|------|------|------|------|------|------------|------------|----------|
| — | dev-requirements | 分支用 `change/dual-mode`，需求文件夹 `docs/changes/2026-11-13-dual-mode` | 机械型 | layout.md 命名规则 | 按约定 | — | 低：改名即可 | 已定 |
| — | dev-requirements | `docs_dir` 用默认 `docs/changes`；新建 `.devflow.yml` 草稿 | 机械型 | 项目没有 `.devflow.yml`，`docs/` 下没有需求目录惯例 | config.md：没有配置时推断草稿，关口 A 确认 | — | 低 | 已定，关口 A 请用户看 |
| — | dev-requirements | 命令推断：install `cd desktop && npm ci`；test/lint `make check`；build `make server` + `cd desktop && npm run build`；e2e `node .claude/skills/verify/scripts/gui-smoke.mjs` | 机械型 | Makefile（`check`/`install-desktop`/`server`）、`desktop/package.json` scripts、CI 只调 `make check-*`、CLAUDE.md「GUI 回归」 | `make check` 是项目唯一检查入口 | 单独列 gofmt/vet/tsc 命令 | 低 | 已定 |
| d1 | dev-requirements | 新界面叫「对话」，不叫「富文本」 | 口味型 | CLAUDE.md 里「富文本」专指外壳 UI 的精致度，不是解析终端内容 | 避免和架构约束里的术语冲突，减少误读 | 「富文本」「Chat」「结构化」 | 低：改文案 | 已定，关口 A 可改 |
| d2 | dev-requirements | 界面在新建时定死，不支持已有会话就地切换；出问题用「新建终端会话接上」（`--resume`） | 口味型 | 同一 session id 不能同时有两个进程；就地切换要协调两套进程生命周期 | 首版简单可靠；交接已能覆盖「对话不够用」的情况 | 就地切换（推迟） | 中：以后加就地切换要补进程交接逻辑 | 已定，关口 A 可改 |
| d3 | dev-requirements | 断线时的权限请求：一直等待并发通知，不超时、不自动允许或拒绝 | 口味型 | `can_use_tool` 本身不超时；重连后会重新下发 | 自动允许不安全，自动拒绝会打断长任务 | 超时自动拒绝；按规则自动允许 | 中：长时间无人处理时任务停住 | 已定，关口 A 可改 |
| d4 | dev-requirements | 新建对话框默认选「终端」；`-c` 默认不勾 | 口味型 | 终端是现有行为，P1 要求不变 | 老用户新建会话的操作不变 | 记住上次选择；默认对话 | 低 | 已定，关口 A 可改 |
| d5 | dev-requirements | 推迟：@文件、图片附件、checkpoint/回退/分叉、模型选择器、上下文用量、就地切换界面、「先答先生效」以外的多端策略 | 口味型 | 范围模式：选择性扩展 | 首版先把权限、保活、补发做可靠 | 首版全做 | 低：后续需求补 | 已定，关口 A 可改 |
| c1 | dev-requirements | 改写 CLAUDE.md：「客户端绝不解析」限定为终端模式，补充对话模式的数据通路（R19） | 只有人能做 | decisions.md 第四节「约束 AI 的规则文件」 | 对话模式本身就要解析 claude 的结构化输出，不改约束就和文档冲突 | 不改 CLAUDE.md | 高：约束写错会误导以后所有改动 | 等用户，关口 A |
| 6 | dev-requirements | 新人通读检查的 8 个问题按其默认答案写进假设 H12–H17、场景 R2.6 / R5.2b；「daemon 重启后对话会话是否存活」「交接后原会话去留」改为关口 A 的 Q2 / Q3 | 机械型 | dev-requirements 第 6 步 | 前 6 项合理的开发者能自己定；后 2 项用户能感知 | — | 低 | 已定 |
| 7 | dev-requirements | 效果页第 2 版：按独立评审修 4 处逻辑矛盾（命名、模式切换、断线权限、-c 默认）和页面机制 | 机械型 | 评审有实测证据（Playwright 375/1280） | 明确错误 | — | 低 | 已改并复验 |
| c1 | dev-requirements | 用户回复 all：c1 同意，改写 CLAUDE.md 架构约束（R19） | 只有人能做 | 关口 A | — | — | — | 关口 A 用户同意 |
| 8 | dev-requirements | 关口 A 通过：Q1 按 H1，Q2 A（daemon 重启后对话会话不存活，H4），Q3 A（交接后原会话留着标已结束，H13）；H1–H17 全部采纳；d1–d5 保持 | 机械型 | 关口 A 回复 all | 按默认 | — | — | 已定 |
| 9 | dev-design | 前置验证 V1–V7 用本机 claude 2.1.210 实测全部通过：control protocol 形状、interrupt、--session-id/--resume、stdin 关闭语义、AskUserQuestion/ExitPlanMode 均可直接照抄 | 机械型 | 实验 | evidence/probe-stream-json.md，日志 .devflow-tmp/probe/logs/ | — | — | 已定 |
| d6 | dev-design | 对话会话元数据存 `<配置文件目录>/vibe-remoted-state/chat-sessions.json`（可配 `state_dir`），不存消息；历史以 claude JSONL 为准 | 口味型 | 原则 3 | 测试用临时配置即自动隔离；文件小、低频写 | `~/.local/state`；daemon 自己落盘消息；借 tmux 存元数据 | 低 | 已定 |
| d7 | dev-design | 「重新启动」和「重载」同义，复用 `POST /sessions/{id}/reload`；交接走 attach 的 `handoffFrom` 字段而不是新 REST 端点 | 口味型 | 原则 2 | 复用 attach 幂等和 reload 端点；非 tmux 模式也能用 | 新增 restart/handoff 端点 | 低 | 已定 |
| d8 | dev-design | 缓冲上限：完整消息 1000 条 / 32 MiB，流式尾巴 20000 条 / 8 MiB，JSONL 历史 2000 行 / 16 MiB；daemon 只解析信封字段、消息体原样透传（设计 1.2 方案 A） | 口味型 | H2、非功能要求 | 500 条 2 秒留一倍余量；复用 7 月 TS 解析器 | daemon 全量语义化 | 中：上限不合适要改常量 | 已定 |
| d9 | dev-design | Markdown 用 markdown-it 15.0.3（html:false）+ dompurify 3.4.17 两层防线，精确锁版本；不做代码高亮 | 口味型 | 原则 3、非功能安全 | 默认转义 HTML、拦 javascript: | marked | 低 | 已定 |
| c2 | dev-design | 新增 9 条不变规则写进 `.devflow.yml` 的 `invariants`（设计 7.1） | 只有人能做 | 约束 AI 的规则文件 | 规则本身已有对应测试并进 make check，只差登记 | 不登记 | 低 | 等用户（关口 B 汇总）；不阻塞任务 |
| 10 | dev-design | 工程评审 15 条：11 条明确错误直接改设计（claude 会话占用表 + 操作互斥、jsdom 跑 markdown 测试、无 JSONL 时用 --session-id、回答先入队再删待答、重连位置只在同步完成后生效、计划批准后再切模式、outstanding 自愈、持久化单路径最新者胜、~ 展开、黄金帧先于协议改动生成、补非功能测试） | 机械型 | 评审有代码依据 | 明确错误 | — | — | 已改 |
| d10 | dev-design | 对话会话 reload 改为 REST 返回 202，结果经 chat_state 广播；停进程时限压缩为 2s/1s/1s | 口味型 | 评审 #11：停进程最坏 7s 超过 rest.ts 8s 超时 | 不改客户端超时 | 同步等待 + 放宽超时 | 低 | 已定 |
| d11 | dev-design | 终端会话带 -c 新建/重载时，若目录最近一次 claude 对话正被运行中的对话会话占用，返回 fatal `claude_session_busy`；其余终端行为不变（该冲突在没有对话会话前不可能发生，P1 成立） | 口味型 | 评审 #12 | 守 R2 | 只在 spec 里声明不保证 | 低 | 已定，汇总里请用户看 |
| d12 | dev-design | 通知不可用（未签名包）时 R16.3 降级为 Dock 弹跳 + 角标 + 侧边栏黄点，不自动切换会话 | 口味型 | 评审 #13：未签名包没有可点的通知 | 不打断用户 | 聚焦时自动切到等待的会话 | 低 | 已定 |
| c3 | dev-design | `-p` 模式可能跳过 claude 的「信任此工作区」确认，项目里的 hook 会直接执行。设计默认：daemon 查 `~/.claude.json` 的 `hasTrustDialogAccepted`，未信任的目录不允许新建对话会话并提示先用终端打开一次（V23 待实测） | 只有人能做 | 评审 #10，安全敏感 | 不替用户降低安全边界 | 不检查；在对话界面里做信任确认 | 高：错误放行会执行不信任仓库的 hook | 等用户（关口 B 汇总）；只影响 T2/T6/T11 的一个小分支，不阻塞 |
| 11 | dev-design | 工程评审第 2 轮 10 条全部按明确改法修订：重启不释放占用、opMu 改 WithOp 不可重入、交接跳过二次 beginCreate、reload 202 加 reloading 标志、只有交接出的终端会话占用 U、c3 的 unknown 按 untrusted 处理且测试生成信任文件、中断路径同样先入队、看门狗迟到 result 标 vr_stale、T2/T3/T4 依赖理顺、黄金帧只比本测试目录的条目 | 机械型 | 评审有锁顺序分析与代码依据 | 明确错误 | — | — | 已改 |
| 12 | dev-design | 机器关口 B 第 1 轮：不通过（验证者 codex）。拦下 6 项：V9–V23 未实测、历史 2000 行上限违背 R1.5、V9/V13 失败预案擅改验收、tasks 残留旧 Stop/Restart 接口、T13 命令缺参数、终端 -c 自动启动未登记占用（F7） | 机械型 | design.md §11 | — | — | — | 已安排：探针补测 + 设计修订 |
| d13 | dev-design | 历史不设上限：daemon 分块流式发送全部 JSONL 历史，客户端先渲染最新 300 条、上滚再实例化更早的 | 口味型 | R1.5/H6/H13「完整历史」 | 守住 spec | 2000 行上限 + 后续分页 | 低 | 已定 |
| d14 | dev-design | daemon 自己以 continue 语义启动的终端会话，启动时按目录最近一次对话做尽力的占用登记，tmux 会话消失即释放；此后对话 -c 冲突返回 claude_session_busy。残留情况（启动与解析之间 JSONL 变化）仍在 H12 之外 | 口味型 | 关口 B 阻挡项 6 | 守 R2 | 只在 spec 声明不保证 | 低 | 已定 |
| 13 | dev-design | 探针第二批 V9–V23 实测全部通过，4 处与设计假设不同并据此改设计：待答时 interrupt 由 claude 自行发 cancel（不再先 deny）；still_queued 不含 stdin 排队消息（outstanding 不按它重算）；bypass 下 AskUserQuestion 仍询问；计划批准后恢复进入 plan 前的模式、立即发 set_permission_mode 不会被覆盖 | 机械型 | 实验 | evidence/probe-stream-json.md 第二批 | — | — | 已改 |
| c3（补充） | dev-design | V23 实测：-p 在从未信任的目录会直接执行项目 .claude/settings.json 里的 hook，无任何提示。信任门槛不是假设而是必需 | 只有人能做 | 实验 | 同上 | — | 高 | 等用户（关口 B 汇总） |
| 14 | dev-design | 机器关口 B 第 2 轮：不通过（codex）。阻挡 3 项：R6.2「逐个确认」未强制切手动；终端 -c 占用的 U 与实际启动的 U 可能不一致（d14 扩大了 H12 例外，不可自行扩大）；停进程测试预期与「interrupt 后排队消息仍执行」冲突 | 机械型 | design.md §11（第 2 轮） | — | — | — | 已安排修订 |
| 15 | dev-design | 推翻 d14：不扩大 H12 例外，改为固定身份——daemon 自己以 continue 语义启动的终端会话，启动时把 -c 改写成 --resume <当时最近的会话 U> 并原子占用；无记录时去掉 -c | 机械型 | 关口 B 第 2 轮 | 守 R2 且不改需求边界 | 保留 d14 | — | 已改设计；因改写用户配置的 flag 记 c4 |
| c4 | dev-design | 终端会话（daemon 启动）带 continue 语义时，-c 改写为 --resume <U>（无记录则去掉 -c）。常见情况与 -c 选中的对话相同；唯一可观察差异是启动瞬间有新对话产生时仍接上解析时的那段 | 只有人能做 | 改写用户配置的 flag，触及 P1 | 这是唯一不扩大 H12 又能守 R2 的做法 | 保留 -c、在 spec 里声明不保证 | 中 | 等用户（关口 B 汇总）；只阻塞 T5/T6 的 continue 分支 |
| 16 | dev-design | 停进程改为：interrupt → 等本回合 result ≤2s → 立即 SIGTERM 进程组 → 1s → SIGKILL；不再依赖关 stdin（V5/V14：EOF 会跑完队列） | 机械型 | 探针 V14 | 明确错误 | — | — | 已改 |
| 17 | dev-design | 机器关口 B 第 3 轮：不通过（codex）。剩 2 项：continue 无记录分支未登记新 U；停进程不能保证排队回合零 result | 机械型 | design.md §11（第 3 轮） | — | — | — | 已安排修订 |
| 18 | dev-design | 无记录分支：daemon 生成 UUID、原子占用后以 --session-id U 启动（仍在 c4 范围内）；停进程边界改为「SIGTERM 生效前的 result 照记，未配到 result 的消息发 dropped_on_stop，每条消息恰得其一」 | 机械型 | 关口 B 第 3 轮推理 | 明确错误 | 保留「绝不产生 result」的承诺 | — | 已改 |
| 19 | dev-design | 更正 #13：探针第二批实测的是 V9–V14、V18–V23；V15–V17 仍待验证（V16 在 T3 内以假 claude 验证，V17 远程 Linux 交 dev-test） | 机械型 | 关口 B 第 2/3 轮备注 | 记录精确 | — | — | 已记 |
| 20 | dev-design | 机器关口 B 第 4 轮：不通过（codex）。剩 2 处条文：同 U 重载失败回滚不得释放原占用；停进程须等读协程处理完 stdout 再结算 dropped_on_stop | 机械型 | design.md §11（第 4 轮） | — | — | — | 已改条文；验证者轮次已到上限（6/6） |
| c5 | dev-design | 验证者轮次用尽（budget verify_rounds_per_change=6），第 4 轮剩下的两处条文修正没有经过独立验证。是否接受「已按验证者给出的明确改法修正」作为关口 B 放行，进入开发；或追加一轮验证（超出上限） | 只有人能做 | 超出花费上限 | 两处都是验证者给出明确改法的条文修正，开发阶段的测试（TestReaderJoinBeforeSettle、T:46 失败注入）会再次覆盖 | 追加第 5 轮验证 | 低 | 等用户 |
| c2 | dev-design | 用户回复 all：同意把 9 条不变规则登记进 .devflow.yml | 只有人能做 | 关口 B 汇总 | — | — | — | 用户同意，T13 落实 |
| c3 | dev-design | 用户回复 all：同意工作区信任准入（未信任/unknown 目录不允许新建对话会话） | 只有人能做 | 关口 B 汇总 | — | — | — | 用户同意，T2/T6/T11 子项解除阻塞 |
| c4 | dev-design | 用户回复 all：同意终端 continue 参数改写为固定会话身份（--resume U / --session-id U） | 只有人能做 | 关口 B 汇总 | — | — | — | 用户同意，T5/T6 子项解除阻塞 |
| c5 | dev-design | 用户回复 all：接受第 4 轮两处条文修正不再独立验证，关口 B 放行 | 只有人能做 | 关口 B 汇总 | — | — | — | 用户同意，进入 dev-build |
| 21 | dev-build | 假 claude 的 `swallow` 加可选参数 `swallow <ms>`：静默 ms 毫秒后补发一个迟到的 `result`（不带参数时一直静默，直到被中断）；`perm <命令>` 不带 `suggest`/`mode` 时请求里没有 `permission_suggestions`（R5.2b 的无建议情形） | 机械型 | T3 的 TestLateResultAfterStaleTurn 要「看门狗之后假 claude 再补发 result」，9.2 没写触发方式 | 最接近 9.2 原意的最小扩展，不影响其它指令 | 用 stdin 控制帧触发补发 | 低：只影响测试夹具 | 已定（T2） |
