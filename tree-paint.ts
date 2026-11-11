/**
 * tree-paint.ts — the card painter's entry point: it derives the card context,
 * resolves the configured layout, and returns that layout's lines.
 */
import { plainTheme, type GroveTheme } from "./theme.js";
import { treeGlyphs, type TreeGroup } from "./tree-model.js";
import { cardLayout, type CardContext, type PaintState } from "./card-layout.js";
import { phaseCallIds } from "./card-plan.js";
import { longestElapsed } from "./card-progress.js";
import { elapsedFor } from "./card-row.js";

/** Repaint cadence while a card is live: one breathe step and one honest duration refresh per tick. */
export const TICK_MS = 100;

export type { PaintState } from "./card-layout.js";
export { PULSE_MS, progressGlyph, shimmerText } from "./card-progress.js";
export {
  derivedProgress,
  finishedPhases,
  phaseCallIds,
  planFinished,
} from "./card-plan.js";

/** Draw one group as a tree of rows through the card layout its settings name. */
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
  // A framed card spends two cells per side; under that width the frame cannot hold a row, so the
  // card falls back to the rail and keeps the cells instead.
  const framed = width >= 24;
  const inner = framed ? Math.max(8, width - 4) : width;
  const glyphs = treeGlyphs(state.settings.iconMode);
  const reveal = piExpanded || group.openAll;
  const limit = Math.max(1, state.settings.window);
  // Reasoning rows narrate the card but are not calls, so the rolling window and the
  // counts apply to tool rows only; reasoning from the window start onward stays in
  // place, which keeps each thought directly above the action it led to.
  const tools = group.rows.filter(row => row.kind !== "thinking");
  const plan = state.settings.groupGutter ? group.milestones ?? [] : [];
  // Every call belongs to a phase once a plan exists, and the rule lives with the progress rule so
  // the rows a phase paints and the rows that make it finished can never disagree.
  const phaseByCall = phaseCallIds(group);
  const displayPhaseByCall = state.settings.groupGutter ? phaseByCall : new Map<string, string>();
  // One clock for the whole card, so every spinning mark lands on the same frame.
  const now = Date.now();
  // Every declared phase starts at zero, so the meter still scales against the whole plan.
  const phaseElapsedById = new Map<string, number>((group.milestones ?? []).map(phase => [phase.id, 0]));
  for (const node of tools) {
    const phaseId = phaseByCall.get(node.id);
    if (phaseId === undefined) continue;
    phaseElapsedById.set(phaseId, (phaseElapsedById.get(phaseId) ?? 0) + elapsedFor(node, now));
  }
  const durationScale = Math.max(
    longestElapsed(group.rows, now),
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
  const ctx: CardContext = {
    state,
    group,
    width,
    inner,
    framed,
    theme,
    glyphs,
    tools,
    visible,
    plan,
    piExpanded,
    targets,
    now,
    reveal,
    tail,
    hidden,
    phaseByCall,
    displayPhaseByCall,
    phaseElapsedById,
    durationScale,
  };
  return cardLayout(state.settings.card).paint(ctx);
}
