# 横切面静态评审

范围：`6d88e45..e278f87f6f80ea98c2c20fa3bd0beb32ef0105ec`，不将 `docs/changes/` 流程文档的改动作为代码评审对象。需求依据为 `docs/changes/2026-11-16-project-worktrees/` 下的 `spec.md`、`design.md`、`tasks.md`、`decisions.md`。

共 **14 个问题，严重 0 个、一般 14 个**。其中包含协议与规则声明不一致、自动化覆盖不足；覆盖不足不等于已经证明当前界面或排序实现错误。三个未参与开发的子评审分别静态检查检查变化、协议、场景覆盖，由主评审复核并合并重复根因。没有运行测试、构建、daemon 或 tmux，没有访问网络或本地服务；唯一写入文件为本报告。

四项结论：

1. **已有检查未发现未经需求或裁决支持的放松。** 指定 diff 覆盖 38 个文件，其中 19 个基准已有文件、19 个新增文件；已有文件中的修改或删除逐项列在后文。已有等待超时、跳过条件、快照及 golden 文件未发现被放宽或删除。新增测试的两个局部自证断言另列证据限制，不把整个测试错误地判为无效。
2. **协议存在声明、可缺省性及错误响应说明的差异。** 问题 1、2、3、5、6、7；其余字段、路由、业务状态码与 fatal 值的逐项核对见清单。
3. **规则文件有两项先检查再运行 git 的承诺不实。** 问题 3 与协议合并计一次，问题 4 单列。其余新增技术断言的核对及全部 invariants 测试名称匹配见清单；没有发现 check 正则完全匹配不到对应包测试的情况。
4. **58 个场景均有至少一种已写自动化断言，但有未被断言覆盖的子句。** 问题 8–14。R8.3 仅有浏览器层检查，但脚本已经存在；不能称其完全没有自动化。全部 58 场景的覆盖边界见矩阵。

以下行号默认指 HEAD；注明“基准”的行号指 `6d88e45`。后文简称 `spec.md`、`tasks.md`、`decisions.md` 均位于上述需求目录。

## 问题

### [一般] 删除 worktree 请求没有校验协议规定的必填字段，缺少 sessions 仍可成功删除

- 位置：`vibe-remoted/internal/server/projects.go:107`；`vibe-remoted/internal/session/projects.go:692`；`desktop/src/shared/protocol.ts:85`；`docs/protocol.md:487`
- 证据：本批新增声明与处理代码：

  ```ts
  export interface WorktreeRemoveRequest {
    path: string;
    head: string;
    sessions: string[];
  }
  ```

  ```go
  var req protocol.WorktreeRemoveRequest
  if status, err := decodeJSONBody(w, r, &req); err != nil { /* 返回错误 */ }
  if req.Path == "" { /* 400 invalid_request */ }
  result, err := s.mgr.RemoveWorktree(req, ...)
  ```

  文档把 `head`、`sessions` 标为必填，处理函数仅检查 `path`。缺失或 `null` 的 sessions 解码为 nil；后续只遍历当前 `st.Sessions` 检查有没有未确认会话。对于无会话的干净 worktree，带正确 path/head、省略 sessions 或传 null，循环为空，删除仍可返回 200。缺 head 则在 `session/projects.go:703` 被当作状态改变返回 409，未被识别为必填字段缺失。`protocol.go:498` 的普通 string/slice 字段无法区分缺失与空值。
- 依据：用户第 2 项；`docs/protocol.md:484` 必填表；设计 4.6；R5 的确认请求必须如实表达用户看到了什么。
- 改法：在 REST 层区分缺失、null 与合法空数组；要求非空 path/head、非 null 的字符串数组 sessions，不满足返回 400 `invalid_request`。允许合法 `sessions:[]`，并把这一请求校验响应补到文档删除响应表。
- 类别：明确错误

### [一般] 删除端点会忽略首个 JSON 后的超长内容，不能保证超过 64 KiB 一律返回 413

- 位置：`vibe-remoted/internal/server/projects.go:108`；`vibe-remoted/internal/server/server.go:495`；`docs/protocol.md:404`
- 证据：

  ```diff
  -请求体（rename、events）上限 64 KiB，超出返回 413。
  +请求体（rename、events、worktrees/remove）上限 64 KiB，超出返回 413。
  ```

  ```go
  r.Body = http.MaxBytesReader(w, r.Body, maxRESTBody)
  if err := json.NewDecoder(r.Body).Decode(v); err != nil { /* 400 或 413 */ }
  return 0, nil
  ```

  新端点复用的函数只 Decode 一次，既不检查 EOF，也不核对完整请求长度。短且正确的删除对象后附超过 64 KiB 的空白或第二个 JSON，解码器可在首对象结束后成功返回，大小限制未被读到上限，删除逻辑仍会执行。这里只计新端点的契约缺口，不把基准已有 rename/events 同根因重复计入本批。
- 依据：用户第 2 项；`docs/protocol.md:404` 的 HTTP 413 承诺。
- 改法：在大小限制内读取完整请求并要求单个 JSON 后只有空白及 EOF；超限返回 413，多对象或非空白尾部返回 400。完成校验后再调用删除逻辑。
- 类别：明确错误

### [一般] 协议和安全规则声称拒绝未登记 worktree 路径前不运行 git，代码却先执行仓库探测

- 位置：`docs/protocol.md:447`；`CLAUDE.md:168`；`vibe-remoted/internal/session/projects.go:423`；`vibe-remoted/internal/session/worktree.go:178`
- 证据：本批新增文字包含“再必须是 daemon 自己……读到的一项”“不对这个路径运行 git”。实际顺序：

  ```go
  home, err := ResolveHome(path) // projects.go:423
  if !home.Git || home.Path != path { return Home{}, ErrWorktreeNotFound }
  // ResolveHome:
  out, err := gitAtTimeout(abs, "rev-parse", "--show-toplevel") // worktree.go:178
  wts, err := ListWorktrees(top) // worktree.go:194
  ```

  对白名单内规范的仓库子目录 `/repo/sub`，先运行 `git -C /repo/sub rev-parse --show-toplevel`，再因它不是根目录返回 404。白名单外和非规范路径确实先被拒绝；未登记或非根路径没有文档承诺的零 git 调用保证。这里只指出顺序声明不实，不声称这些拒绝路径被删除。
- 依据：用户第 2、3 项；协议行为、安全规则须与实际处理一致；spec 安全要求。
- 改法：将两处改成“先检查规范路径和白名单，再执行只读仓库发现和列表校验；通过后才允许删除”。如要保留所有未登记路径不运行 git 的承诺，应先从已知可信仓库的列表匹配目标，避免在尚未匹配的目标上运行 git。
- 类别：明确错误

### [一般] 名字以减号开头时仍先运行 git 探测，与规则的先拒绝承诺不符

- 位置：`.devflow.yml:74`；`CLAUDE.md:169`；`vibe-remoted/internal/session/worktree.go:519`；`vibe-remoted/internal/session/worktree_test.go:732`
- 证据：

  ```diff
  +rule: 客户端传的 worktree 名字不经 shell，以 - 开头的在调用 git 前被拒
  ```

  ```go
  home, err := ResolveHome(sourceAbs) // precheckWorktree:519，内部运行 git
  ...
  if err := ValidateWorktreeName(w, spec.Name); err != nil { return c, err } // :548
  ```

  REST plan 与终端/对话新建均走这一顺序，WS 入口没有预先名字校验。测试的“git 未运行”只通过 `ValidateWorktreeName(repo, "-x")` 验证局部函数，未通过 CreateWorktree/plan/attach。名字本身确实不会作为 git 选项传入，但 git 失败或超时可能先产生 `git_failed`/`create_failed`，覆盖原本明确的非法名字原因。
- 依据：用户第 3 项；新增 invariant 的字面承诺；R3.3 的非法名字原因。
- 改法：在 `precheckWorktree` 的仓库探测前做不依赖 git 的名字校验，并补完整入口的“减号名字零 git 调用”断言；或把规则精确改成“在名字交给 git 校验及创建命令前拒绝”，明确允许先探测仓库。保留名字不经 shell 的保证。
- 类别：明确错误

### [一般] 协议承诺创建失败绝不留目录和分支，却遗漏回滚失败及保留并发改动的例外

- 位置：`docs/protocol.md:272`；`vibe-remoted/internal/protocol/protocol.go:214`；`vibe-remoted/internal/session/worktree.go:655`
- 证据：

  ```diff
  +以上四个 v4 的错误发生时，daemon 不留下这次创建的目录和分支。
  ```

  ```go
  // v4: creating a worktree (all fatal; nothing is left behind)
  if err := allow(mapped); err != nil {
    return CreatedWorktree{}, withCleanup(err, claim.undo())
  }
  // withCleanup 保留原错误码：
  return fmt.Errorf("%w; cleanup: %v", err, cleanupErr)
  ```

  `worktree.go:715` 回滚 git remove 失败会保留内容；`:732` 以旧 OID 删除 ref 失败时，`:738` 明确报告分支已被移动而保留。`worktree_test.go:1267` 的 `TestUndoOnlyRemovesOwnArtifacts/branch_moved` 还断言移动后的分支存在。所以 `worktree_path_not_allowed` 等原错误码不能作为资源已完全清理的保证。
