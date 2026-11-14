//go:build !linux

package chat

import "syscall"

// sysProcAttr puts claude in its own process group, so it is stopped as a
// group (design 6.2). Pdeathsig exists only on Linux.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}
