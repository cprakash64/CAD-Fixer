import { throwIfCancelled } from '@cadfixer/shared';
import type { FormatReadContext } from '../context';
import {
  ImportRefusal,
  importMalformed,
  importTooLarge,
  importUnsupported,
} from '../import-errors';
import { type ObjLimits } from './limits';

/** Production OBJ record semantics, shared by import and bounded export read-back. */
export interface ObjRecordVisitor {
  vertex(x: number, y: number, z: number): void;
  face(a: number, b: number, c: number): void;
  object(name: string | undefined, firstFace: number): void;
  group(name: string, material: string | undefined, firstFace: number): void;
  materialUse(): void;
  materialLibrary(name: string | undefined): void;
}

const FACES_PER_BATCH = 32_768;
/**
 * One face corner: a position index, then optionally a texture index and a
 * normal index, each an optionally signed decimal integer, either of the
 * latter possibly empty. Bounded by the token length the tokeniser already
 * enforces, and linear — no nested quantifier can backtrack.
 */
const OBJ_CORNER = /^[+-]?\d+(?:\/[+-]?\d*){0,2}$/;
/** A decimal number, optionally signed and with an exponent — what OBJ writes. */
const OBJ_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * "an x value", "a y value", "a normal x value": the article the value's name
 * takes when read aloud. Of the names this reader uses, only a bare "x" does.
 */
function article(word: string): string {
  return word === 'x' ? 'an' : 'a';
}

/** A finite number, or a refusal naming the token that was not one. */
function readFinite(token: string | undefined, line: number, what: string): number {
  if (token === undefined || token === '') {
    throw importMalformed(
      ImportRefusal.ObjMalformedNumber,
      `This OBJ file has ${article(what)} ${what} value missing on line ${String(line)}.`,
      { line, what },
    );
  }
  const value = Number(token);
  /*
   * `Number` rather than `parseFloat`, deliberately. `parseFloat('1abc')` is 1,
   * which would silently accept a corrupt token; `Number('1abc')` is NaN. Both
   * accept 'Infinity' and 'NaN' as words, and neither has a bounding box or an
   * exact predicate, so both are refused below.
   */
  if (!Number.isFinite(value)) {
    throw importMalformed(
      ImportRefusal.ObjNonFinite,
      `This OBJ file has ${article(what)} ${what} value Pybrix cannot use on line ${String(line)}.`,
      { line, what, token: token.slice(0, 64) },
    );
  }
  /*
   * LEXICAL, AS FACE CORNERS ARE (PR-01). `Number` also reads `0x10` as sixteen,
   * `0b11` as three and `0o7` as seven; OBJ numbers are decimal, so those are
   * malformed tokens, and reading them imported coordinates the file never
   * stated.
   */
  if (!OBJ_DECIMAL.test(token)) {
    throw importMalformed(
      ImportRefusal.ObjMalformedNumber,
      `This OBJ file has ${article(what)} ${what} value that is not a decimal number on line ${String(line)}.`,
      { line, what, token: token.slice(0, 64) },
    );
  }
  return value;
}

/**
 * Splits a whitespace-separated record without allocating for the whole line.
 *
 * `line.split(/\s+/)` on a 65,536-character line allocates an array of every
 * token whether the caller wants them or not. This yields them.
 */
function* tokens(line: string, from: number): Generator<string, undefined, undefined> {
  let index = from;
  const length = line.length;
  while (index < length) {
    while (index < length && isSpace(line.charCodeAt(index))) index += 1;
    if (index >= length) return;
    const start = index;
    while (index < length && !isSpace(line.charCodeAt(index))) index += 1;
    yield line.slice(start, index);
  }
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 13;
}

