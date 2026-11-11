/**
 * card-plan.ts — the card's plan chrome: phase progress, the meter, the phase boxes and
 * the title border every layout draws.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fitToolLine } from "./block-render.js";
import { themeText, type Foreground, type GroveTheme } from "./theme.js";
import {
  ELLIPSIS,
  TASK_MILESTONE_MAX,
  countDirectErrors,
  failedOnOwn,
  phaseShare,
  type Glyphs,
  type TreeGroup,
  type TreeNode,
} from "./tree-model.js";
import { progressCellText, progressGlyph, progressRamp, pulseText } from "./card-progress.js";

/**
 * True when no call of this level failed on its own account: a reasoning row is not work, so one still
 * in flight never blocks a finished plan, and a nested step answers through its own call row, not through
 * the phase.
 */
function allSucceeded(nodes: TreeNode[]): boolean {
  return nodes.every(node => node.kind === "thinking" || node.status === "success" || !failedOnOwn(node));
}

/**
 * The phase each call is painted under: a call that names a phase joins it, and one that names
 * nothing joins the phase of the work it follows, so no call floats outside the plan.
 */
export function phaseCallIds(group: TreeGroup): Map<string, string> {
  const plan = group.milestones ?? [];
  const byCall = new Map<string, string>();
  let latest = -1;
  for (const node of group.rows) {
    if (node.kind === "thinking") continue;
    if (node.milestone) {
      const declared = plan.findIndex(phase => phase.id === node.milestone);
      if (declared > latest) latest = declared;
    }
    const phase = plan[Math.max(latest, 0)];
    if (phase) byCall.set(node.id, phase.id);
  }
  return byCall;
}

/**
 * How many phases are over, counted from the first: a phase is done when its own calls have all
 * returned. The milestone pointer cannot answer this, because it only moves when a later phase
 * speaks — the last phase would keep working after its work came back. A phase nothing called is
 * over once the plan moved past it, or once the card itself closed.
 */
export function finishedPhases(group: TreeGroup): number {
  const plan = group.milestones ?? [];
  const byCall = phaseCallIds(group);
  const active = plan.findIndex(phase => phase.id === group.activeMilestoneId);
  let count = 0;
  for (const [index, phase] of plan.entries()) {
    const calls = group.rows.filter(node => node.kind !== "thinking" && byCall.get(node.id) === phase.id);
    const over = calls.length > 0
      ? calls.every(node => node.status !== "running")
      : index < active || (index === active && group.settled === true);
    if (!over) break;
    count += 1;
  }
  return count;
}

/** True once the plan is over: every phase's work came back, none of it failed, and the turn ended. */
export function planFinished(group: TreeGroup): boolean {
  const plan = group.milestones;
  if (!plan || plan.length === 0) return false;
  return group.settled === true && allSucceeded(group.rows) && finishedPhases(group) === plan.length;
}

/**
 * Phases the card paints as over: the ones the plan pointer has moved past, and the whole plan
 * once the card ends. A phase is over when the work moved on, not when its last call returned —
 * a gap between two calls is still that phase working, so it can never flash green and back.
 */
export function closedPhases(group: TreeGroup): number {
  const plan = group.milestones ?? [];
  if (planFinished(group)) return plan.length;
  const active = plan.findIndex(phase => phase.id === group.activeMilestoneId);
  const byCall = phaseCallIds(group);
  let count = 0;
  // A phase the pointer left while one of its calls still runs is not over either.
  for (let index = 0; index < Math.max(0, active); index += 1) {
    const id = plan[index]?.id;
    const running = group.rows.some(node => node.kind !== "thinking" && byCall.get(node.id) === id && node.status === "running");
    if (running) break;
    count += 1;
  }
  return count;
}

/**
 * Percent the plan has earned: one equal slice per phase already finished, and the full bar once
 * every phase came back clean and the turn ended — a broken plan never earns the last slice.
 * The number only ever climbs: a call starting after the plan looked finished means work remains,
 * not that the finished phases were undone, so the meter holds instead of falling back a phase.
 */
