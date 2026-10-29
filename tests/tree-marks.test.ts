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
  groupToolNames: true,
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

/** The meter's bar alone: the leading run of cells, without the gutter or the percentage. */
function meterBar(tree: ToolTree): string {
  const line = painted(tree, WIDE, plainTheme).find(candidate => candidate.includes("▰") || candidate.includes("▱")) ?? "";
  const bar = line.slice(line.search(/[▰▱:]/));
  return bar.slice(0, bar.search(/[^▰▱:]/));
}

/** Cells that carry a divider glyph, so a zone's opening column can be asserted by position. */
function dividerCells(bar: string): number[] {
  return [...bar].flatMap((glyph, index) => (glyph === ":" ? [index] : []));
}

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

  const wide = painted(tree, WIDE).find(line => line.includes("▰") && line.includes("Build"));
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

test("a crossed phase states its equal share of the plan", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "inspect", 40);
  settle(tree, "a");
  step(tree, "b", "build", 70);

  // The meter owns the plan gesture, so every phase sits one click away.
  card(tree).handleMouse?.(click(card(tree).render(WIDE).findIndex(line => line.includes("▰"))));
  const planLine = painted(tree, WIDE).find(line => line.includes("Inspect"));
  assert.ok(planLine, "clicking the meter opens the plan");
  // Three phases split 100 evenly, so Inspect closes at 33% whatever the model reported.
  assert.match(planLine, /Inspect\[muted\] 33%/);
  assert.match(planLine, /\[accent\]\* Build/);
});
test("a crossed boundary divides the filled ramp while the phase in flight keeps the accent", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "inspect", 40);
  settle(tree, "a");
  step(tree, "b", "build", 70);
  settle(tree, "b");
  step(tree, "c", "build", 85);

  const meter = painted(tree, WIDE, plainTheme).find(line => line.includes("▰") || line.includes("▱")) ?? "";
  // Build owns at most the second third, so the reported 85% paints as 67%.
  assert.match(meter, /67% > \* Build 2\/3/, meter);
  // The Inspect boundary sits a third of the way along, inside the filled span.
  assert.match(meter, /▰+:▰+/, meter);

  card(tree).handleMouse?.(click(card(tree).render(WIDE).findIndex(line => line.includes("▰"))));
  const planLine = painted(tree, WIDE).find(line => line.includes("Inspect")) ?? "";
  assert.match(planLine, /\[success\]x Inspect/, planLine);
  assert.match(planLine, /\[accent\]\* Build/, planLine);
  assert.match(planLine, /\[dim\]o Verify/, planLine);
  // The arrow behind a finished phase is green, so a completed plan reads as one line.
  assert.match(planLine, /Inspect\[muted\] 33% \[success\]-> \[accent\]\* Build/, planLine);
  assert.match(planLine, /Build \[dim\]-> \[dim\]o Verify/, planLine);
});
test("the bar marks only the phases the plan has reached", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "build", 55);

  // Reaching Build closes Inspect, so its third earns a divider; Verify is still ahead,
  // and a phase that has not started cannot say where it will close.
  const bar = meterBar(tree);
  assert.deepEqual(dividerCells(bar), [0, Math.round(bar.length / 3)]);
});
test("every phase opens a column, and the first one opens the bar itself", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "inspect", 20);
  // The first phase starts where the bar starts, so its divider needs no crossing to earn.
  assert.deepEqual(dividerCells(meterBar(tree)), [0]);

  settle(tree, "a");
  step(tree, "b", "build", 60);
  settle(tree, "b");
  step(tree, "c", "verify", 88);
  const walked = meterBar(tree);
  const cells = walked.length;
  // Each later phase keeps the column its equal share earned.
  assert.deepEqual(dividerCells(walked), [0, Math.round(cells / 3), Math.round((2 * cells) / 3)]);
});
test("the filled span keeps the estimate's red-to-green ramp", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "build", 55);
  settle(tree, "a");

  const meter = painted(tree, WIDE, paletteTheme()).find(line => line.includes("▰") || line.includes("▱")) ?? "";
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

  const line = painted(tree, WIDE).find(candidate => candidate.includes("▰") && candidate.includes("Tidy helper"));
  assert.ok(line, "a two-phase plan still names the phase in flight");
  assert.match(line, /\[accent\]\*\[accent\] Tidy helper 1\/2/);
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
  assert.equal(targetAt(card(tree).render(WIDE).findIndex(line => line.includes("▰"))), PHASES_TARGET);
  assert.equal(hasExpandedPlan(), false, "phase markers do not open the meter's full plan");
  assert.ok(card(tree).render(WIDE).map(plain).some(line => line.includes("Inspect") && line.includes("01")), "the timeline still names its first phase");

  card(tree).handleMouse?.(click(card(tree).render(WIDE).findIndex(line => line.includes("▰"))));
  assert.equal(hasExpandedPlan(), true, "clicking the meter expands the full plan");
  card(tree).handleMouse?.(click(card(tree).render(WIDE).findIndex(line => line.includes("▰"))));
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
  /** Call rows belonging to the given one-word call labels. */
  const rowsOf = (...names: string[]) => codemodeRows().filter(line => names.some(name => line.includes(` ${name} ×1`)));
  const hasExpandedChild = (name: string): boolean =>
    rendered().some(line => line.includes("●") && line.includes(name + " · phase call"));
  const planIsOpen = () => rendered().some(line =>
    line.includes("Inspect") && line.includes("Verify") && (line.includes("->") || line.includes("→")),
  );
  assert.equal(rowsOf("read", "grep", "write").length, 0, "a finished phase's older calls start collapsed");
  assert.equal(codemodeRows().length, 2, "the newest calls stay visible without opening a phase");

  const inspectY = rendered().findIndex(line => line.includes("01 Inspect"));
  assert.ok(inspectY >= 0);
  assert.equal((tree as unknown as { targetAt(index: number): string | undefined }).targetAt(inspectY), milestoneTarget("inspect"));
  component().handleMouse?.({ ...click(inspectY), width: WIDE });
  let calls = rowsOf("read", "grep", "write");
  assert.equal(calls.length, 3, "expanding a phase reveals all and only its direct rows");
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
  assert.equal(rowsOf("read", "grep", "write").length, 0, "a second click collapses the phase back to its summary");
  assert.ok(rendered().some(line => line.includes("3 calls")), "the summary names the phase's full call count");

  const buildY = rendered().findIndex(line => line.includes("02 Build"));
  component().handleMouse?.({ ...click(buildY), width: WIDE });
  calls = rowsOf("test", "lint", "typecheck");
  assert.equal(calls.length, 3, "another phase reveals only its own hidden direct call");
  assert.ok(calls.every(line => line.includes("test ×1") || line.includes("lint ×1") || line.includes("typecheck ×1")));
  assert.equal(hasExpandedChild("test") || hasExpandedChild("lint") || hasExpandedChild("typecheck"), false);
});

