/**
 * tests/words.test.ts — words become glyphs only when the terminal font can draw them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { errorCell, treeGlyphs, toolBreakdown, type TreeNode } from "../tree-model.js";
import { ToolTree, type TreeSettings } from "../tool-tree.js";
import { buildToolBlock, summarizeToolResult } from "../block-render.js";
import { hasToolGlyph, markFor, toolIcon, toolWord } from "../icons.js";
import { plainTheme } from "../theme.js";

const READ = "\uf15c";
const CODEMODE = "\uf121";
const BASH = "\uf120";
const STOP = "\uf05e";
const CHECK = "\uf00c";
const CROSS = "\uf00d";

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
    groupToolNames: true,
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
  return painted.slice(1).map(line => line.replace(/^[▌│|] ?/, "").replace(/ ?[▌│|]$/, "").trim());
}

test("a nerd font adds the tool glyph and still names the tool", () => {
  const tree = new ToolTree(settings("nerd"));
  tree.boundary("turn");
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "check the manifest" } });
  const painted = lines(tree, "a");
  const body = painted.join(String.fromCharCode(10));
  // The glyph is an indicator, never a replacement: the row still says "read".
  assert.match(painted[0]!, /GROVE/, "the card leads with its own name");
  assert.match(body, /1 call/, "the card still counts the call");
  assert.match(body, new RegExp(READ + "  read"), "the glyph sits ahead of the word it stands for");
});

test("built-in names can be replaced by icons without hiding custom names", () => {
  const tree = new ToolTree(settings("nerd", { groupToolNames: false }));
  tree.boundary("turn");
  tree.start({ toolCallId: "code", toolName: "codemode", args: {} });
  tree.start({ toolCallId: "child", toolName: "bash", parentToolCallId: "code", args: {} });
  tree.start({ toolCallId: "custom", toolName: "my_custom_tool", args: {} });
  const output = lines(tree, "code").join("\n");

  assert.ok(output.includes(CODEMODE), JSON.stringify(output));
  assert.ok(output.includes(BASH), JSON.stringify(output));
  assert.doesNotMatch(output, /codemode|bash/);
  assert.match(output, /my_custom_tool/, "custom names stay readable");

  const iconsOff = new ToolTree(settings("nerd", { groupToolNames: false, icons: false }));
  iconsOff.start({ toolCallId: "bash", toolName: "bash", args: {} });
  const nerdOnly = lines(iconsOff, "bash").join("\n");
  assert.ok(nerdOnly.includes(BASH), JSON.stringify(nerdOnly));
  assert.doesNotMatch(nerdOnly, /bash/);

  const ascii = new ToolTree(settings("ascii", { groupToolNames: false, icons: false }));
  ascii.start({ toolCallId: "ascii", toolName: "codemode", args: {} });
  const asciiOnly = lines(ascii, "ascii").join("\n");
  assert.match(asciiOnly, /\[<>\]/);
  assert.doesNotMatch(asciiOnly, /codemode/);
});

test("the nerd icon mode paints the unicode state cues", () => {
  const plan = "inspect=Inspect; build=Build";
  /** Paint a card whose first phase finished, so the meter carries a share. */
  const paint = (iconMode: "nerd" | "ascii"): string => {
    const tree = new ToolTree(settings(iconMode));
    tree.start({ toolCallId: "a", toolName: "read", args: { taskIntent: "Finish the retry fix", taskMilestones: plan, taskMilestone: "inspect" } });
    tree.end({ toolCallId: "a", toolName: "read", result: { content: [] }, isError: false });
    tree.start({ toolCallId: "b", toolName: "read", args: { taskIntent: "Finish the retry fix", taskMilestones: plan, taskMilestone: "build" } });
    return lines(tree, "a").join(String.fromCharCode(10));
  };

  const nerd = paint("nerd");
  assert.ok(/[▰▱]/.test(nerd), "the meter paints a bar");
  assert.match(nerd, /[◔◑◕○●]/, "the meter cue is the unicode pie: " + JSON.stringify(nerd));
  assert.match(nerd, /[├└]─/, "branch guides come from the unicode table: " + JSON.stringify(nerd));
  assert.ok(!/[▸▾]/.test(nerd), "no chevron survives in the card: " + JSON.stringify(nerd));

  const ascii = paint("ascii");
  assert.ok(/[▰▱]/.test(ascii), "the meter paints a bar");
  assert.ok(!/[\uE000-\uF8FF]/.test(ascii), JSON.stringify(ascii));
});

test("the same card keeps every word on a plain terminal", () => {
  const tree = new ToolTree(settings("ascii"));
  tree.boundary("turn");
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "check the manifest" } });
  const body = lines(tree, "a").join(String.fromCharCode(10));
  assert.match(body, /read · check the manifest/, "the plain terminal keeps the word");
  assert.doesNotMatch(body, new RegExp(READ), "no private-use glyph leaks into the plain card");
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

test("every bundled tool has an icon of its own", () => {
  const bundled = [
    "read", "write", "edit", "bash", "grep", "find", "ls", "codemode",
    "compress", "decompress", "search_context", "acp_status", "acp_cache",
    "acp_read_original_image", "ffgrep", "fffind", "generate_image", "web_enable",
    "web_search", "fetch_content", "get_search_content", "source_check", "ask_user_question",
  ];
  for (const name of bundled) assert.equal(hasToolGlyph(name), true, name + " has no icon");
  // Two tools sharing a glyph would make the icon-only row a guess.
  for (const mode of ["nerd", "ascii"] as const) {
    const drawn = bundled.map(name => toolIcon(name, mode));
    assert.equal(new Set(drawn).size, drawn.length, "two tools share a glyph in " + mode);
  }
  // Both are double chevrons, so the direction alone has to separate the pair.
  assert.equal(toolIcon("compress", "nerd"), "\uf103");
  assert.equal(toolIcon("decompress", "nerd"), "\uf102");
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
  const row = lines(tree, "a").find(line => line.includes("check the manifest")) ?? "";
  assert.ok(row.includes(READ + "  read · check the manifest"), JSON.stringify(row));
});

test("a plain word keeps its single space before the dot", () => {
  const tree = new ToolTree(settings("ascii"));
  tree.boundary("turn");
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "check the manifest" } });
  assert.ok((lines(tree, "a").find(line => line.includes("check the manifest")) ?? "").includes("read · check the manifest"));
});

test("the standalone card pads its label the same way", () => {
  const block = buildToolBlock("read", { reasoning: "check the manifest" }, {}, { isError: false, isPartial: false, executionStarted: true, expanded: false, elapsedMs: 900, mode: "reasoning", icons: true, iconMode: "nerd", width: 96, theme: plainTheme });
  assert.ok(block.some(line => line.includes(READ + "  read")), JSON.stringify(block));
});