/**
 * layout-instrument.test.ts — the instrument card on its own: its anatomy at every width,
 * the strip's arrival and departure, its hit map, ASCII parity and the handover to classic.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  GROUP_TARGET,
  PHASES_TARGET,
  treeGlyphs,
  type TreeGroup,
  type TreeNode,
  type TreeSettings,
} from "../tree-model.js";
import type { CardContext, PaintState } from "../card-layout.js";
import { elapsedFor } from "../card-row.js";
import { phaseCallIds } from "../card-plan.js";
import { longestElapsed } from "../card-progress.js";
import { plainTheme } from "../theme.js";
import { instrumentLayout } from "../layouts/instrument.js";
import { classicLayout } from "../layouts/classic.js";

const EPOCH = Date.UTC(2026, 10, 10, 12, 0, 0);
/**
 * Box drawing, spark bars and the unicode marks this layout must never hardcode. The meter's
 * filled and empty cells (U+25B0, U+25B1) are left out: card-plan.ts owns those glyphs.
 */
const UNICODE_INK = /[\u2500-\u257f\u25cf\u25cb\u25c6\u2713\u2581-\u2588\u2800-\u28ff]/u;

/** The tree settings every render starts from, with the instrument selected. */
function settings(overrides: Partial<TreeSettings> = {}): TreeSettings {
  return {
    mode: "turn",
    revealErrors: false,
    icons: true,
    iconMode: "nerd",
    card: "instrument",
    window: 5,
    groupNestedTools: true,
    groupToolNames: true,
    groupProgress: true,
    groupPercent: false,
    groupPhases: true,
    groupSparkline: true,
    groupGutter: true,
    ...overrides,
  };
}

