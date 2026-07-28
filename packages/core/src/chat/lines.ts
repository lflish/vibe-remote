// NDJSON 跨帧行分割。从 mobile/src/lines.ts 上提到 core。
//
// NDJSON 到达时会被 WebSocket 分帧切碎：一帧可能含多行，一行也可能跨多帧。
// makeLineSplitter 缓冲不完整输入，每遇到一个完整的 '\n' 结尾行就回调一次
// （分隔符被剥除）。结尾不带 '\n' 的残段留在缓冲区直到剩余部分到达。
// 这是「服务端补回分隔符、客户端按其重切」NDJSON 契约的客户端一半。
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