/** A piece boundary is invisible, including a CRLF or a record split across pieces. */
export async function readObjRecordStream(
  pieces: AsyncIterable<string>,
  limits: ObjLimits,
  context: FormatReadContext,
  visitor: ObjRecordVisitor,
  onConsumed?: (characters: number) => void,
): Promise<void> {
  let vertexCount = 0;
  let objectCount = 0;
  let groupCount = 0;
  let currentMaterial: string | undefined;
  let faceCount = 0;
  let lineNumber = 0;
  let pending = '';
  let consumed = 0;
  const batch = { needsYield: false };
  const record = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    lineNumber += 1;
    if (line.length > limits.maxLineLength)
      throw importTooLarge(
        ImportRefusal.ObjLineTooLong,
        `This OBJ file has a line longer than Pybrix will read (line ${String(lineNumber)}).`,
        { line: lineNumber, length: line.length, limit: limits.maxLineLength },
      );
    if (line.length > 0) {
      let at = 0;
      while (at < line.length && isSpace(line.charCodeAt(at))) at += 1;
      const first = line.charCodeAt(at);

      // Blank lines and comments, cheapest checks first.
      if (at < line.length && first !== 35 /* # */) {
        const iterator = tokens(line, at);
        const keyword: string | undefined = iterator.next().value;

        switch (keyword) {
          case 'v': {
            const x = readFinite(nextToken(iterator), lineNumber, 'x');
            const y = readFinite(nextToken(iterator), lineNumber, 'y');
            const z = readFinite(nextToken(iterator), lineNumber, 'z');
            vertexCount += 1;
            visitor.vertex(x, y, z);
            if (vertexCount > limits.maxVertices) {
              throw importTooLarge(
                ImportRefusal.ObjTooManyVertices,
                'This OBJ file contains more vertices than Pybrix will hold.',
                { limit: limits.maxVertices },
              );
            }
            break;
          }

          /*
           * `vn` and `vt` are PARSED FOR VALIDITY AND DISCARDED.
           *
           * ADR 0013 froze normals and UVs as "parsed, not authoritative;
           * recomputed as today". Stored normals frequently disagree with
           * winding order — the same reason STL's facet normals are dropped —
           * and a UV has no bearing on topology, repair or export at this
           * stage. Retaining them would mean carrying buffers no code reads and
           * claiming a fidelity the product does not have. They are still
           * validated, so a file with a NaN normal is refused rather than
           * quietly accepted.
           */
          case 'vn': {
            readFinite(nextToken(iterator), lineNumber, 'normal x');
            readFinite(nextToken(iterator), lineNumber, 'normal y');
            readFinite(nextToken(iterator), lineNumber, 'normal z');
            break;
          }
          case 'vt': {
            readFinite(nextToken(iterator), lineNumber, 'texture u');
            const v = nextToken(iterator);
            // `vt` legally carries one, two or three values.
            if (v !== undefined) readFinite(v, lineNumber, 'texture v');
            break;
          }

          case 'o': {
            const name = readName(iterator, limits);
            objectCount += 1;
            visitor.object(name, faceCount);
            if (objectCount > limits.maxObjects) {
              throw importTooLarge(
                ImportRefusal.ObjTooManyObjects,
                'This OBJ file declares more objects than Pybrix will hold.',
                { limit: limits.maxObjects },
              );
            }
            break;
          }

          case 'g': {
            const name = readName(iterator, limits) ?? '';
            groupCount += 1;
            visitor.group(name, currentMaterial, faceCount);
            if (groupCount > limits.maxGroups) {
              throw importTooLarge(
                ImportRefusal.ObjTooManyGroups,
                'This OBJ file declares more groups than Pybrix will hold.',
                { limit: limits.maxGroups },
              );
            }
            break;
          }

          case 'usemtl': {
            currentMaterial = readName(iterator, limits);
            visitor.materialUse();
            // A material change starts a new run of faces, which is what a
            // `MeshGroup` records. Without this a file that never says `g`
            // would lose its material boundaries entirely.
            groupCount += 1;
            visitor.group(currentMaterial ?? '', currentMaterial, faceCount);
            break;
          }

          case 'mtllib': {
            /*
             * RECORDED AS TEXT. NEVER OPENED.
             *
             * No file is read, no path is resolved, no picker is raised and no
             * request is made. A standalone OBJ therefore cannot cause any file
             * or network access, which is the property that made a single-file
             * picker sufficient for this stage — see ADR 0013.
             */
            visitor.materialLibrary(readName(iterator, limits));
            break;
          }

          case 'f': {
            faceCount += 1;
            const corners: number[] = [];
            readFace(iterator, corners, vertexCount, lineNumber, limits);
            visitor.face(corners[0] ?? 0, corners[1] ?? 0, corners[2] ?? 0);
            if (faceCount > limits.maxFaces) {
              throw importTooLarge(
                ImportRefusal.ObjTooManyFaces,
                'This OBJ file contains more faces than Pybrix will hold.',
                { limit: limits.maxFaces },
              );
            }
            if (faceCount % FACES_PER_BATCH === 0) batch.needsYield = true;
            break;
          }

          default:
            // Unknown records are SKIPPED, not refused. OBJ is an extensible
            // text format and files in the wild carry `s`, `l`, `p`, `mg` and
            // vendor records; refusing a file for a line that says nothing
            // about geometry would reject valid models for no benefit.
            break;
        }
      }
    }
  };
  for await (const piece of pieces) {
    throwIfCancelled(context.cancellation);
    let cursor = 0;
    while (cursor < piece.length) {
      const end = piece.indexOf('\n', cursor);
      if (end === -1) {
        pending += piece.slice(cursor);
        if (pending.length > limits.maxLineLength + 1)
          throw importTooLarge(
            ImportRefusal.ObjLineTooLong,
            'This OBJ file has a line longer than Pybrix will read.',
            { line: lineNumber + 1, length: pending.length, limit: limits.maxLineLength },
          );
        break;
      }
      record(pending + piece.slice(cursor, end));
      pending = '';
      cursor = end + 1;
      if (batch.needsYield) {
        batch.needsYield = false;
        throwIfCancelled(context.cancellation);
        await context.yieldToEventLoop();
        throwIfCancelled(context.cancellation);
        onConsumed?.(consumed + cursor);
      }
    }
    consumed += piece.length;
    onConsumed?.(consumed);
  }
  record(pending);
  throwIfCancelled(context.cancellation);
}
/** The next token, typed. `Generator.next().value` is `any` without this. */
function nextToken(iterator: Generator<string, undefined, undefined>): string | undefined {
  const next = iterator.next();
  return next.done === true ? undefined : next.value;
}

