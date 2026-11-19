package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat/chattest"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

const chatWait = 15 * time.Second

// chatFixture is a Manager wired for chat sessions against the fake claude.
type chatFixture struct {
	t        *testing.T
	env      *chattest.Env
	exe      string
	projects string
	stateDir string
	useTmux  bool
	cmd      string // terminal claude_cmd
	m        *Manager
}

func newChatFixture(t *testing.T, useTmux bool, extraEnv ...string) *chatFixture {
	t.Helper()
	if useTmux {
		requireTmux(t)
	}
	f := &chatFixture{
		t:        t,
		env:      chattest.NewEnv(t),
		exe:      filepath.Join(chattest.FakeClaude(t), "claude"),
		stateDir: filepath.Join(t.TempDir(), "state"),
		useTmux:  useTmux,
	}
	f.env.Extra = append(f.env.Extra, extraEnv...)
	f.projects = filepath.Join(f.env.ConfigDir, "projects")
	if useTmux {
		// Runs last: when this test killed the shared tmux server's last
		// session, wait until the server has fully exited so the next test's
		// new-session does not race its shutdown ("server exited unexpectedly").
		t.Cleanup(func() {
			deadline := time.Now().Add(3 * time.Second)
			for time.Now().Before(deadline) {
				out, _ := tmuxCmd("list-sessions").CombinedOutput()
				if !strings.Contains(string(out), "server exited unexpectedly") {
					return
				}
				time.Sleep(20 * time.Millisecond)
			}
		})
	}
	f.cmd = f.exe
	f.m = f.newManager()
	return f
}

// newManager builds a Manager on the fixture's state dir, like a daemon
// (re)start, and loads the chat table.
func (f *chatFixture) newManager() *Manager {
	f.t.Helper()
	m := NewManager(f.useTmux, f.cmd, false, "")
	m.SetEventEnv("http://127.0.0.1:1/api/v1/events", "main-token-for-tests-0123456789")
	m.SetChatConfig(ChatConfig{ProjectsDir: f.projects, Env: f.chatEnv()})
	store, err := chat.NewStore(f.stateDir)
	if err != nil {
		f.t.Fatal(err)
	}
	if err := m.LoadChats(store); err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { m.Shutdown(5 * time.Second) })
	return m
}

// chatEnv is the fixture's extra environment. The shared tmux server may have
// been started from inside a claude session (CLAUDECODE set), and a terminal
// session's environment comes from that server, so the guards are blanked
// explicitly for the fake claude in tmux.
func (f *chatFixture) chatEnv() []string {
	return append(f.env.Vars(), "CLAUDECODE=", "CLAUDE_CODE_ENTRYPOINT=")
}

func (f *chatFixture) workdir() string {
	f.t.Helper()
	dir := f.t.TempDir()
	if canon, err := filepath.EvalSymlinks(dir); err == nil {
		dir = canon
	}
	return dir
}

func parsed(t *testing.T, cmd string) chat.Parsed {
	t.Helper()
	p, reason := chat.ParseClaudeCmd(cmd)
	if reason != "" {
		t.Fatalf("parse %q: %s", cmd, reason)
	}
	return p
}

var idSeq atomic.Int64

func newID(prefix string) string {
	return fmt.Sprintf("%s-%d-%d", prefix, time.Now().UnixNano()%1e9, idSeq.Add(1))
}

func (f *chatFixture) create(m *Manager, id, workdir string, extra string) (ChatAttachment, error) {
	f.t.Helper()
	return m.CreateChat(ChatCreateOptions{ID: id, Workdir: workdir, Mode: protocol.SessionModeNormal,
		Parsed: parsed(f.t, strings.TrimSpace(f.exe+" "+extra))})
}

func (f *chatFixture) mustCreate(m *Manager, id, workdir, extra string) ChatAttachment {
	f.t.Helper()
	a, err := f.create(m, id, workdir, extra)
	if err != nil {
		f.t.Fatalf("CreateChat %s: %v", id, err)
	}
	return a
}

// transcript writes a JSONL for conversation u in workdir's project dir.
func (f *chatFixture) transcript(workdir, u string, mtime time.Time) string {
	f.t.Helper()
	dir := filepath.Join(f.projects, chat.EncodeProjectDir(workdir))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		f.t.Fatal(err)
	}
	path := filepath.Join(dir, u+".jsonl")
	line := fmt.Sprintf(`{"type":"user","cwd":%q,"sessionId":%q,"message":{"role":"user","content":"earlier"}}`+"\n", workdir, u)
	if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
		f.t.Fatal(err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		f.t.Fatal(err)
	}
	return path
}

func waitUntil(t *testing.T, desc string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(chatWait)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for %s", desc)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// argvLines returns every launch the fake recorded.
func (f *chatFixture) argvLines() [][]string {
	data, _ := os.ReadFile(f.env.ArgvLog)
	var out [][]string
	for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var a []string
		if json.Unmarshal([]byte(l), &a) == nil {
			out = append(out, a)
		}
	}
	return out
}

func (f *chatFixture) waitArgv(n int) []string {
	f.t.Helper()
	waitUntil(f.t, fmt.Sprintf("%d launches", n), func() bool { return len(f.argvLines()) >= n })
	return f.argvLines()[n-1]
}

func has(argv []string, flag, value string) bool {
	for i := range argv {
		if argv[i] == flag && (value == "" || (i+1 < len(argv) && argv[i+1] == value)) {
			return true
		}
	}
	return false
}

