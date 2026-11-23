package session

import (
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// A create still in flight when the daemon shuts down must not leave a claude
// process running with no record: Shutdown waits for it, and a create that
// has not started its process yet is refused.
func TestShutdownWaitsForInFlightChatCreate(t *testing.T) {
	f := newChatFixture(t, false)
	repo := tempRepo(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var a ChatAttachment
	var err error
	done := make(chan struct{})
	// The create is held where it used to be: after its worktree exists. The
	// path is checked once before that too (it does not exist yet then).
	var hold sync.Once
	go func() {
		defer close(done)
		a, err = f.m.CreateChat(ChatCreateOptions{ID: newID("shutdown-create"), Workdir: repo,
			Mode: protocol.SessionModeWorktree, Parsed: parsed(t, f.exe),
			ValidateWorkdir: func(path string) (string, error) {
				if _, statErr := os.Stat(path); statErr == nil {
					hold.Do(func() {
						close(entered)
						<-release
					})
				}
				return path, nil
			}})
	}()
	<-entered
	shutdownDone := make(chan struct{})
	go func() {
		f.m.Shutdown(5 * time.Second)
		close(shutdownDone)
	}()
	select {
	case <-shutdownDone:
	case <-time.After(300 * time.Millisecond):
	}
	close(release)
	<-done
	<-shutdownDone

	recs, loadErr := f.m.store.Load()
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if err == nil {
		defer f.m.Delete(a.ID)
		if info := a.Session.Snapshot(); info.Pid != 0 {
			t.Fatalf("shutdown returned while the created chat's process %d still runs (status %s, %d saved records)",
				info.Pid, info.Status, len(recs))
		}
		if len(recs) != 1 {
			t.Fatalf("created chat missing from the final table: %+v", recs)
		}
	} else if !errors.Is(err, ErrShuttingDown) {
		t.Fatalf("create during shutdown: %v, want ErrShuttingDown", err)
	}
	for _, r := range recs {
		if r.Status == chat.StatusRunning {
			t.Fatalf("record %s saved as running after shutdown", r.ID)
		}
	}
}

func TestCreateChatAfterShutdownFails(t *testing.T) {
	f := newChatFixture(t, false)
	f.m.Shutdown(time.Second)
	if _, err := f.create(f.m, newID("after-shutdown"), f.workdir(), ""); !errors.Is(err, ErrShuttingDown) {
		t.Fatalf("create after shutdown: %v, want ErrShuttingDown", err)
	}
	if lines := f.argvLines(); len(lines) != 0 {
		t.Fatalf("claude started after shutdown: %v", lines)
	}
}