- 依据：用户第 2 项；R3.8；`decisions.md:46` 第 16 条要求只撤销仍属于本次的资源，保护并发修改。
- 改法：保留现有避免误删并发提交的策略，补文档和 Go 注释的例外：正常回滚不遗留本次资源，清理失败或身份已变时保留现场，并在消息中说明剩余资源。不要为兑现绝对描述而强删用户新提交；R3.8 的例外应与已确认需求明确对齐。
- 类别：取舍

### [一般] 项目列表响应在 TS 中遗漏 proto，并把必填 projects 改成可缺省

- 位置：`desktop/src/renderer/rest.ts:74`；`vibe-remoted/internal/protocol/protocol.go:423`；`docs/protocol.md:393`
- 证据：

  ```go
  type ProjectsResponse struct {
    Proto int `json:"proto"`
    Projects []Project `json:"projects"`
  }
  ```

  ```ts
  const body = await res.json() as { projects?: Project[] };
  return body.projects ?? [];
  ```

  文档及实际 handler `server/projects.go:19` 返回必填 `{proto, projects}`，共享 TS 文件没有对应响应类型，局部类型丢掉 proto 并接受缺 projects。缺键响应会被视为有效空列表，随后 `index.ts:451` 可将能力标为 v4。没有证据表明当前 daemon 已发出这种坏响应，但三处定义及可缺省性确实不一致。
- 依据：用户第 2 项明确要求每个响应字段及可缺省性三处一致；协议同步规则。
- 改法：在共享 TS 中补 `ProjectsResponse { proto:number; projects:Project[] }`，REST 使用该类型；若需要防御错误响应，显式校验并报错，避免把缺字段当有效空树。若有意宽容读取，应另说明读取策略，不把宽容类型当协议定义。
- 类别：取舍

### [一般] 新增项目端点文档没有列出实际读取错误枚举及请求校验错误

- 位置：`docs/protocol.md:393`；`vibe-remoted/internal/protocol/protocol.go:435`；`vibe-remoted/internal/session/projects.go:128`；`vibe-remoted/internal/server/projects.go:35`
- 证据：文档项目树只列 `error?`、`errorMessage?`，移除项目只列 204/404/409。实际本批代码：

  ```go
  Error string `json:"error,omitempty"` // repo_missing | git_failed
  ErrorMessage string `json:"errorMessage,omitempty"` // first line of git's output
  // buildProject:
  p.Error = "repo_missing" // 或 git_failed，并保留已有会话
  // handleRemoveProject:
  if err := json.Unmarshal(data, &body); err != nil || body.ID == "" {
    writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
  }
  ```

  请求的 JSON 不合法或缺 id 会得到未列出的 400 `invalid_request`；单个项目读取失败仍随 HTTP 200 返回 `repo_missing`/`git_failed`，这些枚举及 errorMessage 首行语义在协议文档没有说明。worktree/remove 的 400 `invalid_request` 也漏列，随问题 1 一并修复，避免重复计数。
- 依据：用户第 2 项要求逐项核对错误码、HTTP 状态码及实际 JSON 键。
- 改法：补项目级错误的枚举、原因文本、HTTP 200 局部失败及会话保留语义；给项目移除补 400 `invalid_request` 的触发条件。TS 开放字符串本身不与 Go 枚举冲突。
- 类别：明确错误

### [一般] 顺序测试把三项目八会话缩成每项目一个会话，漏测 worktree 与会话排序的独立预期

- 位置：`vibe-remoted/internal/server/projects_test.go:231`；`vibe-remoted/internal/session/projects_integration_test.go:305`
- 证据：

  ```go
  for _, name := range []string{"Beta", "alpha", "gamma"} { initRepoAt(t, ... ) }
  for _, name := range []string{"gamma", "alpha", "Beta"} {
    mustCreate(t, mgr, session.CreateOptions{Workdir: filepath.Join(root, name)})
  }
  first := getProjectsRaw(t, s)
  for i := 0; i < 40; i++ {
    if got := getProjectsRaw(t, s); got != first { /* 失败 */ }
  }
  ```

  后续只核对项目名称。重启测试只比较两个会话前后顺序；`desktop/scripts/test-tree.mjs:139` 明确测试保持 daemon 的输入顺序。没有针对 v4 多 worktree、多会话给出主目录在前、其余按分支、会话按创建时间的独立预期；稳定地返回错误顺序仍能通过这些检查。
- 依据：R1.5，`spec.md:110`；`tasks.md:41` 计划三项目八会话并核对三层顺序。
- 改法：构造三项目八会话，含同项目多个非主 worktree、同 worktree 多会话；逆序建分支，使会话 id 顺序与创建时间相反。40 轮与独立写出的完整项目/worktree/会话序列比较，而不是只与首轮响应比较。
- 类别：明确错误

### [一般] 三层侧边栏测试没有验证会话类型图标，图标丢失或两种类型画成同一图标仍能通过

- 位置：`desktop/scripts/test-sidebar.mjs:43`；`vibe-remoted/internal/server/projects_test.go:114`
- 证据：

  ```js
  const tree = buildTree([sess('s1', { workdir: '/r/devflow' }),
    sess('s2', { workdir: '/r/devflow-worktrees/fix-login' })], projects);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].dataset.ui);
  assert.ok('dot' in rows[0].dataset);
  ```

  服务端该场景的两个会话均为终端。全套 GUI 已另测 terminal/chat 的 data-ui，不能说类型完全未测；但唯一精确检查 `.session-kind-icon svg` 的 `test-sidebar.mjs:291` 是工具栏标题，不是侧边栏行。侧边栏图标存在且区分类型没有断言。
- 依据：R1.1，`spec.md:94` 要求主目录对话、另一 worktree 终端，两行带界面类型图标；`tasks.md:30`。
- 改法：给两行明确设置 chat/terminal，以 id 查对应侧边栏行，检查其 SVG 存在、类型标识或 SVG 内容不同、所属 worktree 正确。
- 类别：明确错误

### [一般] 折叠项目的测试只断言点存在，未验证它显示等你处理的状态

- 位置：`desktop/scripts/test-sidebar.mjs:146`；`desktop/src/renderer/sidebar.ts:203`
- 证据：

  ```js
  const dotOf = () => 'waiting';
  const collapsed = render(..., { collapsedProjects: ..., dotOf });
  assert.ok(tid(collapsed, 'project-dot'));
  assert.equal(tid(collapsed, 'session-row'), null);
  // 展开后只检查会话的 data-dot：
  assert.equal(tid(expanded, 'session-row').dataset.dot, 'waiting');
  ```

  汇总纯函数返回 waiting 另有测试，但 DOM 中将 `dot.className = 'session-unread waiting'` 错写成 idle 或普通点时，折叠项目的上述存在性断言仍成立。
- 依据：R1.6，`spec.md:114` 要求折叠项目和展开后会话显示同样的等用户状态点。
- 改法：检查折叠点包含 waiting、不含 idle/output/hidden；展开后比较同一状态；idle/output 输入时检查折叠项目不出现待处理点。
- 类别：明确错误

### [一般] 对话 M1 外观只锁定少数 CSS 属性，工具块和权限卡片完整形态尚无自动化断言

- 位置：`desktop/scripts/test-theme-tokens.mjs:322`；`docs/changes/2026-11-16-project-worktrees/tasks.md:178`
- 证据：新增 `chat_shape_rules` 检查用户气泡背景/圆角/右对齐、输入框圆角、发送按钮圆形、助手文字无背景/边框，最后对权限卡片仅检查：

  ```js
  assert.equal(decls('.chat-instance .perm')['border-radius'], 'var(--radius-card)');
  ```

  既有 chat 测试核对功能，GUI chat 检查工具调用、权限交互，但没有工具块和权限卡片整体 M1 形态的断言。`tasks.md:178` 单列运行中完整画面检查；开发记录里的并排截图不能替代自动化验收。R8.2 的实际终端绘制颜色同样仍是浏览器子项，已有四主题色与 ANSI 常量断言可覆盖其数据侧。
- 依据：R8.1，`spec.md:329` 明列用户、助手、工具块、权限卡片、输入框与 M1 一致；R8.2；`tasks.md:177`、`:178`、`:180`。
- 改法：补含真实来回消息、工具块、权限请求的浏览器画面断言或经审定基准图的视觉比较，明确检查相关容器布局、背景、边框、间距；同时核对终端实际绘制四主题色。保留已有功能测试，不用少数圆角属性声称完整外观覆盖。
- 类别：取舍

### [一般] 800×500 中英双语及新增删除对话框各形态尚无完整真实布局断言

