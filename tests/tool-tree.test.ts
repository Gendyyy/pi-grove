/**
 * tests/tool-tree.test.ts — behaviour of the clickable per-turn tool tree.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { GROUP_TARGET, ToolTree, paintGroup, type TreeGroup, type TreeRow, type TreeSettings } from "../tool-tree.js";
import { plainTheme, type GroveTheme } from "../theme.js";
import { summaryLine } from "../block-render.js";
import { shimmerText } from "../tree-paint.js";
import { composeSourceTool, type SourceToolDefinition } from "../tool-composition.js";

/** Build settings with plain ASCII glyphs so assertions stay readable. */
function settings(overrides: Partial<TreeSettings> = {}): TreeSettings {
  return { mode: "turn", revealErrors: true, icons: false, iconMode: "ascii", window: 4, ...overrides };
}

/** Minimal pi component standing in for a renderer result. */
function inner(): Component {
  return { render: () => ["inner"], invalidate: () => {} };
}

/** One renderer row as pi would hand it to the tree. */
function row(id: string, expanded = false, theme: GroveTheme = plainTheme): TreeRow {
  return { toolCallId: id, inner: inner(), theme, expanded, invalidate: () => {} };
}

const ANSI_THEME: GroveTheme = {
  style: (text, options) => {
    const color = options.fg === "muted" ? "2" : options.fg === "text" ? "1" : options.fg === "accent" ? "35" : "33";
    return "\u001b[" + color + "m" + text + "\u001b[0m";
  },
};

