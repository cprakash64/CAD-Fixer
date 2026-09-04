/**
 * PLATFORM GLOBALS, DECLARED NARROWLY FOR TESTS AND FIXTURES.
 *
 * `@cadfixer/file-formats` compiles with `lib: ES2023` and no DOM or Node
 * types, deliberately: a codec that could reach for `TextDecoder` or
 * `DecompressionStream` directly would stop being testable under plain Node and
 * would drift towards a browser dependency. Production injects them through
 * `FormatReadContext`.
 *
 * These declarations exist so TEST code can construct the same primitives the
 * worker injects. Widening the package's `lib` would have let production reach
 * them too, which is the coupling the injection exists to prevent.
 */

interface TextDecoderLike {
  decode(input?: Uint8Array): string;
}

interface TextEncoderLike {
  encode(input: string): Uint8Array;
}

interface StreamReaderLike {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  cancel(): Promise<void>;
}

interface StreamWriterLike {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

interface TransformStreamLike {
  readonly readable: { getReader(): StreamReaderLike };
  readonly writable: { getWriter(): StreamWriterLike };
}

declare const TextDecoder: new (label?: string, options?: { fatal?: boolean }) => TextDecoderLike;

declare const TextEncoder: new () => TextEncoderLike;

declare const DecompressionStream: new (format: string) => TransformStreamLike;

declare const CompressionStream: new (format: string) => TransformStreamLike;
