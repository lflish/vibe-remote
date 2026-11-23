# 反向检查：每个用例都见过它失败

做法：不改产品代码，把 `desktop/` 复制到临时目录、在副本里放进缺陷后 `vite build`；daemon 的缺陷放在基于 HEAD 的临时 `git worktree` 里构建（用完即删）。然后用 `VR_DESKTOP_DIR=<副本> VR_DAEMON=<带缺陷的 daemon> node .claude/skills/verify/scripts/gui-worktree-smoke.mjs --no-build` 跑同样的用例。期望：负责这个缺陷的用例 FAIL。

一共 5 次运行（缺陷之间会互相连累，所以分开放）：

1. 桌面端 43 处缺陷 + daemon 5 处（清单不记、白名单外也列、目录名、删会话连目录一起删、项目列表变慢）：61 个用例里 58 个 FAIL。连累很重（项目清单没了以后很多用例找不到入口），只取其中 4 个因为自己的缺陷失败的：R1.5、R1.6、R2.2、R5.10。
2. 桌面端 39 处 + daemon 3 处（去掉上面连累别人的几处）：54 个 FAIL；没有 FAIL 的 7 个是这一轮没有对应缺陷的（R1.6、R2.2、R5.10 见第 1 次；R6.2、R7.5 见第 3 次；R8.3、R9.2 见第 5 次）。
3. 桌面端另 8 处（与第 2 次互相冲突的那些）：只跑对应的 9 个用例，7 个 FAIL；R8.1 没有 FAIL（那一处缺陷没有改到主卡片实际用的阴影变量，R8.1 以第 2 次为准），R8.4 因别的用例留下的对话框而失败（不算，R8.4 的两半以第 2、4 次为准；`resetUi` 随后改成一定收掉遗留的对话框）。
4. 桌面端 3 处（光标颜色、对话框高度、状态点形状）：R8.2、R8.4、R8.5 都 FAIL（R8.4 这次是状态点：`"new output" is not a ring`）。
5. R9.2：daemon 把自动命名的前缀改掉 → FAIL。R8.3：从 `gui-smoke.mjs` 删掉一行 `check(` → FAIL，随后 `git checkout` 还原。

下表每行：用例、放进去的缺陷、它失败时的输出（截到 230 字）。有几个用例失败在比标题更靠前的断言上（例如 R3.3 先撞上「什么都没输入时确认按钮应不可用」），同样说明它会失败，原样照录。

