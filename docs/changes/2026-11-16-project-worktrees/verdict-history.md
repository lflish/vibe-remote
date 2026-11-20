# 验证结论历史：按项目和 worktree 组织会话，并更换视觉风格

每一轮机器关口 C 的独立验证结论原样归档在这里，新的一轮追加在后面。当前有效的结论见 `verdict.md`（第 2 轮产生之后才有）。

## 第 1 轮（2026-11-20）：不通过

- 日期：2026-11-20（非界面部分的结论写于 04:13，界面部分写于 04:28）。
- 被测提交：`91e0fab`（`91e0fabd1b2f050aec6b61652790b70a7196480f`），基准 `6d88e45`。
- 验证快照（两份结论里的这一行逐字相同）：

  ```json
  {"schema":1,"docs_dir":"docs/changes","head":"91e0fabd1b2f050aec6b61652790b70a7196480f","head_tree":"77848cde86cb62f4130a38ae37ec270bb77f58bdb5f6bbe87ffeb07c17bb6a84","target":"6d88e45f511b92b84d46bca1ffd917afae548221","target_tree":"b58c4926876d6dca94d03f0e017504a74b2a24ec80eff298d3a5f37737ec1751"}
  ```

- 总结论：**不通过**。两名验证者里有一名拦下了要修的问题，这一轮就不放行。非界面部分的验证者拦下 7 个问题（P1–P7，其中 3 个是会丢数据或漏掉活会话的严重问题），另有「放松检查」一节的两条备注；界面部分没有要拦的问题，结论是「通过，有备注」（7 条备注 N1–N7）。
- 两名验证者的分工（都没有写过被测代码）：
  - **非界面部分**：Codex（GPT-6），主验证者。读 diff 和 58 个场景的测试断言，跑 gofmt / vet / `go test -race` / 桌面端 `typecheck` 和 `npm test`、两份接口冒烟、`.devflow.yml` 的 19 条不变规则、`/protocol-sync`，在 `/tmp` 的副本里写反例。没有启动 Electron，没有跑三份 GUI 冒烟。它的沙箱不允许运行 `ps` 和跨进程发信号，Go 全套因此在 `internal/chat` 的孤儿清理用例上超时（结论里按环境限制记录，不算产品问题）。
  - **界面部分**：Claude（Fable 5），同模型的全新验证者。跑三份 GUI 冒烟（`gui-smoke.mjs` 46 行 PASS、`gui-chat-smoke.mjs` 29 行 PASS、`gui-worktree-smoke.mjs` 65 个用例，都没有失败），再在自己起的临时 Electron 实例里用真实的指针和按键事件亲手走了 58 个场景里的 50 个，每一步读回磁盘。
- 之后的处理：7 个问题全部采纳，在测试阶段的问题编号上接着编为 X9–X15（P1→X9 … P7→X15），返工任务 T21–T27；两条备注是 T28。裁决见 `decisions.md`（#140 起、d68–d70），返工的实验和修复前后的输出见 `evidence/gate-c-1-rework.md`，返工后的全量运行见 `test-report.md`。界面部分的 7 条备注记在 `tasks.md`「后续」。
- 证据放在哪：
  - 非界面部分的结论里有许多指向 `/tmp/vr-codex-5YMvOm/…`、`/tmp/vr-diff-…` 的链接，那是验证者本机的临时文件，**没有收进仓库**，下面原样保留为文字；关键的实际输出已经贴在结论正文里。
  - 界面部分的截图共 99 张（约 12 MB），在本机的 `/Users/mac/github/vibe-remote/.devflow-tmp/gate-c/shots/`（不在仓库里）；三份冒烟的输出在同目录的 `gui-logs/`，验证者的驱动脚本在 `harness/`。其中最能说明 R5 删除确认和失败提示的 10 张复制到了 `evidence/verdict-1/`（文件名与结论的场景表最后一列相同）：

    | 文件 | 画面 |
    |------|------|
    | `09-R5.1-delete-session-dialog.png` | 删除会话：写明 worktree 的目录和分支都会保留，默认「取消」 |
    | `10-R5.3-files-dialog.png` | 有 3 个未提交或未跟踪的文件：警告、「仍然删除」、回车 = 取消 |
    | `10-R5.4-ignored-dialog.png` | 只有被 git 忽略的文件：按干净处理，多一句「另有 3 个被 git 忽略的文件会一并删除」 |
    | `10-R5.5-commits-dialog.png` | 2 个未合并的提交：预选「只删目录、保留分支」 |
    | `11-R5.6-sessions-dialog.png` | 下面还有会话：「会先结束这 2 个会话」 |
    | `11-R5.8-external-dirty-dialog.png` | 不是 vibe-remote 创建的 worktree：只删目录，分支保留 |
    | `12-R5.11-detached-dialog.png` | 不在任何分支上、有 2 个不属于任何分支的提交 |
    | `12-R5.9-locked.png` | 开始删除之前就发现的失败：被 `git worktree lock` 锁定，确认框带原因重开 |
    | `12-R5.12-partial-failure.png` | 删到一半的失败说明：已结束 1 个会话、目录还剩一部分、分支没删 |
    | `14-R5.12-git-failure.png` | git 删除失败、worktree 还在：带原因和「已结束 1 个会话」按最新状态重开 |

  - 收入之前检查过：两份结论、三份冒烟日志、驱动脚本里没有 `VIBE_REMOTE_TOKEN=<十六进制>` 或 `Bearer <长串>`；复制的 10 张截图逐张看过，画面里没有 token。结论里的长十六进制串是提交号和快照的内容指纹。

下面两节是两份结论的全文，除各加的一级标题外一字未改。

# 第 1 轮 · 非界面部分（verdict-codex.md 全文）

- 结论：不通过
- 提交：91e0fabd1b2f050aec6b61652790b70a7196480f
- 验证快照：{"schema":1,"docs_dir":"docs/changes","head":"91e0fabd1b2f050aec6b61652790b70a7196480f","head_tree":"77848cde86cb62f4130a38ae37ec270bb77f58bdb5f6bbe87ffeb07c17bb6a84","target":"6d88e45f511b92b84d46bca1ffd917afae548221","target_tree":"b58c4926876d6dca94d03f0e017504a74b2a24ec80eff298d3a5f37737ec1751"}
- 验证者：Codex（GPT-6），本次独立验证主验证者；未编写被测产品代码。三名同模型协作者分别只读审查场景断言、tmux 删除路径、diff 与检查变更，反例均在 /tmp 副本运行，由主验证者审读源码与实际输出后采纳。
- 环境：local；Go 1.26.2 darwin/arm64、Node v22.22.2、git 2.50.1（Apple Git-155）、tmux 3.6a；桌面依赖已安装，全程未重新安装。
- 问题数量：7（严重数据/会话安全问题 3 条，其余功能、确认契约及协议文档问题 4 条）。环境限制和覆盖边界另列备注，不作为额外产品问题计数。

## 环境版本

开始时，在指定 worktree 执行：

```text
$ git rev-parse HEAD
91e0fabd1b2f050aec6b61652790b70a7196480f
$ git status --short
（无输出）
```
结束时，执行相同命令：

```text
$ git rev-parse HEAD
91e0fabd1b2f050aec6b61652790b70a7196480f
$ git status --short
（无输出）
```
开始、结束均没有已跟踪文件改动。结束时还用 git diff --name-only 与 git diff --cached --name-only 核对，两者无输出。基准为 6d88e45f511b92b84d46bca1ffd917afae548221。验证快照按用户提供的一行 JSON 原样保存，没有把其中的内容指纹当成 git tree ID 重算。

两份 WS 脚本都以自身 ROOT 定位此 worktree，从其 vibe-remoted 源码构建临时 daemon 与 fake claude，再在临时端口启动；没有常驻被测服务。额外协议/百万提交实验使用从同一 worktree 构建到 /tmp 的二进制。反例用 shutil.copytree 复制该模块，只增加临时测试或改变测试内的时限变量，没有改变产品实现。

未访问 127.0.0.1:8765，未启动 Electron，未运行 gui-smoke.mjs、gui-chat-smoke.mjs、gui-worktree-smoke.mjs；未读写用户 claude 配置或已安装 app 数据。所有会启动 tmux 的调用均有独立 TMUX_TMPDIR；临时 daemon 的 allowed_roots 仅为自建 /tmp 目录。没有 git commit/push/checkout 原 worktree，临时仓库提交仅用于测试数据。

## 检查

以下路径相对于指定 worktree。完整运行日志在 /tmp/vr-codex-5YMvOm。首次 go vet 因默认 Go 缓存不可写失败，按用户要求改用 GOCACHE=/tmp/vr-gc-gocache；之后所有 Go 构建/检查都用该缓存。首次登录 shell 还输出 fnm 无权建立 multishell symlink，随后均使用非登录 shell；gofmt 另重跑取得干净结果。

| 命令 | 结果 | 证据 |
|---|---|---|
| cd vibe-remoted && gofmt -l . | 退出 0，无未格式化文件；非登录 shell 从根执行 gofmt -l vibe-remoted 亦无输出 | 开始工具输出 |
| cd vibe-remoted && go vet ./... | 首次退出 1：默认 /Users/mac/Library/Caches/go-build 不可写；GOCACHE=/tmp/vr-gc-gocache go vet ./... 重跑退出 0、无诊断 | [vet.log](/tmp/vr-codex-5YMvOm/vet.log) |
| cd vibe-remoted && GOCACHE=/tmp/vr-gc-gocache TMUX_TMPDIR=$(mktemp -d /tmp/vr-gc-XXXXXX) go test -race -timeout 20m ./... | 退出码 1；见下方环境限制与完整输出 | [go-race.log](/tmp/vr-codex-5YMvOm/go-race.log) |
| cd desktop && npm run typecheck && npm test | 两者退出 0；311 条 ok、0 FAIL；未安装依赖 | [desktop.log](/tmp/vr-codex-5YMvOm/desktop.log)；typecheck 工具输出 tsc --noEmit |
| GOCACHE=/tmp/vr-gc-gocache TMUX_TMPDIR=$(mktemp -d /tmp/vr-gc-XXXXXX) node .claude/skills/verify/scripts/ws-worktree-smoke.mjs | 退出 0；9 PASS、0 FAIL；磁盘、分支和真实临时 tmux 会话均读回 | [ws-worktree.log](/tmp/vr-codex-5YMvOm/ws-worktree.log) |
| GOCACHE=/tmp/vr-gc-gocache TMUX_TMPDIR=$(mktemp -d /tmp/vr-gc-XXXXXX) node .claude/skills/verify/scripts/ws-chat-smoke.mjs | 退出 0；9 PASS、0 FAIL；重放单进程、待答重连、交接、重启、JSONL 保留均检查 | [ws-chat.log](/tmp/vr-codex-5YMvOm/ws-chat.log) |

Go 全套的实际输出：

```text
?   	github.com/lflish/vibe-remote/vibe-remoted/cmd/vibe-remoted	[no test files]
2026/11/20 03:51:51 chat: /var/folders/yq/p60klk5x4rddkhlf74cnj38m0000gn/T/TestStoreCorruptQuarantined3840421242/001/state/chat-sessions.json is unreadable (unexpected end of JSON input); moved to /var/folders/yq/p60klk5x4rddkhlf74cnj38m0000gn/T/TestStoreCorruptQuarantined3840421242/001/state/chat-sessions.json.corrupt-1795117911, starting with no chat sessions
2026/11/20 03:51:51 chat [sess-b9383876]: no output for 200ms, giving up on a turn
2026/11/20 03:51:51 chat [sess-5828b4b9]: subscriber 1024 frames behind, disconnecting it
2026/11/20 03:51:52 chat [sess-4fefe960]: no output for 200ms, giving up on a turn
2026/11/20 03:51:52 chat [sess-cfa8440f]: no output for 200ms, giving up on a turn
2026/11/20 03:51:52 chat [sess-f00a4518]: dropped a stdout line over 16777216 bytes
2026/11/20 03:51:52 chat [sess-36131736]: claude lacks interrupt_receipt_v1; interrupts are not confirmed
2026/11/20 03:51:52 chat [sess-f2d65deb]: claude lacks interrupt_receipt_v1; interrupts are not confirmed
2026/11/20 03:51:53 chat [sess-afaed609]: skipped a non-JSON stdout line (1 so far)
2026/11/20 03:51:53 chat [sess-afaed609]: skipped a non-JSON stdout line (2 so far)
panic: test timed out after 20m0s
	running tests:
		TestOrphanCleanup/stubborn_needs_SIGKILL (19m46s)

goroutine 1035 [running]:
testing.(*M).startAlarm.func1()
	/usr/local/go/src/testing/testing.go:2802 +0x494
created by time.goFunc
	/usr/local/go/src/time/sleep.go:215 +0x44

goroutine 1 [chan receive, 19 minutes]:
testing.tRunner.func1()
	/usr/local/go/src/testing/testing.go:1993 +0x66c
testing.tRunner(0xc00014a008, 0xc000165ab8)
	/usr/local/go/src/testing/testing.go:2042 +0x190
testing.runTests({0x10118ee01, 0x2a}, {0x101191e89, 0x38}, 0xc000010030, {0x1013d3a00, 0x5f, 0x5f}, {0xc000014a00?, 0xc0001122c0?, ...})
	/usr/local/go/src/testing/testing.go:2583 +0x7a4
testing.(*M).Run(0xc00007e500)
	/usr/local/go/src/testing/testing.go:2443 +0xb3c
main.main()
	_testmain.go:234 +0x104

goroutine 214 [chan receive, 19 minutes]:
testing.tRunner.func1()
	/usr/local/go/src/testing/testing.go:1993 +0x66c
testing.tRunner(0xc0004166c8, 0x1013a1878)
	/usr/local/go/src/testing/testing.go:2042 +0x190
created by testing.(*T).Run in goroutine 1
	/usr/local/go/src/testing/testing.go:2101 +0x7c0

goroutine 904 [syscall, 19 minutes]:
syscall.syscalln(0x100fddeb0, {0xc001706d38, 0x6, 0x6})
	/usr/local/go/src/runtime/sys_darwin.go:38 +0x20
syscall.syscall6(0x100fddeb0, 0xdf1, 0xc001706e08, 0x0, 0xc00033b710, 0x0, 0x0)
	/usr/local/go/src/syscall/syscall_darwin.go:388 +0xb4
syscall.wait4(0xdf1, 0xc001706e08, 0x0, 0xc00033b710)
	/usr/local/go/src/syscall/zsyscall_darwin_arm64.go:44 +0x60
syscall.Wait4(0xdf1, 0xc001706e60, 0x0, 0xc00033b710)
	/usr/local/go/src/syscall/syscall_bsd.go:144 +0x48
os.(*Process).pidWait.func1(...)
	/usr/local/go/src/os/exec_unix.go:64
os.ignoringEINTR2[...](...)
	/usr/local/go/src/os/file_posix.go:266
os.(*Process).pidWait(0xc000191c40)
	/usr/local/go/src/os/exec_unix.go:63 +0xe8
os.(*Process).wait(0xc000191c40)
	/usr/local/go/src/os/exec_unix.go:28 +0x44
os.(*Process).Wait(...)
	/usr/local/go/src/os/exec.go:346
os/exec.(*Cmd).Wait(0xc0002891e0)
	/usr/local/go/src/os/exec/exec.go:930 +0x74
github.com/lflish/vibe-remote/vibe-remoted/internal/chat.startOrphan.func1()
	/Users/mac/github/vibe-remote/.devflow-tmp/verify-91e0fab/vibe-remoted/internal/chat/orphan_test.go:37 +0x34
created by github.com/lflish/vibe-remote/vibe-remoted/internal/chat.startOrphan in goroutine 692
	/Users/mac/github/vibe-remote/.devflow-tmp/verify-91e0fab/vibe-remoted/internal/chat/orphan_test.go:36 +0x3cc

goroutine 692 [chan receive, 19 minutes]:
github.com/lflish/vibe-remote/vibe-remoted/internal/chat.TestOrphanCleanup.func2(0xc000e466c8)
	/Users/mac/github/vibe-remote/.devflow-tmp/verify-91e0fab/vibe-remoted/internal/chat/orphan_test.go:86 +0x554
testing.tRunner(0xc000e466c8, 0x1013a1c80)
	/usr/local/go/src/testing/testing.go:2036 +0x168
created by testing.(*T).Run in goroutine 214
	/usr/local/go/src/testing/testing.go:2101 +0x7c0
FAIL	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	1201.585s
?   	github.com/lflish/vibe-remote/vibe-remoted/internal/chat/chattest	[no test files]
?   	github.com/lflish/vibe-remote/vibe-remoted/internal/chat/fakeclaude	[no test files]
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/config	1.582s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/protocol	2.033s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	62.146s
2026/11/20 03:51:55 warning: failed to kill tmux session vibe-remote-recovered: exit status 1
2026/11/20 03:51:56 warning: failed to kill tmux session vibe-remote-recovered-clean: exit status 1
2026/11/20 03:52:57 projects store: /var/folders/yq/p60klk5x4rddkhlf74cnj38m0000gn/T/TestProjectStoreCorruptFileRenamed570214303/001/projects.json is unreadable (invalid character 'o' in literal null (expecting 'u')); moved to /var/folders/yq/p60klk5x4rddkhlf74cnj38m0000gn/T/TestProjectStoreCorruptFileRenamed570214303/001/projects.json.corrupt-1795117977, starting empty
2026/11/20 03:52:57 projects store: /var/folders/yq/p60klk5x4rddkhlf74cnj38m0000gn/T/TestProjectStoreCorruptFileRenamed570214303/002/projects.json is unreadable (<nil>); moved to /var/folders/yq/p60klk5x4rddkhlf74cnj38m0000gn/T/TestProjectStoreCorruptFileRenamed570214303/002/projects.json.corrupt-1795117977, starting empty
2026/11/20 03:53:31 tmux list-sessions failed: exit status 1 (stderr="error connecting to /private/tmp/vr-tmux-1478655841/tmux-501/vibe-remote (Socket operation on non-socket)\n")
2026/11/20 03:53:33 tmux list-sessions failed: exit status 1 (stderr="error connecting to /private/tmp/vr-tmux-1608859268/tmux-501/vibe-remote (Socket operation on non-socket)\n")
2026/11/20 03:53:33 tmux list-sessions failed: exit status 1 (stderr="error connecting to /private/tmp/vr-tmux-1608859268/tmux-501/vibe-remote (Socket operation on non-socket)\n")
2026/11/20 03:53:47 tmux list-sessions failed: exit status 1 (stderr="server exited unexpectedly\n")
2026/11/20 03:53:47 warning: failed to kill tmux session vibe-remote-1795118026796-10f48125: exit status 1
2026/11/20 03:53:49 tmux list-sessions failed: exit status 1 (stderr="server exited unexpectedly\n")
2026/11/20 03:53:49 warning: failed to kill tmux session vibe-remote-1795118028362-e08318d7: exit status 1
2026/11/20 03:53:51 tmux list-sessions failed: exit status 1 (stderr="error connecting to /private/tmp/vr-tmux-216103775/tmux-501/vibe-remote (No such file or directory)\n"): tmux's socket file /private/tmp/vr-tmux-216103775/tmux-501/vibe-remote is gone while the daemon remembers terminal sessions. If tmux is still running, sending SIGUSR1 to the tmux server process makes it create the socket again; otherwise restart the daemon
2026/11/20 03:53:51 tmux list-sessions failed: exit status 1 (stderr="error connecting to /private/tmp/vr-tmux-216103775/tmux-501/vibe-remote (No such file or directory)\n"): tmux's socket file /private/tmp/vr-tmux-216103775/tmux-501/vibe-remote is gone while the daemon remembers terminal sessions. If tmux is still running, sending SIGUSR1 to the tmux server process makes it create the socket again; otherwise restart the daemon
2026/11/20 03:53:51 tmux list-sessions failed: exit status 1 (stderr="error connecting to /private/tmp/vr-tmux-216103775/tmux-501/vibe-remote (No such file or directory)\n"): tmux's socket file /private/tmp/vr-tmux-216103775/tmux-501/vibe-remote is gone while the daemon remembers terminal sessions. If tmux is still running, sending SIGUSR1 to the tmux server process makes it create the socket again; otherwise restart the daemon
2026/11/20 03:53:51 tmux list-sessions failed: exit status 1 (stderr="error connecting to /private/tmp/vr-tmux-216103775/tmux-501/vibe-remote (No such file or directory)\n"): tmux's socket file /private/tmp/vr-tmux-216103775/tmux-501/vibe-remote is gone while the daemon remembers terminal sessions. If tmux is still running, sending SIGUSR1 to the tmux server process makes it create the socket again; otherwise restart the daemon
2026/11/20 03:53:51 tmux list-sessions failed: exit status 1 (stderr="error connecting to /private/tmp/vr-tmux-216103775/tmux-501/vibe-remote (No such file or directory)\n"): tmux's socket file /private/tmp/vr-tmux-216103775/tmux-501/vibe-remote is gone while the daemon remembers terminal sessions. If tmux is still running, sending SIGUSR1 to the tmux server process makes it create the socket again; otherwise restart the daemon
2026/11/20 03:53:52 warning: failed to kill tmux session vibe-remote-1795118031470-4d255666: exit status 1
2026/11/20 03:53:52 tmux list-sessions failed: exit status 1 (stderr="error connecting to /private/tmp/vr-tmux-1163096632/tmux-501/vibe-remote (No such file or directory)\n"): tmux's socket file /private/tmp/vr-tmux-1163096632/tmux-501/vibe-remote is gone while the daemon remembers terminal sessions. If tmux is still running, sending SIGUSR1 to the tmux server process makes it create the socket again; otherwise restart the daemon
2026/11/20 03:53:52 tmux list-sessions failed: exit status 1 (stderr="error connecting to /private/tmp/vr-tmux-1163096632/tmux-501/vibe-remote (No such file or directory)\n"): tmux's socket file /private/tmp/vr-tmux-1163096632/tmux-501/vibe-remote is gone while the daemon remembers terminal sessions. If tmux is still running, sending SIGUSR1 to the tmux server process makes it create the socket again; otherwise restart the daemon
2026/11/20 03:53:52 tmux list-sessions failed: exec: "tmux": executable file not found in $PATH: the tmux program was not found on the daemon's PATH, but tmux's socket /private/tmp/vr-tmux-4050862844/tmux-501/vibe-remote is there: terminal sessions may be running behind it. Put tmux on the daemon's PATH and restart the daemon
2026/11/20 03:53:53 tmux list-sessions failed: exec: "tmux": executable file not found in $PATH: the tmux program was not found on the daemon's PATH, but tmux's socket /private/tmp/vr-tmux-4050862844/tmux-501/vibe-remote is there: terminal sessions may be running behind it. Put tmux on the daemon's PATH and restart the daemon
2026/11/20 03:53:53 tmux list-sessions failed: exec: "tmux": executable file not found in $PATH: the tmux program was not found on the daemon's PATH, but tmux's socket /private/tmp/vr-tmux-4050862844/tmux-501/vibe-remote is there: terminal sessions may be running behind it. Put tmux on the daemon's PATH and restart the daemon
2026/11/20 03:53:53 tmux list-sessions failed: exec: "tmux": executable file not found in $PATH: the tmux program was not found on the daemon's PATH, but tmux's socket /private/tmp/vr-tmux-4050862844/tmux-501/vibe-remote is there: terminal sessions may be running behind it. Put tmux on the daemon's PATH and restart the daemon
2026/11/20 03:53:53 tmux list-sessions failed: exec: "tmux": executable file not found in $PATH: the tmux program was not found on the daemon's PATH, but tmux's socket /private/tmp/vr-tmux-2447352222/tmux-501/vibe-remote is there: terminal sessions may be running behind it. Put tmux on the daemon's PATH and restart the daemon
2026/11/20 03:53:53 tmux list-sessions failed: exec: "tmux": executable file not found in $PATH: the tmux program was not found on the daemon's PATH, but the daemon remembers terminal sessions. Put tmux on the daemon's PATH and restart the daemon
--- FAIL: TestLoadChatsMarksDaemonRestart (15.17s)
    chat_manager_test.go:516: timeout waiting for orphan gone
FAIL
FAIL	github.com/lflish/vibe-remote/vibe-remoted/internal/session	267.394s
FAIL
```

