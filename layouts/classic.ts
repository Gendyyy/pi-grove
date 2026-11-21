/**
 * layouts/classic.ts — the shipped card: a boxed headline, a progress meter,
 * phase rules and branch rows, moved verbatim out of the painter.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { fitToolLine, formatElapsed, summaryLine } from "../block-render.js";
import { filesSummary, filesTouched, shortPath } from "../card-files.js";
import { themeText, toolColor, type Foreground, type GroveTheme } from "../theme.js";
import {
  DOT,
  ELLIPSIS,
  GROUP_TARGET,
  PHASES_TARGET,
  PREVIEW_LINES,
  countDeclaredErrors,
  milestoneTarget,
  type Glyphs,
} from "../tree-model.js";
import { elapsedFor, rowExtras, rowModels, type RowModel } from "../card-row.js";
import {
  durationSpark,
  pulseText,
  sideDurationRail,
  taskProgressText,
} from "../card-progress.js";
import {
  closedPhases,
  derivedProgress,
  phaseInFlight,
  phaseMeterText,
  titleBorder,
  topRule,
} from "../card-plan.js";
import type { CardContext, CardLayout } from "../card-layout.js";


/**
 * One phase rule: the numbered mark, the whole phase title, then whatever numbers fit.
 *
 * The title keeps every word it was given. The metrics take only the cells the title leaves, and a
 * title wider than the card wraps under its own first word instead of being shortened.
 */
function phaseRule(
  head: string,
  title: string,
  cells: readonly string[],
  role: Foreground,
  inner: number,
  theme: GroveTheme,
): string[] {
  const paint = (text: string) => themeText(theme, role, text, true);
  const room = inner - visibleWidth(head) - 1;
  const titleWidth = visibleWidth(title);
  if (titleWidth <= room) {
    // A cell joins only if the whole title still fits beside it, so no word is ever traded for a number.
    const kept = [...cells];
    const joined = () => kept.join(themeText(theme, "dim", DOT));
    while (kept.length > 0 && titleWidth + 1 + visibleWidth(joined()) > room) kept.shift();
    const rollup = joined();
    const used = titleWidth + (rollup ? 1 + visibleWidth(rollup) : 0);
    const gap = " ".repeat(Math.max(1, room - used));
    return [head + " " + paint(title) + gap + rollup];
  }
  const segments: string[] = [];
  let line = "";
  for (const word of title.split(" ").filter(Boolean)) {
    const next = line ? line + " " + word : word;
    if (line && visibleWidth(next) > room) {
      segments.push(line);
      line = word;
    } else line = next;
  }
  if (line) segments.push(line);
  const indent = " ".repeat(visibleWidth(head) + 1);
  return segments.map((segment, index) => (index === 0 ? head + " " : indent) + paint(segment));
}

/** The shipped card: a boxed headline, a meter, phase rules and branch rows. */

