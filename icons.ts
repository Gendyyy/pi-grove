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

/** Outcome marks: one cell that carries the same colour as the word it replaces. */
const marks: Record<string, readonly [string, string]> = {
  done: ["\uf00c", "ok"],
  applied: ["\uf00c", "ok"],
  written: ["\uf00c", "ok"],
  success: ["\uf00c", "ok"],
  error: ["\uf00d", "err"],
  failed: ["\uf00d", "err"],
  cancelled: ["\uf05e", "no"],
  incomplete: ["\uf128", "?"],
  running: ["\uf111", ".."],
};

/** True when the resolved font can stand in for a word; an ASCII terminal cannot. */
export function glyphWords(mode: IconMode = "auto"): boolean {
  return resolveIconMode(mode) === "nerd";
}

/** True when this tool has a glyph of its own, so its name can be dropped. */
export function hasToolGlyph(name: string): boolean {
  return Object.hasOwn(glyphs, name);
}

/** Return a dedicated glyph only for known built-in tools, preserving custom names. */
export function toolIcon(name: string, mode: IconMode = "auto"): string | undefined {
  return hasToolGlyph(name) ? iconFor(name, mode) : undefined;
}

/** The glyph standing in for one status word, or undefined when words must stay. */
export function markFor(word: string, mode: IconMode = "auto"): string | undefined {
  if (!glyphWords(mode)) return undefined;
  return Object.hasOwn(marks, word) ? marks[word][0] : undefined;
}

/**
 * The cell that names a tool: its glyph as a small indicator ahead of the word. The word
 * always stays, because a lone glyph makes a row unreadable to anyone still learning the
 * font, and the point of the row is to say which tool ran.
 */
export function toolWord(name: string, mode: IconMode = "auto"): string {
  if (!glyphWords(mode)) return name;
  // A patched glyph overhangs its cell, so every glyph (known or not) keeps the wider gap
  // iconPrefix uses; one space read as the glyph touching the tool name.
  return (hasToolGlyph(name) ? "" : " ") + iconPrefix(name, mode) + name;
}