- 位置：`desktop/scripts/test-dialog-layout.mjs:14`；`.claude/skills/verify/scripts/picker-layout.mjs:52`；`docs/changes/2026-11-16-project-worktrees/tasks.md:186`
- 证据：

  ```js
  const calls = [...source.matchAll(/\bmodal\.(?:appendChild|append|prepend|insertBefore|replaceChildren)\(([^)]*)\)/g)];
  assert.deepEqual(direct.slice(i, i + 3), SHELL);
  // 既有 picker 的真实测量只改高度：
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height, ... });
  ```

  结构测试只读 header/body/footer。GUI chat 在 `gui-chat-smoke.mjs:1145` 固定 zh。计划 `tasks.md:186` 要新增 `shell-layout.mjs`，在 800×500 中英文测侧边栏、新建及删除各形态，该文件不存在。已有斜杠菜单最小窗口检查和侧边栏默认宽度测量不能覆盖全部新对话框。
- 依据：R8.5，`spec.md:345`；`tasks.md:185`、`:186`。这是已留给 dev-test 的界面覆盖空白，不是当前布局错误的运行证据。
- 改法：补该浏览器脚本，固定 800×500，zh/en 各轮打开新建会话、新建 worktree、删除会话、clean/files/commits/detached/external/失败说明组合；断言窗口边界、文字裁切、元素重叠与 `elementFromPoint` 主按钮命中。
- 类别：取舍

### [一般] 对比度测试的固定色值表没有验证实际按钮使用的合成背景

- 位置：`desktop/scripts/test-theme-tokens.mjs:154`；`desktop/src/renderer/styles.css:956`；`docs/changes/2026-11-16-project-worktrees/tasks.md:184`
- 证据：

  ```js
  ['danger button text', '--on-accent', '--error', 4.5],
  ['neutral button text', '--on-accent', '--text-primary', 4.5],
  ```

  ```css
  .modal-footer .btn-danger:hover {
    background: color-mix(in srgb, var(--error) 86%, var(--text-primary));
  }
  .modal-footer .btn-neutral:hover {
    background: color-mix(in srgb, var(--text-primary) 86%, var(--bg-elevated));
  }
  ```

  固定 PAIRS 没有这两个合成背景，也未读取选择器的实际前景/背景绑定。已有 glow 测试处理了一处透明叠加，不能泛称所有合成色未测；但 `tasks.md:184` 要求的运行中实际元素色对检查尚未写好。没有静态证据证明当前两种按钮对比度不达标。
- 依据：R8.4，`spec.md:341` 要求文字与各自实际背景的比值；`tasks.md:182` 至 `:184`。
- 改法：浏览器里覆盖按钮正常、hover、焦点状态，读取计算颜色并与实际背景合成，按按钮文字 4.5 阈值检查；静态测试从选择器提取色对，避免 CSS 改了、固定表仍通过。
- 类别：取舍

### [一般] 冷启动检查只验证源码色值一致，没有首帧不闪烁的自动化断言

- 位置：`desktop/scripts/test-theme-tokens.mjs:220`；`docs/changes/2026-11-16-project-worktrees/tasks.md:188`
- 证据：

  ```js
  const m = /backgroundColor:\s*'(#[0-9A-Fa-f]{6})'/.exec(mainSource);
  assert.equal(m[1].toLowerCase(), vars['--bg-app'].toLowerCase());
  assert.equal(m[1].toUpperCase(), '#EFEFF4');
  ```

  它可发现配置值变更，无法检查窗口首次绘制时样式是否已加载。已有 GUI 截图在启动并等 DOM 后获取，没有冷启动第一帧颜色断言；计划 `tasks.md:188` 的首帧检查尚未写好。
- 依据：R8.6，`spec.md:349`；`tasks.md:187`、`:188`。
- 改法：用独立临时 userData 冷启动，捕获窗口首次显示前后连续帧，检查未出现旧米色或深色、窗口背景为 M1 色。保留现有源码一致性检查。
- 类别：取舍

## 检查 1：已有检查改动完整清单

实际读取了用户指定的 `git diff 6d88e45..HEAD -- '*_test.go' 'desktop/scripts/*.mjs' '.claude/skills/verify/scripts/*'`，并用零上下文 diff 的全部删除行及 hunk 交叉核对。以下 30 项包含全部已有文件的修改或删除；大块重排按完整旧函数核对，避免把 git 偶然对齐的新增测试当成旧断言的替代。所有依据均是需求行为改变或测试接线适配，没有发现为了让本应出现的失败消失而改检查。

| 项 | 位置和旧→新 diff 片段 | 判定与依据 |
|---|---|---|
| A01 | `.claude/skills/verify/scripts/gui-smoke.mjs:407`：`- // 9. Chat sessions...`；`+ await sidebarCase(sessionId)`；原 `await chatCases()` 仍在 :412，新加布局/快捷键步骤 | 只增检查及改注释编号。R8.3；decisions.md:24 保留已有用例和断言。 |
| A02 | `.claude/skills/verify/scripts/ws-chat-smoke.mjs:416`：`- info.proto !== 3`；`+ info.proto !== 4`；`!info.chat?.supported` 不变 | 精确版本跟随协议 4；decisions.md:15、:17、:23（c1）。 |
| A03 | `desktop/scripts/chat-test-util.mjs:74`：`- views, machineSessions, machineOnline`；`+ … machineTrees, machineCaps, machineProjects`；:77 新增导出 refreshAllMachines | 扩大测试可访问接线，无断言删除；decisions.md:88 第46条。 |
| A04 | `vibe-remoted/internal/protocol/protocol_test.go:41`：`- Version != 3 / want 3`；`+ Version != 4 / want 4` | 仍为精确断言；协议版本裁决，decisions.md:15、:17、:43。 |
| A05 | `vibe-remoted/internal/server/contract_test.go:103`：`- TestInfoAndReadyProto3`；`+ TestInfoAndReadyProto4` | 名称随版本；decisions.md:23。 |
| A06 | 同文件 :119：`- info.Proto != 3 / want 3`；`+ info.Proto != 4 / want 4` | /info 精确值变化，理由同 A04。 |
| A07 | 同文件 :131：`- ready.Proto != 3 / want 3`；`+ ready.Proto != 4 / want 4` | ready 精确值变化，理由同 A04。 |
| A08 | `vibe-remoted/internal/server/worktree_test.go:21`：`- TestDeleteDirtyWorktreeReturnsStructuredConflict`；`+ TestDeleteSessionNeverReturnsPreserved`；基准 :17 的 dirty fixture 改成 clean/unmerged、uncommitted、ignored 三组 | R5.10、H16；decisions.md:23。新增 fixture 的 .gitignore 用来测 ignored，不是检查忽略规则。 |
| A09 | 同文件 :62：原 New、httptest.NewRequest、Authorization、ServeHTTP 五行改缩进到子测试 | 每组仍走真实 handler；无检查语义变化。 |
| A10 | 同文件 :68：`- w.Code != StatusConflict` 及 preserved/message/path/branch JSON 检查；`+ w.Code != StatusNoContent || w.Body.Len() != 0`；:71 新查会话消失、文件条目、分支 tip/提交数 | R5.10、H16、decisions.md:23 改删会话语义。原错误响应应消失，资源保留反而加强。 |
| A11 | `vibe-remoted/internal/session/chat_manager_test.go:253`：`- !os.IsNotExist(err)`；`+ err != nil`；新增 branchOID 非空 | R5.1、H16；decisions.md:23 点名此末段从删除改保留。 |
| A12 | 同文件 :1164：`- parseTmuxSessionLine(...u\textra); !ok`；`+ ...; ok`；删“末列 tab 留在值里”注释 | 10 列从接受改拒绝。新格式严格为 8/9/13 列，claudeU 已非末列；decisions.md:85 第43条。另有新增 parser 测试守新列。 |
| A13 | `vibe-remoted/internal/session/manager_test.go:84`：`- …RecoveredCleanWorktreeRemovesGitResources`；`+ …KeepsGitResources`；:86 CreateWorktree 调用改 WorktreeSpec | H16、decisions.md:23；名称和 API 适配。 |
| A14 | 同文件 :107、:110：`- 目录不存在 / branch --list 为空`；`+ 目录存在 / branchOID 非空 / 会话不在表中` | R5.1/R5.10、H16。OID 检查真实 Git 引用，无自证数据。 |
| A15 | 同文件 :125：`- WriteFile(filepath.Join(...), "keep")`；`+ changed := filepath.Join(...); WriteFile(changed, "keep")` | fixture 抽变量，内容未变。 |
| A16 | 同文件 :130：`- Delete 返回 WorktreePreservedError`；`+ Delete 返回 nil；Get 会话不存在` | H16 删除成功会话不再作为 preserved metadata 留表；decisions.md:23。 |
| A17 | 同文件 :136、:139、:142：旧只 Stat 目录及匹配 branch --list；新检查 bareProcessGone、ReadFile 等于 keep、branchOID 非空 | 同需求下检查更强。不能把 diff 将旧 branch 行对齐到后面的新测试理解为分支检查丢失。 |
| A18 | 基准 manager_test.go:138 的删 changed 后重试 Delete、metadata 消失删除；新函数 :130 已要求第一次删除成功；后续 :210、:240 是另增两个生命周期测试 | H16 取消 preserved 重试路径，非隐藏错误；decisions.md:23。原目录/分支保留在 :139、:142 已查。 |
| A19 | `vibe-remoted/internal/session/shutdown_test.go:32`：`- close(entered); <-release`；`+ if os.Stat(path) 成功 { hold.Do(close entered; wait release) }` | 只卡“worktree 已建好”检查点，避免两次 ValidateWorkdir 重复 close；decisions.md:93 第51条。Shutdown(5s)、time.After(300ms) 和断言均未改。 |
| A20 | `vibe-remoted/internal/session/worktree_test.go:49`：`- meta,mapped,err := CreateWorktree(sub,"abc123")`；`+ created,err := CreateWorktree(WorktreeSpec{…}); meta,mapped := …`；:54 `- defer CleanupWorktree(meta)`；`+ defer created.Undo()` | RepositoryRootSelection 的 SourceRepo/mapped 断言保留。T7/T13 API，decisions.md:46、:72；R3.8/R9.2。 |
| A21 | 同文件 :71：非法 sessionID 测试的 CreateWorktree 改签名 | 输入列表、invalid session ID 断言未变；R9.2/API 适配。 |
| A22 | 同文件 :96、:101：SymlinkAlias 的创建签名和 defer 改为 WorktreeSpec/Undo | canonical 路径精确断言未变；同 A20。 |
| A23 | 同文件 :120、:125：NestedSubdirectoryMapping 的签名和 defer 改为 WorktreeSpec/Undo | mapped 子目录及存在性断言未变；同 A20。 |
| A24 | 同文件 :136：RejectsNonGitDirectory 创建签名变化 | 仍要求错误包含 discover repository；同 A20。 |
| A25 | 同文件 :144、:149：GeneratedBranchAndPath 创建签名及 defer 变化 | vibe/session-1 与自动命名目录的精确预期保留；R9.2。 |
| A26 | 基准 worktree_test.go:150 删除 `TestWorktreeCleanCleanupRemovesWorktreeAndBranch`，含目录不存在、branch --list 空；对应新断言 `worktree_remove_test.go:390`、`worktree_test.go:1286` | H16/R5.2 将显式删除和创建撤销分开；两条路径分别检查目录/ref/登记删除。未保留旧名字，但资源删除检查没丢。 |
| A27 | 基准同文件 :167 删除 `TestWorktreeDirtyCleanupPreservesBoth`，含 preserved 类型/path/branch、目录存在、分支保留；对应 `worktree_remove_test.go:418` | R5.3、H16；新入口无同意返回 worktree_changed，检查三个文件、内容、目录分支 intact；同意才删除。decisions.md:23。 |
| A28 | 基准同文件 :192 删除 `TestWorktreeIgnoredFileIsPreserved`，含 `CleanupWorktree` 必须 error/asPreserved；对应 `worktree_remove_test.go:452` | R5.4、H10 明确 ignored 不算改动，新测 dirty=0、ignored=4、无 discardFiles 也删除。decisions.md:23、:66、:80；是需求变化。 |
| A29 | 基准同文件 :215 `- TestWorktreeRollbackToleratesMissingWorktreeOrBranch`；HEAD :162 `+ TestUndoToleratesMissingWorktreeOrBranch`；`- RollbackWorktree(meta)`；`+ created.Undo()` | 完整旧函数搬迁并改名，先删目录、连续两次 Undo 均 nil 的断言保留；decisions.md:64 第27条。 |
| A30 | 基准同文件 :232 删除 `asPreserved` 辅助函数及其类型断言 | WorktreePreservedError 因 H16 退出；新错误走 errors.Is/wantChanged，未删仍存在的错误路径。decisions.md:23。 |

