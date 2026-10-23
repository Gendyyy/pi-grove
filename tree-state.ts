/**
 * tree-state.ts — the pure half of the group card: one explicit state container plus the
 * transitions that mutate it. No timers, no pi and no rendering, so every rule that once
 * hid inside render callbacks is reachable from a plain test.
 */
import { summarizeToolResult } from "./block-render.js";
import { readNested, type ReplayCall, type ReplaySegment } from "./replay.js";
import { thinkingGoal, thinkingPreview, thinkingSummary } from "./thinking.js";
import { plainTheme } from "./theme.js";
import {
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
  taskMilestoneOf,
  taskMilestonesOf,
  taskIntentOf,
  taskProgressOf,
  targetOf,
  type PaintPhase,
  type TreeGroup,
  type TaskMilestone,
  type TreeNode,
  type TreeStatus,
} from "./tree-model.js";

/** The raw newline, named so this source file needs no escape sequences at all. */
const NEWLINE = String.fromCharCode(10);

/** Everything the card remembers between events. */
export interface TreeState {
  /** Cards in the order they opened, newest last. */
  groups: Map<string, TreeGroup>;
  /** Ids of the rows the reader has opened. */
  expanded: Set<string>;
  /** Key of the card the next call joins. */
  activeKey?: string;
  /** Monotonic counter behind row order and card keys. */
  sequence: number;
}

/** Start from nothing. */
export function createState(): TreeState {
  return { groups: new Map(), expanded: new Set(), sequence: 0 };
}

/** Forget every card, used when the session changes. */
export function resetState(state: TreeState): void {
  state.groups.clear();
  state.expanded.clear();
  state.activeKey = undefined;
}

/** The card a new call would join right now. */
export function activeGroup(state: TreeState): TreeGroup | undefined {
  return state.activeKey === undefined ? undefined : state.groups.get(state.activeKey);
}

/** Find the card that owns a row id, preferring the active card. */
export function findGroup(state: TreeState, id: string): TreeGroup | undefined {
  const active = activeGroup(state);
  if (active?.nodes.has(id)) return active;
  for (const group of state.groups.values()) if (group.nodes.has(id)) return group;
  return undefined;
}

/** Open a card lazily, so a turn with no calls never costs one. */
export function currentGroup(state: TreeState, now: number): TreeGroup {
  const active = activeGroup(state);
  if (active) return active;
  trimGroups(state);
  const group: TreeGroup = {
    key: "g" + ++state.sequence,
    rows: [],
    nodes: new Map(),
    started: now,
    budget: PREVIEW_TOTAL,
    openAll: false,
  };
  state.groups.set(group.key, group);
  state.activeKey = group.key;
  return group;
}

/** Set the current card title only when a model-authored cluster intent is present. */
function updateGroupIntent(group: TreeGroup, intent: string): boolean {
  if (!intent || group.intent === intent) return false;
  group.intent = intent;
  group.progress = undefined;
  group.milestones = undefined;
  group.activeMilestoneId = undefined;
  group.pendingCompletionId = undefined;
  return true;
}

/** Apply an optional phase plan and current id, preserving the last valid state. */
function updateGroupMilestones(
  group: TreeGroup,
  milestones: TaskMilestone[] | undefined,
  milestoneId: string | undefined,
): boolean {
  let changed = false;
  let planChanged = false;
  if (milestones) {
    const samePlan = group.milestones?.length === milestones.length &&
      group.milestones.every((milestone, index) =>
        milestone.id === milestones[index]?.id && milestone.label === milestones[index]?.label,
      );
    if (!samePlan) {
      group.milestones = milestones;
      changed = true;
      planChanged = true;
    }
  }
  const plan = group.milestones;
  if (!plan) return changed;
  const declaredIndex = milestoneId ? plan.findIndex(milestone => milestone.id === milestoneId) : -1;
  const currentIndex = group.activeMilestoneId
    ? plan.findIndex(milestone => milestone.id === group.activeMilestoneId)
    : -1;
  const nextIndex = declaredIndex < 0
    ? currentIndex < 0 ? 0 : currentIndex
    : planChanged || currentIndex < 0 ? declaredIndex : Math.max(currentIndex, declaredIndex);
  const nextId = plan[nextIndex]?.id;
  if (nextId !== group.activeMilestoneId) {
    group.activeMilestoneId = nextId;
    changed = true;
  }
  return changed;
}

/** Keep the last valid estimate; repeated idempotent values do not repaint the card. */
function updateGroupProgress(group: TreeGroup, progress: number | undefined): boolean {
  if (progress === undefined || group.progress === progress) return false;
  group.progress = progress;
  return true;
}

