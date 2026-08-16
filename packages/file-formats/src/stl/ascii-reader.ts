import {
  diagnostic,
  internalError,
  malformedFile,
  throwIfCancelled,
  type Diagnostic,
} from '@cadfixer/shared';
import { createIndexArray, createPositionArray, type MeshGroup } from '@cadfixer/mesh-core';
import { checkAllocation, planAllocation, type ImportBudget } from '../budget';
import type { FormatReadContext } from '../context';
import { ByteScanner, StlKeyword } from './detect';
import { StlWarningCode, type StlRawGeometry } from './warnings';

/**
 * ASCII STL reader.
 *
 * TWO PASSES, ON PURPOSE. An ASCII STL does not declare how many facets it
 * contains, so the count has to come from somewhere. The alternative — growing
 * arrays and copying as they fill — doubles peak memory at exactly the moment
 * memory is tightest, and makes it impossible to check the budget before
 * committing to an allocation.
 *
 * Instead pass one tokenises the file and counts facets without parsing any
 * numbers, which is the cheap half of the work. The budget is then checked
 * against a MEASURED count rather than a declared one, and pass two fills
 * exactly-sized arrays. Peak memory is the input plus the final arrays, with no
 * intermediate copy.
 *
 * No regular expressions are used and no full-file string is ever created. The
 * scanner walks bytes with a monotonically advancing cursor, so parsing is
 * linear in file length and cannot be made to backtrack.
 *
 * DATA INTEGRITY: as with the binary reader, nothing is welded, dropped,
 * reoriented, or rescaled.
 */

const BYTES_PER_PROGRESS_UPDATE = 4 * 1024 * 1024;

/**
 * Smallest number of bytes a complete ASCII facet can occupy.
 *
 * `facet normal 0 0 0 outer loop vertex 0 0 0 vertex 0 0 0 vertex 0 0 0 endloop
 * endfacet` with single-space separators. Used as a physical upper bound on how
 * many facets an input of a given size could possibly contain.
 */
const MIN_ASCII_FACET_BYTES = 85;

export async function readAsciiStl(
  bytes: Uint8Array,
  context: FormatReadContext,
): Promise<StlRawGeometry> {
  const budget = context.budget;
  const measuredTriangles = await countFacets(bytes, context, budget);

  if (measuredTriangles === 0) {
    throw malformedFile('This STL file contains no triangles, so there is no model to load.', {
      inputBytes: bytes.byteLength,
    });
  }

  // Second line of defence on the same amplification: even a count of genuine
  // `facet normal` pairs cannot exceed what the file has room to encode, since
  // a complete facet cannot be written in fewer than MIN_ASCII_FACET_BYTES.
  const physicalCeiling = Math.ceil(bytes.byteLength / MIN_ASCII_FACET_BYTES) + 1;
  if (measuredTriangles > physicalCeiling) {
    throw malformedFile('This STL file declares more facets than it has room to contain.', {
      countedFacets: measuredTriangles,
      physicalCeiling,
      inputBytes: bytes.byteLength,
    });
  }

  const plan = planAllocation(measuredTriangles, bytes.byteLength);
  const rejection = checkAllocation(plan, budget, 'stl/import/ascii', bytes.byteLength);
  if (rejection) throw rejection;

  return await parseFacets(bytes, measuredTriangles, context, budget);
}

/* ----------------------------------------------------------------- pass 1 -- */

/**
 * Counts `facet normal` pairs.
 *
 * Both `solid` and `endsolid` are followed by a free-text name, and those names
 * are skipped rather than tokenised, so a solid called "facet" cannot inflate
 * the count. The `normal` keyword is required so that a run of bare `facet`
 * tokens cannot either.
 *
 * Structure is not fully validated here — pass two is authoritative — but the
 * count it produces is an upper bound that pass two is checked against.
 */
