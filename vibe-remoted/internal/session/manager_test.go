package session

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

func TestManagerCreateDefaultsEmptyModeToNormal(t *testing.T) {
	m := NewManager(false, "/bin/cat", false, "")
	r, err := m.Create(CreateOptions{Workdir: t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Delete(r.ID)
	if r.Metadata().Mode != protocol.SessionModeNormal {
		t.Fatalf("mode = %q, want normal", r.Metadata().Mode)
	}
}

func TestManagerCreateWorktreeUsesGeneratedIDAndMetadata(t *testing.T) {
	repo := tempRepo(t)
	m := NewManager(false, "/bin/cat", false, "")
	r, err := m.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Delete(r.ID)
	if r.ID == "" || r.Branch != "vibe/"+r.ID {
		t.Fatalf("id=%q branch=%q", r.ID, r.Branch)
	}
	if r.Workdir != r.WorktreeRoot || r.SourceWorkdir != repo || r.SourceRepo == "" {
		t.Fatalf("runner metadata = %#v", r.Metadata())
	}
	if _, err := os.Stat(r.WorktreeRoot); err != nil {
		t.Fatalf("worktree missing: %v", err)
	}
}

func TestManagerCreateWorktreeRollsBackWhenRunnerStartFails(t *testing.T) {
	repo := tempRepo(t)
	container := filepath.Join(filepath.Dir(repo), filepath.Base(repo)+"-worktrees")
	m := NewManager(false, "/definitely/missing-command", false, "")

	_, err := m.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, Cols: 80, Rows: 24})
	if err == nil {
		t.Fatal("expected runner start failure")
	}
	entries, readErr := os.ReadDir(container)
	if readErr != nil && !os.IsNotExist(readErr) {
		t.Fatal(readErr)
	}
	if len(entries) != 0 {
		t.Fatalf("rollback left worktrees: %v", entries)
	}
	if got := runGit(t, repo, "branch", "--list", "vibe/*"); got != "" {
		t.Fatalf("rollback left branch: %q", got)
	}
}

func TestManagerDeleteRecoversLiveTmuxSessionBeforeLookup(t *testing.T) {
	m := NewManager(true, "/bin/cat", false, "")
	m.liveTmuxSessions = func() (map[string]tmuxSessionInfo, bool) {
		return map[string]tmuxSessionInfo{
			"recovered": {workdir: t.TempDir(), mode: string(protocol.SessionModeNormal)},
		}, true
	}

	if err := m.Delete("recovered"); err != nil {
		t.Fatalf("Delete recovered session: %v", err)
	}
	if _, ok := m.Get("recovered"); ok {
		t.Fatal("recovered session remains registered after delete")
	}
}

func TestManagerDeleteRecoveredCleanWorktreeRemovesGitResources(t *testing.T) {
	repo := tempRepo(t)
	created, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "recovered-clean"})
	meta, mapped := created.Meta, created.Workdir
	if err != nil {
		t.Fatal(err)
	}

	m := NewManager(true, "/bin/cat", false, "")
	m.sessions["recovered-clean"] = &Runner{ID: "recovered-clean", Mode: string(protocol.SessionModeNormal), useTmux: true}
	m.liveTmuxSessions = func() (map[string]tmuxSessionInfo, bool) {
		return map[string]tmuxSessionInfo{
			"recovered-clean": {
				workdir: mapped, mode: string(protocol.SessionModeWorktree),
				sourceWorkdir: meta.SourceWorkdir, sourceRepo: meta.SourceRepo,
				worktreeRoot: meta.WorktreeRoot, branch: meta.Branch,
			},
		}, true
	}

	if err := m.Delete("recovered-clean"); err != nil {
		t.Fatalf("Delete recovered worktree: %v", err)
	}
	if _, err := os.Stat(meta.WorktreeRoot); !os.IsNotExist(err) {
		t.Fatalf("recovered worktree still exists: %v", err)
	}
	if got := runGit(t, repo, "branch", "--list", meta.Branch); got != "" {
		t.Fatalf("recovered worktree branch still exists: %q", got)
	}
}