const PROGRESS_THEME: GroveTheme = {
  style: (text, options) => {
    const color = options.fg === "error" ? "31" : options.fg === "warning" ? "33" : options.fg === "success" ? "32" : "2";
    return "\u001b[" + color + "m" + text + "\u001b[0m";
  },
};

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function stylesFor(raw: string, target: string): string[] {
  const visible: string[] = [];
  const styles: string[] = [];
  let active = "";
  for (let index = 0; index < raw.length;) {
    if (raw.startsWith("\u001b[", index)) {
      const end = raw.indexOf("m", index);
      if (end < 0) break;
      active = raw.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const cell = String.fromCodePoint(raw.codePointAt(index)!);
    visible.push(cell);
    styles.push(active);
    index += cell.length;
  }
  const start = visible.join("").indexOf(target);
  return start < 0 ? [] : styles.slice(start, start + [...target].length);
}

/** A left click event with coordinates local to the card. */
function click(y: number): TuiMouseEvent {
  return { type: "click", button: "left", x: 0, y, screenX: 0, screenY: 0, width: 80, height: 40 } as unknown as TuiMouseEvent;
}

/** Let queued repaints run, the way pi would on its next frame. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

/** Raw line index inside the frame, which is the coordinate the mouse reports. */
function at(component: Component, pattern: RegExp, width = 80): number {
  return component
    .render(width)
    .map(line => line.replace(/\u001b\[[0-9;]*m/g, ""))
    .findIndex(line => pattern.test(line));
}

/** Rendered lines with the host padding trimmed. */
function lines(component: Component, width = 80): string[] {
  const painted = component.render(width).map(line => line.replace(/\u001b\[[0-9;]*m/g, "").trim());
  // The card is one bordered object now, so the body is what the assertions index.
  if (painted.length < 2 || !/^[╭+┌][-─]/.test(painted[0]!)) return painted;
  return painted.slice(1, -1).map(line => line.replace(/^[▌│|] ?/, "").replace(/ ?[▌│|]$/, "").trim());
}

test("composed tools require taskIntent and strip Grove metadata before execution", async () => {
  let received: unknown;
  const source = {
    name: "fixture",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    execute: async (_id: string, params: unknown) => {
      received = params;
      return { content: [] };
    },
  } as unknown as SourceToolDefinition;
  const composed = composeSourceTool(source, {
    mode: "reasoning",
    reasoningGuideline: "reasoning",
    taskIntent: true,
    taskIntentGuideline: "stable task title",
    taskProgress: true,
    taskProgressGuideline: "current estimated completion percentage",
  });
  const schema = composed.parameters as unknown as {
    required?: string[];
    properties?: Record<string, { type?: string; maxLength?: number; minimum?: number; maximum?: number }>;
  };
  assert.deepEqual(schema.required, ["taskProgress", "taskIntent", "reasoning", "value"]);
  assert.equal(schema.properties?.taskIntent?.type, "string");
  assert.equal(schema.properties?.taskIntent?.maxLength, 120);
  assert.equal(schema.properties?.taskProgress?.type, "integer");
  assert.equal(schema.properties?.taskProgress?.minimum, 0);
  assert.equal(schema.properties?.taskProgress?.maximum, 100);
  assert.match(composed.promptGuidelines?.join(" ") ?? "", /stable task title/);
  assert.match(composed.promptGuidelines?.join(" ") ?? "", /current estimated completion percentage/);

  await Reflect.apply(composed.execute, composed, [
    "call-1",
    { value: "keep", reasoning: "per-call detail", taskIntent: "cluster objective", taskProgress: 35 },
    undefined,
    undefined,
    undefined,
  ]);
  assert.deepEqual(received, { value: "keep" });
});

test("a source cannot reserve Grove taskProgress metadata", () => {
  const source = {
    name: "fixture",
    parameters: { type: "object", properties: { taskProgress: { type: "integer" } } },
    execute: async () => ({ content: [] }),
  } as unknown as SourceToolDefinition;
  assert.throws(
    () => composeSourceTool(source, {
      mode: "reasoning",
      reasoningGuideline: "reasoning",
      taskIntent: true,
      taskProgress: true,
    }),
    /fixture source schema reserves grove-owned taskProgress/,
  );
});

test("a source cannot reserve Grove taskIntent metadata", () => {
  const source = {
    name: "fixture",
    parameters: { type: "object", properties: { taskIntent: { type: "string" } } },
    execute: async () => ({ content: [] }),
  } as unknown as SourceToolDefinition;
  assert.throws(
    () => composeSourceTool(source, {
      mode: "reasoning",
      reasoningGuideline: "reasoning",
      taskIntent: true,
    }),
    /fixture source schema reserves grove-owned taskIntent/,
  );
});

test("running descriptions shimmer without changing text or visible width", () => {
  const description = "inspect the retry path";
  const first = shimmerText(description, ANSI_THEME, 1_000, 1_000);
  const later = shimmerText(description, ANSI_THEME, 1_400, 1_000);
  assert.notEqual(first, later, "the highlight should move");
  assert.equal(stripAnsi(first), description);
  assert.equal(stripAnsi(later), description);
  assert.equal(visibleWidth(first), description.length);
  assert.equal(visibleWidth(later), description.length);
});

test("the agent milestone estimate repeats, and only a successful final call reaches green", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  const intent = "Inspect payment retry safeguards";
  tree.start({ toolCallId: "a", toolName: "read", args: { taskIntent: intent, taskProgress: 6 } });
  const card = tree.render(row("a", false, PROGRESS_THEME));
  const first = card.render(80)[0]!;
  assert.match(stripAnsi(first), /Inspect payment retry safeguards.*▰▱{9} 6%/);
  assert.equal(stylesFor(first, "▰")[0], "\u001b[31m", "early progress is red");
  assert.ok(stylesFor(first, "6%").every(style => style === "\u001b[31m"));

  tree.start({ toolCallId: "b", toolName: "grep", args: { taskIntent: intent, taskProgress: 6 } });
  assert.equal(tree.render(row("a", false, PROGRESS_THEME)).render(80)[0], first, "repeating the same estimate is visually idempotent");
  tree.end({ toolCallId: "a", toolName: "read", result: { content: [] }, isError: false, durationMs: 5 });
  tree.end({ toolCallId: "b", toolName: "grep", result: { content: [] }, isError: false, durationMs: 5 });

  tree.start({ toolCallId: "c", toolName: "bash", args: { taskIntent: intent, taskProgress: 50 } });
  const middle = tree.render(row("a", false, PROGRESS_THEME)).render(80)[0]!;
  assert.match(stripAnsi(middle), /▰{5}▱{5} 50%/);
  assert.ok(stylesFor(middle, "50%").every(style => style === "\u001b[33m"), "midpoint is yellow");
  tree.end({ toolCallId: "c", toolName: "bash", result: { content: [] }, isError: false, durationMs: 5 });

  tree.start({ toolCallId: "d", toolName: "bash", args: { taskIntent: intent, taskProgress: 99 } });
  const almost = tree.render(row("a", false, PROGRESS_THEME)).render(80)[0]!;
  assert.match(stripAnsi(almost), /▰{10} 99%/);
  assert.ok(stylesFor(almost, "99%").every(style => style === "\u001b[33m"), "unfinished progress remains yellow");
  tree.end({ toolCallId: "d", toolName: "bash", result: { content: [] }, isError: false, durationMs: 5 });

  tree.start({ toolCallId: "e", toolName: "bash", args: { taskIntent: intent, taskProgress: 100 } });
  const pending = tree.render(row("a", false, PROGRESS_THEME)).render(80)[0]!;
  assert.match(stripAnsi(pending), /99%/, "100 stays pending while the final call runs");
  tree.end({ toolCallId: "e", toolName: "bash", result: { content: [] }, isError: false, durationMs: 10 });
  const complete = tree.render(row("a", false, PROGRESS_THEME)).render(80)[0]!;
  assert.match(stripAnsi(complete), /▰{10} 100%/);
  assert.ok(stylesFor(complete, "100%").every(style => style === "\u001b[32m"), "completed progress is green");

  tree.start({ toolCallId: "f", toolName: "read", args: { taskIntent: "Verify a different task", taskProgress: 12 } });
  const nextTask = stripAnsi(tree.render(row("a", false, PROGRESS_THEME)).render(80)[0]!);
  assert.match(nextTask, /Verify a different task.*12%/, "a new task gets its own estimate");
});

test("100 waits for the declared final call and outstanding calls to succeed", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  const intent = "Complete the retry fix";
  tree.start({ toolCallId: "a", toolName: "read", args: { taskIntent: intent, taskProgress: 58 } });
  tree.start({ toolCallId: "b", toolName: "bash", args: { taskIntent: intent, taskProgress: 100 } });
  tree.end({ toolCallId: "b", toolName: "bash", result: { content: [] }, isError: false, durationMs: 10 });
  const waiting = tree.render(row("a", false, PROGRESS_THEME)).render(80)[0]!;
  assert.match(stripAnsi(waiting), /58%/, "a still-running call prevents completion");
  tree.end({ toolCallId: "a", toolName: "read", result: { content: [] }, isError: false, durationMs: 10 });
  const complete = tree.render(row("a", false, PROGRESS_THEME)).render(80)[0]!;
  assert.match(stripAnsi(complete), /100%/);
});

test("a failed final call never paints 100 percent", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  const intent = "Complete the retry fix";
  tree.start({ toolCallId: "a", toolName: "read", args: { taskIntent: intent, taskProgress: 58 } });
  tree.end({ toolCallId: "a", toolName: "read", result: { content: [] }, isError: false, durationMs: 10 });
  tree.start({ toolCallId: "b", toolName: "bash", args: { taskIntent: intent, taskProgress: 100 } });
  tree.end({ toolCallId: "b", toolName: "bash", result: { content: [{ type: "text", text: "failed" }] }, isError: true, durationMs: 10 });
  const failed = tree.render(row("a", false, PROGRESS_THEME)).render(80)[0]!;
  assert.match(stripAnsi(failed), /58%/);
  assert.doesNotMatch(stripAnsi(failed), /100%/);
  assert.ok(stylesFor(failed, "58%").every(style => style === "\u001b[33m"));
});

