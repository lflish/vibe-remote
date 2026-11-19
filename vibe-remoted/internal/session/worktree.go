package session

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

type WorktreeMetadata struct {
	SourceWorkdir string
	SourceRepo    string
	WorktreeRoot  string
	Branch        string
}

// gitTimeout bounds the git calls used for read-only discovery (ListWorktrees,
// ResolveHome, worktree pre-checks). Tests may lower it. gitAt (the creation
// and cleanup path) is not time-bounded.
var gitTimeout = 5 * time.Second

// gitStrippedEnv are environment variables that would redirect git at another
// repository or index; a daemon started under one of them must not leak it into
// the worktree queries (design 4.9, V12).
var gitStrippedEnv = map[string]bool{
	"GIT_DIR": true, "GIT_WORK_TREE": true, "GIT_INDEX_FILE": true,
	"GIT_COMMON_DIR": true, "GIT_OBJECT_DIRECTORY": true, "GIT_NAMESPACE": true,
	"LC_ALL": true,
}

// gitEnv returns the process environment with the repository-redirecting
// variables removed and LC_ALL pinned to C, so git's output is stable and
// always describes the directory passed with -C.
func gitEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		key, _, _ := strings.Cut(kv, "=")
		if gitStrippedEnv[key] {
			continue
		}
		env = append(env, kv)
	}
	return append(env, "LC_ALL=C")
}

func gitAt(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = gitEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return out, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// gitAtTimeout runs git under gitTimeout. A deadline hit wraps
// context.DeadlineExceeded so callers can tell a timeout apart from a non-zero
// exit without matching git's message text. The child runs in its own process
// group, which is killed on timeout so a slow git (or its children) cannot
// linger.
func gitAtTimeout(dir string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = gitEnv()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
	cmd.WaitDelay = time.Second
	out, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return out, fmt.Errorf("git %s: %w", strings.Join(args, " "), context.DeadlineExceeded)
		}
		return out, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// Worktree is one entry of `git worktree list --porcelain`. Head is the 40-hex
// commit; Branch is the short name (empty when detached or bare).
type Worktree struct {
	Path, Branch, Head               string
	Detached, Bare, Prunable, Locked bool
	LockReason                       string
}

// ListWorktrees returns the worktrees of the repository that contains dir. The
// first entry is the main worktree (or, for a bare repo, the bare entry); paths
// are git's canonical paths.
func ListWorktrees(dir string) ([]Worktree, error) {
	out, err := gitAtTimeout(dir, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	var list []Worktree
	var cur *Worktree
	flush := func() {
		if cur != nil {
			list = append(list, *cur)
			cur = nil
		}
	}
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			flush()
			continue
		}
		key, val, _ := strings.Cut(line, " ")
		switch key {
		case "worktree":
			flush()
			cur = &Worktree{Path: val}
		case "HEAD":
			if cur != nil {
				cur.Head = val
			}
		case "branch":
			if cur != nil {
				cur.Branch = strings.TrimPrefix(val, "refs/heads/")
			}
		case "detached":
			if cur != nil {
				cur.Detached = true
			}
		case "bare":
			if cur != nil {
				cur.Bare = true
			}
		case "locked":
			if cur != nil {
				cur.Locked = true
				cur.LockReason = val
			}
		case "prunable":
			if cur != nil {
				cur.Prunable = true
			}
		}
	}
	flush()
	return list, nil
}

// Home is a session's project attribution (design 4.9, 5.1). For a non-git
// directory Project and Path are the directory itself and Repo is empty.
type Home struct {
	Project string // project id
	Path    string // root of the worktree the session sits in
	Repo    string // the directory git -C is run against = the first list entry
	Git     bool
	Single  bool // no recognizable main worktree (submodule, --separate-git-dir)
}

