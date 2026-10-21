/**
 * pi-patch.ts — stop pi from drawing its own hidden-thinking rows, so the tool card is
 * the only place reasoning appears. This is the one spot where liuovo touches pi internals.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Whether pi's assistant renderer now skips thinking parts. */
export interface ThinkingFilterStatus {
  installed: boolean;
  /** Where the patch landed, or why it could not. */
  detail: string;
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
/**
 * The CLI entry point runs the bundled build (dist/bundle/cli-runtime.js), so the class on
 * screen lives in the bundle. The modular copy is patched too: some entry points use it.
 */
const CANDIDATE_MODULES = [
  "dist/bundle/index.js",
  "dist/modes/interactive/components/assistant-message.js",
];
const MARK = Symbol.for("liuovo.thinkingFilter");
/** How many directories to climb while looking for pi own package.json. */
const CLIMB = 6;

let last: ThinkingFilterStatus | undefined;

/** Last install attempt, so /liuovo status can report what happened. */
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
  const meta = import.meta as unknown as { resolve?: (specifier: string) => string | Promise<string> };
  try {
    const resolved = await meta.resolve?.(PI_PACKAGE);
    if (typeof resolved === "string") return climbToRoot(fileURLToPath(resolved));
  } catch {
    return undefined;
  }
  return undefined;
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

/** Patch every copy of pi's assistant renderer this process can reach. */
export async function installThinkingFilter(): Promise<ThinkingFilterStatus> {
  if (last?.installed) return last;
  const record = (status: ThinkingFilterStatus): ThinkingFilterStatus => {
    last = status;
    return status;
  };
  const root = await findPiRoot();
  if (!root) return record({ installed: false, detail: "pi install not found" });

  const patched: string[] = [];
  const missed: string[] = [];
  for (const relative of CANDIDATE_MODULES) {
    const target = join(root, relative);
    if (!existsSync(target)) continue;
    try {
      const module = (await import(pathToFileURL(target).href)) as Record<string, unknown>;
      const found = findComponent(module);
      if (!found) {
        missed.push(relative + " (no component export)");
        continue;
      }
      patchPrototype(found.prototype);
      patched.push(relative);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      missed.push(relative + " (" + reason + ")");
    }
  }

  if (patched.length > 0) return record({ installed: true, detail: "patched " + patched.join(", ") });
  if (missed.length > 0) return record({ installed: false, detail: missed.join("; ") });
  return record({ installed: false, detail: "no patchable module in " + root });
}
