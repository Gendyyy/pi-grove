/**
 * tests/tool-tree.test.ts — behaviour of the clickable per-turn tool tree.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { GROUP_TARGET, ToolTree, paintGroup, type TreeGroup, type TreeRow, type TreeSettings } from "../tool-tree.js";
import { plainTheme } from "../theme.js";

/** Build settings with plain ASCII glyphs so assertions stay readable. */
function settings(overrides: Partial<TreeSettings> = {}): TreeSettings {
  return { mode: "turn", revealErrors: true, icons: false, iconMode: "ascii", window: 4, ...overrides };
}

/** Minimal pi component standing in for a renderer result. */
function inner(): Component {
  return { render: () => ["inner"], invalidate: () => {} };
}

/** One renderer row as pi would hand it to the tree. */
function row(id: string, expanded = false): TreeRow {
  return { toolCallId: id, inner: inner(), theme: plainTheme, expanded, invalidate: () => {} };
}

/** A left click event with coordinates local to the card. */
function click(y: number): TuiMouseEvent {
  return { type: "click", button: "left", x: 0, y, screenX: 0, screenY: 0, width: 80, height: 40 } as unknown as TuiMouseEvent;
}

/** Let queued repaints run, the way pi would on its next frame. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

/** Rendered lines with the host padding trimmed. */
function lines(component: Component, width = 80): string[] {
  return component.render(width).map(line => line.trim());
}

test("a single call still leads with the group headline", () => {
  const tree = new ToolTree(settings());
  tree.boundary("turn");
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "check the manifest" } });
  const painted = lines(tree.render(row("a")));
  // The frame never disappears: the headline says what the turn did, the row is detail.
  assert.equal(painted.length, 2);
  assert.match(painted[0]!, /1 call/);
  assert.match(painted[0]!, /read x1/);
  assert.match(painted[1]!, /check the manifest/);
  assert.match(painted[1]!, /running/);
});

test("the card stays on the first call and grows in place", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "check the manifest" } });
  assert.equal(lines(tree.render(row("a"))).length, 2);

  tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "run the tests" } });
  // The newest call must not move the card: a moving card reflows on every call.
  assert.deepEqual(tree.render(row("b")).render(80), []);
  const card = lines(tree.render(row("a")));
  assert.equal(card.length, 3);
  assert.match(card[0]!, /2 calls/);
  assert.match(card[1]!, /read/);
  assert.match(card[2]!, /bash/);
});

test("a streaming call joins the card instead of painting itself", async () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the tests" } });
  assert.equal(lines(tree.render(row("a"))).length, 2);

  // pi mounts the next row while its arguments are still streaming.
  tree.ensure("b", "codemode", { code: "// reasoning: build the card" });
  await flush();
  const card = lines(tree.render(row("a")));
  assert.equal(card.length, 3);
  assert.match(card[2]!, /build the card/);
  // Its own row stays blank, so the same call never appears as a second block.
  assert.deepEqual(tree.render(row("b")).render(80), []);
});

test("a streaming row stops repainting once its text settles", async () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  let repaints = 0;
  const streaming = (args: Record<string, unknown>): Component => {
    tree.ensure("a", "bash", args);
    return tree.render({
      toolCallId: "a",
      inner: inner(),
      theme: plainTheme,
      expanded: false,
      invalidate: () => {
        repaints += 1;
      },
      phase: "call",
    });
  };

  streaming({ reasoning: "run the tests" });
  await flush();
  // pi repaints the chat container for every streaming chunk. An unchanged row that asks
  // for another repaint feeds the render loop forever and freezes the session.
  for (let pass = 0; pass < 5; pass += 1) {
    streaming({ reasoning: "run the tests" });
    await flush();
  }
  assert.equal(repaints, 0);

  streaming({ reasoning: "run the tests", command: "npm test" });
  await flush();
  assert.equal(repaints, 1, "new arguments still repaint the card");

  for (let pass = 0; pass < 3; pass += 1) {
    streaming({ reasoning: "run the tests", command: "npm test" });
    await flush();
  }
  assert.equal(repaints, 1, "a settled row stops asking for repaints");
});

test("clicking a codemode row reveals its nested steps", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "c", toolName: "codemode", args: { code: "// reasoning: build the card\nreturn 1;" } });
  tree.start({ toolCallId: "c1", toolName: "bash", parentToolCallId: "c", args: { reasoning: "list files" } });
  tree.start({ toolCallId: "c2", toolName: "read", parentToolCallId: "c", args: { reasoning: "read the entry" } });
  const card = tree.render(row("c"));
  const before = lines(card);
  assert.equal(before.length, 2);
  assert.match(before[0]!, /1 call/);
  assert.match(before[0]!, /codemode x1/);
  // A branch row names the mix of steps it holds instead of a bare count.
  assert.match(before[1]!, /bash x1/);
  assert.match(before[1]!, /read x1/);
  assert.doesNotMatch(before.join(" "), /list files/);

  // The headline also names codemode, so match the row by its own goal text.
  const y = before.findIndex(line => line.includes("build the card"));
  card.handleMouse?.(click(y));
  const after = lines(tree.render(row("c")));
  assert.equal(after.length, 4);
  assert.match(after[2]!, /list files/);
  assert.match(after[3]!, /read the entry/);
});

