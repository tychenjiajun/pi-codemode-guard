import { describe, expect, it } from "vitest";

import { JS_GLOBALS, PI_SANDBOX_BUILTINS, PI_SANDBOX_GLOBALS, PI_SANDBOX_HOST_GLOBALS } from "../core/pi-globals.ts";
import { detectCodemodeDialect } from "./detect.ts";
import {
  DISTINCTIVE_UNSUPPORTED_GLOBALS,
  UNSUPPORTED_GLOBALS,
  UNSUPPORTED_GLOBAL_BY_NAME,
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

describe("environment vocabulary (core/pi-globals.ts)", () => {
  it.each(PI_SANDBOX_HOST_GLOBALS)(
    "classifies host global %s: present in the sandbox XOR has an UNSUPPORTED_GLOBALS row",
    (name) => {
      const present =
        (PI_SANDBOX_GLOBALS as readonly string[]).includes(name) || PI_SANDBOX_BUILTINS.includes(name);
      const hasRow = UNSUPPORTED_GLOBAL_BY_NAME.has(name);
      // Never both (a present global cannot warn), never neither (an absent
      // global must warn): the classification must be total and disjoint.
      expect(present).not.toBe(hasRow);
    },
  );

  it("classifies every runtime row as a host global", () => {
    const runtimeNames = UNSUPPORTED_GLOBALS.filter((entry) => entry.dialect === "runtime").map(
      (entry) => entry.name,
    );
    expect(runtimeNames.length).toBeGreaterThan(0);
    for (const name of runtimeNames) expect(PI_SANDBOX_HOST_GLOBALS).toContain(name);
  });

  it("keeps unsupported globals out of the skip vocabulary (the RESERVED set)", () => {
    const reserved = [...JS_GLOBALS, ...PI_SANDBOX_GLOBALS, ...PI_SANDBOX_BUILTINS];
    for (const entry of UNSUPPORTED_GLOBALS) expect(reserved).not.toContain(entry.name);
  });
});
