/**
 * settings.test.ts — the option table validates, resolves and persists every grove setting.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { SettingsList } from "@earendil-works/pi-tui";
import { readRawConfig } from "../config.js";
import {
  applyCommand,
  completions,
  describe,
  readSettings,
  resolveCommand,
  panelRows,
  panelValue,
  parseValue,
  persistPanelSetting,
  SETTINGS,
  saveSetting,
  settingsSource,
  statusLines,
  usageText,
  withSetting,
} from "../settings.js";

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

/** A scratch grove.json so tests never touch the real agent dir. */
async function scratch(config: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grove-settings-"));
  scratchDirs.push(dir);
  const path = join(dir, "grove.json");
  await writeFile(path, JSON.stringify(config), "utf8");
  return path;
}

/** Validate one typed command line the way the /grove handler does. */
function run(line: string) {
  const resolved = resolveCommand(line.split(" ").filter(word => word !== ""));
  assert.ok(resolved, "expected " + line + " to match a command");
  return applyCommand(resolved);
}

test("settings classify startup composition separately from live presentation", () => {
  const reload = SETTINGS.filter(spec => spec.apply === "reload").map(spec => spec.key);
  const live = SETTINGS.filter(spec => spec.apply === "live").map(spec => spec.key);
  assert.deepEqual(reload, ["enabled", "mode", "group", "thinking"]);
  assert.deepEqual(live, ["icons", "iconMode", "groupWindow", "groupRevealErrors", "groupNestedTools", "groupToolNames", "groupProgress", "groupSparkline", "groupGutter", "thinkingLabel"]);
  const rows = panelRows(readSettings("/nonexistent/grove.json"));
  assert.match(rows.find(row => row.key === "groupProgress")?.description ?? "", /applies immediately/);
  assert.match(rows.find(row => row.key === "group")?.description ?? "", /requires Grove reload/);
});

test("visibility defaults preserve current output and nested error visibility stays opt-in", async () => {
  const path = await scratch({});
  const settings = readSettings(path);
  assert.equal(settings.enabled, true);
  assert.equal(settings.mode, "reasoning");
  assert.equal(settings.icons, true);
  assert.equal(settings.iconMode, "auto");
  assert.equal(settings.group, "prompt");
  assert.equal(settings.groupWindow, 5);
  assert.equal(settings.groupRevealErrors, false);
  assert.equal(readSettings(await scratch({ groupRevealErrors: true })).groupRevealErrors, true);
  assert.equal(settings.groupNestedTools, true);
  assert.equal(settings.groupToolNames, true);
  assert.equal(settings.groupProgress, true);
  assert.equal(settings.groupSparkline, true);
  const hidden = readSettings(await scratch({ groupNestedTools: false, groupToolNames: false, groupProgress: false, groupSparkline: false }));
  assert.equal(hidden.groupNestedTools, false);
  assert.equal(hidden.groupToolNames, false);
  assert.equal(hidden.groupProgress, false);
  assert.equal(hidden.groupSparkline, false);
  assert.equal(settings.thinking, "off");
  assert.equal(settings.thinkingLabel, "");
});

test("stored junk never reaches the renderer", async () => {
  const path = await scratch({
    enabled: "yes",
    mode: "sideways",
    icons: "maybe",
    iconMode: "runes",
    group: "forever",
    groupWindow: 99,
    groupNestedTools: "maybe",
    groupToolNames: "maybe",
    groupProgress: "maybe",
    groupSparkline: "maybe",
    thinking: "loud",
    thinkingLabel: "x".repeat(200),
  });
  const settings = readSettings(path);
  assert.equal(settings.enabled, true);
  assert.equal(settings.mode, "reasoning");
  assert.equal(settings.icons, true);
  assert.equal(settings.iconMode, "auto");
  assert.equal(settings.group, "prompt");
  assert.equal(settings.groupWindow, 32);
  assert.equal(settings.groupNestedTools, true);
  assert.equal(settings.groupToolNames, true);
  assert.equal(settings.groupProgress, true);
  assert.equal(settings.groupSparkline, true);
  assert.equal(settings.thinking, "off");
  assert.equal(settings.thinkingLabel?.length, 60);
});

