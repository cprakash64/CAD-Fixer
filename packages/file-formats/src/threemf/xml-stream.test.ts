import { describe, expect, it } from 'vitest';
import { isAppError } from '@cadfixer/shared';
import { ImportRefusal, refusalOf } from '../import-errors';
import { DEFAULT_XML_LIMITS, describeUnsafeXml, scanXml, type XmlLimits } from './xml-scan';
import {
  createStreamScanStats,
  scanXmlByteStream,
  XmlSecurityStream,
  XmlStreamScanner,
  type StreamXmlLimits,
  type TextStreamDecoder,
} from './xml-stream';

/**
 * 6E-S — THE STREAMING SCANNER IS THE WHOLE-STRING SCANNER, PIECE BY PIECE.
 *
 * Every test here compares against `scanXml` / `describeUnsafeXml` themselves,
 * never against a hand-written expectation of what they "should" do: the
 * streaming classes are only correct if they are indistinguishable from the
 * shipped functions, quirks included. A chunk boundary may fall anywhere — in a
 * marker, a name, an attribute value, a number, a UTF-8 sequence — so the
 * partitions below put it everywhere.
 */

/* ---------------------------------------------------------------- oracle -- */

type Event =
  | readonly ['open', string, string, boolean]
  | readonly ['close', string]
  | readonly ['progress', number];

interface Outcome {
  readonly events: readonly Event[];
  readonly result:
    | { readonly elements: number }
    | { readonly reason: string | undefined; readonly message: string };
}

function recorder(events: Event[]): Parameters<typeof scanXml>[1] {
  return {
    onOpen: (name, attributes, selfClosing) => events.push(['open', name, attributes, selfClosing]),
    onClose: (name) => events.push(['close', name]),
    onProgress: (count) => events.push(['progress', count]),
  };
}

function failure(error: unknown): { reason: string | undefined; message: string } {
  if (!isAppError(error)) throw error;
  return { reason: refusalOf(error), message: error.message };
}

function whole(text: string, limits: XmlLimits = DEFAULT_XML_LIMITS): Outcome {
  const events: Event[] = [];
  try {
    return { events, result: scanXml(text, recorder(events), limits) };
  } catch (error) {
    return { events, result: failure(error) };
  }
}

/**
 * The two streaming classes, in the order the driver runs them: the security
 * stream over EVERY piece first, then the scanner. Refusals from the security
 * pass therefore precede every event, as they do in `scanXml`.
 */
function streamed(
  pieces: readonly string[],
  limits: XmlLimits = DEFAULT_XML_LIMITS,
  streamLimits?: StreamXmlLimits,
): Outcome {
  const events: Event[] = [];
  try {
    const security = new XmlSecurityStream();
    for (const piece of pieces) security.push(piece);
    const unsafe = security.finish();
    if (unsafe !== undefined) {
      // The same refusal `scanXml` raises — reproduced through it, so the
      // message is the shipped one rather than a copy.
      return { events, result: failure(captureUnsafe(unsafe)) };
    }
    const scanner = new XmlStreamScanner(recorder(events), limits, streamLimits);
    for (const piece of pieces) scanner.push(piece);
    return { events, result: scanner.finish() };
  } catch (error) {
    return { events, result: failure(error) };
  }
}

const UNSAFE_SAMPLES: Readonly<Record<string, string>> = {
  [ImportRefusal.XmlDoctypeRefused]: '<!DOCTYPE x><m/>',
  [ImportRefusal.XmlEntityRefused]: '<m><!ENTITY x "y"></m>',
  [ImportRefusal.XmlExternalIdRefused]: '<!-- SYSTEM "x" --><m/>',
};

function captureUnsafe(refusal: string): unknown {
  try {
    scanXml(UNSAFE_SAMPLES[refusal] ?? '', {});
  } catch (error) {
    return error;
  }
  throw new Error(`no sample for ${refusal}`);
}

/* ------------------------------------------------------------ partitions -- */

/** Every UTF-16 code unit on its own — harsher than any decoder's pieces. */
function codeUnits(text: string): string[] {
  return Array.from({ length: text.length }, (_unit, at) => text.charAt(at));
}

function splitAt(text: string, points: readonly number[]): string[] {
  const out: string[] = [];
  let from = 0;
  for (const point of points) {
    out.push(text.slice(from, point));
    from = point;
  }
  out.push(text.slice(from));
  return out;
}

