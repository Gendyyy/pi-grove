# pi-grove

Groups every tool call of a prompt into one clickable card, so the transcript reads as
narration instead of a stack of boxes.

```
| > 4 calls · read x4 · bash x3 · codemode x1 · grep x1 · <1s
| +- * codemode audit the funnel queries · read x3 · bash x2 · <1s
| |  +- * bash run the checks · 12 passed · 1s
```

Click the header to reveal every row, click a row to open one level, click again to close.
The connector line under a row belongs to that row, so a click just below it opens the same
level; a repeat click inside one gesture never undoes the first. Nothing opens by default; the
headline stays compact above the tool details.

## Install

```sh
pi install npm:pi-grove        # published package
pi install git:github.com/Gendyyy/pi-grove   # straight from the repository
```

The defaults are deliberate, not placeholders: reasoning rows, five visible calls and a hidden
thinking label are what this card looks like out of the box. A machine with no `grove.json` at all
behaves exactly like the machine this was built on; the config file only records departures.

Restart pi. Everything below is optional; the defaults are what the card above shows.

## The card

One card covers one prompt (`group: "prompt"`). Settings live in
`~/.pi/agent/grove.json`:

| Option | Values | Default | What it decides |
| --- | --- | --- | --- |
| `enabled` | on / off | on | render grove at all |
| `mode` | default / reasoning / result | reasoning | what a row leads with |
| `icons` | on / off | on | add glyphs beside tool words |
| `iconMode` | auto / nerd / ascii | auto | whether the font can draw them |
| `group` | prompt / turn / message / off | prompt | where one card ends |
| `groupWindow` | 1-32 | 5 | how many recent unphased calls stay visible |
| `groupRevealErrors` | on / off | off | opt in to showing failed steps while collapsed |
| `groupNestedTools` | on / off | on | show nested tool names and counts inline |
| `groupToolNames` | on / off | on | show built-in tool names or icons only |
| `groupProgress` | on / off | on | show the estimate as a meter, with the phase plan when one is declared |
| `groupSparkline` | on / off | on | show relative call durations in the card rollup |
| `groupGutter` | on / off | on | show Story phase cards; off retains the compact call timeline |
| `thinking` | group / inline / off | off | where reasoning appears |
| `thinkingLabel` | text | hidden | label pi prints for a hidden thinking run |


## Card shape

One card per request: a model-authored task description in the border, then the rollup and tool rows.
Keep task titles concise (ideally 45 characters or fewer); long titles continue onto extra lines.
Cards with a phase plan use the Story layout; cards without one keep the compact timeline. The required `taskIntent` identifies the atomic task cluster and stays fixed
across its calls; progress appears on the rollup, so milestone updates never rewrite the
headline. A new task starts a new title. The title is not per-call reasoning or a summary of
the latest tool action.

When grouping is enabled, Pi's codemode instruction makes `// task-intent:` and
`// task-progress:` mandatory on every top-level call. Progress is the agent's best-judgment estimate
of how much of the requested task is done and how much remains—not a tool-call count or a fixed
formula. Repeat the integer estimate (0–100) on ordinary calls; update it at meaningful milestones,
and lower it if scope grows. The final tool call intended to complete and verify the task passes 100;
Grove shows 100 only after that call succeeds. Filled cells blend smoothly from the theme's error red
to success green; empty cells stay dim. The percentage keeps its estimate-based color.
Both annotations are stored with calls so replay restores the same title and estimate.

A card can also carry a phase plan: declare `// task-milestones: inspect=Inspect; build=Build; verify=Verify`
once, then repeat `// task-milestone: <id>` for the active phase on each top-level call. A plan holds
one to seven phases and may close on a `verify` phase when the work needs checking, or on a `clean` phase
when the work leaves temp files, scratch scripts, or other throwaway artifacts behind. Both are preferences,
not requirements: a plan that ends on plain work is valid, and Grove never invents filler phases.

