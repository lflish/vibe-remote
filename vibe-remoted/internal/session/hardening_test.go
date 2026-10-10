package session

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

func TestHookTokenIsPerSessionAndNotTheMainToken(t *testing.T) {
	const main = "main-token-0123456789abcdef"
	a := HookToken(main, "s1")
	if a != HookToken(main, "s1") {
		t.Fatal("HookToken is not deterministic")
	}
	if len(a) != 64 {
		t.Fatalf("HookToken length = %d, want 64 hex chars", len(a))
	}
	if a == main || strings.Contains(a, main) {
		t.Fatal("HookToken leaks the main token")
	}
	if a == HookToken(main, "s2") {
		t.Fatal("two sessions share a hook token")
	}
	if a == HookToken("other-main-token-0123456789", "s1") {
		t.Fatal("rotating the main token did not change the hook token")
	}
}

// The agent process (and everything it spawns) can read its environment, so
// the main token — full shell access via attach — must never land there.
func TestRunnerEnvCarriesHookTokenNotMainToken(t *testing.T) {
	const main = "main-token-0123456789abcdef"
	m := NewManager(true, "claude", false, "")
	m.SetEventEnv("http://127.0.0.1:8765/api/v1/events", main)
	r := m.recoveredRunner("s1", tmuxSessionInfo{workdir: "/w"}, time.Now())

	env := strings.Join(r.vibeRemoteEnv(), "\n")
	if strings.Contains(env, main) {
		t.Fatalf("main token injected into session env:\n%s", env)
	}
	if !strings.Contains(env, "VIBE_REMOTE_TOKEN="+HookToken(main, "s1")) {
		t.Fatalf("hook token missing from session env:\n%s", env)
	}
	args := strings.Join(r.tmuxEnvArgs(), " ")
	if !strings.Contains(args, "-e VIBE_REMOTE_SESSION_ID=s1") {
		t.Fatalf("tmux env args = %q, want -e VIBE_REMOTE_SESSION_ID=s1", args)
	}
}

// tmux builds a pane's environment from its server, and a running server was
// seeded by whichever client started it. Before -e was passed explicitly, the
// second session on the socket saw the first session's VIBE_REMOTE_SESSION_ID,
// so its hooks reported events against the wrong session.
func TestTmuxSessionsEachSeeTheirOwnEnv(t *testing.T) {
	requireTmux(t)
	const main = "main-token-0123456789abcdef"
	m := NewManager(true, `sh -c 'printf "%s %s" "$VIBE_REMOTE_SESSION_ID" "$VIBE_REMOTE_TOKEN" > env.out; exec sleep 30'`, false, "")
	m.SetEventEnv("http://127.0.0.1:8765/api/v1/events", main)

	var runners []*Runner
	for i := 0; i < 2; i++ {
		r, err := m.Create(CreateOptions{Workdir: t.TempDir(), Cols: 80, Rows: 24})
		if err != nil {
			t.Fatalf("create session %d: %v", i, err)
		}
		t.Cleanup(func() { r.Kill() })
		runners = append(runners, r)
	}

	for _, r := range runners {
		out := waitForFile(t, filepath.Join(r.CurrentWorkdir(), "env.out"))
		want := r.ID + " " + HookToken(main, r.ID)
		if out != want {
			t.Errorf("session %s saw env %q, want %q", r.ID, out, want)
		}
	}
}

