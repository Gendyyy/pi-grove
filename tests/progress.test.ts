// Whether a card reports the right percentage: it is read off the plan, never declared.
import assert from "node:assert/strict";
import test from "node:test";
import { treeGlyphs, type TreeNode, type TreeGroup } from "../tree-model.js";
import { derivedProgress, planFinished, progressGlyph } from "../tree-paint.js";

const call = (id: string, status: TreeNode["status"]): TreeNode => ({
  id,
  name: "bash",
  goal: "",
  target: "",
  status,
  started: 0,
  seq: 0,
  children: [],
});

/** A four-phase card sitting on the named phase, with the given call outcomes behind it. */
const card = (active: string, ...statuses: TreeNode["status"][]): TreeGroup => ({
  key: "card",
  rows: statuses.map((status, index) => call("n" + index, status)),
  nodes: new Map(),
  started: 0,
  budget: 100,
  openAll: false,
  milestones: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }, { id: "d", label: "D" }],
  activeMilestoneId: active,
});

test("the phase in flight has earned nothing yet", () => {
  assert.equal(derivedProgress(card("a", "running")), 0);
});

test("every finished phase earns one equal slice", () => {
  assert.equal(derivedProgress(card("b", "running")), 25);
  assert.equal(derivedProgress(card("c", "success")), 50);
  assert.equal(derivedProgress(card("d", "running")), 75);
});

test("the last phase closing clean is not complete until the card settles", () => {
  assert.equal(derivedProgress(card("d", "success")), 75, "the last phase is still the one working");
  assert.equal(derivedProgress({ ...card("d", "success"), settled: true }), 100);
  assert.equal(derivedProgress(card("d", "success", "error")), 75, "a failure on the last phase is not complete");
});

test("a call starting after the last phase closed never takes the share back", () => {
  const live = card("d", "success");
  assert.equal(derivedProgress(live), 75, "the last phase has not ended just because its call did");
  live.rows.push(call("late", "running"));
  assert.equal(derivedProgress(live), 75, "a late call is more work, not less progress");
  assert.equal(planFinished(live), false, "the plan still knows the last phase is in flight");
});

test("a reasoning row still in flight never holds the plan below complete", () => {
  const live = { ...card("d", "success"), settled: true };
  live.rows.push({ ...call("think", "running"), kind: "thinking" });
  assert.equal(derivedProgress(live), 100, "thinking is not work the plan waits on");
  assert.equal(planFinished(live), true, "a settled plan is over whatever the model is still writing");
});

test("a settled card with nothing failed reads complete", () => {
  assert.equal(derivedProgress({ ...card("d", "success", "success"), settled: true }), 100);
});

test("a settled card that failed keeps only the phases it finished", () => {
  assert.equal(derivedProgress({ ...card("d", "success", "error"), settled: true }), 75);
});

test("a card without a plan reports no percentage at all", () => {
  assert.equal(derivedProgress({ ...card("a", "success"), milestones: undefined }), undefined);
});


test("the status circle fills in quarter steps, so it never overstates a share", () => {
  const glyphs = treeGlyphs("nerd");
  assert.deepEqual([0, 33, 50, 67, 100].map(value => progressGlyph(value, glyphs)), ["○", "◔", "◑", "◕", "●"]);
  assert.deepEqual([50, 100].map(value => progressGlyph(value, treeGlyphs("ascii"))), ["O", "#"]);
});
