import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PiCodemodeGuardDetails } from "./contract.ts";
import { applyCompileReceipt, showGuardStatus, type ChildContainer } from "./ui.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const details: PiCodemodeGuardDetails = {
  version: 1,
  originalCode: '```js\nreturn 1;\n```',
  compiledCode: "return 1;",
  passes: ["strip-code-fence"],
  parsed: true,
  dialect: "pi",
  warnings: ["dropped @options line"],
};

const STATUS_KEY = "pi-codemode-guard";

interface StatusCall {
  key: string;
  value?: string;
}

function tuiContext() {
  const calls: StatusCall[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      setStatus: (key: string, value?: string) => {
        calls.push({ key, value });
      },
    },
  } as unknown as ExtensionContext;
  const clears = () => calls.filter((call) => call.value === undefined).length;
  return { ctx, calls, clears };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("showGuardStatus", () => {
  it("clears the transient status after 4 seconds", () => {
    vi.useFakeTimers();
    const { ctx, calls, clears } = tuiContext();

    showGuardStatus(ctx, "🛡 one");
    expect(calls.at(-1)).toEqual({ key: STATUS_KEY, value: "🛡 one" });

    vi.advanceTimersByTime(3_999);
    expect(clears()).toBe(0);

    vi.advanceTimersByTime(1);
    expect(calls.at(-1)).toEqual({ key: STATUS_KEY, value: undefined });
  });

  it("cancels the previous timer when a second status is shown", () => {
    vi.useFakeTimers();
    const { ctx, calls, clears } = tuiContext();

    showGuardStatus(ctx, "first");
    vi.advanceTimersByTime(2_000);
    showGuardStatus(ctx, "second");
    expect(calls.at(-1)).toEqual({ key: STATUS_KEY, value: "second" });

    // t = 4000ms: the first timer would have fired here if it were not cancelled.
    vi.advanceTimersByTime(2_000);
    expect(clears()).toBe(0);

    // t = 6000ms: only the second timer fires.
    vi.advanceTimersByTime(2_000);
    expect(clears()).toBe(1);
  });

  it("does not accumulate timers on repeated calls", () => {
    vi.useFakeTimers();
    const { ctx, clears } = tuiContext();

    for (let i = 0; i < 5; i += 1) showGuardStatus(ctx, `status ${i}`);
    vi.advanceTimersByTime(4_000);
    expect(clears()).toBe(1);

    vi.advanceTimersByTime(60_000);
    expect(clears()).toBe(1);
  });

  it("returns early outside TUI mode", () => {
    vi.useFakeTimers();
    const calls: StatusCall[] = [];
    const ctx = {
      mode: "print",
      ui: {
        setStatus: (key: string, value?: string) => {
          calls.push({ key, value });
        },
      },
    } as unknown as ExtensionContext;

    expect(() => showGuardStatus(ctx, "x")).not.toThrow();
    vi.advanceTimersByTime(10_000);
    expect(calls).toHaveLength(0);
  });

  it("returns early when ctx.ui is missing", () => {
    vi.useFakeTimers();
    const ctx = { mode: "tui" } as unknown as ExtensionContext;

    expect(() => showGuardStatus(ctx, "x")).not.toThrow();
    vi.advanceTimersByTime(10_000);
  });
});

describe("applyCompileReceipt", () => {
  it("appends the receipt to a component with addChild", () => {
    const children: unknown[] = [];
    const component: ChildContainer = {
      children,
      addChild: (child: unknown) => {
        children.push(child);
      },
    };

    expect(applyCompileReceipt(component, theme, details)).toBe(component);
    expect(children).toHaveLength(1);
  });

  it("is a no-op when addChild is missing (must not throw)", () => {
    const component: ChildContainer = {};

    expect(() => applyCompileReceipt(component, theme, details)).not.toThrow();
    expect(applyCompileReceipt(component, theme, details)).toBe(component);
    expect(component.children).toBeUndefined();
  });

  it("renders one warning line per warning", () => {
    const children: unknown[] = [];
    const component: ChildContainer = {
      children,
      addChild: (child: unknown) => {
        children.push(child);
      },
    };

    // one receipt container: title + summary + one line per warning
    applyCompileReceipt(component, theme, details);
    const receipt = children[0] as { children?: unknown[] };
    expect(children).toHaveLength(1);
    expect(receipt.children).toHaveLength(2 + details.warnings.length);
  });
});
