// State markers on grouped rows: the dot reports the call state instead of an expand arrow.
import assert from "node:assert/strict";
import test from "node:test";
import { ToolTree, GROUP_TARGET, PHASES_TARGET, milestoneTarget, type TreeRow, type TreeSettings } from "../tool-tree.js";
import { clean, treeGlyphs } from "../tree-model.js";
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
/** Any row marker: Nerd Font paints a circle for the Unicode dot, and a live row spins. */
const MARKER = /[●\uf111*|\/-\\o]/;
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
  return card(tree, "a", rowTheme).render(width).map(plain).slice(1);
}
/** The plan block's label row: one box per phase, so every named phase shares a line. */
function planRow(lines: readonly string[], ...names: string[]): string {
  return lines.find(line => names.every(name => line.includes(name))) ?? "";
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
/** Milliseconds each spinner frame holds the screen. */
const SPIN_MS = 80;

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

test("the meter keeps only the share, and the plan row names every phase", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "build", 55);

  const wide = painted(tree, WIDE).find(line => line.includes("▰")) ?? "";
  assert.ok(wide, "a card with a plan paints a meter");
  assert.match(wide, /33%/, "the meter states the share alone");
  assert.doesNotMatch(wide, /Inspect|Build|Verify/, "no phase name spends the bar's cells");

  // The plan block sits under the meter unprompted, one box per phase.
  const plan = planRow(painted(tree, WIDE), "Inspect", "Build", "Verify");
  assert.ok(plan, "the plan row opens without a click");
  assert.match(plan, /\[success\]\| \[success\]Inspect \[success\]\|\[success\]---/, "a closed phase turns its box and its link green");
  assert.match(plan, /\[accent\]\| \[accent\]Build \[accent\]\|/, "the phase in flight keeps the accent");
  assert.match(plan, /\[dim\]\| \[dim\]Verify \[dim\]\|/, "and the phases ahead stay dim");
  assert.doesNotMatch(plan, /%/, "the boxes never carry a percentage");

  const narrow = painted(tree, 35, plainTheme).find(line => /[▰▱]/.test(line)) ?? "";
  assert.ok(narrow, "the meter survives a card too narrow for its plan");
  assert.ok(narrow.length <= 35, `compact meter exceeds its viewport: ${narrow}`);
});

test("a failed phase warns instead of claiming success", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "inspect", 30);
  tree.end({ toolCallId: "a", toolName: "bash", result: { content: [] }, isError: true, durationMs: 4 });
  const open = planRow(painted(tree, WIDE), "Inspect", "Build", "Verify");
  assert.match(open, /\[warning\]\| \[warning\]Inspect \[warning\]\|/, "a failure paints its own phase, in flight or not");
  assert.match(open, /\[dim\]\| \[dim\]Verify \[dim\]\|/, "the phases ahead stay dim");
  assert.doesNotMatch(open, /Inspect \[warning\]\|\[warning\]---/, "the link closes only when the plan moves on");

  // Moving on closes the phase, and the failure travels with it instead of turning green.
  step(tree, "b", "build", 60);
  const moved = planRow(painted(tree, WIDE), "Inspect", "Build", "Verify");
  assert.match(moved, /Inspect \[warning\]\|\[warning\]---\[accent\]\| \[accent\]Build/, moved);
});

test("a crowded plan drops whole boxes and counts the rest instead of cutting one", () => {
  const tree = new ToolTree(settings);
  const plan = "a=Inspect; b=Build; c=Verify; d=Lint; e=Docs; f=Commit; g=Push";
  tree.start({ toolCallId: "a", toolName: "bash", args: { taskIntent: "Ship the retry fix", taskMilestones: plan, taskMilestone: "a" } });

  // Seven phases cannot fit a narrow card, so the tail becomes a count rather than a sliced box.
  const row = planRow(painted(tree, 60, plainTheme), "Inspect", "Build").trimEnd();
  assert.ok(row, "the leading phases keep their boxes");
  assert.match(row, /- \+\d+$/, "the plan ends in a count: " + row);
  assert.ok(visibleWidth(row) <= 60, "the plan exceeds its viewport: " + visibleWidth(row));
});

