# 第三轮核对（review-round3.md）的裁决

核对全文在同目录 `review-round3.md`。R2、R3、R4、R6、R7、R8、R10 没有问题；R1 的修法放得太宽，有 2 条已证实的问题和 1 条待验证项。全部采纳，按下面的口径修。方向只有一个：**拿不准有没有 tmux 会话时，当作查询失败（不清会话表、删除 worktree 返回 500、什么都不动）**。

| # | 问题 | 裁决 |
|---|------|------|
| T1 | tmux server 活着、socket 文件被删时被判成「没有任何会话」：会话从表里消失、claude 会话占用被释放、删除 worktree 漏掉会话 | 修。「socket 不存在 ⇒ 没有会话」只在 daemon 自己的会话表里**没有任何终端会话**时才成立；表里还有终端会话时按查询失败处理（不清表、不释放占用）。此时 500 的 `message` 和日志写明：tmux 的 socket 文件不见了而 daemon 记得有终端会话；如果 tmux 还在运行，对 tmux server 进程发 SIGUSR1 可以重建 socket，否则重启 daemon |
| T2 | daemon 的 PATH 里找不到 tmux、而 socket 文件还在时被判成「没有任何会话」 | 修。找不到 tmux 程序时也看 socket 和会话表：socket 不存在且表里没有终端会话才算空表；否则按查询失败处理，`message` 和日志写明「找不到 tmux 程序，但有 tmux 的 socket（或 daemon 记得有终端会话）」 |
| T3（待验证） | `TMUX_TMPDIR` 指向不存在或解析不了的目录时，daemon 算的 socket 路径与 tmux 实际用的不一致 | 修（改法便宜且与 tmux 一致）：`tmuxSocketPath` 对 `TMUX_TMPDIR` 先做 `filepath.EvalSymlinks`，失败就退到 `/tmp`。用单元测试守住路径的计算（不需要真的在默认目录上跑 tmux：只断言算出的字符串） |
| 已知限制（不修） | daemon 重启后会话表是空的，这时 socket 文件被外部删掉而 tmux server 还活着，仍会被当成「没有会话」 | 不加机制（没有见到实际发生；要挡住它得持久化 tmux server 的 pid）。记口味型决定，写进 tasks.md「后续」和 CLAUDE.md 对账那一段 |

三种状态的最终规则（写进 CLAUDE.md 对账那一段，逐句对照代码）：
1. tmux 回答了 → 以它为准。
2. tmux 说没有 server（`no server running` / `no sessions`）→ 没有会话。
3. 查询失败，且（socket 文件不存在 或 找不到 tmux 程序），且会话表里没有终端会话，且（找不到程序时）socket 文件也不存在 → 没有会话。
4. 其余一切失败 → 对账失败：不清表；删除 worktree 重试一次后返回 500，什么都不动。

需要的用例（先失败后通过；都用独立的 `TMUX_TMPDIR`）：
- server 活着、socket 文件被删、表里有终端会话：`liveTmuxSessions` 报失败；会话仍在表里；`RemoveWorktree` 返回 500 且目录、会话都在；对 server 发 SIGUSR1 后恢复正常，删除能结束该会话。
- PATH 里没有 tmux 而 socket 文件在：对账失败，删除被拒。
- 原有的三条仍然通过：全新 `TMUX_TMPDIR`（没有 socket、表为空）删除成功；没装 tmux 且没有 socket 删除成功；server 在而查询失败时拒绝。
- `tmuxSocketPath` 在 `TMUX_TMPDIR` 不存在 / 是指向别处的符号链接 / 为空时的结果。
