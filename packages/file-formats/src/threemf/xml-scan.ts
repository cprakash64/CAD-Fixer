import { ImportRefusal, importMalformed, importTooLarge } from '../import-errors';

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
 * Everything before the first ELEMENT start tag — the prolog, however long.
 *
 * WHY NOT A FIXED WINDOW. This used to slice the first 8 KiB, on the reasoning
 * that a DOCTYPE may only legally appear in the prolog. But a prolog can be
 * padded to any length with comments and processing instructions, so eight
 * kilobytes of `<!-- … -->` followed by
 * `<!DOCTYPE model SYSTEM "http://…">` slipped past the window while remaining
 * well-formed. Nothing downstream fetches anything, so the file was still not
 * dangerous — but "CAD Fixer refuses a DOCTYPE" has to be true of every DOCTYPE
 * or it is not a rule, and a security check with a bypass in it is worse than
 * no check because it is trusted.
 *
 * `<?` and `<!` keep the scan inside the prolog; the first anything-else is the
 * document element and ends it.
 */
function prologOf(text: string): string {
  let at = 0;
  for (;;) {
    const open = text.indexOf('<', at);
    if (open === -1) return text;
    const next = text.charCodeAt(open + 1);
    if (next === 63 /* ? */ || next === 33 /* ! */) {
      at = open + 1;
      continue;
    }
    return text.slice(0, open);
  }
}

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
/**
 * The characters XML can carry at all, with the rest dropped.
 *
 * XML 1.0 does not permit most control characters even as numeric references,
 * so a writer that "escaped" one would produce a document that is not well
 * formed — and our own reader would refuse the file we had just written.
 * Exposed separately because a validator comparing a written name against the
 * document's has to know that this happened.
 */
export function xmlSafeText(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code === 0x7f) continue;
    out += character;
  }
  return out;
}

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
 * Checked against the WHOLE PROLOG for declarations that may only legally
 * appear there, and against the WHOLE text for `<!ENTITY`, which a malformed
 * document could place anywhere.
 */
export function describeUnsafeXml(text: string): ImportRefusal | undefined {
  const prolog = prologOf(text);
  if (/<!DOCTYPE/i.test(prolog)) return ImportRefusal.XmlDoctypeRefused;
  if (/<!ENTITY/i.test(text)) return ImportRefusal.XmlEntityRefused;
  if (/\b(SYSTEM|PUBLIC)\s+["']/i.test(prolog)) return ImportRefusal.XmlExternalIdRefused;
  return undefined;
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

/** Walks elements. Attributes are parsed lazily by the caller via `readAttrs`. */
export function scanXml(
  text: string,
  handlers: XmlHandlers,
  limits: XmlLimits = DEFAULT_XML_LIMITS,
): { readonly elements: number } {
  const unsafe = describeUnsafeXml(text);
  if (unsafe !== undefined) refuseUnsafe(unsafe);

  const { onOpen, onClose, onProgress } = handlers;
  let at = 0;
  let depth = 0;
  let elements = 0;
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
    const inner = text.slice(lt + 1, gt);

    if (inner.startsWith('/')) {
      depth -= 1;
      if (depth < 0) throw malformed('an end tag with no matching start tag');
      onClose?.(inner.slice(1).trim());
      at = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/\s/);
    const name = (space === -1 ? body : body.slice(0, space)).trim();
    if (name.length === 0 || name.length > limits.maxNameLength) {
      throw malformed('an unusable element name');
    }

    elements += 1;
    if (elements > limits.maxElements) {
      throw importTooLarge(
        ImportRefusal.XmlTooManyElements,
        'This 3MF file contains more XML elements than CAD Fixer will read.',
        { limit: limits.maxElements },
      );
    }
    if (!selfClosing) {
      depth += 1;
      if (depth > limits.maxDepth) {
        throw importTooLarge(
          ImportRefusal.XmlTooDeep,
          'This 3MF file nests XML more deeply than CAD Fixer will read.',
          { depth, limit: limits.maxDepth },
        );
      }
    }

    onOpen?.(name, space === -1 ? '' : body.slice(space), selfClosing);
    if (selfClosing) onClose?.(name);

    // A yield point exists here by construction: the caller's handler runs
    // between elements, so a cancellation token can be polled at a bounded
    // interval without the scanner knowing anything about cancellation.
    if (onProgress !== undefined && (elements & 0xffff) === 0) onProgress(elements);

    at = gt + 1;
  }

  if (depth !== 0) throw malformed('unclosed elements');
  return { elements };
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
        'This 3MF file contains an XML attribute longer than CAD Fixer will read.',
        { attribute: key.slice(0, 64), limit: limits.maxAttributeLength },
      );
    }
    out[key] = decodeXmlText(raw);
  }
  return out;
}