test("a collapsed phase keeps the recent window and reports phase-level failures", () => {
  const tree = new ToolTree({ ...settings, window: 2 });
  const calls: Array<[string, string, "inspect" | "build", number, boolean]> = [
    ["a", "Read release notes", "inspect", 20, true],
    ["b", "Locate version parser", "inspect", 30, false],
    ["c", "Run focused package tests", "build", 55, false],
    ["d", "Typecheck extension types", "build", 65, false],
  ];
  for (const [id, reasoning, taskMilestone, taskProgress, isError] of calls) {
    tree.start({
      toolCallId: id,
      toolName: "bash",
      args: {
        reasoning,
        taskIntent: "Inspect and build safely",
        taskProgress,
        taskMilestones: PLAN,
        taskMilestone,
      },
    });
    tree.end({ toolCallId: id, toolName: "bash", result: { content: [] }, isError, durationMs: 100 });
  }

  /** Render the collapsed card at the standard test width. */
  const rendered = () => card(tree, "a", plainTheme).render(WIDE).map(plain);
  const initial = rendered();
  const styled = card(tree, "a", theme).render(WIDE).map(plain);
  const inspectHeader = styled.find(line => line.includes("Inspect") && line.includes("1 failed")) ?? "";
  assert.match(inspectHeader, /\[warning\] · 1 failed/, "the collapsed phase reports its failure");
  assert.ok(!initial.some(line => line.includes("Read release notes")), "a folded call never resurfaces as a summary row");
  for (const width of [35, 60, 96, WIDE]) {
    const lines = card(tree, "a", plainTheme).render(width).map(plain);
    assert.ok(lines.every(line => visibleWidth(line) <= width), "the phase header stays within " + width + " columns");
    if (width === 35)
      assert.ok(lines.some(line => line.includes("2 calls")), "the phase header counts every call it holds");
  }
  assert.ok(initial.some(line => line.includes("Run focused package tests")));
  assert.ok(initial.some(line => line.includes("Typecheck extension types")));
  const inspectY = initial.findIndex(line => line.includes("Inspect") && line.includes("calls"));
  /** Read the expansion target assigned to a rendered line. */
  const targetAt = (line: number) => (tree as unknown as { targetAt(index: number): string | undefined }).targetAt(line);
  assert.equal(targetAt(inspectY), milestoneTarget("inspect"), "the phase line opens its own calls");

  card(tree, "a", plainTheme).handleMouse?.({ ...click(inspectY), width: WIDE });
  const expanded = rendered().join("\n");
  assert.match(expanded, /Read release notes/);
  assert.match(expanded, /Locate version parser/);
});

