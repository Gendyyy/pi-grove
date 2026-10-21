/**
 * settings.ts — the single table of liuovo options. Defaults, validation, persistence,
 * command words and completions are all derived from it, so a new option is one entry.
 */
import { defaultConfigPath, parseEnabled, readRawConfig, updateConfig } from "./config.js";
import type { IconMode } from "./icons.js";

/** Glyph sets in the order the pickers offer them. */
export const ICON_MODES: readonly IconMode[] = ["auto", "nerd", "ascii"];
export const MODES = ["default", "reasoning", "result"] as const;
export const GROUPS = ["prompt", "turn", "message", "off"] as const;
export const THINKINGS = ["group", "inline", "off"] as const;

/** What one tool row leads with. */
export type LiuovoMode = (typeof MODES)[number];
/** Where one collapsed card ends. */
export type LiuovoGroup = (typeof GROUPS)[number];
/** Where reasoning appears: inside the card, as pi rows, or nowhere. */
export type LiuovoThinking = (typeof THINKINGS)[number];

/** The validated settings liuovo actually runs with. */
export interface LiuovoSettings {
  enabled: boolean;
  mode: LiuovoMode;
  icons: boolean;
  iconMode: IconMode;
  group: LiuovoGroup;
  groupWindow: number;
  groupRevealErrors: boolean;
  thinking: LiuovoThinking;
  /** Absent leaves pi's own hidden-thinking label alone; empty hides those lines. */
  thinkingLabel: string | undefined;
}

export type SettingKey = keyof LiuovoSettings;
export type SettingValue = boolean | number | string | undefined;
export type SettingKind = "boolean" | "enum" | "number" | "text";

/** One option: how to validate it, what it falls back to, and how to describe it. */
export interface SettingSpec {
  key: SettingKey;
  kind: SettingKind;
  values?: readonly string[];
  min?: number;
  max?: number;
  fallback?: boolean | number | string;
  summary: string;
}

/** Hidden labels are clamped: they occupy one line, not a paragraph. */
const LABEL_MAX = 60;
const WINDOW_MAX = 32;

export const SETTINGS: readonly SettingSpec[] = [
  { key: "enabled", kind: "boolean", fallback: true, summary: "render liuovo at all; PI_LIUOVO overrides" },
  { key: "mode", kind: "enum", values: MODES, fallback: "default", summary: "what a tool row leads with" },
  { key: "icons", kind: "boolean", fallback: true, summary: "draw tool icons" },
  { key: "iconMode", kind: "enum", values: ICON_MODES, fallback: "auto", summary: "which glyph set to use" },
  { key: "group", kind: "enum", values: GROUPS, fallback: "prompt", summary: "where one collapsed card ends" },
  { key: "groupWindow", kind: "number", min: 1, max: WINDOW_MAX, fallback: 4, summary: "how many recent calls stay visible" },
  { key: "groupRevealErrors", kind: "boolean", fallback: true, summary: "keep failed steps visible while collapsed" },
  { key: "thinking", kind: "enum", values: THINKINGS, fallback: "off", summary: "where reasoning appears" },
  { key: "thinkingLabel", kind: "text", summary: "text pi prints for a hidden thinking run; empty hides it" },
];

const BY_KEY = new Map(SETTINGS.map(spec => [spec.key, spec]));

/** Look up one option's spec; the table is the only source of truth. */
export function settingSpec(key: SettingKey): SettingSpec {
  const spec = BY_KEY.get(key);
  if (!spec) throw new Error("unknown liuovo setting: " + key);
  return spec;
}

/** Apply one option's validation rules to a stored value, falling back when it fails. */
function coerce(spec: SettingSpec, raw: unknown): SettingValue {
  switch (spec.kind) {
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      return parseEnabled(raw) ?? asBoolean(spec.fallback);
    }
    case "enum": {
      if (typeof raw === "string" && (spec.values ?? []).includes(raw)) return raw;
      return typeof spec.fallback === "string" ? spec.fallback : undefined;
    }
    case "number": {
      if (typeof raw === "number" && Number.isFinite(raw)) return clamp(spec, raw);
      return typeof spec.fallback === "number" ? spec.fallback : undefined;
    }
    case "text": {
      return typeof raw === "string" ? raw.slice(0, LABEL_MAX) : undefined;
    }
  }
}

