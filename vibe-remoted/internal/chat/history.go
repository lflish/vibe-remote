package chat

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
)

// HistoryBatch is how many history frames are read and written per batch.
const HistoryBatch = 200

// historyLine reports whether a transcript line belongs in the chat history:
// main-thread user and assistant messages only (no sidechains, no meta
// messages, no summaries, snapshots or queue operations).
func historyLine(line []byte) bool {
	var m struct {
		Type        string `json:"type"`
		IsSidechain bool   `json:"isSidechain"`
		IsMeta      bool   `json:"isMeta"`
	}
	if json.Unmarshal(line, &m) != nil {
		return false
	}
	return (m.Type == "user" || m.Type == "assistant") && !m.IsSidechain && !m.IsMeta
}

// openHistory opens a transcript limited to its first cutoff bytes (cutoff
// < 0 = the whole file). A missing file is an empty history.
func openHistory(path string, cutoff int64) (io.ReadCloser, error) {
	if cutoff == 0 || path == "" {
		return nil, nil
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if cutoff < 0 {
		return f, nil
	}
	return struct {
		io.Reader
		io.Closer
	}{io.LimitReader(f, cutoff), f}, nil
}

// StreamHistory sends every history line of the transcript's first cutoff
// bytes, oldest first, in batches of at most batch lines; each batch is
// handed to emit before more of the file is read, so a long transcript is
// never held in memory (design 5.3, d13). Nothing is left out; only a single
// line over MaxLine is skipped.
func StreamHistory(path string, cutoff int64, batch int, emit func(lines [][]byte) error) (int, error) {
	r, err := openHistory(path, cutoff)
	if err != nil || r == nil {
		return 0, err
	}
	defer r.Close()
	return streamHistory(r, batch, emit)
}

func streamHistory(r io.Reader, batch int, emit func(lines [][]byte) error) (int, error) {
	if batch <= 0 {
		batch = HistoryBatch
	}
	br := bufio.NewReaderSize(r, 64<<10)
	var buf [][]byte
	count := 0
	for {
		line, tooLong, err := readLine(br)
		if line = bytes.TrimSpace(line); !tooLong && len(line) > 0 && historyLine(line) {
			buf = append(buf, line)
			count++
			if len(buf) == batch {
				if e := emit(buf); e != nil {
					return count, e
				}
				buf = nil
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return count, err
		}
	}
	if len(buf) > 0 {
		if err := emit(buf); err != nil {
			return count, err
		}
	}
	return count, nil
}

// CountHistory counts what StreamHistory would send (chat_sync.historyCount).
func CountHistory(path string, cutoff int64) (int, error) {
	return StreamHistory(path, cutoff, HistoryBatch, func([][]byte) error { return nil })
}
