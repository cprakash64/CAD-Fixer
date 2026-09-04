import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
import { buildAsciiStl, buildBinaryStl, triangleAt, UNIT_TRIANGLE } from './stl/fixtures';
import { valid3mf } from './threemf/zip-fixtures';
import { FormatEvidence, identifyFormat } from './identify';
import { ImportRefusal, refusalOf } from './import-errors';
import { MeshFormatId } from './formats';

/**
 * FORMAT IDENTIFICATION — the first decision made about untrusted bytes.
 *
 * Everything downstream depends on getting this right, and getting it wrong is
 * not a cosmetic failure: pointing the OBJ reader at a binary file, or the ZIP
 * reader at something that merely starts with `PK`, is how a parser is made to
 * read a grammar it was never given.
 *
 * The rule under test is one sentence: THE BYTES DECIDE, and the file name is
 * used only to break a tie the bytes could not settle and to report a
 * disagreement.
 */

function expectRefusal(run: () => unknown, code: AppErrorCode, reason: ImportRefusal): void {
  try {
    run();
  } catch (error) {
    if (!isAppError(error)) throw error;
    expect(error.code).toBe(code);
    expect(refusalOf(error)).toBe(reason);
    return;
  }
  throw new Error('expected a refusal');
}

const TRIANGLES = [UNIT_TRIANGLE, triangleAt(4), triangleAt(8)];
const OBJ = new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');

describe('the bytes decide', () => {
  it('identifies a binary STL by exact length arithmetic', () => {
    const result = identifyFormat(buildBinaryStl(TRIANGLES), 'part.stl');
    expect(result).toEqual({ formatId: MeshFormatId.Stl, evidence: FormatEvidence.BinaryStl });
  });

  it('identifies an ASCII STL by its keywords, not by the word solid alone', () => {
    const result = identifyFormat(buildAsciiStl(TRIANGLES), 'part.stl');
    expect(result.evidence).toBe(FormatEvidence.AsciiStl);

    // `solid` with nothing else is not an STL. It is the start of many things.
    expectRefusal(
      () => identifyFormat(new TextEncoder().encode('solid\n'), 'part.stl'),
      AppErrorCode.UnsupportedFile,
      ImportRefusal.UnknownFormat,
    );
  });

  it('prefers binary STL when a binary file also begins with the word solid', () => {
    /*
     * A REAL AND COMMON CASE: several CAD tools write "solid" into the 80-byte
     * header of a BINARY file. Identifying on the leading word alone hands the
     * file to the ASCII reader, which is the single most frequent STL bug in
     * the wild. The length arithmetic matching to the byte is not a
     * coincidence, so it wins.
     */
    const bytes = buildBinaryStl(TRIANGLES, { header: 'solid exported by something' });
    expect(identifyFormat(bytes, 'part.stl').evidence).toBe(FormatEvidence.BinaryStl);
  });

  it('identifies OBJ by records at the start of lines', () => {
    expect(identifyFormat(OBJ, 'part.obj')).toEqual({
      formatId: MeshFormatId.Obj,
      evidence: FormatEvidence.ObjRecords,
    });
  });

  it('identifies 3MF by the archive, not by the extension', async () => {
    const bytes = await valid3mf();
    expect(identifyFormat(bytes, 'part.3mf').evidence).toBe(FormatEvidence.ZipContainer);
  });

  it('does not read past the sniff window to decide', () => {
    // An OBJ record buried after megabytes of comment is not what the head of
    // the file says it is, and identification is bounded on purpose.
    const padded = new TextEncoder().encode(`${'# comment\n'.repeat(600)}v 0 0 0\nf 1 1 1\n`);
    expectRefusal(
      () => identifyFormat(padded, 'part.obj'),
      AppErrorCode.UnsupportedFile,
      ImportRefusal.UnknownFormat,
    );
  });
});

describe('the name only breaks ties and reports disagreement', () => {
  it('identifies correct content under a wrong-looking name it cannot support', () => {
    // No extension at all: the bytes still decide, and the import proceeds.
    expect(identifyFormat(OBJ, 'model').formatId).toBe(MeshFormatId.Obj);
    expect(identifyFormat(buildBinaryStl(TRIANGLES), 'model').formatId).toBe(MeshFormatId.Stl);
  });

  it('refuses a file whose name and contents disagree, rather than reinterpreting it', () => {
    expectRefusal(
      () => identifyFormat(OBJ, 'part.stl'),
      AppErrorCode.UnsupportedFile,
      ImportRefusal.ContentExtensionMismatch,
    );
    expectRefusal(
      () => identifyFormat(buildBinaryStl(TRIANGLES), 'part.3mf'),
      AppErrorCode.UnsupportedFile,
      ImportRefusal.ContentExtensionMismatch,
    );
  });

  it('names both sides of the disagreement so the user can act on it', () => {
    try {
      identifyFormat(OBJ, 'part.3mf');
      throw new Error('expected a refusal');
    } catch (error) {
      if (!isAppError(error)) throw error;
      expect(error.message).toContain('3MF');
      expect(error.message).toMatch(/rename/i);
      // And it says what it will NOT do.
      expect(error.message).toMatch(/will not guess/i);
    }
  });
});

