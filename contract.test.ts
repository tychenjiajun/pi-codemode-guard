import { describe, expect, it } from "vitest";

import { PI_CODEMODE_GUARD_DETAILS_KEY, readPiCodemodeGuardDetails } from "./contract.ts";

const VALID = {
  version: 1,
  originalCode: "const x = 1;",
  compiledCode: "const x = 1;",
  passes: ["await-async-calls(1)"],
  parsed: true,
  dialect: "pi",
  warnings: [],
};

describe("readPiCodemodeGuardDetails", () => {
  it("reads a valid record", () => {
    const details = readPiCodemodeGuardDetails({ other: true, [PI_CODEMODE_GUARD_DETAILS_KEY]: VALID });
    expect(details).toEqual(VALID);
  });

  it("returns undefined for missing or non-record values", () => {
    expect(readPiCodemodeGuardDetails(undefined)).toBeUndefined();
    expect(readPiCodemodeGuardDetails({})).toBeUndefined();
    expect(readPiCodemodeGuardDetails({ [PI_CODEMODE_GUARD_DETAILS_KEY]: "nope" })).toBeUndefined();
  });

  it("returns undefined for an unknown version", () => {
    expect(readPiCodemodeGuardDetails({ [PI_CODEMODE_GUARD_DETAILS_KEY]: { ...VALID, version: 2 } })).toBeUndefined();
  });

  it("defaults an unknown dialect to `unknown`", () => {
    const details = readPiCodemodeGuardDetails({
      [PI_CODEMODE_GUARD_DETAILS_KEY]: { ...VALID, dialect: "opencode" },
    });
    expect(details?.dialect).toBe("opencode");
    const cloudflare = readPiCodemodeGuardDetails({
      [PI_CODEMODE_GUARD_DETAILS_KEY]: { ...VALID, dialect: "cloudflare" },
    });
    expect(cloudflare?.dialect).toBe("cloudflare");
    const missing = readPiCodemodeGuardDetails({
      [PI_CODEMODE_GUARD_DETAILS_KEY]: { ...VALID, dialect: undefined },
    });
    expect(missing?.dialect).toBe("unknown");
    const tanstack = readPiCodemodeGuardDetails({
      [PI_CODEMODE_GUARD_DETAILS_KEY]: { ...VALID, dialect: "tanstack" },
    });
    expect(tanstack?.dialect).toBe("tanstack");
    const vercel = readPiCodemodeGuardDetails({
      [PI_CODEMODE_GUARD_DETAILS_KEY]: { ...VALID, dialect: "vercel" },
    });
    expect(vercel?.dialect).toBe("vercel");
    const ptc = readPiCodemodeGuardDetails({
      [PI_CODEMODE_GUARD_DETAILS_KEY]: { ...VALID, dialect: "ptc" },
    });
    expect(ptc?.dialect).toBe("ptc");
  });

  it("returns undefined when a field has the wrong type", () => {
    expect(
      readPiCodemodeGuardDetails({ [PI_CODEMODE_GUARD_DETAILS_KEY]: { ...VALID, passes: [1] } }),
    ).toBeUndefined();
    expect(
      readPiCodemodeGuardDetails({ [PI_CODEMODE_GUARD_DETAILS_KEY]: { ...VALID, originalCode: 5 } }),
    ).toBeUndefined();
  });

  it("ignores unknown extra fields inside the record", () => {
    const details = readPiCodemodeGuardDetails({
      [PI_CODEMODE_GUARD_DETAILS_KEY]: {
        ...VALID,
        futureField: { nested: true },
        futureFlag: 7,
      },
    });
    expect(details).toEqual(VALID);
    expect(details).not.toHaveProperty("futureField");
    expect(details).not.toHaveProperty("futureFlag");
  });

  it("returns undefined when the `passes` or `warnings` keys are missing entirely", () => {
    // no `warnings` key at all (passes present)
    expect(
      readPiCodemodeGuardDetails({
        [PI_CODEMODE_GUARD_DETAILS_KEY]: {
          version: 1,
          originalCode: "const x = 1;",
          compiledCode: "const x = 1;",
          passes: [],
          parsed: true,
          dialect: "pi",
        },
      }),
    ).toBeUndefined();
    // no `passes` key at all (warnings present)
    expect(
      readPiCodemodeGuardDetails({
        [PI_CODEMODE_GUARD_DETAILS_KEY]: {
          version: 1,
          originalCode: "const x = 1;",
          compiledCode: "const x = 1;",
          parsed: true,
          dialect: "pi",
          warnings: ["dropped @options"],
        },
      }),
    ).toBeUndefined();
  });

  it("treats a non-boolean `parsed` as false without rejecting the record", () => {
    expect(readPiCodemodeGuardDetails({ [PI_CODEMODE_GUARD_DETAILS_KEY]: { ...VALID, parsed: "yes" } })?.parsed).toBe(false);
    expect(readPiCodemodeGuardDetails({ [PI_CODEMODE_GUARD_DETAILS_KEY]: { ...VALID, parsed: 1 } })?.parsed).toBe(false);
  });

  it("falls back to inline content for an unknown future contract version", () => {
    // Consumers must treat an unrecognized version as "no guard record" and
    // use the inline result content instead.
    expect(readPiCodemodeGuardDetails({ [PI_CODEMODE_GUARD_DETAILS_KEY]: { ...VALID, version: 99 } })).toBeUndefined();
    expect(readPiCodemodeGuardDetails({ [PI_CODEMODE_GUARD_DETAILS_KEY]: { ...VALID, version: 0 } })).toBeUndefined();
  });
});
