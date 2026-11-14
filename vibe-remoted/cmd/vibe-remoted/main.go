// vibe-remoted is the remote Claude terminal daemon.
// It runs on each Linux machine, manages PTY→tmux→claude sessions,
// and exposes a WebSocket + REST API for desktop clients.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/chat"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/config"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/server"
	"github.com/lflish/vibe-remote/vibe-remoted/internal/session"
)

// version is injected at build time: -ldflags "-X main.version=v1.2.3".
var version = "dev"

func main() {
	configPath := flag.String("config", "vibe-remoted.json", "path to config file")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Printf("vibe-remoted %s starting...", version)

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
	// Checked after the env override so it judges the token actually in use.
	if len(cfg.Token) < config.RecommendedTokenLen {
		log.Printf("warning: token is %d characters; %d+ is recommended (e.g. `openssl rand -hex 32`)",
			len(cfg.Token), config.RecommendedTokenLen)
	}

	log.Printf("bind=%s tmux=%v workdir=%s",
		cfg.ListenAddr(), cfg.UseTmux, cfg.DefaultWorkdir)

	// Create session manager
	mgr := session.NewManager(cfg.UseTmux, cfg.ClaudeCmd, cfg.UseLoginShell(), cfg.LoginShellPath())

	// Inject the events endpoint URL into new sessions' environment, and give
	// the manager the main token to derive each session's hook token from, so
	// a claude hook can report out-of-band events back to this daemon.
	mgr.SetEventEnv("http://"+cfg.ListenAddr()+"/api/v1/events", cfg.Token)

	// Chat sessions: their table lives in state_dir. Records of the previous
	// daemon's still-running chats are ended (their processes stopped) here.
	mgr.SetChatConfig(session.ChatConfig{ProjectsDir: chat.ProjectsDir()})
	if store, err := chat.NewStore(cfg.StateDir); err != nil {
		log.Printf("warning: state_dir %s is not writable (%v); chat sessions are unavailable", cfg.StateDir, err)
	} else if err := mgr.LoadChats(store); err != nil {
		log.Printf("warning: load chat sessions from %s: %v", store.Path(), err)
	}

	// Stop on SIGINT/SIGTERM with a graceful HTTP shutdown. tmux sessions are
	// separate processes and keep running for the next daemon to pick up.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Start server
	srv := server.New(cfg, mgr, server.WithVersion(version))
	err = srv.ListenAndServe(ctx)
	// Chat processes cannot outlive the daemon (unlike tmux sessions); stop
	// them and record daemon_restart either way.
	mgr.Shutdown(chatShutdownTimeout)
	if err != nil {
		log.Fatalf("server: %v", err)
	}
}

// chatShutdownTimeout bounds stopping every chat process at exit (each stop
// takes at most ~4 s, all run in parallel; design 6.6).
const chatShutdownTimeout = 6 * time.Second