/** Build one row from a tool call, with the goal it stated and its code size. */
function makeNode(
  state: TreeState,
  id: string,
  toolName: string,
  args: unknown,
  started: number,
  parent?: TreeNode,
  includeTaskMetadata = true,
): TreeNode {
  const record = (args ?? undefined) as Record<string, unknown> | undefined;
  const node: TreeNode = {
    id,
    parent: parent?.id,
    name: brief(toolName, 100),
    goal: goalOf(record),
    target: targetOf(record),
    taskIntent: parent || !includeTaskMetadata ? undefined : taskIntentOf(record) || undefined,
    completesTask: !parent && includeTaskMetadata && taskProgressOf(record) === 100,
    status: "running",
    started,
    seq: ++state.sequence,
    children: [],
  };
  const code = record?.content;
  if (toolName === "write" && typeof code === "string")
    node.writeLines = code.length === 0 ? 0 : code.split(NEWLINE).length - (code.endsWith(NEWLINE) ? 1 : 0);
  return node;
}

/** Build a reasoning row: no tool call, just what the model was weighing first. */
function makeThinkingNode(state: TreeState, id: string, text: string, started: number): TreeNode {
  return {
    id,
    name: "thinking",
    goal: thinkingGoal(text),
    target: "",
    status: "running",
    started,
    seq: ++state.sequence,
    kind: "thinking",
    text,
    summary: thinkingSummary(text),
    preview: thinkingPreview(text, PREVIEW_LINES),
    children: [],
  };
}

/** Input of one recorded tool call. */
export interface CallInput {
  id: string;
  toolName: string;
  args: unknown;
  parentId?: string;
  now: number;
  /** Partial argument streams may register rows, but must not commit task metadata. */
  streaming?: boolean;
}

/**
 * Put one call into the current card. Returns the card that needs repainting, or
 * undefined when nothing visible changed, so repeated renders of one row stay free.
 */
export function registerCall(state: TreeState, input: CallInput): TreeGroup | undefined {
  if (typeof input.id !== "string" || input.id.length === 0 || input.id.length > MAX_ID) return undefined;
  const group = currentGroup(state, input.now);
  const record = (input.args ?? undefined) as Record<string, unknown> | undefined;
  const parent = typeof input.parentId === "string" ? group.nodes.get(input.parentId) : undefined;
  const streaming = input.streaming === true;
  const statedIntent = parent || streaming ? "" : taskIntentOf(record);
  const statedProgress = parent || streaming ? undefined : taskProgressOf(record);
  const statedMilestones = parent || streaming ? undefined : taskMilestonesOf(record);
  const statedMilestone = parent || streaming ? undefined : taskMilestoneOf(record);
  const intentChanged = parent || streaming ? false : updateGroupIntent(group, statedIntent);
  const milestonesChanged = parent || streaming
    ? false
    : updateGroupMilestones(group, statedMilestones, statedMilestone);
  const progressChanged = parent || statedProgress === 100
    ? false
    : updateGroupProgress(group, statedProgress);
  const pendingCompletionId = statedProgress === undefined
    ? group.pendingCompletionId
    : statedProgress === 100 ? input.id : undefined;
  const known = group.nodes.get(input.id);
  if (known) {
    // Streaming rows report their arguments in pieces; keep the row text in step.
    const goal = goalOf(record);
    const target = targetOf(record);
    const intentNodeChanged = !parent && statedIntent !== "" && known.taskIntent !== statedIntent;
    const completion = !parent && statedProgress === 100;
    const completionChanged = statedProgress !== undefined && known.completesTask !== completion;
    if (!parent && statedProgress !== undefined) group.pendingCompletionId = pendingCompletionId;
    if (goal === known.goal && target === known.target && !intentChanged && !milestonesChanged && !progressChanged &&
      !intentNodeChanged && !completionChanged) return undefined;
    known.goal = goal;
    known.target = target;
    if (!parent && statedIntent) known.taskIntent = statedIntent;
    if (statedProgress !== undefined) known.completesTask = completion;
    return group;
  }
  if (parent ? parent.children.length >= MAX_CHILDREN : group.rows.length >= MAX_ROWS) return undefined;
  const node = makeNode(state, input.id, input.toolName, input.args, input.now, parent, !streaming);
  group.nodes.set(input.id, node);
  (parent ? parent.children : group.rows).push(node);
  if (!parent && statedProgress !== undefined) group.pendingCompletionId = pendingCompletionId;
  // The card stays on the oldest call of the group, so it grows in place instead of
  // sliding to every new row, which read as each call rendering itself separately.
  if (!parent && group.leaderId === undefined) group.leaderId = node.id;
  return group;
}

/** Input of one reasoning run. */
export interface NoteInput {
  id: string;
  text: string;
  now: number;
  final?: boolean;
}

/**
 * Record one reasoning run as a row of the current card. Streaming repeats the same id,
 * so the row updates in place and only a real text change repaints the card.
 */