func TestManagerDeleteDirtyWorktreeStopsSessionAndPreservesGitResources(t *testing.T) {
	repo := tempRepo(t)
	m := NewManager(false, "/bin/cat", false, "")
	r, err := m.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r.WorktreeRoot, "changed"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}

	err = m.Delete(r.ID)
	var preserved *WorktreePreservedError
	if !errors.As(err, &preserved) {
		t.Fatalf("err = %T %v, want WorktreePreservedError", err, err)
	}
	if _, ok := m.Get(r.ID); !ok {
		t.Fatal("preserved worktree metadata was discarded")
	}
	if _, err := os.Stat(r.WorktreeRoot); err != nil {
		t.Fatalf("worktree not preserved: %v", err)
	}
	if got := runGit(t, repo, "branch", "--list", r.Branch); !strings.Contains(got, r.Branch) {
		t.Fatalf("branch not preserved: %q", got)
	}
	if err := os.Remove(filepath.Join(r.WorktreeRoot, "changed")); err != nil {
		t.Fatal(err)
	}
	if err := m.Delete(r.ID); err != nil {
		t.Fatalf("retry delete: %v", err)
	}
	if _, ok := m.Get(r.ID); ok {
		t.Fatal("metadata remains after successful retry")
	}
}

func TestRunnerMetadataNormalizesEmptyMode(t *testing.T) {
	r := &Runner{
		Mode:          "",
		SourceWorkdir: "/src",
		SourceRepo:    "/repo",
		WorktreeRoot:  "/repo-worktrees/s1",
		Branch:        "vibe/s1",
	}
	got := r.Metadata()
	if got.Mode != protocol.SessionModeNormal {
		t.Fatalf("mode = %q, want %q", got.Mode, protocol.SessionModeNormal)
	}
	if got.SourceWorkdir != r.SourceWorkdir || got.SourceRepo != r.SourceRepo || got.WorktreeRoot != r.WorktreeRoot || got.Branch != r.Branch {
		t.Fatalf("metadata worktree fields changed: %#v", got)
	}
}

func TestParseTmuxSessionLinePreservesMetadataFields(t *testing.T) {
	line := "vibe-remote-s1\t/src\tname\tworktree\t/source\t/repo\t/repo-worktrees/s1\tvibe/s1"
	got, ok := parseTmuxSessionLine(line)
	if !ok {
		t.Fatal("parseTmuxSessionLine rejected valid line")
	}
	if got.workdir != "/src" || got.name != "name" || got.mode != "worktree" || got.sourceWorkdir != "/source" || got.sourceRepo != "/repo" || got.worktreeRoot != "/repo-worktrees/s1" || got.branch != "vibe/s1" {
		t.Fatalf("parsed fields = %#v", got)
	}
}

func TestParseTmuxSessionLineKeepsEmptyTrailingFields(t *testing.T) {
	_, ok := parseTmuxSessionLine("vibe-remote-s1\t/src\t\t\t\t\t\t")
	if !ok {
		t.Fatal("parseTmuxSessionLine rejected line with empty name")
	}
}

func TestParseTmuxSessionLineRejectsEmptySessionID(t *testing.T) {
	if _, ok := parseTmuxSessionLine("vibe-remote-\t/src\t\t\t\t\t\t"); ok {
		t.Fatal("parser accepted empty session ID")
	}
}

func TestParseTmuxSessionLineRejectsMalformedFieldCount(t *testing.T) {
	if _, ok := parseTmuxSessionLine("vibe-remote-s1\t/src\t"); ok {
		t.Fatal("parser accepted malformed field count")
	}
}

func TestReconcileTmuxSessionsAppliesWorktreeMetadataToExistingRunner(t *testing.T) {
	r := &Runner{ID: "s1", Workdir: "/kept"}
	sessions := map[string]*Runner{"s1": r}
	info := tmuxSessionInfo{workdir: "/tmux", mode: "worktree", sourceWorkdir: "/source", sourceRepo: "/repo", worktreeRoot: "/tree", branch: "vibe/s1"}

	reconcileTmuxSessions(sessions, map[string]tmuxSessionInfo{"s1": info}, time.Unix(42, 0), NewManager(true, "claude", true, "/bin/sh").recoveredRunner)

	if r.Workdir != "/kept" {
		t.Fatalf("existing runner workdir = %q, want preserved workdir", r.Workdir)
	}
	assertRunnerWorktreeMetadata(t, r, info)
}

func TestReconcileTmuxSessionsDoesNotEraseAuthoritativeWorktreeMetadata(t *testing.T) {
	r := &Runner{ID: "s1", Workdir: "/tree/sub", Mode: "worktree", SourceWorkdir: "/repo/sub", SourceRepo: "/repo", WorktreeRoot: "/tree", Branch: "vibe/s1"}
	sessions := map[string]*Runner{"s1": r}

	// A tmux snapshot can observe the session before all user options are visible.
	reconcileTmuxSessions(sessions, map[string]tmuxSessionInfo{"s1": {workdir: "/tree/sub"}}, time.Unix(42, 0), NewManager(true, "claude", true, "/bin/sh").recoveredRunner)

	got := r.Metadata()
	if got.Mode != protocol.SessionModeWorktree || got.SourceWorkdir != "/repo/sub" || got.SourceRepo != "/repo" || got.WorktreeRoot != "/tree" || got.Branch != "vibe/s1" {
		t.Fatalf("authoritative metadata erased by incomplete tmux snapshot: %#v", got)
	}
}

