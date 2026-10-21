import { stripVTControlCharacters } from "node:util";
import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { colorizeDiff, formatElapsed, summarizeToolResult, summaryLine, WidthAwareLines } from "./block-render.js";
import { markFor, type IconMode } from "./icons.js";
import { metric, paintSummary, plainTheme, themeText, toolLabel, type GroveTheme } from "./theme.js";
import type { ExtensionContext, ToolExecutionStartEvent, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { readDetail } from "./details.js";

const MAX_CALLS = 256;
const PREVIEW_CHARS = 2048;
const PREVIEW_TOTAL = 32768;
const COLLAPSED_CALLS = 8;
type Status = "running" | "success" | "error" | "incomplete" | "cancelled";
interface Call {
  id: string;
  parent?: string;
  name: string;
  reasoning: string;
  target: string;
  status: Status;
  started?: number;
  duration?: number;
  inferredEnd?: boolean;
  summary?: string;
  preview?: string;
  previewTruncated?: boolean;
  fullOutputPath?: string;
  diff?: boolean;
  writeLines?: number;
  model?: boolean;
  cost?: number;
}
interface Snapshot {
  version: 1;
  calls: Call[];
  incomplete: boolean;
}

function clean(value: unknown): string {
  return typeof value === "string" ? stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "") : "";
}
function brief(value: unknown, limit = 240): string {
  return clean(value).replace(/\s+/g, " ").trim().slice(0, limit);
}
function target(args: any): string {
  if (typeof args?.command === "string") return brief(args.command);
  if (typeof args?.pattern === "string") return brief(`${args.pattern}${typeof args.path === "string" ? ` in ${args.path}` : ""}`);
  if (typeof args?.model === "string") return brief(`${typeof args.provider === "string" ? `${args.provider}/` : ""}${args.model}`);
  return brief(args?.path ?? args?.name ?? args?.prompt);
}
function goal(args: any): string {
  // Explicit annotation only; never infer intent from JavaScript. Keep native schema/grammar intact.
  const lines = typeof args?.code === "string" ? args.code.trimStart().split("\n", 3) : [];
  const line = lines[0]?.startsWith("// @options:") ? lines[1] : lines[0];
  return brief(args?.reasoning) || brief(line?.match(/^\/\/\s*reasoning:\s*(.+)$/i)?.[1]) || "Run tool script";
}
function elapsed(call: Call): number {
  if (call.status !== "running" || call.started === undefined) return call.duration ?? 0;
  return call.duration ?? Math.max(0, Date.now() - call.started);
}
const isModelCall = (name: unknown) => name === "models.classify" || name === "models.generateImages";
const finiteNonnegative = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const costText = (cost: number) => `$${cost === 0 ? "0.00" : cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;

/** Model records carry a plain provider/id reference, not JSON tool arguments. */
function nativeCall(record: any, index: number): { call: Call; incomplete: boolean } {
  const model = isModelCall(record?.name);
  let args: any = {}, incomplete = false;
  if (!model && typeof record?.args === "string" && record.args) {
    try { args = JSON.parse(record.args.slice(0, 8192)); }
    catch { incomplete = true; }
  }
  const status: Status = record?.status === "ok" ? "success" : record?.status === "error" ? "error"
    : record?.status === "cancelled" ? "cancelled" : record?.status === "running" ? "running" : "incomplete";
  return { incomplete, call: {
    id: brief(record?.id || `record-${index}`, 512), name: brief(record?.name, 100),
    reasoning: model ? "" : brief(args?.reasoning), target: model ? brief(record?.args) : target(args),
    status, duration: finiteNonnegative(record?.durationMs), summary: brief(record?.error) || undefined,
    ...(model ? { model: true, cost: finiteNonnegative(record?.cost) } : {}),
  } };
}

/** Presentation-only grouping: first-seen groups, original order within each group. */
function groupedCalls(calls: Call[]): Array<{ call: Call; heading: boolean; depth: number }> {
  const byId = new Map(calls.map(call => [call.id, call]));
  const children = new Map<Call, Call[]>();
  const roots: Call[] = [];
  for (const call of calls) {
    const parent = call.parent ? byId.get(call.parent) : undefined;
    if (parent && parent !== call) {
      const siblings = children.get(parent) ?? [];
      siblings.push(call);
      children.set(parent, siblings);
    } else roots.push(call);
  }
  const rows: Array<{ call: Call; heading: boolean; depth: number }> = [];
  const visited = new Set<Call>();
  const visit = (siblings: Call[], depth: number) => {
    const groups: Call[][] = [];
    const shared = new Map<string, Call[]>();
    for (const call of siblings) {
      // Unknown/missing reasons are independent, even if their targets match.
      const key = call.reasoning ? JSON.stringify([call.parent ?? null, call.name, call.reasoning]) : undefined;
      let group = key === undefined ? undefined : shared.get(key);
      if (!group) {
        group = [];
        groups.push(group);
        if (key !== undefined) shared.set(key, group);
      }
      group.push(call);
    }
    for (const group of groups) {
      let heading = true;
      for (const call of group) {
        if (visited.has(call)) continue;
        visited.add(call);
        rows.push({ call, heading, depth: Math.min(depth, 4) });
        heading = false;
        visit(children.get(call) ?? [], depth + 1);
      }
    }
  };
  visit(roots, 1);
  // Malformed historic cycles must neither hang nor hide retained calls.
  for (const call of calls) if (!visited.has(call)) visit([call], 1);
  return rows;
}

/** Bounded UI projection. Snapshots live in result details, never model-facing content. */
export class NestedToolObserver {
  private calls = new Map<string, Call>();
  private incomplete = false;
  private settled = false;
  private previewRemaining = PREVIEW_TOTAL;
  constructor(private readonly update: () => void = () => {}) {}

  start(event: Pick<ToolExecutionStartEvent, "toolCallId" | "toolName" | "args" | "parentToolCallId">, _ctx?: Pick<ExtensionContext, "signal">): void {
    if (this.settled) this.clear();
    if (this.calls.has(event.toolCallId)) return;
    if (this.calls.size >= MAX_CALLS || typeof event.toolCallId !== "string" || event.toolCallId.length > 512) {
      this.incomplete = true;
      this.update();
      return;
    }
    const content = event.args?.content;
    const writeDetails: Pick<Call, "writeLines"> = {};
    if (event.toolName === "write" && typeof content === "string") {
      let lineCount = 0;
      if (content.length > 0) {
        lineCount = content.split("\n").length;
        if (content.endsWith("\n")) lineCount--;
      }
      writeDetails.writeLines = lineCount;
    }
    this.calls.set(event.toolCallId, {
      id: event.toolCallId, parent: typeof event.parentToolCallId === "string" ? event.parentToolCallId.slice(0, 512) : undefined,
      name: brief(event.toolName, 100), reasoning: brief(event.args?.reasoning), target: target(event.args),
      status: "running", started: Date.now(),
      ...writeDetails,
    });
    this.update();
  }

  /** Models are not executeTool calls: Pi reports them in codemode partial details. */
  updateModels(id: string, result: any): void {
    const records = result?.details?.calls;
    if (!Array.isArray(records)) return;
    if (records.length > MAX_CALLS) this.incomplete = true;
    for (const [index, record] of records.slice(0, MAX_CALLS).entries()) {
      if (!isModelCall(record?.name) || typeof record?.id !== "string") continue;
      const { call } = nativeCall(record, index);
      const previous = this.calls.get(call.id);
      if (!previous && this.calls.size >= MAX_CALLS) { this.incomplete = true; continue; }
      this.calls.set(call.id, { ...call, parent: id, started: previous?.started ?? Date.now() });
    }
    this.update();
  }

  end(event: any, ctx?: any): void {
    if (event.toolName === "codemode") this.updateModels(event.toolCallId, event.result);
    const call = this.calls.get(event.toolCallId);
    if (!call || (call.status !== "running" && !call.inferredEnd)) return;
    call.inferredEnd = false;
    call.status = ctx?.signal?.aborted ? "cancelled" : event.isError || event.result?.isError ? "error" : "success";
    call.duration = finiteNonnegative(event.durationMs);
    const result = event.result ?? {};
    if (call.status === "cancelled") {
      call.summary = "cancelled";
    } else if (call.writeLines !== undefined && call.status === "success") {
      call.summary = `${call.writeLines} ${call.writeLines === 1 ? "line" : "lines"}`;
    } else {
      call.summary = brief(summarizeToolResult(call.name, result, call.status === "error", {}, call.duration, plainTheme));
    }
    // Capture only child previews, not another copy of the parent's script output.
    if (call.parent) {
      const diff = result.details?.diff;
      const hasDiff = typeof diff === "string" && diff.length > 0;
      const text = hasDiff ? diff : result.content?.find((part: any) => part.type === "text")?.text;
      const raw = clean(text);
      const preview = raw
        .slice(0, Math.min(PREVIEW_CHARS, this.previewRemaining))
        .split("\n").slice(0, 24).join("\n");
      call.preview = preview;
      call.diff = hasDiff;
      call.previewTruncated = preview.length < raw.length;
      this.previewRemaining -= preview.length;
      const fullPath =
        result.structuredContent?.full_output_path ??
        readDetail<{ full_output_path?: string }>(result.details, "piGroveShell")?.full_output_path;
      if (typeof fullPath === "string") call.fullOutputPath = brief(fullPath, 1024);
    }
    this.completeChildren(call.id, ctx);
    this.update();
  }

  completeChildren(id: string, ctx?: Pick<ExtensionContext, "signal">): void {
    for (const child of this.calls.values()) {
      if (child.status === "running" && this.descendsFrom(child, id)) this.closeUnfinished(child, ctx);
    }
  }

  private descendsFrom(call: Call, id: string): boolean {
    let parent = call.parent;
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      if (parent === id) return true;
      visited.add(parent);
      parent = this.calls.get(parent)?.parent;
    }
    return false;
  }
  private closeUnfinished(call: Call, ctx?: Pick<ExtensionContext, "signal">): void {
    call.duration = elapsed(call);
    call.status = ctx?.signal?.aborted ? "cancelled" : "incomplete";
    call.inferredEnd = true;
  }
  finish(ctx?: Pick<ExtensionContext, "signal">): void {
    for (const call of this.calls.values()) if (call.status === "running") this.closeUnfinished(call, ctx);
    this.settled = true;
    this.update();
  }
  snapshot(id: string): Snapshot {
    const calls = [...this.calls.values()].filter(call => this.descendsFrom(call, id));
    return {
      version: 1,
      calls: calls.map(call => ({ ...call, duration: call.status === "running" ? elapsed(call) : call.duration, started: undefined })),
      incomplete: this.incomplete || calls.some(call => call.inferredEnd),
    };
  }
  clear(): void {
    this.calls.clear();
    this.incomplete = false;
    this.settled = false;
    this.previewRemaining = PREVIEW_TOTAL;
  }

  /** Native old results contain argument previews, never child output. Do not fabricate it. */
  private recorded(result: any): Snapshot {
    const saved = readDetail<{ version?: number; calls?: Snapshot["calls"]; incomplete?: boolean }>(
      result?.details,
      "piGroveNested",
    );
    const snapshot: Snapshot = { version: 1, calls: [], incomplete: false };
    if (saved?.version === 1 && Array.isArray(saved.calls)) {
      snapshot.calls = saved.calls.slice(0, MAX_CALLS);
      snapshot.incomplete = !!saved.incomplete || saved.calls.length > MAX_CALLS;
    }
    const records = result?.details?.calls;
    if (!Array.isArray(records)) return snapshot;
    snapshot.incomplete ||= records.length > MAX_CALLS;
    const known = new Set(snapshot.calls.map(call => call.id));
    for (const [index, record] of records.slice(0, MAX_CALLS).entries()) {
      const id = brief(record?.id || `record-${index}`, 512);
      if (known.has(id)) continue;
      if (snapshot.calls.length >= MAX_CALLS) {
        snapshot.incomplete = true;
        break;
      }
      const parsed = nativeCall(record, index);
      snapshot.incomplete ||= parsed.incomplete;
      snapshot.calls.push(parsed.call);
      known.add(id);
    }
    return snapshot;
  }

  private callSummary(call: Call): string {
    switch (call.status) {
      case "running":
        return `running · ${formatElapsed(call.duration ?? 0)}`;
      case "incomplete":
      case "cancelled":
        return call.status;
      default:
        if (call.summary) return call.summary;
        if (call.duration === undefined) return call.status;
        return `${call.status} · ${formatElapsed(call.duration)}`;
    }
  }

  private lines(id: string, args: any, result: any, options: any, theme: GroveTheme, icons: boolean, iconMode: IconMode, width: number): string[] {
    const partial = options.isPartial === true;
    const snapshot = partial ? this.snapshot(id) : this.recorded(result);
    const calls = snapshot.calls;
    const count = (status: Status) => calls.filter(call => call.status === status).length;
    let duration: number | undefined;
    if (partial) {
      const call = this.calls.get(id);
      duration = call ? elapsed(call) : 0;
    } else {
      duration = options.durationMs;
    }
    const running = count("running");
    const errors = count("error");
    const cancelled = count("cancelled");
    const incomplete = count("incomplete");
    const total = metric(theme, calls.length, calls.length === 1 ? "call" : "calls");
    const active = running ? [themeText(theme, "syntaxVariable", `${running} running`)] : [];
    const issues: string[] = [];
    // One glyph and a number in place of each outcome word, keeping its colour.
    const mark = (word: string) => (icons ? markFor(word, iconMode) : undefined);
    const issue = (word: string, role: "error" | "warning", count?: number) => {
      const glyph = mark(word);
      if (count === undefined) return themeText(theme, role, glyph === undefined ? "script failed" : glyph);
      return themeText(theme, role, glyph === undefined ? count + " " + word : glyph + " " + count);
    };
    if (options.isError) issues.push(issue("failed", "error"));
    if (errors) issues.push(issue("error", "error", errors));
    if (cancelled) issues.push(issue("cancelled", "warning", cancelled));
    if (incomplete) issues.push(issue("incomplete", "warning", incomplete));
    const time = duration === undefined ? [] : [themeText(theme, "syntaxVariable", formatElapsed(duration))];
    const dot = themeText(theme, "dim", " · ");
    const separator = ` ${dot} `;
    const label = `${partial ? themeText(theme, "dim", "· ") : ""}${toolLabel("codemode", theme, icons, iconMode)}`;
    const summary = [total, ...active, ...issues, ...time].join(dot);
    // Only reorder when the stats themselves need truncating, not the goal.
    const tight = visibleWidth(label + separator + summary) > width;
    const lines = [summaryLine(label, themeText(theme, "text", goal(args)), separator,
      tight && issues.length ? [...issues, ...active, total, ...time].join(dot) : summary, width)];
    const shown = options.expanded ? calls : calls.slice(0, COLLAPSED_CALLS);
    // Apply the call-count preview cap before grouping, never pull later calls
    // forward at the expense of an earlier failure or a different tool.
    for (const { call, heading, depth } of groupedCalls(shown)) {
      const indent = "  ".repeat(depth);
      const cost = call.model && call.cost !== undefined ? ` · ${costText(call.cost)}` : "";
      const summary = paintSummary(call.name, this.callSummary(call) + cost, call.status, theme, icons, iconMode);
      if (heading) {
        lines.push(truncateToWidth(`${indent}${toolLabel(call.name, theme, icons, iconMode)} ${themeText(theme, "text", call.reasoning || call.target || "arguments unavailable")}`, width, "…"));
      }
      lines.push(summaryLine(`${indent}  `, themeText(theme, "muted", call.target || "—"), ` ${themeText(theme, "dim", "→")} `, summary, width));
      if (options.expanded && call.status !== "running") {
        if (call.preview === undefined && !call.model) lines.push(`${indent}    ${themeText(theme, "muted", "Output not recorded")}`);
        else if (call.preview) {
          const preview = call.diff ? colorizeDiff(call.preview, theme) : call.preview.split("\n").map(line => themeText(theme, "toolOutput", line));
          lines.push(...preview.map(line => `${indent}    ${line}`));
        }
        if (call.previewTruncated) lines.push(`${indent}    ${themeText(theme, "muted", "Output preview truncated")}`);
        if (call.fullOutputPath) lines.push(`${indent}    ${themeText(theme, "muted", `Full output: ${call.fullOutputPath}`)}`);
      }
    }
    if (shown.length < calls.length) lines.push(themeText(theme, "muted", `  … ${calls.length - shown.length} more calls · Ctrl+O to expand`));
    if (snapshot.incomplete) lines.push(themeText(theme, "warning", "  Incomplete record; calls or arguments omitted"));
    if (options.expanded) {
      const appendSection = (label: string, value: string) => {
        if (!value) return;
        const text = clean(value);
        const preview = text.slice(0, 8192).split("\n").slice(0, 80);
        lines.push(themeText(theme, "muted", `  ${label}`), ...preview.map(line => `    ${themeText(theme, "toolOutput", line)}`));
        if (preview.join("\n").length < text.length) lines.push(themeText(theme, "muted", "    … preview truncated"));
      };
      appendSection("Script", typeof args?.code === "string" ? args.code : "");
      const content = result?.content ?? [];
      const scriptHeader = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;
      const output = content
        .filter((part: any) => part.type === "text" && !scriptHeader.test(part.text))
        .map((part: any) => part.text)
        .join("\n");
      appendSection("Script output", output);
      if (result?.details?.fullOutputPath) lines.push(themeText(theme, "muted", `  Full output: ${brief(result.details.fullOutputPath, 4096)}`));
    }
    return lines;
  }

  renderers(icons: boolean, iconMode: IconMode = "auto"): ToolRenderers {
    return {
      renderShell: "self",
      renderCall: (args, theme, context) => {
        if (!context.isPartial) return new Container();
        return WidthAwareLines.reuse(context.lastComponent,
          width => this.lines(context.toolCallId, args, {}, { isPartial: true, expanded: context.expanded }, theme, icons, iconMode, width),
          text => theme.bg("toolPendingBg", text),
          false,
          context.outputPad,
        );
      },
      renderResult: (result, options, theme, context) => {
        if (options.isPartial) return new Container();
        const isError = context.isError;
        return WidthAwareLines.reuse(context.lastComponent,
          width => this.lines(context.toolCallId, context.args, result, { ...options, isError, durationMs: context.durationMs }, theme, icons, iconMode, width),
          text => theme.bg(isError ? "toolErrorBg" : "toolSuccessBg", text),
          true,
          context.outputPad,
        );
      },
    };
  }
}
