// Package main is the vibe-remoted daemon entry point.
// It runs on each Linux machine, spawns headless `claude -p` turns per workdir,
// and exposes a WebSocket + REST API for desktop / web / iOS clients.
package main

import (
	"flag"
	"log"
	"os"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/server"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

func main() {
	configPath := flag.String("config", "vibe-remoted.json", "path to config file")
	flag.Parse()

	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("vibe-remoted starting...")

	// Load config
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	// Allow env overrides for quick setup
	if addr := os.Getenv("VIBE_REMOTED_BIND_ADDR"); addr != "" {
		cfg.BindAddr = addr
	}
	if token := os.Getenv("VIBE_REMOTED_TOKEN"); token != "" {
		cfg.Token = token
	}

	if err := cfg.Validate(); err != nil {
		log.Fatalf("config validation: %v", err)
	}

	log.Printf("bind=%s:%d workdir=%s",
		cfg.BindAddr, cfg.Port, cfg.DefaultWorkdir)

	// Create session manager. SetEventEnv is intentionally NOT called: the
	// out-of-band events endpoint was removed together with the TUI line, so
	// there is currently no receiver for hook-driven notifications. The
	// injection mechanism (Manager.SetEventEnv → VIBE_REMOTE_EVENTS_URL /
	// VIBE_REMOTE_TOKEN) is preserved for the future permission-MCP path;
	// wire it up once a replacement endpoint exists.
	mgr := session.NewManager(cfg.ClaudeCmd, cfg.UseLoginShell(), cfg.LoginShellPath())

	// Start server
	srv := server.New(cfg, mgr)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}