func TestManagerListReplacesRecoveredDefaultModeWithCompleteWorktreeMetadata(t *testing.T) {
	m := NewManager(true, "claude", false, "/bin/sh")
	m.sessions["s1"] = &Runner{ID: "s1", Mode: string(protocol.SessionModeNormal), useTmux: true}
	info := tmuxSessionInfo{workdir: "/tree/sub", mode: "worktree", sourceWorkdir: "/repo/sub", sourceRepo: "/repo", worktreeRoot: "/tree", branch: "vibe/s1"}
	m.liveTmuxSessions = func() (map[string]tmuxSessionInfo, bool) {
		return map[string]tmuxSessionInfo{"s1": info}, true
	}

	list := m.List()
	if len(list) != 1 {
		t.Fatalf("list length = %d, want 1", len(list))
	}
	got := list[0].SessionMetadata
	if got.Mode != protocol.SessionModeWorktree || got.SourceWorkdir != info.sourceWorkdir || got.SourceRepo != info.sourceRepo || got.WorktreeRoot != info.worktreeRoot || got.Branch != info.branch {
		t.Fatalf("recovered list metadata = %#v", got)
	}
	readyMetadata := m.sessions["s1"].Metadata()
	if readyMetadata != got {
		t.Fatalf("ready metadata = %#v, want list metadata %#v", readyMetadata, got)
	}
}

func TestReconcileTmuxSessionsAppliesWorktreeMetadataToRecoveredRunner(t *testing.T) {
	sessions := map[string]*Runner{}
	info := tmuxSessionInfo{workdir: "/tmux", mode: "worktree", sourceWorkdir: "/source", sourceRepo: "/repo", worktreeRoot: "/tree", branch: "vibe/s1"}

	reconcileTmuxSessions(sessions, map[string]tmuxSessionInfo{"s1": info}, time.Unix(42, 0), NewManager(true, "claude", true, "/bin/sh").recoveredRunner)

	r, ok := sessions["s1"]
	if !ok {
		t.Fatal("reconciliation did not recover runner")
	}
	assertRunnerWorktreeMetadata(t, r, info)
	if r.Workdir != info.workdir || r.Created != time.Unix(42, 0) {
		t.Fatalf("recovered runner identity fields = %#v", r)
	}
}

func assertRunnerWorktreeMetadata(t *testing.T, r *Runner, info tmuxSessionInfo) {
	t.Helper()
	if r.Mode != info.mode || r.SourceWorkdir != info.sourceWorkdir || r.SourceRepo != info.sourceRepo || r.WorktreeRoot != info.worktreeRoot || r.Branch != info.branch {
		t.Fatalf("runner metadata = %#v, want mode=%q source=%q repo=%q root=%q branch=%q", r.Metadata(), info.mode, info.sourceWorkdir, info.sourceRepo, info.worktreeRoot, info.branch)
	}
}

func TestManagerListSerializesMetadata(t *testing.T) {
	m := newTestManager()
	m.sessions["s1"] = &Runner{ID: "s1", Workdir: "/work", Mode: "worktree", SourceWorkdir: "/source", SourceRepo: "/repo", WorktreeRoot: "/tree", Branch: "vibe/s1"}
	list := m.List()
	if len(list) != 1 {
		t.Fatalf("list length = %d, want 1", len(list))
	}
	got := list[0].SessionMetadata
	if got.Mode != protocol.SessionModeWorktree || got.SourceWorkdir != "/source" || got.SourceRepo != "/repo" || got.WorktreeRoot != "/tree" || got.Branch != "vibe/s1" {
		t.Fatalf("session metadata = %#v", got)
	}
}