环境限制：沙箱拒绝启动 ps。chat/orphan.go 的 cmdlineMentions 因此不能确认孤儿身份，相关清理不执行；TestOrphanCleanup/stubborn_needs_SIGKILL 阻塞，TestLoadChatsMarksDaemonRestart 等等待退出失败。这不能作为一般 local 环境的产品缺陷证据，但本次 make check 的等价检查确实未通过，不能标绿。未删除、跳过或改动这些测试。

为区分环境限制与本需求的守护测试，另执行下列检查：

- 同目录、独立 TMUX_TMPDIR、相同缓存运行 go test -race -v -timeout 30s ./internal/chat -run '^TestOrphanCleanup$/^ended_and_confirmed_gone$'：退出 1，orphan still running after cleanup，见 [orphan-diagnostic.log](/tmp/vr-codex-5YMvOm/orphan-diagnostic.log)。额外只读诊断尝试执行 ps 得 PermissionError: Operation not permitted。
- go test -race -timeout 10m ./internal/session ./internal/server ./internal/config ./internal/protocol：session 因 TestLoadChatsMarksDaemonRestart 等待孤儿退出失败；server/config/protocol 均 ok，见 [go-unaffected.log](/tmp/vr-codex-5YMvOm/go-unaffected.log)。
- 从 58 场景审查表提取并确认源码存在的 51 个 Go 顶层测试，在原 worktree 以 -race -count=1 -v 单独运行：51 PASS、0 FAIL、0 SKIP；session 40.069s、server 11.963s，见 [scenario-go.log](/tmp/vr-codex-5YMvOm/scenario-go.log)。完整命令：

```text
cd /Users/mac/github/vibe-remote/.devflow-tmp/verify-91e0fab/vibe-remoted
GOCACHE=/tmp/vr-gc-gocache TMUX_TMPDIR=$(mktemp -d /tmp/vr-gc-XXXXXX) go test -race -count=1 -timeout 10m -v ./internal/session ./internal/server -run '^(TestAttachWorktreeWithoutNameKeepsLegacyNaming|TestChatTrust|TestCreateInHiddenWorktreeDir|TestCreateNamedWorktree|TestCreateNamedWorktreeBranchExists|TestCreateNamedWorktreeExcludesUncommitted|TestCreateNamedWorktreePathExists|TestCreateNamedWorktreePathNotAllowed|TestCreatedSurvivesRestartTmux|TestDeleteSessionKeepsWorktreeAndBranch|TestDeleteSessionNeverReturnsPreserved|TestDirtyFiles|TestFSChatTrustWorktree|TestIgnoredFiles|TestListWorktrees|TestNamedWorktreeReplaySameID|TestProjectReappearsAfterNewSession|TestProjectsAllowedRootIsSymlink|TestProjectsHidesWorktreesOutsideAllowedRoots|TestProjectsListsSessionlessAndExternal|TestProjectsNonGitProject|TestProjectsOrderStable|TestProjectsOrderSurvivesRestart|TestProjectsPrunedWorktreeSessionsMoveUp|TestProjectsRepoMissing|TestProjectsSurviveSessionDeletionAndRestart|TestProjectsTree|TestProjectsTwoSessionsOneWorktree|TestRemoveCleanMergedWorktree|TestRemoveDetachedNeedsConsent|TestRemoveDirtyNeedsConsent|TestRemoveEndsSessionsFirst|TestRemoveExternalNeverDeletesBranch|TestRemoveGitFailureKeepsState|TestRemoveIgnoredOnlyIsClean|TestRemoveLockedRefusedBeforeEndingSessions|TestRemoveMainRefused|TestRemovePartialFailureReported|TestRemoveProjectKeepsDisk|TestRemoveProjectNotFound|TestRemoveProjectWithSessions409|TestRemoveRefusedWhenNestedWorktree|TestRemoveSessionEndFailureStops|TestRemoveSubmoduleCheckoutRefused|TestRemoveUnmergedNeedsConsent|TestUnmergedCommits|TestV3ClientFlowAgainstV4Daemon|TestWSAttachWorktreeCreateFailed|TestWSAttachWorktreeName|TestWSCreateChatInWorktreeOfTrustedMain|TestWSCreateChatWorktreeUntrusted)$'
```

- 第 4 条 invariant 因 && 未执行的第二段，另带独立 TMUX_TMPDIR 原样执行：

```text
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	5.952s
ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	11.200s
```
完整命令与第 4 条的第二个 go test 相同，工作目录 vibe-remoted。

测试清理限制：从两个 TestOrphanCleanup/stubborn_needs_SIGKILL 的专属临时 PID 文件、生成时间（03:51:52 与 03:52:37）确认它们由上述两次检查启动。尝试仅向这两个测试假 claude 发 SIGKILL，但跨 exec 命令的信号也被沙箱拒绝（Operation not permitted），没有送达。PID 为 3569、14455；对应注册路径与失败在 [cleanup-own-orphans.log](/tmp/vr-codex-5YMvOm/cleanup-own-orphans.log) 和 [cleanup-own-orphans.py](/tmp/vr-codex-5YMvOm/cleanup-own-orphans.py)。这些测试子进程未能在当前沙箱清理；需要在允许进程操作的环境确认身份后清理，不能把注册文件等同于永久有效的 PID。没有向任何真实 daemon/tmux 会话发信号。

### .devflow.yml 的 19 条 invariants

18 条命令型 check 字符串原样交给 zsh 执行；外层为每条建立独立 TMUX_TMPDIR，并设置 GOCACHE=/tmp/vr-gc-gocache，已在命令里自行设 TMUX_TMPDIR 的保持原样。第 2 条 /protocol-sync 按技能手动核对，详见下一节。

1. 命令：`cd desktop && npm test`

   结果：退出 0；42.988s；桌面脚本全部通过。 日志：[invariant-01.log](/tmp/vr-codex-5YMvOm/invariant-01.log)。

3. 命令：`cd vibe-remoted && go test -race ./internal/server -run TestTerminalFramesUnchangedV3`

   结果：退出 0；3.487s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	2.343s 日志：[invariant-03.log](/tmp/vr-codex-5YMvOm/invariant-03.log)。

4. 命令：`cd vibe-remoted && go test -race ./internal/chat -run 'TestSingleProcess|TestOrphanCleanup' && go test -race ./internal/session ./internal/server -run 'TestReloadWaitsForOldProcess|TestChatCreateReplaySameID|TestContinueReusesRunningSession|TestConcurrentContinueCreatesOneProcess|TestRestartRefusedWhenUResumedElsewhere|TestHandoffVsReloadOneWins|TestReloadVsDeleteSerialized|TestTerminalContinueBusyWhenChatOwns|TestTerminalContinueClaimsLatest'`

   结果：退出 1；600.996s；第一段 TestOrphanCleanup/stubborn_needs_SIGKILL 超时，&& 后第二段未运行；第二段随后独立运行通过。 日志：[invariant-04.log](/tmp/vr-codex-5YMvOm/invariant-04.log)。

5. 命令：`cd vibe-remoted && go test -race ./internal/server -run TestChatDisconnectKeepsProcess`

   结果：退出 0；5.064s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	4.411s 日志：[invariant-05.log](/tmp/vr-codex-5YMvOm/invariant-05.log)。

6. 命令：`cd vibe-remoted && go test -race ./internal/chat -run TestPendingSurvivesRingEviction`

   结果：退出 0；2.451s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	2.145s 日志：[invariant-06.log](/tmp/vr-codex-5YMvOm/invariant-06.log)。

7. 命令：`cd vibe-remoted && go test -race ./internal/chat -run TestRespondRejectsForeignRule`

   结果：退出 0；2.39s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	2.109s 日志：[invariant-07.log](/tmp/vr-codex-5YMvOm/invariant-07.log)。

8. 命令：`cd vibe-remoted && go test ./internal/chat -run TestCommandFromConfigOnly && go test ./internal/server -run TestAttachIgnoresCommandFields`

   结果：退出 0；3.259s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	0.439s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	1.163s 日志：[invariant-08.log](/tmp/vr-codex-5YMvOm/invariant-08.log)。

9. 命令：`cd desktop && npm run test:chat-markdown && npm run test:chat-render-guard`

   结果：退出 0；2.751s；桌面脚本全部通过。 日志：[invariant-09.log](/tmp/vr-codex-5YMvOm/invariant-09.log)。

10. 命令：`cd vibe-remoted && go test ./internal/session -run TestChatEnvHookTokenOnly`

   结果：退出 0；2.03s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	1.189s 日志：[invariant-10.log](/tmp/vr-codex-5YMvOm/invariant-10.log)。

11. 命令：`cd vibe-remoted && go test ./internal/chat -run TestNoCredentialAccess`

   结果：退出 0；0.681s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/chat	0.402s 日志：[invariant-11.log](/tmp/vr-codex-5YMvOm/invariant-11.log)。

12. 命令：`cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -timeout 10m ./internal/session ./internal/server -run 'TestDeleteSessionKeepsWorktreeAndBranch|TestDeleteSessionNeverReturnsPreserved'`

   结果：退出 0；4.08s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	2.997s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	3.589s 日志：[invariant-12.log](/tmp/vr-codex-5YMvOm/invariant-12.log)。

13. 命令：`cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -timeout 10m ./internal/session ./internal/server -run 'TestRemoveOnlyListedWorktrees|TestRemoveMainRefused'`

   结果：退出 0；4.401s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	4.001s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	1.737s [no tests to run] 日志：[invariant-13.log](/tmp/vr-codex-5YMvOm/invariant-13.log)。

14. 命令：`cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -timeout 10m ./internal/session -run 'TestRemoveExternalNeverDeletesBranch|TestManagedRequiresPathAndBranch'`

   结果：退出 0；4.256s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	3.900s 日志：[invariant-14.log](/tmp/vr-codex-5YMvOm/invariant-14.log)。

15. 命令：`cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -timeout 10m ./internal/session -run 'TestRemoveDirtyNeedsConsent|TestRemoveUnmergedNeedsConsent|TestRemoveChangedSinceStatus|TestRemoveHeadMovedWhileEndingSessions|TestRemoveRefusedWhenNestedWorktree|TestRemoveSubmoduleCheckoutRefused|TestRemoveUntrackedRepositoryRefused|TestRemoveBranchSwitchedAfterConfirmation|TestRemoveEndsSessionsAttributedElsewhere|TestRemoveWorktreeAfterRestartNeedsTheSessionsFromTmux|TestRemoveWorktreeRefusedWhenTmuxSocketDoesNotAnswer|TestSessionsOfAWorktreeGoByWhereTheyWereCreatedAcrossRestart|TestSocketFileGoneWhileTheTmuxServerRuns|TestMissingSocketIsNotAnEmptySetWhileTheTableHasTerminalSessions|TestRemoveWorktreeRefusedWhenTmuxIsNotOnPathButItsSocketIsThere|TestNoTmuxProgramIsAnEmptySetOnlyWithoutSocketAndWithoutTerminalSessions|TestTmuxSocketPathResolvesTheDirectoryLikeTmux'`

   结果：退出 0；35.804s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	34.870s 日志：[invariant-15.log](/tmp/vr-codex-5YMvOm/invariant-15.log)。

16. 命令：`cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -timeout 10m ./internal/session ./internal/server -run 'TestWorktreeNameNeverReachesShell|TestValidateWorktreeName|TestCreateRefusesBadWorktreeNameBeforeAnyGit|TestAttachRefusesBadWorktreeNameBeforeAnyGit'`

   结果：退出 0；6.114s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	5.676s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/server	5.524s 日志：[invariant-16.log](/tmp/vr-codex-5YMvOm/invariant-16.log)。

17. 命令：`cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -timeout 10m ./internal/session -run TestChatTrust`

   结果：退出 0；4.907s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	4.494s 日志：[invariant-17.log](/tmp/vr-codex-5YMvOm/invariant-17.log)。

18. 命令：`cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -timeout 10m ./internal/session -run 'TestGitNeverGetsShortBranchName|TestValidateWorktreeNameRejectsExpansion|TestUndoOnlyRemovesOwnArtifacts|TestRemoveDeletesBranchByFullRef'`

   结果：退出 0；15.614s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	15.076s 日志：[invariant-18.log](/tmp/vr-codex-5YMvOm/invariant-18.log)。

19. 命令：`cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d) go test -race -timeout 10m ./internal/session -run 'TestReadOnlyGitRunsNoRepositoryProgram|TestCreateAndRemoveWorktreeDoNotRunFsmonitor|TestGitEnvKeepsInheritedConfig|TestDirtyFilesDoesNotRunFsmonitor|TestFsmonitorStaysOffOnGitWithoutConfigEnvironment|TestEveryGitCallTurnsFsmonitorOff'`

   结果：退出 0；10.229s；ok  	github.com/lflish/vibe-remote/vibe-remoted/internal/session	9.761s 日志：[invariant-19.log](/tmp/vr-codex-5YMvOm/invariant-19.log)。

### /protocol-sync

已读完整 protocol.go、protocol.ts、rest.ts、docs/protocol.md，逐字段对照 JSON 名、可选性、类型、常量、routes 方法/路径、Bearer 鉴权、错误码与 HTTP 状态码。额外机械比对 30 个对应类型，字段集合全部相同，见 [protocol-fields.py](/tmp/vr-codex-5YMvOm/protocol-fields.py)、[protocol-fields.log](/tmp/vr-codex-5YMvOm/protocol-fields.log)。两个可选性差别是兼容旧接收端：Go ready.proto 必出而 TS 可缺省（早期 daemon），Go ChatInfo.claudeVersion 必出而 rest.ts 可缺省；都按缺失/未知处理，不是运行冲突。

| 帧/类型/端点 | Go、TS、文档核对项与结果 |
|---|---|
| auth | type/token string，一致 |
| attach | type/sessionId?/newSessionId?/cols/rows/workdir?/flags?/mode?/ui?/epoch?/since?/handoffFrom?/worktreeName?；Go uint16/uint64 与 TS number，模式和创建条件一致 |
| ready | type/sessionId/workdir/proto/mode、4 个 worktree 元数据字段及 4 个 chat 字段；字段一致，终端不新增字段 |
| data（双向）/resize/ping/pong | base64 payload；cols/rows；ping/pong type；未改 PTY 数据、未知 relay 帧忽略，一致 |
| SessionInfo/sessions | id/title/workdir/created/mode 与可选 sourceWorkdir/sourceRepo/worktreeRoot/branch/ui/state/activitySeq/epoch/endReason；list，一致 |
| exit/error/notify | code integer；message/code?/fatal?；sessionId/kind/message?，开放 kind/code 按既有兼容规则处理，一致 |
| chat/chat_sync | seq（恒有）/h?/msg；epoch/reset/omitted/historyCount/backlog，JSON 体与同步语义一致 |
| chat_state/PendingRequest/SlashCommand/ChatEnded | status/permissionMode/permissionLocked/pending/degraded?/slashCommands/claudeVersion/claudeSessionId/ended(null或对象)，nested 字段及六种结束原因一致 |
| chat_ack/chat_send | op/ref?/ok/code?/message?/duplicate?/completed?；clientMsgId/text；9 种 ack code 与四 op 一致 |
| chat_respond/ChatResponse | requestId/response/setMode?；allow或deny、updatedInput?/updatedPermissions?/message?/interrupt?，规则只取建议，一致 |
| chat_interrupt/chat_set_mode | type；mode=default/acceptEdits/plan，一致 |
| vr_resolved/vr_notice/vr_exit/user echo | 5 个 outcome、notice 开放 code、exit code/reason/stderrTail 与 user vr_client_msg_id，产生位置和文档一致 |
| Project/ProjectWorktree/ProjectsResponse | 所有字段 JSON 名/类型/省略条件一致；projects/worktrees/sessions 恒为数组，proto=4 |
| WorktreePlan/WorktreeBase | ok/error?/message?/conflict?/project?/projectName?/base?/branch?/path?；base branch?/head/detached? 一致；7 种 ok:false 原因一致 |
| WorktreeStatus | 11 个字段含 ignoredFiles 恒有、-1 未知、sessions[]、完整 head（含无提交全零）一致 |
| WorktreeRemoveRequest/Result | path/head/sessions 必填；branch?/discardFiles?/deleteBranch?/dropCommits?；removed/branchDeleted/branchError?/endedSessions[]，一致 |
| GET /healthz | 无鉴权，200 |
| GET /api/v1/info 与 ?recheck=1 | 机器信息/flags/chat、ChatInfo reason、minClaudeVersion、proto 一致；chat 最低协议仍 3 |
| GET /api/v1/sessions | 与 sessions frame 一致 |
| GET /api/v1/projects | 200/401；旧版404作为能力检测；一个项目失败仍200，一致 |
| POST /api/v1/projects/remove | body id；204/400 invalid_request/404 project_not_found/409 project_has_sessions，一致 |
| GET /api/v1/worktrees/plan | workdir/name 编码；200 ok:false/400/403/500 git_failed；不存在目录的 400 vs 实际403 不一致，见 P7 |
| GET /api/v1/worktrees/status | path；200/400 invalid_request/404 worktree_not_found/500 git_failed，一致 |
| POST /api/v1/worktrees/remove | 200/400 invalid_request或worktree_is_main/404 worktree_not_found/409 worktree_changed含status及endedSessions/413/500 worktree_remove_failed或git_failed；单对象与必填校验一致 |
| DELETE /api/v1/sessions/{id} | 204/404；v4 不再409 worktree_preserved，客户端仍处理v3该体；保留 worktree 一致 |
| POST rename/reload | rename body name、204/404/500；chat reload202、busy409含owner/message、terminal204，一致 |
| GET /api/v1/fs | path/parent/entries/chatTrust；只自己或真实受信任主目录的 linked worktree 根，拒绝伪造/子目录等，一致 |
| POST /api/v1/events | body sessionId/kind/message?；主token与按session导出的hook token；204/400/401/413，一致；此 hook REST 类型未由桌面 rest.ts 暴露，不存在矛盾字段 |
| 错误码 | auth_failed/auth_timeout/invalid_workdir/invalid_mode/invalid_session_id/create_failed/session_not_found/attach_failed、v3 ui_mismatch/chat_unsupported/claude_session_busy/shutting_down 与 v4 四 worktree code，fatal/transient 文档与 WS 实现一致；TS error.code 为开放 string |
| 版本互连 | Version=PROTOCOL_VERSION=4，CHAT_MIN_PROTO=3；v3 tree fallback、禁用新端点、旧自动命名及旧删除提示，与测试及文档一致 |

结果：字段定义核对通过；协议整体“完全一致”的完成条件不成立（P7 的状态码/原因不符）。删除的确认语义另被 P2–P5 反例推翻，不能因为类型一致就认定安全保证成立。

## 场景：58 个逐项结果

下表逐个读了测试的实际 assert，而非仅测试名。Go 路径以 vibe-remoted/internal/ 为前缀，desktop 测试路径以 desktop/scripts/ 为前缀。GUI 的行号都指 .claude/skills/verify/scripts/gui-worktree-smoke.mjs。本次原 worktree 的 51 个相关 Go 顶层用例及全部 desktop 测试均已运行通过；表中 GUI 均只审断言，运行由另一名验证者负责，未借用之前测试报告的 GUI PASS 作为本次独立运行。

| 场景 | 自动化守护：已读断言与运行 | GUI：已读断言、运行分工 | 结果 |
|---|---|---|---|