// ResolveHome computes the project attribution of dir. A directory that is not
// a git repository returns Home{Git:false} and a nil error; a git failure or
// timeout returns an error (the caller then records no attribution and retries
// later).
func ResolveHome(dir string) (Home, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return Home{}, err
	}
	out, err := gitAtTimeout(abs, "rev-parse", "--show-toplevel")
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return Home{}, err
		}
		// Not a repo vs. a real failure is decided by git exit codes and the
		// filesystem, never by matching message text (design 4.9).
		if inside, ierr := gitAtTimeout(abs, "rev-parse", "--is-inside-git-dir"); ierr == nil && strings.TrimSpace(string(inside)) == "true" {
			return Home{Project: abs, Path: abs, Git: false}, nil
		}
		if !hasGitAncestor(abs) {
			return Home{Project: abs, Path: abs, Git: false}, nil
		}
		return Home{}, err
	}
	top := filepath.Clean(strings.TrimSpace(string(out)))
	wts, err := ListWorktrees(top)
	if err != nil {
		return Home{}, err
	}
	if len(wts) == 0 {
		return Home{Project: top, Path: top, Repo: top, Git: true}, nil
	}
	first := wts[0]
	if first.Bare || hasDotGit(first.Path) {
		// Normal repository: the first entry is the main worktree.
		return Home{Project: first.Path, Path: top, Repo: first.Path, Git: true}, nil
	}
	// The first entry is a git directory (submodule, --separate-git-dir): there
	// is no main worktree to group under, so the project is this toplevel alone.
	return Home{Project: top, Path: top, Repo: first.Path, Git: true, Single: true}, nil
}

func hasDotGit(path string) bool {
	_, err := os.Stat(filepath.Join(path, ".git"))
	return err == nil
}

