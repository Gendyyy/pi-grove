/**
 * tool-tree.ts — the state machine: it collects the calls of one prompt, closes a
 * card at the right boundary, restores cards from a transcript, and re-exports the
 * public surface so importers keep one entry point.
 */
import { Container, type Component } from "@earendil-works/pi-tui";
import type { ToolExecutionEndEvent, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { summarizeToolResult, WidthAwareLines } from "./block-render.js";
import { readNested, type ReplayCall } from "./replay.js";
import { thinkingGoal, thinkingPreview, thinkingSummary } from "./thinking.js";
import { plainTheme, type LiuovoTheme } from "./theme.js";
import { TreeBlock, type TreeRow } from "./tree-block.js";
import { BLINK_MS, paintGroup, type PaintState } from "./tree-paint.js";
import {
  DOT,
  ELLIPSIS,
  GROUP_TARGET,
  MAX_CHILDREN,
  MAX_GROUPS,
  MAX_GROUPS_TOTAL,
  MAX_ID,
  MAX_ROWS,
  PREVIEW_CHARS,
  PREVIEW_LINES,
  PREVIEW_TOTAL,
  brief,
  clean,
  goalOf,
  targetOf,
  type GroupMode,
  type PaintPhase,
  type PaintScope,
  type TreeGroup,
  type TreeNode,
  type TreeSettings,
  type TreeStatus,
} from "./tree-model.js";
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


// The public surface stays here: importers and tests never need to know the split.
export { GROUP_TARGET, treeGlyphs } from "./tree-model.js";
export type {
  Glyphs,
  GroupMode,
  PaintPhase,
  PaintScope,
  TreeGroup,
  TreeNode,
  TreeSettings,
  TreeStatus,
} from "./tree-model.js";
export { paintGroup } from "./tree-paint.js";
export type { PaintState } from "./tree-paint.js";
export type { TreeRow } from "./tree-block.js";
