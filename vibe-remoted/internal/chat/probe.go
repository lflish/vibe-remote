package chat

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// MinClaudeVersion is the oldest claude the chat UI supports: the stream-json
// control protocol it relies on was measured on this version.
const MinClaudeVersion = "2.1.210"

var versionRe = regexp.MustCompile(`^\s*v?(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+(])`)

// ParseVersion reads "x.y.z" at the start of s (as in "2.1.210 (Claude Code)").
func ParseVersion(s string) (v [3]int, ok bool) {
	m := versionRe.FindStringSubmatch(s)
	if m == nil {
		return v, false
	}
	for i := 0; i < 3; i++ {
		n, err := strconv.Atoi(m[i+1])
		if err != nil {
			return v, false
		}
		v[i] = n
	}
	return v, true
}

// VersionAtLeast reports v >= min.
func VersionAtLeast(v, min [3]int) bool {
	for i := 0; i < 3; i++ {
		if v[i] != min[i] {
			return v[i] > min[i]
		}
	}
	return true
}

// ProbeResult is what `claude --version` told us. Version "" with Reason ""
// means unknown (unparseable output or timeout): chat is allowed and the
// version in system/init decides later.
type ProbeResult struct {
	Version string
	Reason  string // "", protocol.ChatReasonClaudeNotFound or ChatReasonTooOld
}

// Probe runs `<exe> --version` the way the chat process will be started
// (through the login shell when loginShell is set) and classifies the result.
func Probe(ctx context.Context, exe string, loginShell bool, shell string) ProbeResult {
	argv := []string{exe, "--version"}
	var cmd *exec.Cmd
	if loginShell {
		if shell == "" {
			shell = "/bin/bash"
		}
		cmd = exec.CommandContext(ctx, shell, "-lic", "exec "+ShellJoin(argv))
	} else {
		cmd = exec.CommandContext(ctx, argv[0], argv[1:]...)
	}
	cmd.Env = withoutNestedGuard(os.Environ())
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		switch {
		case errors.Is(err, exec.ErrNotFound), errors.Is(err, os.ErrNotExist), errors.Is(err, os.ErrPermission):
			return ProbeResult{Reason: protocol.ChatReasonClaudeNotFound}
		case errors.As(err, &exitErr) && (exitErr.ExitCode() == 127 || exitErr.ExitCode() == 126):
			// The shell could not find or execute it.
			return ProbeResult{Reason: protocol.ChatReasonClaudeNotFound}
		}
		if ctx.Err() != nil {
			return ProbeResult{}
		}
	}
	// A login shell may print its own lines first; take the first version.
	for _, line := range strings.Split(string(out), "\n") {
		v, ok := ParseVersion(line)
		if !ok {
			continue
		}
		version := strings.Fields(line)[0]
		version = strings.TrimPrefix(version, "v")
		min, _ := ParseVersion(MinClaudeVersion)
		if !VersionAtLeast(v, min) {
			return ProbeResult{Version: version, Reason: protocol.ChatReasonTooOld}
		}
		return ProbeResult{Version: version}
	}
	return ProbeResult{}
}

// withoutNestedGuard drops the variables claude sets for its own children; a
// daemon started from a claude session would otherwise make claude refuse to
// run (nested session protection).
func withoutNestedGuard(env []string) []string {
	out := env[:0:0]
	for _, kv := range env {
		if strings.HasPrefix(kv, "CLAUDECODE=") || strings.HasPrefix(kv, "CLAUDE_CODE_ENTRYPOINT=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// ProbeConfig configures a Prober.
type ProbeConfig struct {
	Exe        string
	LoginShell bool
	Shell      string
	// TTL is how long a result is reused (default 10 minutes).
	TTL time.Duration
	// Timeout bounds one probe (default 15 seconds).
	Timeout time.Duration
}

// Prober runs Probe in the background and caches the result, so
// /api/v1/info never waits on a login shell for long.
type Prober struct {
	cfg ProbeConfig
	ttl time.Duration

	mu       sync.Mutex
	result   ProbeResult
	at       time.Time     // when result was obtained; zero = none
	inflight chan struct{} // closed when the running probe finishes
	gen      int           // bumped by Recheck; a probe started earlier is discarded
}

// NewProber returns a Prober; the first Get (or Start) begins probing.
func NewProber(cfg ProbeConfig) *Prober {
	if cfg.TTL <= 0 {
		cfg.TTL = 10 * time.Minute
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 15 * time.Second
	}
	return &Prober{cfg: cfg, ttl: cfg.TTL}
}

// Start begins a probe in the background unless one is running or the cached
// result is still fresh.
func (p *Prober) Start() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.startLocked()
}

func (p *Prober) startLocked() chan struct{} {
	if p.inflight != nil {
		return p.inflight
	}
	done := make(chan struct{})
	p.inflight = done
	gen := p.gen
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), p.cfg.Timeout)
		res := Probe(ctx, p.cfg.Exe, p.cfg.LoginShell, p.cfg.Shell)
		cancel()
		p.mu.Lock()
		p.inflight = nil
		if gen == p.gen {
			p.result, p.at = res, time.Now()
		} else {
			// Recheck ran while this probe was in flight: its answer may
			// predate the upgrade, so probe again.
			p.startLocked()
		}
		p.mu.Unlock()
		close(done)
	}()
	return done
}

// Recheck drops the cached result and probes again ("I upgraded claude").
func (p *Prober) Recheck() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.at = time.Time{}
	p.gen++
	p.startLocked()
}

// Get returns the cached result if fresh; otherwise it starts a probe and
// waits up to wait for it. known is false when no result is available in
// time (the caller treats the version as unknown).
func (p *Prober) Get(ctx context.Context, wait time.Duration) (ProbeResult, bool) {
	p.mu.Lock()
	if !p.at.IsZero() && time.Since(p.at) < p.ttl {
		res := p.result
		p.mu.Unlock()
		return res, true
	}
	done := p.startLocked()
	p.mu.Unlock()

	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		select {
		case <-done:
		case <-timer.C:
			return ProbeResult{}, false
		case <-ctx.Done():
			return ProbeResult{}, false
		}
		p.mu.Lock()
		if !p.at.IsZero() {
			res := p.result
			p.mu.Unlock()
			return res, true
		}
		// The probe we waited on was superseded by a Recheck; wait for its successor.
		done = p.startLocked()
		p.mu.Unlock()
	}
}