| R1.1 | server/projects_test.go TestProjectsTree：一个 git 项目存在 main/fix-login 两项，各自 sessions 包含创建在该目录的 id；test-sidebar.mjs renders_three_levels：两会话各在自己的 worktree DOM，chat/terminal 图标形状、kind 文案、data-dot 都存在。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :833：devflow/main 有指定 chat id，fix-login 有 terminal id，不重复挂载；检查图标不同、状态点类型及主目录标签。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R1.2 | test-sidebar.mjs flat_project_has_no_worktree_row：2会话只有主目录时零 worktree-row，project-branch=dev；test-tree.mjs 单主目录形成 flat 项目。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :859：new-api 不含 worktree 层，直接含两个指定 id，项目分支=dev且磁盘分支亦为dev。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R1.3 | server/projects_test.go TestProjectsNonGitProject：git=false、worktrees空、无error、会话在项目级；test-tree.mjs non_git_project 和 test-sidebar.mjs non_git_has_no_worktree_entries：flat、无分支、新 worktree 和项目菜单。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :871：notes无worktree层/分支/相关入口，包含会话；用 git rev-parse 确认前提为非git。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R1.4 | test-tree.mjs duplicate_names_get_numbers：devflow、devflow 2、devflow 3，手工名不编号、不同worktree互不编号。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :882：main三个未改名会话显示名精确等于上述三个且全唯一；daemon原title均devflow。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R1.5 | server/projects_test.go TestProjectsOrderStable：3项目40次响应体完全相同，名称顺序alpha/Beta/gamma；session/projects_integration_test.go TestProjectsOrderSurvivesRestart、manager_test.go TestCreatedSurvivesRestartTmux 守创建时间/恢复顺序；test-tree.mjs order_three_projects_eight_sessions_new_daemon/old_daemon 与 test-sidebar.mjs rows_are_drawn_in_the_daemons_order 用明确期望顺序检查3项目8会话、40轮乱序，防止“错误但稳定”。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :895：实际发送至少40次projects请求，40轮树形顺序零差异，项目按名称、主worktree先、其余分支排序、会话按创建时间；前提>=3项目>=8会话。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R1.6 | test-tree.mjs rollup_waiting_only：仅waiting聚合，idle/output不聚合；test-sidebar.mjs collapsed_project_shows_waiting_dot：折叠项目waiting点与展开会话点class完全相同。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :935：项目折叠后从另一客户端发送真实权限请求，waiting点出现；展开后会话waiting/等你处理，项目点消失。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R1.7 | test-tree.mjs session_context_and_notification_title、test-sidebar.mjs toolbar_title_parts：项目devflow、分支fix-login、会话登录修复及完整通知标题精确比较。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :966：顶部三个标题字段精确比较；后台hook事件204，notify shown/fallback日志标题精确为this-mac · devflow / fix-login · 登录修复，行waiting。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R1.8 | session/worktree_test.go TestListWorktrees：detached=true、40位HEAD且无branch；test-tree.mjs detached_label_is_short_hash：7位label。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :988：用git确认没有符号分支，该路径行label等于磁盘HEAD前7位。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R2.1 | server/projects_test.go TestProjectsListsSessionlessAndExternal：外部change/general-skills列出，sessions空、main/managed均false；test-sidebar.mjs empty_worktree_row：无会话文案、external标签、两个新建入口且回调目录正确。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1000：路径/分支/没有会话/external/新建按钮，点击空态新建入口的对话框完整路径正确。 本次运行由另一名验证者负责。 | 扩展路径反例不通过（P6：全部 worktree 的路径要求）。 GUI运行仍由另一名验证者负责。 |
| R2.2 | server/projects_test.go TestProjectsSurviveSessionDeletionAndRestart：删除唯一会话后重新打开相同state_dir的项目store与manager，devflow仍返回；store round-trip守持久化。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1018：唯一会话删除204，keep两worktree均没有会话；桌面退出重开、daemon停启各一次，两个worktree保持；读取projects.json确认记录。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R2.3 | server/projects_test.go TestRemoveProjectKeepsDisk：移除204、不再列出、仓库仍存在；TestProjectReappearsAfterNewSession：仓库src新会话后重新出现；test-sidebar.mjs project_menu_remove：回调一次、项目id正确。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1048：菜单启用，移除后多次刷新/daemon均不列；worktree列表和所有分支前后严格相等、两README仍在；repo/sub新会话使项目返回且挂main。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R2.4 | server/projects_test.go TestRemoveProjectWithSessions409：409且项目保持；test-sidebar.mjs project_remove_disabled_with_sessions：disabled和说明；TestRemoveProjectNotFound另守404。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1075：菜单disabled并准确说明先结束会话；点击不移除，直接REST返回409。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R2.5 | server/projects_test.go TestProjectsPrunedWorktreeSessionsMoveUp：外部git worktree remove后原worktree消失、会话id上移项目级；test-tree.mjs gone_sessions/test-sidebar.mjs gone_session_meta检查gone标志及目录不存在文案。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1096：真实外部git remove后下一次刷新无px行，原会话仍在项目下，gone及目录已不存在精确比较。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R2.6 | server/projects_test.go TestProjectsHidesWorktreesOutsideAllowedRoots：allowed_roots只有主仓库时外部wt不返回；TestProjectsAllowedRootIsSymlink：符号链接白名单正确放行真实路径。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1118：git列出2worktree、daemon只返回主目录、侧边栏不出现outside；outside status=404。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R2.7 | server/projects_test.go TestProjectsRepoMissing/GitFailed：已登记仓库丢失或git失败分别repo_missing/git_failed，项目会话保持；test-sidebar.mjs project_error_row_sessions_usable检查文案和点击回调。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1132：真实挪仓库目录和破坏.git/HEAD，显示各自原因，会话均仍在且真实shell echo可输入输出；其他项目仍成功。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R3.1 | session/worktree_test.go TestCreateNamedWorktree：目录/branch/归属/HEAD、clean、提交能移动新分支；server/worktree_test.go TestWSAttachWorktreeName：ready为chat，目录和分支准确，projects中managed且唯一会话；test-worktree-dialogs.mjs new_worktree_confirm_resolves：确认前再plan，返回正确worktreeName/path/ui。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1180：从main发起fix-login选择chat，分支等于发起HEAD、目录/登记/clean/workdir正确、侧边栏chat会话，发chat并得到真实fake-claude回复。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R3.2 | session/worktree_test.go TestCreateNamedWorktree/slash：change/foo分支、change-foo目录及symbolic-ref；test-worktree-name.mjs dir_name直接assert转换。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1208：预检目标change-foo、sidebar change/foo、磁盘分支/README/登记正确、shell pwd在新目录。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R3.3 | test-worktree-name.mjs shared_vectors和name_length_and_invisible_characters读共享表并assert原因，control/expansion/长度/Cf边界；test-session-form.mjs invalid_name_disables_confirm：原因、disabled、本地拒绝不发plan，git-only a~b等待daemon后拒绝。Go name校验和命令无shell测试见矩阵，运行由主验证者负责。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1225：逐个空、空格、..、-、a~b、@{-1}准确原因、禁确认，Enter后保持对话框；磁盘分支/worktree/目录和会话总数前后相等。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R3.4 | session/worktree_test.go TestCreateNamedWorktreeBranchExists：错误类型/冲突分支、原OID不动、不建container；dir-file冲突不调用update-ref；test-worktree-dialogs.mjs plan_rejection_keeps_dialog_open：确认时竞态拒绝后Promise未结束、可改名成功。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1249：已有分支预检禁止确认、Enter保持；原分支OID不变，无目标目录；同框更名-2成功。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R3.5 | session/worktree_test.go TestCreateNamedWorktreePathExists：非空/空目录均拒绝，keep.txt内容不动、无分支登记；test-worktree-dialogs.mjs plan_rejection_keeps_dialog_open含path_exists。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1270：目录已存在完整路径、禁确认、Enter保持；keep.txt名称内容不变、无新分支/worktree、会话数量不变。 本次运行由另一名验证者负责。 | 并发接管回滚反例不通过（P1：未经同意覆盖/删除）。 GUI运行仍由另一名验证者负责。 |
| R3.6 | session/worktree_test.go TestCreateNamedWorktreeExcludesUncommitted：新worktree clean、HEAD等于base、README是已提交内容；test-session-form.mjs base_info_text/detached_base_text检查准确base文字。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1286：修改README加untracked后，显示main@短HEAD及不含改动；实际新worktree clean、HEAD准确、untracked不存在、README等于修改前。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R3.7 | session/idempotent_test.go TestNamedWorktreeReplaySameID：顺序及2个并发m.Create返回同一Runner，git同名wt=1、branch=1、m.List同branch会话=1；test-attach-replay.mjs replay_carries_worktree_name：自动重连和reconnectNow带同一newSessionId/name，ready后只带existing sessionId。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1318 createWithCutConnection与:1352：在客户端收到ready前切连接；自动/手动各至少2attach且id相同，显示首创建id，磁盘wt/branch/目录均仅1、daemon与行内session仅1，恢复后shell可用。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R3.8 | server/worktree_test.go TestWSAttachWorktreeCreateFailed：不可写.git/worktrees触发fatal create_failed并带git原报错，projects无新行、只有main分支、无container；manager_test.go同类cleanup用例见矩阵。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1359：预检通过后chmod阻止git，展示Permission denied等原报错、无新行/会话/视图；分支/worktree/container完整状态与前相同。 本次运行由另一名验证者负责。 | 普通创建失败守护通过；并发接管回滚不通过（P1）。 GUI运行仍由另一名验证者负责。 |
| R3.9 | test-session-form.mjs picker_worktree_mode_name_segment：四字段存在、空名disabled、base/目标准确、返回named mode；picker_name_segment_follows_mode_and_folder：非git置灰且返回normal时解除。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1382：机器概览进入worktree，非git根禁输入/确认、进入webapp后空名禁确认、bad/taken原因、可用目标并实际创建from-overview分支。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R3.10 | session/worktree_test.go TestCreateNamedWorktreePathNotAllowed：只有仓库白名单，完整目标路径报错、不建container/branch；symlinked_container不写白名单外；test-worktree-dialogs.mjs plan_rejection_keeps_dialog_open含not_allowed。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1411：项目入口可进入，完整目标路径错误、禁确认、Enter保持；取消后container/branch均不存在。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R4.1 | test-worktree-dialogs.mjs worktree_session_dialog_shape：标题/项目完整路径、无目录list/mode/name，仅ui和flags，确认返回normal该workdir；chat选择和取消也断言。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1428：标题fix-login、项目/完整路径、无folder/mode/name、terminal/chat各卡、continue启动项、无worktree模式文本。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R4.2 | session/manager_test.go TestCreateInHiddenWorktreeDir：创建在隐藏真实wt中，Runner.Home等于git规范路径；test-worktree-dialogs.mjs worktree_session_hidden_dir返回完整隐藏workdir。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1446：目录含/.devflow-tmp/，从行新建term，shell pwd及daemon workdir等于隐藏目录，会话挂该行。 本次运行由另一名验证者负责。 | 普通隐藏路径守护通过；合法换行路径反例不通过（P6）。 GUI运行仍由另一名验证者负责。 |
| R4.3 | session/trust_test.go TestChatTrust/worktree_of_trusted_main：仅主目录信任，邻接与隐藏wt均Trusted；server/fs_test.go TestFSChatTrustWorktree：主/两wt trusted而子目录untrusted；server/ws_chat_test.go TestWSCreateChatInWorktreeOfTrustedMain：两wt均可create chat且workdir准确。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1457：临时.claude.json只有main条目，行新建chat成功、daemon workdir准确并得到chat回复。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R4.4 | session/trust_test.go TestChatTrust/neither_trusted/main_false及大量拒绝反例；server/ws_chat_test.go TestWSCreateChatWorktreeUntrusted：untrusted/伪造.git/子目录REST信任结果拒绝，WS fatal chat_unsupported带workdir_untrusted；test-chat-availability.mjs worktree_untrusted_reason/test-worktree-dialogs.mjs worktree_session_chat_disabled_reason：精确主目录提示、term可用。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1469：chat disabled、指定主目录准确文案、点击保持false、terminal选中/可用/确认启用，实际terminal echo成功。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R4.5 | server/projects_test.go TestProjectsTwoSessionsOneWorktree：两个独立id都在main.sessions；GUI实际并存使用补充。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1488：原term在fix-login，再新建term使数量+1、名字唯一，两个会话分别shell echo成功、workdir相同。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R4.6 | session/trust_test.go TestChatTrust/worktree_itself_trusted：仅wt自身Trusted。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1506：临时信任表含wt而不含main，从行新建chat并得到chat回复，然后结束。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R5.1 | session/manager_test.go TestDeleteSessionKeepsWorktreeAndBranch：terminal/chat各建named wt加2未合并commit，Delete后目录/branch/2commit/managed空session行均在；test-worktree-dialogs.mjs delete_session_keeps_worktree_note：准确保留文案、初焦点Cancel。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1528：两未合并commit，用户删会话确认保留文案、Cancel聚焦；daemon无会话、row没有会话、目录/登记/branch/原tip及2commit均在。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R5.2 | session/worktree_remove_test.go TestRemoveCleanMergedWorktree：真实merge后status零dirty/unmerged、managed，显式DeleteBranch删除branch/登记/record，main合并文件在；test-worktree-dialogs.mjs delete_wt_clean：文案/按钮/请求删除分支。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1549：无会话fresh分支全部被main包含，clean框无文件/提交/会话/ignored行、确认默认，删除后目录/登记/branch全无、main不动。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R5.3 | session/worktree_remove_test.go TestDirtyFiles：modified/staged/untracked总数3；TestRemoveDirtyNeedsConsent：无DiscardFiles返回changed、0已结束、目录/三文件内容不动，显式同意成功；test-worktree-dialogs.mjs delete_wt_files初焦点Cancel、仅force、请求discard=true。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1567：精确3文件warning、默认Cancel、Enter=Cancel保持磁盘与3dirty；仍然删除后目录/登记/branch不存在。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R5.4 | session/worktree_remove_test.go TestIgnoredFiles：0→4逐文件、非ignored不算；TestRemoveIgnoredOnlyIsClean：0dirty/4ignored，新增ignored不需同意；test-worktree-dialogs.mjs delete_wt_ignored_note：clean、4条注记，0/缺字段不显示、-1显示未知。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1598：真实ignored=4、git status clean，clean框无文件警告、有准确ignored数、默认确认，实际删除；R5.2守N=0无注记。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R5.5 | session/worktree_test.go TestUnmergedCommits：2commit，另一本地branch或remote-tracking覆盖均降0，同名tag不误认；worktree_remove_test.go TestRemoveUnmergedNeedsConsent：默认保留branch/tip/2commit；deleteBranch无drop拒绝、显式drop可删；desktop delete_wt_commits两选择和请求精确。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1618：两worktree各2commit；默认keep、Enter只删目录保留tip/2commit；选择drop后默认Cancel，显式确认删branch并for-each-ref --contains为空。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R5.6 | session/worktree_remove_test.go TestRemoveEndsSessionsFirst：status准确两id；请求只同意1个返回changed、会话都活且磁盘完整；完整同意返回两EndedSessions并移除map；desktop delete_wt_sessions_line/flow_sessions_are_the_statuses_not_the_rows：status列而非树行来决定数量/请求。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1649：term+chat两活会话，确认2条精确文案；删后daemon均无、目录/登记/branch无、两打开视图关掉、当前不指向已结束会话。 本次运行由另一名验证者负责。 | 普通多会话守护通过；真实 tmux 反例不通过（P2/P3/P4）。 GUI运行仍由另一名验证者负责。 |
| R5.7 | session/worktree_remove_test.go TestRemoveMainRefused：即使所有同意true仍ErrWorktreeIsMain、main README/tip/worktree完整；desktop main_worktree_has_no_menu无主行菜单。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1674：主行无worktree-menu，其他行有；项目menu只有移除，flat项目无worktree菜单；直接POST主目录返回400 worktree_is_main、.git在。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R5.8 | session/worktree_remove_test.go TestRemoveExternalNeverDeletesBranch：外部3dirty/1commit，无文件同意拒绝；全同意含deleteBranch仍拒绝且不动数据，目录-only+files同意后删目录branch-tip在；切换分支后managed=false不删原或新branch；desktop delete_wt_external无branch选择。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1695：external标签准确；dirty warning Cancel且file保留；清理测试file后external框无branch选择；删后目录/登记无，ext/tool branch在。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R5.9 | session/worktree_remove_test.go TestRemoveLockedRefusedBeforeEndingSessions：locked含usb，零Ended、两会话活、磁盘完整，解锁能删；TestRemoveSubmoduleCheckoutRefused/TestRemoveRefusedWhenNestedWorktree见矩阵；desktop delete_flow_500_reopens_with_error原错误+未结束。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1721：locked时明确原因/usb、会话继续echo、row及磁盘都在；nested另一wt在ignored目录时删除被拒绝并点名inner，双方目录/branch及未提交file不变。 本次运行由另一名验证者负责。 | 普通事前拒绝守护通过；确认后同OID切分支的重查不通过（P5）。 GUI运行仍由另一名验证者负责。 |
| R5.10 | server/worktree_test.go TestDeleteSessionNeverReturnsPreserved：clean2commit/uncommitted/ignored-only三个REST场景均204空body、map消失、目录内容数不变、branch-tip和commit数不变；兼容v3 flow还守未跟踪文件。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1767：只发旧REST DELETE，两未合并commit和未提交文件场景都204，目录/登记/branch/commit/file保持，row没有会话。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R5.11 | session/worktree_test.go TestUnmergedCommits/detached：2孤立commit；worktree_remove_test.go TestRemoveDetachedNeedsConsent：无drop拒绝且目录/HEAD不动，显式drop成功；clean detached零unmerged可直接删；desktop delete_wt_detached初焦点Cancel、force请求drop。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1785：2孤立commitwarning/Cancel/Enter不动；force后目录/登记无、branch --contains为空；零孤立commit的detached显示plain且确认默认。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R5.12 | session/worktree_remove_test.go TestRemoveGitFailureKeepsState：git原错误、EndedSessions精确两id、map已无而目录/branch仍在；TestRemovePartialFailureReported/TestRemoveSessionEndFailureStops见矩阵；desktop delete_flow_500_after_sessions_ended/partial_shows_failure：已结束数量、错误、残留路径和branch保留、仅关闭。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1816：git wrapper拒绝remove后两个session消失但row空、磁盘全留；权限阻止部分目录删除后1session已结束、git登记无但dir残留、branch仍在，错误含Permission denied且说明准确。 本次运行由另一名验证者负责。 | 普通/超时部分失败守护通过；kill失败却报已结束不通过（P2）。 GUI运行仍由另一名验证者负责。 |
| R6.1 | test-session-form.mjs continue_note_shown：仅勾continue出现准确说明、确认仍可用、取消勾选消失；test-worktree-dialogs.mjs continue_note_counts：数量查exact workdir，不把subdir/ended当当前目录会话，note不阻止confirm。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1873：前提main活chat存在，未勾无note、勾后精确说明、confirm非disabled，取消勾选note消失。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R6.2 | test-session-form.mjs continue_note_hidden_without_sessions：count=0或没传count，勾continue仍无note DOM。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1888：detached无会话，勾continue是真、屏幕与DOM均无note。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R7.1 | test-shortcuts.mjs match_digits/pick_index：⌘1/3/9、超范围null，⌘0/组合键不匹配，12会话时9=第9；接index用例守实际路由。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :1997：3/1/最后/2实际切换，超过n直到9均不动；probe确认阻止传播，⌘K非快捷键不拦。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R7.2 | test-shortcuts.mjs match_brackets/pick_prev_next_wraps：5个末→首、首→末，空列表null。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :2015：末next首、prev末、连续整圈访问每会话一次且顺序正确。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R7.3 | test-shortcuts.mjs capture_blocks_propagation：textarea焦点键defaultPrevented、自身/更内层capture均未收到、draft不变；普通a/CmdC仍可达。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :2031：焦点term，序号/prev/next切换、记录发往remote字节零；普通echo记录器有数据；chat焦点next切换、draft remains。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R7.4 | test-shortcuts.mjs blocked_does_not_intercept：dialog blocked时不open、default未防止且input接到keydown，解除后重新有效。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :2070：新建dialog和delete-confirm开着时2/next不切且按键传递，取消后2成功切。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R7.5 | test-tree.mjs visible_sessions_skip_collapsed：3项目各2会话，折第2仅第1/3的4会话返回，折machine零；test-shortcuts.mjs skips_collapsed_via_index组合实际index逻辑。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :2096：new-api折叠仍有已知hidden id，整圈next仅可见序列、绝不包含hidden、项目不自动展开。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R8.1 | test-theme-tokens.mjs chat_shape_rules：user气泡accent-soft/17px/右对齐，composer17px、send圆形、assistant无bubble/perm radius；chat markdown/diff/view/render-guard等行为由原npm测试守。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :2149：真实chat含消息/tool/perm；测量user右对齐soft气泡、assistant从左且无user底色、composer rounded并全列宽、tool列宽、perm圆角、main白色raised card。Markdown复制diff链接行为由另一验证者跑gui-chat-smoke补齐。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R8.2 | test-theme-tokens.mjs terminal_theme_from_css_vars：四terminal色准确且运行时读var；ansi_colors_unchanged精确逐色比较旧ANSI；index使用terminalTheme无literal；terminal selection等原npm测试守。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :2217：shell带ANSI红色/文本回传，测量终端background/fg/cursor/鼠标selection像素；窗口壳主题色、旧/深背景像素极低；原PTY与剪贴板行为需另跑gui-smoke。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R8.3 | 原 gui-smoke/gui-chat-smoke 基准调用数14/26，本HEAD30/26，旧断言保留；未运行这些GUI脚本。 | :2262：对BASE_REF每断言/等待原行必须仍存在，case count不减；默认仅静态比较，只有--with-existing才真正运行两脚本并assert退出0/0FAIL。 本次运行由另一名验证者负责。 | 旧脚本数量及断言静态核对通过；本次两份 GUI 实际运行由另一验证者负责，尚未合并。 GUI运行仍由另一名验证者负责。 |
| R8.4 | test-theme-tokens.mjs tag_contrast_all_hues/contrast_table/button_text_contrast_from_the_stylesheet/dot_shapes_differ：颜色阈值与点形；GUI运行时computed style补充。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :2295：chat/overview/new/delete/menu五屏各种文字实际fg/bg合成，正文按钮>=4.5、次要>=3且每类至少8样本；三同时后台点分别空心/实心/光环、>=3对比、>=6px、文案精确。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R8.5 | test-dialog-layout.mjs检查CSS/结构和最小布局算法；实际几何由GUI完成。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :2374：两语言800×500，sidebar>=10行、picker worktree拒名/new session长信任原因/new wt有效及拒绝/delete session/5种删除形态/失败重开/slash>=10项，所有测量problem数组为空。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R8.6 | test-theme-tokens.mjs window_background_matches_bg_app：BrowserWindow backgroundColor=#EFEFF4与CSS相同。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :2480：native show和firstPaint背景均EFEFF4，第一帧PNG周边/侧边栏>=95%匹配，卡片白色，旧米色<0.5%、dark<3%。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R9.1 | test-tree.mjs legacy_groups_by_session_fields/ordering：只有sessions信息也准确project/wt分组；test-chat-availability.mjs proto3_daemon_supports_chat：proto3仍可chat；test-sidebar.mjs legacy_note_and_disabled_entries：upgrade原因，unknown不误说旧；test-session-form.mjs picker_proto3_has_no_name_segment：无name/plan、保留mode；delete_session_legacy_note精确旧删除事实。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :2517：真实基准proto3 daemon，main/wt sessions分组、quiet存在磁盘但不展示、新命名/删除入口disabled附upgrade；overview无name、自动vibe/id并可shell；旧删除clean确实目录branch无、dirty保留并消息准确。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |
| R9.2 | server/compat_test.go TestV3ClientFlowAgainstV4Daemon：literal旧帧建worktree、ready JSON keys对golden、自动vibe/id、输入resize/ping/list/reconnect/rename/delete成功、session字段不超v3且无terminal-ui，删除后notes/branch/worktree全在、再attach fatal notfound；server/worktree_test.go TestAttachWorktreeWithoutNameKeepsLegacyNaming完整ready相等。 本次相关 Go/desktop 已运行；见场景 Go 日志与 desktop 日志。 | :2584：取BASE_REF的ws-smoke脚本运行exit0/0FAIL/>=10PASS；旧attach无name自动vibe/id/目录正确、接入/echo/删除204且会话消失。 本次运行由另一名验证者负责。 | 已读断言与需求对应；自动化层通过；GUI 最终运行结果待另一名验证者。 |

