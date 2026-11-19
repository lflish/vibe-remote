package session

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func tempRepo(t *testing.T) string {
	t.Helper()
	d := t.TempDir()
	runGit(t, d, "init")
	runGit(t, d, "config", "user.email", "test@example.com")
	runGit(t, d, "config", "user.name", "Test User")
	if err := os.WriteFile(filepath.Join(d, "README"), []byte("initial\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, d, "add", "README")
	runGit(t, d, "commit", "-m", "initial")
	return d
}

func TestWorktreeRepositoryRootSelection(t *testing.T) {
	repo := tempRepo(t)
	sub := filepath.Join(repo, "nested")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	created, err := CreateWorktree(WorktreeSpec{Source: sub, SessionID: "abc123"})
	meta, mapped := created.Meta, created.Workdir
	if err != nil {
		t.Fatal(err)
	}
	defer created.Undo()
	canonicalRepo := runGit(t, sub, "rev-parse", "--show-toplevel")
	if meta.SourceRepo != canonicalRepo {
		t.Fatalf("meta=%+v mapped=%q", meta, mapped)
	}
	if mapped != filepath.Join(meta.WorktreeRoot, "nested") {
		t.Fatalf("mapped=%q", mapped)
	}
}

func TestWorktreeRejectsUnsafeSessionIDBeforeFilesystemAccess(t *testing.T) {
	repo := tempRepo(t)
	container := filepath.Join(filepath.Dir(repo), filepath.Base(repo)+"-worktrees")
	outside := filepath.Join(filepath.Dir(container), "escape")

	for _, sessionID := range []string{"", ".", "..", "../escape", "../../tmp", "/absolute", `back\\slash`} {
		t.Run(sessionID, func(t *testing.T) {
			_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: sessionID})
			if err == nil || !strings.Contains(err.Error(), "invalid session ID") {
				t.Fatalf("err=%v", err)
			}
		})
	}
	if _, err := os.Stat(container); !os.IsNotExist(err) {
		t.Fatalf("worktree container was touched: %v", err)
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("outside path was touched: %v", err)
	}
	if got := runGit(t, repo, "worktree", "list", "--porcelain"); strings.Count(got, "worktree ") != 1 {
		t.Fatalf("unexpected worktree created:\n%s", got)
	}
}

func TestWorktreeUsesCanonicalRepoRootForSymlinkAlias(t *testing.T) {
	repo := tempRepo(t)
	alias := filepath.Join(filepath.Dir(repo), "repo-alias")
	if err := os.Symlink(repo, alias); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	canonicalRoot := runGit(t, alias, "rev-parse", "--show-toplevel")

	created, err := CreateWorktree(WorktreeSpec{Source: alias, SessionID: "symlinked"})
	meta, mapped := created.Meta, created.Workdir
	if err != nil {
		t.Fatal(err)
	}
	defer created.Undo()
	if meta.SourceRepo != canonicalRoot {
		t.Fatalf("SourceRepo=%q want canonical git root %q", meta.SourceRepo, canonicalRoot)
	}
	wantRoot := filepath.Join(filepath.Dir(canonicalRoot), filepath.Base(canonicalRoot)+"-worktrees", "symlinked")
	if meta.WorktreeRoot != wantRoot {
		t.Fatalf("WorktreeRoot=%q want %q", meta.WorktreeRoot, wantRoot)
	}
	if mapped != wantRoot {
		t.Fatalf("mapped=%q want %q", mapped, wantRoot)
	}
}

func TestWorktreeNestedSubdirectoryMapping(t *testing.T) {
	repo := tempRepo(t)
	sub := filepath.Join(repo, "a", "b")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	created, err := CreateWorktree(WorktreeSpec{Source: sub, SessionID: "nested"})
	meta, mapped := created.Meta, created.Workdir
	if err != nil {
		t.Fatal(err)
	}
	defer created.Undo()
	expected := filepath.Join(meta.WorktreeRoot, "a", "b")
	if mapped != expected {
		t.Fatalf("mapped=%q want %q", mapped, expected)
	}
	if info, err := os.Stat(mapped); err != nil || !info.IsDir() {
		t.Fatalf("mapped workdir was not preserved as a directory: info=%v err=%v", info, err)
	}
}

func TestWorktreeRejectsNonGitDirectory(t *testing.T) {
	_, err := CreateWorktree(WorktreeSpec{Source: t.TempDir(), SessionID: "nope"})
	if err == nil || !strings.Contains(err.Error(), "discover repository") {
		t.Fatalf("err=%v", err)
	}
}

func TestWorktreeGeneratedBranchAndPath(t *testing.T) {
	repo := tempRepo(t)
	created, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "session-1"})
	meta := created.Meta
	if err != nil {
		t.Fatal(err)
	}
	defer created.Undo()
	if meta.Branch != "vibe/session-1" {
		t.Fatal(meta.Branch)
	}
	canonicalRepo := runGit(t, repo, "rev-parse", "--show-toplevel")
	if want := filepath.Join(filepath.Dir(canonicalRepo), filepath.Base(canonicalRepo)+"-worktrees", "session-1"); meta.WorktreeRoot != want {
		t.Fatalf("root=%q want %q", meta.WorktreeRoot, want)
	}
	if got := runGit(t, repo, "branch", "--list", meta.Branch); !strings.Contains(got, meta.Branch) {
		t.Fatalf("branch missing: %q", got)
	}
}

func TestUndoToleratesMissingWorktreeOrBranch(t *testing.T) {
	repo := tempRepo(t)
	created, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "rollback"})
	meta := created.Meta
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(meta.WorktreeRoot); err != nil {
		t.Fatal(err)
	}
	if err := created.Undo(); err != nil {
		t.Fatal(err)
	}
	if err := created.Undo(); err != nil {
		t.Fatal(err)
	}
}

