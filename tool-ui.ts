import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { buildToolBlock, shellSummary, WidthAwareLines } from "./block-render.js";
import type { GroveMode, GroveThinking } from "./settings.js";
import type { IconMode } from "./icons.js";
import { NestedToolObserver } from "./nested-tools.js";
import { installThinkingFilter } from "./pi-patch.js";
import { readTranscript } from "./replay.js";
import { thinkingRuns } from "./thinking.js";
import { taskIntentOf, taskMilestoneOf, taskMilestonesOf, taskProgressOf, toneBackground } from "./tree-model.js";
import { ToolTree, type GroupMode, type TreeRow, type TreeSettings } from "./tool-tree.js";

interface ToolUiOptions {
  /** Tools whose behavior this extension composes. Codemode is always presentation-only. */
  tools: ReadonlySet<string>;
  mode: GroveMode;
  icons: boolean;
  iconMode: IconMode;
  /** Transcript scope one card covers: a turn, one assistant message, or no grouping. */
  group: GroupMode;
  /** Opt in to showing failed nested steps while their parent row is collapsed. */
  groupRevealErrors: boolean;
  /** Recent calls kept visible in the collapsed card. */
  groupWindow: number;
  groupNestedTools: boolean;
  groupProgress: boolean;
  groupSparkline: boolean;
  groupGutter: boolean;
  /** Where reasoning appears: a row of the card, pi own rows, or nowhere. */
  thinking: GroveThinking;
}
/** Settings that can be changed without rebuilding tool definitions or event handlers. */
export type ToolUiLiveSettings = Pick<
  ToolUiOptions,
  | "icons"
  | "iconMode"
  | "groupRevealErrors"
  | "groupWindow"
  | "groupNestedTools"
  | "groupProgress"
  | "groupSparkline"
  | "groupGutter"
>;

/** Runtime handle used by /grove to update the active presentation. */
export interface ToolUiController {
  /** Update mutable presentation settings and repaint existing cards. */
  updateSettings(settings: Partial<ToolUiLiveSettings>): void;
}
const CODEMODE_GUIDANCE = "Start codemode scripts with a short English goal comment: // reasoning: <goal>. If using // @options:, keep it first and put the reasoning comment on the next line.";
export const CODEMODE_GROUP_GUIDANCE = `${CODEMODE_GUIDANCE}
When Grove grouping is enabled, every top-level codemode script must include a model-written // task-intent: line and a // task-progress: <0-100> line. Keep task-intent unchanged across calls advancing the same task; change it only when starting a distinct task. This is the card's stable border title, not a phase update. Estimate completion by your best judgment of how much of the requested task is done and how much remains; do not base it on tool-call count or invent a fixed denominator. Repeat the current integer estimate on ordinary top-level calls; update it at meaningful milestones, and lower it if scope grows. The final tool call intended to complete and verify the task must pass 100; Grove shows 100 only after that call succeeds.
Every top-level call also carries a phase plan: declare it once with // task-milestones: inspect=Inspect; build=Build; verify=Verify. A plan holds one to seven short labeled phases; split the task into meaningful sequential phases rather than inventing filler. Prefer closing on a verify phase when the work actually needs checking, and add a clean phase before it when the work can leave temp files, scratch scripts, or throwaway artifacts behind. Both are judgement calls: skip them when the task genuinely does not need them. Use unique lowercase IDs of at most 24 characters, starting with a letter and followed only by lowercase letters, digits, or hyphens; labels are safely limited to 24 characters. Include // task-milestone: <id> on every top-level call, naming a phase from that plan. Advance the current id only after finishing that phase; Grove marks earlier phases complete and later ones pending. Re-state the same plan verbatim on every call; Grove only adopts a restated plan while it keeps the phases already finished, so a mid-task plan that drops, reorders, or replaces completed phases is ignored. Scope that genuinely grows may insert phases after the current one, and a different task needs a new // task-intent: rather than a rewritten plan. A successful task-progress: 100 call completes all phases; phase state stays independent of the percentage.
With // @options:, put that header first, then // reasoning:, // task-intent:, // task-progress:, and finally the // task-milestones: plan with its // task-milestone: id.
`;