断言覆盖备注：TestProjectsTree 自身两个会话均为 terminal，GUI/desktop 补 chat/terminal 前提；TestProjectsSurviveSessionDeletionAndRestart 自身只守项目，两个 worktree 与桌面重启由 GUI 补；TestRemoveProjectKeepsDisk 自身只 stat 仓库，完整分支/worktree集合由 GUI 补。R3.8 普通失败无残留有明确断言；设计第10节允许撤销失败或现场被别人改变时保留，以免扩大数据丢失，不能据此接受 P1 的强删。

## 完成条件

- 全部 R1–R9 GUI 场景：尚未验证。本次只审读 58 场景断言，运行由另一名验证者负责；需合并同提交的独立 GUI 结论。即使常规 GUI 全过，P1–P6 的新增反例仍需修复/复验。
- make check：不成立。本次等价的 gofmt/vet/typecheck/npm 通过，但 Go 全套因受限环境孤儿检查失败/超时；不能将总检查标为通过。相关51个场景 Go 用例补充运行全部通过，仍不替代全套。
- gui-smoke、gui-chat-smoke 用例数不减/断言不放宽：静态部分成立（14→30、26→26，旧断言未删）；实际两份脚本运行尚未验证，由另一名验证者负责。
- 协议 protocol.go/protocol.ts/rest.ts/docs/protocol.md 一致：不成立。JSON类型与字段集合一致；预检不存在目录的状态码/原因与文档不同（P7）。
- 删除只做用户同意过的事、结束会话/部分失败如实报告：不成立。P1–P5 的磁盘、分支及真实 tmux 读回证据直接反驳。
- 新建重放仅建一份、信任规则、v3/v4基本兼容：非GUI层成立（相关51 Go、desktop、两份WS与invariant3/17）；GUI最终结果尚待另一验证者。

## 问题（7 条，均拦）

以下实际实验没有改变产品实现；独立副本仅新增验证测试、用既有测试钩子安排真实外部 git/tmux 变化。日志中的 FAIL 是新增反例对需求结果的断言失败。

tmux 四个反例的命令、源码与完整输出：

1. cd /tmp/vr-codex-tmux-n588mgcz/vibe-remoted && TMPDIR=/tmp TMUX_TMPDIR=$(mktemp -d /tmp/vr-cp-XXXXXX) GOCACHE=/tmp/vr-gc-gocache go test -count=1 -timeout 5m -v ./internal/session -run '^TestCodex'：退出1，旧元数据例PASS，其余socket/解析/报错路径例FAIL。
2. 同目录，同样TMPDIR/TMUX_TMPDIR/GOCACHE，go test -count=1 -timeout 5m -v ./internal/session -run '^TestCodexSameOID'：退出1，other/detached均FAIL。

源码：[codex_probe_test.go](/tmp/vr-codex-tmux-n588mgcz/vibe-remoted/internal/session/codex_probe_test.go)；完整日志：[probe-tmp.log](/tmp/vr-codex-tmux-n588mgcz/probe-tmp.log)、[branch-probe.log](/tmp/vr-codex-tmux-n588mgcz/branch-probe.log)。下列P2–P5各自引出相应实际输出。

### P1 严重、拦：创建失败回滚会删除另一个进程建的 worktree 文件

位置：`vibe-remoted/internal/session/worktree.go:759`（自己的 worktree add 失败后 `claim.undo()`）、`:896`（只按相同分支，或 detached 且相同 OID 判为本次创建）、`:901`（`git worktree remove --force --force`）。

实际时序：daemon 先占空目录和新分支。另一个进程在 daemon 自己执行 `git worktree add` 前，用 `git worktree add <同一路径> fix-login`，或 `git worktree add --detach <同一路径> HEAD`，建立另一份 worktree，并写入 `precious.txt`。daemon 的 add 由于目录不为空而失败。其回滚把对方的 worktree 误认为是本次创建，强制删除文件。两个变体都发生了未征得同意的数据丢失；同分支变体还删了现在被另一个创建者使用的分支。

依据：原有 `TestUndoOnlyRemovesOwnArtifacts/directory_taken_by_another_worktree` 在同一时序下只使用**不同分支** `theirs`，所以已有 PASS 不守同分支/同 OID 的路径。`CLAUDE.md` 宣称“失败时只撤销本次占到的东西，别人同时建的同名目录或分支原样不动”，实际不成立；需求安全和 R3.5“不覆盖”也不允许该删除。

实验未改产品代码；只在 `/tmp/vr-diff-copy` 复制的模块新增独立测试，使用现有测试钩子 `testBeforeWorktreeAdd` 固定另一个进程运行 git 的时点。

命令（第一次创建副本尝试因 workdir 尚不存在被工具拒绝，没有执行；随后从原目录创建副本再运行）：

```sh
# 原目录：Python shutil.copytree('vibe-remoted', '/tmp/vr-diff-copy')，新增 independent_diff_test.go
cd /tmp/vr-diff-copy
TMUX_TMPDIR=$(mktemp -d /tmp/vr-da-tmux-XXXXXX) TMPDIR=/tmp GOCACHE=/tmp/vr-gc-gocache go test -v -count=1 ./internal/session -run '^TestIndependent' -timeout 3m
```

输出（全文 `/tmp/vr-diff-experiments.txt`）：

```
=== RUN   TestIndependentRollbackOtherSameBranch
CreateWorktree error=create worktree: git worktree add --detach .../devflow-worktrees/fix-login <oid>: exit status 128: Preparing worktree ...
fatal: '.../devflow-worktrees/fix-login' already exists; external file data="" read_error=open .../precious.txt: no such file or directory; branch=""
failed creation deleted another creator's file without approval
--- FAIL: TestIndependentRollbackOtherSameBranch (0.40s)
=== RUN   TestIndependentRollbackOtherDetached
CreateWorktree error=create worktree: git worktree add --detach .../devflow-worktrees/fix-login <oid>: exit status 128: Preparing worktree ...
fatal: '.../devflow-worktrees/fix-login' already exists; external file data="" read_error=open .../precious.txt: no such file or directory
failed creation deleted a separately created detached worktree's file
--- FAIL: TestIndependentRollbackOtherDetached (0.39s)
FAIL .../internal/session 1.612s
```

应有结果：原创建失败，但对方的 `precious.txt`、worktree 注册、对方正在使用的分支保持原样。实际：文件和 worktree 被删。同分支和同 OID 的两次实验是同一个判断缺陷，问题数计 1。

### P2 结束会话失败仍删除目录，且假报已经结束

严重程度：严重；建议拦。关联 R5.6、R5.12。

位置：`manager.go:674` 丢弃 syncFromTmux 的成功标记；`runner.go:835` kill-session 失败仅记日志；`manager.go:682`–688 仍删除会话表项、释放占用并返回 nil；`projects.go:815`–820 据此写入 endedSessions。

最小触发：一个正常 worktree 有活终端会话；RemoveWorktree 初次对账成功后、真正结束会话前，外部清理删除 socket 文件。测试用现有 `testAfterRemovingMarked` 精确删除自己创建的 socket，server 本身仍运行。删除会话时对账失败并识别出 missing socket，但 Kill 的失败被吞掉，整个删除成功。对自己的 server 发 SIGUSR1 重建 socket 后证实 tmux 会话仍活。

实际输出：

```text
warning: failed to kill tmux session vibe-remote-1795117975666-f556d088: exit status 1
RemoveWorktree result={Removed:true BranchDeleted:false BranchError: EndedSessions:[1795117975666-f556d088]} error=<nil> <nil> directoryExists=false
after SIGUSR1 to own server, tmux session alive=true; reported ended=[1795117975666-f556d088]
```

预期：结束失败应返回 worktree_remove_failed，目录、分支留着，未确认结束的 id 不应进入 endedSessions。这不属于 CLAUDE.md 所写的“daemon重启后空表+socket被删”限制：本次 daemon/manager没有重启，进入删除时表里有活会话，单次 RemoveWorktree 内触发。tasks.md 的后续已提到单独 Delete 吞错误，但未免除 R5.6/R5.12 的保证。

### P3 工作目录中的换行或制表符使活会话遗漏/归属错位

严重程度：严重；建议拦。关联 H19、R5.6。

位置：`runner.go:119` 的 SplitN 14 列；`runner.go:254` 按换行切记录，260–266 解析失败只记录并 continue，最终仍回 ok=true；`manager.go:653` 等据此 reconcile，活条目被删除或恢复成错误归属。

实验：会话在正常 worktree 创建，归属和 startDir 已持久化；tmux respawn-pane 把 pane_current_path 改到名字为 `line\nwrap` 或 `tab\twrap` 的合法目录，以模拟终端执行 cd 的实际状态。换行实验无需重启；制表符实验用空的第二个 manager模拟 daemon重启。

换行实际输出：

```text
tmux list-sessions unparsed line: "vibe-remote-...\t/private/tmp/.../line"
tmux list-sessions unparsed line: "wrap\t\tnormal..."
parsedSessionCount=0 ok=true
status.sessions=[]; expected creation-root session 1795117976370-868508d7
removal={Removed:true BranchDeleted:false BranchError: EndedSessions:[]} error=<nil> directoryExists=false tmuxAlive=true
```

制表符实际输出：

```text
parsedSessionCount=1 ok=true
status.sessions=[]; expected creation-root session 1795117977025-480deb47
removal={Removed:true BranchDeleted:false BranchError: EndedSessions:[]} error=<nil> directoryExists=false tmuxAlive=true
```

制表符会把 mode/project/home/created/startDir 列错位，不仅显示名错。预期：合法 cd 不改变归属；实在不能完整解析时必须按对账失败，不能信任部分/空结果让删除遗漏活会话。这里 socket 正常、server正常、不是外部删socket的已知限制。

### P4 stderr 中 socket 路径含 “no sessions” 就被误判空表

严重程度：一般（触发目录名较特殊，但后果为安全边界被绕过）；建议拦。关联 R5.6、CLAUDE 四条规则。

位置：`runner.go:168`–171 对整个 stderr 用 strings.Contains；`runner.go:220` 在 socket/table检查之前直接返回空表。

实验：创建独立 TMUX_TMPDIR `/tmp/vr-no sessions-<随机后缀>`；启动自己的活 tmux 会话，然后删除自己的 socket。真实 tmux 的报错是 `error connecting to /private/tmp/vr-no sessions-.../tmux-501/vibe-remote (No such file or directory)`，这不是“no sessions”回答，但 isNoTmuxServer 在路径里找到了这两个词，跳过 haveTerminal 的保守规则。整个删除成功、活会话不被结束。

实际输出：

```text
liveTmux count=0 ok=true while server alive and socket absent
removal={Removed:true BranchDeleted:false BranchError: EndedSessions:[]} error=<nil> directoryExists=false sessionAlive=true
```

预期：第④种失败；返回500、endedSessions=[]、目录/分支/会话都在，并说明socket不见了。表中本来有终端会话，未重启，CLAUDE 已知限制不适用。

### P5 结束会话期间切同OID分支或detached，仍删除目录与原分支

严重程度：一般（违反确认约定）；建议拦。关联 CLAUDE“分支被切换即409”、设计4.6/6.2 的删除确认条件。

位置：`projects.go:828`–837 在结束会话后只比较 HEAD 的OID；不重读分支、detached/managed 状态。初次比较分支正确，结束会话阶段发生变化后未再次验证。

实验：managed worktree fix-login，有一个会话；确认请求带 branch=fix-login、deleteBranch=true。`testAfterSessionsEnded` 执行 `git checkout other`（other恰好与fix-login同OID），或 `git checkout --detach <同OID>`。这是会话结束前后用户或其他进程可能造成的有效外部变化。

实际输出（other）：

```text
changed branch after sessions ended: branch="other" HEAD=4a1469d36e44a5863652782035422978c76acc5e
confirmedBranch=fix-login confirmedHEAD=4a1469d36e44a5863652782035422978c76acc5e removal={Removed:true BranchDeleted:true BranchError: EndedSessions:[1795118050036-ccebc19c]} error=<nil> <nil> dir=false originalBranch="" otherBranch="4a1469d36e44a5863652782035422978c76acc5e"
```

detached也同样 Removed:true、BranchDeleted:true、error=nil，目录和fix-login都删除。other分支保留。

预期：返回 WorktreeChangedError/409，带真实 endedSessions，重新确认变化后的状态；目录和原分支此时保留。该实验不证明删除other分支，仅证明确认后的branch变化没有守住。

### P6 一般、拦：包含换行的合法目录名不能列出和使用

位置：`worktree.go:137–177`，`ListWorktrees` 用非零分隔的 `git worktree list --porcelain`，再按 `\n` 分行，无法表示目录路径中的换行。git 允许该目录名，并会原样输出换行。新建分支名字限制控制字符与这个问题无关：这是一份**外部** worktree 的既有目录名。

先用 /tmp 临时仓库验证 git 本身的输出，包含 tab、换行、引号、反斜线四种路径。只有换行破坏列表结构。随后独立 Go 测试读取同样目录并调用公开 Manager.WorktreeStatus（无 tmux）。同一命令上述 `-run '^TestIndependent'`。

```
=== RUN   TestIndependentNewlineWorktreePath
actual directory="/private/tmp/TestIndependentNewlineWorktreePath3331175445/001/external\nworktree"
list=[{Path:.../devflow Branch:main ...} {Path:.../external Branch: Head: ...} {Path: Branch:newline Head:<oid> ...}]
WorktreeStatus=worktree not found
existing external worktree must be listed and usable; found=false status_error=worktree not found
--- FAIL: TestIndependentNewlineWorktreePath (0.30s)
```

应有结果：R2“列出项目的全部 worktree”、R4“在任何已有 worktree 里开会话”含该目录；状态查询可用。实际目录在磁盘和 git 注册中存在，daemon 解析错路径并报 not found。问题频率较低，但属于真实功能缺陷；不是未运行的推测。

### P7 一般（文档/错误反馈），拦：不存在的白名单内目录被错误报告为越权

位置：vibe-remoted/internal/server/projects.go:77，config/config.go:270；docs/protocol.md:458。handler 先用 ResolveAllowedWorkdir，EvalSymlinks 的 ENOENT 被统一转换为403“path not in allowed roots”，尚未进入400“not a directory”的判断。

用同HEAD构建的临时daemon，use_tmux=false、allowed_roots只给自建 /tmp/vr-api-*/roots，GET plan 查询其 missing 子目录（不存在但位于白名单内）。命令：python3 /tmp/vr-codex-5YMvOm/protocol-probe.py。实际输出：

```text
不存在且在白名单内 (403, '{"error":"path not in allowed roots"}\n')
普通文件且在白名单内 (400, '{"error":"invalid_request","message":"workdir is not a directory"}\n')
无token /api/v1/projects (401, '{"error":"unauthorized"}\n')
无token /api/v1/worktrees/plan (401, '{"error":"unauthorized"}\n')
无token /api/v1/worktrees/status (401, '{"error":"unauthorized"}\n')
```

预期：按 docs/protocol.md，workdir 不是目录返回400 invalid_request；越出 allowed_roots 才403。实际：缺失目录403且说不在白名单。目录在选择后被外部删除时，用户会收到错误的权限原因，也破坏端点文档。普通文件对照正确返回400，排除了fixture本身不在白名单的解释。三个新GET端点无token均401，鉴权本身正常。证据：[protocol-probe.py](/tmp/vr-codex-5YMvOm/protocol-probe.py)、[protocol-probe.log](/tmp/vr-codex-5YMvOm/protocol-probe.log)。

## 待验证项：review.md 的 13 条

| 项 | 本次复现/排除证据与结论 | 影响及下一步 |
|---|---|---|
| 1 M1整体 | 读GUI R8.1/R8.2的圆角、列对齐、颜色像素断言；desktop theme脚本已通过；历史截图逐块对照有记录 | 本次未独立跑GUI/看真实窗口，运行由另一验证者负责；不能把历史“已排除”直接沿用 |
| 2 800×500中英文布局 | 读R8.5及dialog-layout实际边界/按钮命中/交叠/文本测量；desktop布局脚本通过；历史26次测量证据与断言对应 | 实际窗口由另一验证者负责；历史delete-wt-failed英文版未测的备注仍有效 |
| 3 冷启动首帧 | 读native背景与firstPaint截图断言；theme脚本核对背景常量通过 | 本次GUI由另一人负责；创建至firstPaint之间的实际合成画面仍非逐帧录屏证明，作为覆盖边界 |
| 4 真实键盘 | jsdom/快捷键脚本通过；CDP代码守preventDefault、无传播、零PTY字节、草稿不变 | 仍尚未验证macOS菜单/输入法链路；需人在打包app按键。未据此编造失败或列新增问题 |
| 5 git<2.31 | 审读fsmonitor每调用-c与历史2.30.2九条WS/六测试日志；c6在旧版本仅COUNT跳过，PARAMETERS仍跑。当前2.50.1 invariant19通过 | 历史证据支持2.30.2有限结论；本次无已安装旧git，未重建旧版本。不能外推更早版本 |
| 6 新环境/无tmux | 本次WS9条实跑：fresh chat-only、PATH无tmux、已退出留socket均200；目录读回删除，没有启动额外tmux | 普通状态已排除 |
| 7 tmux四规则 | 本次WS普通missing socket返回500且endedSessions[]；SIGUSR1恢复后200；PATH缺tmux但有socket返回500，磁盘/会话都在。原守护invariant15通过 | 普通三状态成立；“所有路径已排除”不成立，P2/P3/P4证实额外漏洞，必须修复复验 |
| 8 不存在TMUX_TMPDIR/旧tmux | 没有运行，原因：会落默认socket目录，违反用户安全约束；审读历史tmux3.0a源码摘录，其不回退/tmp，与3.2a+不同 | 仍待隔离容器实测3.0/3.1/3.2；当前local只证明3.6a。配置存在目录有操作出路，未证明新的永久死路 |
| 9 百万未合并提交 | 本次git fast-import造1000000，3次rev-list=1000000，各4.201/4.211/4.210s；临时daemon status200、1000000、dirty0、4.210s，见million-probe.py/log | 本机该规模排除30s超时担忧；不承诺所有硬件/仓库都同耗时 |
| 10 删除超时后的真实状态 | 本次/tmp副本测试设2s，wrapper删除.git后阻塞；error带准确endedSessions、残留路径/分支保留，status=notfound；记录的git父子PID均ESRCH，见timeout-probe.log | 已排除该最小反例；wrapper导致raw git列表prunable仍存在，所以“git no longer lists”是按daemon可用列表说的，文案精度另作备注 |
| 11 菜单重建/删除中行 | 读X11两个GUI操作断言与历史41次采样；desktop sidebar/menu/shortcut修复回归通过 | 真实窗口运行由另一名验证者负责；历史“已排除”需其本次证据 |
| 12 Electron ICU/Go Unicode | 读共享名字向量及全码位比较方式，当前名字测试通过；历史明确比较172码位集合相同 | 本次未启动Electron，全集对照由另一GUI验证者复核；当前共享向量通过不替代全集 |
| 13 旧会话无元数据 | 本次WS直接status/delete未先projects：status包含旧id、endedSessions包含同id、目录消失且tmux结束；独立Go额外abcdef123456也PASS | 已排除最小反例；backfillTerminal实际被collectSessions调用 |

第9、第10项完整新增独立证据：[million-probe.py](/tmp/vr-codex-5YMvOm/million-probe.py)、[million-probe.log](/tmp/vr-codex-5YMvOm/million-probe.log)、[/tmp副本测试](/tmp/vr-diff-copy/internal/session/codex_timeout_probe_test.go)、[timeout-probe.log](/tmp/vr-codex-5YMvOm/timeout-probe.log)。