async function countFacets(
  bytes: Uint8Array,
  context: FormatReadContext,
  budget: ImportBudget,
): Promise<number> {
  const scanner = new ByteScanner(bytes, budget.maxTokenBytes);
  let facets = 0;
  let nextProgressAt = BYTES_PER_PROGRESS_UPDATE;

  if (!scanner.matchKeyword(StlKeyword.Solid)) {
    throw malformedFile('This file does not begin with an STL "solid" declaration.', {
      line: scanner.line,
    });
  }
  scanner.skipRestOfLine();

  while (!scanner.isAtEnd()) {
    if (scanner.offset >= nextProgressAt) {
      throwIfCancelled(context.cancellation);
      // Pass one is roughly a third of the work; progress is reported in the
      // first third of the range so it never goes backwards when pass two
      // starts.
      context.progress.report((scanner.offset / bytes.byteLength) * 0.33, 'scanning');
      await context.yieldToEventLoop();
      throwIfCancelled(context.cancellation);
      nextProgressAt = scanner.offset + BYTES_PER_PROGRESS_UPDATE;
    }

    if (scanner.matchKeyword(StlKeyword.Facet)) {
      // A bare `facet` token is not evidence of a facet. Counting one would let
      // a file consisting of the word "facet" repeated drive an allocation
      // roughly eight times its own size — a ~77 MB file could commit ~613 MB
      // of typed arrays before pass two rejected it on the very next token.
      // Requiring `normal` costs one keyword compare and makes the measured
      // count mean something.
      if (!scanner.matchKeyword(StlKeyword.Normal)) continue;
      facets += 1;
      if (facets > budget.maxTriangles) {
        // Stop counting the moment the budget is blown. Continuing would mean
        // scanning an arbitrarily large hostile file to produce a number that
        // is only going to be rejected.
        const plan = planAllocation(facets, bytes.byteLength);
        const rejection = checkAllocation(plan, budget, 'stl/import/ascii', bytes.byteLength);
        throw (
          rejection ??
          internalError('ASCII facet count exceeded the budget without producing a rejection.')
        );
      }
      continue;
    }

    // Both `solid` and `endsolid` are followed by a free-text name, and that
    // name has to be skipped rather than tokenised. Missing the `endsolid` case
    // meant a file whose solid is called "facet" — or any name merely
    // containing that word — had its facet count inflated here, disagreed with
    // pass two, and was rejected with an internal error. A perfectly ordinary
    // file, refused. Regression tests in stl-reader.test.ts.
    if (scanner.matchKeyword(StlKeyword.Solid) || scanner.matchKeyword(StlKeyword.EndSolid)) {
      scanner.skipRestOfLine();
      continue;
    }

    // Any other token is consumed without interpretation; pass two decides
    // whether the structure is legal.
    const range = scanner.peekTokenRange();
    if (range === undefined) {
      throw malformedFile(
        'This STL file contains a token that is too long to be valid, so it was not read.',
        { line: scanner.line, maxTokenBytes: budget.maxTokenBytes },
      );
    }
    scanner.consumeTo(range.end);
  }

  return facets;
}

/* ----------------------------------------------------------------- pass 2 -- */

