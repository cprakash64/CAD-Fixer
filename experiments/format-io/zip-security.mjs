/**
 * Stage 4A-1 — does the bounded reader actually refuse hostile archives?
 * RESEARCH ONLY.
 *
 * INDEPENDENT ORACLE. Every fixture is also opened with Node's own `zlib`
 * inflater through a deliberately naive reader, to show what an unbounded
 * implementation does with the same bytes. Agreement between our reader and
 * itself would prove nothing; the contrast is the evidence.
 */
import { inflateRawSync } from 'node:zlib';
import { DEFAULT_ZIP_LIMITS, readDirectory, readEntry, ZipError } from './zip.mjs';
import { buildZip, compressionBomb, valid3mf } from './zip-fixtures.mjs';

const say = (line = '') => process.stdout.write(`${line}\n`);

/** What an implementation without budgets does. Used only as a contrast. */
function naiveTotalInflatedBytes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let total = 0;
  for (let i = 0; i < bytes.length - 4; i += 1) {
    if (view.getUint32(i, true) !== 0x04034b50) continue;
    const method = view.getUint16(i + 8, true);
    const compressed = view.getUint32(i + 18, true);
    const nameLength = view.getUint16(i + 26, true);
    const extraLength = view.getUint16(i + 28, true);
    const start = i + 30 + nameLength + extraLength;
    const payload = bytes.subarray(start, start + compressed);
    total += method === 8 ? inflateRawSync(payload).length : payload.length;
  }
  return total;
}

const enc = new TextEncoder();
const cases = [
  ['F10 valid minimal 3MF', await valid3mf(), 'ACCEPT'],
  ['F18 malformed: truncated archive', (await valid3mf()).subarray(0, 40), 'REFUSE'],
  ['F18 malformed: no EOCD', enc.encode('PK\u0003\u0004 not really a zip at all'), 'REFUSE'],
  ['F19 compression bomb (64 MiB of zeros)', await compressionBomb(), 'REFUSE'],
  [
    'F19 lying header: declares tiny, inflates huge',
    await buildZip([
      {
        name: '3D/3dmodel.model',
        method: 8,
        content: new Uint8Array(32 * 1024 * 1024),
        declaredUncompressedSize: 1_024,
      },
    ]),
    'REFUSE',
  ],
  [
    'F20 traversal: ../../etc/passwd',
    await buildZip([{ name: '../../etc/passwd', content: 'x' }]),
    'REFUSE',
  ],
  [
    'F20 traversal: 3D/../../escape',
    await buildZip([{ name: '3D/../../escape', content: 'x' }]),
    'REFUSE',
  ],
  ['F20 absolute path', await buildZip([{ name: '/etc/passwd', content: 'x' }]), 'REFUSE'],
  ['F20 drive-letter path', await buildZip([{ name: 'C:/windows/x', content: 'x' }]), 'REFUSE'],
  [
    'F20 backslash traversal',
    await buildZip([{ name: '3D\\..\\..\\escape', content: 'x' }]),
    'REFUSE',
  ],
  [
    'F20 encoded traversal',
    await buildZip([{ name: '3D/%2e%2e/%2e%2e/escape', content: 'x' }]),
    'REFUSE',
  ],
  [
    'F21 URL-like entry name',
    await buildZip([{ name: 'https://evil.test/x.model', content: 'x' }]),
    'REFUSE',
  ],
  [
    'F21 file:// entry name',
    await buildZip([{ name: 'file:///etc/passwd', content: 'x' }]),
    'REFUSE',
  ],
  [
    'encrypted entry (flag bit 0)',
    await buildZip([{ name: '3D/a.model', content: 'x', flags: 1 }]),
    'REFUSE',
  ],
  [
    'unsupported method (bzip2 = 12)',
    await buildZip([{ name: '3D/a.model', content: 'x', method: 12 }]),
    'REFUSE',
  ],
  [
    'case-colliding duplicate paths',
    await buildZip([
      { name: '3D/3dmodel.model', content: 'a' },
      { name: '3D/3DModel.MODEL', content: 'b' },
    ]),
    'REFUSE',
  ],
  ['NUL in path', await buildZip([{ name: '3D/a\u0000.model', content: 'x' }]), 'REFUSE'],
  [
    'entry count above cap',
    await buildZip(
      Array.from({ length: 5_000 }, (_, i) => ({ name: `3D/p${String(i)}.model`, content: 'x' })),
    ),
    'REFUSE',
  ],
];

say('case                                          expected  actual    refusal');
say('-'.repeat(96));

let correct = 0;
for (const [name, bytes, expected] of cases) {
  let actual = 'ACCEPT';
  let refusal = '';
  try {
    const { entries } = readDirectory(bytes);
    for (const entry of entries) await readEntry(bytes, entry);
  } catch (error) {
    actual = 'REFUSE';
    refusal = error instanceof ZipError ? error.refusal : `THREW ${error.constructor.name}`;
  }
  const ok = actual === expected;
  if (ok) correct += 1;
  say(
    `${name.padEnd(45)} ${expected.padEnd(9)} ${actual.padEnd(9)} ${refusal}${ok ? '' : '   *** WRONG'}`,
  );
}

say('');
say(`bounded reader: ${String(correct)}/${String(cases.length)} behaved as required`);

// THE CONTRAST. Same bytes, no budgets.
const bomb = await compressionBomb();
say('');
say('--- independent oracle: what an UNBOUNDED reader does with the same bomb ---');
say(`  archive on disk:              ${String(bomb.length)} bytes`);
const naive = naiveTotalInflatedBytes(bomb);
say(
  `  naive inflater produces:      ${String(naive)} bytes (${(naive / bomb.length).toFixed(0)}:1)`,
);
say(
  `  bounded reader refuses at:    <= ${String(DEFAULT_ZIP_LIMITS.maxCompressionRatio)}:1 declared, and again while inflating`,
);
