import { ImportRefusal, importTooLarge } from '../import-errors';
import { XmlSecurityStream } from './xml-security';

export { XmlSecurityStream };
import {
  applyTag,
  malformedXml,
  refuseUnsafeXml,
  type XmlHandlers,
  type XmlLimits,
  type XmlScanState,
} from './xml-scan';

/**
 * STREAMING XML INGESTION — Stage 6E-A1 PROTOTYPE. NOT ON ANY SHIPPED PATH.
 *
 * `scanXml` needs the whole model part as one JavaScript string, which needs the
 * whole inflated entry as one byte array first. For a 297 MiB entry that is the
 * ~2.1 GiB renderer footprint Stage 6D-B3 measured. This module does the same
 * work on the document in PIECES, retaining only what one construct needs:
 *
 *   - `XmlSecurityStream` answers exactly what `describeUnsafeXml` answers for
 *     the concatenation of everything pushed into it;
 *   - `XmlStreamScanner` emits exactly the `onOpen` / `onClose` / `onProgress`
 *     events `scanXml` emits, in the same order, with the same refusals;
 *   - `scanXmlByteStream` drives both over an inflating byte source.
 *
 * "EXACTLY" IS THE CONTRACT, and it is proven by the tests in
 * `xml-stream.test.ts`: every split position of every marker, one-character
 * chunks, and seeded random partitions, compared against the whole-string
 * functions. A chunk boundary is invisible to both classes by construction —
 * nothing here assumes a construct is complete inside one chunk.
 */

/** Limits that exist only because the input arrives in pieces. */
export interface StreamXmlLimits {
  /**
   * The longest tag — text between `<` and the first `>` — held while waiting
   * for its `>`. `scanXml` has no such bound because the whole string is
   * already resident. 1 MiB is sixteen maximum-length attribute values; every
   * tag in the qualification corpus is under 64 KiB.
   */
  readonly maxTagLength: number;
}

export const DEFAULT_STREAM_XML_LIMITS: StreamXmlLimits = Object.freeze({
  maxTagLength: 1_048_576,
});

/* ================================================================ scanner */

type ScanMode = 'text' | 'open' | 'tag' | 'pi' | 'comment' | 'cdata';

const COMMENT_OPEN = '!--';
const CDATA_OPEN = '![CDATA[';
const TERMINATOR: Readonly<Record<'pi' | 'comment' | 'cdata', string>> = {
  pi: '?>',
  comment: '-->',
  cdata: ']]>',
};
const UNTERMINATED: Readonly<Record<ScanMode, string | undefined>> = {
  text: undefined,
  open: 'unterminated tag',
  tag: 'unterminated tag',
  pi: 'unterminated processing instruction',
  comment: 'unterminated comment',
  cdata: 'unterminated CDATA section',
};

/** What a streaming scan held at its largest, for tests and qualification. */
export interface StreamScanStats {
  /** Longest tag buffered while waiting for its `>`, in characters. */
  maxTagChars: number;
  /** Longest terminator carry held inside a comment, PI or CDATA section. */
  maxCarryChars: number;
  /** Largest single piece pushed, in characters. */
  maxPieceChars: number;
  pieces: number;
  /**
   * Decoded characters consumed so far — the scanner's LOCATION. Read after a
   * refusal it says how far into the part the failure was, for debugging and
   * tests; no user-facing message carries it, and no XML excerpt is kept.
   */
  charsConsumed: number;
}

export function createStreamScanStats(): StreamScanStats {
  return { maxTagChars: 0, maxCarryChars: 0, maxPieceChars: 0, pieces: 0, charsConsumed: 0 };
}

/**
 * `scanXml`'s element walk, resumable across arbitrary pieces.
 *
 * THE SAME DISPATCH, IN THE SAME ORDER: after a `<`, a `?` makes a processing
 * instruction ending at the first `?>`; `!--` a comment ending at the first
 * `-->`; `![CDATA[` a CDATA section ending at the first `]]>`; anything else a
 * tag ending at the first `>`, handed to the SAME `applyTag` `scanXml` uses.
 * The terminator searches start AT the `<`, as the whole-string `indexOf` calls
 * do, so `<?>` and `<!-->` end where they end there.
 *
 * WHAT IS RETAINED BETWEEN PIECES, AND ITS BOUND:
 *   - inside a tag, the tag so far — at most `maxTagLength` characters, then a
 *     typed refusal rather than growth;
 *   - just after `<`, at most seven characters while deciding between a tag, a
 *     comment and a CDATA section;
 *   - inside a comment, PI or CDATA section, at most the terminator's length
 *     minus one — their CONTENT is never held, however long it is;
 *   - between elements, nothing: character data is skipped, as `scanXml`
 *     skips it.
 */
