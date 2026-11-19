package session

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

func projectContaining(ps []protocol.Project, id string) *protocol.Project {
	for i := range ps {
		for _, sid := range ps[i].Sessions {
			if sid == id {
				return &ps[i]
			}
		}
		for _, w := range ps[i].Worktrees {
			for _, sid := range w.Sessions {
				if sid == id {
					return &ps[i]
				}
			}
		}
	}
	return nil
}

func TestProjectsWithUnwritableStateDir(t *testing.T) {
	repo := tempRepo(t)
	m := NewManager(false, "/bin/cat", false, "")
	m.SetProjectStore(NewMemoryProjectStore())
	r, err := m.Create(CreateOptions{Workdir: repo, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Kill() })

	ps := m.Projects(nil)
	p := projectContaining(ps, r.ID)
	if p == nil || !p.Git {
		t.Fatalf("session's project = %+v (all: %+v)", p, ps)
	}
}

func TestBackfillRetriesUntilGitWorks(t *testing.T) {
	repo := tempRepo(t)
	origPATH := os.Getenv("PATH")
	slow := t.TempDir()
	writeFakeGit(t, slow, "#!/bin/sh\nexec sleep 5\n")
	t.Setenv("PATH", slow+string(os.PathListSeparator)+origPATH)
	old := gitTimeout
	gitTimeout = 50 * time.Millisecond
	defer func() { gitTimeout = old }()

	m := NewManager(false, "/bin/cat", false, "")
	m.SetProjectStore(NewMemoryProjectStore())
	r, err := m.Create(CreateOptions{Workdir: repo, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Kill() })
	if p, h := r.Home(); p != "" || h != "" {
		t.Fatalf("attribution should be empty while git fails: %q %q", p, h)
	}

	// First read, git still failing: the session sits in a temporary non-git
	// project (its workdir) and nothing is recorded.
	p := projectContaining(m.Projects(nil), r.ID)
	if p == nil || p.Git {
		t.Fatalf("while git fails, project = %+v", p)
	}
	if len(m.projectStore.Projects()) != 0 {
		t.Fatalf("store should be empty while git fails: %v", m.projectStore.Projects())
	}

	// Git recovers: the next read resolves the session and records the project.
	gitTimeout = old
	t.Setenv("PATH", origPATH)
	p = projectContaining(m.Projects(nil), r.ID)
	if p == nil || !p.Git {
		t.Fatalf("after git recovers, project = %+v", p)
	}
	if len(m.projectStore.Projects()) == 0 {
		t.Fatal("recovered git project not recorded")
	}
}

func TestProjectsKeepsRecordCreatedDuringPoll(t *testing.T) {
	repo := tempRepo(t)
	canon := runGit(t, repo, "rev-parse", "--show-toplevel")
	m := NewManager(false, "/bin/cat", false, "")
	m.SetProjectStore(NewMemoryProjectStore())

	wtRoot := filepath.Join(filepath.Dir(canon), filepath.Base(canon)+"-worktrees", "poll")
	m.testAfterWorktreeSnapshot = func() {
		m.testAfterWorktreeSnapshot = nil // once
		runGit(t, repo, "worktree", "add", "-b", "poll", wtRoot, "HEAD")
		m.projectStore.AddWorktree(canon, wtRoot, "poll")
	}
	// A session keeps the project alive.
	r, err := m.Create(CreateOptions{Workdir: repo, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Kill() })

	m.Projects(nil) // the record is added during this call's snapshot gap
	if !m.projectStore.Managed(canon, wtRoot, "poll") {
		t.Fatal("record created during the poll was pruned")
	}
	// Next round: the worktree is in the list and still managed.
	dev := findProject(m.Projects(nil), canon)
	var managed bool
	for _, w := range dev.Worktrees {
		if w.Branch == "poll" && w.Managed {
			managed = true
		}
	}
	if !managed {
		t.Fatalf("poll worktree not managed: %+v", dev.Worktrees)
	}
}

func findProject(ps []protocol.Project, id string) *protocol.Project {
	for i := range ps {
		if ps[i].ID == id {
			return &ps[i]
		}
	}
	return nil
}

func TestSessionsEndpointRunsNoGit(t *testing.T) {
	repo := tempRepo(t)
	m := NewManager(false, "/bin/cat", false, "")
	m.SetProjectStore(NewMemoryProjectStore())
	r, err := m.Create(CreateOptions{Workdir: repo, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Kill() })

	log := installCountingGit(t)
	m.List()
	if n := countLines(t, log); n != 0 {
		t.Fatalf("List() ran %d git processes, want 0", n)
	}
}

