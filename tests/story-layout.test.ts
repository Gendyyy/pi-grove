// Exercises the Story card's phase and call disclosure and narrow failure presentation.
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { plainTheme } from "../theme.js";
import { GROUP_TARGET, ToolTree, milestoneTarget, type TreeSettings } from "../tool-tree.js";

const settings: TreeSettings = { mode: "prompt", revealErrors: false, icons: false, iconMode: "ascii", card: "classic", window: 4, groupNestedTools: true, groupProgress: true, groupPercent: true, groupPhases: true, groupSparkline: false, groupGutter: true, groupToolNames: true };

/** Build a card with completed and failed phases and one nested tool call. */
function storyCard() {
  const tree = new ToolTree(settings);
  for (const [id, phase, goal] of [["a", "inspect", "Read settings"], ["b", "verify", "Check registry"]]) {
    tree.start({ toolCallId: id, toolName: "codemode", args: { reasoning: goal, taskIntent: "Check updates", taskProgress: phase === "inspect" ? 10 : 65, taskMilestones: "inspect=Inspect; verify=Verify", taskMilestone: phase } });
    if (id === "b") {
      tree.start({ toolCallId: "child", parentToolCallId: id, toolName: "bash", args: { reasoning: "Request registry" } });
      tree.end({ toolCallId: "child", toolName: "bash", result: { content: [] }, isError: true });
    }
    tree.end({ toolCallId: id, toolName: "codemode", result: { content: [] }, isError: false });
  }
  const card = tree.render({ toolCallId: "a", inner: { render: () => [], invalidate: () => {} }, theme: plainTheme, expanded: false, invalidate: () => {} });
  return { tree, card };
}

test("story phases ignore a nested failure and open one level at a time", () => {
  const { tree, card } = storyCard();
  const render = (width = 96) => card.render(width);
  const lines = render();
  assert.ok(lines[0]!.includes("Check updates"), "the card states the task intent in its border");
  assert.ok(lines.some(line => line.includes("x 01 Inspect")));
  const phase = lines.findIndex(line => line.includes("02 Verify"));
  assert.ok(phase >= 0);
  assert.ok(!lines[phase]!.includes("failed"), "a nested step's failure never marks its phase");
  assert.ok(lines.some(line => line.includes("1 failed")), "the card rollup still counts the nested failure");
  assert.ok(!lines.some(line => line.includes("Request registry")));
  assert.equal((tree as unknown as { targetAt(index: number): string | undefined }).targetAt(phase), milestoneTarget("verify"));
  card.handleMouse?.({ type: "click", button: "left", x: 0, y: phase, screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false, width: 96, height: 40 });
  const opened = render();
  const call = opened.findIndex(line => line.includes("codemode") && line.includes("Check registry"));
  assert.ok(call >= 0);
  assert.ok(!opened.some(line => line.includes("Request registry")));
  card.handleMouse?.({ type: "click", button: "left", x: 0, y: call, screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false, width: 96, height: 40 });
  assert.ok(render().some(line => line.includes("Request registry")));
  const narrow = render(35);
  assert.ok(narrow.every(line => visibleWidth(line) <= 35));
  assert.ok(!(narrow.find(line => line.includes("02 Verify")) ?? "").includes("failed"));
});

test("story phase headers count the whole phase and fit common widths", () => {
  const tree = new ToolTree(settings);
  for (let i = 0; i < 6; i++) {
    const id = String(i);
    tree.start({ toolCallId: id, toolName: "bash", args: { reasoning: `Inspect lengthy configuration item ${i}`, taskIntent: "Inspect settings", taskProgress: 30, taskMilestones: "inspect=Inspect; verify=Verify", taskMilestone: "inspect" } });
    tree.end({ toolCallId: id, toolName: "bash", result: { content: [] }, isError: false });
  }
  const card = tree.render({ toolCallId: "0", inner: { render: () => [], invalidate: () => {} }, theme: plainTheme, expanded: false, invalidate: () => {} });
  for (const width of [35, 60, 96, 160]) {
    const lines = card.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `overflow at ${width}`);
    assert.ok(lines.some(line => line.includes("6 calls")), `phase call count missing at ${width}`);
  }
  const settled = card.render(96);
  assert.ok(settled.some(line => line.includes("Inspect lengthy configuration item 4")), "the newest calls stay visible");
  assert.equal(settled.filter(line => line.includes("Inspect lengthy configuration item 0")).length, 0, "a folded call never resurfaces as a summary row");
});

