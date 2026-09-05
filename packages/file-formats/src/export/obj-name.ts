/**
 * WHAT OBJ CAN SPELL IN A NAME. A LEAF MODULE WITH NO IMPORTS.
 *
 * OBJ has no escape mechanism at all. A name is written after `o `, `g ` or
 * `usemtl ` and terminated by the end of the line, so:
 *
 *   - a CONTROL CHARACTER cannot be written. A newline inside a name would end
 *     the record and turn the rest of the name into geometry records — the file
 *     would contain triangles the document never had. It is removed, not
 *     escaped, because there is no escape.
 *   - RUNS OF SPACES AND TABS cannot survive. A reader splits on whitespace, so
 *     `Left  Bracket` and `Left Bracket` are the same name once written.
 *
 * Both are LOSSES, small ones, and a user is entitled to know before they
 * export that a name will come back different. That is why the predicate lives
 * beside the transform: the conversion policy runs on the MAIN THREAD and must
 * be able to ask "would this change?" without importing a serialiser. Nothing
 * here imports anything, so nothing arrives with it.
 */

/** Removes what OBJ cannot carry and normalises what it cannot distinguish. */
export function normaliseObjName(name: string): string {
  let stripped = '';
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    stripped += character;
  }
  return stripped
    .split(/[ \t]+/)
    .filter((token) => token.length > 0)
    .join(' ');
}

/**
 * Whether writing this name as OBJ would change it.
 *
 * DELIBERATELY EXCLUDES TRUNCATION. Length is bounded at import to the
 * document's own cap, so the writer's cap cannot be what alters a name that got
 * this far — and reporting a truncation that never happens would be a warning
 * about nothing.
 */
export function objNameChangesOnWrite(name: string): boolean {
  return normaliseObjName(name) !== name;
}
