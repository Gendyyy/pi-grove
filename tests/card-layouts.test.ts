/**
 * card-layouts.test.ts — the shared harness for the card layout seam: render one layout
 * through the real tree, and prove the registry and the row model stay honest.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cardLayout, type CardContext, type PaintState } from "../card-layout.js";
import { elapsedFor, rowModels } from "../card-row.js";
import { phaseCallIds } from "../card-plan.js";
import { longestElapsed } from "../card-progress.js";
import { paintGroup } from "../tree-paint.js";
import { plainTheme, type GroveTheme } from "../theme.js";
import { ToolTree } from "../tool-tree.js";
import type { TreeRow } from "../tree-block.js";
import type { IconMode } from "../icons.js";
import {
  CARD_LAYOUTS,
  treeGlyphs,
  type CardLayoutId,
  type TreeGroup,
  type TreeNode,
  type TreeSettings,
} from "../tree-model.js";

const EPOCH = Date.UTC(2026, 10, 10, 12, 0, 0);

/** The tree settings every harness render starts from: classic, plain, and fully explicit. */
function settings(overrides: Partial<TreeSettings> = {}): TreeSettings {
  return {
    mode: "turn",
    revealErrors: false,
    icons: true,
    iconMode: "auto",
    card: "classic",
    window: 5,
    groupNestedTools: true,
    groupToolNames: true,
    groupProgress: true,
    groupPercent: false,
    groupPhases: false,
    groupSparkline: true,
    groupGutter: true,
    ...overrides,
  };
}

/** One call row, with every field the tree reads but no captured output. */
function node(
  id: string,
  name: string,
  goal: string,
  seq: number,
  overrides: Partial<TreeNode> = {},
): TreeNode {
  return {
    id,
    name,
    goal,
    target: goal,
    status: "success",
    started: EPOCH + seq * 1_000,
    duration: 900,
    summary: "1 file",
    children: [],
    seq,
    ...overrides,
  };
}

/** A card with one parent call, one nested child and a sibling: three visible rows. */
function sampleGroup(): TreeGroup {
  const child = node("a1", "read", "Open the seam", 1, { parent: "a" });
  const parent = node("a", "codemode", "Extract the layout seam", 0, { children: [child] });
  const sibling = node("b", "bash", "Run the suite", 2);
  return {
    key: "sample",
    rows: [parent, sibling],
    nodes: new Map([
      [parent.id, parent],
      [child.id, child],
      [sibling.id, sibling],
    ]),
    started: EPOCH,
    budget: 5,
    openAll: false,
  };
}

/** Build the same context the painter derives, so a layout can be called on its own. */
function contextFor(group: TreeGroup, width: number, expanded: ReadonlySet<string> = new Set()): CardContext {
  const state: PaintState = { settings: settings(), expanded };
  const framed = width >= 24;
  const inner = framed ? Math.max(8, width - 4) : width;
  const glyphs = treeGlyphs(state.settings.iconMode);
  const tools = group.rows.filter(row => row.kind !== "thinking");
  const plan = state.settings.groupGutter ? group.milestones ?? [] : [];
  const visible = group.openAll ? tools : tools.slice(-Math.max(1, state.settings.window));
  const now = Date.now();
  const phaseByCall = phaseCallIds(group);
  const phaseElapsedById = new Map<string, number>((group.milestones ?? []).map(phase => [phase.id, 0]));
  for (const node of tools) {
    const phaseId = phaseByCall.get(node.id);
    if (phaseId === undefined) continue;
    phaseElapsedById.set(phaseId, (phaseElapsedById.get(phaseId) ?? 0) + elapsedFor(node, now));
  }
  const tail = group.openAll ? tools : tools.slice(-Math.max(1, state.settings.window));
  return {
    state,
    group,
    width,
    inner,
    framed,
    theme: plainTheme,
    glyphs,
    tools,
    visible,
    plan,
    piExpanded: false,
    targets: new Map(),
    now,
    reveal: group.openAll,
    tail,
    hidden: Math.max(0, tools.length - tail.length),
    phaseByCall,
    displayPhaseByCall: state.settings.groupGutter ? phaseByCall : new Map<string, string>(),
    phaseElapsedById,
    durationScale: Math.max(longestElapsed(group.rows, now), ...phaseElapsedById.values()),
  };
}

