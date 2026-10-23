// State markers on grouped rows: the dot reports the call state instead of an expand arrow.
import assert from "node:assert/strict";
import test from "node:test";
import { ToolTree, type TreeRow, type TreeSettings } from "../tool-tree.js";
import type { GroveTheme } from "../theme.js";

const theme: GroveTheme = { style: (text, options) => "[" + (options.fg ?? "-") + "]" + text };
const settings: TreeSettings = { mode: "prompt", revealErrors: false, icons: false, iconMode: "ascii", window: 4 };
const inner = () => ({ render: () => ["inner"], invalidate: () => {} });
const row = (id: string): TreeRow => ({ toolCallId: id, inner: inner(), theme, expanded: false, invalidate: () => {} });
const click = (y: number) => ({ type: "click", button: "left", x: 0, y, screenX: 0, screenY: 0, width: 96, height: 40 });
const plain = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");
const card = (tree: ToolTree, id = "a") => tree.render(row(id)) as unknown as {
  handleMouse?: (event: unknown) => unknown;
  render(width: number): string[];
};

/** Paint the group with every row revealed. */
function painted(tree: ToolTree): string[] {
  // The header is the first line inside the frame, so the raw frame index is 1.
  card(tree).handleMouse?.(click(1));
  // This theme tags text instead of emitting escapes, so the frame is sliced, not parsed.
  return card(tree).render(96).map(plain).slice(1, -1);
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
  const headerMarker = head!.split(" · ")[0]!;
  assert.match(headerMarker, /\[dim\]/);
  assert.doesNotMatch(headerMarker, /warning/);
  assert.match(ok!, /\[success\]\*/);
  assert.match(failed!, /\[error\]\*/);
  assert.doesNotMatch(ok!, /error/);
});

test("a running call spins through the frame ramp", () => {
  const real = Date.now;
  try {
    const tree = new ToolTree(settings);
    tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "read the schema" } });
    tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "run the tests" } });
    const base = 1_000_000;
    const marker = (offset: number): string => {
      Date.now = () => base + offset;
      const row = painted(tree)[2]!;
      const found = /\[warning\]([^ ])/.exec(row);
      assert.ok(found, `expected a spinner frame in ${JSON.stringify(row)}`);
      return found[1]!;
    };
    // One frame per tick, each a single cell the terminal can rotate in place.
    const frames = [0, 100, 200, 300].map(marker);
    assert.deepEqual(frames, ["|", "/", "-", "\\"]);
    // Halfway through the ramp the marker is a different cell, not a blink out.
    assert.notEqual(marker(100), marker(0));
    // The ramp wraps, so a long call keeps turning instead of stopping on the last frame.
    assert.equal(marker(400), marker(0));
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
