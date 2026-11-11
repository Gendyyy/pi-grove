/**
 * layouts/instrument.ts — the instrument panel: a title headline carrying the plan's share,
 * a meta row, a numbered phase strip, the meter, then calls on fixed rails with a scale bar.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fitToolLine, formatElapsed } from "../block-render.js";
import { themeText, type Foreground, type GroveTheme } from "../theme.js";
import {
  DOT,
  ELLIPSIS,
  GROUP_TARGET,
  PHASES_TARGET,
  PREVIEW_LINES,
  countDirectErrors,
  countErrors,
  counted,
  errorCell,
  toolBreakdown,
  type Glyphs,
} from "../tree-model.js";
import { elapsedFor, rowExtras, rowModels, spinnerGlyph, type RowModel } from "../card-row.js";
import { durationSpark } from "../card-progress.js";
import { closedPhases, derivedProgress, phaseMeterText, planFinished } from "../card-plan.js";
import type { CardContext, CardLayout } from "../card-layout.js";
import { classicLayout } from "./classic.js";

/** Fixed rails: phase number, tool name, summary, duration and the per-row scale bar. */
const PHNO = 2;
const TOOL_MIN = 8;
const TOOL_MAX = 12;
const SUM = 8;
const DUR_MIN = 5;
const DUR_MAX = 8;
const BAR = 6;
/** The goal keeps at least this much before a column is dropped instead of squeezed. */
const GOAL_MIN = 12;
/** Preview lines hang past every rail left of the goal, so an opened row stays in its column. */
const EXTRA_INDENT = PHNO + TOOL_MIN + 4;
/** Below this a strip cell cannot hold a numeral, its mark and a name worth reading. */
const STRIP_MIN_CELL = 7;
/** The strip and the bar need a rail grid to sit in; under this the card keeps the compact form. */
const FULL_WIDTH = 64;

/** Pad one painted cell to an exact width, truncating it when it is already wider. */
function cell(text: string, cells: number, align: "left" | "right" = "left"): string {
  const fitted = truncateToWidth(text, Math.max(0, cells), ELLIPSIS);
  const gap = " ".repeat(Math.max(0, cells - visibleWidth(fitted)));
  return align === "left" ? fitted + gap : gap + fitted;
}

/** One fixed-width duration bar: the call's share of the card's longest interval. */
function scaleBar(elapsed: number, scale: number, theme: GroveTheme, glyphs: Glyphs, color: Foreground): string {
  const filled = scale > 0 ? Math.round(Math.min(1, Math.max(0, elapsed) / scale) * BAR) : 0;
  const fill = glyphs.spark === "ascii" ? "#" : "━";
  return themeText(theme, color, fill.repeat(filled)) + themeText(theme, "dim", glyphs.h.repeat(BAR - filled));
}

/** Line 0: the task title, with the plan's share set against the right edge. */
function headline(ctx: CardContext, progress: number | undefined): string {
  const { group, theme, width } = ctx;
  const share = progress === undefined ? "" : themeText(theme, "accent", progress + "%", true);
  const title = themeText(theme, "text", truncateToWidth(group.intent || "GROVE", Math.max(1, width - visibleWidth(share) - 1), ELLIPSIS), true);
  return title + " ".repeat(Math.max(0, width - visibleWidth(title) - visibleWidth(share))) + share;
}

/** Line 1: the rollup rails — duration shape, call count, tool mix, wall clock. */
function metaLine(ctx: CardContext, spark: boolean, errors: string): string {
  const { group, theme, glyphs, tools, visible, now, state } = ctx;
  const settings = state.settings;
  const sep = themeText(theme, "dim", DOT);
  const shape = spark ? durationSpark(tools, theme, glyphs) : "";
  const counts = visible.length === tools.length
    ? counted(theme, tools.length, "call", "calls")
    : themeText(theme, "accent", String(visible.length)) +
      themeText(theme, "dim", " of ") +
      themeText(theme, "muted", String(tools.length)) +
      themeText(theme, "muted", " calls");
  const mix = toolBreakdown(tools, theme, glyphs, 4, settings.icons, settings.iconMode, settings.groupNestedTools, settings.groupToolNames);
  const clock = themeText(theme, "dim", formatElapsed(Math.max(0, now - group.started)));
  const line = [shape, counts, ...mix, clock, errors].filter(Boolean).join(sep);
  const trimmed = [shape, counts, ...mix, errors].filter(Boolean).join(sep);
  // The clock goes before the mix does, and the mix before a count: a truncated separator reads as a broken rail.
  return fitToolLine(
    visibleWidth(line) <= ctx.width ? line : visibleWidth(trimmed) <= ctx.width ? trimmed : [shape, counts, errors].filter(Boolean).join(sep),
    ctx.width,
  );
}

