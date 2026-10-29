// Exercises the Story card's phase and call disclosure and narrow failure presentation.
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { plainTheme } from "../theme.js";
import { ToolTree, milestoneTarget, type TreeSettings } from "../tool-tree.js";

const settings: TreeSettings = { mode: "prompt", revealErrors: false, icons: false, iconMode: "ascii", window: 4, groupNestedTools: true, groupProgress: true, groupSparkline: false, groupGutter: true, groupToolNames: true };

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

test("story phases retain failures and open one level at a time", () => {
  const { tree, card } = storyCard();
  const render = (width = 96) => card.render(width);
  const lines = render();
  assert.ok(lines.some(line => line.includes("GROVE / TASK")));
  assert.ok(lines.some(line => line.includes("x 01 Inspect")));
  const phase = lines.findIndex(line => line.includes("! 02 Verify") && line.includes("1 failed"));
  assert.ok(phase >= 0);
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
  assert.ok(narrow.some(line => line.includes("1 failed")));
});

test("story summaries count the whole phase and fit common widths", () => {
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
  assert.equal(settled.filter(line => line.includes("Inspect lengthy configuration item 0")).length, 1, "a visible call is never repeated in the summary");
});

test("expand-all reveals nested steps and Story colors distinguish phase outcomes", () => {
  const { tree } = storyCard();
  const roleTheme = { style: (value: string, options: { fg?: unknown }) => `[${String(options.fg)}]${value}` };
  const row = { toolCallId: "a", inner: { render: () => [], invalidate: () => {} }, theme: roleTheme, expanded: true, invalidate: () => {} };
  const lines = tree.render(row).render(400);
  assert.ok(lines.some(line => line.includes("[success]x 01")));
  assert.ok(lines.some(line => line.includes("[warning]! 02")));
  assert.ok(lines.some(line => line.includes("Request registry")));
});

test("expanded Story rows replace summaries and keep the phase rail through nested tools", () => {
  const { tree } = storyCard();
  const theme = { style: (value: string, options: { fg?: unknown }) => `[${String(options.fg)}]${value}` };
  const card = tree.render({ toolCallId: "a", inner: { render: () => [], invalidate: () => {} }, theme, expanded: true, invalidate: () => {} });
  const lines = card.render(400);
  const phase = lines.find(line => line.includes("! 02") && line.includes("Verify")) ?? "";
  const call = lines.find(line => line.includes("codemode") && line.includes("Check registry")) ?? "";
  const child = lines.find(line => line.includes("bash") && line.includes("Request registry")) ?? "";
  assert.match(phase, /\[warning\]\| /);
  assert.match(call, /\[warning\]\| /, "the phase rail must not change to the call outcome color");
  assert.match(child, /\[warning\]\| /);
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
    assert.equal(phase.indexOf("|", 1), parent.indexOf("|", 1));
    assert.equal(parent.indexOf("|", 1), child.indexOf("|", 1));
    assert.equal(child.indexOf("|", 1), output.indexOf("|", 1));
    assert.ok(output.indexOf("OUTPUT:") > child.indexOf("bash"), "output is nested under its tool");
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
});

test("Story titles wrap from the border without hiding text or breaking targets", () => {
  const intent = "Inspect 東京 settings and verify the complete configuration without losing important details";
  const tree = new ToolTree(settings);
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "Inspect settings", taskIntent: intent, taskProgress: 30, taskMilestones: "inspect=Inspect; verify=Verify", taskMilestone: "inspect" } });
  const card = tree.render({ toolCallId: "a", inner: { render: () => [], invalidate: () => {} }, theme: plainTheme, expanded: false, invalidate: () => {} });
  for (const width of [35, 60, 96]) {
    const lines = card.render(width);
    const header = lines.findIndex(line => line.includes("GROVE / TASK"));

    const title = lines.slice(0, header).map((line, index) => index === 0 ? line.replace(/^\s*\+[-─] /, "").replace(/ [-─]+\+$/, "") : line.replace(/^\s*[|│]\s*/, "").replace(/\s*[|│]$/, "")).join(" ").replace(/\s+/g, " ").trim();
    assert.equal(title, intent, `full title at ${width}`);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    const targetAt = (tree as unknown as { targetAt(index: number): string | undefined }).targetAt.bind(tree);
    for (let i = 1; i < header; i++) assert.equal(targetAt(i), targetAt(0));
    const phase = lines.findIndex(line => line.includes("01 Inspect"));
    assert.equal(targetAt(phase), milestoneTarget("inspect"));
  }
});