/** One call row, with the fields the tree reads but no captured output. */
function node(id: string, name: string, goal: string, seq: number, overrides: Partial<TreeNode> = {}): TreeNode {
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

/** The design's card: three phases, two closed, a failure and a live call in the last. */
function planGroup(): TreeGroup {
  const read = node("a", "read", "hit map and click targets", 0, { milestone: "inspect", summary: "38 L" });
  const edit = node("b", "edit", "meter line owns the plan gesture", 1, { milestone: "build", duration: 1_100, summary: "+38/−6" });
  const failed = node("c", "bash", "run the full suite", 2, {
    milestone: "verify",
    status: "error",
    duration: 4_800,
    summary: "npm test",
  });
  const live = node("d", "bash", "confirm the package under the new fold", 3, {
    milestone: "verify",
    status: "running",
    started: EPOCH + 4_000,
    duration: undefined,
    summary: "test:pack",
  });
  return {
    key: "instrument",
    rows: [read, edit, failed, live],
    nodes: new Map([
      [read.id, read],
      [edit.id, edit],
      [failed.id, failed],
      [live.id, live],
    ]),
    started: EPOCH,
    budget: 5,
    openAll: false,
    intent: "Wire the meter click to its plan",
    milestones: [
      { id: "inspect", label: "Inspect" },
      { id: "build", label: "Build" },
      { id: "verify", label: "Verify" },
    ],
    activeMilestoneId: "verify",
  };
}

/** Build the same context the painter derives, so the layout can be called on its own. */
function contextFor(
  group: TreeGroup,
  width: number,
  options: { expanded?: ReadonlySet<string>; settings?: Partial<TreeSettings> } = {},
): CardContext {
  const expanded = options.expanded ?? new Set<string>();
  const state: PaintState = { settings: settings(options.settings), expanded };
  const framed = width >= 24;
  const inner = framed ? Math.max(8, width - 4) : width;
  const tools = group.rows.filter(row => row.kind !== "thinking");
  const plan = state.settings.groupGutter ? group.milestones ?? [] : [];
  const visible = group.openAll ? tools : tools.slice(-Math.max(1, state.settings.window));
  const now = EPOCH + 21_000;
  const phaseByCall = phaseCallIds(group);
  const phaseElapsedById = new Map<string, number>((group.milestones ?? []).map(phase => [phase.id, 0]));
  for (const node of tools) {
    const phaseId = phaseByCall.get(node.id);
    if (phaseId === undefined) continue;
    phaseElapsedById.set(phaseId, (phaseElapsedById.get(phaseId) ?? 0) + elapsedFor(node, now));
  }
  return {
    state,
    group,
    width,
    inner,
    framed,
    theme: plainTheme,
    glyphs: treeGlyphs(state.settings.iconMode),
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

/** Assert every line fits inside the card width it was painted for. */
function expectWithinWidth(lines: string[], width: number): void {
  for (const line of lines) {
    const actual = visibleWidth(line);
    assert.ok(actual <= width, `line is ${actual} cells wide, card is ${width}: ${JSON.stringify(line)}`);
  }
}

test("the instrument paints a headline, a meta row, a strip, a meter and railed rows", () => {
  const lines = instrumentLayout.paint(contextFor(planGroup(), 100));
  expectWithinWidth(lines, 100);
  assert.equal(visibleWidth(lines[0]!), 100);
  assert.ok(lines[0]!.startsWith("Wire the meter click to its plan"), "the title leads the card");
  assert.ok(lines[0]!.endsWith("67%"), "the share sits on the headline");
  assert.ok(lines[1]!.includes("4 calls"), "the meta row counts the calls");
  assert.ok(lines[1]!.includes("21s"), "the meta row ends with the wall clock");
  const strip = lines.findIndex(line => line.includes("Inspect") && line.includes("Build"));
  assert.ok(strip > 1, "one strip line names every phase");
  assert.match(lines[strip]!, /^01 ✓ Inspect/);
  assert.ok(lines[strip]!.includes("2c !1"), "the failing phase counts its calls and its failures");
  assert.ok(lines.some(line => line.includes("▱")), "the meter is drawn");
  const row = lines.find(line => line.includes("read") && line.includes("38 L"));
  assert.ok(row !== undefined, "a call row keeps its tool, goal and summary");
  assert.ok(/[━─]{6}$/.test(row!), "the full form ends every row with its scale bar");
  assert.equal(row!.slice(0, 2), "01", "the row carries its phase number");
});

test("the instrument holds its width at 100, 80, 64, 40 and 23 columns", () => {
  for (const width of [100, 80, 64, 40, 23]) {
    const lines = instrumentLayout.paint(contextFor(planGroup(), width));
    assert.ok(lines.length > 0, `no lines at ${width}`);
    expectWithinWidth(lines, width);
    // Under 24 columns the card is classic's unframed form, which has no headline of its own.
    if (width >= 24) assert.ok(lines[0]!.includes("Wire the meter click to its plan"), `title missing at ${width}`);
  }
});

test("the strip is part of the full form and gone in the compact one", () => {
  const strip = (width: number): boolean =>
    instrumentLayout.paint(contextFor(planGroup(), width)).some(line => line.includes("Inspect") && line.includes("Build"));
  assert.equal(strip(100), true);
  assert.equal(strip(64), true);
  assert.equal(strip(63), false);
  assert.equal(strip(40), false);
});

test("the compact form drops the scale bar and the sparkline, and keeps every row", () => {
  const full = instrumentLayout.paint(contextFor(planGroup(), 100));
  const compact = instrumentLayout.paint(contextFor(planGroup(), 40));
  assert.ok(!compact.some(line => /[━─]{6}$/.test(line)), "no bar survives under 64 columns");
  assert.ok(!compact.some(line => /[▁▂▃▄▅▆▇█]/.test(line)), "no sparkline survives under 64 columns");
  assert.ok(full.some(line => /[▁▂▃▄▅▆▇█]/.test(line)), "the full form keeps the sparkline");
  assert.equal(compact.filter(line => /^0\d /.test(line)).length, 4, "every call keeps its own line");
});

test("the instrument registers the headline, the strip, the meter and every call row", () => {
  const ctx = contextFor(planGroup(), 100);
  const lines = instrumentLayout.paint(ctx);
  assert.equal(ctx.targets.get(0), GROUP_TARGET);
  const strip = lines.findIndex(line => line.includes("Inspect") && line.includes("Build"));
  assert.equal(ctx.targets.get(strip), PHASES_TARGET);
  assert.equal(ctx.targets.get(strip + 1), PHASES_TARGET, "the meter opens the same plan");
  for (const id of ["a", "b", "c", "d"]) assert.ok([...ctx.targets.values()].includes(id), `${id} owns a line`);
  const off = contextFor(planGroup(), 100, { settings: { groupPhases: false } });
  const offLines = instrumentLayout.paint(off);
  const offStrip = offLines.findIndex(line => line.includes("Inspect") && line.includes("Build"));
  assert.equal(off.targets.get(offStrip), GROUP_TARGET, "without phase cards the strip is a row gesture");
  assert.equal(ctx.targets.size, lines.length, "every painted line owns exactly one target");
});

test("ASCII mode draws with the card's own glyphs, never a box-drawing character", () => {
  const lines = instrumentLayout.paint(contextFor(planGroup(), 100, { settings: { iconMode: "ascii" } }));
  expectWithinWidth(lines, 100);
  for (const line of lines) assert.ok(!UNICODE_INK.test(line), `unicode ink in ASCII mode: ${JSON.stringify(line)}`);
});

test("below 24 columns the instrument hands the card to classic byte for byte", () => {
  const instrument = instrumentLayout.paint(contextFor(planGroup(), 23));
  const classic = classicLayout.paint(contextFor(planGroup(), 23));
  assert.deepEqual(instrument, classic);
  assert.ok(instrument.length > 0);
});

test("an opened row keeps its previews and stays inside the card", () => {
  const group = planGroup();
  group.nodes.get("a")!.preview = ["tree-block.ts · 38 lines · hit map, reveal targets"];
  const lines = instrumentLayout.paint(contextFor(group, 80, { expanded: new Set(["a"]) }));
  expectWithinWidth(lines, 80);
  assert.ok(lines.some(line => line.includes("hit map, reveal targets")), "the preview is painted under its call");
});
