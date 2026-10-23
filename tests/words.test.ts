/**
 * tests/words.test.ts — words become glyphs only when the terminal font can draw them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { errorCell, treeGlyphs, toolBreakdown, type TreeNode } from "../tree-model.js";
import { ToolTree, type TreeSettings } from "../tool-tree.js";
import { buildToolBlock, summarizeToolResult } from "../block-render.js";
import { hasToolGlyph, markFor, toolWord } from "../icons.js";
import { plainTheme } from "../theme.js";

const READ = "\uf15c";
const CHECK = "\uf00c";
const CROSS = "\uf00d";
const STOP = "\uf05e";
const PERCENT = "";

/** Tree settings with the glyph style switched on. */
function settings(iconMode: "nerd" | "ascii", overrides: Partial<TreeSettings> = {}): TreeSettings {
  return {
    mode: "turn",
    revealErrors: true,
    icons: true,
    iconMode,
    window: 4,
    groupNestedTools: true,
    groupProgress: true,
    groupSparkline: true,
    groupGutter: true,
    ...overrides,
  };
}

/** A renderer row as pi hands it to the tree. */
function row(id: string): { toolCallId: string; inner: Component; theme: typeof plainTheme; expanded: boolean; invalidate: () => void } {
  return { toolCallId: id, inner: { render: () => ["inner"], invalidate: () => {} }, theme: plainTheme, expanded: false, invalidate: () => {} };
}

/** Painted lines with host padding trimmed. */
function lines(tree: ToolTree, id: string): string[] {
  const painted = tree.render(row(id)).render(90).map(line => line.replace(/\u001b\[[0-9;]*m/g, "").trim());
  // The card is one bordered object now, so the body is what the assertions index.
  if (painted.length < 2 || !/^[╭+┌][-─]/.test(painted[0]!)) return painted;
  return painted.slice(1, -1).map(line => line.replace(/^[▌│|] ?/, "").replace(/ ?[▌│|]$/, "").trim());
}

test("a nerd font adds the tool glyph and still names the tool", () => {
  const tree = new ToolTree(settings("nerd"));
  tree.boundary("turn");
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "check the manifest" } });
  const painted = lines(tree, "a");
  // The glyph is an indicator, never a replacement: the row still says "read".
  assert.match(painted[0]!, /read/);
  assert.match(painted[0]!, /1/);
  assert.match(painted[1]!, new RegExp(READ));
  assert.match(painted[1]!, /read/);
});

test("a Nerd Font percent icon sits beside the progress meter", () => {
  const nerd = new ToolTree(settings("nerd"));
  nerd.start({ toolCallId: "a", toolName: "read", args: { taskIntent: "Finish the retry fix", taskProgress: 35 } });
  const nerdRollup = lines(nerd, "a")[0]!;
  assert.ok(nerdRollup.includes(PERCENT + "  ▰"), JSON.stringify(nerdRollup));

  const ascii = new ToolTree(settings("ascii"));
  ascii.start({ toolCallId: "a", toolName: "read", args: { taskIntent: "Finish the retry fix", taskProgress: 35 } });
  const asciiRollup = lines(ascii, "a")[0]!;
  assert.ok(asciiRollup.includes("▰"));
  assert.ok(!asciiRollup.includes(PERCENT), JSON.stringify(asciiRollup));
});

test("the same card keeps every word on a plain terminal", () => {
  const tree = new ToolTree(settings("ascii"));
  tree.boundary("turn");
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "check the manifest" } });
  const painted = lines(tree, "a");
  assert.match(painted[0]!, /read/);
  assert.doesNotMatch(painted[0]!, new RegExp(READ));
});

test("an outstanding outcome becomes one coloured glyph", () => {
  assert.equal(markFor("error", "nerd"), CROSS);
  assert.equal(markFor("cancelled", "nerd"), STOP);
  assert.equal(markFor("error", "ascii"), undefined);
  assert.equal(errorCell(2, plainTheme, true, "nerd"), CROSS + " 2");
  assert.equal(errorCell(1, plainTheme, true, "ascii"), "1 error");
});

test("a bash outcome says what happened without the word for it", () => {
  const result = { exit_code: 0, wall_time_seconds: 3 };
  const glyphs = summarizeToolResult("bash", result, false, {}, undefined, plainTheme, true, "nerd");
  assert.match(glyphs, new RegExp(CHECK));
  assert.doesNotMatch(glyphs, /done|in /);
  const words = summarizeToolResult("bash", result, false, {}, undefined, plainTheme, true, "ascii");
  assert.match(words, /done/);
});

test("counts shorten to a unit letter only when glyphs are on", () => {
  const body = { content: [{ type: "text", text: new Array(12).fill("line").join("\n") }] };
  const summary = summarizeToolResult("read", body, false, {}, undefined, plainTheme, true, "nerd");
  assert.match(summary, /12 L/);
  const words = summarizeToolResult("read", body, false, {}, undefined, plainTheme, true, "ascii");
  assert.match(words, /12 lines/);
});

test("a tool word always stays next to its glyph", () => {
  assert.equal(hasToolGlyph("read"), true);
  assert.equal(hasToolGlyph("mcp__db__lookup"), false);
  assert.match(toolWord("mcp__db__lookup", "nerd"), /mcp__db__lookup/);
  assert.equal(toolWord("read", "nerd"), READ + "  read");
  assert.equal(toolWord("read", "ascii"), "read");
});

test("the breakdown names tools in words, like the mock", () => {
  const nodes: TreeNode[] = [
    { id: "1", seq: 1, name: "read", goal: "", target: "", status: "success", started: 0, children: [] },
    { id: "2", seq: 2, name: "read", goal: "", target: "", status: "success", started: 0, children: [] },
    { id: "3", seq: 3, name: "bash", goal: "", target: "", status: "success", started: 0, children: [] },
  ];
  const glyphs = toolBreakdown(nodes, plainTheme, treeGlyphs("nerd"), 4, true, "nerd");
  const g = treeGlyphs("nerd");
  assert.deepEqual(glyphs, ["read " + g.times + "2", "bash " + g.times + "1"]);
});

test("the glyph keeps a gap ahead of the tool word", () => {
  const tree = new ToolTree(settings("nerd"));
  tree.boundary("turn");
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "check the manifest" } });
  const row = lines(tree, "a")[1]!;
  assert.ok(row.includes(READ + "  read · check the manifest"), JSON.stringify(row));
});

test("a plain word keeps its single space before the dot", () => {
  const tree = new ToolTree(settings("ascii"));
  tree.boundary("turn");
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "check the manifest" } });
  assert.ok(lines(tree, "a")[1]!.includes("read · check the manifest"));
});

test("the standalone card pads its label the same way", () => {
  const block = buildToolBlock("read", { reasoning: "check the manifest" }, {}, { isError: false, isPartial: false, executionStarted: true, expanded: false, elapsedMs: 900, mode: "reasoning", icons: true, iconMode: "nerd", width: 96, theme: plainTheme });
  assert.ok(block.some(line => line.includes(READ + "  read")), JSON.stringify(block));
});