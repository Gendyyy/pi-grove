/**
 * tests/host.test.ts — the group card driven through a fake pi host, so the bugs that only
 * appeared once pi's own layout was involved cannot come back.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FakeHost, okay } from "./host.js";

/** The card's lines without its border, so assertions index the body the way they always did. */
function body(frame: { lines: string[] }): string[] {
  const painted = frame.lines;
  if (painted.length < 2 || !/^[╭+]-/.test(painted[0]!.trim())) return painted;
  return painted.slice(1);
}

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

/** A tool result entry. */
function result(timestamp: string, toolCallId: string, toolName: string, details?: unknown): unknown {
  return entry(timestamp, {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "ok" }],
    details,
    isError: false,
    durationMs: 120,
  });
}

/** The snapshot grove stores for the steps that ran inside one codemode call. */
function snapshot(calls: Array<Record<string, unknown>>): unknown {
  return { piGroveNested: { version: 2, incomplete: false, calls } };
}

test("one card paints once even though pi mounts a row and a result row", () => {
  const host = new FakeHost();
  host.start("a", "read", { reasoning: "read the manifest" });
  host.start("b", "bash", { reasoning: "run the suite" });
  host.start("c", "bash", { reasoning: "run the linter" });
  host.frame();
  // While the calls are still streaming, only the live row of the card may paint.
  assert.deepEqual(host.painters(), ["a"]);
  host.end("a", okay("one line"));
  host.end("b", okay("2 passed"));
  host.end("c", okay("clean"));
  const frame = host.frame();
  // The result rows take the card over, and the live rows go blank in the same frame.
  assert.deepEqual(host.painters(), ["a"]);
  assert.match(body(frame)[0]!, /3 calls/);
  assert.match(body(frame)[0]!, /bash x2/);
  assert.equal(body(frame).length, 4, "headline and one branch row per call, without blank links");
});

test("the card never moves while calls arrive", () => {
  const host = new FakeHost();
  host.start("a", "read", { reasoning: "read the manifest" });
  const first = body(host.frame())[0]!;
  for (const [index, name] of ["bash", "grep", "ls"].entries()) {
    host.start("n" + index, name, { reasoning: "step " + index });
    const frame = host.frame();
    // A card that migrated to the newest row reflowed the whole transcript every call.
    assert.match(body(frame)[0]!, /calls?/);
    assert.equal(frame.rows.filter(row => row.lines.length > 0).length, 1);
  }
  assert.match(first, /1 call/);
});

test("a step registered live is not duplicated by the codemode snapshot", () => {
  const host = new FakeHost();
  host.start("code", "codemode", { reasoning: "audit the suite" });
  host.start("step", "bash", { reasoning: "run the tests" }, "code");
  host.end("step", okay("2 passed"));
  host.end("code", okay("done"), {
    isError: false,
  });
  // The snapshot carries the same step id the live event stream already registered.
  host.start("code2", "codemode", { reasoning: "audit the types" });
  host.start("step2", "read", { reasoning: "read the entry" }, "code2");
  host.end(
    "code2",
    {
      content: [{ type: "text", text: "ok" }],
      isError: false,
      details: snapshot([
        { id: "step2", name: "read", status: "success", started: 1, duration: 40, summary: "1 line", preview: "export {};" },
      ]),
    },
  );
  host.frame();
  // Click the headline to reveal every row, then drill into the second codemode call.
  // The rollup is the first line inside the frame, so click it where it now sits.
  host.click(host.frame().lines.findIndex(line => /calls/.test(line)));
  const revealed = host.frame();
  assert.match(body(revealed)[0]!, /2 calls/);
  host.click(revealed.lines.findIndex(line => /audit the types/.test(line)));
  const drilled = host.frame();
  // The live event stream registered each step once; the snapshot must not add a second row.
  assert.equal(body(drilled).filter(line => /read the entry/.test(line)).length, 1);
  // The first card still owns exactly one child, so the snapshot added no second row there.
});

test("a reload rebuilds the same cards from the transcript", () => {
  const host = new FakeHost();
  host.reload([
    user("t1", "audit the repo"),
    assistant("t2", [
      { id: "c1", name: "read", arguments: { reasoning: "read the manifest" } },
      { id: "c2", name: "bash", arguments: { reasoning: "run the suite" } },
    ]),
    result("t3", "c1", "read"),
    result("t4", "c2", "bash"),
  ]);
  const frame = host.frame();
  assert.match(body(frame)[0]!, /2 calls/);
  assert.match(body(frame)[0]!, /read x1/);
  // Only the card paints: the historical rows must not reappear above it.
  assert.deepEqual(host.painters(), ["c1"]);
});

test("reasoning shows up inside the card, between the calls that used it", () => {
  const host = new FakeHost();
  host.start("a", "read", { reasoning: "read the manifest" });
  host.end("a", okay("12 lines"));
  host.note("m1", "The manifest names the entry module, so read it before the schema.", { final: true });
  host.start("b", "bash", { reasoning: "run the suite" });
  host.end("b", okay("2 passed"));
  const frame = host.frame();
  assert.equal(body(frame).length, 4, "headline, call/reasoning rows, and no blank inter-call links");
  assert.equal(body(frame).filter(line => /thinking/.test(line)).length, 1);
  assert.doesNotMatch(body(frame).join("\n"), /manifest names the entry/);
  host.click(frame.lines.findIndex(line => /thinking/.test(line)));
  const revealed = host.frame();
  assert.match(body(revealed).join("\n"), /manifest names the entry/);
});
