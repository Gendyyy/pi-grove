/**
 * tree-paint.ts — turns one group into the lines of its collapsed or revealed card,
 * and records the click target of every line it paints.
 */
import { mixColors, rgbColor, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { colorizeDiff, fitToolLine, formatElapsed, summaryLine } from "./block-render.js";
import type { IconMode } from "./icons.js";
import { plainTheme, themeText, toolLabel, type Foreground, type GroveTheme } from "./theme.js";
import {
  DOT,
  ELLIPSIS,
  GROUP_TARGET,
  CALL_GROUP_TARGET_PREFIX,
  PHASES_TARGET,
  milestoneTarget,
  PREVIEW_LINES,
  TASK_MILESTONE_MAX,
  countErrors,
  countToolCalls,
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

/** Repaint cadence while a card is live: one breathe step and one honest duration refresh per tick. */
export const TICK_MS = 100;

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

/** Shortest rule worth drawing after a phase name; below this the row reads as noise. */
const PHASE_RULE_MIN = 4;

/** Place one duration on the fixed log scale, so a height means the same thing on every card. */
function sparkPosition(ms: number): number {
  const floor = Math.log1p(SPARK_FLOOR_MS);
  const span = Math.log1p(SPARK_CEIL_MS) - floor;
  return Math.max(0, Math.min(1, (Math.log1p(Math.max(0, ms)) - floor) / span));
}
/** Render one height-coded cell per call, on an absolute scale. */
function durationSpark(tools: readonly TreeNode[], theme: GroveTheme, glyphs: Glyphs): string {
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

/** Return the same Grove elapsed interval used by the row's time label. */
function elapsedFor(node: TreeNode, now: number): number {
  return node.duration ?? (node.status === "running" ? Math.max(0, now - node.started) : 0);
}

/** Find the longest elapsed interval across every call and reasoning row in the card. */
function longestElapsed(nodes: readonly TreeNode[], now: number): number {
  let longest = 0;
  for (const node of nodes)
    longest = Math.max(longest, elapsedFor(node, now), longestElapsed(node.children, now));
  return longest;
}

/** Paint a responsive duration track against the longest interval in its card. */
function sideDurationRail(
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

/** Color the percentage by coarse estimate bands. */
function progressColor(progress: number): Foreground {
  if (progress < 34) return "error";
  if (progress < 67) return "warning";
  return "success";
}

/** Blend the theme's error and success colors for one progress cell. */
function progressCellText(theme: GroveTheme, index: number, cells = PROGRESS_CELLS, glyph = "▰"): string {
  const position = cells > 1 ? index / (cells - 1) : 0;
  const palette = theme.colors ?? FALLBACK_PROGRESS_COLORS;
  const color = mixColors(palette.error, palette.success, position, "oklch");
  return theme.style(glyph, { fg: color });
}

/** Paint a static progress bar and percentage, leaving empty cells visually quiet. */
function taskProgressText(progress: number, theme: GroveTheme, glyphs: Glyphs): string {
  const value = Math.max(0, Math.min(100, Math.round(progress)));
  const filled = Math.round((value / 100) * PROGRESS_CELLS);
  const color = progressColor(value);
  const cue = glyphs.progress ? themeText(theme, "accent", glyphs.progress + "  ") : "";
  const bar = Array.from(
    { length: filled },
    (_, index) => progressCellText(theme, index),
  ).join("");
  return cue + bar +
    themeText(theme, "dim", "▱".repeat(PROGRESS_CELLS - filled)) +
    themeText(theme, color, ` ${String(value).padStart(3, " ")}%`);
}

/** One breathe cycle for the active phase marker, slow enough to read as a pulse. */
export const PULSE_MS = 1600;
/** Deepest point of the breathe: the marker quiets toward the muted role, never to nothing. */
const PULSE_DEPTH = 0.85;

/** Roles a marker can breathe in: the hue stays put, only its brightness moves. */
type PulseBase = "accent" | "warning" | "error";

/** Blend the marker's own role toward muted on a cosine curve, so it breathes instead of blinking. */
function pulseText(glyph: string, theme: GroveTheme, now: number, base: PulseBase = "accent"): string {
  const palette = theme.colors;
  const from = palette?.[base];
  if (!from || !palette?.muted) return themeText(theme, base, glyph);
  const phase = (now % PULSE_MS) / PULSE_MS;
  const breath = ((1 - Math.cos(phase * 2 * Math.PI)) / 2) * PULSE_DEPTH;
  return theme.style(glyph, { fg: mixColors(from, palette.muted, breath, "oklch") });
}

/** Cells in a plan meter: wide enough to hold real zones, narrow enough to stay a meter. */
const METER_CELLS_MIN = 10;
const METER_CELLS_MAX = 24;

/** One painted meter: the line itself, plus the expanded plan when the user asked for it. */
interface MeterPaint {
  line: string;
  plan?: string;
}

/**
 * Paint the plan as one meter: the bar is a written ruler whose needle is the estimate.
 * A finished phase keeps the width it earned at the estimate that closed it, the active
 * phase runs from there up to the needle, and the phases still ahead split what is left,
 * so the plan's remaining shape reads without spending a single label on the future.
 */
function phaseMeterText(
  group: TreeGroup,
  theme: GroveTheme,
  glyphs: Glyphs,
  width: number,
  now: number,
  running: boolean,
): MeterPaint | undefined {
  const plan = group.milestones;
  if (!plan || plan.length === 0 || plan.length > TASK_MILESTONE_MAX) return undefined;
  const value = Math.max(0, Math.min(100, Math.round(group.progress ?? 0)));
  const complete = value === 100;
  const activeIndex = complete
    ? plan.length - 1
    : plan.findIndex(milestone => milestone.id === group.activeMilestoneId);
  if (activeIndex < 0) return undefined;

  const caret = group.openPhases ? glyphs.open : glyphs.closed;
  const marker = complete ? glyphs.check : glyphs.dot;
  const label = " " + plan[activeIndex]!.label;
  const position = ` ${activeIndex + 1}/${plan.length}`;
  const pct = ` ${String(value).padStart(3, " ")}%`;
  const cue = glyphs.progress ? themeText(theme, "accent", glyphs.progress + "  ") : "";
  const cueWidth = glyphs.progress ? 3 : 0;
  // The plan's scale survives the longest: a narrow card drops the phase name, then the
  // whole suffix, before it will concede cells the bar needs to show zones at all.
  const forms = [` ${caret} ${marker}${label}${position}`, ` ${caret} ${marker}${position}`, ""];
  const suffix = forms.find(
    form => width - cueWidth - visibleWidth(form) - visibleWidth(pct) - 1 >= METER_CELLS_MIN,
  ) ?? "";
  const cells = Math.max(
    METER_CELLS_MIN,
    Math.min(METER_CELLS_MAX, width - cueWidth - visibleWidth(suffix) - visibleWidth(pct) - (suffix ? 1 : 0)),
  );
  const cellAt = (percent: number): number =>
    Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
  const bounds = group.phaseBounds?.length === plan.length + 1
    ? group.phaseBounds
    : Array.from({ length: plan.length + 1 }, () => 0);

  const fill = cellAt(value);
  const painted: Array<string | undefined> = new Array<string | undefined>(cells).fill(undefined);
  // The whole filled span keeps the estimate's own ramp, error red at the left edge to success
  // green at the right, so the bar's colour and its percentage can never disagree.
  for (let index = 0; index < fill; index += 1) painted[index] = progressCellText(theme, index, cells);
  // A boundary earns a column only once it is actually crossed: nobody can say where a phase
  // will end before it does, so the bar draws no forecasts. The tick keeps the ramp colour of
  // the cell it divides, and one the estimate has retreated behind is a warning right of the needle.
  // Every zone opens with its own column. The first one opens at the bar's left edge, where
  // there is no crossing to earn, so it is painted before the loop can skip it as cell zero.
  painted[0] = fill > 0
    ? progressCellText(theme, 0, cells, glyphs.tick)
    : themeText(theme, "dim", glyphs.tick);
  const ticks = new Set<number>([0]);
  for (let index = 1; index <= activeIndex; index += 1) {
    const tick = cellAt(bounds[index] ?? 0);
    if (tick <= 0 || tick >= cells) continue;
    painted[tick] = tick <= fill
      ? progressCellText(theme, tick, cells, glyphs.tick)
      : themeText(theme, "warning", glyphs.tick);
    ticks.add(tick);
  }
  // The needle is the one cell that moves on its own: it breathes while work is in flight,
  // so a breathing bar means a live call and a still bar means nothing is happening. When a
  // boundary lands on the needle the needle *is* that boundary, so the tick breathes instead.
  if (running && fill > 0) {
    const edge = fill - 1;
    painted[edge] = pulseText(ticks.has(edge) ? glyphs.tick : "▰", theme, now);
  }
  const empty = themeText(theme, "dim", "▱");
  const bar = painted.map(cell => cell ?? empty).join("");
  // A finished plan is green; a plan left open at 100 already says the estimate is wrong.
  const tone: Foreground = complete ? "success" : "accent";
  const suffixText = suffix
    ? themeText(theme, "muted", " " + caret) +
      " " +
      themeText(theme, tone, marker) +
      themeText(theme, tone, suffix.slice(visibleWidth(` ${caret} ${marker}`)))
    : "";
  return {
    line: cue + bar + themeText(theme, progressColor(value), pct) + suffixText,
    plan: group.openPhases ? phasePlanText(group, theme, glyphs, width, value, activeIndex, bounds) : undefined,
  };
}

/** The whole plan under the meter, on demand: every name, and the estimate that closed it. */
function phasePlanText(
  group: TreeGroup,
  theme: GroveTheme,
  glyphs: Glyphs,
  width: number,
  value: number,
  activeIndex: number,
  bounds: number[],
): string {
  const plan = group.milestones ?? [];
  const complete = value === 100;
  const parts: string[] = [];
  plan.forEach((phase, index) => {
    if (index > 0) {
      // The arrow behind a finished phase turns green, so a completed run reads as one line.
      const green = complete || index <= activeIndex;
      parts.push(` ${themeText(theme, green ? "success" : "dim", glyphs.arrow)} `);
    }
    const done = complete || index < activeIndex;
    const current = !complete && index === activeIndex;
    const role: Foreground = done ? "success" : current ? "accent" : "dim";
    const glyph = done ? glyphs.check : current ? glyphs.dot : glyphs.hollow;
    // A finished phase states the estimate that closed it: that crossing is the real fact.
    const crossed = done ? Math.round(index === activeIndex ? value : bounds[index + 1] ?? 0) : undefined;
    parts.push(
      themeText(theme, role, glyph + " " + phase.label) +
        (crossed === undefined ? "" : themeText(theme, "muted", ` ${crossed}%`)),
    );
  });
  return fitToolLine("  " + parts.join(""), width);
}

/** A row marker: its glyph, the role that colours it, and the role it breathes while live. */
interface StateMark {
  glyph: string;
  color: Foreground;
  pulse?: PulseBase;
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
        ...(node.status === "running" ? { pulse: color } : {}),
      };
    }
  }
  switch (node.status) {
    case "running":
      // A live call breathes the way the active milestone does: one steady dot whose colour
      // swells and quiets, instead of a rotating glyph that makes the row flicker.
      return { glyph: glyphs.dot, color: "warning", pulse: "warning" };
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
  // Under 24 columns the card has no frame, so preserve the entire row width.
  const inner = width < 24 ? width : Math.max(8, width - 4);
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
  const phasePlan = group.milestones ?? [];
  const plan = state.settings.groupGutter ? phasePlan : [];
  const story = plan.length > 0;
  const phaseByCall = new Map<string, string>();
  let latestObservedPhase = -1;
  for (const node of tools) {
    if (!node.milestone) continue;
    const declaredIndex = phasePlan.findIndex(phase => phase.id === node.milestone);
    if (declaredIndex < 0) continue;
    latestObservedPhase = Math.max(latestObservedPhase, declaredIndex);
    const phase = phasePlan[latestObservedPhase];
    if (phase) phaseByCall.set(node.id, phase.id);
  }
  const displayPhaseByCall = state.settings.groupGutter ? phaseByCall : new Map<string, string>();
  // Contiguous runs preserve chronology and retain a stable first-call disclosure target.
  const callGroups = new Map<string, { first: string; label: string; nodes: TreeNode[] }>();
  let run: { first: string; label: string; nodes: TreeNode[]; phase: string } | undefined;
  for (const node of tools) {
    const phase = displayPhaseByCall.get(node.id);
    if (!phase || !node.callGroup) { run = undefined; continue; }
    if (!run || run.phase !== phase || run.label !== node.callGroup)
      run = { first: node.id, label: node.callGroup, phase, nodes: [] };
    run.nodes.push(node);
    callGroups.set(node.id, run);
  }
  // A single labeled call needs no extra disclosure level.
  for (const [id, candidate] of callGroups) if (candidate.nodes.length < 2) callGroups.delete(id);
  const durationNow = Date.now();
  // Every declared phase starts at zero, so the meter still scales against the whole plan.
  const phaseElapsedById = new Map<string, number>(phasePlan.map(phase => [phase.id, 0]));
  for (const node of tools) {
    const phaseId = phaseByCall.get(node.id);
    if (phaseId === undefined) continue;
    phaseElapsedById.set(phaseId, (phaseElapsedById.get(phaseId) ?? 0) + elapsedFor(node, durationNow));
  }
  const durationScale = Math.max(
    longestElapsed(group.rows, durationNow),
    ...phaseElapsedById.values(),
  );

  // One entry per call-level row: a group row when a run qualifies, otherwise one call row.
  // The newest entries stay visible, so the card always shows what just happened, including
  // the tail of a phase that has already finished.
  const entries: TreeNode[][] = [];
  for (const node of tools) {
    const callGroup = callGroups.get(node.id);
    if (!callGroup) entries.push([node]);
    else if (callGroup.first === node.id) entries.push(callGroup.nodes);
  }
  const tail = reveal ? tools : entries.slice(-limit).flat();
  const tailIds = new Set(tail.map(node => node.id));
  const expandedPhases = group.expandedMilestones ?? new Set<string>();
  const visible = reveal
    ? tools
    : tools.filter(node => {
        const phase = displayPhaseByCall.get(node.id);
        return tailIds.has(node.id) || (phase !== undefined && expandedPhases.has(phase));
      });
  // Reasoning from the oldest visible call onward stays in place; older reasoning hides with
  // the calls it led to, so opening a phase never drags a stale thought into view.
  const from = visible.length > 0 && visible.length < tools.length
    ? visible[0]!.seq
    : Number.NEGATIVE_INFINITY;
  const visibleIds = new Set(visible.map(row => row.id));
  const rows = group.rows.filter(row =>
    row.kind === "thinking" ? row.seq >= from : visibleIds.has(row.id),
  );
  // Branch glyphs belong to a phase, not to the card: the last call of a phase closes that
  // phase's branch, so the next phase starts a fresh one and every phase reads as a group.
  const branchEnd = new Set<string>();
  const branchRows = rows.filter(node => node.kind !== "thinking");
  branchRows.forEach((node, index) => {
    const next = branchRows[index + 1];
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
      themeText(theme, color, (end ? glyphs.end : glyphs.tee) + " ");
  };

  const phaseRoles = new Map<number, Foreground>();
  /** Keep every row in a phase on the same status-colored rail. */
  const phaseRole = (index: number): Foreground => {
    const cached = phaseRoles.get(index);
    if (cached) return cached;
    const phase = plan[index];
    if (!phase) return "dim";
    const activeIndex = group.progress === 100 ? plan.length - 1 : plan.findIndex(item => item.id === group.activeMilestoneId);
    const role: Foreground = countErrors(tools.filter(node => displayPhaseByCall.get(node.id) === phase.id))
      ? "warning" : group.progress === 100 || index < activeIndex ? "success" : index === activeIndex ? "warning" : "dim";
    phaseRoles.set(index, role);
    return role;
  };

  /** Paint a declared phase before its calls, with a rollup of the time already spent. */
  const emitPhase = (index: number): void => {
    const phase = plan[index];
    if (!phase) return;
    const complete = group.progress === 100;
    const activeIndex = complete ? plan.length - 1 : plan.findIndex(item => item.id === group.activeMilestoneId);
    if (story) {
      const phaseRows = tools.filter(node => displayPhaseByCall.get(node.id) === phase.id);
      const failures = countErrors(phaseRows);
      const done = complete || index < activeIndex;
      const role = phaseRole(index);
      const mark = failures ? glyphs.warning : done ? glyphs.check : index === activeIndex ? glyphs.dot : glyphs.hollow;
      const open = reveal || expandedPhases.has(phase.id);
      const target = milestoneTarget(phase.id);
      const rail = themeText(theme, role, glyphs.v + " ");
      const prefix = rail + themeText(theme, role, `${mark} ${String(index + 1).padStart(2, "0")} `);
      const failureText = failures ? ` · ${failures} failed` : "";
      const disclosure = ` ${open ? glyphs.open : glyphs.closed}`;
      const labelBudget = Math.max(0, inner - visibleWidth(prefix) - visibleWidth(failureText) - visibleWidth(disclosure));
      const label = fitToolLine(themeText(theme, "text", phase.label, true), labelBudget);
      const count = ` · ${phaseRows.length} ${phaseRows.length === 1 ? "call" : "calls"}`;
      const duration = ` · ${formatElapsed(phaseElapsedById.get(phase.id) ?? 0)}`;
      const metaBudget = Math.max(0, inner - visibleWidth(prefix + label + failureText + disclosure));
      const meta = visibleWidth(count + duration) <= metaBudget ? count + duration : visibleWidth(count) <= metaBudget ? count : "";
      lines.push(fitToolLine(prefix + label + themeText(theme, "dim", meta) +
        themeText(theme, "warning", failureText) + themeText(theme, "dim", disclosure), inner));
      targets.set(lines.length - 1, target);
      // The summary stands only for calls the rows below cannot show, and always names the
      // phase's full call count so a collapsed phase still reads as the work it stands for.
      const hidden = open ? [] : phaseRows.filter(node => !visibleIds.has(node.id));
      if (hidden.length > 0) {
        const descriptions = hidden.slice(0, 2).map(node => detailOf(node) || node.name);
        const count = ` · ${phaseRows.length} ${phaseRows.length === 1 ? "call" : "calls"}`;
        const lead = rail + themeText(theme, "dim", "  " + glyphs.closed + " ");
        const budget = Math.max(0, inner - visibleWidth(lead) - visibleWidth(count));
        lines.push(lead + fitToolLine(themeText(theme, "muted", descriptions.join(" · ")), budget) + themeText(theme, "dim", count));
        targets.set(lines.length - 1, target);
      }
      return;
    }
    const role: Foreground = complete || index < activeIndex ? "success" : index === activeIndex ? "accent" : "dim";
    const phaseRows = tools.filter(node => displayPhaseByCall.get(node.id) === phase.id);
    // Count the phase's direct timeline rows; nested totals stay governed by the codemode summary setting.
    const calls = phaseRows.length;
    const phaseErrors = countErrors(phaseRows);
    const elapsed = phaseElapsedById.get(phase.id) ?? 0;
    const phaseTarget = milestoneTarget(phase.id);
    const prefix = themeText(theme, role, glyphs.diamond + " " + phase.label, true);
    const detailParts = [
      calls > 0 ? themeText(theme, "dim", calls + " " + (calls === 1 ? "call" : "calls")) : "",
      phaseErrors > 0 ? errorCell(phaseErrors, theme, state.settings.icons, state.settings.iconMode) : "",
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

    const hiddenCalls = phaseRows.filter(node => !visibleIds.has(node.id));
    if (hiddenCalls.length > 0) {
      const summaries = hiddenCalls.slice(0, 2).map(node => {
        const callDetail = detailOf(node);
        return callDetail
          ? themeText(theme, "muted", callDetail)
          : toolLabel(node.name, theme, state.settings.icons, state.settings.iconMode, state.settings.groupToolNames);
      });
      const omitted = hiddenCalls.length - summaries.length;
      const summaryParts = [
        counted(theme, hiddenCalls.length, "call", "calls"),
        ...summaries,
      ];
      if (omitted > 0)
        summaryParts.push(counted(theme, omitted, "additional call", "additional calls"));
      const summary = themeText(theme, "dim", "   " + glyphs.closed + " ") +
        summaryParts.join(separator);
      lines.push(fitToolLine(summary, inner));
      targets.set(lines.length - 1, phaseTarget);
    }
  };


  // The headline always leads the card: the border names the current task, the rollup
  // counts its calls, and the rows below show their detail.
  const errors = countErrors(tools);
  // The plan meter leads the card: it carries the estimate, the current phase and the shape
  // of the remaining plan in one line, so the rollup never has to repeat the percentage.
  const running = tools.some(row => row.status === "running");
  const meter = state.settings.groupProgress
    ? phaseMeterText(group, theme, glyphs, inner, Date.now(), running)
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
    if (!meter && state.settings.groupProgress && group.progress !== undefined)
      parts.push(taskProgressText(group.progress, theme, glyphs));
    // Keep the duration shape ahead of the count and tool mix when space gets tight.
    if (state.settings.groupSparkline) {
      const spark = durationSpark(tools, theme, glyphs);
      if (spark) {
        const chart = glyphs.chart ? themeText(theme, "accent", glyphs.chart + "  ") : "";
        parts.push(chart + spark);
      }
    }
    parts.push(scope);
    parts.push(...toolBreakdown(tools, theme, glyphs, 4, state.settings.icons, state.settings.iconMode, state.settings.groupNestedTools, state.settings.groupToolNames));
    if (errors > 0) parts.push(errorCell(errors, theme, state.settings.icons, state.settings.iconMode));
    const head = themeText(theme, "dim", (reveal ? glyphs.open : glyphs.closed) + " ");
    headerLine = fitToolLine(head + parts.join(themeText(theme, "dim", DOT)), width);
  }
  // One line, one gesture: the meter opens the plan it draws, the border opens the rows.
  if (story) {
    const activeIndex = group.progress === 100 ? plan.length - 1 : plan.findIndex(item => item.id === group.activeMilestoneId);
    const current = plan[activeIndex];
    const complete = group.progress === 100;
    const status = !state.settings.groupProgress ? "" : complete ? `${glyphs.check} 100% · Complete` : current ? `${glyphs.dot} ${group.progress ?? 0}% · ${current.label} ${activeIndex + 1}/${plan.length}` : "";
    lines.push(fitToolLine(themeText(theme, "success", "GROVE / TASK", true) + (status ? "  " + themeText(theme, complete ? "success" : "warning", status) : ""), inner));
    targets.set(lines.length - 1, GROUP_TARGET);
    const pieces: string[] = [];
    if (meter) pieces.push(meter.line);
    else if (state.settings.groupProgress && group.progress !== undefined) pieces.push(taskProgressText(group.progress, theme, glyphs));
    if (errors) pieces.push(themeText(theme, "error", `${errors} failed`));
    pieces.push(counted(theme, tools.length, "call", "calls"));
    if (state.settings.groupSparkline) {
      const spark = durationSpark(tools, theme, glyphs);
      if (spark) pieces.push(spark);
    }
    pieces.push(...toolBreakdown(tools, theme, glyphs, 4, state.settings.icons, state.settings.iconMode, state.settings.groupNestedTools, state.settings.groupToolNames));
    const elapsed = formatElapsed(Math.max(0, durationNow - group.started));
    pieces.push(themeText(theme, "dim", elapsed));
    lines.push(fitToolLine(pieces.join(themeText(theme, "dim", DOT)), inner));
    targets.set(lines.length - 1, PHASES_TARGET);
    if (meter?.plan) {
      lines.push(meter.plan);
      targets.set(lines.length - 1, PHASES_TARGET);
    }
    lines.push(themeText(theme, "dim", glyphs.h.repeat(Math.max(0, inner))));
  } else if (meter) {
    lines.push(meter.line);
    targets.set(lines.length - 1, PHASES_TARGET);
    if (meter.plan) {
      lines.push(meter.plan);
      targets.set(lines.length - 1, PHASES_TARGET);
    }
  }
  if (headerLine && !story) {
    lines.push(headerLine);
    targets.set(lines.length - 1, GROUP_TARGET);
  }

  /** Render visible call nodes as aligned markers, preserving expansion and previews. */
  const emit = (nodes: TreeNode[], ancestors: boolean[], inheritedRail?: Foreground, grouped = false): void => {
    for (const [index, node] of nodes.entries()) {
      const last = index === nodes.length - 1;
      const displayPhase = displayPhaseByCall.get(node.id);
      if (ancestors.length === 0 && node.kind !== "thinking" && displayPhase) {
        const declaredIndex = plan.findIndex(phase => phase.id === displayPhase);
        while (nextPhaseIndex <= declaredIndex && nextPhaseIndex < plan.length) {
          emitPhase(nextPhaseIndex);
          nextPhaseIndex += 1;
        }
      }

      const callGroup = ancestors.length === 0 && story ? callGroups.get(node.id) : undefined;
      if (callGroup) {
        const groupOpen = reveal || group.expandedCallGroups?.has(callGroup.first) === true;
        if (node.id === callGroup.first) {
          const phaseIndex = plan.findIndex(phase => phase.id === displayPhase);
          const rail = themeText(theme, phaseRole(phaseIndex), glyphs.v + " ");
          const failures = countErrors(callGroup.nodes);
          const tail = ` · ${callGroup.nodes.length} ${callGroup.nodes.length === 1 ? "call" : "calls"}` + (failures ? ` · ${failures} failed` : "");
          const prefix = rail + themeText(theme, "dim", `  ${groupOpen ? glyphs.open : glyphs.closed} `);
          const budget = Math.max(0, inner - visibleWidth(prefix) - visibleWidth(tail));
          lines.push(prefix + fitToolLine(themeText(theme, "muted", callGroup.label), budget) + themeText(theme, failures ? "error" : "dim", tail));
          targets.set(lines.length - 1, CALL_GROUP_TARGET_PREFIX + callGroup.first);
        }
        if (!groupOpen) continue;
      }
      const open = expandAll || state.expanded.has(node.id);
      const now = Date.now();
      const mark = stateMark(node, glyphs);
      const connectorColor: Foreground =
        node.kind === "thinking"
          ? "muted"
          : node.status === "running"
            ? "accent"
            : mark.color === "error" || mark.color === "warning"
              ? mark.color
              : node.status === "success"
                ? "success"
                : "dim";
      const label =
        node.kind === "thinking"
          ? themeText(theme, "muted", "thinking")
          : toolLabel(node.name, theme, state.settings.icons, state.settings.iconMode, state.settings.groupToolNames);
      const markText = mark.pulse
        ? pulseText(mark.glyph, theme, now, mark.pulse)
        : themeText(theme, mark.color, mark.glyph);
      const end = ancestors.length === 0 ? branchEnd.has(node.id) : last;
      const disclosure = node.children.length > 0 || (node.preview?.length ?? 0) > 0;
      const phaseIndex = displayPhase ? plan.findIndex(phase => phase.id === displayPhase) : -1;
      const railColor = inheritedRail ?? (phaseIndex >= 0 ? phaseRole(phaseIndex) : connectorColor);
      const connector = story
        ? themeText(theme, railColor, glyphs.v + " ") + themeText(theme, "dim", "  ".repeat(ancestors.length + 1 + (grouped || callGroup ? 1 : 0)) + (disclosure ? (open ? glyphs.open : glyphs.closed) : " ") + " ") + markText + " " + label
        : branchGuide(ancestors, end, connectorColor) + markText + " " + label;
      const detail = node.kind === "thinking" ? "" : detailOf(node);
      const elapsed = elapsedFor(node, durationNow);
      const rail = story ? "" : sideDurationRail(elapsed, durationScale, inner, theme, glyphs, connectorColor);
      const rowTailParts = node.kind === "thinking"
        ? {
            summary: "",
            duration: rail + themeText(theme, "dim", DOT + formatElapsed(elapsed)),
          }
        : rowTail(
            node,
            theme,
            glyphs,
            state.settings.icons,
            state.settings.iconMode,
            state.settings.groupNestedTools,
            rail,
            elapsed,
            state.settings.groupToolNames,
          );
      const separator = themeText(theme, "dim", DOT);
      const durationSuffix = rowTailParts.summary
        ? separator + rowTailParts.duration
        : rowTailParts.duration;
      const line = summaryLine(
        connector,
        detail ? "· " + detail : "",
        separator,
        rowTailParts.summary,
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

      if (open) emit(node.children, [...ancestors, last], railColor, grouped || !!callGroup);
      else if (state.settings.revealErrors)
        emit(node.children.filter(child => child.status === "error"), [...ancestors, last], railColor, grouped || !!callGroup);

      // Keep bounded tool previews attached to their call without treating lines as markers.
      const preview = node.children.length === 0 ? node.preview ?? [] : [];
      if (open && preview.length > 0) {
        const childGuide = [...ancestors, last].map(ancestor => (ancestor ? "   " : glyphs.pipe + "  ")).join("");
        const prefix = story
          ? themeText(theme, railColor, glyphs.v + " ") + themeText(theme, "dim", "  ".repeat(ancestors.length + 3 + (grouped || callGroup ? 1 : 0)) + glyphs.pipe + " ")
          : themeText(theme, "dim", childGuide + glyphs.pipe + " ");
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
  while (nextPhaseIndex < plan.length) {
    emitPhase(nextPhaseIndex);
    nextPhaseIndex += 1;
  }
  if (lines.length === 0 || width < 24) return lines;

  // One border around intent, rollup and calls: the group reads as a single object
  // instead of loose lines, and the frame keeps its width whatever the content is.
  const border = (text: string) => themeText(theme, "dim", text);
  const body = (line: string): string => {
    const fitted = fitToolLine(line, inner);
    return border(glyphs.v + " ") + fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted))) + border(" " + glyphs.v);
  };
  const titlePrefix = glyphs.tl + glyphs.h + " ";
  const titleBudget = Math.max(1, width - 10);
  const titleLines = story ? wrapTextWithAnsi(group.intent || "GROVE", titleBudget) : [fitToolLine(group.intent || "GROVE", titleBudget)];
  const title = titleLines[0] ?? "GROVE";
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
  for (const continuation of titleLines.slice(1)) {
    wrapped.push(body(themeText(theme, "accent", continuation, true)));
    remapped.set(wrapped.length - 1, GROUP_TARGET);
  }
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

