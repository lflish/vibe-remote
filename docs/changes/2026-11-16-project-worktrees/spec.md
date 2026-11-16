# 按项目和 worktree 组织会话

状态：草案　阶段：dev-requirements　待关口：评审　等级：L1　规模：标准　创建：2026-11-16　更新：2026-11-16

## 背景与目标

为什么要做：用户想在同一个项目（例如 `/Users/mac/github/devflow`）上同时开好几个会话、好几个 worktree 并行工作。daemon 已经能并行跑（实测），但桌面端只按机器把会话平铺成一列：worktree 会话的默认名是一串会话 id，看不出分支和所属项目；别处建好的 worktree（如 devflow 的 `.devflow-tmp/worktrees/<短名>`）在目录选择器里选不到；删会话时顺带删 worktree 和分支，会丢掉已提交未合并的工作，被保留下来的 worktree 又没有任何地方能再看到。

做完的样子：侧边栏按 机器 → 项目 → worktree 组织，会话挂在所属 worktree 下；用户能从项目里新建带名字的 worktree、打开已有的 worktree、并行开多个会话且一眼分清；会话和 worktree 分开管理，删会话不再丢代码。（待评审确认后量化。）

## 完成条件

待评审回复后写定。

## 现状（2026-11-16 调查，代码 + 临时 daemon 实测）

已经能用：
- 同一目录不勾 `-c` 可以开任意多个互不相干的会话，终端和对话可混用（实测）。
- 同一仓库可以同时开多个 Worktree 会话，终端和对话都行，无数量上限、无互斥（实测，`manager.go` 的 `beginCreate` 只串行化同 id 的并发创建）。
- 源目录可以选仓库子目录，会话落在 worktree 里对应的子目录（实测）。
- daemon 重启后 worktree 会话的身份不丢（终端靠 tmux 用户选项，对话靠 `chat-sessions.json`）。
- `/api/v1/sessions` 每条已带 `mode`，worktree 会话另带 `sourceWorkdir`、`sourceRepo`、`worktreeRoot`、`branch`；客户端只用了 `mode`。

卡住的地方（按严重程度）：
1. 删「工作区干净但有未合并提交」的 worktree 会话：返回 204，目录删除、分支被 `git branch -D`，提交只剩悬空对象；确认框不提 worktree 和分支（实测；`worktree.go:120-139` 只看 `git status --porcelain` 是否为空）。
2. 工作区不干净（含只有 gitignore 文件，如 `node_modules/`）时删会话：返回 409 `worktree_preserved`，会话已停并从列表消失，worktree 和分支留在磁盘，路径只在状态栏显示 6 秒，之后产品里没有任何地方能看到或清理它（实测）。
3. 单窗口，一次只显示一个会话，无分屏、无标签、无切换快捷键（`desktop/src/main/index.ts`、`renderer/index.ts:1079-1081`）。
4. 分不清谁是谁：worktree 会话默认名是会话 id（如 `1794824025040-12b763ac`）；同目录多个会话同名；侧边栏、工具栏、通知都不显示分支和源仓库；终端会话在侧边栏的顺序会随轮询随机互换（daemon 端 map 遍历）。
5. 勾了 `-c` 时，同一目录开第二个对话会话会被接到已有那个（`ready.existing`），开第二个终端会话报 fatal `claude_session_busy`；对话框的说明没讲这个后果。用户现有的 devflow 对话会话就勾了 `-c`。
6. Worktree 模式没有可填的字段：分支固定 `vibe/<会话id>`，目录固定 `<仓库父目录>/<仓库名>-worktrees/<会话id>`，基于源目录当前 HEAD、不含未提交改动；界面只有一句「创建一个隔离分支」。
7. 别处建的 worktree 打不开：目录选择器过滤所有 `.` 开头的目录、没有路径输入框，所以 `/Users/mac/github/devflow/.devflow-tmp/worktrees/general-skills` 选不到；即使选到，对话界面也因该路径未被 claude 信任而被拒（`workdir_untrusted`）。
8. 新 worktree 路径本身不在 claude 的信任记录里：之后无法在其中再开一个普通对话会话。
9. 没有任何 worktree 的列表、清理入口；daemon 没有对应 REST 端点。

## 前提（待评审确认）

