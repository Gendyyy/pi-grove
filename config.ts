import { promises as fs, readFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import type { IconMode } from "./icons.js";

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

/** Calls kept visible in a running codemode card; the settled card folds to its heading. */
export const DEFAULT_COLLAPSED_CALLS = 5;
/** Upper bound keeps a running card readable; the rest stays behind Ctrl+O. */
export const MAX_COLLAPSED_CALLS = 32;

/** Resolve the running-card call window; an out-of-range value keeps the default. */
export function loadLiuovoCollapsedCalls(configPath = defaultConfigPath()): number {
  try {
    const value = JSON.parse(readFileSync(configPath, "utf8"))?.collapsedCalls;
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_COLLAPSED_CALLS)
      return value;
  } catch {
    // Missing and malformed config preserve the default window.
  }
  return DEFAULT_COLLAPSED_CALLS;
}

/** Resolve whether consecutive tool cards of one assistant turn share a card. */
export function loadLiuovoTurnGroups(configPath = defaultConfigPath()): boolean {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.turnGroups === false)
      return false;
  } catch {
    // Missing and malformed config keep turn grouping enabled.
  }
  return true;
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

/** Persist the running-card call window after clamping it to the supported range. */
export function saveLiuovoCollapsedCalls(
  calls: number,
  configPath = defaultConfigPath()
): Promise<void> {
  const clamped = Math.min(MAX_COLLAPSED_CALLS, Math.max(1, Math.trunc(calls)));
  return updateConfig({ collapsedCalls: clamped }, configPath);
}

export async function saveLiuovoMode(
  mode: LiuovoMode,
  configPath = defaultConfigPath()
): Promise<void> {
  await updateConfig({ mode }, configPath);
}

/** Persist the turn-group switch; enabled stays the default. */
export function saveLiuovoTurnGroups(
  turnGroups: boolean,
  configPath = defaultConfigPath()
): Promise<void> {
  return updateConfig({ turnGroups }, configPath);
}

export async function saveLiuovoIcons(
  icons: boolean,
  configPath = defaultConfigPath()
): Promise<void> {
  await updateConfig({ icons }, configPath);
}
