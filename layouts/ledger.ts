/**
 * layouts/ledger.ts — the borderless ledger card: a headline over a rule, one rule per
 * phase, and a table row per call with a dotted leader and a right-aligned time column.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fitToolLine, formatElapsed } from "../block-render.js";
import { themeText, type Foreground, type GroveTheme } from "../theme.js";
import {
  DOT,
  ELLIPSIS,
  GROUP_TARGET,
  PREVIEW_LINES,
  countDirectErrors,
  countErrors,
  counted,
  milestoneTarget,
  type Glyphs,
} from "../tree-model.js";
import { rowModels, spinnerGlyph, type RowModel } from "../card-row.js";
import { closedPhases, derivedProgress, planFinished } from "../card-plan.js";
import { classicLayout } from "./classic.js";
import type { CardContext, CardLayout } from "../card-layout.js";

/** Width at which the ledger keeps its dotted leader and its summary column. */
const FULL_WIDTH = 56;
/** Width below which a table has no room left, so the card hands over to classic. */
const CLASSIC_WIDTH = 24;
/** Above this the headline can afford its failures and its clock without eating the task name. */
const WIDE = 72;
/** The tool column, so every goal in the card starts on the same cell. */
const TOOL_CELLS = 8;
/** The time column, so every duration in the card ends on the same cell. */
const TIME_CELLS = 5;
/** Fewer free cells than this and a leader reads as debris instead of a bridge. */
const LEADER_MIN = 4;

