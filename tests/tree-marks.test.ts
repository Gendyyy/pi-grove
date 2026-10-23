// State markers on grouped rows: the dot reports the call state instead of an expand arrow.
import assert from "node:assert/strict";
import test from "node:test";
import { ToolTree, type TreeRow, type TreeSettings } from "../tool-tree.js";
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
  // The header is the first line inside the frame, so the raw frame index is 1.
  card(tree, "a", rowTheme).handleMouse?.(click(1));
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

/** Colour the theme tagged onto the active phase marker of the strip. */
function markerColor(lines: readonly string[]): string | undefined {
  return lines.find(line => line.includes("Build"))?.match(/rgb\(\d+,\d+,\d+\)\*/)?.[0];
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

test("milestone stepper colors each phase and switches to the active label when narrow", () => {
  const tree = new ToolTree(settings);
  tree.start({
    toolCallId: "a",
    toolName: "bash",
    args: {
      taskIntent: "Implement retry safety",
      taskProgress: 55,
      taskMilestones: "inspect=Inspect; build=Build; verify=Verify",
      taskMilestone: "build",
    },
  });

  const labeled = painted(tree, 180).find(line => line.includes("Inspect"));
  assert.ok(labeled);
  assert.match(labeled, /\[success\]x Inspect/);
  assert.match(labeled, /\[accent\]\* Build/);
  assert.match(labeled, /\[dim\]o Verify/);

  const full = painted(tree, 40, plainTheme).find(line => line.includes("Inspect"));
  assert.ok(full);
  assert.match(full, /x Inspect -> \* Build -> o Verify/);

  const compact = painted(tree, 35, plainTheme).find(line => line.includes("Build"));
  assert.ok(compact);
  assert.doesNotMatch(compact, /Inspect|Verify/);
  assert.match(compact, /x.*\*.*o.*Build/);
  assert.ok(compact.length <= 35, `compact stepper exceeds its viewport: ${compact}`);
});

test("an unframed narrow card preserves a fitting active milestone label", () => {
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

  const compact = card(tree, "a", plainTheme).render(27).map(plain).find(line => line.includes("Check"));
  assert.ok(compact);
  assert.match(compact, /x.*\*.*o.*Checkpoint/);
  assert.ok(compact.length <= 27, `compact stepper exceeds its viewport: ${compact}`);
});

test("the milestone strip is centered inside the card", () => {
  const tree = new ToolTree(settings);
  tree.start({
    toolCallId: "a",
    toolName: "bash",
    args: {
      taskIntent: "Implement retry safety",
      taskProgress: 55,
      taskMilestones: "inspect=Inspect; build=Build; verify=Verify",
      taskMilestone: "build",
    },
  });

  const strip = painted(tree, 40, plainTheme).find(line => line.includes("Inspect"));
  assert.ok(strip);
  const lead = strip.length - strip.trimStart().length;
  const trail = strip.length - strip.trimEnd().length;
  assert.ok(Math.abs(lead - trail) <= 1, "strip is off-center: " + lead + " before, " + trail + " after");
});

test("the arrow between phases turns green once the phase behind it is done", () => {
  const tree = new ToolTree(settings);
  tree.start({
    toolCallId: "a",
    toolName: "bash",
    args: {
      taskIntent: "Implement retry safety",
      taskProgress: 60,
      taskMilestones: "inspect=Inspect; build=Build; verify=Verify",
      taskMilestone: "build",
    },
  });

  const strip = painted(tree, 180).find(line => line.includes("Inspect")) ?? "";
  assert.match(strip, /Inspect\[success\] -> \[accent\]/, strip);
  assert.ok(strip.includes("Build[dim] -> "), "a pending run keeps its arrow quiet: " + strip);
});

test("the active milestone marker breathes instead of blinking on and off", () => {
  const tree = new ToolTree(settings);
  tree.start({
    toolCallId: "a",
    toolName: "bash",
    args: {
      taskIntent: "Implement retry safety",
      taskProgress: 55,
      taskMilestones: "inspect=Inspect; build=Build; verify=Verify",
      taskMilestone: "build",
    },
  });

  const realNow = Date.now;
  // Sample the strip at fixed clock positions, since the pulse is driven by the paint clock.
  const sample = (clock: number): string | undefined => {
    try {
      Date.now = () => clock;
      return markerColor(painted(tree, 60, paletteTheme()));
    } finally {
      Date.now = realNow;
    }
  };

  const bright = sample(0);
  const mid = sample(PULSE_MS / 2);
  const nextCycle = sample(PULSE_MS);
  assert.ok(bright && mid && nextCycle);
  assert.equal(bright, nextCycle, "one cycle later the marker returns to where it started");
  assert.notEqual(bright, mid, "half a cycle lands on a different colour, not the same glyph");
  assert.notEqual(mid, "rgb(80,80,80)*", "the pulse quiets toward muted without switching the marker off");
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

  const line = painted(tree, 60).find(candidate => candidate.includes("Tidy helper"));
  assert.ok(line, "one phase must render as a stepper");
  assert.match(line, /\[accent\]\* Tidy helper/);
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

  const wide = painted(tree, 200).find(candidate => candidate.includes("Plan"));
  assert.ok(wide, "seven phases fit while the labels have room");
  assert.match(wide, /\[success\]x Plan/);
  assert.match(wide, /\[accent\]\* Test/);

  const narrow = painted(tree, 28, plainTheme).find(candidate => candidate.includes("Test"));
  assert.ok(narrow, "the active phase keeps its label on a narrow card");
  assert.doesNotMatch(narrow, /Plan|Verify/);
  assert.ok(narrow.length <= 28, `narrow stepper exceeds its viewport: ${narrow}`);
});
