/**
 * layout-spine.test.ts — the spine card's contract: one rail column, a timebar that only
 * appears where it fits, a complete hit map, ASCII parity, and classic below 24 columns.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CardContext } from "../card-layout.js";
import { phaseCallIds } from "../card-plan.js";
import { longestElapsed } from "../card-progress.js";
import { elapsedFor } from "../card-row.js";
import type { IconMode } from "../icons.js";
import { classicLayout } from "../layouts/classic.js";
import { spineLayout } from "../layouts/spine.js";
import { plainTheme } from "../theme.js";
import type { PaintState } from "../tree-paint.js";
import {
  GROUP_TARGET,
  milestoneTarget,
  treeGlyphs,
  type TreeGroup,
  type TreeNode,
  type TreeSettings,
} from "../tree-model.js";

const EPOCH = Date.UTC(2026, 10, 10, 12, 0, 0);

/** The tree settings every render here starts from: the spine card, plain and explicit. */
function settings(overrides: Partial<TreeSettings> = {}): TreeSettings {
  return {
    mode: "turn",
    revealErrors: false,
    icons: true,
    iconMode: "nerd",
    card: "spine",
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

/** A two-phase card with a nested step, a failure and a closed plan. */
function cardGroup(): TreeGroup {
  const child = node("a1", "read", "Open the seam", 1, { parent: "a", milestone: "inspect" });
  const parent = node("a", "codemode", "Extract the layout seam", 0, {
    children: [child],
    milestone: "inspect",
    duration: 3_400,
    summary: "2 files",
  });
  const bash = node("b", "bash", "Run the suite", 2, { milestone: "inspect", duration: 21_000 });
  const grep = node("c", "grep", "Find the rail", 3, {
    milestone: "verify",
    status: "error",
    duration: 1_200,
  });
  return {
    key: "spine",
    rows: [parent, bash, grep],
    nodes: new Map([
      [parent.id, parent],
      [child.id, child],
      [bash.id, bash],
      [grep.id, grep],
    ]),
    started: EPOCH,
    budget: 5,
    openAll: false,
    intent: "Wire the spine card",
    milestones: [
      { id: "inspect", label: "Inspect" },
      { id: "verify", label: "Verify" },
    ],
    activeMilestoneId: "verify",
  };
}

/** Build the context the painter would derive, so the layout can be called on its own. */
function contextFor(
  group: TreeGroup,
  width: number,
  overrides: Partial<TreeSettings> = {},
  expanded: ReadonlySet<string> = new Set(),
): CardContext {
  const state: PaintState = { settings: settings(overrides), expanded };
  const framed = width >= 24;
  const glyphs = treeGlyphs(state.settings.iconMode);
  const tools = group.rows.filter(row => row.kind !== "thinking");
  const plan = state.settings.groupGutter ? group.milestones ?? [] : [];
  const visible = group.openAll ? tools : tools.slice(-Math.max(1, state.settings.window));
  const now = Date.now();
  const phaseByCall = phaseCallIds(group);
  const phaseElapsedById = new Map<string, number>((group.milestones ?? []).map(phase => [phase.id, 0]));
  for (const item of tools) {
    const phaseId = phaseByCall.get(item.id);
    if (phaseId === undefined) continue;
    phaseElapsedById.set(phaseId, (phaseElapsedById.get(phaseId) ?? 0) + elapsedFor(item, now));
  }
  return {
    state,
    group,
    width,
    inner: framed ? Math.max(8, width - 4) : width,
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
    tail: visible,
    hidden: Math.max(0, tools.length - visible.length),
    phaseByCall,
    displayPhaseByCall: state.settings.groupGutter ? phaseByCall : new Map<string, string>(),
    phaseElapsedById,
    durationScale: Math.max(longestElapsed(group.rows, now), ...phaseElapsedById.values()),
  };
}

/** Paint the spine and prove no line overflows the card it was painted for. */
function paint(width: number, overrides: Partial<TreeSettings> = {}, expanded: ReadonlySet<string> = new Set()): {
  ctx: CardContext;
  lines: string[];
  plain: string[];
} {
  const ctx = contextFor(cardGroup(), width, overrides, expanded);
  const lines = spineLayout.paint(ctx);
  for (const line of lines) {
    const actual = visibleWidth(line);
    assert.ok(actual <= width, `line is ${actual} cells wide, card is ${width}: ${JSON.stringify(line)}`);
  }
  return { ctx, lines, plain: lines.map(line => stripVTControlCharacters(line)) };
}

/** The glyphs the rail itself may carry on a line: connectors, node marks and the closing mark. */
function railGlyphs(iconMode: IconMode): Set<string> {
  const glyphs = treeGlyphs(iconMode);
  return new Set([
    glyphs.pipe,
    glyphs.tee,
    glyphs.hollow,
    glyphs.dot,
    glyphs.check,
    glyphs.warning,
    ...glyphs.spinner,
  ]);
}

test("the spine layout names itself", () => {
  assert.equal(spineLayout.id, "spine");
});

test("the spine paints at every width band, inside its card", () => {
  for (const width of [100, 80, 56, 40, 23]) {
    const { lines } = paint(width);
    assert.ok(lines.length >= 5, `${width} columns painted ${lines.length} lines`);
  }
});

test("the rail is one column: every line after the headline starts in the same cell", () => {
  const { plain } = paint(80);
  const marks = railGlyphs("nerd");
  assert.ok(!marks.has(plain[0]!.slice(0, 1)), "the headline sits above the rail, not on it");
  for (const [index, line] of plain.entries()) {
    if (index === 0) continue;
    assert.ok(marks.has(line.slice(0, 1)), `line ${index} starts off the rail: ${JSON.stringify(line)}`);
    assert.equal(line[1], " ", `line ${index} keeps one cell of air beside the rail: ${JSON.stringify(line)}`);
  }
});

test("call rows hang off the rail with a connector that keeps the stroke", () => {
  const { plain } = paint(80);
  const row = plain.find(line => line.includes("bash"));
  assert.ok(row !== undefined, "the bash row paints");
  assert.ok(row.startsWith("├ "), `the call row connects with a tee: ${JSON.stringify(row)}`);
  const nested = paint(80, {}, new Set(["a"])).plain.find(line => line.includes("Open the seam"));
  assert.ok(nested !== undefined, "the nested row paints");
  assert.ok(nested.startsWith("├ "), `the nested row keeps the rail: ${JSON.stringify(nested)}`);
  assert.ok(
    nested.indexOf("· Open the seam") > row.indexOf("· Run the suite"),
    `the nested row indents off the rail: ${JSON.stringify(nested)}`,
  );
});

test("the timebar fills a fixed column at full width and disappears below it", () => {
  const full = paint(80).plain.find(line => line.includes("bash"));
  assert.ok(full !== undefined && /[▌─]{15}/u.test(full), `the full form draws a 15 cell timebar: ${JSON.stringify(full)}`);
  for (const width of [55, 45, 40]) {
    const row = paint(width).plain.find(line => line.includes("bash"));
    assert.ok(row !== undefined && !/[▌─]{15}/u.test(row), `${width} columns drop the timebar: ${JSON.stringify(row)}`);
  }
});

test("the hit map keeps every row, both phases and the card", () => {
  const { ctx, plain } = paint(80, {}, new Set(["a"]));
  const targets = [...ctx.targets.values()];
  for (const id of ["a", "a1", "b", "c"]) assert.ok(targets.includes(id), `row ${id} is clickable`);
  assert.ok(targets.includes(milestoneTarget("inspect")), "the inspect node is clickable");
  assert.ok(targets.includes(milestoneTarget("verify")), "the verify node is clickable");
  assert.ok(targets.includes(GROUP_TARGET), "the card itself is clickable");
  const rowLine = [...ctx.targets].find(([, target]) => target === "b")?.[0];
  assert.ok(rowLine !== undefined, "the bash row owns a line");
  assert.ok(plain[rowLine]!.includes("bash"), "the bash target points at the bash row");
  for (const line of ctx.targets.keys()) assert.ok(plain[line] !== undefined, `target line ${line} exists`);
});

test("the hidden-window count rides the rail and opens the card", () => {
  const { ctx, plain } = paint(80, { window: 2 });
  const line = plain.findIndex(text => text.includes("earlier call"));
  assert.ok(line > 0, "the dropped calls are named");
  assert.equal(ctx.targets.get(line), GROUP_TARGET, "the hidden line opens the card");
});

test("ASCII mode draws the spine with plain characters only", () => {
  const { plain } = paint(80, { iconMode: "ascii" });
  const unicodeBox = /[│├└─●○✓◆▌┌┐┘┴┬]/u;
  for (const line of plain) {
    assert.ok(!unicodeBox.test(line), `ASCII mode leaks a box glyph: ${JSON.stringify(line)}`);
  }
  const marks = railGlyphs("ascii");
  for (const [index, line] of plain.entries()) {
    if (index === 0) continue;
    assert.ok(marks.has(line.slice(0, 1)), `line ${index} keeps the ASCII rail: ${JSON.stringify(line)}`);
  }
});

test("below 24 columns the spine hands the card to classic unchanged", () => {
  const ctx = contextFor(cardGroup(), 23);
  const spineLines = spineLayout.paint(ctx);
  const spineTargets = [...ctx.targets];
  const classicLines = classicLayout.paint(ctx);
  assert.deepEqual(spineLines, classicLines);
  assert.deepEqual(spineTargets, [...ctx.targets]);
});
