// State markers on grouped rows: the dot reports the call state instead of an expand arrow.
import assert from "node:assert/strict";
import test from "node:test";
import { ToolTree, GROUP_TARGET, PHASES_TARGET, type TreeRow, type TreeSettings } from "../tool-tree.js";
import { colorToRgb, rgbColor } from "@earendil-works/pi-tui";
import { plainTheme, type GroveTheme } from "../theme.js";
import { PULSE_MS } from "../tree-paint.js";

const theme: GroveTheme = { ...plainTheme, style: (text, options) => "[" + (options.fg ?? "-") + "]" + text };
const settings: TreeSettings = {
  mode: "prompt",
  revealErrors: false,
  icons: false,
  iconMode: "ascii",
  window: 4,
  groupNestedTools: true,
  groupProgress: true,
  groupSparkline: true,
  groupGutter: true,
};
const inner = () => ({ render: () => ["inner"], invalidate: () => {} });
const row = (id: string, rowTheme: GroveTheme = theme): TreeRow => ({ toolCallId: id, inner: inner(), theme: rowTheme, expanded: false, invalidate: () => {} });
const click = (y: number) => ({ type: "click", button: "left", x: 0, y, screenX: 0, screenY: 0, width: 96, height: 40 });
const plain = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");
const card = (tree: ToolTree, id = "a", rowTheme: GroveTheme = theme) => tree.render(row(id, rowTheme)) as unknown as {
  handleMouse?: (event: unknown) => unknown;
  render(width: number): string[];
};

/** Paint the group with every row revealed. */
function painted(tree: ToolTree, width = 96, rowTheme: GroveTheme = theme): string[] {
  // The frame border carries the row gesture; line 1 belongs to the meter, which opens the plan.
  card(tree, "a", rowTheme).handleMouse?.(click(0));
  // This theme tags text instead of emitting escapes, so the frame is sliced, not parsed.
  return card(tree, "a", rowTheme).render(width).map(plain).slice(1, -1);
}

/** Theme with a concrete palette that tags every colour as an rgb triple. */
function paletteTheme(): GroveTheme {
  return {
    colors: {
      accent: rgbColor(160, 120, 255),
      muted: rgbColor(80, 80, 80),
      success: rgbColor(0, 200, 0),
      error: rgbColor(255, 0, 0),
      warning: rgbColor(230, 180, 60),
    },
    style: (text, options) => {
      if (typeof options.fg === "object" && options.fg !== null) {
        const { r, g, b } = colorToRgb(options.fg);
        return "rgb(" + [r, g, b].map(channel => Math.round(channel)).join(",") + ")" + text;
      }
      return "[" + (options.fg ?? "-") + "]" + text;
    },
  };
}

const PLAN = "inspect=Inspect; build=Build; verify=Verify";
/** This theme counts every tag as visible text, so colour assertions need a very wide card. */
const WIDE = 400;

/** Colour of the live fill edge: the last filled cell of the meter. */
function needleColor(lines: readonly string[]): string | undefined {
  const meter = lines.find(line => line.includes("▰")) ?? "";
  const matches = [...meter.matchAll(/rgb\(\d+,\d+,\d+\)▰/g)];
  return matches[matches.length - 1]?.[0];
}

/** Declare a phase on a fresh call, the way an agent walks a plan. */
function step(tree: ToolTree, id: string, taskMilestone: string, taskProgress: number, plan = PLAN): void {
  tree.start({
    toolCallId: id,
    toolName: "bash",
    args: { taskIntent: "Implement retry safety", taskProgress, taskMilestones: plan, taskMilestone },
  });
}

/** Close a call so its estimate settles. */
function settle(tree: ToolTree, id: string): void {
  tree.end({ toolCallId: id, toolName: "bash", result: { content: [] }, isError: false, durationMs: 4 });
}
/** Build a settled codemode call with the requested nested outcomes. */
function codemodeWithOutcomes(failures: boolean[]): ToolTree {
  const tree = new ToolTree(settings);
  tree.start({ toolCallId: "a", toolName: "codemode", args: { code: "// reasoning: run nested tools" } });
  failures.forEach((failed, index) => {
    const id = "a" + (index + 1);
    tree.start({ toolCallId: id, toolName: "bash", parentToolCallId: "a", args: { reasoning: "nested step " + index } });
    tree.end({ toolCallId: id, toolName: "bash", result: { content: [] }, isError: failed, durationMs: 100 });
  });
  tree.end({ toolCallId: "a", toolName: "codemode", result: { content: [] }, isError: false, durationMs: 200 });
  return tree;
}