func TestSanitizeSessionName(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"plain", "my session", "my session"},
		{"trim spaces", "  hi  ", "hi"},
		{"strip newline", "a\nb", "ab"},
		{"strip tab and cr", "a\tb\rc", "abc"},
		{"strip ansi esc", "a\x1b[31mb", "ab"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeSessionName(tt.in); got != tt.want {
				t.Errorf("sanitizeSessionName(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestSanitizeSessionNameTruncates(t *testing.T) {
	long := strings.Repeat("x", 300)
	got := sanitizeSessionName(long)
	if len(got) != 200 {
		t.Errorf("expected truncation to 200, got len %d", len(got))
	}
}

func TestTitleFrom(t *testing.T) {
	tests := []struct {
		name    string
		inName  string
		workdir string
		id      string
		want    string
	}{
		{"name wins", "custom", "/home/user/proj", "abc", "custom"},
		{"empty name falls to workdir tail", "", "/home/user/proj", "abc", "proj"},
		{"empty name trailing slash", "", "/home/user/proj/", "abc", "proj"},
		{"empty name empty workdir falls to id", "", "", "abc", "abc"},
		{"whitespace-only workdir root falls to id", "", "/", "abc", "abc"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := titleFrom(tt.inName, tt.workdir, tt.id); got != tt.want {
				t.Errorf("titleFrom(%q, %q, %q) = %q, want %q", tt.inName, tt.workdir, tt.id, got, tt.want)
			}
		})
	}
}

func TestDisplayTitleFallback(t *testing.T) {
	// No tmux available in unit test → readName returns "" → falls back.
	tests := []struct {
		name   string
		runner *Runner
		want   string
	}{
		{"workdir tail", &Runner{ID: "abc", Workdir: "/home/user/proj", useTmux: false}, "proj"},
		{"empty workdir falls to id", &Runner{ID: "abc", Workdir: "", useTmux: false}, "abc"},
		{"trailing slash", &Runner{ID: "abc", Workdir: "/home/user/proj/", useTmux: false}, "proj"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.runner.displayTitle(); got != tt.want {
				t.Errorf("displayTitle() = %q, want %q", got, tt.want)
			}
		})
	}
}

func newTestManager() *Manager {
	return &Manager{
		sessions: map[string]*Runner{},
		subs:     map[string][]chan protocol.NotifyFrame{},
	}
}

func TestPubSubDelivers(t *testing.T) {
	m := newTestManager()
	ch, unsub := m.Subscribe("s1")
	defer unsub()

	m.PublishEvent("s1", protocol.NotifyFrame{Type: protocol.TypeNotify, SessionID: "s1", Kind: "idle"})

	select {
	case f := <-ch:
		if f.Kind != "idle" {
			t.Errorf("kind = %q, want idle", f.Kind)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for event")
	}
}

func TestPubSubMultipleSubscribers(t *testing.T) {
	m := newTestManager()
	ch1, unsub1 := m.Subscribe("s1")
	defer unsub1()
	ch2, unsub2 := m.Subscribe("s1")
	defer unsub2()

	m.PublishEvent("s1", protocol.NotifyFrame{Kind: "waiting"})

	for i, ch := range []<-chan protocol.NotifyFrame{ch1, ch2} {
		select {
		case f := <-ch:
			if f.Kind != "waiting" {
				t.Errorf("subscriber %d kind = %q, want waiting", i, f.Kind)
			}
		case <-time.After(time.Second):
			t.Fatalf("subscriber %d timed out", i)
		}
	}
}

func TestPubSubUnsubscribeRemoves(t *testing.T) {
	m := newTestManager()
	_, unsub := m.Subscribe("s1")
	unsub()

	m.mu.RLock()
	n := len(m.subs["s1"])
	m.mu.RUnlock()
	if n != 0 {
		t.Errorf("after unsubscribe, subs[s1] len = %d, want 0", n)
	}
}

func TestPublishToNoSubscribersIsNoop(t *testing.T) {
	m := newTestManager()
	// Must not panic or block.
	m.PublishEvent("ghost", protocol.NotifyFrame{Kind: "idle"})
}

func TestReloadRequiresTmux(t *testing.T) {
	m := NewManager(false, "claude", true, "/bin/sh")
	if err := m.Reload("session-id", "claude -c"); err == nil || !strings.Contains(err.Error(), "requires tmux") {
		t.Fatalf("Reload() error = %v, want requires tmux", err)
	}
}

// TestPubSubConcurrentPublishUnsubscribe stresses PublishEvent against
// Subscribe/unsub churn on the same sessionID. It reproduces the
// send-on-closed-channel race (publisher sends on a channel a concurrent
// unsub has closed) — before the fix this panics / trips -race; after the
// fix (close under write lock, send under read lock) it stays green.
func TestPubSubConcurrentPublishUnsubscribe(t *testing.T) {
	m := newTestManager()
	const sid = "s1"

	var wg sync.WaitGroup
	stop := make(chan struct{})

	// Publishers: hammer PublishEvent concurrently.
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					m.PublishEvent(sid, protocol.NotifyFrame{Kind: "idle"})
				}
			}
		}()
	}

	// Subscriber churn: repeatedly Subscribe then immediately unsub, draining
	// whatever arrived so a full buffer never stalls the loop.
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 2000; j++ {
				ch, unsub := m.Subscribe(sid)
				select {
				case <-ch:
				default:
				}
				unsub()
			}
		}()
	}

	// Let publishers run until the churn goroutines finish, then stop them.
	go func() {
		// Wait only for the churn goroutines by observing a separate group.
		time.Sleep(200 * time.Millisecond)
		close(stop)
	}()

	wg.Wait()
}