test("PI_GROVE wins over the file and is reported as the source", async () => {
  const path = await scratch({ enabled: true });
  const previous = process.env.PI_GROVE;
  process.env.PI_GROVE = "off";
  try {
    assert.equal(readSettings(path).enabled, false);
    assert.equal(settingsSource(path), "environment");
  } finally {
    if (previous === undefined) delete process.env.PI_GROVE;
    else process.env.PI_GROVE = previous;
  }
  assert.equal(settingsSource(path), "file");
});

test("the longest command words win", () => {
  const window = resolveCommand(["group", "window", "6"]);
  assert.deepEqual(window?.command.keys, ["groupWindow"]);
  assert.deepEqual(window?.rest, ["6"]);
  const errors = resolveCommand(["group", "errors", "off"]);
  assert.deepEqual(errors?.command.keys, ["groupRevealErrors"]);
  assert.deepEqual(resolveCommand(["group", "nested", "off"])?.command.keys, ["groupNestedTools"]);
  assert.deepEqual(resolveCommand(["group", "tool-names", "off"])?.command.keys, ["groupToolNames"]);
  assert.deepEqual(resolveCommand(["group", "progress", "off"])?.command.keys, ["groupProgress"]);
  assert.deepEqual(resolveCommand(["group", "sparkline", "off"])?.command.keys, ["groupSparkline"]);
  const label = resolveCommand(["thinking", "label", "warming", "up"]);
  assert.deepEqual(label?.command.keys, ["thinkingLabel"]);
  assert.deepEqual(label?.rest, ["warming", "up"]);
  const plain = resolveCommand(["group", "turn"]);
  assert.deepEqual(plain?.command.keys, ["group"]);
  assert.equal(resolveCommand(["nonsense"]), undefined);
});

test("values are validated before they are saved", () => {
  const iconsOn = run("icons on");
  assert.equal(iconsOn.ok, true);
  assert.equal(iconsOn.ok && iconsOn.key, "icons");
  const iconsNerd = run("icons nerd");
  assert.equal(iconsNerd.ok && iconsNerd.key, "iconMode");
  const badIcons = run("icons maybe");
  assert.equal(badIcons.ok, false);
  const clamped = run("group window 99");
  assert.equal(clamped.ok && clamped.value, 32);
  const nested = run("group nested off");
  assert.equal(nested.ok && nested.key, "groupNestedTools");
  const toolNames = run("group tool-names off");
  assert.equal(toolNames.ok && toolNames.key, "groupToolNames");
  assert.equal(toolNames.ok && toolNames.value, false);
  const progress = run("group progress off");
  assert.equal(progress.ok && progress.key, "groupProgress");
  const sparkline = run("group sparkline off");
  assert.equal(sparkline.ok && sparkline.key, "groupSparkline");
  const bogusThinking = run("thinking loud");
  assert.equal(bogusThinking.ok, false);
  assert.match(bogusThinking.ok ? "" : bogusThinking.message, /group \| inline \| off/);
  const emptyLabel = run("thinking label");
  assert.equal(emptyLabel.ok && emptyLabel.value, "");
});

test("saveSetting writes the key it names and round-trips", async () => {
  const path = await scratch({ mode: "default" });
  await saveSetting("groupWindow", 2, path);
  await saveSetting("groupNestedTools", false, path);
  await saveSetting("groupToolNames", false, path);
  await saveSetting("groupProgress", false, path);
  await saveSetting("groupSparkline", false, path);
  await saveSetting("thinkingLabel", "", path);
  assert.equal(readRawConfig(path).groupWindow, 2);
  const settings = readSettings(path);
  assert.equal(settings.groupWindow, 2);
  assert.equal(settings.groupNestedTools, false);
  assert.equal(settings.groupToolNames, false);
  assert.equal(settings.groupProgress, false);
  assert.equal(settings.groupSparkline, false);
  assert.equal(settings.thinkingLabel, "");
  assert.match(await readFile(path, "utf8"), /"thinkingLabel": ?""/);
});

test("labels, status lines and usage all come from the table", () => {
  assert.equal(describe("thinkingLabel", undefined), "pi default");
  assert.equal(describe("thinkingLabel", ""), "hidden");
  assert.equal(describe("thinkingLabel", "hmm"), '"hmm"');
  const settings = readSettings("/nonexistent/grove.json");
  const lines = statusLines(settings, ["mode", "thinkingLabel"]);
  assert.deepEqual(lines, ["mode: reasoning", "thinkingLabel: hidden"]);
  assert.match(usageText(), /thinking label/);
  assert.match(usageText(), /group progress/);
  assert.ok(completions().includes("group window status"));
  assert.ok(completions().includes("group nested off"));
  assert.ok(completions().includes("group tool-names off"));
  assert.ok(completions().includes("group progress off"));
  assert.ok(completions().includes("group sparkline off"));
  assert.ok(completions().includes("thinking label "));
  assert.ok(completions().includes("icons ascii"));
});

