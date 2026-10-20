export type IconMode = "auto" | "nerd" | "ascii";
export type ResolvedIconMode = Exclude<IconMode, "auto">;

/** Font Awesome glyphs included in Nerd Fonts; no runtime font/package dependency. */
const glyphs: Record<string, readonly [string, string]> = {
  read: ["\uf15c", "[r]"],
  write: ["\uf0c7", "[w]"],
  edit: ["\uf044", "[e]"],
  bash: ["\uf120", "[$]"],
  grep: ["\uf002", "[?]"],
  find: ["\uf1e5", "[/]"],
  ls: ["\uf07b", "[d]"],
  codemode: ["\uf121", "[<>]"],
};
const unknown = ["\uf12e", "[~]"] as const;

/** A terminal owns its font: auto is a heuristic, never a font detector. */
export function resolveIconMode(
  mode: IconMode = "auto",
  env: NodeJS.ProcessEnv = process.env,
  isTTY = process.stdout.isTTY === true,
): ResolvedIconMode {
  if (mode !== "auto") return mode;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  if (!isTTY || env.TERM === "dumb" || env.SSH_TTY || env.SSH_CONNECTION
    || (locale && !/utf-?8/i.test(locale))) return "ascii";
  return "nerd";
}

/** Patched fonts may overhang a cell; an extra Nerd gap keeps labels readable. */
export function iconPrefix(name: string, mode: IconMode = "auto"): string {
  const resolved = resolveIconMode(mode);
  return `${iconFor(name, resolved)}${resolved === "nerd" ? "  " : " "}`;
}

export function iconFor(name: string, mode: IconMode = "auto"): string {
  return (Object.hasOwn(glyphs, name) ? glyphs[name] : unknown)[resolveIconMode(mode) === "nerd" ? 0 : 1];
}