export function noteReasoning(state: TreeState, input: NoteInput): TreeGroup | undefined {
  if (input.text.trim().length === 0) return undefined;
  const group = currentGroup(state, input.now);
  let node = group.nodes.get(input.id);
  if (!node) {
    node = makeThinkingNode(state, input.id, input.text, input.now);
    group.nodes.set(input.id, node);
    group.rows.push(node);
  }
  const changed = node.text !== input.text;
  if (changed) {
    node.text = input.text;
    node.goal = thinkingGoal(input.text);
    node.summary = thinkingSummary(input.text);
    node.preview = thinkingPreview(input.text, PREVIEW_LINES);
  }
  if (input.final && node.status === "running") {
    node.status = "success";
    node.duration = Math.max(0, input.now - node.started);
  }
  return changed || input.final === true ? group : undefined;
}

/** Apply a finished result: status, one-line summary, and bounded output preview. */
export function finalizeNode(
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
  capture(group, node, result);
}

/** Input of a finished tool call. */
export interface EndInput {
  id: string;
  result: unknown;
  status: TreeStatus;
  now: number;
}

/** Commit 100 only after the declared final call succeeds and all top-level calls settle. */
function finishPendingCompletion(group: TreeGroup): void {
  const id = group.pendingCompletionId;
  if (!id) return;
  const node = group.nodes.get(id);
  if (!node || node.taskIntent !== group.intent) {
    group.pendingCompletionId = undefined;
    return;
  }
  if (node.status === "error" || node.status === "cancelled" || node.status === "incomplete") {
    group.pendingCompletionId = undefined;
    return;
  }
  if (node.status !== "success" || group.rows.some(row => row.kind !== "thinking" && row.status === "running")) return;
  group.pendingCompletionId = undefined;
  updateGroupProgress(group, 100);
}

/** Finish one recorded call and adopt the steps a codemode snapshot kept of its children. */
export function finishCall(state: TreeState, input: EndInput): TreeGroup | undefined {
  const group = findGroup(state, input.id);
  const node = group?.nodes.get(input.id);
  if (!group || !node || node.status !== "running") return undefined;
  const durationMs = Math.max(0, input.now - node.started);
  finalizeNode(group, node, input.result, input.status, durationMs);
  // The codemode snapshot is the only record of the steps that ran inside the call.
  attachCalls(state, group, readNested((input.result as { details?: unknown } | undefined)?.details), node);
  finishPendingCompletion(group);
  return group;
}

/** Attach replayed calls under a parent row, used by both restore and a live codemode result. */
export function attachCalls(
  state: TreeState,
  group: TreeGroup,
  calls: ReplayCall[],
  parent?: TreeNode,
): void {
  for (const call of calls) {
    if (!parent) {
      const args = (call.args ?? undefined) as Record<string, unknown> | undefined;
      updateGroupIntent(group, taskIntentOf(args));
      updateGroupMilestones(group, taskMilestonesOf(args), taskMilestoneOf(args));
      const progress = taskProgressOf(args);
      if (progress === 100) group.pendingCompletionId = call.id;
      else if (progress !== undefined) {
        updateGroupProgress(group, progress);
        group.pendingCompletionId = undefined;
      }
    }
    const existing = group.nodes.get(call.id);
    if (existing && existing !== parent) {
      // The live session already registered this step from its own tool events, so the
      // snapshot only fills in what the event stream could not keep: never a second row.
      if (existing.summary === undefined) existing.summary = call.summary;
      if (existing.preview === undefined) restorePreview(group, existing, call);
      attachCalls(state, group, call.children, existing);
      continue;
    }
    if (parent ? parent.children.length >= MAX_CHILDREN : group.rows.length >= MAX_ROWS) return;
    const node = makeNode(state, call.id, call.name, call.args, call.started, parent);
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
    attachCalls(state, group, call.children, node);
    if (call.result !== undefined) finalizeNode(group, node, call.result, call.status, call.durationMs);
    else {
      node.status = call.status;
      node.duration = call.durationMs;
      node.summary = call.summary;
      restorePreview(group, node, call);
    }
  }
}

/** Restore a bounded preview for a call whose output only survives as snapshot text. */
function restorePreview(group: TreeGroup, node: TreeNode, call: ReplayCall): void {
  const lines = call.preview ?? [];
  if (group.budget <= 0 || lines.length === 0) return;
  const shown = lines.slice(0, PREVIEW_LINES);
  group.budget -= shown.reduce((total, line) => total + line.length + 1, 0);
  node.previewDiff = call.previewDiff === true;
  node.preview = shown;
  node.previewTruncated = call.previewTruncated === true || lines.length > PREVIEW_LINES;
}