// TestIsNoTmuxServerDistinguishesEmptyFromFailure pins the stderr check that
// decides whether a non-zero `tmux list-sessions` means "nothing is running" or
// "the query failed". tmux uses a non-zero exit for both, so only stderr tells
// them apart — and mistaking a failure for an empty set makes reconcile evict
// every live session from the in-memory table.
func TestIsNoTmuxServerDistinguishesEmptyFromFailure(t *testing.T) {
	cases := []struct {
		name   string
		stderr string
		want   bool
	}{
		{"no server running", "no server running on /tmp/tmux-501/vibe-remote\n", true},
		{"no sessions", "no sessions\n", true},
		{"socket missing", "error connecting to /tmp/tmux-501/vibe-remote (No such file or directory)\n", false},
		{"not a socket", "error connecting to /tmp/x (Socket operation on non-socket)\n", false},
		{"permission denied", "error connecting to /tmp/x (Permission denied)\n", false},
		{"empty stderr", "", false},
	}
	for _, c := range cases {
		if got := isNoTmuxServer([]byte(c.stderr)); got != c.want {
			t.Errorf("%s: isNoTmuxServer(%q) = %v, want %v", c.name, c.stderr, got, c.want)
		}
	}
}

// TestListKeepsSessionsWhenTmuxQueryFails guards the fallback: a failed query
// must leave the in-memory sessions alone rather than reporting an empty list.
func TestListKeepsSessionsWhenTmuxQueryFails(t *testing.T) {
	m := NewManager(true, "/bin/cat", false, "")
	m.sessions["alive"] = &Runner{ID: "alive", Workdir: t.TempDir(), useTmux: true}
	m.liveTmuxSessions = func() (map[string]tmuxSessionInfo, bool) {
		return nil, false // query failed — we cannot tell what is running
	}

	list := m.List()
	if len(list) != 1 || list[0].ID != "alive" {
		t.Fatalf("List() = %+v, want the in-memory session preserved on query failure", list)
	}
	if _, ok := m.Get("alive"); !ok {
		t.Error("session was evicted from the table despite an inconclusive tmux query")
	}
}

// --- T2: session attribution (home) and creation time ---

func createdByID(list []protocol.SessionInfo) map[string]string {
	m := map[string]string{}
	for _, s := range list {
		m[s.ID] = s.Created
	}
	return m
}

func TestCreateSessionWhenGitFailsLeavesHomeEmpty(t *testing.T) {
	dir := t.TempDir()
	writeFakeGit(t, dir, "#!/bin/sh\nexec sleep 5\n")
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	old := gitTimeout
	gitTimeout = 50 * time.Millisecond
	defer func() { gitTimeout = old }()

	m := NewManager(false, "/bin/cat", false, "")
	r, err := m.Create(CreateOptions{Workdir: t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Kill() })
	if p, h := r.Home(); p != "" || h != "" {
		t.Fatalf("home should be empty on git failure, got project=%q home=%q", p, h)
	}
}

func TestWorktreeModeHome(t *testing.T) {
	repo := tempRepo(t)
	m := NewManager(false, "/bin/cat", false, "")
	r, err := m.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Kill() })
	canon := runGit(t, repo, "rev-parse", "--show-toplevel")
	p, h := r.Home()
	if p != canon {
		t.Fatalf("project=%q want %q", p, canon)
	}
	if h != r.WorktreeRoot {
		t.Fatalf("home=%q want %q (worktree root)", h, r.WorktreeRoot)
	}

	t.Run("single", func(t *testing.T) {
		root := t.TempDir()
		gitDir := filepath.Join(root, "gd")
		wt := filepath.Join(root, "wt")
		runGit(t, root, "init", "--separate-git-dir="+gitDir, wt)
		runGit(t, wt, "config", "user.email", "a@b.c")
		runGit(t, wt, "config", "user.name", "a")
		runGit(t, wt, "commit", "--allow-empty", "-m", "init")

		m := NewManager(false, "/bin/cat", false, "")
		r, err := m.Create(CreateOptions{Workdir: wt, Mode: protocol.SessionModeWorktree, Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { r.Kill() })
		p, h := r.Home()
		if p != r.WorktreeRoot || h != r.WorktreeRoot {
			t.Fatalf("single repo: project=%q home=%q both want worktree root %q", p, h, r.WorktreeRoot)
		}
	})
}