test("the meter names the phase in flight and keeps the rest of the plan unspoken", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "build", 55);

  const wide = painted(tree, WIDE).find(line => line.includes("Build"));
  assert.ok(wide, "the phase in flight is the one that gets named");
  // Only the phase in flight spends width on a name; the phases ahead stay a shape.
  assert.match(wide, /\[accent\]\*\[accent\] Build 2\/3/);
  assert.doesNotMatch(wide, /Inspect|Verify/);

  const narrow = painted(tree, 35, plainTheme).find(line => line.includes("2/3"));
  assert.ok(narrow, "the position survives a card too narrow for the name");
  assert.doesNotMatch(narrow, /Build/);
  assert.match(narrow, /55% > \* 2\/3/);
  assert.ok(narrow.length <= 35, `compact meter exceeds its viewport: ${narrow}`);
});

test("a narrow card drops the label but keeps the plan position", () => {
  const tree = new ToolTree(settings);
  tree.start({
    toolCallId: "a",
    toolName: "bash",
    args: {
      taskIntent: "Implement retry safety",
      taskProgress: 55,
      taskMilestones: "inspect=Inspect; build=Checkpoint; verify=Verify",
      taskMilestone: "build",
    },
  });

  const compact = card(tree, "a", plainTheme).render(40).map(plain).find(line => line.includes("2/3"));
  assert.ok(compact, "the position is the last thing the meter gives up");
  assert.doesNotMatch(compact, /Checkpoint/);
  assert.match(compact, /55% > \* 2\/3/);
  assert.ok(compact.length <= 40, `compact meter exceeds its viewport: ${compact}`);
});

test("a crossed boundary pins at the estimate the finished phase reached", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "inspect", 40);
  settle(tree, "a");
  step(tree, "b", "build", 70);

  // The meter owns the plan gesture, so every phase sits one click away.
  card(tree).handleMouse?.(click(1));
  const planLine = painted(tree, WIDE).find(line => line.includes("Inspect"));
  assert.ok(planLine, "clicking the meter opens the plan");
  // Inspect closed at 40%, so 40 is the only position it is allowed to claim.
  assert.match(planLine, /Inspect\[muted\] 40%/);
  assert.match(planLine, /\[accent\]\* Build/);
});

test("a crossed boundary divides the filled ramp while the phase in flight keeps the accent", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "inspect", 40);
  settle(tree, "a");
  step(tree, "b", "build", 70);

  const meter = painted(tree, WIDE).find(line => line.includes("%")) ?? "";
  assert.match(meter, /70%/, meter);
  assert.match(meter, /\[accent\]\*\[accent\] Build 2\/3/, meter);
  // The boundary inspect ended on keeps a column of its own inside the filled run.
  const glyphsOnly = painted(tree, WIDE, plainTheme).find(line => line.includes("%")) ?? "";
  assert.match(glyphsOnly, /▰+:▰+/, glyphsOnly);

  card(tree).handleMouse?.(click(1));
  const planLine = painted(tree, WIDE).find(line => line.includes("Inspect")) ?? "";
  assert.match(planLine, /\[success\]x Inspect/, planLine);
  assert.match(planLine, /\[accent\]\* Build/, planLine);
  assert.match(planLine, /\[dim\]o Verify/, planLine);
  // The arrow behind a finished phase is green, so a completed plan reads as one line.
  assert.match(planLine, /Inspect\[muted\] 40% \[success\]-> \[accent\]\* Build/, planLine);
  assert.match(planLine, /Build \[dim\]-> \[dim\]o Verify/, planLine);
});

test("the bar forecasts no boundary before a phase has actually ended", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "build", 55);

  const meter = painted(tree, WIDE, plainTheme).find(line => line.includes("%")) ?? "";
  // Nobody can say where the phases ahead will close, so the bar draws no guess in between.
  assert.doesNotMatch(meter, /[▰▱]:/, meter);
});

test("the filled span keeps the estimate's red-to-green ramp", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "build", 55);
  settle(tree, "a");

  const meter = painted(tree, WIDE, paletteTheme()).find(line => line.includes("%")) ?? "";
  const ramp = [...meter.matchAll(/rgb\((\d+),(\d+),(\d+)\)▰/g)].map(found => ({
    r: Number(found[1]),
    g: Number(found[2]),
  }));
  assert.ok(ramp.length >= 8, meter);
  const first = ramp[0]!;
  const last = ramp[ramp.length - 1]!;
  assert.ok(first.r > last.r && first.g < last.g, `expected red to green, got ${meter}`);
});

