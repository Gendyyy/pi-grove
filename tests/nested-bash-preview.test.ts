/**
 * tests/nested-bash-preview.test.ts — expanded nested Bash rows show a command head,
 * a divider and the captured output tail in both card renderers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NestedToolObserver } from "../nested-tools.js";
import { plainTheme } from "../theme.js";
import { linePreview, type TreeSettings } from "../tree-model.js";
import { createState, restoreSegments } from "../tree-state.js";
import { ToolTree, type TreeRow } from "../tool-tree.js";
import { readNested, type ReplayCall } from "../replay.js";

const settings: TreeSettings = {
  mode: "prompt",
  revealErrors: false,
  icons: false,
  iconMode: "ascii",
  window: 10,
  groupNestedTools: true,
  groupProgress: false,
  groupPercent: true,
  groupPhases: true,
  groupSparkline: false,
  groupGutter: false,
  groupToolNames: true,
};

/** Remove ANSI styling so assertions check stable visible text. */
const strip = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, "");
/** Generate numbered lines to exercise head and tail previews. */
const linesOf = (count: number, prefix: string): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");
/** Provide the minimal nested renderer expected by ToolTree. */
const inner = () => ({ render: () => ["inner"], invalidate: () => {} });

/** A card with one codemode parent and one nested call already finished. */
function card(toolName = "bash", command = "", text = ""): ToolTree {
  const tree = new ToolTree(settings);
  tree.start({ toolCallId: "parent", toolName: "codemode", args: { code: "// reasoning: run a step" } });
  const args = toolName === "bash" ? { command } : { path: "file.ts" };
  tree.start({ toolCallId: "child", toolName, parentToolCallId: "parent", args });
  tree.end({
    toolCallId: "child",
    toolName,
    result: { content: [{ type: "text", text }] },
    isError: false,
    durationMs: 5,
  });
  tree.end({ toolCallId: "parent", toolName: "codemode", result: { content: [] }, isError: false, durationMs: 10 });
  return tree;
}

/** Render the card through the parent row, the way pi would. */
function painted(tree: ToolTree, width = 100): string[] {
  const row: TreeRow = { toolCallId: "parent", inner: inner(), theme: plainTheme, expanded: false, invalidate: () => {} };
  return (tree.render(row) as unknown as { render(width: number): string[] }).render(width).map(strip);
}

/** Click the first painted row whose text matches, returning the new frame. */
function click(tree: ToolTree, pattern: RegExp, width = 100): string[] {
  let frame = painted(tree, width);
  const y = frame.findIndex(line => pattern.test(line));
  assert.ok(y >= 0, `row not found: ${pattern}`);
  const row: TreeRow = { toolCallId: "parent", inner: inner(), theme: plainTheme, expanded: false, invalidate: () => {} };
  const component = tree.render(row) as unknown as { handleMouse?: (event: unknown) => void };
  component.handleMouse?.({ type: "click", button: "left", x: 0, y, screenX: 0, screenY: 0, width, height: 40 });
  frame = painted(tree, width);
  return frame;
}

/** Open the codemode row and then the named nested row. */
function expandNested(tree: ToolTree, toolName = "bash"): string[] {
  click(tree, /codemode ·/);
  return click(tree, new RegExp(toolName + " ·"));
}

/** The shared helper keeps a trailing newline from inventing an omitted line. */
test("linePreview counts omissions without a phantom terminal line", () => {
  assert.deepEqual(linePreview("one\ntwo\nthree\nfour\nfive\nsix\nseven", "head"), {
    lines: ["one", "two", "three", "four", "five"],
    omitted: 2,
  });
  assert.deepEqual(linePreview("one\ntwo\nthree\nfour\nfive\nsix\nseven\n", "tail"), {
    lines: ["three", "four", "five", "six", "seven"],
    omitted: 2,
  });
});

test("grouped card shows the actual command head and output tail beyond capture limits", () => {
  const tree = card("bash", linesOf(300, "echo"), linesOf(300, "out"));
  const frame = expandNested(tree).join("\n");
  assert.match(frame, /echo 1/);
  assert.match(frame, /echo 5/);
  assert.doesNotMatch(frame, /\|\s*echo 6\s*\|/, "only five command lines are shown");
  assert.match(frame, /295 more command lines/);
  assert.match(frame, /-{10,}/, "a horizontal divider separates command from output");
  assert.match(frame, /295 earlier output lines/);
  assert.match(frame, /out 300/);
  assert.match(frame, /out 296/);
  assert.doesNotMatch(frame, /out 295/, "only the actual last five output lines are shown");
});