func hasGitAncestor(dir string) bool {
	for {
		if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil {
			return true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		dir = parent
	}
}

var safeSessionID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// Errors of the worktree-creating path (design 4.1, 4.9). Each maps to its own
// fatal attach error code; anything else is create_failed.
var (
	ErrInvalidWorktreeName    = errors.New("invalid worktree name")
	ErrWorktreeBranchExists   = errors.New("branch already exists")
	ErrWorktreePathExists     = errors.New("worktree directory already exists")
	ErrWorktreePathNotAllowed = errors.New("worktree path not allowed")
	ErrUnsupportedRepo        = errors.New("this repository is a submodule or uses a separate git directory; named worktrees are not supported here")
)

// Errors of looking at or removing a worktree (design 4.5, 4.6).
var (
	// ErrWorktreeNotFound: the path is not a worktree the daemon read from its
	// repository, or is outside the allowed roots.
	ErrWorktreeNotFound = errors.New("worktree not found")
	// ErrWorktreeIsMain: the path is a repository's main directory.
	ErrWorktreeIsMain = errors.New("the main directory of a repository cannot be removed")
	// ErrWorktreeBusy: a session was about to start in a worktree that is
	// being removed.
	ErrWorktreeBusy = errors.New("this worktree is being removed")
)

// WorktreeChangedError: the worktree is not in the state the user confirmed
// (409 worktree_changed). Status is the current state; EndedSessions are the
// sessions this removal had already ended when it noticed.
type WorktreeChangedError struct {
	Status        protocol.WorktreeStatus
	EndedSessions []string
}

func (e *WorktreeChangedError) Error() string {
	return fmt.Sprintf("worktree %s changed since it was confirmed", e.Status.Path)
}

// WorktreeRemoveError: the removal could not be done (500
// worktree_remove_failed). With no EndedSessions nothing was touched.
type WorktreeRemoveError struct {
	Message       string
	EndedSessions []string
}

func (e *WorktreeRemoveError) Error() string { return e.Message }

// nonEmptyLines counts the non-empty lines of a git listing.
func nonEmptyLines(out []byte) int {
	n := 0
	for _, line := range strings.Split(string(out), "\n") {
		if line != "" {
			n++
		}
	}
	return n
}

// DirtyFiles counts the uncommitted and untracked files of a worktree; files
// git ignores are not counted (H10). core.fsmonitor is the one setting that
// makes status run a program of the repository's choosing, so it is off.
func DirtyFiles(worktreeDir string) (int, error) {
	out, err := gitAtTimeout(worktreeDir, "-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all")
	if err != nil {
		return 0, fmt.Errorf("check worktree status: %w", err)
	}
	return nonEmptyLines(out), nil
}

// IgnoredFiles counts the files git ignores in a worktree: one per file, a
// directory is not folded into one entry, and a repository nested in an
// ignored directory counts once (design 3). It walks everything git ignores,
// so it can be slow where the tracked content is not.
func IgnoredFiles(worktreeDir string) (int, error) {
	out, err := gitAtTimeout(worktreeDir, "-c", "core.fsmonitor=false", "ls-files", "--others", "--ignored", "--exclude-standard")
	if err != nil {
		return 0, fmt.Errorf("count ignored files: %w", err)
	}
	return nonEmptyLines(out), nil
}

// HasSubmoduleCheckouts reports whether a worktree holds a checked-out
// submodule or embedded repository, by the two tests git itself applies before
// it refuses to remove a worktree (validate_no_submodules): the worktree's git
// directory has a modules/ directory, or the index has a gitlink whose path
// contains a .git. Such a checkout can hold commits that exist nowhere else.
func HasSubmoduleCheckouts(worktreeDir string) (bool, error) {
	out, err := gitAtTimeout(worktreeDir, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return false, fmt.Errorf("locate git directory: %w", err)
	}
	gitDir := strings.TrimSpace(string(out))
	if info, statErr := os.Stat(filepath.Join(gitDir, "modules")); statErr == nil && info.IsDir() {
		return true, nil
	}
	out, err = gitAtTimeout(worktreeDir, "ls-files", "--stage", "-z")
	if err != nil {
		return false, fmt.Errorf("read index: %w", err)
	}
	for _, entry := range strings.Split(string(out), "\x00") {
		// "<mode> <object> <stage>\t<path>"
		meta, name, ok := strings.Cut(entry, "\t")
		if !ok || !strings.HasPrefix(meta, "160000 ") {
			continue
		}
		if _, statErr := os.Lstat(filepath.Join(worktreeDir, name, ".git")); statErr == nil {
			return true, nil
		}
	}
	return false, nil
}

// BranchExistsError says which existing branch blocks the new one: the branch
// itself, or one git cannot keep next to it (fix blocks fix/login, change/foo
// blocks change). errors.Is(err, ErrWorktreeBranchExists) is true.
type BranchExistsError struct{ Branch, Conflict string }

func (e *BranchExistsError) Error() string {
	if e.Conflict == e.Branch {
		return fmt.Sprintf("branch %q already exists", e.Branch)
	}
	return fmt.Sprintf("branch %q cannot be created: branch %q already exists", e.Branch, e.Conflict)
}

func (e *BranchExistsError) Is(target error) bool { return target == ErrWorktreeBranchExists }

// WorktreeSpec describes the worktree to create. Name empty keeps the original
// naming (branch vibe/<SessionID>). AllowPath, when set, vets the new worktree
// root before anything is created and the session's final workdir afterwards.
type WorktreeSpec struct {
	Source, SessionID, Name string
	AllowPath               func(string) error
}

// CreatedWorktree is what CreateWorktree made; Undo removes exactly that.
type CreatedWorktree struct {
	Meta         WorktreeMetadata
	Workdir      string // the session's workdir (Source mapped into the new worktree)
	Home         Home
	OID          string // the commit the new branch was created at
	NewContainer bool   // the <repo>-worktrees directory was created by this call
}

// Test seams: after the pre-checks and before anything is claimed; after the
// directory and branch are claimed and before git worktree add.
var (
	testAfterCreateChecks func()
	testBeforeWorktreeAdd func()
)

// gitExitCode returns git's exit status when err is a plain non-zero exit, as
// opposed to a timeout or a failure to run git at all.
func gitExitCode(err error) (int, bool) {
	var exit *exec.ExitError
	if errors.As(err, &exit) && !errors.Is(err, context.DeadlineExceeded) {
		return exit.ExitCode(), true
	}
	return 0, false
}

// worktreeNameProblem applies the name rules that need no git (design 4.1,
// rule 1) and returns the reason code of the first one broken, or "". The
// desktop applies the same rules in the same order; both sides are held to
// testdata/worktree-names.json.
func worktreeNameProblem(name string) string {
	if name == "" {
		return "empty"
	}
	for _, r := range name {
		if unicode.IsSpace(r) {
			return "whitespace"
		}
	}
	if strings.Contains(name, "..") {
		return "dotdot"
	}
	if strings.HasPrefix(name, "-") {
		return "leading_dash"
	}
	// "@{" is git's syntax for the previous or upstream branch.
	if strings.Contains(name, "@{") {
		return "invalid"
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "invalid"
		}
	}
	return ""
}

