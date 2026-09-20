import { formatCount } from '@cadfixer/shared';
import type { TextStreamDecoder } from '../context';
import { ImportRefusal, importTooLarge } from '../import-errors';
import { XmlSecurityStream } from './xml-security';
import {
  applyTag,
  DEFAULT_XML_LIMITS,
  malformedXml,
  refuseUnsafeXml,
  type XmlHandlers,
  type XmlLimits,
  type XmlScanState,
} from './xml-scan';

/**
 * STREAMING XML INGESTION — Stage 6E-A1 prototype, productionised in 6E-A2.
 *
 * `scanXml` needs the whole model part as one JavaScript string, which needs the
 * whole inflated entry as one byte array first. This module does the same work
 * on the document in PIECES, retaining only what one construct needs:
 *
 *   - `XmlSecurityStream` (in `xml-security.ts`) answers the security rules for
 *     the concatenation of everything pushed into it. Since Stage 6E-A2 it is
 *     ALSO the whole-string check: `describeUnsafeXml` pushes the whole text
 *     through it, so the two ingestion paths share one implementation;
 *   - `XmlStreamScanner` emits exactly the `onOpen` / `onClose` / `onProgress`
 *     events `scanXml` emits, in the same order, with the same refusals;
 *   - `scanXmlByteStream` drives both over a two-pass byte source.
 *
 * "EXACTLY" IS THE CONTRACT, proven in `xml-stream.test.ts`: every split
 * position of every marker, one-character chunks and seeded random partitions,
 * against the whole-string scanner and against the regular-expression
 * statement of the security rules kept there as the oracle.
 */

/** Limits that exist only because the input arrives in pieces. */
export interface StreamXmlLimits {
  /**
   * The longest tag — text between `<` and the first `>` — held while waiting
   * for its `>`.
   *
   * A NEW RESOURCE POLICY, AND IT SAYS SO. `scanXml` needs no such bound because
   * its whole input is already one resident string, so this cannot be derived
   * from anything the whole-string reader enforces: XML puts no ceiling on how
   * many attributes an element carries, and 3MF's `anyAttribute` extension
   * points admit any number from foreign namespaces. It is therefore EXPRESSED
   * in the unit that is bounded — `maxAttributeLength` — as sixteen maximum-
   * length attribute values. The widest core element, `<object>`, defines seven
   * attributes; the longest tag in every fixture and producer file Stage 6E has
   * measured is under 1 KiB. A tag past it is refused as `XML_TAG_TOO_LONG`, a
   * resource refusal naming the limit, and that is the ONE refusal the streamed
   * path can produce that the whole-string path cannot.
   */
  readonly maxTagLength: number;
}

/** How many attribute-length values one tag may hold. See `maxTagLength`. */
export const MAX_TAG_ATTRIBUTE_WIDTHS = 16;

export const DEFAULT_STREAM_XML_LIMITS: StreamXmlLimits = Object.freeze({
  maxTagLength: MAX_TAG_ATTRIBUTE_WIDTHS * DEFAULT_XML_LIMITS.maxAttributeLength,
});

/**
 * Pieces between event-loop yields. Each piece is at most one decompressor
 * chunk — 64 KiB in Chromium — so sixteen is about a megabyte of XML between
 * the points where a cancel MESSAGE can be delivered. Cancellation is still
 * POLLED after every piece; this only bounds how long a message waits.
 */
export const STREAM_YIELD_EVERY_PIECES = 16;

/* ================================================================ scanner */

/**
 * The scanner's states. EXHAUSTIVE: every `switch` over it has no `default`, so
 * a new state is a compile error at every place that must handle it.
 */
type ScanMode = 'text' | 'open' | 'tag' | 'pi' | 'comment' | 'cdata';

const COMMENT_OPEN = '!--';
const CDATA_OPEN = '![CDATA[';
const TERMINATOR: Readonly<Record<'pi' | 'comment' | 'cdata', string>> = {
  pi: '?>',
  comment: '-->',
  cdata: ']]>',
};
/** The refusal for input ending in each state — `scanXml`'s own words. */
const UNTERMINATED: Readonly<Record<ScanMode, string | undefined>> = {
  text: undefined,
  open: 'unterminated tag',
  tag: 'unterminated tag',
  pi: 'unterminated processing instruction',
  comment: 'unterminated comment',
  cdata: 'unterminated CDATA section',
};

