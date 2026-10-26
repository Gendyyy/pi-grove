/**
 * tree-model.ts — the shapes and pure helpers of the tool card: what a node is,
 * how a call is summarised, and how counts and glyphs are derived.
 * No state and no rendering: paint reads it, tool-tree.ts mutates it.
 */
import { stripVTControlCharacters } from "node:util";
import { formatElapsed, summaryLine, summarizeToolResult } from "./block-render.js";
import { markFor, resolveIconMode, toolIcon, type IconMode } from "./icons.js";
import { metric, paintSummary, themeText, toolColor, type Foreground, type GroveTheme } from "./theme.js";
/** One card per user prompt, per assistant turn, or per message; "off" leaves pi alone. */
export type GroupMode = "prompt" | "turn" | "message" | "off";

/** pi mounts two rows per call: the streaming call row and the finished result row. */
export type PaintPhase = "call" | "result";

/** The event kinds that can close a card. */
export type PaintScope = "prompt" | "turn" | "message";

/** Presentation settings owned by grove.json and updated by the live settings controller. */
export interface TreeSettings {
  mode: GroupMode;
  /** Opt in to showing failed nested steps while their parent card is collapsed. */
  revealErrors: boolean;
  icons: boolean;
  iconMode: IconMode;
  /** How many recent calls the collapsed card keeps visible. */
  window: number;
  /** Show nested tool names and counts in compact codemode rows. */
  groupNestedTools: boolean;
  /** Show names for tools with dedicated Grove icons. */
  groupToolNames: boolean;
  /** Show the agent progress estimate in the card rollup. */
  groupProgress: boolean;
  /** Show relative call durations in the card rollup. */
  groupSparkline: boolean;
  /** Divide the rows wherever the plan moved on to another phase. */
  groupGutter: boolean;
}

/** Lifecycle state of one tool call in the tree. */
export type TreeStatus = "running" | "success" | "error" | "incomplete" | "cancelled";

/** One tool call: the goal it pursued, what it touched, and its bounded output. */
export interface TreeNode {
  readonly id: string;
  readonly parent?: string;
  name: string;
  goal: string;
  target: string;
  /** Task identity captured from this top-level call for completion gating. */
  taskIntent?: string;
  /** True when this call declares itself the task-completing final action. */
  completesTask?: boolean;
  /** Phase this call declared, so the rows can show where the plan moved. */
  milestone?: string;
  status: TreeStatus;
  started: number;
  duration?: number;
  writeLines?: number;
  summary?: string;
  preview?: string[];
  previewDiff?: boolean;
  previewTruncated?: boolean;
  children: TreeNode[];
  /** Repaint hook of the row currently drawing this node, used when leadership moves. */
  invalidate?: () => void;
  /** Repaint hooks of both pi rows for this call, so the idle one can be blanked. */
  slots?: Map<PaintPhase, () => void>;
  /** True once a result row exists, so the live call row steps aside for it. */
  hasResult?: boolean;
  /** True for a node rebuilt from the transcript: its rows are history, not live calls. */
  restored?: boolean;
  /** Creation order, so a newer call wins leadership over an older one. */
  seq: number;
  /** Set on a reasoning row: it narrates the card but is not a tool call. */
  kind?: "thinking";
  /** Raw reasoning text, kept so a streaming repaint can be told from a real update. */
  text?: string;
}

/** One declared phase of a model-authored task, rendered in its card stepper. */
export interface TaskMilestone {
  id: string;
  label: string;
}

/** One turn or message boundary: the calls that share a card. */
export interface TreeGroup {
  key: string;
  rows: TreeNode[];
  nodes: Map<string, TreeNode>;
  leaderId?: string;
  started: number;
  budget: number;
  openAll: boolean;
  /** Stable model-authored identity shared by calls advancing one atomic task. */
  intent?: string;
  /** Agent's subjective completion estimate, updated only at meaningful milestones. */
  progress?: number;
  /** Declared ordered phases, one to seven, shared by calls advancing one task. */
  milestones?: TaskMilestone[];
  /** Current phase id; earlier phases are complete and later phases are pending. */
  activeMilestoneId?: string;
  /** Top-level call awaiting successful completion before the card can reach 100%. */
  pendingCompletionId?: string;
  /**
   * Percent at which each phase boundary was crossed, so a finished phase keeps the width
   * it actually earned. Monotone, one longer than the plan, and written only from an
   * observed crossing: a boundary we have not reached yet stays a guess until it happens.
   */
  phaseBounds?: number[];
  /** True while the full plan is expanded under the meter. */
  openPhases?: boolean;
  /** Phase ids whose nested call rows are expanded from their timeline marker. */
  expandedMilestones?: Set<string>;
  invalidate?: () => void;
}

