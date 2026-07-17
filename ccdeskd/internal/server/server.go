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
	s.mux.HandleFunc("POST /api/v1/sessions/{id}/rename", s.handleRenameSession)
	s.mux.HandleFunc("POST /api/v1/events", s.handleEvents)
	s.mux.HandleFunc("GET /api/v1/fs", s.handleFS)
	s.mux.HandleFunc("/ws", s.handleWS)
}

// ListenAndServe starts the server on the configured bind address.
func (s *Server) ListenAndServe() error {
	addr := fmt.Sprintf("%s:%d", s.cfg.BindAddr, s.cfg.Port)
	log.Printf("ccdeskd listening on %s", addr)
	return http.ListenAndServe(addr, withCORS(s.mux))
}

// withCORS adds permissive CORS headers so the Electron renderer (which loads
// from file:// or the Vite dev server, a different origin) can call the REST
// API via fetch. This is safe here: ccdeskd is tailnet-only and every REST
// endpoint still requires the Bearer token. WebSocket upgrades bypass CORS and
// are unaffected. Preflight OPTIONS requests are answered directly.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
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

// handleRenameSession sets a user display name on a session.
func (s *Server) handleRenameSession(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing session id"})
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if err := s.mgr.Rename(id, body.Name); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleEvents receives an out-of-band session event (from a claude hook or any
// tailnet-local reporter) and routes it to the session's WS subscribers as a
// notify frame. Reuses the same Bearer auth as every other REST endpoint.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	var body protocol.EventRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.SessionID == "" || body.Kind == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sessionId and kind required"})
		return
	}
	s.mgr.PublishEvent(body.SessionID, protocol.NotifyFrame{
		Type:      protocol.TypeNotify,
		SessionID: body.SessionID,
		Kind:      body.Kind,
		Message:   body.Message,
	})
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