/** The shipped card: a boxed headline, a meter, phase rules and branch rows. */
export const classicLayout: CardLayout = {
  /** Compose the classic card's lines from the shared context. */
  paint(ctx: CardContext): string[] {
    const {
      state, group, width, inner, framed, theme, glyphs, tools, visible, plan, targets,
      now, hidden, displayPhaseByCall, phaseElapsedById, durationScale,
    } = ctx;
    targets.clear();
    const lines: string[] = [];
    if (group.rows.length === 0) return lines;
    const settings = state.settings;
    const story = plan.length > 0;
    // Branch glyphs belong to a phase, not to the card: the last call of a phase closes that
    // phase's branch, so the next phase starts a fresh one and every phase reads as a group.
    const branchEnd = new Set<string>();
    visible.forEach((node, index) => {
      const next = visible[index + 1];
      const key = displayPhaseByCall.get(node.id) ?? "";
      const nextKey = next === undefined ? undefined : displayPhaseByCall.get(next.id) ?? "";
      if (next === undefined || nextKey !== key) branchEnd.add(node.id);
    });
    let nextPhaseIndex = 0;
    let hasPhaseMarker = false;
    let phaseConnectorRole: Foreground = "dim";
    let lastPhaseTarget: string | undefined;

    /** Link phase diamonds only; call rows use their colored branch glyphs for sequence. */
    const appendPhaseMarker = (line: string, target: string, nextRole: Foreground): void => {
      if (hasPhaseMarker) {
        lines.push(themeText(theme, phaseConnectorRole, glyphs.pipe));
        // A phase link belongs to the phase above it, so its click expands that phase's calls.
        if (lastPhaseTarget !== undefined) targets.set(lines.length - 1, lastPhaseTarget);
      }
      lines.push(fitToolLine(line, inner));
      targets.set(lines.length - 1, target);
      lastPhaseTarget = target;
      hasPhaseMarker = true;
      phaseConnectorRole = nextRole;
    };

    /**
     * Branch lines carry no colour at all: they say where a row hangs, and the row's own mark
     * already says how it went.
     */
    const branchGuide = (ancestors: readonly boolean[], end: boolean): string =>
      ancestors.map(ancestor => (ancestor ? "   " : glyphs.pipe + "  ")).join("") +
      (end ? glyphs.end : glyphs.tee) + glyphs.h + " ";

    const phaseRoles = new Map<number, Foreground>();
    /** Keep every row in a phase on the same status-colored rail. */
    const phaseRole = (index: number): Foreground => {
      const cached = phaseRoles.get(index);
      if (cached) return cached;
      const phase = plan[index];
      if (!phase) return "dim";
      // Colour answers one question: has the plan moved past this phase? Only a failure overrides it,
      // so a phase cannot turn green and back while the pointer still sits on it.
      const closed = closedPhases(group);
      const activeIndex = plan.findIndex(item => item.id === group.activeMilestoneId);
      const failed = countDeclaredErrors(tools, phase.id) > 0;
      const role: Foreground = failed ? "warning" : index < closed ? "success" : index === activeIndex ? "accent" : "dim";
      phaseRoles.set(index, role);
      return role;
    };

    /** Paint a declared phase before its calls, with a rollup of the time already spent. */
    const emitPhase = (index: number): void => {
      const phase = plan[index];
      if (!phase) return;
      // A phase closes the moment its own calls return, whatever the pointer still says — but the last
      // one, which waits for the final response like the meter does.
      const closed = closedPhases(group);
      const activeIndex = plan.findIndex(item => item.id === group.activeMilestoneId);
      if (story) {
        const phaseRows = tools.filter(node => displayPhaseByCall.get(node.id) === phase.id);
        const failures = countDeclaredErrors(phaseRows, phase.id);
        const done = index < closed;
        const role = phaseRole(index);
        // The phase in flight breathes on the same clock as its calls and keeps breathing until the plan
        // moves past it or the card closes: a gap between two calls is still that phase working, so its
        // own calls returning never stops the breath. A failed call changes colour, never motion.
        const live = index === activeIndex && phaseInFlight(group);
        const settled = failures ? glyphs.warning : done ? glyphs.dot : glyphs.hollow;
        const mark = failures || done || index !== activeIndex ? settled : glyphs.dot;
        const target = milestoneTarget(phase.id);
        const number = String(index + 1).padStart(2, "0");
        // Only the dot breathes, in the running role: the number keeps the colour its siblings share.
        const head = live
          ? pulseText(glyphs.dot, theme, now, "warning") + themeText(theme, role, " " + number)
          : themeText(theme, role, mark + " " + number);
        // A failure shows in the mark and the role, so the rule spends no cell counting it.
        const cells = [
          themeText(theme, "dim", `${phaseRows.length} ${phaseRows.length === 1 ? "call" : "calls"}`),
          themeText(theme, "dim", formatElapsed(phaseElapsedById.get(phase.id) ?? 0)),
        ];
        for (const line of phaseRule(head, phase.label, cells, "text", inner, theme)) {
          lines.push(fitToolLine(line, inner));
          targets.set(lines.length - 1, target);
        }
        return;
      }
      const role: Foreground = phaseRole(index);
      const phaseRows = tools.filter(node => displayPhaseByCall.get(node.id) === phase.id);
      // Count the phase's direct timeline rows; nested totals stay governed by the codemode summary setting.
      const calls = phaseRows.length;
      const elapsed = phaseElapsedById.get(phase.id) ?? 0;
      const phaseTarget = milestoneTarget(phase.id);
      // A live phase breathes instead of holding a still diamond from the moment it opens until it
      // closes; a failure inside it shows in the colour, never in a counter.
      const live = index === activeIndex && phaseInFlight(group);
      const head = live ? pulseText(glyphs.diamond, theme, now, "warning") : themeText(theme, role, glyphs.diamond);
      const separator = themeText(theme, "dim", DOT);
      const rail = sideDurationRail(elapsed, durationScale, inner, theme, glyphs, role);
      const clock = themeText(theme, "dim", formatElapsed(elapsed));
      const cells = [
        calls > 0 ? themeText(theme, "dim", calls + " " + (calls === 1 ? "call" : "calls")) : "",
        rail ? rail + separator + clock : clock,
      ].filter(Boolean);
      const rule = phaseRule(head, phase.label, cells, role, inner, theme);
      appendPhaseMarker(rule[0]!, phaseTarget, role);
      for (const line of rule.slice(1)) {
        lines.push(fitToolLine(line, inner));
        targets.set(lines.length - 1, phaseTarget);
      }
    };

    // The headline always leads the card: the border names the current task, the strip carries
    // progress and time, and the rows below say how much work there is.
    // The plan meter leads the card: it carries the estimate, the current phase and the shape
    // of the remaining plan in one line, so the rollup never has to repeat the percentage.
    const running = tools.some(row => row.status === "running");
    // Progress is never declared: it is the share of the plan already finished.
    const shownProgress = derivedProgress(group);
    const meter = settings.groupProgress
      ? phaseMeterText(group, theme, glyphs, inner, now, running, settings.groupPercent, settings.groupPhases)
      : undefined;
    let headerLine = "";
    if (tools.length > 0) {
      // Keep the strip factual: progress, duration shape and failures, with no status label and
      // no counts — the rows below already say how much work there is.
      const parts: string[] = [];
      if (!meter && settings.groupProgress && shownProgress !== undefined)
        parts.push(taskProgressText(shownProgress, theme, glyphs, settings.groupPercent));
      // Keep the duration shape ahead of the count and tool mix when space gets tight.
      if (settings.groupSparkline) {
        const spark = durationSpark(tools, theme, glyphs);
        if (spark) {
          const chart = glyphs.chart ? themeText(theme, "accent", glyphs.chart + "  ") : "";
          parts.push(chart + spark);
        }
      }
      // An empty strip would print a blank line above the rows, so it prints nothing at all.
      headerLine = parts.length > 0 ? fitToolLine(parts.join(themeText(theme, "dim", DOT)), width) : "";
    }
    // The card names itself first and measures second: one headline line, then the meter, then
    // the work. The share rides the meter beside its own bar, so the headline stays a name.
    // The task intent lives in the card's own top border, so the title never costs a content row.
    const title = group.intent || "GROVE";
    const topBorder = framed ? titleBorder(title, theme, glyphs, width) : "";
    // One line, one gesture: the meter opens the plan it draws, the rail opens the rows.
    if (story) {
      const pieces: string[] = [];
      if (meter) pieces.push(meter.line);
      else if (settings.groupProgress && shownProgress !== undefined) pieces.push(taskProgressText(shownProgress, theme, glyphs, settings.groupPercent));
      if (settings.groupSparkline) {
        const spark = durationSpark(tools, theme, glyphs);
        if (spark) pieces.push(spark);
      }
      const elapsed = formatElapsed(Math.max(0, now - group.started));
      pieces.push(themeText(theme, "dim", elapsed));
      lines.push(fitToolLine(pieces.join(themeText(theme, "dim", DOT)), inner));
      // Without phase cards the meter owns no plan gesture, so the strip falls back to the row gesture.
      targets.set(lines.length - 1, settings.groupPhases ? PHASES_TARGET : GROUP_TARGET);
      for (const line of meter?.plan ?? []) {
        lines.push(line);
        targets.set(lines.length - 1, PHASES_TARGET);
      }
    } else if (meter) {
      lines.push(meter.line);
      targets.set(lines.length - 1, settings.groupPhases ? PHASES_TARGET : GROUP_TARGET);
      for (const line of meter.plan ?? []) {
        lines.push(line);
        targets.set(lines.length - 1, PHASES_TARGET);
      }
    }
    // Without the box the rule carries the strip, so the card spends one row on chrome, not three.
    if (headerLine && !story && framed) {
      lines.push(headerLine);
      targets.set(lines.length - 1, GROUP_TARGET);
    }

    // The window's leftovers are named, and the row doubles as the shortcut that opens them.
    if (hidden > 0) {
      const noun = hidden === 1 ? "call" : "calls";
      lines.push(fitToolLine(themeText(theme, "dim", `${ELLIPSIS} ${hidden} earlier ${noun} · ctrl+o`), inner));
      targets.set(lines.length - 1, GROUP_TARGET);
    }

    const phaseIndent = story && plan.length > 0 ? "  " : "";

    /** Paint a row's previews, nested Bash output and live block after its whole subtree. */
    const emitExtras = (model: RowModel): void => {
      const childGuide = [...model.ancestors, model.last].map(ancestor => (ancestor ? "   " : glyphs.pipe + "  ")).join("");
      const prefix = themeText(theme, "dim", phaseIndent + childGuide + glyphs.pipe + " ");
      const prefixWidth = visibleWidth(prefix);
      for (const text of rowExtras(ctx, model, Math.max(1, inner - prefixWidth), Math.max(1, width - prefixWidth))) {
        lines.push(fitToolLine(prefix + text, width));
        targets.set(lines.length - 1, model.node.id);
      }
    };

    /** Render visible call nodes as aligned markers, preserving expansion and previews. */
    const pending: RowModel[] = [];
    for (const model of rowModels(ctx)) {
      // A row's previews belong to it, but paint after its whole subtree, so a parent's
      // extras wait until the next row at its depth or shallower.
      while (pending.length > 0 && pending[pending.length - 1]!.depth >= model.depth) {
        emitExtras(pending.pop()!);
      }
      const node = model.node;
      const displayPhase = displayPhaseByCall.get(node.id);
      if (model.depth === 0 && node.kind !== "thinking" && displayPhase) {
        const declaredIndex = plan.findIndex(phase => phase.id === displayPhase);
        while (nextPhaseIndex <= declaredIndex && nextPhaseIndex < plan.length) {
          emitPhase(nextPhaseIndex);
          nextPhaseIndex += 1;
        }
      }

      const connectorColor: Foreground =
        node.kind === "thinking"
          ? "muted"
          : node.status === "running"
            ? "accent"
            : model.tone === "error" || model.tone === "warning"
              ? model.tone
              : node.status === "success"
                ? "success"
                : "dim";
      // A call hangs off its phase on a branch in both layouts: the tee or end says whose child
      // the row is and the guide above it says how deep, so no row needs a chevron of its own.
      const end = model.depth === 0 ? branchEnd.has(node.id) : model.last;
      const connector =
        themeText(theme, "dim", phaseIndent) + branchGuide(model.ancestors, end) + model.mark + " " + model.tool;
      const elapsed = elapsedFor(node, now);
      const rail = story ? "" : sideDurationRail(elapsed, durationScale, inner, theme, glyphs, connectorColor);
      const separator = themeText(theme, "dim", DOT);
      const railPart = rail ? rail + separator : "";
      const durationSuffix = node.kind === "thinking"
        ? rail + model.duration
        : model.summary ? separator + railPart + model.duration : railPart + model.duration;
      const line = summaryLine(
        connector,
        model.goal ? "· " + model.goal : "",
        separator,
        model.summary,
        inner,
        fittedDetail => {
          const color: Foreground = node.status === "error" ? "error" : "muted";
          const leadLength =
            fittedDetail.startsWith("· ") ? 2 : fittedDetail.startsWith("·") ? 1 : 0;
          const lead = themeText(theme, color, fittedDetail.slice(0, leadLength));
          return lead + themeText(theme, color, fittedDetail.slice(leadLength));
        },
        durationSuffix,
      );
      lines.push(fitToolLine(line, inner));
      targets.set(lines.length - 1, node.id);
      if (model.expanded) pending.push(model);
    }
    while (pending.length > 0) emitExtras(pending.pop()!);

    while (nextPhaseIndex < plan.length) {
      emitPhase(nextPhaseIndex);
      nextPhaseIndex += 1;
    }
    if (lines.length === 0) return lines;

    // The one fixed answer to "what did this turn touch": it sits under the rows so a long
    // card cannot bury it, and clicking it reveals the per-file list.
    const files = filesTouched(group);
    if (files.length > 0) {
      targets.set(lines.length, GROUP_TARGET);
      lines.push(themeText(theme, "dim", glyphs.tick + " ") + themeText(theme, "muted", filesSummary(files, inner - 2)));
      if (ctx.reveal) {
        for (const file of files) {
          lines.push(
            "  " + themeText(theme, "dim", glyphs.tick) + " " +
            themeText(theme, "muted", shortPath(file.path, Math.max(8, inner - 14))) + " " +
            themeText(theme, toolColor(file.tool), file.tool) +
            (file.calls > 1 ? " ×" + file.calls : ""),
          );
          targets.set(lines.length - 1, GROUP_TARGET);
        }
      }
    }

    if (!framed) {
      const body = lines.map(line => fitToolLine(line, inner));
      // The rule is the card's clickable identity, exactly where the border used to be.
      const shifted = [...targets].map(([line, target]) => [line + 1, target] as const);
      targets.clear();
      targets.set(0, GROUP_TARGET);
      for (const [line, target] of shifted) targets.set(line, target);
      return [topRule(title, story ? "" : headerLine, theme, glyphs, width), ...body];
    }
    // The card is its own box: the title rides the top border, the sides carry the frame, and the
    // chrome keeps one tone so the rows inside say how the work is going.
    const edge = (text: string) => themeText(theme, "dim", text);
    const side = edge(glyphs.v + " ");
    const sideEnd = edge(" " + glyphs.v);
    // Every row is padded to the frame's content width, or the right border would wander.
    const body = lines.map(line => {
      const fitted = fitToolLine(line, inner);
      const pad = " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
      return side + fitted + pad + sideEnd;
    });
    const bottom = edge(glyphs.box.bl + glyphs.h.repeat(Math.max(0, width - 2)) + glyphs.box.br);
    // Every click target moves one row down once the border is above them, and the border itself
    // is the gesture that reveals the whole card.
    const shifted = [...targets].map(([line, target]) => [line + 1, target] as const);
    targets.clear();
    targets.set(0, GROUP_TARGET);
    for (const [line, target] of shifted) targets.set(line, target);
    return [topBorder, ...body, bottom];
  },
};
