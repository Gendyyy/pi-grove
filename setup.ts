import type { PiFffIntegrationController } from "./pi-fff/controller.js";

export interface SetupContext {
  enabled: boolean;
  confirm?: (title: string, preview: string) => Promise<boolean>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  reload(): Promise<void>;
}

/** Only FFF needs ownership management. Pi owns codemode and its activation. */
export async function runSetup(
  action: "setup" | "teardown",
  fff: PiFffIntegrationController,
  ctx: SetupContext,
): Promise<void> {
  if (action === "setup" && !ctx.enabled) {
    ctx.notify("Run /grove on before setup.", "warning");
    return;
  }
  if (!ctx.confirm) {
    ctx.notify("Interactive confirmation is required; no settings changed.", "warning");
    return;
  }
  try {
    const result = await fff.run(action, {
      enabled: ctx.enabled,
      deferReload: true,
      confirm: preview => ctx.confirm!(`grove FFF ${action}`, [
        ...preview.changes.map(change => {
          const before = JSON.stringify(change.before);
          const after = JSON.stringify(change.after);
          const journalNote = before === after ? "\nSettings unchanged; ownership journal will change." : "";
          return `FFF: ${change.settingsPath}\n${before} → ${after}${journalNote}`;
        }),
        "Only FFF package entries are managed. Codemode and defaultTools stay under Pi's control.",
        "Run /grove teardown before removing managed FFF. Extensions will reload once.",
      ].join("\n\n")),
    });
    if (result.code === "PIFFF_CONFIG_MISSING") {
      ctx.notify("FFF is not installed; nothing to set up. Codemode rendering works without setup; enable it in Pi's defaultTools if needed.", "info");
      return;
    }
    ctx.notify(result.message, result.level);
    if (result.level === "error" || result.reload === "none") return;
  } catch (error) {
    ctx.notify(`${error instanceof Error ? error.message : String(error)}\nIf any FFF settings were saved, reload and check /grove status; recovery journals are retained.`, "error");
    return;
  }
  try { await ctx.reload(); }
  catch (error) {
    ctx.notify(`Reload did not complete: ${error instanceof Error ? error.message : String(error)}. Run /reload to finish FFF recovery.`, "error");
  }
}
