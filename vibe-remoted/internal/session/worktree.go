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
	"sync"
	"sync/atomic"
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

// Every git process the daemon starts is time-bounded: several of them run
// while a repository's lock is held (creating, undoing and removing a
// worktree), and one that never came back would block every later create and
// removal in that repository for good. A call that runs out of time is killed
// with its process group and counts as a failure. Tests may lower the limits.
//
// The limits are wide; what they are measured against (macOS, SSD, a
// repository of 20,000 files and 20,000 commits):
//
//   - gitTimeout: lookups (worktree list, rev-parse, status, the pre-checks)
//     and single ref updates (update-ref, symbolic-ref, config), 15–20 ms each.
//   - gitCountTimeout: rev-list --count over a branch's unmerged commits,
//     0.08 s for 20,000 of them (so 360 times that).
//   - gitTreeTimeout: git worktree add and git worktree remove, which write or
//     delete every file of the work tree (and add runs the post-checkout
//     hook): 2.3 s and 1.6 s (so 130 times the slower one; 20 times is still
//     kept for a work tree six times that size).
var (
	gitTimeout      = 5 * time.Second
	gitCountTimeout = 30 * time.Second
	gitTreeTimeout  = 5 * time.Minute
)

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
// always describes the directory passed with -C. Configuration the daemon's
// own environment passes to git (GIT_CONFIG_COUNT, GIT_CONFIG_PARAMETERS) is
// left as it is.
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

// gitFixedArgs start every git command line of the daemon, before -C and the
// subcommand. They turn core.fsmonitor off: that setting makes any command
// that reads the index run a program named in the repository's configuration,
// and the daemon does not run that program — not to look at a worktree, and
// not to create or remove one. It is given as -c, which every git version
// reads, which ranks above the configuration files and whatever the
// environment passes, and which git hands on (GIT_CONFIG_PARAMETERS) to the
// git processes it starts itself: `git worktree remove` runs a status of its
// own. The environment form, GIT_CONFIG_COUNT, is ignored by git before 2.31.
//
// This is about core.fsmonitor only. A repository's clean and smudge filters
// and its hooks are git's own business and do run: a status re-filters a file
// whose timestamp changed, and `git worktree add` checks files out and runs
// post-checkout.
var gitFixedArgs = []string{"-c", "core.fsmonitor=false"}

// gitAtTimeout runs git under gitTimeout; see gitWithin.
func gitAtTimeout(dir string, args ...string) ([]byte, error) {
	return gitWithin(gitTimeout, dir, args...)
}

