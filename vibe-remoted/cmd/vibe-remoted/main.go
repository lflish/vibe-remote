// vibe-remoted is the remote Claude terminal daemon.
// It runs on each Linux machine, manages PTY→tmux→claude sessions,
// and exposes a WebSocket + REST API for desktop clients.
package main

import (
	"flag"
	"fmt"
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

	log.Printf("bind=%s:%d tmux=%v workdir=%s",
		cfg.BindAddr, cfg.Port, cfg.UseTmux, cfg.DefaultWorkdir)

	// Create session manager
	mgr := session.NewManager(cfg.UseTmux, cfg.ClaudeCmd, cfg.UseLoginShell(), cfg.LoginShellPath())

	// Inject the events endpoint URL + token into new sessions' environment so a
	// claude hook can report out-of-band events back to this daemon.
	mgr.SetEventEnv(fmt.Sprintf("http://%s:%d/api/v1/events", cfg.BindAddr, cfg.Port), cfg.Token)

	// Start server
	srv := server.New(cfg, mgr)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}
