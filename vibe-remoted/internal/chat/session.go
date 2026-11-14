package chat

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lflish/vibe-remote/vibe-remoted/internal/protocol"
)

// Limits (design 5.2, H2).
const (
	RingMax        = 1000     // complete messages kept per epoch
	RingBytesMax   = 32 << 20 // … and at most this many bytes
	TailMax        = 20000    // stream events of the reply being generated
	TailBytesMax   = 8 << 20
	SubBuffer      = 1024 // frames a subscriber may lag before it is dropped
	StdinQueue     = 256  // stdin writes waiting for the writer goroutine
	MaxSendBytes   = 256 << 10
	InitializeWait = 10 * time.Second // only decides where slash commands come from
	// StaleTurn: a turn with no output and no open request for this long is
	// given up on (vr_notice stale_turn).
	StaleTurn = 10 * time.Minute
	// StartupGrace bounds the wait for a --resume start to either answer or
	// fail (a transcript deleted between the check and the start, probe V21).
	StartupGrace = 3 * time.Second

	maxClientMsgID  = 64
	recentMsgIDs    = 256
	stderrTailBytes = 8 << 10
	stopResultWait  = 2 * time.Second
	stopTermWait    = time.Second
	stopKillWait    = time.Second
)

// Tuning overrides timing constants (tests); zero values use the defaults.
type Tuning struct {
	StaleTurn      time.Duration
	InitializeWait time.Duration
	StartupGrace   time.Duration
}

// Spec describes one chat session's claude process.
type Spec struct {
	ID              string // vibe-remote session id
	Workdir         string
	Exe             string   // claude executable (from ParseClaudeCmd)
	Args            []string // user arguments, without -c and session control flags
	ClaudeSessionID string   // U: --session-id U, or --resume U once a transcript exists
	LoginShell      bool
	Shell           string
	Env             []string // full environment; nil = the daemon's
	ProjectsDir     string   // where transcripts live (ProjectsDir())
	Lock            bool     // permission mode fixed to bypass (R1.6)
	PermissionMode  string   // mode the arguments start claude in ("" = default)
	Hooks           Hooks
	Tuning          Tuning

	test *testHooks
}

// Hooks connect a Session to its owner (the session Manager).
type Hooks struct {
	// Claim is called before RestartLocked starts a process: the claude
	// session id must belong to this session (same owner succeeds).
	Claim func(u string) error
	// OnExit runs on its own goroutine, without Session.mu, after a process
	// is gone and its messages are settled.
	OnExit func(ExitEvent)
}

// ExitEvent reports that a session's process ended.
type ExitEvent struct {
	Session         *Session
	ClaudeSessionID string
	Reason          string // an EndReason*, or "restart"
	// Release: the session no longer holds its claude session id. False only
	// for the stop half of a restart, which keeps the claim.
	Release bool
	Ended   *protocol.ChatEnded
}

// reasonRestart is StopLocked's reason inside RestartLocked; clients see
// EndReasonStopped until the new process is up.
const reasonRestart = "restart"

// testHooks are seams for this package's tests only.
type testHooks struct {
	onStdin     func([]byte)          // a line was written to stdin
	beforeLine  func([]byte)          // before a stdout line is handled
	afterResult func(outstanding int) // after a result line was counted
	afterFind   func(path string)     // after the transcript lookup of a start
	readerExit  func()                // stdout and stderr readers are done
	settle      func()                // messages of a stopped process are settled
	writeHold   sync.Mutex            // locked = the stdin writer pauses
}

// Ack answers a client request.
type Ack struct {
	OK      bool
	Code    string
	Message string
	// Duplicate (Send): the clientMsgId was already accepted; Completed: a
	// result for it has been seen.
	Duplicate bool
	Completed bool
}

func ok() Ack                    { return Ack{OK: true} }
func nack(code string) Ack       { return Ack{Code: code} }
func nackMsg(code, m string) Ack { return Ack{Code: code, Message: m} }

type entry struct {
	seq   uint64
	frame []byte
}

type pendingEntry struct {
	id      string
	seq     uint64
	request json.RawMessage
}

// initialize reply states.
const (
	initPending = iota
	initOK
	initFallback // failed or timed out: system/init's names are used
)

// Session is one chat session: its claude process (if any), the epoch's
// message buffer, the open permission requests and the subscribers.
//
// Lock order (design 2): opMu → (Manager.mu) → mu. mu is held only briefly
// and never across blocking IO.
type Session struct {
	opMu sync.Mutex // serializes stop / restart / handoff / delete
	mu   sync.Mutex

	spec  Spec
	test  *testHooks
	stale time.Duration

	proc        *proc
	epoch       string
	seq         uint64
	ring        []entry
	ringBytes   int
	omitted     int
	evictedUpTo uint64
	tail        []entry
	tailBytes   int
	cutoff      int64 // transcript bytes that predate this epoch; -1 = whole file

	pending       []pendingEntry
	ours          map[string]string // daemon's own control requests: id → subtype
	ourSeq        int
	unpaired      []string // clientMsgIds written and not yet paired with a result
	ignoreResults int
	interruptID   string
	lastActivity  time.Time

	permissionMode string
	initCmds       []protocol.SlashCommand
	initializeCmds []protocol.SlashCommand
	initState      int
	initializeReq  string
	degraded       []string
	claudeVersion  string
	ended          *protocol.ChatEnded

	// delivered records the last recentMsgIDs clientMsgIds Send accepted
	// (value: a result for it was seen), in acceptance order. It is kept
	// apart from the ring, so a replay is recognized after eviction too.
	delivered      map[string]bool
	deliveredOrder []string
	subs           map[*Subscription]struct{}
	lastState      []byte
	nonJSON        int
	reloading      bool
	exitCB         chan struct{} // closed when the last exit callback returned
}

// proc is one running claude process (one epoch).
type proc struct {
	cmd      *exec.Cmd
	pid      int
	stdin    io.WriteCloser
	stdinQ   chan []byte
	stderr   *tailWriter
	restart  bool
	waitDone chan struct{} // closed when Wait returned
	joined   chan struct{} // closed when the readers finished (and a real exit was settled)
	stopCh   chan struct{} // closed when settled: writer and watchdog end
	firstOut chan struct{} // closed on the first stdout line
	firstMu  sync.Once
	resultCh chan struct{} // poked on every result line

	// guarded by Session.mu
	exitCode       int
	stopping       string
	results        int
	sawInit        bool
	versionChecked bool
	badVersion     *string
	lastErrors     []string
}