test("the header reveals every row but opens no level", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "c", toolName: "codemode", args: { code: "// reasoning: build the card" } });
  tree.start({ toolCallId: "c1", toolName: "bash", parentToolCallId: "c", args: { reasoning: "list files" } });
  tree.start({ toolCallId: "d", toolName: "bash", args: { reasoning: "run the tests" } });
  const card = tree.render(row("c"));
  card.handleMouse?.(click(0));
  const revealed = lines(tree.render(row("c")));
  // Every call is listed, and each row still waits for its own click.
  assert.equal(revealed.length, 3);
  assert.match(revealed[2]!, /run the tests/);
  assert.doesNotMatch(revealed.join(" "), /list files/);

  // The header also names codemode in its mix, so match the row by its own goal.
  const y = revealed.findIndex(line => line.includes("build the card"));
  const card2 = tree.render(row("c"));
  card2.handleMouse?.(click(y));
  const drilled = lines(tree.render(row("c")));
  assert.match(drilled.join(" "), /list files/);
});

test("an unknown line falls through to pi's own expand toggle", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the tests" } });
  const card = tree.render(row("a"));
  assert.equal(card.handleMouse?.(click(9)), undefined);
  assert.equal(card.handleMouse?.({ ...click(0), button: "right" }), undefined);
});

test("turn boundaries separate cards, message boundaries do not", () => {
  const turns = new ToolTree(settings());
  turns.start({ toolCallId: "a", toolName: "read", args: { reasoning: "first turn" } });
  turns.boundary("turn");
  turns.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "second turn" } });
  assert.equal(lines(turns.render(row("a"))).length, 2);
  assert.equal(lines(turns.render(row("b"))).length, 2);

  const messages = new ToolTree(settings({ mode: "message" }));
  messages.start({ toolCallId: "a", toolName: "read", args: { reasoning: "first turn" } });
  messages.boundary("turn");
  messages.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "second turn" } });
  assert.equal(lines(messages.render(row("a"))).length, 3);
});

test("only one of the two pi rows paints a call", async () => {
  let callRepaints = 0;
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the tests" } });
  const callRow = { ...row("a"), phase: "call" as const, invalidate: () => { callRepaints += 1; } };
  assert.equal(lines(tree.render(callRow)).length, 2);

  // The result row takes the card over and blanks the row that painted it.
  const resultRow = { ...row("a"), phase: "result" as const };
  assert.equal(lines(tree.render(resultRow)).length, 2);
  await flush();
  assert.ok(callRepaints >= 1, "the call row is repainted so it can render nothing");
  assert.deepEqual(tree.render({ ...row("a"), phase: "call" as const }).render(80), []);
});

test("a prompt scope keeps one card across turns and splits on the next user message", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "first call" } });
  tree.boundary("turn");
  tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "second call" } });
  const together = lines(tree.render(row("a")));
  assert.equal(together.length, 3);
  assert.match(together[0]!, /2 calls/);

  tree.boundary("prompt");
  tree.start({ toolCallId: "c", toolName: "bash", args: { reasoning: "fresh prompt" } });
  assert.equal(lines(tree.render(row("c"))).length, 2);
});

test("the collapsed card keeps only the newest calls and expands on click", () => {
  const tree = new ToolTree(settings({ window: 2 }));
  for (const id of ["a", "b", "c", "d"]) {
    tree.start({ toolCallId: id, toolName: "bash", args: { reasoning: "step " + id } });
  }
  const card = tree.render(row("a"));
  const rolled = lines(card);
  assert.equal(rolled.length, 3);
  assert.match(rolled[0]!, /2 of 4 calls/);
  assert.match(rolled[1]!, /step c/);
  assert.match(rolled[2]!, /step d/);

  card.handleMouse?.(click(0));
  assert.equal(lines(tree.render(row("a"))).length, 5);
});

test("failed nested steps stay visible while their parent is collapsed", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "c", toolName: "codemode", args: { code: "// reasoning: build the card" } });
  tree.start({ toolCallId: "c1", toolName: "bash", parentToolCallId: "c", args: { reasoning: "run the tests" } });
  tree.end({ toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "boom" }] }, isError: true, durationMs: 1200 });
  assert.ok(lines(tree.render(row("c"))).some(line => /run the tests/.test(line)));

  const quiet = new ToolTree(settings({ revealErrors: false }));
  quiet.start({ toolCallId: "c", toolName: "codemode", args: { code: "// reasoning: build the card" } });
  quiet.start({ toolCallId: "c1", toolName: "bash", parentToolCallId: "c", args: { reasoning: "run the tests" } });
  quiet.end({ toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "boom" }] }, isError: true, durationMs: 1200 });
  assert.ok(!lines(quiet.render(row("c"))).some(line => /run the tests/.test(line)));
});

