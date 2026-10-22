/**
 * grove — compact, reason-first tool output for pi.
 *
 * Model (per-tool 2-line block): each built-in tool renders its OWN compact
 * block inline in the transcript, in execution order, via the tool-renderer
 * path (renderShell: "self"). No above-editor widget or turn-end stamping —
 * pi already renders tool components inline; we just make them tight.
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
 * "self" mode, ToolExecutionComponent.render() skips that baked
 * spacer — it emits ONE leading blank + the self-rendered content, and returns
 * [] when content is empty. So each tool = 1 separator + 2 tight lines.
 *
 * "reasoning": built-in tools have no reasoning of their own, so we inject a
 * REQUIRED "reasoning" string param into each wrapped tool. The model must fill
 * it with the GOAL/intent behind the call (not the file or command, which are
 * already shown); we strip it before delegating and render it as the line-1
 * headline. If ever absent, line 1 falls back to the arg detail.
 *
 * C-o (app.tools.expand) expansion: renderResult receives { expanded }.
 * Collapsed shows the 2-line block; expanded appends the tool's real output —
 * a colored line-numbered diff for code edits (details.diff), else raw content.
 *
 * Grouping stays inside pi's public renderer API: ToolTree collects the calls of
 * one prompt into a single clickable card, and a transcript replay rebuilds the
 * same card after /reload. Codemode remains Pi-owned; its nested steps arrive as
 * the details.piGroveNested snapshot, so foreign tools keep their own cards.
 *
 * Usage:  pi -e ./index.ts     (or install as a pi package)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveIconMode } from "./icons.js";
import { showSettingsPanel } from "./panel.js";
import { registerToolUi } from "./tool-ui.js";
import { registerTitleStatus } from "./title-status.js";
import { defaultConfigPath } from "./config.js";
import {
  SETTINGS,
  applyCommand,
  completions,
  currentValue,
  describe,
  readSettings,
  resolveCommand,
  saveSetting,
  settingsSource,
  statusLines,
  usageText,
  type SettingKey,
  type SettingValue,
} from "./settings.js";
import { composeSourceTool, type SourceToolDefinition } from "./tool-composition.js";
import { createDiffingWriteTool, createNativeSource } from "./native-tools.js";
import {
  createPiFffIntegrationController,
  type PiFffIntegrationController,
} from "./pi-fff/controller.js";
import { runSetup } from "./setup.js";
import { buildGenerateImageTool } from "./imagegen/tool.js";

export { withReasoning } from "./tool-composition.js";

export {
  fitToolLine,
  formatElapsed,
  buildToolBlock,
} from "./block-render.js";

export interface GroveExtensionDependencies {
  cwd?: string;
  /** Where grove.json lives; tests point this at a scratch file. */
  configPath?: string;
  readSettings?: typeof readSettings;
  saveSetting?: typeof saveSetting;
  createIntegration?: (
    pi: ExtensionAPI,
    cwd: string
  ) => PiFffIntegrationController;
}

