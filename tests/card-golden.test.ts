// Locks the classic card's exact lines, so layout work can never move the default by a space.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plainTheme } from "../theme.js";
import { ToolTree, type TreeSettings } from "../tool-tree.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
/** Set UPDATE_GOLDEN=1 to rewrite the fixtures from the current renderer. */
const UPDATE = process.env.UPDATE_GOLDEN === "1";
/** A fixed epoch keeps durations, sparkline and spinner frames out of the diff. */
const EPOCH = Date.UTC(2026, 10, 10, 12, 0, 0);
const WIDTHS = [100, 80, 60];

/** Shipped defaults, so the fixtures describe the card most users actually see. */
const defaults: TreeSettings = {
  mode: "prompt",
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
};

type Tick = (ms: number) => void;
/** Builds one card and returns its rendered lines at the given width. */
type Fixture = { settings: TreeSettings; widths?: number[]; render: (width: number, tick: Tick) => string[] };

/** Renders a tree's leader card at a width, using the plain theme so the fixture stays readable. */
function paint(tree: ToolTree, leader: string, width: number): string[] {
  const card = tree.render({
    toolCallId: leader,
    inner: { render: () => [], invalidate: () => {} },
    theme: plainTheme,
    expanded: false,
    invalidate: () => {},
  });
  return card.render(width);
}

/** Three settled calls and no plan: the plain collapsed card. */
const flat: Fixture = {
  settings: defaults,
  render: (width, tick) => {
    const tree = new ToolTree(defaults);
    tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "Read the paint entry", path: "tree-paint.ts" } });
    tick(900);
    tree.end({ toolCallId: "a", toolName: "read", result: { content: [{ type: "text", text: "1023 lines" }] }, isError: false });
    tick(80);
    tree.start({ toolCallId: "b", toolName: "grep", args: { reasoning: "Find every paint caller", pattern: "paintGroup" } });
    tick(600);
    tree.end({ toolCallId: "b", toolName: "grep", result: { content: [] }, isError: false });
    tick(80);
    tree.start({ toolCallId: "c", toolName: "bash", args: { reasoning: "Run the type check", command: "npm run check" } });
    tick(2400);
    tree.end({ toolCallId: "c", toolName: "bash", result: { content: [] }, isError: false });
    return paint(tree, "a", width);
  },
};

/** Two calls under one milestone: the story card with a single phase. */
const plan: Fixture = {
  settings: defaults,
  render: (width, tick) => {
    const tree = new ToolTree(defaults);
    const intent = { taskIntent: "Wire the meter click", taskMilestones: "inspect=Inspect; verify=Verify" };
    tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "Read the hit map", path: "tree-block.ts", taskProgress: 20, taskMilestone: "inspect", ...intent } });
    tick(700);
    tree.end({ toolCallId: "a", toolName: "read", result: { content: [] }, isError: false });
    tick(60);
    tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "Run the suite", command: "npm test", taskProgress: 80, taskMilestone: "verify", ...intent } });
    tick(1300);
    tree.end({ toolCallId: "b", toolName: "bash", result: { content: [] }, isError: false });
    return paint(tree, "a", width);
  },
};

/** Three phases, a failure and the phase plan boxes: the widest branch of the renderer. */
const phases: Fixture = {
  settings: { ...defaults, groupPercent: true, groupPhases: true },
  render: (width, tick) => {
    const tree = new ToolTree({ ...defaults, groupPercent: true, groupPhases: true });
    const intent = { taskIntent: "Wire the meter click", taskMilestones: "inspect=Inspect; build=Build; verify=Verify" };
    const call = (id: string, toolName: string, reasoning: string, milestone: string, progress: number, ms: number, isError = false) => {
      tree.start({ toolCallId: id, toolName, args: { reasoning, taskProgress: progress, taskMilestone: milestone, ...intent } });
      tick(ms);
      tree.end({ toolCallId: id, toolName, result: { content: [] }, isError });
      tick(60);
    };
    call("a", "read", "Read the hit map", "inspect", 8, 900);
    call("b", "grep", "Find the call sites", "inspect", 16, 600);
    call("c", "edit", "Meter line owns the plan", "build", 34, 1100);
    call("d", "edit", "Keep the click one gesture", "build", 48, 400);
    call("e", "bash", "Run the suite", "verify", 70, 4800, true);
    call("f", "bash", "Confirm the package", "verify", 92, 1300);
    return paint(tree, "a", width);
  },
};

