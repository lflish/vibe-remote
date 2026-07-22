// NDJSON arrives split across WebSocket frames: a single frame may hold several
// lines, or one line may span multiple frames. makeLineSplitter buffers partial
// input and emits one call to onLine per complete '\n'-terminated line (the
// terminator is stripped). A trailing segment without a '\n' stays in the buffer
// until the rest arrives. This is the client half of the "server re-adds the
// delimiter, client re-splits on it" NDJSON contract.
export function makeLineSplitter(onLine: (line: string) => void) {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  };
}
