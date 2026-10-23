/**
 * tree-paint.ts — turns one group into the lines of its collapsed or revealed card,
 * and records the click target of every line it paints.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { colorizeDiff, fitToolLine, formatElapsed, summaryLine } from "./block-render.js";
import type { IconMode } from "./icons.js";
import { plainTheme, themeText, toolLabel, type Foreground, type GroveTheme } from "./theme.js";
import {
  DOT,
  ELLIPSIS,
  GROUP_TARGET,
  PREVIEW_LINES,
  countErrors,
  errorCell,
  counted,
  detailOf,
  rowTail,
  toolBreakdown,
  toolCounts,
  treeGlyphs,
  type Glyphs,
  type PaintScope,
  type TreeGroup,
  type TreeNode,
  type TreeSettings,
} from "./tree-model.js";
/** Render inputs shared by the painter and by tests. */
export interface PaintState {
  settings: TreeSettings;
  expanded: ReadonlySet<string>;
}

/** Repaint cadence for running markers and live duration traces. */
/** One spinner frame, and one honest duration refresh, per tick while a card is live. */
export const SPIN_MS = 100;

/** Maximum duration bars shown in the rollup, oldest call first. */
const SPARK_CELLS = 8;

/** Height levels for one duration bar per call in each glyph mode. */
const UNICODE_SPARK_BARS = [..."▁▂▃▄▅▆▇█"];
const ASCII_SPARK_BARS = [...".:-=+*#@"];
/** Theme color ramp: short calls green, middle calls yellow, long calls red. */
const SPARK_BAR_COLORS = [
  "success", "success", "success", "warning", "warning", "error", "error", "error",
] as const;

/** Render relative call durations as a one-cell height bar per call. */
function durationSpark(tools: readonly TreeNode[], theme: GroveTheme, glyphs: Glyphs): string {
  const recent = tools.slice(-SPARK_CELLS);
  if (recent.length === 0) return "";
  const now = Date.now();
  const took = recent.map(tool =>
    tool.duration ?? (tool.status === "running" ? Math.max(0, now - tool.started) : 0),
  );
  if (took.every(value => value <= 0)) return "";

  // A log scale keeps one four-minute call from flattening every other point.
  const low = Math.log(Math.max(1, Math.min(...took)));
  const high = Math.log(Math.max(1, Math.max(...took)));
  const span = high - low;
  const heights = took.map(value =>
    span <= 0 ? 0.5 : (Math.log(Math.max(1, value)) - low) / span,
  );

  const bars = glyphs.spark === "ascii" ? ASCII_SPARK_BARS : UNICODE_SPARK_BARS;
  return heights
    .map((height, index) => {
      const level = Math.round(height * (bars.length - 1));
      const bar = bars[level]!;
      return themeText(theme, SPARK_BAR_COLORS[level]!, bar);
    })
    .join("");
}

