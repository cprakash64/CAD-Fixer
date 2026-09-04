import { extractExtension } from './screening';
import { MeshFormatId } from './formats';
import { ImportRefusal, importUnsupported } from './import-errors';
import { looksLikeZip } from './threemf/zip';

/**
 * DECIDING WHAT A FILE ACTUALLY IS, once, before any parser runs.
 *
 * NEITHER SIGNAL ALONE IS TRUSTED. A filename is user-supplied text and says
 * nothing about content; a browser's MIME type for CAD files is inconsistent to
 * the point of uselessness and is not consulted here at all. So identification
 * looks at the BYTES, and uses the extension only to disambiguate the one case
 * bytes cannot settle — plain text that could be either OBJ or ASCII STL.
 *
 * WHEN NAME AND CONTENT DISAGREE, the file is REFUSED rather than reinterpreted.
 * Silently importing a `.3mf` that is really an OBJ would be guessing on the
 * user's behalf about a file they may not have meant to open; saying so lets
 * them rename it if that is what they intended. The one exception is a
 * `.obj`-named file whose bytes are unmistakably ZIP or binary STL, which is a
 * mislabelled file rather than an ambiguous one — and that is still a refusal,
 * for the same reason.
 */

export const FormatEvidence = {
  /** PK signature and a readable directory. */
  ZipContainer: 'zip-container',
  /** An 80-byte header plus a triangle count matching the file length exactly. */
  BinaryStl: 'binary-stl',
  /** Leading `solid` with STL keywords following. */
  AsciiStl: 'ascii-stl',
  /** OBJ records (`v`, `f`, `o`, …) at the start of lines. */
  ObjRecords: 'obj-records',
  /**
   * An 80-byte header and a non-zero triangle count, but a length that does not
   * match `84 + 50n` — a facet stream cut short, or one with bytes after it.
   *
   * Not identifying on its own: the four bytes at offset 80 of an arbitrary
   * binary file are usually an enormous number, so almost anything
   * unrecognisable satisfies the short case. It becomes a decision only when
   * the file is also NAMED as an STL. See `identifyFormat`.
   */
  InexactBinaryStl: 'inexact-binary-stl',
  /** Nothing recognisable. */
  Unrecognised: 'unrecognised',
} as const;

export type FormatEvidence = (typeof FormatEvidence)[keyof typeof FormatEvidence];

export interface FormatIdentification {
  readonly formatId: MeshFormatId;
  /** What the bytes showed. Recorded so a refusal can explain itself. */
  readonly evidence: FormatEvidence;
}

/** How many bytes the content sniff reads. Enough for a header and a few records. */
const SNIFF_BYTES = 4_096;

function sniffText(bytes: Uint8Array): string {
  const end = Math.min(bytes.byteLength, SNIFF_BYTES);
  let out = '';
  for (let at = 0; at < end; at += 1) {
    const byte = bytes[at] ?? 0;
    // Printable ASCII, tab and newline. Anything else becomes a space, so a
    // binary file cannot masquerade as text through a lucky byte sequence.
    out +=
      (byte >= 32 && byte < 127) || byte === 9 || byte === 10 || byte === 13
        ? String.fromCharCode(byte)
        : ' ';
  }
  return out;
}

/**
 * Whether the bytes are a binary STL, by the same arithmetic the STL detector
 * uses: 84 bytes of header plus exactly 50 per declared triangle.
 *
 * A length that matches to the byte is not a coincidence, which is what makes
 * this a reliable signal even when the file also begins with the word `solid`.
 */
function looksLikeBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 84) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(80, true);
  return 84 + declared * 50 === bytes.byteLength;
}

/**
 * Whether the bytes have a binary STL's SHAPE without its exact length.
 *
 * Two real cases, and the reader distinguishes them: a stream cut short by an
 * interrupted copy, and a complete stream followed by bytes some tools append.
 * The exact-length test above has already claimed every file that matches to
 * the byte, so anything reaching here is one or the other.
 */
function looksLikeInexactBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.byteLength <= 84) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(80, true);
  // A zero count is a complete, empty STL and matches the exact test instead.
  return declared !== 0;
}

const OBJ_RECORD = /^[ \t]*(v|vn|vt|f|o|g|usemtl|mtllib|s)[ \t]+\S/m;
const STL_ASCII = /^\s*solid\b/i;
const STL_ASCII_BODY = /^[ \t]*(facet\s+normal|outer\s+loop|vertex|endsolid)\b/im;

