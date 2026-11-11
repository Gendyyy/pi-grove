/**
 * layout-margin.test.ts — locks the wide-margin card: its spread at every width, the 16ch to
 * 6ch margin, its hit map, italic time, and the classic card it delegates to when it cannot spread.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { classicLayout } from "../layouts/classic.js";
import { marginLayout } from "../layouts/margin.js";
import { phaseCallIds } from "../card-plan.js";
import { elapsedFor } from "../card-row.js";
import { longestElapsed } from "../card-progress.js";
import { plainTheme, type GroveTheme } from "../theme.js";
import type { IconMode } from "../icons.js";
import {
  GROUP_TARGET,
  treeGlyphs,
  type TreeGroup,
  type TreeNode,
  type TreeSettings,
} from "../tree-model.js";
import type { CardContext, PaintState } from "../card-layout.js";

const EPOCH = Date.UTC(2026, 10, 10, 12, 0, 0);

/** The settings every render starts from: the margin card, a plan and its gutter on. */
function settings(overrides: Partial<TreeSettings> = {}): TreeSettings {
  return {
    mode: "turn",
    revealErrors: false,
    icons: true,
    iconMode: "auto",
    card: "margin",
    window: 5,
    groupNestedTools: true,
    groupToolNames: true,
    groupProgress: true,
    groupPercent: false,
    groupPhases: false,
    groupSparkline: false,
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

/** A three-phase card: a codemode with one nested step, an edit, and a failed bash. */
function phasedGroup(): TreeGroup {
  const nested = node("a1", "grep", "find PHASES_TARGET call sites", 1, {
    parent: "a",
    summary: "4 matches in 2 files",
  });
  const first = node("a", "codemode", "hit map and click targets", 0, {
    milestone: "inspect",
    children: [nested],
  });
  const second = node("b", "edit", "meter line owns the plan gesture", 2, {
    milestone: "build",
    summary: "+38/−6",
  });
  const third = node("c", "bash", "run the full suite", 3, {
    milestone: "verify",
    status: "error",
    summary: "npm test · 1 test failed",
  });
  return {
    key: "margin",
    rows: [first, second, third],
    nodes: new Map([first, nested, second, third].map(row => [row.id, row])),
    started: EPOCH,
    budget: 5,
    openAll: true,
    intent: "Wire the meter click to its plan",
    milestones: [
      { id: "inspect", label: "Inspect" },
      { id: "build", label: "Build" },
      { id: "verify", label: "Verify" },
    ],
    activeMilestoneId: "verify",
  };
}

/** Build the context the painter derives, so the layout can be called on its own. */
function contextFor(
  group: TreeGroup,
  width: number,
  expanded: ReadonlySet<string> = new Set(["a"]),
  iconMode: IconMode = "auto",
  theme: GroveTheme = plainTheme,
): CardContext {
  const state: PaintState = { settings: settings({ iconMode }), expanded };
  const framed = width >= 24;
  const inner = framed ? Math.max(8, width - 4) : width;
  const tools = group.rows.filter(row => row.kind !== "thinking");
  const plan = state.settings.groupGutter ? group.milestones ?? [] : [];
  const visible = group.openAll ? tools : tools.slice(-Math.max(1, state.settings.window));
  const now = Date.now();
  const phaseByCall = phaseCallIds(group);
  const phaseElapsedById = new Map<string, number>((group.milestones ?? []).map(phase => [phase.id, 0]));
  for (const row of tools) {
    const phaseId = phaseByCall.get(row.id);
    if (phaseId === undefined) continue;
    phaseElapsedById.set(phaseId, (phaseElapsedById.get(phaseId) ?? 0) + elapsedFor(row, now));
  }
  return {
    state,
    group,
    width,
    inner,
    framed,
    theme,
    glyphs: treeGlyphs(iconMode),
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

test("the margin card renders every spread width within its card", () => {
  for (const width of [100, 80, 72, 60, 40]) {
    const lines = marginLayout.paint(contextFor(phasedGroup(), width));
    assert.ok(lines.length > 0, `no lines at ${width}`);
    expectWithinWidth(lines, width);
  }
});

test("the hairline frame sets the title into its top border", () => {
  const lines = marginLayout.paint(contextFor(phasedGroup(), 100, new Set(["a"]), "nerd"));
  assert.ok(lines[0]!.includes("Wire the meter click to its plan"), lines[0]);
  assert.ok(lines[0]!.startsWith("╭") && lines[0]!.endsWith("╮"), lines[0]);
  assert.ok(lines.at(-1)!.startsWith("╰") && lines.at(-1)!.endsWith("╯"), lines.at(-1));
});

test("the phase margin is 16ch wide, and narrows to 6ch below 72", () => {
  const wide = marginLayout.paint(contextFor(phasedGroup(), 100));
  const widePhase = wide.find(line => line.includes("INSPECT"));
  assert.ok(widePhase, "no phase margin at 100");
  assert.equal(widePhase.slice(2, 18).trimEnd(), "01 INSPECT");

  const narrow = marginLayout.paint(contextFor(phasedGroup(), 60));
  const narrowPhase = narrow.find(line => line.includes("Inspect"));
  assert.ok(narrowPhase, "no phase margin at 60");
  assert.equal(narrowPhase.slice(2, 8).trim(), "01");
  assert.equal(narrowPhase.slice(8, 10), "  ");
  assert.ok(narrowPhase.slice(10).startsWith("Inspect"), narrowPhase);
});

test("a call row and its phase marker register their own hit targets", () => {
  const ctx = contextFor(phasedGroup(), 100);
  const lines = marginLayout.paint(ctx);
  assert.equal(ctx.targets.get(0), GROUP_TARGET);
  for (const id of ["a", "a1", "b", "c"]) {
    assert.ok([...ctx.targets.values()].includes(id), `no target for ${id}`);
  }
  const callLine = lines.findIndex(line => line.includes("hit map and click targets"));
  assert.equal(ctx.targets.get(callLine), "a");
  const phaseLine = lines.findIndex(line => line.includes("INSPECT"));
  assert.equal(ctx.targets.get(phaseLine), "@milestone:inspect");
});

test("a call's summary sits on its own line under the goal", () => {
  const lines = marginLayout.paint(contextFor(phasedGroup(), 100));
  const goalLine = lines.findIndex(line => line.includes("find PHASES_TARGET call sites"));
  assert.ok(goalLine >= 0, "no nested row");
  assert.ok(lines[goalLine]!.includes("grep"), lines[goalLine]);
  assert.ok(lines[goalLine + 1]!.includes("4 matches in 2 files"), lines[goalLine + 1]);
  assert.ok(!lines[goalLine]!.includes("4 matches"), "summary leaked onto the goal line");
});

test("the duration is painted italic", () => {
  const painted: Array<{ text: string; italic: boolean }> = [];
  const theme: GroveTheme = {
    style: (text, options) => {
      painted.push({ text, italic: options.italic === true });
      return text;
    },
  };
  marginLayout.paint(contextFor(phasedGroup(), 100, new Set(["a"]), "auto", theme));
  assert.ok(painted.some(call => call.italic && /\d+s/.test(call.text)), "no italic duration");
});

test("ASCII mode draws square corners", () => {
  const lines = marginLayout.paint(contextFor(phasedGroup(), 80, new Set(["a"]), "ascii"));
  assert.ok(lines[0]!.startsWith("+") && lines[0]!.endsWith("+"), lines[0]);
  assert.ok(lines.at(-1)!.startsWith("+") && lines.at(-1)!.endsWith("+"), lines.at(-1));
  expectWithinWidth(lines, 80);
});

test("a 23-column card is classic's card, byte for byte", () => {
  const ctx = contextFor(phasedGroup(), 23);
  const margin = marginLayout.paint(ctx);
  const classic = classicLayout.paint(ctx);
  assert.deepEqual(margin, classic);
  expectWithinWidth(margin, 23);
});