/** The running marker at this instant: a frame of the ramp, wrap-around included. */
export function spinGlyph(glyphs: Glyphs, now: number): string {
  const frames = [...glyphs.spin];
  if (frames.length === 0) return glyphs.dot;
  return frames[Math.floor(now / SPIN_MS) % frames.length]!;
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

/** Keep progress green only at completion; a high estimate is still unfinished. */
function progressColor(progress: number): Foreground {
  if (progress < 34) return "error";
  if (progress < 67) return "warning";
  return "success";
}

/** Choose a theme role by a cell's position along the progress ramp. */
function progressCellColor(index: number): Foreground {
  const position = index / PROGRESS_CELLS;
  if (position < 0.3) return "error";
  if (position < 0.7) return "warning";
  return "success";
}

/** Paint a static progress bar and percentage, leaving empty cells visually quiet. */
function taskProgressText(progress: number, theme: GroveTheme, glyphs: Glyphs): string {
  const value = Math.max(0, Math.min(100, Math.round(progress)));
  const filled = Math.round((value / 100) * PROGRESS_CELLS);
  const color = progressColor(value);
  const cue = glyphs.progress ? themeText(theme, "accent", glyphs.progress + "  ") : "";
  const bar = Array.from(
    { length: filled },
    (_, index) => themeText(theme, progressCellColor(index), "▰"),
  ).join("");
  return cue + bar +
    themeText(theme, "dim", "▱".repeat(PROGRESS_CELLS - filled)) +
    themeText(theme, color, ` ${String(value).padStart(3, " ")}%`);
}

/** Colour and glyph of a row marker: the call state, not whether the row opens. */
function stateMark(node: TreeNode, glyphs: Glyphs, now: number): { glyph: string; color: Foreground } {
  if (node.kind === "thinking") return { glyph: glyphs.dot, color: "muted" };
  switch (node.status) {
    case "running":
      // A live call spins: the marker walks the frame ramp, one frame per tick, so the row
      // reads as in flight instead of as a dot that sometimes blinks out.
      return { glyph: spinGlyph(glyphs, now), color: "warning" };
    case "error":
      return { glyph: glyphs.dot, color: "error" };
    case "success":
      return { glyph: glyphs.dot, color: "success" };
    case "cancelled":
      return { glyph: glyphs.hollow, color: "muted" };
    default:
      return { glyph: glyphs.hollow, color: "warning" };
  }
}
/**
 * Draw one group as a tree of rows. Returns ANSI text per line and, when a target map is
 * provided, records which node id owns each clickable line.
 */
export function paintGroup(
  state: PaintState,
  group: TreeGroup,
  width: number,
  theme: GroveTheme = plainTheme,
  piExpanded = false,
  targets: Map<number, string> = new Map(),
): string[] {
  targets.clear();
  const lines: string[] = [];
  if (group.rows.length === 0) return lines;
  const glyphs = treeGlyphs(state.settings.iconMode);
  // Two different gestures: the header reveals every row of the group, while pi own
  // expand-all (ctrl+o) opens every level. A revealed row still opens only by click.
  const expandAll = piExpanded;
  const reveal = piExpanded || group.openAll;
  const limit = Math.max(1, state.settings.window);
  // Reasoning rows narrate the card but are not calls, so the rolling window and the
  // counts apply to tool rows only; reasoning from the window start onward stays in
  // place, which keeps each thought directly above the action it led to.
  const tools = group.rows.filter(row => row.kind !== "thinking");
  const truncated = !reveal && tools.length > limit;
  const visible = truncated ? tools.slice(-limit) : tools;
  // Only a truncated card drops old narration: it belongs to rows that scrolled away.
  const from = truncated && visible.length > 0 ? visible[0]!.seq : Number.NEGATIVE_INFINITY;
  const kept = new Set(visible.map(row => row.id));
  const rows = group.rows.filter(row => (row.kind === "thinking" ? row.seq >= from : kept.has(row.id)));

  // The headline always leads the card: the border names the current task, the rollup
  // counts its calls, and the rows below show their detail.
  const errors = countErrors(tools);
  let headerLine = "";
  if (tools.length > 0) {
    const total = tools.length;
    const scope =
      visible.length === total
        ? counted(theme, total, "call", "calls")
        : themeText(theme, "accent", String(visible.length)) +
          themeText(theme, "dim", " of ") +
          themeText(theme, "muted", String(total)) +
          themeText(theme, "muted", " calls");
    // Keep the rollup factual: progress, counts, duration shape and tool mix, with no status label.
    const parts: string[] = [];
    if (group.progress !== undefined) parts.push(taskProgressText(group.progress, theme, glyphs));
    parts.push(scope);
    // The duration shape sits before the tool mix: a narrow card drops the trailing parts
    // first, and "where did the time go" matters more than the fourth tool name.
    const spark = durationSpark(tools, theme, glyphs);
    if (spark) {
      const chart = glyphs.chart ? themeText(theme, "accent", glyphs.chart + "  ") : "";
      parts.push(chart + spark);
    }
    parts.push(...toolBreakdown(tools, theme, glyphs, 4, state.settings.icons, state.settings.iconMode));
    if (errors > 0) parts.push(errorCell(errors, theme, state.settings.icons, state.settings.iconMode));
    const head = themeText(theme, "dim", (reveal ? glyphs.open : glyphs.closed) + " ");
    headerLine = fitToolLine(head + parts.join(themeText(theme, "dim", DOT)), width);
  }
  // The rollup sits directly under the frame top: the card is the headline plus its rows,
  // with no goal or phase prose between them.
  if (headerLine) {
    lines.push(headerLine);
    targets.set(lines.length - 1, GROUP_TARGET);
  }

  const emit = (nodes: TreeNode[], ancestors: boolean[]): void => {
    for (const [index, node] of nodes.entries()) {
      const last = index === nodes.length - 1;
      const guide = ancestors.map(ancestor => (ancestor ? "   " : glyphs.pipe + "  ")).join("");
      const open = expandAll || state.expanded.has(node.id);
      const now = Date.now();
      const mark = stateMark(node, glyphs, now);
      // The guide is structure, not state: the dot and the row summary already carry the
      // outcome, so a failed call keeps a neutral stem instead of repainting the line.
      const stemColor: Foreground =
        node.kind === "thinking" ? "muted" : node.status === "running" ? "accent" : "dim";
      const label =
        node.kind === "thinking"
          ? themeText(theme, "muted", "thinking")
          : toolLabel(node.name, theme, state.settings.icons, state.settings.iconMode);
      // The branch keeps its stem; the dot after it carries the call state, so a running
      // call blinks in place instead of the marker only saying open or closed.
      const stem = guide + (last ? glyphs.end : glyphs.tee) + "─ ";
      const connector =
        themeText(theme, stemColor, stem) + themeText(theme, mark.color, mark.glyph) + " " + label;
      // Reasoning stays a plain label until it is clicked; the text lives in the preview.
      const detail = node.kind === "thinking" ? "" : detailOf(node);
      const tail =
        node.kind === "thinking"
          ? themeText(theme, "dim", formatElapsed(node.duration ?? (node.status === "running" ? now - node.started : 0)))
          : rowTail(node, theme, glyphs, state.settings.icons, state.settings.iconMode);
      const line = detail
        ? summaryLine(
            connector,
            // The dot between the tool word and its intent keeps the two readable apart.
            "· " + detail,
            themeText(theme, "dim", DOT),
            tail,
            width,
            fittedDetail => {
              const color: Foreground = node.status === "error" ? "error" : "muted";
              const leadLength =
                fittedDetail.startsWith("· ") ? 2 : fittedDetail.startsWith("·") ? 1 : 0;
              const lead = themeText(theme, color, fittedDetail.slice(0, leadLength));
              const words = fittedDetail.slice(leadLength);
              return lead + (node.status === "running"
                ? shimmerText(words, theme, now, node.started)
                : themeText(theme, color, words));
            },
          )
        : fitToolLine(connector + themeText(theme, "dim", DOT) + tail, width);
      lines.push(line);
      targets.set(lines.length - 1, node.id);

      if (open) emit(node.children, [...ancestors, last]);
      else if (state.settings.revealErrors)
        emit(node.children.filter(child => child.status === "error"), [...ancestors, last]);

      // Branch rows drill into their steps instead of dumping their own output.
      const preview = node.children.length === 0 ? node.preview ?? [] : [];
      if (open && preview.length > 0) {
        const childGuide = [...ancestors, last].map(ancestor => (ancestor ? "   " : glyphs.pipe + "  ")).join("");
        const prefix = themeText(theme, "dim", childGuide + glyphs.pipe + " ");
        const painted = node.previewDiff
          ? colorizeDiff(preview.join("\n"), theme)
          : preview.map(text => themeText(theme, "dim", text));
        for (const text of painted.slice(0, PREVIEW_LINES)) {
          lines.push(fitToolLine(prefix + text, width));
          targets.set(lines.length - 1, node.id);
        }
        if (node.previewTruncated || painted.length > PREVIEW_LINES) {
          lines.push(fitToolLine(prefix + themeText(theme, "dim", ELLIPSIS), width));
          targets.set(lines.length - 1, node.id);
        }
      }
    }
  };

  emit(rows, []);
  if (lines.length === 0 || width < 24) return lines;

  // One border around intent, rollup and calls: the group reads as a single object
  // instead of loose lines, and the frame keeps its width whatever the content is.
  const inner = Math.max(8, width - 4);
  const border = (text: string) => themeText(theme, "dim", text);
  const body = (line: string): string => {
    const fitted = fitToolLine(line, inner);
    return border(glyphs.v + " ") + fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted))) + border(" " + glyphs.v);
  };
  const titlePrefix = glyphs.tl + glyphs.h + " ";
  const titleBudget = Math.max(1, width - 10);
  const title = fitToolLine(group.intent || "GROVE", titleBudget);
  const topPlain = titlePrefix + title + " ";
  const fill = Math.max(0, width - 1 - visibleWidth(topPlain));
  const titleText = themeText(theme, "accent", title, true);
  const wrapped: string[] = [
    border(titlePrefix) +
      titleText +
      border(" " + glyphs.h.repeat(fill) + glyphs.tr),
  ];
  const remapped = new Map<number, string>();
  remapped.set(0, GROUP_TARGET);
  for (const [index, line] of lines.entries()) {
    wrapped.push(body(line));
    const target = targets.get(index);
    if (target !== undefined) remapped.set(wrapped.length - 1, target);
  }
  wrapped.push(border(glyphs.bl + glyphs.h.repeat(Math.max(0, width - 2)) + glyphs.br));
  remapped.set(wrapped.length - 1, GROUP_TARGET);
  targets.clear();
  for (const [index, target] of remapped) targets.set(index, target);
  return wrapped;
}

