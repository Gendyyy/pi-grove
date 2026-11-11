/**
 * layouts/margin.ts — the wide-margin card: a hairline box around an editorial two-column
 * spread, with a phase margin on the left and the calls as body text on the right.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fitToolLine, formatElapsed, summaryLine } from "../block-render.js";
import { themeText, type Foreground } from "../theme.js";
import {
  DOT,
  ELLIPSIS,
  GROUP_TARGET,
  PREVIEW_LINES,
  countDirectErrors,
  countErrors,
  counted,
  milestoneTarget,
  toolBreakdown,
} from "../tree-model.js";
import { rowExtras, rowModels, type RowModel } from "../card-row.js";
import { shimmerText } from "../card-progress.js";
import { closedPhases, derivedProgress, titleBorder } from "../card-plan.js";
import type { CardContext, CardLayout } from "../card-layout.js";
import { classicLayout } from "./classic.js";

/** The full margin: a two-digit numeral, a space and an uppercase phase name. */
const GUTTER_WIDE = 16;
/** The narrow margin: the numeral alone, so the phase name moves into the body. */
const GUTTER_NARROW = 6;
/** Air between the margin and the body, so the two columns never read as one run. */
const COL_GAP = 2;
/** Below this width the spread has no room left, so the column card paints instead. */
const SPREAD_MIN = 24;
/** Width the wide form keeps for the tool label, so every goal starts on one column. */
const TOOL_COL = 8;

