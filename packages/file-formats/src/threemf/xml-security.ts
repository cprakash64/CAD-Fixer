import { ImportRefusal } from '../import-errors';

/**
 * THE XML SECURITY RULES — one implementation for both ingestion paths, Stage
 * 6E-A2. A LEAF MODULE: it imports nothing from the scanner, so `xml-scan.ts`
 * (the whole-string reader) and `xml-stream.ts` (the streamed one) can both
 * depend on it without a cycle between them.
 */

/**
 * JavaScript's `\s` — WhiteSpace plus LineTerminator, ECMA-262 §12.2–12.3 —
 * without a regular expression. `xml-stream.test.ts` compares it with `/\s/`
 * for every UTF-16 code unit.
 */
export function isEcmaWhitespace(code: number): boolean {
  if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  if (code < 0xa0) return false;
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function isWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

/**
 * ASCII-only upper-casing: exactly what `/i` does to these letters without the
 * `u` flag. A locale- or Unicode-aware fold would accept spellings the rule
 * does not — U+0131 and U+017F fold to `I` and `S` under full case mapping, and
 * `/i` deliberately refuses to map a non-ASCII character to an ASCII one.
 */
function upperAscii(code: number): number {
  return code >= 97 && code <= 122 ? code - 32 : code;
}

/**
 * A case-insensitive search for one fixed literal that begins with `<`,
 * resumable across pieces.
 *
 * WHY A MATCH COUNT IS ENOUGH STATE. Both literals it is used for, `<!DOCTYPE`
 * and `<!ENTITY`, contain `<` only as their first character, so no proper
 * prefix of either is also a suffix of a longer partial match: on a mismatch
 * the only possible restart is at the mismatching character itself, and only
 * if that character is `<`. So a single integer — how many characters of the
 * literal the input currently ends with — carries a partial match over any
 * piece boundary, and no text is ever retained.
 *
 * WHY IT IS FAST. With no partial match in progress it jumps with `indexOf`
 * to the next `<!` — native, and never a regular expression, so no match state
 * of the engine ends up referring to the document.
 */
class LiteralMatcher {
  private readonly upper: readonly number[];
  private matched = 0;
  public found = false;

  public constructor(literal: string) {
    this.upper = Array.from({ length: literal.length }, (_unit, at) =>
      upperAscii(literal.charCodeAt(at)),
    );
  }

  public push(text: string): void {
    const length = text.length;
    let at = 0;
    while (at < length && !this.found) {
      if (this.matched === 0) {
        const open = text.indexOf('<!', at);
        if (open === -1) {
          // A `<` ending the piece may be the start of the literal.
          if (text.charCodeAt(length - 1) === 60 /* < */) this.matched = 1;
          return;
        }
        this.matched = 2;
        at = open + 2;
        continue;
      }
      const code = text.charCodeAt(at);
      if (upperAscii(code) === this.upper[this.matched]) {
        this.matched += 1;
        if (this.matched === this.upper.length) this.found = true;
      } else {
        this.matched = code === 60 /* < */ ? 1 : 0;
      }
      at += 1;
    }
  }
}

/**
 * The XML security rules, incrementally — and, since Stage 6E-A2, for the
 * whole-string reader too.
 *
 * THE RULES, and their precedence, are unchanged from v0.2.0:
 *
 *   1. `<!DOCTYPE` (any ASCII case) anywhere in the PROLOG — everything before
 *      the first `<` that is not followed by `?` or `!` — including inside a
 *      comment there;
 *   2. `<!ENTITY` (any ASCII case) anywhere in the WHOLE text;
 *   3. `SYSTEM` or `PUBLIC` (any ASCII case) at a word boundary, followed by at
 *      least one character of JavaScript's `\s`, then a quote — in the prolog.
 *
 * `xml-stream.test.ts` keeps them as three regular expressions — the form they
 * were qualified in — and holds this class equal to them.
 *
 * NO REGULAR EXPRESSION RUNS OVER THE DOCUMENT. That is Stage 6E-A2's fix for
 * the retention finding: a successful regular-expression match leaves the
 * engine's last-match state pointing at its subject, and a substring subject
 * keeps its whole parent — the decoded model part — alive after the import.
 * Rules 1 and 2 are `LiteralMatcher`s; rule 3 is the automaton below. None of
 * them retains text between pieces.
 *
 * NOTHING IS DECIDED UNTIL `finish()`. The precedence means a DOCTYPE late in a
 * long prolog outranks an ENTITY early in it, so this reports nothing
 * mid-stream; the driver runs it over the WHOLE part before a single element is
 * scanned for meaning.
 */
export class XmlSecurityStream {
  private inProlog = true;
  /** The prolog ended on a `<` whose next character has not arrived yet. */
  private pendingLt = false;
  private readonly doctype = new LiteralMatcher('<!DOCTYPE');
  private readonly entity = new LiteralMatcher('<!ENTITY');
  private external = false;
  /*
   * RULE 3's AUTOMATON.
   *   stage 0: idle — waiting for `S` or `P` at a word boundary;
   *   stage 1: inside a candidate word, `matched` characters of it seen;
   *   stage 2: the word is complete; `sawSpace` once one `\s` has followed.
   * `previousWord` is whether the previous character was a `\w` character,
   * which is what `\b` tests; it carries across pieces like everything else.
   */
  private stage = 0;
  private word: 'SYSTEM' | 'PUBLIC' = 'SYSTEM';
  private matched = 0;
  private sawSpace = false;
  private previousWord = false;

  public push(text: string): void {
    if (text.length === 0) return;
    if (!this.entity.found) this.entity.push(text);
    if (this.inProlog) this.pushProlog(text);
  }

  public finish(): ImportRefusal | undefined {
    // A `<` as the very last character does not extend the prolog: the
    // whole-string rule reads the character after it, finds none, and ends the
    // prolog before it.
    this.pendingLt = false;
    if (this.doctype.found) return ImportRefusal.XmlDoctypeRefused;
    if (this.entity.found) return ImportRefusal.XmlEntityRefused;
    if (this.external) return ImportRefusal.XmlExternalIdRefused;
    return undefined;
  }

  private pushProlog(text: string): void {
    if (this.pendingLt) {
      const next = text.charCodeAt(0);
      this.pendingLt = false;
      if (next !== 63 /* ? */ && next !== 33 /* ! */) {
        this.inProlog = false;
        return;
      }
      this.feedProlog('<');
    }
    let search = 0;
    for (;;) {
      const lt = text.indexOf('<', search);
      if (lt === -1) {
        this.feedProlog(text);
        return;
      }
      if (lt === text.length - 1) {
        this.feedProlog(text.slice(0, lt));
        this.pendingLt = true;
        return;
      }
      const next = text.charCodeAt(lt + 1);
      if (next === 63 || next === 33) {
        search = lt + 1;
        continue;
      }
      this.feedProlog(text.slice(0, lt));
      this.inProlog = false;
      return;
    }
  }

  private feedProlog(segment: string): void {
    if (segment.length === 0) return;
    if (!this.doctype.found) this.doctype.push(segment);
    if (this.external) return;
    for (let at = 0; at < segment.length; at += 1) {
      const code = segment.charCodeAt(at);
      if (this.stage === 2) {
        if (isEcmaWhitespace(code)) {
          this.sawSpace = true;
          this.previousWord = false;
          continue;
        }
        if (this.sawSpace && (code === 34 /* " */ || code === 39) /* ' */) {
          this.external = true;
          return;
        }
        this.stage = 0;
      } else if (this.stage === 1) {
        if (upperAscii(code) === this.word.charCodeAt(this.matched)) {
          this.matched += 1;
          if (this.matched === this.word.length) {
            this.stage = 2;
            this.sawSpace = false;
          }
          this.previousWord = true;
          continue;
        }
        this.stage = 0;
      }
      if (this.stage === 0 && !this.previousWord) {
        const upper = upperAscii(code);
        if (upper === 83 /* S */ || upper === 80 /* P */) {
          this.stage = 1;
          this.word = upper === 83 ? 'SYSTEM' : 'PUBLIC';
          this.matched = 1;
        }
      }
      this.previousWord = isWordCode(code);
    }
  }
}
