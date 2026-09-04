/**
 * Stage 4A-1-R1 — a bounded, streaming-shaped XML element scanner. RESEARCH ONLY.
 *
 * WHY NOT DOMParser FOR THE GEOMETRY PASS. DOMParser builds a full node tree
 * before a caller sees anything, so a 50 MiB model file becomes a 50 MiB string
 * PLUS a DOM whose per-node overhead dwarfs the text it came from — and every
 * vertex in 3MF is an element. It is also one opaque synchronous call, which
 * cannot be interrupted and cannot report progress.
 *
 * A 3MF model part is structurally regular: elements, attributes, almost no
 * mixed content. Scanning it directly costs one pass, allocates only the
 * geometry arrays the caller actually wants, and yields between elements so a
 * cancellation token can be polled. DOMParser remains the right tool for the
 * small relationship and content-type parts, where a tree is convenient and the
 * input is tiny.
 *
 * SECURITY IS UNCHANGED. The same refusal applies before a byte is scanned: a
 * document declaring a DTD, an entity, or an external identifier is rejected
 * outright rather than parsed carefully.
 */

export const XmlRefusal = {
  Doctype: 'XML_DOCTYPE_REFUSED',
  Entity: 'XML_ENTITY_REFUSED',
  ExternalId: 'XML_EXTERNAL_IDENTIFIER_REFUSED',
  Malformed: 'XML_MALFORMED',
  TooDeep: 'XML_TOO_DEEP',
  TooManyElements: 'XML_TOO_MANY_ELEMENTS',
  AttributeTooLong: 'XML_ATTRIBUTE_TOO_LONG',
};

export class XmlError extends Error {
  constructor(refusal, detail) {
    super(`${refusal}${detail === undefined ? '' : `: ${detail}`}`);
    this.name = 'XmlError';
    this.refusal = refusal;
  }
}

export const DEFAULT_XML_LIMITS = Object.freeze({
  maxElements: 80_000_000,
  maxDepth: 64,
  maxAttributeLength: 65_536,
  maxNameLength: 1_024,
});

/** Refused BEFORE parsing, so the answer never depends on the parser. */
export function describeUnsafeXml(text) {
  const head = text.slice(0, 8_192);
  if (/<!DOCTYPE/i.test(head)) return XmlRefusal.Doctype;
  if (/<!ENTITY/i.test(text)) return XmlRefusal.Entity;
  if (/\b(SYSTEM|PUBLIC)\s+["']/i.test(head)) return XmlRefusal.ExternalId;
  return undefined;
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Expands only the five predefined entities plus numeric character references. */
export function decodeXmlText(raw) {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    const named = NAMED_ENTITIES[body];
    // An UNDECLARED entity is not silently dropped and not expanded: it is left
    // exactly as written, so nothing can smuggle content through a name we do
    // not recognise.
    return named ?? match;
  });
}

export function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Walks elements, calling `onOpen(name, attributes, selfClosing)` and
 * `onClose(name)`. Attributes are parsed lazily by the caller via `readAttrs`.
 */
export function scanXml(text, handlers, limits = DEFAULT_XML_LIMITS) {
  const unsafe = describeUnsafeXml(text);
  if (unsafe !== undefined) throw new XmlError(unsafe);

  const { onOpen, onClose, onProgress } = handlers;
  let i = 0;
  let depth = 0;
  let elements = 0;
  const length = text.length;

  while (i < length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;

    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt);
      if (end === -1)
        throw new XmlError(XmlRefusal.Malformed, 'unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt);
      if (end === -1) throw new XmlError(XmlRefusal.Malformed, 'unterminated comment');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt);
      if (end === -1) throw new XmlError(XmlRefusal.Malformed, 'unterminated CDATA');
      i = end + 3;
      continue;
    }

    const gt = text.indexOf('>', lt);
    if (gt === -1) throw new XmlError(XmlRefusal.Malformed, 'unterminated tag');
    const inner = text.slice(lt + 1, gt);

    if (inner.startsWith('/')) {
      depth -= 1;
      if (depth < 0) throw new XmlError(XmlRefusal.Malformed, 'unbalanced close tag');
      onClose?.(inner.slice(1).trim());
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/\s/);
    const name = (space === -1 ? body : body.slice(0, space)).trim();
    if (name.length === 0 || name.length > limits.maxNameLength) {
      throw new XmlError(XmlRefusal.Malformed, 'bad element name');
    }

    elements += 1;
    if (elements > limits.maxElements) throw new XmlError(XmlRefusal.TooManyElements);
    if (!selfClosing) {
      depth += 1;
      if (depth > limits.maxDepth) throw new XmlError(XmlRefusal.TooDeep, String(depth));
    }

    onOpen?.(name, space === -1 ? '' : body.slice(space), selfClosing);
    if (selfClosing) onClose?.(name);

    // A yield point exists here by construction: the caller's handler runs
    // between elements, so a cancellation token can be polled at a bounded
    // interval without the scanner knowing anything about cancellation.
    if (onProgress !== undefined && (elements & 0xffff) === 0) onProgress(elements);

    i = gt + 1;
  }

  if (depth !== 0) throw new XmlError(XmlRefusal.Malformed, 'unclosed elements');
  return { elements };
}

const ATTR = /([A-Za-z_:][\w.:-]*)\s*=\s*"([^"]*)"|([A-Za-z_:][\w.:-]*)\s*=\s*'([^']*)'/g;

/** Parses one element's attribute text. Values are entity-decoded and bounded. */
export function readAttrs(source, limits = DEFAULT_XML_LIMITS) {
  const out = {};
  if (source === '') return out;
  ATTR.lastIndex = 0;
  let match;
  while ((match = ATTR.exec(source)) !== null) {
    const key = match[1] ?? match[3];
    const raw = match[2] ?? match[4] ?? '';
    if (raw.length > limits.maxAttributeLength) {
      throw new XmlError(XmlRefusal.AttributeTooLong, key);
    }
    out[key] = decodeXmlText(raw);
  }
  return out;
}
