/**
 * Local file download.
 *
 * Entirely browser-local: a `Blob` is created from bytes already in memory and
 * handed to the browser's own download mechanism. No network request is made,
 * no server is involved, and the model never leaves the machine. There is no
 * gating of any kind — export is open.
 */

/**
 * Saves `bytes` as `fileName`.
 *
 * The object URL is revoked on the next task rather than immediately: revoking
 * synchronously after `click()` can cancel the download in some browsers, and
 * never revoking would pin the whole buffer in memory for the life of the
 * document — which for a 400 MB export is not a rounding error.
 */
export function downloadBytes(bytes: Uint8Array, fileName: string, mimeType: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/** Characters Windows reserves in filenames. */
const RESERVED_FILENAME_CHARACTERS = new Set(['<', '>', ':', '"', '|', '?', '*']);

/**
 * Unicode bidirectional formatting characters.
 *
 * U+202E RIGHT-TO-LEFT OVERRIDE is the classic filename spoof: it reverses the
 * rendering of everything after it, so `evil‮gnp.stl` is displayed as
 * `evills.png`. A user who believes they downloaded an image is being deceived
 * by their own file manager, so these are stripped rather than preserved.
 */
function isBidiControl(code: number): boolean {
  return (
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

const MAX_EXPORT_NAME_LENGTH = 100;

/**
 * Derives an export filename from the source filename.
 *
 * The source name is user-controlled, so it is sanitised rather than trusted:
 * directory components are dropped, control characters and reserved characters
 * are removed, and the length is bounded.
 *
 * Filtering is done by character code rather than with a character class,
 * because spelling this set as a regular expression is easy to get subtly wrong
 * — `[ -]` reads as two literals but is actually the range from space to
 * hyphen, which silently strips a dozen ordinary characters.
 */
export function deriveExportName(sourceName: string, suffix: string): string {
  const withoutPath = sourceName.split(/[\\/]/).pop() ?? '';
  const withoutExtension = withoutPath.replace(/\.[^.]*$/, '');

  let base = '';
  for (const character of withoutExtension) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (isBidiControl(code)) continue;
    if (RESERVED_FILENAME_CHARACTERS.has(character)) continue;
    base += character;
    if (base.length >= MAX_EXPORT_NAME_LENGTH) break;
  }

  const trimmed = base.trim();

  // A name consisting only of dots (`..`, `....`) is a legal filename but a
  // confusing one, and `..` in particular reads as a directory. Anything with
  // no ordinary character left in it falls back to the generic name.
  const onlyDots = /^\.*$/.test(trimmed);
  return `${onlyDots ? 'model' : trimmed}${suffix}.stl`;
}