test("the progress metric stays visible when the title is clipped on narrow cards", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  tree.start({ toolCallId: "a", toolName: "read", args: { taskIntent: "A very long title that should be clipped", taskProgress: 6 } });
  const frame = tree.render(row("a")).render(32);
  assert.ok(frame.every(line => visibleWidth(line) <= 32));
  assert.match(stripAnsi(frame[0]!), /▰▱{9} 6%/);
  assert.doesNotMatch(stripAnsi(frame[0]!), /A very long title/);
});

test("the border title stays static while tool rows run", () => {
  const realNow = Date.now;
  try {
    const base = 1_000_000;
    const title = "Inspect payment retry safeguards";
    const tree = new ToolTree(settings({ mode: "prompt" }));
    Date.now = () => base;
    tree.start({ toolCallId: "a", toolName: "read", args: { taskIntent: title, taskProgress: 20 } });
    const cardRow = row("a", false, ANSI_THEME);
    const first = tree.render(cardRow).render(80)[0]!;
    Date.now = () => base + 100;
    const next = tree.render(cardRow).render(80)[0]!;
    assert.match(stripAnsi(first).trimStart(), /^\+- Inspect payment retry safeguards/);
    assert.equal(next, first, "the border title has no shimmer or animated glyph");
    assert.ok(stylesFor(first, title).every(style => style === "\u001b[35m"));
    assert.equal(visibleWidth(first), visibleWidth(next));
    assert.ok(visibleWidth(first) <= 80);

    tree.end({
      toolCallId: "a",
      toolName: "read",
      result: { content: [] },
      isError: false,
      durationMs: 100,
    }, undefined);
    Date.now = () => base + 200;
    const betweenCalls = tree.render(cardRow).render(80)[0]!;
    assert.equal(betweenCalls, first, "the task title stays fixed after a call ends");
    assert.equal(visibleWidth(betweenCalls), visibleWidth(first));

    tree.settle();
    Date.now = () => base + 300;
    const settled = tree.render(cardRow).render(80)[0]!;
    assert.equal(settled, first, "settlement does not animate or replace the title");
    assert.equal(visibleWidth(settled), visibleWidth(first));
  } finally {
    Date.now = realNow;
  }
});