/** Mulberry32. The seed is recorded in every test name that uses it. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomPartition(text: string, next: () => number): string[] {
  const points: number[] = [];
  let at = 0;
  while (at < text.length) {
    at += 1 + Math.floor(next() * 12);
    if (at < text.length) points.push(at);
  }
  return splitAt(text, points);
}

/** Whole, every two-piece split, one-character pieces, and 25 seeded partitions. */
function expectPartitionInvariant(text: string, limits?: XmlLimits, seed = 0xca_df_1e): void {
  const expected = whole(text, limits);
  expect(streamed([text], limits)).toEqual(expected);
  for (let point = 0; point <= text.length; point += 1) {
    expect(streamed(splitAt(text, [point]), limits), `split at ${String(point)}`).toEqual(expected);
  }
  expect(streamed(codeUnits(text), limits), 'one character at a time').toEqual(expected);
  const next = random(seed);
  for (let round = 0; round < 25; round += 1) {
    expect(
      streamed(randomPartition(text, next), limits),
      `seed ${String(seed)} round ${String(round)}`,
    ).toEqual(expected);
  }
}

/* --------------------------------------------------------------- corpus -- */

const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

const VALID_MODEL =
  '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- prolog comment with a < b and SYSTEM word -->\n' +
  `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE}" xmlns:p="${PRODUCTION}" requiredextensions="p">\n` +
  ' <metadata name="Title">Ünïcödé 模型 😀 &amp; &lt;name&gt;</metadata>\n' +
  ' <resources>\n' +
  '  <object id="123" type="model" name="Gehäuse">\n' +
  '   <mesh><vertices><vertex x="-1.2345e-06" y="0" z="10"/><vertex x="1" y="2.5" z="-3E+2"/>' +
  '<vertex x="0" y=\'0\' z="0"/></vertices>\n' +
  '   <triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>\n' +
  '  </object>\n' +
  '  <object id="42" type="model"><components>' +
  '<component objectid="42" p:path="/3D/Objects/a.model" transform="1 0 0 0 1 0 0 0 1 10.5 -2 0"/>' +
  '</components></object>\n' +
  '  <![CDATA[ <not-an-element attr="x"/> ]]>\n' +
  '  <?pi with > inside ?>\n' +
  ' </resources>\n' +
  ' <build><item objectid="123" p:path="/3D/Objects/a.model"/></build>\n' +
  '</model>\n';

const QUIRKS: readonly (readonly [string, string])[] = [
  ['PI that closes on its own question mark', '<m><?></m>'],
  ['comment that closes on its own dashes', '<m><!--></m>'],
  ['a near-comment is a tag', '<m><!-></!-></m>'],
  ['a bare <!> is a tag', '<m><!>x</!></m>'],
  ['an attribute containing > ends the tag early', '<m a="1>2" b="3"></m>'],
  ['CDATA containing ]] and >', '<m><![CDATA[ a ]] > ]]]></m>'],
  ['text after the last tag', '<m></m> trailing text'],
  ['a comment containing <', '<m><!-- a < b --></m>'],
  ['end tag names are not matched', '<a></b>'],
  ['self-closing with spaces', '<a  x="1"  / >'],
  ['tabs and newlines as name separators', '<a\tx="1"\n/>'],
  ['a non-breaking space inside a name', '<a\u00A0b="1"/>'],
  ['empty document', ''],
  ['text only', 'no markup at all'],
];

const MALFORMED: readonly (readonly [string, string])[] = [
  ['EOF inside a tag', '<model a="1"'],
  ['EOF inside an attribute value', '<model a="1'],
  ['EOF inside a comment', '<m><!-- never closed'],
  ['EOF inside CDATA', '<m><![CDATA[ never closed'],
  ['EOF inside a PI', '<?xml version="1.0"'],
  ['EOF just after <', '<m><'],
  ['EOF inside a partial comment opener', '<m><!-'],
  ['EOF inside a partial CDATA opener', '<m><![CDA'],
  ['EOF inside a partial forbidden declaration', '<!DOC'],
  ['EOF inside a partial entity declaration', '<m></m><!ENTI'],
  ['unclosed elements', '<a><b></b>'],
  ['a stray end tag', '</a>'],
  ['an empty element name', '< x="1"/>'],
];

