/**
 * card-progress.ts — the card's live progress primitives: duration sparks, side rails,
 * shimmer text, the progress strip and its pulse.
 */
import { mixColors, rgbColor } from "@earendil-works/pi-tui";
import { themeText, type Foreground, type GroveTheme } from "./theme.js";
import { type Glyphs, type TreeNode } from "./tree-model.js";
import { elapsedFor, type PulseBase } from "./card-row.js";

/** Maximum duration bars shown in the rollup, oldest call first. */
const SPARK_CELLS = 8;

/** Height levels for one duration bar per call in each glyph mode. */
const UNICODE_SPARK_BARS = [..."▁▂▃▄▅▆▇█"];
const ASCII_SPARK_BARS = [...".:-=+*#@"];
/** Theme color ramp: short calls green, middle calls yellow, long calls red. */
const SPARK_BAR_COLORS = [
  "success", "success", "success", "warning", "warning", "error", "error", "error",
] as const;

/** Absolute duration window: cells span 50ms to 10s on a log curve. */
const SPARK_FLOOR_MS = 50;
const SPARK_CEIL_MS = 10_000;

/** Maximum visible width of each per-row elapsed-time rail. */
const SIDE_DURATION_MAX_CELLS = 8;

/** Place one duration on the fixed log scale, so a height means the same thing on every card. */
function sparkPosition(ms: number): number {
  const floor = Math.log1p(SPARK_FLOOR_MS);
  const span = Math.log1p(SPARK_CEIL_MS) - floor;
  return Math.max(0, Math.min(1, (Math.log1p(Math.max(0, ms)) - floor) / span));
}
/** Render one height-coded cell per call, on an absolute scale. */
export function durationSpark(tools: readonly TreeNode[], theme: GroveTheme, glyphs: Glyphs): string {
  const recent = tools.slice(-SPARK_CELLS);
  if (recent.length === 0) return "";
  const now = Date.now();
  const took = recent.map(tool =>
    tool.duration ?? (tool.status === "running" ? Math.max(0, now - tool.started) : 0),
  );
  if (took.every(value => value <= 0)) return "";

  // Heights are absolute, not normalised to the window: a fast card reads low and a slow one
  // reads tall, so the bars say how slow a call was, not which call was the slowest.
  const heights = took.map(value => (value <= 0 ? 0 : sparkPosition(value)));

  const bars = glyphs.spark === "ascii" ? ASCII_SPARK_BARS : UNICODE_SPARK_BARS;
  return heights
    .map((height, index) => {
      const level = Math.round(height * (bars.length - 1));
      const bar = bars[level]!;
      return themeText(theme, SPARK_BAR_COLORS[level]!, bar);
    })
    .join("");
}

/** Find the longest elapsed interval across every call and reasoning row in the card. */
export function longestElapsed(nodes: readonly TreeNode[], now: number): number {
  let longest = 0;
  for (const node of nodes)
    longest = Math.max(longest, elapsedFor(node, now), longestElapsed(node.children, now));
  return longest;
}

/** Paint a responsive duration track against the longest interval in its card. */
export function sideDurationRail(
  elapsed: number,
  scale: number,
  width: number,
  theme: GroveTheme,
  glyphs: Glyphs,
  color: Foreground,
): string {
  const cells = Math.max(2, Math.min(SIDE_DURATION_MAX_CELLS, Math.floor(width / 9)));
  const fraction = scale > 0 ? Math.max(0, elapsed) / scale : 0;
  const filled = Math.round(Math.min(1, fraction) * cells);
  const fill = glyphs.spark === "ascii" ? "#" : "━";
  return themeText(theme, color, fill.repeat(filled)) +
    themeText(theme, "muted", glyphs.h.repeat(cells - filled));
}

const SHIMMER_BAND = 3;
const SHIMMER_MIN_MS = 1_000;
const SHIMMER_MAX_MS = 2_600;

