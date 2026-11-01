// Package server implements the HTTP and WebSocket server for vibe-remoted.
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

// maxRESTBody caps JSON request bodies. Every REST body is a few small fields;
// the cap stops a token holder's buggy or hostile client from making the
// daemon buffer an unbounded body.
const maxRESTBody = 64 << 10

// Field caps for POST /api/v1/events. kind is a short enum-like tag; message
// is a one-line notification text that clients surface in a desktop toast.
const (
	maxEventKind    = 64
	maxEventMessage = 4096
)

// Server holds the HTTP server and dependencies.
type Server struct {
	cfg     *config.Config
	mgr     *session.Manager
	mux     *http.ServeMux
	version string

	// WebSocket liveness; see the defaults in ws.go.
	idleReadTimeout time.Duration
	pingInterval    time.Duration
	pongTimeout     time.Duration
}

// Option configures optional Server settings.
type Option func(*Server)

// WithVersion sets the daemon version reported by /api/v1/info.
func WithVersion(v string) Option {
	return func(s *Server) { s.version = v }
}

// New creates a new Server.
func New(cfg *config.Config, mgr *session.Manager, opts ...Option) *Server {
	s := &Server{
		cfg:             cfg,
		mgr:             mgr,
		mux:             http.NewServeMux(),
		version:         "dev",
		idleReadTimeout: defaultIdleReadTimeout,
		pingInterval:    defaultPingInterval,
		pongTimeout:     defaultPongTimeout,
	}
	for _, opt := range opts {
		opt(s)
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
	s.mux.HandleFunc("POST /api/v1/sessions/{id}/reload", s.handleReloadSession)
	s.mux.HandleFunc("POST /api/v1/events", s.handleEvents)
	s.mux.HandleFunc("GET /api/v1/fs", s.handleFS)
	s.mux.HandleFunc("/ws", s.handleWS)
}

// handleReloadSession replaces the CLI process in an existing tmux pane while
// retaining the session id, working directory, name, worktree, and attachments.
func (s *Server) handleReloadSession(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r, w) {
		return
	}
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing session id"})
		return
	}
	if err := s.mgr.Reload(id, s.cfg.ResolveClaudeReloadCmd()); err != nil {
		if strings.Contains(err.Error(), "not found") {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		if errors.Is(err, session.ErrReloadRequiresTmux) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// shutdownTimeout bounds how long a SIGINT/SIGTERM waits for in-flight REST
// requests. Sessions are unaffected either way: they live in tmux, and clients
// reconnect to the next daemon instance.
const shutdownTimeout = 5 * time.Second

// ListenAndServe serves on the configured bind address until ctx is done, then
// shuts down gracefully.
//
// Only ReadHeaderTimeout and IdleTimeout are set. ReadTimeout/WriteTimeout
// would apply to the hijacked connection behind each WebSocket too, and kill
// every long-lived terminal session after the timeout elapsed.
func (s *Server) ListenAndServe(ctx context.Context) error {
	srv := &http.Server{
		Addr:              s.cfg.ListenAddr(),
		Handler:           withCORS(s.mux),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("vibe-remoted %s listening on %s", s.version, srv.Addr)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	log.Printf("shutting down (tmux sessions keep running)")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	// Shutdown does not wait for hijacked WebSocket connections; those end when
	// the process exits, and their tmux sessions survive that.
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}

// withCORS adds permissive CORS headers so the Electron renderer (which loads
// from file:// or the Vite dev server, a different origin) can call the REST
// API via fetch. The daemon binds a private-network address (not the public
// internet) and every REST endpoint still requires the constant-time Bearer
// token check, so a wildcard origin does not itself grant access. WebSocket
// upgrades bypass CORS and are unaffected. Preflight OPTIONS are answered
// directly.
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
	// Expose only id/label/default to the client — never Arg (an internal
	// server-side concatenation detail).
	flags := make([]map[string]any, 0, len(s.cfg.ClaudeFlags))
	for _, f := range s.cfg.ClaudeFlags {
		flags = append(flags, map[string]any{
			"id":      f.ID,
			"label":   f.Label,
			"default": f.Default,
		})
	}
	info := map[string]any{
		"version":         s.version,
		"proto":           protocol.Version,
		"hostname":        hostname,
		"tmux_enabled":    s.cfg.UseTmux,
		"default_workdir": s.cfg.DefaultWorkdir,
		"allowed_roots":   s.cfg.AllowedRoots,
		"claude_flags":    flags,
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
		if preserved, ok := err.(*session.WorktreePreservedError); ok {
			writeJSON(w, http.StatusConflict, map[string]string{
				"error":        "worktree_preserved",
				"message":      preserved.Error(),
				"worktreeRoot": preserved.WorktreeRoot,
				"branch":       preserved.Branch,
			})
			return
		}
		if strings.Contains(err.Error(), "not found") {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
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
	if status, err := decodeJSONBody(w, r, &body); err != nil {
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	if err := s.mgr.Rename(id, body.Name); err != nil {
		if errors.Is(err, session.ErrSessionNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		// A tmux failure is not "no such session"; reporting it as 404 made the
		// client drop a session that still exists.
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleEvents receives an out-of-band session event (from a claude hook or any
// tailnet-local reporter) and routes it to the session's WS subscribers as a
// notify frame.
//
// Unlike every other endpoint it also accepts the per-session hook token that
// sessions get as VIBE_REMOTE_TOKEN, but only for the sessionId it was derived
// for. That is why the body is decoded before the auth check. An unauthorized
// caller still gets 401 rather than 400, so a malformed body reveals nothing.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	var body protocol.EventRequest
	status, decodeErr := decodeJSONBody(w, r, &body)
	if !s.eventsAuthorized(r, body.SessionID) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if decodeErr != nil {
		writeJSON(w, status, map[string]string{"error": decodeErr.Error()})
		return
	}
	if body.SessionID == "" || body.Kind == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sessionId and kind required"})
		return
	}
	if len(body.Kind) > maxEventKind {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("kind exceeds %d bytes", maxEventKind)})
		return
	}
	if len(body.Message) > maxEventMessage {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("message exceeds %d bytes", maxEventMessage)})
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
	canonicalPath, resolveErr := s.cfg.ResolveAllowedWorkdir(absPath)
	if resolveErr != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "path not in allowed roots"})
		return
	}
	absPath = canonicalPath

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

	// Report the parent only when it is itself listable. The client cannot work
	// this out on its own: allowed_roots are configured pre-symlink-resolution
	// (e.g. "/tmp") while these paths are canonical ("/private/tmp"), so a
	// string comparison against the roots would wrongly offer a parent that the
	// next request then rejects with 403. Empty means "already at a root".
	parent := ""
	if dir := filepath.Dir(absPath); dir != absPath {
		if canonicalParent, err := s.cfg.ResolveAllowedWorkdir(dir); err == nil {
			parent = canonicalParent
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"path":    absPath,
		"parent":  parent,
		"entries": dirs,
	})
}

// checkToken validates the Bearer token from the Authorization header.
func (s *Server) checkToken(r *http.Request, w http.ResponseWriter) bool {
	auth := r.Header.Get("Authorization")
	expected := "Bearer " + s.cfg.Token
	if !tokenEqual(auth, expected) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return false
	}
	return true
}