func TestProjectsOneGitCallPerProject(t *testing.T) {
	const n = 20
	root := t.TempDir()
	m := NewManager(false, "/bin/cat", false, "")
	m.SetProjectStore(NewMemoryProjectStore())
	var runners []*Runner
	for i := 0; i < n; i++ {
		repo := filepath.Join(root, "repo"+strconv.Itoa(i))
		runGit(t, root, "init", "-b", "main", repo)
		runGit(t, repo, "config", "user.email", "a@b.c")
		runGit(t, repo, "config", "user.name", "a")
		runGit(t, repo, "commit", "--allow-empty", "-m", "init")
		for j := 0; j < 5; j++ {
			wt := filepath.Join(root, "repo"+strconv.Itoa(i)+"-w"+strconv.Itoa(j))
			runGit(t, repo, "worktree", "add", "--detach", wt, "HEAD")
		}
		r, err := m.Create(CreateOptions{Workdir: repo, Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		runners = append(runners, r)
	}
	t.Cleanup(func() {
		for _, r := range runners {
			r.Kill()
		}
	})

	log, maxFile := installCountingGitConcurrency(t)
	m.Projects(nil)
	if got := countLines(t, log); got != n {
		t.Fatalf("Projects() ran %d git processes, want %d", got, n)
	}
	if mx := maxValue(t, maxFile); mx > projectsGitConcurrency {
		t.Fatalf("max concurrent git = %d, want <= %d", mx, projectsGitConcurrency)
	}

	t.Run("unresolved_session", func(t *testing.T) {
		// A workdir whose parent holds an empty .git never resolves.
		bad := filepath.Join(t.TempDir(), "proj")
		if err := os.MkdirAll(filepath.Join(bad, ".git"), 0o755); err != nil {
			t.Fatal(err)
		}
		work := filepath.Join(bad, "work")
		if err := os.MkdirAll(work, 0o755); err != nil {
			t.Fatal(err)
		}
		r, err := m.Create(CreateOptions{Workdir: work, Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { r.Kill() })

		var counts []int
		for round := 0; round < 3; round++ {
			log, _ := installCountingGitConcurrency(t)
			m.Projects(nil)
			counts = append(counts, countLines(t, log))
		}
		for _, c := range counts {
			if c > n+3 {
				t.Fatalf("round ran %d git processes, want <= %d", c, n+3)
			}
			if c != counts[0] {
				t.Fatalf("git process count not stable across rounds: %v", counts)
			}
		}
	})
}

// installCountingGit prepends a git that records each invocation and execs the
// real git. It returns the log path.
func installCountingGit(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls.log")
	real := realGit(t)
	script := "#!/bin/sh\necho c >> '" + log + "'\nexec '" + real + "' \"$@\"\n"
	writeFakeGit(t, dir, script)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return log
}

// installCountingGitConcurrency also samples how many git processes overlap.
func installCountingGitConcurrency(t *testing.T) (log, maxFile string) {
	t.Helper()
	dir := t.TempDir()
	live := filepath.Join(dir, "live")
	if err := os.MkdirAll(live, 0o755); err != nil {
		t.Fatal(err)
	}
	log = filepath.Join(dir, "calls.log")
	maxFile = filepath.Join(dir, "concurrency.log")
	real := realGit(t)
	script := "#!/bin/sh\n" +
		"f=$(mktemp '" + live + "'/l.XXXXXX)\n" +
		"ls '" + live + "' | wc -l >> '" + maxFile + "'\n" +
		"sleep 0.1\n" +
		"rm -f \"$f\"\n" +
		"echo c >> '" + log + "'\n" +
		"exec '" + real + "' \"$@\"\n"
	writeFakeGit(t, dir, script)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	// Which form of the worktree list a git speaks is found out once per git
	// executable (ListWorktrees): with a git before 2.36 the first reading costs
	// one more process, and none after that. This wrapper is a git the process
	// has not used before, and that one process is not part of what a poll
	// costs, so it is spent here, before the counting starts.
	probe := filepath.Join(dir, "probe")
	if out, err := exec.Command(real, "init", "-q", probe).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}
	if _, err := ListWorktrees(probe); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{log, maxFile} {
		if err := os.Remove(f); err != nil {
			t.Fatal(err)
		}
	}
	return log, maxFile
}

func countLines(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0
		}
		t.Fatal(err)
	}
	s := strings.TrimSpace(string(data))
	if s == "" {
		return 0
	}
	return len(strings.Split(s, "\n"))
}

func maxValue(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	max := 0
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if n, err := strconv.Atoi(strings.TrimSpace(line)); err == nil && n > max {
			max = n
		}
	}
	return max
}