test("related calls form independently expandable consecutive groups", () => {
  const tree = new ToolTree(settings);
  const entries = [["a", "Read configuration"], ["b", "Read configuration"], ["c", ""], ["d", "Read configuration"], ["e", "Run checks"]];
  for (const [id, taskGroup] of entries) {
    tree.start({ toolCallId: id, toolName: "codemode", args: { code: `// task-intent: Group checks\n// task-progress: 30\n// task-milestones: inspect=Inspect\n// task-milestone: inspect\n${taskGroup ? `// task-group: ${taskGroup}` : ""}\n// reasoning: action ${id}` } });
    if (id === "a") {
      tree.start({ toolCallId: "nested", parentToolCallId: id, toolName: "bash", args: { reasoning: "Read nested data" } });
      tree.end({ toolCallId: "nested", toolName: "bash", result: { content: [] }, isError: false });
    }
    tree.end({ toolCallId: id, toolName: "codemode", result: { content: [] }, isError: id === "b" });
  }
  const card = tree.render({ toolCallId: "a", inner: { render: () => [], invalidate: () => {} }, theme: plainTheme, expanded: false, invalidate: () => {} });
  const click = (y: number) => card.handleMouse?.({ type: "click", button: "left", x: 0, y, screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false, width: 96, height: 40 });
  let lines = card.render(96);
  click(lines.findIndex(line => line.includes("01 Inspect")));
  lines = card.render(96);
  assert.equal(lines.filter(line => line.includes("Read configuration")).length, 1);
  assert.ok(lines.some(line => line.includes("2 calls") && line.includes("1 failed")));
  assert.ok(lines.some(line => line.includes("action c")), "unlabeled calls remain visible");
  assert.ok(lines.some(line => line.includes("action d")) && lines.some(line => line.includes("action e")), "single-call runs remain visible");
  assert.ok(!lines.some(line => line.includes("Run checks")), "a singleton has no group row");
  assert.ok(!lines.some(line => line.includes("action a")));
  click(lines.findIndex(line => line.includes("Read configuration")));
  lines = card.render(96);
  assert.ok(lines.some(line => line.includes("action a")) && lines.some(line => line.includes("action b")));
  assert.ok(lines.some(line => line.includes("action d")), "later single-call run remains visible");
  assert.ok(!lines.some(line => line.includes("Read nested data")));
  click(lines.findIndex(line => line.includes("action a")));
  lines = card.render(96);
  assert.ok(lines.some(line => line.includes("Read nested data")), "individual calls retain nested disclosure");
  assert.ok(lines.findIndex(line => line.includes("action c")) < lines.findIndex(line => line.includes("action d")));
  for (const width of [35, 60, 96]) assert.ok(card.render(width).every(line => visibleWidth(line) <= width));
});


test("direct failures keep a warning phase after completion in ASCII and Nerd modes", () => {
  for (const iconMode of ["ascii", "nerd"] as const) {
    const tree = new ToolTree({ ...settings, iconMode });
    tree.start({ toolCallId: "a", toolName: "codemode", args: { reasoning: "Attempt checks", taskIntent: "Verify changes", taskProgress: 80, taskMilestones: "verify=Verify", taskMilestone: "verify" } });
    tree.end({ toolCallId: "a", toolName: "codemode", result: { content: [] }, isError: true });
    tree.start({ toolCallId: "b", toolName: "codemode", args: { reasoning: "Finish checks", taskIntent: "Verify changes", taskProgress: 100, taskMilestones: "verify=Verify", taskMilestone: "verify" } });
    tree.end({ toolCallId: "b", toolName: "codemode", result: { content: [] }, isError: false });
    const theme = { style: (value: string, options: { fg?: unknown }) => `[${String(options.fg)}]${value}` };
    const card = tree.render({ toolCallId: "a", inner: { render: () => [], invalidate: () => {} }, theme, expanded: false, invalidate: () => {} });
    const phase = card.render(96).find(line => line.includes("01") && line.includes("Verify")) ?? "";
    assert.ok(phase.includes(`[warning]${iconMode === "ascii" ? "!" : "\uf071"} 01`));
    assert.match(phase, /\[warning\] · 1 failed/);
  }
});


test("a labeled call becomes a group only when a second related call arrives", () => {
  const tree = new ToolTree(settings);
  /** Add one labeled call to the current phase. */
  const add = (id: string) => {
    tree.start({ toolCallId: id, toolName: "codemode", args: { code: `// task-intent: Group checks\n// task-progress: 30\n// task-milestones: inspect=Inspect\n// task-milestone: inspect\n// task-group: Read configuration\n// reasoning: action ${id}` } });
    tree.end({ toolCallId: id, toolName: "codemode", result: { content: [] }, isError: false });
  };
  add("a");
  const card = tree.render({ toolCallId: "a", inner: { render: () => [], invalidate: () => {} }, theme: plainTheme, expanded: false, invalidate: () => {} });
  let lines = card.render(96);
  assert.ok(lines.some(line => line.includes("action a")), "collapsed phase summarizes the lone call");
  card.handleMouse?.({ type: "click", button: "left", x: 0, y: lines.findIndex(line => line.includes("01 Inspect")), screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false, width: 96, height: 40 });
  lines = card.render(96);
  assert.ok(lines.some(line => line.includes("action a")));
  assert.ok(!lines.some(line => line.includes("Read configuration")));
  add("b");
  lines = card.render(96);
  assert.ok(lines.some(line => line.includes("Read configuration") && line.includes("2 calls")));
  assert.ok(!lines.some(line => line.includes("action a") || line.includes("action b")));
});