test("the meter needle breathes while a call is running", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "build", 55);

  const realNow = Date.now;
  // Sample the live fill edge, since the pulse follows the paint clock.
  const sample = (clock: number): string | undefined => {
    try {
      Date.now = () => clock;
      return needleColor(painted(tree, WIDE, paletteTheme()));
    } finally {
      Date.now = realNow;
    }
  };

  const bright = sample(0);
  const mid = sample(PULSE_MS / 2);
  const nextCycle = sample(PULSE_MS);
  assert.ok(bright && mid && nextCycle, "the last filled cell carries the pulse");
  assert.equal(bright, nextCycle, "one cycle later the needle returns to where it started");
  assert.notEqual(bright, mid, "half a cycle lands on a different colour, not the same glyph");
  assert.notEqual(mid, "rgb(80,80,80)▰", "the pulse quiets toward muted without switching the cell off");
});
test("codemode marks partial nested failures orange without revealing them", () => {
  const rows = painted(codemodeWithOutcomes([true, false]));
  const codemode = rows.find(line => line.includes("codemode"));
  assert.ok(codemode);
  assert.match(codemode, /\[warning\]\*/);
  assert.doesNotMatch(rows.join("\n"), /nested step/);
});

test("codemode marks all nested failures red without revealing them", () => {
  const rows = painted(codemodeWithOutcomes([true, true]));
  const codemode = rows.find(line => line.includes("codemode"));
  assert.ok(codemode);
  assert.match(codemode, /\[error\]\*/);
  assert.doesNotMatch(rows.join("\n"), /nested step/);
});

test("a settled call shows a filled dot in its status colour", () => {
  const tree = new ToolTree(settings);
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the typecheck" } });
  tree.end({ toolCallId: "a", toolName: "bash", result: { content: [] }, durationMs: 900 } as never, undefined);
  tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "run the tests" } });
  tree.end({ toolCallId: "b", toolName: "bash", result: { content: [] }, isError: true, durationMs: 800 } as never, undefined);
  const [head, ok, failed] = painted(tree) as [string, string, string];
  const headerMarker = head!.match(/\[dim\]v/)?.[0];
  assert.ok(headerMarker);
  assert.doesNotMatch(headerMarker, /warning/);
  assert.match(ok!, /\[success\]\*/);
  assert.match(failed!, /\[error\]\*/);
  assert.doesNotMatch(ok!, /error/);
});

test("a running call breathes its marker instead of cycling frames", () => {
  const real = Date.now;
  try {
    const tree = new ToolTree(settings);
    tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "read the schema" } });
    tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "run the tests" } });
    const base = 1_000_000;
    // Sample the live row marker, the only cell painted as a breathing dot.
    const marker = (offset: number): string => {
      Date.now = () => base + offset;
      // The detail text is the narrowest thing on the row, so locate it by the tool label.
      const row = painted(tree, 96, paletteTheme()).find(line => line.includes("rgb(") && line.includes("bash"));
      assert.ok(row, "expected the live row in the painted card");
      const found = /rgb\(\d+,\d+,\d+\)\*/.exec(row);
      assert.ok(found, "expected a breathing marker in " + JSON.stringify(row));
      return found[0];
    };
    const glyphOf = (paintedMarker: string): string => paintedMarker.replace(/^rgb\([^)]*\)/, "");

    const bright = marker(0);
    const mid = marker(PULSE_MS / 2);
    // The glyph is steady, so the row cannot flicker between frames the way a spinner did.
    assert.equal(glyphOf(bright), "*");
    assert.equal(glyphOf(mid), "*");
    assert.notEqual(bright, mid, "half a cycle lands on a different brightness");
    assert.equal(marker(PULSE_MS), bright, "one cycle later the breathing returns to where it started");
    assert.notEqual(mid, "rgb(80,80,80)*", "the pulse quiets toward muted without switching the marker off");
  } finally {
    Date.now = real;
  }
});

test("a finished card keeps a quiet marker", () => {
  const tree = new ToolTree(settings);
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "step one" } });
  tree.end({ toolCallId: "a", toolName: "bash", result: { content: [] }, durationMs: 500 } as never, undefined);
  tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "step two" } });
  tree.end({ toolCallId: "b", toolName: "bash", result: { content: [] }, durationMs: 500 } as never, undefined);
  const head = painted(tree)[0]!;
  const marker = head.split(" · ")[0]!;
  assert.match(marker, /\[dim\]/);
  assert.doesNotMatch(marker, /warning/);
});

test("a two-phase plan still paints a labeled stepper", () => {
  const tree = new ToolTree(settings);
  tree.start({
    toolCallId: "a",
    toolName: "bash",
    args: { taskIntent: "Tidy the retry helper", taskProgress: 40, taskMilestones: "work=Tidy helper; verify=Verify", taskMilestone: "work" },
  });

  const line = painted(tree, WIDE).find(candidate => candidate.includes("Tidy helper"));
  assert.ok(line, "a two-phase plan still names the phase in flight");
  assert.match(line, /\[accent\]\*\[accent\] Tidy helper 1\/2/);
});

