// ---------------------------------------------------------------------------
// Guard UI
// ---------------------------------------------------------------------------
//
//   🛡 pi-codemode-guard · compiled codemode script
//      strip-code-fence · normalize-options-line · await-async-calls(2)
//
// The receipt is appended to the codemode result. A transient footer status
// mirrors it for the few seconds after a compile, like pi-tool-guard.

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import type { PiCodemodeGuardDetails } from "./contract.ts";

const GUARD_GLYPH = "🛡";
const STATUS_KEY = "pi-codemode-guard";
const STATUS_DURATION_MS = 4_000;
const statusTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();

/** Structural view of a pi-tui Container, kept loose so tests can fake it. */
export interface ChildContainer {
  children?: unknown[];
  addChild?: (child: unknown) => void;
}

/** `🛡 pi-codemode-guard · <summary>` — the receipt title line. */
export function guardTitle(theme: Theme, summary: string): string {
  return (
    `${theme.fg("warning", GUARD_GLYPH)} ` +
    `${theme.fg("accent", theme.bold("pi-codemode-guard"))} ` +
    `${theme.fg("dim", `· ${summary}`)}`
  );
}

/** One-line summary of the compile, e.g. `strip-code-fence · await-async-calls(2)`. */
export function compileSummary(details: PiCodemodeGuardDetails): string {
  if (details.passes.length > 0) return details.passes.join(" · ");
  return details.parsed ? "no changes needed" : "left unchanged";
}

/** Full receipt block, appended to the codemode tool result. */
export function renderCompileReceipt(theme: Theme, details: PiCodemodeGuardDetails): Container {
  const container = new Container();
  container.addChild(new Text(guardTitle(theme, "compiled codemode script"), 0, 0));
  container.addChild(new Text(`   ${theme.fg("success", compileSummary(details))}`, 0, 0));
  for (const warning of details.warnings) {
    container.addChild(new Text(`   ${theme.fg("warning", `⚠ ${warning}`)}`, 0, 0));
  }
  return container;
}

/** Append the receipt to an existing result component. */
export function applyCompileReceipt(
  component: ChildContainer,
  theme: Theme,
  details: PiCodemodeGuardDetails,
): ChildContainer {
  component.addChild?.(renderCompileReceipt(theme, details));
  return component;
}

/**
 * Flash a guard status in the footer and clear it after a few seconds.
 * Mirrors pi-tool-guard's transient status.
 */
export function showGuardStatus(ctx: ExtensionContext, text: string): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setStatus(STATUS_KEY, text);

  const key: object = ctx.ui;
  const previous = statusTimers.get(key);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    if (statusTimers.get(key) !== timer) return;
    statusTimers.delete(key);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }, STATUS_DURATION_MS);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  statusTimers.set(key, timer);
}