test("grouped card omits no line notes for short commands and output", () => {
  const tree = card("bash", "echo one\necho two", "out one\nout two\n");
  const frame = expandNested(tree).join("\n");
  assert.match(frame, /echo one/);
  assert.match(frame, /echo two/);
  assert.match(frame, /out one/);
  assert.match(frame, /out two/);
  assert.doesNotMatch(frame, /more command lines/);
  assert.doesNotMatch(frame, /earlier output lines/);
  assert.match(frame, /-{10,}/);
});

test("grouped card refreshes the input head when streamed args keep the same target", () => {
  const tree = new ToolTree(settings);
  tree.start({ toolCallId: "parent", toolName: "codemode", args: { code: "// reasoning: stream a command" } });
  tree.start({
    toolCallId: "child",
    toolName: "bash",
    parentToolCallId: "parent",
    args: { command: `${"x".repeat(120)}\necho old` },
  });
  tree.start({
    toolCallId: "child",
    toolName: "bash",
    parentToolCallId: "parent",
    args: { command: `${"x".repeat(120)}\necho new` },
  });
  tree.end({
    toolCallId: "child",
    toolName: "bash",
    result: { content: [{ type: "text", text: "done" }] },
    isError: false,
    durationMs: 5,
  });
  tree.end({ toolCallId: "parent", toolName: "codemode", result: { content: [] }, isError: false, durationMs: 10 });

  const frame = expandNested(tree).join("\n");
  assert.match(frame, /echo new/);
  assert.doesNotMatch(frame, /echo old/);
});

test("expanded nested Bash keeps the divider when command and output are empty", () => {
  const grouped = expandNested(card("bash", "", "")).join("\n");
  const ungrouped = nestedFrame(true, "bash", "", "").join("\n");
  assert.match(grouped, /-{10,}/);
  assert.match(ungrouped, /-{10,}/);
});

test("grouped card keeps the nested Bash preview hidden until both rows are open", () => {
  const tree = card("bash", "echo hidden", "output hidden");
  const collapsed = painted(tree).join("\n");
  assert.doesNotMatch(collapsed, /echo hidden/);
  assert.doesNotMatch(collapsed, /output hidden/);
  click(tree, /codemode ·/);
  const parentOpen = painted(tree).join("\n");
  assert.doesNotMatch(parentOpen, /\|\s*echo hidden\s*\|/, "opening the parent does not open the child");
});

test("grouped card leaves a non-Bash child on its existing preview", () => {
  const tree = card("read", "", "file line one\nfile line two");
  const frame = expandNested(tree, "read").join("\n");
  assert.match(frame, /file line one/);
  assert.match(frame, /file line two/);
  assert.doesNotMatch(frame, /more command lines/);
  assert.doesNotMatch(frame, /earlier output lines/);
});

/** Render the group-off expanded codemode card through the observer's call renderer. */
function nestedFrame(expanded: boolean, toolName = "bash", command = "", text = ""): string[] {
  const observer = new NestedToolObserver();
  observer.start({ toolCallId: "parent", toolName: "codemode", args: {} });
  const args = toolName === "bash" ? { command } : { path: "file.ts" };
  observer.start({ toolCallId: "child", toolName, parentToolCallId: "parent", args });
  observer.end({
    toolCallId: "child",
    toolName,
    result: { content: [{ type: "text", text }] },
    isError: false,
    durationMs: 5,
  });
  const renderers = observer.renderers(false, "ascii");
  const component = renderers.renderCall!(
    {},
    { ...plainTheme, bg: (_role: string, text: string) => text } as never,
    { toolCallId: "parent", args: {}, expanded, isPartial: true, outputPad: 1, invalidate: () => {} } as never,
  );
  return (component as unknown as { render(width: number): string[] }).render(100).map(strip);
}

test("group-off expanded codemode shows the actual output tail beyond capture limits", () => {
  const frame = nestedFrame(true, "bash", linesOf(300, "echo"), linesOf(300, "out")).join("\n");
  assert.match(frame, /echo 1/);
  assert.match(frame, /echo 5/);
  assert.doesNotMatch(frame, /^\s+echo 6\s*$/m);
  assert.match(frame, /295 more command lines/);
  assert.match(frame, /-{10,}/);
  assert.match(frame, /295 earlier output lines/);
  assert.match(frame, /out 300/);
  assert.match(frame, /out 296/);
  assert.doesNotMatch(frame, /out 295/);
});

