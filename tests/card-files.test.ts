/**
 * card-files.test.ts — the footer's source of truth: which write/edit calls count,
 * how duplicates fold, and how a deep path keeps its basename.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { filesSummary, filesTouched, shortPath } from "../card-files.js";
import type { TreeGroup, TreeNode } from "../tree-model.js";

/** One call row with only the fields the footer reads. */
function node(
  id: string,
  name: string,
  target: string,
  children: TreeNode[] = [],
  seq = 0,
): TreeNode {
  return {
    id,
    name,
    target,
    goal: "",
    status: "success",
    started: 0,
    children,
    seq,
  };
}

/** A group whose rows are exactly the nodes given. */
function group(rows: TreeNode[]): TreeGroup {
  return {
    key: "files",
    rows,
    nodes: new Map(),
    started: 0,
    budget: 5,
    openAll: false,
  };
}

test("filesTouched folds repeated paths across calls", () => {
  const files = filesTouched(group([
    node("a", "edit", "src/layouts/classic.ts"),
    node("b", "write", "src/layouts/classic.ts", [], 1),
  ]));
  assert.deepEqual(files, [{ path: "src/layouts/classic.ts", tool: "edit", calls: 2 }]);
});

test("filesTouched includes nested children and skips reads and empty targets", () => {
  const child = node("a1", "write", "src/nested.ts", [], 1);
  const files = filesTouched(group([
    node("a", "codemode", "", [child]),
    node("b", "read", "src/read.ts", [], 2),
    node("c", "write", "", [], 3),
  ]));
  assert.deepEqual(files, [{ path: "src/nested.ts", tool: "write", calls: 1 }]);
});

test("filesSummary caps the names and marks the rest", () => {
  const files = ["a/one.ts", "b/two.ts", "c/three.ts", "d/four.ts"].map(path => ({ path, tool: "edit", calls: 1 }));
  assert.equal(filesSummary(files, 94), "4 files · a/one.ts · b/two.ts · c/three.ts · +1 more");
  assert.equal(filesSummary(files, 34), "4 files · a/one.ts · +3 more");
  assert.equal(filesSummary(files, 12), "4 files · +3 more");
  assert.ok(filesSummary(files, 34).length <= 34);
  assert.equal(filesSummary(files.slice(0, 1), 94), "1 file · a/one.ts");
  assert.equal(filesSummary(files.slice(0, 1), 12), "1 file");
  assert.equal(filesSummary([], 40), "");
});

test("filesSummary trims names to the width it is given", () => {
  const files = ["src/layouts/classic.ts", "src/layouts/spine.ts", "src/card-files.ts", "src/render.ts"]
    .map(path => ({ path, tool: "edit", calls: 1 }));
  assert.equal(
    filesSummary(files, 94),
    "4 files · …/layouts/classic.ts · src/layouts/spine.ts · src/card-files.ts · +1 more",
  );
  assert.equal(filesSummary(files, 60), "4 files · …/classic.ts · …/spine.ts · +2 more");
  assert.equal(filesSummary(files, 40), "4 files · …/layouts/classic.ts · +3 more");
  assert.equal(filesSummary(files, 20), "4 files · +3 more");
});

test("filesSummary never exceeds its width budget", () => {
  const pool = ["src/layouts/classic.ts", "src/layouts/spine.ts", "src/card-files.ts", "src/render.ts", "src/a.ts", "src/b.ts"]
    .map(path => ({ path, tool: "edit", calls: 1 }));
  for (let width = 20; width <= 120; width += 1) {
    for (let count = 1; count <= 6; count += 1) {
      const line = filesSummary(pool.slice(0, count), width);
      assert.ok(line.length <= width, `${width}/${count}: ${line} (${line.length})`);
    }
  }
});

test("shortPath keeps the basename and never exceeds max", () => {
  assert.equal(shortPath("src/layouts/classic.ts"), "src/layouts/classic.ts");
  assert.equal(shortPath("src/layouts/classic.ts", 21), "…/layouts/classic.ts");
  const deep = shortPath("packages/app/src/features/a/very/deep/file.ts", 24);
  assert.ok(deep.endsWith("file.ts"), deep);
  assert.ok(deep.length <= 24, deep);
  const flat = shortPath("abcdefghij", 5);
  assert.equal(flat, "…ghij");
  assert.ok(flat.length <= 5, flat);
});