test("the shared call timer stops when no tool row is running", () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let tick: (() => void) | undefined;
  let clears = 0;
  globalThis.setInterval = ((callback: (...args: unknown[]) => void) => {
    tick = callback;
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => { clears += 1; }) as typeof clearInterval;
  try {
    const tree = new ToolTree(settings({ mode: "prompt" }));
    tree.start({ toolCallId: "a", toolName: "read", args: { taskIntent: "Inspect payment retry safeguards" } });
    tree.end({
      toolCallId: "a",
      toolName: "read",
      result: { content: [] },
      isError: false,
      durationMs: 100,
    }, undefined);
    assert.ok(tick);
    tick!();
    assert.equal(clears, 1, "the timer stops at the first tick after the last call ends");
    tree.settle();
    assert.equal(clears, 1, "settlement does not leave a timer behind");
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test("shimmer formatting only sees the description that fits the row", () => {
  const fitted: string[] = [];
  const line = summaryLine(
    "READ",
    "· inspect the retry path",
    " · ",
    "running",
    32,
    detail => {
      fitted.push(detail);
      return shimmerText(detail, ANSI_THEME, 1_400, 1_000);
    },
  );
  const visibleDetail = stripAnsi(fitted[fitted.length - 1]!);
  assert.notEqual(visibleDetail, "· inspect the retry path");
  assert.match(visibleDetail, /…$/);
  assert.equal(stripAnsi(line).includes("retry path"), false);
  assert.ok(visibleWidth(line) <= 32);
});

test("a running row shimmers its fitted description without changing layout", () => {
  const realNow = Date.now;
  try {
    const base = 1_000_000;
    const tree = new ToolTree(settings({ mode: "prompt" }));
    Date.now = () => base;
    tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "inspect the retry path" } });
    const cardRow = row("a", false, ANSI_THEME);
    const first = tree.render(cardRow).render(80);
    Date.now = () => base + 400;
    const later = tree.render(cardRow).render(80);
    const firstStyles = stylesFor(first.join("\n"), "inspect the retry path");
    const laterStyles = stylesFor(later.join("\n"), "inspect the retry path");
    assert.equal(firstStyles.length, "inspect the retry path".length);
    assert.notDeepEqual(laterStyles, firstStyles, "the description highlight should move");
    assert.deepEqual(later.map(visibleWidth), first.map(visibleWidth));
  } finally {
    Date.now = realNow;
  }
});

test("settled tool descriptions stay static", () => {
  const realNow = Date.now;
  try {
    const base = 1_000_000;
    const tree = new ToolTree(settings({ mode: "prompt" }));
    Date.now = () => base;
    tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "inspect the retry path" } });
    tree.end({ toolCallId: "a", toolName: "read", result: { content: [] }, isError: false, durationMs: 300 });
    tree.settle();
    const cardRow = row("a", false, ANSI_THEME);
    const first = tree.render(cardRow).render(80).join("\n");
    Date.now = () => base + 5_000;
    const later = tree.render(cardRow).render(80).join("\n");
    assert.equal(later, first, "settled cards should not keep animating");
  } finally {
    Date.now = realNow;
  }
});

test("a single call still leads with the group headline", () => {
  const tree = new ToolTree(settings());
  tree.boundary("turn");
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "check the manifest" } });
  const painted = lines(tree.render(row("a")));
  // The frame never disappears: the headline says what the turn did, the row is detail.
  assert.equal(painted.length, 2);
  assert.match(painted[0]!, /1 call/);
  assert.match(painted[0]!, /read x1/);
  assert.doesNotMatch(painted[0]!, /\b(?:DONE|WORKING|FAILED)\b/);
  assert.match(painted[1]!, /check the manifest/);
  assert.match(painted[1]!, /running/);
});

test("the border title stays on the task description despite legacy phase annotations", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  const task = "Inspect payment retry safeguards";
  tree.start({
    toolCallId: "a",
    toolName: "read",
    args: { taskIntent: task, taskProgress: 20, groupPhase: "Trace when timeout handling resets the retry counter" },
  });
  const card = tree.render(row("a"));
  tree.start({
    toolCallId: "b",
    toolName: "grep",
    args: { taskIntent: task, taskProgress: 20, groupPhase: "Add regression coverage for timeout retries" },
  });
  const title = card.render(80)[0]!;
  assert.match(title, /Inspect payment retry safeguards/);
  assert.doesNotMatch(title, /Trace when timeout|Add regression coverage/);
  assert.match(stripAnsi(title), /▰▰▱{8} 20%/);

  tree.start({
    toolCallId: "nested",
    toolName: "bash",
    parentToolCallId: "a",
    args: { taskIntent: "Run the complete test suite", taskProgress: 100, groupPhase: "Verify behavior" },
  });
  assert.match(card.render(80)[0]!, /Inspect payment retry safeguards/, "nested work cannot replace the title");
  assert.match(stripAnsi(card.render(80)[0]!), /20%/, "nested work cannot replace task progress");
});

