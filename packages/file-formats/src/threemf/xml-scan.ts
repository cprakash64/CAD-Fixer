import { formatCount } from '@cadfixer/shared';
import { ImportRefusal, importMalformed, importTooLarge } from '../import-errors';
/*
 * `xmlSafeText` LIVES IN A LEAF MODULE, not here.
 *
 * The conversion policy runs on the MAIN THREAD and needs to know whether a
 * name will survive being written; importing it from this file would invite a
 * bundler to follow this file's own imports — the scanner, the limits, the
 * whole intake path — into the application bundle. Re-exported so every
 * existing caller is unaffected.
 */
import { xmlSafeText } from './xml-text';
import { XmlSecurityStream } from './xml-security';

export { xmlSafeText, xmlTextChangesOnWrite } from './xml-text';

/**
 * A BOUNDED XML ELEMENT SCANNER, fail-closed before it parses anything.
 *
 * WHY NOT `DOMParser` FOR THE GEOMETRY PASS. It builds a full node tree before
 * the caller sees anything, so a 50 MiB model becomes a 50 MiB string PLUS a
 * DOM whose per-node overhead dwarfs the text — and every vertex in 3MF is an
 * element. It is also one opaque synchronous call, which cannot be interrupted
 * and cannot report progress. A 3MF model part is structurally regular:
 * elements, attributes, almost no mixed content. Scanning it directly costs one
 * pass, allocates only the arrays the caller wants, and leaves a natural yield
 * point between elements.
 *
 * THE SECURITY POLICY IS FAIL-CLOSED AND INDEPENDENT OF ANY PARSER. A document
 * declaring a DTD, an entity, or an external identifier is refused BEFORE a
 * byte is scanned for meaning. The research proved Chromium's `DOMParser` does
 * not expand external entities — but that is a property of today's engines, not
 * a contract we control, and a file that never reaches entity expansion cannot
 * depend on whether entity expansion is safe. Billion-laughs is refused by the
 * same rule, before expansion.
 *
 * Promoted from `experiments/format-io/xml-scan.mjs`.
 */

export interface XmlLimits {
  readonly maxElements: number;
  readonly maxDepth: number;
  readonly maxAttributeLength: number;
  readonly maxNameLength: number;
}

export const DEFAULT_XML_LIMITS: XmlLimits = Object.freeze({
  maxElements: 80_000_000,
  maxDepth: 64,
  maxAttributeLength: 65_536,
  maxNameLength: 1_024,
});

/**
 * Escapes a string so it is XML DATA and can never be anything else.
 *
 * ALL FIVE PREDEFINED ENTITIES, including the two that only matter inside an
 * attribute value. A writer that escapes `&`, `<` and `>` but not the quotes
 * produces a document where a name containing `"` closes the attribute and the
 * rest of the name becomes markup — which is the whole attack, achieved with
 * one character.
 *
 * `&` MUST BE FIRST. Replacing it after the others would re-escape the
 * ampersands those replacements just introduced, turning `<` into `&amp;lt;`.
 *
 * Control characters are DROPPED rather than escaped. XML 1.0 does not permit
 * most of them at all — not even as numeric references — so a document
 * containing one is not well formed, and our own reader would refuse the file
 * we had just written.
 */
export function escapeXml(value: string): string {
  let out = '';
  for (const character of xmlSafeText(value)) {
    switch (character) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case "'":
        out += '&apos;';
        break;
      default:
        out += character;
    }
  }
  return out;
}

/**
 * Names the unsafe construct in a document, or `undefined`.
 *
 * The rules — a DOCTYPE or an external identifier in the PROLOG, an ENTITY
 * anywhere — and their precedence are `XmlSecurityStream`'s, and since Stage
 * 6E-A2 this IS `XmlSecurityStream`, fed the whole text in one piece. The
 * streamed reader feeds the same class in pieces, so the two ingestion paths
 * cannot disagree about what is unsafe.
 *
 * WHY THE PROLOG IS NOT A FIXED WINDOW. It used to be the first 8 KiB, on the
 * reasoning that a DOCTYPE may only legally appear there. But a prolog can be
 * padded to any length with comments and processing instructions, so eight
 * kilobytes of `<!-- … -->` followed by `<!DOCTYPE model SYSTEM "http://…">`
 * slipped past the window while remaining well-formed. "CAD Fixer refuses a
 * DOCTYPE" has to be true of every DOCTYPE or it is not a rule: the prolog is
 * everything before the first `<` that is not followed by `?` or `!`, however
 * long.
 *
 * NO REGULAR EXPRESSION RUNS OVER THE TEXT, which is Stage 6E-A2's fix for the
 * retention finding in `docs/design/STAGE_6E_STREAMING_3MF_IMPORT.md`: a
 * successful match left the engine's last-match state holding the document.
 */
