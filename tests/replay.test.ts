/**
 * tests/replay.test.ts — rebuild grouped cards from a stored transcript.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { ToolTree, type TreeRow, type TreeSettings } from "../tool-tree.js";
import { readTranscript } from "../replay.js";
import { plainTheme } from "../theme.js";

/** One transcript entry carrying a message, the way pi stores it. */
function entry(timestamp: string, message: Record<string, unknown>): unknown {
  return { type: "message", id: timestamp, timestamp, message };
}

/** A user prompt entry. */
function user(timestamp: string, text: string): unknown {
  return entry(timestamp, { role: "user", content: [{ type: "text", text }] });
}

/** An assistant entry carrying tool calls. */
function assistant(timestamp: string, calls: Array<{ id: string; name: string; arguments?: unknown }>): unknown {
  return entry(timestamp, {
    role: "assistant",
    content: calls.map(call => ({ type: "toolCall", ...call })),
  });
}

/** A tool result entry, with the details grove stored for a codemode call. */
function result(
  timestamp: string,
  toolCallId: string,
  toolName: string,
  options: { text?: string; isError?: boolean; durationMs?: number; details?: unknown } = {},
): unknown {
  return entry(timestamp, {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: options.text ?? "ok" }],
    details: options.details,
    isError: options.isError ?? false,
    durationMs: options.durationMs ?? 100,
  });
}

const NESTED = {
  piGroveNested: {
    version: 3,
    incomplete: false,
    calls: [
      { id: "c1a", name: "bash", reasoning: "list files", status: "success", started: 1000, duration: 400, summary: "2 files", preview: "first file\nsecond file" },
      { id: "c1b", name: "read", reasoning: "read the entry", status: "error", started: 1500, duration: 100 },
      { id: "c1c", name: "grep", reasoning: "find callers", status: "success", started: 1600, duration: 50 },
    ],
  },
};

test("a transcript becomes one segment per prompt with nested steps attached", () => {
  const entries = [
    user("2026-01-01T00:00:00.000Z", "first"),
    assistant("2026-01-01T00:00:01.000Z", [{ id: "c1", name: "codemode", arguments: { code: "// reasoning: build the card\nreturn 1;" } }]),
    result("2026-01-01T00:00:03.000Z", "c1", "codemode", { durationMs: 2000, details: NESTED }),
    user("2026-01-01T00:00:09.000Z", "second"),
    assistant("2026-01-01T00:00:10.000Z", [{ id: "c2", name: "read", arguments: { reasoning: "check the manifest" } }]),
    result("2026-01-01T00:00:11.000Z", "c2", "read", { text: "one line", durationMs: 500 }),
  ];
  const segments = readTranscript(entries, "prompt");
  assert.equal(segments.length, 2);
  const [first, second] = segments;
  assert.equal(first!.calls.length, 1);
  const call = first!.calls[0]!;
  assert.equal(call.name, "codemode");
  assert.equal(call.status, "success");
  assert.equal(call.durationMs, 2000);
  assert.equal(call.children.length, 3);
  assert.deepEqual(call.children.map(child => child.name), ["bash", "read", "grep"]);
  assert.equal(call.children[1]!.status, "error");
  assert.equal(second!.calls[0]!.name, "read");
});

test("turn mode breaks a segment at every assistant message", () => {
  const entries = [
    user("2026-01-01T00:00:00.000Z", "go"),
    assistant("2026-01-01T00:00:01.000Z", [{ id: "a1", name: "read" }]),
    result("2026-01-01T00:00:02.000Z", "a1", "read"),
    assistant("2026-01-01T00:00:03.000Z", [{ id: "a2", name: "bash" }]),
    result("2026-01-01T00:00:04.000Z", "a2", "bash"),
  ];
  const segments = readTranscript(entries, "turn");
  assert.deepEqual(segments.map(segment => segment.calls.map(call => call.name)), [["read"], ["bash"]]);
  assert.deepEqual(readTranscript(entries, "off"), []);
});

test("a call with no stored result stays unfinished instead of disappearing", () => {
  const entries = [
    user("2026-01-01T00:00:00.000Z", "go"),
    assistant("2026-01-01T00:00:01.000Z", [{ id: "a1", name: "bash", arguments: { reasoning: "run the tests" } }]),
  ];
  const segments = readTranscript(entries, "prompt");
  assert.equal(segments[0]!.calls[0]!.status, "incomplete");
  assert.equal(segments[0]!.calls[0]!.result, undefined);
});

/** Settings with ASCII glyphs so painted lines can be asserted literally. */
function settings(): TreeSettings {
  return {
    mode: "prompt",
    revealErrors: true,
    icons: false,
    iconMode: "ascii",
    window: 4,
    groupNestedTools: true,
    groupProgress: true,
    groupSparkline: true,
    groupGutter: true,
  };
}