test("seven phases keep the active phase readable on a narrow card", () => {
  const tree = new ToolTree(settings);
  tree.start({
    toolCallId: "a",
    toolName: "bash",
    args: {
      taskIntent: "Ship the retry guard",
      taskProgress: 50,
      taskMilestones: "plan=Plan; read=Read; patch=Patch; test=Test; docs=Docs; review=Review; verify=Verify",
      taskMilestone: "test",
    },
  });

  const wide = painted(tree, WIDE).find(candidate => candidate.includes("Test"));
  assert.ok(wide, "seven phases have room for a name on a wide card");
  assert.match(wide, /50%/);
  assert.match(wide, /\[accent\]\*\[accent\] Test 4\/7/);
  assert.doesNotMatch(wide, /Plan|Verify/);

  const narrow = painted(tree, 34, plainTheme).find(candidate => candidate.includes("4/7"));
  assert.ok(narrow, "the position survives the narrow card");
  assert.doesNotMatch(narrow, /Test/);
  assert.match(narrow, /50% > \* 4\/7/);
  assert.ok(narrow.length <= 34, `narrow meter exceeds its viewport: ${narrow}`);
});

test("the meter line is its own click target for the plan", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "build", 55);
  const targetAt = (line: number) => (tree as unknown as { targetAt(index: number): string | undefined }).targetAt(line);

  // The frame border still means "reveal the rows", so line 1 has to mean something else.
  card(tree).render(WIDE);
  assert.equal(targetAt(0), GROUP_TARGET);
  assert.equal(targetAt(1), PHASES_TARGET);

  assert.equal(card(tree).render(WIDE).map(plain).some(line => line.includes("Inspect")), false, "the plan stays closed until asked for");
  card(tree).handleMouse?.(click(1));
  const opened = card(tree).render(WIDE).map(plain);
  assert.ok(opened.some(line => line.includes("Inspect") && line.includes("Verify")), "clicking the meter opens the plan");
  card(tree).handleMouse?.(click(1));
  assert.equal(card(tree).render(WIDE).map(plain).some(line => line.includes("Inspect")), false, "a second click closes it");
});
/** Two finished calls in one phase, then a live call that opened the next one. */
function twoPhases(gutterSettings: TreeSettings = settings): ToolTree {
  const tree = new ToolTree(gutterSettings);
  step(tree, "a", "inspect", 20);
  settle(tree, "a");
  step(tree, "b", "inspect", 35);
  settle(tree, "b");
  step(tree, "c", "build", 55);
  return tree;
}

test("a phase change draws one divider where the plan actually moved", () => {
  const tree = twoPhases();
  const lines = painted(tree, 60, plainTheme);
  // The divider is a pipe, the meter's own boundary tick, the milestone diamond, a name, a rule.
  const divider = (line: string) => line.includes(" : * Build ") && line.includes("--");
  const at = lines.findIndex(divider);
  assert.ok(at > 0, "the boundary between two phases gets a divider: " + lines.join(" / "));
  // One boundary, one divider, and it stands directly above the row that opened the phase.
  assert.equal(lines.filter(divider).length, 1);
  assert.match(lines[at + 1] ?? "", /bash/);
  // Nothing divides the card above its first call, and the phase that call opened needs no divider.
  assert.ok(at > lines.findIndex(line => line.includes("bash")), "the first call carries no divider above it");
  // The divider is furniture, not a call: the rollup still counts three.
  assert.match(lines.find(line => line.includes("calls")) ?? "", /3 calls/);
});

test("the gutter is opt-out and its divider opens the plan", () => {
  const off = twoPhases({ ...settings, groupGutter: false });
  assert.equal(painted(off, 60, plainTheme).filter(line => line.includes(" : * Build ")).length, 0, "opted out, the rows stay undivided");

  const tree = twoPhases();
  const targetAt = (line: number) => (tree as unknown as { targetAt(index: number): string | undefined }).targetAt(line);
  card(tree).handleMouse?.(click(0));
  // Under the tagging theme only the divider joins the diamond tag straight to the name.
  const y = card(tree).render(60).map(plain).findIndex(line => line.includes("[accent]Build") || line.includes("[success]Build"));
  assert.ok(y > 0, "the divider is on screen");
  assert.equal(targetAt(y), PHASES_TARGET, "the divider belongs to the plan, like the meter");
  card(tree).handleMouse?.(click(y));
  assert.ok(card(tree).render(WIDE).map(plain).some(line => line.includes("Inspect") && line.includes("Verify")), "clicking the divider opens the plan");
});

test("a divider re-colours behind the plan as later phases open", () => {
  const tree = twoPhases();
  const divider = () => painted(tree, WIDE).find(line => /\[(accent|success|dim)\]Build/.test(line)) ?? "";
  assert.match(divider(), /\[accent\]\* \[accent\]Build/, "the phase in flight carries the accent, diamond included");

  step(tree, "d", "verify", 80);
  settle(tree, "c");
  assert.match(divider(), /\[success\]\* \[success\]Build/, "a divider behind the plan reads as history, like the pinned span");
});