/** Pad a painted cell out to an exact visible width, never cutting it. */
function cell(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Push a painted cell out to a visible width on its left, so numbers share one edge. */
function alignRight(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

/** A run of leader dots, long enough to bridge a gap, in the glyph set's own ink. */
function leaderDots(glyphs: Glyphs, cells: number): string {
  return (glyphs.spark === "ascii" ? "." : "·").repeat(Math.max(1, cells));
}

/**
 * Join a left label and a right rollup: a dotted leader across the slack at full width,
 * plain air in the compact form, and a shortened label when the two would collide.
 */
function fillLine(
  left: string,
  right: string,
  width: number,
  glyphs: Glyphs,
  theme: GroveTheme,
  full: boolean,
): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (full && gap >= LEADER_MIN) return left + " " + themeText(theme, "dim", leaderDots(glyphs, gap - 2)) + " " + right;
  if (gap >= 1) return left + " ".repeat(gap) + right;
  const head = truncateToWidth(left, Math.max(1, width - visibleWidth(right) - 1), ELLIPSIS);
  return head + " ".repeat(Math.max(1, width - visibleWidth(head) - visibleWidth(right))) + right;
}

/** The borderless ledger card: headline, rule, phase rules and one row per call. */
export const ledgerLayout: CardLayout = {
  id: "ledger",
  /** Compose the ledger card's lines from the shared context. */
  paint(ctx: CardContext): string[] {
    const {
      state, group, width, theme, glyphs, tools, visible, plan, targets,
      now, hidden, displayPhaseByCall, phaseElapsedById,
    } = ctx;
    targets.clear();
    const lines: string[] = [];
    if (group.rows.length === 0) return lines;
    // Under a table's minimum the ledger has nothing to arrange, so classic keeps the cells.
    if (width < CLASSIC_WIDTH) return classicLayout.paint(ctx);
    const full = width >= FULL_WIDTH;
    const settings = state.settings;
    // The column separator follows the glyph set, so an ASCII console never sees a middle dot.
    const sep = glyphs.spark === "ascii" ? " - " : DOT;

    // The headline is the table's own header: the task on the left, its numbers on the right.
    const errors = countErrors(tools);
    const stats: string[] = [];
    // The share comes off the plan itself; the numeric-share switch is classic-only.
    const progress = settings.groupProgress ? derivedProgress(group) : undefined;
    // A narrow headline keeps only what a phase rule and a row cannot say for themselves.
    if (progress !== undefined && width >= 40) stats.push(themeText(theme, "accent", `${progress}%`));
    stats.push(
      visible.length === tools.length
        ? counted(theme, tools.length, "call", "calls")
        : themeText(theme, "accent", String(visible.length)) +
          themeText(theme, "dim", " of ") +
          themeText(theme, "muted", String(tools.length)) +
          themeText(theme, "muted", " calls"),
    );
    // Failures and the clock are the first things a narrow headline sheds: the phase rules
    // already count failures, and the task name is what the line is for.
    if (errors > 0 && width >= WIDE) stats.push(themeText(theme, "error", `${errors} failed`));
    if (width >= WIDE) stats.push(themeText(theme, "dim", formatElapsed(Math.max(0, now - group.started))));
    const rollup = stats.join(themeText(theme, "dim", sep));
    const title = themeText(theme, "text", group.intent || "GROVE", true);
    const room = Math.max(1, width - visibleWidth(rollup) - 2);

    const head = visibleWidth(title) <= room ? title : truncateToWidth(title, room, ELLIPSIS);
    lines.push(fitToolLine(head + " ".repeat(Math.max(2, width - visibleWidth(head) - visibleWidth(rollup))) + rollup, width));
    targets.set(lines.length - 1, GROUP_TARGET);
    lines.push(themeText(theme, "dim", glyphs.h.repeat(width)));
    targets.set(lines.length - 1, GROUP_TARGET);

    // The window's leftovers are named, and the line doubles as the shortcut that opens them.
    if (hidden > 0) {
      const noun = hidden === 1 ? "call" : "calls";
      lines.push(fitToolLine(themeText(theme, "dim", `${ELLIPSIS} ${hidden} earlier ${noun}${sep}ctrl+o`), width));
      targets.set(lines.length - 1, GROUP_TARGET);
    }

    const closed = closedPhases(group);
    const activeIndex = plan.findIndex(phase => phase.id === group.activeMilestoneId);
    const finished = planFinished(group);

    /** Paint one declared phase as a ledger rule: its number, name, leader and state. */
    const emitPhase = (index: number): void => {
      const phase = plan[index];
      if (!phase) return;
      const phaseRows = tools.filter(node => displayPhaseByCall.get(node.id) === phase.id);
      const failures = countDirectErrors(phaseRows);
      const done = index < closed;
      const live = index === activeIndex && group.settled !== true && !finished;
      const mark = live
        ? spinnerGlyph(glyphs, now)
        : failures > 0 ? glyphs.warning : done ? glyphs.check : index !== activeIndex ? glyphs.hollow : glyphs.dot;
      const role: Foreground = failures > 0 ? "warning" : done ? "success" : live ? "accent" : "dim";
      const name = themeText(theme, "text", `${String(index + 1).padStart(2, "0")}  ${phase.label.toUpperCase()}`, true);
      const state = failures > 0
        ? themeText(theme, "warning", `${failures} failed`)
        : done ? themeText(theme, "success", "done")
          : live ? themeText(theme, "accent", "live")
            : themeText(theme, "dim", "queued");
      const calls = `${phaseRows.length} ${phaseRows.length === 1 ? "call" : "calls"}`;
      const spent = formatElapsed(phaseElapsedById.get(phase.id) ?? 0);
      const right = themeText(theme, role, mark) + " " + state +
        (full ? themeText(theme, "dim", sep + calls + sep + spent) : "");
      lines.push(fitToolLine(fillLine(name, right, width, glyphs, theme, full), width));
      targets.set(lines.length - 1, milestoneTarget(phase.id));
    };

    // Rows hang off the phase column by two cells per level: the table stays a table,
    // and depth reads from the indent instead of from a branch glyph.
    const indentOf = (depth: number): string => "  ".repeat(depth);

    /** Paint one call as a table row: mark, tool column, goal, leader, sum and time. */
    const emitRow = (model: RowModel): void => {
      const node = model.node;
      const left = indentOf(model.depth) + model.mark + " " + cell(model.tool, TOOL_CELLS) + " " +
        (model.goal ? themeText(theme, node.status === "error" ? "error" : "muted", model.goal) : "");
      const time = alignRight(model.duration, TIME_CELLS);
      // The summary column is the first thing a narrow card gives up: the goal keeps the cells.
      const right = full && model.summary ? model.summary + themeText(theme, "dim", sep) + time : time;
      lines.push(fitToolLine(fillLine(left, right, width, glyphs, theme, full && model.goal !== ""), width));
      targets.set(lines.length - 1, node.id);
    };

    /** Paint an open row's captured output under its goal column, on its own hit target. */
    const emitPreview = (model: RowModel): void => {
      const pad = " ".repeat(indentOf(model.depth).length + TOOL_CELLS + 3);
      const push = (text: string): void => {
        lines.push(fitToolLine(pad + text, width));
        targets.set(lines.length - 1, model.node.id);
      };
      for (const text of model.preview) push(text);
      // A call still running has nothing captured yet, so its live component is all there is.
      if (model.preview.length === 0 && model.node.status === "running" && model.node.live) {
        let live: string[] = [];
        try {
          live = model.node.live.render(Math.max(1, width - pad.length));
        } catch {
          live = [];
        }
        for (const text of live.slice(0, PREVIEW_LINES)) push(text);
      }
    };

    // A row's previews belong to it but paint after its whole subtree, so a parent's
    // output waits until the next row at its depth or shallower.
    const pending: RowModel[] = [];
    let nextPhase = 0;
    for (const model of rowModels(ctx)) {
      while (pending.length > 0 && pending[pending.length - 1]!.depth >= model.depth) emitPreview(pending.pop()!);
      const displayPhase = displayPhaseByCall.get(model.node.id);
      if (model.depth === 0 && model.node.kind !== "thinking" && displayPhase) {
        const declared = plan.findIndex(phase => phase.id === displayPhase);
        while (nextPhase <= declared && nextPhase < plan.length) {
          emitPhase(nextPhase);
          nextPhase += 1;
        }
      }
      emitRow(model);
      if (model.expanded) pending.push(model);
    }
    while (pending.length > 0) emitPreview(pending.pop()!);
    while (nextPhase < plan.length) {
      emitPhase(nextPhase);
      nextPhase += 1;
    }
    return lines;
  },
};
