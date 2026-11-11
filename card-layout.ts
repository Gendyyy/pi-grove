/**
 * card-layout.ts — the seam between the card's data and its line composition:
 * the context every layout receives, and the registry that resolves one.
 */
import type { GroveTheme } from "./theme.js";
import type { CardLayoutId, Glyphs, TaskMilestone, TreeGroup, TreeNode, TreeSettings } from "./tree-model.js";
import { classicLayout } from "./layouts/classic.js";
import { instrumentLayout } from "./layouts/instrument.js";
import { ledgerLayout } from "./layouts/ledger.js";
import { spineLayout } from "./layouts/spine.js";
import { marginLayout } from "./layouts/margin.js";

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
  /** One clock sample per paint, so durations, spinners and pulses agree on a frame. */
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

/** One card layout: an identity and the lines it paints from a context. */
export interface CardLayout {
  id: CardLayoutId;
  paint(ctx: CardContext): string[];
}

/** Every layout id maps to its implementation. */
const registry: Record<CardLayoutId, CardLayout> = {
  classic: classicLayout,
  instrument: instrumentLayout,
  ledger: ledgerLayout,
  spine: spineLayout,
  margin: marginLayout,
};

/** Resolve one card layout, falling back to classic for an unknown id. */
export function cardLayout(id: CardLayoutId): CardLayout {
  return registry[id] ?? registry.classic;
}
