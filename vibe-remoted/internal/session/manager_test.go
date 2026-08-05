package session

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

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
