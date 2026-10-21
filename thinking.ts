/**
 * thinking.ts — read the model's reasoning runs out of assistant messages, so the tool
 * card can narrate them instead of pi drawing its own rows between calls.
 */

/** One reasoning run: what the model thought before its next action. */
export interface ThinkingRun {
  /** Stable id, unique per assistant message, so streaming updates hit the same row. */
  id: string;
  /** Full reasoning text, trimmed and bounded. */
  text: string;
}

/** Cap on stored reasoning, so one long think cannot bloat the tree. */
const MAX_TEXT = 8000;
/** Headline length for a reasoning row. */
const MAX_GOAL = 140;

/** Collect the consecutive thinking parts of one assistant message into runs. */
export function thinkingRuns(message: unknown, key: string): ThinkingRun[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const runs: ThinkingRun[] = [];
  for (let index = 0; index < content.length; index++) {
    const part = content[index] as { type?: unknown } | undefined;
    if (part?.type !== "thinking") continue;
    const blocks: string[] = [];
    for (; index < content.length; index++) {
      const next = content[index] as { type?: unknown; thinking?: unknown } | undefined;
      if (next?.type !== "thinking") break;
      const text = typeof next.thinking === "string" ? next.thinking.trim() : "";
      if (text) blocks.push(text);
    }
    index--;
    if (blocks.length === 0) continue;
    runs.push({ id: key + ":t" + runs.length, text: blocks.join("\n\n").slice(0, MAX_TEXT) });
  }
  return runs;
}

/** Headline for a reasoning run: its opening line, cropped to one row. */
export function thinkingGoal(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "reasoning";
  const stop = flat.search(/\.\s/);
  const head = stop > 24 ? flat.slice(0, stop) : flat;
  return head.length > MAX_GOAL ? head.slice(0, MAX_GOAL - 1) + "\u2026" : head;
}

/** How much the model thought, phrased as a count the card can paint. */
export function thinkingSummary(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words + (words === 1 ? " word" : " words");
}

/** Bounded preview lines for a reasoning row, painted when the row is expanded. */
export function thinkingPreview(text: string, lines: number): string[] {
  return text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, lines);
}
