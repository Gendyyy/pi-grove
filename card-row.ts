/**
 * card-row.ts — the shared row model: decides what each visible row says
 * (mark, label, detail, summary, duration, preview) before any layout draws it.
 */
import { colorizeDiff, formatElapsed } from "./block-render.js";
import { themeText, type Foreground, type GroveTheme } from "./theme.js";
import {
  DOT,
  ELLIPSIS,
  PREVIEW_LINES,
  countErrors,
  countToolCalls,
  detailOf,
  rowTail,
  type Glyphs,
  type TreeNode,
} from "./tree-model.js";
import type { CardContext } from "./card-layout.js";
import { toolLabel } from "./theme.js";

/** Roles a row marker can breathe in: the hue stays put, only its brightness moves. */
export type PulseBase = "accent" | "warning" | "error";

/** After this long a call is infrastructure, not progress, so the pulse stops instead of blinking forever. */
const PULSE_FREEZE_MS = 5 * 60_000;

/** One frame per 80 ms, whatever the frame count: fast enough to read as motion, never a flicker. */
const SPIN_MS = 80;

/** Return the same Grove elapsed interval used by the row's time label. */
export function elapsedFor(node: TreeNode, now: number): number {
  return node.duration ?? (node.status === "running" ? Math.max(0, now - node.started) : 0);
}

/** Frame of a running call's spinner: a quarter circle cycling, so a live row moves instead of blinking. */
export function spinnerGlyph(glyphs: Glyphs, now: number): string {
  const frames = glyphs.spinner;
  return frames[Math.floor(now / SPIN_MS) % frames.length] ?? glyphs.dot;
}

/** A row marker: its glyph, the role that colours it, and the role it breathes while live. */
interface StateMark {
  glyph: string;
  color: Foreground;
  /** A live call cycles its spinner instead of holding one glyph. */
  spin?: boolean;
}

