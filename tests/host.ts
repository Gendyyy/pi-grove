/**
 * tests/host.ts — a fake pi host: it mounts the two rows pi mounts per tool call, renders
 * them in pi's order, and routes clicks back to the card, so bugs that only appear once
 * pi's own layout is involved can be reproduced without a terminal.
 */
import { Container, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ToolTree, type TreeSettings } from "../tool-tree.js";
import { readTranscript } from "../replay.js";
import { plainTheme } from "../theme.js";

/** One rendered row of the fake transcript. */
export interface RowFrame {
  id: string;
  phase: "call" | "result";
  startsAt: number;
  lines: string[];
  component: Component;
}

/** One frame of the fake transcript, exactly as pi would lay it out. */
export interface Frame {
  lines: string[];
  rows: RowFrame[];
}

/** One tool call the host has been told about. */
interface FakeCall {
  id: string;
  name: string;
  ended: boolean;
  expanded: boolean;
}

/** A left click with coordinates local to one row. */
function clickEvent(y: number): TuiMouseEvent {
  return { type: "click", button: "left", x: 0, y, screenX: 0, screenY: 0, width: 96, height: 40 } as unknown as TuiMouseEvent;
}

/** A successful tool result in pi's shape. */
export function okay(text = "ok"): unknown {
  return { content: [{ type: "text", text }], isError: false };
}

/**
 * A stand-in for pi's interactive host: it owns the row list, renders every row once per
 * frame in pi's order (live call row first, then the finished result row), and forwards
 * clicks. The tree under test is a real ToolTree.
 */
export class FakeHost {
  readonly tree: ToolTree;
  readonly width: number;
  private readonly calls = new Map<string, FakeCall>();
  private readonly order: string[] = [];
  private rendering?: Frame;
  private repaints = 0;

  constructor(options: { width?: number; settings?: Partial<TreeSettings> } = {}) {
    this.width = options.width ?? 96;
    const settings: TreeSettings = {
      mode: "prompt",
      revealErrors: true,
      icons: false,
      iconMode: "ascii",
      window: 4,
      groupNestedTools: true,
      groupProgress: true,
      groupSparkline: true,
      groupGutter: true,
      ...options.settings,
    };
    this.tree = new ToolTree(settings, () => {
      this.repaints += 1;
    });
  }

  /** Record a tool call the way pi announces it. */
  start(id: string, name: string, args: unknown, parentId?: string): void {
    if (!this.calls.has(id)) this.order.push(id);
    this.calls.set(id, { id, name, ended: false, expanded: false });
    this.tree.start({ toolCallId: id, toolName: name, args, parentToolCallId: parentId });
  }

  /** Record a finished call the way pi reports it. */
  end(id: string, result: unknown = okay(), options: { isError?: boolean; durationMs?: number } = {}): void {
    const call = this.calls.get(id);
    if (!call) throw new Error("unknown call: " + id);
    call.ended = true;
    this.tree.end(
      {
        toolCallId: id,
        toolName: call.name,
        result,
        isError: options.isError ?? false,
        durationMs: options.durationMs ?? 10,
      },
      {},
    );
  }

  /** Record one reasoning run, which the card shows as its own row. */
  note(id: string, text: string, options: { final?: boolean } = {}): void {
    this.tree.note(id, text, options);
  }

  /**
   * Rebuild the session from transcript entries, the way a reload does: pi re-creates one
   * component per stored call and then asks the tree where it belongs.
   */
  reload(entries: unknown[], mode: "prompt" | "turn" | "message" = "prompt"): void {
    this.tree.clear();
    this.tree.restore(readTranscript(entries, mode));
    this.calls.clear();
    this.order.length = 0;
    for (const raw of entries) {
      const message = (raw as { message?: { role?: string; content?: unknown; toolCallId?: string } }).message;
      if (!message) continue;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content as Array<{ type?: string; id?: string; name?: string }>) {
          if (part.type !== "toolCall" || !part.id) continue;
          this.calls.set(part.id, { id: part.id, name: part.name ?? "tool", ended: false, expanded: false });
          this.order.push(part.id);
        }
      }
      if (message.role === "toolResult" && message.toolCallId) {
        const call = this.calls.get(message.toolCallId);
        if (call) call.ended = true;
      }
    }
  }

  /** Render every row once, in pi's order, and return the laid-out frame. */
  frame(): Frame {
    const lines: string[] = [];
    const rows: RowFrame[] = [];
    const render = (id: string, phase: "call" | "result"): void => {
      const call = this.calls.get(id);
      if (!call) return;
      const component = this.tree.render({
        toolCallId: id,
        inner: new Container(),
        theme: plainTheme,
        phase,
        expanded: call.expanded,
        invalidate: () => {
          this.repaints += 1;
        },
        outputPad: 1,
      });
      const painted = component.render(this.width).map(line => line.trim());
      rows.push({ id, phase, startsAt: lines.length, lines: painted, component });
      lines.push(...painted);
    };
    for (const id of this.order) {
      const call = this.calls.get(id);
      if (!call) continue;
      // pi mounts the live row first and the result row second, in one container.
      render(id, "call");
      if (call.ended) render(id, "result");
    }
    this.rendering = { lines, rows };
    return this.rendering;
  }

  /** Ids of the calls whose row painted something in the last frame. */
  painters(): string[] {
    const frame = this.rendering ?? this.frame();
    return frame.rows.filter(row => row.lines.length > 0).map(row => row.id);
  }

  /** How many times the host was asked to repaint, so out-of-band blanking is visible. */
  repaintCount(): number {
    return this.repaints;
  }

  /** Click a line of the last frame; the row under it receives the click. */
  click(line: number): boolean {
    const frame = this.rendering ?? this.frame();
    const row = frame.rows.find(entry => line >= entry.startsAt && line < entry.startsAt + entry.lines.length);
    if (!row) return false;
    const handler = (row.component as { handleMouse?: (event: TuiMouseEvent) => unknown }).handleMouse;
    if (typeof handler !== "function") return false;
    handler.call(row.component, clickEvent(line - row.startsAt));
    return true;
  }

  /** Expand every row of a call the way pi's own toggle would. */
  expand(id: string): void {
    const call = this.calls.get(id);
    if (call) call.expanded = true;
  }
}
