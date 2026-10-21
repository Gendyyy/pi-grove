/**
 * block-render.ts — the tight tool-block renderer for grove.
 *
 * Pure, stateless rendering kernel extracted from index.ts (issue 185):
 * builds the 2-line tool blocks and the width-aware
 * component that fits pre-composed lines to the live viewport. No extension
 * plumbing, no state — only rendering.
 */
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  RESET,
  grepResultCounts,
  nonEmptyLineCount,
  stripReasoning,
} from "./render.js";
import type { GroveMode } from "./settings.js";
import { metric, paintSummary, themeText, toolLabel, type GroveTheme } from "./theme.js";
import type { IconMode } from "./icons.js";
import { readDetail } from "./details.js";

/** Hanging indent for detail and expanded continuation lines. */
const INDENT = "  ";

/** Collapse whitespace/newlines to one line (width-based truncation happens at render). */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Fit a rendered line while preserving its useful result tail. */
export function fitToolLine(line: string, width: number): string {
  const max = Math.max(1, width);
  if (visibleWidth(line) <= max) return line;
  const arrowIndex = line.indexOf("→");
  if (arrowIndex < 0) return truncateToWidth(line, max, "…");

  const tail = line.slice(arrowIndex);
  const tailWidth = visibleWidth(tail);
  if (tailWidth >= max) return truncateToWidth(tail, max, "…");
  const head = line.slice(0, arrowIndex).trimEnd();
  return `${truncateToWidth(head, max - tailWidth - 1, "…")} ${tail}`;
}

/** Fit semantic fields before flattening ANSI, so arrows inside a goal are harmless. */
export function summaryLine(prefix: string, detail: string, separator: string, summary: string, width = Infinity): string {
  const join = (body: string, tail: string) => `${prefix}${body ? `${prefix.trim() ? " " : ""}${body}` : ""}${separator}${tail}`;
  const full = join(detail, summary);
  if (visibleWidth(full) <= width) return full;
  const max = Math.max(1, width);
  const fixed = visibleWidth(prefix) + visibleWidth(separator);
  if (fixed + 2 > max) return truncateToWidth(prefix, max, "…");
  const tail = truncateToWidth(summary, max - fixed, "…");
  const room = max - fixed - visibleWidth(tail) - (prefix.trim() ? 1 : 0);
  return join(room > 1 ? truncateToWidth(detail, room, "…") : "", tail);
}

/**
 * A width-aware component: truncates each pre-composed (ANSI-colored) line to the
 * live viewport width so nothing soft-wraps. Re-flows on resize
 * because render(width) is re-invoked by the TUI.
 *
 * Static sources and opted-in settled builders cache fitted lines per width: the TUI re-invokes render() on every frame, and without
 * the cache every settled block in the transcript re-fits its lines on every
 * keystroke. invalidate() also reruns settled builders so theme colors refresh.
 * Live function sources (running calls with ticking elapsed time) are not cached.
 */
export class WidthAwareLines {
  private cache?: { width: number; lines: string[] };

  constructor(
    private source: string[] | ((width: number) => string[]),
    private background?: (text: string) => string,
    private cacheSource = false,
    private outputPad = 1,
  ) {}
  static reuse(previous: Component | undefined, source: (width: number) => string[], background: (text: string) => string, cacheSource = false, outputPad = 1): WidthAwareLines {
    if (!(previous instanceof WidthAwareLines)) return new WidthAwareLines(source, background, cacheSource, outputPad);
    previous.source = source;
    previous.background = background;
    previous.cacheSource = cacheSource;
    previous.outputPad = outputPad;
    previous.invalidate();
    return previous;
  }
  invalidate(): void {
    this.cache = undefined;
  }
  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const max = Math.max(0, width);
    if (max === 0) return [];
    // Reserve both sides while retaining at least one content cell on narrow screens.
    const pad = Math.min(Math.max(0, Math.floor(this.outputPad)), Math.floor((max - 1) / 2));
    const inset = " ".repeat(pad);
    const contentWidth = max - 2 * pad;
    const lines =
      typeof this.source === "function" ? this.source(contentWidth) : this.source;
    const rendered = lines.map((line) => {
      const fitted = inset + fitToolLine(line, contentWidth);
      if (!this.background) return fitted;
      const padded =
        fitted + " ".repeat(Math.max(0, max - visibleWidth(fitted)));
      // Raw foreground styling uses RESET, which also clears an enclosing
      // background. Apply the background independently to every reset-delimited
      // segment so it remains continuous through the full padded line.
      return padded
        .split(RESET)
        .map((segment) => this.background!(`${segment}${RESET}`))
        .join("");
    });
    if (typeof this.source !== "function" || this.cacheSource)
      this.cache = { width, lines: rendered };
    return rendered;
  }
}

