// Package server implements the HTTP and WebSocket server for ccdeskd.
package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/anthropic/ccdesk/ccdeskd/internal/config"
	"github.com/anthropic/ccdesk/ccdeskd/internal/protocol"
	"github.com/anthropic/ccdesk/ccdeskd/internal/session"
)

// Server holds the HTTP server and dependencies.
type Server struct {
	cfg     *config.Config
	mgr     *session.Manager
	mux     *http.ServeMux
}

// New creates a new Server.
func New(cfg *config.Config, mgr *session.Manager) *Server {
	s := &Server{
		cfg: cfg,
		mgr: mgr,
		mux: http.NewServeMux(),
	}
	s.routes()
	return s
}

// routes registers all HTTP endpoints.
func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", s.handleHealthz)
	s.mux.HandleFunc("GET /api/v1/info", s.handleInfo)
	s.mux.HandleFunc("GET /api/v1/sessions", s.handleListSessions)
	s.mux.HandleFunc("DELETE /api/v1/sessions/{id}", s.handleDeleteSession)
	s.mux.HandleFunc("GET /api/v1/fs", s.handleFS)
	s.mux.HandleFunc("/ws", s.handleWS)
}

// ListenAndServe starts the server on the configured bind address.
func (s *Server) ListenAndServe() error {
	addr := fmt.Sprintf("%s:%d", s.cfg.BindAddr, s.cfg.Port)
	log.Printf("ccdeskd listening on %s", addr)
	return http.ListenAndServe(addr, s.mux)
}

// --- REST handlers ---

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	hostname, _ := os.Hostname()
	info := map[string]any{
		"hostname":        hostname,
		"tmux_enabled":    s.cfg.UseTmux,
		"default_workdir": s.cfg.DefaultWorkdir,
		"allowed_roots":   s.cfg.AllowedRoots,
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	list := s.mgr.List()
	frame := protocol.SessionsFrame{
		Type: protocol.TypeSessions,
		List: list,
	}
	writeJSON(w, http.StatusOK, frame)
}

func (s *Server) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing session id"})
		return
	}
	if err := s.mgr.Delete(id); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleFS lists directory entries for the remote directory picker.
func (s *Server) handleFS(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	dirPath := r.URL.Query().Get("path")
	if dirPath == "" {
		dirPath = s.cfg.DefaultWorkdir
	}

	// Resolve and check access
	absPath, err := filepath.Abs(dirPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid path"})
		return
	}
	if !s.cfg.IsAllowedWorkdir(absPath) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "path not in allowed roots"})
		return
	}

	entries, err := os.ReadDir(absPath)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}

	// Only return directories
	dirs := make([]map[string]string, 0)
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			dirs = append(dirs, map[string]string{
				"name": e.Name(),
				"path": filepath.Join(absPath, e.Name()),
			})
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"path":    absPath,
		"entries": dirs,
	})
}

// checkToken validates the Bearer token from the Authorization header.
func (s *Server) checkToken(r *http.Request, w http.ResponseWriter) bool {
	auth := r.Header.Get("Authorization")
	expected := "Bearer " + s.cfg.Token
	if auth != expected {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return false
	}
	return true
}

// writeJSON encodes a value as JSON and writes it to the response.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