func (f *chatFixture) owner(m *Manager, u string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.claudeOwners[u]
}

func (f *chatFixture) noViolation() {
	f.t.Helper()
	if v := f.env.Violation(); v != "" {
		f.t.Fatalf("VIOLATION: %s", v)
	}
}

func idle(s *chat.Session) func() bool {
	return func() bool { return s.Snapshot().Status == protocol.ChatStatusIdle }
}

// --- create ---

func TestCreateContinueResumesLatest(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	w := f.workdir()
	older, newer := chat.NewUUID(), chat.NewUUID()
	f.transcript(w, older, time.Now().Add(-time.Hour))
	f.transcript(w, newer, time.Now().Add(-time.Minute))
	a := f.mustCreate(f.m, newID("c"), w, "-c")
	if a.Session.ClaudeSessionID() != newer || a.Existing {
		t.Fatalf("attachment %+v, want claude session %s", a, newer)
	}
	argv := f.waitArgv(1)
	if !has(argv, "--resume", newer) || has(argv, "-c", "") || has(argv, "--continue", "") {
		t.Fatalf("argv %v", argv)
	}
}

func TestChatWorktreeAndFlags(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	repo := tempRepo(t)
	id := newID("wt")
	a, err := f.m.CreateChat(ChatCreateOptions{ID: id, Workdir: repo, Mode: protocol.SessionModeWorktree,
		Flags: []string{"model"}, Parsed: parsed(t, f.exe+" --model fable --append-system-prompt 'be brief'")})
	if err != nil {
		t.Fatal(err)
	}
	argv := f.waitArgv(1)
	if !has(argv, "--model", "fable") || !has(argv, "--append-system-prompt", "be brief") {
		t.Fatalf("argv %v", argv)
	}
	info := f.m.chatInfo(id)
	if info.Mode != protocol.SessionModeWorktree || info.WorktreeRoot == "" || info.Branch != "vibe/"+id {
		t.Fatalf("metadata %+v", info)
	}
	pid := a.Session.Snapshot().Pid
	cwd := processCwd(t, pid)
	if !strings.HasPrefix(cwd, info.WorktreeRoot) {
		t.Fatalf("claude runs in %s, want inside %s", cwd, info.WorktreeRoot)
	}
	if err := f.m.Delete(id); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(info.WorktreeRoot); err != nil {
		t.Fatalf("deleting the session removed its worktree: %v", err)
	}
	if branchOID(t, repo, "vibe/"+id) == "" {
		t.Fatal("deleting the session removed its branch")
	}
}

// processCwd returns pid's working directory (lsof on macOS, /proc on Linux).
func processCwd(t *testing.T, pid int) string {
	t.Helper()
	if link, err := os.Readlink(fmt.Sprintf("/proc/%d/cwd", pid)); err == nil {
		return link
	}
	out, err := exec.Command("lsof", "-a", "-p", fmt.Sprint(pid), "-d", "cwd", "-Fn").Output()
	if err != nil {
		t.Fatalf("lsof: %v", err)
	}
	for _, l := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(l, "n") {
			return l[1:]
		}
	}
	t.Fatalf("no cwd for %d", pid)
	return ""
}

func TestChatCreateReplaySameID(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	w := f.workdir()
	id := newID("rp")
	var wg sync.WaitGroup
	results := make([]ChatAttachment, 4)
	errs := make([]error, 4)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = f.create(f.m, id, w, "")
		}(i)
	}
	wg.Wait()
	for i := range results {
		if errs[i] != nil || results[i].Session != results[0].Session || results[i].ID != id {
			t.Fatalf("replay %d: %+v %v", i, results[i], errs[i])
		}
	}
	again := f.mustCreate(f.m, id, w, "")
	if again.Session != results[0].Session {
		t.Fatal("later replay got another session")
	}
	time.Sleep(200 * time.Millisecond)
	if n := len(f.argvLines()); n != 1 {
		t.Fatalf("%d processes started", n)
	}
	f.noViolation()
}

func TestChatCreateConcurrentSameID(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	repo := tempRepo(t)
	id := newID("cc")
	var wg sync.WaitGroup
	var sessions sync.Map
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a, err := f.m.CreateChat(ChatCreateOptions{ID: id, Workdir: repo, Mode: protocol.SessionModeWorktree, Parsed: parsed(t, f.exe)})
			if err != nil {
				t.Error(err)
				return
			}
			sessions.Store(a.Session, true)
		}()
	}
	wg.Wait()
	n := 0
	sessions.Range(func(any, any) bool { n++; return true })
	if n != 1 {
		t.Fatalf("%d sessions for one id", n)
	}
	if got := runGit(t, repo, "branch", "--list", "--format=%(refname:short)", "vibe/*"); got != "vibe/"+id {
		t.Fatalf("branches %q", got)
	}
}

func TestContinueReusesRunningSession(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	w := f.workdir()
	u := chat.NewUUID()
	f.transcript(w, u, time.Now())
	first := f.mustCreate(f.m, newID("x"), w, "-c")
	second := f.mustCreate(f.m, newID("y"), w, "-c")
	if !second.Existing || second.ID != first.ID || second.Session != first.Session {
		t.Fatalf("second -c create: %+v (first %s)", second, first.ID)
	}
	time.Sleep(200 * time.Millisecond)
	if n := len(f.env.LivePids(u)); n != 1 {
		t.Fatalf("%d processes for %s", n, u)
	}
	if n := len(f.m.List()); n != 1 {
		t.Fatalf("%d sessions listed", n)
	}
}

