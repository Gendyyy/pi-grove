// State markers on grouped rows: the dot reports the call state instead of an expand arrow.
import assert from "node:assert/strict";
import test from "node:test";
import { ToolTree, GROUP_TARGET, PHASES_TARGET, milestoneTarget, type TreeRow, type TreeSettings } from "../tool-tree.js";
import { colorToRgb, rgbColor, visibleWidth } from "@earendil-works/pi-tui";
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
/** Identify a connector row between the card's left and right frame borders. */
function isConnectorLine(line: string): boolean {
  return /^[│|] [│|]\s+[│|]$/.test(line.trim());
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
  const rows = painted(codemodeWithOutcomes([true, false]), WIDE);
  const codemode = rows.find(line => /\[\w+\]\* \[\w+\]codemode/.test(line));
  assert.ok(codemode, "the call row carries the nested outcome");
  assert.match(codemode, /\[warning\]\*/);
  assert.doesNotMatch(rows.join("\n"), /nested step/);
});

test("codemode marks all nested failures red without revealing them", () => {
  const rows = painted(codemodeWithOutcomes([true, true]), WIDE);
  const codemode = rows.find(line => /\[\w+\]\* \[\w+\]codemode/.test(line));
  assert.ok(codemode, "the call row carries the nested outcome");
  assert.match(codemode, /\[error\]\*/);
  assert.doesNotMatch(rows.join("\n"), /nested step/);
});

test("a codemode row with no nested call says so instead of looking expandable", () => {
  const tree = new ToolTree(settings);
  tree.start({ toolCallId: "a", toolName: "codemode", args: { reasoning: "list the tools" } });
  tree.end({ toolCallId: "a", toolName: "codemode", result: { content: [] }, isError: false, durationMs: 200 });
  const row = painted(tree, WIDE).find(line => line.includes("list the tools"));
  assert.ok(row, "the card paints the codemode row");
  assert.match(row, /no calls/, "the row names its empty step list");

  const quiet = new ToolTree({ ...settings, groupNestedTools: false });
  quiet.start({ toolCallId: "a", toolName: "codemode", args: { reasoning: "list the tools" } });
  quiet.end({ toolCallId: "a", toolName: "codemode", result: { content: [] }, isError: false, durationMs: 200 });
  const quietRow = painted(quiet, WIDE).find(line => line.includes("list the tools")) ?? "";
  assert.doesNotMatch(quietRow, /no calls/, "hiding nested detail hides the empty-list note too");
});

test("a settled call shows a filled dot in its status colour", () => {
  const tree = new ToolTree(settings);
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the typecheck" } });
  tree.end({ toolCallId: "a", toolName: "bash", result: { content: [] }, durationMs: 900 } as never, undefined);
  tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "run the tests" } });
  tree.end({ toolCallId: "b", toolName: "bash", result: { content: [] }, isError: true, durationMs: 800 } as never, undefined);
  const rows = painted(tree);
  const head = rows.find(line => line.includes("[dim]v"));
  const ok = rows.find(line => line.includes("[success]*"));
  const failed = rows.find(line => line.includes("[error]*"));
  assert.ok(head);
  assert.ok(ok);
  assert.ok(failed);
  const headerMarker = head.match(/\[dim\]v/)?.[0];
  assert.ok(headerMarker);
  assert.doesNotMatch(headerMarker, /warning/);
  assert.match(ok, /\[success\]\*/);
  assert.match(failed, /\[error\]\*/);
  assert.doesNotMatch(ok, /error/);
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
      const row = painted(tree, 400, paletteTheme()).find(line => line.includes("rgb(") && line.includes("bash"));
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

test("the meter toggles the expanded plan independently of visible timeline phases", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "build", 55);
  const targetAt = (line: number) => (tree as unknown as { targetAt(index: number): string | undefined }).targetAt(line);
  const hasExpandedPlan = () => card(tree).render(WIDE).map(plain).some(line =>
    line.includes("Inspect") && line.includes("Verify") && (line.includes("->") || line.includes("→")),
  );

  card(tree).render(WIDE);
  assert.equal(targetAt(0), GROUP_TARGET);
  assert.equal(targetAt(1), PHASES_TARGET);
  assert.equal(hasExpandedPlan(), false, "phase markers do not open the meter's full plan");
  assert.ok(card(tree).render(WIDE).map(plain).some(line => line.includes("Inspect") && line.includes("*")), "the timeline still names its first phase");

  card(tree).handleMouse?.(click(1));
  assert.equal(hasExpandedPlan(), true, "clicking the meter expands the full plan");
  card(tree).handleMouse?.(click(1));
  assert.equal(hasExpandedPlan(), false, "a second click closes only the expanded plan");
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