/** A codemode parent with nested children: nested breakdown, previews and a live tail. */
const nested: Fixture = {
  settings: defaults,
  render: (width, tick) => {
    const tree = new ToolTree(defaults);
    tree.start({ toolCallId: "a", toolName: "codemode", args: { reasoning: "Wire the phase ticks in one paint", taskIntent: "Wire the meter click", taskMilestones: "build=Build", taskMilestone: "build", taskProgress: 40 } });
    tree.start({ toolCallId: "a1", parentToolCallId: "a", toolName: "read", args: { reasoning: "Read the row emitter", path: "tree-paint.ts" } });
    tick(400);
    tree.end({ toolCallId: "a1", toolName: "read", result: { content: [{ type: "text", text: "840 lines" }] }, isError: false });
    tree.start({ toolCallId: "a2", parentToolCallId: "a", toolName: "edit", args: { reasoning: "Paint the ticks once", path: "tree-paint.ts" } });
    tick(900);
    tree.end({ toolCallId: "a2", toolName: "edit", result: { content: [] }, isError: true });
    tick(200);
    tree.end({ toolCallId: "a", toolName: "codemode", result: { content: [] }, isError: false });
    tick(60);
    tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "Confirm the package under the new fold", command: "npm run test:pack", taskIntent: "Wire the meter click", taskMilestones: "build=Build", taskMilestone: "build", taskProgress: 60 } });
    tick(300);
    return paint(tree, "a", width);
  },
};

/** The same shape with the nerd glyph set, so the frame and connectors stay locked too. */
const nerd: Fixture = {
  settings: { ...defaults, icons: false, iconMode: "nerd" },
  widths: [100, 60],
  render: (width, tick) => {
    const tree = new ToolTree({ ...defaults, icons: false, iconMode: "nerd" });
    tree.start({ toolCallId: "a", toolName: "write", args: { reasoning: "Write the layout registry", path: "card-layout.ts" } });
    tick(1400);
    tree.end({ toolCallId: "a", toolName: "write", result: { content: [] }, isError: false });
    tick(60);
    tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "Run the layout suite", command: "npm test" } });
    tick(2100);
    tree.end({ toolCallId: "b", toolName: "bash", result: { content: [] }, isError: false });
    return paint(tree, "a", width);
  },
};

const FIXTURES_BY_NAME: Record<string, Fixture> = { flat, plan, phases, nested, nerd };

test("classic card matches its golden fixtures", () => {
  const real = Date.now;
  try {
    for (const [name, fixture] of Object.entries(FIXTURES_BY_NAME)) {
      for (const width of fixture.widths ?? WIDTHS) {
        let clock = EPOCH;
        Date.now = () => clock;
        const tick: Tick = ms => {
          clock += ms;
        };
        const lines = fixture.render(width, tick);
        Date.now = real;
        const file = join(FIXTURES, `classic-${name}-${width}.txt`);
        const body = lines.join("\n") + "\n";
        if (UPDATE) {
          mkdirSync(FIXTURES, { recursive: true });
          writeFileSync(file, body);
          continue;
        }
        const expected = readFileSync(file, "utf8");
        assert.equal(body, expected, `${name} at ${width} columns changed; re-run with UPDATE_GOLDEN=1 only if the change is intended`);
      }
    }
  } finally {
    Date.now = real;
  }
});
