//go:build linux

package chat

import "syscall"

// sysProcAttr puts claude in its own process group (stopped as a group) and
// kills it if the daemon dies (design 6.2).
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}