test("phase diamonds share a spine while calls remain in branch lists", () => {
  const tree = twoPhases({ ...settings, iconMode: "nerd" });
  const lines = painted(tree, WIDE, plainTheme);
  const markers = lines.filter(line => /(?:◆|◇) (?:Inspect|Build|Verify)|● bash/.test(line));
  assert.deepEqual(markers.map(line => line.match(/(?:◆|◇|●) (?:Inspect|Build|Verify|bash)/)?.[0]), [
    "◆ Inspect", "● bash", "● bash", "◆ Build", "● bash", "◆ Verify",
  ]);
  const connectors = lines.filter(isConnectorLine);
  assert.equal(connectors.length, 2, "only adjacent phase diamonds share standalone spine links");

  const rendered = card(tree, "a", plainTheme).render(WIDE).map(plain);
  const buildY = rendered.findIndex(line => line.includes("◆ Build"));
  const targetAt = (line: number) => (tree as unknown as { targetAt(index: number): string | undefined }).targetAt(line);
  assert.equal(targetAt(buildY), milestoneTarget("build"), "each phase marker owns a phase-scoped expansion target");
});

test("a phase click reveals its direct codemode rows without opening nested steps", () => {
  const tree = new ToolTree({ ...settings, window: 2, iconMode: "nerd" });
  /** Start one top-level codemode call assigned to a declared phase. */
  const startCodemode = (id: string, milestone: string, progress: number): void => {
    tree.start({
      toolCallId: id,
      toolName: "codemode",
      args: {
        taskIntent: "Inspect and build safely",
        taskProgress: progress,
        taskMilestones: PLAN,
        taskMilestone: milestone,
      },
    });
  };
  /** Attach one nested call so the test can distinguish disclosure from recursive expansion. */
  const addNestedCall = (id: string, parent: string, toolName: string): void => {
    tree.start({ toolCallId: id, toolName, parentToolCallId: parent, args: { reasoning: "phase call" } });
    tree.end({ toolCallId: id, toolName, result: { content: [] }, isError: false });
  };
  /** Finish a codemode row after recording its nested call. */
  const addCodemode = (id: string, milestone: string, progress: number, child: string): void => {
    startCodemode(id, milestone, progress);
    addNestedCall(id + "-child", id, child);
    tree.end({ toolCallId: id, toolName: "codemode", result: { content: [] }, isError: false });
  };

  addCodemode("inspect-read", "inspect", 10, "read");
  addCodemode("inspect-grep", "inspect", 20, "grep");
  addCodemode("inspect-write", "inspect", 30, "write");
  addCodemode("build-test", "build", 55, "test");
  addCodemode("build-lint", "build", 65, "lint");
  addCodemode("build-types", "build", 75, "typecheck");

  const component = () => card(tree, "inspect-read", plainTheme);
  const rendered = () => component().render(WIDE).map(plain);
  const codemodeRows = () => rendered().filter(line => line.includes("● codemode ·"));
  const hasExpandedChild = (name: string): boolean =>
    rendered().some(line => line.includes("●") && line.includes(name + " · phase call"));
  const planIsOpen = () => rendered().some(line =>
    line.includes("Inspect") && line.includes("Verify") && (line.includes("->") || line.includes("→")),
  );
  assert.equal(codemodeRows().length, 2, "the rolling window initially shows only the newest calls");

  const inspectY = rendered().findIndex(line => line.includes("◆ Inspect"));
  assert.ok(inspectY >= 0);
  assert.equal((tree as unknown as { targetAt(index: number): string | undefined }).targetAt(inspectY), milestoneTarget("inspect"));
  component().handleMouse?.({ ...click(inspectY), width: WIDE });
  let calls = codemodeRows();
  assert.equal(calls.length, 5, "the selected phase's three direct rows appear alongside the rolling window");
  assert.ok(calls.some(line => line.includes("read ×1")));
  assert.ok(calls.some(line => line.includes("grep ×1")));
  assert.equal(hasExpandedChild("read") || hasExpandedChild("grep"), false, "showing codemodes does not open their nested tools");
  assert.equal(planIsOpen(), false, "phase expansion does not also open the full plan");

  const readY = rendered().findIndex(line => line.includes("● codemode · read ×1"));
  assert.ok(readY >= 0, "the revealed codemode row remains individually clickable");
  component().handleMouse?.({ ...click(readY), width: WIDE });
  assert.equal(hasExpandedChild("read"), true, "clicking the codemode row expands its nested call");
  assert.equal(hasExpandedChild("grep"), false, "other codemode rows remain collapsed");

  component().handleMouse?.({ ...click(inspectY), width: WIDE });
  assert.equal(codemodeRows().length, 2, "a second click restores the rolling window");

  const buildY = rendered().findIndex(line => line.includes("◆ Build"));
  component().handleMouse?.({ ...click(buildY), width: WIDE });
  calls = codemodeRows();
  assert.equal(calls.length, 3, "another phase reveals only its own hidden direct call");
  assert.ok(calls.every(line => line.includes("test ×1") || line.includes("lint ×1") || line.includes("typecheck ×1")));
  assert.equal(hasExpandedChild("test") || hasExpandedChild("lint") || hasExpandedChild("typecheck"), false);
});