// NewUUID returns a random UUID v4 (claude session ids).
func NewUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func newEpoch() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

func newSession(spec Spec) *Session {
	s := &Session{
		spec:      spec,
		test:      spec.test,
		stale:     spec.Tuning.StaleTurn,
		ours:      map[string]string{},
		delivered: map[string]bool{},
		subs:      map[*Subscription]struct{}{},
		cutoff:    -1,
	}
	if s.stale <= 0 {
		s.stale = StaleTurn
	}
	if s.test == nil {
		s.test = &testHooks{}
	}
	s.permissionMode = s.initialMode()
	return s
}

func (s *Session) initialMode() string {
	switch {
	case s.spec.Lock:
		return "bypassPermissions"
	case s.spec.PermissionMode != "":
		return s.spec.PermissionMode
	}
	return "default"
}

// Start launches a chat session's claude process. The caller must already
// hold the claim on spec.ClaudeSessionID.
func Start(spec Spec) (*Session, error) {
	s := newSession(spec)
	if err := s.spawn(false); err != nil {
		return nil, err
	}
	return s, nil
}

// Load returns a session whose process is not running (a record read back
// after a daemon restart). Its history is the whole transcript; RestartLocked
// starts it again.
func Load(spec Spec, ended *protocol.ChatEnded) *Session {
	s := newSession(spec)
	s.ended = ended
	return s
}

// Reloading reports whether a reload was accepted and has not finished.
func (s *Session) Reloading() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reloading
}

// BeginReload marks a reload as accepted; false if one already is (the
// second request is answered without starting a second restart).
func (s *Session) BeginReload() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reloading {
		return false
	}
	s.reloading = true
	return true
}

// EndReload clears the mark set by BeginReload.
func (s *Session) EndReload() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reloading = false
}

// SetHandedOff records that the conversation continues in terminal session
// to (ended.reason handed_off) and tells every subscriber.
func (s *Session) SetHandedOff(to string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ended = &protocol.ChatEnded{Reason: protocol.EndReasonHandedOff, HandedOffTo: to}
	s.broadcastStateLocked()
}

// BroadcastState sends the current chat_state to every subscriber, even if
// it did not change.
func (s *Session) BroadcastState() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastState = nil
	s.broadcastStateLocked()
}

// Close drops every subscriber (the session was deleted); their relays close
// the connection and a reconnect finds the session gone.
func (s *Session) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for sub := range s.subs {
		delete(s.subs, sub)
		close(sub.c)
	}
}

// ID is the vibe-remote session id.
func (s *Session) ID() string { return s.spec.ID }

// ClaudeSessionID is the claude conversation this session runs.
func (s *Session) ClaudeSessionID() string { return s.spec.ClaudeSessionID }

// Spec returns the session's launch description.
func (s *Session) Spec() Spec { return s.spec }

func (s *Session) argv(resume bool) *exec.Cmd {
	argv := ChatArgv(Parsed{Exe: s.spec.Exe, Args: s.spec.Args}, s.spec.ClaudeSessionID, resume)
	var cmd *exec.Cmd
	if s.spec.LoginShell {
		sh := s.spec.Shell
		if sh == "" {
			sh = "/bin/bash"
		}
		cmd = exec.Command(sh, "-lic", "exec "+ShellJoin(argv))
	} else {
		cmd = exec.Command(argv[0], argv[1:]...)
	}
	cmd.Dir = s.spec.Workdir
	env := s.spec.Env
	if env == nil {
		env = os.Environ()
	}
	cmd.Env = withoutNestedGuard(env)
	cmd.SysProcAttr = sysProcAttr()
	return cmd
}

// spawn starts a new process and epoch. Called from Start or with opMu held.
func (s *Session) spawn(restart bool) error {
	path, resume := FindTranscript(s.spec.ProjectsDir, s.spec.ClaudeSessionID)
	if s.test.afterFind != nil {
		s.test.afterFind(path)
	}
	var cutoff int64
	if resume {
		if fi, err := os.Stat(path); err == nil {
			cutoff = fi.Size()
		}
	}
	cmd := s.argv(resume)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("stdin pipe: %w", err)
	}
	// The daemon owns the stdout pipe (not StdoutPipe, which Wait closes
	// while lines may still be unread, design 6.4).
	outR, outW, err := os.Pipe()
	if err != nil {
		stdin.Close()
		return fmt.Errorf("stdout pipe: %w", err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		stdin.Close()
		outR.Close()
		outW.Close()
		return fmt.Errorf("stderr pipe: %w", err)
	}
	cmd.Stdout, cmd.Stderr = outW, errW
	if err := cmd.Start(); err != nil {
		stdin.Close()
		outR.Close()
		outW.Close()
		errR.Close()
		errW.Close()
		return fmt.Errorf("start claude: %w", err)
	}
	outW.Close()
	errW.Close()

	p := &proc{
		cmd:      cmd,
		pid:      cmd.Process.Pid,
		stdin:    stdin,
		stdinQ:   make(chan []byte, StdinQueue),
		stderr:   &tailWriter{max: stderrTailBytes},
		restart:  restart,
		waitDone: make(chan struct{}),
		joined:   make(chan struct{}),
		stopCh:   make(chan struct{}),
		firstOut: make(chan struct{}),
		resultCh: make(chan struct{}, 1),
	}

	s.mu.Lock()
	s.proc = p
	s.epoch = newEpoch()
	s.seq = 0
	s.ring, s.ringBytes, s.omitted, s.evictedUpTo = nil, 0, 0, 0
	s.tail, s.tailBytes = nil, 0
	s.cutoff = cutoff
	s.pending = nil
	s.ours = map[string]string{}
	s.unpaired = nil
	s.ignoreResults = 0
	s.interruptID = ""
	s.lastActivity = time.Now()
	s.permissionMode = s.initialMode()
	s.initState = initPending
	s.initCmds, s.initializeCmds = nil, nil
	s.degraded = nil
	s.ended = nil
	// initialize only fetches the command list (probe V1); stdin is
	// buffered while claude starts (V7), so nothing waits for it.
	s.initializeReq = s.ourIDLocked("initialize")
	s.enqueueLocked(p, controlRequestLine(s.initializeReq, map[string]any{"subtype": "initialize"}))
	if restart && len(s.subs) > 0 {
		plan := s.planLocked("", nil)
		for sub := range s.subs {
			s.sendLocked(sub, Event{Resync: plan})
		}
		s.lastState = plan.State
	}
	s.broadcastStateLocked()
	s.mu.Unlock()

	readerDone := make(chan struct{})
	stderrDone := make(chan struct{})
	go s.writer(p)
	go s.readStdout(p, outR, readerDone)
	go func() {
		_, _ = io.Copy(p.stderr, errR)
		errR.Close()
		close(stderrDone)
	}()
	go s.monitor(p, readerDone, stderrDone)
	go s.watchdog(p)
	wait := s.spec.Tuning.InitializeWait
	if wait <= 0 {
		wait = InitializeWait
	}
	time.AfterFunc(wait, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.proc == p && s.initState == initPending {
			s.initState = initFallback
			s.broadcastStateLocked()
		}
	})

	if !resume {
		return nil
	}
	grace := s.spec.Tuning.StartupGrace
	if grace <= 0 {
		grace = StartupGrace
	}
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-p.firstOut:
		// Answered something; but a missing transcript still exits right
		// after its result line, so give a just-failing process its exit.
		select {
		case <-p.joined:
		case <-time.After(50 * time.Millisecond):
			return nil
		}
	case <-p.joined:
	case <-timer.C:
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proc == p { // still running after all
		return nil
	}
	if s.ended != nil && s.ended.Message != "" {
		return errors.New(s.ended.Message)
	}
	return fmt.Errorf("claude exited during startup (code %d)", p.exitCode)
}

