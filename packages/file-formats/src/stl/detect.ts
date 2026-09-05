import { DEFAULT_IMPORT_BUDGET, type ImportBudget } from '../budget';

/**
 * STL encoding detection.
 *
 * STL has no magic number. A binary STL begins with 80 bytes of arbitrary
 * header that exporters fill with whatever they like — including, notoriously,
 * text beginning with "solid". So the widespread "does it start with solid?"
 * test is wrong, and so is trusting the extension or the MIME type. Detection
 * here is structural.
 *
 * THE DECISION PROCEDURE, in order:
 *
 *   1. Empty or shorter than a binary header + count -> cannot be binary.
 *   2. EXACT BINARY MATCH. Read the uint32 facet count at offset 80 and compute
 *      84 + count * 50. If that equals the file length exactly, it is binary.
 *      This is the strongest possible signal and is checked first.
 *   3. ASCII GRAMMAR. Tokenise the head of the file and require a real
 *      `solid ... facet normal ... outer loop ... vertex x3 ... endloop
 *      endfacet` opening. Arbitrary text containing the word "vertex" does not
 *      pass.
 *   4. BINARY WITH TRAILING DATA. If the declared body fits inside the file and
 *      the surplus is within a small allowance, treat it as binary and report
 *      the surplus. Bounded deliberately: without a bound, any large file whose
 *      bytes 80-83 happen to be small would be "detected" as a binary STL with
 *      a handful of triangles.
 *   5. Otherwise indeterminate, with a reason. We never guess and continue.
 *
 * WHY STEP 2 CANNOT MISFIRE ON AN ASCII FILE: for the exact match to hold, the
 * four bytes at offset 80 must encode a facet count consistent with the file
 * size. In an ASCII STL those bytes are printable characters, so the smallest
 * value they can encode is around 0x20202020 (538 million), which would require
 * a file of roughly 27 GB. An ASCII STL therefore cannot accidentally satisfy
 * the binary equation.
 */

/*
 * THE CONTAINER'S SHAPE LIVES IN ONE PLACE, and it is not here.
 *
 * `export/stl-layout.ts` is a leaf module with no imports, so the conversion
 * policy can do STL size arithmetic on the main thread without dragging this
 * file's ASCII keyword tables into the application bundle. Re-exported so every
 * existing caller of `detect` is unaffected.
 */
import {
  BINARY_HEADER_BYTES,
  BINARY_PREFIX_BYTES,
  binaryStlByteLength,
} from '../export/stl-layout';

export {
  BINARY_COUNT_BYTES,
  BINARY_FACET_BYTES,
  BINARY_HEADER_BYTES,
  BINARY_PREFIX_BYTES,
  binaryStlByteLength,
} from '../export/stl-layout';

/**
 * Surplus tolerated after a binary STL body.
 *
 * Some exporters pad or append a short trailer. Anything larger is treated as
 * evidence that the file is not a binary STL at all.
 */
export const MAX_TRAILING_BYTES = 1024;

export const StlEncoding = {
  Binary: 'binary',
  Ascii: 'ascii',
} as const;

export type StlEncoding = (typeof StlEncoding)[keyof typeof StlEncoding];

export const StlDetectionFailure = {
  /** Zero bytes. */
  Empty: 'EMPTY',
  /** Fewer bytes than a binary header plus facet count. */
  TooShort: 'TOO_SHORT',
  /**
   * Reads as a plausible binary STL, but the declared facet body extends past
   * the end of the file.
   */
  BinaryTruncated: 'BINARY_TRUNCATED',
  /** Neither encoding could be established. */
  Unrecognized: 'UNRECOGNIZED',
} as const;

export type StlDetectionFailure = (typeof StlDetectionFailure)[keyof typeof StlDetectionFailure];

export interface StlBinaryDetected {
  readonly encoding: typeof StlEncoding.Binary;
  readonly triangleCount: number;
  /** Bytes present beyond the declared body. Zero for an exact match. */
  readonly trailingBytes: number;
}

export interface StlAsciiDetected {
  readonly encoding: typeof StlEncoding.Ascii;
}

export interface StlDetectionIndeterminate {
  readonly encoding: undefined;
  readonly failure: StlDetectionFailure;
  /** Populated for BINARY_TRUNCATED so the error can be specific. */
  readonly declaredTriangles?: number;
  readonly requiredBytes?: number;
  readonly actualBytes: number;
}

export type StlDetection = StlBinaryDetected | StlAsciiDetected | StlDetectionIndeterminate;