test("clicking a finished call shows a bounded preview", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "read the log" } });
  const body = Array.from({ length: 20 }, (_, index) => "line " + (index + 1)).join("\n");
  tree.end({ toolCallId: "a", toolName: "bash", result: { content: [{ type: "text", text: body }] }, isError: false, durationMs: 900 });
  const card = tree.render(row("a"));
  assert.equal(lines(card).length, 2);
  // Line 0 is the headline, so the call row itself sits on line 1.
  card.handleMouse?.(click(1));
  const painted = lines(tree.render(row("a")));
  assert.equal(painted.length, 11);
  assert.match(painted[2]!, /line 1/);
  assert.match(painted[10]!, /…/);
});

test("pi's expanded flag opens the whole tree without a click", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "c", toolName: "codemode", args: { code: "// reasoning: build the card" } });
  tree.start({ toolCallId: "c1", toolName: "bash", parentToolCallId: "c", args: { reasoning: "list files" } });
  assert.equal(lines(tree.render(row("c", true))).length, 3);
});

test("settle marks unfinished calls incomplete and off mode is a no-op", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the tests" } });
  tree.settle();
  assert.match(lines(tree.render(row("a")))[1]!, /incomplete/);

  const off = new ToolTree(settings({ mode: "off" }));
  off.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the tests" } });
  const untouched = off.render(row("a"));
  assert.deepEqual(untouched.render(80), ["inner"]);
});

test("old turns still paint after many newer ones", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "first turn" } });
  tree.end({ toolCallId: "a", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false, durationMs: 100 });
  for (let index = 0; index < 40; index += 1) {
    tree.boundary("turn");
    tree.start({ toolCallId: "t" + index, toolName: "read", args: { reasoning: "turn " + index } });
  }
  const painted = lines(tree.render(row("a")));
  assert.equal(painted.length, 2);
  assert.match(painted[1]!, /first turn/);
});

test("paintGroup keeps the click map aligned with the painted lines", () => {
  const group: TreeGroup = {
    key: "g1", rows: [], nodes: new Map(), started: Date.now(), budget: 100, openAll: false,
  };
  const targets = new Map<number, string>();
  const painted = paintGroup({ settings: settings(), expanded: new Set<string>() }, group, 80, plainTheme, false, targets);
  assert.deepEqual(painted, []);
  assert.equal(targets.size, 0);
  assert.equal(GROUP_TARGET, "@group");
});

test("a finished codemode call keeps the steps that ran inside it", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  const details = {
    piGroveNested: {
      version: 1,
      incomplete: false,
      calls: [
        {
          id: "c:1",
          parent: "c",
          name: "bash",
          reasoning: "run the tests",
          status: "success",
          duration: 1200,
          summary: "12 passed",
          preview: ["$ bun test", "12 passed"],
        },
      ],
    },
  };
  tree.start({ toolCallId: "c", toolName: "codemode", args: { code: "// reasoning: audit the suite" } });
  tree.end({ toolCallId: "c", toolName: "codemode", result: { content: [{ type: "text", text: "done" }], details }, isError: false, durationMs: 1300 });

  // The snapshot is the only trace of the steps, so the card must adopt them on completion.
  const before = lines(tree.render(row("c")));
  assert.equal(before.length, 2);
  assert.match(before[0]!, /1 call/);
  assert.match(before[1]!, /bash x1/);

  tree.render(row("c")).handleMouse?.(click(1));
  const opened = lines(tree.render(row("c")));
  assert.match(opened[2]!, /run the tests/);

  tree.render(row("c")).handleMouse?.(click(2));
  const expanded = lines(tree.render(row("c")));
  assert.ok(expanded.some(line => /12 passed/.test(line)), "the step keeps its output");
});
test("a codemode call does not duplicate the steps it already registered live", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  const details = {
    piGroveNested: {
      version: 1,
      incomplete: false,
      calls: [
        { id: "c:1", parent: "c", name: "bash", reasoning: "run the tests", status: "success", duration: 1200, summary: "12 passed", preview: "$ bun test\n12 passed" },
        { id: "c:2", parent: "c", name: "read", reasoning: "read the entry", status: "success", duration: 40, summary: "2 lines" },
      ],
    },
  };
  tree.start({ toolCallId: "c", toolName: "codemode", args: { code: "// reasoning: audit the suite" } });
  // Each step also arrives as its own tool event; the snapshot must not add a second copy.
  tree.start({ toolCallId: "c:1", toolName: "bash", args: { command: "bun test" }, parentToolCallId: "c" });
  tree.end({ toolCallId: "c:1", toolName: "bash", result: { content: [{ type: "text", text: "$ bun test\n12 passed" }] }, isError: false, durationMs: 1200 });
  tree.end({ toolCallId: "c", toolName: "codemode", result: { content: [{ type: "text", text: "done" }], details }, isError: false, durationMs: 1300 });

  tree.render(row("c")).handleMouse?.(click(1));
  const painted = lines(tree.render(row("c")));
  const steps = painted.filter(line => line.includes("bun test") || line.includes("read the entry"));
  assert.equal(steps.length, 2, painted.join(" | "));
  assert.equal(painted.filter(line => line.includes("bun test")).length, 1);
});
