package session

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

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
	meta, mapped, err := CreateWorktree(repo, "recovered-clean")
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
	if _, ok := m.Get(r.ID); ok {
		t.Fatal("deleted session remains registered")
	}
	if _, err := os.Stat(r.WorktreeRoot); err != nil {
		t.Fatalf("worktree not preserved: %v", err)
	}
	if got := runGit(t, repo, "branch", "--list", r.Branch); !strings.Contains(got, r.Branch) {
		t.Fatalf("branch not preserved: %q", got)
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

	reconcileTmuxSessions(sessions, map[string]tmuxSessionInfo{"s1": info}, time.Unix(42, 0), true, "claude", "/bin/sh", true)

	if r.Workdir != "/kept" {
		t.Fatalf("existing runner workdir = %q, want preserved workdir", r.Workdir)
	}
	assertRunnerWorktreeMetadata(t, r, info)
}

func TestReconcileTmuxSessionsDoesNotEraseAuthoritativeWorktreeMetadata(t *testing.T) {
	r := &Runner{ID: "s1", Workdir: "/tree/sub", Mode: "worktree", SourceWorkdir: "/repo/sub", SourceRepo: "/repo", WorktreeRoot: "/tree", Branch: "vibe/s1"}
	sessions := map[string]*Runner{"s1": r}

	// A tmux snapshot can observe the session before all user options are visible.
	reconcileTmuxSessions(sessions, map[string]tmuxSessionInfo{"s1": {workdir: "/tree/sub"}}, time.Unix(42, 0), true, "claude", "/bin/sh", true)

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

	reconcileTmuxSessions(sessions, map[string]tmuxSessionInfo{"s1": info}, time.Unix(42, 0), true, "claude", "/bin/sh", true)

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