const UNSAFE: readonly (readonly [string, string])[] = [
  ['DOCTYPE in the prolog', '<?xml version="1.0"?><!DOCTYPE model><model/>'],
  ['doctype in lower case', '<!doctype model><model/>'],
  ['DOCTYPE after a long comment', `<!-- ${'x'.repeat(300)} --><!DOCTYPE m><m/>`],
  ['DOCTYPE inside a prolog comment', '<!-- <!DOCTYPE m> --><m/>'],
  ['DOCTYPE after the root is not in the prolog', '<m></m><!DOCTYPE x>'],
  ['ENTITY in the body', '<m><!ENTITY x "y"></m>'],
  ['ENTITY in an attribute value', '<m a="<!ENTITY"/>'],
  ['entity in mixed case in a comment', '<m><!-- <!eNtItY --></m>'],
  ['ENTITY outranked by a later prolog DOCTYPE', '<!ENTITY a "b"><!DOCTYPE m><m/>'],
  ['SYSTEM identifier in the prolog', '<!DOCTYPE m SYSTEM "http://x"><m/>'],
  ['SYSTEM word in a prolog comment', '<!-- SYSTEM "a" --><m/>'],
  ['PUBLIC with a tab and a single quote', "<!-- public\t'a' --><m/>"],
  ['PUBLIC with a non-breaking space', '<!-- PUBLIC\u00A0"a" --><m/>'],
  ['SYSTEM with a long whitespace run', `<!-- SYSTEM${' '.repeat(200)}"a" --><m/>`],
  ['SYSTEMX is not the word', '<!-- SYSTEMX "a" --><m/>'],
  ['xSYSTEM has no word boundary', '<!-- xSYSTEM "a" --><m/>'],
  ['SYSTEM with no whitespace', '<!-- SYSTEM"a" --><m/>'],
  ['SYSTEM in the body is not the prolog', '<m a="SYSTEM"/><!-- SYSTEM "x" -->'],
  ['a < at the very end ends nothing', '<!-- SYSTEM "a" --><'],
  ['ENTITY outranks a prolog SYSTEM', '<!-- SYSTEM "a" --><m/><!ENTITY'],
];

describe('6E-S1: every construct, split at every position, one character at a time, and at random', () => {
  it('a valid production-extension model part', () => {
    expectPartitionInvariant(VALID_MODEL);
  });
  for (const [label, text] of [...QUIRKS, ...MALFORMED, ...UNSAFE]) {
    it(label, () => {
      expectPartitionInvariant(text);
    });
  }
});

describe('6E-S2: limits are the same limits, counted across pieces', () => {
  const tight: XmlLimits = { maxElements: 5, maxDepth: 3, maxAttributeLength: 8, maxNameLength: 4 };
  for (const [label, text] of [
    ['too many elements', '<a><b/><b/><b/><b/><b/></a>'],
    ['too deep', '<a><b><c><d></d></c></b></a>'],
    ['name too long', '<abcde/>'],
    ['exactly at the element limit', '<a><b/><b/><b/><b/></a>'],
  ] as const) {
    it(label, () => {
      expectPartitionInvariant(text, tight);
    });
  }

  it('progress fires at the same element counts', () => {
    const many = `<m>${'<v/>'.repeat(140_000)}</m>`;
    const expected = whole(many);
    expect(expected.events.filter((event) => event[0] === 'progress')).toHaveLength(2);
    expect(streamed(randomPartition(many, random(7)))).toEqual(expected);
  });
});

describe('6E-S3: the security stream is describeUnsafeXml, on arbitrary text', () => {
  const alphabet = [
    '<',
    '!',
    '?',
    '>',
    '-',
    ' ',
    '\t',
    '\n',
    '\u00A0',
    '"',
    "'",
    '_',
    'a',
    'x',
    '1',
    '<!DOCTYPE',
    '<!doctype',
    '<!ENTITY',
    '<!EnTiTy',
    'SYSTEM',
    'system',
    'PUBLIC',
    'Public',
    'SYST',
    'EM',
    'PUB',
    'LIC',
    '<!DOC',
    'TYPE',
    '<!ENT',
    'ITY',
    '<?',
    '?>',
    '<!--',
    '-->',
    'ſ',
  ];
  it('matches on 4,000 seeded random documents under random partitions (seed 0x6E5)', () => {
    const next = random(0x6e5);
    for (let round = 0; round < 4_000; round += 1) {
      let text = '';
      const parts = 1 + Math.floor(next() * 24);
      for (let part = 0; part < parts; part += 1) {
        text += alphabet[Math.floor(next() * alphabet.length)] ?? '';
      }
      const security = new XmlSecurityStream();
      for (const piece of randomPartition(text, next)) security.push(piece);
      expect(security.finish(), JSON.stringify(text)).toBe(describeUnsafeXml(text));
    }
  });

  for (const marker of [
    '<!DOCTYPE',
    '<!ENTITY',
    '<!--',
    '-->',
    '<![CDATA[',
    ']]>',
    '<?xml',
    'SYSTEM "',
  ]) {
    it(`finds ${marker} split at every position inside it`, () => {
      const text = `<!-- pad -->${marker} x --><m/><!-- ${marker} -->`;
      for (let point = 0; point <= text.length; point += 1) {
        const security = new XmlSecurityStream();
        for (const piece of splitAt(text, [point])) security.push(piece);
        expect(security.finish(), `split at ${String(point)}`).toBe(describeUnsafeXml(text));
      }
    });
  }
});

