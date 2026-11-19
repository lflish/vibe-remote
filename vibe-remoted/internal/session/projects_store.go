package session

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// ProjectStore is <state_dir>/projects.json (design 5.2): the git projects that
// have hosted a session, and the worktrees vibe-remote created. Its mutex is a
// leaf lock; every mutation writes the whole file under it (temporary file,
// fsync, rename). A write failure updates memory anyway, logs one line, and is
// re-attempted on the next mutation. A nil dir keeps everything in memory only.
type ProjectStore struct {
	mu        sync.Mutex
	dir       string // "" = memory only
	path      string
	projects  []projectEntry
	worktrees []WorktreeRecord
}

type projectEntry struct {
	ID      string `json:"id"`
	AddedAt string `json:"addedAt"`
}

// WorktreeRecord is one vibe-remote-created worktree (H17).
type WorktreeRecord struct {
	Project   string `json:"project"`
	Path      string `json:"path"`
	Branch    string `json:"branch"`
	CreatedAt string `json:"createdAt"`
}

type projectsFile struct {
	Version   int              `json:"version"`
	Projects  []projectEntry   `json:"projects"`
	Worktrees []WorktreeRecord `json:"worktrees"`
}

// projectsFileName is the store's file inside state_dir.
const projectsFileName = "projects.json"

// legacyVibeID matches the two session-id shapes vibe-remote has ever
// generated: a millisecond timestamp with 8 hex, or a 19-digit fallback
// (design 5.3). A looser id check would wrongly claim user-made worktrees
// (d22).
var legacyVibeID = regexp.MustCompile(`^([0-9]{13}-[0-9a-f]{8}|[0-9]{19})$`)

// OpenProjectStore opens (creating if needed) the store in stateDir. It returns
// an error when the directory is not writable; callers fall back to
// NewMemoryProjectStore.
func OpenProjectStore(stateDir string) (*ProjectStore, error) {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, err
	}
	// An existing but read-only directory passes MkdirAll; probe writability.
	probe, err := os.CreateTemp(stateDir, ".projects-probe-*")
	if err != nil {
		return nil, fmt.Errorf("projects store dir not writable: %w", err)
	}
	probe.Close()
	os.Remove(probe.Name())

	s := &ProjectStore{dir: stateDir, path: filepath.Join(stateDir, projectsFileName)}
	s.load()
	return s, nil
}

// NewMemoryProjectStore returns a store that never touches the filesystem.
func NewMemoryProjectStore() *ProjectStore { return &ProjectStore{} }

// load reads the file; a missing file is an empty store, and an unreadable one
// (or a version other than 1) is moved aside and the store starts empty.
func (s *ProjectStore) load() {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var f projectsFile
	if err := json.Unmarshal(data, &f); err != nil || f.Version != 1 {
		quarantine := fmt.Sprintf("%s.corrupt-%d", s.path, time.Now().Unix())
		if rerr := os.Rename(s.path, quarantine); rerr != nil {
			log.Printf("projects store: %s is unreadable (%v) and could not be moved aside: %v", s.path, err, rerr)
			return
		}
		log.Printf("projects store: %s is unreadable (%v); moved to %s, starting empty", s.path, err, quarantine)
		return
	}
	s.projects = f.Projects
	s.worktrees = f.Worktrees
}

// persistLocked writes the whole file. Called under s.mu. A write failure is
// logged but not surfaced, so the in-memory state stays authoritative for this
// run (design 5.2).
func (s *ProjectStore) persistLocked() {
	if s.dir == "" {
		return
	}
	data, err := json.Marshal(projectsFile{Version: 1, Projects: s.projects, Worktrees: s.worktrees})
	if err != nil {
		log.Printf("projects store: write failed: %v", err)
		return
	}
	if err := atomicWriteFile(s.dir, s.path, data); err != nil {
		log.Printf("projects store: write failed: %v", err)
	}
}

func atomicWriteFile(dir, path string, data []byte) error {
	tmp, err := os.CreateTemp(dir, ".projects.json.tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	fail := func(err error) error {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		return fail(err)
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Rename(name, path); err != nil {
		os.Remove(name)
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}

func nowStamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// AddProject records a git project that hosted a session. A repeated id is a
// no-op.
func (s *ProjectStore) AddProject(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.projects {
		if p.ID == id {
			return
		}
	}
	s.projects = append(s.projects, projectEntry{ID: id, AddedAt: nowStamp()})
	s.persistLocked()
}

// RemoveProject drops a project; it reports whether one was removed.
func (s *ProjectStore) RemoveProject(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, p := range s.projects {
		if p.ID == id {
			s.projects = append(s.projects[:i:i], s.projects[i+1:]...)
			s.persistLocked()
			return true
		}
	}
	return false
}

// Projects returns the recorded project ids.
func (s *ProjectStore) Projects() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]string, len(s.projects))
	for i, p := range s.projects {
		ids[i] = p.ID
	}
	return ids
}

// AddWorktree records a vibe-remote-created worktree, replacing any record at
// the same path with a fresh CreatedAt.
func (s *ProjectStore) AddWorktree(project, path, branch string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.worktrees = removeByPath(s.worktrees, path)
	s.worktrees = append(s.worktrees, WorktreeRecord{Project: project, Path: path, Branch: branch, CreatedAt: nowStamp()})
	s.persistLocked()
}

// RemoveWorktree drops any record at path.
func (s *ProjectStore) RemoveWorktree(path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if next := removeByPath(s.worktrees, path); len(next) != len(s.worktrees) {
		s.worktrees = next
		s.persistLocked()
	}
}

// Worktrees returns a snapshot of the worktree records.
func (s *ProjectStore) Worktrees() []WorktreeRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]WorktreeRecord, len(s.worktrees))
	copy(out, s.worktrees)
	return out
}

// RemoveWorktreeIfSame drops the record at rec.Path only if it still matches
// rec field-for-field (it was not replaced since the snapshot was taken). It
// reports whether it removed one.
func (s *ProjectStore) RemoveWorktreeIfSame(rec WorktreeRecord) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, w := range s.worktrees {
		if w == rec {
			s.worktrees = append(s.worktrees[:i:i], s.worktrees[i+1:]...)
			s.persistLocked()
			return true
		}
	}
	return false
}

// Managed reports whether the worktree at path on branch was created by
// vibe-remote (design 5.3): either a record matches path and branch, or it has
// the legacy auto-named shape under the project's "<name>-worktrees" container.
func (s *ProjectStore) Managed(project, path, branch string) bool {
	if branch == "" {
		return false
	}
	s.mu.Lock()
	for _, w := range s.worktrees {
		if w.Path == path && w.Branch == branch {
			s.mu.Unlock()
			return true
		}
	}
	s.mu.Unlock()

	container := filepath.Join(filepath.Dir(project), filepath.Base(project)+"-worktrees")
	x := filepath.Base(path)
	return filepath.Dir(path) == container && branch == "vibe/"+x && legacyVibeID.MatchString(x)
}

func removeByPath(recs []WorktreeRecord, path string) []WorktreeRecord {
	out := recs[:0:0]
	for _, w := range recs {
		if w.Path != path {
			out = append(out, w)
		}
	}
	return out
}