// ourIDLocked registers a control request the daemon sends.
func (s *Session) ourIDLocked(subtype string) string {
	s.ourSeq++
	id := "vr-" + strconv.Itoa(s.ourSeq)
	s.ours[id] = subtype
	return id
}

// enqueueLocked queues a stdin line without blocking; false = queue full.
func (s *Session) enqueueLocked(p *proc, line []byte) bool {
	select {
	case p.stdinQ <- line:
		return true
	default:
		return false
	}
}

func (s *Session) writer(p *proc) {
	for {
		select {
		case <-p.stopCh:
			return
		case line := <-p.stdinQ:
			s.test.writeHold.Lock()
			s.test.writeHold.Unlock() //nolint:staticcheck // a pause point for tests
			if _, err := p.stdin.Write(line); err == nil && s.test.onStdin != nil {
				s.test.onStdin(line)
			}
		}
	}
}

// readStdout reads claude's stdout until EOF, whether or not anyone is
// subscribed: a full pipe would block claude (probe V5).
func (s *Session) readStdout(p *proc, r *os.File, done chan struct{}) {
	defer close(done)
	defer r.Close()
	br := bufio.NewReaderSize(r, 64<<10)
	for {
		line, tooLong, err := readLine(br)
		if tooLong {
			p.firstMu.Do(func() { close(p.firstOut) })
			log.Printf("chat [%s]: dropped a stdout line over %d bytes", s.spec.ID, MaxLine)
			s.mu.Lock()
			if s.proc == p {
				s.appendRingLocked(vrNotice(NoticeLineDropped, fmt.Sprintf("a line over %d bytes was dropped", MaxLine), ""))
			}
			s.mu.Unlock()
		} else if len(line) > 0 {
			if s.test.beforeLine != nil {
				s.test.beforeLine(line)
			}
			s.handleLine(p, line)
		}
		if err != nil {
			return
		}
	}
}

// readLine reads one '\n'-terminated line of at most MaxLine bytes. A longer
// line is consumed and reported as tooLong.
func readLine(br *bufio.Reader) (line []byte, tooLong bool, err error) {
	var buf []byte
	for {
		chunk, e := br.ReadSlice('\n')
		if !tooLong {
			if len(buf)+len(chunk) > MaxLine+1 {
				tooLong, buf = true, nil
			} else {
				buf = append(buf, chunk...)
			}
		}
		if e == bufio.ErrBufferFull {
			continue
		}
		return buf, tooLong, e
	}
}

// monitor waits for the process and its readers. A real exit (nobody is
// stopping it) is settled here; a stop is settled by StopLocked.
func (s *Session) monitor(p *proc, readerDone, stderrDone chan struct{}) {
	code := 0
	if err := p.cmd.Wait(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
			if code < 0 {
				if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
					code = 128 + int(ws.Signal())
				}
			}
		} else {
			code = -1
		}
	}
	s.mu.Lock()
	p.exitCode = code
	s.mu.Unlock()
	close(p.waitDone)
	<-readerDone
	<-stderrDone
	if s.test.readerExit != nil {
		s.test.readerExit()
	}
	s.mu.Lock()
	if p.stopping != "" || s.proc != p {
		s.mu.Unlock()
		close(p.joined)
		return
	}
	reason, msg := protocol.EndReasonExited, ""
	if !p.sawInit && len(p.lastErrors) > 0 {
		msg = p.lastErrors[0]
		if p.restart {
			reason = protocol.EndReasonRestartFailed
		}
	}
	run := s.settleLocked(p, reason, msg)
	s.mu.Unlock()
	close(p.joined)
	run(false)
}

// watchdog gives up on a turn that produced nothing for StaleTurn while no
// permission request was open (claude stays silent while it waits for an
// answer, probe V13).
func (s *Session) watchdog(p *proc) {
	tick := s.stale / 4
	if tick < 10*time.Millisecond {
		tick = 10 * time.Millisecond
	}
	if tick > 5*time.Second {
		tick = 5 * time.Second
	}
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		select {
		case <-p.stopCh:
			return
		case <-t.C:
		}
		s.mu.Lock()
		if s.proc == p && len(s.unpaired) > 0 && len(s.pending) == 0 && time.Since(s.lastActivity) >= s.stale {
			id := s.unpaired[0]
			s.unpaired = s.unpaired[1:]
			s.ignoreResults++
			s.lastActivity = time.Now()
			log.Printf("chat [%s]: no output for %v, giving up on a turn", s.spec.ID, s.stale)
			s.appendRingLocked(vrNotice(NoticeStaleTurn, "no result arrived for this message", id))
			s.broadcastStateLocked()
		}
		s.mu.Unlock()
	}
}

