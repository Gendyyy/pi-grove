/**
 * liuovo — compact, reason-first tool output for pi.
 *
 * Model (per-tool 2-line block): each built-in tool renders its OWN compact
 * block inline in the transcript, in execution order, via the tool-renderer
 * path (renderShell: "self"). No above-editor widget or turn-end stamping —
 * pi already renders tool components inline; we just make
 * them tight.
 *
 *     [e] edit put reasoning on line 1, detail on line 2
 *       index.ts → +28/-14
 *     [$] bash run the typecheck
 *       npx tsc --noEmit → done (1 lines)
 *
 * Line 1: {running mark?} {icon} {name} {reasoning headline}
 * Line 2:   {dim arg/command detail} → {colored summary}
 *
 * Why this beats the spacer floor: pi bakes a Spacer(1) inside every tool's
 * ToolExecutionComponent, so N default cards = N blank lines. BUT in
 * `renderShell: "self"` mode, ToolExecutionComponent.render() skips that baked
 * spacer — it emits ONE leading blank + the self-rendered content, and returns
 * [] when content is empty. So each tool = 1 separator + 2 tight lines.
 *
 * `reasoning`: built-in tools have no reasoning of their own, so we inject a
 * REQUIRED `reasoning` string param into each wrapped tool. The model must fill
 * it with the GOAL/intent behind the call (not the file or command, which are
 * already shown); we strip it before delegating and render it as the line-1
 * headline. If ever absent, line 1 falls back to the arg detail.
 *
 * C-o (app.tools.expand) expansion: renderResult receives `{ expanded }`.
 * Collapsed shows the 2-line block; expanded appends the tool's real output —
 * a colored line-numbered diff for code edits (details.diff), else raw content.
 *
 * Codemode stays Pi-owned. A renderer resolver and bounded event projection put
 * two-line children inside the parent card without replacing its tool definition.
 * Direct MCP / foreign tools keep their own cards and execution ownership.
 *
 * Usage:  pi -e ./index.ts     (or install as a pi package)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveIconMode, type IconMode } from "./icons.js";
import { registerToolUi } from "./tool-ui.js";
import { registerTitleStatus } from "./title-status.js";
import {
  CONFIG_PATH,
  loadLiuovoIcons,
  loadLiuovoIconMode,
  saveLiuovoIconMode,
  loadLiuovoMode,
  loadLiuovoState,
  saveLiuovoEnabled,
  saveLiuovoIcons,
  saveLiuovoMode,
  type LiuovoMode,
} from "./config.js";

import {
  composeSourceTool,
  createDiffingWriteTool,
  createNativeSource,
  type SourceToolDefinition,
} from "./tool-composition.js";
import {
  createPiFffIntegrationController,
  type PiFffIntegrationController,
} from "./pi-fff/controller.js";
import { runSetup } from "./setup.js";

export { withReasoning } from "./tool-composition.js";

export {
  fitToolLine,
  formatElapsed,
  buildToolBlock,
} from "./block-render.js";
const LIUOVO_COMPLETIONS = [
  "on",
  "off",
  "toggle",
  "status",
  "mode default",
  "mode reasoning",
  "mode result",
  "mode status",
  "icons on",
  "icons off",
  "icons status",
  "icons auto",
  "icons nerd",
  "icons ascii",
  "setup",
  "teardown",
];

export interface LiuovoExtensionDependencies {
  cwd?: string;
  loadState?: typeof loadLiuovoState;
  loadMode?: typeof loadLiuovoMode;
  loadIcons?: typeof loadLiuovoIcons;
  saveIcons?: typeof saveLiuovoIcons;
  loadIconMode?: typeof loadLiuovoIconMode;
  saveIconMode?: typeof saveLiuovoIconMode;
  createIntegration?: (
    pi: ExtensionAPI,
    cwd: string
  ) => PiFffIntegrationController;
}

export function createLiuovoExtension(
  dependencies: LiuovoExtensionDependencies = {}
) {
  return async (pi: ExtensionAPI): Promise<void> => {
    const cwd = dependencies.cwd ?? process.cwd();
    const liuovoState = (dependencies.loadState ?? loadLiuovoState)();
    const liuovoMode = (dependencies.loadMode ?? loadLiuovoMode)();
    const liuovoIcons = (dependencies.loadIcons ?? loadLiuovoIcons)();
    const persistIcons = dependencies.saveIcons ?? saveLiuovoIcons;
    const iconMode = (dependencies.loadIconMode ?? loadLiuovoIconMode)();
    const resolvedIcons = resolveIconMode(iconMode);
    const persistIconMode = dependencies.saveIconMode ?? saveLiuovoIconMode;
    const integration =
      dependencies.createIntegration?.(pi, cwd) ??
      createPiFffIntegrationController({ pi, cwd });

    pi.registerCommand("liuovo", {
      description: "Configure liuovo display and manage optional FFF execution",
      getArgumentCompletions: (prefix) =>
        LIUOVO_COMPLETIONS.filter((value) =>
          value.startsWith(prefix.trim().toLowerCase())
        ).map((value) => ({ value, label: value })),
      handler: async (args, ctx) => {
        const action = args.trim().toLowerCase();
        if (action === "setup" || action === "teardown") {
          await runSetup(action, integration, {
            enabled: liuovoState.enabled,
            confirm: ctx.hasUI === false ? undefined : (title, preview) => ctx.ui.confirm(title, preview),
            notify: (message, level) => ctx.ui.notify(message, level),
            reload: () => ctx.reload(),
          });
          return;
        }
        if (action === "status" || action === "mode status") {
          const detail =
            liuovoState.source === "environment"
              ? "PI_LIUOVO override"
              : liuovoState.source === "file"
                ? CONFIG_PATH
                : "default; no config file";
          const status = await integration.run("status", { enabled: liuovoState.enabled });
          ctx.ui.notify(
            `liuovo is ${liuovoState.enabled ? "on" : "off"}, mode ${liuovoMode}, icons ${liuovoIcons ? "on" : "off"} (${detail}).\nIcon mode ${iconMode} (${resolvedIcons}).\ncodemode: Pi-owned; ${pi.getActiveTools().includes("codemode") ? "active" : "inactive"} (configure defaultTools in Pi).\n${status.message}`,
            "info"
          );
          return;
        }
        if (action === "icons status") {
          ctx.ui.notify(
            `liuovo icons are ${liuovoIcons ? "on" : "off"}; mode ${iconMode} (${resolvedIcons}).`,
            "info"
          );
          return;
        }
        const iconModeMatch = action.match(/^icons (auto|nerd|ascii)$/);
        if (iconModeMatch) {
          const mode = iconModeMatch[1] as IconMode;
          if (mode === iconMode) {
            ctx.ui.notify(`liuovo icon mode is already ${mode} (${resolvedIcons}).`, "info");
            return;
          }
          try {
            await persistIconMode(mode);
          } catch (error) {
            ctx.ui.notify(`Could not save ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
            return;
          }
          ctx.ui.notify(`liuovo icon mode set to ${mode}; reloading.`, "info");
          await ctx.reload();
          return;
        }
        const iconsMatch = action.match(/^icons (on|off)$/);
        if (iconsMatch) {
          const icons = iconsMatch[1] === "on";
          if (icons === liuovoIcons) {
            ctx.ui.notify(
              `liuovo icons are already ${icons ? "on" : "off"}.`,
              "info"
            );
            return;
          }
          try {
            await persistIcons(icons);
          } catch (error) {
            ctx.ui.notify(
              `Could not save ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
              "error"
            );
            return;
          }
          ctx.ui.notify(
            `liuovo icons set to ${icons ? "on" : "off"}; reloading.`,
            "info"
          );
          await ctx.reload();
          return;
        }
        const modeMatch = action.match(/^mode (default|reasoning|result)$/);
        if (modeMatch) {
          const mode = modeMatch[1] as LiuovoMode;
          if (mode === liuovoMode) {
            ctx.ui.notify(`liuovo mode is already ${mode}.`, "info");
            return;
          }
          try {
            await saveLiuovoMode(mode);
          } catch (error) {
            ctx.ui.notify(
              `Could not save ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
              "error"
            );
            return;
          }
          ctx.ui.notify(
            `liuovo mode set to ${mode}; reloading.`,
            "info"
          );
          await ctx.reload();
          return;
        }
        if (action !== "on" && action !== "off" && action !== "toggle") {
          ctx.ui.notify(
            "Usage: /liuovo setup|status|teardown|on|off|toggle|mode default|reasoning|result|status|icons on|off|status|auto|nerd|ascii",
            "warning"
          );
          return;
        }
        if (liuovoState.source === "environment") {
          ctx.ui.notify(
            "PI_LIUOVO overrides persistent settings; change or unset it first.",
            "warning"
          );
          return;
        }
        const enabled =
          action === "toggle" ? !liuovoState.enabled : action === "on";
        if (enabled === liuovoState.enabled) {
          ctx.ui.notify(
            `liuovo is already ${enabled ? "on" : "off"}.`,
            "info"
          );
          return;
        }
        try {
          await saveLiuovoEnabled(enabled);
        } catch (error) {
          ctx.ui.notify(
            `Could not save ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
            "error"
          );
          return;
        }
        ctx.ui.notify(
          `liuovo ${enabled ? "enabled" : "disabled"}; reloading.`,
          "info"
        );
        await ctx.reload();
        return;
      },
    });

    const startupPlan = await integration.initialize(liuovoState.enabled);
    if (startupPlan.notice) {
      const notice = startupPlan.notice;
      pi.on("session_start", (_event, ctx) =>
        ctx.ui.notify(notice.message, notice.level)
      );
    }
    if (!liuovoState.enabled) return;
    registerTitleStatus(pi);

    const composedNames = new Set<string>();
    const compose = (source: SourceToolDefinition): SourceToolDefinition => {
      composedNames.add(source.name);
      return composeSourceTool(source, {
        mode: liuovoMode,
        reasoningGuideline: `Always pass a "reasoning" phrase to ${source.name}: state the GOAL/intent, not the file or command (those are shown already). Write the reasoning in Chinese.`,
      });
    };
    const sources = [
      createNativeSource("read", cwd),
      createDiffingWriteTool(cwd),
      ...(["edit", "bash", "grep", "find", "ls"] as const).map(name => createNativeSource(name, cwd)),
    ];
    for (const source of sources) {
      if (startupPlan.skipLiuovoTools.has(source.name as "read" | "grep" | "find")) continue;
      pi.registerTool(compose(source));
    }
    startupPlan.commit(compose);
    registerToolUi(pi, {
      tools: composedNames, mode: liuovoMode, icons: liuovoIcons, iconMode: resolvedIcons,
    });

    pi.registerTool(buildGenerateImageTool());
  };
}

import { buildGenerateImageTool } from "./imagegen/tool.js";
const extension = createLiuovoExtension();
export default extension;