// checkRefFormatBranch is rule 2: git accepts the name as a branch name and
// prints it back unchanged. Exit status alone is not enough: for "@{-1}" git
// exits 0 and prints the previously checked-out branch (V10).
func checkRefFormatBranch(repoDir, name string) error {
	out, err := gitAtTimeout(repoDir, "check-ref-format", "--branch", name)
	if err != nil {
		if _, exited := gitExitCode(err); exited {
			return fmt.Errorf("%w: %q", ErrInvalidWorktreeName, name)
		}
		return err
	}
	if strings.TrimSuffix(string(out), "\n") != name {
		return fmt.Errorf("%w: %q", ErrInvalidWorktreeName, name)
	}
	return nil
}

// ValidateWorktreeName reports whether name can be the branch of a new
// worktree in the repository at repoDir (errors.Is ErrInvalidWorktreeName when
// it cannot). Names that start with "-" or contain "@{" are refused before git
// is run at all.
func ValidateWorktreeName(repoDir, name string) error {
	if problem := worktreeNameProblem(name); problem != "" {
		return fmt.Errorf("%w: %q (%s)", ErrInvalidWorktreeName, name, problem)
	}
	return checkRefFormatBranch(repoDir, name)
}

// WorktreeDirName is the directory name of a named worktree.
func WorktreeDirName(name string) string { return strings.ReplaceAll(name, "/", "-") }

func branchRefExists(repoDir, branch string) (bool, error) {
	_, err := gitAtTimeout(repoDir, "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	if err == nil {
		return true, nil
	}
	if code, exited := gitExitCode(err); exited && code == 1 {
		return false, nil
	}
	return false, err
}

// BranchConflict returns the existing branch that keeps name from being
// created: name itself, one of its "/" prefixes (fix blocks fix/login), or a
// branch below it (change/foo blocks change). "" when nothing does. Read-only.
func BranchConflict(repoDir, name string) (string, error) {
	candidates := []string{name}
	for i := range name {
		if name[i] == '/' && i > 0 {
			candidates = append(candidates, name[:i])
		}
	}
	for _, c := range candidates {
		exists, err := branchRefExists(repoDir, c)
		if err != nil {
			return "", err
		}
		if exists {
			return c, nil
		}
	}
	out, err := gitAtTimeout(repoDir, "for-each-ref", "--count=1", "--format=%(refname)", "refs/heads/"+name+"/")
	if err != nil {
		return "", err
	}
	if ref := strings.TrimSpace(string(out)); ref != "" {
		return strings.TrimPrefix(ref, "refs/heads/"), nil
	}
	return "", nil
}

// errNotInGit marks a worktree request made from outside any git repository.
var errNotInGit = errors.New("is not inside a git repository")

func errNotGit(dir string) error {
	return fmt.Errorf("discover repository: %s %w", dir, errNotInGit)
}

// worktreeChecks is what the checks made before anything is created have
// established so far; a failed check leaves the fields of the later ones empty.
type worktreeChecks struct {
	sourceAbs string
	home      Home   // of the source directory
	rel       string // the source directory relative to its worktree root
	claim     worktreeClaim
}