A20、A22、A23、A25 的清理返回值在基准和 HEAD 都没有检查；换 defer 没有新增对失败的 catch/忽略。A26–A30 的大 diff 还混入新 GitEnv/ListWorktrees/ResolveHome/UnmergedCommits 测试，已按完整旧函数逐项检查，未依赖 diff 的行对齐猜测。

其余 **9 个基准已有文件只有新增内容**：

| 文件:行号 | 新增检查，旧断言保持 |
|---|---|
| `desktop/scripts/test-attach-replay.mjs:125` | 命名 worktree 自动/手动重放与 ready 后只以 sessionId 重接；R3.7。 |
| `desktop/scripts/test-chat-availability.mjs:106` | proto3 对话可用、proto2 至少需3、未信任 worktree 显示主目录原因；R4.4/R9.1。 |
| `desktop/scripts/test-picker-layout.mjs:39` | 旧 daemon 说明在 body 中及左右 padding；R8.5/R9.1。 |
| `vibe-remoted/internal/chat/store_test.go:141` | TestChatRecordHomeRoundTrip；H19/T2。 |
| `vibe-remoted/internal/config/config_test.go:357` | TestResolveAllowedNewPath；R3.10。 |
| `vibe-remoted/internal/server/fs_test.go:85` | TestFSChatTrustWorktree；R4.3。 |
| `vibe-remoted/internal/server/ws_chat_test.go:586` | 新 helper、:603 trusted-main 可创建、:619 untrusted 拒绝；R4.3/R4.4。 |
| `vibe-remoted/internal/session/idempotent_test.go:148` | TestNamedWorktreeReplaySameID；R3.7。 |
| `vibe-remoted/internal/session/runner_test.go:294` | TestParseTmuxSessionLineColumns，8/9/13 接受、10/11/12 拒绝并检查新增字段；T2。 |

上述有修改的文件中的新增 hunk 也全数读取：gui-smoke 的 import/sidebarRoot/keep/sidebarCase/shortcutCase/清理（:12、:16、:31、:42、:91、:426、:432、:565、:731）；server/worktree_test.go:116 后的 attach 名称、fatal、旧命名、handoff；chat_manager_test.go:1173 的 HandoffCopiesHome；manager_test.go:161、:210、:240、:634 后的生命周期、归属、重启、并发和回滚；shutdown_test 的 os/sync、sync.Once；worktree_test 新增的分支计数、列表、归属、GitEnv、名字向量、shell 反例、符号链接、并发及 Undo。未修改原等待时间、原跳过条件、快照或 golden；新增测试的平台能力 skip 不是既有检查放松。

新增文件 19 个也已检查断言：sidebar-layout.mjs；desktop 的 dialog-test-util.mjs、test-dialog-layout.mjs、test-legacy-daemon.mjs、test-rest-projects.mjs、test-session-form.mjs、test-shortcuts.mjs、test-sidebar.mjs、test-theme-tokens.mjs、test-tree.mjs、test-worktree-dialogs.mjs、test-worktree-name.mjs；server 的 compat_test.go、projects_test.go；session 的 projects_integration_test.go、projects_store_test.go、projects_test.go、trust_test.go、worktree_remove_test.go（Go 路径均在 vibe-remoted/internal/）。

新增断言的局部自证与限制：

| 位置及代码 | 能证明什么、不能证明什么 |
|---|---|
| `desktop/scripts/test-theme-tokens.mjs:193`：`assert.equal(PAIRS.length, 35)` | 表由同文件 :154 静态准备，该行只保护测试表条目数，产品变化无法让这一行失败。:195 实际读取 styles.css 色值并做阈值检查可失败，所以不能判整个 case 无效；35 不等于35个真实元素已覆盖，见问题13。 |
| `desktop/scripts/test-shortcuts.mjs:85`、:98：先 `area.value='draft'`，合成 dispatchEvent 后 `assert.equal(area.value,'draft')` | 合成 KeyboardEvent 不触发真实默认文本输入，单独 value 不变断言不能证明不写输入框；:94 的 defaultPrevented、监听器不运行以及 GUI :626 的真实草稿不变、:672 的零 WS data 有互补强证据。保留或注明限制即可，不计 R7.3 用户缺陷。 |

未发现整项通过“复制产品算法再与同算法比较”而不可失败的测试。projectHue 的恒定性、DOM CSS 变量接线、REST mock 响应解析和 Git 的独立目录/ref/文件检查都有生产调用可失败；WCAG 算法是外部标准，产品不运行同一计算，不属于实现同源自证。

## 检查 2：协议三处与实际处理清单

表中 `?` 表示可缺省；没有问号表示必填。所有 Go JSON 标签、TS 字段、文档及 handler 均按最终代码静态核对；“一致”不表示运行验证通过。REST 错误没有 WS fatal 字段，fatal 仅用于 error 帧。

