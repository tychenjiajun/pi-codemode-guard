import { describe, expect, it } from "vitest";

import { buildCatalog, resolveToolPath } from "./catalog.ts";

describe("resolveToolPath", () => {
  it("resolves a server.local path against an mcp__ catalog name", () => {
    const catalog = buildCatalog(["mcp__github__list_issues"]);
    expect(resolveToolPath(["github", "list_issues"], catalog)).toEqual({
      identifier: "mcp__github__list_issues",
      matched: "mcp__github__list_issues",
    });
  });

  it("resolves an mcp__ name written with separators the catalog spells differently", () => {
    const catalog = buildCatalog(["mcp__dev-radius__search"]);
    expect(resolveToolPath(["dev", "radius", "search"], catalog).matched).toBe("mcp__dev-radius__search");
  });

  it("fuzzy-matches an mcp__-prefixed catalog name case-insensitively", () => {
    const catalog = buildCatalog(["mcp__GitHub__List_Issues"]);
    const resolution = resolveToolPath(["github", "list_issues"], catalog);
    expect(resolution.matched).toBe("mcp__GitHub__List_Issues");
    expect(resolution.identifier).toBe("mcp__GitHub__List_Issues");
  });

  it("does not let an identifier collision resolve order-dependently", () => {
    const forward = buildCatalog(["web-search", "web_search"]);
    expect(resolveToolPath(["web-search"], forward).matched).toBe("web-search");
    expect(resolveToolPath(["web_search"], forward).matched).toBe("web_search");

    const reverse = buildCatalog(["web_search", "web-search"]);
    expect(resolveToolPath(["web-search"], reverse).matched).toBe("web-search");
    expect(resolveToolPath(["web_search"], reverse).matched).toBe("web_search");
  });

  it("still flattens deterministically when nothing matches", () => {
    const catalog = buildCatalog(["mcp__github__list_issues"]);
    expect(resolveToolPath(["unknown", "thing"], catalog)).toEqual({ identifier: "unknown__thing" });
  });
});