/** Click target that toggles every level of a group; node ids are tool call ids. */
export const GROUP_TARGET = "@group";
/** Click target that toggles the phase plan under the meter; one line, one meaning. */
export const PHASES_TARGET = "@phases";
/** Prefix for a click target that expands only the calls assigned to one phase. */
export const MILESTONE_TARGET_PREFIX = "@milestone:";

/** Name the click target for one phase marker. */
export function milestoneTarget(id: string): string {
  return MILESTONE_TARGET_PREFIX + id;
}

/** Groups that keep bounded output previews; older ones stay renderable without them. */
export const MAX_GROUPS = 24;
/** Hard ceiling so a marathon session cannot grow the tree forever. */
export const MAX_GROUPS_TOTAL = 2000;
export const PREVIEW_LINES = 8;
export const PREVIEW_CHARS = 1200;
export const PREVIEW_TOTAL = 24000;
export const MAX_ID = 512;
export const DOT = " · ";
export const ELLIPSIS = "…";

export interface Glyphs {
  tee: string;
  end: string;
  pipe: string;
  open: string;
  closed: string;
  times: string;
  dot: string;
  hollow: string;
  /** Connector between two task phases, pointing at the next one. */
  arrow: string;
  /** Phase boundary drawn inside the meter, dashed because an unreached one is a guess. */
  tick: string;
  /** Milestone mark on a timeline row, so a phase never reads as another call. */
  diamond: string;
  /** Frame corners and edges of the group card. */
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
  /** Glyph style used for duration bars. */
  spark: "bars" | "ascii";
  /** Font Awesome bar-chart cue, empty when only ASCII glyphs are available. */
  chart: string;
  /** Font Awesome percent cue beside the progress meter; empty in ASCII mode. */
  progress: string;
  /** Completed milestone marker, with an ASCII fallback for plain consoles. */
  check: string;
}

const UNICODE_GLYPHS: Glyphs = {
  tee: "├", end: "└", pipe: "│", open: "▾", closed: "▸", times: "×", dot: "●", hollow: "○",
  tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", arrow: "→", tick: "┆", diamond: "◆", spark: "bars", chart: "\uf080", progress: "", check: "✓",
};
const ASCII_GLYPHS: Glyphs = {
  tee: "+", end: "+", pipe: "|", open: "v", closed: ">", times: "x", dot: "*", hollow: "o",
  tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", arrow: "->", tick: ":", diamond: "*", spark: "ascii", chart: "", progress: "", check: "x",
};

