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
function sanitiseBase(sourceName: string): string {
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
  return /^\.*$/.test(trimmed) ? 'model' : trimmed;
}

export function deriveExportName(sourceName: string, suffix: string): string {
  return `${sanitiseBase(sourceName)}${suffix}.stl`;
}

/**
 * The extension a written document gets, decided by the WRITER.
 *
 * Never taken from the source name, and never from anything inside the
 * document. What was written decides what the file is called, so a `.3mf`
 * exported as OBJ is named `.obj` and a model whose name ends in `.exe` cannot
 * produce a file that ends in `.exe`.
 */
const EXPORT_EXTENSIONS: Readonly<Record<string, string>> = {
  obj: '.obj',
  '3mf': '.3mf',
  stl: '.stl',
};

/**
 * Derives a document export filename from the source name and the target.
 *
 * SAME SANITISATION AS THE STL PATH, and the same reasoning: the source name is
 * text the user's filesystem supplied, so directory components are dropped,
 * control and bidi characters are removed, reserved characters are removed, and
 * the length is bounded. `../../evil.obj` becomes `evil.obj` — a name, in
 * whatever folder the browser is already saving to.
 *
 * Nothing here can affect an archive path: the 3MF writer's entry paths are a
 * fixed list it decides for itself and no filename reaches them.
 */
export function deriveDocumentExportName(sourceName: string, target: string): string {
  const extension = EXPORT_EXTENSIONS[target] ?? '.bin';
  return `${sanitiseBase(sourceName)}${extension}`;
}