func TestUnmergedCommits(t *testing.T) {
	repo := tempRepo(t)
	base := runGit(t, repo, "rev-parse", "HEAD")
	runGit(t, repo, "update-ref", "refs/heads/fix-login", base)
	wt := filepath.Join(t.TempDir(), "wt")
	runGit(t, repo, "worktree", "add", wt, "fix-login")
	runGit(t, wt, "commit", "--allow-empty", "-m", "c1")
	runGit(t, wt, "commit", "--allow-empty", "-m", "c2")
	tip := runGit(t, wt, "rev-parse", "HEAD")

	if n, err := UnmergedCommits(repo, "fix-login"); err != nil || n != 2 {
		t.Fatalf("UnmergedCommits = %d, %v; want 2, nil", n, err)
	}

	// A second local branch pointing at the tip covers the commits → 0.
	runGit(t, repo, "update-ref", "refs/heads/other", tip)
	if n, err := UnmergedCommits(repo, "fix-login"); err != nil || n != 0 {
		t.Fatalf("after local branch: %d, %v; want 0, nil", n, err)
	}
	runGit(t, repo, "update-ref", "-d", "refs/heads/other")

	// Only a remote-tracking ref covers them → 0.
	runGit(t, repo, "update-ref", "refs/remotes/origin/fix-login", tip)
	if n, err := UnmergedCommits(repo, "fix-login"); err != nil || n != 0 {
		t.Fatalf("after remote ref: %d, %v; want 0, nil", n, err)
	}
	runGit(t, repo, "update-ref", "-d", "refs/remotes/origin/fix-login")

	t.Run("detached", func(t *testing.T) {
		repo := tempRepo(t)
		base := runGit(t, repo, "rev-parse", "HEAD")
		wt := filepath.Join(t.TempDir(), "wt")
		runGit(t, repo, "worktree", "add", "--detach", wt, base)
		runGit(t, wt, "commit", "--allow-empty", "-m", "d1")
		runGit(t, wt, "commit", "--allow-empty", "-m", "d2")
		if n, err := UnmergedCommits(wt, ""); err != nil || n != 2 {
			t.Fatalf("UnmergedCommits = %d, %v; want 2, nil", n, err)
		}
	})

	t.Run("tag_with_same_name", func(t *testing.T) {
		repo := tempRepo(t)
		base := runGit(t, repo, "rev-parse", "HEAD")
		runGit(t, repo, "update-ref", "refs/heads/fix-login", base)
		wt := filepath.Join(t.TempDir(), "wt")
		runGit(t, repo, "worktree", "add", wt, "fix-login")
		runGit(t, wt, "commit", "--allow-empty", "-m", "c1")
		runGit(t, wt, "commit", "--allow-empty", "-m", "c2")
		// A tag with the same short name pointing at main must not be mistaken
		// for the branch (full ref form avoids the tag-wins resolution, V10).
		runGit(t, repo, "tag", "fix-login", base)
		if n, err := UnmergedCommits(repo, "fix-login"); err != nil || n != 2 {
			t.Fatalf("UnmergedCommits = %d, %v; want 2, nil", n, err)
		}
	})
}

// --- T2: worktree listing and home resolution ---

func writeFakeGit(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "git"), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}

func realGit(t *testing.T) string {
	t.Helper()
	p, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not found")
	}
	return p
}

func TestListWorktrees(t *testing.T) {
	repo := tempRepo(t)
	canonRepo := runGit(t, repo, "rev-parse", "--show-toplevel")
	base := runGit(t, repo, "rev-parse", "HEAD")

	linked := filepath.Join(t.TempDir(), "linked")
	runGit(t, repo, "worktree", "add", "-b", "feature", linked, base)
	det := filepath.Join(t.TempDir(), "det")
	runGit(t, repo, "worktree", "add", "--detach", det, base)
	runGit(t, det, "commit", "--allow-empty", "-m", "x")
	hidden := filepath.Join(repo, ".devflow-tmp", "worktrees", "general-skills")
	runGit(t, repo, "worktree", "add", "-b", "change/general-skills", hidden, base)
	locked := filepath.Join(t.TempDir(), "locked")
	runGit(t, repo, "worktree", "add", "--detach", locked, base)
	runGit(t, repo, "worktree", "lock", "--reason", "usb", locked)
	gone := filepath.Join(t.TempDir(), "gone")
	runGit(t, repo, "worktree", "add", "--detach", gone, base)
	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}

	wts, err := ListWorktrees(repo)
	if err != nil {
		t.Fatal(err)
	}
	if wts[0].Path != canonRepo {
		t.Fatalf("first entry = %q, want %q", wts[0].Path, canonRepo)
	}
	fromLinked, err := ListWorktrees(linked)
	if err != nil {
		t.Fatal(err)
	}
	if fromLinked[0].Path != canonRepo {
		t.Fatalf("first entry from linked = %q, want %q", fromLinked[0].Path, canonRepo)
	}

	var branches = map[string]Worktree{}
	var detached, lockedCount, prunable int
	for _, w := range wts {
		if w.Branch != "" {
			branches[w.Branch] = w
		}
		if w.Detached {
			detached++
			if len(w.Head) != 40 || w.Branch != "" {
				t.Fatalf("detached entry = %+v", w)
			}
		}
		if w.Locked {
			lockedCount++
			if w.LockReason != "usb" {
				t.Fatalf("lock reason = %q", w.LockReason)
			}
		}
		if w.Prunable {
			prunable++
		}
	}
	if _, ok := branches["feature"]; !ok {
		t.Fatalf("missing feature worktree: %+v", wts)
	}
	if _, ok := branches["change/general-skills"]; !ok {
		t.Fatalf("missing hidden worktree: %+v", wts)
	}
	if detached < 1 || lockedCount != 1 || prunable < 1 {
		t.Fatalf("detached=%d locked=%d prunable=%d: %+v", detached, lockedCount, prunable, wts)
	}
}

func TestListWorktreesBare(t *testing.T) {
	bare := filepath.Join(t.TempDir(), "bare.git")
	runGit(t, t.TempDir(), "init", "--bare", bare)
	wts, err := ListWorktrees(bare)
	if err != nil {
		t.Fatal(err)
	}
	if len(wts) == 0 || !wts[0].Bare {
		t.Fatalf("bare first entry = %+v", wts)
	}
}

func TestResolveHome(t *testing.T) {
	repo := tempRepo(t)
	canon := runGit(t, repo, "rev-parse", "--show-toplevel")
	h, err := ResolveHome(repo)
	if err != nil || !h.Git || h.Project != canon || h.Path != canon {
		t.Fatalf("repo: %+v %v", h, err)
	}
	sub := filepath.Join(repo, "a", "b")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	h, err = ResolveHome(sub)
	if err != nil || h.Project != canon || h.Path != canon {
		t.Fatalf("subdir: %+v %v", h, err)
	}
	base := runGit(t, repo, "rev-parse", "HEAD")
	wt := filepath.Join(t.TempDir(), "wt")
	runGit(t, repo, "worktree", "add", "-b", "feat", wt, base)
	canonWt := runGit(t, wt, "rev-parse", "--show-toplevel")
	wsub := filepath.Join(wt, "x")
	if err := os.MkdirAll(wsub, 0o755); err != nil {
		t.Fatal(err)
	}
	h, err = ResolveHome(wsub)
	if err != nil || h.Project != canon || h.Path != canonWt {
		t.Fatalf("linked subdir: %+v %v (project want %q path want %q)", h, err, canon, canonWt)
	}
}

func TestResolveHomeNonGit(t *testing.T) {
	dir := t.TempDir()
	abs, _ := filepath.Abs(dir)
	h, err := ResolveHome(dir)
	if err != nil || h.Git || h.Project != abs || h.Path != abs {
		t.Fatalf("%+v %v", h, err)
	}

	t.Run("zh_locale", func(t *testing.T) {
		t.Setenv("LANG", "zh_CN.UTF-8")
		t.Setenv("LC_ALL", "zh_CN.UTF-8")
		dir := t.TempDir()
		abs, _ := filepath.Abs(dir)
		h, err := ResolveHome(dir)
		if err != nil || h.Git || h.Project != abs {
			t.Fatalf("%+v %v", h, err)
		}
	})
}

