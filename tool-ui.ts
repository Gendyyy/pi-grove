import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { buildToolBlock, shellSummary, WidthAwareLines } from "./block-render.js";
import type { LiuovoMode } from "./config.js";
import type { IconMode } from "./icons.js";
import { NestedToolObserver } from "./nested-tools.js";

interface ToolUiOptions {
  /** Tools whose behavior this extension composes. Codemode is always presentation-only. */
  tools: ReadonlySet<string>;
  mode: LiuovoMode;
  icons: boolean;
  iconMode: IconMode;
}
const CODEMODE_GUIDANCE = "Start codemode scripts with a short Chinese goal comment: // reasoning: <goal>. If using // @options:, keep it first and put the reasoning comment on the next line.";

/** Own presentation and bounded result metadata, never codemode's tool definition or activation. */
export function registerToolUi(pi: ExtensionAPI, options: ToolUiOptions): void {
  const startedAt = new Map<string, number>();
  const listeners = new Map<string, () => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const redraw = () => { for (const invalidate of [...listeners.values()]) invalidate(); };
  const nested = new NestedToolObserver(redraw);
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
  pi.on("tool_execution_start", (event, ctx) => {
    if (observed(event.toolName)) startedAt.set(event.toolCallId, Date.now());
    nested.start(event, ctx);
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
  });
  pi.on("turn_end", (_event, ctx) => {
    startedAt.clear();
    stopTimer();
    nested.finish(ctx);
    listeners.clear();
  });
  pi.on("session_start", clear);
  pi.on("session_tree", clear);
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
        return renderCall(args, theme, context);
      },
      renderResult(result, options, theme, context) {
        if (!options.isPartial) unwatch(context.toolCallId);
        return renderResult(result, options, theme, context);
      },
    });
  }
  pi.registerToolRenderer((name, next) => renderers.get(name) ?? next());
}
