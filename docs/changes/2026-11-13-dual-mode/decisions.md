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