/** Render one layout through the real tree, at one width, with the options the harness owns. */
export function renderCard(
  layout: CardLayoutId,
  width: number,
  tree: ToolTree,
  options: { leader?: string; expanded?: boolean; theme?: GroveTheme; iconMode?: IconMode; icons?: boolean } = {},
): string[] {
  tree.updateSettings({
    card: layout,
    ...(options.iconMode !== undefined ? { iconMode: options.iconMode } : {}),
    ...(options.icons !== undefined ? { icons: options.icons } : {}),
  });
  const row: TreeRow = {
    toolCallId: options.leader ?? "a",
    inner: { render: () => [], invalidate: () => {} },
    theme: options.theme ?? plainTheme,
    expanded: options.expanded ?? false,
    invalidate: () => {},
  };
  return tree.render(row).render(width);
}

/** Assert every line fits inside the card width it was painted for. */
export function expectWithinWidth(lines: string[], width: number): void {
  for (const line of lines) {
    const actual = visibleWidth(line);
    assert.ok(actual <= width, `line is ${actual} cells wide, card is ${width}: ${JSON.stringify(line)}`);
  }
}

test("classic through the registry paints the same lines and targets as paintGroup", () => {
  const group = sampleGroup();
  const expanded = new Set(["a"]);
  const state: PaintState = { settings: settings(), expanded };
  const directTargets = new Map<number, string>();
  const direct = paintGroup(state, group, 80, plainTheme, false, directTargets);
  const ctx = contextFor(group, 80, expanded);
  const viaRegistry = cardLayout("classic").paint(ctx);
  assert.deepEqual(viaRegistry, direct);
  assert.deepEqual([...ctx.targets], [...directTargets]);
});

test("every layout id resolves to its own implementation", () => {
  for (const id of CARD_LAYOUTS) assert.equal(cardLayout(id).id, id);
});

test("every layout paints a card that fits the width it was asked for", () => {
  const group = sampleGroup();
  for (const id of CARD_LAYOUTS) {
    for (const width of [100, 80, 56, 40]) {
      const ctx = contextFor(group, width, new Set(["a"]));
      expectWithinWidth(cardLayout(id).paint(ctx), width);
    }
  }
});

test("every layout keeps the task name when the card gets narrow", () => {
  const group = { ...sampleGroup(), intent: "Wire the meter click to its plan" };
  for (const id of CARD_LAYOUTS) {
    for (const width of [100, 80, 64, 56, 40]) {
      const ctx = contextFor(group, width, new Set(["a"]));
      const head = cardLayout(id).paint(ctx)[0] ?? "";
      // The rollup sheds its numbers before the title sheds its words.
      assert.ok(head.includes("Wire the meter"), `${id} @${width} lost the title: ${JSON.stringify(head)}`);
    }
  }
});

test("the row model counts exactly the rows the classic card paints", () => {
  const group = sampleGroup();
  const ctx = contextFor(group, 80, new Set(["a"]));
  const models = rowModels(ctx);
  cardLayout("classic").paint(ctx);
  const painted = [...ctx.targets.values()].filter(target => group.nodes.has(target));
  assert.deepEqual(models.map(model => model.node.id), ["a", "a1", "b"]);
  assert.equal(painted.length, models.length);
});

test("renderCard paints a live tree through the configured layout within its width", () => {
  const tree = new ToolTree(settings());
  tree.start({
    toolCallId: "a",
    toolName: "read",
    args: { taskIntent: "Read the card seam", path: "card-layout.ts" },
  });
  tree.end({ toolCallId: "a", toolName: "read", result: { content: [] }, isError: false });
  const lines = renderCard("classic", 80, tree);
  assert.ok(lines.length > 0);
  expectWithinWidth(lines, 80);
});
