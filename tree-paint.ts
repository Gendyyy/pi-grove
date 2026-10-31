/**
 * tree-paint.ts — turns one group into the lines of its collapsed or revealed card,
 * and records the click target of every line it paints.
 */
import { mixColors, rgbColor, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { colorizeDiff, fitToolLine, formatElapsed, summaryLine } from "./block-render.js";
import type { IconMode } from "./icons.js";
import { plainTheme, themeText, toolLabel, type Foreground, type GroveTheme } from "./theme.js";
import {
  DOT,
  ELLIPSIS,
  GROUP_TARGET,
  PHASES_TARGET,
  milestoneTarget,
  PREVIEW_LINES,
  TASK_MILESTONE_MAX,
  countErrors,
  countToolCalls,
  phaseShare,
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
/** Narrowest phase label worth showing beside the right-aligned numbers. */
const PHASE_LABEL_MIN = 12;

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

/** Blend the error-to-success ramp at one position, so a cue, its bar and its share agree. */
function progressRamp(theme: GroveTheme, position: number, text: string): string {
  const palette = theme.colors ?? FALLBACK_PROGRESS_COLORS;
  return theme.style(text, { fg: mixColors(palette.error, palette.success, Math.max(0, Math.min(1, position)), "oklch") });
}

/** Blend the theme's error and success colors for one progress cell. */
function progressCellText(theme: GroveTheme, index: number, cells = PROGRESS_CELLS, glyph = "▰"): string {
  return progressRamp(theme, cells > 1 ? index / (cells - 1) : 0, glyph);
}

/** Paint a static progress bar and percentage, leaving empty cells visually quiet. */
function taskProgressText(progress: number, theme: GroveTheme, glyphs: Glyphs): string {
  const value = Math.max(0, Math.min(100, Math.round(progress)));
  const filled = Math.round((value / 100) * PROGRESS_CELLS);
  const cue = glyphs.progress ? progressRamp(theme, value / 100, glyphs.progress + "  ") : "";
  const bar = Array.from(
    { length: filled },
    (_, index) => progressCellText(theme, index),
  ).join("");
  return cue + bar +
    themeText(theme, "dim", "▱".repeat(PROGRESS_CELLS - filled)) +
    progressRamp(theme, value / 100, ` ${String(value).padStart(3, " ")}%`);
}

/** One breathe cycle for the active phase marker, slow enough to read as a pulse. */
export const PULSE_MS = 1600;
/** After this long a call is infrastructure, not progress, so the pulse stops instead of blinking forever. */
const PULSE_FREEZE_MS = 5 * 60_000;
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

/** Quarter steps of the progress circle, so its fill never overstates the share it reports. */
export function progressGlyph(progress: number, glyphs: Glyphs): string {
  const index = Math.min(4, Math.round(progress / 25));
  return glyphs.pie[index] ?? glyphs.dot;
}

/** Frame of a running call's spinner: a quarter circle cycling, so a live row moves instead of blinking. */
/** One frame per 80 ms, whatever the frame count: fast enough to read as motion, never a flicker. */
const SPIN_MS = 80;

export function spinnerGlyph(glyphs: Glyphs, now: number): string {
  const frames = glyphs.spinner;
  return frames[Math.floor(now / SPIN_MS) % frames.length] ?? glyphs.dot;
}

/** True when every call in the card succeeded, so a closed plan may count as finished. */
/** True when no call failed: a reasoning row is not work, so one still in flight never blocks a finished plan. */
function allSucceeded(nodes: TreeNode[]): boolean {
  return nodes.every(
    node => (node.kind === "thinking" || node.status === "success") && allSucceeded(node.children),
  );
}

/**
 * True once the plan is over: every call succeeded and the card itself has settled. Reaching the
 * last phase only means it is the one still working, so the plan believes nothing about the end
 * until the card closes — a phase is over when the card is, never earlier.
 */
export function planFinished(group: TreeGroup): boolean {
  const plan = group.milestones;
  if (!plan || plan.length === 0) return false;
  return allSucceeded(group.rows) && group.settled === true;
}

/**
 * Percent the plan has earned: one equal slice per phase already finished, and the full bar once
 * the last phase closed clean, so a card reads complete before the turn ends — a broken one never does.
 * The number only ever climbs: a call starting after the plan looked finished means work remains,
 * not that the finished phases were undone, so the meter holds instead of falling back a phase.
 */
export function derivedProgress(group: TreeGroup): number | undefined {
  const plan = group.milestones;
  if (!plan || plan.length === 0) return undefined;
  const active = plan.findIndex(phase => phase.id === group.activeMilestoneId);
  const earned = planFinished(group) ? 100 : active <= 0 ? 0 : phaseShare(plan.length, active - 1);
  group.reached = Math.max(group.reached ?? 0, earned);
  return group.reached;
}

/** Cells in a plan meter: wide enough to hold real zones, narrow enough to stay a meter. */
const METER_CELLS_MIN = 10;
const METER_CELLS_MAX = 24;
// The separator that opens the stats tail plus the ellipsis it leaves behind: a bar that took
// both would be the reason a narrow card cut the '%' off its own percentage.
const METER_TAIL_RESERVE = 2;
// One cell of air between the bar and its share, so the two never read as one run.
const METER_GAP = 1;

/** One painted meter: the line itself, plus the expanded plan when the user asked for it. */
interface MeterPaint {
  line: string;
  /** The plan block: border row, label row, border row. Absent when the plan is folded away. */
  plan?: string[];
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
  const value = derivedProgress(group) ?? 0;
  // The bar holds the share it earned; only the plan itself can say the work is over.
  const complete = planFinished(group);
  const activeIndex = complete
    ? plan.length - 1
    : plan.findIndex(milestone => milestone.id === group.activeMilestoneId);
  if (activeIndex < 0) return undefined;

  const pct = ` ${value}%`;
  // The pie rides the share it describes, so the headline stays a bare name.
  const share = (complete ? glyphs.check : progressGlyph(value, glyphs)) + pct;
  const cue = glyphs.progress ? progressRamp(theme, value / 100, glyphs.progress + "  ") : "";
  const cueWidth = glyphs.progress ? 3 : 0;
  // The bar keeps the whole line: the phase it is in lives on the plan row below, which
  // names every phase, so naming one of them twice would only spend the bar's cells.
  const cells = Math.max(
    METER_CELLS_MIN,
    Math.min(METER_CELLS_MAX, width - cueWidth - visibleWidth(share) - METER_GAP - METER_TAIL_RESERVE),
  );
  const cellAt = (percent: number): number =>
    Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
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
    const tick = cellAt(phaseShare(plan.length, index - 1));
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
  return {
    line: cue + bar + " " + progressRamp(theme, value / 100, share),
    // The plan is on screen unless the card was told to fold it: a click on the meter folds it.
    plan: group.openPhases === false ? undefined : phasePlanLines(group, theme, glyphs, width, activeIndex),
  };
}

/** A plan box: one space of inner padding a side, two border cells, a three-cell link between boxes. */
const PLAN_PAD = 1;
const PLAN_LINK = 3;
/** Under ten label cells a box stops reading as a name, so a whole phase drops before it gets that small. */
const PLAN_MIN_BOX = 14;

/**
 * The plan under the meter as three rows: one rounded box per phase, chained left to right, going
 * green as each phase closes. Labels shrink first, then whole phases drop: no box is cut in half.
 */
/**
 * Lays the plan out as one linked box per phase.
 * shortcut: allocates widths by hand; pi-tui's HStack basis/minSize can take this over once the row refactor lands.
 */
function phasePlanLines(
  group: TreeGroup,
  theme: GroveTheme,
  glyphs: Glyphs,
  width: number,
  activeIndex: number,
): string[] {
  const plan = group.milestones ?? [];
  if (plan.length === 0) return [];
  const complete = planFinished(group);
  const widths = plan.map(phase => visibleWidth(phase.label) + PLAN_PAD * 2 + 2);
  let over = widths.reduce((sum, box) => sum + box, 0) + (widths.length - 1) * PLAN_LINK - (width - 2);
  while (over > 0) {
    const widest = widths.indexOf(Math.max(...widths));
    if ((widths[widest] ?? 0) <= PLAN_MIN_BOX) break;
    widths[widest] = (widths[widest] ?? 0) - 1;
    over -= 1;
  }
  let dropped = 0;
  while (over > 0 && widths.length > 1) {
    over -= (widths.pop() ?? 0) + PLAN_LINK;
    dropped += 1;
  }
  // The count chip spends cells too, so keep dropping until it fits beside the boxes.
  while (dropped > 0 && widths.length > 1) {
    if (over + 4 + String(dropped).length <= 0) break;
    over -= (widths.pop() ?? 0) + PLAN_LINK;
    dropped += 1;
  }
  const top: string[] = [];
  const middle: string[] = [];
  const bottom: string[] = [];
  widths.forEach((box, index) => {
    const phase = plan[index];
    if (!phase) return;
    const done = complete || index < activeIndex;
    const current = !complete && index === activeIndex;
    const role: Foreground = done ? "success" : current ? "accent" : "dim";
    if (index > 0) {
      // The link closes only once the phase on its left does, so a finished run reads as one chain.
      const closed = complete || index - 1 < activeIndex;
      top.push(" ".repeat(PLAN_LINK));
      bottom.push(" ".repeat(PLAN_LINK));
      middle.push(themeText(theme, closed ? "success" : "dim", glyphs.h.repeat(PLAN_LINK)));
    }
    const border = themeText(theme, role, (role === "dim" ? glyphs.boxAhead : glyphs.h).repeat(box - 2));
    const corner = (glyph: string) => themeText(theme, role, glyph);
    const inner = box - 2 - PLAN_PAD * 2;
    const text = truncateToWidth(phase.label, inner, ELLIPSIS);
    top.push(corner(glyphs.box.tl) + border + corner(glyphs.box.tr));
    bottom.push(corner(glyphs.box.bl) + border + corner(glyphs.box.br));
    middle.push(
      corner(glyphs.v) +
        " ".repeat(PLAN_PAD) +
        themeText(theme, role, text + " ".repeat(Math.max(0, inner - visibleWidth(text)))) +
        " ".repeat(PLAN_PAD) +
        corner(glyphs.v),
    );
  });
  // Whatever did not fit is counted, never guessed at.
  if (dropped) middle.push(themeText(theme, "dim", ` ${glyphs.h} +${dropped}`));
  return [top, middle, bottom].map(row => fitToolLine("  " + row.join(""), width));
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
  // The card spends two columns on its rail instead of four on a box, so narrow cards keep more.
  const inner = width < 24 ? width : Math.max(8, width - 2);
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
  // One clock for the whole card, so every spinning mark lands on the same frame.
  const now = Date.now();
  const phaseByCall = new Map<string, string>();
  let latestObservedPhase = -1;
  // Every call belongs to a phase once a plan exists. A call whose milestone is missing or
  // names something the plan does not have joins the phase of the work it follows, so no row
  // floats outside the plan and the phase counts always add up to the calls on the card.
  for (const node of tools) {
    if (node.milestone) {
      const declaredIndex = phasePlan.findIndex(phase => phase.id === node.milestone);
      if (declaredIndex > latestObservedPhase) latestObservedPhase = declaredIndex;
    }
    const phase = phasePlan[Math.max(latestObservedPhase, 0)];
    if (phase) phaseByCall.set(node.id, phase.id);
  }
  const displayPhaseByCall = state.settings.groupGutter ? phaseByCall : new Map<string, string>();
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

  // The newest calls stay visible, so the card always shows what just happened, including
  // the tail of a phase that has already finished.
  const tail = reveal ? tools : tools.slice(-limit);
  // What the window dropped, said out loud: a card that silently loses rows looks broken.
  const hidden = Math.max(0, tools.length - tail.length);
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
      themeText(theme, color, (end ? glyphs.end : glyphs.tee) + glyphs.h + " ");
  };

  const phaseRoles = new Map<number, Foreground>();
  /** Keep every row in a phase on the same status-colored rail. */
  const phaseRole = (index: number): Foreground => {
    const cached = phaseRoles.get(index);
    if (cached) return cached;
    const phase = plan[index];
    if (!phase) return "dim";
    const finished = planFinished(group);
    const activeIndex = finished ? plan.length - 1 : plan.findIndex(item => item.id === group.activeMilestoneId);
    const role: Foreground = countErrors(tools.filter(node => displayPhaseByCall.get(node.id) === phase.id))
      ? "warning" : finished || index < activeIndex ? "success" : index === activeIndex ? "warning" : "dim";
    phaseRoles.set(index, role);
    return role;
  };

  /** Paint a declared phase before its calls, with a rollup of the time already spent. */
  const emitPhase = (index: number): void => {
    const phase = plan[index];
    if (!phase) return;
    const complete = planFinished(group);
    const activeIndex = complete ? plan.length - 1 : plan.findIndex(item => item.id === group.activeMilestoneId);
    if (story) {
      const phaseRows = tools.filter(node => displayPhaseByCall.get(node.id) === phase.id);
      const failures = countErrors(phaseRows);
      const done = complete || index < activeIndex;
      const role = phaseRole(index);
      // The phase in flight turns the same spinner as its calls and keeps turning until the phase ends,
      // so a gap between two calls never reads as work that stopped. A failed call inside it changes the
      // row's colour and rollup, never the spinner: the phase has not stopped working.
      const live = !done && index === activeIndex && group.settled !== true;
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
    const role: Foreground = complete || index < activeIndex ? "success" : index === activeIndex ? "accent" : "dim";
    const phaseRows = tools.filter(node => displayPhaseByCall.get(node.id) === phase.id);
    // Count the phase's direct timeline rows; nested totals stay governed by the codemode summary setting.
    const calls = phaseRows.length;
    const phaseErrors = countErrors(phaseRows);
    const elapsed = phaseElapsedById.get(phase.id) ?? 0;
    const phaseTarget = milestoneTarget(phase.id);
    // A live phase turns instead of holding a still diamond, from the moment it opens until it closes,
    // even after a call inside it failed: the error cell reports that, the marker reports motion.
    const live = !(complete || index < activeIndex) && index === activeIndex && group.settled !== true;
    const prefix = themeText(theme, role, (live ? spinnerGlyph(glyphs, now) : glyphs.diamond) + " " + phase.label, true);
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
  };


  // The headline always leads the card: the border names the current task, the rollup
  // counts its calls, and the rows below show their detail.
  const errors = countErrors(tools);
  // The plan meter leads the card: it carries the estimate, the current phase and the shape
  // of the remaining plan in one line, so the rollup never has to repeat the percentage.
  const running = tools.some(row => row.status === "running");
  // Progress is never declared: it is the share of the plan already finished.
  const shownProgress = derivedProgress(group);
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
    if (!meter && state.settings.groupProgress && shownProgress !== undefined)
      parts.push(taskProgressText(shownProgress, theme, glyphs));
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
    headerLine = fitToolLine(parts.join(themeText(theme, "dim", DOT)), width);
  }
  // The card names itself first and measures second: one headline line, then the meter, then
  // the work. The share rides the meter beside its own bar, so the headline stays a name.
  const titleLines = wrapTextWithAnsi(group.intent || "GROVE", Math.max(1, inner));
  for (const line of titleLines) {
    lines.push(fitToolLine(themeText(theme, "accent", line, true), inner));
    targets.set(lines.length - 1, GROUP_TARGET);
  }
  // One line, one gesture: the meter opens the plan it draws, the rail opens the rows.
  if (story) {
    const pieces: string[] = [];
    if (meter) pieces.push(meter.line);
    else if (state.settings.groupProgress && shownProgress !== undefined) pieces.push(taskProgressText(shownProgress, theme, glyphs));
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
    for (const line of meter?.plan ?? []) {
      lines.push(line);
      targets.set(lines.length - 1, PHASES_TARGET);
    }
  } else if (meter) {
    lines.push(meter.line);
    targets.set(lines.length - 1, PHASES_TARGET);
    for (const line of meter.plan ?? []) {
      lines.push(line);
      targets.set(lines.length - 1, PHASES_TARGET);
    }
  }
  if (headerLine && !story) {
    lines.push(headerLine);
    targets.set(lines.length - 1, GROUP_TARGET);
  }

  /** Render visible call nodes as aligned markers, preserving expansion and previews. */
  const emit = (nodes: TreeNode[], ancestors: boolean[], inheritedRail?: Foreground): void => {
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

      const open = expandAll || state.expanded.has(node.id);
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
      const markText = mark.spin && now - node.started < PULSE_FREEZE_MS
        ? themeText(theme, mark.color, spinnerGlyph(glyphs, now))
        : themeText(theme, mark.color, mark.glyph);
      const end = ancestors.length === 0 ? branchEnd.has(node.id) : last;
      const phaseIndex = displayPhase ? plan.findIndex(phase => phase.id === displayPhase) : -1;
      const railColor = inheritedRail ?? (phaseIndex >= 0 ? phaseRole(phaseIndex) : connectorColor);
      // A call hangs off its phase on a branch in both layouts: the tee or end says whose child
      // the row is and the guide above it says how deep, so no row needs a chevron of its own.
      const phaseIndent = story && plan.length > 0 ? "  " : "";
      const connector =
        themeText(theme, "dim", phaseIndent) + branchGuide(ancestors, end, connectorColor) + markText + " " + label;
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

      if (open) emit(node.children, [...ancestors, last], railColor);
      else if (state.settings.revealErrors)
        emit(node.children.filter(child => child.status === "error"), [...ancestors, last], railColor);

      // Keep bounded tool previews attached to their call without treating lines as markers.
      const preview = node.children.length === 0 ? node.preview ?? [] : [];
      if (open && preview.length > 0) {
        const childGuide = [...ancestors, last].map(ancestor => (ancestor ? "   " : glyphs.pipe + "  ")).join("");
        const prefix = themeText(theme, "dim", phaseIndent + childGuide + glyphs.pipe + " ");
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

  // The window's leftovers are named, and the row doubles as the shortcut that opens them.
  if (hidden > 0) {
    const noun = hidden === 1 ? "call" : "calls";
    lines.push(fitToolLine(themeText(theme, "dim", `${ELLIPSIS} ${hidden} earlier ${noun} · ctrl+o`), inner));
    targets.set(lines.length - 1, GROUP_TARGET);
  }
  emit(rows, []);
  while (nextPhaseIndex < plan.length) {
    emitPhase(nextPhaseIndex);
    nextPhaseIndex += 1;
  }
  if (lines.length === 0 || width < 24) return lines;

  // The rail is the card: one tone column on the left edge, no right border and no rules, so
  // a group reads as narration inside pi's own row box instead of a box inside a box. The tone
  // is fixed: chrome says where the card is, the rows inside say how the work is going.
  const rail = themeText(theme, "dim", glyphs.rail) + " ";
  return lines.map(line => rail + fitToolLine(line, inner));
}

