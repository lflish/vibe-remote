package chat

import (
	"bytes"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// Orphan cleanup timings (design 6.6).
const (
	orphanTermWait = 2 * time.Second
	orphanKillWait = time.Second
)

// Orphan is a claude process from a previous daemon that would not die: its
// conversation stays claimed ("orphan:<pid>") until the process is gone.
type Orphan struct {
	ClaudeSessionID string
	Pid             int
}

// Owner is the claudeOwners value for the orphan.
func (o Orphan) Owner() string { return "orphan:" + strconv.Itoa(o.Pid) }

// Gone reports whether the orphan process has exited.
func (o Orphan) Gone() bool { return !processAlive(o.Pid) }

// CleanupOrphans runs at daemon start. Every record still marked running
// lost its process with the previous daemon (Q2=A): a claude process that is
// still alive and runs that conversation is stopped (SIGTERM to its group,
// up to 2 s, SIGKILL, up to 1 s, confirmed gone), and the record becomes
// ended/daemon_restart. A process that survives even that is returned as an
// Orphan. Processes whose command line does not mention the conversation
// (a reused pid) are left alone.
func CleanupOrphans(recs []Record) ([]Record, []Orphan) {
	return cleanupOrphans(recs, signalOrphan)
}

func signalOrphan(pid int, sig syscall.Signal) {
	signalGroup(pid, sig)
	_ = syscall.Kill(pid, sig) // in case it is not a group leader
}

func cleanupOrphans(recs []Record, signal func(int, syscall.Signal)) ([]Record, []Orphan) {
	out := make([]Record, len(recs))
	var orphans []Orphan
	now := time.Now().UTC().Format(time.RFC3339)
	for i, r := range recs {
		out[i] = r
		if r.Status != StatusRunning {
			continue
		}
		if r.Pid > 0 && r.ClaudeSessionID != "" && processAlive(r.Pid) && cmdlineMentions(r.Pid, r.ClaudeSessionID) {
			if !stopOrphan(r.Pid, signal) {
				log.Printf("chat: claude pid %d (session %s) survived SIGKILL; its conversation stays claimed", r.Pid, r.ID)
				orphans = append(orphans, Orphan{ClaudeSessionID: r.ClaudeSessionID, Pid: r.Pid})
			}
		}
		out[i].Status = StatusEnded
		out[i].EndReason = protocol.EndReasonDaemonRestart
		out[i].EndedAt = now
		out[i].Pid = 0
	}
	return out, orphans
}

// stopOrphan ends pid; true once kill(pid, 0) reports it gone.
func stopOrphan(pid int, signal func(int, syscall.Signal)) bool {
	signal(pid, syscall.SIGTERM)
	if waitGone(pid, orphanTermWait) {
		return true
	}
	signal(pid, syscall.SIGKILL)
	return waitGone(pid, orphanKillWait)
}

func waitGone(pid int, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for {
		if !processAlive(pid) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// cmdlineMentions reports whether pid's command line contains s: Linux reads
// /proc/<pid>/cmdline, elsewhere `ps -o command= -p <pid>`.
func cmdlineMentions(pid int, s string) bool {
	if data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline"); err == nil {
		return bytes.Contains(data, []byte(s))
	}
	out, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), s)
}