// precheckWorktree runs design 6.1 steps 1–5 — everything that can refuse a
// worktree without creating or changing anything. CreateWorktree continues
// from its result and the pre-check endpoint reports it, so the two cannot
// disagree about a name. named=false is the original naming by session id.
func precheckWorktree(spec WorktreeSpec, named bool) (worktreeChecks, error) {
	var c worktreeChecks
	if !named && !safeSessionID.MatchString(spec.SessionID) {
		return c, fmt.Errorf("invalid session ID")
	}
	sourceAbs, err := filepath.Abs(spec.Source)
	if err != nil {
		return c, fmt.Errorf("resolve source workdir: %w", err)
	}
	c.sourceAbs = sourceAbs
	home, err := ResolveHome(sourceAbs)
	if err != nil {
		return c, fmt.Errorf("discover repository: %w", err)
	}
	if !home.Git {
		return c, errNotGit(sourceAbs)
	}
	c.home = home
	if named && home.Single {
		return c, ErrUnsupportedRepo
	}
	// Every git command from here on runs in the worktree Source sits in: it is
	// a usable work tree, and branches and worktrees are shared repository-wide.
	w := home.Path
	canonicalAbs, err := filepath.EvalSymlinks(sourceAbs)
	if err != nil {
		return c, fmt.Errorf("resolve source workdir links: %w", err)
	}
	canonicalRepo, err := filepath.EvalSymlinks(w)
	if err != nil {
		return c, fmt.Errorf("resolve repository links: %w", err)
	}
	c.rel, err = filepath.Rel(canonicalRepo, canonicalAbs)
	if err != nil || c.rel == ".." || strings.HasPrefix(c.rel, ".."+string(filepath.Separator)) {
		return c, fmt.Errorf("source workdir escapes repository")
	}

	claim := worktreeClaim{w: w}
	if named {
		if err := ValidateWorktreeName(w, spec.Name); err != nil {
			return c, err
		}
		claim.branch = spec.Name
		claim.container = filepath.Join(filepath.Dir(home.Project), filepath.Base(home.Project)+"-worktrees")
		claim.root = filepath.Join(claim.container, WorktreeDirName(spec.Name))
	} else {
		claim.branch = "vibe/" + spec.SessionID
		claim.container = filepath.Join(filepath.Dir(w), filepath.Base(w)+"-worktrees")
		claim.root = filepath.Join(claim.container, spec.SessionID)
	}
	c.claim = claim
	if err := allowWorktreePath(spec, claim.root); err != nil {
		return c, err
	}
	// The next two checks only fix the order errors are reported in; what
	// actually protects existing things is CreateWorktree's create-if-absent
	// claims.
	conflict, err := BranchConflict(w, claim.branch)
	if err != nil {
		return c, fmt.Errorf("check existing branches: %w", err)
	}
	if conflict != "" {
		return c, &BranchExistsError{Branch: claim.branch, Conflict: conflict}
	}
	if _, err := os.Lstat(claim.root); err == nil {
		return c, fmt.Errorf("%w: %s", ErrWorktreePathExists, claim.root)
	} else if !os.IsNotExist(err) {
		return c, fmt.Errorf("check worktree directory: %w", err)
	}
	return c, nil
}

func allowWorktreePath(spec WorktreeSpec, path string) error {
	if spec.AllowPath == nil {
		return nil
	}
	if err := spec.AllowPath(path); err != nil {
		return fmt.Errorf("%w: %s: %v", ErrWorktreePathNotAllowed, path, err)
	}
	return nil
}

