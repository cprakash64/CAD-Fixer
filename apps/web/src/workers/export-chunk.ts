/** Transfer exactly the view, never unrelated bytes or the parent of later chunks. */
export function transferableExportChunk(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
}
