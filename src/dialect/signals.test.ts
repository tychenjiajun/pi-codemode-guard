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

  it("adds no new detection signal: runtime rows are never distinctive", () => {
    const runtimeRows = UNSUPPORTED_GLOBALS.filter((entry) => entry.dialect === "runtime");
    expect(runtimeRows.length).toBeGreaterThan(0);
    expect(runtimeRows.every((entry) => entry.distinctive !== true)).toBe(true);
    expect(DISTINCTIVE_UNSUPPORTED_GLOBALS.some((entry) => entry.dialect === "runtime")).toBe(false);
  });

  it("keeps detection of an Intl reference unchanged (unknown, no runtime signal)", () => {
    const detection = detectCodemodeDialect("const d = new Intl.DateTimeFormat('en');");
    expect(detection.dialect).toBe("unknown");
    expect(detection.signals.some((signal) => signal.startsWith("runtime:"))).toBe(false);
  });
});

describe("globals Pi's sandbox lacks (runtime rows)", () => {
  it("warns exactly once for crypto.randomUUID() with the runtime message, not a Cloudflare one", () => {
    const result = translateCodemode("crypto.randomUUID();", { tools: ["read"], dialect: "unknown" });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("crypto");
    expect(result.warnings.join("\n")).not.toContain("Cloudflare");
  });

  it("stays silent for performance.now() — a real sandbox builtin", () => {
    const result = translateCodemode("performance.now();", { tools: ["read"], dialect: "cloudflare" });
    expect(result.warnings).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it.each(["Intl", "structuredClone", "setInterval"])("warns for %s referenced as a value", (name) => {
    const result = translateCodemode(`text(typeof ${name});`, { tools: [], dialect: "unknown" });
    expect(result.warnings).toHaveLength(1);
    const row = UNSUPPORTED_GLOBALS.find((entry) => entry.name === name);
    expect(row?.dialect).toBe("runtime");
    expect(result.warnings).toContain(row?.message);
  });

  it("is idempotent: the code is untouched for every runtime-only case", () => {
    const sources = [
      "crypto.randomUUID();",
      "performance.now();",
      "text(typeof Intl);",
      "structuredClone({});",
      "setInterval(fn, 1000);",
    ];
    for (const source of sources) {
      const options = { tools: ["read"], dialect: "unknown" as const };
      const once = translateCodemode(source, options);
      const twice = translateCodemode(once.code, options);
      expect(twice.code).toBe(once.code);
      expect(twice.changed).toBe(false);
      expect(twice.warnings).toEqual(once.warnings);
    }
  });
});