function gatherEvidence(bytes: Uint8Array): FormatEvidence {
  if (looksLikeZip(bytes)) return FormatEvidence.ZipContainer;
  if (looksLikeBinaryStl(bytes)) return FormatEvidence.BinaryStl;

  const text = sniffText(bytes);
  // ASCII STL is checked before OBJ: an STL body has no OBJ records in it, but
  // `solid` alone is a weak signal, so the body keywords must appear too.
  if (STL_ASCII.test(text) && STL_ASCII_BODY.test(text)) return FormatEvidence.AsciiStl;
  if (OBJ_RECORD.test(text)) return FormatEvidence.ObjRecords;
  // LAST, so a text file is never mistaken for a damaged binary one.
  if (looksLikeInexactBinaryStl(bytes)) return FormatEvidence.InexactBinaryStl;
  return FormatEvidence.Unrecognised;
}

function formatForExtension(fileName: string): MeshFormatId | undefined {
  switch (extractExtension(fileName)) {
    case '.stl':
      return MeshFormatId.Stl;
    case '.obj':
      return MeshFormatId.Obj;
    case '.3mf':
      return MeshFormatId.ThreeMf;
    default:
      return undefined;
  }
}

/** Which formats a given piece of evidence is compatible with. */
function formatsFor(evidence: FormatEvidence): readonly MeshFormatId[] {
  switch (evidence) {
    case FormatEvidence.ZipContainer:
      return [MeshFormatId.ThreeMf];
    case FormatEvidence.BinaryStl:
    case FormatEvidence.AsciiStl:
      return [MeshFormatId.Stl];
    case FormatEvidence.ObjRecords:
      return [MeshFormatId.Obj];
    /*
     * BOTH OF THESE MEAN "THE BYTES DID NOT DECIDE". The inexact case is listed
     * separately because it is far more specific than "unrecognised", and
     * `identifyFormat` uses that to hand a damaged STL to the STL reader, which
     * can say what is actually wrong with it.
     */
    case FormatEvidence.InexactBinaryStl:
    case FormatEvidence.Unrecognised:
      return [];
  }
}

/**
 * Identifies a file, or refuses it.
 *
 * `fileName` is advisory and is used only to break the text ambiguity and to
 * report a mismatch. The decision itself comes from the bytes.
 */
export function identifyFormat(bytes: Uint8Array, fileName: string): FormatIdentification {
  const evidence = gatherEvidence(bytes);
  const claimed = formatForExtension(fileName);
  const compatible = formatsFor(evidence);

  if (compatible.length === 0) {
    /*
     * A DAMAGED FILE LOOKS EXACTLY LIKE AN UNIDENTIFIABLE ONE, and the two
     * deserve different answers. A binary STL whose facet stream was cut short
     * — an interrupted download, a partial copy — fails the length arithmetic
     * and matches no other grammar, so it would be refused as "CAD Fixer could
     * not recognise this file", which tells the user nothing about the one
     * thing that is actually wrong with it. A complete stream with trailing
     * bytes fails the same arithmetic and is not damaged at all: the reader
     * imports it and reports the extra bytes.
     *
     * THIS IS THE SANCTIONED USE OF THE NAME. It breaks a tie the bytes could
     * not, and it decides only WHICH READER RUNS — never that the file is
     * valid. The STL reader makes that judgement, and for a truncated file it
     * refuses with the precise reason.
     */
    if (evidence === FormatEvidence.InexactBinaryStl && claimed === MeshFormatId.Stl) {
      return { formatId: MeshFormatId.Stl, evidence };
    }

    throw importUnsupported(
      ImportRefusal.UnknownFormat,
      'CAD Fixer could not recognise this file. It reads STL, OBJ and 3MF.',
      { evidence, claimed: claimed ?? 'none' },
    );
  }

  const detected = compatible[0];
  if (detected === undefined) {
    throw importUnsupported(
      ImportRefusal.UnknownFormat,
      'CAD Fixer could not recognise this file. It reads STL, OBJ and 3MF.',
      { evidence },
    );
  }

  if (claimed !== undefined && !compatible.includes(claimed)) {
    /*
     * NAME AND CONTENT DISAGREE. Refused rather than reinterpreted: a `.3mf`
     * whose bytes are an OBJ is either a mistake or something the user did not
     * intend to open, and quietly importing it as OBJ decides that for them.
     * Naming both sides lets them rename the file if that is what they meant.
     */
    throw importUnsupported(
      ImportRefusal.ContentExtensionMismatch,
      `This file is named as ${claimed.toUpperCase()} but its contents are not ${claimed.toUpperCase()}. CAD Fixer will not guess which is right — rename it if the contents are correct.`,
      { claimed, evidence, detected },
    );
  }

  return { formatId: detected, evidence };
}
