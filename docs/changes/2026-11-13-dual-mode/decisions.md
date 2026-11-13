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
