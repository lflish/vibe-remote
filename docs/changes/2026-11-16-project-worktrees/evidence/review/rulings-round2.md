# 第二轮复评（review-round2.md）各条意见的裁决

复评全文在同目录 `review-round2.md`，每条有位置、复现方式和改法。10 条：2 条严重（都是上一批修复引入的回归）、8 条一般。全部采纳，按下面的口径修。

| # | 问题 | 裁决 |
|---|------|------|
| R1 [严重] | tmux 的 socket 不存在（或没装 tmux）时任何 worktree 都删不掉 | 明确错误，修。「socket 文件不存在」和「找不到 tmux 可执行文件」都等于「没有任何 tmux 会话」，对账算成功；只有 server 在而查询失败才算对账失败。判断 socket 不存在不要靠匹配 tmux 的报错文字（用 `os.Stat` socket 路径或 `exec.ErrNotFound` / `ENOENT`）。先读代码确认 socket 路径怎么得到（`TMUX_TMPDIR`、默认 `/tmp/tmux-<uid>/`、`-L vibe-remote`）。补用例：`use_tmux:true` + 全新的 `TMUX_TMPDIR` 下删除成功；PATH 里没有 tmux 时删除成功；server 在而查询失败时仍然拒绝（原有用例保留）。同样的判断也用在 `WorktreeStatus` 和 `Projects` 读会话的地方 |
| R2 [严重] | git 低于 2.31 时 `GIT_CONFIG_COUNT` 不生效，`core.fsmonitor` 又会被执行 | 明确错误，修。按复评的改法：把 `-c core.fsmonitor=false` 作为参数加在所有 git 调用最前面（任何版本都认，git 会传给自己起的子进程）；环境变量那一套去掉，避免两套并存。四个 fsmonitor 用例保持通过。如果本机能方便地拿到一个低于 2.31 的 git 就实测一遍，拿不到就写明依据是 git 文档（`-c` 自 1.7.2 起支持、经 `GIT_CONFIG_PARAMETERS` 传给子进程） |
| R3 | `worktree add` 到时限被杀后留下 `locked initializing` 的残留，撤销清不掉 | 明确错误，修。撤销里对认定是本次自己的那一项用 `git worktree remove --force --force`；并清掉它留下的 `index.lock`（如果 remove 成功会随管理目录一起消失就不用另处理，以实测为准）。补「检出中途被杀」的用例（复评用的是不返回的 smudge 过滤器） |
| R4 | G2 的读回失败时，撤销留下目录却删了分支 | 明确错误，修。两处：(1) 读回失败先重试一次；(2) 撤销里只要 worktree 没能确认已经移除（列表读不到、`worktree remove` 失败），就**不删分支**，并把「目录和分支都留着」写进 message。补用例 |
| R5 | `.devflow.yml` 新规则「daemon 运行的 git 不执行仓库配置指定的程序」写得比代码能保证的宽 | 明确错误，修文字：改成「daemon 运行的 git 不运行 `core.fsmonitor` 指定的程序（查看状态、预检、被拒绝的删除请求的检查都不运行它）」；CLAUDE.md 里加一句：clean / smudge 过滤器和 hook 是 git 自己的行为，不在保证范围内。`worktree.go` 里那句范围过宽的注释一并改准 |
| R6 | 删除成功后、刷新回来之前，「正在删除…」的行短暂变回可点 | 明确错误，修。成功时把标记留到刷新结束之后再清；失败 / 409 / 取消仍在重开确认框之前清。补用例 |
| R7 | G5 改成按工作目录判断后，daemon 重启前后对同一个会话结论不同（重启后用的是进程当前目录） | 以 spec H19 为准（「会话归属按创建时的目录定，不随进程里 `cd` 变化……否则 R5.6 也会结束错会话」）→ 采用复评的 (a)：把创建时的工作目录也存进 tmux 用户选项（与 `@vibe_remote_home` 等一起；`list-sessions` 的格式串和 `parseTmuxSessionLine` 接受的列数跟着改，CLAUDE.md 写着这两处要一起改），找回会话时 `sessionsIn` 用它，不用 `pane_current_path`。升级前建的会话没有这个选项时，退回只按 `home` 判断（不看当前目录）。对话会话核对 `chat-sessions.json` 里存的是不是创建时的目录。补「重启后 `cd` 进别的 worktree 的会话不被算进去」和「重启后建在 worktree 内嵌套仓库目录里的会话仍被算进去」两个用例。记一行机械型（依据 H19） |
| R8、R9 | 目录有一轮读不到（`prunable`）时创建记录被清 | 取舍 → 采纳「只在 git 的列表里完全没有这个路径时才清记录」，`prunable` 的保留记录。这推翻 decisions #82 里「或已是 prunable」那半句：追加一行说明。CLAUDE.md 那句于是与代码一致，核对即可。补用例（复评的 `TestR2DirectoryAwayForOnePoll` 的做法） |
| R10 | 名字新规则的提示说成「git 不接受这个分支名」 | 取舍 → 采纳：两种情况各给一个原因码和一句文案（例如 `invisible`：「名字里有不显示的字符（零宽字符或方向控制符）」；`too_long`：「名字太长（最多 250 字节）」），Go 和桌面端的 `validateWorktreeName`、共用向量 `worktree-names.json` 的 `reason`、i18n 中英文、`docs/protocol.md`（如果原因码出现在协议里）一起改。规则本身不动。复评列的仍能通过的几个「看不见」字符（U+034F、U+3164、U+2800、U+FE0F）不处理，记进「后续」 |

另外记进 tasks.md「后续」（不修）：
- 删除 worktree 的确认框只写要结束几个会话、不列名字（已有一条，补一句：status 的 `sessions` 可能含不挂在这一行下的会话）。
- tmux 调用本身没有时限，删除时在仓库锁内调用 `syncFromTmux`（原有写法）。
- `rev-list --count` 的 30 秒时限在超大仓库上的表现没有实测。
- 没有写明支持的最低 git 版本；本需求用到的 `git worktree list --porcelain`、`worktree add --detach`、`worktree remove`、`update-ref`、`symbolic-ref` 需要的最低版本待核实后写进文档。
