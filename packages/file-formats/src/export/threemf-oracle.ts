/**
 * AN INDEPENDENT STRUCTURAL VIEW OF A 3MF ARCHIVE. TEST-ONLY.
 *
 * Same reasoning as `obj-oracle.ts`, and more necessary here: a 3MF is a ZIP
 * containing XML, and our production reader is the only thing that has ever
 * looked at either. If the writer emitted a wrong CRC, or a central directory
 * whose offsets pointed at the wrong bytes, a reader that only ever reads
 * forward from the local headers would never notice — and every other tool on
 * earth would refuse the file.
 *
 * So this re-derives the archive from the CENTRAL DIRECTORY, verifies each
 * entry's CRC against its inflated bytes, and checks the model XML for
 * well-formedness and for the constructs a 3MF must and must not contain. It
 * shares no code with the production reader.
 */

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  void writer
    .write(payload)
    .then(() => writer.close())
    .catch(() => undefined);

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export interface OracleEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly declaredCrc: number;
  readonly actualCrc: number;
  readonly declaredUncompressed: number;
  readonly actualUncompressed: number;
  readonly content: Uint8Array;
}

export interface ThreeMfInspection {
  readonly entries: readonly OracleEntry[];
  readonly problems: readonly string[];
  /** The model part's text, if the archive has one. */
  readonly modelXml: string | undefined;
}

/** Reads the archive from its central directory and verifies every entry. */
export async function inspect3mf(bytes: Uint8Array): Promise<ThreeMfInspection> {
  const problems: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let at = bytes.byteLength - 22; at >= 0; at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) {
    return { entries: [], problems: ['no end-of-central-directory record'], modelXml: undefined };
  }

  const entryCount = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  let offset = view.getUint32(eocd + 16, true);

  if (offset + directorySize + 22 !== bytes.byteLength) {
    problems.push('directory offset and size do not account for the whole archive');
  }

  const entries: OracleEntry[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      problems.push(`entry ${String(index)} has no central directory signature`);
      break;
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const declaredCrc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const declaredUncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    if ((flags & 0x1) !== 0) problems.push(`entry "${name}" is marked encrypted`);
    if ((flags & 0x8) !== 0) problems.push(`entry "${name}" uses a data descriptor`);
    if (method !== 0 && method !== 8) {
      problems.push(`entry "${name}" uses compression method ${String(method)}`);
    }
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
      problems.push(`entry "${name}" has an unsafe path`);
    }

    // FROM THE LOCAL HEADER, independently: a directory that disagrees with the
    // local headers is the classic way a hand-written archive is wrong.
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      problems.push(`entry "${name}" has no local header at its declared offset`);
      offset += 46 + nameLength + extraLength + commentLength;
      continue;
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localCompressed = view.getUint32(localOffset + 18, true);
    if (localCompressed !== compressedSize) {
      problems.push(`entry "${name}" compressed size differs between headers`);
    }
    // THE TWO HEADERS MUST AGREE. A directory that disagrees with its local
    // headers is how a hand-written archive is wrong in a way only some readers
    // notice — ours reads the local header, most others read the directory.
    if (view.getUint32(localOffset + 14, true) !== declaredCrc) {
      problems.push(`entry "${name}" CRC differs between local and central headers`);
    }
    if (view.getUint32(localOffset + 22, true) !== declaredUncompressed) {
      problems.push(`entry "${name}" uncompressed size differs between headers`);
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? compressed : await inflate(compressed);

    const actualCrc = crc32(content);
    if (actualCrc !== declaredCrc) problems.push(`entry "${name}" has a wrong CRC`);
    if (content.byteLength !== declaredUncompressed) {
      problems.push(`entry "${name}" declares the wrong uncompressed size`);
    }

    entries.push({
      name,
      method,
      flags,
      declaredCrc,
      actualCrc,
      declaredUncompressed,
      actualUncompressed: content.byteLength,
      content,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  for (const required of ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']) {
    if (!entries.some((entry) => entry.name === required)) {
      problems.push(`missing required entry "${required}"`);
    }
  }

  const model = entries.find((entry) => entry.name === '3D/3dmodel.model');
  const modelXml = model === undefined ? undefined : decoder.decode(model.content);
  if (modelXml !== undefined) problems.push(...checkModelXml(modelXml));

  return { entries, problems, modelXml };
}

/**
 * Structural checks on the model part, with a deliberately naive scanner.
 *
 * It counts tags rather than building a tree: the question is whether the
 * document is balanced and free of the constructs a 3MF must not carry, not
 * what it means.
 */
export function checkModelXml(xml: string): readonly string[] {
  const problems: string[] = [];

  // NOTHING EXTERNAL, EVER. Our own reader refuses all of these on import, so a
  // writer that emitted one would produce a file CAD Fixer could not open.
  for (const banned of ['<!DOCTYPE', '<!ENTITY', 'SYSTEM "', "SYSTEM '", 'PUBLIC "']) {
    if (xml.includes(banned)) problems.push(`model XML contains ${banned}`);
  }
  /*
   * A URL IN A NAME IS DATA, not a reference. Namespace declarations, the
   * relationship type and any `name`/`pid` value the document supplied are
   * removed before this looks for one, because a part legitimately called
   * `https://example.com/thing` must not be reported as an external reference.
   */
  const withoutData = xml
    .replace(/xmlns[^=]*="[^"]*"/g, '')
    .replace(/Type="[^"]*"/g, '')
    .replace(/\s(?:name|pid)="[^"]*"/g, '');
  if (/https?:\/\//.test(withoutData)) {
    problems.push('model XML references an external URL outside its namespace declarations');
  }

  const stack: string[] = [];
  const tag = /<\/?([A-Za-z_][\w.:-]*)([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(xml)) !== null) {
    const whole = match[0];
    const name = match[1] ?? '';
    if (whole.startsWith('<?') || whole.startsWith('<!')) continue;
    if (whole.startsWith('</')) {
      const open = stack.pop();
      if (open !== name)
        problems.push(`close tag </${name}> does not match <${open ?? 'nothing'}>`);
      continue;
    }
    if (whole.endsWith('/>')) continue;
    stack.push(name);
  }
  if (stack.length > 0) problems.push(`unclosed elements: ${stack.join(',')}`);

  // Unescaped markup inside an attribute value is the injection this checks.
  for (const found of xml.matchAll(/\s(?:name|pid)="([^"]*)"/g)) {
    const value = found[1] ?? '';
    if (
      value.includes('<') ||
      value.includes('>') ||
      /&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(value)
    ) {
      problems.push(`attribute value is not escaped: ${value.slice(0, 40)}`);
    }
  }

  if (!/<model\b[^>]*\bunit="/.test(xml)) problems.push('model element declares no unit');
  return problems;
}