// gitWithin runs git in dir and gives it timeout to finish. A deadline hit
// wraps context.DeadlineExceeded so callers can tell a timeout apart from a
// non-zero exit without matching git's message text. The child runs in its own
// process group, which is killed on timeout so a slow git (or its children:
// a hook, a pager) cannot linger.
func gitWithin(timeout time.Duration, dir string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	argv := append(append(append([]string{}, gitFixedArgs...), "-C", dir), args...)
	cmd := exec.CommandContext(ctx, "git", argv...)
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
			return out, fmt.Errorf("git %s: no answer within %s: %w", strings.Join(args, " "), timeout, context.DeadlineExceeded)
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

// gitUsageError is the exit status of a git command that was given an option
// it does not know.
const gitUsageError = 129

// gitListZ is what is known, per git executable, about `worktree list -z`:
// -z is git 2.36, and Ubuntu 22.04 still ships 2.34. The first reading with a
// given git finds out (asked finishes it; readings that arrive meanwhile wait
// for it rather than each asking on their own), and a git that answered with a
// usage error is asked for the line-separated list straight away from then on.
type gitListZ struct {
	asked   sync.Once
	without atomic.Bool
}

var gitListZByPath sync.Map // git executable → *gitListZ

// ListWorktrees returns the worktrees of the repository that contains dir. The
// first entry is the main worktree (or, for a bare repo, the bare entry); paths
// are git's canonical paths.
//
// The list is read NUL-separated (-z), which is the only form that can carry
// every path: a directory name may contain a newline, and in the
// line-separated list such a path is cut into lines that read like other
// entries. A git that does not know -z is asked for the lines instead, and
// what it answers is not believed on its own (worktreesFromLines): there, a
// worktree whose path has a newline in it is not listed, and nothing it was
// cut into is.
func ListWorktrees(dir string) ([]Worktree, error) {
	gitPath, _ := exec.LookPath("git")
	known, _ := gitListZByPath.LoadOrStore(gitPath, &gitListZ{})
	z := known.(*gitListZ)
	listZ := func() ([]byte, error) {
		out, err := gitAtTimeout(dir, "worktree", "list", "--porcelain", "-z")
		if code, exited := gitExitCode(err); exited && code == gitUsageError {
			z.without.Store(true)
		}
		return out, err
	}
	var out []byte
	var err error
	first := false
	z.asked.Do(func() {
		first = true
		out, err = listZ()
	})
	if !z.without.Load() {
		if !first {
			out, err = listZ()
		}
		if err == nil {
			return parseWorktreeList(string(out), "\x00"), nil
		}
		if !z.without.Load() {
			return nil, err // any failure but "this git does not know -z"
		}
	}
	out, err = gitAtTimeout(dir, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	return worktreesFromLines(dir, string(out))
}

// errWorktreeLines is why a line-separated worktree list was not used.
func errWorktreeLines(dir, why string) error {
	return fmt.Errorf("git worktree list in %s cannot be read line by line: %s; this git does not know `worktree list -z` (git 2.36 and later do), which is the form that can carry a path with a newline in it", dir, why)
}

// worktreesFromLines turns the line-separated list git gave for dir into
// worktrees. A path with a newline in it is cut into lines there, and the
// lines can be anything, a whole entry of another path included, so the shape
// of the lines (parseWorktreeList) cannot say which entries are real. What can
// is where git itself has the list from: the back-pointers under the
// repository's git directory, <common dir>/worktrees/<id>/gitdir, each a file
// holding one path whole. So:
//
//   - the first entry has to be the repository dir is in: the directory its
//     path names (or the .git in it) is the git directory found from dir on
//     the file system. If it is not, the main directory's own path was cut,
//     and the reading fails; the next entry is never taken for it.
//   - every other entry is kept only if its path is one of the back-pointers,
//     and only if no other entry of the list has the same path (a path that
//     was cut can name a real worktree; which of the two entries is the real
//     one cannot be told, so neither is listed).
//
// A worktree whose path has a newline in it is therefore never listed here,
// and nothing it was cut into is; other worktrees are, unless a cut path names
// them. Nothing is run for this: it is a few small files per reading.
func worktreesFromLines(dir, out string) ([]Worktree, error) {
	parsed := parseWorktreeList(out, "\n")
	if len(parsed) == 0 {
		return nil, errWorktreeLines(dir, "the entry of the main directory is not whole")
	}
	common, err := gitCommonDirOf(dir)
	if err != nil {
		return nil, errWorktreeLines(dir, err.Error())
	}
	main := parsed[0]
	if !sameFile(filepath.Join(main.Path, ".git"), common) && !sameFile(main.Path, common) {
		return nil, errWorktreeLines(dir, fmt.Sprintf("its first entry, %q, is not the repository at %q", main.Path, common))
	}
	registered, err := registeredWorktreePaths(common)
	if err != nil {
		return nil, errWorktreeLines(dir, err.Error())
	}
	seen := map[string]int{}
	for _, wt := range parsed[1:] {
		seen[wt.Path]++
	}
	list := []Worktree{main}
	for _, wt := range parsed[1:] {
		if registered[wt.Path] && seen[wt.Path] == 1 {
			list = append(list, wt)
		}
	}
	return list, nil
}

func sameFile(a, b string) bool {
	ai, err := os.Stat(a)
	if err != nil {
		return false
	}
	bi, err := os.Stat(b)
	return err == nil && os.SameFile(ai, bi)
}

// gitCommonDirOf finds, on the file system and the way git does, the git
// directory shared by the worktrees of the repository dir is in: the nearest
// .git going up from dir (a directory, or a file that names one), or dir's
// nearest ancestor that is itself a git directory; and from there the
// directory its commondir file names, if it has one (a linked worktree).
func gitCommonDirOf(dir string) (string, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	for d := abs; ; {
		dotGit := filepath.Join(d, ".git")
		if fi, err := os.Stat(dotGit); err == nil {
			if fi.IsDir() {
				return commonDirOfGitDir(dotGit), nil
			}
			data, err := os.ReadFile(dotGit)
			if err != nil {
				return "", err
			}
			target, ok := strings.CutPrefix(strings.TrimRight(string(data), "\r\n"), "gitdir: ")
			if !ok {
				return "", fmt.Errorf("%s is not a gitdir file", dotGit)
			}
			if !filepath.IsAbs(target) {
				target = d + string(filepath.Separator) + target
			}
			return commonDirOfGitDir(target), nil
		}
		if isGitDir(d) {
			return commonDirOfGitDir(d), nil
		}
		parent := filepath.Dir(d)
		if parent == d {
			return "", fmt.Errorf("no git directory found from %s", abs)
		}
		d = parent
	}
}

// commonDirOfGitDir follows gitDir's commondir file. The path is put together
// without cleaning it: a ".." in it is resolved by the file system, as git
// does.
func commonDirOfGitDir(gitDir string) string {
	data, err := os.ReadFile(filepath.Join(gitDir, "commondir"))
	if err != nil {
		return gitDir
	}
	target := strings.TrimRight(string(data), "\r\n")
	if filepath.IsAbs(target) {
		return target
	}
	return gitDir + string(filepath.Separator) + target
}

func isGitDir(dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, "HEAD")); err != nil {
		return false
	}
	for _, sub := range []string{"objects", "refs"} {
		if fi, err := os.Stat(filepath.Join(dir, sub)); err != nil || !fi.IsDir() {
			return false
		}
	}
	return true
}