test("a stale phase declaration stays with the latest completed phase in the timeline", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "inspect", 10);
  step(tree, "b", "build", 55);
  step(tree, "c", "inspect", 45);

  const lines = painted(tree, WIDE, plainTheme);
  const inspectAt = lines.findIndex(line => line.includes("Inspect") && /1 .*call/.test(line));
  const buildAt = lines.findIndex(line => line.includes("Build") && /2 .*calls/.test(line));
  const calls = lines.flatMap((line, index) =>
    line.includes("bash") && !/\bcalls?\b/.test(line) ? [index] : [],
  );
  assert.ok(inspectAt >= 0 && buildAt > inspectAt, "phase summaries stay in declared order");
  assert.equal(calls.length, 3, "all three calls remain visible");
  assert.ok(inspectAt < calls[0]! && buildAt < calls[1]!, "the stale declaration is rendered under the latest phase");
  assert.ok(calls[1]! < calls[2]!, "the calls retain their transcript order");
});

test("phase gutter hides phase markers and leaves calls as branches", () => {
  const tree = twoPhases({ ...settings, groupGutter: false, iconMode: "nerd" });
  const lines = painted(tree, 60, plainTheme);
  assert.equal(lines.some(line => /◆ (?:Inspect|Build|Verify)/.test(line)), false, "the existing phase-gutter option still hides phase markers");
  assert.equal(lines.filter(isConnectorLine).length, 0, "hidden phases do not leave a detached spine");
  assert.equal(lines.filter(line => /^ │ [├└] ●/.test(line)).length, 3, "calls remain a branch list");
});

test("a completed phase marker turns green when the plan moves on", () => {
  const tree = twoPhases();
  const phaseMarker = () => painted(tree, WIDE).find(line => /\[accent\]\* Build|\[success\]\* Build/.test(line)) ?? "";
  assert.match(phaseMarker(), /\[accent\]\* Build/, "the active phase marker carries the accent");

  step(tree, "d", "verify", 80);
  settle(tree, "c");
  assert.match(phaseMarker(), /\[success\]\* Build/, "the completed phase marker reads as history");
});

test("a completed phase turns its phase-spine link green", () => {
  const tree = twoPhases();
  const buildLink = () => {
    const lines = card(tree).render(WIDE).map(plain);
    // The link immediately before Verify joins the preceding Build phase to the next diamond.
    const verify = lines.findIndex(line => /\* Verify/.test(line));
    return lines[verify - 1] ?? "";
  };
  assert.match(buildLink(), /\[accent\]\|/, "the active phase keeps its outgoing link active");

  step(tree, "d", "verify", 80);
  settle(tree, "c");
  assert.match(buildLink(), /\[success\]\|/, "the completed phase's spine link turns green");
});

test("phase call counts do not reveal nested totals hidden from codemode summaries", () => {
  const tree = new ToolTree({ ...settings, groupNestedTools: false });
  tree.start({
    toolCallId: "a",
    toolName: "codemode",
    args: { taskIntent: "Implement retry safety", taskProgress: 10, taskMilestones: PLAN, taskMilestone: "inspect" },
  });
  for (const [id, toolName] of [["a1", "bash"], ["a2", "read"]]) {
    tree.start({ toolCallId: id!, toolName: toolName!, parentToolCallId: "a", args: { reasoning: "nested step" } });
    tree.end({ toolCallId: id!, toolName: toolName!, result: { content: [] }, isError: false, durationMs: 100 });
  }
  tree.end({ toolCallId: "a", toolName: "codemode", result: { content: [] }, isError: false, durationMs: 200 });

  const phase = painted(tree, WIDE, plainTheme).find(line => line.includes("Inspect") && line.includes("call")) ?? "";
  assert.match(phase, /1 .*call/, "phase count describes its direct codemode row");
  assert.doesNotMatch(phase, /3 .*calls/, "hidden nested tools do not leak through the phase rollup");
  const styledPhase = painted(tree, WIDE).find(line => line.includes("Inspect") && line.includes("call")) ?? "";
  assert.match(styledPhase, /\[dim\]1 calls?/, "the phase count and its unit share the dim role");
});

