/**
 * tests/thinking.test.ts — reasoning runs become rows, not wasted transcript space.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { thinkingGoal, thinkingPreview, thinkingRuns, thinkingSummary } from "../thinking.js";
import { readTranscript } from "../replay.js";
import { ToolTree, type TreeRow, type TreeSettings } from "../tool-tree.js";
import { plainTheme } from "../theme.js";

/** An assistant message built from raw parts. */
function message(parts: unknown[]): unknown {
  return { role: "assistant", id: "a1", content: parts };
}

/** Text of a thinking part. */
function thought(text: string): unknown {
  return { type: "thinking", thinking: text };
}

/** A tool call part. */
function call(id: string, name: string): unknown {
  return { type: "toolCall", id: id, name: name, arguments: { reasoning: "do the thing" } };
}

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

/** Rendered lines without host padding and escapes. */
function lines(component: Component, width = 100): string[] {
  const painted = component.render(width).map(line => line.replace(/\u001b\[[0-9;]*m/g, "").trim());
  // The card is one bordered object now, so the body is what the assertions index.
  if (painted.length < 2 || !/^[╭+┌][-─]/.test(painted[0]!)) return painted;
  return painted.slice(1, -1).map(line => line.replace(/^[▌│|] ?/, "").replace(/ ?[▌│|]$/, "").trim());
}

test("consecutive thinking parts collapse into one run with ordered ids", () => {
  const runs = thinkingRuns(message([thought("first thought"), thought("second thought"), call("c1", "read")]), "m1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.id, "m1:t0");
  assert.match(runs[0]!.text, /first thought\n\nsecond thought/);
});

test("reasoning rows carry a one-line goal and a word count", () => {
  assert.equal(thinkingGoal("Checking the schema first. Then the query."), "Checking the schema first");
  assert.equal(thinkingSummary("one two three"), "3 words");
  assert.deepEqual(thinkingPreview("a\n\nb\nc", 2), ["a", "b"]);
});

test("a reasoning row never counts as a tool call", () => {
  const tree = new ToolTree(settings());
  tree.note("m1:t0", "Look at the schema before querying it.");
  tree.start({ toolCallId: "c1", toolName: "read", args: { reasoning: "check the schema" } });
  tree.end({ toolCallId: "c1", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false, durationMs: 100 });

  const painted = lines(tree.render(row("c1")));
  // The headline counts one call, not two: reasoning is narration, never a call.
  assert.equal(painted.length, 4);
  assert.match(painted[0]!, /1 call/);
  assert.match(painted[1]!, /thinking/);
  // Collapsed, a reasoning row is just its label: the text waits behind a click.
  assert.doesNotMatch(painted[1]!, /schema/);
  assert.doesNotMatch(painted[1]!, /words/);
  assert.match(painted[3]!, /read/);
});

test(
  "clicking a reasoning row reveals the text it was hiding",
  () => {
    const tree = new ToolTree(settings());
    tree.note("m1:t0", "Look at the schema before querying it.");
    tree.start({ toolCallId: "c1", toolName: "read", args: { reasoning: "check the schema" } });
    tree.end({ toolCallId: "c1", toolName: "read", result: {}, isError: false, durationMs: 100 });
    const card = tree.render(row("c1")) as Component & { handleMouse?: (event: unknown) => unknown };
    const index = card
      .render(100)
      .map(line => line.replace(/\u001b\[[0-9;]*m/g, ""))
      .findIndex(line => line.includes("thinking"));
    card.handleMouse?.({ type: "click", button: "left", x: 0, y: index, screenX: 0, screenY: 0, width: 80, height: 40 });
    const opened = lines(tree.render(row("c1")));
    assert.match(opened.join(" "), /Look at the schema before querying it/);
  },
);

test("streaming reasoning updates the row instead of adding another", () => {
  const tree = new ToolTree(settings());
  tree.note("m1:t0", "Working on it");
  tree.note("m1:t0", "Working on it and then some", { final: true });
  tree.start({ toolCallId: "c1", toolName: "read", args: { reasoning: "check the schema" } });
  tree.end({ toolCallId: "c1", toolName: "read", result: {}, isError: false, durationMs: 10 });
  const painted = lines(tree.render(row("c1")));
  assert.equal(painted.filter(line => line.includes("thinking")).length, 1);
  // One row, no second copy of the text: the row keeps its single label.
});

test("a replay keeps reasoning in place above the call it led to", () => {
  const entries = [
    { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    {
      type: "message",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", id: "a1", content: [thought("First check the manifest."), call("c1", "read")] },
    },
    {
      type: "message",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        durationMs: 100,
      },
    },
  ];
  const segments = readTranscript(entries, "prompt");
  assert.deepEqual(segments[0]!.calls.map(entry => entry.name), ["thinking", "read"]);

  const tree = new ToolTree(settings());
  tree.restore(segments);
  const painted = lines(tree.render(row("c1")));
  assert.ok(painted.some(line => /thinking/.test(line)));
  assert.doesNotMatch(painted.join(" "), /First check the manifest/);
  assert.ok(painted.some(line => /read/.test(line)));
});
