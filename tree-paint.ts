/**
 * tree-paint.ts — turns one group into the lines of its collapsed or revealed card,
 * and records the click target of every line it paints.
 */
import { colorizeDiff, fitToolLine, formatElapsed, summaryLine } from "./block-render.js";
import { labelGap, type IconMode } from "./icons.js";
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
  groupTiming,
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

/** How long one blink frame lasts; the watch timer repaints on the same cadence. */
export const BLINK_MS = 450;

/** Colour and glyph of a row marker: the call state, not whether the row opens. */
function stateMark(node: TreeNode, glyphs: Glyphs, now: number): { glyph: string; color: Foreground } {
  if (node.kind === "thinking") return { glyph: glyphs.dot, color: "muted" };
  switch (node.status) {
    case "running":
      // A running call pulses between the filled and the outline dot.
      return { glyph: Math.floor(now / BLINK_MS) % 2 === 0 ? glyphs.dot : glyphs.hollow, color: "warning" };
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

  // The headline always leads the card, even for a single call: it is the frame that
  // tells you what this turn did, and the rows below are its detail.
  if (tools.length > 0) {
    const timing = groupTiming(group.rows);
    const errors = countErrors(tools);
    const total = tools.length;
    const scope =
      visible.length === total
        ? counted(theme, total, "call", "calls")
        : themeText(theme, "accent", String(visible.length)) +
          themeText(theme, "dim", " of ") +
          themeText(theme, "muted", String(total)) +
          themeText(theme, "muted", " calls");
    const parts = [scope, ...toolBreakdown(tools, theme, glyphs, 4, state.settings.icons, state.settings.iconMode)];
    if (errors > 0) parts.push(errorCell(errors, theme, state.settings.icons, state.settings.iconMode));
    parts.push(themeText(theme, "dim", formatElapsed(timing.elapsed)));
    const headColor: Foreground = timing.running ? "warning" : errors > 0 ? "error" : "dim";
    const head = themeText(theme, headColor, glyphs.rail + " " + (reveal ? glyphs.open : glyphs.closed) + " ");
    lines.push(fitToolLine(head + parts.join(themeText(theme, "dim", DOT)), width));
    targets.set(0, GROUP_TARGET);
  }

  const emit = (nodes: TreeNode[], ancestors: boolean[]): void => {
    for (const [index, node] of nodes.entries()) {
      const last = index === nodes.length - 1;
      const guide = ancestors.map(ancestor => (ancestor ? "   " : glyphs.pipe + "  ")).join("");
      const open = expandAll || state.expanded.has(node.id);
      const mark = stateMark(node, glyphs, Date.now());
      const railColor: Foreground =
        node.kind === "thinking"
          ? "muted"
          : node.status === "error"
            ? "error"
            : node.status === "running"
              ? "accent"
              : "dim";
      const label =
        node.kind === "thinking"
          ? themeText(theme, "muted", "thinking")
          : toolLabel(node.name, theme, state.settings.icons, state.settings.iconMode);
      // The branch keeps its stem; the dot after it carries the call state, so a running
      // call blinks in place instead of the marker only saying open or closed.
      const stem = glyphs.rail + " " + guide + (last ? glyphs.end : glyphs.tee) + "─ ";
      // A patched glyph overhangs its cell, so the words after it need that column back.
      const gap = node.kind === "thinking" ? "" : labelGap(node.name, state.settings.icons, state.settings.iconMode);
      const connector =
        themeText(theme, railColor, stem) + themeText(theme, mark.color, mark.glyph) + " " + label + gap;
      // Reasoning stays a plain label until it is clicked; the text lives in the preview.
      const detail = node.kind === "thinking" ? "" : detailOf(node);
      const tail =
        node.kind === "thinking"
          ? themeText(theme, "dim", formatElapsed(node.duration ?? (node.status === "running" ? Date.now() - node.started : 0)))
          : rowTail(node, theme, glyphs, state.settings.icons, state.settings.iconMode);
      const line = detail
        ? summaryLine(
            connector,
            themeText(theme, node.status === "error" ? "error" : "muted", detail),
            themeText(theme, "dim", DOT),
            tail,
            width,
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
        const prefix = themeText(theme, "dim", glyphs.rail + " " + childGuide + glyphs.pipe + " ");
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
  return lines;
}