/**
 * What a streaming scan held at its largest. QUALIFICATION INSTRUMENTATION: the
 * product never passes one, and updating it costs one comparison per piece and
 * per tag — never per character.
 */
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
 *     comment and a CDATA section — the longest proper prefix of `![CDATA[`;
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

  /**
   * SECURITY-SENSITIVE: the opener is the initial carry, because `scanXml`
   * searches for the terminator starting AT the `<`. That is what makes `<?>`
   * a complete processing instruction and `<!-->` a complete comment, in both
   * readers alike; starting after the opener would disagree with the
   * whole-string scanner about where a construct ends.
   */
  private enterSkip(mode: 'pi' | 'comment' | 'cdata', opened: string): void {
    this.mode = mode;
    this.buffer = '';
    this.carry = opened;
  }

  /**
   * Skips to just past `terminator`, retaining at most `terminator.length - 1`
   * characters.
   *
   * WHY THAT CARRY IS ENOUGH. An occurrence that starts inside the carry ends
   * within the first `terminator.length - 1` characters of this piece, so it is
   * found in `head`; any other occurrence lies wholly in this piece and is found
   * by `indexOf` on the piece itself. Neither search concatenates the piece.
   */
  private skipTo(terminator: string, text: string, at: number): number {
    const width = terminator.length - 1;
    const head = this.carry + text.slice(at, at + width);
    const spanning = head.indexOf(terminator);
    if (spanning !== -1) {
      const resume = at + spanning + terminator.length - this.carry.length;
      this.carry = '';
      this.mode = 'text';
      return resume;
    }
    const found = text.indexOf(terminator, at);
    if (found !== -1) {
      this.carry = '';
      this.mode = 'text';
      return found + terminator.length;
    }
    this.carry = text.length - at >= width ? text.slice(text.length - width) : head.slice(-width);
    if (this.stats !== undefined) {
      this.stats.maxCarryChars = Math.max(this.stats.maxCarryChars, this.carry.length);
    }
    return text.length;
  }

  private appendTag(piece: string): void {
    this.buffer += piece;
    this.noteTag();
  }

  /** Refuses BEFORE growth past the bound, never after. */
  private noteTag(): void {
    if (this.stats !== undefined) {
      this.stats.maxTagChars = Math.max(this.stats.maxTagChars, this.buffer.length);
    }
    if (this.buffer.length > this.streamLimits.maxTagLength) {
      throw importTooLarge(
        ImportRefusal.XmlTagTooLong,
        `This 3MF file contains an XML tag longer than ${formatCount(this.streamLimits.maxTagLength)} characters, which is CAD Fixer's limit for one tag.`,
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

/**
 * The bytes of one model part, readable TWICE, in order.
 *
 * `security()` is the first read and the only one charged to the package
 * inflation budget; `semantic()` is the second, and an implementation must
 * refuse to open it until the first has been read to its end. `zip.ts`'s
 * `openTwoPassEntry` is the implementation, and owns both rules.
 */
export interface TwoPassByteSource {
  security(): AsyncIterable<Uint8Array>;
  semantic(): AsyncIterable<Uint8Array>;
}

export interface ByteStreamScanOptions {
  /** A fresh decoder per pass. Must behave as `TextDecoder('utf-8', { fatal: false })`. */
  readonly createDecoder: () => TextStreamDecoder;
  /** Polled after every piece, in both passes. */
  readonly poll: () => void;
  /** Awaited every `yieldEveryPieces` pieces, so a cancel MESSAGE can be delivered. */
  readonly yieldToEventLoop: () => Promise<void>;
  readonly streamLimits?: StreamXmlLimits;
  readonly yieldEveryPieces?: number;
  /** Qualification only. See `StreamScanStats`. */
  readonly stats?: StreamScanStats;
  /** Qualification only: each piece's byte length, per pass. */
  readonly onBytes?: (pass: 1 | 2, byteLength: number) => void;
  /** Qualification only: pass boundaries, for phase timings. */
  readonly onPass?: (pass: 1 | 2, event: 'start' | 'end') => void;
}

/**
 * Scans a model part's bytes as `scanXml` would scan them decoded, without ever
 * holding the decoded text or the bytes.
 *
 * TWO PASSES, AND THE FIRST DECIDES. `scanXml` refuses an unsafe document before
 * a single element is scanned for meaning, with a fixed precedence between its
 * three rules — and a DOCTYPE late in a prolog, or an ENTITY anywhere, can only
 * be known once the input has been read. So pass 1 reads the WHOLE part through
 * `XmlSecurityStream`, and only a part it clears is read again, by pass 2, for
 * elements.
 *
 * THE ORDER IS STRUCTURAL, NOT A CONVENTION. The element handlers do not exist
 * until pass 1 has cleared: `createHandlers` is called after `finish()` returns
 * no refusal, and not before. A caller cannot hand this function handlers that
 * pass 1 might invoke, and the byte source refuses to open pass 2 early. A
 * boundary test pins the call order in this function's source.
 */
export async function scanXmlByteStream(
  source: TwoPassByteSource,
  createHandlers: () => XmlHandlers,
  limits: XmlLimits,
  options: ByteStreamScanOptions,
): Promise<{ readonly elements: number }> {
  const every = Math.max(1, options.yieldEveryPieces ?? STREAM_YIELD_EVERY_PIECES);
  let pieces = 0;
  const afterPiece = async (): Promise<void> => {
    options.poll();
    pieces += 1;
    if (pieces % every === 0) {
      await options.yieldToEventLoop();
      options.poll();
    }
  };

  // PASS 1 — security. Nothing here can emit an element event.
  options.onPass?.(1, 'start');
  const security = new XmlSecurityStream();
  const first = options.createDecoder();
  for await (const chunk of source.security()) {
    options.onBytes?.(1, chunk.byteLength);
    security.push(first.decode(chunk, { stream: true }));
    await afterPiece();
  }
  security.push(first.decode());
  const unsafe = security.finish();
  options.onPass?.(1, 'end');
  if (unsafe !== undefined) refuseUnsafeXml(unsafe);

  // PASS 2 — elements. The handlers are created only now.
  options.onPass?.(2, 'start');
  const scanner = new XmlStreamScanner(
    createHandlers(),
    limits,
    options.streamLimits ?? DEFAULT_STREAM_XML_LIMITS,
    options.stats,
  );
  const second = options.createDecoder();
  for await (const chunk of source.semantic()) {
    options.onBytes?.(2, chunk.byteLength);
    scanner.push(second.decode(chunk, { stream: true }));
    await afterPiece();
  }
  scanner.push(second.decode());
  const result = scanner.finish();
  options.onPass?.(2, 'end');
  return result;
}
