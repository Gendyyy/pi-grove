import type { Theme } from "@earendil-works/pi-coding-agent";
import { iconPrefix, type IconMode } from "./icons.js";

export type LiuovoTheme = Pick<Theme, "style">;

/** Explicit unstyled formatter for persisted summaries and text-only previews. */
export const plainTheme: LiuovoTheme = { style: (text) => text };

export type Foreground = "toolTitle" | "toolOutput" | "text" | "muted" | "dim"
  | "accent" | "success" | "error" | "warning"
  | "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext"
  | "syntaxVariable" | "syntaxFunction" | "syntaxKeyword";

export function themeText(theme: LiuovoTheme = plainTheme, token: Foreground, text: string, bold = false): string {
  return theme.style(text, { fg: token, ...(bold ? { bold: true } : {}) });
}

/** Borrow palette roles, not status colors. Custom themes remain authoritative. */
export function toolColor(name: string): Foreground {
  if (["read", "grep", "find", "ls"].includes(name)) return "syntaxVariable";
  if (["write", "edit"].includes(name)) return "syntaxFunction";
  // The built-in accent is violet already; blue execution keeps orchestration distinct.
  if (name === "bash") return "syntaxKeyword";
  return "accent";
}

export function toolLabel(name: string, theme?: LiuovoTheme, icons = true, iconMode: IconMode = "auto"): string {
  return themeText(theme, toolColor(name), `${icons ? iconPrefix(name, iconMode) : ""}${name}`, true);
}

export function metric(theme: LiuovoTheme | undefined, value: string | number, unit: string): string {
  return `${themeText(theme, "accent", String(value))} ${themeText(theme, "muted", unit)}`;
}

/** Recolor bounded plain summaries, including persisted cards, without storing ANSI. */
export function paintSummary(name: string, summary: string, state: string, theme?: LiuovoTheme): string {
  const paint = (role: Foreground, text: string) => themeText(theme, role, text);
  if (state === "error") return paint("error", summary);
  if (state === "cancelled" || state === "incomplete") return paint("warning", summary);
  if (state === "running") return paint("syntaxVariable", summary);
  const diff = name === "edit" && summary.match(/^(\+\d+)\/(\-\d+)$/);
  if (diff) return `${paint("toolDiffAdded", diff[1])}${paint("dim", "/")}${paint("toolDiffRemoved", diff[2])}`;
  const shell = name === "bash" && summary.match(/^(done|error|exit \d+) in (.+?)( · truncated)?$/);
  if (shell) return `${paint(shell[1] === "done" ? "success" : "error", shell[1])} ${paint("dim", "in")} ${paint("syntaxVariable", shell[2])}${shell[3] ? paint("warning", shell[3]) : ""}`;
  const counts = summary.match(/^(\d+) (matches?|lines?|files?|entries|results)(?: in (\d+) (files?))?$/);
  if (counts) return metric(theme, counts[1], counts[2]) + (counts[3] ? ` ${paint("dim", "in")} ${metric(theme, counts[3], counts[4])}` : "");
  const bytes = name === "write" && summary.match(/^(\d+)b$/);
  if (bytes) return `${paint("accent", bytes[1])}${paint("muted", "b")}`;
  if (/^(done|applied|written|success)$/.test(summary)) return paint("success", summary);
  return paint("muted", summary);
}
