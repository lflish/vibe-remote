package session

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
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
	meta, mapped, err := CreateWorktree(sub, "abc123")
	if err != nil {
		t.Fatal(err)
	}
	defer CleanupWorktree(meta)
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
			_, _, err := CreateWorktree(repo, sessionID)
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

	meta, mapped, err := CreateWorktree(alias, "symlinked")
	if err != nil {
		t.Fatal(err)
	}
	defer CleanupWorktree(meta)
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
	meta, mapped, err := CreateWorktree(sub, "nested")
	if err != nil {
		t.Fatal(err)
	}
	defer CleanupWorktree(meta)
	expected := filepath.Join(meta.WorktreeRoot, "a", "b")
	if mapped != expected {
		t.Fatalf("mapped=%q want %q", mapped, expected)
	}
	if info, err := os.Stat(mapped); err != nil || !info.IsDir() {
		t.Fatalf("mapped workdir was not preserved as a directory: info=%v err=%v", info, err)
	}
}

func TestWorktreeRejectsNonGitDirectory(t *testing.T) {
	_, _, err := CreateWorktree(t.TempDir(), "nope")
	if err == nil || !strings.Contains(err.Error(), "discover repository") {
		t.Fatalf("err=%v", err)
	}
}

func TestWorktreeGeneratedBranchAndPath(t *testing.T) {
	repo := tempRepo(t)
	meta, _, err := CreateWorktree(repo, "session-1")
	if err != nil {
		t.Fatal(err)
	}
	defer CleanupWorktree(meta)
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

func TestWorktreeCleanCleanupRemovesWorktreeAndBranch(t *testing.T) {
	repo := tempRepo(t)
	meta, _, err := CreateWorktree(repo, "clean")
	if err != nil {
		t.Fatal(err)
	}
	if err := CleanupWorktree(meta); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(meta.WorktreeRoot); !os.IsNotExist(err) {
		t.Fatalf("worktree still exists: %v", err)
	}
	if got := runGit(t, repo, "branch", "--list", meta.Branch); got != "" {
		t.Fatalf("branch still exists: %q", got)
	}
}

func TestWorktreeDirtyCleanupPreservesBoth(t *testing.T) {
	repo := tempRepo(t)
	meta, _, err := CreateWorktree(repo, "dirty")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(meta.WorktreeRoot, "changed"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	err = CleanupWorktree(meta)
	var preserved *WorktreePreservedError
	if !asPreserved(err, &preserved) {
		t.Fatalf("err=%T %v", err, err)
	}
	if preserved.WorktreeRoot != meta.WorktreeRoot || preserved.Branch != meta.Branch {
		t.Fatalf("preserved=%+v", preserved)
	}
	if _, err := os.Stat(meta.WorktreeRoot); err != nil {
		t.Fatal(err)
	}
	if got := runGit(t, repo, "branch", "--list", meta.Branch); !strings.Contains(got, meta.Branch) {
		t.Fatal(got)
	}
}

func TestWorktreeIgnoredFileIsPreserved(t *testing.T) {
	repo := tempRepo(t)
	if err := os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("ignored.txt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", ".gitignore")
	runGit(t, repo, "commit", "-m", "ignore")
	meta, _, err := CreateWorktree(repo, "ignored")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(meta.WorktreeRoot, "ignored.txt"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	err = CleanupWorktree(meta)
	if err == nil {
		t.Fatal("ignored file cleanup unexpectedly succeeded")
	}
	var preserved *WorktreePreservedError
	if !asPreserved(err, &preserved) {
		t.Fatalf("err=%T %v", err, err)
	}
}
func TestWorktreeRollbackToleratesMissingWorktreeOrBranch(t *testing.T) {
	repo := tempRepo(t)
	meta, _, err := CreateWorktree(repo, "rollback")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(meta.WorktreeRoot); err != nil {
		t.Fatal(err)
	}
	if err := RollbackWorktree(meta); err != nil {
		t.Fatal(err)
	}
	if err := RollbackWorktree(meta); err != nil {
		t.Fatal(err)
	}
}

func asPreserved(err error, target **WorktreePreservedError) bool {
	if err == nil {
		return false
	}
	p, ok := err.(*WorktreePreservedError)
	if ok {
		*target = p
	}
	return ok
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

func TestCleanupKeepsCleanWorktreeWithUnmergedCommits(t *testing.T) {
	repo := tempRepo(t)
	base := runGit(t, repo, "rev-parse", "HEAD")
	meta, _, err := CreateWorktree(repo, "unmerged")
	if err != nil {
		t.Fatal(err)
	}
	runGit(t, meta.WorktreeRoot, "commit", "--allow-empty", "-m", "c1")
	runGit(t, meta.WorktreeRoot, "commit", "--allow-empty", "-m", "c2")

	err = CleanupWorktree(meta)
	var preserved *WorktreePreservedError
	if !asPreserved(err, &preserved) {
		t.Fatalf("err=%T %v", err, err)
	}
	if _, statErr := os.Stat(meta.WorktreeRoot); statErr != nil {
		t.Fatalf("worktree dir was removed: %v", statErr)
	}
	if got := runGit(t, repo, "branch", "--list", meta.Branch); !strings.Contains(got, meta.Branch) {
		t.Fatalf("branch removed: %q", got)
	}
	if got := runGit(t, repo, "rev-list", "--count", base+".."+"refs/heads/"+meta.Branch); got != "2" {
		t.Fatalf("unmerged count = %q, want 2", got)
	}
}

func TestCleanupKeepsBranchWhenWorktreeDirMissing(t *testing.T) {
	repo := tempRepo(t)
	meta, _, err := CreateWorktree(repo, "missingdir")
	if err != nil {
		t.Fatal(err)
	}
	runGit(t, meta.WorktreeRoot, "commit", "--allow-empty", "-m", "c1")
	runGit(t, meta.WorktreeRoot, "commit", "--allow-empty", "-m", "c2")
	if err := os.RemoveAll(meta.WorktreeRoot); err != nil {
		t.Fatal(err)
	}

	err = CleanupWorktree(meta)
	var preserved *WorktreePreservedError
	if !asPreserved(err, &preserved) {
		t.Fatalf("err=%T %v", err, err)
	}
	if got := runGit(t, repo, "branch", "--list", meta.Branch); !strings.Contains(got, meta.Branch) {
		t.Fatalf("branch removed: %q", got)
	}
}

func TestCleanupFailsClosedWhenUnmergedCheckFails(t *testing.T) {
	repo := tempRepo(t)
	meta, _, err := CreateWorktree(repo, "failclosed")
	if err != nil {
		t.Fatal(err)
	}
	broken := meta
	broken.SourceRepo = filepath.Join(t.TempDir(), "does-not-exist")

	err = CleanupWorktree(broken)
	if err == nil {
		t.Fatal("expected error when the unmerged check fails")
	}
	var preserved *WorktreePreservedError
	if asPreserved(err, &preserved) {
		t.Fatalf("want a plain error, got preserved: %v", err)
	}
	if _, statErr := os.Stat(meta.WorktreeRoot); statErr != nil {
		t.Fatalf("worktree dir was removed: %v", statErr)
	}
	if got := runGit(t, repo, "branch", "--list", meta.Branch); !strings.Contains(got, meta.Branch) {
		t.Fatalf("branch removed: %q", got)
	}
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
