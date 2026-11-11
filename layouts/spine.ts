/**
 * layouts/spine.ts — the story spine card: a borderless headline, one continuous
 * left rail with the phase nodes on it, and timed call rows hanging off that rail.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fitToolLine, formatElapsed } from "../block-render.js";
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
import { elapsedFor, rowModels, spinnerGlyph, type RowModel } from "../card-row.js";
import { shimmerText } from "../card-progress.js";
import { closedPhases, derivedProgress, planFinished } from "../card-plan.js";
import { classicLayout } from "./classic.js";
import type { CardContext, CardLayout } from "../card-layout.js";

/** Full form keeps the timebar column; narrower cards drop it and keep the rail. */
const SPINE_FULL_MIN = 56;
/** Below this the card is too narrow to hold a spine and borrows classic's rail form. */
const SPINE_MIN = 24;
/** The timebar column, in cells. */
const TIMEBAR_CELLS = 15;
/** Above this the headline can afford its failures and its clock without eating the task name. */
const WIDE = 72;
/** The tool-name column: the design's 8ch, wide enough for "codemode". */
const TOOL_CELLS = 8;
/** The widest the tool column may grow before a name is cut. */
const TOOL_MAX = 12;
/** Narrowest goal worth a column; below it the timebar yields first. */
const GOAL_MIN = 8;

/** Narrowest summary worth printing; below it the goal keeps the room. */
const SUMMARY_MIN = 10;

