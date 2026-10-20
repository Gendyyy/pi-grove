/**
 * turn-group.ts — one collapsible transcript card that stacks the tool calls of
 * a single assistant turn, plus the thinking blocks that sit between them.
 *
 * The group owns turn-level chrome only: a header line with the turn's facts,
 * the newest call rows while the turn runs, and a fold back to the header once
 * the turn settles. Ctrl+O still reaches each card (full detail); a click on the
 * header reveals every row with the cards left compact.
 */

import {
  Container,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { formatElapsed } from "./block-render.js";
import { liveTheme, themeText } from "./theme.js";

/** How many call rows a running turn keeps visible before it is revealed. */
export const DEFAULT_TURN_WINDOW = 5;

/** The part of a host transcript component that the group reads or drives. */
export interface GroupChild extends Component {
  /** True while the host card is still streaming or executing. */
  isPartial?: boolean;
  /** Host tool result; only the error flag matters to the header. */
  result?: { isError?: boolean };
  /** Host expansion hook (Ctrl+O and card clicks both land here). */
  setExpanded?(expanded: boolean): void;
  /** Last message handed to an assistant component, used to classify it. */
  lastMessage?: { role?: string; content?: unknown };
  /** Host surface used to repaint a detached-from-render child. */
  ui?: { requestRender?(force?: boolean): void };
}

interface TurnGroupEntry {
  kind: "call" | "thinking";
  component: GroupChild;
  thinkingMs?: number;
}

interface RowLayout {
  component: GroupChild;
  top: number;
  height: number;
  skip: number;
  fullHeight: number;
}

interface GroupLayout {
  width: number;
  headerRow: number;
  rows: RowLayout[];
}

/** What the host container layer expects back from a mouse handler. */
type MouseDispatchResult = ReturnType<Container["handleMouse"]>;

export interface TurnGroupOptions {
  /** Call rows kept visible while the turn runs. */
  window?: number;
  /** Turn start used for the live header timer; defaults to now. */
  startedAt?: number;
}

/** Read the content parts of an assistant component without trusting its type. */
function contentParts(component: GroupChild): unknown[] {
  const content = component.lastMessage?.content;
  return Array.isArray(content) ? content : [];
}

/** True when a content part is assistant text with something to read. */
function isTextPart(part: unknown): boolean {
  const value = part as { type?: unknown; text?: unknown };
  return value?.type === "text" && typeof value.text === "string" && value.text.trim() !== "";
}

/** True when a content part is a tool call the host renders as a card. */
function isToolCallPart(part: unknown): boolean {
  return (part as { type?: unknown })?.type === "toolCall";
}

/** True when a content part carries reasoning text. */
function isThinkingPart(part: unknown): boolean {
  const value = part as { type?: unknown; thinking?: unknown };
  return value?.type === "thinking" && typeof value.thinking === "string" && value.thinking.trim() !== "";
}

/** The host method names that identify an assistant transcript component. */
const ASSISTANT_METHODS = ["setExpanded", "updateContent", "setHideThinkingBlock"] as const;

/** True for the host assistant transcript component, matched structurally. */
export function isAssistantCard(component: Component): component is GroupChild {
  const child = component as unknown as Record<string, unknown>;
  const named = (component as { constructor?: { name?: string } }).constructor?.name === "AssistantMessageComponent";
  const structural = ASSISTANT_METHODS.every((method) => typeof child[method] === "function") && child.lastMessage !== undefined;
  return named || structural;
}

/** True when a card holds only reasoning: no answer text and no tool calls. */
export function isThinkingOnlyCard(component: Component): component is GroupChild {
  if (!isAssistantCard(component)) return false;
  const parts = contentParts(component);
  if (parts.length === 0) return false;
  return !parts.some(isTextPart) && !parts.some(isToolCallPart) && parts.some(isThinkingPart);
}

/** True when a card has already grown visible text and must leave the group. */
export function hasVisibleText(component: Component): boolean {
  return isAssistantCard(component) && contentParts(component).some(isTextPart);
}

/** True for the host tool card that the group collects. */
export function isToolCard(component: Component): component is GroupChild {
  const child = component as unknown as Record<string, unknown>;
  return (
    typeof child.toolName === "string" &&
    typeof child.toolCallId === "string" &&
    typeof child.setExpanded === "function" &&
    typeof child.updateResult === "function"
  );
}

/** The turn-level card. Children stay real host components; the group only stacks them. */
export class TurnGroupComponent extends Container {
  private entries: TurnGroupEntry[] = [];
  private readonly windowSize: number;
  private readonly openedAt: number;
  private expanded = false;
  private revealed = false;
  private finished = false;
  private finishedAt = 0;
  private layout: GroupLayout | undefined;

  constructor(options: TurnGroupOptions = {}) {
    super();
    this.windowSize = Math.max(1, Math.trunc(options.window ?? DEFAULT_TURN_WINDOW));
    this.openedAt = options.startedAt ?? Date.now();
  }

  /** Append a tool card to the turn. */
  addCall(component: GroupChild): void {
    this.entries.push({ kind: "call", component });
  }

  /** Append a reasoning block with the duration it took. */
  absorbThinking(component: GroupChild, thinkingMs = 0): void {
    this.entries.push({ kind: "thinking", component, thinkingMs });
  }

  /** Detach reasoning blocks that turned into real messages for the caller to re-home. */
  drainVisibleText(): GroupChild[] {
    const released: GroupChild[] = [];
    this.entries = this.entries.filter((entry) => {
      if (entry.kind !== "thinking" || !hasVisibleText(entry.component)) return true;
      released.push(entry.component);
      return false;
    });
    return released;
  }

  /** Forward the host-wide Ctrl+O expansion to every card in the turn. */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    for (const entry of this.entries) entry.component.setExpanded?.(expanded);
  }

  /** Show or hide every row while keeping the cards themselves compact. */
  toggleReveal(): void {
    this.revealed = !this.revealed;
    this.requestRepaint();
  }

  /** Fold the turn to its header once execution stopped. */
  settle(): void {
    if (this.finished) return;
    this.finished = true;
    this.finishedAt = Date.now();
    this.requestRepaint();
  }

  /** Number of tool calls collected in this turn. */
  get callCount(): number {
    return this.entries.filter((entry) => entry.kind === "call").length;
  }

  /** Number of calls whose host result reported an error. */
  get errorCount(): number {
    return this.entries.filter((entry) => entry.kind === "call" && entry.component.result?.isError === true).length;
  }

  /** True once the turn settled and the group folds to its header. */
  get settled(): boolean {
    return this.finished;
  }

  /** Rows currently rendered: all when open, the newest window while running. */
  private visibleEntries(): TurnGroupEntry[] {
    if (this.expanded || this.revealed) return this.entries;
    if (this.finished) return [];
    return this.entries.slice(-this.windowSize);
  }

  /** True when the group shows every row. */
  private open(): boolean {
    return this.expanded || this.revealed;
  }

  /** Number of reasoning blocks folded into the header. */
  private thinkingCount(): number {
    return this.entries.filter((entry) => entry.kind === "thinking").length;
  }

  /** Reasoning duration folded into the header. */
  private thinkingTotal(): number {
    return this.entries.reduce((total, entry) => total + (entry.kind === "thinking" ? entry.thinkingMs ?? 0 : 0), 0);
  }

  /** Repaint the transcript through the first child that can reach the host TUI. */
  private requestRepaint(): void {
    for (const entry of this.entries) {
      if (entry.component.ui?.requestRender) {
        entry.component.ui.requestRender();
        return;
      }
    }
  }

  /** Forward invalidation to the absorbed cards: they are not in `children`. */
  override invalidate(): void {
    for (const entry of this.entries) entry.component.invalidate?.();
  }

  /** Render the header plus the rows the current state allows. */
  override render(width: number): string[] {
    const lines = [""];
    const headerRow = lines.length;
    lines.push(this.header(width));
    const rows: RowLayout[] = [];
    for (const entry of this.visibleEntries()) {
      const childLines = entry.component.render(width);
      // Host tool cards emit one leading blank line; the group supplies spacing.
      const skip = entry.kind === "call" && (childLines[0] ?? "").trim() === "" ? 1 : 0;
      const visible = childLines.slice(skip);
      rows.push({
        component: entry.component,
        top: lines.length,
        height: visible.length,
        skip,
        fullHeight: childLines.length,
      });
      lines.push(...visible);
    }
    this.layout = { width, headerRow, rows };
    return lines;
  }

  /** Route clicks to the cards, and header clicks to the group itself. */
  override handleMouse(event: TuiMouseEvent): MouseDispatchResult {
    const layout = this.layout?.width === event.width ? this.layout : undefined;
    if (!layout) return undefined;
    const row = layout.rows.find((candidate) => event.y >= candidate.top && event.y < candidate.top + candidate.height);
    if (row) {
      const forwarded = row.component.handleMouse?.({
        ...event,
        y: event.y - row.top + row.skip,
        height: row.fullHeight,
      });
      if (forwarded) return this.forwardedEvent(event, row, forwarded);
    }
    if (event.type === "click" && event.button === "left" && event.y === layout.headerRow) {
      this.toggleReveal();
      return this.handledEvent(event);
    }
    return undefined;
  }

  /** Re-anchor a child result at the child's absolute position in the transcript. */
  private forwardedEvent(event: TuiMouseEvent, row: RowLayout, result: TuiMouseEventResult): MouseDispatchResult {
    return {
      ...result,
      handled: true,
      target: {
        component: row.component,
        originX: event.screenX - event.x,
        originY: event.screenY - event.y + row.top,
        width: event.width,
        height: row.fullHeight,
      },
    } as MouseDispatchResult;
  }

  /** Build the dispatch result the host expects from a group-owned click. */
  private handledEvent(event: TuiMouseEvent): MouseDispatchResult {
    return {
      handled: true,
      render: true,
      target: {
        component: this,
        originX: event.screenX - event.x,
        originY: event.screenY - event.y,
        width: event.width,
        height: event.height,
      },
    } as MouseDispatchResult;
  }

  /** Compose the one-line turn header: reasoning, calls, errors, time, hint. */
  private header(width: number): string {
    const theme = liveTheme();
    const separator = themeText(theme, "dim", " · ");
    const parts: string[] = [];
    if (this.thinkingCount() > 0)
      parts.push(`${themeText(theme, "muted", "Thought")} ${themeText(theme, "accent", formatElapsed(this.thinkingTotal()))}`);
    const calls = this.callCount;
    parts.push(`${themeText(theme, "accent", String(calls))} ${themeText(theme, "muted", calls === 1 ? "call" : "calls")}`);
    const errors = this.errorCount;
    if (errors > 0)
      parts.push(`${themeText(theme, "error", String(errors))} ${themeText(theme, "muted", errors === 1 ? "error" : "errors")}`);
    if (!this.finished) {
      const visible = new Set(this.visibleEntries());
      const hidden = this.entries.filter((entry) => entry.kind === "call" && !visible.has(entry)).length;
      if (hidden > 0) parts.push(themeText(theme, "dim", `${hidden} earlier`));
    }
    const elapsed = this.finished ? this.finishedAt - this.openedAt : Date.now() - this.openedAt;
    parts.push(themeText(theme, this.finished ? "dim" : "syntaxVariable", formatElapsed(elapsed)));
    const marker = themeText(theme, "dim", this.open() ? "▾" : "▸");
    const base = `${marker} ${parts.join(separator)}`;
    if (this.finished && !this.open()) {
      // Prefer the full hint, then a shorter one, so narrow terminals stay readable.
      for (const hint of ["ctrl+o or click", "ctrl+o"]) {
        const line = base + separator + themeText(theme, "dim", hint);
        if (visibleWidth(line) <= width) return line;
      }
    }
    return truncateToWidth(base, width);
  }
}