test("a crossed phase turns its box green and leaves the live phase in the accent", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "inspect", 40);
  settle(tree, "a");
  step(tree, "b", "build", 70);

  // The plan block is already on screen, so a phase's stage needs no gesture.
  const planLine = planRow(painted(tree, WIDE), "Inspect", "Build", "Verify");
  assert.ok(planLine, "the plan row states each phase's stage unprompted");
  // Three phases split 100 evenly, so Inspect sits behind us at 33% whatever the model reported.
  assert.match(planLine, /\[success\]\| \[success\]Inspect \[success\]\|\[success\]---\[accent\]\| \[accent\]Build/, planLine);
  assert.doesNotMatch(planLine, /33%/, "the share stays on the meter");
});
test("a crossed boundary divides the filled ramp while the phase in flight keeps the accent", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "inspect", 40);
  settle(tree, "a");
  step(tree, "b", "build", 70);
  settle(tree, "b");
  step(tree, "c", "build", 85);

  const meter = painted(tree, WIDE, plainTheme).find(line => line.includes("▰") || line.includes("▱")) ?? "";
  // Only Inspect has finished, so Build owns the first third whatever the model reported.
  assert.match(meter, / 33%/, meter);
  // Inspect's tick is the fill edge: one finished phase, one third filled.
  assert.match(meter, /▰+:?▱/, meter);

  const planLine = planRow(painted(tree, WIDE), "Inspect", "Build", "Verify");
  assert.match(planLine, /\[success\]\| \[success\]Inspect/, planLine);
  assert.match(planLine, /\[accent\]\| \[accent\]Build/, planLine);
  assert.match(planLine, /\[dim\]\| \[dim\]Verify/, planLine);
  // The link behind a finished phase is green, so a closed run reads as one chain.
  assert.match(planLine, /Inspect \[success\]\|\[success\]---\[accent\]\| \[accent\]Build/, planLine);
  assert.match(planLine, /Build \[accent\]\|\[dim\]---\[dim\]\| \[dim\]Verify/, planLine);
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
  assert.ok(ramp.length >= 4, meter);
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
  const ok = rows.find(line => line.includes("[success]*"));
  const failed = rows.find(line => line.includes("[error]*"));
  assert.ok(ok);
  assert.ok(failed);
  assert.match(ok, /\[success\]\*/);
  assert.match(failed, /\[error\]\*/);
  assert.doesNotMatch(ok, /error/);
});