/** The story spine card: one rail, phase nodes on it, calls hanging off it. */
export const spineLayout: CardLayout = {
  id: "spine",
  /** Compose the spine card's lines from the shared context. */
  paint(ctx: CardContext): string[] {
    const {
      state, group, width, theme, glyphs, tools, visible, plan, targets,
      now, hidden, displayPhaseByCall, phaseElapsedById, durationScale,
    } = ctx;
    targets.clear();
    if (group.rows.length === 0) return [];
    if (width < SPINE_MIN) return classicLayout.paint(ctx);
    const settings = state.settings;
    const lines: string[] = [];
    const models = rowModels(ctx);
    const separator = themeText(theme, "dim", DOT);
    const bars = width >= SPINE_FULL_MIN;

    /** The right-hand elapsed label of one row, from the shared clock. */
    const elapsedOf = (model: RowModel): string => formatElapsed(elapsedFor(model.node, now));
    /** Widest elapsed label on the card, so every row shares one right edge. */
    const durationWidth = Math.min(8, Math.max(1, ...models.map(model => elapsedOf(model).length)));
    // The tool column is the design's 8ch unless a label needs more, so "codemode" and an
    // icon prefix are never cut; a pathological name still stops at the cap.
    const toolWidth = Math.min(TOOL_MAX, Math.max(TOOL_CELLS, ...models.map(model => visibleWidth(model.tool))));

    /** Right-align one row's elapsed label in the shared duration column. */
    const durationCell = (model: RowModel): string => {
      const text = themeText(theme, "dim", elapsedOf(model));
      return " ".repeat(Math.max(0, durationWidth - visibleWidth(text))) + text;
    };

    /** The timebar: elapsed against the card's longest, a heavy fill over a light track. */
    const timebar = (model: RowModel, color: Foreground): string => {
      const filled = durationScale > 0
        ? Math.round(Math.min(1, Math.max(0, elapsedFor(model.node, now)) / durationScale) * TIMEBAR_CELLS)
        : 0;
      return themeText(theme, color, glyphs.rail.repeat(filled)) +
        themeText(theme, "dim", glyphs.h.repeat(TIMEBAR_CELLS - filled));
    };

    /**
     * Draw one glyph of the spine column plus its cell of air. The column is exactly one
     * cell wide, so it is its own centre: every node, connector and the closing mark draw
     * at index 0 and the rail never moves.
     */
    const spineAt = (glyph: string, color: Foreground = "dim"): string =>
      themeText(theme, color, glyph) + " ";

    // The headline names the task and measures the run: the borderless card's title line.
    const errors = countErrors(tools);
    const progress = derivedProgress(group);
    const stats: string[] = [];
    if (progress !== undefined) stats.push(themeText(theme, "accent", `${progress}%`));
    // A narrow headline keeps the task name and the call count: failures ride their phase
    // node and the clock is the first number to go.
    if (errors > 0 && width >= WIDE) stats.push(themeText(theme, "error", `${errors} failed`));
    stats.push(
      visible.length === tools.length
        ? counted(theme, tools.length, "call", "calls")
        : themeText(theme, "accent", String(visible.length)) +
          themeText(theme, "dim", " of ") +
          themeText(theme, "muted", String(tools.length)) +
          themeText(theme, "muted", " calls"),
    );
    if (width >= WIDE) stats.push(themeText(theme, "dim", formatElapsed(Math.max(0, now - group.started))));
    const rollup = stats.join(separator);
    const title = truncateToWidth(
      themeText(theme, "text", group.intent || "GROVE", true),
      Math.max(1, width - visibleWidth(rollup) - 1),
      ELLIPSIS,
    );
    const gap = " ".repeat(Math.max(1, width - visibleWidth(title) - visibleWidth(rollup)));
    lines.push(fitToolLine(title + gap + rollup, width));
    targets.set(0, GROUP_TARGET);

    // The window's leftovers are named on the rail, and the line opens them.
    if (hidden > 0) {
      const noun = hidden === 1 ? "call" : "calls";
      lines.push(fitToolLine(spineAt(glyphs.pipe) + themeText(theme, "dim", `${ELLIPSIS} ${hidden} earlier ${noun} · ctrl+o`), width));
      targets.set(lines.length - 1, GROUP_TARGET);
    }

    /** Paint one phase as a node on the rail, its rollup pinned to the right edge. */
    const emitPhase = (index: number): void => {
      const phase = plan[index];
      if (!phase) return;
      const closed = closedPhases(group);
      const activeIndex = plan.findIndex(item => item.id === group.activeMilestoneId);
      const rows = tools.filter(node => displayPhaseByCall.get(node.id) === phase.id);
      const failures = countDirectErrors(rows);
      const done = index < closed;
      // A phase in flight turns the same spinner as its calls; a gap between two calls is
      // still that phase working, so its own calls returning never stops the mark.
      const live = index === activeIndex && group.settled !== true && !planFinished(group);
      const role: Foreground = failures ? "warning" : done ? "success" : index === activeIndex ? "accent" : "dim";
      const settled = failures ? glyphs.warning : done ? glyphs.check : glyphs.hollow;
      const mark = live ? spinnerGlyph(glyphs, now) : failures || done || index !== activeIndex ? settled : glyphs.dot;
      const head = spineAt(mark, role) +
        themeText(theme, "dim", String(index + 1).padStart(2, "0")) + " " +
        themeText(theme, "text", phase.label, true);
      const cells = [
        failures ? themeText(theme, "warning", `${failures} failed`) : "",
        themeText(theme, "dim", `${rows.length} ${rows.length === 1 ? "call" : "calls"}`),
        themeText(theme, "dim", formatElapsed(phaseElapsedById.get(phase.id) ?? 0)),
      ].filter(Boolean);
      const status = cells.join(separator);
      // The rule takes exactly the air between the name and the rollup, never wrapping.
      const room = width - visibleWidth(head) - visibleWidth(status) - 2;
      lines.push(
        room >= 2
          ? head + " " + themeText(theme, "dim", glyphs.h.repeat(room)) + " " + status
          : fitToolLine(head + " " + status, width),
      );
      targets.set(lines.length - 1, milestoneTarget(phase.id));
    };

    /** Paint a row's previews, nested Bash output and live block after its whole subtree. */
    const emitExtras = (model: RowModel): void => {
      const node = model.node;
      const preview = node.children.length === 0 ? node.preview ?? [] : [];
      const nestedBash =
        node.children.length === 0 && node.parent !== undefined && node.name === "bash" &&
        node.inputPreview !== undefined;
      const childGuide = [...model.ancestors, model.last]
        .map(ancestor => (ancestor ? "   " : glyphs.pipe + "  "))
        .join("");
      // Extras keep the spine in the same cell and hang their own guide one column in.
      const prefix = spineAt(glyphs.pipe) + " " + themeText(theme, "dim", childGuide + glyphs.pipe + " ");
      const push = (text: string): void => {
        lines.push(fitToolLine(prefix + text, width));
        targets.set(lines.length - 1, node.id);
      };
      if (nestedBash) {
        for (const text of node.inputPreview ?? []) push(themeText(theme, "accent", text));
        if (node.inputOmitted) {
          const noun = node.inputOmitted === 1 ? "line" : "lines";
          push(themeText(theme, "muted", `${ELLIPSIS} ${node.inputOmitted} more command ${noun}`));
        }
        if (node.outputTail) {
          push(themeText(theme, "dim", glyphs.h.repeat(Math.max(3, width - visibleWidth(prefix)))));
          if (node.outputOmitted) {
            const noun = node.outputOmitted === 1 ? "line" : "lines";
            push(themeText(theme, "muted", `${ELLIPSIS} ${node.outputOmitted} earlier output ${noun}`));
          }
          for (const text of preview) push(themeText(theme, "toolOutput", text));
        }
      } else if (model.preview.length > 0) {
        for (const text of model.preview) push(text);
      }
      // A call still running has nothing captured yet, so its own live component is the
      // only output there is; painting it keeps opening the row from being a no-op.
      if (preview.length === 0 && !nestedBash && node.status === "running" && node.live) {
        let live: string[] = [];
        try {
          live = node.live.render(Math.max(1, width - visibleWidth(prefix)));
        } catch {
          live = [];
        }
        for (const text of live.slice(0, PREVIEW_LINES)) push(text);
      }
    };

    /** One call row: connector, mark, tool, goal and summary, timebar and elapsed label. */
    const rowLine = (model: RowModel): string => {
      const node = model.node;
      const color: Foreground =
        node.kind === "thinking"
          ? "muted"
          : node.status === "running"
            ? "accent"
            : model.tone === "error" || model.tone === "warning"
              ? model.tone
              : node.status === "success"
                ? "success"
                : "dim";
      const guide = model.ancestors.map(ancestor => (ancestor ? "   " : glyphs.pipe + "  ")).join("");
      const tool = visibleWidth(model.tool) > toolWidth ? truncateToWidth(model.tool, toolWidth, ELLIPSIS) : model.tool;
      // Every call row keeps the rail's vertical stroke, so the spine stays one column;
      // nesting indents the content, never the rail.
      const lead = spineAt(glyphs.tee, color) + model.mark + " " +
        (guide ? themeText(theme, "dim", guide) : "") + tool +
        " ".repeat(Math.max(0, toolWidth - visibleWidth(tool))) + " ";
      const detailColor: Foreground = node.status === "error" ? "error" : "muted";
      const goal = model.goal
        ? themeText(theme, detailColor, "· ") +
          (node.status === "running"
            ? shimmerText(model.goal, theme, now, node.started)
            : themeText(theme, detailColor, model.goal))
        : "";
      const summary = model.summary;
      const duration = durationCell(model);
      let tail = bars ? timebar(model, color) + " " + duration : duration;
      let room = width - visibleWidth(lead) - visibleWidth(tail) - 1;
      // A deep row on a narrow card gives up its bar before it gives up its goal.
      if (room < GOAL_MIN && bars) {
        tail = duration;
        room = width - visibleWidth(lead) - visibleWidth(tail) - 1;
      }
      // The summary carries the result, so it keeps its room and the goal truncates first.
      const budget = Math.max(1, room - (goal ? visibleWidth(separator) : 0));
      const kept = summary ? truncateToWidth(summary, budget, ELLIPSIS) : "";
      const rest = budget - visibleWidth(kept) - (kept && goal ? visibleWidth(separator) : 0);
      const head = goal && rest >= GOAL_MIN ? truncateToWidth(goal, rest, ELLIPSIS) : "";
      const text = head + (head && kept ? separator : "") + kept;
      const pad = " ".repeat(Math.max(0, width - visibleWidth(lead) - visibleWidth(text) - visibleWidth(tail)));
      return lead + text + pad + tail;
    };

    let nextPhaseIndex = 0;
    const pending: RowModel[] = [];
    for (const model of models) {
      // A row's previews belong to it, but paint after its whole subtree, so a parent's
      // extras wait until the next row at its depth or shallower.
      while (pending.length > 0 && pending[pending.length - 1]!.depth >= model.depth) {
        emitExtras(pending.pop()!);
      }
      const node = model.node;
      const displayPhase = displayPhaseByCall.get(node.id);
      if (model.depth === 0 && node.kind !== "thinking" && displayPhase) {
        const declared = plan.findIndex(phase => phase.id === displayPhase);
        while (nextPhaseIndex <= declared && nextPhaseIndex < plan.length) {
          emitPhase(nextPhaseIndex);
          nextPhaseIndex += 1;
        }
      }
      lines.push(rowLine(model));
      targets.set(lines.length - 1, node.id);
      if (model.expanded) pending.push(model);
    }
    while (pending.length > 0) emitExtras(pending.pop()!);
    while (nextPhaseIndex < plan.length) {
      emitPhase(nextPhaseIndex);
      nextPhaseIndex += 1;
    }

    // The closing mark closes the rail with the same rollup the headline opened with.
    const closing = [
      ...(progress !== undefined ? [themeText(theme, "accent", `${progress}%`)] : []),
      counted(theme, tools.length, "call", "calls"),
      themeText(theme, "dim", formatElapsed(Math.max(0, now - group.started))),
      ...toolBreakdown(tools, theme, glyphs, 4, settings.icons, settings.iconMode, settings.groupNestedTools, settings.groupToolNames),
    ];
    lines.push(fitToolLine(spineAt(glyphs.hollow) + closing.join(separator), width));
    targets.set(lines.length - 1, GROUP_TARGET);
    return lines;
  },
};