func mainWorktreeSessions(ps []protocol.Project, id string) []string {
	p := findProject(ps, id)
	if p == nil {
		return nil
	}
	for _, w := range p.Worktrees {
		if w.Main {
			return w.Sessions
		}
	}
	return nil
}

func TestProjectsOrderSurvivesRestart(t *testing.T) {
	requireTmux(t)
	repo := tempRepo(t)
	canon := runGit(t, repo, "rev-parse", "--show-toplevel")
	state := t.TempDir()

	m1 := NewManager(true, "sleep 30", false, "")
	ps1, err := OpenProjectStore(state)
	if err != nil {
		t.Fatal(err)
	}
	m1.SetProjectStore(ps1)
	for i := 0; i < 2; i++ {
		r, err := m1.Create(CreateOptions{Workdir: repo, Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		id := r.ID
		t.Cleanup(func() { m1.Delete(id) })
	}
	before := mainWorktreeSessions(m1.Projects(nil), canon)
	if len(before) != 2 {
		t.Fatalf("expected 2 sessions, got %v", before)
	}

	// A fresh manager on the same store (daemon restart), no List() first.
	m2 := NewManager(true, "sleep 30", false, "")
	ps2, err := OpenProjectStore(state)
	if err != nil {
		t.Fatal(err)
	}
	m2.SetProjectStore(ps2)
	after := mainWorktreeSessions(m2.Projects(nil), canon)
	if strings.Join(before, ",") != strings.Join(after, ",") {
		t.Fatalf("session order changed: before=%v after=%v", before, after)
	}
}

func TestBackfillHomeForLegacyTmuxSessions(t *testing.T) {
	requireTmux(t)
	repo := tempRepo(t)
	m1 := NewManager(true, "sleep 30", false, "")
	m1.SetProjectStore(NewMemoryProjectStore())
	r, err := m1.Create(CreateOptions{Workdir: repo, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	id := r.ID
	t.Cleanup(func() { m1.Delete(id) })
	// Simulate a pre-upgrade session: no attribution options.
	for _, opt := range []string{"@vibe_remote_project", "@vibe_remote_home"} {
		if err := tmuxCmd("set-option", "-t", "vibe-remote-"+id, "-u", opt).Run(); err != nil {
			t.Fatalf("unset %s: %v", opt, err)
		}
	}

	m2 := NewManager(true, "sleep 30", false, "")
	m2.SetProjectStore(NewMemoryProjectStore())
	m2.List() // recover with empty attribution
	r2, ok := m2.Get(id)
	if !ok {
		t.Fatal("not recovered")
	}
	if p, _ := r2.Home(); p != "" {
		t.Fatalf("attribution should be empty after clearing options, got %q", p)
	}

	ps := m2.Projects(nil)
	if projectContaining(ps, id) == nil {
		t.Fatalf("legacy session not placed: %+v", ps)
	}
	if p, _ := r2.Home(); p == "" {
		t.Fatal("attribution not backfilled")
	}
	if len(m2.projectStore.Projects()) == 0 {
		t.Fatal("backfilled git project not recorded")
	}
}

func TestBackfillHomeForLegacyChatRecords(t *testing.T) {
	repo := tempRepo(t)
	canon := runGit(t, repo, "rev-parse", "--show-toplevel")
	state := t.TempDir()
	store, err := chat.NewStore(state)
	if err != nil {
		t.Fatal(err)
	}
	// A pre-upgrade record with no attribution. Ended, so no process is started.
	rec := chat.Record{ID: "1763000000000-9f3a1c2e", Workdir: repo, Mode: "normal",
		Exe: "claude", ClaudeSessionID: "0b6c0000-0000-4000-8000-000000000000",
		CreatedAt: "2026-11-13T10:00:00Z", Status: chat.StatusEnded, EndReason: protocol.EndReasonExited}
	if err := store.Save([]chat.Record{rec}); err != nil {
		t.Fatal(err)
	}

	m := NewManager(false, "claude", false, "")
	m.SetChatConfig(ChatConfig{ProjectsDir: filepath.Join(state, "projects")})
	m.SetProjectStore(NewMemoryProjectStore())
	if err := m.LoadChats(store); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Shutdown(2 * time.Second) })

	m.mu.RLock()
	got := m.chats[rec.ID].rec
	m.mu.RUnlock()
	if got.Project != canon || got.Home != canon {
		t.Fatalf("record not backfilled on load: %+v", got)
	}
	m.flush()
	recs, err := store.Load()
	if err != nil || len(recs) != 1 || recs[0].Project == "" {
		t.Fatalf("backfill not persisted: %v %+v", err, recs)
	}
}