| 对象 | 全部新增/改变字段及语义 | 定义、实际代码和结论 |
|---|---|---|
| 版本 | Version=4、PROTOCOL_VERSION=4；ready.proto、info.proto | `protocol.go:27`、`protocol.ts:20`、`docs/protocol.md:13` 一致；info/ready 精确断言同步改变。CHAT_MIN_PROTO=3 是本地能力常量，不是线上帧字段。 |
| attach | `worktreeName?:string`；省略/空串自动命名；仅新建 worktree 生效，handoff 忽略 | Go `protocol.go:122`、TS `protocol.ts:177`、文档 :125、`server/ws.go:266`、`ws_chat.go:94` 一致；命名预检先运行 git 的规则问题见4。 |
| WS 新错误 | invalid_worktree_name、worktree_branch_exists、worktree_path_exists、worktree_path_not_allowed，均 fatal=true | Go :215、TS 版本说明 :12、文档 :267、`ws.go:275`、`ws_chat.go:26` 的映射一致；清理绝对保证不符见5。 |
| 既有 create_failed 新原因 | git 创建失败、不支持仓库、worktree 正在被删除；fatal | `protocol.go:204`、文档 :260/:504、`ws.go:225`、`ws_chat.go:50` 一致。shutting_down 仍为非 fatal；新增错误没有改其重试语义。 |
| S→C 帧 | ready、sessions、data、exit、error 等既有字段、可缺省性 | 本批没有增删 S→C 字段；仅 proto 值和错误码/行为扩展。既有 golden、TestTerminalFramesUnchangedV3 未改；此处只核对源码及历史。 |
| GET /api/v1/projects | Bearer；200 `{proto,projects}`；旧 daemon 404；其他失败 RestError | 路由 `server.go:139`、`server/projects.go:14`、`rest.ts:70`、文档 :393 一致；包络 TS 类型差异见6。 |
| ProjectsResponse | `proto:number`、`projects:Project[]` 必填，空列表为 [] | Go :423、文档 :393、handler :19 一致；TS `rest.ts:74` 缺 proto、projects?，见6。 |
| Project | `id:string,name:string,git:boolean,error?:string,errorMessage?:string,worktrees:ProjectWorktree[],sessions:string[]` | Go :431、TS :104、文档 :393、`session/projects.go:121` 字段及可缺省性一致。错误枚举及 HTTP200 局部失败文档未说明，见7。 |
| ProjectWorktree | `path:string,branch?:string,head:string,detached?:boolean,main?:boolean,managed?:boolean,sessions:string[]` | Go :442、TS :30、文档 :393、`session/projects.go:170` 一致；head 前7位，false 可省略，空 sessions 为 []。 |
| POST /api/v1/projects/remove | 请求 id:string；204；404 project_not_found；409 project_has_sessions | 路由 server.go:140、handler projects.go:23、rest.ts:79、文档 :394 业务响应一致；代码还返回未文档化的400 invalid_request，见7。 |
| GET /api/v1/worktrees/plan | workdir 必填、name 可空，两者 URL 编码；只读 | 路由 server.go:141、handler projects.go:57/:67、rest.ts:121、文档 :421 一致。空名字返回 ok=false/invalid_worktree_name，但可提供 base。 |
| WorktreePlan | `ok:boolean,error?:string,message?:string,conflict?:string,project?:string,projectName?:string,base?:WorktreeBase,branch?:string,path?:string` | Go :455、TS :43、文档 :431、`session/projects.go:801` 一致。not_git 无项目/base；unsupported_repo/非法名字无 branch/path；branch 冲突才带 conflict。 |
| WorktreeBase | `branch?:string,head:string,detached?:boolean`，head 前7位 | Go :471、TS :60、文档 :438、`session/projects.go:843` 一致。 |
| plan 业务错误 | not_git、unsupported_repo、四个新增 worktree code；200/ok=false | Go :457、TS :45、文档 :434、session/projects.go:803/:819 一致；message 含原因，路径越界含完整路径，分支冲突带 conflict。 |
| plan HTTP 错误 | 缺 workdir→400 invalid_request；越界→403 path not in allowed roots；git 失败/超时→500 git_failed+message；旧daemon404 | handler projects.go:58/:63/:71、rest.ts:125、文档 :441 一致；403 JSON 与 fs 一致。 |
| GET /api/v1/worktrees/status | path；200；缺path400 invalid_request；404 worktree_not_found；500 git_failed+message | 路由 server.go:142、handler projects.go:78、rest.ts:134、文档 :449/:473 一致；未登记路径先git的承诺不符见3。主目录可查，Single 类型仓库status返回404。 |
| WorktreeStatus | 必填 `path:string,project:string,head:string,main:boolean,managed:boolean,dirtyFiles:number,unmergedCommits:number,ignoredFiles:number,sessions:string[]`；`branch?:string,detached?:boolean` | Go :481、TS :67、文档 :460、session/projects.go:497/:548 一致；head完整40位；ignoredFiles 失败为-1；sessions非null。 |
| status 数量定义 | dirty 不含ignored；unmerged不被其他本地/remote-tracking引用包含，detached不被任一引用包含；ignored只是说明，无同意项、不比对 | 文档 :468/:469/:470、`worktree.go:288`、:300、:770、`projects.go:521`、:701 一致。 |
| POST /api/v1/worktrees/remove 请求 | 必填 path/head/sessions；discardFiles?/deleteBranch?/dropCommits? 布尔，默认false | Go :498、TS :85、文档 :484 类型声明一致；handler 只查 path，缺失/null 语义不一致见1。 |
| 删除同意 | 外部忽略 deleteBranch；dirty未同意拒绝；删除会令未合并提交失去分支时才要求dropCommits | 文档 :489/:498、session/projects.go:701 一致。 |
| WorktreeRemoveResult | `removed:boolean,branchDeleted:boolean,branchError?:string,endedSessions:string[]`；200 | Go :509、TS :96、文档 :495、handler projects.go:120 一致。branch没删成是成功删除目录后的 branchDeleted=false+branchError。 |
| 删除业务错误 | 400 worktree_is_main；404 worktree_not_found；409 worktree_changed+message/status/endedSessions；500 worktree_remove_failed+message/endedSessions；500 git_failed+message/endedSessions=[] | handler projects.go:123 至 :137、文档 :493 一致；decode和缺path的400 invalid_request漏列，见1/7。409/500的endedSessions恒为数组。 |
| 删除阻止条件 | locked、checked-out子模块/嵌入仓库、内嵌另一worktree：结束会话前500 remove_failed；创建中409；删除中创建fatal create_failed | session/projects.go:650/:664/:672/:681、server/ws.go、文档 :498/:499/:504 一致。结束会话后再检查HEAD及失败实际结束列表与文档一致。 |
| 删除超时/断线 | min(60000,10000+5000×sessions.length)；客户端断开不取消删除 | rest.ts:19/:155、server/projects.go:116 不传请求context、文档 :506 一致。完整请求体上限承诺不符见2。 |
| DELETE sessions/{id} | 204，notfound404；v4只结束会话，不清worktree、不返回preserved409 | 文档 :398、server.go:325、session/manager.go:632、chat_manager.go:450 一致。rest.ts:58仍处理旧daemon409是R9兼容，不是协议4服务端还发409。 |
| fs.chatTrust 与 chat attach | trusted/untrusted/unknown类型不变；自身可信或可信主目录授权仓库自己列出的linked worktree根；子目录/bare/Single不继承 | 文档 :401、rest.ts 的 ChatTrust、server.go:465、ws_chat.go:86都走session.ChatTrust；trust.go:33两次列表核对一致。 |
| 互连与最低版本 | 聊天最低3；项目功能由projects端点能力判断；旧命名与旧删除提示保留 | protocol.ts:27、availability.ts:51、tree.ts 的nextCapability、index.ts:451、文档版本互连一致；未用最高协议4误禁用proto3聊天。 |

除问题1–7已经列明的差异，没有发现其它新增字段、业务状态码、fatal、数组缺省或路由不一致。`projects/remove` 的 `{id}` 是局部请求类型，Go与TS通过handler/REST明确同名；不要求每个只用于本地消费的结构都强制新增共享类型，但已存在的包络字段及可缺省性差异必须如实记录。

## 检查 3：新增规则的技术事实与 invariants 名称

CLAUDE.md 的新增/改写句子按技术断言拆开核对如下；未改变的旧规则不作为本批新增断言。表列出了该句中常量、函数、端点、行为及检查名称的依据。

