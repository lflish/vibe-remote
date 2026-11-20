package chat

import (
	"errors"
	"syscall"
)

// signalGroup signals the process group led by pid.
func signalGroup(pid int, sig syscall.Signal) {
	if pid > 0 {
		_ = syscall.Kill(-pid, sig)
	}
}

// processAlive reports whether pid exists (kill(pid, 0) is not ESRCH).
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || !errors.Is(err, syscall.ESRCH)
}