func TestConcurrentContinueCreatesOneProcess(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	for round := 0; round < 5; round++ {
		w := f.workdir()
		u := chat.NewUUID()
		f.transcript(w, u, time.Now())
		var wg sync.WaitGroup
		atts := make([]ChatAttachment, 2)
		errs := make([]error, 2)
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				atts[i], errs[i] = f.create(f.m, newID(fmt.Sprintf("k%d", i)), w, "-c")
			}(i)
		}
		wg.Wait()
		for i := range errs {
			if errs[i] != nil && !errors.Is(errs[i], ErrClaudeSessionBusy) {
				t.Fatalf("round %d: %v", round, errs[i])
			}
		}
		if errs[0] == nil && errs[1] == nil && atts[0].Session != atts[1].Session {
			t.Fatalf("round %d: two sessions for one conversation", round)
		}
		time.Sleep(100 * time.Millisecond)
		if n := len(f.env.LivePids(u)); n != 1 {
			t.Fatalf("round %d: %d processes", round, n)
		}
	}
	f.noViolation()
}

// --- reload ---

func TestReloadWaitsForOldProcess(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	a := f.mustCreate(f.m, newID("rl"), f.workdir(), "")
	u := a.Session.ClaudeSessionID()
	waitUntil(t, "first process", func() bool { return len(f.env.LivePids(u)) == 1 })
	oldPid := a.Session.Snapshot().Pid
	stop := make(chan struct{})
	var overlap atomic.Bool
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			if len(f.env.LivePids(u)) > 1 {
				overlap.Store(true)
			}
			time.Sleep(time.Millisecond)
		}
	}()
	if err := f.m.ReloadChat(a.ID); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "new process", func() bool {
		info := a.Session.Snapshot()
		return info.Pid != 0 && info.Pid != oldPid && info.Status == protocol.ChatStatusIdle
	})
	close(stop)
	if overlap.Load() {
		t.Fatal("old and new process alive at the same time")
	}
	if processRunning(oldPid) {
		t.Fatal("old process still alive")
	}
	if o := f.owner(f.m, u); o != a.ID {
		t.Fatalf("owner %q", o)
	}
	f.noViolation()
}

func processRunning(pid int) bool {
	return pid > 0 && exec.Command("kill", "-0", fmt.Sprint(pid)).Run() == nil
}

func TestRestartRefusedWhenUResumedElsewhere(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	w := f.workdir()
	x := f.mustCreate(f.m, newID("x"), w, "")
	u := x.Session.ClaudeSessionID()
	if ack := x.Session.Send("1", "echo hi"); !ack.OK {
		t.Fatal(ack)
	}
	waitUntil(t, "x idle", idle(x.Session))
	x.Session.WithOp(func(ops chat.OpHandle) { _ = ops.StopLocked(protocol.EndReasonStopped) })
	waitUntil(t, "release", func() bool { return f.owner(f.m, u) == "" })
	y := f.mustCreate(f.m, newID("y"), w, "-c")
	if y.Session.ClaudeSessionID() != u || y.Existing {
		t.Fatalf("y %+v", y)
	}
	err := f.m.ReloadChat(x.ID)
	var busy *ClaudeSessionBusyError
	if !errors.As(err, &busy) || busy.Owner != y.ID {
		t.Fatalf("reload x: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	if info := y.Session.Snapshot(); info.Status == protocol.ChatStatusEnded || len(f.env.LivePids(u)) != 1 {
		t.Fatalf("y affected: %+v", info)
	}
}

func TestReloadVsDeleteSerialized(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	for i := 0; i < 5; i++ {
		a := f.mustCreate(f.m, newID("rd"), f.workdir(), "")
		u := a.Session.ClaudeSessionID()
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); _ = f.m.ReloadChat(a.ID) }()
		go func() { defer wg.Done(); _ = f.m.Delete(a.ID) }()
		wg.Wait()
		waitUntil(t, "settled", func() bool {
			return !a.Session.Snapshot().Reloading && len(f.env.LivePids(u)) == 0
		})
		time.Sleep(50 * time.Millisecond)
		if _, ok := f.m.ChatGet(a.ID); ok {
			t.Fatal("session survived delete")
		}
		if n := len(f.env.LivePids(u)); n != 0 {
			t.Fatalf("%d processes left", n)
		}
		if o := f.owner(f.m, u); o != "" {
			t.Fatalf("claim left: %s", o)
		}
	}
	f.noViolation()
}

// --- daemon restart ---

func TestLoadChatsMarksDaemonRestart(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	a := f.mustCreate(f.m, newID("lr"), f.workdir(), "")
	if err := f.m.Rename(a.ID, "keeps its name"); err != nil {
		t.Fatal(err)
	}
	f.m.flush()
	// Simulate the daemon being killed: the record still says running.
	data, _ := os.ReadFile(filepath.Join(f.stateDir, chat.StoreFileName))
	if !strings.Contains(string(data), `"status":"running"`) {
		t.Fatalf("store %s", data)
	}
	pid := a.Session.Snapshot().Pid
	m2 := f.newManager() // its LoadChats cleans up the still-running process
	waitUntil(t, "orphan gone", func() bool { return !processRunning(pid) })
	var got *protocol.SessionInfo
	for _, s := range m2.List() {
		if s.ID == a.ID {
			s := s
			got = &s
		}
	}
	if got == nil || got.UI != protocol.UIChat || got.State != protocol.ChatStatusEnded ||
		got.EndReason != protocol.EndReasonDaemonRestart || got.Title != "keeps its name" {
		t.Fatalf("listed %+v", got)
	}
}

