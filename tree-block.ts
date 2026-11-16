/**
 * tree-block.ts — the one pi component that paints a group card: it caches the
 * painted lines and maps a click back to the node it hit.
 */
import { Container, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { fitToolLine, WidthAwareLines } from "./block-render.js";
import type { GroveTheme } from "./theme.js";
import type { PaintPhase, TreeGroup } from "./tree-model.js";
import type { ToolTree } from "./tool-tree.js";

/** One tool row handed to the tree: its live component and the host paint context. */

export interface TreeRow {
  toolCallId: string;
  inner: Component;
  theme?: GroveTheme;
  expanded: boolean;
  invalidate: () => void;
  /** Which pi row this render call belongs to; defaults to the finished result row. */
  phase?: PaintPhase;
  background?: (text: string) => string;
  outputPad?: number;
}

/** Renders and owns the click target of the single line that paints a group card. */
export class TreeBlock implements Component {
  private painterWidth?: number;
  private painter?: WidthAwareLines;

  constructor(
    private readonly tree: ToolTree,
    private readonly group: TreeGroup,
    private readonly theme: GroveTheme,
    private readonly row: TreeRow,
  ) {}

  /** Paint the group, applying the host row background and inset padding. */
  render(width: number): string[] {
    if (!this.painter || this.painterWidth !== width) {
      // cacheSource: pi re-invokes render() on every frame for every mounted row, and any real
      // change rebuilds this component, so a painted card never goes stale.
      this.painter = new WidthAwareLines(
        innerWidth => this.tree.paint(this.group, innerWidth, this.theme, this.row.expanded),
        this.row.background,
        true,
        this.row.outputPad ?? 1,
      );
      this.painterWidth = width;
    }
    return this.painter.render(width);
  }

  invalidate(): void {
    this.painter?.invalidate();
  }

  /** Toggle the clicked level; rows outside the painter fall through to pi's own expand. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    // A double click is still one gesture: toggling on its second click would undo the level
    // the first click revealed, which reads as a row that refuses to open.
    if ((event.clickCount ?? 1) > 1) return { handled: true };
    // Repaint from the click's own width so the hit map always matches these lines, at the
    // same width render() paints at.
    this.tree.paint(
      this.group,
      WidthAwareLines.rowWidth(event.width, this.row.outputPad ?? 1).contentWidth,
      this.theme,
      this.row.expanded,
    );
    const target = this.tree.targetAt(event.y);
    if (target === undefined) return undefined;
    this.tree.toggle(this.group, target);
    return { handled: true };
  }
}