test("codemode task metadata after @options becomes the border title", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  tree.start({
    toolCallId: "code",
    toolName: "codemode",
    args: { code: '// @options: {"timeout_ms": 2000}\n// reasoning: inspect recent sessions\n// task-intent: Classify session transcripts safely\n// group-phase: Trace how transcript calls are grouped\nreturn 1;' },
  });
  assert.match(tree.render(row("code")).render(80)[0]!, /Classify session transcripts safely/);
  assert.doesNotMatch(tree.render(row("code")).render(80)[0]!, /Trace how transcript calls are grouped/);
});

test("a long task title is clipped to the available border width", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  tree.start({
    toolCallId: "a",
    toolName: "read",
    args: { taskIntent: "Prepare a comprehensive compatibility report for every supported platform" },
  });
  const frame = tree.render(row("a")).render(32);
  assert.ok(visibleWidth(frame[0]!) <= 32);
  assert.match(stripAnsi(frame[0]!), /Prepare a compreh…/);
  assert.match(frame[0]!, /…/);
});

test("a recovered failure remains a count without a group status label", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the tests" } });
  tree.end({ toolCallId: "a", toolName: "bash", result: { content: [] }, isError: true, durationMs: 400 });
  tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "run the tests again" } });
  tree.end({ toolCallId: "b", toolName: "bash", result: { content: [] }, isError: false, durationMs: 500 });
  // The card paints on its leader row, which is the first call of the group.
  const painted = lines(tree.render(row("a")));
  assert.doesNotMatch(painted[0]!, /\b(?:DONE|WORKING|FAILED)\b/);
  assert.match(painted[0]!, /1 error/);
});

test("a final failure is counted without a group status label", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the tests" } });
  tree.end({ toolCallId: "a", toolName: "bash", result: { content: [] }, isError: true, durationMs: 400 });
  const painted = lines(tree.render(row("a")));
  assert.doesNotMatch(painted[0]!, /\b(?:DONE|WORKING|FAILED)\b/);
  assert.match(painted[0]!, /1 error/);
});

test("the rollup ends in a sparkline of how long each call took", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "read the manifest" } });
  tree.end({ toolCallId: "a", toolName: "read", result: { content: [] }, isError: false, durationMs: 150 });
  tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "run the suite" } });
  tree.end({ toolCallId: "b", toolName: "bash", result: { content: [] }, isError: false, durationMs: 90_000 });
  tree.start({ toolCallId: "c", toolName: "read", args: { reasoning: "read the log" } });
  tree.end({ toolCallId: "c", toolName: "read", result: { content: [] }, isError: false, durationMs: 900 });
  const head = lines(tree.render(row("a")))[0]!;
  const spark = head.split(" · ")[1];
  assert.equal(spark, "./\\", `no ASCII line trace in: ${head}`);
  // One segment per call: rising to the slow call, then falling again.
  assert.equal(spark!.length, 3);
  assert.doesNotMatch(spark!, /[_=+*#@]/);
});

test("a running call keeps its own cell at the end of the sparkline", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the suite" } });
  tree.end({ toolCallId: "a", toolName: "bash", result: { content: [] }, isError: false, durationMs: 2000 });
  tree.start({ toolCallId: "b", toolName: "read", args: { reasoning: "read the log" } });
  const head = lines(tree.render(row("a")))[0]!;
  const spark = head.split(" · ")[1]?.slice(0, 2);
  assert.equal(spark?.length, 2, `no running line segment in: ${head}`);
  assert.equal(spark?.[0], ".");
  assert.ok(["/", "\\", "-"].includes(spark?.[1] ?? ""));
});

test("Unicode duration sparkline plots a connected Braille line, not bars", () => {
  const tree = new ToolTree(settings({ mode: "prompt", iconMode: "nerd" }));
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "read the manifest" } });
  tree.end({ toolCallId: "a", toolName: "read", result: { content: [] }, isError: false, durationMs: 150 });
  tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "run the suite" } });
  tree.end({ toolCallId: "b", toolName: "bash", result: { content: [] }, isError: false, durationMs: 90_000 });
  tree.start({ toolCallId: "c", toolName: "read", args: { reasoning: "read the log" } });
  tree.end({ toolCallId: "c", toolName: "read", result: { content: [] }, isError: false, durationMs: 900 });
  const head = lines(tree.render(row("a")))[0]!;
  const plot = head.split(" · ")[1];
  assert.ok(plot?.includes("\uf201"), `no Nerd Font chart-line cue in: ${head}`);
  const spark = [...(plot ?? "")].filter(cell => {
    const code = cell.codePointAt(0)!;
    return code >= 0x2800 && code <= 0x28ff;
  });
  assert.equal(spark.length, 3, `no Braille line sparkline in: ${head}`);
  assert.doesNotMatch(spark.join(""), /[▁▂▃▄▅▆▇█▰▱]/);
  const masks = spark.map(cell => cell.codePointAt(0)! - 0x2800);
  // The first segment joins the low first call to the high middle call.
  assert.ok(masks[0]! & 0x40);
  assert.ok(masks[0]! & 0x08);
  // The next segment starts at that same peak and heads back down.
  assert.ok(masks[1]! & 0x01);
  assert.ok(masks[1]! & 0x20);
});
test("the card shows call details without group-level prose", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "inspect the current behavior" } });
  tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "run the regression tests" } });
  const card = lines(tree.render(row("a"))).join(" ");
  assert.doesNotMatch(card, /\bGoal\b|\bNow\b/);
  assert.match(card, /inspect the current behavior/);
  assert.match(card, /run the regression tests/);
});

