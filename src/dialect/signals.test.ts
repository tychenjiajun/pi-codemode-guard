import { describe, expect, it } from "vitest";

import { detectCodemodeDialect } from "./detect.ts";
import {
  DISTINCTIVE_UNSUPPORTED_GLOBALS,
  UNSUPPORTED_GLOBALS,
  unsupportedGlobalSignal,
} from "./signals.ts";
import { translateCodemode } from "./translate.ts";

// The unsupported-globals table is the single source of truth for both the
// translator's warnings and the detector's signals, so every row must be wired
// through both. These tests fail if a row is added without that wiring.

describe("unsupported globals table", () => {
  it.each(UNSUPPORTED_GLOBALS)("warns with the table message for $name", (entry) => {
    const result = translateCodemode(`await ${entry.name}();`, { tools: [], dialect: entry.dialect });
    expect(result.warnings).toContain(entry.message);
  });

  it.each(DISTINCTIVE_UNSUPPORTED_GLOBALS)("detects $name as a $dialect signal", (entry) => {
    const detection = detectCodemodeDialect(`await ${entry.name}();`);
    expect(detection.dialect).toBe(entry.dialect);
    expect(detection.signals).toContain(unsupportedGlobalSignal(entry));
  });
});