/** Require a stable model-authored task title for grouped top-level codemode calls. */
export function codemodeGroupMetadataViolation(
  event: { toolName: string; input: Record<string, unknown>; parentToolCallId?: string },
  group: GroupMode,
): string | undefined {
  if (group === "off" || event.toolName !== "codemode" || event.parentToolCallId !== undefined) return undefined;
  if (!taskIntentOf(event.input))
    return "Grove blocked this codemode call: grouping requires a model-written // task-intent: <objective> line. Keep it stable for the same task, then retry.";
  if (taskProgressOf(event.input) === undefined)
    return "Grove blocked this codemode call: grouping requires the current // task-progress: <integer 0-100> estimate on every top-level call. Repeat it unchanged until a meaningful milestone, then retry.";
  const milestones = taskMilestonesOf(event.input);
  if (!milestones)
    return "Grove blocked this codemode call: grouping requires a // task-milestones: <id>=<label> plan of one to seven short labeled phases. Split the task into meaningful phases, then retry.";
  const milestoneId = taskMilestoneOf(event.input);
  if (!milestoneId)
    return "Grove blocked this codemode call: grouping requires // task-milestone: <id> naming the phase this call works on. Use an id from the declared plan, then retry.";
  if (!milestones.some(milestone => milestone.id === milestoneId))
    return "Grove blocked this codemode call: // task-milestone: must name a phase from the declared // task-milestones: plan. Fix the id, then retry.";
  return undefined;
}