test("every option becomes one panel row with a label and a value to cycle", () => {
  const settings = readSettings("/nonexistent/grove.json");
  const rows = panelRows(settings);
  assert.equal(rows.length, SETTINGS.length);
  for (const row of rows) {
    assert.ok(row.label.length > 0, row.key + " needs a label");
    assert.ok(row.description.length > 0, row.key + " needs a description");
    assert.ok(row.currentValue.length > 0, row.key + " needs a current value");
    if (row.choices) assert.ok(row.choices.includes(row.currentValue), row.key + " current value must be cycleable");
  }
  assert.equal(new Set(rows.map(row => row.label)).size, rows.length, "labels must be unique");
  assert.deepEqual(rows.find(row => row.key === "icons")?.choices, ["on", "off"]);
  assert.ok(rows.find(row => row.key === "groupWindow")?.choices?.includes("4"));
  // The free-text option opens an editor instead of cycling.
  assert.equal(rows.find(row => row.key === "thinkingLabel")?.choices, undefined);
});

test("boolean panel rows keep cycling through Space and Enter", () => {
  const row = panelRows(readSettings("/nonexistent/grove.json")).find(row => row.key === "groupToolNames");
  assert.ok(row?.choices);
  const item = {
    id: row.key,
    label: row.label,
    currentValue: row.currentValue,
    values: [...row.choices],
  };
  const changes: string[] = [];
  const theme = {
    label: (text: string) => text,
    value: (text: string) => text,
    description: (text: string) => text,
    cursor: "> ",
    hint: (text: string) => text,
  };
  const list = new SettingsList([item], 5, theme, (_id, value) => {
    changes.push(value);
    const outcome = parseValue(row.key, value);
    assert.ok(outcome.ok);
    if (outcome.ok) item.currentValue = panelValue(row.key, outcome.value);
  }, () => {});

  list.handleInput(" ");
  list.handleInput("\r");
  list.handleInput(" ");

  assert.deepEqual(changes, ["off", "on", "off"]);
});

test("panel persistence applies live settings and flags lifecycle changes", async () => {
  const path = await scratch({});
  const liveChanges: Array<[string, unknown]> = [];
  const warnings: string[] = [];
  const onLiveChange = (key: import("../settings.js").SettingKey, value: import("../settings.js").SettingValue) => {
    liveChanges.push([key, value]);
  };

  const reloadForLiveSetting = await persistPanelSetting("groupToolNames", false, path, onLiveChange, message => warnings.push(message));
  assert.equal(reloadForLiveSetting, false);
  assert.deepEqual(liveChanges, [["groupToolNames", false]]);
  assert.equal(readSettings(path).groupToolNames, false);

  const reloadForGrouping = await persistPanelSetting("group", "turn", path, onLiveChange, message => warnings.push(message));
  assert.equal(reloadForGrouping, true);
  assert.equal(readSettings(path).group, "turn");
  assert.deepEqual(liveChanges, [["groupToolNames", false]], "reload-only options do not use the live callback");
  assert.deepEqual(warnings, []);
});

test("panel persistence requires reload if live application is unavailable or fails", async () => {
  const path = await scratch({});
  const warnings: string[] = [];
  assert.equal(await persistPanelSetting("icons", false, path, undefined, message => warnings.push(message)), true);
  assert.equal(await persistPanelSetting("icons", true, path, () => { throw new Error("renderer unavailable"); }, message => warnings.push(message)), true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not apply it live/);
});

test("a value of the wrong kind never lands in the settings", () => {
  const settings = readSettings("/nonexistent/grove.json");
  assert.equal(withSetting(settings, "groupWindow", 8).groupWindow, 8);
  assert.equal(withSetting(settings, "groupWindow", "8").groupWindow, 5);
  assert.equal(withSetting(settings, "icons", false).icons, false);
  assert.equal(withSetting(settings, "icons", "off").icons, true);
  assert.equal(withSetting(settings, "thinkingLabel", "").thinkingLabel, "");
  assert.equal(withSetting(settings, "mode", "reasoning").mode, "reasoning");
});