/**
 * Bytes required by a binary STL declaring `triangleCount` facets.
 *
 * Exact in double arithmetic for every uint32 input: the maximum result is
 * 84 + (2^32 - 1) * 50, about 2.1e11, far below the 2^53 integer-exact limit.
 * No modular wraparound is possible, which is what makes the truncation check
 * below sound against a hostile facet count.
 */
export function detectStlEncoding(
  bytes: Uint8Array,
  budget: ImportBudget = DEFAULT_IMPORT_BUDGET,
): StlDetection {
  const actualBytes = bytes.byteLength;

  if (actualBytes === 0) {
    return { encoding: undefined, failure: StlDetectionFailure.Empty, actualBytes };
  }

  if (actualBytes < BINARY_PREFIX_BYTES) {
    // Too short to be binary. It could still be a (tiny, necessarily invalid)
    // ASCII file, so the grammar is tried before giving up.
    return looksLikeAsciiStl(bytes, budget)
      ? { encoding: StlEncoding.Ascii }
      : { encoding: undefined, failure: StlDetectionFailure.TooShort, actualBytes };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredTriangles = view.getUint32(BINARY_HEADER_BYTES, true);
  const requiredBytes = binaryStlByteLength(declaredTriangles);

  // Step 2 — exact match wins outright.
  if (requiredBytes === actualBytes) {
    return {
      encoding: StlEncoding.Binary,
      triangleCount: declaredTriangles,
      trailingBytes: 0,
    };
  }

  // Step 3 — a real ASCII STL opening.
  if (looksLikeAsciiStl(bytes, budget)) {
    return { encoding: StlEncoding.Ascii };
  }

  // Step 4 — binary with a small trailer.
  if (actualBytes > requiredBytes) {
    const trailingBytes = actualBytes - requiredBytes;
    if (declaredTriangles >= 1 && trailingBytes <= MAX_TRAILING_BYTES) {
      return { encoding: StlEncoding.Binary, triangleCount: declaredTriangles, trailingBytes };
    }
    return { encoding: undefined, failure: StlDetectionFailure.Unrecognized, actualBytes };
  }

  // Step 5 — the declared body runs past the end of the file. Report it as a
  // truncated binary STL only when the declared count is one a real file could
  // plausibly hold; a wildly implausible count (0xFFFFFFFF, or four bytes of
  // ASCII text reinterpreted as a number) means this is simply not an STL, and
  // saying "this file declares 4.29 billion triangles" would mislead.
  if (declaredTriangles >= 1 && declaredTriangles <= budget.maxTriangles) {
    return {
      encoding: undefined,
      failure: StlDetectionFailure.BinaryTruncated,
      declaredTriangles,
      requiredBytes,
      actualBytes,
    };
  }

  return { encoding: undefined, failure: StlDetectionFailure.Unrecognized, actualBytes };
}

/* ------------------------------------------------------------------ ASCII -- */

const SOLID = asciiBytes('solid');
const FACET = asciiBytes('facet');
const NORMAL = asciiBytes('normal');
const OUTER = asciiBytes('outer');
const LOOP = asciiBytes('loop');
const VERTEX = asciiBytes('vertex');
const ENDLOOP = asciiBytes('endloop');
const ENDFACET = asciiBytes('endfacet');
const ENDSOLID = asciiBytes('endsolid');

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    // Every keyword here is pure ASCII, so charCodeAt is the byte value.
    out[index] = text.charCodeAt(index);
  }
  return out;
}

export const StlKeyword = {
  Solid: SOLID,
  Facet: FACET,
  Normal: NORMAL,
  Outer: OUTER,
  Loop: LOOP,
  Vertex: VERTEX,
  EndLoop: ENDLOOP,
  EndFacet: ENDFACET,
  EndSolid: ENDSOLID,
} as const;

/**
 * Establishes that the file opens with genuine ASCII STL structure.
 *
 * Requires this exact token sequence: `solid`, the rest of that line as a name,
 * then `facet`, `normal`, three numbers, `outer`, `loop`, `vertex`. A `solid`
 * followed immediately by `endsolid` also qualifies — that is a valid, empty
 * ASCII STL, which the parser later rejects for containing no triangles.
 *
 * WHERE THE LINE IS DRAWN, and why it is here rather than further along: this
 * probe answers "is this an ASCII STL?", not "is this a VALID ASCII STL?". Those
 * are different questions with different consequences. Demanding a complete,
 * well-formed first facet would mean a file that is unmistakably an ASCII STL —
 * but has four vertices in a facet, or a missing `endloop`, or a dropped
 * coordinate — would fail detection and be reported as an unrecognised file
 * type. That is both wrong and unhelpful: the user would be told CAD Fixer does
 * not understand the format, when in fact it understands it perfectly and the
 * file is broken. Detection establishes the encoding; the parser then reports
 * precisely what is wrong, with a line number.
 *
 * Eight structural tokens in a fixed order is still far more than arbitrary
 * prose or binary data can satisfy by accident, which is the property that
 * matters for keeping non-STL files out of the ASCII parser.
 */