export function createGroveExtension(
  dependencies: GroveExtensionDependencies = {}
) {
  return async (pi: ExtensionAPI): Promise<void> => {
    const cwd = dependencies.cwd ?? process.cwd();
    const configPath = dependencies.configPath ?? defaultConfigPath();
    const read = dependencies.readSettings ?? readSettings;
    const save = dependencies.saveSetting ?? saveSetting;
    const settings = read(configPath);
    const integration =
      dependencies.createIntegration?.(pi, cwd) ??
      createPiFffIntegrationController({ pi, cwd });

    /** Persist one option and reload, so every option travels the same path. */
    const change = async (
      ctx: ExtensionCommandContext,
      key: SettingKey,
      value: SettingValue,
      display = describe(key, value)
    ): Promise<void> => {
      if (currentValue(settings, key) === value) {
        ctx.ui.notify(key + " is already " + display + ".", "info");
        return;
      }
      if (key === "enabled" && settingsSource(configPath) === "environment") {
        ctx.ui.notify(
          "PI_GROVE overrides persistent settings; change or unset it first.",
          "warning"
        );
        return;
      }
      try {
        await save(key, value, configPath);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify("Could not save " + configPath + ": " + detail, "error");
        return;
      }
      ctx.ui.notify(key + " set to " + display + "; reloading.", "info");
      await ctx.reload();
    };

    /** Print the options a command owns, or the whole picture for a bare status. */
    const report = async (
      ctx: ExtensionCommandContext,
      keys: readonly SettingKey[]
    ): Promise<void> => {
      const lines = statusLines(settings, keys);
      if (keys.length !== SETTINGS.length) {
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      const source = settingsSource(configPath);
      const origin =
        source === "environment" ? "PI_GROVE override"
          : source === "file" ? configPath
            : "default; no config file";
      const status = await integration.run("status", { enabled: settings.enabled });
      const detail = [
        "grove is " + (settings.enabled ? "on" : "off") + " (" + origin + ").",
        ...lines,
        "iconMode " + settings.iconMode + " resolves to " + resolveIconMode(settings.iconMode) + ".",
        "codemode: pi-owned; " +
          (pi.getActiveTools().includes("codemode") ? "active" : "inactive") +
          " (configure defaultTools in pi).",
        status.message,
      ].filter(line => line !== "");
      ctx.ui.notify(detail.join("\n"), "info");
    };

    pi.registerCommand("grove", {
      description: "Configure grove display and manage optional FFF execution",
      getArgumentCompletions: (prefix) =>
        completions()
          .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
          .map((value) => ({ value, label: value })),
      handler: async (args, ctx) => {
        const words = args.trim().split(/\s+/).filter((word) => word !== "");
        const verb = (words[0] ?? "").toLowerCase();

        if (verb === "setup" || verb === "teardown") {
          await runSetup(verb, integration, {
            enabled: settings.enabled,
            confirm: ctx.hasUI === false ? undefined : (title, preview) => ctx.ui.confirm(title, preview),
            notify: (message, level) => ctx.ui.notify(message, level),
            reload: () => ctx.reload(),
          });
          return;
        }

        if (verb === "on" || verb === "off" || verb === "toggle") {
          const enabled = verb === "toggle" ? !settings.enabled : verb === "on";
          await change(ctx, "enabled", enabled, enabled ? "on" : "off");
          return;
        }

        if (verb === "status") {
          await report(ctx, SETTINGS.map((spec) => spec.key));
          return;
        }

        if (verb === "" || verb === "panel" || verb === "settings") {
          const written = await showSettingsPanel(ctx.ui, { settings });
          if (!written) return;
          ctx.ui.notify("grove settings saved; reloading to apply them.", "info");
          ctx.reload();
          return;
        }

        const resolved = resolveCommand(words);
        if (!resolved) {
          ctx.ui.notify(usageText(), "warning");
          return;
        }
        const asked = (resolved.rest[0] ?? "").toLowerCase();
        if (resolved.rest.length === 0 || asked === "status") {
          await report(ctx, resolved.command.keys);
          return;
        }
        const outcome = applyCommand(resolved);
        if (!outcome.ok) {
          ctx.ui.notify(outcome.message, "warning");
          return;
        }
        await change(ctx, outcome.key, outcome.value, outcome.display);
      },
    });

    const startupPlan = await integration.initialize(settings.enabled);
    if (startupPlan.notice) {
      const notice = startupPlan.notice;
      pi.on("session_start", (_event, ctx) =>
        ctx.ui.notify(notice.message, notice.level)
      );
    }
    if (!settings.enabled) return;
    registerTitleStatus(pi);
    const thinkingLabel = settings.thinkingLabel;
    if (thinkingLabel !== undefined) {
      // A blank label makes pi render no hidden-thinking line at all. pi restores its
      // own wording in resetExtensionUI(), so every new message re-arms the label.
      const label = thinkingLabel;
      const applyThinkingLabel = (ctx: { ui: { setHiddenThinkingLabel(value?: string): void } }): void => {
        try {
          ctx.ui.setHiddenThinkingLabel(label);
        } catch {
          // Hosts without the label API keep pi own wording.
        }
      };
      pi.on("session_start", (_event, ctx) => applyThinkingLabel(ctx));
      pi.on("agent_start", (_event, ctx) => applyThinkingLabel(ctx));
      pi.on("turn_start", (_event, ctx) => applyThinkingLabel(ctx));
      pi.on("message_start", (_event, ctx) => applyThinkingLabel(ctx));
    }

    const composedNames = new Set<string>();
    const compose = (source: SourceToolDefinition): SourceToolDefinition => {
      composedNames.add(source.name);
      return composeSourceTool(source, {
        mode: settings.mode,
        reasoningGuideline: 'Always pass a "reasoning" phrase to ' + source.name + ': state the GOAL/intent, not the file or command (those are shown already). Write the reasoning in English.',
        taskIntent: settings.group !== "off",
        taskIntentGuideline: 'Always pass "taskIntent" to ' + source.name + ': give the concise high-level objective for the current atomic task. Keep it unchanged across calls advancing that task; change it only when starting a distinct task. This is the stable task identity and the border title remains fixed for that task.',
        taskProgress: settings.group !== "off",
        taskProgressGuideline: 'Always pass "taskProgress" to ' + source.name + ': your best-judgment estimate (integer 0–100) of how much of the requested task is complete and how much remains. Do not base it on tool-call count or invent a fixed denominator. Repeat the same value on ordinary top-level calls; update it at meaningful milestones, and lower it if scope grows. The final tool call intended to complete and verify the task must pass 100; Grove shows 100 only after that call succeeds.',
      });
    };
    const sources = [
      createNativeSource("read", cwd),
      createDiffingWriteTool(cwd),
      ...(["edit", "bash", "grep", "find", "ls"] as const).map(name => createNativeSource(name, cwd)),
    ];
    for (const source of sources) {
      if (startupPlan.skipGroveTools.has(source.name as "read" | "grep" | "find")) continue;
      pi.registerTool(compose(source));
    }
    startupPlan.commit(compose);
    registerToolUi(pi, {
      tools: composedNames,
      mode: settings.mode,
      icons: settings.icons,
      iconMode: resolveIconMode(settings.iconMode),
      group: settings.group,
      groupRevealErrors: settings.groupRevealErrors,
      groupWindow: settings.groupWindow,
      thinking: settings.thinking,
    });

    pi.registerTool(buildGenerateImageTool());
  };
}

const extension = createGroveExtension();
export default extension;
