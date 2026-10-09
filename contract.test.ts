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
});
