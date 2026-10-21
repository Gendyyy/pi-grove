/**
 * replay.ts — rebuild grouped tool cards from the stored transcript, so a reload or a
 * resumed session keeps the grouped narration instead of falling back to per-call rows.
 */
import { thinkingRuns } from "./thinking.js";
import type { GroupMode, TreeStatus } from "./tool-tree.js";
import { readDetail } from "./details.js";

/** One tool call recovered from the transcript, with the steps nested inside it. */
export interface ReplayCall {
  id: string;
  name: string;
  args?: unknown;
  /** Result envelope pi stored with the call, replayed through the normal summary path. */
  result?: unknown;
  isError: boolean;
  status: TreeStatus;
  started: number;
  durationMs?: number;
  /** Snapshot summary, used when the transcript only kept a one-line result. */
  summary?: string;
  children: ReplayCall[];
  parent?: string;
  /** Set on a reasoning row recovered from an assistant message. */
  kind?: "thinking";
  /** Reasoning text, used by the card to narrate the thought. */
  text?: string;
  /** Bounded output lines kept in a snapshot, so a restored row can still expand. */
  preview?: string[];
  previewTruncated?: boolean;
  previewDiff?: boolean;
}

/** Only these statuses describe a finished call; anything else is treated as unfinished. */
function normalizeStatus(value: unknown): TreeStatus {
  if (value === "error") return "error";
  if (value === "cancelled") return "cancelled";
  if (value === "running") return "incomplete";
  if (value === "incomplete") return "incomplete";
  return "success";
}

/** Snapshot previews are one string; a replayed transcript may already hold lines. */
function previewLines(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    return value.length === 0 ? undefined : value.split("\n");
  }
  if (Array.isArray(value)) {
    const lines = value.filter((line): line is string => typeof line === 'string');
    return lines.length > 0 ? lines : undefined;
  }
  return undefined;
}

/** Recover the steps grove recorded inside one codemode result. */
export function readNested(details: unknown): ReplayCall[] {
  const snapshot = readDetail<{ calls?: unknown }>(details, "piGroveNested");
  const calls = Array.isArray(snapshot?.calls) ? snapshot.calls : [];
  const nodes = new Map<string, ReplayCall>();
  const parents = new Map<string, string | undefined>();
  for (const raw of calls) {
    const call = raw as {
      id?: unknown;
      name?: unknown;
      reasoning?: unknown;
      status?: unknown;
      started?: unknown;
      duration?: unknown;
      parent?: unknown;
      summary?: unknown;
      preview?: unknown;
      previewTruncated?: unknown;
      previewDiff?: unknown;
      diff?: unknown;
    };
    if (typeof call?.id !== "string" || typeof call.name !== "string") continue;
    const reasoning = typeof call.reasoning === "string" && call.reasoning ? call.reasoning : undefined;
    nodes.set(call.id, {
      id: call.id,
      name: call.name,
      args: reasoning ? { reasoning: reasoning } : undefined,
      isError: call.status === "error",
      status: normalizeStatus(call.status),
      started: typeof call.started === "number" ? call.started : Date.now(),
      durationMs: typeof call.duration === "number" ? call.duration : undefined,
      summary: typeof call.summary === "string" ? call.summary : undefined,
      preview: previewLines(call.preview),
      previewTruncated: call.previewTruncated === true,
      // A live snapshot flags a diff with diff; a replayed transcript uses previewDiff.
      previewDiff: call.previewDiff === true || call.diff === true,
      children: [],
    });
    parents.set(call.id, typeof call.parent === "string" ? call.parent : undefined);
  }
  const roots: ReplayCall[] = [];
  for (const [id, node] of nodes) {
    const parent = nodes.get(parents.get(id) ?? "");
    // A parent link that points outside this snapshot leaves the step at the top.
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * Read a pi session transcript into one segment of top-level calls per card.
 * The mode names where a card breaks: a prompt, an assistant turn, or every message.
 */
export function readTranscript(entries: unknown, mode: GroupMode, includeThinking = true): ReplayCall[][] {
  if (mode === "off" || !Array.isArray(entries)) return [];
  const segments: ReplayCall[][] = [];
  const index = new Map<string, ReplayCall>();
  const openSegment = (): ReplayCall[] => {
    const segment: ReplayCall[] = [];
    segments.push(segment);
    return segment;
  };
  let current: ReplayCall[] = [];

  for (const raw of entries) {
    const entry = raw as { type?: unknown; timestamp?: unknown; message?: Record<string, unknown> };
    if (entry?.type !== "message" || !entry.message) continue;
    const message = entry.message;
    const role = message.role;
    const stamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    const at = Number.isFinite(stamp) ? stamp : Date.now();

    if (role === "user") {
      if (mode === "prompt") {
        current = openSegment();
      }
      continue;
    }
    if (role === "assistant") {
      if (mode !== "prompt") current = openSegment();
      const parts = Array.isArray(message.content) ? message.content : [];
      // Reasoning is replayed in place, so a reloaded card narrates the same order the
      // live card did: thought, action, thought, action.
      const runs = thinkingRuns(message, typeof message.id === "string" ? "id:" + message.id : "t" + at);
      let seen = 0;
      // Consecutive thinking parts are one run, exactly how the live card saw them.
      let inside = false;
      for (const part of parts) {
        const call = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
        if (call?.type === "thinking") {
          // Reasoning rows exist only while the card is the place reasoning is shown.
          if (!includeThinking) continue;
          if (inside) continue;
          inside = true;
          const run = runs[seen++];
          if (!run) continue;
          const thought: ReplayCall = {
            id: run.id,
            name: "thinking",
            kind: "thinking",
            text: run.text,
            isError: false,
            status: "success",
            started: at,
            children: [],
          };
          index.set(thought.id, thought);
          current.push(thought);
          continue;
        }
        inside = false;
        if (call?.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string") continue;
        const node: ReplayCall = {
          id: call.id,
          name: call.name,
          args: call.arguments,
          isError: false,
          status: "incomplete",
          started: at,
          children: [],
        };
        index.set(node.id, node);
        current.push(node);
      }
      continue;
    }
    if (role !== "toolResult") continue;

    const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
    const node = id ? index.get(id) : undefined;
    if (!node) continue;
    const isError = message.isError === true;
    node.result = { content: message.content, details: message.details, isError: isError };
    node.isError = isError;
    node.durationMs = typeof message.durationMs === "number" ? message.durationMs : undefined;
    node.status = isError ? "error" : "success";
    node.children = readNested(message.details);
    for (const child of node.children) index.set(child.id, child);
  }

  return segments.filter(segment => segment.length > 0);
}
