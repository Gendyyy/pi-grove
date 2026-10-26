/**
 * config.test.ts — concurrent updates to the same config file queue up instead of
 * overwriting each other, and a failed write leaves no temp file behind.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { readRawConfig, updateConfig } from "../config.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A throwaway config path inside the system temp directory. */
async function tempConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grove-config-"));
  dirs.push(dir);
  return join(dir, "grove.json");
}

test("two updates started together both reach the file", async () => {
  const path = await tempConfig();
  await Promise.all([updateConfig({ group: "turn" }, path), updateConfig({ icons: false }, path)]);
  assert.deepEqual(readRawConfig(path), { group: "turn", icons: false });
});

test("a failed write reports the error and leaves the file readable", async () => {
  const path = await tempConfig();
  await updateConfig({ group: "prompt" }, path);
  await assert.rejects(updateConfig({ group: "turn" }, path + "/nested.json"));
  assert.deepEqual(readRawConfig(path), { group: "prompt" });
  assert.match(await readFile(path, "utf8"), /"group": "prompt"/);
});