The plan and the estimate share one line, because they answer one question: the meter is a written ruler
whose needle is the estimate. The filled span keeps the estimate's own ramp from error red at the left edge to
success green at the right, so the bar's colour and its number can never disagree. A finished phase is pinned at
the estimate it actually reached, so the order the phases closed in is history rather than arithmetic and never
moves later; its boundary keeps a vertical tick of its own inside the filled span, in the ramp colour of the
cell it divides. Nobody can say where a phase will end before it does, so the bar draws a division only after
one is crossed and never forecasts one, and only a boundary the estimate has since retreated behind turns into
a warning tick right of the needle. The phase in flight is the only one that spends width on a name, with
a `2/3` position beside it, and the caret says whether the plan is open. Clicking the meter expands the whole
plan under it—every name joined by arrows, plus the estimate that closed each finished phase—while clicking the
frame border still reveals the rows. Each arrow behind a finished phase turns green, so a completed plan reads as
one green line. Narrow cards drop the label, then the name while keeping the position, before they concede the
cells the bar needs. Phases
only move forward: every call restates the plan, so a restatement is adopted only while it keeps the phases
already finished, and a plan that would drop or rewrite them is ignored instead of clearing the pins. The plan
is transcript-backed and independent of the percentage, and a successful final `task-progress: 100` closes it.
While a call is live, the needle's own cell breathes between the accent and muted roles on a cosine curve
instead of blinking on and off, so motion means work in flight and a still bar means nothing is running.

The Story layout groups work into numbered, colored phase cards. Each phase header shows its
status, direct call count, elapsed time when space permits, and failure count. The newest
call rows always stay visible: the last `groupWindow` call-level entries, where a run of related
calls counts as one entry, so a phase that just finished keeps its tail on screen. Older calls
collapse into a summary naming up to two of that phase's actual call goals (or tool names) plus
the phase's total call count; a call shown as a row is never repeated in the summary. Click the
phase header or summary to reveal the phase's direct calls; click a call to reveal its nested
steps and output. Failures remain visible when collapsed. The same tail rule covers calls
without a visible phase. The meter separately
opens the full plan, and Pi's expand-all opens the entire tree. Setting `groupGutter` off
uses the compact timeline instead of the Story phase cards.

```text
╭─ Check updates ────────────────────────────────────────────╮
│ GROVE / TASK  ● 65% · Verify 2/2                           │
│ ▰▰▰▰▰▰▱▱▱▱  65% · 2 calls                                  │
│ ────────────────────────────────────────────────────────── │
│ │ ✓ 01 Inspect · 1 call · 1s ▸                             │
│ │   ▸ Read settings                                        │
│ │ ! 02 Verify · 1 call · 1 failed ▸                        │
│ │   ▸ Check registry                                       │
╰────────────────────────────────────────────────────────────╯
```

The task title stays fixed across the task; call rows show their own per-call intent. Grove
adds no separate Goal or Now sections.

## Layers

Every part of a card has a name, so a request can point at one layer instead of describing a
position. From the outside in:

| Layer | What it is | Click target |
| --- | --- | --- |
| Card frame | The border, including the task title and its wrapped continuation lines | Reveals every row |
| Status line | GROVE / TASK plus the percentage and current phase, or the complete marker | Reveals every row |
| Rollup | One metrics line: meter, failed count, call count, duration sparkline, tool mix, elapsed | Expands the plan |
| Progress meter | The filled bar and its phase ticks | Expands the plan |
| Plan line | The expanded phase names joined by arrows, with the estimate that closed each phase | Expands the plan |
| Phase row | Numbered rail mark, phase name, call count, duration, failure count, caret | Opens that phase |
| Phase summary row | Up to two of a collapsed phase's hidden call goals, plus that phase's total call count | Opens that phase |
| Call row | Tool label, its goal, nested counts, and duration | Opens that call |
| Nested row | A tool the call ran, such as a bash step inside a codemode script | Opens that step |
| Preview row | Bounded output under an expanded call, led by a pipe guide | Opens or closes the call |
| Reasoning row | A thinking segment kept inline, shown as thinking | None |

The layers are also named in code: tree-model.ts holds the data, tree-state.ts the disclosure
state, tree-paint.ts the rows and their names, and tree-block.ts the measuring and hit map that
turns a click into one of the targets above.

## Rollup

The line under the frame shows how much work is in view and **where the time went**.
Nerd Font mode adds a percent icon beside the progress meter and a bar-chart cue beside the
duration bars. Each call gets one height-coded cell, oldest first, on a fixed log scale from
50ms to 10s, so a cell means the same thing on every card: 150ms is a low cell whether or not
a 90s call shares the strip, and anything slower than 10s clamps to the top. Unicode mode uses
block heights, while ASCII mode uses increasing intensity characters. Bar colors are absolute
bands of that same scale: the theme's success color for fast calls, warning in the middle,
error for slow ones. Exact times stay on each row. Live call times use Grove's full start-to-finish
elapsed interval, not the host-reported execution duration. `/grove group progress off` hides only
the meter, not milestone tracking; `/grove group sparkline off` hides only the chart, not row times.
`/grove group nested off` hides nested tool names/counts from both the summary strip and codemode
rows while preserving top-level tool counts, expandable child rows, and parent failure markers.
`/grove group tool-names off` replaces recognized built-in names (`codemode`, `bash`, `read`,
`write`, and others) with their selected Nerd or ASCII icons in rows and tool-mix summaries.
Custom tool names remain visible; this icon-only mode still shows a glyph when `icons` is off.