永久删不掉的路径审读结论：常规“表有会话但server/socket没了”有重启daemon或逐个删会话出路；locked/nested/submodule/untracked repo的拒绝消息有解锁、先移除内层或手动处理出路；PATH缺tmux提示修PATH再重启。未独立证明一个新的永远没有出路的状态。tmux调用本身无时限是tasks已记限制，卡住可重启daemon；本次不制造长期挂起tmux进程。

探索报告的X2.rename/X3.keys/X6.scroll/X8.menu：修前FAIL均有事件/位置/焦点证据，当前对应desktop回归已运行通过，真实窗口由另一验证者负责。X1(c7)后台终端重绘被算新消息、五处M1细节差异及原有分号目录限制已在后续/决策记录，未将它们冒充本次新发现。c7需产品规则选择，不把“尚待选择”本身计作新增功能失败。

## 放松检查



完整审查输入：`git diff 6d88e45...HEAD -- '*_test.go' 'desktop/scripts/*.mjs' '.claude/skills/verify/scripts/*'`，存于 `/tmp/vr-test-diff.txt`。48 个文件，19645 增行，127 删行。新增测试大量增加覆盖；修改已有内容的文件仅以下类型。

1. `server/contract_test.go` 的 `TestInfoAndReadyProto3` 改名 Proto4，两处版本期望 3→4；`protocol/protocol_test.go` 版本期望同改，`ws-chat-smoke.mjs` info.proto 3→4。是 R9 的协议升级，不是放宽。
2. `server/worktree_test.go` 原 `TestDeleteDirtyWorktreeReturnsStructuredConflict` 的 409/worktree_preserved 被替换为 `TestDeleteSessionNeverReturnsPreserved`；覆盖 clean、uncommitted、unmerged、ignored-only，要求 204 空响应，并核对磁盘。是 H16、R5.1、R5.10 明确改变删除会话行为，保留数据的断言加强。
3. `session/chat_manager_test.go` 删除会话后 worktree 不存在改为必须存在，增加分支必须存在。是 R5.1；`TestParseTmuxSessionLineReadsClaudeU` 10 列“作为末字段吞掉 tab”改为拒绝非法列数，是升级后的列格式校验加强（现有 8、9、13、14 列另有测试）。
4. `session/manager_test.go` 原 `TestManagerDeleteRecoveredCleanWorktreeRemovesGitResources` 改为 KeepsGitResources，目录/分支都必须保留，会话表必须移除。原 dirty 删除期望 WorktreePreservedError、保留已停止元数据、清文件再重删改为一次成功、进程真正退出、原文件内容和分支都在。是 H16/R5.1；并新增两会话只删一个的进程/目录断言。
5. `session/worktree_test.go` 的函数签名适配 `WorktreeSpec/CreatedWorktree`，清理替换为 `Undo`。原自动删除 clean、dirty、ignored 的三条 `CleanupWorktree` 用例删除，依据生命周期拆分 H16；替代覆盖在 `TestDeleteSessionKeepsWorktreeAndBranch`、server clean/dirty/ignored 组、`TestRemoveIgnoredOnlyIsClean`、`TestRemoveDirty…`、`TestUndoOnlyRemovesOwnArtifacts/clean`。原 `TestWorktreeRollbackToleratesMissingWorktreeOrBranch` 改名 `TestUndoToleratesMissingWorktreeOrBranch`，仍核对可重入撤销。不能简单说“基准以来没有删除测试”：确有三条旧 cleanup 用例被行为变更替代。
6. `session/shutdown_test.go` 的 ValidateWorkdir 钩子改为只在目录实际存在时用 sync.Once 阻塞；新增创建前预检调用使钩子可被调用多次，阻塞时点仍在目录建好之后；关停等待的原断言不变。不是放宽。
7. `desktop/scripts/chat-test-util.mjs` 仅增加导出的测试接缝（machineTrees/caps/projects、poll/refresh），原接缝未减；其他被修改桌面测试文件只增测试；没有旧断言删除。
8. `gui-smoke.mjs` 只有两条旧行被替换：临时 daemon 配置增加一个默认不选的 continue flag、原第9步注释改为第10步。原检查全部保留；增加侧边栏布局、实际快捷键截断、普通按键和对话框等检查。`gui-chat-smoke.mjs` 在本基准 diff 没有变化。`desktop/package.json` npm test 原23个脚本全部保留，追加10个脚本。该范围没有旧测试超时被调大的删改，也没有添加忽略旧测试的规则。

### c6

还读了 `git show cef5e4d -- vibe-remoted/internal/session/review_fixes_test.go`：原环境继承检查拆为 `GIT_CONFIG_PARAMETERS` 与 `GIT_CONFIG_COUNT` 两子例。COUNT 的原两个值（inherited=kept、core.fsmonitor=false）一条不少，并添加环境自己指定 fsmonitor 不得胜过 daemon 的设置。新增探测 `exec.Command("git", "-C", repo, "config", "--get", "vibe.inherited")` 不是 kept 时 t.Skip，确属 review 已报告的条件跳过；旧 git 不支持 COUNT 的前提合理，PARAMETERS 在旧 git 仍保留。

本次执行（/tmp 副本，不改产品代码）：

```sh
TMUX_TMPDIR=$(mktemp -d /tmp/vr-da-tmux-XXXXXX) TMPDIR=/tmp GOCACHE=/tmp/vr-gc-gocache go test -v -count=1 ./internal/session -run '^(TestGitEnvKeepsInheritedConfig|TestGitTimeoutKillsProcess|TestUndoOnlyRemovesOwnArtifacts|TestCreateRaceWithExternalDir|TestCreateRaceWithExternalBranch)$' -timeout 3m
```

结果：c6 两个子用例 PASS，不跳过；原外部目录、外部分支、撤销五个子例全部 PASS。说明现有断言并没有守住 D1 的两个反例。原测试输出见 `/tmp/vr-diff-existing-checks.txt`。

c6 的备注：探测忽略执行错误，跳过条件实际比“git<2.31”宽，任意探测失败也会跳过；该写法本机未触发，不能据此认定产品功能坏了。是否保留仍按 review 的 c6 由汇总记录处理。

### 其他新增条件跳过（不能漏记）

以下都是相对 6d88e45 新增的测试/辅助器里的 skip，主要为实验前提，不能混成“其他无跳过”。

- `config/TestResolveAllowedNewPath`，`server/TestProjectsAllowedRootIsSymlink`，`server/TestWorktreeStatusEndpoint`，`server/TestWSWorktreeErrorsAreFatal`，`session/symlinkedContainerRepo`，`session/TestWorktreePathChecksBeforeGit`，`session/TestRemoveOnlyListedWorktrees`，`session/TestCreateNamedWorktreePathNotAllowed`，`session/linkdirRepo`：系统不支持符号链接时跳过对应分支。原基准已有类似 symlink skip；新增平台前提，不减旧覆盖。
- `server/TestV3ClientFlowAgainstV4Daemon`：缺 tmux 跳过；`server/gitWrapper`、`session/realGit`：缺 git 跳过。新增端到端实验依赖，不减旧覆盖。
- `server/TestWorktreeRemoveUnbornBranchAsTheDesktopSendsIt`、`session/unbornWorktree`：git 无法添加无提交分支时跳过相应用例。新增 git 版本能力前提。
- `server/TestWSAttachWorktreeCreateFailed`、`session/TestCreateNamedWorktreeGitFailureLeavesNothing`、`session/TestRemovePartialFailureReported`、`session/TestGitNeverGetsShortBranchName`：root 用户跳过需要不可写目录的实验。新增权限前提；本机 uid 非 root。
- `session/fsmonitorProbe`、`session/TestDirtyFilesDoesNotRunFsmonitor`：基线 git 本身不执行 fsmonitor 时跳过探针。新增负面对照前提，否则不能证明关闭的作用；与 c6 是不同的 skip。
- `session/TestProjectsKeepsRecordWhileGitStillListsTheWorktree` 的 moved_aside、unmounted 模拟子例：git 不把缺目录 worktree 标 prunable 时跳过。新增 git 行为前提。
- `session/TestRemovePartialFailureReported`：git 删除失败后仍保持注册时跳过“半删已注销”的分支，因为实际未到该状态。新测试的状态分支选择；其他删除失败仍有断言。
- `session/TestGitTimeoutKillsProcess`：fake git 未记录 PID 时跳过**进程确实被杀**的断言。这个条件比“环境能力不支持”宽，是新增测试覆盖缺口。我的本次一次执行 SKIP，随后原样单测 `-count=3` 三次仍全部 SKIP（全文 `/tmp/vr-diff-timeout-check.txt`）；因此不能用这个测试本次通过来证明进程已杀。代码的进程组杀逻辑与 `TestStuckGitReleasesTheRepositoryLock` 等更完整实验是其他证据，本项作为备注，不因覆盖不足单独判用户功能失败。

没有把上述新增环境跳过等同于旧断言放松；真实改弱的审查项是已列 c6，另存在新加测试的 PID skip 覆盖缺口。


补充核对：基准gui-smoke的check调用14处、HEAD30处；gui-chat-smoke的顶层test调用26处且与基准文件无diff。对比命令 git diff 6d88e45...HEAD -- '*_test.go' 'desktop/scripts/*.mjs' '.claude/skills/verify/scripts/*' 的完整输入在 [/tmp/vr-test-diff.txt](/tmp/vr-test-diff.txt)。基准以来确有旧CleanupWorktree用例被需求行为替换，不能写“无删除测试”；上述逐项说明其替代断言。c6真实条件跳过、新PID测试跳过均留在备注，没有自行放宽检查。

当前51个相关场景Go补跑0SKIP；c6本机两个子例实际PASS。TestGitTimeoutKillsProcess四次SKIP不能证明杀进程，但本次独立2s timeout实验记录真实父子PID且二者均ESRCH，提供了不依赖该skip的实际证据。

## 最后核对

HEAD与工作区结尾输出见 [end-state.log](/tmp/vr-codex-5YMvOm/end-state.log)；与开始完全一致。唯一写入指定工作区的新文件是本 verdict-codex.md，其他新增文件都在 /tmp。当前GUI运行分工保持不变；本结论已因7条真实用户问题不通过，不借GUI尚待合并或沙箱限制推测产品正确。

# 第 1 轮 · 界面部分（verdict-gui.md 全文）

# 关口 C 独立验证结论（界面部分）

- 结论：**通过，有备注**（界面这一半；没有要拦的问题，7 条备注见「问题」）
- 提交：91e0fabd1b2f050aec6b61652790b70a7196480f
- 验证快照：`{"schema":1,"docs_dir":"docs/changes","head":"91e0fabd1b2f050aec6b61652790b70a7196480f","head_tree":"77848cde86cb62f4130a38ae37ec270bb77f58bdb5f6bbe87ffeb07c17bb6a84","target":"6d88e45f511b92b84d46bca1ffd917afae548221","target_tree":"b58c4926876d6dca94d03f0e017504a74b2a24ec80eff298d3a5f37737ec1751"}`
- 验证者：Claude（Fable 5，模型 id `claude-fable-5-2[1m]`），独立验证者，没有写过这段代码；负责界面这一半（真实 Electron 窗口里的场景）。Go 测试、`make check`、接口冒烟、读 diff 由另一名验证者负责，这里不重复。

## 环境版本

开始时（worktree `/Users/mac/github/vibe-remote/.devflow-tmp/verify-91e0fab-gui`）：

```
$ git rev-parse HEAD
91e0fabd1b2f050aec6b61652790b70a7196480f
$ git status --short
（空）
```

结束时（停掉我启动的全部进程、删掉临时目录和临时 worktree 之后）：

```
$ git rev-parse HEAD
91e0fabd1b2f050aec6b61652790b70a7196480f
$ git status --short
（空）
```

三份冒烟脚本各自从这个 worktree 构建并启动临时 daemon 和 Electron；我自己的临时实例同样从这个 worktree 构建（daemon 和假 claude 是 `go build`，桌面端是冒烟脚本刚用 `vite build` 生成的 `desktop/dist`），所以运行的都是这个 HEAD。被忽略的构建产物只有 `desktop/dist/`（和原有的 `desktop/node_modules/`）。没有改动任何已跟踪的文件，没有提交。

收尾：我的 Electron、两台临时 daemon 都已停止，它们各自的 tmux server 已不在（只对我自己的 socket 目录执行过 tmux 命令）；`/tmp/vrgc-hUz4Kt`、三个 `/tmp/vr-XXXXXX`、临时 worktree `…/vrgc-hUz4Kt/base-src` 都已删除，`git worktree list` 里没有它。没有访问 8765、默认 tmux socket 目录、已安装的 app、`~/.claude.json`、真实的 machines.json；我自己的临时实例没有读写系统剪贴板（`gui-smoke.mjs` 的 ⌘C / ⌘V 用例会改剪贴板文本并在结束时写回原来的文本，那是脚本自身的行为）。`/tmp` 下其余的 `vr-*` 目录不是我建的，没有动。

工具：node v22.22.2、go 1.26.2 darwin/arm64、tmux 3.6a、git 2.50.1。

## 检查（GUI 冒烟，逐个运行，各带独立 TMUX_TMPDIR）

| 脚本 | 命令 | 结果 |
|------|------|------|
| gui-smoke.mjs | `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-smoke.mjs` | 第 1 次：46 PASS / 0 FAIL，exit=0 |
| gui-chat-smoke.mjs | `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-chat-smoke.mjs` | 第 1 次：29 PASS / 0 FAIL，exit=0 |
| gui-worktree-smoke.mjs | `TMUX_TMPDIR=$(mktemp -d /tmp/vr-XXXXXX) node .claude/skills/verify/scripts/gui-worktree-smoke.mjs --no-build`（`desktop/dist` 刚由上一条从同一 worktree 构建；daemon 和假 claude 仍由脚本自己构建） | 第 1 次：68 行 PASS / 0 FAIL，`65 cases: R1 8/8, R2 7/7, R3 10/10, R4 6/6, R5 12/12, R6 2/2, R7 5/5, R8 6/6, R9 2/2, other 7/7`，exit=0 |

三份都没有失败用例，所以没有重跑。

## 场景（亲手走的）

我的临时实例：`/tmp/vrgc-hUz4Kt/` 下自建（daemon 从本 worktree `go build`；`this-mac` = 协议 4，`claude` 是两行包装：对话走假 claude、终端走 `/bin/bash`；`old-mac` = 从 `6d88e45` 经 `/tmp` 下临时 `git worktree add --detach` 构建的协议 3 daemon；`allowed_roots` 只有 `/private/tmp/vrgc-hUz4Kt/a` 和 `…/o`；各自独立的 `state_dir`、`TMUX_TMPDIR`、`CLAUDE_CONFIG_DIR`；Electron 用本 worktree 的 `desktop/dist`、临时 userData、`--use-mock-keychain`、随机 CDP 端口）。操作全部是 `Input.dispatchMouseEvent`（先移动到元素中心、核对该点下面确实是这个元素，再按下 / 抬起）和 `Input.dispatchKeyEvent` / `Input.insertText`；断言之外不调用 DOM 的 `.click()`。截图在 `shots/`（99 张，文件名即表里最后一列加 `.png`）；三份冒烟的完整输出在 `gui-logs/`，我的驱动脚本在 `harness/`（都不含 token）。中途为了 R2.2 重启过一次 `this-mac`，重启时把我自己的 git 包装放进了它的 PATH（只在存在标记文件时让 `worktree remove` 失败，用于 R5.12 的第二种情况），其余时候它就是真实的 git。

