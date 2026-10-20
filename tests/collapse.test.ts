// Tests the collapsible codemode card: newest-calls window, group-safe cuts, settled fold.
import assert from "node:assert/strict";
import { NestedToolObserver } from "../nested-tools.ts";
import { plainTheme } from "../theme.ts";

const WIDTH = 100;
const theme: any = { ...plainTheme, fg: (_t: string, text: string) => text, bg: (_t: string, text: string) => text };

/** Strips ANSI styling so assertions read plain text. */
function plain(lines: string[]): string[] {
  return lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd());
}

/** Builds a render context stub for the card renderers. */
function context(id: string, isPartial: boolean, expanded: boolean): any {
  return { toolCallId: id, isPartial, expanded, outputPad: 1, lastComponent: undefined, invalidate: () => {}, args: {} };
}

/** Builds codemode args carrying a goal comment plus script body. */
function args(goal: string, code = "x"): any {
  return { reasoning: goal, code: "// reasoning: " + goal + "\n" + code };
}

/** Renders the card for one observer and returns plain text lines. */
function render(observer: NestedToolObserver, collapsedCalls: number, expanded: boolean, settled: boolean, goal: string, id: string): string[] {
  const renderers = (observer as any).renderers(true, "ascii", collapsedCalls) as any;
  if (!settled) {
    return plain(renderers.renderCall(args(goal), theme, context(id, true, expanded)).render(WIDTH));
  }
  const result = { content: [], details: { piLiuovoNested: observer.snapshot(id) } };
  const ctx = { ...context(id, false, expanded), args: args(goal), isError: false, durationMs: 4200 };
  return plain(renderers.renderResult(result, { expanded, isPartial: false }, theme, ctx).render(WIDTH));
}

/** Starts a child tool call inside a parent codemode script. */
function startChild(observer: NestedToolObserver, id: string, name: string, goal: string, parent: string, extra: any = {}): void {
  observer.start({ toolCallId: id, toolName: name, args: { reasoning: goal, ...extra }, parentToolCallId: parent });
}

/** Records a successful child result with two output lines. */
function endChild(observer: NestedToolObserver, id: string): void {
  observer.end(
    { toolCallId: id, toolName: "read", isError: false, durationMs: 120, result: { content: [{ type: "text", text: "line one\nline two" }] } },
    {},
  );
}

/** Builds a parent codemode call with N finished and one running child. */
function runningCard(count: number, goal = "inspect panel layout"): NestedToolObserver {
  const observer = new NestedToolObserver(() => {});
  observer.start({ toolCallId: "p", toolName: "codemode", args: args(goal) });
  const names = ["read", "grep", "bash", "read", "edit", "bash", "read", "ls"];
  for (let i = 0; i < count; i++) {
    startChild(observer, "c" + i, names[i % names.length]!, "step " + i, "p", { path: "f" + i + ".ts", command: "run " + i });
    if (i < count - 1) endChild(observer, "c" + i);
  }
  return observer;
}

// The running card windows the newest calls and hides the rest behind a footer.
{
  const lines = render(runningCard(8), 5, false, false, "inspect panel layout", "p");
  assert.equal(lines.length, 12, "header + five rows + footer shows 12 lines");
  assert.match(lines[0]!, /codemode inspect panel layout/, "header keeps the goal");
  assert.ok(!lines.join("\n").includes("step 2"), "the oldest steps scroll out of the window");
  assert.match(lines[lines.length - 1]!, /… 3 earlier calls · Ctrl\+O to expand/, "footer counts the hidden calls");
}

// Expanding shows every call plus the script section.
{
  const lines = render(runningCard(8), 5, true, false, "inspect panel layout", "p").join("\n");
  for (let i = 0; i < 8; i++) assert.ok(lines.includes("step " + i), "expanded card keeps step " + i);
  assert.ok(lines.includes("Script"), "expanded card appends the script section");
}

// A settled card collapses to the heading plus the expand hint only.
{
  const lines = render(runningCard(8), 5, false, true, "inspect panel layout", "p");
  assert.equal(lines.length, 2, "settled collapsed card is heading + hint");
  assert.match(lines[0]!, /8 calls/, "heading keeps the call count");
  assert.match(lines[1]!, /… 8 calls · Ctrl\+O or click to expand/, "hint offers both expand paths");
}

// Window cuts land on group boundaries, so a shared heading is re-emitted.
{
  const observer = new NestedToolObserver(() => {});
  observer.start({ toolCallId: "q", toolName: "codemode", args: args("dedupe headings") });
  for (let i = 0; i < 4; i++) {
    startChild(observer, "g" + i, "read", "shared goal", "q", { path: "f" + i + ".ts" });
    endChild(observer, "g" + i);
  }
  const lines = render(observer, 2, false, false, "dedupe headings", "q");
  assert.equal(lines.length, 5, "header, one heading row, two call rows, one footer");
  assert.match(lines[1]!, /read shared goal/, "the shared heading survives a mid-group cut");
  assert.ok(lines[2]!.includes("f2.ts") && lines[3]!.includes("f3.ts"), "only the newest two calls remain");
  const wide = render(observer, 8, false, false, "dedupe headings", "q");
  assert.ok(!wide[wide.length - 1]!.includes("earlier"), "a window larger than the group adds no footer");
}

// The configured window is clamped to the documented maximum.
{
  const lines = render(runningCard(8), 99, false, false, "inspect panel layout", "p");
  assert.ok(!lines.join("\n").includes("earlier"), "an out-of-range window never truncates");
}

console.log("collapse tests passed");