- P1 并行多开的后端能力已经有了；要解决的是界面怎么组织，以及 worktree 怎么建、怎么找、怎么收尾。
- P2 「项目」= 一个 git 仓库：它的所有 worktree（包括不是 vibe-remote 建的）归到同一个项目下，主目录是其中第一个 worktree；不在 git 仓库里的目录自成一个项目，下面只有它自己。
- P3 会话和 worktree 的生命周期分开：结束或删除会话不再顺带删除 worktree 和分支；删除 worktree 是 worktree 上的显式操作，有未提交改动或未合并提交时明确告知。
- P4 每个 worktree 里的 claude 对话各自独立：新 worktree = 新对话，不继承主目录的上下文；同一个 worktree 里勾 `-c` 再开 = 回到已有那段（现有行为）。

## 做法与范围（待评审确认）

做法候选：
- A 最小可行：侧边栏仍按机器平铺，只改显示（会话行显示分支、worktree 新建时可起名）并修掉删除丢提交。不解决「已有 worktree 打不开」和「保留下来的 worktree 没人管」。
- B 三层组织（推荐）：机器 → 项目 → worktree，会话挂在 worktree 下；项目下列出该仓库的全部 worktree；从项目里新建带名字的 worktree；worktree 与会话分开管理。
- C 理想形态：B + 并排看多个会话（分屏或多窗口）+ worktree 上的 git 状态与合并操作。

范围模式：缩减（给已有产品加功能，预计改动超过 15 个文件：侧边栏、目录选择器、协议三处、会话管理、worktree、测试）。

扩展候选：
- E1 切换会话的快捷键（⌘1–9、⌘⇧[ / ⌘⇧]）　工作量小　推荐加入
- E2 一个窗口里并排看 2 个会话（分屏）　工作量中到大　推荐推迟
- E3 多个 macOS 窗口　工作量大（同一终端会话被两处 attach 会互相顶掉 PTY，需要窗口间协调）　推荐推迟
- E4 worktree 行上常驻显示「有未提交改动 / 领先 N 个提交」　工作量中　推荐推迟（删除确认时仍会现查现报）
- E5 在工具里看 diff、合并、提 PR　工作量大　推荐不做（交给会话里的 claude）

待问（评审消息）：
- Q1 「好几个窗口」指什么：A 一个窗口，侧边栏三层 + 快捷键，靠状态点和通知知道谁在等（推荐）；B 还要一个窗口里并排看 2–4 个会话；C 要真正的多个 macOS 窗口。
- Q2 从 vibe-remote 新建 worktree 时名字和基线怎么定：A 填一个名字作为分支名，基于发起处当前 HEAD（推荐）；B 另外可选基于哪个分支；C 保持自动命名。
- Q3 已有 worktree 里开对话界面，信任怎么算：A 项目主目录已被 claude 信任，它的 worktree 就可以开对话（推荐，与现有 Worktree 模式只查源目录一致）；B 每个 worktree 路径都要先用终端界面打开一次 claude。
- Q4 删会话丢提交的问题要不要先单独修：A 现在就作为一个独立小修复修掉（推荐）；B 随本需求一起改。

理想状态对照：现状 会话按机器平铺，worktree 建了就没人管 → 本次 按项目和 worktree 组织，worktree 可命名、可找回、可安全收尾 → 一年后 一个项目的多条并行工作线在一处总览（状态、改动、合并），可并排查看。

## 需求与验收场景

待评审回复后写。

## 假设

| # | 假设 | 依据 |
|---|------|------|
| H1 | 第三层是 worktree，用它检出的分支名显示；没有 worktree 的分支不单独列出 | 一个目录同一时刻只能检出一个分支，并行工作必须落在不同目录 |
| H2 | 项目开过会话后留在侧边栏，直到用户手动移除；移除只是不再显示，不删任何文件 | 否则会话删完项目就消失，留在磁盘上的 worktree 又看不见了（现状痛点 2） |
| H3 | 只有一个 worktree 且只有一个会话的项目，在侧边栏不比现在多占行 | 不让不用 worktree 的用户为新层级付出代价 |
| H4 | 本需求叠在双模式会话（`change/dual-mode`，未合并）之上 | 需求涉及对话会话；`docs/changes/` 和 `.devflow.yml` 目前只在该分支 |

## 问答记录

- 2026-11-16 用户（讨论中）：是不是应该三个维度，机器、项目、项目的某个 worktree 或者分支 → 采纳为做法 B；第三层具体为 worktree（见 H1），会话挂在 worktree 下。

## 效果页

评审回复后生成。

## 变更记录

- 2026-11-16 建立草案，发出评审消息。