/** The wide-margin card: one spread per phase, its calls as the body text. */
export const marginLayout: CardLayout = {
  id: "margin",
  /** Compose the margin card's lines from the shared context. */
  paint(ctx: CardContext): string[] {
    const { state, group, width, inner, framed, theme, glyphs, tools, plan, targets, now, hidden } = ctx;
    targets.clear();
    const lines: string[] = [];
    if (group.rows.length === 0) return lines;
    // A spread needs two columns; under that the column card is the honest shape.
    if (width < SPREAD_MIN) return classicLayout.paint(ctx);

    const settings = state.settings;
    const gutter = plan.length === 0 ? 0 : width >= 72 ? GUTTER_WIDE : GUTTER_NARROW;
    const lead = gutter > 0 ? gutter + COL_GAP : 0;
    const bodyWidth = Math.max(1, inner - lead);
    const toolCol = width >= 72 ? TOOL_COL : 0;
    const pad = " ".repeat(lead);
    /** Pad one margin cell to the column's full width, so the body always starts on its edge. */
    const marginCell = (text: string): string =>
      text + " ".repeat(Math.max(0, gutter - visibleWidth(text)));

    // The card names the work first: the phase it is in, the calls it made and the time it spent.
    if (tools.length > 0) {
      const activeIndex = plan.findIndex(phase => phase.id === group.activeMilestoneId);
      const progress = settings.groupProgress ? derivedProgress(group) : undefined;
      const errors = countErrors(tools);
      const rollup: string[] = [];
      if (activeIndex >= 0) {
        const phase = plan[activeIndex]!;
        rollup.push(themeText(theme, "accent", `${String(activeIndex + 1).padStart(2, "0")} ${phase.label}`));
      }
      rollup.push(counted(theme, tools.length, "call", "calls"));
      if (errors > 0) rollup.push(themeText(theme, "error", `${errors} failed`));
      if (progress !== undefined) {
        const noun = plan.length === 1 ? "phase" : "phases";
        rollup.push(themeText(theme, "muted", `${progress}% of ${plan.length} ${noun}`));
      }
      rollup.push(themeText(theme, "dim", formatElapsed(Math.max(0, now - group.started))));
      rollup.push(...toolBreakdown(tools, theme, glyphs, 4, settings.icons, settings.iconMode, settings.groupNestedTools, settings.groupToolNames));
      // Shed whole pieces from the tail rather than let the line cut a number in half.
      const joiner = themeText(theme, "dim", DOT);
      while (rollup.length > 1 && visibleWidth(rollup.join(joiner)) > inner) rollup.pop();
      lines.push(fitToolLine(rollup.join(joiner), inner));
      targets.set(lines.length - 1, GROUP_TARGET);
    }

    // The window's leftovers are named, and the row doubles as the shortcut that opens them.
    if (hidden > 0) {
      const noun = hidden === 1 ? "call" : "calls";
      lines.push(fitToolLine(themeText(theme, "dim", `${ELLIPSIS} ${hidden} earlier ${noun} · ctrl+o`), inner));
      targets.set(lines.length - 1, GROUP_TARGET);
    }

    const closed = closedPhases(group);
    const activeIndex = plan.findIndex(phase => phase.id === group.activeMilestoneId);
    /** One role per phase, so its numeral answers whether the plan has moved past it. */
    const phaseRole = (index: number): Foreground => {
      const phase = plan[index];
      if (!phase) return "dim";
      const failed = countDirectErrors(tools.filter(node => ctx.displayPhaseByCall.get(node.id) === phase.id)) > 0;
      return failed ? "warning" : index < closed ? "success" : index === activeIndex ? "accent" : "dim";
    };

    /** Paint a phase as a spread head: numeral and name in the margin, its rollup in the body. */
    const emitPhase = (index: number): void => {
      const phase = plan[index];
      if (!phase) return;
      const phaseRows = tools.filter(node => ctx.displayPhaseByCall.get(node.id) === phase.id);
      const failures = countDirectErrors(phaseRows);
      const numeral = themeText(theme, phaseRole(index), String(index + 1).padStart(2, "0"));
      const name = gutter >= GUTTER_WIDE ? " " + themeText(theme, "muted", phase.label.toUpperCase()) : "";
      // A narrow margin has no room for the name, so the body carries it instead of dropping it.
      const head = gutter >= GUTTER_WIDE ? [] : [themeText(theme, "text", phase.label, true)];
      const parts = [
        ...head,
        counted(theme, phaseRows.length, "call", "calls"),
      ];
      if (failures > 0) parts.push(themeText(theme, "warning", `${failures} failed`));
      parts.push(themeText(theme, "dim", formatElapsed(ctx.phaseElapsedById.get(phase.id) ?? 0)));
      const text = fitToolLine(parts.join(themeText(theme, "dim", DOT)), bodyWidth);
      const cell = marginCell(truncateToWidth(numeral + name, Math.max(1, gutter), ELLIPSIS));
      lines.push(fitToolLine(cell + " ".repeat(lead - gutter) + text, inner));
      targets.set(lines.length - 1, milestoneTarget(phase.id));
    };

    /** The row's head: depth indent, marker, tool label and the fixed tool column. */
    const rowHead = (model: RowModel): string => {
      const toolPad = toolCol > 0
        ? " ".repeat(Math.max(1, toolCol + 1 - visibleWidth(model.tool)))
        : " ";
      return "  ".repeat(model.depth) + model.mark + " " + model.tool + toolPad;
    };

    /** Paint a call's previews and nested output in the body column, under its own line. */
    const emitExtras = (model: RowModel): void => {
      const prefix = " ".repeat(visibleWidth(rowHead(model))) + themeText(theme, "dim", glyphs.pipe + " ");
      const room = Math.max(1, bodyWidth - visibleWidth(prefix));
      for (const text of rowExtras(ctx, model, room)) {
        lines.push(fitToolLine(pad + prefix + text, inner));
        targets.set(lines.length - 1, model.node.id);
      }
    };

    let nextPhase = 0;
    const pending: RowModel[] = [];
    for (const model of rowModels(ctx)) {
      // A row's previews belong to it, but paint after its whole subtree.
      while (pending.length > 0 && pending[pending.length - 1]!.depth >= model.depth) {
        emitExtras(pending.pop()!);
      }
      const node = model.node;
      const displayPhase = ctx.displayPhaseByCall.get(node.id);
      if (model.depth === 0 && node.kind !== "thinking" && displayPhase) {
        const declared = plan.findIndex(phase => phase.id === displayPhase);
        while (nextPhase <= declared && nextPhase < plan.length) {
          emitPhase(nextPhase);
          nextPhase += 1;
        }
      }

      const head = rowHead(model);
      const goal = node.kind === "thinking"
        ? ""
        : node.status === "running"
          ? shimmerText(model.goal, theme, now, node.started)
          : themeText(theme, node.status === "error" ? "error" : "text", model.goal);
      // Time is a footnote here: the label keeps its own dim tone and only leans into italic.
      const duration = theme.style(model.duration, { italic: true });
      // The gap rides the suffix: a truncated goal must not run into its own time.
      lines.push(fitToolLine(pad + summaryLine(head + goal, "", "", "", bodyWidth, undefined, " " + duration), inner));
      targets.set(lines.length - 1, node.id);
      // The summary is the call's second line, aligned under the goal rather than beside it.
      if (model.summary) {
        lines.push(fitToolLine(pad + fitToolLine(" ".repeat(visibleWidth(head)) + model.summary, bodyWidth), inner));
        targets.set(lines.length - 1, node.id);
      }
      if (model.expanded) pending.push(model);
    }
    while (pending.length > 0) emitExtras(pending.pop()!);
    while (nextPhase < plan.length) {
      emitPhase(nextPhase);
      nextPhase += 1;
    }
    if (lines.length === 0) return lines;

    if (!framed) return lines.map(line => fitToolLine(line, inner));
    // The card is its own box: the title rides the top border and the sides carry the frame.
    const edge = (text: string): string => themeText(theme, "dim", text);
    const side = edge(glyphs.v + " ");
    const sideEnd = edge(" " + glyphs.v);
    // Every row is padded to the frame's content width, or the right border would wander.
    const body = lines.map(line => {
      const fitted = fitToolLine(line, inner);
      return side + fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted))) + sideEnd;
    });
    const bottom = edge(glyphs.box.bl + glyphs.h.repeat(Math.max(0, width - 2)) + glyphs.box.br);
    // Every click target moves one row down once the border is above them.
    const shifted = [...targets].map(([line, target]) => [line + 1, target] as const);
    targets.clear();
    targets.set(0, GROUP_TARGET);
    for (const [line, target] of shifted) targets.set(line, target);
    return [titleBorder(group.intent || "GROVE", theme, glyphs, width), ...body, bottom];
  },
};