/** Dim line-2 detail when the model gave no `reasoning`. Always ONE line. */
function argDetail(name: string, args: Record<string, unknown>): string {
  if (name === "bash" && typeof args.command === "string")
    return oneLine(args.command);
  if (
    (name === "grep" || name === "find") &&
    typeof args.pattern === "string"
  ) {
    return oneLine(
      typeof args.path === "string"
        ? `${args.pattern} in ${args.path}`
        : String(args.pattern)
    );
  }
  if (typeof args.path === "string") return oneLine(args.path);
  if (typeof args.name === "string") return oneLine(args.name);
  return "";
}

/** Compact elapsed time for an in-progress tool. */
export function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1000) return "<1s";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60)
    return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

export interface ShellSummary {
  exit_code?: number;
  wall_time_seconds?: number;
  truncated?: boolean;
  full_output_path?: string;
}

/** Copy only bounded display metadata; never persist the programmatic output. */
export function shellSummary(value: unknown): ShellSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const summary: ShellSummary = {};
  if (typeof raw.exit_code === "number" && Number.isInteger(raw.exit_code)) summary.exit_code = raw.exit_code;
  if (typeof raw.wall_time_seconds === "number" && Number.isFinite(raw.wall_time_seconds) && raw.wall_time_seconds >= 0)
    summary.wall_time_seconds = raw.wall_time_seconds;
  if (typeof raw.truncated === "boolean") summary.truncated = raw.truncated;
  if (typeof raw.full_output_path === "string") summary.full_output_path = raw.full_output_path.slice(0, 4096);
  return Object.keys(summary).length ? summary : undefined;
}

/** Prefer structured shell metadata without rendering its potentially 1 MiB output. */
function plainToolSummary(
  name: string, result: any, isError: boolean,
  args: Record<string, unknown> = {}, elapsedMs?: number
): string {
  const text = textFromResult(result);
  if (name === "bash") {
    const shell = shellSummary(result?.structuredContent) ?? shellSummary(readDetail(result?.details, "piGroveShell"));
    const exit = shell?.exit_code ?? Number(text.match(/exit code: (\d+)/)?.[1] ?? 0);
    const duration = elapsedMs ?? (shell?.wall_time_seconds === undefined ? undefined : shell.wall_time_seconds * 1000);
    const status = exit !== 0 ? `exit ${exit}` : isError ? "error" : "done";
    const time = duration === undefined ? "" : ` in ${formatElapsed(duration)}`;
    return `${status}${time}${shell?.truncated ? " · truncated" : ""}`;
  }
  if (isError) return text.split("\n")[0] || "error";
  if (name === "read") {
    const lines = text.split("\n").length;
    return lines + (lines === 1 ? " line" : " lines");
  }
  if (name === "write") {
    if (typeof args.content === "string" && !args.content.includes("\0")) {
      const lines = args.content.length === 0 ? 0 : (args.content.match(/\n/g)?.length ?? 0) + (args.content.endsWith("\n") ? 0 : 1);
      return `${lines} ${lines === 1 ? "line" : "lines"}`;
    }
    const bytes = text.match(/wrote (\d+) bytes/i)?.[1];
    return bytes ? `${bytes}b` : "written";
  }
  if (name === "edit") {
    const diff = result?.details?.diff as string | undefined;
    if (!diff) return "applied";
    let add = 0, del = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) add++;
      if (line.startsWith("-") && !line.startsWith("---")) del++;
    }
    return `+${add}/-${del}`;
  }
  if (name === "grep") {
    const { matches, files } = grepResultCounts(text);
    return `${matches} ${matches === 1 ? "match" : "matches"} in ${files} ${files === 1 ? "file" : "files"}`;
  }
  const count = nonEmptyLineCount(text);
  const noun = name === "find" ? (count === 1 ? "file" : "files") : name === "ls" ? (count === 1 ? "entry" : "entries") : (count === 1 ? "result" : "results");
  return count + " " + noun;
}

