package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

func TestDeleteDirtyWorktreeReturnsStructuredConflict(t *testing.T) {
	repo := serverTempRepo(t)
	mgr := session.NewManager(false, "/bin/cat", false, "")
	runner, err := mgr.Create(session.CreateOptions{
		Workdir: repo,
		Mode:    protocol.SessionModeWorktree,
		Cols:    80,
		Rows:    24,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runner.WorktreeRoot, "changed"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := New(&config.Config{Token: "secret"}, mgr)
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/sessions/"+runner.ID, nil)
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", w.Code, w.Body.String())
	}
	var body struct {
		Error        string `json:"error"`
		Message      string `json:"message"`
		WorktreeRoot string `json:"worktreeRoot"`
		Branch       string `json:"branch"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error != "worktree_preserved" || body.Message == "" || body.WorktreeRoot != runner.WorktreeRoot || body.Branch != runner.Branch {
		t.Fatalf("body = %#v", body)
	}
}

func serverTempRepo(t *testing.T) string {
	t.Helper()
	d := t.TempDir()
	serverGit(t, d, "init")
	serverGit(t, d, "config", "user.email", "test@example.com")
	serverGit(t, d, "config", "user.name", "Test User")
	if err := os.WriteFile(filepath.Join(d, "README"), []byte("initial\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	serverGit(t, d, "add", "README")
	serverGit(t, d, "commit", "-m", "initial")
	return d
}

func serverGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}
