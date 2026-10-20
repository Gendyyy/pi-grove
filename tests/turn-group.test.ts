// Tests turn grouping: which cards join a turn, the running window, the settled fold, and reveal/expand behaviour.
import assert from "node:assert/strict";
import { Container, Spacer, type Component } from "@earendil-works/pi-tui";
import { installTurnGrouping, settleTurnGroups } from "../turn-grouping.ts";
import { TurnGroupComponent } from "../turn-group.ts";

const WIDTH = 80;

/** Fake tool card carrying the host fields the grouping layer reads. */
interface FakeTool extends Component {
  toolName: string;
  toolCallId: string;
  result?: { isError?: boolean };
  expansion: boolean[];
  handled: boolean;
  setExpanded(expanded: boolean): void;
  updateResult(): void;
  handleMouse(): { handled: boolean };
}

/** Fake assistant message card with the host methods the grouping layer probes. */
interface FakeAssistant extends Component {
  lastMessage: { role: string; content: unknown[] };
  hidden: boolean;
  expansion: boolean[];
  setExpanded(expanded: boolean): void;
  updateContent(): void;
  setHideThinkingBlock(hidden: boolean): void;
}

let paints = 0;

/** Builds a tool card whose render output mimics the host's leading blank line. */
function tool(id: string, options: { error?: boolean; rows?: string[] } = {}): FakeTool {
  const card: FakeTool = {
    toolName: "read",
    toolCallId: id,
    result: options.error ? { isError: true } : undefined,
    expansion: [],
    handled: false,
    ui: { requestRender: () => { paints += 1; } },
    render: () => ["", ...(options.rows ?? [id + " call", "  -> done"])],
    invalidate: () => {},
    setExpanded: (expanded: boolean) => { card.expansion.push(expanded); },
    updateResult: () => {},
    handleMouse: () => ({ handled: true }),
  } as FakeTool;
  return card;
}

/** Builds an assistant card, optionally thinking-only. */
function assistant(parts: unknown[], rows: string[] = ["reasoning text"]): FakeAssistant {
  const card: FakeAssistant = {
    lastMessage: { role: "assistant", content: parts },
    hidden: false,
    expansion: [],
    ui: { requestRender: () => { paints += 1; } },
    render: () => rows,
    invalidate: () => {},
    setExpanded: (expanded: boolean) => { card.expansion.push(expanded); },
    updateContent: () => {},
    setHideThinkingBlock: (hidden: boolean) => { card.hidden = hidden; },
  } as FakeAssistant;
  return card;
}

/** Strips ANSI styling so assertions read plain text. */
function plain(lines: string[]): string[] {
  return lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd());
}

/** Renders the transcript and returns plain lines. */
function view(container: Container): string[] {
  return plain(container.render(WIDTH));
}

/** Left click at a transcript row. */
function click(container: Container, y: number): void {
  container.handleMouse({ type: "click", button: "left", x: 1, y, screenX: 1, screenY: y, width: WIDTH, height: 40, shift: false, alt: false, ctrl: false });
}

/** Only direct children of a container, typed for assertions. */
function kids(container: Container): Component[] {
  return container.children;
}

/** Fresh transcript plus an installed patch. */
function transcript(): { container: Container; reset: () => void } {
  const container = new Container();
  const uninstall = installTurnGrouping({ window: 5 });
  return { container, reset: () => { settleTurnGroups(); uninstall(); } };
}

// Two consecutive tool cards share one group; the running card keeps both rows.
{
  const { container, reset } = transcript();
  const first = tool("a.ts");
  const second = tool("b.ts");
  container.addChild(first);
  container.addChild(second);
  assert.equal(kids(container).length, 1, "two cards collapse into one group");
  const group = kids(container)[0] as TurnGroupComponent;
  assert.ok(group instanceof TurnGroupComponent, "the child is a group");
  const lines = view(container);
  assert.match(lines[1], /▸ 2 calls/, "header counts the calls");
  assert.ok(lines.includes("a.ts call") && lines.includes("b.ts call"), "both rows render while running");
  assert.deepEqual(first.expansion, [], "grouping does not expand the cards");
  reset();
}

