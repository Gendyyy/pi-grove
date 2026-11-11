/**
 * layout-ledger.test.ts — the ledger card on its own: anatomy at every width, the dotted
 * leader's arrival and departure, its hit map, ASCII parity, and the handover to classic.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  GROUP_TARGET,
  milestoneTarget,
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
import { ToolTree } from "../tool-tree.js";
import type { TreeRow } from "../tree-block.js";
import { ledgerLayout } from "../layouts/ledger.js";
import { classicLayout } from "../layouts/classic.js";

const EPOCH = Date.UTC(2026, 10, 10, 12, 0, 0);
/** Box drawing, progress bars and the unicode marks the ledger must never hardcode. */
const UNICODE_INK = /[\u2500-\u257f\u25b0\u25b1\u25cf\u25cb\u25c6\u2713\u00b7]/u;

/** The tree settings every render starts from, with the ledger selected. */
function settings(overrides: Partial<TreeSettings> = {}): TreeSettings {
  return {
    mode: "turn",
    revealErrors: false,
    icons: true,
    iconMode: "auto",
    card: "ledger",
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

/** A plan of two phases with a nested child, a failure and a running call. */
function planGroup(): TreeGroup {
  const read = node("a", "read", "Read the card seam", 0, {
    milestone: "inspect",
    preview: ["the seam is here"],
  });
  const grep = node("b", "grep", "Find the paint callers", 1, { milestone: "inspect" });
  const child = node("c1", "bash", "Run the ledger suite", 3, { parent: "c", milestone: "build" });
  const build = node("c", "codemode", "Wire the phase rules", 2, { children: [child], milestone: "build" });
  const run = node("d", "bash", "Run the full suite", 4, { milestone: "build", status: "error", summary: "1 failed" });
  const live = node("e", "read", "Check the last line", 5, { milestone: "build", status: "running", duration: undefined, summary: "" });
  return {
    key: "ledger",
    rows: [read, grep, build, run, live],
    nodes: new Map([
      [read.id, read],
      [grep.id, grep],
      [build.id, build],
      [child.id, child],
      [run.id, run],
      [live.id, live],
    ]),
    started: EPOCH,
    budget: 5,
    openAll: false,
    intent: "Draw the ledger",
    milestones: [
      { id: "inspect", label: "Inspect" },
      { id: "build", label: "Build" },
    ],
    activeMilestoneId: "build",
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

test("the ledger paints a title, a rule and one row per call at 100 columns", () => {
  const group = planGroup();
  const ctx = contextFor(group, 100, { expanded: new Set(["c"]) });
  const lines = ledgerLayout.paint(ctx);
  expectWithinWidth(lines, 100);
  assert.equal(visibleWidth(lines[0]!), 100);
  assert.ok(lines[0]!.startsWith("Draw the ledger"));
  assert.ok(lines[0]!.endsWith("21s"));
  assert.match(lines[1]!, /^[-─]{100}$/u, "the rule spans the card");
  // Phase rules come before the rows they own, and the nested child sits one indent in.
  const phaseLines = lines.filter(line => /^\d\d {2}[A-Z]/.test(line));
  assert.deepEqual(phaseLines.map(line => line.slice(0, 2)), ["01", "02"]);
  const rowLines = lines.filter(line => line.includes("codemode") || line.includes("Run the ledger suite"));
  assert.ok(rowLines.length >= 2);
  assert.ok(rowLines.some(line => line.startsWith("  ")), "the nested child indents under its parent");
  assert.ok(lines.some(line => line.includes("1 failed")), "the failing phase keeps its tone");
});

test("the ledger holds its width at 100, 80, 56, 40 and 23 columns", () => {
  for (const width of [100, 80, 56, 40, 23]) {
    const ctx = contextFor(planGroup(), width);
    const lines = ledgerLayout.paint(ctx);
    assert.ok(lines.length > 0, `no lines at ${width}`);
    expectWithinWidth(lines, width);
    // Under 24 columns the card is classic's, and classic opens with its meter strip.
    if (width >= 24) {
      assert.ok(lines[0]!.includes("Draw the ledger"), `title missing at ${width}: ${JSON.stringify(lines[0])}`);
      assert.ok(!lines[0]!.startsWith(" "), `title does not start the card at ${width}`);
    }
  }
});

test("the dotted leader exists at full width and is gone in the compact form", () => {
  const leader = (width: number): boolean =>
    ledgerLayout.paint(contextFor(planGroup(), width)).some(line => /\.{3,}|·{3,}/u.test(line));
  assert.equal(leader(100), true);
  assert.equal(leader(56), true);
  assert.equal(leader(40), false);
  assert.equal(leader(48), false);
});

test("the ledger registers the headline, the phases and every call row", () => {
  const group = planGroup();
  const ctx = contextFor(group, 100, { expanded: new Set(["c"]) });
  const lines = ledgerLayout.paint(ctx);
  const targets = [...ctx.targets];
  assert.equal(ctx.targets.get(0), GROUP_TARGET);
  assert.equal(ctx.targets.get(1), GROUP_TARGET);
  const phaseTargets = targets.map(([, target]) => target).filter(target => target.startsWith("@milestone:"));
  assert.deepEqual(phaseTargets, [milestoneTarget("inspect"), milestoneTarget("build")]);
  for (const id of ["a", "b", "c", "c1", "d", "e"]) {
    assert.ok(targets.some(([, target]) => target === id), `no hit target for ${id}`);
  }
  // Every registered line exists, and nothing overruns the painted card.
  for (const [index] of targets) assert.ok(index < lines.length);
  assert.equal(targets.length, lines.length);
});

test("ASCII mode draws the ledger with no unicode ink at all", () => {
  const ctx = contextFor(planGroup(), 100, { settings: { iconMode: "ascii" } });
  const lines = ledgerLayout.paint(ctx);
  expectWithinWidth(lines, 100);
  for (const line of lines) {
    assert.ok(!UNICODE_INK.test(line), `unicode ink in ASCII mode: ${JSON.stringify(line)}`);
  }
  assert.ok(lines.some(line => /-{3,}/.test(line)), "the rule falls back to hyphens");
  assert.ok(lines.some(line => /\.{3,}/.test(line)), "the leader falls back to dots");
});

test("below 24 columns the ledger is byte-identical to classic", () => {
  const group = planGroup();
  const ledger = ledgerLayout.paint(contextFor(group, 23));
  const classic = classicLayout.paint(contextFor(group, 23));
  assert.deepEqual(ledger, classic);
});

test("a windowed card names the calls it left out and paints only the tail", () => {
  const group = planGroup();
  const ctx = contextFor(group, 80, { settings: { window: 2 } });
  const lines = ledgerLayout.paint(ctx);
  expectWithinWidth(lines, 80);
  assert.ok(lines[0]!.includes("2 of 5 calls"), `headline: ${JSON.stringify(lines[0])}`);
  assert.ok(lines.some(line => line.includes("3 earlier calls")), "the hidden window is counted");
  const painted = [...ctx.targets.values()].filter(target => group.nodes.has(target));
  assert.deepEqual(painted, ["d", "e"], "only the window's tail paints");
});

test("an open row's preview sits under its goal column on the row's own target", () => {
  const ctx = contextFor(planGroup(), 100, { expanded: new Set(["a"]) });
  const lines = ledgerLayout.paint(ctx);
  expectWithinWidth(lines, 100);
  const index = lines.findIndex(line => line.includes("the seam is here"));
  assert.ok(index > 0, "the preview paints");
  assert.ok(lines[index]!.startsWith(" ".repeat(11)), "the preview aligns under the goal");
  assert.equal(ctx.targets.get(index), "a");
});

test("a real tree renders the ledger within its width, and matches classic when narrow", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "a", toolName: "read", args: { taskIntent: "Read the card seam", path: "card-layout.ts" } });
  tree.end({ toolCallId: "a", toolName: "read", result: { content: [] }, isError: false });
  const row: TreeRow = {
    toolCallId: "a",
    inner: { render: () => [], invalidate: () => {} },
    theme: plainTheme,
    expanded: false,
    invalidate: () => {},
  };
  tree.updateSettings({ card: "classic" });
  const classic = tree.render(row).render(23);
  tree.updateSettings({ card: "ledger" });
  const ledger = tree.render(row).render(23);
  assert.deepEqual(ledger, classic);
});