func waitForFile(t *testing.T, path string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		data, err := os.ReadFile(path)
		if err == nil && len(data) > 0 {
			return string(data)
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s was not written: %v", path, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A name that looks like a flag must be stored verbatim, not parsed by tmux.
func TestSetNameStoresFlagLikeNames(t *testing.T) {
	requireTmux(t)
	id := fmt.Sprintf("setname-%d", time.Now().UnixNano())
	startTmuxSession(t, "vibe-remote-"+id, "sleep", "30")

	r := &Runner{ID: id, useTmux: true}
	for _, name := range []string{"-g", "-u", "plain name"} {
		if err := r.SetName(name); err != nil {
			t.Fatalf("SetName(%q): %v", name, err)
		}
		if got := r.readName(); got != name {
			t.Fatalf("readName after SetName(%q) = %q", name, got)
		}
	}
	if err := r.SetName(""); err != nil {
		t.Fatalf("SetName(\"\"): %v", err)
	}
	if got := r.readName(); got != "" {
		t.Fatalf("readName after clearing = %q, want empty", got)
	}
}

// The source directory was validated by the caller, but the worktree is
// created next to the repo root and may fall outside the allowed roots.
func TestManagerCreateWorktreeRollsBackWhenWorkdirRejected(t *testing.T) {
	repo := tempRepo(t)
	container := filepath.Join(filepath.Dir(repo), filepath.Base(repo)+"-worktrees")
	m := NewManager(false, "/bin/cat", false, "")

	var checked string
	_, err := m.Create(CreateOptions{
		Workdir: repo, Mode: protocol.SessionModeWorktree, Cols: 80, Rows: 24,
		ValidateWorkdir: func(dir string) (string, error) {
			checked = dir
			return "", errors.New("workdir not in allowed roots")
		},
	})
	if err == nil {
		t.Fatal("expected Create to fail when the worktree workdir is rejected")
	}
	// CreateWorktree returns a canonical path (/private/var/... on macOS), so
	// compare by the container's name rather than its full path.
	if !strings.Contains(checked, string(filepath.Separator)+filepath.Base(container)+string(filepath.Separator)) {
		t.Fatalf("validated %q, want the created worktree under %q", checked, container)
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
	if len(m.sessions) != 0 {
		t.Fatalf("rejected session was registered: %v", m.sessions)
	}
}

// Two attaches to the same not-yet-registered session (daemon just restarted)
// must end up with one Runner. Two would each install a PTY and fight over the
// epoch, so one client's relay would be torn down by the other.
func TestLookupOrRecoverSharesRunnerAcrossConcurrentRecovery(t *testing.T) {
	m := NewManager(true, "claude", false, "")
	var arrived sync.WaitGroup
	arrived.Add(2)
	m.liveTmuxSessions = func() (map[string]tmuxSessionInfo, bool) {
		// Hold both queries until both have started, so both callers miss the
		// table and race to register.
		arrived.Done()
		arrived.Wait()
		return map[string]tmuxSessionInfo{"s1": {workdir: "/w"}}, true
	}

	var wg sync.WaitGroup
	got := make([]*Runner, 2)
	for i := range got {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r, err := m.lookupOrRecover("s1")
			if err != nil {
				t.Errorf("lookupOrRecover: %v", err)
			}
			got[i] = r
		}(i)
	}
	wg.Wait()
	if got[0] == nil || got[0] != got[1] {
		t.Fatalf("concurrent recovery produced distinct runners: %p vs %p", got[0], got[1])
	}
}

// A tmux exec can take arbitrarily long; holding Manager.mu across it stalls
// every Get/Attach/Subscribe/PublishEvent behind the sidebar poll.
func TestListQueriesTmuxWithoutHoldingManagerLock(t *testing.T) {
	m := NewManager(true, "claude", false, "")
	m.liveTmuxSessions = func() (map[string]tmuxSessionInfo, bool) {
		if !m.mu.TryLock() {
			t.Error("Manager.mu is held during the tmux query")
		} else {
			m.mu.Unlock()
		}
		return map[string]tmuxSessionInfo{}, true
	}
	m.List()
}

// With the query outside the lock, a session created while it is in flight is
// missing from the snapshot. Applying that snapshot would evict the new session
// and replace it with a recovered stand-in on the next poll.
func TestListDoesNotApplySnapshotThatPredatesCreate(t *testing.T) {
	m := NewManager(true, "claude", false, "")
	created := &Runner{ID: "new", Workdir: "/w", useTmux: true}
	m.liveTmuxSessions = func() (map[string]tmuxSessionInfo, bool) {
		// Simulate Create registering a session mid-query.
		m.mu.Lock()
		m.sessions["new"] = created
		m.gen++
		m.mu.Unlock()
		return map[string]tmuxSessionInfo{}, true
	}

	m.List()
	if r, ok := m.Get("new"); !ok || r != created {
		t.Fatalf("session created during the tmux query was evicted (got %p, ok=%v)", r, ok)
	}
}

// Exercises List's reconcile, recovery, metadata writes and readers at once;
// the value is in running it under -race.
func TestManagerConcurrentListAttachMetadataIsRaceFree(t *testing.T) {
	m := NewManager(true, "claude", false, "")
	// Pre-registered runners with empty metadata, so reconcile actually writes
	// fields while readers read them.
	for i := 0; i < 4; i++ {
		id := fmt.Sprintf("s%d", i)
		m.sessions[id] = &Runner{ID: id, useTmux: true}
	}
	var calls atomic.Int64
	m.liveTmuxSessions = func() (map[string]tmuxSessionInfo, bool) {
		n := calls.Add(1)
		live := map[string]tmuxSessionInfo{}
		for i := 0; i < 4; i++ {
			id := fmt.Sprintf("s%d", i)
			info := tmuxSessionInfo{workdir: "/w/" + id, mode: "normal"}
			if n%2 == 0 {
				info = tmuxSessionInfo{workdir: "/tree/" + id, mode: "worktree", sourceWorkdir: "/repo", sourceRepo: "/repo", worktreeRoot: "/tree/" + id, branch: "vibe/" + id}
			}
			live[id] = info
		}
		// "flaky" comes and goes so reconcile also deletes and recovers.
		if n%3 != 0 {
			live["flaky"] = tmuxSessionInfo{workdir: "/w/flaky"}
		}
		return live, true
	}

	const iterations = 200
	var wg sync.WaitGroup
	run := func(f func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < iterations; i++ {
				f()
			}
		}()
	}
	run(func() { m.List() })
	run(func() { m.List() })
	run(func() { _, _ = m.lookupOrRecover("flaky") })
	run(func() {
		for i := 0; i < 4; i++ {
			if r, ok := m.Get(fmt.Sprintf("s%d", i)); ok {
				_ = r.Metadata()
				_ = r.CurrentWorkdir()
			}
		}
	})
	wg.Wait()
}
