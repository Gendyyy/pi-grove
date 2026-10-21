/**
 * tests/patch.test.ts — the thinking filter has to find pi's assistant renderer wherever
 * that release keeps it, and must say so when it cannot, instead of failing silently.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { candidateModules, installThinkingFilter } from "../pi-patch.js";

/** The class pi renders one assistant message with, in the shape the patch looks for. */
const COMPONENT = [
  "export class AssistantMessageComponent {",
  "  constructor() { this.message = undefined; }",
  "  updateContent(message) { this.message = message; }",
  "  setHiddenThinkingLabel() {}",
  "}",
  "",
].join("\n");

/** Build a fake pi install whose only module sits at the given relative path. */
function fakePi(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "liuovo-pi-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.0" }));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

/** A message with one reasoning part and one text part. */
function message(): { content: Array<{ type: string; thinking?: string; text?: string }> } {
  return { content: [{ type: "thinking", thinking: "weigh the options" }, { type: "text", text: "done" }] };
}

test("the modular renderer is found and loses its thinking parts", async () => {
  const relative = "dist/modes/interactive/components/assistant-message.js";
  const root = fakePi({ [relative]: COMPONENT });
  const status = await installThinkingFilter({ root });
  assert.equal(status.installed, true);
  assert.deepEqual(status.modules, [relative]);

  const module = (await import(pathToFileURL(join(root, relative)).href)) as {
    AssistantMessageComponent: new () => { message?: { content: unknown[] }; updateContent(value: unknown): void };
  };
  const component = new module.AssistantMessageComponent();
  component.updateContent(message());
  // The session data keeps its reasoning; only the rendered copy drops it.
  assert.equal(component.message?.content.length, 1);
});

test("a bundled chunk is found when the known paths are gone", async () => {
  const root = fakePi({
    "dist/bundle/chunks/chunk-aaa.js": COMPONENT,
    // A chunk without the hint is never imported, so a wrong hit cannot patch the wrong class.
    "dist/bundle/chunks/chunk-bbb.js": "export const unrelated = 1;\n",
  });
  const found = candidateModules(root);
  assert.deepEqual(found, ["dist/bundle/chunks/chunk-aaa.js"]);
  const status = await installThinkingFilter({ root });
  assert.equal(status.installed, true);
  assert.match(status.detail, /chunk-aaa\.js/);
});

test("an install with no renderer reports why instead of failing silently", async () => {
  const root = fakePi({ "dist/index.js": "export const nothing = true;\n" });
  const status = await installThinkingFilter({ root });
  assert.equal(status.installed, false);
  assert.match(status.detail, /no assistant renderer/);
  assert.deepEqual(status.modules, []);
});

test("patching the same class twice is harmless", async () => {
  const relative = "dist/bundle/index.js";
  const root = fakePi({ [relative]: COMPONENT });
  const first = await installThinkingFilter({ root });
  const module = (await import(pathToFileURL(join(root, relative)).href)) as {
    AssistantMessageComponent: new () => { message?: { content: unknown[] }; updateContent(value: unknown): void };
  };
  const component = new module.AssistantMessageComponent();
  component.updateContent(message());
  assert.equal(first.installed, true);
  // A second pass must not wrap the wrapper and strip twice.
  const second = await installThinkingFilter({ root });
  assert.equal(second.installed, true);
  const again = new module.AssistantMessageComponent();
  again.updateContent(message());
  assert.equal(again.message?.content.length, 1);
});