// CreateWorktree creates a worktree on a new branch at Source's current commit
// (design 6.1). The directory and the branch are each claimed with a
// create-only-if-absent operation, so a failure can undo exactly what this
// call made and nothing that was already there. The branch is only ever named
// to git as refs/heads/<branch>. The caller holds the repository's lock.
func CreateWorktree(spec WorktreeSpec) (CreatedWorktree, error) {
	checks, err := precheckWorktree(spec, spec.Name != "")
	if err != nil {
		return CreatedWorktree{}, err
	}
	sourceAbs, home, rel, claim := checks.sourceAbs, checks.home, checks.rel, checks.claim
	w := claim.w
	allow := func(path string) error { return allowWorktreePath(spec, path) }
	out, err := gitAt(w, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil {
		return CreatedWorktree{}, fmt.Errorf("resolve source commit: %w", err)
	}
	claim.oid = strings.TrimSpace(string(out))
	if testAfterCreateChecks != nil {
		testAfterCreateChecks()
	}

	if _, err := os.Lstat(claim.container); os.IsNotExist(err) {
		if err := os.MkdirAll(claim.container, 0o755); err != nil {
			return CreatedWorktree{}, fmt.Errorf("create worktree container: %w", err)
		}
		claim.newContainer = true
	}
	if err := os.Mkdir(claim.root, 0o755); err != nil {
		undoErr := claim.undo()
		if os.IsExist(err) {
			return CreatedWorktree{}, withCleanup(fmt.Errorf("%w: %s", ErrWorktreePathExists, claim.root), undoErr)
		}
		return CreatedWorktree{}, withCleanup(fmt.Errorf("create worktree directory: %w", err), undoErr)
	}
	claim.dir = true
	// An empty old value makes update-ref create the branch only if it does not
	// exist. The message is what `git worktree add -b` writes to the reflog.
	if _, err := gitAt(w, "update-ref", "-m", "branch: Created from HEAD", "refs/heads/"+claim.branch, claim.oid, ""); err != nil {
		undoErr := claim.undo()
		if conflict, cerr := BranchConflict(w, claim.branch); cerr == nil && conflict != "" {
			return CreatedWorktree{}, withCleanup(&BranchExistsError{Branch: claim.branch, Conflict: conflict}, undoErr)
		}
		return CreatedWorktree{}, withCleanup(fmt.Errorf("create branch: %w", err), undoErr)
	}
	claim.branchRef = true
	if testBeforeWorktreeAdd != nil {
		testBeforeWorktreeAdd()
	}
	if _, err := gitAt(w, "worktree", "add", "--detach", claim.root, claim.oid); err != nil {
		return CreatedWorktree{}, withCleanup(fmt.Errorf("create worktree: %w", err), claim.undo())
	}
	// Not "checkout: moving from …": git resolves @{-1} from reflog entries of
	// that form, and a worktree made with -b has no previous branch (V22).
	if _, err := gitAt(claim.root, "symbolic-ref", "-m", "worktree: attached to refs/heads/"+claim.branch, "HEAD", "refs/heads/"+claim.branch); err != nil {
		return CreatedWorktree{}, withCleanup(fmt.Errorf("attach worktree to its branch: %w", err), claim.undo())
	}
	// From here on the worktree goes by the path and branch git registered,
	// which are what every later reading of the list is compared with. They are
	// not always the ones put together above: git resolves a symlinked
	// container, and on macOS it precomposes a decomposed Unicode name.
	registered, err := claim.registered()
	if err != nil {
		return CreatedWorktree{}, withCleanup(fmt.Errorf("read the new worktree back: %w", err), claim.undo())
	}
	claim.root, claim.branch = registered.Path, registered.Branch

	mapped := claim.root
	if rel != "." {
		mapped = filepath.Join(claim.root, rel)
		// Checked before creating it as well: when a leading part of rel is, in
		// the commit just checked out, a symlink out of the allowed roots,
		// MkdirAll would create the rest of the path over there.
		if err := allow(mapped); err != nil {
			return CreatedWorktree{}, withCleanup(err, claim.undo())
		}
		// Git does not materialize empty/untracked directories. Preserve the
		// caller's selected directory so Runner always receives a valid cwd.
		if err := os.MkdirAll(mapped, 0o755); err != nil {
			return CreatedWorktree{}, withCleanup(fmt.Errorf("create mapped workdir: %w", err), claim.undo())
		}
	}
	// The workdir exists now, so this resolves every symlink on the way to it.
	if err := allow(mapped); err != nil {
		return CreatedWorktree{}, withCleanup(err, claim.undo())
	}

	created := CreatedWorktree{
		Meta:         WorktreeMetadata{SourceWorkdir: sourceAbs, SourceRepo: w, WorktreeRoot: claim.root, Branch: claim.branch},
		Workdir:      mapped,
		Home:         Home{Project: home.Project, Path: claim.root, Repo: home.Repo, Git: true},
		OID:          claim.oid,
		NewContainer: claim.newContainer,
	}
	if home.Single {
		// A worktree of a repository with no recognizable main worktree is a
		// project of its own, as ResolveHome would say of it afterwards.
		created.Home.Project, created.Home.Single = claim.root, true
	}
	return created, nil
}

func withCleanup(err, cleanupErr error) error {
	if cleanupErr == nil {
		return err
	}
	return fmt.Errorf("%w; cleanup: %v", err, cleanupErr)
}

// worktreeClaim is what one CreateWorktree call has taken so far. undo gives
// back exactly that, deciding each step from the repository's state rather
// than from git's messages.
type worktreeClaim struct {
	w, root, branch, oid, container string
	dir, branchRef, newContainer    bool
}

// sameDir reports whether a and b name one directory: the same string, or the
// same file once symlinks and the file system's own folding of names are
// resolved. A path that does not exist is only equal to itself.
func sameDir(a, b string) bool {
	if a == b {
		return true
	}
	ai, err := os.Stat(a)
	if err != nil {
		return false
	}
	bi, err := os.Stat(b)
	if err != nil {
		return false
	}
	return os.SameFile(ai, bi)
}

// registered returns the entry git lists for the worktree just created in
// c.root. It fails when there is none, or when the entry is not on a branch:
// then the create did not produce what it set out to.
func (c worktreeClaim) registered() (Worktree, error) {
	wts, err := ListWorktrees(c.w)
	if err != nil {
		return Worktree{}, err
	}
	for _, wt := range wts {
		if !sameDir(wt.Path, c.root) {
			continue
		}
		if wt.Branch == "" {
			return Worktree{}, fmt.Errorf("git lists %s without a branch", wt.Path)
		}
		return wt, nil
	}
	return Worktree{}, fmt.Errorf("git does not list a worktree at %s", c.root)
}

func (c worktreeClaim) undo() error {
	var problems []string
	if c.dir {
		wts, err := ListWorktrees(c.w)
		if err != nil {
			problems = append(problems, fmt.Sprintf("registration of %s not checked: %v", c.root, err))
		}
		removeDir := true
		for _, wt := range wts {
			// By identity, not spelling: until the create has read the worktree
			// back, c.root is the path as put together here, and git may have
			// registered another spelling of it (a resolved symlink).
			if !sameDir(wt.Path, c.root) {
				continue
			}
			// Ours is on the branch claimed here, or still detached at the
			// commit (between worktree add and symbolic-ref). Anything else was
			// put into the claimed, still empty directory by someone else (V20).
			if wt.Branch == c.branch || (wt.Detached && wt.Head == c.oid) {
				if _, err := gitAt(c.w, "worktree", "remove", "--force", wt.Path); err != nil {
					problems = append(problems, fmt.Sprintf("worktree %s not removed: %v", c.root, err))
				}
			} else {
				removeDir = false
				problems = append(problems, fmt.Sprintf("directory %s not removed: it now holds another worktree", c.root))
			}
		}
		if removeDir {
			// Not recursive: a directory that still has content is kept.
			if err := os.Remove(c.root); err != nil && !os.IsNotExist(err) {
				problems = append(problems, fmt.Sprintf("directory %s not removed: %v", c.root, err))
			}
		}
	}
	if c.branchRef {
		// Deletes only while the branch still points at the commit it was created at.
		if _, err := gitAt(c.w, "update-ref", "-d", "refs/heads/"+c.branch, c.oid); err != nil {
			if exists, serr := branchRefExists(c.w, c.branch); serr != nil {
				problems = append(problems, fmt.Sprintf("branch %s not removed: %v", c.branch, err))
			} else if exists {
				at, _ := gitAt(c.w, "rev-parse", "--verify", "refs/heads/"+c.branch+"^{commit}")
				if cur := strings.TrimSpace(string(at)); cur != "" && cur != c.oid {
					problems = append(problems, fmt.Sprintf("branch %s kept: it now points at %s", c.branch, cur))
				} else {
					problems = append(problems, fmt.Sprintf("branch %s not removed: %v", c.branch, err))
				}
			}
		}
	}
	if c.newContainer {
		_ = os.Remove(c.container) // stays if anything else moved in
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

// Undo removes what CreateWorktree made and only that (design 6.1): the
// worktree if it is still this one, the directory if empty, the branch if it
// has not moved, the container if this call created it and it is empty. What
// is left in place is named in the returned error. Safe to call again.
func (c CreatedWorktree) Undo() error {
	return worktreeClaim{
		w: c.Meta.SourceRepo, root: c.Meta.WorktreeRoot, branch: c.Meta.Branch, oid: c.OID,
		container: filepath.Dir(c.Meta.WorktreeRoot), dir: true, branchRef: true, newContainer: c.NewContainer,
	}.undo()
}

// UnmergedCommits counts commits on branch that no other local branch or
// remote-tracking ref contains (H9, design 3). An empty branch counts the
// commits reachable from dir's detached HEAD instead. The branch is always
// named by its full ref form (refs/heads/<branch>): a short name that
// collides with a same-named tag would resolve to the tag and report 0 (V10).
func UnmergedCommits(dir, branch string) (int, error) {
	var args []string
	if branch == "" {
		args = []string{"rev-list", "--count", "HEAD", "--not", "--branches", "--remotes"}
	} else {
		args = []string{"rev-list", "--count", "refs/heads/" + branch, "--not", "--exclude=" + branch, "--branches", "--remotes"}
	}
	out, err := gitAt(dir, args...)
	if err != nil {
		return 0, fmt.Errorf("count unmerged commits: %w", err)
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return 0, fmt.Errorf("parse unmerged commit count: %w", err)
	}
	return n, nil
}