test("a running call cycles a quarter circle and settles to a still dot", () => {
  const real = Date.now;
  try {
    const tree = new ToolTree(settings);
    tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the tests" } });
    const base = 1_000_000;
    const frame = PULSE_MS / 4;
    // Sample the live row marker: the spinner turns in place of the state dot.
    const marker = (offset: number): string => {
      Date.now = () => base + offset;
      const card = painted(tree, 400, paletteTheme());
      const row = card.find(line => /\[warning\][|/\-\\] \S*bash/.test(line));
      assert.ok(row, "expected the live row in the painted card");
      // The spinner keeps the running role's colour, so only the glyph itself turns.
      assert.match(row, /\[warning\]/, "the spinner stays in the running role");
      return /\[warning\]([|/\-\\])/.exec(row)![1]!;
    };

    assert.deepEqual([marker(0), marker(frame), marker(frame * 2)], ["|", "/", "-"]);
    assert.equal(marker(frame * 4), marker(0), "a full cycle returns to the first quarter");

    tree.end({ toolCallId: "a", toolName: "bash", result: { content: [] }, durationMs: 500 } as never, undefined);
    const settled = painted(tree, 400, paletteTheme()).find(line => /\[success\]\* \S*bash/.test(line))!;
    assert.ok(settled, "a finished call keeps the filled dot");
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

test("the phase in flight keeps turning until the plan moves on", () => {
  const real = Date.now;
  try {
    const tree = new ToolTree(settings);
    step(tree, "a", "build", 55);
    const base = 1_000_000;
    // The phase's mark turns on the same clock as a live call while that call is in flight.
    const mark = (offset: number): string => {
      Date.now = () => base + offset;
      // The plan row also names Build, so pick the numbered phase row below it.
      const row = painted(tree, WIDE, plainTheme).find(line => /(\S) \d\d /.test(line) && line.includes("Build"));
      assert.ok(row, "expected the phase row in the painted card");
      // The rail owns the first cell, so the phase mark is the glyph before its number.
      return /(\S) \d\d /.exec(row)![1]!;
    };
    const first = mark(0);
    assert.notEqual(mark(SPIN_MS), first, "the phase mark turns while its call runs");
    assert.notEqual(mark(SPIN_MS * 2), mark(SPIN_MS), "it keeps turning between two frames");
    // One revolution is as long as the glyph table's frame list, whatever mode is painting.
    assert.equal(mark(SPIN_MS * treeGlyphs(settings.iconMode).spinner.length), first, "one revolution returns to the first frame");
    // A call returning is work, not an ending: the gap before the next call still shows motion.
    tree.end({ toolCallId: "a", toolName: "bash", result: { content: [] }, isError: false, durationMs: 4 });
    assert.notEqual(mark(SPIN_MS), mark(0), "a returned call never stops its phase turning");
    // The plan moving past the phase is what closes it.
    step(tree, "b", "verify", 80);
    const closed = mark(0);
    assert.equal(closed, treeGlyphs(settings.iconMode).check, "a phase the plan moved past holds a check");
    assert.equal(mark(SPIN_MS), closed, "a closed phase stops turning");
    tree.settle();
    assert.equal(mark(0), closed, "settling the card changes nothing once the plan is over");
  } finally {
    Date.now = real;
  }
});

test("a failed phase keeps turning while it is in flight, then holds the failure", () => {
  const real = Date.now;
  try {
    const tree = new ToolTree(settings);
    step(tree, "a", "build", 55);
    tree.end({ toolCallId: "a", toolName: "bash", result: { content: [] }, isError: true, durationMs: 4 });
    const base = 2_000_000;
    // Nothing runs in the phase, yet it is still the one in flight, so the mark keeps turning.
    const frames = treeGlyphs(settings.iconMode).spinner;
    const mark = (offset: number): string => {
      Date.now = () => base + offset;
      const line = painted(tree, WIDE, plainTheme).find(candidate => /(\S) \d\d /.test(candidate) && candidate.includes("Build"));
      assert.ok(line, "expected the phase row in the painted card");
      return /(\S) \d\d /.exec(line)![1]!;
    };
    assert.ok(frames.includes(mark(0)), "a phase still in flight keeps turning after a failure");
    assert.notEqual(mark(SPIN_MS), mark(0), "a failure changes the colour, not the motion");
    // The plan moving past it is what ends the phase, and the failure is what it then holds.
    step(tree, "b", "verify", 80);
    assert.equal(mark(0), "!", "a failed phase the plan left behind holds the failure");
    assert.equal(mark(SPIN_MS), "!", "and stops turning");
  } finally {
    Date.now = real;
  }
});

test("a two-phase plan still paints a labeled stepper", () => {
  const tree = new ToolTree(settings);
  tree.start({
    toolCallId: "a",
    toolName: "bash",
    args: { taskIntent: "Tidy the retry helper", taskProgress: 40, taskMilestones: "work=Tidy helper; verify=Verify", taskMilestone: "work" },
  });

  const meter = painted(tree, WIDE).find(candidate => /[▰▱]/.test(candidate)) ?? "";
  assert.ok(meter, "a two-phase plan still paints a meter");
  assert.doesNotMatch(meter, /Tidy helper/, "the meter leaves the name to the plan row");

  const line = planRow(painted(tree, WIDE), "Tidy helper", "Verify");
  assert.ok(line, "a two-phase plan still boxes the phase in flight");
  assert.match(line, /\[accent\]\| \[accent\]Tidy helper \[accent\]\|/, line);
  assert.match(line, /\[dim\]\| \[dim\]Verify \[dim\]\|/, line);
});

test("the meter toggles the expanded plan independently of visible timeline phases", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "build", 55);
  const targetAt = (line: number) => (tree as unknown as { targetAt(index: number): string | undefined }).targetAt(line);
  const hasExpandedPlan = () => planRow(card(tree).render(WIDE).map(plain), "Inspect", "Verify") !== "";

  card(tree).render(WIDE);
  assert.equal(targetAt(0), GROUP_TARGET);
  assert.equal(targetAt(card(tree).render(WIDE).findIndex(line => line.includes("▰"))), PHASES_TARGET);
  const meterY = () => card(tree).render(WIDE).findIndex(line => line.includes("▰"));
  assert.equal(hasExpandedPlan(), true, "the plan row is on screen without a click");
  assert.ok(card(tree).render(WIDE).map(plain).some(line => line.includes("Inspect") && line.includes("01")), "the timeline still names its first phase");

  card(tree).handleMouse?.(click(meterY()));
  assert.equal(hasExpandedPlan(), false, "clicking the meter folds the full plan away");
  card(tree).handleMouse?.(click(meterY()));
  assert.equal(hasExpandedPlan(), true, "a second click brings it back");
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
  const codemodeRows = () => rendered().filter(line => MARKER.test(line) && line.includes(" codemode ·"));
  /** Call rows belonging to the given one-word call labels. */
  const rowsOf = (...names: string[]) => codemodeRows().filter(line => names.some(name => line.includes(` ${name} ×1`)));
  const hasExpandedChild = (name: string): boolean =>
    rendered().some(line => MARKER.test(line) && line.includes(name + " · phase call"));
  const planIsOpen = () => planRow(rendered(), "Inspect", "Verify") !== "";
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
  assert.equal(planIsOpen(), true, "phase expansion leaves the plan row where it was");

  const readY = rendered().findIndex(line => MARKER.test(line) && line.includes(" codemode · read ×1"));
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
  assert.match(inspectHeader, /\[warning\]1 failed/, "the collapsed phase reports its failure");
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
    MARKER.test(line) && line.includes(" bash") && !/\bcalls?\b/.test(line) ? [index] : [],
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
  assert.equal(lines.filter(line => /[├└]─ /.test(line)).length, 3, "calls remain a branch list");
});

test("a completed phase marker turns green when the plan moves on", () => {
  const tree = twoPhases();
  const phaseMarker = () => painted(tree, WIDE).find(line => line.includes("02") && line.includes("Build")) ?? "";
  assert.match(phaseMarker(), /\[accent\]. 02/, "the active phase marker carries the accent color and turns");

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
  assert.match(styledPhase, /\[dim\]1 calls?/, "the phase count and its unit share the dim role");
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
    const rail = /[━─]+(?= · 5s$)/.exec(current)?.[0];
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

test("the bar stops behind the phase the plan has left", () => {
  const tree = new ToolTree(settings);
  step(tree, "a", "build", 100);
  settle(tree, "a");
  const meter = painted(tree, WIDE, plainTheme).find(line => line.includes("▰") || line.includes("▱")) ?? "";
  // Build is the phase in flight: its call came back, but the plan has not moved past it.
  assert.match(meter, / 33%/, meter);
  assert.match(meter, /▱/, "the last third stays empty");

  const finished = new ToolTree(settings);
  step(finished, "a", "verify", 100);
  settle(finished, "a");
  finished.settle();
  const full = painted(finished, WIDE, plainTheme).find(line => line.includes("▰") || line.includes("▱")) ?? "";
  assert.match(full, /100%/, full);
});

test("a plan box is measured in cells, so a wide label cannot shear its border", () => {
  const tree = new ToolTree(settings);
  tree.start({ toolCallId: "a", toolName: "bash", args: { taskIntent: "Document the audit", taskMilestones: "a=調査する; b=Build", taskMilestone: "a" } });

  // A wide label spends two cells per character, so building the box from code units leaves it short.
  const lines = painted(tree, 120, plainTheme).map(line => line.trimEnd());
  const middle = lines.findIndex(line => line.includes("調査する"));
  assert.ok(middle > 0, "the plan paints the wide label");
  const block = lines.slice(middle - 1, middle + 2).map(visibleWidth);
  assert.equal(new Set(block).size, 1, "every row of a box spans the same cells: " + block.join("/"));
});

test("clean expands a tab before the line is measured", () => {
  // A tab reads as one cell to the width counter and several on screen, so it must become spaces first.
  assert.equal(clean("a	b"), "a   b", "a tab survives into the painter");
});