export class XmlStreamScanner {
  public readonly state: XmlScanState = { depth: 0, elements: 0 };
  private mode: ScanMode = 'text';
  private buffer = '';
  private carry = '';

  private readonly handlers: XmlHandlers;
  private readonly limits: XmlLimits;
  private readonly streamLimits: StreamXmlLimits;
  private readonly stats: StreamScanStats | undefined;

  public constructor(
    handlers: XmlHandlers,
    limits: XmlLimits,
    streamLimits: StreamXmlLimits = DEFAULT_STREAM_XML_LIMITS,
    stats?: StreamScanStats,
  ) {
    this.handlers = handlers;
    this.limits = limits;
    this.streamLimits = streamLimits;
    this.stats = stats;
  }

  public push(text: string): void {
    if (this.stats !== undefined) {
      this.stats.pieces += 1;
      this.stats.maxPieceChars = Math.max(this.stats.maxPieceChars, text.length);
      this.stats.charsConsumed += text.length;
    }
    let at = 0;
    const length = text.length;
    while (at < length) {
      switch (this.mode) {
        case 'text': {
          const lt = text.indexOf('<', at);
          if (lt === -1) return;
          this.mode = 'open';
          this.buffer = '';
          at = lt + 1;
          break;
        }
        case 'open':
          at = this.classify(text, at);
          break;
        case 'tag': {
          const gt = text.indexOf('>', at);
          if (gt === -1) {
            this.appendTag(text.slice(at));
            return;
          }
          this.appendTag(text.slice(at, gt));
          this.closeTag();
          at = gt + 1;
          break;
        }
        case 'pi':
        case 'comment':
        case 'cdata':
          at = this.skipTo(TERMINATOR[this.mode], text, at);
          break;
      }
    }
  }

  public finish(): { readonly elements: number } {
    const unterminated = UNTERMINATED[this.mode];
    if (unterminated !== undefined) throw malformedXml(unterminated);
    if (this.state.depth !== 0) throw malformedXml('unclosed elements');
    return { elements: this.state.elements };
  }

  /** One character at a time until the construct after `<` is known. */
  private classify(text: string, from: number): number {
    let at = from;
    while (at < text.length) {
      this.buffer += text.charAt(at);
      at += 1;
      if (this.buffer.charCodeAt(0) === 63 /* ? */) {
        this.enterSkip('pi', this.buffer);
        return at;
      }
      if (this.buffer === COMMENT_OPEN) {
        this.enterSkip('comment', this.buffer);
        return at;
      }
      if (this.buffer === CDATA_OPEN) {
        this.enterSkip('cdata', this.buffer);
        return at;
      }
      if (COMMENT_OPEN.startsWith(this.buffer) || CDATA_OPEN.startsWith(this.buffer)) continue;
      // A tag. Neither candidate contains `>`, so if one arrived it is the
      // character just appended — the first `>`, which ends the tag.
      this.mode = 'tag';
      if (this.buffer.endsWith('>')) {
        this.buffer = this.buffer.slice(0, -1);
        this.closeTag();
      } else {
        this.noteTag();
      }
      return at;
    }
    return at;
  }

  private enterSkip(mode: 'pi' | 'comment' | 'cdata', opened: string): void {
    this.mode = mode;
    this.buffer = '';
    this.carry = opened;
  }

  /** Skips to just past `terminator`, holding only `terminator.length - 1` characters. */
  private skipTo(terminator: string, text: string, at: number): number {
    const joined = this.carry + text.slice(at);
    const found = joined.indexOf(terminator);
    if (found === -1) {
      this.carry = joined.slice(-(terminator.length - 1));
      if (this.stats !== undefined) {
        this.stats.maxCarryChars = Math.max(this.stats.maxCarryChars, this.carry.length);
      }
      return text.length;
    }
    const resume = at + (found + terminator.length - this.carry.length);
    this.carry = '';
    this.mode = 'text';
    return resume;
  }