The card owns its background instead of borrowing one row's result: it stays pending while any
call runs, stays neutral when calls succeed or only some of them fail, and turns red only when
every call in the card failed. A partial failure is still visible through the parent's warning
marker and the error count, so the block never shouts about work that partly succeeded.

## Glyphs

`icons` adds a glyph without hiding what the row says. With a Nerd Font a tool gets a glyph
in its own colour beside its name, so the row still reads `  read`, `  codemode`, `  bash` with
the two-cell gap a patched glyph needs so it never touches the word. Set `groupToolNames` off
to use the glyph alone for recognized built-ins; custom tool names remain words. The selected
icon mode supplies the icon even when `icons` is off. Outcome words become a single mark,
and counts keep their number. With names enabled, the tool word is never dropped for its glyph;
the rollup names tools in words (`read ×2 · bash ×1`) so the mix stays readable without the font. `auto` turns glyphs on only when the terminal can draw them;
force `ascii` to keep every word.

A live call breathes its marker every 100 ms, exactly like the active phase marker, while the
same tick keeps elapsed time honest. The border title stays static throughout the task. Each live call's description
gets its own subtle highlight; words and layout stay fixed while running work is visible.

| Glyph | Means |
| --- | --- |
| `` | read a file |
| `` | write a file |
| `` | edit a file |
| `` | run a command |
| `` | search file contents |
| `` | find files by name |
| `` | list a directory |
| `` | run a script |
| `×3` | three of something |
| `12 L` | twelve lines, matches or files |

| Mark | Means |
| --- | --- |
| `` | done, applied, written |
| `` | error, failed |
| `` | cancelled |
| `` | incomplete |
| `` | breathing dot | running, one steady dot whose colour swells and quiets |

A tool grove has no glyph for keeps its name beside the generic mark, so an MCP call still
says which server ran. A plain terminal keeps every word and drops only the old bracket
prefixes.

`PI_GROVE=on|off` overrides `enabled` for one shell, and `PI_GROVE_CONFIG` points the
config at another file.

## Commands

Run `/grove` with no arguments to open the settings panel: one searchable list of every
option above. Enter cycles a value or opens a submenu, typing filters, Escape closes.

```
/grove                      open the settings panel
/grove status               report every option and what is active
/grove group turn           change card boundaries (reload required)
/grove group window 6       numbers are clamped to their range
/grove group nested off      hide inline nested names/counts
/grove group tool-names off  show built-ins as icons only
/grove group progress off    hide the progress meter
/grove group sparkline off   hide duration bars from the rollup
/grove thinking label Plan  free text, quoted output, empty hides the label
/grove on | off | toggle
```

Tool icons, built-in tool names, icon set, visible-call window, failure visibility, nested counts, progress,
duration bars, and the thinking label apply immediately. Enabled state, row-label mode,
grouping, and reasoning placement require Grove to reload because they change startup-time
tool composition or event behavior. The settings panel labels each option with its policy.

## Reasoning

`thinking: "off"` is the default: pi's own thinking rows cost two blank lines each, so
grove removes them from the rendered message (the session still keeps them, and still
sends them to the provider).

`thinking: "group"` instead shows each reasoning run as a row inside the card, hidden
until you click it. `thinking: "inline"` leaves pi's behaviour untouched.

## History

Cards are rebuilt from the session transcript on start and on reload, so past prompts keep
their grouping and their expandable steps. Steps recorded by earlier versions of this
extension, before it was called grove, are still read.

## Attribution

Originally developed as `pi-tools-ui` / `pi-tidy-tools` by Mikey O'Brien, and derived
from [mikeyobrien/pi-tidy-tools](https://github.com/mikeyobrien/pi-tidy-tools). The MIT
licence and the original copyright notice are kept in [LICENSE](LICENSE).

## Development

```sh
npm run check        # tsc --noEmit
npm test             # node:test through tsx
npm run test:host-smoke   # load the extension in a real pi process
```

Every call keeps its own row inside its phase; there is no intermediate grouping level.
