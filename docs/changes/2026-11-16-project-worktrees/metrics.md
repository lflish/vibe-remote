# 数据记录 · 按项目和 worktree 组织会话

| 时间 | 阶段 | 事件 | 值 | 说明 |
|------|------|------|----|------|
| 2026-11-16 17:57 | dev-requirements | 阶段开始 | | 规模：标准，等级：L1 |
| 2026-11-16 17:57 | dev-requirements | 原型实验 | 7 | 临时 daemon + 假 claude：E1–E7（同目录多会话、`-c`、worktree 创建/删除/重启） |
| 2026-11-16 18:22 | dev-requirements | 问用户 | 评审消息 | 4 个前提、3 个做法、5 个扩展候选、4 个问题 |
| 2026-11-17 18:11 | dev-requirements | 用户回复 | 1429 分钟 | 做三层组织和 worktree 功能，另加视觉风格；其余按推荐 |
| 2026-11-17 19:15 | dev-requirements | 用量 | 子 agent 2 次 | 新人通读检查 1 次、效果页 1 次 |
| 2026-11-17 19:15 | dev-requirements | 问用户 | 关口 A | 3 个视觉方案、26 条假设、3 个问题 |
| 2026-11-18 10:03 | dev-requirements | 用户回复 | 888 分钟 | 关口 A：M1，其余按默认 |
| 2026-11-18 10:08 | dev-requirements | 阶段结束 | | 关口 A 通过 |
| 2026-11-18 10:08 | dev-design | 阶段开始 | | |
| 2026-11-18 10:36 | dev-design | 原型实验 | 5 | git 行为探针：worktree 列表、未合并与干净判定、创建失败的残留、删除、伪造 `.git`（evidence/git-probe.txt、git-probe-2.txt） |
| 2026-11-18 10:41 | dev-design | 原型实验 | 1 | 性能：20 仓库 × 5 worktree 的 git 调用耗时，7 组对比（evidence/perf-list.txt） |
| 2026-11-18 10:52 | dev-design | 原型实验 | 3 | 临时 daemon + 调试实例：协议 3 对新端点返回 404、会话列表基线耗时、快捷键拦截与菜单加速键（evidence/shortcut-probe.txt） |
| 2026-11-18 10:58 | dev-design | 原型实验 | 1 | M1 配色对比度（evidence/contrast-m1.txt） |
| 2026-11-18 16:18 | dev-design | 原型实验 | 5 | 工程评审后的 git 探针：`@{-1}` 与名字校验、`update-ref` 先占后建、子模块与 separate-git-dir、locale 与 `GIT_DIR`、锁定和含子模块的 worktree 的删除（evidence/git-probe-3.txt A–E） |
| 2026-11-18 16:18 | dev-design | 原型实验 | 1 | tmux 用户选项存创建时间（私有 socket；evidence/git-probe-3.txt F） |
| 2026-11-18 16:18 | dev-design | 原型实验 | 1 | 项目行标签 0–359 色相的对比度（evidence/contrast-tag.txt） |
| 2026-11-18 17:03 | dev-design | 用量 | 评审者 1 次 | 工程评审：3 个严重、12 个一般 |
| 2026-11-18 17:03 | dev-design | 验证拦下问题 | 11 | 工程评审的错误类意见 |
| 2026-11-19 10:10 | dev-design | 用户回复 | | c3 同意、c4 采纳、R5.9 按建议改写；第二轮修完直接进关口 B |
