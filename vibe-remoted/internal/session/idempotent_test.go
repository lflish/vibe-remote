package session

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// A client that loses its connection between sending a create-attach and
// receiving `ready` replays the same attach. With a client-chosen id the
// replay must land on the session the first attempt created — before, it
// created a second session, and in worktree mode a second worktree + branch
// that nothing ever cleaned up.
func TestCreateWithSameIDAttachesInsteadOfCreatingTwice(t *testing.T) {
	requireTmux(t)
	repo := tempRepo(t)
	m := NewManager(true, "sleep 30", false, "")
	id := fmt.Sprintf("idem-%d", time.Now().UnixNano())

	first, err := m.Create(CreateOptions{ID: id, Workdir: repo, Mode: protocol.SessionModeWorktree, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	t.Cleanup(func() { m.Delete(id) })
	if first.ID != id {
		t.Fatalf("id = %q, want the client-chosen %q", first.ID, id)
	}

	replay, err := m.Create(CreateOptions{ID: id, Workdir: repo, Mode: protocol.SessionModeWorktree, Cols: 100, Rows: 30})
	if err != nil {
		t.Fatalf("replayed create: %v", err)
	}
	if replay != first {
		t.Fatal("replayed create returned a different runner")
	}
	if got := runGit(t, repo, "branch", "--list", "--format=%(refname:short)", "vibe/*"); got != "vibe/"+id {
		t.Fatalf("branches after replay = %q, want only vibe/%s", got, id)
	}
	container := filepath.Join(filepath.Dir(repo), filepath.Base(repo)+"-worktrees")
	if entries, _ := os.ReadDir(container); len(entries) != 1 {
		t.Fatalf("worktrees after replay = %d, want 1", len(entries))
	}
}

// After a daemon restart the table is empty, but tmux still has the session the
// first attempt created. The replay must recover it, not create a new one.
func TestCreateWithIDRecoversSessionMissingFromTable(t *testing.T) {
	requireTmux(t)
	id := fmt.Sprintf("idem-recover-%d", time.Now().UnixNano())
	startTmuxSession(t, "vibe-remote-"+id, "sleep", "30")

	m := NewManager(true, "sleep 30", false, "")
	r, err := m.Create(CreateOptions{ID: id, Workdir: t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Cleanup(func() { r.DetachEpoch(r.CurrentEpoch()) })
	if r.ID != id {
		t.Fatalf("id = %q, want %q", r.ID, id)
	}
	if n := len(m.List()); n != 1 {
		t.Fatalf("sessions = %d, want 1 (the recovered one)", n)
	}
}

// Two creates with one id racing each other (the replay arriving while the
// first attempt is still in CreateWorktree) must not both create.
func TestBeginCreateSerializesSameID(t *testing.T) {
	m := newTestManager()
	done, exists := m.beginCreate("s1")
	if exists || done == nil {
		t.Fatal("first claim should own the id")
	}

	var wg sync.WaitGroup
	wg.Add(1)
	var secondExists bool
	go func() {
		defer wg.Done()
		_, secondExists = m.beginCreate("s1")
	}()

	time.Sleep(50 * time.Millisecond) // let the second claim block
	m.mu.Lock()
	m.sessions["s1"] = &Runner{ID: "s1"}
	m.mu.Unlock()
	done()
	wg.Wait()

	if !secondExists {
		t.Fatal("second claim did not see the session the first one registered")
	}
	if len(m.creating) != 0 {
		t.Fatalf("creating map not cleaned up: %v", m.creating)
	}
}

// A failed create releases the id so a later attempt can retry it.
func TestBeginCreateReleasesIDAfterFailure(t *testing.T) {
	m := newTestManager()
	done, _ := m.beginCreate("s1")
	done() // create failed: nothing registered

	again, exists := m.beginCreate("s1")
	if exists || again == nil {
		t.Fatal("id stayed claimed after a failed create")
	}
	again()
}

func TestCreateRejectsUnsafeID(t *testing.T) {
	m := NewManager(false, "/bin/cat", false, "")
	tooLong := strings.Repeat("a", maxSessionIDLen+1)
	for _, id := range []string{"../x", "a b", "a;b", "a/b", tooLong} {
		if _, err := m.Create(CreateOptions{ID: id, Workdir: t.TempDir(), Cols: 80, Rows: 24}); !errors.Is(err, ErrInvalidSessionID) {
			t.Errorf("Create(ID=%q) err = %v, want ErrInvalidSessionID", id, err)
		}
	}
}

// Without tmux the CLI dies with its PTY, so a reconnect has nothing to attach
// to. That must surface as not-found (fatal for the client), not as a generic
// failure the client would retry forever.
func TestAttachWithoutTmuxIsNotFound(t *testing.T) {
	m := NewManager(false, "/bin/cat", false, "")
	if _, err := m.Attach("anything", 80, 24); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("err = %v, want ErrSessionNotFound", err)
	}
}
