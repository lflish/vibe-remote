// base64 ↔ bytes / text 工具（UTF-8 安全）。
// PTY 字节与 headless NDJSON 都以 base64 传输；必须走 bytes（不是 JS string）
// 以免多字节 UTF-8 序列（box-drawing / emoji / CJK）被拆坏。
// 从 desktop/src/renderer/index.ts 与 mobile/src/main.ts 的重复实现上提到 core。

/** base64 → 原始字节。 */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 原始字节 → base64。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** base64 → UTF-8 文本（用于 headless NDJSON 行）。 */
export function base64ToText(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}

/** UTF-8 文本 → base64（用于把 prompt 编码为 data 帧 payload）。 */
export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}
