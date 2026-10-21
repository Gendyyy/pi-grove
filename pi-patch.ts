/**
 * pi-patch.ts — stop pi from drawing its own hidden-thinking rows, so the tool card is
 * the only place reasoning appears. This is the one spot where grove touches pi
 * internals, so it finds the class by capability instead of trusting one file path: the
 * bundled build, the modular build and any future chunk layout are all searched.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** What the install attempt found. */
export interface ThinkingFilterStatus {
  installed: boolean;
  /** Where the patch landed, or why it could not. */
  detail: string;
  /** Modules the filter actually patched, relative to the pi install. */
  modules: string[];
}

/** Options, so a test can point the patch at a fixture package. */
export interface ThinkingFilterOptions {
  /** pi install directory; discovered from the running process when omitted. */
  root?: string;
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
/** Paths worth trying first: the bundled build, then the modular one. */
const KNOWN_MODULES = [
  "dist/bundle/index.js",
  "dist/modes/interactive/components/assistant-message.js",
];
/** Where pi keeps bundle chunks, the layout that broke the first version of this patch. */
const CHUNK_DIRECTORY = "dist/bundle/chunks";
/** A chunk is only worth importing when it mentions the hidden-label method. */
const CHUNK_HINT = "setHiddenThinkingLabel";
/** Refuse to slurp an enormous file while looking for the class. */
const CHUNK_MAX_BYTES = 8 * 1024 * 1024;
const MARK = Symbol.for("grove.thinkingFilter");
/** How many directories to climb while looking for pi own package.json. */
const CLIMB = 6;

let last: ThinkingFilterStatus | undefined;

/** Last install attempt, so /grove status can report what happened. */
export function thinkingFilterStatus(): ThinkingFilterStatus | undefined {
  return last;
}

/** True when a directory holds the pi package this process runs from. */
function isPiRoot(directory: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: unknown };
    return manifest.name === PI_PACKAGE;
  } catch {
    return false;
  }
}

/** Walk up from a file inside pi to the package root that owns it. */
function climbToRoot(from: string): string | undefined {
  let directory = dirname(from);
  for (let step = 0; step < CLIMB; step++) {
    if (isPiRoot(directory)) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

/** Locate pi's install directory using the running entry point, then module resolution. */
async function findPiRoot(): Promise<string | undefined> {
  const entry = process.argv[1];
  if (typeof entry === "string" && entry.length > 0) {
    try {
      const found = climbToRoot(realpathSync(entry));
      if (found) return found;
    } catch {
      // The entry point may already be gone; fall through to resolution.
    }
  }
  const meta = import.meta as unknown as { resolve?: (specifier: string) => unknown };
  try {
    const resolved = await meta.resolve?.(PI_PACKAGE);
    if (typeof resolved === "string") return climbToRoot(fileURLToPath(resolved));
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Every module in this pi install that could hold the assistant renderer: the two known
 * layouts first, then any chunk that mentions the hidden-label method. Detection is by
 * capability, so a pi release that moves the class does not silently disable the patch.
 */
export function candidateModules(root: string): string[] {
  const found: string[] = [];
  for (const relative of KNOWN_MODULES) if (existsSync(join(root, relative))) found.push(relative);
  const chunks = join(root, CHUNK_DIRECTORY);
  if (!existsSync(chunks)) return found;
  let entries: string[];
  try {
    entries = readdirSync(chunks).sort();
  } catch {
    return found;
  }
  for (const name of entries) {
    if (!name.endsWith(".js")) continue;
    const relative = CHUNK_DIRECTORY + "/" + name;
    const path = join(chunks, name);
    try {
      if (statSync(path).size > CHUNK_MAX_BYTES) continue;
      if (!readFileSync(path, "utf8").includes(CHUNK_HINT)) continue;
    } catch {
      continue;
    }
    found.push(relative);
  }
  return found;
}

/** Copy of an assistant message without thinking parts, or undefined when it had none. */
function withoutThinking(message: unknown): unknown {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const kept = content.filter(part => (part as { type?: unknown } | undefined)?.type !== "thinking");
  if (kept.length === content.length) return undefined;
  return { ...(message as Record<string, unknown>), content: kept };
}

type Prototype = Record<PropertyKey, unknown>;
interface ComponentClass {
  prototype: Prototype;
}

/** True when an export looks like pi's assistant message component. */
function isAssistantComponent(value: unknown): value is ComponentClass {
  const prototype = (value as ComponentClass | undefined)?.prototype;
  if (!prototype) return false;
  return typeof prototype.updateContent === "function" && typeof prototype.setHiddenThinkingLabel === "function";
}

/** Apply the render filter to one class prototype, once per process. */
function patchPrototype(prototype: Prototype): boolean {
  if (prototype[MARK]) return false;
  const update = prototype.updateContent as (message: unknown, isStreaming?: boolean) => void;
  // The session keeps its reasoning: only the rendered copy loses the thinking parts.
  prototype.updateContent = function patchedUpdateContent(this: unknown, message: unknown, isStreaming?: boolean) {
    return update.call(this, withoutThinking(message) ?? message, isStreaming);
  };
  Object.defineProperty(prototype, MARK, { value: true });
  return true;
}

/** Find the component class inside a module namespace, by name or by shape. */
function findComponent(module: Record<string, unknown>): ComponentClass | undefined {
  const named = module.AssistantMessageComponent;
  if (isAssistantComponent(named)) return named;
  for (const value of Object.values(module)) if (isAssistantComponent(value)) return value;
  return undefined;
}

/** Patch every copy of pi's assistant renderer reachable from one install. */
export async function installThinkingFilter(options: ThinkingFilterOptions = {}): Promise<ThinkingFilterStatus> {
  if (last?.installed && options.root === undefined) return last;
  const record = (status: ThinkingFilterStatus): ThinkingFilterStatus => {
    last = status;
    return status;
  };
  const root = options.root ?? (await findPiRoot());
  if (!root) return record({ installed: false, detail: "pi install not found", modules: [] });

  const patched: string[] = [];
  const missed: string[] = [];
  for (const relative of candidateModules(root)) {
    // Stop importing once the renderer is patched: the remaining chunks cannot add more.
    if (patched.length > 0) break;
    try {
      const module = (await import(pathToFileURL(join(root, relative)).href)) as Record<string, unknown>;
      const found = findComponent(module);
      if (!found) {
        missed.push(relative + " (no assistant component)");
        continue;
      }
      if (patchPrototype(found.prototype)) patched.push(relative);
      else patched.push(relative + " (already filtered)");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      missed.push(relative + " (" + reason + ")");
    }
  }

  if (patched.length > 0) return record({ installed: true, detail: "patched " + patched.join(", "), modules: patched });
  if (missed.length > 0)
    return record({ installed: false, detail: missed.slice(0, 3).join("; "), modules: [] });
  return record({ installed: false, detail: "no assistant renderer in " + root, modules: [] });
}
