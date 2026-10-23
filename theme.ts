import type { Theme } from "@earendil-works/pi-coding-agent";
import { glyphWords, markFor, toolWord, type IconMode } from "./icons.js";

export type GroveTheme = Pick<Theme, "style"> & {
  /** Optional active palette used to blend progress cells; plain formatters may omit it. */
  colors?: Pick<Theme["colors"], "error" | "success">;
};

/** Explicit unstyled formatter for persisted summaries and text-only previews. */
export const plainTheme: GroveTheme = { style: text => text };

export type Foreground = "toolTitle" | "toolOutput" | "text" | "muted" | "dim"
  | "accent" | "success" | "error" | "warning"
  | "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext"
  | "syntaxVariable" | "syntaxFunction" | "syntaxKeyword";

export function themeText(theme: GroveTheme = plainTheme, token: Foreground, text: string, bold = false): string {
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

/** One cell for a tool: its glyph when the font has one, its word otherwise. */
export function toolLabel(name: string, theme?: GroveTheme, icons = true, iconMode: IconMode = "auto"): string {
  return themeText(theme, toolColor(name), icons ? toolWord(name, iconMode) : name, true);
}

export function metric(theme: GroveTheme | undefined, value: string | number, unit: string): string {
  return `${themeText(theme, "accent", String(value))} ${themeText(theme, "muted", unit)}`;
}

/** One-letter units keep counts short once glyphs are on; ASCII keeps the word. */
function unitLetter(word: string, iconMode: IconMode): string | undefined {
  if (!glyphWords(iconMode)) return undefined;
  if (/^matches?$/.test(word)) return "M";
  if (/^lines?$/.test(word)) return "L";
  if (/^files?$/.test(word)) return "F";
  if (/^entr(?:y|ies)$/.test(word)) return "E";
  if (/^results?$/.test(word)) return "R";
  return undefined;
}

/** Recolor bounded plain summaries, including persisted cards, without storing ANSI. */
export function paintSummary(
  name: string,
  summary: string,
  state: string,
  theme?: GroveTheme,
  icons = false,
  iconMode: IconMode = "auto",
): string {
  const paint = (role: Foreground, text: string) => themeText(theme, role, text);
  // A glyph only ever replaces a word when the terminal font can draw it.
  const mark = (word: string) => (icons ? markFor(word, iconMode) : undefined);
  if (state === "error") return paint("error", summary);
  if (state === "cancelled" || state === "incomplete") return paint("warning", summary);
  if (state === "running") return paint("syntaxVariable", summary);
  const diff = name === "edit" && summary.match(/^(\+\d+)\/(\-\d+)$/);
  if (diff) return paint("toolDiffAdded", diff[1]) + paint("dim", "/") + paint("toolDiffRemoved", diff[2]);
  const shell = name === "bash" && summary.match(/^(done|error|exit \d+) in (.+?)( · truncated)?$/);
  if (shell) {
    const outcome = mark(shell[1] === "done" ? "done" : "error");
    const head = outcome === undefined ? paint(shell[1] === "done" ? "success" : "error", shell[1]) : outcome;
    // A glyph already says which happened, so the connective word is dead weight.
    const glue = outcome === undefined ? " " + paint("dim", "in") : "";
    const time = paint("syntaxVariable", shell[2]) + (shell[3] ? paint("warning", shell[3]) : "");
    return head + glue + " " + time;
  }
  const counts = summary.match(/^(\d+) (matches?|lines?|files?|entr(?:y|ies)|results?)(?: in (\d+) (files?))?$/);
  if (counts) {
    const short = (word: string): string => {
      const letter = icons ? unitLetter(word, iconMode) : undefined;
      return letter === undefined ? word : letter;
    };
    const total = metric(theme, counts[1], short(counts[2]));
    return counts[3] ? total + " " + paint("dim", "in") + " " + metric(theme, counts[3], short(counts[4])) : total;
  }
  const bytes = name === "write" && summary.match(/^(\d+)b$/);
  if (bytes) return paint("accent", bytes[1]) + paint("muted", "b");
  if (/^(done|applied|written|success)$/.test(summary)) {
    const outcome = mark(summary);
    return paint("success", outcome === undefined ? summary : outcome);
  }
  return paint("muted", summary);
}
