/**
 * turn-grouping.ts — teach the chat transcript to stack one assistant turn's
 * tool cards into a single TurnGroupComponent.
 *
 * Host hook: Container.prototype.addChild. A tool card that lands directly
 * after another tool card (or after an existing group, allowing thinking blocks
 * in between) is moved into a group instead of sitting alone in the transcript.
 * The patch is installed once and re-pointed on reload, so the newest extension
 * code always drives old transcripts.
 */

import { Container, Spacer, type Component } from "@earendil-works/pi-tui";
import {
  TurnGroupComponent,
  hasVisibleText,
  isAssistantCard,
  isThinkingOnlyCard,
  isToolCard,
  type GroupChild,
} from "./turn-group.js";

/** Symbol key that marks our patch (and keeps it unique across reloads). */
const PATCH_KEY = Symbol.for("liuovo.turnGrouping");

/** Turn start clock per assistant component, used for the "Thought Xs" header. */
const THINKING_START = new WeakMap<object, number>();

/** Live groups, settled when the turn ends. */
const LIVE_GROUPS = new Set<TurnGroupComponent>();

interface PatchState {
  window: number;
  originalAddChild: typeof Container.prototype.addChild;
  onAdd: (parent: Container, child: Component, window: number) => void;
}

export interface TurnGroupingOptions {
  /** Call rows a running turn keeps visible. */
  window?: number;
}

/** Resolve the visible-call window for a running turn. */
function windowFrom(value: number | undefined): number {
  const requested = Math.trunc(value ?? 5);
  return requested >= 1 ? requested : 5;
}

/** Read the recorded start of an assistant card's reasoning. */
function thinkingStart(component: Component): number | undefined {
  return THINKING_START.get(component as object);
}

/** Milliseconds an absorbed reasoning block took to arrive. */
function thinkingDuration(component: GroupChild): number {
  const started = thinkingStart(component);
  return started === undefined ? 0 : Math.max(0, Date.now() - started);
}

/** Drop a component from a child list by identity. */
function detach(children: Component[], component: Component): void {
  const index = children.lastIndexOf(component);
  if (index !== -1) children.splice(index, 1);
}

/** Walk back from a new tool card to the component that can own it. */
function readAnchor(
  children: Component[],
  index: number
): { child: Component; index: number; thinking: GroupChild[]; spacers: Spacer[] } | undefined {
  const thinking: GroupChild[] = [];
  const spacers: Spacer[] = [];
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const child = children[cursor];
    if (child instanceof Spacer) {
      spacers.push(child);
      continue;
    }
    if (isThinkingOnlyCard(child)) {
      thinking.unshift(child);
      continue;
    }
    return { child, index: cursor, thinking, spacers };
  }
  return undefined;
}

/** Walk back from an anchor to collect the reasoning that opened the turn. */
function readLeading(
  children: Component[],
  index: number
): { thinking: GroupChild[]; spacers: Spacer[] } {
  const thinking: GroupChild[] = [];
  const spacers: Spacer[] = [];
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const child = children[cursor];
    if (child instanceof Spacer) {
      spacers.push(child);
      continue;
    }
    if (isThinkingOnlyCard(child)) {
      thinking.unshift(child);
      continue;
    }
    break;
  }
  return { thinking, spacers };
}

/** Move reasoning blocks (and their spacing) into a group. */
function absorb(children: Component[], group: TurnGroupComponent, thinking: GroupChild[], spacers: Spacer[]): void {
  for (const spacer of spacers) detach(children, spacer);
  for (const component of thinking) {
    detach(children, component);
    group.absorbThinking(component, thinkingDuration(component));
  }
}

/** Re-home reasoning blocks that grew real text, so answers stay outside the group. */
function releaseVisibleText(children: Component[]): void {
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (!(child instanceof TurnGroupComponent)) continue;
    const released = child.drainVisibleText();
    if (released.length === 0) continue;
    children.splice(index + 1, 0, ...released);
    index += released.length;
  }
}

/** Group a freshly added child when the transcript shape allows it. */
function attachGroup(parent: Container, added: Component, window: number): void {
  const children = parent.children;
  if (!Array.isArray(children)) return;
  if (isAssistantCard(added) && !THINKING_START.has(added as object)) THINKING_START.set(added as object, Date.now());
  releaseVisibleText(children);
  if (!isToolCard(added)) return;

  const index = children.lastIndexOf(added);
  if (index === -1) return;
  const anchor = readAnchor(children, index);
  if (!anchor) return;

  if (anchor.child instanceof TurnGroupComponent) {
    detach(children, added);
    absorb(children, anchor.child, anchor.thinking, anchor.spacers);
    anchor.child.addCall(added);
    return;
  }
  if (!isToolCard(anchor.child)) return;

  const leading = readLeading(children, anchor.index);
  const group = new TurnGroupComponent({
    window,
    startedAt: thinkingStart(leading.thinking[0] ?? anchor.child) ?? Date.now(),
  });
  children[anchor.index] = group;
  detach(children, added);
  absorb(children, group, leading.thinking, leading.spacers);
  group.addCall(anchor.child);
  absorb(children, group, anchor.thinking, anchor.spacers);
  group.addCall(added);
  LIVE_GROUPS.add(group);
}

/** Fold every open turn: the transcript is quiet again. */
export function settleTurnGroups(): void {
  for (const group of LIVE_GROUPS) group.settle();
  LIVE_GROUPS.clear();
}

/** Install the transcript patch; returns a cleanup that only the owner may run. */
export function installTurnGrouping(options: TurnGroupingOptions = {}): () => void {
  const prototype = Container.prototype as unknown as Record<symbol, PatchState | undefined>;
  const window = windowFrom(options.window);
  const existing = prototype[PATCH_KEY];
  if (existing) {
    // A reload re-points the patch at the newest module instance.
    existing.window = window;
    existing.onAdd = attachGroup;
    return () => {};
  }

  const state: PatchState = {
    window,
    originalAddChild: Container.prototype.addChild,
    onAdd: attachGroup,
  };
  prototype[PATCH_KEY] = state;
  Container.prototype.addChild = function addChildWithTurnGroups(this: Container, child: Component): void {
    state.originalAddChild.call(this, child);
    try {
      state.onAdd(this, child, state.window);
    } catch {
      // Grouping is cosmetic; a broken transcript shape must never block a message.
    }
  };

  return () => {
    if (prototype[PATCH_KEY] !== state) return;
    Container.prototype.addChild = state.originalAddChild;
    delete prototype[PATCH_KEY];
    LIVE_GROUPS.clear();
  };
}

/** Test hook: true when the transcript patch is active. */
export function isTurnGroupingInstalled(): boolean {
  return (Container.prototype as unknown as Record<symbol, unknown>)[PATCH_KEY] !== undefined;
}

/** Re-exported for tests that assert classification behaviour. */
export { hasVisibleText, isThinkingOnlyCard, isToolCard };
