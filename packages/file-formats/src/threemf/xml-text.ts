/**
 * WHAT XML CAN CARRY IN A TEXT VALUE. A LEAF MODULE WITH NO IMPORTS.
 *
 * XML 1.0 does not permit most control characters at all — not even as numeric
 * references — so a writer that "escaped" one would produce a document that is
 * not well formed, and our own reader would refuse the file we had just
 * written. They are DROPPED. Tab, newline and carriage return are the three XML
 * does allow.
 *
 * Split out of `xml-scan.ts` so the conversion policy, which runs on the MAIN
 * THREAD, can ask whether a name will survive without importing the XML
 * scanner and the whole 3MF intake path behind it.
 */

/** The characters XML can carry at all, with the rest dropped. */
export function xmlSafeText(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code === 0x7f) continue;
    out += character;
  }
  return out;
}

/** Whether writing this value into XML would change it. */
export function xmlTextChangesOnWrite(value: string): boolean {
  return xmlSafeText(value) !== value;
}