test("expand-all reveals nested steps while a phase follows its own calls", () => {
  const { tree } = storyCard();
  const roleTheme = { style: (value: string, options: { fg?: unknown }) => `[${String(options.fg)}]${value}` };
  const row = { toolCallId: "a", inner: { render: () => [], invalidate: () => {} }, theme: roleTheme, expanded: true, invalidate: () => {} };
  const lines = tree.render(row).render(400);
  assert.ok(lines.some(line => line.includes("[success]x 01")));
  assert.doesNotMatch(lines.find(line => line.includes(" 02")) ?? "", /\[warning\]/, "a nested failure never turns its phase orange");
  // Only the final response closes the last phase, and its own calls then decide the mark.
  tree.settle();
  const settled = tree.render(row).render(400);
  const verifyRow = settled.find(line => line.includes(" 02")) ?? "";
  assert.match(verifyRow, /\[success\]x 02/, "a phase whose own calls returned closes with a check");
  assert.doesNotMatch(verifyRow, /failed/, "the nested failure stays off the phase");
  assert.ok(lines.some(line => line.includes("Request registry")));
});

test("expanded Story rows replace summaries and keep the phase rail through nested tools", () => {
  const { tree } = storyCard();
  const theme = { style: (value: string, options: { fg?: unknown }) => `[${String(options.fg)}]${value}` };
  const card = tree.render({ toolCallId: "a", inner: { render: () => [], invalidate: () => {} }, theme, expanded: true, invalidate: () => {} });
  const lines = card.render(400);
  const phase = lines.find(line => line.includes(" 02 ") && line.includes("Verify")) ?? "";
  const call = lines.find(line => line.includes("codemode") && line.includes("Check registry")) ?? "";
  const child = lines.find(line => line.includes("bash") && line.includes("Request registry")) ?? "";
  assert.match(phase, /\[dim\]\| /, "the rail keeps one colour whatever the phase outcome");
  assert.ok(!phase.includes("failed"), "a nested failure stays off the phase rollup");
  assert.match(call, /\[error\]\*/, "the failing nested step still marks its own call row");
  assert.match(call, /\[dim\]\| /, "the phase rail must not change to the call outcome color");
  assert.match(child, /\[dim\]\| /);
  assert.match(child, /\[error\]\*/, "the failing call keeps its error marker");
  assert.equal(lines.filter(line => line.includes("Check registry")).length, 1, "the collapsed summary is replaced by its call");
  assert.ok(child.indexOf("Request registry") > call.indexOf("Check registry"), "nested tools are indented further");
});