| 用例 | 缺陷 | 哪次运行 | FAIL 时的输出 |
|------|------|----------|----------------|
| R1.1 | （桌面端）所有会话行都用对话图标 | 第 2 次 | `the chat and the terminal session have the same icon` |
| R1.2 | （桌面端）单 worktree 项目的行上不显示分支 | 第 2 次 | `branch on the project row: got null, want "dev"` |
| R1.3 | （桌面端）非 git 项目也有项目菜单 | 第 2 次 | `worktree entries on a non-git project: ["project-new-session","project-menu"]` |
| R1.4 | （桌面端）同名会话不加序号 | 第 2 次 | `names of the three sessions in main, in the order they were created: got ["devflow","devflow","devflow"], want ["devflow","devflow 2","devflow 3"]` |
| R1.5 | （桌面端）项目的先后每次渲染随机颠倒 | 第 1 次 | `refreshes that showed another order: got 19, want 0` |
| R1.6 | （桌面端）折叠的项目行从不显示状态点 | 第 1 次 | `timeout (15000ms): dot on the folded project row` |
| R1.7 | （桌面端）通知标题不带分支 | 第 2 次 | `notification title: got "this-mac · devflow · 登录修复", want "this-mac · devflow / fix-login · 登录修复"` |
| R1.8 | （桌面端）detached 的 worktree 标签为空 | 第 2 次 | `label of the detached worktree: got "", want "a30dc1b"` |
| R2.1 | （桌面端）没有会话的 worktree 下没有「新建会话」 | 第 2 次 | `no "new session" entry: ["worktree-new-session","worktree-menu"]` |
| R2.2 | （daemon）项目清单不被记住：`ProjectStore.Projects()` 返回空 | 第 1 次 | `after deleting the session: keep is gone from the sidebar` |
| R2.3 | （桌面端）「从侧边栏移除」什么都不做 | 第 2 次 | `timeout (8000ms): rm gone from the sidebar` |
| R2.4 | （桌面端）项目下有会话时菜单项仍可点 | 第 2 次 | `the menu item: got {"disabled":false,"note":"这个项目下还有会话，先结束会话才能移除"}, want {"disabled":true,"note":"这个项目下还有会话，先结束会话才能移除"}` |
| R2.5 | （桌面端）目录不在的会话不标出来 | 第 2 次 | `the session row does not say its directory is gone: {"id":"1795110378468-ea338f05","ui":"terminal","name":"x","dot":"none","active":false,"meta":"终端","gone":false,"icon":true,"dotEl":true}` |
| R2.6 | （daemon）白名单之外的 worktree 也列出来 | 第 2 次 | `the sidebar mentions the outside worktree: {"name":"solo","id":"<work>/n/solo","branch":null,"error":null,"dot":null,"collapsed":false,"buttons":["project-new-worktree","project-menu"],"worktrees":[{"label":"main","path":"<work>/n…` |
| R2.7 | （桌面端）读不到的项目不显示任何说明 | 第 2 次 | `the row of the missing repository: got null, want "仓库目录不存在"` |
| R3.1 | （桌面端）新建 worktree 对话框总是建终端会话 | 第 2 次 | `timeout (30000ms): new chat session on lab-mac` |
| R3.2 | （daemon）带斜杠的名字，目录名把 `/` 换成 `_` 而不是 `-` | 第 2 次 | `verdict on the name: got ["","<work>/l/webapp-worktrees/change_foo"], want ["","<work>/l/webapp-worktrees/change-foo"]` |
| R3.3 | （桌面端）本地不再判断 `..` | 第 2 次 | `Confirm before anything is typed: got true, want false` |
| R3.4 | （桌面端）不管 daemon 怎么回答，确认按钮都可点 | 第 2 次 | `verdict on the name: got ["分支 taken-branch 已存在",true], want ["分支 taken-branch 已存在",false]` |
| R3.5 | （桌面端）不管 daemon 怎么回答，确认按钮都可点 | 第 2 次 | `verdict on the name: got ["目录已存在：<work>/l/webapp-worktrees/occupied",true], want ["目录已存在：<work>/l/webapp-worktrees/occupied",false]` |
| R3.6 | （桌面端）「基于…」一行不提未提交的改动 | 第 2 次 | `the line about the base: got "基于 main @ 32eb479", want "基于 main @ 32eb479，不包含未提交的改动"` |
| R3.7 | （桌面端）重放的新建带一个新的会话 id | 第 2 次 | `timeout (15000ms): new session 1795110415255-8613a9a9 shown` |
| R3.8 | （桌面端）新建失败不留任何提示 | 第 2 次 | `timeout (20000ms): the error in the status bar` |
| R3.9 | （桌面端）目录选择器的 Worktree 模式不出现名字输入框 | 第 2 次 | `timeout (15000ms): picker in worktree mode` |
| R3.10 | （桌面端）不管 daemon 怎么回答，确认按钮都可点 | 第 2 次 | `verdict on the name: got ["目录不在允许的范围内：<work>/n/solo-worktrees/blocked",true], want ["目录不在允许的范围内：<work>/n/solo-worktrees/blocked",false]` |
| R4.1 | （桌面端）对话框标题不带 worktree 名 | 第 2 次 | `dialog title: got "新建会话", want "在 fix-login 新建会话"` |
| R4.2 | （桌面端）worktree 行上新建的会话落在项目主目录 | 第 2 次 | `pwd is not <work>/a/devflow/.devflow-tmp/worktrees/general-skills:` |
| R4.3 | （桌面端）worktree 行上新建的会话落在项目主目录 | 第 2 次 | `working directory of the chat session: got "<work>/a/devflow", want "<work>/a/devflow/.devflow-tmp/worktrees/general-skills"` |
| R4.4 | （桌面端）置灰原因不提项目主目录 | 第 2 次 | `the interface cards: got {"chatDisabled":true,"reason":"先用终端界面在该目录打开一次 claude 以信任此目录","terminal":"true","terminalDisabled":false,"confirm":true}, want {"chatDisabled":true,"reason":"先用终端界面在项目主目录 <work>/l/untrusted 打开一次 claude，信任这个…` |
| R4.5 | （桌面端）worktree 行上新建的会话落在项目主目录 | 第 2 次 | `timeout (10000ms): the second session under fix-login` |
| R4.6 | （桌面端）worktree 行上新建的会话落在项目主目录 | 第 2 次 | `timeout (30000ms): new chat session on lab-mac` |
| R5.1 | （桌面端）删会话确认框不提 worktree | 第 2 次 | `what the confirmation says about the worktree: got null, want "worktree r51 的目录和分支都会保留，之后可以在侧边栏继续使用，或者单独删除。"` |
| R5.2 | （桌面端）删干净已合并的 worktree 时不请求删分支 | 第 2 次 | `on disk: got {"dir":false,"listed":false,"branch":true}, want {"dir":false,"listed":false,"branch":false}` |
| R5.3 | （桌面端）有东西会丢时回车仍然是删除 | 第 3 次 | `focused / default button: got ["delete-wt-force","delete-wt-force"], want ["dialog-cancel","dialog-cancel"]` |
| R5.4 | （桌面端）不提被忽略的文件 | 第 2 次 | `the confirmation: got ["clean",null,null], want ["clean",null,"另有 4 个被 git 忽略的文件会一并删除。"]` |
| R5.5 | （桌面端）预选的是「目录和分支都删」 | 第 2 次 | `preselected choice and default button: got [false,true,"dialog-cancel"], want [true,false,"dialog-confirm"]` |
| R5.6 | （桌面端）确认框不写会先结束几个会话 | 第 3 次 | `the confirmation: got ["clean",null], want ["clean","会先结束这 2 个会话。"]` |
| R5.7 | （桌面端）主目录一行也有删除菜单 | 第 2 次 | `the main row has a menu: ["worktree-new-session","worktree-menu"]` |
| R5.8 | （桌面端）不写「不是由 vibe-remote 创建」 | 第 2 次 | `the line about who created it: got null, want "这个 worktree 不是由 vibe-remote 创建：只删目录，分支 ext/tool 保留。"` |
| R5.9 | （桌面端）确认框里不显示失败原因 | 第 2 次 | `timeout (20000ms): the reason in the dialog` |
| R5.10 | （daemon）删除终端会话时把它的 worktree 目录一起删掉 | 第 1 次 | `on disk: got [{"dir":false,"listed":true,"branch":true},{"dir":false,"listed":true,"branch":true}], want [{"dir":true,"listed":true,"branch":true},{"dir":true,"listed":true,"branch":true}]` |
| R5.11 | （桌面端）有东西会丢时回车仍然是删除 | 第 3 次 | `focused / default button: got ["delete-wt-force","delete-wt-force"], want ["dialog-cancel","dialog-cancel"]` |
| R5.12 | （桌面端）确认框里不显示失败原因 | 第 2 次 | `timeout (30000ms): the error in the dialog` |
| R6.1 | （桌面端）`-c` 的说明从不出现 | 第 2 次 | `timeout (5000ms): the note` |
| R6.2 | （桌面端）目录里没有会话时也显示 `-c` 的说明 | 第 3 次 | `the note: got "这个目录已有会话正在用最近那段对话：对话界面会切到已有的那个会话，终端界面可能无法启动。不勾选即可开一段新对话。", want null` |
| R7.1 | （桌面端）⌘n 打开的是第 n+1 个 | 第 2 次 | `key 3: session shown is 1795110468510-309923ae, want 1795110346470-0d56497b` |
| R7.2 | （桌面端）⌘⇧] 到最后一个不回到第一个 | 第 3 次 | `key next: session shown is 1795110694590-441669ea, want 1795110693507-3a9ca02e` |
| R7.3 | （桌面端）按键不被拦截（去掉 `preventDefault` / `stopPropagation`） | 第 2 次 | `⌘3 in a focused terminal was not intercepted: 3: seen>page>bubble` |
| R7.4 | （桌面端）对话框开着时快捷键照样切换 | 第 3 次 | `key 2 changed the session shown to 1795110693580-a0ba59a1` |
| R7.5 | （桌面端）不跳过折叠项目里的会话 | 第 3 次 | `⌘⇧] went to 1795110694278-d4fb957c, want 1795110694590-441669ea` |
| R8.1 | （桌面端）用户消息气泡不靠右 | 第 2 次 | `the user bubble 807..951 is not at the right of the column 403..1151` |
| R8.2 | （桌面端）终端光标取前景色而不是 `--term-cursor` | 第 4 次 | `timeout (4000ms): pixels in the cursor color #6B54D3` |
| R8.3 | （脚本）从 `gui-smoke.mjs` 删掉一行 `check(`（跑完即还原） | 第 5 次 | `gui-smoke.mjs: 1 asserting line(s) of the version before are gone or changed, e.g. check(createdSessions.size === 1, 'exactly one session created on the daemon', …` |
| R8.4 | （桌面端）次要文字颜色调浅（`--text-muted`） | 第 2、4 次 | `439 of 950 texts below their minimum: chat session .session-meta "对话" #B4B2C0 on #DDD7F5 = 1.5 (< 3); chat session .session-meta "终端" #B4B2C0 on #EFEF… ／ "new output" is not a ring: {"state":"output","filled":true,"border":0,"ring":false,"size":8,"color":"#6F6C86","on":"#EF` |
| R8.5 | （桌面端）`.modal` 的 `max-height` 不再跟窗口高度走 | 第 4 次 | `19 layout problem(s) in 26 measurements: [zh-CN picker, worktree mode, name refused] dialog 140,-200..660,700 leaves the 800×500 window ¦¦ [zh-CN picker, worktree mode, name refused] dialog: button "取消" 645..679 is outside the 800…` |
| R8.6 | （桌面端）窗口底色改成深色 | 第 2 次 | `window background when it is first shown: got "#1E1E1E", want "#EFEFF4"` |
| R9.1 | （桌面端）旧 daemon 的机器下没有说明条 | 第 2 次 | `the note under the machine: got null, want "vibe-remoted 版本较旧：不能新建或删除 worktree，没有会话的 worktree 不会列出。升级 vibe-remoted 后可用。"` |
| R9.2 | （daemon）不带名字的 Worktree 模式，分支前缀从 `vibe/` 改成 `vibez/` | 第 5 次 | `mode, branch and directory of the session: got ["worktree","vibez/<id>","<work>/k/keep-worktrees/<id>"], want ["worktree","vibe/<id>",…]` |
| X11.menu | （桌面端）侧边栏重建时关掉开着的菜单 | 第 2 次 | `the menu closed when the sidebar was rebuilt` |
| X11.removing | （桌面端）删除请求在途时不标记这一行 | 第 2 次 | `24 of 24 samples show an ordinary row while it was being deleted, first at 11 ms: {"t":11,"removing":false,"buttons":["worktree-new-session","worktree-menu"]}` |
| NFR.perf | （daemon）`/api/v1/projects` 每次多等 300 ms | 第 2 次 | `/api/v1/projects takes 414.8 ms (median of 15)` |

`ws-worktree-smoke.mjs` 的反向检查用的是真实的旧提交（`VR_DAEMON=<那个提交构建的 daemon>`），正好是评审里记录的两次回归：

- `6c77d1c`（评审第二轮的 R1：socket 不存在就一律拒绝）：4 个 tmux 用例 FAIL（全新 socket 目录和没有 tmux 程序时删除得到 500；另两个的 500 没有说明原因）。
- `1d9a6f1`（评审第三轮的 T1、T2：放得太宽）：「socket 文件被删而 server 还活着」「PATH 里没有 tmux 而 socket 在」两个用例 FAIL（删除返回 200，没有先结束会话）。
- HEAD：9 个用例都通过。