// A settled group folds to its header and reveals every row on a header click.
{
  const { container, reset } = transcript();
  const cards = ["a", "b", "c", "d", "e", "f"].map((name) => tool(name));
  for (const card of cards) container.addChild(card);
  const group = kids(container)[0] as TurnGroupComponent;
  const running = view(container);
  assert.equal(running.length, 1 + 1 + 5 * 2, "running shows the newest five rows only");
  assert.match(running[1], /6 calls/, "header keeps the turn total");
  assert.match(running[1], /1 earlier/, "header reports the folded rows");
  settleTurnGroups();
  const settled = view(container);
  assert.deepEqual(settled.filter((line) => line !== ""), [settled[1]], "settled shows the header only");
  assert.match(settled[1], /ctrl\+o or click/, "header advertises both reveal paths");
  click(container, 1);
  assert.equal(view(container).length, 1 + 1 + 6 * 2, "a header click reveals every row");
  click(container, 1);
  assert.equal(view(container).length, 2, "a second header click folds again");
  assert.ok(group.settled, "the group reports settled state");
  reset();
}

// Ctrl+O reaches the individual cards inside the group.
{
  const { container, reset } = transcript();
  const first = tool("a");
  const second = tool("b");
  container.addChild(first);
  container.addChild(second);
  const group = kids(container)[0] as TurnGroupComponent;
  group.setExpanded(true);
  assert.deepEqual(first.expansion, [true], "the first card received the expansion");
  assert.deepEqual(second.expansion, [true], "the second card received the expansion");
  assert.equal(view(container).length, 1 + 1 + 2 * 2, "every row renders when expanded");
  group.setExpanded(false);
  assert.deepEqual(second.expansion, [true, false], "collapsing reaches the cards again");
  reset();
}

// Reasoning that opened the turn is folded into the header, not left above the group.
{
  const { container, reset } = transcript();
  const thinking = assistant([{ type: "thinking", thinking: "plan the change" }], ["plan the change"]);
  container.addChild(thinking);
  container.addChild(tool("a"));
  container.addChild(tool("b"));
  assert.equal(kids(container).length, 1, "the reasoning block joined the turn");
  const lines = view(container);
  assert.match(lines[1], /Thought /, "header reports the reasoning time");
  assert.equal(lines.filter((line) => line === "plan the change").length, 1, "the reasoning row renders once");
  reset();
}

// A final answer with text never joins the group, even when it carries reasoning.
{
  const { container, reset } = transcript();
  container.addChild(tool("a"));
  container.addChild(tool("b"));
  const answer = assistant([{ type: "thinking", thinking: "summarize" }, { type: "text", text: "here is the answer" }], ["here is the answer"]);
  container.addChild(answer);
  assert.equal(kids(container).length, 2, "the answer stays outside the group");
  assert.ok(kids(container)[1] === answer, "the answer keeps its place after the group");
  reset();
}

// An absorbed reasoning block that grows text moves back out of the group.
{
  const { container, reset } = transcript();
  const thinking = assistant([{ type: "thinking", thinking: "plan" }], ["plan"]);
  container.addChild(thinking);
  container.addChild(tool("a"));
  container.addChild(tool("b"));
  thinking.lastMessage = { role: "assistant", content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "late answer" }] };
  container.addChild(new Spacer(1));
  assert.equal(kids(container).length, 3, "the text-bearing card was released after the group");
  assert.ok(kids(container)[1] === thinking, "the released card lands immediately after the group");
  reset();
}

// Errors stay visible in the header after the failing row folded away.
{
  const { container, reset } = transcript();
  container.addChild(tool("a", { error: true }));
  container.addChild(tool("b"));
  const lines = view(container);
  assert.match(lines[1], /1 error/, "header counts the failure");
  reset();
}

console.log("turn-group: ok");
