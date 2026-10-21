/**
 * pack.test.ts — every module the extension imports must be published, and the
 * pure kernel must never pull the pi host at runtime.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  files: string[];
  pi: { extensions: string[] };
}

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Manifest;
}

/** Follow ./relative specifiers from the entry points and return every local module. */
async function reachable(entries: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = await readFile(join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      // Sources import "./x.js" (node ESM style) while the published file is x.ts.
      const target = specifier.replace(/\.js$/, ".ts");
      queue.push(relative(root, join(root, dirname(file), target)).replace(/\\/g, "/"));
    }
  }
  return [...seen].sort();
}

/** Translate a package files glob into a regex; a double star also matches no directory. */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*" && pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    source += (character ?? "").replace(/[.\[\]{}()*+?^$|]/g, "\\$&");
  }
  return new RegExp("^" + source + "$");
}

test("every module the entry point imports is published", async () => {
  const { files, pi } = await manifest();
  const globs = files.map(globToRegExp);
  const modules = await reachable(pi.extensions.map((entry) => entry.replace(/^\.\//, "")));
  assert.ok(modules.length > 10, "expected the entry graph to reach the modules");
  const missing = modules.filter(file => !globs.some(glob => glob.test(file)));
  assert.deepEqual(missing, [], "add these to package.json files: " + missing.join(", "));
});

/** Modules that must stay pure: no pi import, so tests and tools can load them anywhere. */
const KERNEL = ["config.ts", "settings.ts", "icons.ts", "theme.ts", "render.ts", "replay.ts", "thinking.ts"];

test("the kernel never imports the pi host at runtime", async () => {
  for (const file of KERNEL) {
    const source = await readFile(join(root, file), "utf8");
    for (const line of source.split("\n")) {
      if (!line.startsWith("import ")) continue;
      if (line.startsWith("import type ")) continue;
      assert.ok(
        !line.includes("@earendil-works/"),
        file + " imports the pi host at runtime: " + line.trim()
      );
    }
  }
});

test("the kernel does not reach up into adapters or the ui layer", async () => {
  const forbidden = /\/(tool-ui|nested-tools|title-status|pi-fff|imagegen)[^"]*"/;
  for (const file of KERNEL) {
    const source = await readFile(join(root, file), "utf8");
    assert.ok(!forbidden.test(source), file + " imports an adapter module");
  }
});
