/**
 * config.ts — where liuovo keeps its settings on disk, and how those writes stay atomic.
 * Validation and defaults live in settings.ts; this module owns only the file.
 */
import { promises as fs, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Mirrors pi getAgentDir() without importing the host: this module must stay pure node. */
export function agentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override) return override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
  return join(homedir(), ".pi", "agent");
}

/** The file liuovo reads and merges; resolved per call so a redirected run is honoured. */
export function configPath(): string {
  return join(agentDir(), "liuovo.json");
}

/** Config path redirect for hermetic tests and sandboxed runs; unset means the user path. */
export function defaultConfigPath(): string {
  return process.env.PI_LIUOVO_CONFIG ?? configPath();
}

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
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

/** Read the stored settings as a plain object; a missing or malformed file reads as empty. */
export function readRawConfig(configPath = defaultConfigPath()): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing, unreadable, and malformed config all read as "nothing stored".
  }
  return {};
}

/** Merge one update into the config file atomically, so a crash cannot truncate it. */
export async function updateConfig(
  update: Record<string, unknown>,
  configPath = defaultConfigPath()
): Promise<void> {
  const current = readRawConfig(configPath);
  const directory = dirname(configPath);
  const temporaryPath = configPath + "." + process.pid + "." + Date.now() + ".tmp";
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(temporaryPath, JSON.stringify({ ...current, ...update }, null, 2) + "\n", "utf8");
    await fs.rename(temporaryPath, configPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