/**
 * Rebuild cards from a replayed transcript, so a reload or a resumed session keeps the
 * grouping it had. Restored rows are history: they paint once and hold no live timer.
 */
export function restoreSegments(state: TreeState, segments: ReplaySegment[]): void {
  if (segments.length === 0) return;
  resetState(state);
  for (const [index, segment] of segments.entries()) {
    const calls = segment.calls;
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
    state.groups.set(group.key, group);
    attachCalls(state, group, calls);
    finishPendingCompletion(group);
    // A card needs a tool row to be painted on, so reasoning alone keeps no group.
    const first = group.rows.find(row => row.kind !== "thinking");
    if (first) group.leaderId = first.id;
    else state.groups.delete(group.key);
  }
  state.activeKey = undefined;
  trimGroups(state);
}

/** Close the card the next call would join; unfinished calls become incomplete. */
export function settleActive(state: TreeState, now: number): void {
  const group = activeGroup(state);
  state.activeKey = undefined;
  if (group) closeGroup(state, group, now);
}

/** Mark still-running rows as incomplete when their card closes. */
export function closeGroup(state: TreeState, group: TreeGroup, now: number): void {
  const closeNodes = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      if (node.status === "running") {
        node.duration = now - node.started;
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
  group.pendingCompletionId = undefined;
  // Reasoning without a tool call has no row to paint on, so the group is worthless.
  if (!group.rows.some(node => node.kind !== "thinking")) {
    state.groups.delete(group.key);
    if (state.activeKey === group.key) state.activeKey = undefined;
  }
}

/** Open or close one level of the card: a single row, or every row at once. */
export function toggleTarget(state: TreeState, group: TreeGroup, target: string): void {
  if (target === GROUP_TARGET) group.openAll = !group.openAll;
  else if (state.expanded.has(target)) state.expanded.delete(target);
  else state.expanded.add(target);
}

/**
 * Drop previews from older cards and evict only at the hard ceiling: a settled turn must
 * still paint after a terminal resize, long after its output was worth keeping.
 */
export function trimGroups(state: TreeState): void {
  const keys = [...state.groups.keys()];
  const active = activeGroup(state);
  for (const key of keys.slice(0, Math.max(0, keys.length - (MAX_GROUPS - 1)))) {
    const group = state.groups.get(key);
    if (!group || group === active) continue;
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
    state.groups.delete(key);
    state.expanded.delete(key);
  }
}

/** What one pi row should paint, decided without touching a component. */
export interface SlotClaim {
  /** Whether this row paints the card. */
  paint: boolean;
  /** A repaint to run after the frame, because pi rebuilds rows inside a render pass. */
  repaint?: () => void;
}

/** Input of one rendered row. */
export interface SlotInput {
  group: TreeGroup;
  node: TreeNode;
  phase: PaintPhase;
  invalidate: () => void;
}

/**
 * Decide whether one pi row paints the card. pi mounts two rows per call — the live call
 * row and then the finished result row — so exactly one of them may paint, or the card is
 * drawn twice and the session looks duplicated.
 */
export function claimSlot(input: SlotInput): SlotClaim {
  const { group, node, phase, invalidate } = input;
  node.invalidate = invalidate;
  node.slots ??= new Map();
  node.slots.set(phase, invalidate);
  let repaint: (() => void) | undefined;
  if (phase === "call") {
    // A restored call with no result has only a call row, so it must be allowed to paint.
    if (node.hasResult || node.status !== "running") return { paint: false };
  } else if (!node.hasResult) {
    node.hasResult = true;
    // Repaint the call row out of band: pi rebuilds its children inside the render pass.
    repaint = node.slots.get("call");
  }
  if (!node.painted) node.painted = true;
  // Fallback for a card whose first row never reached the tree: paint somewhere.
  if (group.leaderId === undefined) group.leaderId = node.id;
  if (group.leaderId !== node.id) return { paint: false, repaint };
  group.invalidate = invalidate;
  return { paint: true, repaint };
}

/** Store a bounded preview of the call's own output, diff first. */
function capture(group: TreeGroup, node: TreeNode, result: unknown): void {
  if (group.budget <= 0) return;
  const details = (result as { details?: { diff?: unknown } } | undefined)?.details;
  const diff = typeof details?.diff === "string" && details.diff.length > 0 ? details.diff : undefined;
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  const text = diff ?? content?.find(part => part?.type === "text")?.text;
  const raw = clean(text);
  if (!raw) return;
  const slice = raw.slice(0, Math.min(PREVIEW_CHARS * PREVIEW_LINES, group.budget));
  group.budget -= slice.length;
  const lines = slice.split(NEWLINE);
  node.previewDiff = Boolean(diff);
  node.preview = lines.slice(0, PREVIEW_LINES);
  node.previewTruncated = lines.length > PREVIEW_LINES || slice.length < raw.length;
}
