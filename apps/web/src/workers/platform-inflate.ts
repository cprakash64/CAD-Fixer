import {
  createSlicedInflater,
  type DecompressorLike,
  type RawInflater,
} from '@cadfixer/file-formats';

/**
 * THE WORKERS' RAW-DEFLATE INFLATER — Stage 6E-A2. One definition, used by the
 * geometry worker's import path and the export worker's parse-back alike.
 *
 * The platform's `DecompressionStream` is the decompressor; `createSlicedInflater`
 * owns everything around it — bounded input slices written under the stream's
 * own backpressure, and release of both sides on every exit. Each of the two
 * workers used to carry its own copy that wrote the whole compressed entry in
 * ONE call, which Chromium answers by inflating the entire entry into its queue.
 *
 * The adapter exists only because the DOM declares `getReader` as an overload
 * set (default and BYOB readers), which a single-signature structural type
 * cannot accept directly. It always asks for the default reader.
 */
function openDecompressor(): DecompressorLike {
  const stream = new DecompressionStream('deflate-raw');
  return {
    readable: { getReader: () => stream.readable.getReader() },
    writable: stream.writable,
  };
}

export const inflateRaw: RawInflater = createSlicedInflater(openDecompressor);