| 规则位置 | 核对的技术断言及实际依据 | 结论 |
|---|---|---|
| CLAUDE.md:12 | 只改外壳M1形态，终端仍纯字节；index.ts:794/theme.ts、client.ts data通路，chat源码未随视觉变更 | 符合改动范围；完整M1视觉自动化不足另见11。 |
| :50 | GUI临时daemon/userData/mock-keychain、侧边栏布局、快捷键；TMUX_TMPDIR需要调用方隔离 | gui-smoke.mjs :432/:565 实有布局/键盘检查，终端daemon继承环境；chat daemon独立socket。命令指向现存脚本，无新增超时放宽。 |
| :76 | @vibe_remote_created/project/home；RFC3339Nano UTC写、Local读；session_created兜底；13列只兼容8/9/13 | runner.go:90/:149/:473、manager.go:179真实存在并按此工作；runner_test.go:298 有精确列检查。 |
| :95 | 项目主目录/非git自成项目；GET projects；列表阶段每项目一次worktree list、8并发、5秒；不执行status | projects.go:49/:208、projectsGitConcurrency=8、worktree.go:30/:105；列表阶段符合，首次补归属可能另做ResolveHome，不能把该句当全请求总git调用数。 |
| :97 | project/home归属创建时定，cd不改变；终端tmux、chat记录；git失败留空，Projects重试 | manager.go:288、chat_manager.go:305、projects.go:237/:274/:302；归属及记录字段真实。 |
| :98 | projects.json记录项目+自建路径/分支；remove只删记录，仍有会话409；managed要求路径和分支及安全旧命名；ProjectStore叶子锁，不在Manager.mu下文件IO | projects_store.go:19/:47/:240、projects.go:339、manager.go:414；项目存储调用在Manager快照/解锁后，判定宁可外部。 |
| :99 | Delete/deleteChat只结束会话；协议4不返回preserved409；客户端保留旧兼容 | manager.go:632、chat_manager.go:450、server.go:325、rest.ts:58；符合R5/H16。 |
| :100 | CreateWorktree、repoLocks、Mkdir/完整ref占位、detach+symbolic-ref、Undo只本次；预检共享precheckWorktree | manager.go:422/:444、worktree.go:509/:596/:645/:699、projects.go:801。共享检查存在；预检后外部并发变更仍可导致创建失败，不应把“同结论”理解为跨时刻事务承诺。 |
| :101 | status→remove带head/sessions/三个同意项；重查409；lock/checkout/nested提前500；先停会话再HEAD；force仅同意弃文件；失败报告endedSessions；主目录不可删 | projects.go:599/:664/:672/:681/:703/:711及后续复查、server/projects.go:128/:133。行为声明符合，必填解码校验缺口见1。 |
| :102 | startingDirs/removingRoots、两方向互斥、Manager.mu下标记；create→repo→session op→Manager→leaf顺序 | projects.go:379/:560、manager.go:499/:422、chat_manager.go的WithOp；映射409/fatal create_failed真实；ProjectStore不要求嵌套持锁。 |
| :103 | refs/heads、不调用git branch、不用-b/-B；LC_ALL=C、剥离GIT_DIR等；不解析翻译错误；Single限制 | worktree.go:35/:44/:449/:596/:699/:770、projects.go:779；动态分支按完整ref，状态判断用退出码/列表/文件系统。Single创建和remove限制实有。 |
| :105 | worktree/projects/store/trust及桌面tree/sidebar/dialogs/form文件职责 | 所列文件和函数存在，调用接线可追踪。 |
| :119/:121 | worktreeName、新五端点、proto4、S→C不加字段、两个旧帧测试、CHAT_MIN_PROTO=3 | protocol.go/ts版本和字段、server.go:139五路由、golden_test.go:147、compat_test.go:135、availability.ts:51；一致。 |
| :123 | 四个新错误fatal；对话chat_ack/ended旧语义不变 | ws.go:275、ws_chat.go:26；fatal映射一致。 |
| :127/:131 | REST端点、删除超时公式/断开不取消、会话与projects每5秒并行独立发布 | rest.ts:19/:150、server/projects.go:116、index.ts:426/:448；符合。 |
| :133 | buildTree纯函数、sidebar模型/动作、不导入index；v4/legacy/unknown；失败保持能力；旧分组稳定；扁平/编号/localStorage/捕获快捷键 | tree.ts、sidebar.ts、index.ts:72/:74/:80/:451、shortcuts.ts；对应测试实有。排序和图标/点的断言不足见8–10。 |
| :135 | :root颜色、变量/color-mix、test-theme-tokens；窗口色等于bg-app；终端四色读取/ANSI常量；modal只有body滚动；两个布局脚本 | styles.css、theme.ts:17、main/index.ts:102、test-theme-tokens.mjs、test-dialog-layout.mjs、verify/scripts/picker-layout.mjs均存在。静态/部分布局检查存在，不能据此认定完整R8.5/8.6已覆盖。 |
| :139 | 同newSessionId/worktreeName重放、ready后按id重接、beginCreate串行同id | client.ts、manager.go:499、test-attach-replay.mjs:125、idempotent_test.go:148；符合。 |
| :167 | ResolveAllowedWorkdir/ResolveAllowedNewPath白名单、符号链接、建前根及建后mapped重查 | config.go对应函数、worktree.go:560/:655/:667、manager.go:444；符合，回滚例外见5。 |
| :168 | path先规范及白名单、自身列表、主目录拒绝、分支源自列表/managed/同意；“不对路径运行git” | 前述删除约束存在；零git的绝对顺序声明不实，见3。 |
| :169 | 本地名字检查+check-ref-format输出相等、完整ref、exec参数无shell；减号名字git前拒绝 | worktree.go:391/:421/:439/:57；名字不作为shell/选项符合，但完整入口先探测git，见4。 |
| :170 | session.ChatTrust，fs与attach同函数，精确主目录+两次自身列表，未知拒绝、Single/bare/subdir只自身信任 | trust.go:33、server.go:465、ws_chat.go:86、chat/trust.go。目录内.git不作为单独授权依据，不等于git探测从不读取.git。 |
| :180 | state_dir两文件0700/0600、默认/相对配置目录；不可写chat不可用、项目内存退化、重启命名记录丢失 | config.go、main.go项目store初始化、projects_store.go:58/:76、chat/store.go；各函数与退化路径存在。 |

.devflow.yml 新增七条规则对应：删会话保资源（:66）、只删白名单内非主的列表项（:68）、外部分支不删（:70）、无同意不丢文件/提交及复查/嵌套拒绝（:72）、名字安全（:74）、信任规则（:76）、完整ref和Undo所有权（:78）。除减号名字零git的顺序承诺（问题4），其余断言均有上述实际代码支撑。七条新的 `-timeout 10m` 与独立 `TMUX_TMPDIR` 是新命令的限定，不是改大已有检查的超时；decisions.md:131 记录该配置裁决。

全部18条 invariant 的 check 已静态核对：11条原规则加7条新规则。以下为其中全部Go `-run` 名称/正则在指定包中实际匹配的 `func TestXxx`；未执行任何 check。路径前缀为 `vibe-remoted/internal/`。

| check行 | 正则或测试名 → 实际包/文件:行号 |
|---|---|
| .devflow.yml:47 | TestTerminalFramesUnchangedV3 → server/golden_test.go:147 |
| :49 | TestSingleProcess → chat/session_test.go:1127 的 **TestSingleProcessRestart**；TestOrphanCleanup → chat/orphan_test.go:54。前者是有效前缀正则，并非同名函数缺失。 |
| :49 | TestReloadWaitsForOldProcess → session/chat_manager_test.go:398；TestChatCreateReplaySameID → :280；TestContinueReusesRunningSession → :342；TestConcurrentContinueCreatesOneProcess → :362；TestRestartRefusedWhenUResumedElsewhere → :444 |
| :49 | TestHandoffVsReloadOneWins → server/ws_chat_test.go:1323；TestReloadVsDeleteSerialized → session/chat_manager_test.go:471；TestTerminalContinueBusyWhenChatOwns → session/chat_manager_test.go:1062，并匹配server/ws_chat_test.go:1459的…WS；TestTerminalContinueClaimsLatest → session/chat_manager_test.go:887 |
| :51 | TestChatDisconnectKeepsProcess → server/ws_chat_test.go:711 |
| :53 | TestPendingSurvivesRingEviction → chat/session_test.go:407 |
| :55 | TestRespondRejectsForeignRule → chat/control_test.go:452 |
| :57 | TestCommandFromConfigOnly → chat/cmdline_test.go:132；TestAttachIgnoresCommandFields → server/ws_chat_test.go:674 |
| :61 | TestChatEnvHookTokenOnly → session/chat_manager_test.go:843 |
| :63 | TestNoCredentialAccess → chat/credentials_test.go:14 |
| :67 | TestDeleteSessionKeepsWorktreeAndBranch → session/manager_test.go:161；TestDeleteSessionNeverReturnsPreserved → server/worktree_test.go:21 |
| :69 | TestRemoveOnlyListedWorktrees → session/worktree_remove_test.go:1493；TestRemoveMainRefused → :555；server包没有这两个测试，但该命令指定的session包都匹配，不是完全空跑。 |
| :71 | TestRemoveExternalNeverDeletesBranch → session/worktree_remove_test.go:589；TestManagedRequiresPathAndBranch → session/projects_store_test.go:70 |
| :73 | TestRemoveDirtyNeedsConsent → session/worktree_remove_test.go:418；TestRemoveUnmergedNeedsConsent → :469；TestRemoveChangedSinceStatus → :722；TestRemoveHeadMovedWhileEndingSessions → :984；TestRemoveRefusedWhenNestedWorktree → :925；TestRemoveSubmoduleCheckoutRefused → :834 |
| :75 | TestWorktreeNameNeverReachesShell → session/worktree_test.go:729；TestValidateWorktreeName → :640，也匹配:694的TestValidateWorktreeNameRejectsExpansion。名字零git测试只查局部函数的局限见4。 |
| :77 | TestChatTrust → session/trust_test.go:82 |
| :79 | TestGitNeverGetsShortBranchName → session/worktree_test.go:1385；TestValidateWorktreeNameRejectsExpansion → :694；TestUndoOnlyRemovesOwnArtifacts → :1266；TestRemoveDeletesBranchByFullRef → session/worktree_remove_test.go:1370 |

