// Whether a card reports the right percentage: it is read off the plan's calls, never declared.
import assert from "node:assert/strict";
import test from "node:test";
import { treeGlyphs, type TreeNode, type TreeGroup } from "../tree-model.js";
import { derivedProgress, finishedPhases, planFinished, progressGlyph } from "../tree-paint.js";

const call = (id: string, status: TreeNode["status"], milestone?: string): TreeNode => ({
  id,
  name: "bash",
  goal: "",
  target: "",
  status,
  started: 0,
  seq: 0,
  children: [],
  milestone,
});

/** One call the named phase already ran and got back. */
const ran = (phase: string, status: TreeNode["status"] = "success"): TreeNode => call("call-" + phase + "-" + status, status, phase);

/** A four-phase card whose pointer sits on the named phase, holding the calls its phases ran. */
const card = (active: string, ...rows: TreeNode[]): TreeGroup => ({
  key: "card",
  rows,
  nodes: new Map(),
  started: 0,
  budget: 100,
  openAll: false,
  milestones: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }, { id: "d", label: "D" }],
  activeMilestoneId: active,
});

test("the phase in flight has earned nothing yet", () => {
  assert.equal(derivedProgress(card("a", call("n0", "running", "a"))), 0);
});

test("every finished phase earns one equal slice, long before the turn ends", () => {
  assert.equal(derivedProgress(card("b", ran("a"), call("n1", "running", "b"))), 25);
  assert.equal(derivedProgress(card("c", ran("a"), ran("b"))), 50, "a phase nobody called yet still sits ahead");
  assert.equal(derivedProgress(card("d", ran("a"), ran("b"), ran("c"))), 75);
});

test("the plan reads complete only once the final response is out", () => {
  const live = card("d", ran("a"), ran("b"), ran("c"), ran("d"));
  assert.equal(live.settled, undefined, "the turn is still open");
  assert.equal(finishedPhases(live), 4, "every phase's work came back");
  assert.equal(planFinished(live), false, "but the plan is not over while the agent still talks");
  assert.equal(derivedProgress(live), 75, "the last slice waits for the final response");

  const done = { ...live, settled: true };
  assert.equal(planFinished(done), true);
  assert.equal(derivedProgress(done), 100);
});

test("a phase the pointer still sits on stays open after its own calls return", () => {
  const live = card("a", ran("a"));
  assert.equal(finishedPhases(live), 1, "the work inside the phase came back");
  assert.equal(derivedProgress(live), 0, "but the plan has not moved past it, so it earns nothing");
  assert.equal(derivedProgress(card("b", ran("a"))), 25, "the next phase declaring itself is what closes it");
});

test("a failed phase still finished its work, but the plan never reads complete", () => {
  const live = card("d", ran("a"), ran("b"), call("boom", "error", "c"), ran("d"));
  assert.equal(finishedPhases(live), 4, "a failed call has returned, so its phase is over");
  assert.equal(planFinished(live), false);
  assert.equal(derivedProgress(live), 75, "the bar stops one slice short of a plan that went wrong");
  assert.equal(derivedProgress({ ...live, settled: true }), 75, "closing the card cannot repair a failure");
});

test("a phase nothing called closes only once the plan moved past it", () => {
  assert.equal(derivedProgress(card("b")), 25);
  assert.equal(derivedProgress({ ...card("b"), settled: true }), 25, "a closed card invents no work the plan never passed");
});

test("a call starting after the plan looked finished never takes the share back", () => {
  const live = { ...card("d", ran("a"), ran("b"), ran("c"), ran("d")), settled: true };
  assert.equal(derivedProgress(live), 100);
  live.rows.push(call("late", "running"));
  assert.equal(derivedProgress(live), 100, "a late call is more work, not less progress");
  assert.equal(planFinished(live), false, "the plan still knows a call is in flight");
});

test("a reasoning row still in flight never holds the plan below complete", () => {
  const live = { ...card("d", ran("a"), ran("b"), ran("c"), ran("d")), settled: true };
  live.rows.push({ ...call("think", "running"), kind: "thinking" });
  assert.equal(derivedProgress(live), 100, "thinking is not work the plan waits on");
  assert.equal(planFinished(live), true, "a plan whose calls all came back is over whatever the model is still writing");
});

test("a settled card with nothing failed reads complete", () => {
  assert.equal(derivedProgress({ ...card("d", ran("a")), settled: true }), 100);
});

test("a finished plan stops one slice short until the last phase has nothing left to say", () => {
  const live = card("d", ran("a"), ran("b"), ran("c"), ran("d"));
  // Three of four phases read closed mid-turn: the fourth waits for the same ending the meter waits for.
  assert.equal(derivedProgress(live), 75);
  assert.equal(derivedProgress({ ...live, settled: true }), 100, "the final response closes it");
});

test("the filled span ends where the last returned call left it while work is still running", () => {
  const live = card("d", ran("a"), ran("b"), ran("c"), call("n", "running", "d"));
  assert.equal(derivedProgress(live), 75);
  assert.equal(planFinished(live), false);
});

test("the share glyph walks the pie in quarter steps", () => {
  const { pie } = treeGlyphs("ascii");
  assert.equal(progressGlyph(24, treeGlyphs("ascii")), pie[1]);
  assert.equal(progressGlyph(100, treeGlyphs("ascii")), pie[4]);
});

test("a card without a plan reports no percentage at all", () => {
  const plain = { ...card("a", ran("a")), milestones: [] };
  assert.equal(derivedProgress(plain), undefined);
  assert.equal(planFinished(plain), false);
});