function asBoolean(value: SettingSpec["fallback"]): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Keep a number inside the range its spec declares. */
function clamp(spec: SettingSpec, value: number): number {
  const rounded = Math.round(value);
  const low = spec.min ?? rounded;
  const high = spec.max ?? rounded;
  return Math.min(high, Math.max(low, rounded));
}

function readFlag(spec: SettingSpec, raw: unknown, fallback: boolean): boolean {
  const value = coerce(spec, raw);
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(spec: SettingSpec, raw: unknown, fallback: number): number {
  const value = coerce(spec, raw);
  return typeof value === "number" ? value : fallback;
}

function readChoice<T extends string>(spec: SettingSpec, raw: unknown, values: readonly T[], fallback: T): T {
  const stored = coerce(spec, raw);
  return values.find(value => value === stored) ?? fallback;
}

/** Read and validate every option once, so callers never re-read the file per key. */
export function readSettings(configPath = defaultConfigPath()): LiuovoSettings {
  const raw = readRawConfig(configPath);
  return {
    // A valid PI_LIUOVO value wins over the file, so a shell can pin liuovo on or off.
    enabled: parseEnabled(process.env.PI_LIUOVO) ?? readFlag(settingSpec("enabled"), raw.enabled, true),
    mode: readChoice(settingSpec("mode"), raw.mode, MODES, "default"),
    icons: readFlag(settingSpec("icons"), raw.icons, true),
    iconMode: readChoice(settingSpec("iconMode"), raw.iconMode, ICON_MODES, "auto"),
    group: readChoice(settingSpec("group"), raw.group, GROUPS, "prompt"),
    groupWindow: readNumber(settingSpec("groupWindow"), raw.groupWindow, 4),
    groupRevealErrors: readFlag(settingSpec("groupRevealErrors"), raw.groupRevealErrors, true),
    thinking: readChoice(settingSpec("thinking"), raw.thinking, THINKINGS, "off"),
    thinkingLabel: (() => {
      const value = coerce(settingSpec("thinkingLabel"), raw.thinkingLabel);
      return typeof value === "string" ? value : undefined;
    })(),
  };
}

export type SettingsSource = "environment" | "file" | "default";

/** Where the enabled flag came from, so /liuovo status can explain a refusal to save. */
export function settingsSource(configPath = defaultConfigPath()): SettingsSource {
  if (parseEnabled(process.env.PI_LIUOVO) !== undefined) return "environment";
  return readRawConfig(configPath).enabled === undefined ? "default" : "file";
}

/** A command word sequence and the options it can set. */
export interface CommandSpec {
  words: readonly string[];
  keys: readonly SettingKey[];
}

/** Longest words first: "group window" must win before "group" sees the line. */
export const COMMANDS: readonly CommandSpec[] = [
  { words: ["mode"], keys: ["mode"] },
  { words: ["icons"], keys: ["icons", "iconMode"] },
  { words: ["group", "window"], keys: ["groupWindow"] },
  { words: ["group", "errors"], keys: ["groupRevealErrors"] },
  { words: ["group"], keys: ["group"] },
  { words: ["thinking", "label"], keys: ["thinkingLabel"] },
  { words: ["thinking"], keys: ["thinking"] },
];

/** Pick the command whose words match the longest prefix of the typed line. */
export function resolveCommand(words: readonly string[]): { command: CommandSpec; rest: string[] } | undefined {
  const lowered = words.map(word => word.toLowerCase());
  const ordered = [...COMMANDS].sort((left, right) => right.words.length - left.words.length);
  for (const command of ordered) {
    if (command.words.every((word, index) => lowered[index] === word)) {
      return { command, rest: words.slice(command.words.length) };
    }
  }
  return undefined;
}

/** Pick which option a command means when one word sets more than one (icons on / icons nerd). */
function pickKey(command: CommandSpec, rest: readonly string[]): { key: SettingKey; text: string } | undefined {
  const text = rest.join(" ").trim();
  for (const key of command.keys) {
    if (command.keys.length === 1) return { key, text };
    const spec = settingSpec(key);
    if (spec.kind === "boolean" && parseEnabled(text) !== undefined) return { key, text };
    if (spec.kind === "enum" && (spec.values ?? []).includes(text.toLowerCase())) return { key, text };
  }
  return undefined;
}

export type SettingOutcome =
  | { ok: true; key: SettingKey; value: SettingValue; display: string }
  | { ok: false; message: string };

/** Validate a typed value against the option it names. */
export function parseValue(key: SettingKey, text: string): SettingOutcome {
  const spec = settingSpec(key);
  const typed = text.trim();
  if (spec.kind === "text") {
    const value = typed.slice(0, LABEL_MAX);
    return { ok: true, key, value, display: describe(key, value) };
  }
  if (spec.kind === "boolean") {
    const value = parseEnabled(typed);
    if (value === undefined) return { ok: false, message: key + " takes on or off" };
    return { ok: true, key, value, display: describe(key, value) };
  }
  if (spec.kind === "enum") {
    const values = spec.values ?? [];
    const value = values.find(choice => choice === typed.toLowerCase());
    if (value === undefined) return { ok: false, message: key + " takes " + values.join(" | ") };
    return { ok: true, key, value, display: describe(key, value) };
  }
  const parsed = Number(typed);
  if (typed === "" || !Number.isFinite(parsed)) return { ok: false, message: key + " takes a whole number" };
  const value = clamp(spec, parsed);
  return { ok: true, key, value, display: describe(key, value) };
}

/** Resolve a matched command and its arguments into one validated change. */
export function applyCommand(resolved: { command: CommandSpec; rest: readonly string[] }): SettingOutcome {
  const picked = pickKey(resolved.command, resolved.rest);
  if (!picked) {
    const keys = resolved.command.keys.map(key => key + " (" + allowedText(key) + ")").join(" or ");
    return { ok: false, message: "usage: " + resolved.command.words.join(" ") + " " + keys };
  }
  return parseValue(picked.key, picked.text);
}

/** Allowed values for one option, for messages and usage text. */
export function allowedText(key: SettingKey): string {
  const spec = settingSpec(key);
  if (spec.kind === "boolean") return "on | off";
  if (spec.kind === "enum") return (spec.values ?? []).join(" | ");
  if (spec.kind === "number") return "a number " + String(spec.min ?? 1) + "-" + String(spec.max ?? WINDOW_MAX);
  return "any text";
}

/** Render one option's value the way the user should read it back. */
export function describe(key: SettingKey, value: SettingValue): string {
  if (key === "thinkingLabel") {
    if (value === undefined) return "pi default";
    if (value === "") return "hidden";
    return JSON.stringify(value);
  }
  return String(value);
}

/** The value a setting currently holds, for change detection and status output. */
export function currentValue(settings: LiuovoSettings, key: SettingKey): SettingValue {
  return settings[key];
}

/** One line per option; the default set is every option liuovo owns. */
export function statusLines(
  settings: LiuovoSettings,
  keys: readonly SettingKey[] = SETTINGS.map(spec => spec.key)
): string[] {
  return keys.map(key => key + ": " + describe(key, currentValue(settings, key)));
}

/** Persist one option; the key names the JSON field, so nothing else needs editing. */
export function saveSetting(key: SettingKey, value: SettingValue, configPath = defaultConfigPath()): Promise<void> {
  return updateConfig({ [key]: value }, configPath);
}

/** Every command form /liuovo offers, derived so a new option cannot be forgotten. */
export function completions(): string[] {
  const entries: string[] = [];
  for (const command of COMMANDS) {
    const words = command.words.join(" ");
    entries.push(words, words + " status");
    for (const key of command.keys) {
      const spec = settingSpec(key);
      if (spec.kind === "enum") for (const value of spec.values ?? []) entries.push(words + " " + value);
      if (spec.kind === "boolean") entries.push(words + " on", words + " off");
      if (spec.kind === "number") entries.push(words + " " + String(spec.fallback ?? 4));
      if (spec.kind === "text") entries.push(words + " ");
    }
  }
  return [...new Set(entries)];
}

/** Usage text built from the same table, so it cannot drift from the parser. */
export function usageText(): string {
  const commands = COMMANDS.map(command => command.words.join(" ") + " " + command.keys.map(allowedText).join(" | "));
  return "Usage: /liuovo setup|status|teardown|on|off|toggle, or " + commands.join(", ") + " (append status to read).";
}
