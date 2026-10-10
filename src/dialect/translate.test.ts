import { describe, expect, it } from "vitest";

import { compileCodemodeSource } from "../compile.ts";
import { parseScript } from "../core/parse.ts";
import { translateCodemode } from "./translate.ts";

describe("translateCodemode: bare tool calls", () => {
  it("translates a bare call into `tools.<identifier>`", () => {
    const result = translateCodemode('const r = await search({ query: "x" });', { tools: ["search"] });
    expect(result.code).toBe('const r = await tools.search({ query: "x" });');
    expect(result.groups.bare).toBe(1);
  });

  it("resolves a bare name through the catalog to Pi's identifier", () => {
    const result = translateCodemode("await web_search({ q: 1 });", { tools: ["web-search"] });
    expect(result.code).toBe("await tools.web_search({ q: 1 });");
  });

  it("leaves a bare call the catalog does not know", () => {
    const result = translateCodemode("await missing({ q: 1 });", { tools: ["search"] });
    expect(result.changed).toBe(false);
    expect(result.code).toBe("await missing({ q: 1 });");
  });

  it("leaves a locally declared function alone", () => {
    const code = "const search = (q) => q;\nreturn search({ q: 1 });";
    expect(translateCodemode(code, { tools: ["search"] }).changed).toBe(false);
  });

  it("never rewrites a sandbox helper, even when a tool shares its name", () => {
    const result = translateCodemode('text("hi");\nsearchTools("q");', { tools: ["text", "searchTools"] });
    expect(result.changed).toBe(false);
  });
});

describe("translateCodemode: mixed dialects in one snippet", () => {
  it("translates OpenCode, Cloudflare, TanStack and bare calls together", () => {
    const source = [
      'const a = await tools.orders.lookup({ id: "1" });',
      'const b = await codemode.search("x");',
      'const c = await external_getWeather({ location: "London" });',
      'const d = await search({ query: "y" });',
    ].join("\n");
    const result = translateCodemode(source, {
      tools: ["orders.lookup", "getWeather", "search"],
      dialect: "unknown",
    });
    expect(result.changed).toBe(true);
    expect(result.groups).toMatchObject({ opencode: 1, cloudflare: 1, tanstack: 1, bare: 1 });
    expect(result.code).toContain("tools.orders_lookup");
    expect(result.code).toContain("searchTools(String(");
    expect(result.code).toContain('tools.getWeather({ location: "London" })');
    expect(result.code).toContain('tools.search({ query: "y" })');
    expect(parseScript(result.code)).toBeDefined();
  });

  it("translates a catalog-confirmed namespace path even outside the OpenCode dialect", () => {
    const result = translateCodemode("const o = await tools.orders.lookup({ id: 1 });", {
      tools: ["orders.lookup"],
      dialect: "pi",
    });
    expect(result.code).toBe("const o = await tools.orders_lookup({ id: 1 });");
    expect(result.groups.opencode).toBe(1);
  });

  it("does not flatten a function property when the path is not a catalog tool", () => {
    const result = translateCodemode("const n = tools.read.length;", { tools: ["read"], dialect: "pi" });
    expect(result.changed).toBe(false);
  });

  it("is idempotent", () => {
    const source = [
      'const a = await tools.orders.lookup({ id: "1" });',
      'const c = await external_getWeather({ location: "London" });',
      'const d = await search({ query: "y" });',
    ].join("\n");
    const options = { tools: ["orders.lookup", "getWeather", "search"], dialect: "unknown" };
    const once = translateCodemode(source, options);
    const twice = translateCodemode(once.code, options);
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });
});

