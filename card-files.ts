/**
 * card-files.ts — the "files touched" footer: which paths this turn wrote or edited,
 * gathered from the same tree the card already paints.
 */
import type { TreeGroup, TreeNode } from "./tree-model.js";

const WRITE_TOOLS = new Set(["write", "edit"]);

export interface TouchedFile {
  path: string;
  tool: string;
  calls: number;
}

/** Walk the whole subtree so a nested edit still lands in the footer. */
export function filesTouched(group: TreeGroup): TouchedFile[] {
  const files: TouchedFile[] = [];
  const byPath = new Map<string, TouchedFile>();
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      if (WRITE_TOOLS.has(node.name) && typeof node.target === "string" && node.target.length > 0) {
        const seen = byPath.get(node.target);
        if (seen) seen.calls += 1;
        else {
          const file = { path: node.target, tool: node.name, calls: 1 };
          byPath.set(node.target, file);
          files.push(file);
        }
      }
      walk(node.children);
    }
  };
  walk(group.rows);
  return files;
}

/** Keep the basename readable when a deep path has to lose its head. */
export function shortPath(path: string, max = 28): string {
  if (path.length <= max) return path;
  if (max <= 1) return "…";
  const tail = path.slice(-(max - 1));
  const slash = tail.indexOf("/");
  return "…" + (slash === -1 ? tail : tail.slice(slash));
}

/** One plain line naming the touched files; the painter owns its colour. */
export function filesSummary(files: TouchedFile[], width: number): string {
  if (files.length === 0) return "";
  const count = files.length + " file" + (files.length === 1 ? "" : "s");
  const minName = 12; // never show a name shorter than this
  let shown = Math.min(files.length, 3);
  let result = "";
  while (shown >= 1) {
    const more = files.length - shown;
    const tail = more > 0 ? " · +" + more + " more" : "";
    // separators: 3 chars before each name, 3 between names
    const names = width - count.length - tail.length - shown * 3 - Math.max(0, shown - 1) * 3;
    const perName = Math.floor(names / shown);
    if (perName >= minName) {
      const paths = files.slice(0, shown).map(f => shortPath(f.path, perName));
      result = count + " · " + paths.join(" · ") + tail;
      break;
    }
    if (shown === 1) result = count + tail; // even one name will not fit
    shown -= 1;
  }
  return result;
}
