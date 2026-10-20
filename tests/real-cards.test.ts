// Regression test: the turn-group predicates and patch against the real host components.
import assert from "node:assert/strict";
import { Container, Spacer, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ToolExecutionComponent, AssistantMessageComponent, initTheme, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { installTurnGrouping, isTurnGroupingInstalled } from "../turn-grouping.ts";
import { TurnGroupComponent, isToolCard, isAssistantCard, isThinkingOnlyCard } from "../turn-group.ts";

initTheme("dark");

/** Build a real host tool card for the given call. */
const toolCard = (id: string, file: string) =>
  new (ToolExecutionComponent as any)("read", id, { path: file, reasoning: "read " + file }, { showImages: false, outputPad: 1 }, undefined, { requestRender: () => {} }, process.cwd());

/** Build a real host assistant card from content parts. */
const assistantCard = (content: unknown[]) =>
  new (AssistantMessageComponent as any)({ role: "assistant", content }, false, getMarkdownTheme(), "Thinking...", 1);

const click = (y: number): TuiMouseEvent => ({ type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width: 120, height: 4, shift: false, alt: false, ctrl: false });

const first = toolCard("t1", "a.ts");
const reasoning = assistantCard([{ type: "thinking", thinking: "first, plan" }]);
const answer = assistantCard([{ type: "thinking", thinking: "done" }, { type: "text", text: "here you go" }]);

assert.equal(isToolCard(first), true, "a real tool card is recognised");
assert.equal(isAssistantCard(reasoning), true, "a real assistant card is recognised");
assert.equal(isThinkingOnlyCard(reasoning), true, "a pure reasoning card is absorbable");
assert.equal(isThinkingOnlyCard(answer), false, "a card with an answer is never absorbed");

const root = new Container();
installTurnGrouping({ window: 5 });
assert.equal(isTurnGroupingInstalled(), true, "the container patch is installed");

root.addChild(reasoning);
root.addChild(new Spacer(1));
root.addChild(first);
root.addChild(toolCard("t2", "b.ts"));

const kids = (root as any).children as any[];
assert.deepEqual(kids.map((child) => child.constructor.name), ["TurnGroupComponent"], "the turn folds into one card");
const group = kids[0] as TurnGroupComponent;
assert.equal(group.callCount, 2, "both tool calls joined the group");
assert.match(group.render(120)[1], /Thought/, "reasoning shows in the header");
assert.match(group.render(120)[1], /2 calls/, "calls are counted in the header");

group.settle();
const settled = group.render(120);
assert.equal(settled.length, 2, "a settled turn folds to one line");
assert.match(settled[1], /ctrl\+o or click/, "the settled header carries the expand hint");
assert.doesNotMatch(settled[1], /earlier/, "a settled header never claims hidden calls");

const narrow = group.render(40)[1];
assert.ok(visibleWidth(narrow) <= 40, "the settled header fits a narrow terminal");
assert.match(narrow, /ctrl\+o/, "the narrow header keeps a complete hint");
assert.doesNotMatch(narrow, /…/, "the hint is shortened, not truncated");

group.render(120);
assert.equal(group.handleMouse(click(1))?.render, true, "a header click is handled");
assert.ok(group.render(120).length > 2, "a header click reveals the rows");

console.log("real-cards: ok");