/**
 * The plan as one strip of numbered cells: numeral, state mark, name, then its call count,
 * failures and time. Returns nothing when the cells would be too narrow to read.
 */
function phaseStrip(ctx: CardContext): string | undefined {
  const { group, plan, theme, glyphs, width, now, phaseByCall, phaseElapsedById } = ctx;
  if (plan.length === 0) return undefined;
  const gap = themeText(theme, "dim", " " + glyphs.pipe + " ");
  const gapWidth = visibleWidth(gap);
  const cellWidth = Math.floor((width - gapWidth * (plan.length - 1)) / plan.length);
  if (cellWidth < STRIP_MIN_CELL) return undefined;
  const closed = closedPhases(group);
  const active = plan.findIndex(phase => phase.id === group.activeMilestoneId);
  const cells = plan.map((phase, index) => {
    const rows = group.rows.filter(node => node.kind !== "thinking" && phaseByCall.get(node.id) === phase.id);
    const failures = countDirectErrors(rows);
    const done = index < closed;
    // A live phase turns the same spinner as its calls until the plan moves past it or the card closes.
    const live = index === active && group.settled !== true && !planFinished(group);
    const role: Foreground = failures ? "warning" : done ? "success" : index === active ? "accent" : "dim";
    const mark = live ? spinnerGlyph(glyphs, now) : failures ? glyphs.warning : done ? glyphs.check : glyphs.hollow;
    const head =
      themeText(theme, role, String(index + 1).padStart(2, "0") + " ") + themeText(theme, role, mark) + " ";
    const tailText = [
      rows.length + "c",
      failures ? "!" + failures : "",
      formatElapsed(phaseElapsedById.get(phase.id) ?? 0),
    ].filter(Boolean).join(" ");
    // A tail that would eat the name leaves instead: the name is what the strip is for.
    const tail = visibleWidth(head) + visibleWidth(tailText) + 4 <= cellWidth
      ? themeText(theme, failures ? "warning" : "dim", tailText)
      : "";
    const room = cellWidth - visibleWidth(head) - visibleWidth(tail) - (tail ? 1 : 0);
    const label = room > 0 ? themeText(theme, role, truncateToWidth(phase.label, room, ELLIPSIS), true) : "";
    const used = visibleWidth(head) + visibleWidth(label) + visibleWidth(tail);
    return head + label + " ".repeat(Math.max(0, cellWidth - used)) + tail;
  });
  return fitToolLine(cells.join(gap), width);
}

/** The widest label in a column, clamped, so one long tool name never truncates the rest. */
function column(values: string[], min: number, max: number): number {
  return Math.min(max, Math.max(min, ...values.map(text => visibleWidth(text))));
}

/** One call on the rails: phase number, mark, tool, goal, summary, duration, scale bar. */
function rowLine(ctx: CardContext, model: RowModel, full: boolean, toolCol: number, durCol: number, sumCol: number): string {
  const { theme, glyphs, plan, phaseByCall, durationScale, now, width } = ctx;
  const node = model.node;
  const phaseIndex = plan.findIndex(phase => phase.id === phaseByCall.get(node.id));
  const lead = model.depth === 0
    ? themeText(theme, "muted", phaseIndex < 0 ? "" : String(phaseIndex + 1).padStart(2, "0"))
    // shortcut: nested rows share one guide column, so depth past one reads flat; upgrade when a deep tree needs it.
    : themeText(theme, "dim", model.last ? glyphs.end : glyphs.tee);
  const elapsed = elapsedFor(node, now);
  const tone: Foreground = node.status === "running" ? "accent" : model.tone;
  const barWidth = full ? BAR + 1 : 0;
  const leftWidth = PHNO + toolCol + 4;
  const rightWidth = sumCol + durCol + 2 + barWidth;
  const goalWidth = Math.max(1, width - leftWidth - rightWidth);
  const goal = themeText(theme, node.status === "error" ? "error" : "text", model.goal);
  // The time is formatted from the card's own clock, so the rail and the bar never disagree on a frame.
  const duration = themeText(theme, "dim", formatElapsed(elapsed));
  const bar = full ? " " + scaleBar(elapsed, durationScale, theme, glyphs, tone) : "";
  return cell(lead, PHNO) + " " + model.mark + " " + cell(model.tool, toolCol) + " " +
    cell(goal, goalWidth) + cell(model.summary, sumCol, "right") + " " + cell(duration, durCol, "right") + bar;
}

