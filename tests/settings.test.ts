/**
 * settings.test.ts — the option table validates, resolves and persists every liuovo setting.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRawConfig } from "../config.js";
import {
  applyCommand,
  completions,
  describe,
  readSettings,
  resolveCommand,
  saveSetting,
  settingsSource,
  statusLines,
  usageText,
} from "../settings.js";

/** A scratch liuovo.json so tests never touch the real agent dir. */
async function scratch(config: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "liuovo-settings-"));
  const path = join(dir, "liuovo.json");
  await writeFile(path, JSON.stringify(config), "utf8");
  return path;
}

/** Validate one typed command line the way the /liuovo handler does. */
function run(line: string) {
  const resolved = resolveCommand(line.split(" ").filter(word => word !== ""));
  assert.ok(resolved, "expected " + line + " to match a command");
  return applyCommand(resolved);
}

test("missing settings fall back to the documented defaults", async () => {
  const path = await scratch({});
  const settings = readSettings(path);
  assert.equal(settings.enabled, true);
  assert.equal(settings.mode, "default");
  assert.equal(settings.icons, true);
  assert.equal(settings.iconMode, "auto");
  assert.equal(settings.group, "prompt");
  assert.equal(settings.groupWindow, 4);
  assert.equal(settings.groupRevealErrors, true);
  assert.equal(settings.thinking, "off");
  assert.equal(settings.thinkingLabel, undefined);
});

test("stored junk never reaches the renderer", async () => {
  const path = await scratch({
    enabled: "yes",
    mode: "sideways",
    icons: "maybe",
    iconMode: "runes",
    group: "forever",
    groupWindow: 99,
    thinking: "loud",
    thinkingLabel: "x".repeat(200),
  });
  const settings = readSettings(path);
  assert.equal(settings.enabled, true);
  assert.equal(settings.mode, "default");
  assert.equal(settings.icons, true);
  assert.equal(settings.iconMode, "auto");
  assert.equal(settings.group, "prompt");
  assert.equal(settings.groupWindow, 32);
  assert.equal(settings.thinking, "off");
  assert.equal(settings.thinkingLabel?.length, 60);
});

test("PI_LIUOVO wins over the file and is reported as the source", async () => {
  const path = await scratch({ enabled: true });
  const previous = process.env.PI_LIUOVO;
  process.env.PI_LIUOVO = "off";
  try {
    assert.equal(readSettings(path).enabled, false);
    assert.equal(settingsSource(path), "environment");
  } finally {
    if (previous === undefined) delete process.env.PI_LIUOVO;
    else process.env.PI_LIUOVO = previous;
  }
  assert.equal(settingsSource(path), "file");
});

test("the longest command words win", () => {
  const window = resolveCommand(["group", "window", "6"]);
  assert.deepEqual(window?.command.keys, ["groupWindow"]);
  assert.deepEqual(window?.rest, ["6"]);
  const errors = resolveCommand(["group", "errors", "off"]);
  assert.deepEqual(errors?.command.keys, ["groupRevealErrors"]);
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
  const bogusThinking = run("thinking loud");
  assert.equal(bogusThinking.ok, false);
  assert.match(bogusThinking.ok ? "" : bogusThinking.message, /group \| inline \| off/);
  const emptyLabel = run("thinking label");
  assert.equal(emptyLabel.ok && emptyLabel.value, "");
});

test("saveSetting writes the key it names and round-trips", async () => {
  const path = await scratch({ mode: "default" });
  await saveSetting("groupWindow", 2, path);
  await saveSetting("thinkingLabel", "", path);
  assert.equal(readRawConfig(path).groupWindow, 2);
  const settings = readSettings(path);
  assert.equal(settings.groupWindow, 2);
  assert.equal(settings.thinkingLabel, "");
  assert.match(await readFile(path, "utf8"), /"thinkingLabel": ?""/);
});

test("labels, status lines and usage all come from the table", () => {
  assert.equal(describe("thinkingLabel", undefined), "pi default");
  assert.equal(describe("thinkingLabel", ""), "hidden");
  assert.equal(describe("thinkingLabel", "hmm"), '"hmm"');
  const settings = readSettings("/nonexistent/liuovo.json");
  const lines = statusLines(settings, ["mode", "thinkingLabel"]);
  assert.deepEqual(lines, ["mode: default", "thinkingLabel: pi default"]);
  assert.match(usageText(), /thinking label/);
  assert.ok(completions().includes("group window status"));
  assert.ok(completions().includes("thinking label "));
  assert.ok(completions().includes("icons ascii"));
});
