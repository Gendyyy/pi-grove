/**
 * layouts/classic.ts — the shipped card: a boxed headline, a progress meter,
 * phase rules and branch rows, moved verbatim out of the painter.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { fitToolLine, formatElapsed, summaryLine } from "../block-render.js";
import { themeText, type Foreground } from "../theme.js";
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
  milestoneTarget,
  toolBreakdown,
} from "../tree-model.js";
import { elapsedFor, rowExtras, rowModels, spinnerGlyph, type RowModel } from "../card-row.js";
import {
  durationSpark,
  shimmerText,
  sideDurationRail,
  taskProgressText,
} from "../card-progress.js";
import {
  closedPhases,
  derivedProgress,
  phaseMeterText,
  planFinished,
  titleBorder,
} from "../card-plan.js";
import type { CardContext, CardLayout } from "../card-layout.js";

/** Shortest rule worth drawing after a phase name; below this the row reads as noise. */
const PHASE_RULE_MIN = 4;
/** Narrowest phase label worth showing beside the right-aligned numbers. */
const PHASE_LABEL_MIN = 12;

/** The shipped card: a boxed headline, a meter, phase rules and branch rows. */
export const classicLayout: CardLayout = {
  id: "classic",
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
     * Branch depth stays quiet while this call's tee or end glyph carries its outcome colour.
     */
    const branchGuide = (
      ancestors: readonly boolean[],
      end: boolean,
      color: Foreground,
    ): string => {
      const depth = ancestors.map(ancestor => (ancestor ? "   " : glyphs.pipe + "  ")).join("");
      return themeText(theme, "dim", depth) +
        themeText(theme, color, (end ? glyphs.end : glyphs.tee) + glyphs.h + " ");
    };

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
      const failed = countDirectErrors(tools.filter(node => displayPhaseByCall.get(node.id) === phase.id)) > 0;
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
        const failures = countDirectErrors(phaseRows);
        const done = index < closed;
        const role = phaseRole(index);
        // The phase in flight turns the same spinner as its calls and keeps turning until the plan moves
        // past it or the card closes: a gap between two calls is still that phase working, so its own
        // calls returning never stops the spinner. A failed call changes colour, never motion.
        const live = index === activeIndex && group.settled !== true && !planFinished(group);
        const settled = failures ? glyphs.warning : done ? glyphs.check : glyphs.hollow;
        const mark = live ? spinnerGlyph(glyphs, now) : failures || done || index !== activeIndex ? settled : glyphs.dot;
        const target = milestoneTarget(phase.id);
        const prefix = themeText(theme, role, `${mark} ${String(index + 1).padStart(2, "0")} `);
        const dot = themeText(theme, "dim", DOT);
        // The numbers own the right edge, so phases compare at a glance instead of being read.
        let gutter = "";
        const cells = [
          failures ? themeText(theme, "warning", `${failures} failed`) : "",
          themeText(theme, "dim", `${phaseRows.length} ${phaseRows.length === 1 ? "call" : "calls"}`),
          themeText(theme, "dim", formatElapsed(phaseElapsedById.get(phase.id) ?? 0)),
        ].filter(Boolean);
        for (const cell of cells) {
          const next = gutter ? gutter + dot + cell : cell;
          if (visibleWidth(prefix) + visibleWidth(next) + PHASE_LABEL_MIN <= inner) gutter = next;
        }
        const tail = gutter;
        const label = fitToolLine(themeText(theme, "text", phase.label, true), Math.max(1, inner - visibleWidth(prefix) - visibleWidth(tail) - 1));
        const gap = " ".repeat(Math.max(1, inner - visibleWidth(prefix) - visibleWidth(label) - visibleWidth(tail)));
        lines.push(fitToolLine(prefix + label + gap + tail, inner));
        targets.set(lines.length - 1, target);
        return;
      }
      const role: Foreground = phaseRole(index);
      const phaseRows = tools.filter(node => displayPhaseByCall.get(node.id) === phase.id);
      // Count the phase's direct timeline rows; nested totals stay governed by the codemode summary setting.
      const calls = phaseRows.length;
      const phaseErrors = countDirectErrors(phaseRows);
      const elapsed = phaseElapsedById.get(phase.id) ?? 0;
      const phaseTarget = milestoneTarget(phase.id);
      // A live phase turns instead of holding a still diamond, from the moment it opens until it closes,
      // even after a call inside it failed: the error cell reports that, the marker reports motion.
      const live = index === activeIndex && group.settled !== true;
      const prefix = themeText(theme, role, (live ? spinnerGlyph(glyphs, now) : glyphs.diamond) + " " + phase.label, true);
      const detailParts = [
        calls > 0 ? themeText(theme, "dim", calls + " " + (calls === 1 ? "call" : "calls")) : "",
        phaseErrors > 0 ? errorCell(phaseErrors, theme, settings.icons, settings.iconMode) : "",
      ].filter(Boolean);
      const separator = themeText(theme, "dim", DOT);
      const detail = detailParts.join(separator);
      const rail = sideDurationRail(elapsed, durationScale, inner, theme, glyphs, role);
      const tail = rail + themeText(theme, "dim", DOT + formatElapsed(elapsed));
      const rollup = (detail ? separator + detail : "") + separator + tail;
      // The rule takes exactly the space the rollup leaves, so the row fills the card and never wraps.
      const room = inner - visibleWidth(prefix) - 1 - visibleWidth(rollup);
      const line =
        room >= PHASE_RULE_MIN
          ? prefix + " " + themeText(theme, "dim", glyphs.h.repeat(room)) + rollup
          : summaryLine(prefix, detail, separator, tail, inner);
      appendPhaseMarker(line, phaseTarget, role);
    };

    // The headline always leads the card: the border names the current task, the rollup
    // counts its calls, and the rows below show their detail.
    const errors = countErrors(tools);
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
      parts.push(scope);
      parts.push(...toolBreakdown(tools, theme, glyphs, 4, settings.icons, settings.iconMode, settings.groupNestedTools, settings.groupToolNames));
      if (errors > 0) parts.push(errorCell(errors, theme, settings.icons, settings.iconMode));
      headerLine = fitToolLine(parts.join(themeText(theme, "dim", DOT)), width);
    }
    // The card names itself first and measures second: one headline line, then the meter, then
    // the work. The share rides the meter beside its own bar, so the headline stays a name.
    // The task intent lives in the card's own top border, so the title never costs a content row.
    const topBorder = framed ? titleBorder(group.intent || "GROVE", theme, glyphs, width) : "";
    // One line, one gesture: the meter opens the plan it draws, the rail opens the rows.
    if (story) {
      const pieces: string[] = [];
      if (meter) pieces.push(meter.line);
      else if (settings.groupProgress && shownProgress !== undefined) pieces.push(taskProgressText(shownProgress, theme, glyphs, settings.groupPercent));
      if (errors) pieces.push(themeText(theme, "error", `${errors} failed`));
      pieces.push(counted(theme, tools.length, "call", "calls"));
      if (settings.groupSparkline) {
        const spark = durationSpark(tools, theme, glyphs);
        if (spark) pieces.push(spark);
      }
      pieces.push(...toolBreakdown(tools, theme, glyphs, 4, settings.icons, settings.iconMode, settings.groupNestedTools, settings.groupToolNames));
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
    if (headerLine && !story) {
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
        themeText(theme, "dim", phaseIndent) + branchGuide(model.ancestors, end, connectorColor) + model.mark + " " + model.tool;
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
          const words = fittedDetail.slice(leadLength);
          return lead + (node.status === "running"
            ? shimmerText(words, theme, now, node.started)
            : themeText(theme, color, words));
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
    if (lines.length === 0 || width < 24) return lines;

    if (!framed) {
      const rail = themeText(theme, "dim", glyphs.rail) + " ";
      return lines.map(line => rail + fitToolLine(line, inner));
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