test("a call with an unknown or missing milestone joins the phase it follows", () => {
  const tree = new ToolTree({ ...settings, window: 5 });
  // The second call names the label instead of the id; the third declares nothing at all.
  for (const [id, reasoning, milestone, progress] of [["a", "Read package docs", "inspect", 10], ["b", "Read extension source", "Inspect", 20], ["c", "Run focused tests", "verify", 80], ["d", "Typecheck sources", undefined, 95]] as const) {
    tree.start({
      toolCallId: id,
      toolName: "codemode",
      args: { reasoning, taskIntent: "Inspect and build safely", taskProgress: progress, taskMilestones: PLAN, ...(milestone ? { taskMilestone: milestone } : {}) },
    });
    tree.end({ toolCallId: id, toolName: "codemode", result: { content: [] }, isError: false, durationMs: 100 });
  }
  const lines = card(tree, "a", plainTheme).render(WIDE).map(plain);
  // Every call lands under a phase, and the phase counts add up to the calls on the card.
  assert.ok(lines.some(line => line.includes("01 Inspect") && line.includes("2 calls")), "an unresolved milestone stays with the phase it follows");
  assert.ok(lines.some(line => line.includes("03 Verify") && line.includes("2 calls")), "a call that declares nothing joins the phase before it");
  const inspectY = lines.findIndex(line => line.includes("01 Inspect"));
  const verifyY = lines.findIndex(line => line.includes("03 Verify"));
  const at = (goal: string) => lines.findIndex(line => line.includes(goal));
  assert.ok(at("Read package docs") > inspectY && at("Read package docs") < verifyY, "the phantom-milestone call renders inside its phase");
  assert.ok(at("Typecheck sources") > verifyY, "the undeclared call renders inside the last phase");
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
    line.includes("* bash") && !/\bcalls?\b/.test(line) ? [index] : [],
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
  const phaseMarker = () => painted(tree, WIDE).find(line => line.includes("02") && line.includes("Build")) ?? "";
  assert.match(phaseMarker(), /\[warning\]\* 02/, "the active phase marker carries the warning color");

  step(tree, "d", "verify", 80);
  settle(tree, "c");
  assert.match(phaseMarker(), /\[success\]x 02/, "the completed phase marker reads as history");
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

  const phase = painted(tree, WIDE, plainTheme).find(line => line.includes("01") && line.includes("Inspect") && line.includes("call")) ?? "";
  assert.match(phase, /1 .*call/, "phase count describes its direct codemode row");
  assert.doesNotMatch(phase, /3 .*calls/, "hidden nested tools do not leak through the phase rollup");
  const styledPhase = painted(tree, WIDE).find(line => line.includes("01") && line.includes("Inspect") && line.includes("call")) ?? "";
  assert.match(styledPhase, /\[dim\] · 1 calls?/, "the phase count and its unit share the dim role");
});

test("the duration scale includes calls outside the collapsed window", () => {
  const realNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const tree = new ToolTree({
      ...settings,
      window: 1,
      groupProgress: false,
      groupGutter: false,
      iconMode: "nerd",
    });
    tree.start({
      toolCallId: "old",
      toolName: "old_tool",
      args: { taskIntent: "Compare elapsed work", taskProgress: 20, taskMilestones: PLAN, taskMilestone: "inspect" },
    });
    now += 9_000;
    tree.end({ toolCallId: "old", toolName: "old_tool", result: { content: [] }, isError: false, durationMs: 1 });
    tree.start({
      toolCallId: "new",
      toolName: "new_tool",
      args: { taskProgress: 60, taskMilestones: PLAN, taskMilestone: "build" },
    });
    now += 5_000;
    tree.end({ toolCallId: "new", toolName: "new_tool", result: { content: [] }, isError: false, durationMs: 1 });

    const lines = card(tree, "old", plainTheme).render(WIDE).map(plain);
    const current = lines.find(line => line.includes("new_tool") && line.includes("5s"));
    assert.ok(current, "the most recent tool remains visible");
    assert.doesNotMatch(
      lines.filter(line => line.includes("●")).join(" "),
      /old_tool/,
      "the older tool row is outside the visible window",
    );
    const rail = /[━─]+(?= · 5s │$)/.exec(current)?.[0];
    assert.ok(rail, "the visible row retains its rail and elapsed label");
    assert.equal(
      [...rail].filter(cell => cell === "━").length,
      4,
      "the hidden 9s call still sets the card scale for the visible 5s call",
    );
  } finally {
    Date.now = realNow;
  }
});

test("no phase but the last may paint a finished bar", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "build", 100);
  settle(tree, "a");
  const meter = painted(tree, WIDE, plainTheme).find(line => line.includes("▰") || line.includes("▱")) ?? "";
  // Build has two thirds to claim, so a reported 100% stops there while Verify is ahead.
  assert.match(meter, /67% > \* Build 2\/3/, meter);
  assert.match(meter, /▱/, "the last third stays empty");

  const finished = new ToolTree(settings);
  step(finished, "a", "verify", 100);
  settle(finished, "a");
  const full = painted(finished, WIDE, plainTheme).find(line => line.includes("▰") || line.includes("▱")) ?? "";
  assert.match(full, /100% > x Verify 3\/3/, full);
});
