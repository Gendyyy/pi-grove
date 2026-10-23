import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CODEMODE_GROUP_GUIDANCE, codemodeGroupMetadataViolation, registerToolUi } from "../tool-ui.js";

const script = (...lines: string[]) => lines.join("\n");
const intent = "// task-intent: Make payment retries safe from duplicate charges";
const progress = "// task-progress: 6";
const plan = "// task-milestones: inspect=Inspect; build=Build; verify=Verify";
const phase = "// task-milestone: inspect";
test("grouped top-level codemode calls require stable identity and current progress", () => {
  const missingTask = {
    toolName: "codemode",
    input: { code: script("// reasoning: inspect the retry path", "return 1;") },
  };
  assert.match(codemodeGroupMetadataViolation(missingTask, "prompt") ?? "", /requires a model-written.*task-intent/);

  const missingProgress = {
    toolName: "codemode",
    input: { code: script("// reasoning: inspect the retry path", intent, "return 1;") },
  };
  assert.match(codemodeGroupMetadataViolation(missingProgress, "prompt") ?? "", /task-progress.*every top-level call/);

  const invalidProgress = {
    toolName: "codemode",
    input: { code: script("// reasoning: inspect the retry path", intent, "// task-progress: 101", "return 1;") },
  };
  assert.match(codemodeGroupMetadataViolation(invalidProgress, "prompt") ?? "", /task-progress/);

  const validTask = {
    toolName: "codemode",
    input: { code: script("// reasoning: inspect the retry path", intent, progress, plan, phase, "return 1;") },
  };
  const missingPlan = {
    toolName: "codemode",
    input: { code: script("// reasoning: inspect the retry path", intent, progress, "return 1;") },
  };
  assert.match(codemodeGroupMetadataViolation(missingPlan, "prompt") ?? "", /task-milestones.*last phase is verify/);

  const missingPhase = {
    toolName: "codemode",
    input: { code: script("// reasoning: inspect the retry path", intent, progress, plan, "return 1;") },
  };
  assert.match(codemodeGroupMetadataViolation(missingPhase, "prompt") ?? "", /task-milestone: <id> naming the phase/);

  const foreignPhase = {
    toolName: "codemode",
    input: { code: script("// reasoning: inspect the retry path", intent, progress, plan, "// task-milestone: deploy", "return 1;") },
  };
  assert.match(codemodeGroupMetadataViolation(foreignPhase, "prompt") ?? "", /must name a phase from the declared/);

  assert.equal(codemodeGroupMetadataViolation(validTask, "prompt"), undefined);

  const annotated = {
    toolName: "codemode",
    input: { code: script(
      '// @options: {"timeout_ms": 2000}',
      "// reasoning: inspect the retry path",
      intent,
      progress,
      plan,
      phase,
      "// group-phase: ignored legacy annotation",
      "return 1;",
    ) },
  };
  assert.equal(codemodeGroupMetadataViolation(annotated, "prompt"), undefined);

  assert.equal(codemodeGroupMetadataViolation(missingTask, "off"), undefined);
  assert.equal(codemodeGroupMetadataViolation({ ...missingTask, toolName: "bash" }, "prompt"), undefined);
  assert.equal(codemodeGroupMetadataViolation({ ...missingTask, parentToolCallId: "parent" }, "prompt"), undefined);
});

test("registerToolUi injects stable-title guidance and blocks missing identity", () => {
  const handlers = new Map<string, (event: unknown, context?: unknown) => unknown>();
  const pi = {
    on(name: string, handler: (event: unknown, context?: unknown) => unknown) {
      handlers.set(name, handler);
      return () => {};
    },
    registerToolRenderer() {},
  } as unknown as ExtensionAPI;
  const controller = registerToolUi(pi, {
    tools: new Set(),
    mode: "reasoning",
    icons: false,
    iconMode: "ascii",
    group: "prompt",
    groupRevealErrors: true,
    groupWindow: 5,
    groupNestedTools: true,
    groupProgress: true,
    groupSparkline: true,
    thinking: "inline",
  });
  controller.updateSettings({ groupProgress: false, groupWindow: 3 });

  const promptEvent = { systemPromptOptions: { selectedTools: ["codemode"], sections: {} as Record<string, string> } };
  handlers.get("before_agent_start")?.(promptEvent);
  assert.match(promptEvent.systemPromptOptions.sections.grove_tool_ui ?? "", /must include a model-written.*task-intent:.*task-progress:/s);
  assert.match(promptEvent.systemPromptOptions.sections.grove_tool_ui ?? "", /stable border title, not a phase update/);
  assert.match(promptEvent.systemPromptOptions.sections.grove_tool_ui ?? "", /best judgment.*not.*tool-call count.*fixed denominator/s);
  assert.match(promptEvent.systemPromptOptions.sections.grove_tool_ui ?? "", /final tool call.*100.*only after that call succeeds/s);
  assert.match(promptEvent.systemPromptOptions.sections.grove_tool_ui ?? "", /one to seven short labeled phases/);
  assert.match(promptEvent.systemPromptOptions.sections.grove_tool_ui ?? "", /task-milestone: <id>.*every top-level call/);
  assert.match(promptEvent.systemPromptOptions.sections.grove_tool_ui ?? "", /phase state stays independent of the percentage/);
  assert.doesNotMatch(promptEvent.systemPromptOptions.sections.grove_tool_ui ?? "", /group-phase/);

  const toolCall = handlers.get("tool_call")!;
  const missingTask = toolCall({
    toolName: "codemode",
    input: { code: script("// reasoning: inspect the retry path", "return 1;") },
  }) as { block?: boolean; reason?: string } | undefined;
  assert.equal(missingTask?.block, true);
  assert.match(missingTask?.reason ?? "", /task-intent/);

  const accepted = toolCall({
    toolName: "codemode",
    input: { code: script("// reasoning: inspect the retry path", intent, progress, plan, phase, "// group-phase: ignored legacy annotation", "return 1;") },
  });
  assert.equal(accepted, undefined, "legacy phase comments no longer affect the task title");
});

test("Pi-agent guidance keeps task identity as the sole border title", () => {
  assert.match(CODEMODE_GROUP_GUIDANCE, /must include a model-written \/\/ task-intent:.*task-progress:/s);
  assert.match(CODEMODE_GROUP_GUIDANCE, /stable border title, not a phase update/);
  assert.match(CODEMODE_GROUP_GUIDANCE, /best judgment.*not.*tool-call count.*fixed denominator/s);
  assert.match(CODEMODE_GROUP_GUIDANCE, /final tool call.*100.*only after that call succeeds/s);
  assert.match(CODEMODE_GROUP_GUIDANCE, /one to seven short labeled phases/);
  assert.match(CODEMODE_GROUP_GUIDANCE, /task-milestone: <id>.*every top-level call/);
  assert.match(CODEMODE_GROUP_GUIDANCE, /@options:.*reasoning:.*task-intent:.*task-progress:/s);
  assert.doesNotMatch(CODEMODE_GROUP_GUIDANCE, /group-phase/);
});
