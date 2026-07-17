// ccdeskd is the remote Claude terminal daemon.
// It runs on each Linux machine, manages PTY→tmux→claude sessions,
// and exposes a WebSocket + REST API for desktop clients.
package main

import (
	"flag"
	"log"
	"os"

	"github.com/anthropic/ccdesk/ccdeskd/internal/config"
	"github.com/anthropic/ccdesk/ccdeskd/internal/server"
	"github.com/anthropic/ccdesk/ccdeskd/internal/session"
)

func main() {
	configPath := flag.String("config", "ccdeskd.json", "path to config file")
	flag.Parse()

	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("ccdeskd starting...")

	// Load config
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	// Allow env overrides for quick setup
	if addr := os.Getenv("CCDESKD_BIND_ADDR"); addr != "" {
		cfg.BindAddr = addr
	}
	if token := os.Getenv("CCDESKD_TOKEN"); token != "" {
		cfg.Token = token
	}

	if err := cfg.Validate(); err != nil {
		log.Fatalf("config validation: %v", err)
	}

	log.Printf("bind=%s:%d tmux=%v workdir=%s",
		cfg.BindAddr, cfg.Port, cfg.UseTmux, cfg.DefaultWorkdir)

	// Create session manager
	mgr := session.NewManager(cfg.UseTmux, cfg.ClaudeCmd, cfg.UseLoginShell(), cfg.LoginShellPath())

	// Start server
	srv := server.New(cfg, mgr)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}