func TestOrphanOwnerBlocksReloadUntilGone(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	a := f.mustCreate(f.m, newID("or"), f.workdir(), "")
	u := a.Session.ClaudeSessionID()
	f.m.flush()
	pid := a.Session.Snapshot().Pid
	m2 := NewManager(false, f.cmd, false, "")
	m2.SetChatConfig(ChatConfig{ProjectsDir: f.projects, Env: f.chatEnv()})
	store, _ := chat.NewStore(f.stateDir)
	// The old process survives cleanup (as if even SIGKILL did not end it).
	m2.orphanCleanup = func(recs []chat.Record) ([]chat.Record, []chat.Orphan) {
		var orphans []chat.Orphan
		out := append([]chat.Record(nil), recs...)
		for i, r := range out {
			if r.Status == chat.StatusRunning {
				orphans = append(orphans, chat.Orphan{ClaudeSessionID: r.ClaudeSessionID, Pid: r.Pid})
				out[i].Status, out[i].EndReason, out[i].Pid = chat.StatusEnded, protocol.EndReasonDaemonRestart, 0
			}
		}
		return out, orphans
	}
	if err := m2.LoadChats(store); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m2.Shutdown(5 * time.Second) })
	if o := f.owner(m2, u); o != fmt.Sprintf("orphan:%d", pid) {
		t.Fatalf("owner %q", o)
	}
	var busy *ClaudeSessionBusyError
	if err := m2.ReloadChat(a.ID); !errors.As(err, &busy) || busy.Owner != fmt.Sprintf("orphan:%d", pid) {
		t.Fatalf("reload while orphan alive: %v", err)
	}
	// The first manager's process is the orphan; end it for real.
	a.Session.WithOp(func(ops chat.OpHandle) { _ = ops.StopLocked(protocol.EndReasonStopped) })
	waitUntil(t, "orphan gone", func() bool { return !processRunning(pid) })
	if err := m2.ReloadChat(a.ID); err != nil {
		t.Fatalf("reload after orphan exit: %v", err)
	}
	s2, _ := m2.ChatGet(a.ID)
	waitUntil(t, "restarted", idle(s2))
	if o := f.owner(m2, u); o != a.ID {
		t.Fatalf("owner after reload %q", o)
	}
}

func TestShutdownStopsChats(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	var pids []int
	for i := 0; i < 3; i++ {
		a := f.mustCreate(f.m, newID("sd"), f.workdir(), "")
		if i == 0 {
			a.Session.Send("1", "slow 50 200")
		}
		pids = append(pids, a.Session.Snapshot().Pid)
	}
	start := time.Now()
	f.m.Shutdown(6 * time.Second)
	if d := time.Since(start); d > 6*time.Second {
		t.Fatalf("shutdown took %v", d)
	}
	for _, p := range pids {
		if processRunning(p) {
			t.Fatalf("pid %d alive after shutdown", p)
		}
	}
	store, _ := chat.NewStore(f.stateDir)
	recs, _ := store.Load()
	if len(recs) != 3 {
		t.Fatalf("%d records", len(recs))
	}
	for _, r := range recs {
		if r.Status != chat.StatusEnded || r.EndReason != protocol.EndReasonDaemonRestart {
			t.Fatalf("record %+v", r)
		}
	}
}

// --- rename / delete / list / store ---

func TestChatRenamePersists(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	a := f.mustCreate(f.m, newID("rn"), f.workdir(), "")
	if err := f.m.Rename(a.ID, "  \x1b[31mmy chat\x1b[0m  "); err != nil {
		t.Fatal(err)
	}
	title := func(m *Manager) string {
		for _, s := range m.List() {
			if s.ID == a.ID {
				return s.Title
			}
		}
		return ""
	}
	if got := title(f.m); got != "my chat" {
		t.Fatalf("title %q", got)
	}
	f.m.Shutdown(5 * time.Second)
	if got := title(f.newManager()); got != "my chat" {
		t.Fatalf("after restart: %q", got)
	}
	if err := f.m.Rename("missing", "x"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("rename missing: %v", err)
	}
}

func TestChatDeleteKeepsJSONL(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	a := f.mustCreate(f.m, newID("dl"), f.workdir(), "")
	if ack := a.Session.Send("1", "echo keep"); !ack.OK {
		t.Fatal(ack)
	}
	waitUntil(t, "idle", func() bool {
		return a.Session.Snapshot().Status == protocol.ChatStatusIdle && a.Session.Snapshot().Seq > 3
	})
	u := a.Session.ClaudeSessionID()
	pid := a.Session.Snapshot().Pid
	path, ok := chat.FindTranscript(f.projects, u)
	if !ok {
		t.Fatal("no transcript")
	}
	if err := f.m.Delete(a.ID); err != nil {
		t.Fatal(err)
	}
	if processRunning(pid) {
		t.Fatal("process alive after delete")
	}
	if _, ok := f.m.ChatGet(a.ID); ok {
		t.Fatal("record kept")
	}
	for _, s := range f.m.List() {
		if s.ID == a.ID {
			t.Fatal("still listed")
		}
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("transcript removed: %v", err)
	}
	f.m.flush()
	data, _ := os.ReadFile(filepath.Join(f.stateDir, chat.StoreFileName))
	if strings.Contains(string(data), a.ID) {
		t.Fatal("record still stored")
	}
	if err := f.m.Delete(a.ID); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("second delete: %v", err)
	}
}