// injectLine handles line as if the current process had printed it (tests).
func (s *Session) injectLine(line []byte) {
	s.mu.Lock()
	p := s.proc
	s.mu.Unlock()
	if p != nil {
		s.handleLine(p, line)
	}
}

// initializeID is the request id of this epoch's initialize (tests).
func (s *Session) initializeID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.initializeReq
}

// procWaitDone is closed once the current process was reaped (tests).
func (s *Session) procWaitDone() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proc == nil {
		c := make(chan struct{})
		close(c)
		return c
	}
	return s.proc.waitDone
}

// handleLine processes one stdout line of process p.
func (s *Session) handleLine(p *proc, raw []byte) {
	line := bytes.TrimSpace(raw)
	if len(line) == 0 {
		return
	}
	p.firstMu.Do(func() { close(p.firstOut) })
	var env envelope
	if line[0] != '{' || json.Unmarshal(line, &env) != nil || env.Type == "" {
		s.mu.Lock()
		s.nonJSON++
		n := s.nonJSON
		s.mu.Unlock()
		if n <= 3 {
			log.Printf("chat [%s]: skipped a non-JSON stdout line (%d so far)", s.spec.ID, n)
		}
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proc != p {
		return // a settled epoch takes nothing more
	}
	if env.Type != "keep_alive" {
		s.lastActivity = time.Now()
	}
	switch env.Type {
	case "keep_alive":
		return
	case "stream_event":
		evType := ""
		if env.Event != nil {
			evType = env.Event.Type
		}
		s.appendTailLocked(line, evType)
	case "control_request":
		if requestSubtype(env.Request) != "can_use_tool" {
			// No hooks or SDK servers are registered, so claude should not
			// ask anything else; answer at once so it never hangs.
			s.enqueueLocked(p, controlErrorLine(env.RequestID, "unsupported by vibe-remote"))
			return
		}
		seq := s.appendRingLocked(line)
		s.pending = append(s.pending, pendingEntry{id: env.RequestID, seq: seq, request: append(json.RawMessage(nil), env.Request...)})
	case "control_cancel_request":
		s.appendRingLocked(line)
		if i := s.pendingIndexLocked(env.RequestID); i >= 0 {
			s.removePendingLocked(i)
			outcome := outcomeCancelled
			if s.interruptID != "" {
				outcome = outcomeInterrupted
			}
			s.appendRingLocked(vrResolved(env.RequestID, outcome))
		}
	case "control_response":
		s.handleOurResponseLocked(&env)
	case "system":
		s.handleSystemLocked(p, &env)
		s.appendRingLocked(line)
	case "result":
		p.results++
		msg := line
		if s.ignoreResults > 0 {
			s.ignoreResults--
			msg = markStale(line)
		} else if len(s.unpaired) > 0 {
			if id := s.unpaired[0]; id != "" {
				if _, seen := s.delivered[id]; seen {
					s.delivered[id] = true
				}
			}
			s.unpaired = s.unpaired[1:]
		}
		s.interruptID = ""
		if len(env.Errors) > 0 && env.NumTurns != nil && *env.NumTurns == 0 {
			p.lastErrors = env.Errors
		}
		s.appendRingLocked(msg)
		s.tail, s.tailBytes = nil, 0
		select {
		case p.resultCh <- struct{}{}:
		default:
		}
		if s.test.afterResult != nil {
			s.test.afterResult(len(s.unpaired))
		}
	default:
		s.appendRingLocked(line)
	}
	s.broadcastStateLocked()
}

func (s *Session) handleOurResponseLocked(env *envelope) {
	if env.Response == nil {
		return
	}
	id := env.Response.RequestID
	kind, ok := s.ours[id]
	if !ok {
		return // not ours: nothing to forward
	}
	delete(s.ours, id)
	success := env.Response.Subtype == "success"
	switch kind {
	case "initialize":
		if success {
			var r struct {
				Commands []protocol.SlashCommand `json:"commands"`
			}
			_ = json.Unmarshal(env.Response.Response, &r)
			s.initializeCmds = r.Commands
			s.initState = initOK
		} else if s.initState != initOK {
			s.initState = initFallback
		}
	case "interrupt":
		if s.interruptID == id {
			s.interruptID = ""
		}
	case "set_permission_mode":
		var r struct {
			Mode string `json:"mode"`
		}
		if success && json.Unmarshal(env.Response.Response, &r) == nil && r.Mode != "" {
			s.permissionMode = r.Mode
		}
	}
}

// handleSystemLocked updates session metadata from system/init (sent again at
// the start of every turn, probe V1) and system/status.
func (s *Session) handleSystemLocked(p *proc, env *envelope) {
	if env.PermissionMode != nil && *env.PermissionMode != "" {
		s.permissionMode = *env.PermissionMode
	}
	if env.Subtype != "init" {
		return
	}
	p.sawInit = true
	if env.SlashCommands != nil {
		cmds := make([]protocol.SlashCommand, 0, len(env.SlashCommands))
		for _, n := range env.SlashCommands {
			cmds = append(cmds, protocol.SlashCommand{Name: n})
		}
		s.initCmds = cmds
	}
	version := ""
	if env.ClaudeCodeVersion != nil {
		version = *env.ClaudeCodeVersion
	}
	s.claudeVersion = version
	hasReceipt := false
	if env.Capabilities != nil {
		for _, c := range *env.Capabilities {
			if c == "interrupt_receipt_v1" {
				hasReceipt = true
			}
		}
	}
	if hasReceipt {
		s.degraded = nil
	} else if s.degraded == nil {
		s.degraded = []string{"interrupt_receipt"}
		log.Printf("chat [%s]: claude lacks interrupt_receipt_v1; interrupts are not confirmed", s.spec.ID)
	}
	if p.versionChecked {
		return
	}
	p.versionChecked = true
	min, _ := ParseVersion(MinClaudeVersion)
	if v, ok := ParseVersion(version); ok && VersionAtLeast(v, min) {
		return
	}
	p.badVersion = &version
	go s.WithOp(func(ops OpHandle) { _ = ops.stop(p, protocol.EndReasonVersionUnsupported) })
}

func (s *Session) pendingIndexLocked(id string) int {
	for i, pe := range s.pending {
		if pe.id == id {
			return i
		}
	}
	return -1
}

func (s *Session) removePendingLocked(i int) {
	s.pending = append(s.pending[:i:i], s.pending[i+1:]...)
}

func chatFrame(seq uint64, msg []byte) []byte {
	b := make([]byte, 0, len(msg)+40)
	b = append(b, `{"type":"chat","seq":`...)
	b = strconv.AppendUint(b, seq, 10)
	b = append(b, `,"msg":`...)
	b = append(b, msg...)
	return append(b, '}')
}

// appendRingLocked buffers a complete message under the next seq and sends
// it to every subscriber.
func (s *Session) appendRingLocked(msg []byte) uint64 {
	s.seq++
	f := chatFrame(s.seq, msg)
	s.ring = append(s.ring, entry{seq: s.seq, frame: f})
	s.ringBytes += len(f)
	for len(s.ring) > RingMax || (s.ringBytes > RingBytesMax && len(s.ring) > 1) {
		s.ringBytes -= len(s.ring[0].frame)
		s.evictedUpTo = s.ring[0].seq
		s.ring[0] = entry{}
		s.ring = s.ring[1:]
		s.omitted++
	}
	s.broadcastLocked(Event{Frame: f})
	return s.seq
}

// appendTailLocked keeps the stream events of the reply being generated, so
// a client that reconnects mid-reply gets its missing deltas (R12.4).
func (s *Session) appendTailLocked(msg []byte, evType string) {
	if evType == "message_start" {
		s.tail, s.tailBytes = nil, 0
	}
	s.seq++
	f := chatFrame(s.seq, msg)
	s.tail = append(s.tail, entry{seq: s.seq, frame: f})
	s.tailBytes += len(f)
	for len(s.tail) > TailMax || (s.tailBytes > TailBytesMax && len(s.tail) > 1) {
		s.tailBytes -= len(s.tail[0].frame)
		s.tail = s.tail[1:]
	}
	s.broadcastLocked(Event{Frame: f})
	if evType == "message_stop" {
		s.tail, s.tailBytes = nil, 0
	}
}

func (s *Session) statusLocked() string {
	switch {
	case s.proc == nil:
		return protocol.ChatStatusEnded
	case len(s.pending) > 0:
		return protocol.ChatStatusWaiting
	case len(s.unpaired) > 0:
		return protocol.ChatStatusRunning
	}
	return protocol.ChatStatusIdle
}

func (s *Session) slashLocked() []protocol.SlashCommand {
	var cmds []protocol.SlashCommand
	switch s.initState {
	case initOK:
		cmds = s.initializeCmds
	case initFallback:
		cmds = s.initCmds
	}
	if cmds == nil {
		cmds = []protocol.SlashCommand{}
	}
	return cmds
}

func (s *Session) pendingLocked() []protocol.PendingRequest {
	out := make([]protocol.PendingRequest, 0, len(s.pending))
	for _, pe := range s.pending {
		out = append(out, protocol.PendingRequest{RequestID: pe.id, Seq: pe.seq, Request: pe.request})
	}
	return out
}

func (s *Session) stateLocked() protocol.ChatStateFrame {
	return protocol.ChatStateFrame{
		Type:             protocol.TypeChatState,
		Status:           s.statusLocked(),
		PermissionMode:   s.permissionMode,
		PermissionLocked: s.spec.Lock,
		Pending:          s.pendingLocked(),
		Degraded:         s.degraded,
		SlashCommands:    s.slashLocked(),
		ClaudeVersion:    s.claudeVersion,
		ClaudeSessionID:  s.spec.ClaudeSessionID,
		Ended:            s.ended,
	}
}

// broadcastStateLocked sends chat_state to every subscriber when it changed.
func (s *Session) broadcastStateLocked() {
	b := mustJSON(s.stateLocked())
	if bytes.Equal(b, s.lastState) {
		return
	}
	s.lastState = b
	s.broadcastLocked(Event{Frame: b})
}

// Info is a point-in-time view of a session.
type Info struct {
	ID               string
	ClaudeSessionID  string
	Status           string
	Epoch            string
	Seq              uint64
	Pending          []protocol.PendingRequest
	PermissionMode   string
	PermissionLocked bool
	SlashCommands    []protocol.SlashCommand
	ClaudeVersion    string
	Degraded         []string
	Ended            *protocol.ChatEnded
	Pid              int
	Outstanding      int
	IgnoreResults    int
	NonJSONLines     int
	Reloading        bool
}

// Snapshot returns the session's current state.
func (s *Session) Snapshot() Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	info := Info{
		ID:               s.spec.ID,
		ClaudeSessionID:  s.spec.ClaudeSessionID,
		Status:           s.statusLocked(),
		Epoch:            s.epoch,
		Seq:              s.seq,
		Pending:          s.pendingLocked(),
		PermissionMode:   s.permissionMode,
		PermissionLocked: s.spec.Lock,
		SlashCommands:    s.slashLocked(),
		ClaudeVersion:    s.claudeVersion,
		Degraded:         s.degraded,
		Ended:            s.ended,
		Outstanding:      len(s.unpaired),
		IgnoreResults:    s.ignoreResults,
		NonJSONLines:     s.nonJSON,
		Reloading:        s.reloading,
	}
	if s.proc != nil {
		info.Pid = s.proc.pid
	}
	return info
}