test("the card stays on the first call and grows in place", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "check the manifest" } });
  assert.equal(lines(tree.render(row("a"))).length, 2);

  tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "run the tests" } });
  // The newest call must not move the card: a moving card reflows on every call.
  assert.deepEqual(tree.render(row("b")).render(80), []);
  const card = lines(tree.render(row("a")));
  assert.equal(card.length, 3);
  assert.match(card[0]!, /2 calls/);
  assert.match(card[1]!, /read/);
  assert.match(card[2]!, /bash/);
});

test("a streaming call joins the card instead of painting itself", async () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the tests" } });
  assert.equal(lines(tree.render(row("a"))).length, 2);

  // pi mounts the next row while its arguments are still streaming.
  tree.ensure("b", "codemode", { code: "// reasoning: build the card" });
  await flush();
  const card = lines(tree.render(row("a")));
  assert.equal(card.length, 3);
  assert.match(card[2]!, /build the card/);
  // Its own row stays blank, so the same call never appears as a second block.
  assert.deepEqual(tree.render(row("b")).render(80), []);
});

test("a streaming row stops repainting once its text settles", async () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  let repaints = 0;
  const streaming = (args: Record<string, unknown>): Component => {
    tree.ensure("a", "bash", args);
    return tree.render({
      toolCallId: "a",
      inner: inner(),
      theme: plainTheme,
      expanded: false,
      invalidate: () => {
        repaints += 1;
      },
      phase: "call",
    });
  };

  streaming({ reasoning: "run the tests" });
  await flush();
  // pi repaints the chat container for every streaming chunk. An unchanged row that asks
  // for another repaint feeds the render loop forever and freezes the session.
  for (let pass = 0; pass < 5; pass += 1) {
    streaming({ reasoning: "run the tests" });
    await flush();
  }
  assert.equal(repaints, 0);

  streaming({ reasoning: "run the tests", command: "npm test" });
  await flush();
  assert.equal(repaints, 1, "new arguments still repaint the card");

  for (let pass = 0; pass < 3; pass += 1) {
    streaming({ reasoning: "run the tests", command: "npm test" });
    await flush();
  }
  assert.equal(repaints, 1, "a settled row stops asking for repaints");
});

test("clicking a codemode row reveals its nested steps", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "c", toolName: "codemode", args: { code: "// reasoning: build the card\nreturn 1;" } });
  tree.start({ toolCallId: "c1", toolName: "bash", parentToolCallId: "c", args: { reasoning: "list files" } });
  tree.start({ toolCallId: "c2", toolName: "read", parentToolCallId: "c", args: { reasoning: "read the entry" } });
  const card = tree.render(row("c"));
  const before = lines(card);
  assert.equal(before.length, 2);
  assert.match(before[0]!, /1 call/);
  assert.match(before[0]!, /codemode x1/);
  // A branch row names the mix of steps it holds instead of a bare count.
  assert.match(before[1]!, /bash x1/);
  assert.match(before[1]!, /read x1/);
  assert.doesNotMatch(before.join(" "), /list files/);

  // The headline also names codemode, so match the row by its own goal text.
  card.handleMouse?.(click(at(card, /─ .*build the card/)));
  const after = lines(tree.render(row("c")));
  assert.equal(after.length, 4);
  assert.match(after[2]!, /list files/);
  assert.match(after[3]!, /read the entry/);
});

test("the header reveals every row but opens no level", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "c", toolName: "codemode", args: { code: "// reasoning: build the card" } });
  tree.start({ toolCallId: "c1", toolName: "bash", parentToolCallId: "c", args: { reasoning: "list files" } });
  tree.start({ toolCallId: "d", toolName: "bash", args: { reasoning: "run the tests" } });
  const card = tree.render(row("c"));
  card.handleMouse?.(click(at(card, /\d+ calls?\b/)));
  const revealed = lines(tree.render(row("c")));
  // Every call is listed, and each row still waits for its own click.
  assert.equal(revealed.length, 3);
  assert.match(revealed[2]!, /run the tests/);
  assert.doesNotMatch(revealed.join(" "), /list files/);

  // The header also names codemode in its mix, so match the row by its own goal.
  const card2 = tree.render(row("c"));
  card2.handleMouse?.(click(at(card2, /─ .*build the card/)));
  const drilled = lines(tree.render(row("c")));
  assert.match(drilled.join(" "), /list files/);
});