/** The instrument panel: rails, a strip and a meter instead of a box and rules. */
export const instrumentLayout: CardLayout = {
  id: "instrument",
  /** Compose the instrument panel's lines from the shared context. */
  paint(ctx: CardContext): string[] {
    const { state, group, width, theme, glyphs, tools, targets, now, hidden } = ctx;
    targets.clear();
    const lines: string[] = [];
    if (group.rows.length === 0) return lines;
    // Under 40 columns the rails cannot hold a goal worth reading, so the card keeps the classic form.
    if (width < 40) return classicLayout.paint(ctx);
    const settings = state.settings;
    const full = width >= FULL_WIDTH;
    const errors = countErrors(tools);
    const running = tools.some(row => row.status === "running");
    // The layout owns its own share display, so groupPercent and groupSparkline stay classic-only.
    const progress = settings.groupProgress ? derivedProgress(group) : undefined;
    const errorText = errors > 0 ? errorCell(errors, theme, settings.icons, settings.iconMode) : "";
    const meter = settings.groupProgress
      ? phaseMeterText(group, theme, glyphs, width - (errorText ? visibleWidth(errorText) + 1 : 0), now, running, false, false)
      : undefined;
    // A strip is a plan gesture; without phase cards it falls back to the row gesture.
    const phasesTarget = settings.groupPhases ? PHASES_TARGET : GROUP_TARGET;

    lines.push(headline(ctx, progress));
    targets.set(lines.length - 1, GROUP_TARGET);
    lines.push(metaLine(ctx, full, meter ? "" : errorText));
    targets.set(lines.length - 1, GROUP_TARGET);

    if (full) {
      const strip = phaseStrip(ctx);
      if (strip) {
        lines.push(strip);
        targets.set(lines.length - 1, phasesTarget);
      }
    }
    if (meter) {
      // The share rides the headline, so the meter keeps only its bar, its pie and the failures.
      lines.push(fitToolLine(errorText ? meter.line + " " + errorText : meter.line, width));
      targets.set(lines.length - 1, phasesTarget);
    }

    // The window's leftovers are named, and the row doubles as the shortcut that opens them.
    if (hidden > 0) {
      const noun = hidden === 1 ? "call" : "calls";
      lines.push(fitToolLine(themeText(theme, "dim", `${ELLIPSIS} ${hidden} earlier ${noun} · ctrl+o`), width));
      targets.set(lines.length - 1, GROUP_TARGET);
    }

    /** Paint a row's previews, nested Bash output and live block under the goal column. */
    const emitExtras = (model: RowModel): void => {
      const prefix = themeText(theme, "dim", " ".repeat(EXTRA_INDENT + toolCol - TOOL_MIN + model.depth * 2) + glyphs.pipe + " ");
      const room = Math.max(1, width - visibleWidth(prefix));
      for (const text of rowExtras(ctx, model, room)) {
        lines.push(fitToolLine(prefix + text, width));
        targets.set(lines.length - 1, model.node.id);
      }
    };

    const models = rowModels(ctx);
    const toolCol = column(models.map(model => model.tool), TOOL_MIN, TOOL_MAX);
    const durCol = column(models.map(model => model.duration), DUR_MIN, DUR_MAX);
    const barWidth = full ? BAR + 1 : 0;
    // The summary is the first column to go: a goal cut to a stub says less than a missing tail.
    const sumCol = width - (PHNO + toolCol + 4) - durCol - 2 - barWidth - GOAL_MIN >= SUM ? SUM : 0;

    const pending: RowModel[] = [];
    for (const model of models) {
      // A row's previews belong to it, but paint after its whole subtree, so a parent's
      // extras wait until the next row at its depth or shallower.
      while (pending.length > 0 && pending[pending.length - 1]!.depth >= model.depth) {
        emitExtras(pending.pop()!);
      }
      lines.push(rowLine(ctx, model, full, toolCol, durCol, sumCol));
      targets.set(lines.length - 1, model.node.id);
      if (model.expanded) pending.push(model);
    }
    while (pending.length > 0) emitExtras(pending.pop()!);
    return lines;
  },
};