async function parseFacets(
  bytes: Uint8Array,
  expectedTriangles: number,
  context: FormatReadContext,
  budget: ImportBudget,
): Promise<StlRawGeometry> {
  const scanner = new ByteScanner(bytes, budget.maxTokenBytes);
  const positions = createPositionArray(expectedTriangles * 9);
  const indices = createIndexArray(expectedTriangles * 3);
  const groups: MeshGroup[] = [];
  const warnings: Diagnostic[] = [];

  let triangle = 0;
  let solidCount = 1;
  let sawEndSolid = false;
  let groupStartIndex = 0;
  let groupName = '';
  let nextProgressAt = BYTES_PER_PROGRESS_UPDATE;

  const expect = (keyword: Uint8Array, description: string): void => {
    if (!scanner.matchKeyword(keyword)) {
      throw malformedFile(`This STL file is malformed: expected ${description}.`, {
        line: scanner.line,
        byteOffset: scanner.offset,
        triangleIndex: triangle,
      });
    }
  };

  const readCoordinate = (axis: string): number => {
    const token = scanner.readNumber();
    if (token === undefined) {
      throw malformedFile(`This STL file is malformed: expected a number for ${axis}.`, {
        line: scanner.line,
        byteOffset: scanner.offset,
        triangleIndex: triangle,
      });
    }
    // Finiteness is checked TWICE, against two different types. `token.finite`
    // is double finiteness; positions are stored as float32, and a literal like
    // 1e39 is a perfectly finite double that becomes Infinity the moment it is
    // narrowed. Checking only the double would let an infinity into the
    // canonical mesh through the ASCII path while the binary path — which reads
    // float32 directly — correctly rejected it.
    //
    // The offending literal is deliberately NOT put in `details`: it is content
    // from the user's file, and `details` is the field that would be
    // transmitted if telemetry were ever added. The axis, line, and triangle
    // index locate the defect without quoting the model.
    if (!token.finite || !Number.isFinite(Math.fround(token.value))) {
      throw malformedFile(
        'This STL file contains a vertex coordinate that is not a finite number.',
        {
          line: scanner.line,
          triangleIndex: triangle,
          axis,
        },
      );
    }
    return token.value;
  };

  const closeGroup = (): void => {
    const indexCount = triangle * 3 - groupStartIndex;
    if (indexCount > 0) {
      groups.push({ name: groupName, indexOffset: groupStartIndex, indexCount });
    }
    groupStartIndex = triangle * 3;
  };

  if (!scanner.matchKeyword(StlKeyword.Solid)) {
    throw malformedFile('This file does not begin with an STL "solid" declaration.', {
      line: scanner.line,
    });
  }
  groupName = readSolidName(scanner, bytes);

  while (!scanner.isAtEnd()) {
    if (scanner.offset >= nextProgressAt) {
      throwIfCancelled(context.cancellation);
      context.progress.report(0.33 + (scanner.offset / bytes.byteLength) * 0.67, 'parsing');
      await context.yieldToEventLoop();
      throwIfCancelled(context.cancellation);
      nextProgressAt = scanner.offset + BYTES_PER_PROGRESS_UPDATE;
    }

    if (scanner.matchKeyword(StlKeyword.EndSolid)) {
      scanner.skipRestOfLine();
      sawEndSolid = true;
      closeGroup();
      if (scanner.isAtEnd()) break;
      // A second solid may follow in the same file.
      expect(StlKeyword.Solid, '"solid" or end of file after "endsolid"');
      solidCount += 1;
      groupName = readSolidName(scanner, bytes);
      sawEndSolid = false;
      continue;
    }

    expect(StlKeyword.Facet, '"facet" or "endsolid"');
    expect(StlKeyword.Normal, '"normal" after "facet"');
    // The stored normal is read and discarded: it is advisory, frequently wrong
    // in real files, and never used as geometry. It must still be
    // well-formed for the file to be structurally valid.
    for (const axis of ['normal x', 'normal y', 'normal z']) {
      if (scanner.readNumber() === undefined) {
        throw malformedFile(`This STL file is malformed: expected a number for ${axis}.`, {
          line: scanner.line,
          triangleIndex: triangle,
        });
      }
    }

    expect(StlKeyword.Outer, '"outer" after the facet normal');
    expect(StlKeyword.Loop, '"loop" after "outer"');

    if (triangle >= expectedTriangles) {
      // Malformed, not internal: the two passes read the same untrusted bytes,
      // so a disagreement is a property of the file. Reporting it as an
      // internal error would tell the user CAD Fixer is broken when their file
      // is.
      throw malformedFile('This STL file has inconsistent structure and could not be read.', {
        line: scanner.line,
        expectedTriangles,
        triangleIndex: triangle,
      });
    }

    const positionBase = triangle * 9;
    const vertexBase = triangle * 3;
    for (let corner = 0; corner < 3; corner += 1) {
      expect(StlKeyword.Vertex, `"vertex" (corner ${String(corner + 1)} of 3)`);
      const slot = positionBase + corner * 3;
      positions[slot] = readCoordinate('x');
      positions[slot + 1] = readCoordinate('y');
      positions[slot + 2] = readCoordinate('z');
      indices[vertexBase + corner] = vertexBase + corner;
    }

    // A fourth `vertex` here means the facet is not a triangle. STL has no
    // polygon facets, so this is malformed rather than something to triangulate.
    expect(StlKeyword.EndLoop, '"endloop" after exactly three vertices');
    expect(StlKeyword.EndFacet, '"endfacet" after "endloop"');
    triangle += 1;
  }

  if (triangle !== expectedTriangles) {
    throw malformedFile('This STL file has inconsistent structure and could not be read.', {
      line: scanner.line,
      expectedTriangles,
      parsed: triangle,
    });
  }

  if (!sawEndSolid) {
    closeGroup();
    warnings.push(
      diagnostic(
        StlWarningCode.MissingEndSolid,
        'This file ends without an "endsolid" line. All complete facets were read.',
        { line: scanner.line },
      ),
    );
  }

  if (solidCount > 1) {
    warnings.push(
      diagnostic(
        StlWarningCode.MultipleSolids,
        'This file contains more than one solid. They were kept as separate groups.',
        { solidCount },
      ),
    );
  }

  throwIfCancelled(context.cancellation);
  context.progress.report(1, 'parsing');

  return { positions, indices, triangleCount: triangle, warnings, groups };
}

/**
 * Consumes the remainder of a `solid` line as its name.
 *
 * The name is decoded here — bounded by one line — because it is displayed and
 * round-tripped. Control characters are stripped so a crafted name cannot
 * disturb terminal output or later ASCII export.
 */
function readSolidName(scanner: ByteScanner, bytes: Uint8Array): string {
  const start = scanner.offset;
  scanner.skipRestOfLine();
  const end = scanner.offset;

  let name = '';
  for (let index = start; index < end && name.length < 128; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) break;
    // Printable ASCII only.
    if (byte >= 32 && byte < 127) name += String.fromCharCode(byte);
    else if (byte === 9) name += ' ';
  }
  return name.trim();
}
