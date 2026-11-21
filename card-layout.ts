/**
 * card-layout.ts — the seam between the card's data and its line composition:
 * the context every layout receives.
 */
import type { GroveTheme } from "./theme.js";
import type { Glyphs, TaskMilestone, TreeGroup, TreeNode, TreeSettings } from "./tree-model.js";

/** Render inputs shared by the painter and by tests. */
export interface PaintState {
  settings: TreeSettings;
  expanded: ReadonlySet<string>;
}

/** Everything one card layout needs to compose its lines. */
export interface CardContext {
  state: PaintState;
  group: TreeGroup;
  width: number;
  inner: number;
  framed: boolean;
  theme: GroveTheme;
  glyphs: Glyphs;
  tools: TreeNode[];
  visible: TreeNode[];
  plan: TaskMilestone[];
  piExpanded: boolean;
  targets: Map<number, string>;
  /** One clock sample per paint, so durations and pulses agree on a frame. */
  now: number;
  /** True when every row shows: pi's expand-all or the group's own open state. */
  reveal: boolean;
  /** The rolling window a collapsed card keeps, newest calls last. */
  tail: TreeNode[];
  /** How many call rows the window dropped from the top. */
  hidden: number;
  /** Every call's phase, independent of whether the gutter shows it. */
  phaseByCall: Map<string, string>;
  /** The same map, empty when the gutter setting is off. */
  displayPhaseByCall: Map<string, string>;
  /** Elapsed time per declared phase, every phase seeded at zero. */
  phaseElapsedById: Map<string, number>;
  /** The longest elapsed, used to scale rails and bars. */
  durationScale: number;
}

/** The one card grove paints: the lines it composes from a context. */
export interface CardLayout {
  paint(ctx: CardContext): string[];
}