func TestCreateInHiddenWorktreeDir(t *testing.T) {
	repo := tempRepo(t)
	base := runGit(t, repo, "rev-parse", "HEAD")
	hidden := filepath.Join(repo, ".devflow-tmp", "worktrees", "general-skills")
	runGit(t, repo, "worktree", "add", "-b", "change/general-skills", hidden, base)
	canonHidden := runGit(t, hidden, "rev-parse", "--show-toplevel")

	m := NewManager(false, "/bin/cat", false, "")
	r, err := m.Create(CreateOptions{Workdir: hidden, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Kill() })
	if _, h := r.Home(); h != canonHidden {
		t.Fatalf("home=%q want %q", h, canonHidden)
	}
}

func TestCreatedSurvivesRestartTmux(t *testing.T) {
	requireTmux(t)
	repo := tempRepo(t)
	m1 := NewManager(true, "sleep 30", false, "")
	var ids []string
	for i := 0; i < 2; i++ {
		r, err := m1.Create(CreateOptions{Workdir: repo, Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		id := r.ID
		ids = append(ids, id)
		t.Cleanup(func() { m1.Delete(id) })
	}
	before := createdByID(m1.List())

	m2 := NewManager(true, "sleep 30", false, "")
	after := createdByID(m2.List())
	for _, id := range ids {
		if before[id] == "" || before[id] != after[id] {
			t.Fatalf("created for %s: before=%q after=%q", id, before[id], after[id])
		}
		r1, _ := m1.Get(id)
		r2, ok := m2.Get(id)
		if !ok {
			t.Fatalf("%s not recovered", id)
		}
		if d := r1.Created.Sub(r2.Created); d != 0 {
			t.Fatalf("created delta for %s = %v, want 0", id, d)
		}
	}
}

func TestCreatedFallsBackToTmuxSessionCreated(t *testing.T) {
	requireTmux(t)
	repo := tempRepo(t)
	m1 := NewManager(true, "sleep 30", false, "")
	r, err := m1.Create(CreateOptions{Workdir: repo, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	id := r.ID
	t.Cleanup(func() { m1.Delete(id) })
	// Simulate a pre-upgrade session that never recorded @vibe_remote_created.
	if err := tmuxCmd("set-option", "-t", "vibe-remote-"+id, "-u", "@vibe_remote_created").Run(); err != nil {
		t.Fatalf("unset created option: %v", err)
	}
	time.Sleep(2 * time.Second)

	m2 := NewManager(true, "sleep 30", false, "")
	m2.List()
	r2, ok := m2.Get(id)
	if !ok {
		t.Fatalf("%s not recovered", id)
	}
	if since := time.Since(r2.Created); since < time.Second {
		t.Fatalf("recovered created is %v ago, want >= 1s (should come from session_created)", since)
	}
}

func TestHomeSurvivesRestartTmux(t *testing.T) {
	requireTmux(t)
	repo := tempRepo(t)
	m1 := NewManager(true, "sleep 30", false, "")
	r, err := m1.Create(CreateOptions{Workdir: repo, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	id := r.ID
	t.Cleanup(func() { m1.Delete(id) })
	p1, h1 := r.Home()

	m2 := NewManager(true, "sleep 30", false, "")
	m2.List()
	r2, ok := m2.Get(id)
	if !ok {
		t.Fatalf("%s not recovered", id)
	}
	p2, h2 := r2.Home()
	if p1 == "" || p1 != p2 || h1 != h2 {
		t.Fatalf("home before=(%q,%q) after=(%q,%q)", p1, h1, p2, h2)
	}
}

func TestHomeDoesNotFollowCd(t *testing.T) {
	requireTmux(t)
	repo := tempRepo(t)
	other := t.TempDir()
	canonOther, _ := filepath.EvalSymlinks(other)
	m1 := NewManager(true, "/bin/sh", false, "")
	r, err := m1.Create(CreateOptions{Workdir: repo, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	id := r.ID
	t.Cleanup(func() { m1.Delete(id) })
	_, homeBefore := r.Home()

	if err := tmuxCmd("send-keys", "-t", "vibe-remote-"+id, "cd "+canonOther, "Enter").Run(); err != nil {
		t.Fatalf("send-keys: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		out, _ := tmuxCmd("display-message", "-p", "-t", "vibe-remote-"+id, "#{pane_current_path}").Output()
		if strings.TrimSpace(string(out)) == canonOther {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	m2 := NewManager(true, "/bin/sh", false, "")
	m2.List()
	r2, ok := m2.Get(id)
	if !ok {
		t.Fatalf("%s not recovered", id)
	}
	if got := r2.CurrentWorkdir(); got != canonOther {
		t.Fatalf("workdir = %q, want %q (should follow cd)", got, canonOther)
	}
	if _, h := r2.Home(); h != homeBefore {
		t.Fatalf("home = %q, want %q (must not follow cd)", h, homeBefore)
	}
}

// --- T7: named worktrees through the Manager ---

func TestConcurrentCreateSameNameOneWins(t *testing.T) {
	for round := 0; round < 20; round++ {
		repo := devflowRepo(t)
		m := NewManager(false, "/bin/cat", false, "")
		m.SetProjectStore(NewMemoryProjectStore())
		var wg sync.WaitGroup
		runners := make([]*Runner, 2)
		errs := make([]error, 2)
		for i := range runners {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				runners[i], errs[i] = m.Create(CreateOptions{ID: "race-" + string(rune('a'+i)), Workdir: repo,
					Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login", Cols: 80, Rows: 24})
			}(i)
		}
		wg.Wait()
		won := 0
		for i, err := range errs {
			if err == nil {
				won++
				r := runners[i]
				t.Cleanup(func() { r.Kill() })
				continue
			}
			if !errors.Is(err, ErrWorktreeBranchExists) {
				t.Fatalf("round %d: loser got %v, want ErrWorktreeBranchExists", round, err)
			}
		}
		if won != 1 {
			t.Fatalf("round %d: %d creates succeeded (%v), want exactly one", round, won, errs)
		}
		root := filepath.Join(containerOf(repo), "fix-login")
		if got := runGit(t, root, "symbolic-ref", "HEAD"); got != "refs/heads/fix-login" {
			t.Fatalf("round %d: winner's worktree HEAD = %q", round, got)
		}
		if got := runGit(t, root, "status", "--porcelain"); got != "" {
			t.Fatalf("round %d: winner's worktree is not clean:\n%s", round, got)
		}
		if n := strings.Count(runGit(t, repo, "worktree", "list", "--porcelain"), "branch refs/heads/fix-login"); n != 1 {
			t.Fatalf("round %d: %d worktrees on fix-login, want 1", round, n)
		}
		if entries, _ := os.ReadDir(containerOf(repo)); len(entries) != 1 {
			t.Fatalf("round %d: container holds %d entries, want 1", round, len(entries))
		}
	}
}

func TestNamedWorktreeRolledBackWhenSessionStartFails(t *testing.T) {
	assertNothingLeft := func(t *testing.T, repo string, store *ProjectStore, name string) {
		t.Helper()
		root := filepath.Join(containerOf(repo), name)
		if pathExists(root) || worktreeListed(t, repo, root) || branchOID(t, repo, name) != "" {
			t.Fatalf("%s: the directory, registration or branch is left", name)
		}
		if store.Managed(repo, root, name) {
			t.Fatalf("%s: the creation record is left", name)
		}
	}

	t.Run("terminal", func(t *testing.T) {
		repo := devflowRepo(t)
		store := NewMemoryProjectStore()
		m := NewManager(false, "/definitely/missing-command", false, "")
		m.SetProjectStore(store)
		if _, err := m.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login", Cols: 80, Rows: 24}); err == nil {
			t.Fatal("expected the session start to fail")
		}
		assertNothingLeft(t, repo, store, "fix-login")
		if pathExists(containerOf(repo)) {
			t.Fatal("the container created for this worktree is left")
		}
	})

	t.Run("chat", func(t *testing.T) {
		f := newChatFixture(t, false)
		repo := devflowRepo(t)
		store := NewMemoryProjectStore()
		f.m.SetProjectStore(store)
		_, err := f.m.CreateChat(ChatCreateOptions{ID: newID("wtfail"), Workdir: repo, Mode: protocol.SessionModeWorktree,
			WorktreeName: "fix-login", Parsed: chat.Parsed{Exe: "/definitely/missing/claude"}})
		if err == nil {
			t.Fatal("expected the chat process start to fail")
		}
		assertNothingLeft(t, repo, store, "fix-login")
	})

	// The undo runs inside the repository lock: a create of another name that
	// arrives meanwhile waits, then finds its container intact.
	t.Run("concurrent_create", func(t *testing.T) {
		for round := 0; round < 20; round++ {
			repo := devflowRepo(t)
			store := NewMemoryProjectStore()
			broken := NewManager(false, "/definitely/missing-command", false, "")
			broken.SetProjectStore(store)
			var other *Runner
			var otherErr error
			done := make(chan struct{})
			broken.testUndoLocked = func() {
				go func() {
					defer close(done)
					// Same Manager (same lock table), a command that does start.
					other, otherErr = broken.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, WorktreeName: "other",
						ClaudeCmdOverride: "/bin/cat", Cols: 80, Rows: 24})
				}()
				time.Sleep(30 * time.Millisecond) // let it reach the lock
			}
			if _, err := broken.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login", Cols: 80, Rows: 24}); err == nil {
				t.Fatal("expected the session start to fail")
			}
			select {
			case <-done:
			case <-time.After(20 * time.Second):
				t.Fatalf("round %d: the undo never ran inside the repository lock, or the concurrent create never finished", round)
			}
			if otherErr != nil {
				t.Fatalf("round %d: the concurrent create failed: %v", round, otherErr)
			}
			t.Cleanup(func() { other.Kill() })
			assertNothingLeft(t, repo, store, "fix-login")
			root := filepath.Join(containerOf(repo), "other")
			if got := runGit(t, root, "symbolic-ref", "HEAD"); got != "refs/heads/other" {
				t.Fatalf("round %d: other's worktree HEAD = %q", round, got)
			}
			if !store.Managed(repo, root, "other") {
				t.Fatalf("round %d: other is not recorded as created here", round)
			}
		}
	})
}

func TestNamedWorktreeWithMemoryStore(t *testing.T) {
	repo := devflowRepo(t)
	store := NewMemoryProjectStore()
	m := NewManager(false, "/bin/cat", false, "")
	m.SetProjectStore(store)
	r, err := m.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Kill() })
	root := filepath.Join(containerOf(repo), "fix-login")
	if p, h := r.Home(); p != repo || h != root {
		t.Fatalf("home = %q / %q, want %q / %q", p, h, repo, root)
	}
	if !store.Managed(repo, root, "fix-login") {
		t.Fatal("the worktree is not recorded as created by vibe-remote")
	}
	// A new in-memory store is what a restart with an unwritable state_dir has.
	if NewMemoryProjectStore().Managed(repo, root, "fix-login") {
		t.Fatal("a fresh store should not know the worktree")
	}
}

func TestCreateNamedWorktreeGitFailureLeavesNothing(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("needs a non-writable directory")
	}
	create := func(repo string) (*ProjectStore, error) {
		store := NewMemoryProjectStore()
		m := NewManager(false, "/bin/cat", false, "")
		m.SetProjectStore(store)
		_, err := m.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login", Cols: 80, Rows: 24})
		return store, err
	}

	repo := devflowRepo(t)
	admin := filepath.Join(repo, ".git", "worktrees")
	if err := os.Mkdir(admin, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(admin, 0o755) })
	store, err := create(repo)
	if err == nil {
		t.Fatal("expected git worktree add to fail")
	}
	if errors.Is(err, ErrWorktreeBranchExists) || errors.Is(err, ErrWorktreePathExists) || errors.Is(err, ErrWorktreePathNotAllowed) {
		t.Fatalf("err = %v, want a plain create failure", err)
	}
	if !strings.Contains(err.Error(), "fatal:") {
		t.Fatalf("message %q should carry git's output", err)
	}
	if branchOID(t, repo, "fix-login") != "" || pathExists(filepath.Join(containerOf(repo), "fix-login")) || pathExists(containerOf(repo)) {
		t.Fatal("the branch, the directory or the new container is left")
	}
	if len(store.Worktrees()) != 0 {
		t.Fatalf("store keeps %v", store.Worktrees())
	}

	t.Run("container_readonly", func(t *testing.T) {
		repo := devflowRepo(t)
		if err := os.Mkdir(containerOf(repo), 0o555); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(containerOf(repo), 0o755) })
		store, err := create(repo)
		if err == nil || errors.Is(err, ErrWorktreePathExists) {
			t.Fatalf("err = %v, want a plain create failure", err)
		}
		if branchOID(t, repo, "fix-login") != "" || pathExists(filepath.Join(containerOf(repo), "fix-login")) {
			t.Fatal("the branch or the directory is left")
		}
		if !pathExists(containerOf(repo)) {
			t.Fatal("the pre-existing container was removed")
		}
		if len(store.Worktrees()) != 0 {
			t.Fatalf("store keeps %v", store.Worktrees())
		}
	})
}
