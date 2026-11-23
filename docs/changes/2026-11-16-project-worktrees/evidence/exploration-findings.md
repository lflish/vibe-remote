# 探索式检查发现的四个问题：回归用例在修复之前的输出

被测：`a3d07cc` 的桌面端构建（修复之前），四个用例是新写的（`gui-worktree-smoke.mjs` 的 X2.rename、X8.menu、X3.keys、X6.scroll，用真实的指针和按键事件）。时间 2026-11-20。

```
$ node .claude/skills/verify/scripts/gui-worktree-smoke.mjs --no-build --only=X2,X8,X3,X6
PASS 5 daemons up (this-mac:29074 proto 4, lab-mac:28660 proto 4, keep-mac:25630 proto 4, narrow-mac:20264 proto 4, old-mac:22292 proto 3)
PASS app started with 5 machines (zh), hooks installed
FAIL double-clicking the name of a session that is open here renames it (exploration X2) — a double click on an open session's name did not start renaming (session shown: 1795115530341-b0458bf3, focus in terminal)
FAIL a row menu opened with the pointer stays at its button when the sidebar is rebuilt (exploration X8) — where the menu is after a rebuild, the pointer still on the button: got {"left":-179,"gap":3,"buttonShown":true}, want {"left":0,"gap":3,"buttonShown":true}
FAIL the row menus work from the keyboard alone (exploration X3) — the menu opened, but the focus stayed outside it: {"testid":"worktree-menu","inMenu":false,"row":"x3k","tag":"BUTTON"} — its items cannot be reached with the keyboard
FAIL switching with the keys scrolls the session's row into view (exploration X6) — ⌘⇧[ opened the last session, but its row is out of sight: {"inView":false,"top":1748,"height":450,"overflow":1358}
PASS no uncaught renderer exceptions

4 cases: other 0/4

4 check(s) FAILED
```

单元层的对应用例，修复之前：

```
FAIL: test-sidebar: double_click_renames_a_session_that_is_open
AssertionError [ERR_ASSERTION]: the second click of a double click does not open it again
  actual: 2,
  expected: 1,
FAIL: test-sidebar: menu_button_is_marked_expanded_while_its_menu_is_open
AssertionError [ERR_ASSERTION]: the button of the open menu
FAIL: test-sidebar: row_menu_from_the_keyboard
AssertionError [ERR_ASSERTION]: opening the menu puts the focus on its item
FAIL: test-shortcuts: switching_reveals_the_row_via_index
AssertionError [ERR_ASSERTION]: the row of the session ⌘3 opened
```

## X2 的事件记录（探索时在页面的 document 上按捕获阶段记下的）

在一个已经在本窗口打开过的会话名字上做一次真实的双击（`Input.dispatchMouseEvent`，`clickCount` 1、2）：

```
mousedown:session-label:connected=true:detail=1
mouseup:session-label:connected=true:detail=1
click:session-label:connected=true:detail=1
mousedown:session-label:connected=true:detail=2
mouseup:session-label:connected=true:detail=2
click:session-label:connected=true:detail=2
rename input: false                                  # 没有 dblclick
```

同样的双击落在一个还没在本窗口打开过的会话上：

```
mousedown:session-label:connected=true:detail=1
mouseup:session-label:connected=true:detail=1
click:session-label:connected=true:detail=1
mousedown:session-label:connected=true:detail=2
mouseup:session-label:connected=true:detail=2
click:session-label:connected=true:detail=2
dblclick:session-label:connected=true:detail=2
rename input: true focus session-rename-input
```

## X8 的位置记录（探索时）

```
tool/external opened by a real click: {"menuLeftTop":[242,425],"anchorLeftBottom":[242,422],"focus":"worktree-menu"}
  after one refresh:    {"menuLeftTop":[63,425],"anchorLeftBottom":[242,422],"focus":"worktree-menu"}
```

## X1 的帧记录（探索时，没有修）

新建一个终端会话（确认之后的 0.4 秒内），本窗口另外三个打开着的终端会话各收到 10 次相同的 431 字节整屏重绘：

```
2015 >> 72470.270 attach 112x44 tmp-probe
2363 << 72470.170 data 431b
2363 << 72470.224 data 431b
2363 << 72470.116 data 431b
…（每个会话 10 次，到 2426 ms 为止）
2427 << 72470.270 ready
```

之后三个会话的行都是「终端 · 有新消息」（`X1.png`）。空闲 6 秒、打开和关闭对话框时没有任何帧。
