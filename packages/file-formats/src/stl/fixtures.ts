import { DEFAULT_IMPORT_BUDGET, type ImportBudget } from '../budget';
import type { FormatReadContext, FormatWriteContext } from '../context';
import { BINARY_HEADER_BYTES, BINARY_PREFIX_BYTES, BINARY_FACET_BYTES } from './detect';
import { uncancellable, type CancellationToken } from '@cadfixer/shared';

/**
 * Deterministic STL fixture builders for tests.
 *
 * Everything the test suite parses is generated here, in code, so that no large
 * binary blobs are committed and every byte a test relies on is auditable by
 * reading this file. Each builder is intentionally simple enough to verify by
 * eye — a fixture builder that needed its own tests would undermine the tests
 * that use it.
 */

export interface Triangle {
  readonly normal: readonly [number, number, number];
  readonly vertices: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
}

/** A single unit triangle in the XY plane, wound counter-clockwise. */
export const UNIT_TRIANGLE: Triangle = {
  normal: [0, 0, 1],
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
};

export function triangleAt(offset: number): Triangle {
  return {
    normal: [0, 0, 1],
    vertices: [
      [offset, 0, 0],
      [offset + 1, 0, 0],
      [offset, 1, 0],
    ],
  };
}

/* ---------------------------------------------------------------- binary -- */

export interface BinaryStlOptions {
  /** Text written into the 80-byte header. Truncated to fit. */
  readonly header?: string;
  /** Overrides the declared facet count, for truncation and overflow tests. */
  readonly declaredCount?: number;
  /** Extra bytes appended after the last facet. */
  readonly trailingBytes?: number;
  /** Truncates the finished buffer to this many bytes. */
  readonly truncateTo?: number;
  readonly attributeByteCount?: number;
}

export function buildBinaryStl(
  triangles: readonly Triangle[],
  options: BinaryStlOptions = {},
): Uint8Array {
  const trailing = options.trailingBytes ?? 0;
  const total = BINARY_PREFIX_BYTES + triangles.length * BINARY_FACET_BYTES + trailing;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  const header = options.header ?? 'cadfixer test fixture';
  for (let index = 0; index < header.length && index < BINARY_HEADER_BYTES; index += 1) {
    bytes[index] = header.charCodeAt(index) & 0xff;
  }

  view.setUint32(BINARY_HEADER_BYTES, options.declaredCount ?? triangles.length, true);

  triangles.forEach((triangle, triangleIndex) => {
    const offset = BINARY_PREFIX_BYTES + triangleIndex * BINARY_FACET_BYTES;
    view.setFloat32(offset, triangle.normal[0], true);
    view.setFloat32(offset + 4, triangle.normal[1], true);
    view.setFloat32(offset + 8, triangle.normal[2], true);
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = triangle.vertices[corner] ?? [0, 0, 0];
      const cornerOffset = offset + 12 + corner * 12;
      view.setFloat32(cornerOffset, vertex[0], true);
      view.setFloat32(cornerOffset + 4, vertex[1], true);
      view.setFloat32(cornerOffset + 8, vertex[2], true);
    }
    view.setUint16(offset + 48, options.attributeByteCount ?? 0, true);
  });

  return options.truncateTo === undefined ? bytes : bytes.slice(0, options.truncateTo);
}

/* ----------------------------------------------------------------- ascii -- */

export interface AsciiStlOptions {
  readonly solidName?: string;
  readonly lineEnding?: '\n' | '\r\n';
  readonly indent?: string;
  readonly includeEndSolid?: boolean;
  readonly trailingNewline?: boolean;
}

export function buildAsciiStl(
  triangles: readonly Triangle[],
  options: AsciiStlOptions = {},
): Uint8Array {
  const name = options.solidName ?? 'fixture';
  const eol = options.lineEnding ?? '\n';
  const pad = options.indent ?? '  ';

  const lines: string[] = [`solid ${name}`];
  for (const triangle of triangles) {
    lines.push(`${pad}facet normal ${triangle.normal.map(formatFixture).join(' ')}`);
    lines.push(`${pad}${pad}outer loop`);
    for (const vertex of triangle.vertices) {
      lines.push(`${pad}${pad}${pad}vertex ${vertex.map(formatFixture).join(' ')}`);
    }
    lines.push(`${pad}${pad}endloop`);
    lines.push(`${pad}endfacet`);
  }
  if (options.includeEndSolid !== false) lines.push(`endsolid ${name}`);

  let text = lines.join(eol);
  if (options.trailingNewline !== false) text += eol;
  return asciiToBytes(text);
}

export function asciiToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function formatFixture(value: number): string {
  return value.toExponential(8);
}

/* --------------------------------------------------------------- context -- */

export interface RecordingContext extends FormatReadContext, FormatWriteContext {
  readonly fractions: number[];
  readonly notes: (string | undefined)[];
}

/** A read/write context that records progress and never cancels. */
export function testContext(
  overrides: { budget?: ImportBudget; cancellation?: CancellationToken; encoding?: string } = {},
): RecordingContext {
  const fractions: number[] = [];
  const notes: (string | undefined)[] = [];
  return {
    cancellation: overrides.cancellation ?? uncancellable,
    budget: overrides.budget ?? DEFAULT_IMPORT_BUDGET,
    ...(overrides.encoding === undefined ? {} : { encoding: overrides.encoding }),
    progress: {
      report(fraction: number, note?: string): void {
        fractions.push(fraction);
        notes.push(note);
      },
    },
    // A microtask is enough under test: there is no message queue to drain, and
    // resolving immediately keeps the suite fast. The real worker supplies a
    // macrotask, which is what actually lets a queued cancel be delivered.
    yieldToEventLoop: (): Promise<void> => Promise.resolve(),
    decodeText: (): string => {
      // The STL readers scan bytes and never decode text. Throwing rather than

      // stubbing keeps that a fact rather than an assumption.

      throw new Error('the STL reader does not decode text');
    },
    fractions,
    notes,
  };
}