func TestResolveHomeSeparateGitDir(t *testing.T) {
	root := t.TempDir()
	gitDir := filepath.Join(root, "gd")
	wt := filepath.Join(root, "wt")
	runGit(t, root, "init", "--separate-git-dir="+gitDir, wt)
	runGit(t, wt, "config", "user.email", "a@b.c")
	runGit(t, wt, "config", "user.name", "a")
	runGit(t, wt, "commit", "--allow-empty", "-m", "init")
	canonWt := runGit(t, wt, "rev-parse", "--show-toplevel")
	h, err := ResolveHome(wt)
	if err != nil || !h.Git || !h.Single || h.Project != canonWt || h.Path != canonWt {
		t.Fatalf("%+v %v (want single, project=%q)", h, err, canonWt)
	}
}

func TestResolveHomeSubmodule(t *testing.T) {
	main := tempRepo(t)
	sub := tempRepo(t)
	runGit(t, main, "-c", "protocol.file.allow=always", "submodule", "add", sub, "sub")
	runGit(t, main, "commit", "-m", "add submodule")
	subWT := filepath.Join(main, "sub")
	canonSub := runGit(t, subWT, "rev-parse", "--show-toplevel")
	h, err := ResolveHome(subWT)
	if err != nil || !h.Git || !h.Single || h.Project != canonSub || h.Path != canonSub {
		t.Fatalf("%+v %v (want single, project=%q)", h, err, canonSub)
	}
}

func TestResolveHomeInsideGitDir(t *testing.T) {
	repo := tempRepo(t)
	hooks := filepath.Join(repo, ".git", "hooks")
	h, err := ResolveHome(hooks)
	if err != nil || h.Git {
		t.Fatalf("hooks: %+v %v", h, err)
	}
	bare := filepath.Join(t.TempDir(), "bare.git")
	runGit(t, t.TempDir(), "init", "--bare", bare)
	h, err = ResolveHome(bare)
	if err != nil || h.Git {
		t.Fatalf("bare: %+v %v", h, err)
	}
}