/** One presentation for standalone tools and bounded, persisted nested summaries. */
export function summarizeToolResult(
  name: string, result: any, isError: boolean,
  args: Record<string, unknown> = {}, elapsedMs?: number, theme?: GroveTheme
): string {
  return paintSummary(name, plainToolSummary(name, result, isError, args, elapsedMs), isError ? "error" : "success", theme);
}

/** Pull the first text block out of a tool result / partial (shape varies). */
function textFromResult(r: any): string {
  const content = r?.content ?? r?.partialResult?.content;
  if (Array.isArray(content)) {
    const c = content.find((x: any) => x?.type === "text");
    if (c?.text) return c.text;
  }
  if (typeof r?.output === "string") return r.output;
  if (typeof r?.error === "string") return r.error;
  if (typeof r?.message === "string") return r.message;
  if (typeof r?.details?.error === "string") return r.details.error;
  return "";
}

/** Replace tabs with painted cells using stops relative to the code payload. */
function expandTabs(text: string): string {
  let column = 0;
  let expanded = "";
  for (const character of text) {
    if (character === "\t") {
      const spaces = 8 - (column % 8);
      expanded += " ".repeat(spaces);
      column += spaces;
    } else {
      expanded += character;
      column += visibleWidth(character);
    }
  }
  return expanded;
}

/** Keep line-number prefixes out of edit payload tab-stop calculations. */
function expandDiffTabs(line: string): string {
  const numbered = line.match(/^([ +\-]\s*\d+ )(.*)$/);
  return numbered
    ? `${numbered[1]}${expandTabs(numbered[2])}`
    : expandTabs(line);
}

/** Colorize a unified/line-numbered diff string (edit tool's details.diff). */
export function colorizeDiff(diff: string, theme?: GroveTheme): string[] {
  return diff.split("\n").map((rawLine) => {
    const line = expandDiffTabs(rawLine);
    if (line.startsWith("+") && !line.startsWith("+++"))
      return themeText(theme, "toolDiffAdded", line);
    if (line.startsWith("-") && !line.startsWith("---"))
      return themeText(theme, "toolDiffRemoved", line);
    if (line.startsWith("@@")) return themeText(theme, "accent", line);
    return themeText(theme, "toolDiffContext", line);
  });
}

/**
 * Build the expanded (C-o) continuation lines for a settled tool result:
 *   - bash: the full multi-line command input, then its output
 *   - edit/write: the colored line-numbered diff when present
 *   - otherwise: the raw result text
 * Each line is prefixed with the hanging INDENT.
 */