export function derivedProgress(group: TreeGroup): number | undefined {
  const plan = group.milestones;
  if (!plan || plan.length === 0) return undefined;
  const closed = closedPhases(group);
  // A failed phase still finished its work, but only a clean plan earns the last share: the meter
  // counts the work that came back, and a full bar is a claim that the plan went well.
  const earned = planFinished(group)
    ? 100
    : closed === 0
      ? 0
      : phaseShare(plan.length, Math.min(closed, plan.length - 1) - 1);
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
export function phaseMeterText(
  group: TreeGroup,
  theme: GroveTheme,
  glyphs: Glyphs,
  width: number,
  now: number,
  running: boolean,
  showPercent: boolean,
  showPhases: boolean,
): MeterPaint | undefined {
  const plan = group.milestones;
  if (!plan || plan.length === 0 || plan.length > TASK_MILESTONE_MAX) return undefined;
  const value = derivedProgress(group) ?? 0;
  // The bar holds the share it earned; only the plan itself can say the work is over.
  const complete = planFinished(group);
  // A phase's boundary is crossed the moment its own calls return: the pointer only moves once the
  // next phase speaks, so it cannot be the evidence the bar reads.
  const crossed = closedPhases(group);
  const activeIndex = plan.findIndex(milestone => milestone.id === group.activeMilestoneId);
  if (activeIndex < 0 && crossed === 0) return undefined;

  const pct = ` ${value}%`;
  // The pie rides the share it describes, so the headline stays a bare name.
  const share = (complete ? glyphs.check : progressGlyph(value, glyphs)) + (showPercent ? pct : "");
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
  for (let index = 1; index <= crossed; index += 1) {
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
    // The plan is on screen unless the card was told to fold it or phase cards are off.
    plan: group.openPhases === false || !showPhases ? undefined : phasePlanLines(group, theme, glyphs, width, activeIndex),
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
  // A box turns green when its own calls return, so the chain fills from the left as work lands.
  const closed = closedPhases(group);
  const byCall = phaseCallIds(group);
  // A phase can finish badly: its box and the link it closed warn instead of claiming success.
  // Only a call that failed on its own counts: a script that broke on a nested step answers through
  // that step's row.
  const failed = new Set(
    group.rows.filter(node => byCall.has(node.id) && countDirectErrors([node]) > 0).map(node => byCall.get(node.id)!),
  );
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
    const done = index < closed;
    // A failure keeps warning even while the phase is still the one in flight.
    const broke = failed.has(phase.id);
    const current = !done && index === activeIndex;
    const role: Foreground = broke ? "warning" : done ? "success" : current ? "accent" : "dim";
    if (index > 0) {
      // The link closes only once the phase on its left does, so a finished run reads as one chain.
      const linkClosed = index - 1 < closed;
      const linkRole: Foreground = !linkClosed ? "dim" : failed.has(plan[index - 1]!.id) ? "warning" : "success";
      top.push(" ".repeat(PLAN_LINK));
      bottom.push(" ".repeat(PLAN_LINK));
      middle.push(themeText(theme, linkRole, glyphs.h.repeat(PLAN_LINK)));
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

/** The card's top border, with the task intent set into it as a plain label. */
export function titleBorder(title: string, theme: GroveTheme, glyphs: Glyphs, width: number): string {
  const leadIn = themeText(theme, "dim", glyphs.box.tl + glyphs.h);
  // The label keeps a cell of air either side, so it reads as set into the stroke, not glued on.
  const room = Math.max(1, width - visibleWidth(leadIn) - 4);
  const label = truncateToWidth(title, room, ELLIPSIS);
  const lead = leadIn + themeText(theme, "accent", " " + label + " ", true);
  const rule = themeText(theme, "dim", glyphs.h.repeat(Math.max(0, width - visibleWidth(lead) - 1)));
  return lead + rule + themeText(theme, "dim", glyphs.box.tr);
}