/** Colour and glyph of a row marker reflect call state and nested codemode failures. */
function stateMark(node: TreeNode, glyphs: Glyphs): StateMark {
  if (node.kind === "thinking") return { glyph: glyphs.dot, color: "muted" };
  if (node.name === "codemode") {
    const failures = countErrors(node.children);
    if (failures > 0) {
      const total = countToolCalls(node.children);
      const color: PulseBase = failures === total ? "error" : "warning";
      return {
        glyph: glyphs.dot,
        color,
        ...(node.status === "running" ? { spin: true } : {}),
      };
    }
  }
  switch (node.status) {
    case "running":
      // A live call turns a quarter circle on the spot: the row says work is happening
      // without a swinging brightness that reads as a flicker at 60 columns.
      return { glyph: glyphs.dot, color: "warning", spin: true };
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

/** One visible row with its content already decided; layouts own only indentation and width. */
export interface RowModel {
  node: TreeNode;
  /** How many ancestors sit above this row. */
  depth: number;
  /** Which of those ancestors still have a sibling below them, for the guide. */
  ancestors: boolean[];
  /** True when this row is the last of its siblings, so the connector closes here. */
  last: boolean;
  /** Painted marker cell, spinner frame included. */
  mark: string;
  /** Role the marker is painted in, so the connector can follow it. */
  tone: Foreground;
  /** Painted tool label, or the reasoning word. */
  tool: string;
  /** Detail text without its leading dot. */
  goal: string;
  /** Painted summary tail, empty when the row has none. */
  summary: string;
  /** Painted elapsed label; a layout adds its own rail and separators. */
  duration: string;
  /** Painted preview lines, already truncated, ellipsis included. */
  preview: string[];
  expanded: boolean;
  /** True when the row owns a live component to render while open. */
  live: boolean;
}

/** Paint a leaf row's bounded preview and its ellipsis, exactly as the row shows them. */
function previewLines(node: TreeNode, theme: GroveTheme): string[] {
  if (node.children.length > 0) return [];
  // A nested Bash row paints its command and output tail as chrome, not as a plain preview.
  const nestedBash = node.parent !== undefined && node.name === "bash" && node.inputPreview !== undefined;
  if (nestedBash) return [];
  const preview = node.preview ?? [];
  if (preview.length === 0) return [];
  const painted = node.previewDiff
    ? colorizeDiff(preview.join("\n"), theme)
    : preview.map(text => themeText(theme, "dim", text));
  const lines = painted.slice(0, PREVIEW_LINES);
  if (node.previewTruncated || painted.length > PREVIEW_LINES)
    lines.push(themeText(theme, "dim", ELLIPSIS));
  return lines;
}

/** Resolve every visible row in paint order, expansion and previews included. */
export function rowModels(ctx: CardContext): RowModel[] {
  const { state, group, theme, glyphs, tools, visible, piExpanded } = ctx;
  const settings = state.settings;
  const expandAll = piExpanded;
  const now = ctx.now;
  // Reasoning from the oldest visible call onward stays in place; older reasoning hides with
  // the calls it led to, so opening a phase never drags a stale thought into view.
  const from = visible.length > 0 && visible.length < tools.length
    ? visible[0]!.seq
    : Number.NEGATIVE_INFINITY;
  const visibleIds = new Set(visible.map(row => row.id));
  const rows = group.rows.filter(row =>
    row.kind === "thinking" ? row.seq >= from : visibleIds.has(row.id),
  );

  const models: RowModel[] = [];
  const walk = (nodes: TreeNode[], ancestors: boolean[]): void => {
    for (const [index, node] of nodes.entries()) {
      const last = index === nodes.length - 1;
      const open = expandAll || state.expanded.has(node.id);
      const mark = stateMark(node, glyphs);
      const markText = mark.spin && now - node.started < PULSE_FREEZE_MS
        ? themeText(theme, mark.color, spinnerGlyph(glyphs, now))
        : themeText(theme, mark.color, mark.glyph);
      const tool =
        node.kind === "thinking"
          ? themeText(theme, "muted", "thinking")
          : toolLabel(node.name, theme, settings.icons, settings.iconMode, settings.groupToolNames);
      const elapsed = elapsedFor(node, now);
      let summary = "";
      let duration: string;
      if (node.kind === "thinking") {
        duration = themeText(theme, "dim", DOT + formatElapsed(elapsed));
      } else {
        const tail = rowTail(
          node,
          theme,
          glyphs,
          settings.icons,
          settings.iconMode,
          settings.groupNestedTools,
          "",
          elapsed,
          settings.groupToolNames,
        );
        summary = tail.summary;
        duration = tail.duration;
      }
      models.push({
        node,
        depth: ancestors.length,
        ancestors,
        last,
        mark: markText,
        tone: mark.color,
        tool,
        goal: node.kind === "thinking" ? "" : detailOf(node),
        summary,
        duration,
        preview: open ? previewLines(node, theme) : [],
        expanded: open,
        live: node.live !== undefined,
      });
      if (open) walk(node.children, [...ancestors, last]);
      else if (settings.revealErrors)
        walk(node.children.filter(child => child.status === "error"), [...ancestors, last]);
    }
  };
  walk(rows, []);
  return models;
}

/**
 * The output lines a row hangs under itself: bounded previews, a nested Bash call's command
 * and tail, and a live call's own component. Painted, unprefixed and width-fitted to `room`,
 * so every layout can hang them under its own column.
 */
export function rowExtras(ctx: CardContext, model: RowModel, room: number, liveRoom = room): string[] {
  const { theme, glyphs } = ctx;
  const node = model.node;
  // Keep bounded tool previews attached to their call without treating lines as markers.
  const preview = node.children.length === 0 ? node.preview ?? [] : [];
  const nestedBash =
    node.children.length === 0 && node.parent !== undefined && node.name === "bash" &&
    node.inputPreview !== undefined;
  const out: string[] = [];
  if (nestedBash) {
    for (const text of node.inputPreview ?? []) out.push(themeText(theme, "accent", text));
    if (node.inputOmitted) {
      const noun = node.inputOmitted === 1 ? "line" : "lines";
      out.push(themeText(theme, "muted", `${ELLIPSIS} ${node.inputOmitted} more command ${noun}`));
    }
    if (node.outputTail) {
      out.push(themeText(theme, "dim", glyphs.h.repeat(Math.max(3, room))));
      if (node.outputOmitted) {
        const noun = node.outputOmitted === 1 ? "line" : "lines";
        out.push(themeText(theme, "muted", `${ELLIPSIS} ${node.outputOmitted} earlier output ${noun}`));
      }
      for (const text of preview) out.push(themeText(theme, "toolOutput", text));
    }
  } else if (model.preview.length > 0) {
    for (const text of model.preview) out.push(text);
  }
  // A call still running has nothing captured yet, so its own live component is the only
  // output there is; painting it keeps opening the row from being a no-op.
  if (preview.length === 0 && !nestedBash && node.status === "running" && node.live) {
    let live: string[] = [];
    try {
      live = node.live.render(Math.max(1, liveRoom));
    } catch {
      live = [];
    }
    for (const text of live.slice(0, PREVIEW_LINES)) out.push(text);
  }
  return out;
}
