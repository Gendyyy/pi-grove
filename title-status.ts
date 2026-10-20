import { basename } from "node:path";
import type {
  AgentActivityOutcome,
  ExtensionAPI,
  ExtensionContext,
  UIPromptKind,
} from "@earendil-works/pi-coding-agent";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 120;
const OUTCOME_ICON: Record<AgentActivityOutcome, string> = {
  completed: "✓",
  error: "!",
  aborted: "⏹",
};
type TitleState = "idle" | "working" | AgentActivityOutcome;

/** One title owner per enabled extension, with no timers outside the TUI. */
export function registerTitleStatus(pi: ExtensionAPI): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let frameIndex = 0;
  let state: TitleState = "idle";
  let outcome: AgentActivityOutcome | undefined;
  let context: ExtensionContext | undefined;
  let waitingFor: Exclude<UIPromptKind, "custom"> | undefined;

  function stopTimer(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  function startTimer(): void {
    if (timer !== undefined || state !== "working" || waitingFor !== undefined) return;
    timer = setInterval(() => {
      frameIndex = (frameIndex + 1) % FRAMES.length;
      if (context) render(context);
    }, INTERVAL_MS);
    timer.unref();
  }

  function render(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const cwd = basename(ctx.cwd);
    const session = pi.getSessionName();
    const base = session ? `π - ${session} - ${cwd}` : `π - ${cwd}`;
    const prefix = state === "working"
      ? waitingFor !== undefined ? "?" : FRAMES[frameIndex]
      : state === "idle" ? "" : OUTCOME_ICON[state];
    // Titles are plain text: metadata must not inject terminal control sequences.
    ctx.ui.setTitle(`${prefix ? `${prefix} ` : ""}${base}`.replace(/[\x00-\x1f\x7f-\x9f]/g, " "));
  }

  function reset(ctx: ExtensionContext): void {
    stopTimer();
    frameIndex = 0;
    state = "idle";
    outcome = undefined;
    context = undefined;
    waitingFor = undefined;
    render(ctx);
  }

  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", (_event, ctx) => reset(ctx));
  pi.on("session_info_changed", (_event, ctx) => {
    // Updating metadata must neither advance the frame nor restart its clock.
    if (state === "working") context = ctx;
    render(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    context = ctx;
    outcome = undefined;
    if (state === "working") return; // Retries and continuations share one animation.
    state = "working";
    frameIndex = 0;
    render(ctx);
    startTimer();
  });

  // Pi coalesces nested prompts into one outer start/end pair. Custom UI also
  // includes passive detail views, so it is intentionally excluded.
  pi.on("ui_prompt_start", (event, ctx) => {
    if (ctx.mode !== "tui" || state !== "working" || event.kind === "custom" || waitingFor !== undefined) return;
    waitingFor = event.kind;
    context = ctx;
    stopTimer();
    render(ctx);
  });
  pi.on("ui_prompt_end", (event, ctx) => {
    if (ctx.mode !== "tui" || state !== "working" || waitingFor !== event.kind) return;
    waitingFor = undefined;
    context = ctx;
    render(ctx); // Resume from the same frame, rather than jumping back to frame zero.
    startTimer();
  });

  // Cancellation can skip agent_before_settle, so also observe the turn outcome.
  // Tool errors alone are not run failures: Pi may recover on a later turn.
  pi.on("turn_end", (event) => {
    if (state === "working") outcome = event.outcome;
  });
  pi.on("agent_before_settle", (event) => {
    if (state === "working") outcome = event.outcome;
  });
  pi.on("agent_settled", (event, ctx) => {
    if (state !== "working") return;
    stopTimer();
    // Never claim success if an exceptional run produced no outcome at all.
    state = event.aborted ? "aborted" : outcome ?? "error";
    context = undefined;
    waitingFor = undefined;
    render(ctx);
  });
}