func TestDeleteAfterHandoffKeepsWorktree(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	repo := tempRepo(t)
	id := newID("dh")
	if _, err := f.m.CreateChat(ChatCreateOptions{ID: id, Workdir: repo, Mode: protocol.SessionModeWorktree, Parsed: parsed(t, f.exe)}); err != nil {
		t.Fatal(err)
	}
	info := f.m.chatInfo(id)
	f.m.mu.Lock()
	f.m.chats[id].rec.WorktreeHandedOff = true // the worktree now belongs to a terminal session
	f.m.mu.Unlock()
	if err := f.m.Delete(id); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(info.WorktreeRoot); err != nil {
		t.Fatalf("handed-off worktree removed: %v", err)
	}
	if got := runGit(t, repo, "branch", "--list", "--format=%(refname:short)", "vibe/*"); got != "vibe/"+id {
		t.Fatalf("branch %q", got)
	}
}

func TestListMergesChatAndTmux(t *testing.T) {
	f := newChatFixture(t, true)
	f.cmd = "sleep 30"
	f.m = f.newManager()
	w := f.workdir()
	termID := newID("lt")
	if _, err := f.m.Create(CreateOptions{ID: termID, Workdir: w, Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.m.Delete(termID) })
	a := f.mustCreate(f.m, newID("lc"), w, "")
	var gotTerm, gotChat *protocol.SessionInfo
	for i := 0; i < 2; i++ { // a second reconcile must not drop the chat either
		gotTerm, gotChat = nil, nil
		for _, s := range f.m.List() {
			s := s
			switch s.ID {
			case termID:
				gotTerm = &s
			case a.ID:
				gotChat = &s
			}
		}
		if gotTerm == nil || gotChat == nil {
			t.Fatalf("list round %d: term %v chat %v", i, gotTerm, gotChat)
		}
	}
	if gotTerm.UI != "" || gotTerm.State != "" || gotTerm.Epoch != "" {
		t.Fatalf("terminal entry gained chat fields: %+v", gotTerm)
	}
	snap := a.Session.Snapshot()
	if gotChat.UI != protocol.UIChat || gotChat.State != snap.Status || gotChat.Epoch != snap.Epoch || gotChat.Workdir != w {
		t.Fatalf("chat entry %+v", gotChat)
	}
	if _, err := f.m.Attach(a.ID, 80, 24); !errors.Is(err, ErrUIMismatch) {
		t.Fatalf("terminal attach to chat: %v", err)
	}
	if _, err := f.m.Create(CreateOptions{ID: a.ID, Workdir: w}); !errors.Is(err, ErrUIMismatch) {
		t.Fatalf("terminal create on chat id: %v", err)
	}
	if _, err := f.create(f.m, termID, w, ""); !errors.Is(err, ErrUIMismatch) {
		t.Fatalf("chat create on terminal id: %v", err)
	}
}

func TestStoreConcurrentSaveKeepsLatest(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	var ids []string
	for i := 0; i < 4; i++ {
		ids = append(ids, f.mustCreate(f.m, newID("sv"), f.workdir(), "").ID)
	}
	var wg sync.WaitGroup
	var created sync.Map
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			switch g % 4 {
			case 0, 1:
				_ = f.m.Rename(ids[g%len(ids)], fmt.Sprintf("name-%d", g))
			case 2:
				if a, err := f.create(f.m, newID("sv"), f.workdir(), ""); err == nil {
					created.Store(a.ID, true)
				}
			case 3:
				if g == 3 {
					_ = f.m.Delete(ids[3])
				}
			}
		}(g)
	}
	wg.Wait()
	want := map[string]string{}
	for _, s := range f.m.List() {
		want[s.ID] = s.Title
	}
	f.m.Shutdown(6 * time.Second)
	store, _ := chat.NewStore(f.stateDir)
	recs, _ := store.Load()
	if len(recs) != len(want) {
		t.Fatalf("%d records stored, %d in memory", len(recs), len(want))
	}
	for _, r := range recs {
		title, ok := want[r.ID]
		if !ok {
			t.Fatalf("stored %s not in memory", r.ID)
		}
		if r.Name != "" && r.Name != title {
			t.Fatalf("%s stored name %q, memory %q", r.ID, r.Name, title)
		}
	}
}

func TestOwnersReleasedOnExit(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	a := f.mustCreate(f.m, newID("ow"), f.workdir(), "")
	u := a.Session.ClaudeSessionID()
	if o := f.owner(f.m, u); o != a.ID {
		t.Fatalf("owner %q", o)
	}
	a.Session.Send("1", "crash 1")
	waitUntil(t, "release after crash", func() bool { return f.owner(f.m, u) == "" })
	b := f.mustCreate(f.m, newID("ow"), f.workdir(), "")
	ub := b.Session.ClaudeSessionID()
	if err := f.m.Delete(b.ID); err != nil {
		t.Fatal(err)
	}
	if o := f.owner(f.m, ub); o != "" {
		t.Fatalf("owner after delete %q", o)
	}
	f.m.mu.RLock()
	defer f.m.mu.RUnlock()
	for u, o := range f.m.claudeOwners {
		if o == a.ID || o == b.ID {
			t.Fatalf("leftover claim %s → %s", u, o)
		}
	}
}

// --- environment ---

