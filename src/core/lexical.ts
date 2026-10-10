// ---------------------------------------------------------------------------
// Lexical preprocessing
// ---------------------------------------------------------------------------
//
// Dialect detection falls back to raw-text signals when the source is
// TypeScript that acorn cannot parse. A comment that merely mentions a dialect
// keyword (`// codemode.search`) must not count, so the text is scanned and
// comments are blanked out — newlines preserved, string literals left alone —
// before the signal regexes run.

/**
 * Blank out `//` line comments and `/* … *​/` block comments (newlines kept,
 * string literals untouched) so a comment-only mention of a dialect keyword is
 * not a signal.
 */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let quote = "";
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (quote !== "") {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < text.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