test("group-off expanded codemode omits no line notes for short values", () => {
  const frame = nestedFrame(true, "bash", "echo one\necho two", "out one\nout two\n").join("\n");
  assert.match(frame, /echo one/);
  assert.match(frame, /out two/);
  assert.doesNotMatch(frame, /more command lines/);
  assert.doesNotMatch(frame, /earlier output lines/);
  assert.match(frame, /-{10,}/);
});

test("group-off collapsed codemode hides the nested Bash preview", () => {
  const frame = nestedFrame(false, "bash", linesOf(8, "echo"), "output hidden").join("\n");
  assert.doesNotMatch(frame, /-{10,}/, "the divider only appears when expanded");
  assert.doesNotMatch(frame, /more command lines/);
  assert.doesNotMatch(frame, /earlier output lines/);
  assert.doesNotMatch(frame, /output hidden/);
});

test("group-off expanded codemode keeps a non-Bash preview unchanged", () => {
  const frame = nestedFrame(true, "read", "", "file line one\nfile line two").join("\n");
  assert.match(frame, /file line one/);
  assert.match(frame, /file line two/);
  assert.doesNotMatch(frame, /more command lines/);
  assert.doesNotMatch(frame, /earlier output lines/);
});

/** Persist and restore nested Bash edges without reconstructing raw commands. */
test("nested Bash snapshot replays bounded command and true tail metadata", () => {
  const observer = new NestedToolObserver();
  const command = linesOf(300, "echo");
  const output = linesOf(300, "out");
  observer.start({ toolCallId: "parent", toolName: "codemode", args: {} });
  observer.start({ toolCallId: "child", toolName: "bash", parentToolCallId: "parent", args: { command } });
  observer.end({
    toolCallId: "child",
    toolName: "bash",
    result: { content: [{ type: "text", text: output }] },
    isError: false,
    durationMs: 5,
  });
  const snapshot = observer.snapshot("parent");
  const saved = snapshot.calls[0]!;
  assert.deepEqual(saved.commandPreview, linesOf(5, "echo").split("\n"));
  assert.equal(saved.commandOmitted, 295);
  assert.equal(saved.outputTail, true);
  assert.equal(saved.outputOmitted, 295);
  assert.deepEqual(saved.preview?.split("\n"), output.split("\n").slice(-5));
  assert.equal("command" in saved, false, "the complete command is not persisted");

  const child = readNested({ piGroveNested: snapshot })[0]!;
  const parent: ReplayCall = {
    id: "parent",
    name: "codemode",
    args: { code: "// reasoning: replay nested Bash" },
    isError: false,
    status: "success",
    started: 1,
    children: [child],
  };
  const state = createState();
  restoreSegments(state, [{ calls: [parent] }]);
  const restored = [...state.groups.values()][0]!.nodes.get("child")!;
  assert.deepEqual(restored.inputPreview, linesOf(5, "echo").split("\n"));
  assert.equal(restored.inputOmitted, 295);
  assert.deepEqual(restored.preview, output.split("\n").slice(-5));
  assert.equal(restored.outputTail, true);
  assert.equal(restored.outputOmitted, 295);

  const frame = recordedFrame({ details: { piGroveNested: snapshot } }).join("\n");
  assert.match(frame, /out 300/);
  assert.match(frame, /295 earlier output lines/);
  assert.doesNotMatch(frame, /out 295/);
});

/** Render a stored nested snapshot through the completed codemode result renderer. */
function recordedFrame(result: unknown): string[] {
  const renderers = new NestedToolObserver().renderers(false, "ascii");
  const component = renderers.renderResult!(
    result as never,
    { expanded: true } as never,
    { ...plainTheme, bg: (_role: string, text: string) => text } as never,
    {
      toolCallId: "parent",
      args: {},
      expanded: true,
      isPartial: false,
      outputPad: 1,
      invalidate: () => {},
    } as never,
  );
  return (component as unknown as { render(width: number): string[] }).render(100).map(strip);
}

/** Old snapshots remain ordinary previews instead of being misrepresented as tails. */
test("legacy nested snapshot keeps its head preview and has no tail divider", () => {
  const frame = recordedFrame({
    details: {
      piGroveNested: {
        version: 3,
        calls: [{
          id: "child",
          parent: "parent",
          name: "bash",
          reasoning: "",
          target: "echo legacy",
          status: "success",
          preview: linesOf(8, "legacy"),
          previewTruncated: true,
          command: "echo legacy",
        }],
      },
    },
  }).join("\n");
  assert.match(frame, /legacy 1/);
  assert.match(frame, /legacy 8/);
  assert.doesNotMatch(frame, /-{10,}/);
  assert.doesNotMatch(frame, /earlier output lines/);
});