func TestChatEnvStripsNestedGuard(t *testing.T) {
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("CLAUDE_CODE_ENTRYPOINT", "cli")
	f := newChatFixture(t, false)
	a := f.mustCreate(f.m, newID("ng"), f.workdir(), "")
	if ack := a.Session.Send("1", "echo hi"); !ack.OK {
		t.Fatal(ack)
	}
	waitUntil(t, "reply", func() bool {
		return a.Session.Snapshot().Status == protocol.ChatStatusIdle && a.Session.Snapshot().Seq > 3
	})
	if _, err := os.Stat(filepath.Join(f.env.PidDir, "NESTED")); err == nil {
		t.Fatal("claude saw CLAUDECODE")
	}
}

func TestChatEnvHookTokenOnly(t *testing.T) {
	t.Parallel()
	f := newChatFixture(t, false)
	dump := filepath.Join(t.TempDir(), "env.txt")
	wrapDir := filepath.Join(t.TempDir(), "wrap")
	os.MkdirAll(wrapDir, 0o755)
	wrapper := filepath.Join(wrapDir, "claude")
	os.WriteFile(wrapper, []byte("#!/bin/sh\nenv > '"+dump+"'\nexec '"+f.exe+"' \"$@\"\n"), 0o755)
	id := newID("ht")
	if _, err := f.m.CreateChat(ChatCreateOptions{ID: id, Workdir: f.workdir(), Parsed: parsed(t, wrapper)}); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "env dump", func() bool { _, err := os.Stat(dump); return err == nil })
	time.Sleep(50 * time.Millisecond)
	data, _ := os.ReadFile(dump)
	env := string(data)
	if !strings.Contains(env, "VIBE_REMOTE_TOKEN="+HookToken("main-token-for-tests-0123456789", id)+"\n") {
		t.Fatalf("hook token missing:\n%s", env)
	}
	if strings.Contains(env, "main-token-for-tests-0123456789") {
		t.Fatal("main token in the chat process environment")
	}
	if !strings.Contains(env, "VIBE_REMOTE_SESSION_ID="+id+"\n") || !strings.Contains(env, "VIBE_REMOTE_EVENTS_URL=") {
		t.Fatalf("session env missing:\n%s", env)
	}
}

// --- terminal continue (c4) and handoff claims ---

func (f *chatFixture) createTerminal(m *Manager, id, workdir, cmd string) (*Runner, error) {
	f.t.Helper()
	r, err := m.Create(CreateOptions{ID: id, Workdir: workdir, Cols: 80, Rows: 24, ClaudeCmdOverride: cmd})
	if err == nil {
		f.t.Cleanup(func() { m.Delete(id) })
	}
	return r, err
}

func tmuxOption(t *testing.T, id, key string) string {
	t.Helper()
	out, _ := tmuxCmd("show-options", "-t", "vibe-remote-"+id, "-qv", key).Output()
	return strings.TrimSpace(string(out))
}

