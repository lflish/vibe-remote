package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat"
)

// trustEnv points claude's config at a private temp dir for the test; the real
// ~/.claude.json is never read.
type trustEnv struct {
	t   *testing.T
	dir string
}

func newTrustEnv(t *testing.T) *trustEnv {
	t.Helper()
	e := &trustEnv{t: t, dir: t.TempDir()}
	t.Setenv("CLAUDE_CONFIG_DIR", e.dir)
	return e
}

// set replaces the trust file: each path gets hasTrustDialogAccepted = its value.
// The file carries other fields too, as claude's does.
func (e *trustEnv) set(records map[string]bool) {
	e.t.Helper()
	projects := map[string]any{}
	for path, accepted := range records {
		projects[path] = map[string]any{"hasTrustDialogAccepted": accepted, "allowedTools": []string{}}
	}
	data, err := json.Marshal(map[string]any{"numStartups": 3, "projects": projects})
	if err != nil {
		e.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.dir, ".claude.json"), data, 0o600); err != nil {
		e.t.Fatal(err)
	}
}

func canonPath(t *testing.T, p string) string {
	t.Helper()
	c, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func mkdirAll(t *testing.T, p string) string {
	t.Helper()
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// addWorktree adds a linked worktree on a new branch and returns its canonical path.
func addWorktree(t *testing.T, repo, path, branch string) string {
	t.Helper()
	mkdirAll(t, filepath.Dir(path))
	runGit(t, repo, "worktree", "add", "-b", branch, path)
	return canonPath(t, path)
}

func wantTrust(t *testing.T, dir string, want chat.TrustState) {
	t.Helper()
	if got := ChatTrust(dir); got != want {
		t.Fatalf("ChatTrust(%s) = %s, want %s", dir, got, want)
	}
}

// TestChatTrust is the chat interface's trust rule (design 7.3, spec H7): a
// directory counts when claude trusts it itself, or when it is the root of a
// worktree of a repository whose main directory — exactly that path — is
// trusted. `claude -p` runs a directory's hooks without asking, so every case
// that must NOT pass is spelled out.
func TestChatTrust(t *testing.T) {
	env := newTrustEnv(t)
	main := canonPath(t, tempRepo(t))
	// A linked worktree next to the repository, one in a hidden directory inside
	// it, and a second sibling.
	wt := addWorktree(t, main, filepath.Join(filepath.Dir(main), filepath.Base(main)+"-worktrees", "fix-login"), "fix-login")
	hidden := addWorktree(t, main, filepath.Join(main, ".devflow-tmp", "worktrees", "general-skills"), "change/general-skills")
	other := addWorktree(t, main, filepath.Join(filepath.Dir(main), filepath.Base(main)+"-worktrees", "other"), "other")
	plain := canonPath(t, t.TempDir())

	t.Run("self_trusted", func(t *testing.T) {
		env.set(map[string]bool{plain: true, main: true})
		wantTrust(t, plain, chat.TrustTrusted)
		wantTrust(t, main, chat.TrustTrusted)
	})

	t.Run("worktree_of_trusted_main", func(t *testing.T) {
		env.set(map[string]bool{main: true})
		wantTrust(t, wt, chat.TrustTrusted)
		wantTrust(t, hidden, chat.TrustTrusted)
	})

	t.Run("worktree_itself_trusted", func(t *testing.T) {
		env.set(map[string]bool{wt: true})
		wantTrust(t, wt, chat.TrustTrusted)
	})

	t.Run("neither_trusted", func(t *testing.T) {
		env.set(map[string]bool{plain: true})
		wantTrust(t, wt, chat.TrustUntrusted)
		wantTrust(t, hidden, chat.TrustUntrusted)
		wantTrust(t, main, chat.TrustUntrusted)
	})

	t.Run("main_false", func(t *testing.T) {
		env.set(map[string]bool{main: false})
		wantTrust(t, wt, chat.TrustUntrusted)
	})

	t.Run("self_false_main_trusted", func(t *testing.T) {
		env.set(map[string]bool{wt: false, main: true})
		wantTrust(t, wt, chat.TrustTrusted)
	})

	t.Run("subdir_of_worktree", func(t *testing.T) {
		env.set(map[string]bool{main: true})
		wantTrust(t, mkdirAll(t, filepath.Join(wt, "src")), chat.TrustUntrusted)
		wantTrust(t, mkdirAll(t, filepath.Join(hidden, "a", "b")), chat.TrustUntrusted)
	})

	t.Run("subdir_of_main", func(t *testing.T) {
		env.set(map[string]bool{main: true})
		wantTrust(t, mkdirAll(t, filepath.Join(main, "src")), chat.TrustUntrusted)
		// The directories that hold the hidden worktree are not worktree roots either.
		wantTrust(t, filepath.Join(main, ".devflow-tmp"), chat.TrustUntrusted)
		wantTrust(t, filepath.Join(main, ".devflow-tmp", "worktrees"), chat.TrustUntrusted)
	})

	t.Run("main_not_via_worktree", func(t *testing.T) {
		env.set(map[string]bool{wt: true})
		wantTrust(t, main, chat.TrustUntrusted)
	})

	t.Run("sibling_worktree_trusted", func(t *testing.T) {
		env.set(map[string]bool{other: true})
		wantTrust(t, wt, chat.TrustUntrusted)
		env.set(map[string]bool{hidden: true})
		wantTrust(t, wt, chat.TrustUntrusted)
	})

	t.Run("parent_of_main_trusted", func(t *testing.T) {
		env.set(map[string]bool{filepath.Dir(main): true, "/": true})
		wantTrust(t, wt, chat.TrustUntrusted)
		wantTrust(t, main, chat.TrustUntrusted)
	})

	t.Run("child_of_main_trusted", func(t *testing.T) {
		env.set(map[string]bool{filepath.Join(main, "src"): true, filepath.Join(main, ".git"): true})
		wantTrust(t, wt, chat.TrustUntrusted)
	})

	// A directory that calls itself a worktree of the trusted repository: its
	// .git file names one of that repository's worktree entries. git believes
	// it (rev-parse answers with the trusted repository's git dir, design V4);
	// the repository's own list does not have it.
	t.Run("forged_gitfile", func(t *testing.T) {
		env.set(map[string]bool{main: true})
		forged := canonPath(t, t.TempDir())
		entry := filepath.Join(main, ".git", "worktrees", "fix-login")
		if _, err := os.Stat(entry); err != nil {
			t.Fatalf("worktree entry: %v", err)
		}
		if err := os.WriteFile(filepath.Join(forged, ".git"), []byte("gitdir: "+entry+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		// The premise: git, asked from inside the forged directory, points at the trusted repository.
		common := runGit(t, forged, "rev-parse", "--path-format=absolute", "--git-common-dir")
		if canonPath(t, common) != filepath.Join(main, ".git") {
			t.Fatalf("premise: git-common-dir from the forged dir = %q, want the trusted repository's", common)
		}
		wantTrust(t, forged, chat.TrustUntrusted)
		wantTrust(t, mkdirAll(t, filepath.Join(forged, "sub")), chat.TrustUntrusted)
		// The real worktree is unaffected.
		wantTrust(t, wt, chat.TrustTrusted)
	})

	// Same idea with a private git dir whose commondir points at the trusted repository.
	t.Run("forged_commondir", func(t *testing.T) {
		env.set(map[string]bool{main: true})
		forged := canonPath(t, t.TempDir())
		fake := mkdirAll(t, filepath.Join(forged, ".fake"))
		for name, content := range map[string]string{
			"HEAD":      "ref: refs/heads/main\n",
			"commondir": filepath.Join(main, ".git") + "\n",
			"gitdir":    filepath.Join(forged, ".git") + "\n",
		} {
			if err := os.WriteFile(filepath.Join(fake, name), []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.WriteFile(filepath.Join(forged, ".git"), []byte("gitdir: "+fake+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		common := runGit(t, forged, "rev-parse", "--path-format=absolute", "--git-common-dir")
		if canonPath(t, common) != filepath.Join(main, ".git") {
			t.Fatalf("premise: git-common-dir from the forged dir = %q, want the trusted repository's", common)
		}
		wantTrust(t, forged, chat.TrustUntrusted)
	})

	// .git as a symlink to the trusted repository's git dir.
	t.Run("forged_git_symlink", func(t *testing.T) {
		env.set(map[string]bool{main: true})
		forged := canonPath(t, t.TempDir())
		if err := os.Symlink(filepath.Join(main, ".git"), filepath.Join(forged, ".git")); err != nil {
			t.Fatal(err)
		}
		wantTrust(t, forged, chat.TrustUntrusted)
	})

	// Only the exact path the repository lists counts: a symlink that leads to
	// a worktree root is not that path. (Callers pass canonical paths.)
	t.Run("symlink_to_worktree", func(t *testing.T) {
		env.set(map[string]bool{main: true})
		link := filepath.Join(canonPath(t, t.TempDir()), "link")
		if err := os.Symlink(wt, link); err != nil {
			t.Fatal(err)
		}
		wantTrust(t, link, chat.TrustUntrusted)
		wantTrust(t, wt, chat.TrustTrusted)
		// A symlink that leads to the trusted main directory does not make the
		// main directory's own record apply to anything else either.
		mainLink := filepath.Join(filepath.Dir(link), "main-link")
		if err := os.Symlink(main, mainLink); err != nil {
			t.Fatal(err)
		}
		wantTrust(t, filepath.Join(mainLink, "src"), chat.TrustUntrusted)
	})

	// Another repository that merely sits inside the trusted one.
	t.Run("nested_repo_in_main", func(t *testing.T) {
		env.set(map[string]bool{main: true})
		nested := mkdirAll(t, filepath.Join(main, "vendor", "lib"))
		runGit(t, nested, "init")
		runGit(t, nested, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "--allow-empty", "-m", "init")
		wantTrust(t, nested, chat.TrustUntrusted)
		nestedWT := addWorktree(t, nested, filepath.Join(main, "vendor", "lib-wt"), "x")
		wantTrust(t, nestedWT, chat.TrustUntrusted)
	})

	t.Run("bare_repo", func(t *testing.T) {
		bare := filepath.Join(canonPath(t, t.TempDir()), "bare.git")
		runGit(t, main, "clone", "--bare", main, bare)
		bareWT := addWorktree(t, bare, filepath.Join(filepath.Dir(bare), "bare-wt"), "from-bare")
		env.set(map[string]bool{bare: true, filepath.Dir(bare): true})
		wantTrust(t, bareWT, chat.TrustUntrusted)
		env.set(map[string]bool{bareWT: true})
		wantTrust(t, bareWT, chat.TrustTrusted)
	})

	t.Run("submodule", func(t *testing.T) {
		super := canonPath(t, tempRepo(t))
		runGit(t, super, "-c", "protocol.file.allow=always", "submodule", "add", tempRepo(t), "sub")
		runGit(t, super, "commit", "-m", "add submodule")
		sub := filepath.Join(super, "sub")
		gitDir := filepath.Join(super, ".git", "modules", "sub")
		subWT := addWorktree(t, sub, filepath.Join(canonPath(t, t.TempDir()), "sub-wt"), "from-sub")
		wts, err := ListWorktrees(subWT)
		if err != nil || len(wts) < 2 || wts[0].Path != gitDir {
			t.Fatalf("premise: first entry of a submodule's list should be its git dir: %+v %v", wts, err)
		}
		// The submodule's working directory, its git dir and the superproject are all trusted.
		env.set(map[string]bool{sub: true, gitDir: true, super: true})
		wantTrust(t, subWT, chat.TrustUntrusted)
		wantTrust(t, sub, chat.TrustTrusted)
		env.set(map[string]bool{subWT: true})
		wantTrust(t, subWT, chat.TrustTrusted)
	})

	t.Run("separate_git_dir", func(t *testing.T) {
		base := canonPath(t, t.TempDir())
		work := mkdirAll(t, filepath.Join(base, "work"))
		gitDir := filepath.Join(base, "gitdir")
		runGit(t, work, "init", "--separate-git-dir", gitDir)
		runGit(t, work, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "--allow-empty", "-m", "init")
		sepWT := addWorktree(t, work, filepath.Join(base, "sep-wt"), "from-sep")
		env.set(map[string]bool{work: true, gitDir: true, base: true})
		wantTrust(t, sepWT, chat.TrustUntrusted)
		env.set(map[string]bool{sepWT: true})
		wantTrust(t, sepWT, chat.TrustTrusted)
	})

	// A listed worktree whose directory was deleted and later reappeared as a
	// plain directory: git marks the entry prunable.
	t.Run("prunable", func(t *testing.T) {
		gone := addWorktree(t, main, filepath.Join(main, ".wt", "gone"), "gone")
		if err := os.RemoveAll(gone); err != nil {
			t.Fatal(err)
		}
		mkdirAll(t, gone)
		wts, err := ListWorktrees(gone)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, w := range wts {
			if w.Path == gone {
				found = w.Prunable
			}
		}
		if !found {
			t.Fatalf("premise: %s should be listed as prunable: %+v", gone, wts)
		}
		env.set(map[string]bool{main: true})
		wantTrust(t, gone, chat.TrustUntrusted)
		runGit(t, main, "worktree", "prune")
	})

	t.Run("non_git_untrusted", func(t *testing.T) {
		env.set(map[string]bool{main: true})
		wantTrust(t, plain, chat.TrustUntrusted)
	})

	// git cannot answer in time: refuse.
	t.Run("git_timeout", func(t *testing.T) {
		env.set(map[string]bool{main: true})
		bin := t.TempDir()
		writeFakeGit(t, bin, "#!/bin/sh\nexec sleep 5\n")
		t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
		old := gitTimeout
		gitTimeout = 50 * time.Millisecond
		defer func() { gitTimeout = old }()
		wantTrust(t, wt, chat.TrustUntrusted)
	})

	// Without a readable trust file nothing is trusted, and git is not even asked.
	t.Run("config_missing", func(t *testing.T) {
		bin := t.TempDir()
		calls := filepath.Join(bin, "calls")
		writeFakeGit(t, bin, "#!/bin/sh\necho \"$@\" >> '"+calls+"'\nexec '"+realGit(t)+"' \"$@\"\n")
		t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

		if err := os.Remove(filepath.Join(env.dir, ".claude.json")); err != nil {
			t.Fatal(err)
		}
		wantTrust(t, wt, chat.TrustUnknown)
		wantTrust(t, main, chat.TrustUnknown)
		if err := os.WriteFile(filepath.Join(env.dir, ".claude.json"), []byte("{not json"), 0o600); err != nil {
			t.Fatal(err)
		}
		wantTrust(t, wt, chat.TrustUnknown)
		if data, err := os.ReadFile(calls); err == nil {
			t.Fatalf("git was called without a readable trust file:\n%s", data)
		}
		// The counter itself works: with a trust file the worktree lookup does call git.
		env.set(map[string]bool{main: true})
		wantTrust(t, wt, chat.TrustTrusted)
		data, err := os.ReadFile(calls)
		if err != nil || !strings.Contains(string(data), "worktree list") {
			t.Fatalf("expected git worktree list calls, got %q (%v)", data, err)
		}
		// A directory claude trusts itself needs no git either.
		if err := os.Remove(calls); err != nil {
			t.Fatal(err)
		}
		wantTrust(t, main, chat.TrustTrusted)
		if data, err := os.ReadFile(calls); err == nil {
			t.Fatalf("git was called for a directory that is trusted itself:\n%s", data)
		}
	})
}