  private appendTag(piece: string): void {
    this.buffer += piece;
    this.noteTag();
  }

  private noteTag(): void {
    if (this.stats !== undefined) {
      this.stats.maxTagChars = Math.max(this.stats.maxTagChars, this.buffer.length);
    }
    if (this.buffer.length > this.streamLimits.maxTagLength) {
      throw importTooLarge(
        ImportRefusal.XmlTagTooLong,
        `This 3MF file contains an XML tag longer than ${String(this.streamLimits.maxTagLength)} characters, which is CAD Fixer's limit for one tag.`,
        { limit: this.streamLimits.maxTagLength },
      );
    }
  }

  private closeTag(): void {
    const inner = this.buffer;
    this.buffer = '';
    this.mode = 'text';
    applyTag(inner, this.state, this.handlers, this.limits);
  }
}

/* ================================================================= driver */

/** The platform's streaming UTF-8 decoder, injected like `decodeText`. */
export interface TextStreamDecoder {
  decode(input?: Uint8Array, options?: { readonly stream?: boolean }): string;
}

export interface ByteStreamScanOptions {
  /** A fresh decoder per pass. Must behave as `TextDecoder('utf-8', { fatal: false })`. */
  readonly createDecoder: () => TextStreamDecoder;
  readonly streamLimits?: StreamXmlLimits;
  /** Polled after every piece, in both passes. */
  readonly poll?: () => void;
  /** Awaited every `yieldEveryPieces` pieces, so a cancel MESSAGE can be delivered. */
  readonly yieldToEventLoop?: () => Promise<void>;
  readonly yieldEveryPieces?: number;
  readonly stats?: StreamScanStats;
  /** Called with each piece's byte length, per pass. For progress and tests. */
  readonly onBytes?: (pass: 1 | 2, byteLength: number) => void;
}

/**
 * Scans a byte source as `scanXml` would scan it decoded, without ever holding
 * the decoded text or the bytes.
 *
 * TWO PASSES, AND THE SECOND IS WHY THE FIRST IS TRUSTWORTHY. `scanXml` refuses
 * an unsafe document before a single element is scanned for meaning, with a
 * fixed precedence between its three rules — and a DOCTYPE late in a prolog, or
 * an ENTITY anywhere, can only be known once the input has been read. So pass 1
 * reads the WHOLE part through `XmlSecurityStream`, and only a part it clears
 * is read again, by pass 2, for elements. The price is inflating and decoding
 * twice; the guarantee is the whole-string one, with the same precedence, not
 * an approximation of it.
 *
 * `openBytes(pass)` must yield the same bytes both times; the ZIP layer checks
 * that the second pass produces exactly the declared size, and charges the
 * package inflation budget only once.
 */
export async function scanXmlByteStream(
  openBytes: (pass: 1 | 2) => AsyncIterable<Uint8Array>,
  handlers: XmlHandlers,
  limits: XmlLimits,
  options: ByteStreamScanOptions,
): Promise<{ readonly elements: number }> {
  const every = Math.max(1, options.yieldEveryPieces ?? 16);

  const security = new XmlSecurityStream();
  const first = options.createDecoder();
  let pieces = 0;
  for await (const chunk of openBytes(1)) {
    options.onBytes?.(1, chunk.byteLength);
    security.push(first.decode(chunk, { stream: true }));
    options.poll?.();
    pieces += 1;
    if (options.yieldToEventLoop !== undefined && pieces % every === 0) {
      await options.yieldToEventLoop();
      options.poll?.();
    }
  }
  security.push(first.decode());
  const unsafe = security.finish();
  if (unsafe !== undefined) refuseUnsafeXml(unsafe);

  const scanner = new XmlStreamScanner(
    handlers,
    limits,
    options.streamLimits ?? DEFAULT_STREAM_XML_LIMITS,
    options.stats,
  );
  const second = options.createDecoder();
  for await (const chunk of openBytes(2)) {
    options.onBytes?.(2, chunk.byteLength);
    scanner.push(second.decode(chunk, { stream: true }));
    options.poll?.();
    pieces += 1;
    if (options.yieldToEventLoop !== undefined && pieces % every === 0) {
      await options.yieldToEventLoop();
      options.poll?.();
    }
  }
  scanner.push(second.decode());
  return scanner.finish();
}