// --- client requests ---

// Send writes one user message to claude (chat_send).
func (s *Session) Send(clientMsgID, text string) Ack {
	if strings.TrimSpace(text) == "" {
		return nack(protocol.AckEmpty)
	}
	if len(text) > MaxSendBytes {
		return nackMsg(protocol.AckTooLarge, fmt.Sprintf("message exceeds %d bytes", MaxSendBytes))
	}
	if len(clientMsgID) > maxClientMsgID {
		return nackMsg(protocol.AckTooLarge, fmt.Sprintf("clientMsgId exceeds %d characters", maxClientMsgID))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if completed, seen := s.delivered[clientMsgID]; clientMsgID != "" && seen {
		// A replay of a message already written: not written again.
		return Ack{OK: true, Duplicate: true, Completed: completed}
	}
	p := s.proc
	if p == nil {
		return nack(protocol.AckChatNotRunning)
	}
	if !s.enqueueLocked(p, userMessageLine(text)) {
		return nack(protocol.AckChatBusy)
	}
	if clientMsgID != "" {
		s.delivered[clientMsgID] = false
		s.deliveredOrder = append(s.deliveredOrder, clientMsgID)
		if len(s.deliveredOrder) > recentMsgIDs {
			delete(s.delivered, s.deliveredOrder[0])
			s.deliveredOrder = s.deliveredOrder[1:]
		}
	}
	s.appendRingLocked(userEcho(text, clientMsgID))
	s.unpaired = append(s.unpaired, clientMsgID)
	s.lastActivity = time.Now()
	s.broadcastStateLocked()
	return ok()
}

// forgetMsgIDLocked drops id from the replay filter of Send.
func (s *Session) forgetMsgIDLocked(id string) {
	if _, seen := s.delivered[id]; id == "" || !seen {
		return
	}
	delete(s.delivered, id)
	for i, r := range s.deliveredOrder {
		if r == id {
			s.deliveredOrder = append(s.deliveredOrder[:i:i], s.deliveredOrder[i+1:]...)
			break
		}
	}
}

// Respond answers an open permission request (chat_respond). The answer is
// queued for stdin before the request leaves the pending table, so a full
// queue never shows as answered while claude still waits (R5.6).
func (s *Session) Respond(requestID string, resp json.RawMessage, setMode string) Ack {
	var r map[string]json.RawMessage
	if json.Unmarshal(resp, &r) != nil || r == nil {
		return nackMsg(protocol.AckInvalidResponse, "response must be an object")
	}
	var behavior string
	_ = json.Unmarshal(r["behavior"], &behavior)
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.pendingIndexLocked(requestID)
	if i < 0 {
		return nack(protocol.AckRequestNotPending)
	}
	if behavior != "allow" && behavior != "deny" {
		return nackMsg(protocol.AckInvalidResponse, "behavior must be allow or deny")
	}
	if setMode != "" && setMode != "acceptEdits" && setMode != "default" {
		return nack(protocol.AckInvalidMode)
	}
	p := s.proc
	if p == nil {
		return nack(protocol.AckChatNotRunning)
	}
	var req struct {
		ToolName    string            `json:"tool_name"`
		Input       json.RawMessage   `json:"input"`
		Suggestions []json.RawMessage `json:"permission_suggestions"`
	}
	_ = json.Unmarshal(s.pending[i].request, &req)
	if setMode != "" {
		// setMode only comes with approving a plan, and never unlocks a
		// session whose mode is fixed (as SetMode).
		if s.spec.Lock {
			return nack(protocol.AckModeLocked)
		}
		if req.ToolName != "ExitPlanMode" {
			return nackMsg(protocol.AckInvalidMode, "setMode is only accepted when answering a plan")
		}
	}
	if up := r["updatedPermissions"]; len(up) > 0 && string(up) != "null" {
		var items []json.RawMessage
		if json.Unmarshal(up, &items) != nil {
			return nack(protocol.AckForeignRule)
		}
		for _, item := range items {
			found := false
			for _, sug := range req.Suggestions {
				if jsonEqual(item, sug) {
					found = true
					break
				}
			}
			if !found {
				return nack(protocol.AckForeignRule)
			}
		}
	}
	if behavior == "allow" {
		if in := r["updatedInput"]; len(in) == 0 || string(in) == "null" {
			// claude requires updatedInput on allow (probe V2).
			r["updatedInput"] = req.Input
			if len(req.Input) == 0 {
				r["updatedInput"] = json.RawMessage(`{}`)
			}
		}
	}
	if !s.enqueueLocked(p, controlResponseLine(requestID, mustJSON(r))) {
		return nack(protocol.AckChatBusy)
	}
	s.removePendingLocked(i)
	outcome := outcomeAllowed
	if behavior == "deny" {
		outcome = outcomeDenied
	}
	s.appendRingLocked(vrResolved(requestID, outcome))
	if setMode != "" {
		// Right behind the answer: claude restores the pre-plan mode itself,
		// and a switch sent at once is not overridden (probe V22).
		id := s.ourIDLocked("set_permission_mode")
		if !s.enqueueLocked(p, controlRequestLine(id, map[string]any{"subtype": "set_permission_mode", "mode": setMode})) {
			delete(s.ours, id)
			s.appendRingLocked(vrNotice(NoticeSetModeFailed, "the permission mode could not be switched to "+setMode, ""))
		}
	}
	s.lastActivity = time.Now()
	s.broadcastStateLocked()
	return ok()
}

// Interrupt stops the running turn (chat_interrupt). claude cancels its own
// open requests and ends the turn (probe V12); the daemon answers nothing.
func (s *Session) Interrupt() Ack {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.proc
	if p == nil || (len(s.unpaired) == 0 && len(s.pending) == 0) {
		return ok()
	}
	id := s.ourIDLocked("interrupt")
	if !s.enqueueLocked(p, controlRequestLine(id, map[string]any{"subtype": "interrupt"})) {
		delete(s.ours, id)
		return nack(protocol.AckChatBusy)
	}
	s.interruptID = id
	return ok()
}

// SetMode switches the permission mode (chat_set_mode); the new mode shows
// once claude confirms it.
func (s *Session) SetMode(mode string) Ack {
	if mode != "default" && mode != "acceptEdits" && mode != "plan" {
		return nack(protocol.AckInvalidMode)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.spec.Lock {
		return nack(protocol.AckModeLocked)
	}
	p := s.proc
	if p == nil {
		return nack(protocol.AckChatNotRunning)
	}
	id := s.ourIDLocked("set_permission_mode")
	if !s.enqueueLocked(p, controlRequestLine(id, map[string]any{"subtype": "set_permission_mode", "mode": mode})) {
		delete(s.ours, id)
		return nack(protocol.AckChatBusy)
	}
	return ok()
}

// --- stop and restart ---

// OpHandle is the capability WithOp hands out: only code holding opMu may
// stop or restart the process.
type OpHandle struct{ s *Session }

// WithOp runs fn holding the session's operation lock (not reentrant: fn must
// not call WithOp again). Manager's handoff, delete and reload each call it once.
func (s *Session) WithOp(fn func(ops OpHandle)) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	fn(OpHandle{s})
}

// StopLocked stops the process and waits until it is gone (design 6.4):
// interrupt → the turn's result (≤2 s) → SIGTERM to the process group → 1 s
// for claude to exit and its output to end → otherwise SIGKILL to the group →
// Wait → the stdout reader finished (≤1 s more) → every written message
// without a result gets dropped_on_stop → exit callback. Idempotent.
func (o OpHandle) StopLocked(reason string) error { return o.stop(nil, reason) }

// stop stops target (nil = whatever runs now).
func (o OpHandle) stop(target *proc, reason string) error {
	s := o.s
	s.waitExitCallback()
	s.mu.Lock()
	p := s.proc
	if p == nil || (target != nil && p != target) {
		s.mu.Unlock()
		return nil
	}
	p.stopping = reason
	running := len(s.unpaired) > 0 || len(s.pending) > 0
	results := p.results
	if running {
		id := s.ourIDLocked("interrupt")
		if s.enqueueLocked(p, controlRequestLine(id, map[string]any{"subtype": "interrupt"})) {
			s.interruptID = id
		} else {
			delete(s.ours, id)
		}
	}
	s.mu.Unlock()

	if running {
		deadline := time.NewTimer(stopResultWait)
	wait:
		for {
			select {
			case <-p.resultCh:
				s.mu.Lock()
				got := p.results > results
				s.mu.Unlock()
				if got {
					break wait
				}
			case <-p.waitDone:
				break wait
			case <-deadline.C:
				break wait
			}
		}
		deadline.Stop()
	}
	// Signal right away: closing stdin would let claude run every queued
	// message first (probe V5, V14). The deadline covers both claude's exit
	// and the end of its output: a process left in claude's group that
	// ignores SIGTERM keeps stdout open after claude itself is gone, so the
	// group gets SIGKILL unless both happened in time.
	if !closed(p.joined) {
		signalGroup(p.pid, syscall.SIGTERM)
		select {
		case <-p.joined:
		case <-time.After(stopTermWait):
			signalGroup(p.pid, syscall.SIGKILL)
			<-p.waitDone // claude itself is confirmed gone
			select {
			case <-p.joined:
			case <-time.After(stopKillWait):
				// Held open by a process outside claude's group; the epoch is
				// settled without it (its lines are ignored from now on).
				log.Printf("chat [%s]: claude's output is still held open after it exited; not waiting for it", s.spec.ID)
			}
		}
	}

	s.mu.Lock()
	run := s.settleLocked(p, reason, "")
	s.mu.Unlock()
	run(true)
	return nil
}

func closed(c chan struct{}) bool {
	select {
	case <-c:
		return true
	default:
		return false
	}
}

// waitExitCallback waits for a running exit callback, so a restart never
// claims before the previous process's release went through.
func (s *Session) waitExitCallback() {
	s.mu.Lock()
	c := s.exitCB
	s.mu.Unlock()
	if c != nil {
		<-c
	}
}

// settleLocked closes an epoch whose process is gone and readers are done.
// It returns the function that runs the exit callback on its own goroutine
// (wait = block until it returned).
func (s *Session) settleLocked(p *proc, reason, message string) func(wait bool) {
	if s.test.settle != nil {
		s.test.settle()
	}
	for _, id := range s.unpaired {
		s.appendRingLocked(vrNotice(NoticeDroppedOnStop, "the session stopped before this message ran", id))
		// It never ran: a resend with the same id is a new message, not a
		// replay to swallow.
		s.forgetMsgIDLocked(id)
	}
	for _, pe := range s.pending {
		s.appendRingLocked(vrResolved(pe.id, outcomeExited))
	}
	s.unpaired, s.pending, s.ignoreResults, s.interruptID = nil, nil, 0, ""
	s.ours = map[string]string{}
	s.tail, s.tailBytes = nil, 0

	shown := reason
	if reason == reasonRestart {
		shown = protocol.EndReasonStopped
	}
	if p.badVersion != nil {
		shown = protocol.EndReasonVersionUnsupported
	}
	ended := &protocol.ChatEnded{Reason: shown, Message: message}
	exited := shown == protocol.EndReasonExited || shown == protocol.EndReasonRestartFailed || shown == protocol.EndReasonVersionUnsupported
	if exited {
		code := p.exitCode
		ended.Code = &code
		ended.StderrTail = p.stderr.String()
		s.appendRingLocked(vrExit(code, shown, ended.StderrTail))
	}
	if shown == protocol.EndReasonVersionUnsupported {
		ended.ClaudeVersion = *p.badVersion
		ended.MinClaudeVersion = MinClaudeVersion
	}
	s.ended = ended
	s.proc = nil
	close(p.stopCh)
	s.broadcastStateLocked()
	if exited {
		code := p.exitCode
		s.broadcastLocked(Event{Exit: &code})
	}

	done := make(chan struct{})
	s.exitCB = done
	ev := ExitEvent{Session: s, ClaudeSessionID: s.spec.ClaudeSessionID, Reason: reason,
		Release: reason != reasonRestart, Ended: ended}
	onExit := s.spec.Hooks.OnExit
	return func(wait bool) {
		go func() {
			defer close(done)
			if onExit != nil {
				onExit(ev)
			}
		}()
		if wait {
			<-done
		}
	}
}

// RestartLocked stops the process if it runs and starts a new one on the same
// claude session id (reload, R2.2/R15.3): --resume when a transcript exists,
// --session-id otherwise. The claim is kept throughout; a claim lost while the
// session was ended is reported by Hooks.Claim.
func (o OpHandle) RestartLocked() error {
	s := o.s
	if err := o.stop(nil, reasonRestart); err != nil {
		return err
	}
	s.waitExitCallback()
	if s.spec.Hooks.Claim != nil {
		if err := s.spec.Hooks.Claim(s.spec.ClaudeSessionID); err != nil {
			// Only possible once the session had ended and released it:
			// another session now runs this conversation.
			s.mu.Lock()
			s.ended = &protocol.ChatEnded{Reason: protocol.EndReasonRestartFailed, Message: err.Error()}
			s.broadcastStateLocked()
			s.mu.Unlock()
			return err
		}
	}
	if err := s.spawn(true); err != nil {
		s.mu.Lock()
		if s.proc == nil && (s.ended == nil || s.ended.Reason != protocol.EndReasonRestartFailed) {
			// Failed before a process existed: nothing settled it yet.
			s.ended = &protocol.ChatEnded{Reason: protocol.EndReasonRestartFailed, Message: err.Error()}
			s.broadcastStateLocked()
			done := make(chan struct{})
			s.exitCB = done
			ev := ExitEvent{Session: s, ClaudeSessionID: s.spec.ClaudeSessionID,
				Reason: protocol.EndReasonRestartFailed, Release: true, Ended: s.ended}
			onExit := s.spec.Hooks.OnExit
			go func() {
				defer close(done)
				if onExit != nil {
					onExit(ev)
				}
			}()
		}
		s.mu.Unlock()
		return err
	}
	return nil
}

// --- subscribers ---

// Event is one item a subscriber receives, in order.
type Event struct {
	Frame  []byte    // a serialized chat or chat_state frame
	Resync *SyncPlan // the epoch changed: replay a reset sync
	Exit   *int      // the process really exited: send an exit frame
}

// Subscription receives a session's events. C is closed when the
// subscriber fell SubBuffer events behind (slow consumer) or on Cancel.
type Subscription struct {
	C <-chan Event
	c chan Event
	s *Session
}

// Cancel unsubscribes; safe to call more than once.
func (sub *Subscription) Cancel() {
	s := sub.s
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.subs[sub]; ok {
		delete(s.subs, sub)
		close(sub.c)
	}
}

func (s *Session) sendLocked(sub *Subscription, ev Event) {
	select {
	case sub.c <- ev:
	default:
		// Slow consumer: drop the subscriber rather than a frame. Its relay
		// closes the connection and the client resyncs with since.
		log.Printf("chat [%s]: subscriber %d frames behind, disconnecting it", s.spec.ID, SubBuffer)
		delete(s.subs, sub)
		close(sub.c)
	}
}

func (s *Session) broadcastLocked(ev Event) {
	for sub := range s.subs {
		s.sendLocked(sub, ev)
	}
}

// SyncPlan is the sync sequence a subscriber is sent first (design 4.4):
// chat_sync, the transcript history (reset only), the buffered backlog, then
// chat_state as the end mark.
type SyncPlan struct {
	Sync    protocol.ChatSyncFrame
	Backlog [][]byte
	State   []byte

	// History source of a reset sync: the transcript's first cutoff bytes
	// (cutoff < 0 = all of it, 0 = none).
	projectsDir, claudeSessionID string
	cutoff                       int64
}

func historyFrame(line []byte) []byte {
	b := make([]byte, 0, len(line)+40)
	b = append(b, `{"type":"chat","seq":0,"h":true,"msg":`...)
	b = append(b, line...)
	return append(b, '}')
}

// WriteTo writes the sync sequence through write, in order. The transcript
// is read here, outside every lock, HistoryBatch lines at a time; each batch
// is written before the next is read.
func (p *SyncPlan) WriteTo(write func([]byte) error) error {
	path := ""
	if p.Sync.Reset && p.cutoff != 0 {
		path, _ = FindTranscript(p.projectsDir, p.claudeSessionID)
	}
	sync := p.Sync
	if path != "" {
		n, err := CountHistory(path, p.cutoff)
		if err != nil {
			log.Printf("chat: read history %s: %v", path, err)
			path = ""
		}
		sync.HistoryCount = n
	}
	if err := write(mustJSON(sync)); err != nil {
		return err
	}
	if path != "" {
		if _, err := StreamHistory(path, p.cutoff, HistoryBatch, func(lines [][]byte) error {
			for _, l := range lines {
				if err := write(historyFrame(l)); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return err
		}
	}
	for _, f := range p.Backlog {
		if err := write(f); err != nil {
			return err
		}
	}
	return write(p.State)
}

// Subscribe returns the sync plan for a client that last saw (epoch, since)
// and registers it for live events, atomically: nothing is missed or sent
// twice between the backlog and the live events. since nil or a stale epoch
// gives a reset sync.
func (s *Session) Subscribe(epoch string, since *uint64) (*SyncPlan, *Subscription) {
	s.mu.Lock()
	defer s.mu.Unlock()
	plan := s.planLocked(epoch, since)
	c := make(chan Event, SubBuffer)
	sub := &Subscription{C: c, c: c, s: s}
	s.subs[sub] = struct{}{}
	return plan, sub
}

func (s *Session) planLocked(epoch string, since *uint64) *SyncPlan {
	incremental := s.epoch != "" && epoch == s.epoch && since != nil &&
		*since >= s.evictedUpTo && *since <= s.seq
	from := uint64(0)
	if incremental {
		from = *since
	}
	var backlog []entry
	for _, list := range [][]entry{s.ring, s.tail} {
		for _, e := range list {
			if e.seq > from {
				backlog = append(backlog, e)
			}
		}
	}
	sort.Slice(backlog, func(i, j int) bool { return backlog[i].seq < backlog[j].seq })
	plan := &SyncPlan{
		Sync: protocol.ChatSyncFrame{
			Type:    protocol.TypeChatSync,
			Epoch:   s.epoch,
			Reset:   !incremental,
			Backlog: len(backlog),
		},
		State: mustJSON(s.stateLocked()),
	}
	if !incremental {
		plan.Sync.Omitted = s.omitted
		plan.projectsDir = s.spec.ProjectsDir
		plan.claudeSessionID = s.spec.ClaudeSessionID
		plan.cutoff = s.cutoff
	}
	for _, e := range backlog {
		plan.Backlog = append(plan.Backlog, e.frame)
	}
	return plan
}

// tailWriter keeps the last max bytes written to it (stderr).
type tailWriter struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (t *tailWriter) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = append([]byte(nil), t.buf[len(t.buf)-t.max:]...)
	}
	return len(p), nil
}

func (t *tailWriter) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}