test("tool duration bars align to the right edge for different labels", () => {
  const realNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const tree = new ToolTree({ ...settings, iconMode: "nerd" });
    step(tree, "a", "inspect", 15);
    now += 2_000;
    settle(tree, "a");
    tree.start({
      toolCallId: "b",
      toolName: "very_long_tool",
      args: { taskIntent: "Implement retry safety", taskProgress: 20, taskMilestones: PLAN, taskMilestone: "inspect" },
    });
    now += 3_000;
    tree.end({ toolCallId: "b", toolName: "very_long_tool", result: { content: [] }, isError: false, durationMs: 4 });

    const lines = painted(tree, 80, plainTheme);
    const rows = lines.filter(line => line.includes("● bash") || line.includes("● very_long_tool"));
    assert.equal(rows.length, 2, "both tools have a painted row");
    const railStarts = rows.map(line => {
      const rail = /[━─]+(?= · (?:<\d+s|\d+s) │$)/.exec(line);
      assert.ok(rail, "duration rail and elapsed time sit immediately before the right frame");
      return visibleWidth(line.slice(0, rail.index));
    });
    assert.equal(railStarts[0], railStarts[1], "equal-width elapsed labels put each rail in the same column");
  } finally {
    Date.now = realNow;
  }
});

test("calls hang off their phase as a branch inside the timeline", () => {
  const tree = new ToolTree({ ...settings, iconMode: "nerd" });
  tree.start({ toolCallId: "a", toolName: "bash", args: { taskIntent: "Fix retries", taskProgress: 20, taskMilestones: PLAN, taskMilestone: "inspect" } });
  settle(tree, "a");
  tree.start({ toolCallId: "b", toolName: "bash", args: { taskProgress: 40, taskMilestones: PLAN, taskMilestone: "inspect" } });
  settle(tree, "b");
  tree.start({ toolCallId: "c", toolName: "bash", args: { taskProgress: 60, taskMilestones: PLAN, taskMilestone: "build" } });
  settle(tree, "c");
  tree.start({ toolCallId: "d", toolName: "bash", args: { taskProgress: 80, taskMilestones: PLAN, taskMilestone: "build" } });
  settle(tree, "d");

  const rows = painted(tree, 70, plainTheme);
  const at = (needle: string) => rows.find(line => line.includes(needle)) ?? "";
  // Calls follow their phase directly; only the phase-to-phase spine gets a blank link row.
  const inspect = rows.findIndex(line => line.includes("◆ Inspect"));
  assert.ok(inspect >= 0);
  assert.match(rows[inspect + 1] ?? "", /^ │ ├ ●/, "the first call attaches directly as a branch");
  const build = rows.findIndex(line => line.includes("◆ Build"));
  assert.ok(isConnectorLine(rows[build - 1] ?? ""), "the phase spine reconnects before the next diamond");
  // The last call of a phase closes that phase's branch, not the card's.
  const calls = rows.filter(line => /^ │ [├└] ●/.test(line));
  assert.equal(calls.length, 4, "every call hangs off a branch");
  assert.match(calls[0] ?? "", /^ │ ├ ●/, "an earlier call keeps the branch open");
  assert.equal(calls.filter(line => line.includes("└")).length, 2, "one branch closes per phase");
  assert.ok(
    rows.findIndex(line => line.includes("◆ Build")) > rows.findIndex(line => line.includes("└")),
    "the closing branch comes before the next phase",
  );
});

test("completed calls color their branch glyph green", () => {
  const tree = new ToolTree({ ...settings, iconMode: "nerd" });
  step(tree, "a", "inspect", 20);
  settle(tree, "a");

  const calls = painted(tree, WIDE).filter(line => /\[success\][├└] \[success\]●/.test(line));
  assert.equal(calls.length, 1, "the completed call's branch glyph uses the success color");
});

test("phase and call duration rails show elapsed time and fit narrow widths", () => {
  const realNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const tree = new ToolTree({ ...settings, iconMode: "nerd" });
    step(tree, "a", "inspect", 15);
    now += 3_100;
    settle(tree, "a");
    step(tree, "b", "build", 55);
    now += 1_550;
    settle(tree, "b");

    const lines = painted(tree, 100, plainTheme);
    const phase = lines.find(line => line.includes("◆ Inspect"));
    const call = lines.find(line => line.includes("● bash") && line.includes("3s"));
    assert.ok(phase && phase.includes("3s"), "phase summary includes its accumulated elapsed time");
    assert.ok(phase.includes("━") && phase.includes("─"), "phase summary has a filled and remaining duration rail");
    assert.ok(call && call.includes("3s"), "call summary retains its elapsed label beside the rail");

    for (const width of [18, 23, 24, 27, 35, 40, 80]) {
      const rendered = card(tree, "a", plainTheme).render(width);
      assert.ok(rendered.every(line => visibleWidth(line) <= width), `timeline exceeds ${width} columns`);
    }
  } finally {
    Date.now = realNow;
  }
});
