import { promises as fs, readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import type { IconMode } from "./icons.js";
import type { GroupMode } from "./tool-tree.js";

export const CONFIG_PATH = join(getAgentDir(), "liuovo.json");

/** Config path redirect for hermetic tests and sandboxed runs; unset means the user path. */
export function defaultConfigPath(): string {
  return process.env.PI_LIUOVO_CONFIG ?? CONFIG_PATH;
}

export type LiuovoStateSource = "environment" | "file" | "default";

export interface LiuovoState {
  enabled: boolean;
  source: LiuovoStateSource;
}

export type LiuovoMode = "default" | "reasoning" | "result";

/** Parse the documented boolean forms; unknown values do not override config. */
export function parseEnabled(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "on":
    case "yes":
      return true;
    case "0":
    case "false":
    case "off":
    case "no":
      return false;
    default:
      return undefined;
  }
}

/** Resolve startup state. A valid environment override always wins. */
export function loadLiuovoState(
  options: { envValue?: string; configPath?: string } = {}
): LiuovoState {
  const envValue = options.envValue ?? process.env.PI_LIUOVO;
  const envEnabled = parseEnabled(envValue);
  if (envEnabled !== undefined)
    return { enabled: envEnabled, source: "environment" };

  const configPath = options.configPath ?? defaultConfigPath();
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof parsed?.enabled === "boolean")
      return { enabled: parsed.enabled, source: "file" };
  } catch {
    // Missing, unreadable, and malformed config all preserve the enabled default.
  }
  return { enabled: true, source: "default" };
}

/** Resolve decorative icon visibility; only an explicit false disables them. */
export function loadLiuovoIcons(configPath = defaultConfigPath()): boolean {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.icons === false
    )
      return false;
  } catch {
    // Missing, unreadable, and malformed config all preserve visible icons.
  }
  return true;
}

export function loadLiuovoIconMode(configPath = defaultConfigPath()): IconMode {
  try {
    const mode = JSON.parse(readFileSync(configPath, "utf8"))?.iconMode;
    if (mode === "nerd" || mode === "ascii") return mode;
  } catch { /* Invalid/missing preferences retain automatic selection. */ }
  return "auto";
}

export function saveLiuovoIconMode(mode: IconMode, configPath = defaultConfigPath()): Promise<void> {
  return updateConfig({ iconMode: mode }, configPath);
}

export function loadLiuovoMode(configPath = defaultConfigPath()): LiuovoMode {
  try {
    const mode = JSON.parse(readFileSync(configPath, "utf8"))?.mode;
    if (mode === "reasoning" || mode === "result") return mode;
  } catch {
    // Missing and malformed config preserve the default layout.
  }
  return "default";
}

async function updateConfig(
  update: Record<string, unknown>,
  configPath: string
): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      current = parsed;
  } catch {
    // Missing and malformed config are replaced with valid extension config.
  }
  const directory = dirname(configPath);
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify({ ...current, ...update }, null, 2)}\n`,
      "utf8"
    );
    await fs.rename(temporaryPath, configPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** Persist only extension-owned settings outside the package checkout. */
export async function saveLiuovoEnabled(
  enabled: boolean,
  configPath = defaultConfigPath()
): Promise<void> {
  await updateConfig({ enabled }, configPath);
}

export async function saveLiuovoMode(
  mode: LiuovoMode,
  configPath = defaultConfigPath()
): Promise<void> {
  await updateConfig({ mode }, configPath);
}

export async function saveLiuovoIcons(
  icons: boolean,
  configPath = defaultConfigPath()
): Promise<void> {
  await updateConfig({ icons }, configPath);
}

/** Transcript scope for one collapsed card; owned by liuovo.json. */
export type LiuovoGroup = GroupMode;

export function loadLiuovoGroup(configPath = defaultConfigPath()): LiuovoGroup {
  try {
    const group = JSON.parse(readFileSync(configPath, "utf8"))?.group;
    if (group === "prompt" || group === "turn" || group === "message" || group === "off") return group;
  } catch {
    // Missing and malformed config keep grouping on, which is the shipped default.
  }
  return "prompt";
}

/** Where reasoning appears: inside the tool card, as pi rows, or nowhere. */
export type LiuovoThinking = "group" | "inline" | "off";

/** Resolve where reasoning belongs; the card is the default because pi rows cost space. */
export function loadLiuovoThinking(configPath = defaultConfigPath()): LiuovoThinking {
  try {
    const value = JSON.parse(readFileSync(configPath, "utf8"))?.thinking;
    if (value === "group" || value === "inline" || value === "off") return value;
  } catch {
    // Missing and malformed config hide reasoning, which is pi own default.
  }
  return "off";
}

/** Persist where reasoning appears. */
export async function saveLiuovoThinking(thinking: LiuovoThinking, configPath = defaultConfigPath()): Promise<void> {
  await updateConfig({ thinking: thinking }, configPath);
}

/** How many recent calls the collapsed card keeps visible; bounded for sanity. */
export function loadLiuovoGroupWindow(configPath = defaultConfigPath()): number {
  try {
    const value = JSON.parse(readFileSync(configPath, "utf8"))?.groupWindow;
    if (typeof value === "number" && Number.isFinite(value)) return Math.min(32, Math.max(1, Math.round(value)));
  } catch {
    // Missing and malformed config keep the four-call window.
  }
  return 4;
}

/** Persist the visible window size; clamped to the loader bounds. */
export async function saveLiuovoGroupWindow(window: number, configPath = defaultConfigPath()): Promise<void> {
  await updateConfig({ groupWindow: Math.min(32, Math.max(1, Math.round(window))) }, configPath);
}

/**
 * Text pi prints for a hidden thinking run. An empty string hides those lines
 * entirely, because pi Text renders nothing for blank text. Undefined leaves pi alone.
 */
export function loadLiuovoThinkingLabel(configPath = defaultConfigPath()): string | undefined {
  try {
    const value = JSON.parse(readFileSync(configPath, "utf8"))?.thinkingLabel;
    if (typeof value === "string") return value.slice(0, 60);
  } catch {
    // Missing and malformed config keep pi own label.
  }
  return undefined;
}

/** Persist the hidden-thinking label; an empty string hides it. */
export async function saveLiuovoThinkingLabel(label: string, configPath = defaultConfigPath()): Promise<void> {
  await updateConfig({ thinkingLabel: label.slice(0, 60) }, configPath);
}

/** Failed steps stay visible with their parent collapsed; default on. */
export function loadLiuovoGroupRevealErrors(configPath = defaultConfigPath()): boolean {
  try {
    const value = JSON.parse(readFileSync(configPath, "utf8"))?.groupRevealErrors;
    if (typeof value === "boolean") return value;
  } catch {
    // Missing and malformed config keep failures visible.
  }
  return true;
}

export async function saveLiuovoGroup(
  group: LiuovoGroup,
  configPath = defaultConfigPath()
): Promise<void> {
  await updateConfig({ group }, configPath);
}
