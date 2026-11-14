package chat

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Record statuses.
const (
	StatusRunning = "running"
	StatusEnded   = "ended"
)

// Record is one chat session in chat-sessions.json (design 5.1). Messages
// are not stored: claude's own transcript is the history.
type Record struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	Workdir           string   `json:"workdir"`
	Mode              string   `json:"mode"`
	SourceWorkdir     string   `json:"sourceWorkdir,omitempty"`
	SourceRepo        string   `json:"sourceRepo,omitempty"`
	WorktreeRoot      string   `json:"worktreeRoot,omitempty"`
	Branch            string   `json:"branch,omitempty"`
	WorktreeHandedOff bool     `json:"worktreeHandedOff"`
	Flags             []string `json:"flags"`
	// Exe and Args are what the session was created with (claude_cmd and the
	// selected flags, parsed, without -c); restarts and handoff use them so a
	// later config change does not alter an existing session.
	Exe              string   `json:"exe"`
	Args             []string `json:"args"`
	ClaudeSessionID  string   `json:"claudeSessionId"`
	PermissionLocked bool     `json:"permissionLocked"`
	PermissionMode   string   `json:"permissionMode,omitempty"`
	CreatedAt        string   `json:"createdAt"`
	Status           string   `json:"status"`
	EndedAt          string   `json:"endedAt"`
	EndReason        string   `json:"endReason"`
	ExitCode         int      `json:"exitCode"`
	HandedOffTo      string   `json:"handedOffTo"`
	Pid              int      `json:"pid"`
}

type storeFile struct {
	Version  int      `json:"version"`
	Sessions []Record `json:"sessions"`
}

// StoreFileName is the chat session table inside state_dir.
const StoreFileName = "chat-sessions.json"

// Store reads and writes chat-sessions.json. Writes replace the file
// atomically (temporary file, fsync, rename); the directory is 0700 and the
// file 0600.
type Store struct {
	dir  string
	path string
	mu   sync.Mutex

	beforeRename func() error // test seam: fail between write and rename
}

// NewStore opens (creating if needed) the state directory dir.
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir, path: filepath.Join(dir, StoreFileName)}, nil
}

// Path is the table's file path.
func (s *Store) Path() string { return s.path }

// Load reads the table. A missing file is an empty table; an unreadable one
// is moved aside to chat-sessions.json.corrupt-<unix> and also loads empty.
func (s *Store) Load() ([]Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var f storeFile
	if err := json.Unmarshal(data, &f); err != nil || f.Version != 1 {
		quarantine := fmt.Sprintf("%s.corrupt-%d", s.path, time.Now().Unix())
		if rerr := os.Rename(s.path, quarantine); rerr != nil {
			return nil, fmt.Errorf("corrupt %s and could not move it aside: %w", s.path, rerr)
		}
		log.Printf("chat: %s is unreadable (%v); moved to %s, starting with no chat sessions", s.path, err, quarantine)
		return nil, nil
	}
	return f.Sessions, nil
}

// Save replaces the table with recs.
func (s *Store) Save(recs []Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if recs == nil {
		recs = []Record{}
	}
	data, err := json.Marshal(storeFile{Version: 1, Sessions: recs})
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, ".chat-sessions.json.tmp-*")
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
	if s.beforeRename != nil {
		if err := s.beforeRename(); err != nil {
			os.Remove(name)
			return err
		}
	}
	if err := os.Rename(name, s.path); err != nil {
		os.Remove(name)
		return err
	}
	if d, err := os.Open(s.dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}
