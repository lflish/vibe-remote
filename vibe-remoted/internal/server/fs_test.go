package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
)

// fsListing calls GET /api/v1/fs and returns the decoded body.
func fsListing(t *testing.T, s *Server, path string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/fs?path="+path, nil)
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	s.mux.ServeHTTP(w, req)

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body %q: %v", w.Body.String(), err)
	}
	return w.Code, body
}

// The picker used to derive the parent by trimming the path string, so at an
// allowed root it offered an "up" entry whose next request was always rejected
// with 403. The listing now reports the parent only when it is itself listable,
// so the client can hide that dead end.
func TestFSReportsParentOnlyWhenItIsListable(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "child")
	if err := os.Mkdir(child, 0o755); err != nil {
		t.Fatal(err)
	}
	s := New(&config.Config{Token: "secret", AllowedRoots: []string{root}}, nil)

	// Inside the root: the parent is listable, so it must be reported.
	code, body := fsListing(t, s, child)
	if code != http.StatusOK {
		t.Fatalf("child status = %d, want 200; body=%v", code, body)
	}
	canonicalRoot, err := s.cfg.ResolveAllowedWorkdir(root)
	if err != nil {
		t.Fatal(err)
	}
	if got := body["parent"]; got != canonicalRoot {
		t.Errorf("child parent = %v, want %q", got, canonicalRoot)
	}

	// At the root itself: the parent is outside allowed_roots, so reporting it
	// would hand the client a path that 403s on the next click.
	code, body = fsListing(t, s, root)
	if code != http.StatusOK {
		t.Fatalf("root status = %d, want 200; body=%v", code, body)
	}
	if got := body["parent"]; got != "" {
		t.Errorf("root parent = %v, want empty (already at an allowed root)", got)
	}
}

// The whitelist is the path-traversal boundary; escaping it must stay a 403
// regardless of the parent-reporting change above.
func TestFSRejectsPathOutsideAllowedRoots(t *testing.T) {
	root := t.TempDir()
	s := New(&config.Config{Token: "secret", AllowedRoots: []string{filepath.Join(root, "inside")}}, nil)
	if err := os.Mkdir(filepath.Join(root, "inside"), 0o755); err != nil {
		t.Fatal(err)
	}

	code, body := fsListing(t, s, root)
	if code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body=%v", code, body)
	}
	if body["error"] != "path not in allowed roots" {
		t.Errorf("error = %v, want %q", body["error"], "path not in allowed roots")
	}
}
