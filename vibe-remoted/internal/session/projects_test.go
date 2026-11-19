package session

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
)

// planErrorOf is the plan error code CreateWorktree's error corresponds to.
func planErrorOf(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrInvalidWorktreeName):
		return "invalid_worktree_name"
	case errors.Is(err, ErrWorktreeBranchExists):
		return "worktree_branch_exists"
	case errors.Is(err, ErrWorktreePathExists):
		return "worktree_path_exists"
	case errors.Is(err, ErrWorktreePathNotAllowed):
		return "worktree_path_not_allowed"
	case errors.Is(err, ErrUnsupportedRepo):
		return "unsupported_repo"
	}
	return "other: " + err.Error()
}

// The pre-check and the create must agree: whatever the plan says about a name
// is what creating it then does.
func TestPlanMatchesCreate(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	repo := repoAt(t, filepath.Join(base, "devflow"))
	runGit(t, repo, "branch", "taken")
	runGit(t, repo, "branch", "fix")
	runGit(t, repo, "branch", "change/foo")
	if err := os.MkdirAll(filepath.Join(containerOf(repo), "occupied"), 0o755); err != nil {
		t.Fatal(err)
	}
	wide := allowWith(&config.Config{AllowedRoots: []string{base}})
	narrow := allowWith(&config.Config{AllowedRoots: []string{repo}})
	m := NewManager(false, "/bin/cat", false, "")

	for _, tc := range []struct {
		label, name string
		allow       func(string) error
		want        string
	}{
		{"valid", "fix-login", wide, ""},
		{"valid with a slash", "change/new", wide, ""},
		{"invalid name", "a b", wide, "invalid_worktree_name"},
		{"expansion syntax", "@{-1}", wide, "invalid_worktree_name"},
		{"branch exists", "taken", wide, "worktree_branch_exists"},
		{"blocked by a prefix branch", "fix/login", wide, "worktree_branch_exists"},
		{"blocked by a branch below it", "change", wide, "worktree_branch_exists"},
		{"directory exists", "occupied", wide, "worktree_path_exists"},
		{"outside the allowed roots", "elsewhere", narrow, "worktree_path_not_allowed"},
		// More than one thing wrong: both report the same one first.
		{"not allowed and branch exists", "taken", narrow, "worktree_path_not_allowed"},
	} {
		t.Run(tc.label, func(t *testing.T) {
			plan, err := m.PlanWorktree(repo, tc.name, tc.allow)
			if err != nil {
				t.Fatalf("PlanWorktree: %v", err)
			}
			if plan.Error != tc.want || plan.OK != (tc.want == "") {
				t.Fatalf("plan = %+v, want error %q", plan, tc.want)
			}
			created, cerr := CreateWorktree(WorktreeSpec{Source: repo, SessionID: "s1", Name: tc.name, AllowPath: tc.allow})
			if got := planErrorOf(cerr); got != plan.Error {
				t.Fatalf("plan said %q, create said %q (%v)", plan.Error, got, cerr)
			}
			var be *BranchExistsError
			if errors.As(cerr, &be) && be.Conflict != plan.Conflict {
				t.Fatalf("plan conflict %q, create conflict %q", plan.Conflict, be.Conflict)
			}
			if cerr == nil {
				if created.Meta.WorktreeRoot != plan.Path || created.Meta.Branch != plan.Branch || created.Home.Project != plan.Project {
					t.Fatalf("plan %+v, created %+v", plan, created)
				}
				if plan.Base == nil || plan.Base.Head != created.OID[:7] {
					t.Fatalf("plan base %+v, created at %s", plan.Base, created.OID)
				}
			}
		})
	}
}

func TestPlanWorktreeGitTimeout(t *testing.T) {
	repo := devflowRepo(t)
	dir := t.TempDir()
	writeFakeGit(t, dir, "#!/bin/sh\nexec sleep 5\n")
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	old := gitTimeout
	gitTimeout = 50 * time.Millisecond
	defer func() { gitTimeout = old }()

	m := NewManager(false, "/bin/cat", false, "")
	plan, err := m.PlanWorktree(repo, "fix-login", nil)
	if err == nil {
		t.Fatalf("PlanWorktree with a hanging git = %+v, want an error (not a not_git plan)", plan)
	}
}