/** Box-drawing connectors survive UTF-8 terminals; forced ASCII keeps plain consoles readable. */
export function treeGlyphs(mode: IconMode): Glyphs {
  return resolveIconMode(mode) === "ascii" ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

/** Strip terminal escapes from tool output before it is measured or stored. */
export function clean(value: unknown): string {
  return typeof value === "string"
    ? stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    : "";
}

/** Bound any single-line text so one card cannot dominate the transcript. */
export function brief(value: unknown, limit = 240): string {
  const text = clean(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit - 1) + ELLIPSIS : text;
}

/** Recover the stated goal: the injected reasoning param, else a codemode goal comment. */
export function goalOf(args: Record<string, unknown> | undefined): string {
  const direct = args?.reasoning;
  if (typeof direct === "string" && direct.trim()) return brief(direct, 200);
  const code = args?.code ?? args?.script;
  if (typeof code === "string") {
    const match = code.match(/^\s*(?:\/\/|#)\s*reasoning:\s*(.+)$/im);
    if (match) return brief(match[1], 200);
  }
  return "";
}

/** Recover explicit cluster intent from a composed tool field or codemode comment. */
export function taskIntentOf(args: Record<string, unknown> | undefined): string {
  const direct = args?.taskIntent;
  if (typeof direct === "string" && direct.trim()) return brief(direct, 120);
  const code = args?.code ?? args?.script;
  if (typeof code === "string") {
    const match = code.match(/^\s*(?:\/\/|#)\s*task-intent:\s*(.+)$/im);
    if (match) return brief(match[1], 120);
  }
  return "";
}

/** Recover a bounded task estimate from composed args or a codemode comment. */
export function taskProgressOf(args: Record<string, unknown> | undefined): number | undefined {
  const direct = args?.taskProgress;
  if (typeof direct === "number" && Number.isInteger(direct) && direct >= 0 && direct <= 100) return direct;
  const code = args?.code ?? args?.script;
  if (typeof code !== "string") return undefined;
  const match = code.match(/^\s*(?:\/\/|#)\s*task-progress:\s*(\d{1,3})\s*$/im);
  if (!match) return undefined;
  const progress = Number(match[1]);
  return progress <= 100 ? progress : undefined;
}

const TASK_MILESTONE_ID = /^[a-z][a-z0-9-]{0,23}$/;

/** Smallest and largest phase plan a card renders; one phase is enough for a small task. */
export const TASK_MILESTONE_MIN = 1;
export const TASK_MILESTONE_MAX = 7;

/** Recover a valid one-to-seven phase plan from composed args or a codemode comment. */
export function taskMilestonesOf(args: Record<string, unknown> | undefined): TaskMilestone[] | undefined {
  const direct = args?.taskMilestones;
  const code = args?.code ?? args?.script;
  const match = typeof code === "string"
    ? code.match(/^\s*(?:\/\/|#)\s*task-milestones:\s*(.*)$/im)
    : undefined;
  const declaration = typeof direct === "string" && direct.trim() ? direct : match?.[1];
  if (!declaration?.trim()) return undefined;
  const entries = declaration.split(";");
  if (entries.length < TASK_MILESTONE_MIN || entries.length > TASK_MILESTONE_MAX) return undefined;

  const ids = new Set<string>();
  const milestones: TaskMilestone[] = [];
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 0) return undefined;
    const id = entry.slice(0, separator).trim();
    const label = brief(entry.slice(separator + 1), 24);
    if (!TASK_MILESTONE_ID.test(id) || ids.has(id) || !label) return undefined;
    ids.add(id);
    milestones.push({ id, label });
  }
  return milestones;
}

/**
 * Keep a re-declared plan only while it preserves the phases already finished.
 *
 * Every call restates the plan, so a model that rewrites or shrinks it mid-task would
 * otherwise erase the ticks the card already showed. A plan is adopted when its completed
 * prefix is unchanged, which covers renaming labels and inserting work after the current
 * phase; anything that would un-complete a phase leaves the standing plan in place.
 */
export function adoptMilestones(
  previous: TaskMilestone[] | undefined,
  next: TaskMilestone[],
  completed: number,
): TaskMilestone[] {
  if (!previous || previous.length === 0) return next;
  const done = Math.max(0, Math.min(completed, previous.length));
  const prefixKept = previous
    .slice(0, done)
    .every((milestone, index) => milestone.id === next[index]?.id);
  return prefixKept ? next : previous;
}

/** Recover the current phase id from composed args or a codemode comment. */
export function taskMilestoneOf(args: Record<string, unknown> | undefined): string | undefined {
  const direct = args?.taskMilestone;
  let id = typeof direct === "string" ? direct.trim() : "";
  if (!id) {
    const code = args?.code ?? args?.script;
    if (typeof code === "string") {
      const match = code.match(/^\s*(?:\/\/|#)\s*task-milestone:\s*([a-z][a-z0-9-]{0,23})\s*$/im);
      id = match?.[1] ?? "";
    }
  }
  return TASK_MILESTONE_ID.test(id) ? id : undefined;
}

const TARGET_KEYS = ["path", "file_path", "filePath", "pattern", "query", "command", "cmd", "url", "name", "prompt"];

/** Name the single value a call acts on, so a closed row still reads clearly. */
export function targetOf(args: Record<string, unknown> | undefined): string {
  for (const key of TARGET_KEYS) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return brief(value, 120);
  }
  return "";
}

/** Compose the row's human detail: goal first, then the value it acted on when short. */
export function detailOf(node: TreeNode): string {
  const goal = node.goal;
  const target = node.target;
  if (goal && target && target !== goal && !goal.includes(target) && target.length <= 28)
    return goal + " (" + target + ")";
  return goal || target || "";
}

/** Sum the wall clock of every top-level call in one group. */
export function groupTiming(rows: TreeNode[]): { elapsed: number; running: boolean } {
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  let running = false;
  for (const row of rows) {
    start = Math.min(start, row.started);
    if (row.status === "running") {
      running = true;
      end = Math.max(end, Date.now());
    } else {
      end = Math.max(end, row.started + (row.duration ?? 0));
    }
  }
  if (!Number.isFinite(start)) return { elapsed: 0, running: false };
  return { elapsed: Math.max(0, end - start), running: running };
}

/** Count every call by tool name, nested steps included, so the header can name them. */
export function toolCounts(nodes: TreeNode[], counts = new Map<string, number>()): Map<string, number> {
  for (const node of nodes) {
    if (node.kind === "thinking") continue;
    counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
    toolCounts(node.children, counts);
  }
  return counts;
}

/** Count only the tools at one level, excluding nested descendants and reasoning rows. */
function directToolCounts(nodes: TreeNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.kind === "thinking") continue;
    counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
  }
  return counts;
}

/** Paint the mix of tools inside one group, busiest first, with a bounded long tail. */
export function toolBreakdown(
  nodes: TreeNode[],
  theme: GroveTheme,
  glyphs: Glyphs,
  kinds = 4,
  icons = false,
  iconMode: IconMode = "auto",
  includeDescendants = true,
  showBuiltinNames = true,
): string[] {
  const counts = [...(includeDescendants ? toolCounts(nodes) : directToolCounts(nodes))].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  // Each part is one glyph and a count once the font can name the tool itself.
  const parts = counts.slice(0, kinds).map(([name, count]) => {
    const label = showBuiltinNames ? name : toolIcon(name, iconMode) ?? name;
    return themeText(theme, toolColor(name), label) +
      themeText(theme, "dim", " " + glyphs.times) +
      themeText(theme, "muted", String(count));
  });
  if (counts.length > kinds) parts.push(themeText(theme, "dim", "+" + (counts.length - kinds)));
  return parts;
}

/** Count failures anywhere in the subtree. */
export function countErrors(nodes: TreeNode[]): number {
  return nodes.reduce(
    (total, node) =>
      node.kind === "thinking" ? total : total + (node.status === "error" ? 1 : 0) + countErrors(node.children),
    0,
  );
}

/** Background tone a card wears, read from the card itself rather than one borrowed row. */
export type CardTone = "pending" | "success" | "error";

/**
 * Read one card's tone from its own calls: a live call keeps the card pending, only a card
 * whose every call failed turns red, and a mix of failures and successes stays neutral.
 */
export function groupTone(rows: readonly TreeNode[]): CardTone {
  const calls = rows.filter(row => row.kind !== "thinking");
  if (calls.some(row => row.status === "running")) return "pending";
  if (calls.length > 0 && calls.every(row => row.status === "error")) return "error";
  return "success";
}

/** Host background role that carries a card tone. */
export function toneBackground(tone: CardTone): "toolPendingBg" | "toolSuccessBg" | "toolErrorBg" {
  if (tone === "pending") return "toolPendingBg";
  return tone === "error" ? "toolErrorBg" : "toolSuccessBg";
}

/** Count tool calls anywhere in the subtree, excluding reasoning rows. */
export function countToolCalls(nodes: TreeNode[]): number {
  return nodes.reduce(
    (total, node) => node.kind === "thinking" ? total : total + 1 + countToolCalls(node.children),
    0,
  );
}

/** Pluralize a counted noun without a plural dictionary. */
export function counted(theme: GroveTheme, value: number, singular: string, plural: string): string {
  return metric(theme, value, value === 1 ? singular : plural);
}

/** Failures as one glyph and a number, or the plain words when glyphs are unavailable. */
export function errorCell(count: number, theme: GroveTheme, icons = false, iconMode: IconMode = "auto"): string {
  const mark = icons ? markFor("error", iconMode) : undefined;
  if (mark !== undefined) return themeText(theme, "error", mark + " " + count);
  return themeText(theme, "error", count + (count === 1 ? " error" : " errors"));
}

/** Split one row's metadata from its optional duration rail and elapsed label. */
export function rowTail(
  node: TreeNode,
  theme: GroveTheme,
  glyphs: Glyphs,
  icons = false,
  iconMode: IconMode = "auto",
  showNestedBreakdown = true,
  durationRail = "",
  elapsedMs = node.duration ?? (node.status === "running" ? Date.now() - node.started : 0),
  showBuiltinNames = true,
): { summary: string; duration: string } {
  const parts: string[] = [];
  // A codemode row names the mix of steps it contains instead of a bare count.
  if (showNestedBreakdown && node.children.length > 0)
    parts.push(...toolBreakdown(node.children, theme, glyphs, 4, icons, iconMode, true, showBuiltinNames));
  // A script that called no tool has nothing to open, so the row says so rather than looking
  // like every expandable row whose click did nothing.
  if (showNestedBreakdown && node.name === "codemode" && node.children.length === 0)
    parts.push(themeText(theme, "dim", "no calls"));
  const errors = node.children.filter(child => child.status === "error").length;
  if (errors > 0) parts.push(errorCell(errors, theme, icons, iconMode));
  // A codemode row is summarized by its steps; a leaf row carries its own outcome.
  if (node.summary && node.children.length === 0)
    parts.push(paintSummary(node.name, node.summary, node.status, theme, icons, iconMode));
  else if (node.children.length === 0)
    parts.push(paintSummary(node.name, node.status === "running" ? "running" : node.status, node.status, theme, icons, iconMode));
  const separator = themeText(theme, "dim", DOT);
  return {
    summary: parts.join(separator),
    duration: (durationRail ? durationRail + separator : "") +
      themeText(theme, "dim", formatElapsed(elapsedMs)),
  };
}

