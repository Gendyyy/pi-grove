/**
 * panel.ts — the /grove settings panel: one searchable list over the settings table,
 * so every option is editable without memorising command words.
 */
import { Container, Input, SettingsList, Text, type Component, type SettingItem } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { DynamicBorder, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import { defaultConfigPath } from "./config.js";
import {
  panelRows,
  parseValue,
  readSettings,
  saveSetting,
  withSetting,
  type GroveSettings,
  type SettingKey,
} from "./settings.js";

/** Rows the panel draws above the list: border, title, config path. */
const HEADER_ROWS = 3;

/** How many rows the panel shows before it scrolls. */
const VISIBLE_ROWS = 9;

/** Attribution the panel can be called with; the defaults read the real config file. */
export interface PanelOptions {
  configPath?: string;
  settings?: GroveSettings;
}

/** The file the panel writes, shortened so it fits one line. */
function configHint(configPath: string): string {
  const home = homedir();
  return configPath.startsWith(home) ? "~" + configPath.slice(home.length) : configPath;
}

/** A one-line editor for the free-text option, where Enter saves and Esc keeps the old value. */
function labelEditor(theme: Theme, current: string, done: (value?: string) => void): Component {
  const container = new Container();
  const input = new Input({ placeholder: "type a label, or leave empty to hide it" });
  input.setValue(current);
  input.focused = true;
  input.onSubmit = (value) => done(value);
  input.onEscape = () => done();
  container.addChild(new Text(theme.fg("accent", theme.bold(" Thinking label")), 1, 0));
  container.addChild(new Text(theme.fg("dim", " enter saves · empty hides it · esc keeps the current value"), 1, 0));
  container.addChild(input);
  return {
    render: (width: number) => container.render(width),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => input.handleInput(data),
    handleMouse: (event) => input.handleMouse?.(event),
  };
}

/** Build the list rows: cycling options change on Enter, free text opens the editor. */
function buildItems(
  live: GroveSettings,
  theme: Theme,
  change: (key: SettingKey, raw: string) => void,
): SettingItem[] {
  return panelRows(live).map((row) => {
    const item: SettingItem = {
      id: row.key,
      label: row.label,
      description: row.description,
      currentValue: row.currentValue,
    };
    if (row.choices && row.choices.length > 0) item.values = [...row.choices];
    else {
      // Only the label option has no fixed choices: it opens the editor seeded with the
      // stored text, not with the display form ("pi default" / "hidden").
      const raw = live.thinkingLabel ?? "";
      item.submenu = (_currentValue, done) =>
        labelEditor(theme, raw, (value) => {
          if (value !== undefined) change(row.key, value);
          done();
        });
    }
    return item;
  });
}

/**
 * Open the settings panel. Resolves true when at least one option was written, which is the
 * caller cue to reload so the new layout takes effect.
 */
export async function showSettingsPanel(
  ui: ExtensionUIContext,
  options: PanelOptions = {},
): Promise<boolean> {
  const configPath = options.configPath ?? defaultConfigPath();
  const live: GroveSettings = { ...(options.settings ?? readSettings(configPath)) };
  let changed = false;

  await ui.custom<boolean>(
    (tui, theme, _keybindings, done) => {
      const container = new Container();
      const change = (key: SettingKey, raw: string): void => {
        const outcome = parseValue(key, raw);
        if (!outcome.ok) return;
        Object.assign(live, withSetting(live, outcome.key, outcome.value));
        changed = true;
        list.updateValue(key, outcome.display);
        void saveSetting(outcome.key, outcome.value, configPath).catch((error: unknown) => {
          ui.notify("grove could not save " + key + ": " + String(error), "warning");
        });
        tui.requestRender();
      };

      const items = buildItems(live, theme, change);
      const list = new SettingsList(
        items,
        VISIBLE_ROWS,
        {
          label: (text, selected) => (selected ? theme.bold(theme.fg("accent", text)) : theme.fg("text", text)),
          value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
          description: (text) => theme.fg("dim", text),
          cursor: theme.fg("accent", "› "),
          hint: (text) => theme.fg("dim", text),
        },
        (id, value) => change(id as SettingKey, value),
        () => done(changed),
        { enableSearch: true },
      );

      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      container.addChild(new Text(theme.fg("accent", theme.bold(" grove settings")), 1, 0));
      container.addChild(new Text(theme.fg("dim", " " + configHint(configPath)), 1, 0));
      container.addChild(list);
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

      return {
        render: (width: number) => container.render(width),
        invalidate: () => {
          container.invalidate();
          list.invalidate();
        },
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
        handleMouse: (event) => {
          // Clicks arrive in this component own coordinates, so shift them past the header.
          const local = { ...event, y: event.y - HEADER_ROWS };
          if (local.y < 0) return undefined;
          const result = list.handleMouse(local);
          if (result?.render !== false) tui.requestRender();
          return result;
        },
      };
    },
    { overlay: true },
  );

  return changed;
}