// eventsAuthorized accepts the main token, or the hook token derived for
// sessionID. Both comparisons always run, in constant time, so the response
// time does not reveal which credential was presented.
func (s *Server) eventsAuthorized(r *http.Request, sessionID string) bool {
	auth := r.Header.Get("Authorization")
	mainOK := tokenEqual(auth, "Bearer "+s.cfg.Token)
	hookOK := false
	if sessionID != "" {
		hookOK = tokenEqual(auth, "Bearer "+session.HookToken(s.cfg.Token, sessionID))
	}
	return mainOK || hookOK
}

// decodeJSONBody decodes a size-capped JSON body. On failure it returns the
// status to report: 413 when the body exceeds maxRESTBody, 400 otherwise.
func decodeJSONBody(w http.ResponseWriter, r *http.Request, v any) (int, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRESTBody)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return http.StatusRequestEntityTooLarge, fmt.Errorf("body exceeds %d bytes", maxRESTBody)
		}
		return http.StatusBadRequest, errors.New("invalid body")
	}
	return 0, nil
}

// tokenEqual compares two token strings in constant time. Since the static
// token is the primary access boundary (the daemon may bind a plaintext LAN
// address, not only a tailnet IP), this avoids leaking token length or a prefix
// match through response timing. Empty tokens are already rejected at config
// validation, so callers never pass an empty expected value.
func tokenEqual(got, expected string) bool {
	return subtle.ConstantTimeCompare([]byte(got), []byte(expected)) == 1
}

// writeJSON encodes a value as JSON and writes it to the response.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