| 场景 | 怎么验证的 | 结果 | 截图 |
|------|-----------|------|------|
| R3.6 | 先在 devflow 主目录留 1 处未提交修改 + 1 个未跟踪文件；悬停项目行点「新建 worktree」。对话框写「基于 main @ 1421e4a，不包含未提交的改动」，与磁盘 `git rev-parse --short HEAD` 一致 | 通过 | 02-R3.6-new-worktree-dialog |
| R3.3 | 同一对话框逐个输入：`a b`→「名字不能包含空格」、`a..b`→「名字不能包含 ..」、`-x`→「名字不能以 - 开头」、`a~b` / `x.lock`→「git 不接受这个分支名」、输入后清空→「请填写名字」、`change`（与 `change/general-skills` 互为前缀）→ 写明两个名字不能同时存在。每种都是确认按钮不可用、目标目录显示「—」；磁盘上 worktree 和分支没有变化。初次打开（还没输入）时不显示错误、按钮不可用 | 通过 | 02-R3.3-invalid-name、04-R3.3-empty |
| R3.4 | (a) 输入已有分支 `change/general-skills` 后立刻回车：对话框留着，显示「分支 change/general-skills 已存在」。(b) 输入 `fix-login`（可用）后在磁盘上 `git branch fix-login`，再点「创建并打开」：对话框留着，显示「分支 fix-login 已存在」，没有建目录；删掉该分支后重新输入即可继续 | 通过 | 03-R3.4-branch-exists |
| R3.1 | 输入 `fix-login`、点「对话」卡片、点「创建并打开」。磁盘：`refs/heads/fix-login` = main 的提交，`git worktree list` 多出 `…/a/devflow-worktrees/fix-login [fix-login]`，新 worktree 里 README 是已提交的内容、没有主目录的未跟踪文件。界面：devflow 下出现 `fix-login` 行，里面一个对话会话并已打开，标题「devflow / fix-login · fix-login」 | 通过 | 03-R3.1-before-confirm、03-R3.1-created |
| R3.2 | 名字 `change/foo`，终端界面。分支 `change/foo`，目录 `devflow-worktrees/change-foo`（没有 `change/foo` 嵌套目录），侧边栏行显示 `change/foo`；终端里 `pwd; git branch --show-current` 输出该目录和 `change/foo` | 通过 | 04-R3.2-slash-name、04-R3.2-created-terminal |
| R3.7 | 我自己在页面里包了一层 WebSocket（运行时注入，不是脚本作者的那份）。(a) 对话界面、名字 `r37-a`：daemon 的 `ready` 到达时丢弃并关闭连接 → 客户端 1 秒后自动重连重放。(b) 终端界面、名字 `r37-b`：attach 帧一发出就关闭连接，并在 4 秒内拒绝新连接（两次自动重连失败，出现「连接已断开，正在重连…」横幅），之后用指针点「立即重试」。两次的 attach 帧都带同一个 `newSessionId` 和同一个 `worktreeName`。结果各自：daemon 上 1 个会话、`git worktree list` 1 项、1 个分支、没有 `vibe/*` 分支、`devflow-worktrees/` 下 1 个目录、侧边栏 1 行 1 个会话并已打开 | 通过 | 05-R3.7-a-chat-cut / -after、05-R3.7-b-term-cut / -after |
| R4.1 | 悬停 `fix-login` 行点「新建会话」。标题「在 fix-login 新建会话」，副标题「devflow · /private/tmp/vrgc-hUz4Kt/a/devflow-worktrees/fix-login」；正文只有「界面」（终端 / 对话）和「启动选项」，没有目录列表、没有「会话模式」、没有名字输入框。确认后终端里 `pwd` 是该目录 | 通过 | 06-R4.1-session-dialog |
| R1.1 | devflow 主目录 1 个对话会话（经目录选择器建）、`fix-login` 里对话 + 终端会话。侧边栏 `this-mac` → `devflow` → `main`（标「主目录」）/ `fix-login` 两行，会话各在自己的 worktree 下，对话和终端图标不同，第二行写「对话」/「终端」，后台有输出的带空心点 | 通过 | 06-R1-sidebar、01-chat-in-main |
| R1.2 | `new-api`（只有主目录，分支 `dev`）开 2 个会话：没有 worktree 行，2 个会话直接在项目下，项目行显示 `dev` | 通过 | 06-R1-sidebar |
| R1.3 | 非 git 目录 `notes` 开 1 个会话：项目 `notes`，没有 worktree 行、没有分支名，项目行只有「新建会话」一个按钮（没有「新建 worktree」和「⋯」） | 通过 | 06-R1-sidebar |
| R1.4 | devflow 主目录先后 3 个没改名的会话：显示 `devflow`、`devflow 2`、`devflow 3`；`fix-login` 下两个是 `fix-login`、`fix-login 2` | 通过 | 06-R1-sidebar |
| R1.7（标题） | 用真实的双击把 `fix-login` 下的终端会话改名为「登录修复」再点开：标题三段是 `devflow`、`fix-login`、`登录修复`。通知标题见后面 | 通过 | 07-R1.7-title |
| X2 修复 | 真实双击（mousePressed/Released clickCount 1、2）落在已在本窗口打开过、但不在前台的会话名上：出现输入框、焦点在其中、内容是原名；输入新名回车后 daemon 的 title 和侧边栏都变了。再对正在前台的会话双击：同样出现输入框，Esc 后名字不变 | 生效 | 07-X2-rename-input |
| R2.1 | devflow 的 `change/general-skills`（手工 `git worktree add` 建在 `.devflow-tmp/worktrees/` 下）：行上标「外部」，下面写「没有会话」和「+ 新建会话」，悬停有「新建会话」和「⋯」 | 通过 | 01-chat-in-main |
| R2.4 | `new-api` 有 2 个会话时打开项目菜单：「从侧边栏移除」置灰，下面写「这个项目下还有会话，先结束会话才能移除」；用指针点这个置灰项，daemon 的项目清单和侧边栏都没变 | 通过 | 08-R2.4-remove-disabled |
| R2.3 | 把 `new-api` 的 2 个会话都删掉（确认框没有 worktree 那句话，焦点在「取消」）→ 一轮刷新后项目仍在、0 个会话 → 菜单里「从侧边栏移除」可用，点它 → 侧边栏和 `/api/v1/projects` 都没有它了；磁盘上 `.git`、`git worktree list`、分支 `dev` 原样。再经目录选择器在该目录开会话 → 项目重新出现 | 通过 | 08-R2.3-remove-enabled、08-R2.3-removed |
| R5.1 | `shop` 里经界面新建 worktree `r51`（终端会话），在其中提交 2 次（比 main 多 2 个提交）。悬停会话行点 ✕：确认框「会话会结束…」+「worktree r51 的目录和分支都会保留，之后可以在侧边栏继续使用，或者单独删除。」，焦点和默认按钮都是「取消」；按回车 → 对话框关闭、会话还在。再点 ✕ →「删除会话」：会话从 daemon 和侧边栏消失，`r51` 行写「没有会话」；磁盘：目录在、HEAD 仍是第 2 个提交、`refs/heads/r51` 没动、`main..r51` 仍是 2 | 通过 | 09-R5.1-delete-session-dialog、09-R5.1-after |
| R5.2 | `r52`：没有会话、`status` 为空、`main..r52` = 0。⋯ → 删除 worktree：确认框「工作区是干净的，分支上的提交都已包含在其他分支里。目录和分支都会删除。」，没有被忽略文件那句话，默认按钮「删除」。回车 → 目录没了、`git worktree list` 没有它、分支 `r52` 没了、行消失 | 通过 | 10-R5.2-clean-dialog、10-R5.2-after |
| R5.3 | `r53`：改 1 个已跟踪文件 + 2 个未跟踪文件（其中一个在子目录）。确认框标题「r53 里有还没提交的文件」，「有 3 个文件未提交或未跟踪。删除 worktree 会丢弃它们，无法恢复。」，另写明分支会一并删除；按钮是「仍然删除」（描边）和「取消」（实心、默认、有焦点），左下「回车 = 取消」。回车 / 点取消 / Esc 三种各试一次：目录、列表项、分支、3 个文件都原样。点「仍然删除」→ 目录和分支都没了 | 通过 | 10-R5.3-files-dialog |
| R5.4 | `r54`：只有 `node_modules/a.js`、`node_modules/b/c.js`、`.env`（`git status` 为空，`--ignored` 列出 3 个）。确认框是「干净」的那种（没有丢弃文件的警告、默认按钮「删除」），多一句「另有 3 个被 git 忽略的文件会一并删除。」。确认后目录（连同被忽略的文件）和分支都没了。R5.2 那次（0 个被忽略文件）没有这句话 | 通过 | 10-R5.4-ignored-dialog |
| R5.5 | `r55`：2 个提交不在别的分支上。确认框「r55 有 2 个未合并的提交」，两个选项「只删目录、保留分支」（预选）/「目录和分支都删」，默认按钮「删除」。直接回车 → 目录没了，分支 `r55` 还在且仍指向那 2 个提交。`r55b` 同样状态：用指针选「目录和分支都删」→ 默认按钮变成「取消」（带描边），回车 → 什么都没变；重新打开、选「都删」、点「删除」→ 目录和分支都没了（这是用户明确同意的） | 通过 | 10-R5.5-commits-dialog、10-R5.5-delete-both-chosen |
| R5.6 | `r56` 里一个终端会话 + 一个对话会话都在运行。确认框第一句「会先结束这 2 个会话。」，其余按干净处理。确认后：daemon 上两个会话都没了、我这台 daemon 的 tmux 里对应会话没了、侧边栏两行没了、主区域切到别的会话；目录、列表项、分支都没了 | 通过 | 11-R5.6-sessions-dialog、11-R5.6-after |
| R5.8 | 手工建三个 worktree：`ext/tool`（2 个未合并提交 + 2 个未跟踪文件）、`ext/clean`（1 个未合并提交）、`lookalike`（故意建在 `shop-worktrees/lookalike`、分支同名，长得和 vibe-remote 建的一样）。三行都标「外部」。`ext/tool`：文件警告 +「这个 worktree 不是由 vibe-remote 创建：只删目录，分支 ext/tool 保留。」，默认取消，回车什么都没变；「仍然删除」后目录没了、分支和它的 2 个提交还在。`ext/clean`、`lookalike`：没有保留 / 删除分支的选项，回车删除后目录没了、分支都还在（`git for-each-ref` 核对） | 通过 | 11-R5.8-external-rows、11-R5.8-external-dirty-dialog、11-R5.8-external-clean-dialog |
| R5.9 | `r59`（里面有 1 个运行中的终端会话和 1 个未跟踪文件）先 `git worktree lock --reason verifier`。⋯ → 删除 → 「仍然删除」：确认框重新出现，最上面一行「删除失败：this worktree is locked with git worktree lock (reason: verifier); unlock it first: git worktree unlock <路径>」。目录、列表项、分支、未跟踪文件都在；会话还在 daemon 和我这台 tmux 里、侧边栏行还在。Esc 后同样没变。再试一种：解锁后在它里面手工建一个嵌套 worktree `inner`（里面放一个没提交的文件）→ 同样被拒：「another worktree is inside this one: …/r59/inner (branch r59-inner); remove that one first」，什么都没变 | 通过 | 12-R5.9-locked、12-R5.9-nested |
| R5.11、R1.8 | 手工 `git worktree add --detach` 两个：`det`（之后在 detached HEAD 上提交 2 次）、`det0`（没有多出的提交）。侧边栏两行显示的是各自的短哈希（`c391eed`、`7712239`），标「外部」。删 `det`：标题「c391eed 有 2 个不属于任何分支的提交」，「这 2 个提交删除后不再属于任何分支，无法恢复。」，默认取消、「回车 = 取消」；回车后目录和 HEAD 原样；「仍然删除」后目录没了。删 `det0`：普通确认「工作区是干净的，没有不属于任何分支的提交。只删除目录。」 | 通过 | 12-R1.8-detached-rows、12-R5.11-detached-dialog |
| R5.12（目录删到一半） | `r512`：1 个运行中的会话、1 个未合并提交、被忽略目录 `node_modules/locked` 设成只读（真实的权限错误，不是假 git）。确认（回车 = 只删目录、保留分支）后出现单独的对话框「删除 r512 没有完成」：「删除失败：error: failed to delete '…/r512': Permission denied; git no longer lists this worktree, but part of its directory is left at …; the branch was not deleted」、「已结束 1 个会话。」、「git 已经不再登记这个 worktree，但目录没有删完，还剩一部分在 …/r512。分支没有删除。」，只有一个「关闭」。磁盘与它说的一致：目录还在（剩 `.git`、几个文件和那个只读目录）、`git worktree list` 没有它、分支 `r512` 仍指向那个提交、会话在 daemon 和 tmux 里都没了。关闭并等一轮刷新后那一行消失 | 通过 | 12-R5.12-partial-failure、12-R5.12-after-close |
| R5.12（git 删除失败、worktree 还在） | 重启 daemon 时把我自己的 git 包装放进它的 PATH（存在标记文件时 `worktree remove` 失败）。`r51`（1 个运行中的会话、2 个未合并提交）确认删除：确认框重新出现，「删除失败：fatal: simulated failure of worktree remove (verifier)」+「已结束 1 个会话。」+ 按最新状态重列（2 个未合并提交、仍预选保留分支）。磁盘：目录、列表项、分支和 2 个提交都在；会话确实已结束。去掉标记后在同一个确认框回车：目录没了、分支和提交还在 | 通过 | 14-R5.12-git-failure |
| R5.7 | 每个项目的主目录行（devflow、shop、untrusted 的 `main`）悬停后只有「新建会话」一个按钮，没有「⋯」；只有主目录的项目（new-api）的项目菜单里只有「从侧边栏移除」 | 通过 | 06-R1-sidebar、08-R2.4-remove-disabled |
| 补充：确认之后状态变了 | `tc1` 干净时打开确认框（写着「目录和分支都会删除」），随后在磁盘上往里提交 1 次，再回车：没有删除，确认框换成「状态刚刚发生了变化，请按最新的情况重新确认。」+ 1 个未合并提交 + 预选保留分支。再往里放 1 个未跟踪文件后回车：又一次「状态刚刚发生了变化」，这次是文件警告、默认取消；回车 = 取消。全程目录、分支、提交、文件都在 | 通过 | 14-changed-after-confirmation |
| 补充：vibe-remote 建的 worktree 被手工切了分支 | `sw1` 经界面新建后在里面 `git switch -c other-branch`。一轮刷新后那一行变成 `other-branch` 并标「外部」；删除确认框写「不是由 vibe-remote 创建：只删目录，分支 other-branch 保留」；删除后目录没了，`other-branch` 和 `sw1` 两个分支都在 | 通过 | — |
| R2.2 | `shop` 的会话全部经界面删掉后（还有 `main`、`r51`、`r59`、`r59-inner` 四个 worktree）：项目和四行都在，各写「没有会话」。退出并重新启动桌面端 → 仍在。停掉 daemon（机器行显示「离线」，项目行保留）→ 重新启动 daemon，8 秒后恢复「已连接」→ 仍在，`r51`、`r59` 仍不带「外部」（`/api/v1/projects` 里 `managed`），其余项目的终端会话都找回来了、名字（含「登录修复」）和顺序不变 | 通过 | 13-R2.2-no-sessions、13-R2.2-after-desktop-restart、13-daemon-down、13-R2.2-after-daemon-restart |
| R6.2 | 在没有会话的 `change/general-skills` 上新建会话，用指针勾选「续上次会话 (-c)」：没有出现说明，确认可点 | 通过 | 15-R6.2-no-note |
| R6.1 | 在已有 3 个会话的 devflow `main` 上新建会话，勾选 `-c`：选项正下方出现「这个目录已有会话正在用最近那段对话：对话界面会切到已有的那个会话，终端界面可能无法启动。不勾选即可开一段新对话。」，确认按钮仍可点；取消勾选后说明消失 | 通过 | 15-R6.1-note |
| R4.2 | 在 `…/devflow/.devflow-tmp/worktrees/general-skills`（隐藏目录下、目录选择器里看不到）那一行新建终端会话：终端里 `pwd` 是该目录，`git branch --show-current` 是 `change/general-skills` | 通过 | 15-R4.2-hidden-worktree-terminal |
| R4.3 | 信任文件里只有 devflow 主目录。同一行再新建会话：「对话」卡片可选、没有置灰原因；选中后创建，发一条消息有回复，标题「devflow / change/general-skills · general-skills 2」 | 通过 | 15-R4.3-chat-allowed、15-R4.3-chat-in-external-worktree |
| R4.4 | 仓库 `untrusted`（主目录和它的 worktree 都不在信任文件里）。它的 worktree 行上新建会话：「对话」置灰，原因「先用终端界面在项目主目录 /private/tmp/vrgc-hUz4Kt/a/untrusted 打开一次 claude，信任这个项目后才能用对话界面。」；用指针点置灰的卡片不会选中；「终端」可用，建出的终端会话在该 worktree 目录里 | 通过 | 15-R4.4-chat-greyed |
| R7.1 | 侧边栏可见 14 个会话。CDP 按键（`Input.dispatchKeyEvent`，rawKeyDown + keyUp，带 meta）：Cmd+3 → 第 3 个、Cmd+1 → 第 1 个、Cmd+9 → 第 9 个、Cmd+5 → 第 5 个（标题随之变）。折叠 devflow 后只剩 4 个可见，Cmd+9 → 不动 | 通过 | — |
| R7.2 | 在第 1 个上按 Cmd+Shift+[ → 第 14 个（最后一个）；再按 Cmd+Shift+] → 回到第 1 个 | 通过 | 16-X6-last-row-in-view |
| R7.3 | 用指针点进终端、敲了半行字后按 Cmd+Shift+]、Cmd+Shift+[、Cmd+2：照常切换，期间页面发往任何 PTY 的 `data` 帧为 0 个（我在 `WebSocket.prototype.send` 上记的）；切回来接着敲完回车，终端回显是完整的一行、没有多出字符。对话输入框里先打「草稿 draft」再按 Cmd+Shift+]、Cmd+Shift+[、Cmd+1：照常切换，回来后草稿原样、没有发出消息 | 通过 | — |
| R7.4 | 「在 main 新建会话」对话框开着时按 Cmd+2、Cmd+Shift+]；删除会话确认框开着时按 Cmd+4、Cmd+Shift+[：当前会话都没变，对话框都还在 | 通过 | — |
| R7.5 | 折叠 devflow 后从第 1 个连按 Cmd+Shift+]：1 → 2 → 3 → 4 → 1 → 2，没有停在 devflow 里的任何会话上 | 通过 | 16-R7.5-folded |
| X6 修复 | 14 个会话超出侧边栏高度。Cmd+Shift+[ 跳到最后一个：该行在侧边栏可见区内（行 753–800，列表 50–800）；Cmd+Shift+] 回第一个：同样可见 | 生效 | 16-X6-last-row-in-view |
| R3.9 | this-mac 机器概览点「创建隔离 Worktree」→ 目录选择器进 `shop`：出现同一个名字输入框和「基于 main @ 7712239，不包含未提交的改动」；名字为空时「在此打开」不可用；`a b`、`-x`、`a..b`、`main` 各自给出与 R3.3 / R3.4 相同的原因；`pick/er` → 目标目录 `…/shop-worktrees/pick-er`，确认后磁盘上分支 `pick/er`、目录 `pick-er` | 通过 | 17-R3.9-picker-worktree-mode |
| R9.1 | `old-mac`（从 `6d88e45` 构建，`/api/v1/info` 的 proto = 3）。机器行下常驻说明「vibe-remoted 版本较旧：不能新建或删除 worktree，没有会话的 worktree 不会列出。升级 vibe-remoted 后可用。」。经目录选择器开普通会话（终端可用、回显正常），对话框里有「这台机器的 vibe-remoted（dev，协议 3）比桌面端（协议 4）旧…」；选「创建隔离 Worktree」：没有名字输入框，说明仍是「Worktree 模式会从所选仓库创建一个隔离分支」，建出 `legacy-worktrees/<会话id>` + 分支 `vibe/<会话id>`。侧边栏：项目 `legacy` 下主目录行（只有「主目录」标签，没有分支名——design d39 已记录）和 `vibe/<id>` 行，会话各在其下；我手工建的没有会话的 worktree `quiet` 没有列出。项目行「新建 worktree」置灰，提示「需要升级这台机器的 vibe-remoted」，用指针点它不出对话框；worktree 菜单里「删除 worktree」置灰并带同一句话。删 Worktree 会话的确认框：「这台机器的 vibe-remoted 是旧版：工作区干净时，worktree 的目录和分支会被一并删除；有未提交改动时会保留。」——确认后磁盘上该 worktree 和 `vibe/<id>` 分支确实都没了（与文案一致） | 通过 | 17-R9.1-picker-old-daemon、17-R9.1-picker-worktree-mode-old、17-R9.1-sidebar-old、17-R9.1-menu-old、17-R9.1-delete-session-old |
| R1.7（通知）、R1.6 | 「登录修复」在本窗口打开过、当前在后台时，向 daemon 的 `/api/v1/events` 发 `waiting`：渲染进程日志 `[notify] fallback: this-mac · devflow / fix-login · 登录修复`（未签名构建走 Dock 降级，标题含机器名、项目、分支、会话名）；该行变成「终端 · 等你处理」+ 带光圈的黄点。折叠 devflow：项目行上出现同样的「等你处理」点；展开后仍在会话行上 | 通过 | 18-R1.7-waiting-dot、18-R1.6-folded-waiting |
| R8.4（目视） | 同一屏里三种点：实心绿（回合结束）、空心灰（有新消息）、带光圈的黄（等你处理），形状和颜色都不同，旁边第二行还有文字 | 分得清 | 18-R8.4-three-dots |
| R8.1 | 在 `shop` 主目录开对话会话，依次发 `md`、一句中文、`tool Read`、`tool Edit`。用户消息是右对齐的淡紫气泡，助手消息无气泡左对齐；Markdown 的标题 / 列表 / 表格 / 行内代码 / 代码块（带语言名和「复制」）正常，`<script>`、`<img onerror>`、`javascript:` 链接都按文字显示；工具块一行一个（状态点 + 工具名 + 参数，可展开），Edit 带红绿 diff；权限卡片在输入框位置：「要对 a.txt 做这项修改吗？」+ diff + 三个编号选项（第一项实心紫）+「Esc 中断」。用指针点「是」后回合继续（「done Edit」），输入框回来。与效果页画面 1 逐块对照，形态一致（没有点「复制」，免得改动系统剪贴板；它的行为由 gui-chat-smoke 的 R3.2 覆盖） | 通过 | 19-R8.1-chat-markdown、19-R8.1-chat-edit-permission、20-R8.1-chat-after-permission |
| R8.2 | 打开终端会话「登录修复」，输出带 ANSI 颜色、反显、框线字符、中文的几行并拖选一段。外壳（淡紫侧边栏、浮起的白色圆角卡片、标题「项目 / 分支 · 会话」、右上「已连接」）是新主题；终端底色白（`--term-bg` #FFFFFF）、前景深色、光标紫（#6B54D3）、选区淡紫（#D9D2F4）；红 / 绿 / 粗体蓝 / 反显、`┌─┐ 中文 ✓` 原样显示 | 通过 | 20-R8.2-terminal |
| R8.5 | 经主进程把**真实窗口**设成 800×500（不是视口模拟），中文、英文各走一遍（语言用指针点右上角按钮切换）：侧边栏；目录选择器（选了「对话」）；新建 worktree（一次带错误、一次 50 多个字符的名字，目标目录折成两行）；在 worktree 里新建会话（勾了 `-c`，说明在可见区内）；删除 worktree 最高的一种（文件警告 + 未合并提交 + 两个选项 + 目录 / 分支）；删除会话；对话输入框里敲 `/` 出斜杠菜单。每个对话框：整体在窗口内（上下各留 ≥16px）、没有横向溢出、只有正文滚动；底部每个按钮的中心点在窗口内且该点最上层就是这个按钮（`elementFromPoint`）。斜杠菜单在窗口内、在输入框上方不相交。逐张看了英文的侧边栏、新建 worktree、删除 worktree、斜杠菜单截图，没有文字重叠 | 通过（见备注 N3） | 21-R8.5-zh-1 … 8、21-R8.5-en-1 … 8 |
| R8.6 | 退出后冷启动，主进程用 `--inspect-brk` 停在第一条语句装记录器（我自己写的）：窗口构造完成后的第一个 `setImmediate`（约 +23 ms）起 `getBackgroundColor()` 就是 `#EFEFF4` 且窗口已可见；`ready-to-show` 时 `capturePage()` 的整帧已经是新主题（淡紫侧边栏 + 白卡片）；页面里 `--bg-app`、`html`、`body` 的底色都是 `#EFEFF4`。**证明到「窗口原生底色」和「第一次绘制完成的那一帧」为止**；两者之间约 0.1 秒屏幕上实际合成的像素没有取（要录屏，会录到用户的屏幕，没有做） | 通过（到上述程度） | 22-R8.6-first-painted-frame-b |
| X8 修复 | 用指针悬停 `tc1` 行、点「⋯」：菜单左上角 (242, 731)，就在按钮（左 242）下方。指针停在按钮上等了 11.5 秒（期间侧边栏重建多次），菜单位置一个像素没动、按钮仍显示；指针移到菜单项上再等一轮刷新，仍不动；点菜单项，确认框正常打开 | 生效 | 23-X8-menu-after-rebuild |
| X3 修复 | 只用键盘：焦点在 `tc1` 行的「⋯」上按回车 → 菜单打开且焦点在「删除 worktree」上；↓ 留在该项；Esc → 菜单关闭、焦点回到「⋯」；回车、回车 → 出现删除确认框（焦点在默认的「取消」）；Esc → 关闭，焦点回到「⋯」 | 生效 | 23-X3-more-focused、23-X3-keyboard-confirmation |
| R3.5 | 先在磁盘上建 `shop-worktrees/occupied/keep.txt`。名字填 `occupied`：「目录已存在：…/shop-worktrees/occupied」，确认不可用；在输入框里直接回车也一样，对话框留着。磁盘：目录里仍只有 `keep.txt`，没有分支 `occupied`，`git worktree list` 没有它 | 通过 | 27-R3.5-path-exists |
| R2.7 | 把仓库 `untrusted` 的目录改名挪走：一轮刷新后项目行显示「仓库目录不存在」，「新建 worktree」置灰，原有 2 个会话照常列在项目下；点开其中一个，终端照常能用。挪回去后一轮刷新恢复成 `main` / `change/general-skills` 两行（文字见备注 N4） | 通过 | 27-R2.7-read-failed |
| R2.5（rm -rf 的情况） | `pick-er`（里面有运行中的终端会话）的目录被我直接 `rm -rf`：一轮刷新后那一行消失，会话留在项目下、第二行写「目录已不存在」；`git worktree prune` 之后仍如此，会话可以正常删除 | 通过 | 24-worktree-dir-removed-by-hand |
| R4.5 | `fix-login` 下先有对话会话，再从行上新建一个终端会话（不勾 `-c`）：得到第二个独立会话（`fix-login`、`fix-login 2`），两个都能用（对话有回复、终端 `pwd` 正常） | 通过 | 06-R1-sidebar |
| R5.10 | 没有旧版桌面端可运行，改为按协议 3 桌面端的做法直接发帧：attach 带 `mode:"worktree"`、不带名字和 `newSessionId` → 建出 `vibe/<id>`；在里面提交 2 次；`DELETE /api/v1/sessions/{id}` → 204（不是 409）；目录、分支、2 个提交都在。之后它在新桌面端侧边栏里是一行不带「外部」的 `vibe/<id>`，从界面删除时给出保留 / 删除分支的选择，回车只删目录、分支保留 | 通过（接口层面） | 28-legacy-named-worktree-delete |
| 补充：确认框开着时别人在里面开了会话 | `tc1` 的确认框写「会先结束这 1 个会话」时，另一个客户端在 `tc1` 里新开一个会话；点「仍然删除」→ 没有删，换成「状态刚刚发生了变化…会先结束这 2 个会话」；两个会话都还在运行，目录、文件、分支都在 | 通过 | 26-session-appeared-after-confirmation |
| 补充：移除有多个 worktree 的项目再找回 | `shop` 的会话删光后「从侧边栏移除」：侧边栏和 daemon 清单里都没了，`git worktree list` 和全部分支一字不差；过一轮刷新也不回来。从目录选择器进 `shop-worktrees/tc1` 开会话：项目 `shop` 回来，`main`、`r59`、`tc1` 等各行都在，会话在 `tc1` 下，`r59`、`tc1` 仍是 vibe-remote 创建的（没有变成「外部」） | 通过 | 24-project-back-via-worktree |
| 补充：daemon 重启后重启对话会话 | daemon 重启后 `fix-login` 的对话会话显示「会话已结束：vibe-remoted 重启过」；点「重新启动」后发消息有回复，工作目录仍是该 worktree | 通过 | 24-chat-restarted-in-worktree |