func TestTerminalContinueClaimsLatest(t *testing.T) {
	f := newChatFixture(t, true)
	cont := f.exe + " -c"

	// A transcript exists: -c becomes --resume U and U is claimed.
	w := f.workdir()
	u := chat.NewUUID()
	f.transcript(w, u, time.Now().Add(-time.Minute))
	t1 := newID("t1")
	if _, err := f.createTerminal(f.m, t1, w, cont); err != nil {
		t.Fatal(err)
	}
	argv := f.waitArgv(1)
	if !has(argv, "--resume", u) || has(argv, "-c", "") {
		t.Fatalf("terminal argv %v", argv)
	}
	if o := f.owner(f.m, u); o != t1 {
		t.Fatalf("owner %q", o)
	}
	if got := tmuxOption(t, t1, "@vibe_remote_claude_u"); got != u {
		t.Fatalf("tmux option %q", got)
	}
	_, err := f.create(f.m, newID("c1"), w, "-c")
	var busy *ClaudeSessionBusyError
	if !errors.As(err, &busy) || busy.Owner != t1 || !strings.Contains(busy.Error(), filepath.Base(w)) {
		t.Fatalf("chat -c over a continue terminal: %v", err)
	}
	waitUntil(t, "terminal process", func() bool { return len(f.env.LivePids(u)) == 1 })

	// A newer transcript appears between resolving and starting.
	w2 := f.workdir()
	u2 := chat.NewUUID()
	f.transcript(w2, u2, time.Now().Add(-time.Minute))
	b := chat.NewUUID()
	f.m.testAfterResolve = func(dir string) {
		if dir == w2 {
			// Newer than anything the terminal's own start writes later.
			f.transcript(w2, b, time.Now().Add(time.Hour))
		}
	}
	t2 := newID("t2")
	if _, err := f.createTerminal(f.m, t2, w2, cont); err != nil {
		t.Fatal(err)
	}
	f.m.testAfterResolve = nil
	if argv := f.waitArgv(2); !has(argv, "--resume", u2) {
		t.Fatalf("terminal argv %v", argv)
	}
	c2 := f.mustCreate(f.m, newID("c2"), w2, "-c")
	if c2.Session.ClaudeSessionID() != b || c2.Existing {
		t.Fatalf("chat -c got %s, want the newer %s", c2.Session.ClaudeSessionID(), b)
	}

	// No transcript: a fixed new U with --session-id.
	w3 := f.workdir()
	t3 := newID("t3")
	if _, err := f.createTerminal(f.m, t3, w3, cont); err != nil {
		t.Fatal(err)
	}
	argv = f.waitArgv(4)
	u3 := ""
	for i := range argv {
		if argv[i] == "--session-id" && i+1 < len(argv) {
			u3 = argv[i+1]
		}
	}
	if u3 == "" || has(argv, "-c", "") || f.owner(f.m, u3) != t3 {
		t.Fatalf("argv %v owner %q", argv, f.owner(f.m, u3))
	}
	waitUntil(t, "terminal transcript", func() bool { _, ok := chat.FindTranscript(f.projects, u3); return ok })
	if _, err := f.create(f.m, newID("c3"), w3, "-c"); !errors.As(err, &busy) || busy.Owner != t3 {
		t.Fatalf("chat -c after terminal wrote U3: %v", err)
	}
	if n := len(f.env.LivePids(u3)); n != 1 {
		t.Fatalf("%d processes for U3", n)
	}

	// Reload: --resume U3, old process gone before the new one, claim kept.
	stop := make(chan struct{})
	var lost, overlap atomic.Bool
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			if f.owner(f.m, u3) != t3 {
				lost.Store(true)
			}
			if len(f.env.LivePids(u3)) > 1 {
				overlap.Store(true)
			}
			time.Sleep(time.Millisecond)
		}
	}()
	launches := len(f.argvLines())
	if err := f.m.Reload(t3, cont); err != nil {
		t.Fatal(err)
	}
	argv = f.waitArgv(launches + 1)
	close(stop)
	if !has(argv, "--resume", u3) {
		t.Fatalf("reload argv %v", argv)
	}
	if lost.Load() || overlap.Load() {
		t.Fatalf("claim lost %v, overlap %v", lost.Load(), overlap.Load())
	}

	// Reload whose start fails: U′ = U keeps the claim …
	f.m.testFailRespawn = errors.New("injected respawn failure")
	if err := f.m.Reload(t3, cont); err == nil {
		t.Fatal("injected failure not reported")
	}
	if o := f.owner(f.m, u3); o != t3 {
		t.Fatalf("U′=U failure released the claim: %q", o)
	}
	// … and a new U′ ≠ U is released again.
	u4 := chat.NewUUID()
	f.transcript(w3, u4, time.Now().Add(time.Minute))
	if err := f.m.Reload(t3, cont); err == nil {
		t.Fatal("injected failure not reported")
	}
	f.m.testFailRespawn = nil
	if o := f.owner(f.m, u4); o != "" {
		t.Fatalf("U′ claim kept after failure: %q", o)
	}
	if o := f.owner(f.m, u3); o != t3 {
		t.Fatalf("U lost after U′ failure: %q", o)
	}
	os.Remove(filepath.Join(f.projects, chat.EncodeProjectDir(w3), u4+".jsonl"))

	// A restarted daemon recovers the claim from the tmux option.
	m2 := f.newManager()
	m2.List()
	if o := f.owner(m2, u3); o != t3 {
		t.Fatalf("after restart owner %q", o)
	}
	if err := m2.Delete(t3); err != nil {
		t.Fatal(err)
	}
	if o := f.owner(m2, u3); o != "" {
		t.Fatalf("after delete owner %q", o)
	}
	// Killing the tmux session behind the daemon's back releases on reconcile.
	if err := tmuxCmd("kill-session", "-t", "vibe-remote-"+t1).Run(); err != nil {
		t.Fatal(err)
	}
	f.m.List()
	if o := f.owner(f.m, u); o != "" {
		t.Fatalf("claim of a vanished terminal %q", o)
	}

	// Without continue the command is untouched and nothing is claimed.
	w5 := f.workdir()
	f.transcript(w5, chat.NewUUID(), time.Now())
	launches = len(f.argvLines())
	t5 := newID("t5")
	if _, err := f.createTerminal(f.m, t5, w5, f.exe); err != nil {
		t.Fatal(err)
	}
	argv = f.waitArgv(launches + 1)
	if has(argv, "--resume", "") || has(argv, "--session-id", "") {
		t.Fatalf("plain terminal argv %v", argv)
	}
	f.m.mu.RLock()
	for u, o := range f.m.claudeOwners {
		if o == t5 {
			t.Errorf("plain terminal claimed %s", u)
		}
	}
	f.m.mu.RUnlock()
	f.noViolation()
}

func TestTerminalContinueBusyWhenChatOwns(t *testing.T) {
	f := newChatFixture(t, true)
	w := f.workdir()
	c := f.mustCreate(f.m, newID("co"), w, "")
	if err := f.m.Rename(c.ID, "chat owner"); err != nil {
		t.Fatal(err)
	}
	if ack := c.Session.Send("1", "echo hi"); !ack.OK {
		t.Fatal(ack)
	}
	waitUntil(t, "transcript", func() bool { _, ok := chat.FindTranscript(f.projects, c.Session.ClaudeSessionID()); return ok })
	tid := newID("tb")
	_, err := f.createTerminal(f.m, tid, w, f.exe+" -c")
	var busy *ClaudeSessionBusyError
	if !errors.As(err, &busy) || busy.Owner != c.ID || !strings.Contains(busy.Error(), "chat owner") {
		t.Fatalf("terminal -c over a running chat: %v", err)
	}
	if exec.Command("tmux", "-L", tmuxSocket, "has-session", "-t", "vibe-remote-"+tid).Run() == nil {
		t.Fatal("tmux session created anyway")
	}
	f.m.mu.RLock()
	defer f.m.mu.RUnlock()
	for u, o := range f.m.claudeOwners {
		if o == tid {
			t.Fatalf("failed create left claim %s", u)
		}
	}
	if len(f.env.LivePids(c.Session.ClaudeSessionID())) != 1 {
		t.Fatal("a second process started")
	}
}

