/**
 * tests/imports.test.ts — the two structural promises the card layer makes:
 * its modules load in one direction, and the painter draws through the layout it is handed.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { paintGroup } from "../tree-paint.js";
import { plainTheme } from "../theme.js";
import type { CardContext, CardLayout } from "../card-layout.js";
import type { TreeGroup, TreeNode, TreeSettings } from "../tree-model.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Root modules only: that is the layer where a cycle would actually bite at load time. */
function modules(): string[] {
  return readdirSync(ROOT).filter((name) => name.endsWith(".ts")).sort();
}

/**
 * True when the statement imports a value, not just a type. Type-only imports vanish at compile,
 * so they cannot form a runtime cycle and must not be reported as one.
 */
function importsValue(clause: string, form: string): boolean {
  if (form === "type") return false;
  const braced = /\{([^}]*)\}/.exec(clause);
  if (braced) {
    const specifiers = braced[1]!.split(",").map((part) => part.trim()).filter(Boolean);
    if (specifiers.length === 0) return false;
    return specifiers.some((specifier) => !/^type\s/.test(specifier));
  }
  // A default, namespace or side-effect import always loads the module.
  return true;
}

/** Every local module this file loads a value from, keyed by the sibling file name. */
function valueEdges(file: string): string[] {
  const text = readFileSync(join(ROOT, file), "utf8");
  const edges: string[] = [];
  const statement = /^\s*(import|export)\s+(type\s+)?([^;]*?from\s+)?["'](\.\/[^"']+)["']/gm;
  for (const match of text.matchAll(statement)) {
    const [, , typeOnly, clause = "", specifier] = match;
    const target = specifier!.replace(/^\.\//, "").replace(/\.js$/, ".ts");
    if (!modules().includes(target)) continue;
    if (!importsValue(clause, typeOnly ? "type" : "value")) continue;
    edges.push(target);
  }
  return edges;
}

/** Depth-first walk that returns the first cycle it closes, so a failure names the loop. */
function firstCycle(starts: string[], edges: (file: string) => string[] = valueEdges): string[] | undefined {
  const seen = new Set<string>();
  const path: string[] = [];
  const walk = (file: string): string[] | undefined => {
    const at = path.indexOf(file);
    if (at >= 0) return [...path.slice(at), file];
    if (seen.has(file)) return undefined;
    seen.add(file);
    path.push(file);
    for (const next of edges(file)) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    path.pop();
    return undefined;
  };
  for (const file of starts) {
    const cycle = walk(file);
    if (cycle) return cycle;
  }
  return undefined;
}

test("the cycle walker reports a loop instead of passing it", () => {
  const found = firstCycle(["a.ts"], (file) => (file === "a.ts" ? ["b.ts"] : ["a.ts"]));
  assert.deepEqual(found, ["a.ts", "b.ts", "a.ts"]);
});

test("the card modules form a runtime acyclic graph", () => {
  const found = firstCycle(modules());
  assert.equal(found, undefined, "runtime import cycle: " + (found ?? []).join(" -> "));
  // Guards the naive reading of the assertion: an empty graph would also be acyclic.
  assert.ok(valueEdges("tree-paint.ts").includes("tree-model.ts"));
});

const settings: TreeSettings = {
  mode: "turn",
  revealErrors: false,
  icons: false,
  iconMode: "ascii",
  window: 4,
  groupNestedTools: true,
  groupProgress: true,
  groupPercent: true,
  groupPhases: true,
  groupSparkline: false,
  groupGutter: true,
  groupBox: false,
  groupToolNames: true,
};

/** One live call, which is all the painter needs to reach the layout. */
function oneCall(): TreeGroup {
  const node: TreeNode = {
    id: "a",
    name: "bash",
    goal: "run the suite",
    target: "bun test",
    status: "running",
    started: 0,
    children: [],
    seq: 0,
  };
  return { key: "g1", rows: [node], nodes: new Map([["a", node]]), started: 0, budget: 100, openAll: false };
}

test("paintGroup draws through the layout it is given", () => {
  let seen: CardContext | undefined;
  const stub: CardLayout = { paint: (ctx) => { seen = ctx; return ["stub card"]; } };
  const group = oneCall();
  const painted = paintGroup({ settings, expanded: new Set<string>() }, group, 80, plainTheme, false, new Map(), stub);
  assert.deepEqual(painted, ["stub card"]);
  // The real context reaches the layout, so a second card inherits the whole contract.
  assert.equal(seen?.inner, 80);
  assert.equal(seen?.group, group);
  assert.ok(seen!.targets instanceof Map);
});

test("a caller that names no layout still gets the classic card", () => {
  const plain = paintGroup({ settings, expanded: new Set<string>() }, oneCall(), 80, plainTheme);
  assert.ok(plain.length > 0);
  assert.ok(plain.join("\n").includes("bun test"));
});