func TestResolveHomeGitFailure(t *testing.T) {
	parent := t.TempDir()
	if err := os.Mkdir(filepath.Join(parent, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(parent, "child")
	if err := os.Mkdir(child, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveHome(child); err == nil {
		t.Fatal("expected error for an unrecognizable repo")
	}

	t.Run("timeout", func(t *testing.T) {
		dir := t.TempDir()
		writeFakeGit(t, dir, "#!/bin/sh\nexec sleep 5\n")
		t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
		old := gitTimeout
		gitTimeout = 50 * time.Millisecond
		defer func() { gitTimeout = old }()
		if _, err := ResolveHome(t.TempDir()); err == nil {
			t.Fatal("expected timeout error")
		}
	})
}

func TestGitEnvIsFixed(t *testing.T) {
	repo := tempRepo(t)
	canon := runGit(t, repo, "rev-parse", "--show-toplevel")
	other := tempRepo(t)
	wrapDir := t.TempDir()
	envFile := filepath.Join(wrapDir, "env.out")
	writeFakeGit(t, wrapDir, "#!/bin/sh\nenv > '"+envFile+"'\nexec '"+realGit(t)+"' \"$@\"\n")

	t.Setenv("LC_ALL", "zh_CN.UTF-8")
	t.Setenv("GIT_DIR", filepath.Join(other, ".git"))
	t.Setenv("GIT_WORK_TREE", "/")
	t.Setenv("PATH", wrapDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	wts, err := ListWorktrees(repo)
	if err != nil {
		t.Fatal(err)
	}
	if wts[0].Path != canon {
		t.Fatalf("first entry = %q, want %q (GIT_DIR leaked?)", wts[0].Path, canon)
	}
	data, err := os.ReadFile(envFile)
	if err != nil {
		t.Fatal(err)
	}
	env := string(data)
	if !strings.Contains(env, "LC_ALL=C\n") {
		t.Fatalf("LC_ALL not pinned to C:\n%s", env)
	}
	for _, k := range []string{"GIT_DIR=", "GIT_WORK_TREE="} {
		if strings.Contains(env, k) {
			t.Fatalf("%s leaked into git env:\n%s", k, env)
		}
	}
}

func TestGitTimeoutKillsProcess(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "pid")
	writeFakeGit(t, dir, "#!/bin/sh\necho $$ > '"+pidFile+"'\nexec sleep 5\n")
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	old := gitTimeout
	gitTimeout = 50 * time.Millisecond
	defer func() { gitTimeout = old }()

	start := time.Now()
	if _, err := gitAtTimeout(t.TempDir(), "rev-parse", "HEAD"); err == nil {
		t.Fatal("expected timeout error")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("gitAtTimeout took %v, want < 1s", elapsed)
	}
	data, _ := os.ReadFile(pidFile)
	pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
	if pid <= 0 {
		t.Skip("fake git did not record a pid")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if syscall.Kill(pid, 0) != nil {
			return // process gone
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("fake git process %d still alive after timeout", pid)
}

// --- T7: named worktrees ---

// repoAt initializes a repository with one commit on branch main in dir and
// returns git's canonical path for it.
func repoAt(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "init", "-b", "main")
	runGit(t, dir, "config", "user.email", "test@example.com")
	runGit(t, dir, "config", "user.name", "Test User")
	if err := os.WriteFile(filepath.Join(dir, "README"), []byte("initial\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "README")
	runGit(t, dir, "commit", "-m", "initial")
	return runGit(t, dir, "rev-parse", "--show-toplevel")
}

// devflowRepo is a repository named devflow in a fresh directory of its own, so
// the sibling devflow-worktrees container belongs to this test alone.
func devflowRepo(t *testing.T) string {
	t.Helper()
	return repoAt(t, filepath.Join(t.TempDir(), "devflow"))
}

func containerOf(repo string) string {
	return filepath.Join(filepath.Dir(repo), filepath.Base(repo)+"-worktrees")
}

func commitFile(t *testing.T, dir, name string) string {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(name+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", name)
	runGit(t, dir, "commit", "-m", "add "+name)
	return runGit(t, dir, "rev-parse", "HEAD")
}

// branchOID returns the commit refs/heads/<name> points at, or "" when the
// branch does not exist.
func branchOID(t *testing.T, repo, name string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/"+name).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func pathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func worktreeListed(t *testing.T, repo, path string) bool {
	t.Helper()
	for _, line := range strings.Split(runGit(t, repo, "worktree", "list", "--porcelain"), "\n") {
		if line == "worktree "+path {
			return true
		}
	}
	return false
}

const gitCallEnd = "<<end>>"

// installArgLoggingGit prepends a git that records every argument of each call
// (one per line, then a gitCallEnd line) and execs the real git. It returns the
// log path.
func installArgLoggingGit(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "args.log")
	real := realGit(t)
	script := "#!/bin/sh\n{ for a in \"$@\"; do printf '%s\\n' \"$a\"; done; printf '%s\\n' '" + gitCallEnd + "'; } >> '" + log + "'\nexec '" + real + "' \"$@\"\n"
	writeFakeGit(t, dir, script)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return log
}

// loggedGitCalls returns the recorded calls with the leading "-C <dir>" removed,
// so each starts with the git subcommand.
func loggedGitCalls(t *testing.T, log string) [][]string {
	t.Helper()
	data, err := os.ReadFile(log)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var calls [][]string
	var cur []string
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		if line == gitCallEnd {
			if len(cur) >= 2 && cur[0] == "-C" {
				cur = cur[2:]
			}
			calls = append(calls, cur)
			cur = nil
			continue
		}
		cur = append(cur, line)
	}
	return calls
}

func subcommands(calls [][]string) map[string]int {
	seen := map[string]int{}
	for _, c := range calls {
		if len(c) > 0 {
			seen[c[0]]++
		}
	}
	return seen
}

func TestValidateWorktreeName(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "worktree-names.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name   string `json:"name"`
		OK     bool   `json:"ok"`
		Reason string `json:"reason"`
		Local  bool   `json:"local"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	must := map[string]bool{}
	for _, n := range []string{"", "a b", "a\tb", "a..b", "-x", "-", "a~b", "a.lock", "HEAD", "@{-1}", "@{-2}", "@{u}", "a@{b",
		"fix-login", "change/foo", "功能/登录", "@", "refs/heads/x"} {
		must[n] = false
	}
	repo := devflowRepo(t)
	for _, v := range vectors {
		if _, ok := must[v.Name]; ok {
			must[v.Name] = true
		}
		err := ValidateWorktreeName(repo, v.Name)
		if v.OK {
			if err != nil {
				t.Errorf("%q: want accepted, got %v", v.Name, err)
			}
			if got := worktreeNameProblem(v.Name); got != "" {
				t.Errorf("%q: local rules report %q for an accepted name", v.Name, got)
			}
			continue
		}
		if !errors.Is(err, ErrInvalidWorktreeName) {
			t.Errorf("%q: want ErrInvalidWorktreeName, got %v", v.Name, err)
		}
		// local:true = the desktop must reach this reason without asking the
		// daemon, so the daemon's local rules must give exactly it.
		want := ""
		if v.Local {
			want = v.Reason
		}
		if got := worktreeNameProblem(v.Name); got != want {
			t.Errorf("%q: local rules report %q, want %q", v.Name, got, want)
		}
	}
	for n, seen := range must {
		if !seen {
			t.Errorf("vector file lacks %q", n)
		}
	}
}

func TestValidateWorktreeNameRejectsExpansion(t *testing.T) {
	repo := devflowRepo(t)
	runGit(t, repo, "checkout", "-b", "prev")
	prev := commitFile(t, repo, "only-on-prev")
	runGit(t, repo, "checkout", "main")
	if got := runGit(t, repo, "rev-parse", "--abbrev-ref", "@{-1}"); got != "prev" {
		t.Fatalf("setup: @{-1} = %q, want prev", got)
	}

	log := installArgLoggingGit(t)
	if err := ValidateWorktreeName(repo, "@{-1}"); !errors.Is(err, ErrInvalidWorktreeName) {
		t.Fatalf("ValidateWorktreeName(@{-1}) = %v", err)
	}
	if calls := loggedGitCalls(t, log); len(calls) != 0 {
		t.Fatalf("the local rules should have stopped it before git ran: %v", calls)
	}
	// The second rule on its own: exit status 0 is not enough, the printed name
	// has to be the one that was asked about.
	if err := checkRefFormatBranch(repo, "@{-1}"); !errors.Is(err, ErrInvalidWorktreeName) {
		t.Fatalf("checkRefFormatBranch(@{-1}) = %v, want rejected (git prints prev)", err)
	}

	m := NewManager(false, "/bin/cat", false, "")
	_, err := m.Create(CreateOptions{Workdir: repo, Mode: protocol.SessionModeWorktree, WorktreeName: "@{-1}", Cols: 80, Rows: 24})
	if !errors.Is(err, ErrInvalidWorktreeName) {
		t.Fatalf("Create = %v, want ErrInvalidWorktreeName", err)
	}
	if got := branchOID(t, repo, "prev"); got != prev {
		t.Fatalf("prev moved: %q, want %q", got, prev)
	}
	if pathExists(containerOf(repo)) {
		t.Fatal("a worktree container was left behind")
	}
}

func TestWorktreeNameNeverReachesShell(t *testing.T) {
	repo := devflowRepo(t)
	log := installArgLoggingGit(t)
	if err := ValidateWorktreeName(repo, "-x"); !errors.Is(err, ErrInvalidWorktreeName) {
		t.Fatalf("ValidateWorktreeName(-x) = %v", err)
	}
	if calls := loggedGitCalls(t, log); len(calls) != 0 {
		t.Fatalf("git ran for a name starting with -: %v", calls)
	}

	const name = "$(touch${IFS}PWNED)"
	created, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: name})
	if err != nil {
		t.Fatalf("CreateWorktree(%q): %v", name, err)
	}
	cwd, _ := os.Getwd()
	for _, dir := range []string{cwd, repo, filepath.Dir(repo), containerOf(repo), created.Meta.WorktreeRoot} {
		if pathExists(filepath.Join(dir, "PWNED")) {
			t.Fatalf("the name was executed: %s/PWNED exists", dir)
		}
	}
	found := false
	for _, c := range loggedGitCalls(t, log) {
		for _, a := range c {
			if a == "refs/heads/"+name {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("no git call carried refs/heads/%s as one argument", name)
	}
	if branchOID(t, repo, name) == "" {
		t.Fatal("the branch with the literal name was not created")
	}
}

func TestWorktreeDirName(t *testing.T) {
	for in, want := range map[string]string{"change/foo": "change-foo", "a/b/c": "a-b-c", "fix-login": "fix-login"} {
		if got := WorktreeDirName(in); got != want {
			t.Errorf("WorktreeDirName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBranchConflict(t *testing.T) {
	repo := devflowRepo(t)
	runGit(t, repo, "branch", "fix")
	runGit(t, repo, "branch", "change/foo")
	runGit(t, repo, "pack-refs", "--all")
	log := installArgLoggingGit(t)
	for name, want := range map[string]string{
		"fix": "fix", "fix/login": "fix", "fix/a/b": "fix", "change": "change/foo",
		"ok/name": "", "fixed": "", "change-foo": "",
	} {
		got, err := BranchConflict(repo, name)
		if err != nil || got != want {
			t.Errorf("BranchConflict(%q) = %q, %v; want %q", name, got, err, want)
		}
	}
	for sub := range subcommands(loggedGitCalls(t, log)) {
		if sub != "show-ref" && sub != "for-each-ref" {
			t.Errorf("BranchConflict ran git %s; only show-ref and for-each-ref are read-only", sub)
		}
	}
}

func TestCreateNamedWorktree(t *testing.T) {
	repo := devflowRepo(t)
	head := runGit(t, repo, "rev-parse", "HEAD")
	created, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(filepath.Dir(repo), "devflow-worktrees", "fix-login")
	if created.Meta.WorktreeRoot != root || created.Meta.Branch != "fix-login" || created.Workdir != root {
		t.Fatalf("created %+v, want root %q on fix-login", created, root)
	}
	if created.Home.Project != repo || created.Home.Path != root || !created.Home.Git || created.Home.Single {
		t.Fatalf("home %+v, want project %q path %q", created.Home, repo, root)
	}
	if created.OID != head || branchOID(t, repo, "fix-login") != head {
		t.Fatalf("OID %q, branch %q, want main's %q", created.OID, branchOID(t, repo, "fix-login"), head)
	}
	if got := runGit(t, root, "symbolic-ref", "HEAD"); got != "refs/heads/fix-login" {
		t.Fatalf("new worktree HEAD = %q", got)
	}
	if got := runGit(t, root, "status", "--porcelain"); got != "" {
		t.Fatalf("new worktree is not clean:\n%s", got)
	}
	// A commit made there moves the branch.
	next := commitFile(t, root, "work")
	if branchOID(t, repo, "fix-login") != next {
		t.Fatal("a commit in the new worktree did not move its branch")
	}

	t.Run("slash", func(t *testing.T) {
		created, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s2", Name: "change/foo"})
		if err != nil {
			t.Fatal(err)
		}
		want := filepath.Join(filepath.Dir(repo), "devflow-worktrees", "change-foo")
		if created.Meta.Branch != "change/foo" || created.Meta.WorktreeRoot != want {
			t.Fatalf("created %+v, want branch change/foo in %q", created.Meta, want)
		}
		if got := runGit(t, want, "symbolic-ref", "HEAD"); got != "refs/heads/change/foo" {
			t.Fatalf("HEAD = %q", got)
		}
	})
}

func TestCreateNamedWorktreeBranchExists(t *testing.T) {
	repo := devflowRepo(t)
	old := runGit(t, repo, "rev-parse", "HEAD")
	runGit(t, repo, "branch", "fix-login")
	commitFile(t, repo, "later")
	_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
	if !errors.Is(err, ErrWorktreeBranchExists) {
		t.Fatalf("err = %v, want ErrWorktreeBranchExists", err)
	}
	var be *BranchExistsError
	if !errors.As(err, &be) || be.Branch != "fix-login" || be.Conflict != "fix-login" {
		t.Fatalf("err = %#v, want conflict fix-login", err)
	}
	if pathExists(containerOf(repo)) {
		t.Fatal("something was created next to the repository")
	}
	if got := branchOID(t, repo, "fix-login"); got != old {
		t.Fatalf("existing branch moved to %q", got)
	}

	t.Run("dir_file_conflict", func(t *testing.T) {
		repo := devflowRepo(t)
		runGit(t, repo, "branch", "fix")
		runGit(t, repo, "branch", "change/foo")
		log := installArgLoggingGit(t)
		for name, conflict := range map[string]string{"fix/login": "fix", "change": "change/foo"} {
			_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: name})
			var be *BranchExistsError
			if !errors.Is(err, ErrWorktreeBranchExists) || !errors.As(err, &be) || be.Conflict != conflict {
				t.Fatalf("%q: err = %v, want blocked by %q", name, err, conflict)
			}
			if !strings.Contains(err.Error(), conflict) {
				t.Fatalf("%q: message %q does not name %q", name, err, conflict)
			}
		}
		if pathExists(containerOf(repo)) {
			t.Fatal("a container directory was created")
		}
		if n := subcommands(loggedGitCalls(t, log))["update-ref"]; n != 0 {
			t.Fatalf("update-ref ran %d times; the conflict must be caught before claiming the branch", n)
		}
	})
}

func TestCreateNamedWorktreePathExists(t *testing.T) {
	repo := devflowRepo(t)
	root := filepath.Join(containerOf(repo), "fix-login")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "keep.txt"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
	if !errors.Is(err, ErrWorktreePathExists) {
		t.Fatalf("err = %v, want ErrWorktreePathExists", err)
	}
	if branchOID(t, repo, "fix-login") != "" {
		t.Fatal("a branch was created")
	}
	if data, _ := os.ReadFile(filepath.Join(root, "keep.txt")); string(data) != "keep" {
		t.Fatal("the existing directory was touched")
	}

	t.Run("empty_dir", func(t *testing.T) {
		repo := devflowRepo(t)
		root := filepath.Join(containerOf(repo), "fix-login")
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatal(err)
		}
		_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
		if !errors.Is(err, ErrWorktreePathExists) {
			t.Fatalf("err = %v, want ErrWorktreePathExists", err)
		}
		entries, readErr := os.ReadDir(root)
		if readErr != nil || len(entries) != 0 {
			t.Fatalf("the empty directory was used or removed: %v %v", entries, readErr)
		}
		if worktreeListed(t, repo, root) {
			t.Fatal("git took the empty directory as a worktree")
		}
		if branchOID(t, repo, "fix-login") != "" {
			t.Fatal("a branch was created")
		}
	})
}

func TestCreateNamedWorktreeExcludesUncommitted(t *testing.T) {
	repo := devflowRepo(t)
	head := runGit(t, repo, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(repo, "README"), []byte("edited, not committed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	created, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
	if err != nil {
		t.Fatal(err)
	}
	if got := runGit(t, created.Meta.WorktreeRoot, "status", "--porcelain"); got != "" {
		t.Fatalf("the new worktree carries changes:\n%s", got)
	}
	if got := runGit(t, created.Meta.WorktreeRoot, "rev-parse", "HEAD"); got != head {
		t.Fatalf("HEAD = %q, want the source's %q", got, head)
	}
	if data, _ := os.ReadFile(filepath.Join(created.Meta.WorktreeRoot, "README")); string(data) != "initial\n" {
		t.Fatalf("README = %q, want the committed content", data)
	}
}

func allowWith(cfg *config.Config) func(string) error {
	return func(p string) error {
		_, err := cfg.ResolveAllowedNewPath(p)
		return err
	}
}

func TestCreateNamedWorktreePathNotAllowed(t *testing.T) {
	repo := devflowRepo(t)
	root := filepath.Join(containerOf(repo), "fix-login")
	cfg := &config.Config{AllowedRoots: []string{repo}}
	_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login", AllowPath: allowWith(cfg)})
	if !errors.Is(err, ErrWorktreePathNotAllowed) {
		t.Fatalf("err = %v, want ErrWorktreePathNotAllowed", err)
	}
	if !strings.Contains(err.Error(), root) {
		t.Fatalf("message %q lacks the full path %q", err, root)
	}
	if pathExists(containerOf(repo)) || branchOID(t, repo, "fix-login") != "" {
		t.Fatal("a directory or branch was created")
	}

	t.Run("symlinked_container", func(t *testing.T) {
		base, _ := filepath.EvalSymlinks(t.TempDir())
		outside, _ := filepath.EvalSymlinks(t.TempDir())
		repo := repoAt(t, filepath.Join(base, "devflow"))
		if err := os.Symlink(outside, containerOf(repo)); err != nil {
			t.Skipf("symlinks unsupported: %v", err)
		}
		cfg := &config.Config{AllowedRoots: []string{base}}
		_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login", AllowPath: allowWith(cfg)})
		if !errors.Is(err, ErrWorktreePathNotAllowed) {
			t.Fatalf("err = %v, want ErrWorktreePathNotAllowed", err)
		}
		if entries, _ := os.ReadDir(outside); len(entries) != 0 {
			t.Fatalf("something was created outside the allowed roots: %v", entries)
		}
		if branchOID(t, repo, "fix-login") != "" {
			t.Fatal("a branch was created")
		}
	})
}

func TestCreateNamedWorktreeFromLinkedWorktree(t *testing.T) {
	repo := devflowRepo(t)
	first, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
	if err != nil {
		t.Fatal(err)
	}
	onFix := commitFile(t, first.Meta.WorktreeRoot, "fix-only")
	second, err := CreateWorktree(WorktreeSpec{Source: first.Meta.WorktreeRoot, SessionID: "s2", Name: "follow-up"})
	if err != nil {
		t.Fatal(err)
	}
	if second.OID != onFix || branchOID(t, repo, "follow-up") != onFix {
		t.Fatalf("follow-up at %q, want fix-login's HEAD %q", second.OID, onFix)
	}
	if want := filepath.Join(containerOf(repo), "follow-up"); second.Meta.WorktreeRoot != want {
		t.Fatalf("root %q, want %q (next to the main worktree)", second.Meta.WorktreeRoot, want)
	}
	if second.Home.Project != repo {
		t.Fatalf("project %q, want the main worktree %q", second.Home.Project, repo)
	}
}

func TestCreateNamedWorktreeSubdir(t *testing.T) {
	repo := devflowRepo(t)
	sub := filepath.Join(repo, "src", "app")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	created, err := CreateWorktree(WorktreeSpec{Source: sub, SessionID: "s1", Name: "fix-login"})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(created.Meta.WorktreeRoot, "src", "app")
	if created.Workdir != want {
		t.Fatalf("workdir %q, want %q", created.Workdir, want)
	}
	if info, err := os.Stat(want); err != nil || !info.IsDir() {
		t.Fatalf("mapped workdir missing: %v", err)
	}
}

func TestCreateNamedWorktreeReflog(t *testing.T) {
	repo := devflowRepo(t)
	created, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
	if err != nil {
		t.Fatal(err)
	}
	first := func(dir, ref string) string {
		return strings.Split(runGit(t, dir, "reflog", "show", "--format=%gs", ref), "\n")[0]
	}
	if got := first(repo, "refs/heads/fix-login"); got != "branch: Created from HEAD" {
		t.Fatalf("branch reflog = %q", got)
	}
	if got := first(created.Meta.WorktreeRoot, "HEAD"); got != "worktree: attached to refs/heads/fix-login" {
		t.Fatalf("HEAD reflog = %q", got)
	}
	// As with `git worktree add -b`, the new worktree has no previous branch.
	if out, err := exec.Command("git", "-C", created.Meta.WorktreeRoot, "rev-parse", "--verify", "--quiet", "@{-1}").CombinedOutput(); err == nil {
		t.Fatalf("@{-1} resolves to %s in the new worktree", out)
	}
}

func TestCreateNamedWorktreeUnsupportedRepo(t *testing.T) {
	setups := map[string]func(t *testing.T) (workdir string, watched []string){
		"submodule": func(t *testing.T) (string, []string) {
			main := tempRepo(t)
			sub := tempRepo(t)
			runGit(t, main, "-c", "protocol.file.allow=always", "submodule", "add", sub, "sub")
			runGit(t, main, "commit", "-m", "add submodule")
			canonMain := runGit(t, main, "rev-parse", "--show-toplevel")
			return filepath.Join(canonMain, "sub"), []string{filepath.Join(canonMain, ".git", "modules"), canonMain}
		},
		"separate_git_dir": func(t *testing.T) (string, []string) {
			root, _ := filepath.EvalSymlinks(t.TempDir())
			wt := filepath.Join(root, "wt")
			runGit(t, root, "init", "--separate-git-dir="+filepath.Join(root, "gd"), wt)
			runGit(t, wt, "config", "user.email", "a@b.c")
			runGit(t, wt, "config", "user.name", "a")
			runGit(t, wt, "commit", "--allow-empty", "-m", "init")
			return wt, []string{root}
		},
	}
	for name, setup := range setups {
		t.Run(name, func(t *testing.T) {
			workdir, watched := setup(t)
			before := map[string][]string{}
			for _, dir := range watched {
				before[dir] = dirNames(t, dir)
			}
			branches := runGit(t, workdir, "for-each-ref", "refs/heads")
			_, err := CreateWorktree(WorktreeSpec{Source: workdir, SessionID: "s1", Name: "fix-login"})
			if !errors.Is(err, ErrUnsupportedRepo) {
				t.Fatalf("err = %v, want ErrUnsupportedRepo", err)
			}
			for _, dir := range watched {
				if got := dirNames(t, dir); strings.Join(got, ",") != strings.Join(before[dir], ",") {
					t.Fatalf("%s changed: %v → %v", dir, before[dir], got)
				}
			}
			if got := runGit(t, workdir, "for-each-ref", "refs/heads"); got != branches {
				t.Fatalf("branches changed:\n%s", got)
			}

			// Without a name the original naming still works there.
			created, err := CreateWorktree(WorktreeSpec{Source: workdir, SessionID: "legacy-1"})
			if err != nil {
				t.Fatalf("unnamed worktree: %v", err)
			}
			wantRoot := filepath.Join(filepath.Dir(workdir), filepath.Base(workdir)+"-worktrees", "legacy-1")
			if created.Meta.Branch != "vibe/legacy-1" || created.Meta.WorktreeRoot != wantRoot {
				t.Fatalf("created %+v, want vibe/legacy-1 in %q", created.Meta, wantRoot)
			}
			if created.Home.Project != wantRoot || created.Home.Path != wantRoot || !created.Home.Single {
				t.Fatalf("home %+v, want the new worktree as its own single project", created.Home)
			}
			if h, err := ResolveHome(wantRoot); err != nil || h != created.Home {
				t.Fatalf("ResolveHome(new worktree) = %+v, %v; CreateWorktree said %+v", h, err, created.Home)
			}
		})
	}
}

func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// linkdirRepo is a repository under base whose HEAD has `linkdir` as a symlink
// to target while the work tree has a real directory there (uncommitted), so a
// session can be started from <repo>/linkdir.
func linkdirRepo(t *testing.T, base, target string) string {
	t.Helper()
	repo := repoAt(t, filepath.Join(base, "devflow"))
	if err := os.Symlink(target, filepath.Join(repo, "linkdir")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	runGit(t, repo, "add", "linkdir")
	runGit(t, repo, "commit", "-m", "linkdir is a symlink")
	if err := os.Remove(filepath.Join(repo, "linkdir")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(repo, "linkdir"), 0o755); err != nil {
		t.Fatal(err)
	}
	return repo
}

func TestCreateWorktreeMappedWorkdirEscapesViaSymlink(t *testing.T) {
	for _, tc := range []struct{ label, name, dir, branch string }{
		{"named", "fix-login", "fix-login", "fix-login"},
		{"unnamed", "", "esc-1", "vibe/esc-1"},
	} {
		t.Run(tc.label, func(t *testing.T) {
			base, _ := filepath.EvalSymlinks(t.TempDir())
			outside, _ := filepath.EvalSymlinks(t.TempDir())
			repo := linkdirRepo(t, base, outside)
			cfg := &config.Config{AllowedRoots: []string{base}}
			store := NewMemoryProjectStore()
			m := NewManager(false, "/bin/cat", false, "")
			m.SetProjectStore(store)
			root := filepath.Join(containerOf(repo), tc.dir)
			_, err := m.Create(CreateOptions{ID: "esc-1", Workdir: filepath.Join(repo, "linkdir"), Mode: protocol.SessionModeWorktree,
				WorktreeName: tc.name, Cols: 80, Rows: 24, ValidateWorkdir: cfg.ResolveAllowedNewPath})
			if !errors.Is(err, ErrWorktreePathNotAllowed) {
				t.Fatalf("err = %v, want ErrWorktreePathNotAllowed", err)
			}
			if !strings.Contains(err.Error(), filepath.Join(root, "linkdir")) {
				t.Fatalf("message %q lacks the final workdir %q", err, filepath.Join(root, "linkdir"))
			}
			if pathExists(root) || worktreeListed(t, repo, root) || branchOID(t, repo, tc.branch) != "" {
				t.Fatal("the worktree or its branch was left behind")
			}
			if len(store.Worktrees()) != 0 {
				t.Fatalf("store keeps %v", store.Worktrees())
			}
			if entries, _ := os.ReadDir(outside); len(entries) != 0 {
				t.Fatalf("the link target gained %v", entries)
			}
			if len(m.sessions) != 0 {
				t.Fatal("a session was registered")
			}
		})
	}

	// The source is a directory below the link: nothing may be created at the
	// link's target on the way to finding out the path is not allowed.
	t.Run("below_the_link", func(t *testing.T) {
		base, _ := filepath.EvalSymlinks(t.TempDir())
		outside, _ := filepath.EvalSymlinks(t.TempDir())
		repo := linkdirRepo(t, base, outside)
		source := filepath.Join(repo, "linkdir", "sub", "deeper")
		if err := os.MkdirAll(source, 0o755); err != nil {
			t.Fatal(err)
		}
		cfg := &config.Config{AllowedRoots: []string{base}}
		_, err := CreateWorktree(WorktreeSpec{Source: source, SessionID: "s1", Name: "fix-login", AllowPath: allowWith(cfg)})
		if !errors.Is(err, ErrWorktreePathNotAllowed) {
			t.Fatalf("err = %v, want ErrWorktreePathNotAllowed", err)
		}
		if entries, _ := os.ReadDir(outside); len(entries) != 0 {
			t.Fatalf("the link target gained %v", entries)
		}
		if pathExists(containerOf(repo)) || branchOID(t, repo, "fix-login") != "" {
			t.Fatal("the worktree or its branch was left behind")
		}
	})

	t.Run("link_inside_allowed_roots", func(t *testing.T) {
		base, _ := filepath.EvalSymlinks(t.TempDir())
		inside := filepath.Join(base, "shared")
		if err := os.Mkdir(inside, 0o755); err != nil {
			t.Fatal(err)
		}
		repo := linkdirRepo(t, base, inside)
		cfg := &config.Config{AllowedRoots: []string{base}}
		created, err := CreateWorktree(WorktreeSpec{Source: filepath.Join(repo, "linkdir"), SessionID: "s1", Name: "fix-login", AllowPath: allowWith(cfg)})
		if err != nil {
			t.Fatal(err)
		}
		if want := filepath.Join(containerOf(repo), "fix-login", "linkdir"); created.Workdir != want {
			t.Fatalf("workdir %q, want %q", created.Workdir, want)
		}
	})
}

func TestCreateRaceWithExternalBranch(t *testing.T) {
	repo := devflowRepo(t)
	x := runGit(t, repo, "rev-parse", "HEAD")
	commitFile(t, repo, "later")
	testAfterCreateChecks = func() { runGit(t, repo, "branch", "fix-login", x) }
	t.Cleanup(func() { testAfterCreateChecks = nil })
	_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
	if !errors.Is(err, ErrWorktreeBranchExists) {
		t.Fatalf("err = %v, want ErrWorktreeBranchExists", err)
	}
	if got := branchOID(t, repo, "fix-login"); got != x {
		t.Fatalf("their branch now points at %q, want %q", got, x)
	}
	if pathExists(containerOf(repo)) {
		t.Fatal("the directory claimed by this create (or its new container) was left behind")
	}
}

func TestCreateRaceWithExternalDir(t *testing.T) {
	repo := devflowRepo(t)
	root := filepath.Join(containerOf(repo), "fix-login")
	testAfterCreateChecks = func() {
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Error(err)
		}
		if err := os.WriteFile(filepath.Join(root, "theirs.txt"), []byte("theirs"), 0o644); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(func() { testAfterCreateChecks = nil })
	_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
	if !errors.Is(err, ErrWorktreePathExists) {
		t.Fatalf("err = %v, want ErrWorktreePathExists", err)
	}
	if data, _ := os.ReadFile(filepath.Join(root, "theirs.txt")); string(data) != "theirs" {
		t.Fatal("their directory was touched")
	}
	if branchOID(t, repo, "fix-login") != "" {
		t.Fatal("a branch was left behind")
	}
}

func TestUndoOnlyRemovesOwnArtifacts(t *testing.T) {
	t.Run("branch_moved", func(t *testing.T) {
		repo := devflowRepo(t)
		created, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
		if err != nil {
			t.Fatal(err)
		}
		moved := commitFile(t, created.Meta.WorktreeRoot, "work")
		err = created.Undo()
		if err == nil || !strings.Contains(err.Error(), "fix-login") || !strings.Contains(err.Error(), "kept") {
			t.Fatalf("Undo = %v, want an error saying the branch was kept", err)
		}
		if pathExists(created.Meta.WorktreeRoot) || worktreeListed(t, repo, created.Meta.WorktreeRoot) {
			t.Fatal("the worktree is still there")
		}
		if got := branchOID(t, repo, "fix-login"); got != moved {
			t.Fatalf("branch at %q, want kept at the new commit %q", got, moved)
		}
	})

	t.Run("clean", func(t *testing.T) {
		repo := devflowRepo(t)
		created, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
		if err != nil {
			t.Fatal(err)
		}
		if !created.NewContainer {
			t.Fatal("NewContainer should be true for the first worktree")
		}
		if err := created.Undo(); err != nil {
			t.Fatal(err)
		}
		if pathExists(created.Meta.WorktreeRoot) || pathExists(containerOf(repo)) || branchOID(t, repo, "fix-login") != "" || worktreeListed(t, repo, created.Meta.WorktreeRoot) {
			t.Fatal("something of the created worktree is left")
		}
		if err := created.Undo(); err != nil {
			t.Fatalf("second Undo = %v, want nil", err)
		}
	})

	t.Run("shared_container", func(t *testing.T) {
		repo := devflowRepo(t)
		one, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "one"})
		if err != nil {
			t.Fatal(err)
		}
		two, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s2", Name: "two"})
		if err != nil {
			t.Fatal(err)
		}
		if two.NewContainer {
			t.Fatal("the container already existed for the second worktree")
		}
		if err := two.Undo(); err != nil {
			t.Fatal(err)
		}
		if !pathExists(one.Meta.WorktreeRoot) || !worktreeListed(t, repo, one.Meta.WorktreeRoot) || branchOID(t, repo, "one") == "" {
			t.Fatal("the other worktree was damaged")
		}
		if pathExists(two.Meta.WorktreeRoot) || branchOID(t, repo, "two") != "" {
			t.Fatal("the undone worktree is still there")
		}
	})

	t.Run("directory_already_gone", func(t *testing.T) {
		repo := devflowRepo(t)
		created, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.RemoveAll(created.Meta.WorktreeRoot); err != nil {
			t.Fatal(err)
		}
		if err := created.Undo(); err != nil {
			t.Fatal(err)
		}
		if worktreeListed(t, repo, created.Meta.WorktreeRoot) || branchOID(t, repo, "fix-login") != "" {
			t.Fatal("a stale registration or the branch is left")
		}
	})

	t.Run("directory_taken_by_another_worktree", func(t *testing.T) {
		repo := devflowRepo(t)
		runGit(t, repo, "branch", "theirs")
		root := filepath.Join(containerOf(repo), "fix-login")
		log := installArgLoggingGit(t)
		testBeforeWorktreeAdd = func() {
			runGit(t, repo, "worktree", "add", root, "theirs")
			if err := os.WriteFile(filepath.Join(root, "precious.txt"), []byte("precious"), 0o644); err != nil {
				t.Error(err)
			}
		}
		t.Cleanup(func() { testBeforeWorktreeAdd = nil })
		_, err := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: "fix-login"})
		if err == nil || errors.Is(err, ErrWorktreeBranchExists) || errors.Is(err, ErrWorktreePathExists) {
			t.Fatalf("err = %v, want a plain create failure", err)
		}
		if !strings.Contains(err.Error(), root) || !strings.Contains(err.Error(), "not removed") {
			t.Fatalf("message %q should say the directory was not removed", err)
		}
		if data, _ := os.ReadFile(filepath.Join(root, "precious.txt")); string(data) != "precious" {
			t.Fatal("their file is gone")
		}
		if got := runGit(t, root, "symbolic-ref", "HEAD"); got != "refs/heads/theirs" || !worktreeListed(t, repo, root) {
			t.Fatalf("their worktree was disturbed (HEAD %q)", got)
		}
		if branchOID(t, repo, "fix-login") != "" {
			t.Fatal("this create's branch was left behind")
		}
		for _, c := range loggedGitCalls(t, log) {
			if len(c) >= 2 && c[0] == "worktree" && c[1] == "remove" {
				t.Fatalf("git %v ran against a worktree that is not this create's", c)
			}
		}
	})
}

// TestGitNeverGetsShortBranchName walks the three create paths and checks every
// argument git received: the branch only ever appears as a full ref name.
func TestGitNeverGetsShortBranchName(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("needs a non-writable directory")
	}
	okRepo := devflowRepo(t)
	failRepo := devflowRepo(t)
	startFailRepo := devflowRepo(t)
	admin := filepath.Join(failRepo, ".git", "worktrees")
	if err := os.Mkdir(admin, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(admin, 0o755) })
	log := installArgLoggingGit(t)

	m := NewManager(false, "/bin/cat", false, "")
	m.SetProjectStore(NewMemoryProjectStore())
	r, err := m.Create(CreateOptions{Workdir: okRepo, Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Kill() })
	if _, err := m.Create(CreateOptions{Workdir: failRepo, Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login", Cols: 80, Rows: 24}); err == nil {
		t.Fatal("create with a read-only .git/worktrees should fail")
	}
	broken := NewManager(false, "/definitely/missing-command", false, "")
	broken.SetProjectStore(NewMemoryProjectStore())
	if _, err := broken.Create(CreateOptions{Workdir: startFailRepo, Mode: protocol.SessionModeWorktree, WorktreeName: "fix-login", Cols: 80, Rows: 24}); err == nil {
		t.Fatal("create with a missing command should fail")
	}
	for _, repo := range []string{failRepo, startFailRepo} {
		if branchOID(t, repo, "fix-login") != "" || pathExists(filepath.Join(containerOf(repo), "fix-login")) {
			t.Fatalf("%s: the failed create left something", repo)
		}
	}

	// Fourth path: removing a worktree vibe-remote created, branch included.
	if err := m.Delete(r.ID); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(containerOf(okRepo), "fix-login")
	runGit(t, okRepo, "config", "branch.fix-login.remote", "origin")
	st, err := m.WorktreeStatus(root, allowAny)
	if err != nil {
		t.Fatal(err)
	}
	res, err := m.RemoveWorktree(protocol.WorktreeRemoveRequest{Path: st.Path, Head: st.Head, Sessions: st.Sessions, DeleteBranch: true}, allowAny)
	if err != nil || !res.Removed || !res.BranchDeleted {
		t.Fatalf("remove = %+v, %v", res, err)
	}

	calls := loggedGitCalls(t, log)
	seen := subcommands(calls)
	for _, want := range []string{"update-ref", "worktree", "symbolic-ref", "check-ref-format", "show-ref", "for-each-ref", "rev-list", "config"} {
		if seen[want] == 0 {
			t.Errorf("expected a git %s call on these paths; saw %v", want, seen)
		}
	}
	for _, c := range calls {
		if len(c) > 0 && c[0] == "branch" {
			t.Errorf("git branch was called: %v", c)
		}
		for i, a := range c {
			if a == "-b" || a == "-B" {
				t.Errorf("-b/-B passed to git: %v", c)
			}
			if !strings.Contains(a, "fix-login") {
				continue
			}
			switch {
			case a == "refs/heads/fix-login", a == "refs/heads/fix-login/":
			case a == "--exclude=fix-login", a == "branch.fix-login", a == "branch.fix-login.remote":
			case filepath.IsAbs(a) && filepath.Base(a) == "fix-login":
			case a == "fix-login" && i >= 2 && c[i-2] == "check-ref-format" && c[i-1] == "--branch":
			case a == "worktree: attached to refs/heads/fix-login" && i >= 1 && c[i-1] == "-m":
			default:
				t.Errorf("the branch reached git as %q in %v", a, c)
			}
		}
	}
}