describe('a binary STL of inexact length is judged by the STL reader', () => {
  /*
   * THE REGRESSION THIS PINS. When identification began gating every import, a
   * binary STL cut short by an interrupted copy stopped matching the exact
   * length arithmetic, matched no other grammar, and was refused as "CAD Fixer
   * could not recognise this file" — which is true of the identification step
   * and useless to the person holding a half-copied file.
   */
  const truncated = buildBinaryStl(TRIANGLES, { truncateTo: 84 + 50 });

  it('hands it to the STL reader when the name agrees', () => {
    expect(identifyFormat(truncated, 'part.stl')).toEqual({
      formatId: MeshFormatId.Stl,
      evidence: FormatEvidence.InexactBinaryStl,
    });
  });

  it('refuses it when nothing names it an STL', () => {
    /*
     * WITHOUT THE NAME THIS SIGNAL IS WORTHLESS, and that is the whole reason
     * it is gated. The four bytes at offset 80 of an arbitrary binary file are
     * usually an enormous number, so almost any unrecognisable binary satisfies
     * "fewer bytes than the count needs". Accepting that as evidence would make
     * every unknown binary a damaged STL.
     */
    expectRefusal(
      () => identifyFormat(truncated, 'part.bin'),
      AppErrorCode.UnsupportedFile,
      ImportRefusal.UnknownFormat,
    );
    expectRefusal(
      () => identifyFormat(truncated, 'part.3mf'),
      AppErrorCode.UnsupportedFile,
      ImportRefusal.UnknownFormat,
    );
  });

  it('still identifies an exact file exactly', () => {
    expect(identifyFormat(buildBinaryStl(TRIANGLES), 'part.stl').evidence).toBe(
      FormatEvidence.BinaryStl,
    );
  });

  it('also covers a complete stream with trailing bytes, which is not damage', () => {
    /*
     * Some tools append bytes after the last facet. That file is importable and
     * the reader reports the extra bytes as a warning — but its length fails
     * the same arithmetic a truncated file fails, so identification has to hand
     * it over rather than refusing it as unrecognisable.
     */
    const withTrailing = buildBinaryStl(TRIANGLES, { trailingBytes: 7 });
    expect(identifyFormat(withTrailing, 'part.stl')).toEqual({
      formatId: MeshFormatId.Stl,
      evidence: FormatEvidence.InexactBinaryStl,
    });
  });

  it('treats a header with a zero count as a complete, empty STL', () => {
    // `84 + 0 * 50 === 84` matches exactly, so this is not the inexact case at
    // all. Whether an empty STL is importable is the READER'S judgement.
    expect(identifyFormat(new Uint8Array(84), 'part.stl').evidence).toBe(FormatEvidence.BinaryStl);
  });

  it('does not treat a longer all-zero file as an STL of any kind', () => {
    // Zero declared triangles, 200 bytes: neither exact nor a plausible facet
    // stream, and nothing about it says STL.
    expectRefusal(
      () => identifyFormat(new Uint8Array(200), 'part.stl'),
      AppErrorCode.UnsupportedFile,
      ImportRefusal.UnknownFormat,
    );
  });
});

describe('hostile and degenerate inputs', () => {
  it('refuses an empty file', () => {
    expectRefusal(
      () => identifyFormat(new Uint8Array(0), 'part.stl'),
      AppErrorCode.UnsupportedFile,
      ImportRefusal.UnknownFormat,
    );
  });

  it('does not let a lucky byte sequence make a binary file look like text', () => {
    /*
     * The sniff replaces every non-printable byte with a space, so an OBJ-like
     * run buried in binary noise cannot form a record at the start of a line.
     */
    const noise = new Uint8Array(4096);
    for (let index = 0; index < noise.length; index += 1) noise[index] = (index * 37) % 256;
    noise.set(new TextEncoder().encode('v 0 0 0'), 100);
    expectRefusal(
      () => identifyFormat(noise, 'part.obj'),
      AppErrorCode.UnsupportedFile,
      ImportRefusal.UnknownFormat,
    );
  });

  it('treats anything with a ZIP signature as a 3MF candidate, and lets the reader judge', () => {
    // Identification does not open the archive. A `PK` file that is not a 3MF
    // is refused by the 3MF reader, which can say what is missing from it.
    const pk = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(identifyFormat(pk, 'part.3mf').formatId).toBe(MeshFormatId.ThreeMf);
  });
});
