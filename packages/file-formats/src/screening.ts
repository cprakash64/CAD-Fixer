import { SUPPORTED_EXTENSIONS, SUPPORTED_FORMATS, type MeshFormatId } from './formats';

/**
 * UI-BOUNDARY FILENAME SCREENING — NOT PARSER VALIDATION.
 *
 * This module answers one narrow question: "should the interface even offer to
 * open this?" It looks at a filename and a declared byte size. It does not read
 * a single byte of file content, and it establishes no trust whatsoever.
 *
 * A file that passes screening is still fully untrusted input. A `.stl`
 * extension is an unverified claim by the user's filesystem; the real decision
 * belongs to a future parser that must validate magic bytes, declared counts
 * against actual buffer length, and every offset it dereferences, and must
 * treat every field as hostile.
 *
 * The purpose of screening is usability — telling someone their `.zip` will not
 * work before they wait for an import — plus a cheap, declared-size guard so an
 * absurdly large file is refused before any buffer is allocated.
 */

export const FileRejectionReason = {
  /** Filename has no extension to screen on. */
  MissingExtension: 'MISSING_EXTENSION',
  /** Extension is not one of the supported mesh formats. */
  UnsupportedExtension: 'UNSUPPORTED_EXTENSION',
  /** Declared size exceeds the configured intake budget. */
  TooLarge: 'TOO_LARGE',
  /** Declared size is zero. */
  Empty: 'EMPTY',
} as const;

export type FileRejectionReason = (typeof FileRejectionReason)[keyof typeof FileRejectionReason];

export interface FileAccepted {
  readonly accepted: true;
  /** The format claimed by the extension. Unverified. */
  readonly claimedFormat: MeshFormatId;
  readonly extension: string;
}

export interface FileRejected {
  readonly accepted: false;
  readonly reason: FileRejectionReason;
  /** Display-ready explanation. Contains no file content. */
  readonly message: string;
}

export type FileScreeningResult = FileAccepted | FileRejected;

export interface FileScreeningInput {
  readonly name: string;
  /** Byte length as declared by the browser. Not yet read or verified. */
  readonly size: number;
}

export interface FileScreeningOptions {
  /**
   * Largest declared size the interface will offer to open.
   *
   * This is an intake guard, not a memory budget: a mesh expands well beyond its
   * encoded size once parsed. The real budget belongs to the geometry runtime.
   */
  readonly maxBytes?: number;
}

/** 512 MiB. Comfortably above realistic print files while refusing obvious abuse. */
export const DEFAULT_MAX_INTAKE_BYTES = 512 * 1024 * 1024;

const EXTENSION_TO_FORMAT: ReadonlyMap<string, MeshFormatId> = new Map(
  SUPPORTED_FORMATS.flatMap((format) =>
    format.extensions.map((extension) => [extension, format.id] as const),
  ),
);

/**
 * Extracts a lower-case, dot-prefixed extension.
 *
 * Path separators are stripped first because some drag-and-drop sources supply
 * a relative path rather than a bare filename. Returns `undefined` for names
 * with no extension and for dotfiles such as `.stl`, where the leading dot is
 * part of the name rather than an extension marker.
 */
export function extractExtension(fileName: string): string | undefined {
  const baseName = fileName.split(/[\\/]/).pop() ?? '';
  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) return undefined;
  return baseName.slice(dotIndex).toLowerCase();
}

export function screenFile(
  input: FileScreeningInput,
  options: FileScreeningOptions = {},
): FileScreeningResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_INTAKE_BYTES;
  const extension = extractExtension(input.name);

  if (extension === undefined) {
    return {
      accepted: false,
      reason: FileRejectionReason.MissingExtension,
      message: `Files need a supported extension (${SUPPORTED_EXTENSIONS.join(', ')}).`,
    };
  }

  const claimedFormat = EXTENSION_TO_FORMAT.get(extension);
  if (claimedFormat === undefined) {
    return {
      accepted: false,
      reason: FileRejectionReason.UnsupportedExtension,
      message: `${extension} files are not supported. Supported formats: ${SUPPORTED_EXTENSIONS.join(', ')}.`,
    };
  }

  if (input.size <= 0) {
    return {
      accepted: false,
      reason: FileRejectionReason.Empty,
      message: 'That file is empty.',
    };
  }

  if (input.size > maxBytes) {
    return {
      accepted: false,
      reason: FileRejectionReason.TooLarge,
      message: `That file is larger than the ${formatMebibytes(maxBytes)} intake limit.`,
    };
  }

  return { accepted: true, claimedFormat, extension };
}

function formatMebibytes(bytes: number): string {
  return `${String(Math.round(bytes / (1024 * 1024)))} MiB`;
}