其余无Go名称的 checks：:42 `npm test` 指向 desktop/package.json 中实际测试串；:44 `/protocol-sync` 对应 `.claude/skills/protocol-sync/SKILL.md`；:59 `test:chat-markdown` 和 `test:chat-render-guard` 均在 package.json 中定义，指向现有脚本。上述不存在测试名拼错导致整条规则不检查任何内容的情况；静态确认名称不等于证明这些命令已运行或行为全部被充分断言。

## 检查 4：58 场景逐项覆盖矩阵

对照 `tasks.md:27` 起的完整场景测试计划与 T1–T20 的具体测试清单，逐项读取实际断言。**没有整个场景只在计划里、完全零自动化的情况**；需要真实浏览器的验收子句不一定已有相应断言。R8.3 的自动化只有现存 GUI 脚本，不能因为是浏览器层就判成没有自动化。

矩阵简称仅用于节省表宽，位置均相对于本仓库：

| 简称 | 完整文件 |
|---|---|
| 树 | desktop/scripts/test-tree.mjs |
| 栏 | desktop/scripts/test-sidebar.mjs |
| 表 | desktop/scripts/test-session-form.mjs |
| 框 | desktop/scripts/test-worktree-dialogs.mjs |
| 键 | desktop/scripts/test-shortcuts.mjs |
| 色 | desktop/scripts/test-theme-tokens.mjs |
| 旧 | desktop/scripts/test-legacy-daemon.mjs |
| 服项 | vibe-remoted/internal/server/projects_test.go |
| 服区 | vibe-remoted/internal/server/worktree_test.go |
| 区 | vibe-remoted/internal/session/worktree_test.go |
| 删区 | vibe-remoted/internal/session/worktree_remove_test.go |
| 管 | vibe-remoted/internal/session/manager_test.go |
| 信 | vibe-remoted/internal/session/trust_test.go |
| GUI | .claude/skills/verify/scripts/gui-smoke.mjs |

