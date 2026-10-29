import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
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
  assert.match(codemodeGroupMetadataViolation(missingPlan, "prompt") ?? "", /task-milestones.*one to seven short labeled phases/);

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
  assert.equal(codemodeGroupMetadataViolation({
    toolName: "codemode",
    input: { code: script(intent, progress, "// task-milestones: answer=Answer", "// task-milestone: answer", "return 1;") },
  }, "prompt"), undefined);

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

test("a phase may not claim more than its equal share of the estimate", () => {
  const call = (value: number, milestone: string) => ({
    toolName: "codemode",
    input: { code: script(intent, "// task-progress: " + value, plan, "// task-milestone: " + milestone, "return 1;") },
  });

  // Three phases split 100 evenly, so Inspect tops out at 33 and Build at 67.
  assert.match(codemodeGroupMetadataViolation(call(40, "inspect"), "prompt") ?? "", /exceeds this phase's share.*"Inspect" may claim at most 33%/);
  assert.match(codemodeGroupMetadataViolation(call(80, "build"), "prompt") ?? "", /"Build" may claim at most 67%/);
  assert.match(codemodeGroupMetadataViolation(call(100, "build"), "prompt") ?? "", /may claim at most 67%/);
  assert.equal(codemodeGroupMetadataViolation(call(33, "inspect"), "prompt"), undefined);
  assert.equal(codemodeGroupMetadataViolation(call(67, "build"), "prompt"), undefined);
  // The last phase owns the last slice, so only it may report the task finished.
  assert.equal(codemodeGroupMetadataViolation(call(100, "verify"), "prompt"), undefined);
  assert.match(codemodeGroupMetadataViolation(call(100, "inspect"), "prompt") ?? "", /may claim at most 33%/);
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
    groupGutter: true,
    groupToolNames: true,
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
  assert.match(CODEMODE_GROUP_GUIDANCE, /finishes the task must end with a top-level call carrying task-progress: 100/);
  assert.match(CODEMODE_GROUP_GUIDANCE, /answer itself needs no tool call.*still make one last top-level codemode call/s);
  assert.match(CODEMODE_GROUP_GUIDANCE, /never write 100 just to clear the bar/);
  assert.match(CODEMODE_GROUP_GUIDANCE, /best judgment.*not.*tool-call count.*fixed denominator/s);
  assert.match(CODEMODE_GROUP_GUIDANCE, /final tool call.*100.*only after that call succeeds/s);
  assert.match(CODEMODE_GROUP_GUIDANCE, /one to seven short labeled phases/);
  assert.match(CODEMODE_GROUP_GUIDANCE, /outcome, uncertainty, risk, and scale/);
  assert.match(CODEMODE_GROUP_GUIDANCE, /one phase for simple work/);
  assert.match(CODEMODE_GROUP_GUIDANCE, /Examples are inspiration, not mandatory templates/);
  assert.match(CODEMODE_GROUP_GUIDANCE, /discoveries change the work.*preserving the IDs and order of completed phases/);
  assert.match(CODEMODE_GROUP_GUIDANCE, /task-milestone: <id>.*every top-level call/);
  assert.match(CODEMODE_GROUP_GUIDANCE, /@options:.*reasoning:.*task-intent:.*task-progress:/s);
  assert.doesNotMatch(CODEMODE_GROUP_GUIDANCE, /group-phase/);
});

const uiOptions = {
  tools: new Set<string>(["bash"]),
  mode: "reasoning" as const,
  icons: false,
  iconMode: "ascii" as const,
  group: "prompt" as const,
  groupRevealErrors: true,
  groupWindow: 5,
  groupNestedTools: true,
  groupProgress: true,
  groupSparkline: true,
  groupGutter: true,
  groupToolNames: true,
  thinking: "inline" as const,
};

/**
 * Render the card for a run of calls and report which host background role it asked for:
 * the card is one paint borrowed by its first row, so this is what the block actually wears.
 */
function cardBackgrounds(outcomes: ReadonlyArray<"ok" | "error">): string[] {
  const handlers = new Map<string, (event: unknown, context?: unknown) => unknown>();
  let resolve: ((name: string, next: () => unknown) => unknown) | undefined;
  const pi = {
    on(name: string, handler: (event: unknown, context?: unknown) => unknown) {
      handlers.set(name, handler);
      return () => {};
    },
    registerToolRenderer(fn: (name: string, next: () => unknown) => unknown) {
      resolve = fn;
    },
  } as unknown as ExtensionAPI;
  registerToolUi(pi, uiOptions);
  outcomes.forEach((outcome, index) => {
    const id = "call-" + index;
    const args = { command: "run step " + index };
    handlers.get("tool_execution_start")?.({ toolCallId: id, toolName: "bash", args });
    handlers.get("tool_execution_end")?.({
      toolCallId: id,
      toolName: "bash",
      result: { content: [{ type: "text", text: "step " + index }] },
      isError: outcome === "error",
      durationMs: 120,
    });
  });
  const roles: string[] = [];
  const theme = {
    style: (text: string) => text,
    bg: (role: string, text: string) => {
      roles.push(role);
      return text;
    },
  };
  const renderers = resolve?.("bash", () => ({})) as ToolRenderers | undefined;
  const card = renderers?.renderResult!(
    { content: [{ type: "text", text: "step 0" }], details: undefined },
    { isPartial: false, expanded: false },
    theme as never,
    {
      toolCallId: "call-0",
      args: { command: "run step 0" },
      isError: outcomes[0] === "error",
      durationMs: 120,
      outputPad: 1,
      expanded: false,
      invalidate: () => {},
    } as never,
  );
  const painted = (card as { render(width: number): string[] }).render(96);
  assert.ok(painted.length > 0, "the first row paints the card");
  return [...new Set(roles)];
}

test("the card background describes the whole card, not its first call", () => {
  assert.deepEqual(cardBackgrounds(["error", "ok"]), ["toolSuccessBg"]);
  assert.deepEqual(cardBackgrounds(["ok", "error"]), ["toolSuccessBg"]);
  assert.deepEqual(cardBackgrounds(["error", "error"]), ["toolErrorBg"]);
});