function looksLikeAsciiStl(bytes: Uint8Array, budget: ImportBudget): boolean {
  const scanner = new ByteScanner(bytes, budget.maxTokenBytes);

  if (!scanner.matchKeyword(SOLID)) return false;
  scanner.skipRestOfLine();

  if (scanner.matchKeyword(ENDSOLID)) return true;
  if (!scanner.matchKeyword(FACET)) return false;
  if (!scanner.matchKeyword(NORMAL)) return false;
  for (let axis = 0; axis < 3; axis += 1) {
    if (scanner.readNumber() === undefined) return false;
  }
  if (!scanner.matchKeyword(OUTER)) return false;
  if (!scanner.matchKeyword(LOOP)) return false;
  return scanner.matchKeyword(VERTEX);
}

/* ---------------------------------------------------------------- scanner -- */

const CHAR_TAB = 9;
const CHAR_NEWLINE = 10;
const CHAR_VERTICAL_TAB = 11;
const CHAR_FORM_FEED = 12;
const CHAR_CARRIAGE_RETURN = 13;
const CHAR_SPACE = 32;

export function isStlWhitespace(byte: number): boolean {
  return (
    byte === CHAR_SPACE ||
    byte === CHAR_NEWLINE ||
    byte === CHAR_CARRIAGE_RETURN ||
    byte === CHAR_TAB ||
    byte === CHAR_VERTICAL_TAB ||
    byte === CHAR_FORM_FEED
  );
}

/**
 * A forward-only tokeniser over raw bytes.
 *
 * Operating on bytes rather than a decoded string is the point: decoding a
 * 200 MB ASCII STL to a JavaScript string would allocate a full-size copy (and,
 * being UTF-16, potentially twice the size) before parsing even began.
 *
 * There is no regular expression anywhere in this path, so no input can trigger
 * catastrophic backtracking. Every loop advances the cursor monotonically, so
 * parsing is linear in file length by construction.
 */
export class ByteScanner {
  private readonly bytes: Uint8Array;
  private readonly maxTokenBytes: number;
  private cursor = 0;
  private lineNumber = 1;

  public constructor(bytes: Uint8Array, maxTokenBytes: number) {
    this.bytes = bytes;
    this.maxTokenBytes = maxTokenBytes;
  }

  public get offset(): number {
    return this.cursor;
  }

  public get line(): number {
    return this.lineNumber;
  }

  /**
   * Whether only whitespace remains.
   *
   * A METHOD, not a getter, because it mutates: it skips whitespace to answer.
   * As a getter it read like a pure property, which misled both readers and
   * TypeScript's control-flow analysis — after `while (!scanner.atEnd)` the
   * compiler considered the value permanently false inside the loop, since it
   * cannot know that the intervening calls advance the cursor.
   */
  public isAtEnd(): boolean {
    this.skipWhitespace();
    return this.cursor >= this.bytes.length;
  }

  public skipWhitespace(): void {
    while (this.cursor < this.bytes.length) {
      const byte = this.bytes[this.cursor];
      if (byte === undefined || !isStlWhitespace(byte)) return;
      if (byte === CHAR_NEWLINE) this.lineNumber += 1;
      this.cursor += 1;
    }
  }

  public skipRestOfLine(): void {
    while (this.cursor < this.bytes.length) {
      const byte = this.bytes[this.cursor];
      if (byte === CHAR_NEWLINE) return;
      this.cursor += 1;
    }
  }

  /**
   * Reads the next token's byte range without allocating.
   *
   * Returns `undefined` at end of input, or when the token exceeds the budget's
   * token length — which is how a file consisting of one enormous unbroken run
   * of characters is refused rather than driving an unbounded read.
   */
  public peekTokenRange(): { start: number; end: number } | undefined {
    this.skipWhitespace();
    if (this.cursor >= this.bytes.length) return undefined;
    const start = this.cursor;
    let end = start;
    while (end < this.bytes.length) {
      const byte = this.bytes[end];
      if (byte === undefined || isStlWhitespace(byte)) break;
      end += 1;
      if (end - start > this.maxTokenBytes) return undefined;
    }
    return { start, end };
  }