describe("translateCodemode: property access on a tool handle", () => {
  const tools = ["read", "bash", "subagent_start"];

  it("leaves `tools.read.length` alone when the dialect is OpenCode", () => {
    const result = translateCodemode("text(tools.read.length > 0);", { tools, dialect: "opencode" });
    expect(result.changed).toBe(false);
    expect(result.code).toBe("text(tools.read.length > 0);");
    expect(result.warnings).toEqual([]);
  });

  it("leaves `tools.bash.output` and `tools.subagent_start.name` alone", () => {
    const source = "text(tools.bash.output);\ntext(tools.subagent_start.name);";
    const result = translateCodemode(source, { tools, dialect: "opencode" });
    expect(result.changed).toBe(false);
    expect(result.code).toBe(source);
    expect(result.warnings).toEqual([]);
  });

  it("leaves the property access alone for the pi dialect too", () => {
    const source = "text(tools.bash.output);";
    const result = translateCodemode(source, { tools, dialect: "pi" });
    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("leaves a single-segment tool access alone", () => {
    const result = translateCodemode("const r = await tools.read({ path: \"x\" });", {
      tools,
      dialect: "opencode",
    });
    expect(result.changed).toBe(false);
  });

  it("still flattens a namespace path whose first segment is not a tool", () => {
    const result = translateCodemode("const o = await tools.orders.lookup({ id: 1 });", {
      tools: ["orders.lookup"],
      dialect: "opencode",
    });
    expect(result.code).toBe("const o = await tools.orders_lookup({ id: 1 });");
    expect(result.groups.opencode).toBe(1);
  });

  it("still flattens and warns when no segment resolves", () => {
    const result = translateCodemode("const r = await tools.dev_radius.search({ q: 1 });", {
      tools: ["read"],
      dialect: "opencode",
    });
    expect(result.code).toBe("const r = await tools.dev_radius__search({ q: 1 });");
    expect(result.warnings.some((w) => w.includes("could not resolve OpenCode tool path"))).toBe(true);
  });

  it("is idempotent for tool-handle property access", () => {
    const source = "text(tools.read.length > 0);\ntext(tools.bash.output);";
    const options = { tools, dialect: "opencode" as const };
    const once = translateCodemode(source, options);
    const twice = translateCodemode(once.code, options);
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });
});

describe("translateCodemode: Object.keys disambiguation", () => {
  it("uses the OpenCode spelling by default", () => {
    const result = translateCodemode("const n = Object.keys(tools);", { tools: [] });
    expect(result.code).toBe("const n = ALL_TOOLS.map((__cm_tool) => __cm_tool.name);");
  });

  it("uses the PTC spelling for the PTC dialect", () => {
    const result = translateCodemode("const n = Object.keys(tools);", { tools: [], dialect: "ptc" });
    expect(result.code).toBe("const n = ALL_TOOLS.map((__ptc_tool) => __ptc_tool.name);");
  });

  it("warns about Object.keys(tools.<ns>) in the PTC dialect instead of rewriting", () => {
    const result = translateCodemode("const n = Object.keys(tools.orders);", {
      tools: ["orders.lookup"],
      dialect: "ptc",
    });
    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Object.keys(tools.orders)");
  });
});

describe("translateCodemode: unresolved provider paths", () => {
  const tools = ["read", "bash"];

  it("stays silent for a method call on an unbound root when nothing resolves", () => {
    for (const dialect of ["unknown", "pi", "opencode"] as const) {
      const result = translateCodemode("foo.bar();", { tools, dialect });
      expect(result.warnings).toEqual([]);
      expect(result.changed).toBe(false);
    }
  });

  it("keeps the Cloudflare message for an unresolved root in the Cloudflare dialect", () => {
    const result = translateCodemode("foo.bar();", { tools, dialect: "cloudflare" });
    expect(result.warnings).toEqual([
      "could not resolve Cloudflare provider `foo.bar` in the Pi catalog; left unchanged",
    ]);
  });

  it("hints with the real tool when only the trailing segment resolves (unknown dialect)", () => {
    const result = translateCodemode("foo.read({ path: \"x\" });", { tools, dialect: "unknown" });
    expect(result.warnings).toEqual([
      "`foo.read` is not a Pi tool path; Pi has a tool `read` — call `tools.read(...)`",
    ]);
    expect(result.changed).toBe(false);
  });

  it("keeps the Cloudflare message (not the hint) when the trailing segment resolves under the Cloudflare dialect", () => {
    const result = translateCodemode("foo.read({ path: \"x\" });", { tools, dialect: "cloudflare" });
    expect(result.warnings).toEqual([
      "could not resolve Cloudflare provider `foo.read` in the Pi catalog; left unchanged",
    ]);
  });

  it("rewrites a catalog-confirmed provider path for every dialect", () => {
    for (const dialect of ["unknown", "pi", "cloudflare"] as const) {
      const result = translateCodemode('state.readFile("/x");', {
        tools: ["state.readFile"],
        dialect,
      });
      expect(result.code).toBe("tools.state_readFile(\"/x\");");
      expect(result.warnings).toEqual([]);
    }
  });

  it("stays silent for state.readFile when it resolves to nothing outside the Cloudflare dialect", () => {
    const result = translateCodemode('state.readFile("/x");', { tools, dialect: "unknown" });
    expect(result.warnings).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it("still warns about state.readFile in the Cloudflare dialect", () => {
    const result = translateCodemode('state.readFile("/x");', { tools, dialect: "cloudflare" });
    expect(result.warnings).toEqual([
      "could not resolve Cloudflare provider `state.readFile` in the Pi catalog; left unchanged",
    ]);
  });

  it("is idempotent for every unresolved-provider case", () => {
    const cases: Array<{ code: string; dialect: string }> = [
      { code: "foo.bar();", dialect: "unknown" },
      { code: "foo.bar();", dialect: "cloudflare" },
      { code: 'foo.read({ path: "x" });', dialect: "unknown" },
      { code: 'foo.read({ path: "x" });', dialect: "cloudflare" },
      { code: 'state.readFile("/x");', dialect: "unknown" },
      { code: 'state.readFile("/x");', dialect: "cloudflare" },
    ];
    for (const { code, dialect } of cases) {
      const once = translateCodemode(code, { tools, dialect });
      const twice = translateCodemode(once.code, { tools, dialect });
      expect(twice.changed).toBe(false);
      expect(twice.code).toBe(once.code);
      expect(twice.warnings).toEqual(once.warnings);
    }
  });
});

describe("compileCodemodeSource: statement-based translation", () => {
  it("repairs every construct regardless of the snippet's dialect", () => {
    const source = [
      "// @options: {\"max_output_tokens\": 2000}",
      'const a = tools.orders.lookup({ id: "1" });',
      'const b = codemode.search("x");',
      'text(a, b);',
    ].join("\n");
    const result = compileCodemodeSource(source, { tools: ["orders.lookup"] });
    expect(result.dialect).toBe("opencode");
    expect(result.passes).toContain("opencode-dialect(1)");
    expect(result.passes).toContain("cloudflare-dialect(1)");
    expect(result.code).toContain("await tools.orders_lookup(");
    expect(result.code).toContain("await (async (__cm_query)");
  });

  it("translates and awaits a bare tool call", () => {
    const result = compileCodemodeSource('const r = search({ query: "x" });\ntext(r);', { tools: ["search"] });
    expect(result.passes).toContain("bare-tool-calls(1)");
    expect(result.code).toContain('const r = await tools.search({ query: "x" });');
  });
});

describe("unsupported globals versus the live tool catalog (#D)", () => {
  it("rewrites a bare `fetch` call that collides with a catalog tool, warning-free", () => {
    const tools = ["fetch", "read"];
    const source = 'const r = await fetch({ q: 1 });\ntext(r);';
    const result = compileCodemodeSource(source, { tools });
    expect(result.code).toBe('const r = await tools.fetch({ q: 1 });\ntext(r);');
    expect(result.warnings).toEqual([]);
    expect(result.passes).toContain("bare-tool-calls(1)");
    const again = compileCodemodeSource(result.code, { tools });
    expect(again.code).toBe(result.code);
    expect(again.warnings).toEqual([]);
  });

  it("rewrites `fetch.get` to `tools.fetch_get` when the catalog confirms the path, warning-free", () => {
    const tools = ["fetch_get", "read"];
    const source = 'const r = await fetch.get({ id: 1 });';
    const result = compileCodemodeSource(source, { tools });
    expect(result.code).toBe('const r = await tools.fetch_get({ id: 1 });');
    expect(result.warnings).toEqual([]);
    const again = compileCodemodeSource(result.code, { tools });
    expect(again.code).toBe(result.code);
    expect(again.warnings).toEqual([]);
  });

  it("gives crypto.read() exactly one warning: the runtime `crypto` one, no provider hint", () => {
    const tools = ["read"];
    const source = "const r = await crypto.read({ path: 'a' });\ntext(r);";
    const result = compileCodemodeSource(source, { tools });
    expect(result.code).toBe(source);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("`crypto` is unavailable");
    expect(result.warnings.join("\n")).not.toContain("not a Pi tool path");
    expect(result.warnings.join("\n")).not.toContain("Cloudflare");
    const again = compileCodemodeSource(result.code, { tools });
    expect(again.code).toBe(result.code);
    expect(again.warnings).toEqual(result.warnings);
  });

  it("rewrites crypto.read() silently when the catalog confirms crypto_read", () => {
    const tools = ["crypto_read"];
    const source = "const r = await crypto.read({ path: 'a' });\ntext(r);";
    const result = compileCodemodeSource(source, { tools });
    expect(result.code).toBe("const r = await tools.crypto_read({ path: 'a' });\ntext(r);");
    expect(result.warnings).toEqual([]);
    const again = compileCodemodeSource(result.code, { tools });
    expect(again.code).toBe(result.code);
    expect(again.warnings).toEqual([]);
  });

  it("still warns exactly once for crypto.randomUUID() and for bare crypto", () => {
    const tools = ["read"];
    const randomId = compileCodemodeSource("const id = crypto.randomUUID();\ntext(id);", { tools });
    expect(randomId.warnings).toHaveLength(1);
    expect(randomId.warnings[0]).toContain("`crypto` is unavailable");
    const bare = compileCodemodeSource("text(typeof crypto);", { tools });
    expect(bare.warnings).toHaveLength(1);
    expect(bare.warnings[0]).toContain("`crypto` is unavailable");
    for (const result of [randomId, bare]) {
      const again = compileCodemodeSource(result.code, { tools });
      expect(again.code).toBe(result.code);
      expect(again.warnings).toEqual(result.warnings);
    }
  });
});

describe("unsupported-global warnings are scope-precise (#C)", () => {
  it("warns for the top-level reference while a function parameter stays silent", () => {
    const tools = ["read"];
    const source = 'function f(fetch) { return fetch(); }\nawait fetch("https://x");';
    const result = compileCodemodeSource(source, { tools });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("`fetch()` is unavailable");
    const again = compileCodemodeSource(result.code, { tools });
    expect(again.code).toBe(result.code);
    expect(again.warnings).toEqual(result.warnings);
  });

  it("stays silent for a local const of the same name", () => {
    const tools = ["read"];
    const source = 'const fetch = (url) => url;\ntext(await fetch("/x"));';
    const result = compileCodemodeSource(source, { tools });
    expect(result.warnings).toEqual([]);
    const again = compileCodemodeSource(result.code, { tools });
    expect(again.code).toBe(result.code);
    expect(again.warnings).toEqual([]);
  });

  it("warns in a sibling function while another function's parameter stays silent", () => {
    const tools = ["read"];
    const source = 'function a() { return fetch("/a"); }\nfunction b(fetch) { return fetch("/b"); }';
    const result = compileCodemodeSource(source, { tools });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("`fetch()` is unavailable");
    const again = compileCodemodeSource(result.code, { tools });
    expect(again.code).toBe(result.code);
    expect(again.warnings).toEqual(result.warnings);
  });
});