describe('6E-S4: UTF-8, split between the bytes of a character', () => {
  const decode = (bytes: readonly Uint8Array[]): string[] => {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const out = bytes.map((chunk) => decoder.decode(chunk, { stream: true }));
    out.push(decoder.decode());
    return out;
  };

  it('every byte split of a multibyte document gives the whole-string events', () => {
    const bytes = new TextEncoder().encode(VALID_MODEL);
    const expected = whole(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
    for (let point = 0; point <= bytes.length; point += 1) {
      const pieces = decode([bytes.subarray(0, point), bytes.subarray(point)]);
      expect(streamed(pieces), `byte ${String(point)}`).toEqual(expected);
    }
  });

  it('one byte at a time, including a byte-order mark and invalid bytes', () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('<m a="'),
      0xff,
      0xe4,
      0xb8,
      ...new TextEncoder().encode('"><n b="😀"/></m>'),
    ]);
    const expected = whole(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
    const pieces = decode([...bytes].map((byte) => new Uint8Array([byte])));
    expect(streamed(pieces)).toEqual(expected);
  });
});

describe('6E-S5: what the scanner holds between pieces is bounded', () => {
  it('a long comment, PI and CDATA section hold at most two characters of carry', () => {
    const stats = createStreamScanStats();
    const body = 'x'.repeat(2_000_000);
    const text = `<m><!--${body}--><?p ${body}?><![CDATA[${body}]]>${body}</m>`;
    const scanner = new XmlStreamScanner({}, DEFAULT_XML_LIMITS, undefined, stats);
    for (let at = 0; at < text.length; at += 65_536) scanner.push(text.slice(at, at + 65_536));
    expect(scanner.finish().elements).toBe(1);
    expect(stats.maxCarryChars).toBeLessThanOrEqual(2);
    expect(stats.maxTagChars).toBeLessThan(8);
  });

  it('a tag longer than the stream limit is a typed refusal, not growth', () => {
    const limits: StreamXmlLimits = { maxTagLength: 1_024 };
    const at = `<m a="${'x'.repeat(1_017)}"/>`; // inner is exactly 1,024 characters
    const over = `<m a="${'x'.repeat(1_030)}"/>`;
    expect(streamed(codeUnits(at), DEFAULT_XML_LIMITS, limits).result).toEqual({ elements: 1 });
    expect(streamed([over], DEFAULT_XML_LIMITS, limits).result).toMatchObject({
      reason: ImportRefusal.XmlTagTooLong,
    });
    expect(streamed(codeUnits(over), DEFAULT_XML_LIMITS, limits).result).toMatchObject({
      reason: ImportRefusal.XmlTagTooLong,
    });
  });
});

describe('6E-S6: the byte-stream driver runs the security pass over the whole part first', () => {
  const bytes = (text: string, size: number): (() => AsyncIterable<Uint8Array>) => {
    const all = new TextEncoder().encode(text);
    return async function* chunks() {
      for (let at = 0; at < all.length; at += size) {
        await Promise.resolve();
        yield all.subarray(at, at + size);
      }
    };
  };
  const decoder = (): TextStreamDecoder => new TextDecoder('utf-8', { fatal: false });

  it('produces the whole-string events for every chunk size from 1 to 64 bytes', async () => {
    const expected = whole(VALID_MODEL);
    for (let size = 1; size <= 64; size += 1) {
      const events: Event[] = [];
      const result = await scanXmlByteStream(
        bytes(VALID_MODEL, size),
        recorder(events),
        DEFAULT_XML_LIMITS,
        {
          createDecoder: decoder,
        },
      );
      expect({ events, result }, `chunk ${String(size)}`).toEqual(expected);
    }
  });

  it('refuses a late ENTITY before emitting a single element event', async () => {
    const text = `<m>${'<v/>'.repeat(1_000)}<!ENTITY x "y"></m>`;
    const events: Event[] = [];
    let caught: unknown;
    try {
      await scanXmlByteStream(bytes(text, 97), recorder(events), DEFAULT_XML_LIMITS, {
        createDecoder: decoder,
      });
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught) && refusalOf(caught)).toBe(ImportRefusal.XmlEntityRefused);
    expect(events).toEqual([]);
  });

  it('asks for the bytes twice, and polls in both passes', async () => {
    const passes: number[] = [];
    let polls = 0;
    await scanXmlByteStream(
      (pass) => {
        passes.push(pass);
        return bytes(VALID_MODEL, 50)();
      },
      {},
      DEFAULT_XML_LIMITS,
      { createDecoder: decoder, poll: () => (polls += 1) },
    );
    expect(passes).toEqual([1, 2]);
    expect(polls).toBeGreaterThanOrEqual(2 * Math.floor(VALID_MODEL.length / 50));
  });
});
