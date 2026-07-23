package session

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
)

// HeadlessRunner runs one `claude -c -p` turn per RunTurn call (line B: the
// mobile chat path). Unlike the PTY Runner it holds no long-lived process and
// no tmux session — each turn spawns a fresh `claude -p`, streams its NDJSON
// stdout line-by-line, then exits. Continuity across turns is provided by
// claude's own `-c` (continue most recent conversation in this workdir) reading
// the shared ~/.claude/projects/<dir>/*.jsonl. The prompt is written to the
// process's stdin so it never touches the command line (zero shell injection).
type HeadlessRunner struct {
	workdir    string
	claudeCmd  string
	loginShell bool
	shell      string
	env        []string
}

// NewHeadlessRunner builds a runner. claudeCmd is the base command (e.g.
// "claude" or "claude --dangerously-skip-permissions"); the headless flags are
// appended by RunTurn. When loginShell is true the command is wrapped in
// `<shell> -lic 'exec ...'` so the user's PATH / node version manager loads.
func NewHeadlessRunner(workdir, claudeCmd string, loginShell bool, shell string, env []string) *HeadlessRunner {
	return &HeadlessRunner{
		workdir:    workdir,
		claudeCmd:  claudeCmd,
		loginShell: loginShell,
		shell:      shell,
		env:        env,
	}
}

// headlessFlags are appended after the base claude command. --include-partial-messages
// is required for token-by-token content_block_delta events (the typewriter effect);
// --verbose + stream-json are required for the NDJSON event stream.
const headlessFlags = "-c -p --output-format stream-json --include-partial-messages --verbose"

// buildCmd constructs the exec.Cmd. Prompt is NOT included here — it goes to stdin.
func (h *HeadlessRunner) buildCmd(ctx context.Context) *exec.Cmd {
	full := h.claudeCmd + " " + headlessFlags
	var cmd *exec.Cmd
	sh := h.shell
	if sh == "" {
		sh = "/bin/bash"
	}
	if h.loginShell {
		cmd = exec.CommandContext(ctx, sh, "-lic", "exec "+full)
	} else {
		// Non-login: still run through the shell (no login/interactive) so the
		// command string is parsed by shell rules (quotes, etc.), matching the
		// documented claude_cmd contract ("按 shell 规则解析"). `exec` replaces the
		// shell with claude so there's no extra wrapper process.
		cmd = exec.CommandContext(ctx, sh, "-c", "exec "+full)
	}
	cmd.Dir = h.workdir
	cmd.Env = append(os.Environ(), h.env...)
	return cmd
}

// RunTurn spawns one turn, feeds prompt via stdin, and calls onLine per stdout
// line. Blocks until the process exits. Returns the exit code.
func (h *HeadlessRunner) RunTurn(ctx context.Context, prompt string, onLine func(line []byte)) (int, error) {
	cmd := h.buildCmd(ctx)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return -1, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return -1, fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return -1, fmt.Errorf("start: %w", err)
	}

	// Write the prompt and close stdin so claude sees EOF and processes it.
	go func() {
		io.WriteString(stdin, prompt)
		stdin.Close()
	}()

	// Stream stdout line-by-line. Raise the buffer so a large NDJSON line
	// (e.g. a big tool_use payload) isn't truncated.
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		// Copy: scanner reuses its buffer on the next Scan.
		cp := make([]byte, len(line))
		copy(cp, line)
		onLine(cp)
	}
	// A scan error (a line exceeding the 4MB buffer → bufio.ErrTooLong, or a
	// read failure) makes Scan return false silently: the stream is truncated
	// mid-turn. Propagate it so wsHeadless sends an error frame instead of
	// stopping half-way and returning exit 0. Kill first, then reap: with a
	// StdoutPipe the child may still be blocked writing to the now-undrained
	// pipe, so a bare cmd.Wait() would deadlock — Kill unblocks the writer.
	if err := scanner.Err(); err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		return -1, fmt.Errorf("stdout scan: %w", err)
	}

	err = cmd.Wait()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return exitErr.ExitCode(), nil
		}
		return -1, err
	}
	return 0, nil
}
