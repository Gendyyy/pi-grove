/**
 * tool-tree.ts — one clickable, drill-down card per assistant turn: every tool call,
 * its nested codemode steps, and bounded output, expandable at each level by clicking.
 */
import { stripVTControlCharacters } from "node:util";
import {
  Container,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ToolExecutionEndEvent, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";
import { colorizeDiff, fitToolLine, formatElapsed, summarizeToolResult, summaryLine, WidthAwareLines } from "./block-render.js";
import { resolveIconMode, type IconMode } from "./icons.js";
import { readNested, type ReplayCall } from "./replay.js";
import { thinkingGoal, thinkingPreview, thinkingSummary } from "./thinking.js";
import { metric, paintSummary, plainTheme, themeText, toolColor, toolLabel, type Foreground, type LiuovoTheme } from "./theme.js";

/** How much transcript one group card covers. */
/** One card per user prompt, per assistant turn, or per message; "off" leaves pi alone. */
export type GroupMode = "prompt" | "turn" | "message" | "off";

/** pi mounts two rows per call: the streaming call row and the finished result row. */
export type PaintPhase = "call" | "result";

/** Presentation settings owned by liuovo.json and resolved once at startup. */
export interface TreeSettings {
  mode: GroupMode;
  /** Keep failed nested steps visible while their parent card is collapsed. */
  revealErrors: boolean;
  icons: boolean;
  iconMode: IconMode;
  /** How many recent calls the collapsed card keeps visible. */
  window: number;
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
  /** True once a row of this node has actually painted the card. */
  painted?: boolean;
  /** Creation order, so a newer call wins leadership over an older one. */
  seq: number;
  /** Set on a reasoning row: it narrates the card but is not a tool call. */
  kind?: "thinking";
  /** Raw reasoning text, kept so a streaming repaint can be told from a real update. */
  text?: string;
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
  invalidate?: () => void;
}

/** Click target that toggles every level of a group; node ids are tool call ids. */
export const GROUP_TARGET = "@group";

const MAX_ROWS = 64;
const MAX_CHILDREN = 32;
/** Groups that keep bounded output previews; older ones stay renderable without them. */
const MAX_GROUPS = 24;
/** Hard ceiling so a marathon session cannot grow the tree forever. */
const MAX_GROUPS_TOTAL = 2000;
const PREVIEW_LINES = 8;
const PREVIEW_CHARS = 1200;
const PREVIEW_TOTAL = 24000;
const MAX_ID = 512;
const DOT = " · ";
const ELLIPSIS = "…";

interface Glyphs {
  rail: string;
  tee: string;
  end: string;
  pipe: string;
  open: string;
  closed: string;
  times: string;
  dot: string;
  hollow: string;
}

const UNICODE_GLYPHS: Glyphs = { rail: "▌", tee: "├", end: "└", pipe: "│", open: "▾", closed: "▸", times: "×", dot: "●", hollow: "○" };
const ASCII_GLYPHS: Glyphs = { rail: "|", tee: "+", end: "+", pipe: "|", open: "v", closed: ">", times: "x", dot: "*", hollow: "o" };

/** Box-drawing connectors survive UTF-8 terminals; forced ASCII keeps plain consoles readable. */
export function treeGlyphs(mode: IconMode): Glyphs {
  return resolveIconMode(mode) === "ascii" ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

/** Strip terminal escapes from tool output before it is measured or stored. */
function clean(value: unknown): string {
  return typeof value === "string"
    ? stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    : "";
}

/** Bound any single-line text so one card cannot dominate the transcript. */
function brief(value: unknown, limit = 240): string {
  const text = clean(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit - 1) + ELLIPSIS : text;
}

/** Recover the stated goal: the injected reasoning param, else a codemode goal comment. */
function goalOf(args: Record<string, unknown> | undefined): string {
  const direct = args?.reasoning;
  if (typeof direct === "string" && direct.trim()) return brief(direct, 200);
  const code = args?.code ?? args?.script;
  if (typeof code === "string") {
    const match = code.match(/^\s*(?:\/\/|#)\s*reasoning:\s*(.+)$/im);
    if (match) return brief(match[1], 200);
  }
  return "";
}

const TARGET_KEYS = ["path", "file_path", "filePath", "pattern", "query", "command", "cmd", "url", "name", "prompt"];

/** Name the single value a call acts on, so a closed row still reads clearly. */
function targetOf(args: Record<string, unknown> | undefined): string {
  for (const key of TARGET_KEYS) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return brief(value, 120);
  }
  return "";
}

/** Compose the row's human detail: goal first, then the value it acted on when short. */
function detailOf(node: TreeNode): string {
  const goal = node.goal;
  const target = node.target;
  if (goal && target && target !== goal && !goal.includes(target) && target.length <= 28)
    return goal + " (" + target + ")";
  return goal || target || "";
}

/** Sum the wall clock of every top-level call in one group. */
function groupTiming(rows: TreeNode[]): { elapsed: number; running: boolean } {
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
function toolCounts(nodes: TreeNode[], counts = new Map<string, number>()): Map<string, number> {
  for (const node of nodes) {
    if (node.kind === "thinking") continue;
    counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
    toolCounts(node.children, counts);
  }
  return counts;
}

/** Paint the mix of tools inside one group, busiest first, with a bounded long tail. */
function toolBreakdown(nodes: TreeNode[], theme: LiuovoTheme, glyphs: Glyphs, kinds = 4): string[] {
  const counts = [...toolCounts(nodes)].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  const parts = counts.slice(0, kinds).map(([name, count]) =>
    themeText(theme, toolColor(name), name) +
    themeText(theme, "dim", " " + glyphs.times) +
    themeText(theme, "muted", String(count)),
  );
  if (counts.length > kinds) parts.push(themeText(theme, "dim", "+" + (counts.length - kinds)));
  return parts;
}

/** Count failures anywhere in the subtree. */
function countErrors(nodes: TreeNode[]): number {
  return nodes.reduce(
    (total, node) =>
      node.kind === "thinking" ? total : total + (node.status === "error" ? 1 : 0) + countErrors(node.children),
    0,
  );
}

/** Pluralize a counted noun without a plural dictionary. */
function counted(theme: LiuovoTheme, value: number, singular: string, plural: string): string {
  return metric(theme, value, value === 1 ? singular : plural);
}

/** Build the metadata tail of one row: scope, failures, outcome, and time. */
function rowTail(node: TreeNode, theme: LiuovoTheme, glyphs: Glyphs): string {
  const parts: string[] = [];
  // A branch row names the mix of steps it contains instead of a bare count.
  if (node.children.length > 0) parts.push(...toolBreakdown(node.children, theme, glyphs));
  const errors = node.children.filter(child => child.status === "error").length;
  if (errors > 0) parts.push(themeText(theme, "error", errors + (errors === 1 ? " error" : " errors")));
  // A branch row is summarized by its steps; a leaf row carries its own outcome.
  if (node.summary && node.children.length === 0) parts.push(paintSummary(node.name, node.summary, node.status, theme));
  else if (node.children.length === 0)
    parts.push(paintSummary(node.name, node.status === "running" ? "running" : node.status, node.status, theme));
  const elapsed = node.duration ?? (node.status === "running" ? Date.now() - node.started : 0);
  parts.push(themeText(theme, "dim", formatElapsed(elapsed)));
  return parts.join(themeText(theme, "dim", DOT));
}

/** Render inputs shared by the painter and by tests. */
export interface PaintState {
  settings: TreeSettings;
  expanded: ReadonlySet<string>;
}

/** How long one blink frame lasts; the watch timer repaints on the same cadence. */
const BLINK_MS = 450;

/** Colour and glyph of a row marker: the call state, not whether the row opens. */
function stateMark(node: TreeNode, glyphs: Glyphs, now: number): { glyph: string; color: Foreground } {
  if (node.kind === "thinking") return { glyph: glyphs.dot, color: "muted" };
  switch (node.status) {
    case "running":
      // A running call pulses between the filled and the outline dot.
      return { glyph: Math.floor(now / BLINK_MS) % 2 === 0 ? glyphs.dot : glyphs.hollow, color: "warning" };
    case "error":
      return { glyph: glyphs.dot, color: "error" };
    case "success":
      return { glyph: glyphs.dot, color: "success" };
    case "cancelled":
      return { glyph: glyphs.hollow, color: "muted" };
    default:
      return { glyph: glyphs.hollow, color: "warning" };
  }
}
/**
 * Draw one group as a tree of rows. Returns ANSI text per line and, when a target map is
 * provided, records which node id owns each clickable line.
 */
export function paintGroup(
  state: PaintState,
  group: TreeGroup,
  width: number,
  theme: LiuovoTheme = plainTheme,
  piExpanded = false,
  targets: Map<number, string> = new Map(),
): string[] {
  targets.clear();
  const lines: string[] = [];
  if (group.rows.length === 0) return lines;
  const glyphs = treeGlyphs(state.settings.iconMode);
  // Two different gestures: the header reveals every row of the group, while pi own
  // expand-all (ctrl+o) opens every level. A revealed row still opens only by click.
  const expandAll = piExpanded;
  const reveal = piExpanded || group.openAll;
  const limit = Math.max(1, state.settings.window);
  // Reasoning rows narrate the card but are not calls, so the rolling window and the
  // counts apply to tool rows only; reasoning from the window start onward stays in
  // place, which keeps each thought directly above the action it led to.
  const tools = group.rows.filter(row => row.kind !== "thinking");
  const truncated = !reveal && tools.length > limit;
  const visible = truncated ? tools.slice(-limit) : tools;
  // Only a truncated card drops old narration: it belongs to rows that scrolled away.
  const from = truncated && visible.length > 0 ? visible[0]!.seq : Number.NEGATIVE_INFINITY;
  const kept = new Set(visible.map(row => row.id));
  const rows = group.rows.filter(row => (row.kind === "thinking" ? row.seq >= from : kept.has(row.id)));

  // The headline always leads the card, even for a single call: it is the frame that
  // tells you what this turn did, and the rows below are its detail.
  if (tools.length > 0) {
    const timing = groupTiming(group.rows);
    const errors = countErrors(tools);
    const total = tools.length;
    const scope =
      visible.length === total
        ? counted(theme, total, "call", "calls")
        : themeText(theme, "accent", String(visible.length)) +
          themeText(theme, "dim", " of ") +
          themeText(theme, "muted", String(total)) +
          themeText(theme, "muted", " calls");
    const parts = [scope, ...toolBreakdown(tools, theme, glyphs)];
    if (errors > 0) parts.push(themeText(theme, "error", errors + (errors === 1 ? " error" : " errors")));
    parts.push(themeText(theme, "dim", formatElapsed(timing.elapsed)));
    const headColor: Foreground = timing.running ? "warning" : errors > 0 ? "error" : "dim";
    const head = themeText(theme, headColor, glyphs.rail + " " + (reveal ? glyphs.open : glyphs.closed) + " ");
    lines.push(fitToolLine(head + parts.join(themeText(theme, "dim", DOT)), width));
    targets.set(0, GROUP_TARGET);
  }

  const emit = (nodes: TreeNode[], ancestors: boolean[]): void => {
    for (const [index, node] of nodes.entries()) {
      const last = index === nodes.length - 1;
      const guide = ancestors.map(ancestor => (ancestor ? "   " : glyphs.pipe + "  ")).join("");
      const open = expandAll || state.expanded.has(node.id);
      const mark = stateMark(node, glyphs, Date.now());
      const railColor: Foreground =
        node.kind === "thinking"
          ? "muted"
          : node.status === "error"
            ? "error"
            : node.status === "running"
              ? "accent"
              : "dim";
      const label =
        node.kind === "thinking"
          ? themeText(theme, "muted", "thinking")
          : toolLabel(node.name, theme, state.settings.icons, state.settings.iconMode);
      // The branch keeps its stem; the dot after it carries the call state, so a running
      // call blinks in place instead of the marker only saying open or closed.
      const stem = glyphs.rail + " " + guide + (last ? glyphs.end : glyphs.tee) + "─ ";
      const connector =
        themeText(theme, railColor, stem) + themeText(theme, mark.color, mark.glyph) + " " + label;
      // Reasoning stays a plain label until it is clicked; the text lives in the preview.
      const detail = node.kind === "thinking" ? "" : detailOf(node);
      const tail =
        node.kind === "thinking"
          ? themeText(theme, "dim", formatElapsed(node.duration ?? (node.status === "running" ? Date.now() - node.started : 0)))
          : rowTail(node, theme, glyphs);
      const line = detail
        ? summaryLine(
            connector,
            themeText(theme, node.status === "error" ? "error" : "muted", detail),
            themeText(theme, "dim", DOT),
            tail,
            width,
          )
        : fitToolLine(connector + themeText(theme, "dim", DOT) + tail, width);
      lines.push(line);
      targets.set(lines.length - 1, node.id);

      if (open) emit(node.children, [...ancestors, last]);
      else if (state.settings.revealErrors)
        emit(node.children.filter(child => child.status === "error"), [...ancestors, last]);

      // Branch rows drill into their steps instead of dumping their own output.
      const preview = node.children.length === 0 ? node.preview ?? [] : [];
      if (open && preview.length > 0) {
        const childGuide = [...ancestors, last].map(ancestor => (ancestor ? "   " : glyphs.pipe + "  ")).join("");
        const prefix = themeText(theme, "dim", glyphs.rail + " " + childGuide + glyphs.pipe + " ");
        const painted = node.previewDiff
          ? colorizeDiff(preview.join("\n"), theme)
          : preview.map(text => themeText(theme, "dim", text));
        for (const text of painted.slice(0, PREVIEW_LINES)) {
          lines.push(fitToolLine(prefix + text, width));
          targets.set(lines.length - 1, node.id);
        }
        if (node.previewTruncated || painted.length > PREVIEW_LINES) {
          lines.push(fitToolLine(prefix + themeText(theme, "dim", ELLIPSIS), width));
          targets.set(lines.length - 1, node.id);
        }
      }
    }
  };

  emit(rows, []);
  return lines;
}

/** One tool row handed to the tree: its live component and the host's paint context. */
/** The event kinds that can close a card. */
export type PaintScope = "prompt" | "turn" | "message";

export interface TreeRow {
  toolCallId: string;
  inner: Component;
  theme?: LiuovoTheme;
  expanded: boolean;
  invalidate: () => void;
  /** Which pi row this render call belongs to; defaults to the finished result row. */
  phase?: PaintPhase;
  background?: (text: string) => string;
  outputPad?: number;
}

/** Renders and owns the click target of the single line that paints a group card. */
class TreeBlock implements Component {
  private painterWidth?: number;
  private painter?: WidthAwareLines;

  constructor(
    private readonly tree: ToolTree,
    private readonly group: TreeGroup,
    private readonly theme: LiuovoTheme,
    private readonly row: TreeRow,
  ) {}

  /** Paint the group, applying the host row background and inset padding. */
  render(width: number): string[] {
    const pad = this.row.outputPad ?? 1;
    if (!this.painter || this.painterWidth !== width) {
      this.painter = new WidthAwareLines(
        innerWidth => this.tree.paint(this.group, innerWidth - pad * 2, this.theme, this.row.expanded),
        this.row.background,
        false,
        pad,
      );
      this.painterWidth = width;
    }
    return this.painter.render(width);
  }

  invalidate(): void {
    this.painter?.invalidate();
  }

  /** Toggle the clicked level; unknown rows fall through to pi's own expand. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    // Repaint from the click's own width so the hit map always matches these lines.
    this.tree.paint(this.group, event.width - (this.row.outputPad ?? 1) * 2, this.theme, this.row.expanded);
    const target = this.tree.targetAt(event.y);
    if (target === undefined) return undefined;
    this.tree.toggle(this.group, target);
    return { handled: true };
  }
}

/**
 * Observes tool events, groups them by turn or message, and hands the first row of each
 * group a clickable tree that stands in for every row of that group.
 */
export class ToolTree {
  private readonly groups = new Map<string, TreeGroup>();
  private readonly expanded = new Set<string>();
  private readonly targets = new Map<number, string>();
  private active?: TreeGroup;
  private sequence = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly settings: TreeSettings,
    private readonly redraw: () => void = () => {},
  ) {}

  /** Repaints already queued for the next tick, so one row is rebuilt once. */
  private readonly deferred = new Set<() => void>();

  /** Run a row repaint after the current frame instead of during it. */
  private defer(repaint?: () => void): void {
    if (!repaint || this.deferred.has(repaint)) return;
    this.deferred.add(repaint);
    queueMicrotask(() => {
      // Hold the entry for the whole repaint: a repaint that renders its row again would
      // otherwise queue itself forever and starve every other task, freezing the session.
      try {
        repaint();
      } finally {
        this.deferred.delete(repaint);
      }
    });
  }

  /** Close the current group so later calls start a fresh card. */
  boundary(kind: PaintScope): void {
    if (this.settings.mode === "off") return;
    // The mode names the one event that closes a card; every other event is narration.
    if (this.settings.mode !== kind) return;
    if (this.active) this.close(this.active);
    this.active = undefined;
    this.stopWatch();
  }

  /** Record a tool call, attaching it under its parent when one is running. */
  start(event: Pick<ToolExecutionStartEvent, "toolCallId" | "toolName" | "args" | "parentToolCallId">): void {
    if (this.settings.mode === "off") return;
    const group = this.register(event.toolCallId, event.toolName, event.args, event.parentToolCallId);
    if (group) this.refresh(group);
  }

  /**
   * Record a call pi is still streaming, before its execution starts, so the row paints
   * inside the card instead of flashing on its own and then jumping into the group.
   * Runs inside pi's render pass, so it repaints only when the row text actually changed.
   */
  ensure(id: string, toolName: string, args: unknown): void {
    if (this.settings.mode === "off") return;
    const group = this.register(id, toolName, args, undefined);
    if (group) this.defer(group.invalidate);
  }

  /**
   * Put one call into the current group. Returns the group that needs repainting, or
   * undefined when nothing visible changed, so repeated renders of one row stay free.
   */
  private register(id: string, toolName: string, args: unknown, parentId?: string): TreeGroup | undefined {
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID) return undefined;
    const group = this.current();
    const record = (args ?? undefined) as Record<string, unknown> | undefined;
    const known = group.nodes.get(id);
    if (known) {
      // Streaming rows report their arguments in pieces; keep the row text in step.
      const goal = goalOf(record);
      const target = targetOf(record);
      if (goal === known.goal && target === known.target) return undefined;
      known.goal = goal;
      known.target = target;
      return group;
    }
    const parent = typeof parentId === "string" ? group.nodes.get(parentId) : undefined;
    if (parent ? parent.children.length >= MAX_CHILDREN : group.rows.length >= MAX_ROWS) return undefined;
    const node = this.makeNode(id, toolName, args, Date.now(), parent);
    group.nodes.set(id, node);
    (parent ? parent.children : group.rows).push(node);
    // The card stays on the oldest call of the group, so it grows in place instead of
    // sliding to every new row, which read as each call rendering itself separately.
    if (!parent && group.leaderId === undefined) group.leaderId = node.id;
    this.watch();
    return group;
  }

  /** Build one node from a tool call, with the goal it stated and its code size. */
  private makeNode(id: string, toolName: string, args: unknown, started: number, parent?: TreeNode): TreeNode {
    const record = (args ?? undefined) as Record<string, unknown> | undefined;
    const node: TreeNode = {
      id,
      parent: parent?.id,
      name: brief(toolName, 100),
      goal: goalOf(record),
      target: targetOf(record),
      status: "running",
      started,
      seq: ++this.sequence,
      children: [],
    };
    const code = record?.content;
    if (toolName === "write" && typeof code === "string")
      node.writeLines = code.length === 0 ? 0 : code.split("\n").length - (code.endsWith("\n") ? 1 : 0);
    return node;
  }

  /** Build a reasoning row: no tool call, just what the model was weighing first. */
  private makeThinkingNode(id: string, text: string, started: number): TreeNode {
    return {
      id,
      name: "thinking",
      goal: thinkingGoal(text),
      target: "",
      status: "running",
      started,
      seq: ++this.sequence,
      kind: "thinking",
      text,
      summary: thinkingSummary(text),
      preview: thinkingPreview(text, PREVIEW_LINES),
      children: [],
    };
  }

  /**
   * Record one reasoning run as a row of the current card. Streaming repeats the same
   * id, so the row updates in place and only a real text change repaints the card.
   */
  note(id: string, text: string, options: { started?: number; final?: boolean } = {}): void {
    if (this.settings.mode === "off" || text.trim().length === 0) return;
    const group = this.current();
    let node = group.nodes.get(id);
    if (!node) {
      node = this.makeThinkingNode(id, text, options.started ?? Date.now());
      group.nodes.set(id, node);
      group.rows.push(node);
    }
    if (node.text !== text) {
      node.text = text;
      node.goal = thinkingGoal(text);
      node.summary = thinkingSummary(text);
      node.preview = thinkingPreview(text, PREVIEW_LINES);
    }
    if (options.final && node.status === "running") {
      node.status = "success";
      node.duration = Math.max(0, Date.now() - node.started);
    }
    this.refresh(group);
  }

  /** Apply a finished result: status, one-line summary, and bounded output preview. */
  private finalize(
    group: TreeGroup,
    node: TreeNode,
    result: unknown,
    status: TreeStatus,
    durationMs?: number,
  ): void {
    node.status = status;
    node.hasResult = true;
    node.duration = typeof durationMs === "number" && durationMs >= 0 ? durationMs : undefined;
    if (node.status === "cancelled") node.summary = "cancelled";
    else if (node.writeLines !== undefined && node.status === "success")
      node.summary = node.writeLines + (node.writeLines === 1 ? " line" : " lines");
    else
      node.summary = brief(
        summarizeToolResult(node.name, result ?? {}, node.status === "error", {}, undefined, plainTheme),
      );
    this.capture(group, node, result);
  }

  /**
   * Rebuild cards from a replayed transcript, so a reload or a resumed session keeps the
   * grouping it had. Restored rows are history: they paint once and hold no live timer.
   */
  restore(segments: ReplayCall[][]): void {
    if (this.settings.mode === "off" || segments.length === 0) return;
    this.clear();
    for (const [index, calls] of segments.entries()) {
      const leader = calls[0];
      if (!leader) continue;
      const group: TreeGroup = {
        key: "r" + index,
        rows: [],
        nodes: new Map(),
        started: leader.started,
        budget: PREVIEW_TOTAL,
        openAll: false,
      };
      this.groups.set(group.key, group);
      this.attachCalls(group, calls);
      // A card needs a tool row to be painted on, so reasoning alone keeps no group.
      const first = group.rows.find(row => row.kind !== "thinking");
      if (first) group.leaderId = first.id;
      else this.groups.delete(group.key);
    }
    this.active = undefined;
    this.trim();
  }

  /** Attach replayed calls under a parent row, used by both restore and a live codemode result. */
  private attachCalls(group: TreeGroup, calls: ReplayCall[], parent?: TreeNode): void {
    for (const call of calls) {
      const existing = group.nodes.get(call.id);
      if (existing && existing !== parent) {
        // The live session already registered this step from its own tool events, so the
        // snapshot only fills in what the event stream could not keep: never a second row.
        if (existing.summary === undefined) existing.summary = call.summary;
        if (existing.preview === undefined) this.restorePreview(group, existing, call);
        this.attachCalls(group, call.children, existing);
        continue;
      }
      if (parent ? parent.children.length >= MAX_CHILDREN : group.rows.length >= MAX_ROWS) return;
      const node = this.makeNode(call.id, call.name, call.args, call.started, parent);
      node.restored = true;
      if (call.kind === "thinking") {
        node.kind = "thinking";
        node.text = call.text ?? "";
        node.goal = thinkingGoal(node.text);
        node.summary = thinkingSummary(node.text);
        node.preview = thinkingPreview(node.text, PREVIEW_LINES);
      }
      group.nodes.set(call.id, node);
      (parent ? parent.children : group.rows).push(node);
      this.attachCalls(group, call.children, node);
      if (call.result !== undefined) this.finalize(group, node, call.result, call.status, call.durationMs);
      else {
        node.status = call.status;
        node.duration = call.durationMs;
        node.summary = call.summary;
        this.restorePreview(group, node, call);
      }
    }
  }

  /** Restore a bounded preview for a call whose output only survives as snapshot text. */
  private restorePreview(group: TreeGroup, node: TreeNode, call: ReplayCall): void {
    const lines = call.preview ?? [];
    if (group.budget <= 0 || lines.length === 0) return;
    const shown = lines.slice(0, PREVIEW_LINES);
    group.budget -= shown.join("\n").length;
    node.previewDiff = call.previewDiff === true;
    node.preview = shown;
    node.previewTruncated = call.previewTruncated === true || lines.length > PREVIEW_LINES;
  }
  /** Finalize a call's status, bounded summary, and preview text. */
  end(
    event: Pick<ToolExecutionEndEvent, "toolCallId" | "toolName" | "result" | "isError" | "durationMs">,
    ctx?: { signal?: AbortSignal },
  ): void {
    if (this.settings.mode === "off") return;
    const group = this.groupOf(event.toolCallId);
    const node = group?.nodes.get(event.toolCallId);
    if (!group || !node || node.status !== "running") return;
    const failed = Boolean((event as { isError?: boolean }).isError || (event.result as { isError?: boolean } | undefined)?.isError);
    const status: TreeStatus = ctx?.signal?.aborted ? "cancelled" : failed ? "error" : "success";
    // The result row owns the card from here on; the live row goes blank in the same frame.
    this.finalize(group, node, event.result, status, event.durationMs);
    // The codemode snapshot is the only record of the steps that ran inside the call.
    this.attachCalls(group, readNested((event.result as { details?: unknown } | undefined)?.details), node);
    this.refresh(group);
  }

  /** Close the current group when the turn ends; unfinished calls become incomplete. */
  settle(): void {
    if (this.active) this.close(this.active);
    this.active = undefined;
    this.stopWatch();
  }

  /** Drop every group, used when the session changes. */
  clear(): void {
    this.groups.clear();
    this.expanded.clear();
    this.active = undefined;
    this.stopWatch();
  }

  /** Whether the card paints this call, so pi own rows stay blank. */
  owns(id: string): boolean {
    if (this.settings.mode === "off") return false;
    return this.groupOf(id)?.nodes.has(id) === true;
  }

  /** Report what the tree currently holds for /liuovo status. */
  summary(): { groups: number; rows: number; mode: GroupMode } {
    let rows = 0;
    for (const group of this.groups.values()) rows += group.rows.length;
    return { groups: this.groups.size, rows: rows, mode: this.settings.mode };
  }

  /**
   * Decide what one pi row paints: the group card for the group's first row, nothing for
   * its siblings, and the untouched component when the tree does not own this call.
   */
  render(row: TreeRow): Component {
    if (this.settings.mode === "off") return row.inner;
    const group = this.groupOf(row.toolCallId);
    const node = group?.nodes.get(row.toolCallId);
    if (!group || !node) return row.inner;
    node.invalidate = row.invalidate;
    // pi renders two rows per call: the live call row, then the finished result row.
    const phase: PaintPhase = row.phase ?? "result";
    node.slots ??= new Map();
    node.slots.set(phase, row.invalidate);
    if (phase === "call") {
      // A restored call with no result has only a call row, so it must be allowed to paint.
      if (node.hasResult || node.status !== "running") return new Container();
    } else if (!node.hasResult) {
      node.hasResult = true;
      // Repaint the call row out of band: pi rebuilds its children inside the render pass.
      this.defer(node.slots.get("call"));
    }
    if (!node.painted) node.painted = true;
    // Fallback for a group whose first row never reached the tree: paint somewhere.
    if (group.leaderId === undefined) group.leaderId = node.id;
    if (group.leaderId !== node.id) return new Container();
    group.invalidate = row.invalidate;
    return new TreeBlock(this, group, row.theme ?? plainTheme, row);
  }

  /** Toggle one level, either a single call or the whole group. */
  toggle(group: TreeGroup, target: string): void {
    if (target === GROUP_TARGET) group.openAll = !group.openAll;
    else if (this.expanded.has(target)) this.expanded.delete(target);
    else this.expanded.add(target);
    this.refresh(group);
  }

  /** Resolve the node id painted on a given line of the last render. */
  targetAt(line: number): string | undefined {
    return this.targets.get(line);
  }

  /** Paint through the shared helper so the click map and the lines stay in sync. */
  paint(group: TreeGroup, width: number, theme: LiuovoTheme, piExpanded: boolean): string[] {
    return paintGroup(
      { settings: this.settings, expanded: this.expanded },
      group,
      width,
      theme,
      piExpanded,
      this.targets,
    );
  }

  /** Create the group lazily so an empty turn never costs a card. */
  private current(): TreeGroup {
    if (this.active) return this.active;
    this.trim();
    const group: TreeGroup = {
      key: "g" + ++this.sequence,
      rows: [],
      nodes: new Map(),
      started: Date.now(),
      budget: PREVIEW_TOTAL,
      openAll: false,
    };
    this.groups.set(group.key, group);
    this.active = group;
    return group;
  }

  /**
   * Drop previews from older groups and evict only at the hard ceiling: a settled turn
   * must still paint after a terminal resize, long after its output was worth keeping.
   */
  private trim(): void {
    const keys = [...this.groups.keys()];
    for (const key of keys.slice(0, Math.max(0, keys.length - (MAX_GROUPS - 1)))) {
      const group = this.groups.get(key);
      if (!group || group === this.active) continue;
      const drop = (nodes: TreeNode[]): void => {
        for (const node of nodes) {
          node.preview = undefined;
          drop(node.children);
        }
      };
      drop(group.rows);
      group.budget = 0;
    }
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_GROUPS_TOTAL))) {
      this.groups.delete(key);
      this.expanded.delete(key);
    }
  }

  /** Find the group that owns a call id, preferring the active one. */
  private groupOf(id: string): TreeGroup | undefined {
    if (this.active?.nodes.has(id)) return this.active;
    for (const group of this.groups.values()) if (group.nodes.has(id)) return group;
    return undefined;
  }

  /** Mark still-running calls as incomplete when their boundary closes. */
  private close(group: TreeGroup): void {
    const closeNodes = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        if (node.status === "running") {
          node.duration = Date.now() - node.started;
          if (node.kind === "thinking") node.status = "success";
          else {
            node.status = "incomplete";
            node.summary = "incomplete";
          }
        }
        closeNodes(node.children);
      }
    };
    closeNodes(group.rows);
    // Reasoning without a tool call has no row to paint on, so the group is worthless.
    if (!group.rows.some(node => node.kind !== "thinking")) {
      this.groups.delete(group.key);
      if (this.active?.key === group.key) this.active = undefined;
    }
  }

  /** Store a bounded preview of the call's own output, diff first. */
  private capture(group: TreeGroup, node: TreeNode, result: unknown): void {
    if (group.budget <= 0) return;
    const details = (result as { details?: { diff?: unknown } } | undefined)?.details;
    const diff = typeof details?.diff === "string" && details.diff.length > 0 ? details.diff : undefined;
    const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
    const text = diff ?? content?.find(part => part?.type === "text")?.text;
    const raw = clean(text);
    if (!raw) return;
    const slice = raw.slice(0, Math.min(PREVIEW_CHARS * PREVIEW_LINES, group.budget));
    group.budget -= slice.length;
    const lines = slice.split("\n");
    node.previewDiff = Boolean(diff);
    node.preview = lines.slice(0, PREVIEW_LINES);
    node.previewTruncated = lines.length > PREVIEW_LINES || slice.length < raw.length;
  }

  /** Ask the host to repaint the group card after any mutation. */
  private refresh(group: TreeGroup): void {
    group.invalidate?.();
    this.redraw();
  }

  /** Keep running durations honest and animate the blink with one shared timer. */
  private watch(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      const group = this.active;
      if (!group || !this.hasRunning(group)) {
        this.stopWatch();
        return;
      }
      group.invalidate?.();
    }, BLINK_MS);
    this.timer.unref?.();
  }

  private stopWatch(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private hasRunning(group: TreeGroup): boolean {
    const anyRunning = (nodes: TreeNode[]): boolean =>
      nodes.some(node => node.status === "running" || anyRunning(node.children));
    return anyRunning(group.rows);
  }
}