export function describeUnsafeXml(text: string): ImportRefusal | undefined {
  const security = new XmlSecurityStream();
  security.push(text);
  return security.finish();
}

function refuseUnsafe(refusal: ImportRefusal): never {
  const message =
    refusal === ImportRefusal.XmlDoctypeRefused
      ? 'This 3MF file declares a document type definition. CAD Fixer refuses those rather than interpreting them.'
      : refusal === ImportRefusal.XmlEntityRefused
        ? 'This 3MF file declares XML entities. CAD Fixer refuses those rather than expanding them.'
        : 'This 3MF file references an external XML resource. CAD Fixer never fetches those, and refuses the file rather than ignoring the reference.';
  throw importMalformed(refusal, message);
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Expands only the five predefined entities plus numeric character references.
 *
 * An UNDECLARED entity is neither dropped nor expanded: it is left exactly as
 * written, so nothing can smuggle content through a name we do not recognise.
 */
export function decodeXmlText(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

export interface XmlHandlers {
  /*
   * Declared as function-typed PROPERTIES rather than methods so they can be
   * passed around without `this` ambiguity — the same reason the repair
   * services declare their progress callbacks this way.
   */
  readonly onOpen?: (name: string, attributeText: string, selfClosing: boolean) => void;
  readonly onClose?: (name: string) => void;
  /** Called every 65,536 elements. The place a cancellation token is polled. */
  readonly onProgress?: (elements: number) => void;
}

/**
 * The counters every scan carries, whichever driver feeds it.
 *
 * MUTABLE AND SHARED ON PURPOSE — Stage 6E-A1. `scanXml` walks one whole
 * string; the streaming scanner in `xml-stream.ts` walks the same document in
 * pieces. Both hand each tag to `applyTag`, so element counting, depth, name
 * rules, limits and event order are ONE implementation rather than two that
 * could drift apart.
 */
export interface XmlScanState {
  depth: number;
  elements: number;
}

/**
 * Applies one tag: the text between a `<` and the FIRST `>` after it.
 *
 * THE FIRST `>`, NOT A QUOTE-AWARE ONE, and that is the behaviour both drivers
 * preserve exactly: an attribute value containing `>` ends the tag early. That
 * is a known quirk of this scanner, recorded in the Stage 6E design document;
 * changing it is a semantic decision, not a streaming one.
 *
 * A TAG IS A SLICE OF THE DOCUMENT, and V8 keeps a slice's parent alive. The
 * two ways that used to keep a whole decoded model part reachable after an
 * import are closed where they are opened — see `detachedCopy` and
 * `forgetRegExpMatch` — rather than by copying every tag, which Stage 6E-A2
 * measured raising the peak of a multi-part import by ~350 MiB.
 */
export function applyTag(
  inner: string,
  state: XmlScanState,
  handlers: XmlHandlers,
  limits: XmlLimits,
): void {
  const { onOpen, onClose, onProgress } = handlers;

  if (inner.startsWith('/')) {
    state.depth -= 1;
    if (state.depth < 0) throw malformed('an end tag with no matching start tag');
    onClose?.(inner.slice(1).trim());
    return;
  }

  const selfClosing = inner.endsWith('/');
  const body = selfClosing ? inner.slice(0, -1) : inner;
  const space = body.search(/\s/);
  const name = (space === -1 ? body : body.slice(0, space)).trim();
  if (name.length === 0 || name.length > limits.maxNameLength) {
    throw malformed('an unusable element name');
  }

  state.elements += 1;
  if (state.elements > limits.maxElements) {
    throw importTooLarge(
      ImportRefusal.XmlTooManyElements,
      `This 3MF file contains more than ${formatCount(limits.maxElements)} XML elements, which is CAD Fixer's limit.`,
      { limit: limits.maxElements },
    );
  }
  if (!selfClosing) {
    state.depth += 1;
    if (state.depth > limits.maxDepth) {
      throw importTooLarge(
        ImportRefusal.XmlTooDeep,
        `This 3MF file nests XML ${formatCount(state.depth)} levels deep; CAD Fixer's limit is ${formatCount(limits.maxDepth)} levels.`,
        { depth: state.depth, limit: limits.maxDepth },
      );
    }
  }

  onOpen?.(name, space === -1 ? '' : body.slice(space), selfClosing);
  if (selfClosing) onClose?.(name);

  // A yield point exists here by construction: the caller's handler runs
  // between elements, so a cancellation token can be polled at a bounded
  // interval without the scanner knowing anything about cancellation.
  if (onProgress !== undefined && (state.elements & 0xffff) === 0) onProgress(state.elements);
}

/**
 * A copy of `text` that shares no storage with the string it was cut from.
 *
 * WHY THIS EXISTS — Stage 6E-A2, finding R1. V8 represents a substring of 13 or
 * more characters as a VIEW onto its parent string, so an attribute value kept
 * past the import — an object name is the one the reader keeps — kept the
 * ENTIRE decoded model part reachable for as long as the document lived: up to
 * 256 MiB, twice that if the part held one character above U+00FF.
 *
 * HOW IT COPIES. JavaScript has no operation specified to copy a string, so this
 * uses the representation V8 produces: prefixing a character makes a fresh
 * string whose storage is materialised when it is first sliced, and slicing the
 * prefix off then views THAT copy — one name long — instead of the document.
 * `scripts/xml-retention.test.ts` measures the heap to prove the effect rather
 * than trusting this description.
 *
 * APPLIED WHERE A STRING IS KEPT, NOT TO EVERY TAG. Copying every tag closed the
 * same route, but the extra allocation shifted garbage collection enough to
 * raise a two-part package's peak by ~350 MiB in Chromium; one copy per kept
 * name costs nothing measurable.
 */
export function detachedCopy(text: string): string {
  return (' ' + text).slice(1);
}

const EMPTY_MATCH = /(?:)/;

/**
 * Replaces the engine's last-successful-match state with a match on a constant.
 *
 * WHY THIS EXISTS — Stage 6E-A2, finding R1. After a successful regular-
 * expression match V8 keeps its SUBJECT reachable (the legacy `RegExp.input`
 * and friends) until another match succeeds anywhere in the realm. The reader's
 * last successful match is on an attribute list or a value — a slice of the
 * decoded model part — so the whole part stayed reachable after the import, and
 * after a refusal, until something else happened to match. A successful match
 * on the empty string makes the empty string the subject instead.
 *
 * Called after each model part is scanned and when a read ends, however it
 * ends. `scripts/xml-retention.test.ts` measures the heap to prove it works in
 * the engine we ship on, for success, refusal and both ingestion modes.
 */
export function forgetRegExpMatch(): void {
  EMPTY_MATCH.exec('');
}

/** The refusal for an unsafe construct, as `scanXml` raises it. */
export function refuseUnsafeXml(refusal: ImportRefusal): never {
  refuseUnsafe(refusal);
}

/** A malformed-XML refusal naming `what`, exactly as the scanner words it. */
export function malformedXml(what: string): Error {
  return malformed(what);
}

/** Walks elements. Attributes are parsed lazily by the caller via `readAttrs`. */
export function scanXml(
  text: string,
  handlers: XmlHandlers,
  limits: XmlLimits = DEFAULT_XML_LIMITS,
): { readonly elements: number } {
  const unsafe = describeUnsafeXml(text);
  if (unsafe !== undefined) refuseUnsafe(unsafe);

  const state: XmlScanState = { depth: 0, elements: 0 };
  let at = 0;
  const length = text.length;

  while (at < length) {
    const lt = text.indexOf('<', at);
    if (lt === -1) break;

    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt);
      if (end === -1) throw malformed('unterminated processing instruction');
      at = end + 2;
      continue;
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt);
      if (end === -1) throw malformed('unterminated comment');
      at = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt);
      if (end === -1) throw malformed('unterminated CDATA section');
      at = end + 3;
      continue;
    }

    const gt = text.indexOf('>', lt);
    if (gt === -1) throw malformed('unterminated tag');
    applyTag(text.slice(lt + 1, gt), state, handlers, limits);
    at = gt + 1;
  }

  if (state.depth !== 0) throw malformed('unclosed elements');
  return { elements: state.elements };
}

function malformed(what: string): Error {
  return importMalformed(
    ImportRefusal.XmlMalformed,
    `This 3MF file contains malformed XML: ${what}.`,
  );
}

const ATTRIBUTE = /([A-Za-z_:][\w.:-]*)\s*=\s*"([^"]*)"|([A-Za-z_:][\w.:-]*)\s*=\s*'([^']*)'/g;

/** Parses one element's attribute text. Values are entity-decoded and bounded. */
export function readAttrs(
  source: string,
  limits: XmlLimits = DEFAULT_XML_LIMITS,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (source === '') return out;
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(source)) !== null) {
    const key = match[1] ?? match[3] ?? '';
    const raw = match[2] ?? match[4] ?? '';
    if (raw.length > limits.maxAttributeLength) {
      throw importTooLarge(
        ImportRefusal.XmlAttributeTooLong,
        `This 3MF file contains an XML attribute of ${formatCount(raw.length)} characters; CAD Fixer's limit is ${formatCount(limits.maxAttributeLength)} characters.`,
        { attribute: key.slice(0, 64), length: raw.length, limit: limits.maxAttributeLength },
      );
    }
    out[key] = decodeXmlText(raw);
  }
  return out;
}