test("an unknown line falls through to pi's own expand toggle", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the tests" } });
  const card = tree.render(row("a"));
  assert.equal(card.handleMouse?.(click(9)), undefined);
  assert.equal(card.handleMouse?.({ ...click(0), button: "right" }), undefined);
});

test("turn boundaries separate cards, message boundaries do not", () => {
  const turns = new ToolTree(settings());
  turns.start({ toolCallId: "a", toolName: "read", args: { reasoning: "first turn" } });
  turns.boundary("turn");
  turns.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "second turn" } });
  assert.equal(lines(turns.render(row("a"))).length, 2);
  assert.equal(lines(turns.render(row("b"))).length, 2);

  const messages = new ToolTree(settings({ mode: "message" }));
  messages.start({ toolCallId: "a", toolName: "read", args: { reasoning: "first turn" } });
  messages.boundary("turn");
  messages.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "second turn" } });
  assert.equal(lines(messages.render(row("a"))).length, 3);
});

test("only one of the two pi rows paints a call", async () => {
  let callRepaints = 0;
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the tests" } });
  const callRow = { ...row("a"), phase: "call" as const, invalidate: () => { callRepaints += 1; } };
  assert.equal(lines(tree.render(callRow)).length, 2);

  // The result row takes the card over and blanks the row that painted it.
  const resultRow = { ...row("a"), phase: "result" as const };
  assert.equal(lines(tree.render(resultRow)).length, 2);
  await flush();
  assert.ok(callRepaints >= 1, "the call row is repainted so it can render nothing");
  assert.deepEqual(tree.render({ ...row("a"), phase: "call" as const }).render(80), []);
});

test("a prompt scope keeps one card across turns and splits on the next user message", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  tree.start({ toolCallId: "a", toolName: "read", args: { reasoning: "first call" } });
  tree.boundary("turn");
  tree.start({ toolCallId: "b", toolName: "bash", args: { reasoning: "second call" } });
  const together = lines(tree.render(row("a")));
  assert.equal(together.length, 3);
  assert.match(together[0]!, /2 calls/);

  tree.boundary("prompt");
  tree.start({ toolCallId: "c", toolName: "bash", args: { reasoning: "fresh prompt" } });
  assert.equal(lines(tree.render(row("c"))).length, 2);
});

test("the collapsed card keeps only the newest calls and expands on click", () => {
  const tree = new ToolTree(settings({ window: 2 }));
  for (const id of ["a", "b", "c", "d"]) {
    tree.start({ toolCallId: id, toolName: "bash", args: { reasoning: "step " + id } });
  }
  const card = tree.render(row("a"));
  const rolled = lines(card);
  assert.equal(rolled.length, 3);
  assert.match(rolled[0]!, /2 of 4 calls/);
  assert.match(rolled[1]!, /step c/);
  assert.match(rolled[2]!, /step d/);

  card.handleMouse?.(click(at(card, /calls?\b/)));
  assert.equal(lines(tree.render(row("a"))).length, 5);
});

test("failed nested steps stay visible while their parent is collapsed", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "c", toolName: "codemode", args: { code: "// reasoning: build the card" } });
  tree.start({ toolCallId: "c1", toolName: "bash", parentToolCallId: "c", args: { reasoning: "run the tests" } });
  tree.end({ toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "boom" }] }, isError: true, durationMs: 1200 });
  assert.ok(lines(tree.render(row("c"))).some(line => /run the tests/.test(line)));

  const quiet = new ToolTree(settings({ revealErrors: false }));
  quiet.start({ toolCallId: "c", toolName: "codemode", args: { code: "// reasoning: build the card" } });
  quiet.start({ toolCallId: "c1", toolName: "bash", parentToolCallId: "c", args: { reasoning: "run the tests" } });
  quiet.end({ toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "boom" }] }, isError: true, durationMs: 1200 });
  assert.ok(!lines(quiet.render(row("c"))).some(line => /run the tests/.test(line)));
});

test("clicking a finished call shows a bounded preview", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "read the log" } });
  const body = Array.from({ length: 20 }, (_, index) => "line " + (index + 1)).join("\n");
  tree.end({ toolCallId: "a", toolName: "bash", result: { content: [{ type: "text", text: body }] }, isError: false, durationMs: 900 });
  const card = tree.render(row("a"));
  assert.equal(lines(card).length, 2);
  // Clicks take framed coordinates, so resolve the row in the rendered frame.
  card.handleMouse?.(click(at(card, /─ .*read the log/)));
  const painted = lines(tree.render(row("a")));
  assert.equal(painted.length, 11);
  assert.match(painted[2]!, /line 1/);
  assert.match(painted[10]!, /…/);
});