function expandedLines(
  name: string,
  args: Record<string, unknown>,
  result: any, theme?: GroveTheme
): string[] {
  const out: string[] = [];

  // bash: show the full command (collapsed line 2 is truncated to one line).
  if (name === "bash" && typeof args.command === "string") {
    const cmdLines = args.command.replace(/\s+$/, "").split("\n");
    cmdLines.forEach((cl, i) => {
      const prefix = themeText(theme, i === 0 ? "accent" : "dim", i === 0 ? "$ " : "  ");
      out.push(`${INDENT}${prefix}${themeText(theme, "accent", cl)}`);
    });
  }

  // Whole-file writes do not provide a useful diff. Show the actual written
  // content instead of repeating the generic "Successfully wrote..." result.
  if (name === "write" && typeof args.content === "string") {
    if (args.content.length === 0) {
      out.push(`${INDENT}${themeText(theme, "dim", "(empty file)")}`);
      return out;
    }
    const splitLines = args.content.split("\n");
    const contentLines = args.content.endsWith("\n")
      ? splitLines.slice(0, -1)
      : splitLines;
    const lineNumberWidth = String(contentLines.length).length;
    contentLines.forEach((line, index) => {
      const lineNumber = String(index + 1).padStart(lineNumberWidth, " ");
      out.push(`${INDENT}${themeText(theme, "dim", `${lineNumber} `)}${themeText(theme, "text", expandTabs(line))}`);
    });
    return out;
  }

  // Prefer the structured diff over the generic "Successfully replaced..." text.
  const diff = result?.details?.diff as string | undefined;
  if (diff && diff.trim()) {
    for (const dl of colorizeDiff(diff, theme)) out.push(`${INDENT}${dl}`);
    return out;
  }

  const shell = name === "bash"
    ? shellSummary(result?.structuredContent) ?? shellSummary(readDetail(result?.details, "piGroveShell"))
    : undefined;
  if (shell?.full_output_path) out.push(`${INDENT}${themeText(theme, "muted", `Full output: ${shell.full_output_path}`)}`);
  const text = textFromResult(result).replace(/\s+$/, "");
  if (text)
    for (const raw of text.split("\n"))
      out.push(`${INDENT}${themeText(theme, "toolOutput", raw)}`);
  return out;
}

/**
 * Build the rendered lines for one settled tool call. Shared by the live
 * renderResult and the demo generator so the demo shows REAL output, never
 * hand-typed ANSI. `args` includes the model's `reasoning` (stripped here).
 */
export function buildToolBlock(
  name: string,
  args: Record<string, unknown>,
  result: any,
  opts: {
    isError?: boolean;
    isPartial?: boolean;
    executionStarted?: boolean;
    expanded?: boolean;
    elapsedMs?: number;
    mode?: GroveMode;
    icons?: boolean;
    iconMode?: IconMode;
    width?: number;
    theme?: GroveTheme;
  } = {}
): string[] {
  const {
    isError = false,
    isPartial = false,
    executionStarted = true,
    expanded = false,
    elapsedMs,
    mode = "default",
    icons = true,
    iconMode = "auto",
    width,
    theme,
  } = opts;
  const { reasoning, rest } = stripReasoning(args ?? {});

  // Settled success/error is already encoded by Pi's native row background.
  // Only running calls need an inline state mark.
  const runningPrefix = isPartial ? `${themeText(theme, "dim", "·")} ` : "";
  const summary = isPartial
    ? themeText(theme, "syntaxVariable", executionStarted ? formatElapsed(elapsedMs ?? 0) : "preparing")
    : summarizeToolResult(name, result, isError, rest, elapsedMs, theme);

  const label = `${runningPrefix}${toolLabel(name, theme, icons, iconMode)}`;
  const arrow = ` ${themeText(theme, "dim", "→")} `;
  const headline = themeText(theme, "text", oneLine(reasoning || argDetail(name, rest)));
  const detail = argDetail(name, rest);
  // Keep the target on failures too; width fitting preserves the useful error
  // tail while the command/path answers what actually failed.
  const line2 = summaryLine(INDENT, themeText(theme, "muted", detail), detail ? arrow : arrow.trimStart(), summary, width);
  let lines: string[];
  if (mode === "reasoning") {
    lines = [
      summaryLine(label, headline, arrow, summary, width),
    ];
  } else if (mode === "result") {
    lines = [summaryLine(label, detail ? themeText(theme, "muted", detail) : "", arrow, summary, width)];
  } else {
    lines = [truncateToWidth(`${label} ${headline}`, width ?? Infinity, "…"), line2];
  }
  if (expanded && !isPartial) lines.push(...expandedLines(name, rest, result, theme));
  return lines;
}
