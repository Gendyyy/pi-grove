import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { buildToolBlock, shellSummary, WidthAwareLines } from "./block-render.js";
import type { LiuovoMode, LiuovoThinking } from "./config.js";
import type { IconMode } from "./icons.js";
import { NestedToolObserver } from "./nested-tools.js";
import { installThinkingFilter } from "./pi-patch.js";
import { readTranscript } from "./replay.js";
import { thinkingRuns } from "./thinking.js";
import { ToolTree, type GroupMode } from "./tool-tree.js";

interface ToolUiOptions {
  /** Tools whose behavior this extension composes. Codemode is always presentation-only. */
  tools: ReadonlySet<string>;
  mode: LiuovoMode;
  icons: boolean;
  iconMode: IconMode;
  /** Transcript scope one card covers: a turn, one assistant message, or no grouping. */
  group: GroupMode;
  /** Keep failed nested steps visible while their parent row is collapsed. */
  groupRevealErrors: boolean;
  /** Recent calls kept visible in the collapsed card. */
  groupWindow: number;
  /** Where reasoning appears: a row of the card, pi own rows, or nowhere. */
  thinking: LiuovoThinking;
}
const CODEMODE_GUIDANCE = "Start codemode scripts with a short English goal comment: // reasoning: <goal>. If using // @options:, keep it first and put the reasoning comment on the next line.";

/** Own presentation and bounded result metadata, never codemode's tool definition or activation. */
export function registerToolUi(pi: ExtensionAPI, options: ToolUiOptions): void {
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
    },
    redraw,
  );
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
    if (prompt.selectedTools.includes("codemode")) prompt.sections.liuovo_tool_ui = CODEMODE_GUIDANCE;
    else delete prompt.sections.liuovo_tool_ui;
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
    const message = (event as { message?: { role?: string } }).message;
    const role = message?.role;
    if (role === "assistant") {
      tree.boundary("message");
      reasoningMessage += 1;
      feedReasoning(message, false);
    }
    if (role === "user") tree.boundary("prompt");
  });
  pi.on("message_update", (event) => {
    const message = (event as { message?: { role?: string } }).message;
    if (message?.role === "assistant") feedReasoning(message, false);
  });
  pi.on("message_end", (event) => {
    const message = (event as { message?: { role?: string } }).message;
    if (message?.role === "assistant") feedReasoning(message, true);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (observed(event.toolName)) startedAt.set(event.toolCallId, Date.now());
    nested.start(event, ctx);
    // Only tools liuovo renders get a tree row; foreign tools keep their own cards.
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
        ...(shell ? { piLiuovoShell: shell } : {}),
        ...(isCodemode ? { piLiuovoNested: nested.snapshot(event.toolCallId) } : {}),
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
      ctx.ui.notify("liuovo could not hide pi own thinking rows: " + status.detail, "warning");
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
  const renderers = new Map<string, ToolRenderers>([
    ...[...options.tools].map(name => [name, basicRenderers(name)] as const),
    ["codemode", nested.renderers(options.icons, options.iconMode)],
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
          background: text => theme.bg("toolPendingBg", text),
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
          background: text => theme.bg(context.isError ? "toolErrorBg" : "toolSuccessBg", text),
          outputPad: context.outputPad,
        });
      },
    });
  }
  pi.registerToolRenderer((name, next) => renderers.get(name) ?? next());
}