test("pi's expanded flag opens the whole tree without a click", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "c", toolName: "codemode", args: { code: "// reasoning: build the card" } });
  tree.start({ toolCallId: "c1", toolName: "bash", parentToolCallId: "c", args: { reasoning: "list files" } });
  assert.equal(lines(tree.render(row("c", true))).length, 3);
});

test("settle marks unfinished calls incomplete and off mode is a no-op", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the tests" } });
  tree.settle();
  assert.match(lines(tree.render(row("a")))[1]!, /incomplete/);

  const off = new ToolTree(settings({ mode: "off" }));
  off.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "run the tests" } });
  const untouched = off.render(row("a"));
  assert.deepEqual(untouched.render(80), ["inner"]);
});

test("old turns still paint after many newer ones", () => {
  const tree = new ToolTree(settings());
  tree.start({ toolCallId: "a", toolName: "bash", args: { reasoning: "first turn" } });
  tree.end({ toolCallId: "a", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false, durationMs: 100 });
  for (let index = 0; index < 40; index += 1) {
    tree.boundary("turn");
    tree.start({ toolCallId: "t" + index, toolName: "read", args: { reasoning: "turn " + index } });
  }
  const painted = lines(tree.render(row("a")));
  assert.equal(painted.length, 2);
  assert.match(painted[1]!, /first turn/);
});

test("paintGroup keeps the click map aligned with the painted lines", () => {
  const group: TreeGroup = {
    key: "g1", rows: [], nodes: new Map(), started: Date.now(), budget: 100, openAll: false,
  };
  const targets = new Map<number, string>();
  const painted = paintGroup({ settings: settings(), expanded: new Set<string>() }, group, 80, plainTheme, false, targets);
  assert.deepEqual(painted, []);
  assert.equal(targets.size, 0);
  assert.equal(GROUP_TARGET, "@group");
});

test("a finished codemode call keeps the steps that ran inside it", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  const details = {
    piGroveNested: {
      version: 2,
      incomplete: false,
      calls: [
        {
          id: "c:1",
          parent: "c",
          name: "bash",
          reasoning: "run the tests",
          status: "success",
          duration: 1200,
          summary: "12 passed",
          preview: ["$ bun test", "12 passed"],
        },
      ],
    },
  };
  tree.start({ toolCallId: "c", toolName: "codemode", args: { code: "// reasoning: audit the suite" } });
  tree.end({ toolCallId: "c", toolName: "codemode", result: { content: [{ type: "text", text: "done" }], details }, isError: false, durationMs: 1300 });

  // The snapshot is the only trace of the steps, so the card must adopt them on completion.
  const before = lines(tree.render(row("c")));
  assert.equal(before.length, 2);
  assert.match(before[0]!, /1 call/);
  assert.match(before[1]!, /bash x1/);

  tree.render(row("c")).handleMouse?.(click(at(tree.render(row("c")), /─ .*audit the suite/)));
  const opened = lines(tree.render(row("c")));
  assert.match(opened[2]!, /run the tests/);

  tree.render(row("c")).handleMouse?.(click(at(tree.render(row("c")), /─ .*run the tests/)));
  const expanded = lines(tree.render(row("c")));
  assert.ok(expanded.some(line => /12 passed/.test(line)), "the step keeps its output");
});
test("a codemode call does not duplicate the steps it already registered live", () => {
  const tree = new ToolTree(settings({ mode: "prompt" }));
  const details = {
    piGroveNested: {
      version: 2,
      incomplete: false,
      calls: [
        { id: "c:1", parent: "c", name: "bash", reasoning: "run the tests", status: "success", duration: 1200, summary: "12 passed", preview: "$ bun test\n12 passed" },
        { id: "c:2", parent: "c", name: "read", reasoning: "read the entry", status: "success", duration: 40, summary: "2 lines" },
      ],
    },
  };
  tree.start({ toolCallId: "c", toolName: "codemode", args: { code: "// reasoning: audit the suite" } });
  // Each step also arrives as its own tool event; the snapshot must not add a second copy.
  tree.start({ toolCallId: "c:1", toolName: "bash", args: { command: "bun test" }, parentToolCallId: "c" });
  tree.end({ toolCallId: "c:1", toolName: "bash", result: { content: [{ type: "text", text: "$ bun test\n12 passed" }] }, isError: false, durationMs: 1200 });
  tree.end({ toolCallId: "c", toolName: "codemode", result: { content: [{ type: "text", text: "done" }], details }, isError: false, durationMs: 1300 });

  tree.render(row("c")).handleMouse?.(click(at(tree.render(row("c")), /─ .*audit the suite/)));
  const painted = lines(tree.render(row("c")));
  const steps = painted.filter(line => line.includes("bun test") || line.includes("read the entry"));
  assert.equal(steps.length, 2, painted.join(" | "));
  assert.equal(painted.filter(line => line.includes("bun test")).length, 1);
});