function readName(
  iterator: Generator<string, undefined, undefined>,
  limits: ObjLimits,
): string | undefined {
  const parts: string[] = [];
  for (const token of iterator) {
    parts.push(token);
    if (parts.join(' ').length >= limits.maxNameLength) break;
  }
  if (parts.length === 0) return undefined;
  // TRUNCATED, not refused. A long name is a display nuisance, not a
  // structural fault, and refusing a whole model over one would be the wrong
  // trade. It is text throughout and is never treated as markup or as a path.
  return parts.join(' ').slice(0, limits.maxNameLength);
}

/** Reads one `f` record, refusing anything that is not exactly a triangle. */
function readFace(
  iterator: Generator<string, undefined, undefined>,
  out: number[],
  vertexCount: number,
  line: number,
  limits: ObjLimits,
): void {
  const corners: string[] = [];
  for (const token of iterator) {
    corners.push(token);
    if (corners.length > limits.maxFaceVertices) {
      /*
       * THE POLYGON DECISION, enforced rather than worked around. Reading stops
       * at the first corner past the limit: a hostile `f` with a million
       * corners costs four tokens, not a million.
       */
      throw importUnsupported(
        ImportRefusal.ObjPolygonUnsupported,
        'Pybrix currently supports triangle faces in OBJ files. This file contains a face with more than three corners, and Pybrix will not split it into triangles, because doing so would invent geometry the file does not describe.',
        { line },
      );
    }
  }
  if (corners.length < 3) {
    throw importMalformed(
      ImportRefusal.ObjTooFewFaceVertices,
      `This OBJ file has a face with fewer than three corners on line ${String(line)}.`,
      { line, corners: corners.length },
    );
  }

  for (const corner of corners) {
    // v, v/vt, v//vn and v/vt/vn all begin with the position index.
    const slash = corner.indexOf('/');
    const token = slash === -1 ? corner : corner.slice(0, slash);
    /*
     * THE CORNER IS CHECKED LEXICALLY BEFORE ANY PART OF IT IS COERCED — Stage
     * 6D-A4, the reasoning A3 applied to 3MF transform tokens. `Number` reads
     * `0x2` as two, `1e0` as one and `1.0` as one, none of which is an OBJ
     * index; and the texture and normal components were never looked at, so
     * `f 1/x 2 3` imported. Those components are still not IMPORTED — CAD
     * Fixer reads positions only — but a corner that is not one of OBJ's four
     * shapes is not a corner. An EMPTY component (`1/`, `1//`) is tolerated,
     * as it always was, because writers emit it.
     */
    if (token.length > 0 && !OBJ_CORNER.test(corner)) {
      throw importMalformed(
        ImportRefusal.ObjBadIndex,
        `This OBJ file has a face index Pybrix cannot read on line ${String(line)}.`,
        { line, token: corner.slice(0, 64) },
      );
    }
    if (token.length === 0) {
      /*
       * `f /1/1` — a corner that gives a texture and a normal and no position.
       * Reported as what it is. `Number('')` is 0, so without this the refusal
       * came out as "uses vertex index 0", which describes a file that says
       * something different from the one the user actually has.
       */
      throw importMalformed(
        ImportRefusal.ObjMissingPositionIndex,
        `This OBJ file has a face corner with no vertex position on line ${String(line)}.`,
        { line, corner: corner.slice(0, 64) },
      );
    }
    const parsed = Number(token);
    if (!Number.isInteger(parsed)) {
      throw importMalformed(
        ImportRefusal.ObjBadIndex,
        `This OBJ file has a face index Pybrix cannot read on line ${String(line)}.`,
        { line, token: token.slice(0, 64) },
      );
    }
    if (parsed === 0) {
      // OBJ indices are one-based; zero is not a vertex, it is a malformed file.
      throw importMalformed(
        ImportRefusal.ObjZeroIndex,
        `This OBJ file uses vertex index 0 on line ${String(line)}. OBJ indices start at 1.`,
        { line },
      );
    }
    const index = parsed > 0 ? parsed - 1 : vertexCount + parsed;
    if (index < 0 || index >= vertexCount) {
      throw importMalformed(
        ImportRefusal.ObjBadIndex,
        `This OBJ file references vertex ${String(parsed)} on line ${String(line)}, which does not exist.`,
        { line, index: parsed, vertexCount },
      );
    }
    out.push(index);
  }
}