  public consumeTo(end: number): void {
    this.cursor = end;
  }

  /** Consumes the next token if it equals `keyword`, case-insensitively. */
  public matchKeyword(keyword: Uint8Array): boolean {
    const range = this.peekTokenRange();
    if (range === undefined) return false;
    if (range.end - range.start !== keyword.length) return false;
    for (let index = 0; index < keyword.length; index += 1) {
      const actual = this.bytes[range.start + index];
      if (actual === undefined) return false;
      if (toLowerAscii(actual) !== keyword[index]) return false;
    }
    this.cursor = range.end;
    return true;
  }

  /**
   * Reads a numeric token, consuming it only when it really is one.
   *
   * `undefined` means "no numeric token here" — end of input, an oversized
   * token, or a word that is not a number. A returned value may still be
   * non-finite: `NaN` and the infinities are recognised and reported rather
   * than rejected here, so the parser can raise a precise "non-finite
   * coordinate" error instead of a vague "expected a number".
   *
   * The token's bytes become a short string so the engine's own
   * correctly-rounded decimal conversion can be used. A bespoke float parser
   * would risk silently altering users' coordinates, which is exactly what the
   * data-integrity rule forbids. Only the token is copied, never the file.
   */
  public readNumber(): StlNumberToken | undefined {
    const range = this.peekTokenRange();
    if (range === undefined) return undefined;
    let text = '';
    for (let index = range.start; index < range.end; index += 1) {
      const byte = this.bytes[index];
      if (byte === undefined || byte > 127) return undefined;
      text += String.fromCharCode(byte);
    }
    const parsed = parseNumericToken(text);
    if (parsed === undefined) return undefined;
    this.cursor = range.end;
    return parsed;
  }
}

export interface StlNumberToken {
  readonly value: number;
  readonly finite: boolean;
  /** The literal as it appeared, for error messages. Bounded by maxTokenBytes. */
  readonly text: string;
}

/**
 * Interprets a token as a number.
 *
 * No regular expression is used, so there is no backtracking behaviour to
 * exploit.
 *
 * The decimal-shape check is not decoration. `Number()` accepts far more than
 * STL does — `0x41` becomes 65, `0b11` becomes 3, `1_0` is rejected but `Infinity`
 * is not — so handing tokens straight to it would silently reinterpret a file
 * that should have been refused. Only a decimal literal is accepted here; the
 * non-finite spellings real exporters emit are recognised separately and
 * returned as non-finite so the parser can say precisely what is wrong.
 *
 * An overflowing decimal such as `1e999` is also returned as non-finite rather
 * than as "not a number", so the user is told the coordinate is unrepresentable
 * instead of being told the file is unparseable.
 */
function parseNumericToken(text: string): StlNumberToken | undefined {
  if (text.length === 0) return undefined;

  const lowered = text.toLowerCase();
  const negative = lowered.startsWith('-');
  const magnitude = negative || lowered.startsWith('+') ? lowered.slice(1) : lowered;

  if (magnitude === 'nan') return { value: Number.NaN, finite: false, text };
  if (magnitude === 'inf' || magnitude === 'infinity') {
    return {
      value: negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      finite: false,
      text,
    };
  }

  if (!isDecimalLiteral(text)) return undefined;

  const value = Number(text);
  return { value, finite: Number.isFinite(value), text };
}

/**
 * Recognises `[+-]?(digits[.digits?] | .digits)([eE][+-]?digits)?`.
 *
 * A hand-written scanner rather than a regular expression, so the cost is
 * linear in token length with no backtracking, on a token already bounded by
 * `maxTokenBytes`.
 */
function isDecimalLiteral(text: string): boolean {
  let index = 0;
  const length = text.length;

  const digits = (): number => {
    const start = index;
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code < 48 || code > 57) break;
      index += 1;
    }
    return index - start;
  };

  if (index < length && (text[index] === '+' || text[index] === '-')) index += 1;

  const whole = digits();
  let fraction = 0;
  if (index < length && text[index] === '.') {
    index += 1;
    fraction = digits();
  }
  if (whole === 0 && fraction === 0) return false;

  if (index < length && (text[index] === 'e' || text[index] === 'E')) {
    index += 1;
    if (index < length && (text[index] === '+' || text[index] === '-')) index += 1;
    if (digits() === 0) return false;
  }

  return index === length;
}

function toLowerAscii(byte: number): number {
  // 'A'..'Z' -> 'a'..'z'
  return byte >= 65 && byte <= 90 ? byte + 32 : byte;
}
