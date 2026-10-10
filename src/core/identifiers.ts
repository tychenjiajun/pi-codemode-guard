// ---------------------------------------------------------------------------
// Codemode identifiers
// ---------------------------------------------------------------------------
//
// Scripts address tools as `tools.<identifier>`. Pi derives that identifier
// from the tool name by replacing every character that is not valid in a
// JavaScript identifier with `_`, so `mcp__dev-radius__search` becomes
// `tools.mcp__dev_radius__search` and `my-tool` becomes `tools.my_tool`.
// See `toCodemodeIdentifier` in `@earendil-works/pi-codemode`.

const START_CHAR = /^[A-Za-z_$]$/;
const CONTINUE_CHAR = /^[A-Za-z0-9_$]$/;

/** Convert a tool name to the identifier a codemode script uses. */
export function toCodemodeIdentifier(name: string): string {
  let identifier = "";
  for (const char of name) {
    const valid = identifier === "" ? START_CHAR.test(char) : CONTINUE_CHAR.test(char);
    identifier += valid ? char : "_";
  }
  return identifier === "" ? "_" : identifier;
}

/** Whether `name` can be written after a dot without quoting. */
export function isIdentifierName(name: string): boolean {
  if (name.length === 0) return false;
  if (!START_CHAR.test(name[0]!)) return false;
  for (let i = 1; i < name.length; i++) {
    if (!CONTINUE_CHAR.test(name[i]!)) return false;
  }
  return true;
}