test("expanded output is indented beneath its tool and stays within the card", () => {
  const tree = new ToolTree(settings);
  tree.start({ toolCallId: "a", toolName: "codemode", args: { reasoning: "Run checks", taskIntent: "Verify changes", taskProgress: 40, taskMilestones: "verify=Verify", taskMilestone: "verify" } });
  tree.start({ toolCallId: "child", parentToolCallId: "a", toolName: "bash", args: { reasoning: "Run tests" } });
  tree.end({ toolCallId: "child", toolName: "bash", result: { content: [{ type: "text", text: "OUTPUT: tests passed" }] }, isError: false });
  tree.end({ toolCallId: "a", toolName: "codemode", result: { content: [] }, isError: false });
  const card = tree.render({ toolCallId: "a", inner: { render: () => [], invalidate: () => {} }, theme: plainTheme, expanded: true, invalidate: () => {} });
  for (const width of [35, 60, 96]) {
    const lines = card.render(width);
    const phase = lines.find(line => line.includes("01 Verify")) ?? "";
    const parent = lines.find(line => line.includes("* codemode")) ?? "";
    const child = lines.find(line => line.includes("* bash")) ?? "";
    const output = lines.find(line => line.includes("OUTPUT:")) ?? "";
    assert.ok(phase && parent && child && output, `all hierarchy levels are visible at ${width}: ${JSON.stringify(lines)}`);
    const phaseColumn = phase.indexOf("Verify");
    const parentColumn = parent.indexOf("codemode");
    const childColumn = child.indexOf("bash");
    assert.ok(parentColumn > phaseColumn, "the call hangs off its phase: " + JSON.stringify([phase, parent]));
    assert.ok(childColumn > parentColumn, "a nested call sits deeper than its parent: " + JSON.stringify([parent, child]));
    assert.ok(output.indexOf("OUTPUT:") > phaseColumn, "the output is indented past the phase label: " + JSON.stringify([phase, output]));
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
});

test("the task intent rides the border without hiding text or breaking targets", () => {
  const intent = "Inspect 東京 settings and verify the complete configuration without losing important details";
  const tree = new ToolTree(settings);
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "Inspect settings", taskIntent: intent, taskProgress: 30, taskMilestones: "inspect=Inspect; verify=Verify", taskMilestone: "inspect" } });
  const card = tree.render({ toolCallId: "a", inner: { render: () => [], invalidate: () => {} }, theme: plainTheme, expanded: false, invalidate: () => {} });
  const targetAt = (tree as unknown as { targetAt(index: number): string | undefined }).targetAt.bind(tree);
  for (const width of [35, 60, 96]) {
    const lines = card.render(width);
    const border = lines[0]!.replace(/\u001b\[[0-9;]*m/g, "");
    // The border opens with the task, and a title that cannot fit is elided, never clipped.
    assert.match(border, /Inspect 東京 settings/, `the border names the task at ${width}`);
    assert.match(border, /…/, `an oversized title is elided at ${width}`);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.equal(targetAt(0), GROUP_TARGET, "the border is the gesture that reveals the card");
    const phase = lines.findIndex(line => line.includes("01 Inspect"));
    assert.equal(targetAt(phase), milestoneTarget("inspect"));
  }
});

test("consecutive related calls each keep their own row", () => {
  const tree = new ToolTree(settings);
  // A leftover // task-group: comment must not collapse these calls any more.
  for (const id of ["a", "b", "c"]) {
    tree.start({ toolCallId: id, toolName: "codemode", args: { code: `// task-intent: Group checks\n// task-progress: 30\n// task-milestones: inspect=Inspect\n// task-milestone: inspect\n// task-group: Read configuration\n// reasoning: action ${id}` } });
    tree.end({ toolCallId: id, toolName: "codemode", result: { content: [] }, isError: id === "b" });
  }
  const card = tree.render({ toolCallId: "a", inner: { render: () => [], invalidate: () => {} }, theme: plainTheme, expanded: false, invalidate: () => {} });
  const click = (y: number) => card.handleMouse?.({ type: "click", button: "left", x: 0, y, screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false, width: 96, height: 40 });
  const lines = card.render(96);
  click(lines.findIndex(line => line.includes("01 Inspect")));
  const opened = card.render(96);
  for (const id of ["a", "b", "c"]) assert.equal(opened.filter(line => line.includes(`action ${id}`)).length, 1, `action ${id} renders exactly once`);
  assert.ok(!opened.some(line => line.includes("Read configuration")), "no group row is rendered");
  for (const width of [35, 60, 96]) assert.ok(card.render(width).every(line => visibleWidth(line) <= width));
});