/** Own presentation and bounded result metadata, never codemode's tool definition or activation. */
export function registerToolUi(pi: ExtensionAPI, options: ToolUiOptions): ToolUiController {
  // Extensions load before pi rebuilds the transcript on /reload, so patching here wins
  // the race that session_start loses. The call is idempotent and guarded.
  if (options.thinking !== "inline") void installThinkingFilter();
  const startedAt = new Map<string, number>();
  const listeners = new Map<string, () => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const redraw = () => { for (const invalidate of [...listeners.values()]) invalidate(); };
  const nested = new NestedToolObserver(redraw);
  // pi rebuilds the transcript BEFORE it emits session_start, so history rows are asked
  // to render while the tree is still empty. Keep their repaint hooks and re-ask them
  // once restore() has the groups, otherwise every old turn stays a plain card.
  const staleRows = new Map<string, () => void>();
  const remember = (id: string, invalidate: () => void): void => {
    if (!staleRows.has(id)) staleRows.set(id, invalidate);
  };
  /** Re-render the rows that were drawn before the transcript was restored. */
  const repaintStale = (): void => {
    if (staleRows.size === 0) return;
    const hooks = [...staleRows.values()];
    staleRows.clear();
    // Never repaint from inside a render pass: pi re-enters its own updateDisplay().
    setImmediate(() => {
      for (const hook of hooks) hook();
    });
  };
  const tree = new ToolTree(
    {
      mode: options.group,
      revealErrors: options.groupRevealErrors,
      icons: options.icons,
      iconMode: options.iconMode,
      window: options.groupWindow,
      groupNestedTools: options.groupNestedTools,
      groupProgress: options.groupProgress,
      groupSparkline: options.groupSparkline,
      groupGutter: options.groupGutter,
    },
    redraw,
  );
  const updateSettings = (settings: Partial<ToolUiLiveSettings>): void => {
    Object.assign(options, settings);
    const treeSettings: Partial<TreeSettings> = {
      ...(settings.icons === undefined ? {} : { icons: settings.icons }),
      ...(settings.iconMode === undefined ? {} : { iconMode: settings.iconMode }),
      ...(settings.groupRevealErrors === undefined ? {} : { revealErrors: settings.groupRevealErrors }),
      ...(settings.groupWindow === undefined ? {} : { window: settings.groupWindow }),
      ...(settings.groupNestedTools === undefined ? {} : { groupNestedTools: settings.groupNestedTools }),
      ...(settings.groupProgress === undefined ? {} : { groupProgress: settings.groupProgress }),
      ...(settings.groupSparkline === undefined ? {} : { groupSparkline: settings.groupSparkline }),
      ...(settings.groupGutter === undefined ? {} : { groupGutter: settings.groupGutter }),
    };
    tree.updateSettings(treeSettings);
  };
  const observed = (name: string) => name === "codemode" || options.tools.has(name);
  const stopTimer = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const unwatch = (id: string) => {
    listeners.delete(id);
    if (!listeners.size) stopTimer();
  };
  const clear = () => {
    tree.clear();
    stopTimer();
    listeners.clear();
    startedAt.clear();
    nested.clear();
  };

  pi.on("before_agent_start", (event) => {
    const prompt = event.systemPromptOptions;
    if (prompt.selectedTools.includes("codemode"))
      prompt.sections.grove_tool_ui = options.group === "off" ? CODEMODE_GUIDANCE : CODEMODE_GROUP_GUIDANCE;
    else delete prompt.sections.grove_tool_ui;
  });
  pi.on("tool_call", (event) => {
    const reason = codemodeGroupMetadataViolation(
      {
        toolName: event.toolName,
        input: event.input as unknown as Record<string, unknown>,
        parentToolCallId: event.parentToolCallId,
      },
      options.group,
    );
    return reason ? { block: true, reason } : undefined;
  });
  pi.on("turn_start", () => tree.boundary("turn"));
  let reasoningMessage = 0;

  /** Replay one assistant message's reasoning into the card as rows, in place. */
  const feedReasoning = (message: unknown, final: boolean): void => {
    if (options.thinking !== "group") return;
    const runs = thinkingRuns(message, "m" + reasoningMessage);
    for (const run of runs) tree.note(run.id, run.text, { final: final });
  };

  pi.on("message_start", (event) => {
    const message = (event as { message?: { role?: string; content?: unknown } }).message;
    const role = message?.role;
    if (role === "assistant") {
      tree.boundary("message");
      reasoningMessage += 1;
      feedReasoning(message, false);
    }
    if (role === "user") tree.boundary("prompt");
  });
  pi.on("message_update", (event) => {
    const message = (event as { message?: { role?: string; content?: unknown } }).message;
    if (message?.role !== "assistant") return;
    feedReasoning(message, false);
  });
  pi.on("message_end", (event) => {
    const message = (event as { message?: { role?: string; content?: unknown } }).message;
    if (message?.role !== "assistant") return;
    feedReasoning(message, true);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (observed(event.toolName)) startedAt.set(event.toolCallId, Date.now());
    nested.start(event, ctx);
    // Only tools grove renders get a tree row; foreign tools keep their own cards.
    if (observed(event.toolName)) tree.start(event);
  });
  pi.on("tool_execution_update", (event) => {
    if (event.toolName === "codemode") nested.updateModels(event.toolCallId, event.partialResult);
  });
  pi.on("tool_result", (event, ctx) => {
    if (!observed(event.toolName)) return;
    const isCodemode = event.toolName === "codemode";
    if (isCodemode) {
      nested.updateModels(event.toolCallId, event);
      nested.completeChildren(event.toolCallId, ctx);
    }
    const shell = event.toolName === "bash" ? shellSummary(event.structuredContent) : undefined;
    if (!shell && !isCodemode) return;
    return {
      details: {
        ...(event.details ?? {}),
        ...(shell ? { piGroveShell: shell } : {}),
        ...(isCodemode ? { piGroveNested: nested.snapshot(event.toolCallId) } : {}),
      },
    };
  });
  pi.on("tool_execution_end", (event, ctx) => {
    startedAt.delete(event.toolCallId);
    unwatch(event.toolCallId);
    nested.end(event, ctx);
    tree.end(event, ctx);
  });
  pi.on("turn_end", (_event, ctx) => {
    startedAt.clear();
    stopTimer();
    nested.finish(ctx);
    // A prompt scope keeps the card open across turns; only the whole response closes it.
    if (options.group !== "prompt") tree.settle();
    listeners.clear();
  });
  pi.on("agent_end", () => tree.settle());
  // A reload or a resumed session rebuilds cards from the transcript: the tree itself
  // lives in memory, so without this the grouping would vanish on every reload.
  const restore = (_event: unknown, ctx: { sessionManager: { getEntries(): unknown } }) => {
    clear();
    tree.restore(readTranscript(ctx.sessionManager.getEntries(), options.group, options.thinking === "group"));
    repaintStale();
  };
  pi.on("session_start", restore);
  pi.on("session_start", async (_event, ctx) => {
    // Without this pi keeps reserving a padded row per thinking run; the card is the
    // only place reasoning belongs, so the host is told to stop drawing its own.
    if (options.thinking === "inline") return;
    const status = await installThinkingFilter();
    if (!status.installed && options.thinking === "group")
      ctx.ui.notify("grove could not hide pi own thinking rows: " + status.detail, "warning");
  });
  pi.on("session_tree", restore);
  pi.on("session_shutdown", clear);

  const basicRenderers = (name: string): ToolRenderers => ({
    renderShell: "self",
    renderCall(args, theme, context) {
      if (!context.isPartial) return new Container();
      return WidthAwareLines.reuse(context.lastComponent, width => {
        const start = startedAt.get(context.toolCallId);
        return buildToolBlock(name, args as Record<string, unknown>, {}, {
          ...options, width, theme, isPartial: true,
          executionStarted: context.executionStarted,
          elapsedMs: start === undefined ? 0 : Math.max(0, Date.now() - start),
        });
      }, text => theme.bg("toolPendingBg", text), false, context.outputPad);
    },
    renderResult(result, renderOptions, theme, context) {
      if (renderOptions.isPartial) return new Container();
      return WidthAwareLines.reuse(context.lastComponent, width => buildToolBlock(name, context.args as Record<string, unknown>, result, {
        ...options, width, theme, expanded: renderOptions.expanded, isError: context.isError,
        elapsedMs: context.durationMs,
      }), text => theme.bg(context.isError ? "toolErrorBg" : "toolSuccessBg", text), true, context.outputPad);
    },
  });
  // With grouping on, the tree paints codemode like any other call; the rich card is
  // only the fallback for group "off", so neither path is dead or double maintained.
  const nestedRenderers = (): ToolRenderers => nested.renderers(options.icons, options.iconMode);
  const codemode: ToolRenderers = options.group === "off"
    ? {
      renderShell: "self",
      renderCall: (args, theme, context) => nestedRenderers().renderCall!(args, theme, context),
      renderResult: (result, renderOptions, theme, context) =>
        nestedRenderers().renderResult!(result, renderOptions, theme, context),
    }
    : basicRenderers("codemode");
  const renderers = new Map<string, ToolRenderers>([
    ...[...options.tools].map(name => [name, basicRenderers(name)] as const),
    ["codemode", codemode],
  ]);
  for (const [name, renderer] of renderers) {
    const renderCall = renderer.renderCall!;
    const renderResult = renderer.renderResult!;
    renderers.set(name, {
      ...renderer,
      renderCall(args, theme, context) {
        // Hydrating history and streaming arguments must never start clocks.
        if (context.isPartial && context.executionStarted && startedAt.has(context.toolCallId)) {
          if (listeners.size < 256 || listeners.has(context.toolCallId)) listeners.set(context.toolCallId, context.invalidate);
          if (listeners.size && timer === undefined) {
            timer = setInterval(redraw, 1000);
            timer.unref();
          }
        }
        const component = renderCall(args, theme, context);
        // Streaming rows join the card too: painting one on its own is what made every
        // new call flash as a separate block before it snapped into the group.
        if (context.isPartial) tree.ensure(context.toolCallId, name, args);
        // History renders before restore(): remember the hook so the card can come back.
        if (!tree.owns(context.toolCallId)) remember(context.toolCallId, context.invalidate);
        return tree.render({
          toolCallId: context.toolCallId,
          inner: component,
          theme,
          phase: "call",
          expanded: context.expanded,
          invalidate: context.invalidate,
          background: text => theme.bg(toneBackground(tree.tone(context.toolCallId)), text),
          outputPad: context.outputPad,
        });
      },
      renderResult(result, options, theme, context) {
        if (!options.isPartial) unwatch(context.toolCallId);
        const component = renderResult(result, options, theme, context);
        if (options.isPartial) return tree.owns(context.toolCallId) ? new Container() : component;
        if (!tree.owns(context.toolCallId)) remember(context.toolCallId, context.invalidate);
        return tree.render({
          toolCallId: context.toolCallId,
          inner: component,
          theme,
          phase: "result",
          expanded: options.expanded,
          invalidate: context.invalidate,
          background: text => theme.bg(toneBackground(tree.tone(context.toolCallId)), text),
          outputPad: context.outputPad,
        });
      },
    });
  }
  pi.registerToolRenderer((name, next) => renderers.get(name) ?? next());
  return { updateSettings };
}