### 只由脚本覆盖、没有亲手走的场景

R1.5（40 次刷新顺序不变；我只是在几十轮自然刷新里没看到顺序变过）、R2.6（白名单外的 worktree 不列出）、R3.8（git 创建失败不留半截）、R3.10（目标目录在白名单外）、R4.6（worktree 自身被信任）、R8.3（两份原有冒烟——我跑了，见「检查」）、R8.4 的对比度数值、R9.2（旧桌面端 + 新 daemon；R5.10 那一行顺带走了其中「旧式 Worktree 模式仍成功、自动命名 `vibe/<id>`」）。这些在 `gui-worktree-smoke.mjs` 这次运行里都是 PASS。

## 完成条件（界面部分）

| 条件 | 判断 | 依据 |
|------|------|------|
| R1–R9 的全部场景在 GUI 冒烟（CDP 驱动构建产物）里通过 | 成立 | `gui-worktree-smoke.mjs` 在本提交上 65 个用例全过（R1 8/8、R2 7/7、R3 10/10、R4 6/6、R5 12/12、R6 2/2、R7 5/5、R8 6/6、R9 2/2）。另外 58 个场景里我用真实指针和按键亲手走了 50 个（R5 的 12 个全部走了，R5.10 是接口层面），界面和磁盘都与 spec 的「那么」相符，没有发现脚本通过而实际不符的场景 |
| `gui-smoke.mjs` 和 `gui-chat-smoke.mjs` 以基线为准，用例数量不减少、断言不放宽 | 成立 | 两份在本提交上 46 / 0 和 29 / 0。与基线 `6d88e45` 比：`gui-chat-smoke.mjs` 没有任何改动（`git diff` 为空，`test(` 26 处）；`gui-smoke.mjs` +351 / −2，删掉的两行一行是写 daemon 配置（换成多带一个启动选项的写法）、一行是注释，`check(` 从 14 处增加到 30 处；它们用到的 `picker-layout.mjs`、`slash-menu-layout.mjs` 没有改动 |
| `make check` 通过 | 尚未验证（不在我的分工） | 由另一名验证者负责 |
| 协议在 `protocol.go` / `protocol.ts` / `docs/protocol.md` 三处一致 | 尚未验证（不在我的分工） | 同上。界面上看到的互连行为（协议 3 的 daemon 降级、协议 4 的五个端点）与文档描述一致 |

## 问题

没有发现要拦的问题：没有功能与 spec 不符、没有丢文件或丢提交、没有删错分支、三份冒烟没有失败。下面都是备注，都不拦。

- **N1 [低] 新建会话后侧边栏不会滚到新会话那一行。** 步骤：侧边栏里的行多到要滚动（我这里 14 个会话）时，从机器概览或项目行新建一个会话。实际：会话已打开、标题已变，但侧边栏停在原处，高亮的新行在可见区之外。X6 修的是快捷键切换那条路。截图 `06-R1-sidebar`（打开的是 notes，它的行不在视野里）、`19-R8.1-chat-edit-permission`。spec 没有对应条目。
- **N2 [低] 删除失败的原因是英文。** R5.9 / R5.12 里 daemon 给的原因（`this worktree is locked with git worktree lock…`、`another worktree is inside this one…`、`git no longer lists this worktree, but…`）原样夹在中文界面里；效果页画面 7 画的是中文句子，还有一行「什么都没改动：…」和「现在的状态」小表。design 第 7 节写明了 daemon 的 `message` 用英文、桌面端原样显示；原因和处理办法（`git worktree unlock <路径>`）都看得到，R5.12 那种另有一段中文说明剩下了什么。截图 `12-R5.9-locked`、`12-R5.12-partial-failure`。
- **N3 [低] 英文界面下「Terminal · New messages」被截成「New messa…」。** 默认宽度（284px）的侧边栏里，后台终端会话第二行的状态文字带省略号，同一位置的「Turn finished」不截。没有重叠。截图 `21-R8.5-en-1-sidebar`。
- **N4 [低] 仓库目录不存在时项目行没有「读取失败」这几个字。** spec R2.7 和效果页画面 3 写的是「读取失败」及原因；实际显示「仓库目录不存在」（其它 git 失败才是「读取失败：<原因>」）。design 7.4 的文案表就是这样定的，用户看得懂。截图 `27-R2.7-read-failed`。
- **N5 [低] 与效果页的两处外观差别。** (1) 删除确认框的「会先结束这 N 个会话」只有数量，效果页画面 6(e)、7 还列出了每个会话的名字和类型（spec R5.6 只要求写明会先结束这 2 个会话）；(2) 终端会话的卡片底部没有效果页画面 2 那一行「机器 · 路径 / 终端 · tmux 保活」（对话会话底部有机器和路径）。测试报告说有 5 处已记录的外观差异，我没有找到那份清单，没法核对这两处在不在其中。截图 `11-R5.6-sessions-dialog`、`20-R8.2-terminal`。
- **N6 [低] 失败说明框背后的画面。** R5.12 的说明框开着时，主区域还停在刚被结束的那个会话上，标题退化成「this-mac · 8a2f03」并显示「连接已断开，正在重连…」；关掉说明框后恢复正常。截图 `12-R5.12-partial-failure`。
- **N7 [提示] 「保留分支」之后界面里接不回去。** 确认框写「提交还在分支 … 上，以后可以再检出」，但本次没有「为已有分支建 worktree」的入口（spec 明确推迟），再用同名新建会得到「分支已存在」，用户得自己在终端里 `git worktree add`。属于范围内的取舍，写在这里是因为真用的时候第一下就会碰到。
- 测试报告里未修的 X1、X4 我都遇到了（新建会话时其它后台终端全亮「有新消息」；删除带会话的 worktree 后状态栏的「会话已退出（代码 -1）」），与报告描述一致，按要求不重复报。X2、X3、X6、X8 的修复在真实窗口里都生效（见场景表）。

## 待验证项

- **真实键盘**：R7 我用的是 CDP 按键，没有经过 macOS 菜单分发和输入法（不允许向系统前台发按键）。要人在打包后的 app 里按一遍，步骤见 test-report.md「未覆盖和遗留」。
- **冷启动首帧之前的约 0.1 秒**：只证明到窗口原生底色和第一次绘制完成的整帧，两者之间屏幕上实际合成的像素要录屏才能看。
- **原生通知**：未签名构建走 Dock 降级，我核对的是应用发出的通知标题，没有真的通知可点。
- **真正的旧版桌面端**：R5.10 / R9.2 我是按协议 3 的帧直接发的，没有运行基准提交的桌面端。
- **真实 claude 和远程 Linux**：全部是本机的临时 daemon、`/bin/bash`、假 claude、git 2.50.1、tmux 3.6a。
- R8.4 的对比度数值、`make check`、协议三处一致：不在我的分工。

## 放松检查

无。`gui-chat-smoke.mjs` 相对基线没有改动；`gui-smoke.mjs` 只增不减（删掉的两行见上表）。一点覆盖面上的说明（不是放松）：`gui-worktree-smoke.mjs` 的大多数用例用 DOM 的 `click()`，看不到悬停、遮挡和真实双击（它自己的说明里写了）；我这一轮全部用真实指针重走，没有发现因此被漏掉的问题。

# 第 2 轮（提交 482ab63）

（2026-11-20 归档：关口 C 用户放行之后先改四处（T29–T32），派下一轮验证者之前把这一轮的结论原样追加在这里。下面是当时 `verdict.md` 的全文，除上面这个一级标题外一字未改；其中的 N-1、N-2 即返工 T29、T30 的来源。验证者的实验源码在 `evidence/verdict-2/`。）

> 机器关口 C 第 2 轮（返工复验），2026-11-20，被测提交 `482ab63`。本轮先派的验证者是 codex（另一个模型），它的运行约 4 分钟后被其平台的内容安全过滤中止，没有产出结论；按 `verify.models` 的顺序退到同一模型的全新验证者，下面是它的结论全文。第 1 轮（提交 `91e0fab`，不通过）的两份结论在 `verdict-history.md`。验证者的实验源码和完整输出不在仓库里，位于本机 `.devflow-tmp/gate-c2/same-evidence/`。

# 关口 C 第 2 轮独立验证结论（同模型的全新验证者）

- 结论：**通过，有备注**。第 1 轮的 7 个问题和 2 条测试备注，原反例原样重跑全部不再出现；全部检查通过；三份界面冒烟在最终代码上首次运行即全过。新发现 5 条（N-1 – N-5），都发生在很少见的环境或输入下，按本轮给定的标准（用户会遇到的才拦）都不拦，但 N-1、N-2 我认为风险被低估，建议合并前处理或交用户决定——见「问题」。
- 提交：482ab63df9ec109e0f991834b5e267cd118ffbfb
- 验证快照：{"schema":1,"docs_dir":"docs/changes","head":"482ab63df9ec109e0f991834b5e267cd118ffbfb","head_tree":"81f7194080ef794484d8e6eefa77c0cef647e44dbaa60bb506c272aabcd6ed80","target":"6d88e45f511b92b84d46bca1ffd917afae548221","target_tree":"b58c4926876d6dca94d03f0e017504a74b2a24ec80eff298d3a5f37737ec1751"}
- 验证者：Claude（Fable 5，模型 id `claude-fable-5-2[1m]`），独立验证者，没有写过这段代码，没有派发子 agent。codex 本轮不可用（运行被其平台的内容安全过滤中止，没有产出结论），按 verify.models 的顺序退到同一模型的全新验证者。
- 问题数量：5 条新发现（0 条拦；2 条建议合并前处理），另有 2 条说明。

## 环境版本

开始时（`/Users/mac/github/vibe-remote/.devflow-tmp/verify-482ab63`）：

```
$ git rev-parse HEAD
482ab63df9ec109e0f991834b5e267cd118ffbfb
$ git status --short
（空）
$ git diff --stat 91e0fab..HEAD -- desktop .claude
（空：桌面端和 .claude 自第 1 轮的提交起没有改动）
```

结束时（停掉我启动的全部进程、删掉临时目录和两个临时 worktree 之后）：

```
$ git rev-parse HEAD
482ab63df9ec109e0f991834b5e267cd118ffbfb
$ git status --short
（空）
$ git diff --name-only; git diff --cached --name-only
（空）
$ git status --short --ignored | grep -v node_modules
!! desktop/dist/        ← 界面冒烟的构建产物（被忽略）
```

工具：go 1.26.2 darwin/arm64、node v22.22.2、git 2.50.1 (Apple Git-155)、tmux 3.6a。

运行的都是这个提交：检查和脚本在上述 worktree 里运行，脚本各自从它构建临时 daemon、假 claude 和桌面端；我自己的 Go 实验在 `git worktree add --detach /tmp/vr-v2c-*/wt 482ab63` 的副本里（只新增测试文件，没有改产品代码），daemon 实测的二进制是从上述 worktree `go build` 到 `/tmp` 的（脚本打印 `daemon built from 482ab63…`）。对照用的 `91e0fab` 副本同样是临时 worktree。

安全约束：没有访问 8765；没有对默认 tmux socket 目录执行任何命令；所有用到 tmux 的命令都带独立的 `TMUX_TMPDIR`；临时 daemon 的 `allowed_roots` 只有我在 `/tmp` 下建的目录；没有向不是我启动的进程发信号；token 没有进入任何输出或文件。结束时 `ps` 里只剩用户自己的 tmux（1401、5607、85201）和用户的 daemon；我建的 `/tmp/vr-v2*` 目录、两个临时 worktree 都已删除（`git worktree list` 里没有它们）。`/tmp/vr-api-*`、`/tmp/vr-codex-*`、`/tmp/vr-diff-copy` 是第 1 轮留下的，只读过、没有动。

证据：实验源码和各条命令的完整输出在 `/Users/mac/github/vibe-remote/.devflow-tmp/gate-c2/same-evidence/`（不在仓库里；已扫描过，没有 token）。

## 检查

每条都在最终代码上由我重跑，一个一个跑。

| 命令 | 结果 |
|------|------|
| `cd vibe-remoted && gofmt -l .` | 退出 0，无输出 |
| `cd vibe-remoted && go vet ./...` | 退出 0，无输出 |
| `cd vibe-remoted && TMUX_TMPDIR=$(mktemp -d /tmp/vr-v2-XXXXXX) go test -race -count=1 -timeout 25m ./...` | 退出 0。五行 `ok`：`internal/chat` 18.7 s、`config` 3.1 s、`protocol` 2.7 s、`server` 63.4 s、`session` 316.6 s |
| `cd desktop && npm run typecheck` | 退出 0 |
| `cd desktop && npm test` | 退出 0；311 行 `ok`，0 行 `not ok` |
| `.devflow.yml` 的 18 条命令型 `check`，原样交给 zsh，前面加 `GOFLAGS=-count=1` | 18 条都退出 0，没有一行 `(cached)`。第 13 条的 `./internal/server` 是 `[no tests to run]`（那几个用例都在 session 包，与第 1 轮相同）。71 个用例名逐个在源码里核对过，都存在 |
| `/protocol-sync`（第 2 条） | `protocol.go`、`protocol.ts`、`rest.ts` 自 91e0fab 起无改动（`git diff --stat` 为空），字段沿用第 1 轮逐项核对的结果。返工改的三处说明对着处理代码和临时 daemon 的实际应答核对：预检的 400（三种 `message` 与 `handleWorktreePlan` 逐字相同，实测见下）、删除的 409（`RemoveWorktree` 重读列表项，比较 `Head` / `Branch` / `Detached` 三样）、删除的 500（`endSessionConfirmed` 没确认结束 → `endedSessions` 只含已确认的、其后的会话不再结束；重读不到 → 500）都与代码一致。一处边角不一致见 N-5 |
| `node .claude/skills/verify/scripts/ws-worktree-smoke.mjs` | 退出 0，9 PASS / 0 FAIL |
| `node .claude/skills/verify/scripts/ws-chat-smoke.mjs` | 退出 0，9 PASS / 0 FAIL |
| `ws-smoke.mjs`（对我自建的临时 daemon：随机端口、`/bin/bash`、独立 `state_dir` 和 tmux 目录、`allowed_roots` 只有自建目录） | 退出 0，12 PASS / 0 FAIL |
| `TMUX_TMPDIR=… node …/gui-smoke.mjs` | 第 1 次：46 PASS / 0 FAIL，退出 0 |
| `TMUX_TMPDIR=… node …/gui-chat-smoke.mjs` | 第 1 次：29 PASS / 0 FAIL，退出 0 |
| `node …/gui-worktree-smoke.mjs`（完整构建） | 第 1 次：68 行 PASS / 0 FAIL，`65 cases: R1 8/8, R2 7/7, R3 10/10, R4 6/6, R5 12/12, R6 2/2, R7 5/5, R8 6/6, R9 2/2, other 7/7`，退出 0 |

三份界面冒烟都没有失败用例，所以没有重跑。

额外跑的一次（不在要求里，为了列出跳过的用例）：`go test -count=1 -v`（**不带 `-race`**）跑五个包，839 行 PASS、**0 个 SKIP**（本机上 c6 和 `TestGitTimeoutKillsProcess` 都执行了断言），但 `TestProjectStoreRemoveWorktreeIfSame` 失败。这是 tasks.md「后续」里记过两次的已知偶发（先删再加同一条记录，两次时间戳落在同一微秒）；返工没有动这个文件。单独重跑 200 次：不带 `-race` 失败 33 次，带 `-race` 失败 0 次。`make check` 用的是 `-race`，所以要求的检查是通过的；见「问题」的说明 1。

## 第 1 轮问题的复验

做法：把第 1 轮验证者留在 `/tmp/vr-codex-tmux-n588mgcz/…/codex_probe_test.go`（tmux 的四个反例、同提交切分支）和 `/tmp/vr-diff-copy/…/independent_diff_test.go`（撤销删掉别人的 worktree、换行路径）的反例**一个字不改**复制进 482ab63 的临时副本（辅助函数和测试钩子的名字都还在，直接能编译），独立 `TMUX_TMPDIR` 下运行：

`TMPDIR=/tmp TMUX_TMPDIR=<独立目录> go test -count=1 -timeout 5m -v ./internal/session -run '^(TestCodex|TestIndependent)'` → 退出 0，全部 PASS（在 91e0fab 上它们是 FAIL）。P7 用临时 daemon 实测。每条再读开发方加的回归用例，看它守的是不是同一个缺陷。

| 问题 | 重跑的反例和实际输出 | 开发方的回归用例 | 结论 |
|------|----------------------|------------------|------|
| P1（X9）撤销删掉别人的 worktree | 同分支：`external file data="someone else's work" read_error=<nil>; branch=<oid>`，message 带 `directory … not removed: git lists a worktree in it, and this create, whose own git worktree add did not go through, cannot take it for its own; branch fix-login kept: the worktree in … is on it`。detached 同提交：文件同样还在 | `TestUndoLeavesAWorktreeSomeoneElseAddedAtTheSamePath`（同分支、detached 同提交、建分支之前被占三例，另用记录参数的 git 断言没有执行过 `worktree remove`）、`TestUndoAfterWorktreeAddFailedOnItsOwn`：同一时序、同一断言，还多守了一条同类路径 | 已解决 |
| P2（X10）结束会话失败仍删目录、假报已结束 | `result={Removed:false … EndedSessions:[]} error=*session.WorktreeRemoveError could not end session …: tmux kill-session failed (exit status 1), and tmux could not be read … The worktree was not removed directoryExists=true`；SIGUSR1 后 `tmux session alive=true; reported ended=[]` | `TestRemoveWorktreeStopsWhenASessionDidNotEnd`（同一反例，另验证 socket 恢复后同一请求成功）、`TestRemoveWorktreeConfirmsSessionsAgainstTmux`（读失败、仍在列表两例） | 已解决 |
| P3（X11）工作目录里的换行 / 制表符使会话漏掉或错位 | 两例都是 `parsedSessionCount=1 ok=true`、`status.sessions=[<id>]`、`removal={Removed:true … EndedSessions:[<id>]} tmuxAlive=false` | `TestSessionWhoseProcessIsInAnOddlyNamedDirectoryIsStillRead`（5 种名字 × 重启前后）、`TestSessionCreatedInAnOddlyNamedDirectoryIsStillRead`、`TestTmuxReadFailsWhenARecordDoesNotParse` | 已解决（UTF-8 环境下；非 UTF-8 的 locale 见 N-4） |
| P4（X12）socket 路径里有 `no sessions` | `liveTmux count=0 ok=false`；`removal={Removed:false … EndedSessions:[]} error=could not read the running sessions from tmux … directoryExists=true sessionAlive=true` | `TestIsNoTmuxServerGoesByTheWholeLine`、`TestSocketPathSayingNoSessionsIsNotAnEmptySet`（同一反例） | 报告的反例已解决；同一判断方式留下一个更偏的变体，见 N-3 |
| P5（X13）结束会话期间切到同提交的分支 / detach | other、detached 两例都是 `error=*session.WorktreeChangedError … dir=true originalBranch=<oid>` | `TestRemoveBranchSwitchedWhileEndingSessions`（同两例，另断言 `endedSessions` 如实、应答里的状态是切换后的） | 已解决 |
| P6（X14）路径带换行的 worktree 列不出来 | `list=[… {Path:…/external\nworktree …}]`、`WorktreeStatus=<nil>` | `TestListWorktreesPathWithNewline`（6 种名字，含在里面开会话、删除）、`TestListWorktreesFallsBackWithoutZ`、`TestParseWorktreeList` | 认 `-z` 的 git（2.36 起）上已解决。退回模式（更早的 git）是已记录的已知限制，但实际表现比记录的更差，见 N-1 |
| P7（X15）不存在的白名单内目录报成越权 | 临时 daemon：`missing, in the allowed root: 400 {"error":"invalid_request","message":"workdir does not exist"}`；文件 → 400 `workdir is not a directory`；白名单外（存在 / 不存在 / 经 `..`）、悬空链接、指向白名单外的链接（目标存在 / 不存在）→ 全是 403；无 token → 401 | `TestPlanMissingWorkdirIs400`（同一探测，另守「白名单外不回答存在与否」） | 已解决（一处边角见 N-5） |
| 备注 1：`TestGitTimeoutKillsProcess` 每次都 SKIP | `go test -race -v`：PASS，没有 SKIP；`-race -count=5`：5 次 PASS。用例里原来的 `t.Skip` 换成了 `t.Fatal` | — | 已解决 |
| 备注 2：c6 的跳过条件比「git < 2.31」宽 | 探测改成 `git config --get --default not-read vibe.inherited`，命令失败或输出别的都是 `t.Fatalf`；本机两个子用例 PASS、没有 SKIP | — | 已解决（这个跳过本身留不留仍是用户的 c6） |

我没有只看开发方的用例：每条都另外做了自己的反例（下面「问题」和「排除了的」）。

## 场景

受返工影响的场景：