/** Minimal stand-in for a renderer component. */
function inner(): Component {
  return { render: () => ["inner"], invalidate: () => {} };
}

/** One pi row for a call. */
function row(id: string): TreeRow {
  return { toolCallId: id, inner: inner(), theme: plainTheme, expanded: false, invalidate: () => {} };
}

/** Rendered lines, trimmed of host padding and escapes. */
function lines(component: Component, width = 100): string[] {
  const painted = component.render(width).map(line => line.replace(/\u001b\[[0-9;]*m/g, "").trim());
  // The card is one bordered object now, so the body is what the assertions index.
  if (painted.length < 2 || !/^[╭+┌][-─]/.test(painted[0]!)) return painted;
  return painted.slice(1, -1).map(line => line.replace(/^[▌│|] ?/, "").replace(/ ?[▌│|]$/, "").trim());
}

/** Raw line index inside the frame, the coordinate the mouse reports. */
function clickAt(component: Component, pattern: RegExp, width = 100): number {
  return component
    .render(width)
    .map(line => line.replace(/\u001b\[[0-9;]*m/g, ""))
    .findIndex(line => pattern.test(line));
}

/** A left click with coordinates local to the card. */
function click(y: number): TuiMouseEvent {
  return { type: "click", button: "left", x: 0, y, screenX: 0, screenY: 0, width: 80, height: 40 } as unknown as TuiMouseEvent;
}

test("restored groups paint one card at their oldest row", () => {
  const entries = [
    user("2026-01-01T00:00:00.000Z", "first"),
    assistant("2026-01-01T00:00:01.000Z", [
      { id: "c1", name: "codemode", arguments: { code: "// reasoning: build the card\nreturn 1;" } },
      { id: "c2", name: "bash", arguments: { reasoning: "run the tests" } },
      { id: "c3", name: "read", arguments: { reasoning: "check the manifest" } },
    ]),
    result("2026-01-01T00:00:03.000Z", "c1", "codemode", { durationMs: 2000, details: NESTED }),
    result("2026-01-01T00:00:04.000Z", "c2", "bash", { durationMs: 900 }),
    result("2026-01-01T00:00:05.000Z", "c3", "read", { text: "one line", durationMs: 200 }),
  ];
  const tree = new ToolTree(settings());
  tree.restore(readTranscript(entries, "prompt"));

  const card = lines(tree.render(row("c1")));
  assert.match(card[0]!, /3 calls/);
  assert.match(card[0]!, /bash x2/);
  assert.match(card[0]!, /read x2/);
  assert.match(card[0]!, /codemode x1/);
  assert.match(card[0]!, /1 error/);
  // Siblings must stay blank, or pi would paint the same card once per row.
  assert.deepEqual(tree.render(row("c2")).render(80), []);
  assert.deepEqual(tree.render(row("c3")).render(80), []);
  assert.equal(tree.owns("c1"), true);
});

test("replay keeps the stable task title and ignores legacy phase annotations", () => {
  const entries = [
    user("2026-01-01T00:00:00.000Z", "make retry handling safe"),
    assistant("2026-01-01T00:00:01.000Z", [
      {
        id: "a1",
        name: "codemode",
        arguments: { code: '// @options: {"timeout_ms": 2000}\\n// reasoning: inspect retry handling\\n// task-intent: Inspect payment retry safeguards\\n// group-phase: Trace where timeout handling resets retry count\\nreturn 1;' },
      },
      {
        id: "a2",
        name: "bash",
        arguments: {
          taskIntent: "Inspect payment retry safeguards",
          taskProgress: 28,
          reasoning: "find the timeout handling call sites",
        },
      },
      {
        id: "a3",
        name: "bash",
        arguments: {
          taskIntent: "Inspect payment retry safeguards",
          taskProgress: 53,
          groupPhase: "Add regression coverage for timeout retries",
          reasoning: "write the focused retry tests",
        },
      },
    ]),
    result("2026-01-01T00:00:02.000Z", "a1", "codemode"),
    result("2026-01-01T00:00:03.000Z", "a2", "bash"),
    result("2026-01-01T00:00:04.000Z", "a3", "bash"),
  ];
  const tree = new ToolTree(settings());
  tree.restore(readTranscript(entries, "prompt"));
  const frame = tree.render(row("a1")).render(100);
  assert.match(frame[0]!, /Inspect payment retry safeguards/);
  assert.doesNotMatch(frame[0]!, /Add regression coverage for timeout retries/);
  assert.doesNotMatch(frame[0]!, /Trace where timeout handling resets retry count/);
  assert.match(frame[1]!, /53%/, "replay keeps the latest repeated estimate");
});

test("replay restores the latest declared milestone from codemode comments", () => {
  const plan = "// task-milestones: inspect=Inspect; build=Build; verify=Verify";
  const entries = [
    user("2026-01-01T00:00:00.000Z", "finish the retry fix"),
    assistant("2026-01-01T00:00:01.000Z", [
      {
        id: "m1",
        name: "codemode",
        arguments: { code: `// task-intent: Implement retry safety
// task-progress: 25
${plan}
// task-milestone: inspect
return 1;` },
      },
      {
        id: "m2",
        name: "codemode",
        arguments: { code: `// task-intent: Implement retry safety
// task-progress: 55
${plan}
// task-milestone: build
return 1;` },
      },
    ]),
    result("2026-01-01T00:00:02.000Z", "m1", "codemode"),
    result("2026-01-01T00:00:03.000Z", "m2", "codemode"),
  ];
  const tree = new ToolTree(settings());
  tree.restore(readTranscript(entries, "prompt"));
  const card = lines(tree.render(row("m1")));
  assert.match(card[0]!, /55% > \* Build 2\/3/, card[0]);
  assert.doesNotMatch(card[0]!, /Inspect|Verify/, "the phases ahead stay unspoken until clicked");
});

test("replay commits 100 only for a successful final tool call", () => {
  for (const isError of [false, true]) {
    const entries = [
      user("2026-01-01T00:00:00.000Z", "finish the retry fix"),
      assistant("2026-01-01T00:00:01.000Z", [
        { id: "p1", name: "read", arguments: { taskIntent: "Complete the retry fix", taskProgress: 58 } },
        { id: "p2", name: "bash", arguments: { taskIntent: "Complete the retry fix", taskProgress: 100 } },
      ]),
      result("2026-01-01T00:00:02.000Z", "p1", "read"),
      result("2026-01-01T00:00:03.000Z", "p2", "bash", { isError }),
    ];
    const tree = new ToolTree(settings());
    tree.restore(readTranscript(entries, "prompt"));
    const frame = tree.render(row("p1")).render(100)[1]!;
    assert.match(frame, isError ? /58%/ : /100%/);
  }
});

test("a restored call without a result still paints its own card", () => {
  const entries = [
    user("2026-01-01T00:00:00.000Z", "go"),
    assistant("2026-01-01T00:00:01.000Z", [{ id: "a1", name: "bash", arguments: { reasoning: "run the tests" } }]),
  ];
  const tree = new ToolTree(settings());
  tree.restore(readTranscript(entries, "prompt"));
  const painted = lines(tree.render(row("a1")));
  assert.equal(painted.length, 2);
  assert.match(painted[1]!, /run the tests/);
  assert.match(painted[1]!, /incomplete/);
});
test("reasoning is replayed only when the card shows it", () => {
  const transcript = [
    user("t1", "audit the funnel"),
    entry("t2", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "check the manifest first." },
        { type: "toolCall", id: "c1", name: "read", arguments: { reasoning: "read the manifest" } },
      ],
    }),
    result("t3", "c1", "read"),
  ];
  const narrated = readTranscript(transcript, "prompt")[0]!;
  const quiet = readTranscript(transcript, "prompt", false)[0]!;
  assert.equal(narrated.calls.length, 2);
  assert.equal(narrated.calls[0]!.kind, "thinking");
  assert.deepEqual(quiet.calls.map(call => call.id), ["c1"]);
});

test("a restored step still expands to the output its snapshot kept", () => {
  const entries = [
    user("2026-01-01T00:00:00.000Z", "go"),
    assistant("2026-01-01T00:00:01.000Z", [{ id: "c1", name: "codemode", arguments: { code: "// reasoning: build the card" } }]),
    result("2026-01-01T00:00:03.000Z", "c1", "codemode", { durationMs: 2000, details: NESTED }),
  ];
  const tree = new ToolTree(settings());
  tree.restore(readTranscript(entries, "prompt"));

  const before = lines(tree.render(row("c1")));
  assert.ok(before.some(line => line.includes("build the card")), "the codemode row is present");
  const card = tree.render(row("c1"));
  card.handleMouse?.(click(clickAt(card, /─ .*build the card/)));
  const opened = lines(tree.render(row("c1")));
  assert.ok(opened.some(line => line.includes("list files")), "the nested step must be listed");

  const drilled = tree.render(row("c1"));
  drilled.handleMouse?.(click(clickAt(drilled, /─ .*list files/)));
  const expanded = lines(tree.render(row("c1")));
  assert.ok(expanded.some(line => /first file/.test(line)), "a reloaded step keeps its output");
});