// worktreeRegistrations reads the linked worktrees a repository has on
// record, the way git reads them for its list: each
// <common dir>/worktrees/<id>/gitdir holds "<path>/.git". It returns the path
// by id. A file that cannot be read or does not have that form is skipped, as
// git skips it; no worktrees directory means there are none.
func worktreeRegistrations(common string) (map[string]string, error) {
	base := filepath.Join(common, "worktrees")
	ids, err := os.ReadDir(base)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	paths := map[string]string{}
	for _, id := range ids {
		data, err := os.ReadFile(filepath.Join(base, id.Name(), "gitdir"))
		if err != nil {
			continue
		}
		if path, ok := strings.CutSuffix(strings.TrimRight(string(data), " \t\r\n"), "/.git"); ok && filepath.IsAbs(path) {
			paths[id.Name()] = path
		}
	}
	return paths, nil
}

// registeredWorktreePaths is worktreeRegistrations as a set of paths.
func registeredWorktreePaths(common string) (map[string]bool, error) {
	byID, err := worktreeRegistrations(common)
	if err != nil {
		return nil, err
	}
	paths := map[string]bool{}
	for _, path := range byID {
		paths[path] = true
	}
	return paths, nil
}

// gitCommonDir asks git for the git directory the worktrees of the repository
// in dir share, as an absolute path.
func gitCommonDir(dir string) (string, error) {
	out, err := gitAtTimeout(dir, "rev-parse", "--git-common-dir")
	if err != nil {
		return "", err
	}
	common := strings.TrimSuffix(string(out), "\n")
	if common == "" {
		return "", fmt.Errorf("git rev-parse --git-common-dir in %s gave nothing", dir)
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(dir, common)
	}
	if resolved, err := filepath.EvalSymlinks(common); err == nil {
		common = resolved
	}
	return common, nil
}