| 场景 | 怎么验证的 | 结果 |
|------|-----------|------|
| R2.1（列出全部 worktree，含外部的）、R4.2（在任何已有 worktree 里开会话） | GUI：`PASS R2.1 …`、`PASS R4.2 …`；路径带换行 / 制表符 / 引号 / 反斜线的 worktree：第 1 轮反例 + 全量 Go 里的 `TestListWorktreesPathWithNewline`；临时 daemon 上 `/api/v1/projects` 列出 `…/trusted-worktrees/a\nfoo`、`worktrees/status` 200 | 通过（git ≥ 2.36；更早的 git 见 N-1） |
| R2 其余（R2.2–R2.7） | GUI 7/7 | 通过 |
| R3.5（目标目录已存在：不创建、不覆盖） | GUI：`PASS R3.5 … 目录已存在：…/occupied`；P1 的两个反例（创建途中目录被别人占走）不再删对方的文件 | 通过 |
| R3.8（创建失败：显示 git 的错误，不留半截，不出现新行） | GUI：`PASS R3.8 git fails while creating …`（`.git/worktrees` 不可写）；我的实验：smudge 过滤器失败 → 目录、登记、分支都没有留下，可以再建 | 通过；post-checkout 钩子失败这一种会留下一个 worktree（d70，已记录），见 N-2 |
| R5.6（先结束会话再删）、R5.12（部分失败如实报告） | GUI：`PASS R5.6 … both ended, their views closed, worktree removed`、`PASS R5.12 …`；P2 / P3 / P4 的反例；我的负载实验：24 个满载进程下 25 轮「2 个会话的 worktree、最后一个会话结束时 tmux server 退出」，0 轮失败，最慢一次 1.8 s（期间日志里有 23 次 `server exited unexpectedly`，都被重读接住） | 通过 |
| R5.9（动手前的拒绝）及「确认后变了就 409」 | GUI：`PASS R5.9 …`；P5 的两个反例；我的 4 个变体：新建同提交的分支、分支被改名、分支引用被外部移动 → 都是 409，目录在；切走又切回同一分支（没有变化）→ 照常删除，没有误报 | 通过 |
| R5 其余 | GUI 12/12 | 通过 |
| R9.2（旧桌面端 + 新 daemon） | GUI：`PASS R9.2 … ws-smoke.mjs of 6d88e45: 12 PASS, 0 FAIL; worktree mode without a name → vibe/<id>`；全量 Go 里的 `TestV3ClientFlowAgainstV4Daemon`；invariant 第 3 条 `TestTerminalFramesUnchangedV3`；读 tmux 的格式串是 daemon 每次读取时自己给的（`-F`），不存在 tmux 里，升级前已在运行的会话照常读到（`ws-worktree-smoke` 的「a terminal session from before the upgrade is counted and ended」PASS、第 1 轮的旧会话反例 PASS） | 通过 |

其余场景（R1、R3 其余、R4 其余、R6、R7、R8、R9.1）：桌面端代码自 91e0fab 起没有改动，沿用第 1 轮界面验证者的结论（通过，有备注 N1–N7；58 个场景里 50 个用真实指针和按键亲手走过）；daemon 改了，所以三份界面冒烟在最终代码上由我重跑了一遍：65 个用例全过（R1 8/8、R3 10/10、R4 6/6、R6 2/2、R7 5/5、R8 6/6、R9 2/2）。这一轮我没有用真实指针重走界面。

## 完成条件

| 条件 | 判断 | 依据 |
|------|------|------|
| R1–R9 的全部场景在 GUI 冒烟里通过 | 成立 | `gui-worktree-smoke.mjs` 在 482ab63 上 65 个用例全过 |
| `make check` 通过 | 成立 | `make check` 的五条命令（gofmt、vet、`go test -race -count=1 ./...`、typecheck、`npm test`）逐条运行，都退出 0（没有调用 `make` 本身，Makefile 里就是这五条） |
| `gui-smoke.mjs`、`gui-chat-smoke.mjs` 用例数量不减少、断言不放宽 | 成立 | 两份脚本自 91e0fab 起没有改动；第 1 轮已与基线逐行比过（`check(` 14 → 30，`test(` 26 → 26，旧断言都在）；本轮运行 46 / 0、29 / 0 |
| 协议在 `protocol.go` / `protocol.ts` / `docs/protocol.md` 三处一致 | 成立 | 见「检查」的 `/protocol-sync` 一行；P7 指出的那处不一致已改并实测。N-5 是文档没写到的一个边角，不影响这条的判断 |

## 问题

5 条新发现，都有自己运行出来的证据。按本轮的标准（用户会遇到的才拦）**都不拦**。要说明的是：第 1 轮验证者对触发条件同样少见的 P4（目录名里有 `no sessions`）、P6（路径带换行）判了拦，按那个标准 N-1 和 N-3 也会被拦；我的判断依据写在每条里，由关口和用户取舍。

### N-1 [一般，不拦，建议合并前改] 旧 git 的退回模式下，路径带换行的 worktree 不是「列不出来」，而是被读成另一个路径上的一项，那个目录会通过对话界面的信任规则

- 位置：`vibe-remoted/internal/session/worktree.go` 的 `parseWorktreeList`（按行解析时不认识的行直接跳过）；说法在 CLAUDE.md「项目与 worktree」第一段、decisions #146、design 第 10 节、tasks.md「后续」的「已知限制（X14）」。
- 这些地方写的是：按行读时，路径被拆成的两半「一个没有 HEAD、一个路径不是绝对路径」，都被去掉。这只对第二半以 `worktree` 开头的名字成立——回归用例 `TestParseWorktreeList` 只测了第 1 轮反例用的那一个名字 `external\nworktree`。
- 实验（`same-evidence/v2_probe_test.go` 的 `TestV2FallbackNewlinePath`；git 用一个对 `worktree list … -z` 回答 129、其余原样转给真 git 的包装脚本，即模拟 2.36 之前的 git；另在临时 daemon 上经 REST 重做，`same-evidence/daemon-probe.txt`）：
  - worktree 建在 `…/devflow-worktrees/a\nfoo`，旁边另有一个普通目录 `…/devflow-worktrees/a`（不是 worktree，里面放了一个指向该仓库管理目录的 `.git` 文件——目录的主人自己就能写，design V4）。只有主目录被信任。
  - 认 `-z` 的 git：列表是主目录和 `…/a\nfoo`；`ChatTrust(…/a) = untrusted`；`worktrees/status` 对 `…/a` 是 404。
  - 退回模式：列表是主目录和 **`…/a`（branch=nl）**；`ChatTrust(…/a) = trusted`；`GET /api/v1/fs?path=…/a` 返回 `chatTrust: "trusted"`；`/api/v1/projects` 里它是一行；`worktrees/status` 200（`dirtyFiles: 2`）；真正的 worktree `…/a\nfoo` 是 404。
  - 第二种名字 `…/a\nworktree /别处/evil`（换行后面接一个绝对路径）：退回模式下列表里出现的是 **`/别处/evil`**——任意一个绝对路径；`ChatTrust` 同样是 `trusted`。
  - 删除没有造成损失：对伪造的那一项 `RemoveWorktree` 得到 git 的 `'…' is not a working tree`，目录里的文件还在。
- 应有的结果：`.devflow.yml` 的规则「对话界面的信任只认目录本身，或仓库自己列出的 worktree 根」；文档自己写的「不当成 worktree」。
- 为什么不拦：要触发得同时有 2.36 之前的 git（Ubuntu 22.04 自带的 2.34 属于这一类）和一个路径里带换行的 worktree 登记在**已被信任的**仓库里。能往受信任仓库的 `.git/worktrees` 里写登记的人，本来就能在任意目录建一个真正的 worktree 并放上自己的 `.claude/settings.json`，所以它没有让谁多得到什么权限；普通用户碰不到。91e0fab 上任何版本的 git 都是这样，返工把 2.36 及以后的修好了。
- 为什么说风险被低估：这是一条写进 `.devflow.yml` 的安全规则的反例，而文档和决策记录把它写成了已经挡住。改法很小（按行读时，一个条目里出现不认识的行，或 `worktree` 行前面不是空行，就把相邻的条目都丢掉），至少要把文档改成实际的行为。

### N-2 [一般，不拦（已记录的已知限制 d70），建议交用户决定] post-checkout 钩子失败时，「创建失败」会留下一个 worktree；项目不在侧边栏时它在界面里看不见

- 临时 daemon 实测（`daemon-probe.txt`）：仓库的 post-checkout 钩子 `exit 2`（内容照 git-lfs 的钩子在找不到 `git-lfs` 时的写法）。新建命名 worktree `fix-login`：
  - 应答：`{"type":"error","code":"create_failed","fatal":true,"message":"… exit status 2: … git-lfs was not found on your path; cleanup: directory …/hooked-worktrees/fix-login not removed: git lists a worktree in it, and this create, whose own git worktree add did not go through, cannot take it for its own"}`。
  - 磁盘：目录在（`.git`、`README`），`git worktree list` 里是 detached 的一项，分支 `fix-login` 没有留下。没有会话。
  - 同名再建：预检 `{"ok":false,"error":"worktree_path_exists"}`，attach 是 fatal `worktree_path_exists`（带同一个 `newSessionId` 重放也是）。换一个名字 `second`：再留下一个。
  - 这个仓库此前没有开过会话时，`GET /api/v1/projects` 里**没有这个项目**（实测 `projects: []`）——从机器概览的「创建隔离 Worktree」走到这里，残留在侧边栏里看不见，同名重试只会看到「目录已存在」。项目已在侧边栏时，它是一行「外部」的 detached worktree（与 R3.8「侧边栏不出现新行」的字面不符）。
  - 能从接口删掉：`worktrees/status` 200（`detached:true, managed:false, dirtyFiles:0`），`worktrees/remove` 200，目录和登记都没了；钩子修好后同名能建。没有「同名永远建不了」的路径。
- 对照：91e0fab 上同一个实验，两次尝试都是 `dir exists=false listed=false branch=""`（撤销得干干净净）。这是返工为了 P1（不删别人的 worktree）换来的代价，decisions d70 和 tasks.md「后续」都记了。
- 为什么说风险被低估：d70 把风险定为「低」，理由之一是「在侧边栏里看得见、删得掉」——项目不在侧边栏时看不见。会遇到的仓库不算少：装了 git-lfs 钩子、而 daemon 的 PATH 里没有 `git-lfs`（launchd / systemd 启动、不经登录 shell）；husky 之类的钩子要 node，而 node 由 fnm / nvm 管理。这类仓库里每点一次「新建 worktree」都失败并多一个残留。开发方自己写了更好的做法（运行 add 之前记下 `<git 公共目录>/worktrees/` 里已有的登记，只认领新出现的那一个）。它改变了 R3.8 在这一类失败下的结果，建议像 c6、c7 那样让用户知情后决定。

### N-3 [低，不拦] `TMUX_TMPDIR` 的目录名里有换行、其中一行正好是 `no sessions` 时，P4 原样重现

- `isNoTmuxServer` 从「整段里找子串」改成了「逐行比较」，而 socket 路径可以带换行。实验（`TestV2NoSessionsLineFromPath`，目录 `/tmp/vr-a\nno sessions\nb-<随机>`，其余与第 1 轮 P4 的反例相同）：
  `tmux says: "error connecting to /private/tmp/vr-a\nno sessions\nb-…/tmux-501/vibe-remote (No such file or directory)\n"` → `liveTmux count=0 ok=true` → `removal={Removed:true … EndedSessions:[]} error=<nil> directoryExists=false sessionAlive=true`。
- 应有：第 ④ 种（对账失败），500、什么都不动。
- 不拦的理由：`TMUX_TMPDIR` 是启动 daemon 的人自己设的，没有人会在里面放换行。改法：只看 stderr 的**开头**（`error connecting to …` 永远以这几个词开头，后面的路径再怎么写也骗不过），或者 socket 文件不存在时不认第 ② 种。

### N-4 [一般，不拦] daemon 继承了非 UTF-8 的 locale 时，非 ASCII 路径下的会话在 daemon 重启后不算在它的 worktree 里

- tmux 3.6a 在客户端 locale 不是 UTF-8 时，把 `list-sessions` 输出里的非 ASCII 字节、制表符、换行都改写成 `_`（实测：`…/中文 dir` → `…/____ dir`，`tab\tx` → `tab_x`）。`utf8Env` 只在三个 locale 变量都没设时才补 UTF-8，继承来的 `LC_ALL=C` 原样保留。
- 实验（`TestV2InheritedCLocale`，`LC_ALL=C`，仓库在 `…/项目/devflow`）：重启后的 daemon 读到 `home:…/____/devflow-worktrees/feat`，`status.sessions=[]`，`removal={Removed:true … EndedSessions:[]} directoryExists=false tmuxSessionAlive=true`——P3 的后果，换了一个触发条件。纯 ASCII 路径在同样的 locale 下正常。
- 不是返工引入的：同一个实验在 91e0fab 上，ASCII 路径也一样坏（格式串里的制表符被改写，每一行都解析不了）。返工反而修好了 ASCII 的那一半。
- 不拦的理由：这种 locale 下终端里的框线和中文本来就被 tmux 改成 `_`（`utf8Env` 的注释写了），产品的主要功能看得见地是坏的，用户会先去改 locale。`.devflow.yml` 那句「目录名里的制表符和换行不改变读到的归属」只在 UTF-8 环境下成立，没有写这个前提。改法：读 tmux 时加 `-u`（实测 `LC_ALL=C tmux -u … list-sessions` 原样给出 `…/项目`）。

### N-5 [低，不拦] 预检对「路径中间是一个文件」回答 403「不在白名单内」

- `GET /api/v1/worktrees/plan?workdir=<白名单内>/afile/x`（`afile` 是普通文件）→ `403 {"error":"path not in allowed roots"}`。`EvalSymlinks` 给的是 ENOTDIR，不是「不存在」，所以没走新加的 400。docs/protocol.md 写的是不存在 → 400、不在白名单内 → 403，这一种哪边都没写到。目录选择器选不出这样的路径。

### 说明（不是新问题）

1. `TestProjectStoreRemoveWorktreeIfSame` 不带 `-race` 时 200 次失败 33 次（带 `-race` 0 次）。tasks.md 把它记成「机器负载高时各出现过一次」的偶发，实际频率高得多，只是 `make check` 一直带 `-race`。它同时说明 `RemoveWorktreeIfSame` 靠微秒时间戳区分新旧记录不严格（后果是创建记录被多删一次、worktree 变成「外部」，方向安全）。已在「后续」里，建议提前做。
2. 我没有用真正的旧 git 重做 N-1：2.36 之前的 git 是用包装脚本模拟的（只把 `-z` 变成 129，按行的输出来自 git 2.50.1，路径原样带换行——与第 1 轮 P6 的实际输出一致）。开发方在 2.30.2 和 2.34.1 上实测过退回本身。

### 排除了的（做了实验，没有问题）

- tmux 的随机标记（d69）：标记由 `crypto/rand` 的 8 字节生成，每次读取不同；格式串每次由 daemon 经 `-F` 给出，不存在 tmux 里。真实 tmux 上，用户选项和当前目录里的制表符、换行、中文、`ESC`、`\r`、`<vr-0123456789abcdef>` 和 `<vr-…-end>\n` 样子的内容、`#{session_name}`、`#(touch …)` 都原样读回、字段不串位，`#(…)` 没有被执行；别人开在这个 socket 上的会话被跳过、不算读取失败（`TestV2OddFieldValues`，三次读取）。
- 解析失败的处理：所有调用点（`List`、`Attach` 的找回、`Projects`、删除前的对账、结束会话后的确认）都把失败当作「没读到」，不清会话表、不释放占用；没有找到能让解析持续失败的现实输入。
- 结束会话后的确认：见场景表的负载实验；对话会话和不用 tmux 的终端会话走原来的 `Delete`，不受影响（GUI R5.6 是终端 + 对话各一个）。
- 撤销的认领规则：自己的 `worktree add` 中途自己失败（必需的 smudge 过滤器失败）→ git 自己收回，目录、登记、分支都不留，可以再建；被时限杀掉的那一种由 `TestWorktreeAddKilledDuringCheckoutIsUndone` 守着（invariant 第 18 条，通过）。
- `-z` 的退回：只有退出码 129 才退回，其它失败照常报错（`TestListWorktreesFallsBackWithoutZ` 的 128 一例）；「认不认」按 `exec.LookPath("git")` 的结果记，daemon 的 PATH 运行期间不变；git 被原地换成更旧的版本时，下一次读取得到 129 后当场退回。按行读时去掉的只有「路径不是绝对路径」或「没有 HEAD 且不是 bare」的条目，真实的 worktree 两样都有，不会被丢掉。

## 待验证项

| 项 | 影响 | 下一步 |
|----|------|--------|
| 其它版本的 tmux（Ubuntu 22.04 的 3.2a、Debian 12 的 3.3a、Ubuntu 24.04 的 3.4） | 读 tmux 的格式是全部终端会话的入口，返工改了它；我只在 3.6a 上验证过。标记是可打印的 ASCII，看不出哪个版本会改写它，但没有实跑 | 在目标 Linux 上跑一次 `ws-worktree-smoke.mjs` 和 `go test ./internal/session -run 'OddlyNamed|TmuxReadFails'` |
| 真正的旧 git（2.30 / 2.34） | 退回模式我用包装脚本模拟（见说明 2）；开发方的实测在 `evidence/gate-c-1-rework.md` 第 3 节，我没有重建旧 git 复核 | 修 N-1 时在真的 2.34 上跑一遍 |
| 真实键盘经 macOS 菜单和输入法（R7） | 沿用第 1 轮：CDP 的按键不经过原生菜单分发 | 人在打包后的 app 里按一遍（test-report.md 有步骤） |
| 冷启动首帧之前约 0.1 秒、原生通知的点击、真正的旧版桌面端、真实 claude 和远程 Linux | 沿用第 1 轮界面验证者的待验证项，这一轮没有新的证据 | 同第 1 轮 |
| 真实指针重走界面 | 这一轮界面只跑了三份冒烟（大多数用例用 DOM 的 `click()`）；桌面端代码没变，第 1 轮用真实指针走过 50 个场景 | 不需要，除非桌面端再改 |

已交给用户决定的 c6（旧 git 上跳过 `GIT_CONFIG_COUNT` 子用例）、c7（新建或重命名终端会话时后台会话全亮「有新消息」）：这一轮没有新的证据改变它们；c6 的跳过条件已收紧，本机不跳过。

tasks.md「后续」里我认为风险被低估的：d70（N-2）、X14 的已知限制（N-1：实际不是「列不出来」）、`TestProjectStoreRemoveWorktreeIfSame`（说明 1）。「单独删会话不确认 tmux 是否真的结束了它」（d68）我同意开发方的判断：它是 tmux 没了之后清掉表里会话的出路，删会话不删目录。

## 放松检查

返工改动的已有断言，逐个看过 `git diff 91e0fab..HEAD -- '*_test.go'`（9 个文件，+1261 / −63；`func Test…` 的集合：91e0fab 有 440 个，现在 454 个，**没有删掉的**，新增 14 个）：

| 改动 | 判断 |
|------|------|
| `TestParseTmuxSessionLine…` 六个用例（`PreservesMetadataFields`、`KeepsEmptyTrailingFields`、`RejectsEmptySessionID`、`RejectsMalformedFieldCount`、`Columns`、`ReadsClaudeU`）：输入从制表符分隔的一行改成带标记的回答；8、9、13 列从「能解析」改成「拒绝」；id 为空的会话从「解析失败」改成「不算进集合、其余照常读」 | 行为按裁决改变（decisions #141、#142：格式串和解析在同一个二进制里，列数必须正好 14），不是放松。`Columns` 还多了「1、15 列被拒」「字段里的制表符和换行原样保留」「截断的回答、多出来的文字被拒」几条 |
| `TestGitTimeoutKillsProcess`：`t.Skip("fake git did not record a pid")` 换成 `t.Fatal`；先把假 git 运行一次；pid 没写出来就重试，最多 20 次 | 加强。时限 50 ms 和「不到 1 秒」两个数没动；本机 `-race -count=5` 5 次 PASS、0 次 SKIP |
| `TestGitEnvKeepsInheritedConfig/GIT_CONFIG_COUNT`（c6）：探测命令失败、或输出不是 `kept` / `not-read`，从「跳过」改成「失败」 | 加强。现在只在「探测成功且 git 不读 `GIT_CONFIG_COUNT`」时跳过；本机输出 `kept`，执行了断言 |
| `TestWorktreeRemoveEndpoint/changed_after_sessions_ended`：让提交落地的触发点从 `rev-parse HEAD` 改成第三次成功的 `worktree list` | 跟着 X13 的实现改（复核不再调用 `rev-parse HEAD`）；断言（409、`endedSessions` 如实、目录和分支都在）没动 |
| `installCountingGitConcurrency`（测试辅助函数）：开始计数之前先用新装的 git 读一次列表、清空计数 | 断言没动。在认 `-z` 的 git 上不改变任何计数；旧 git 上把「每个 git 只发生一次的探测」排除在「一轮轮询的开销」之外，有依据（decisions #149） |

新增的条件跳过两处：`requireWorktreeListZ`（只有探测以 129 退出才跳过带换行的子用例，别的失败是 `t.Fatalf`；本机不跳过）；`TestPlanMissingWorkdirIs400` 在系统不支持符号链接时跳过后半段（本机不跳过）。本机不带 `-race` 的 `-v` 全量里 0 个 SKIP。

`.devflow.yml`：三条规则的 `check` 只增加了用例名（新加的 14 个用例里的 13 个，外加原有的 `TestWorktreeAddKilledDuringCheckoutIsUndone`；第 14 个 `TestPlanMissingWorkdirIs400` 在全量里跑），没有去掉的；规则文字跟着返工改写。其中「目录名里的制表符和换行不改变读到的归属」少了「UTF-8 环境下」这个前提（N-4），「对话界面的信任…」那条在旧 git 上有反例（N-1）——这两处是规则文字比实际保证的多，不是检查被放松。

覆盖面上的缺口（不是放松）：`TestParseWorktreeList` 对「按行读时路径带换行」只测了 `external\nworktree` 一个名字，所以没有发现 N-1；`TestIsNoTmuxServerGoesByTheWholeLine` 没有路径带换行的例子（N-3）。

除此之外：无。

## 最后核对

- 开始和结束时 `git rev-parse HEAD` 都是 `482ab63df9ec109e0f991834b5e267cd118ffbfb`，`git status --short` 都为空；没有改动任何已跟踪的文件，没有提交。被忽略的构建产物只有 `desktop/dist/`。
- 我启动的进程都已退出（临时 daemon、它们各自 socket 目录下的 tmux server、Electron、负载实验的 24 个 shell 循环）；`/tmp/vr-v2*` 目录、两个临时 worktree（482ab63 和 91e0fab 各一个）已删除。本文件和 `same-evidence/` 是我在 `/Users/mac/github/vibe-remote/.devflow-tmp/gate-c2/` 下新增的全部内容。