func TestReloadRefusedWhenHandedOff(t *testing.T) {
	f := newChatFixture(t, true)
	w := f.workdir()
	c := f.mustCreate(f.m, newID("ho"), w, "")
	u := c.Session.ClaudeSessionID()
	c.Session.WithOp(func(ops chat.OpHandle) { _ = ops.StopLocked(protocol.EndReasonHandedOff) })
	waitUntil(t, "release", func() bool { return f.owner(f.m, u) == "" })
	// A terminal session took the conversation over (as a handoff does).
	tid := newID("ht")
	f.m.mu.Lock()
	f.m.claudeOwners[u] = tid
	f.m.chats[c.ID].rec.HandedOffTo = tid
	f.m.mu.Unlock()
	if _, err := f.m.createTerminalLocked(tid, CreateOptions{Workdir: w, Cols: 80, Rows: 24,
		ClaudeCmdOverride: chat.HandoffCommand(f.exe, nil, u, false), ClaudeU: u}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.m.Delete(tid) })
	var busy *ClaudeSessionBusyError
	if err := f.m.ReloadChat(c.ID); !errors.As(err, &busy) || busy.Owner != tid {
		t.Fatalf("reload of a handed-off chat: %v", err)
	}
	if err := f.m.Delete(tid); err != nil {
		t.Fatal(err)
	}
	if err := f.m.ReloadChat(c.ID); err != nil {
		t.Fatalf("reload once the terminal is gone: %v", err)
	}
	waitUntil(t, "restarted", idle(c.Session))
}

func TestLoadChatsReclaimsHandoff(t *testing.T) {
	f := newChatFixture(t, true)
	w := f.workdir()
	c := f.mustCreate(f.m, newID("rh"), w, "")
	u := c.Session.ClaudeSessionID()
	c.Session.WithOp(func(ops chat.OpHandle) { _ = ops.StopLocked(protocol.EndReasonHandedOff) })
	waitUntil(t, "release", func() bool { return f.owner(f.m, u) == "" })
	tid := newID("rt")
	f.m.mu.Lock()
	f.m.claudeOwners[u] = tid
	f.m.chats[c.ID].rec.HandedOffTo = tid
	f.m.mu.Unlock()
	if _, err := f.m.createTerminalLocked(tid, CreateOptions{Workdir: w, Cols: 80, Rows: 24,
		ClaudeCmdOverride: chat.HandoffCommand(f.exe, nil, u, false), ClaudeU: u}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tmuxCmd("kill-session", "-t", "vibe-remote-"+tid).Run() })
	f.m.Shutdown(5 * time.Second)

	m2 := f.newManager()
	m2.List()
	if o := f.owner(m2, u); o != tid {
		t.Fatalf("claim after restart %q", o)
	}
	var busy *ClaudeSessionBusyError
	if err := m2.ReloadChat(c.ID); !errors.As(err, &busy) || busy.Owner != tid {
		t.Fatalf("restart of the handed-off chat: %v", err)
	}
}

func TestParseTmuxSessionLineReadsClaudeU(t *testing.T) {
	sessions, err := parseTmuxSessions(tmuxAnswer(tmuxFields("vibe-remote-s1", "/src", "name", "normal", "", "", "", "", "0b6c0000-0000-4000-8000-000000000000")), testMarks)
	if got := sessions["s1"]; err != nil || got.claudeU != "0b6c0000-0000-4000-8000-000000000000" || got.workdir != "/src" {
		t.Fatalf("parsed %#v err=%v", got, err)
	}
	sessions, err = parseTmuxSessions(tmuxAnswer(tmuxFields("vibe-remote-s1", "/src")), testMarks)
	if got, ok := sessions["s1"]; err != nil || !ok || got.claudeU != "" {
		t.Fatalf("empty column: %#v err=%v", got, err)
	}
	if sessions, err := parseTmuxSessions(tmuxAnswer([]string{"vibe-remote-s1", "/src", "", "", "", "", "", "", "u", "extra"}), testMarks); err == nil {
		// Ten columns is not what list-sessions was asked for; it is rejected
		// rather than silently folding the extra field into claudeU.
		t.Fatalf("accepted a 10-column record: %#v", sessions)
	}
}

// TestHandoffCopiesHome checks that a terminal session created by handing off a
// worktree chat session inherits the chat's attribution verbatim (design 5.1).
func TestHandoffCopiesHome(t *testing.T) {
	f := newChatFixture(t, true)
	repo := tempRepo(t)
	id := newID("hoh")
	if _, err := f.m.CreateChat(ChatCreateOptions{ID: id, Workdir: repo,
		Mode: protocol.SessionModeWorktree, Parsed: parsed(t, f.exe)}); err != nil {
		t.Fatal(err)
	}
	f.m.mu.RLock()
	rec := f.m.chats[id].rec
	f.m.mu.RUnlock()
	if rec.Home == "" || rec.Project == "" {
		t.Fatalf("chat record has no attribution: %+v", rec)
	}

	termID := newID("hoht")
	r, err := f.m.Handoff(id, termID, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.m.Delete(termID) })
	if p, h := r.Home(); p != rec.Project || h != rec.Home {
		t.Fatalf("handoff home=(%q,%q), want (%q,%q)", p, h, rec.Project, rec.Home)
	}
}