var gitObjectName = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

// parseWorktreeList reads `git worktree list --porcelain`: attributes one per
// line (sep is "\n") or, with -z, NUL-terminated (sep is "\x00"), an empty one
// between worktrees. An entry that cannot be a worktree — its path is not
// absolute, or it has no HEAD and is not bare — is left out.
//
// NUL-separated, an attribute is whatever git wrote, and one this code does
// not know is skipped. Line by line that cannot be assumed: a path with a
// newline in it is cut into lines. There an entry has to have the shape git
// gives one, in git's order:
//
//	worktree <absolute path>
//	bare                         or   HEAD <object name>
//	                                  branch refs/…   or   detached   (or neither)
//	locked[ <reason>]            (optional)
//	prunable[ <reason>]          (optional)
//
// and an entry with any other line in it, or with a line out of place, is
// left out. A "worktree" line that does not follow an empty line is the
// middle of something: what it starts is left out, and so is the entry before
// it. When the first entry is among those left out there is no main
// directory to speak of, and nothing is returned (nil): the entry after it is
// not the main directory.
//
// This is not what makes the line-separated list safe to use — the lines of a
// cut path can have exactly this shape; see worktreesFromLines.
func parseWorktreeList(out, sep string) []Worktree {
	strict := sep == "\n"
	type entry struct {
		wt    Worktree
		stage int // strict: how far through the shape the entry is
		bad   bool
	}
	var entries []*entry
	var cur *entry
	blank := true // the previous line was empty, or there was none
	// place checks that an attribute comes where git writes it: when the entry
	// is at a stage from lo to hi. The entry is then at stage next.
	place := func(e *entry, lo, hi, next int, ok bool) {
		if strict && (e.stage < lo || e.stage > hi || !ok) {
			e.bad = true
		}
		e.stage = next
	}
	for _, line := range strings.Split(out, sep) {
		if line == "" {
			cur, blank = nil, true
			continue
		}
		key, val, hasVal := strings.Cut(line, " ")
		if key == "worktree" {
			e := &entry{wt: Worktree{Path: val}, stage: 1}
			if strict && !blank {
				e.bad = true
				if n := len(entries); n > 0 {
					entries[n-1].bad = true
				}
			}
			entries = append(entries, e)
			cur, blank = e, false
			continue
		}
		blank = false
		if cur == nil {
			// Attributes with no "worktree" line before them: not an entry.
			continue
		}
		switch key {
		case "HEAD":
			place(cur, 1, 1, 2, gitObjectName.MatchString(val))
			cur.wt.Head = val
		case "branch":
			place(cur, 2, 2, 3, strings.HasPrefix(val, "refs/"))
			cur.wt.Branch = strings.TrimPrefix(val, "refs/heads/")
		case "detached":
			place(cur, 2, 2, 3, !hasVal)
			cur.wt.Detached = true
		case "bare":
			place(cur, 1, 1, 3, !hasVal)
			cur.wt.Bare = true
		case "locked":
			place(cur, 2, 3, 4, true)
			cur.wt.Locked = true
			cur.wt.LockReason = val
		case "prunable":
			place(cur, 2, 4, 5, true)
			cur.wt.Prunable = true
		default:
			if strict {
				cur.bad = true
			}
		}
	}
	var list []Worktree
	for i, e := range entries {
		if e.bad || !filepath.IsAbs(e.wt.Path) || (e.wt.Head == "" && !e.wt.Bare) {
			if strict && i == 0 {
				return nil
			}
			continue
		}
		list = append(list, e.wt)
	}
	return list
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
	// The path and one newline, exactly: a directory name may itself end in
	// white space.
	top := filepath.Clean(strings.TrimSuffix(string(out), "\n"))
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
	// ErrSourceNoCommits: the directory the worktree would be created from has
	// nothing committed yet (a fresh repository, a worktree on an unborn
	// branch), so there is no commit to create a branch at.
	ErrSourceNoCommits = errors.New("nothing is committed here yet; a worktree is created from a commit")
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

// isZeroOID reports whether oid is git's null object name, which is what the
// worktree list gives as HEAD for a branch that has no commit yet.
func isZeroOID(oid string) bool {
	return oid != "" && strings.Trim(oid, "0") == ""
}

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
// git ignores are not counted (H10). It does not run the repository's
// core.fsmonitor program: gitFixedArgs turn that off for every call.
func DirtyFiles(worktreeDir string) (int, error) {
	out, err := gitAtTimeout(worktreeDir, "status", "--porcelain", "--untracked-files=all")
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
	out, err := gitAtTimeout(worktreeDir, "ls-files", "--others", "--ignored", "--exclude-standard")
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

// UntrackedRepositories returns the directories in a worktree that are git
// repositories of their own and not tracked by it. git reports such a
// directory as a single untracked entry with a trailing slash and does not
// look inside, so whatever is committed in there is in none of the counts.
// (One nested in an ignored directory is not reported at all.)
func UntrackedRepositories(worktreeDir string) ([]string, error) {
	out, err := gitAtTimeout(worktreeDir, "status", "--porcelain", "-z", "--untracked-files=all")
	if err != nil {
		return nil, fmt.Errorf("check worktree status: %w", err)
	}
	var repos []string
	for _, entry := range strings.Split(string(out), "\x00") {
		name, untracked := strings.CutPrefix(entry, "?? ")
		if !untracked || !strings.HasSuffix(name, "/") {
			continue
		}
		dir := filepath.Join(worktreeDir, name)
		if _, statErr := os.Lstat(filepath.Join(dir, ".git")); statErr == nil {
			repos = append(repos, dir)
		}
	}
	return repos, nil
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
// directory is claimed and before the branch is; after the directory and
// branch are claimed and before git worktree add.
var (
	testAfterCreateChecks func()
	testBeforeBranchClaim func()
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
// rule 1) and returns the reason code of the first one broken, or "": empty,
// white space, "..", a leading "-", then "@{" and control characters (both
// "invalid": git refuses them too), characters that are not shown
// ("invisible"), more than maxWorktreeNameBytes ("too_long"). The last two are
// vibe-remote's own rules — git would take those names — so each has a reason
// of its own for the desktop to explain. The desktop applies the same rules in
// the same order; both sides are held to testdata/worktree-names.json.
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
	for _, r := range name {
		// The ones that are not shown at all (format characters such as a zero
		// width space or a right-to-left override, and the line and paragraph
		// separators): with those a branch can look exactly like another one,
		// or read in another order.
		if unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp) {
			return "invisible"
		}
	}
	if len(name) > maxWorktreeNameBytes {
		return "too_long"
	}
	return ""
}

// maxWorktreeNameBytes bounds a worktree name (UTF-8 bytes). The whole name
// becomes one directory name (WorktreeDirName), and each "/" part of it a ref
// file that git writes as "<part>.lock" first; file systems stop at 255 bytes
// per name. git itself has no limit, so without this one the pre-check would
// accept a name that then cannot be created.
const maxWorktreeNameBytes = 250

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

// CheckWorktreeNameLocal applies the name rules that need no git
// (errors.Is ErrInvalidWorktreeName when one is broken). Everything that
// creates a worktree for a client-given name calls it before it starts its
// first git process, so such a name is refused whatever git would have said
// about the directory, and never comes near a git command line.
func CheckWorktreeNameLocal(name string) error {
	if problem := worktreeNameProblem(name); problem != "" {
		return fmt.Errorf("%w: %q (%s)", ErrInvalidWorktreeName, name, problem)
	}
	return nil
}

// ValidateWorktreeName reports whether name can be the branch of a new
// worktree in the repository at repoDir (errors.Is ErrInvalidWorktreeName when
// it cannot). Names the local rules refuse (a leading "-", "@{", …) are
// refused before git is run at all.
func ValidateWorktreeName(repoDir, name string) error {
	if err := CheckWorktreeNameLocal(name); err != nil {
		return err
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
	// The commit the new branch starts at. With --quiet, exit status 1 is "HEAD
	// names no commit": nothing is committed here yet.
	out, err := gitAtTimeout(w, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")
	if err != nil {
		if code, exited := gitExitCode(err); exited && code == 1 {
			return c, ErrSourceNoCommits
		}
		return c, fmt.Errorf("resolve source commit: %w", err)
	}
	oid := strings.TrimSpace(string(out))
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

	claim := worktreeClaim{w: w, oid: oid}
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
		// A path the file system refuses for its length was not judged against
		// the allowed roots at all.
		if errors.Is(err, syscall.ENAMETOOLONG) {
			return fmt.Errorf("check worktree directory: %w", err)
		}
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
	if spec.Name != "" {
		// Before the first git call. The pre-check endpoint, which shares
		// precheckWorktree, looks at the repository first: it reports where the
		// worktree would go even for a name that cannot be used.
		if err := CheckWorktreeNameLocal(spec.Name); err != nil {
			return CreatedWorktree{}, err
		}
	}
	checks, err := precheckWorktree(spec, spec.Name != "")
	if err != nil {
		return CreatedWorktree{}, err
	}
	sourceAbs, home, rel, claim := checks.sourceAbs, checks.home, checks.rel, checks.claim
	w := claim.w
	allow := func(path string) error { return allowWorktreePath(spec, path) }
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
	if testBeforeBranchClaim != nil {
		testBeforeBranchClaim()
	}
	// An empty old value makes update-ref create the branch only if it does not
	// exist. The message is what `git worktree add -b` writes to the reflog.
	if _, err := gitAtTimeout(w, "update-ref", "-m", "branch: Created from HEAD", "refs/heads/"+claim.branch, claim.oid, ""); err != nil {
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
	// What the repository has registered right before this create's own add
	// runs: a registration that is there now is not one that add made.
	before := registeredBeforeAdd(w)
	if _, err := gitWithin(gitTreeTimeout, w, "worktree", "add", "--detach", claim.root, claim.oid); err != nil {
		// A git that was stopped half-way leaves what it had registered. One
		// that gives up on its own takes back what it had made of the worktree
		// — except when it was the post-checkout hook that failed: then the
		// worktree is complete and stays, and git still reports a failure.
		claim.added = gitStopped(err) || claim.addLeftItsWorktree(before, err)
		return CreatedWorktree{}, withCleanup(fmt.Errorf("create worktree: %w", err), claim.undo())
	}
	claim.added = true
	// Not "checkout: moving from …": git resolves @{-1} from reflog entries of
	// that form, and a worktree made with -b has no previous branch (V22).
	if _, err := gitAtTimeout(claim.root, "symbolic-ref", "-m", "worktree: attached to refs/heads/"+claim.branch, "HEAD", "refs/heads/"+claim.branch); err != nil {
		return CreatedWorktree{}, withCleanup(fmt.Errorf("attach worktree to its branch: %w", err), claim.undo())
	}
	// From here on the worktree goes by the path and branch git registered,
	// which are what every later reading of the list is compared with. They are
	// not always the ones put together above: git resolves a symlinked
	// container, and on macOS it precomposes a decomposed Unicode name.
	registered, err := claim.registered()
	if err != nil {
		// Once more: the worktree itself is made by now, and one list that did
		// not come back (a busy disk right after a large checkout) should not
		// cost it.
		registered, err = claim.registered()
	}
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
//
// added says whether a worktree of this claim can be in root at all: its own
// `git worktree add` finished; or was stopped half-way (its time limit, a
// signal) and so left what it had registered; or failed after the worktree was
// complete (a post-checkout hook), which shows as a registration of root that
// was not there before the add ran (addLeftItsWorktree). While it is false —
// the add has not run yet, or gave up on its own, which is when git takes back
// what it made — any worktree git lists in root was put there by someone else,
// and is never removed, whatever branch or commit it is on.
type worktreeClaim struct {
	w, root, branch, oid, container     string
	dir, branchRef, newContainer, added bool
}

// worktreesBeforeAdd is what a repository had registered right before a
// create's own `git worktree add` ran: the path by id, and the git directory
// they were read from. known is false when that could not be read.
type worktreesBeforeAdd struct {
	common string
	byID   map[string]string
	known  bool
}

func registeredBeforeAdd(w string) worktreesBeforeAdd {
	common, err := gitCommonDir(w)
	if err != nil {
		return worktreesBeforeAdd{}
	}
	byID, err := worktreeRegistrations(common)
	if err != nil {
		return worktreesBeforeAdd{}
	}
	return worktreesBeforeAdd{common: common, byID: byID, known: true}
}

// gitGaveUp is the exit status of a git command that refused to go on (die).
const gitGaveUp = 128

// addLeftItsWorktree reports whether this claim's own `git worktree add`,
// which exited with the error addErr, left a worktree of its own registered in
// c.root. That is so when all of this holds, and in no other case — when in
// doubt the worktree in c.root is someone else's and stays:
//
//   - The repository now has exactly one registration that names c.root, and
//     it was not there before the add ran. One that was there before is
//     someone else's, added after this create took the empty directory.
//   - The add did not end with the status git itself gives up with (128, or
//     129 for a usage error). A git that refuses the path does so before it
//     registers anything, so a registration that appeared while such an add
//     ran is not its own: someone else's add got in between the look at
//     `before` and this add's own look at the path, and this add then refused
//     the path because of it. The other order does not happen — once this add
//     has registered c.root, git refuses anyone else's add there. What is left
//     to this rule is the add that got past its checks and failed afterwards:
//     in its post-checkout hook, whose exit status git passes on. (A hook that
//     itself exits with 128 cannot be told from git refusing, so its worktree
//     stays.)
//
// Whether what is registered is still in the state this create left it in is
// checked by undo, as for every worktree it removes.
func (c worktreeClaim) addLeftItsWorktree(before worktreesBeforeAdd, addErr error) bool {
	if !before.known {
		return false
	}
	if code, exited := gitExitCode(addErr); !exited || code == gitGaveUp || code == gitUsageError {
		return false
	}
	now, err := worktreeRegistrations(before.common)
	if err != nil {
		return false
	}
	fresh := 0
	for id, path := range now {
		if !sameDir(path, c.root) {
			continue
		}
		if _, was := before.byID[id]; was {
			return false
		}
		fresh++
	}
	return fresh == 1
}

// gitStopped reports whether a failed git call was stopped from outside — it
// ran into its time limit, or a signal ended it — rather than exiting with an
// error of its own.
func gitStopped(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var exit *exec.ExitError
	return errors.As(err, &exit) && exit.ExitCode() < 0
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
	// worktreeLeft: a worktree of this claim may still be in c.root — git's
	// list could not be read and the directory is still there, or git would not
	// remove it. Its branch then stays too: a worktree whose branch was deleted
	// under it reads as "no commits yet", and the next commit made in it would
	// start a history of its own.
	worktreeLeft := false
	// branchHolder: a worktree that is on this claim's branch and stays.
	branchHolder := ""
	if c.dir {
		// foreign: git lists a worktree in c.root that is not this claim's.
		// reported: why the directory stays has been said already.
		foreign, reported := false, false
		wts, err := ListWorktrees(c.w)
		listed := err == nil
		if !listed {
			problems = append(problems, fmt.Sprintf("registration of %s not checked: %v", c.root, err))
		}
		for _, wt := range wts {
			// By identity, not spelling: until the create has read the worktree
			// back, c.root is the path as put together here, and git may have
			// registered another spelling of it (a resolved symlink).
			if !sameDir(wt.Path, c.root) {
				if wt.Branch == c.branch {
					branchHolder = wt.Path
				}
				continue
			}
			// Ours is on the branch claimed here, or still detached at the
			// commit (between worktree add and symbolic-ref) — and only if this
			// claim's own add can have left a worktree at all (c.added).
			// Anything else was put into the claimed, still empty directory by
			// someone else (V20): on another branch, or, before this claim's add
			// ran or when it failed on its own, on any branch or commit, this
			// claim's included.
			if c.added && (wt.Branch == c.branch || (wt.Detached && wt.Head == c.oid)) {
				// --force twice: git locks a worktree itself while it is adding
				// it ("initializing") and unlocks it when it is done, so one whose
				// `git worktree add` was killed half-way stays locked, and a single
				// --force does not remove a locked worktree. That lock is this
				// create's own as much as the directory is.
				if _, err := gitWithin(gitTreeTimeout, c.w, "worktree", "remove", "--force", "--force", wt.Path); err != nil {
					worktreeLeft, reported = true, true
					problems = append(problems, fmt.Sprintf("worktree %s not removed: %v", c.root, err))
				}
				continue
			}
			foreign = true
			if wt.Branch == c.branch {
				branchHolder = wt.Path
			}
		}
		// Not recursive: a directory that still has content — a worktree that
		// is not this claim's, anyone's files — is kept.
		if err := os.Remove(c.root); err != nil && !os.IsNotExist(err) && !reported {
			switch {
			case foreign && c.added:
				problems = append(problems, fmt.Sprintf("directory %s not removed: it now holds another worktree", c.root))
			case foreign:
				problems = append(problems, fmt.Sprintf("directory %s not removed: git lists a worktree in it, and this create, whose own git worktree add did not go through, cannot take it for its own", c.root))
			default:
				problems = append(problems, fmt.Sprintf("directory %s not removed: %v", c.root, err))
			}
		}
		if !listed {
			// Without the list, the directory being gone is what shows that no
			// worktree is in it.
			if _, statErr := os.Lstat(c.root); !os.IsNotExist(statErr) {
				worktreeLeft = true
			}
		}
	}
	switch {
	case c.branchRef && worktreeLeft:
		problems = append(problems, fmt.Sprintf("branch %s kept: the worktree in %s could not be confirmed removed, so the directory and the branch are both still there", c.branch, c.root))
	case c.branchRef && branchHolder != "":
		// Someone checked the new branch out in a worktree of their own. A
		// branch deleted under a worktree leaves that worktree with "no commits
		// yet".
		problems = append(problems, fmt.Sprintf("branch %s kept: the worktree in %s is on it", c.branch, branchHolder))
	case c.branchRef:
		// Deletes only while the branch still points at the commit it was created at.
		if _, err := gitAtTimeout(c.w, "update-ref", "-d", "refs/heads/"+c.branch, c.oid); err != nil {
			if exists, serr := branchRefExists(c.w, c.branch); serr != nil {
				problems = append(problems, fmt.Sprintf("branch %s not removed: %v", c.branch, err))
			} else if exists {
				at, _ := gitAtTimeout(c.w, "rev-parse", "--verify", "refs/heads/"+c.branch+"^{commit}")
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
// has not moved and its worktree is known to be gone, the container if this
// call created it and it is empty. What is left in place is named in the
// returned error. Safe to call again.
func (c CreatedWorktree) Undo() error {
	return worktreeClaim{
		w: c.Meta.SourceRepo, root: c.Meta.WorktreeRoot, branch: c.Meta.Branch, oid: c.OID,
		container: filepath.Dir(c.Meta.WorktreeRoot), dir: true, branchRef: true, newContainer: c.NewContainer,
		added: true,
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
	out, err := gitWithin(gitCountTimeout, dir, args...)
	if err != nil {
		return 0, fmt.Errorf("count unmerged commits: %w", err)
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return 0, fmt.Errorf("parse unmerged commit count: %w", err)
	}
	return n, nil
}