/** A soft, fixed-width color band that sweeps across visible running-call text. */
export function shimmerText(text: string, theme: GroveTheme, now: number, started: number, bold = false): string {
  const cells = [...text];
  if (cells.length === 0) return "";

  // Scale the sweep to the fitted text so the light band remains visible on narrow rows.
  const travel = cells.length + SHIMMER_BAND * 2;
  const period = Math.min(SHIMMER_MAX_MS, Math.max(SHIMMER_MIN_MS, travel * 45));
  const elapsed = Math.max(0, now - started);
  const progress = (elapsed % period) / period;
  const center = progress * travel - SHIMMER_BAND;

  // Group adjacent cells with the same role to keep ANSI output compact.
  let output = "";
  let role: Foreground | undefined;
  let chunk = "";
  const flush = () => {
    if (role !== undefined && chunk) output += themeText(theme, role, chunk, bold);
  };
  for (const [index, cell] of cells.entries()) {
    const distance = Math.abs(index - center);
    const nextRole: Foreground = distance < 0.75 ? "text" : distance < 1.75 ? "accent" : "muted";
    if (nextRole !== role) {
      flush();
      role = nextRole;
      chunk = "";
    }
    chunk += cell;
  }
  flush();
  return output;
}

const PROGRESS_CELLS = 10;
/** Plain test themes have no active palette, so use explicit red and green endpoints. */
const FALLBACK_PROGRESS_COLORS = { error: rgbColor(255, 0, 0), success: rgbColor(0, 255, 0) };

/** Blend the error-to-success ramp at one position, so a cue, its bar and its share agree. */
export function progressRamp(theme: GroveTheme, position: number, text: string): string {
  const palette = theme.colors ?? FALLBACK_PROGRESS_COLORS;
  return theme.style(text, { fg: mixColors(palette.error, palette.success, Math.max(0, Math.min(1, position)), "oklch") });
}

/** Blend the theme's error and success colors for one progress cell. */
export function progressCellText(theme: GroveTheme, index: number, cells = PROGRESS_CELLS, glyph = "▰"): string {
  return progressRamp(theme, cells > 1 ? index / (cells - 1) : 0, glyph);
}

/** Paint a static progress bar with an optional percentage, leaving empty cells visually quiet. */
export function taskProgressText(progress: number, theme: GroveTheme, glyphs: Glyphs, showPercent = true): string {
  const value = Math.max(0, Math.min(100, Math.round(progress)));
  const filled = Math.round((value / 100) * PROGRESS_CELLS);
  const cue = glyphs.progress ? progressRamp(theme, value / 100, glyphs.progress + "  ") : "";
  const bar = Array.from(
    { length: filled },
    (_, index) => progressCellText(theme, index),
  ).join("");
  return cue + bar +
    themeText(theme, "dim", "▱".repeat(PROGRESS_CELLS - filled)) +
    (showPercent ? progressRamp(theme, value / 100, ` ${String(value).padStart(3, " ")}%`) : "");
}

/** One breathe cycle for the active phase marker, slow enough to read as a pulse. */
export const PULSE_MS = 1600;
/** Deepest point of the breathe: the marker quiets toward the muted role, never to nothing. */
const PULSE_DEPTH = 0.85;

/** Blend the marker's own role toward muted on a cosine curve, so it breathes instead of blinking. */
export function pulseText(glyph: string, theme: GroveTheme, now: number, base: PulseBase = "accent"): string {
  const palette = theme.colors;
  const from = palette?.[base];
  if (!from || !palette?.muted) return themeText(theme, base, glyph);
  const phase = (now % PULSE_MS) / PULSE_MS;
  const breath = ((1 - Math.cos(phase * 2 * Math.PI)) / 2) * PULSE_DEPTH;
  return theme.style(glyph, { fg: mixColors(from, palette.muted, breath, "oklch") });
}

/** Quarter steps of the progress circle, so its fill never overstates the share it reports. */
export function progressGlyph(progress: number, glyphs: Glyphs): string {
  const index = Math.min(4, Math.round(progress / 25));
  return glyphs.pie[index] ?? glyphs.dot;
}