| 场景 | 实际已有自动化断言及位置 | 断言与需求的边界 |
|---|---|---|
| R1.1 | 服项:105 TestProjectsTree；树:40 two_worktrees_each_with_session；栏:43 renders_three_levels | 归属、分支、节点数已测；GUI另有terminal/chat data-ui断言。侧边栏两类图标存在及区别未测，问题9。 |
| R1.2 | 树:61 single_worktree_is_flat；栏:63 flat_project_has_no_worktree_row | flat、无worktree层、分支文案有断言；真实窗口渲染仍是浏览器计划。 |
| R1.3 | 区:365 TestResolveHomeNonGit；服项:133 TestProjectsNonGitProject；栏:71 non_git_has_no_worktree_entries | 非git项目、没有分支和worktree入口均测。 |
| R1.4 | 树:117 duplicate_names_get_numbers；:186 legacy_grouping_ignores_input_order | 三个默认名的具体序号、跨worktree不串号、输入乱序均有断言。 |
| R1.5 | 服项:231 TestProjectsOrderStable；管:721 TestCreatedSurvivesRestartTmux；session/projects_integration_test.go:305 TestProjectsOrderSurvivesRestart；树:139/:150 | 项目顺序和重启稳定已测；非主worktree及多会话v4排序独立预期缺失，问题8。 |
| R1.6 | 树:244 rollup_waiting_only；栏:146 collapsed_project_shows_waiting_dot | 汇总waiting、折叠隐藏、展开会话waiting已测；折叠项目点状态仅存在性，问题10。 |
| R1.7 | 树:263 session_context_and_notification_title；栏:261 toolbar_title_parts | 标题/通知标题的项目、分支、会话组合有具体断言；实际后台通知到主进程的整条浏览器链仍待验。 |
| R1.8 | 区:255 TestListWorktrees；树:80 detached_label_is_short_hash；服项:190 TestProjectsResponseShape | detached元数据和七位非空显示有互补断言。树的输入已为七位，但后端也测七位，不能单判其自证。 |
| R2.1 | 服项:152 TestProjectsListsSessionlessAndExternal；栏:79 empty_worktree_row | 外部、无会话、文案、新建入口及点击路径有断言。 |
| R2.2 | session/projects_store_test.go:12 TestProjectStoreRoundTrip；服项:369 TestProjectsSurviveSessionDeletionAndRestart | daemon侧清单及重启后的树已有断言；桌面实际重启显示是浏览器计划。 |
| R2.3 | 服项:401 TestRemoveProjectKeepsDisk、:424 TestProjectReappearsAfterNewSession；栏:159 project_menu_remove | 移除记录、不碰磁盘、再次出现、菜单回调有断言。 |
| R2.4 | 服项:448 TestRemoveProjectWithSessions409；栏:173 project_remove_disabled_with_sessions | :179查disabled，:180查menu-note的先结束会话说明；不是只有按钮不可用。 |
| R2.5 | 服项:309 TestProjectsPrunedWorktreeSessionsMoveUp；树:96 gone_sessions；栏:121 gone_session_meta | 行删除、会话上移、目录不存在说明已测。 |
| R2.6 | 服项:331 TestProjectsHidesWorktreesOutsideAllowedRoots、:348 TestProjectsAllowedRootIsSymlink | 白名单配置及规范化路径过滤已有断言。 |
| R2.7 | 服项:268 TestProjectsRepoMissing、:287 TestProjectsGitFailed；栏:130 project_error_row_sessions_usable | :134查读取失败及boom原因，:137点击仍可打开，:143查目录不存在原因；不只是错误码。 |
| R3.1 | 区:796 TestCreateNamedWorktree；服区:169 TestWSAttachWorktreeName；框:49 new_worktree_confirm_resolves | 分支提交、路径、chat ready、树记录、对话框结果已测；侧边栏发起到实际打开的完整GUI链仍待验。 |
| R3.2 | 区:766 TestWorktreeDirName、:796 slash子项；desktop/scripts/test-worktree-name.mjs:40；表:84 | 分支保留斜杠、目录转换、路径文本已测。 |
| R3.3 | 区:640 TestValidateWorktreeName、:694 RejectsExpansion、:729 NeverReachesShell；表:45 invalid_name_disables_confirm | 原因可见、具体文案、disabled、合法反例启用及git拒绝文案已测；完整入口零git规则有缺口见4。 |
| R3.4 | 区:840 TestCreateNamedWorktreeBranchExists；服项:644 TestPlanWorktree；框:79 plan_rejection_keeps_dialog_open | 分支/前缀冲突原因、保持打开、改名成功已测。 |
| R3.5 | 区:884 TestCreateNamedWorktreePathExists；服项:644 path_exists；框:79 path_exists分支 | 空/非空已有目录保留、具体提示有断言。 |
| R3.6 | 区:927 TestCreateNamedWorktreeExcludesUncommitted；服项:750 TestPlanWorktreeBase；表:84 base_info_text | 基准提交、未提交改动不复制、具体说明文本均测。 |
| R3.7 | session/idempotent_test.go:148 TestNamedWorktreeReplaySameID；desktop/scripts/test-attach-replay.mjs:125 | 同id顺序/并发重放、资源数量、自动/手动重放字段已测；真实ready前断链的完整GUI链尚属计划。 |
| R3.8 | 管:1001 TestCreateNamedWorktreeGitFailureLeavesNothing；服区:198 TestWSAttachWorktreeCreateFailed；表:142 plan_failure_is_shown_and_not_ready | git错误/fatal、目录分支树无半截资源、预检错误文案已有断言；最终attach失败的真实界面呈现待浏览器。回滚保留并发改动例外见5。 |
| R3.9 | 表:152 picker_worktree_mode_name_segment、:177 picker_name_segment_follows_mode_and_folder | 同名字段、空名禁用、模式及目录切换均测。 |
| R3.10 | 区:955 TestCreateNamedWorktreePathNotAllowed；服项:644 path_not_allowed；框:79相关分支 | 原因完整路径及无创建产物已测。 |
| R4.1 | 框:211 worktree_session_dialog_shape | 标题、项目、完整路径、只选UI/flag、无目录列表/模式、确认workdir已测。 |
| R4.2 | 管:703 TestCreateInHiddenWorktreeDir；框:252 worktree_session_hidden_dir | 隐藏路径归属及确认路径已测；终端实际pwd的浏览器链待验。 |
| R4.3 | 信:98 worktree_of_trusted_main；server/fs_test.go:85 TestFSChatTrustWorktree；server/ws_chat_test.go:603 TestWSCreateChatInWorktreeOfTrustedMain | 实际信任配置、fs trusted、chat ready有断言。 |
| R4.4 | 信:109 neither_trusted；desktop/scripts/test-chat-availability.mjs:121；框:263 worktree_session_chat_disabled_reason | 原因可见、含主目录和“项目主目录”、不含worktree路径、终端可选和确认terminal已测；中英文原因另测。 |
| R4.5 | 服项:174 TestProjectsTwoSessionsOneWorktree；管:210 TestDeleteOneOfTwoSessionsKeepsWorktree | 两独立会话成功创建、删除其一后另一进程仍活和目录仍在已测；两个同时实际输入的GUI链未写。 |
| R4.6 | 信:104 worktree_itself_trusted；框:211 trusted分支 | 主目录未信任时自身信任的后端判断，与UI trusted可选互补。 |
| R5.1 | 管:161 TestDeleteSessionKeepsWorktreeAndBranch；框:402 delete_session_keeps_worktree_note | terminal/chat两模式、目录/分支/两提交、空会话树、具体保留文案均有断言。 |
| R5.2 | 删区:390 TestRemoveCleanMergedWorktree；服项:1051 TestWorktreeRemoveEndpoint；框:485 delete_wt_clean、:771 delete_flow_success | 实际删目录/ref、响应、具体提示、同意项、流程已测；GUI侧边栏行消失的整条路径待验。 |
| R5.3 | 删区:198 TestDirtyFiles、:418 TestRemoveDirtyNeedsConsent；框:511 delete_wt_files、:679 delete_wt_enter_key | 三文件计数、无同意不删、明确同意、数字文案、取消焦点和回车取消均测。 |
| R5.4 | 删区:257 TestIgnoredFiles、:452 TestRemoveIgnoredOnlyIsClean；服项:970 TestWorktreeStatusEndpoint；框:613 delete_wt_ignored_note | ignored逐文件计数、clean、无discard同意、准确N/0隐藏/-1说明均测，符合c4对说明的裁决。 |
| R5.5 | 区:180 TestUnmergedCommits；删区:469 TestRemoveUnmergedNeedsConsent；框:530 delete_wt_commits | 本地/远程包含、两提交、默认保分支及相应请求均测。 |
| R5.6 | 删区:519 TestRemoveEndsSessionsFirst；框:600 delete_wt_sessions_line；栏:450 remove_result_closes_views | 会话列表不足不结束、顺序结束、具体数字说明、视图关闭均测。 |
| R5.7 | 删区:555 TestRemoveMainRefused；栏:184 main_worktree_has_no_menu | 后端主目录拒绝、界面无删除入口均测。 |
| R5.8 | session/projects_store_test.go:70/:87；删区:589 TestRemoveExternalNeverDeletesBranch；框:555 delete_wt_external | managed安全判定、即使传恶意deleteBranch也不删外部分支、外部说明及弃文件规则均测。 |
| R5.9 | 删区:693 TestRemoveLockedRefusedBeforeEndingSessions、:834 TestRemoveSubmoduleCheckoutRefused、:925 TestRemoveRefusedWhenNestedWorktree；框:848 delete_flow_500_reopens_with_error | 原因、会话未结束、磁盘不变、错误显示已有断言；真实会话继续输入的GUI链待验。 |
| R5.10 | 服区:21 TestDeleteSessionNeverReturnsPreserved；server/compat_test.go:135 TestV3ClientFlowAgainstV4Daemon | 旧请求DELETE返回204且保资源已测；实际旧构建产物的协议冒烟仍是计划。 |
| R5.11 | 区:180 detached子项；删区:641 TestRemoveDetachedNeedsConsent；框:568 delete_wt_detached、:580 delete_wt_detached_clean、:679 enter | 无归属提交计数、明确危险提示、默认取消/回车取消、无提交正常处理均测。 |
| R5.12 | 删区:671 TestRemoveGitFailureKeepsState、:1048 TestRemoveSessionEndFailureStops、:1118 TestRemovePartialFailureReported；框:867/:888/:831 | 真实剩余状态、git原文、结束数、剩余路径和流程返回结束列表已测。 |
| R6.1 | 表:240 continue_note_shown；框:344 continue_note_counts；树:304 count_active_sessions_at | 提示开关、确认不置灰、目录计数已测。文案有i18n key比较，当前完整写出对话复用/终端可能失败/不勾新对话。 |
| R6.2 | 表:262 continue_note_hidden_without_sessions；框:344零会话/新worktree分支 | 无现存会话不显示提示已测。 |
| R7.1 | 键:32 match_digits、:59 pick_index、:212 opens_by_position_via_index；GUI:611/:638 | 1–9、超界、按位置实际切换有断言。 |
| R7.2 | 键:69 pick_prev_next_wraps；GUI:620 | 首尾循环，纯函数与实际界面两侧都有断言。 |
| R7.3 | 键:81 capture_blocks_propagation；GUI:626/:672 | 真实chat草稿不变、terminal零data、普通键验证recorder有效，覆盖充分；合成value断言限制见检查1。 |
| R7.4 | 键:119 blocked_does_not_intercept、:284 dialog_or_rename_blocks_via_index；GUI:662 | blocked、真实删除确认时不切换有断言；真实新建框交互仍待浏览器补全。 |
| R7.5 | 树:251 visible_sessions_skip_collapsed；键:234/:251；GUI:638 | 项目/机器折叠跳过、真实按键一圈均测。 |
| R8.1 | 色:322 chat_shape_rules；既有test-chat-view/markdown/diff/render-guard及GUI chat | 原功能和少数形态有断言；工具块/权限卡片整体M1形态未自动化，问题11。 |
| R8.2 | 色:244 terminal_theme_from_css_vars、:254 ansi_colors_unchanged、:261 index_uses_terminal_theme；既有终端选择/GUI透传 | 四主题色、16ANSI及主题接线、字节透传有断言；实际绘制色和完整外壳M1仍是浏览器子项，见11。 |
| R8.3 | 既有GUI、.claude/skills/verify/scripts/gui-chat-smoke.mjs | 只有浏览器层，但脚本已写；基线用例数、断言不放宽由检查1核对，不称零自动化。 |
| R8.4 | 色:137 tag_contrast_all_hues、:192 contrast_table、:201 dot_shapes_differ、:307 machine_state_readable_on_glow | token/色相/形状和一处叠加已有断言；实际元素绑定与其他合成背景无浏览器断言，问题13。 |
| R8.5 | desktop/scripts/test-dialog-layout.mjs:14；verify/scripts/picker-layout.mjs:39、slash-menu-layout.mjs:14/:80；GUI:477 | 结构、部分高度、斜杠菜单和默认侧边栏测量已有；800×500双语及新建/删除全部形态缺完整断言，问题12。 |
| R8.6 | 色:220 window_background_matches_bg_app | 源码色值一致，首帧无闪未自动化，问题14。 |
| R9.1 | 旧:116/:137/:166/:201/:235/:277/:323/:335；树:289 capability_transitions；表:203 picker_proto3_has_no_name_segment | 假proto3服务+真实renderer接线、降级、无名字、旧删除文案/preserved、原地升级均测；真实旧daemon与构建GUI互连待dev-test。 |
| R9.2 | 服区:231 TestAttachWorktreeWithoutNameKeepsLegacyNaming；server/compat_test.go:135 TestV3ClientFlowAgainstV4Daemon；server/golden_test.go:147 TestTerminalFramesUnchangedV3 | 旧自动命名、字面旧帧流程、逐字节golden均有断言；实际旧桌面构建跨版本GUI仍是计划。 |

表中 Go 短路径 `session/…`、`server/…` 均以 `vibe-remoted/internal/` 为前缀；`verify/scripts/…` 均以 `.claude/skills/` 为前缀。

只有界面行为而仍需补真实浏览器断言的重点子句为：R1.1 的侧边栏类型图标、R1.6 的折叠点形态、R8.1 的完整M1形态、R8.2的实际绘制颜色、R8.4实际元素色对、R8.5最小尺寸双语与对话框全形态、R8.6首帧。它们均不是整个场景零断言，而是已有结构/模型/token断言弱于验收。

其余矩阵中标“完整GUI链待验”的项，已存在互补的后端/DOM/协议断言；如项目清单重启、名称重放、信任规则、保资源、删除失败剩余状态。这些备注如实说明任务计划的浏览器阶段尚未全部写成自动化，不把每条尚未执行的浏览器操作都重复计成代码缺陷。

已明确排除“只测按钮不可用”的误判：R2.4检查禁用及先结束会话说明，R2.7检查读取失败原因及可点击会话，R3.3检查具体非法原因，R4.4检查主目录路径、中英文信任原因及终端仍可确认。报告的问题8–14针对具体没有自动化断言的验收子句；没有根据现有开发记录声称它们已通过或当前外观已失败。
