/**
 * tests/words.test.ts — words become glyphs only when the terminal font can draw them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { errorCell, treeGlyphs, toolBreakdown, type TreeNode } from "../tree-model.js";
import { ToolTree, type TreeSettings } from "../tool-tree.js";
import { summarizeToolResult } from "../block-render.js";
import { hasToolGlyph, markFor, toolWord } from "../icons.js";
import { plainTheme } from "../theme.js";

const READ = "\uf15c";
const CHECK = "\uf00c";
const CROSS = "\uf00d";
const STOP = "\uf05e";

/** Tree settings with the glyph style switched on. */
function settings(iconMode: "nerd" | "ascii", overrides: Partial<TreeSettings> = {}): TreeSettings {
  return { mode: "turn", revealErrors: true, icons: true, iconMode, window: 4, ...overrides };
}

/** A renderer row as pi hands it to the tree. */
function row(id: string): { toolCallId: string; inner: Component; theme: typeof plainTheme; expanded: boolean; invalidate: () => void } {
  return { toolCallId: id, inner: { render: () => ["inner"], invalidate: () => {} }, theme: plainTheme, expanded: false, invalidate: () => {} };
}

/** Painted lines with host padding trimmed. */
function lines(tree: ToolTree, id: string): string[] {
  return tree.render(row(id)).render(90).map(line => line.trim());
}

test("a nerd font drops the tool word from the headline and the row", () => {
  const tree = new ToolTree(settings("nerd"));
  tree.boundary("turn");
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "check the manifest" } });
  const painted = lines(tree, "a");
  assert.match(painted[0]!, new RegExp(READ));
  assert.match(painted[0]!, /1/);
  assert.doesNotMatch(painted[0]!, /read/);
  assert.doesNotMatch(painted[1]!, /read/);
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

test("a tool without a glyph still says which tool ran", () => {
  assert.equal(hasToolGlyph("read"), true);
  assert.equal(hasToolGlyph("mcp__db__lookup"), false);
  assert.match(toolWord("mcp__db__lookup", "nerd"), /mcp__db__lookup/);
  assert.equal(toolWord("read", "nerd"), READ);
  assert.equal(toolWord("read", "ascii"), "read");
});

test("the breakdown mixes glyphs and counts", () => {
  const nodes: TreeNode[] = [
    { id: "1", seq: 1, name: "read", goal: "", target: "", status: "success", started: 0, children: [] },
    { id: "2", seq: 2, name: "read", goal: "", target: "", status: "success", started: 0, children: [] },
    { id: "3", seq: 3, name: "bash", goal: "", target: "", status: "success", started: 0, children: [] },
  ];
  const glyphs = toolBreakdown(nodes, plainTheme, treeGlyphs("nerd"), 4, true, "nerd");
  const g = treeGlyphs("nerd");
  assert.deepEqual(glyphs, [READ + " " + g.times + "2", "\uf120 " + g.times + "1"]);
});