test("direct failures keep a warning phase after completion in ASCII and Nerd modes", () => {
  for (const iconMode of ["ascii", "nerd"] as const) {
    const tree = new ToolTree({ ...settings, iconMode });
    tree.start({ toolCallId: "a", toolName: "codemode", args: { reasoning: "Attempt checks", taskIntent: "Verify changes", taskProgress: 80, taskMilestones: "verify=Verify", taskMilestone: "verify" } });
    tree.end({ toolCallId: "a", toolName: "codemode", result: { content: [] }, isError: true });
    tree.start({ toolCallId: "b", toolName: "codemode", args: { reasoning: "Finish checks", taskIntent: "Verify changes", taskProgress: 100, taskMilestones: "verify=Verify", taskMilestone: "verify" } });
    tree.end({ toolCallId: "b", toolName: "codemode", result: { content: [] }, isError: false });
    tree.settle();
    const theme = { style: (value: string, options: { fg?: unknown }) => `[${String(options.fg)}]${value}` };
    const card = tree.render({ toolCallId: "a", inner: { render: () => [], invalidate: () => {} }, theme, expanded: false, invalidate: () => {} });
    const phase = card.render(96).find(line => line.includes("01") && line.includes("Verify")) ?? "";
    assert.ok(phase.includes("[warning]! 01"), "a closed phase with a failure wears the warning mark");
    assert.match(phase, /\[warning\]1 failed/);
  }
});
test("the card is one rounded frame whose top border carries the task intent", () => {
  const tree = new ToolTree({ ...settings, iconMode: "nerd", icons: true });
  tree.start({
    toolCallId: "a",
    toolName: "read",
    args: { reasoning: "read the manifest", taskIntent: "Frame the card", taskMilestones: "one=One; two=Two", taskMilestone: "one" },
  });
  tree.end({ toolCallId: "a", toolName: "read", result: { content: [] }, isError: false });
  const card = tree.render({ toolCallId: "a", inner: { render: () => [], invalidate: () => {} }, theme: plainTheme, expanded: false, invalidate: () => {} });
  // The host insets every row by one cell, so the frame starts after that pad.
  const lines = card.render(60).map(line => line.replace(/\u001b\[[0-9;]*m/g, "").trimStart());
  // The title is not a row of its own: it is set into the stroke.
  assert.match(lines[0]!, /^╭─ Frame the card ─+╮$/, "the border opens with the task intent");
  assert.match(lines.at(-1)!, /^╰─+╯$/, "the card closes on a rounded rule");
  assert.ok(lines.every(line => visibleWidth(line) <= 60), "every row stays inside the frame width");
  // No rail survives: the sides are the frame, so a row never reads as narration outside it.
  assert.ok(lines.slice(1, -1).every(line => line.startsWith("│ ") && line.trimEnd().endsWith("│")), "the body sits inside the frame");
});

test("a script that broke on a nested step leaves its phase neutral", () => {
  const tree = new ToolTree(settings);
  tree.start({ toolCallId: "a", toolName: "codemode", args: { reasoning: "Attempt checks", taskIntent: "Verify changes", taskMilestones: "verify=Verify", taskMilestone: "verify" } });
  tree.start({ toolCallId: "child", parentToolCallId: "a", toolName: "bash", args: { reasoning: "Run tests" } });
  tree.end({ toolCallId: "child", toolName: "bash", result: { content: [] }, isError: true });
  // Pi fails the whole call when the script lets that rejection escape.
  tree.end({ toolCallId: "a", toolName: "codemode", result: { content: [] }, isError: true });
  tree.start({ toolCallId: "b", toolName: "codemode", args: { reasoning: "Finish checks", taskIntent: "Verify changes", taskMilestones: "verify=Verify", taskMilestone: "verify" } });
  tree.end({ toolCallId: "b", toolName: "codemode", result: { content: [] }, isError: false });
  tree.settle();
  const theme = { style: (value: string, options: { fg?: unknown }) => `[${String(options.fg)}]${value}` };
  const card = tree.render({ toolCallId: "a", inner: { render: () => [], invalidate: () => {} }, theme, expanded: false, invalidate: () => {} });
  const phase = card.render(96).find(line => line.includes("01") && line.includes("Verify")) ?? "";
  assert.ok(phase.includes("[success]x 01"), "the phase closes clean instead of warning: " + phase);
  assert.ok(!phase.includes("warning"), "the script's failure belongs to the failing step, not the phase");
  assert.ok(!phase.includes("failed"), "a nested-caused script failure stays off the phase");
});
