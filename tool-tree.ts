/**
 * tool-tree.ts — the shell around the group card: it adapts pi events to the pure reducer
 * in tree-state.ts, owns the repaint timers, and re-exports the public surface so
 * importers keep one entry point.
 */
import { Container, type Component } from "@earendil-works/pi-tui";
import type { ToolExecutionEndEvent, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";
import type { ReplaySegment } from "./replay.js";
import { plainTheme, type GroveTheme } from "./theme.js";
import { TreeBlock, type TreeRow } from "./tree-block.js";
import { paintGroup, TICK_MS } from "./tree-paint.js";
import { GROUP_TARGET, type GroupMode, type PaintScope, type TreeGroup, type TreeNode, type TreeSettings, type TreeStatus } from "./tree-model.js";
import {
  activeGroup,
  claimSlot,
  createState,
  findGroup,
  finishCall,
  noteReasoning,
  registerCall,
  resetState,
  restoreSegments,
  settleActive,
  toggleTarget,
  type TreeState,
} from "./tree-state.js";

/**
 * Observes tool events, groups them by prompt or turn, and hands the first row of each
 * group a clickable tree that stands in for every row of that group.
 */
export class ToolTree {
  private readonly state: TreeState = createState();
  private readonly targets = new Map<number, string>();
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

  /** Close the current card so later calls start a fresh one. */
  boundary(kind: PaintScope): void {
    if (this.settings.mode === "off") return;
    // The mode names the one event that closes a card; every other event is narration.
    if (this.settings.mode !== kind) return;
    const group = activeGroup(this.state);
    settleActive(this.state, Date.now());
    this.stopWatch();
    if (group) this.refresh(group);
  }

  /** Record a tool call, attaching it under its parent when one is running. */
  start(event: Pick<ToolExecutionStartEvent, "toolCallId" | "toolName" | "args" | "parentToolCallId">): void {
    if (this.settings.mode === "off") return;
    const group = registerCall(this.state, {
      id: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      parentId: event.parentToolCallId,
      now: Date.now(),
    });
    if (group) this.refresh(group);
    this.watch();
  }

  /**
   * Record a call pi is still streaming, before its execution starts, so the row paints
   * inside the card instead of flashing on its own and then jumping into the group.
   * Runs inside pi's render pass, so it repaints only when the row text actually changed.
   */
  ensure(id: string, toolName: string, args: unknown): void {
    if (this.settings.mode === "off") return;
    const group = registerCall(this.state, { id, toolName, args, now: Date.now(), streaming: true });
    if (group) this.defer(group.invalidate);
    this.watch();
  }

  /**
   * Record one reasoning run as a row of the current card. Streaming repeats the same id,
   * so the row updates in place and only a real text change repaints the card.
   */
  note(id: string, text: string, options: { started?: number; final?: boolean } = {}): void {
    if (this.settings.mode === "off") return;
    const group = noteReasoning(this.state, {
      id,
      text,
      now: options.started ?? Date.now(),
      final: options.final === true,
    });
    if (group) this.refresh(group);
  }

  /** Finalize a call, adopting the steps a codemode snapshot kept of its children. */
  end(
    event: Pick<ToolExecutionEndEvent, "toolCallId" | "toolName" | "result" | "isError" | "durationMs">,
    ctx?: { signal?: AbortSignal },
  ): void {
    if (this.settings.mode === "off") return;
    const failed = Boolean(
      (event as { isError?: boolean }).isError || (event.result as { isError?: boolean } | undefined)?.isError,
    );
    const status: TreeStatus = ctx?.signal?.aborted ? "cancelled" : failed ? "error" : "success";
    // Use Grove's full start-to-finish interval, not the host's execution-only duration.
    const group = finishCall(this.state, {
      id: event.toolCallId,
      result: event.result,
      status,
      now: Date.now(),
    });
    if (group) this.refresh(group);
    this.watch();
  }

  /** Close the current card at its configured boundary; unfinished calls become incomplete. */
  settle(): void {
    const group = activeGroup(this.state);
    settleActive(this.state, Date.now());
    this.stopWatch();
    if (group) this.refresh(group);
  }

  /** Rebuild cards from a replayed transcript, so a reload or resume keeps the grouping. */
  restore(segments: ReplaySegment[]): void {
    if (this.settings.mode === "off") return;
    restoreSegments(this.state, segments);
    this.stopWatch();
  }

  /** Update presentation options and repaint every existing card. */
  updateSettings(settings: Partial<TreeSettings>): void {
    Object.assign(this.settings, settings);
    for (const group of this.state.groups.values()) group.invalidate?.();
    this.redraw();
  }

  /** Drop every card, used when the session changes. */
  clear(): void {
    resetState(this.state);
    this.stopWatch();
  }

  /** Whether the card paints this call, so pi own rows stay blank. */
  owns(id: string): boolean {
    if (this.settings.mode === "off") return false;
    return findGroup(this.state, id)?.nodes.has(id) === true;
  }

  /** Report what the tree currently holds for /grove status. */
  summary(): { groups: number; rows: number; mode: GroupMode } {
    let rows = 0;
    for (const group of this.state.groups.values()) rows += group.rows.length;
    return { groups: this.state.groups.size, rows, mode: this.settings.mode };
  }

  /**
   * Decide what one pi row paints: the card for the row that owns it, nothing for its
   * siblings, and the untouched component when the tree does not own the call.
   */
  render(row: TreeRow): Component {
    if (this.settings.mode === "off") return row.inner;
    const group = findGroup(this.state, row.toolCallId);
    const node: TreeNode | undefined = group?.nodes.get(row.toolCallId);
    if (!group || !node) return row.inner;
    const claim = claimSlot({ group, node, phase: row.phase ?? "result", invalidate: row.invalidate });
    if (claim.repaint) this.defer(claim.repaint);
    if (!claim.paint) return new Container();
    return new TreeBlock(this, group, row.theme ?? plainTheme, row);
  }

  /** Toggle one level, either a single row or the whole card. */
  toggle(group: TreeGroup, target: string): void {
    toggleTarget(this.state, group, target);
    this.refresh(group);
  }

  /** Resolve the row id painted on a given line of the last render. */
  targetAt(line: number): string | undefined {
    return this.targets.get(line);
  }

  /** Paint through the shared helper so the click map and the lines stay in sync. */
  paint(group: TreeGroup, width: number, theme: GroveTheme, piExpanded: boolean): string[] {
    return paintGroup(
      { settings: this.settings, expanded: this.state.expanded },
      group,
      width,
      theme,
      piExpanded,
      this.targets,
    );
  }

  /** Ask the host to repaint the card after any mutation. */
  private refresh(group: TreeGroup): void {
    group.invalidate?.();
    this.redraw();
  }

  /** Keep running call markers and elapsed times current while a call is active. */
  private watch(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      const group = this.state.activeKey === undefined ? undefined : this.state.groups.get(this.state.activeKey);
      if (!group || !hasRunning(group.rows)) {
        this.stopWatch();
        return;
      }
      group.invalidate?.();
    }, TICK_MS);
    this.timer.unref?.();
  }

  /** Stop the shared frame timer once nothing is running. */
  private stopWatch(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

function hasRunning(nodes: readonly TreeNode[]): boolean {
  return nodes.some(node => node.status === "running" || hasRunning(node.children));
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
