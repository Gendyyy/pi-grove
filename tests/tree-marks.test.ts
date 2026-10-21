// State markers on grouped rows: the dot reports the call state instead of an expand arrow.
import assert from "node:assert/strict";
import test from "node:test";
import { ToolTree, type TreeRow, type TreeSettings } from "../tool-tree.js";
import type { GroveTheme } from "../theme.js";

const theme: GroveTheme = { style: (text, options) => "[" + (options.fg ?? "-") + "]" + text };
const settings: TreeSettings = { mode: "prompt", revealErrors: true, icons: false, iconMode: "ascii", window: 4 };
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
  card(tree).handleMouse?.(click(0));
  return card(tree).render(96).map(plain);
}

test("a settled call shows a filled dot in its status colour", () => {
  const tree = new ToolTree(settings);
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the typecheck" } });
  tree.end({ toolCallId: "a", toolName: "bash", result: { content: [] }, durationMs: 900 } as never, undefined);
  tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "run the tests" } });
  tree.end({ toolCallId: "b", toolName: "bash", result: { content: [] }, isError: true, durationMs: 800 } as never, undefined);
  const [head, ok, failed] = painted(tree) as [string, string, string];
  assert.match(head!, /\[dim\]/);
  assert.doesNotMatch(head!, /warning/);
  assert.match(ok!, /\[success\]\*/);
  assert.match(failed!, /\[error\]\*/);
  assert.doesNotMatch(ok!, /error/);
});

test("a running call pulses between the filled and the outline dot", () => {
  const real = Date.now;
  try {
    const tree = new ToolTree(settings);
    tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "read the schema" } });
    tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "run the tests" } });
    const base = 1_000_000;
    Date.now = () => base;
    const on = painted(tree)[2]!;
    Date.now = () => base + 450;
    const off = painted(tree)[2]!;
    assert.match(on, /\[warning\]\*/);
    assert.match(off, /\[warning\]o/);
    assert.notEqual(on, off);
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
  assert.match(head, /\[dim\]/);
  assert.doesNotMatch(head, /warning/);
});
