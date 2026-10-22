# pi-grove

Groups every tool call of a prompt into one clickable card, so the transcript reads as
narration instead of a stack of boxes.

```
| > 4 calls · read x4 · bash x3 · codemode x1 · grep x1 · <1s
| +- * codemode audit the funnel queries · read x3 · bash x2 · <1s
| |  +- * bash run the checks · 12 passed · 1s
```

Click the header to reveal every row, click a row to open one level, click again to close.
Nothing opens by default; the headline stays compact above the tool details.

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
| `icons` | on / off | on | replace tool words with glyphs |
| `iconMode` | auto / nerd / ascii | auto | whether the font can draw them |
| `group` | prompt / turn / message / off | prompt | where one card ends |
| `groupWindow` | 1-32 | 5 | how many recent calls stay visible |
| `groupRevealErrors` | on / off | on | keep failed steps visible while collapsed |
| `thinking` | group / inline / off | off | where reasoning appears |
| `thinkingLabel` | text | hidden | label pi prints for a hidden thinking run |


## Card shape

One card per request: a model-authored task description in the top border, then the rollup
and tool rows. The required `taskIntent` identifies the atomic task cluster and stays fixed
across its calls; progress appears on the rollup, so milestone updates never rewrite the
headline. A new task starts a new title. The title is not per-call reasoning or a summary of
the latest tool action.

When grouping is enabled, Pi's codemode instruction makes `// task-intent:` and
`// task-progress:` mandatory on every top-level call. Progress is the agent's best-judgment estimate
of how much of the requested task is done and how much remains—not a tool-call count or a fixed
formula. Repeat the integer estimate (0–100) on ordinary calls; update it at meaningful milestones,
and lower it if scope grows. The final tool call intended to complete and verify the task passes 100;
Grove shows 100 only after that call succeeds. The bar uses a fixed left-to-right red/yellow/green
ramp on its filled cells; empty cells stay dim. The percentage keeps its estimate-based color.
Both annotations are stored with calls so replay restores the same title and estimate.

There are no Goal or Now sections and no group status chip. The rest of the headline carries
the call count, duration sparkline and tool mix.

```
╭─ Make payment retries safe ───────────────────────────╮
│ ▸   ▰▱▱▱▱▱▱▱▱▱   6% · 2 calls ·   ▃█ · bash ×1 · codemode ×1 │
│ ├─ ●   codemode · read the classify docs and run one · 1s  │
│ └─ ●   bash · run the model tests (npm test) · 4s          │
╰────────────────────────────────────────────────────────────╯
```

The border title and rollup completion metric are the card's only group-level summary. Individual
call rows show each tool's own per-call intent; Grove adds no separate Goal or Now sections.

## Rollup

The line under the frame shows how much work is in view and **where the time went**.
Nerd Font mode adds a percent icon beside the progress meter and a bar-chart cue beside the
duration bars. Each call gets one height-coded cell, oldest first; a log scale keeps one
four-minute call from flattening everything beside it, and slower calls rise toward the top.
Unicode mode uses block heights, while ASCII mode uses increasing intensity characters.
Bar colors follow relative duration through the theme's success, warning and error colors:
shorter calls are green, longer calls are red, with intermediate durations transitioning
between them. Exact times stay on each row.

## Glyphs

`icons` shortens the card without hiding what it says. With a Nerd Font a tool gets a glyph
in its own colour beside its name, so the row still reads `  read`, `  codemode`, `  bash` with
the two-cell gap a patched glyph needs so it never touches the word; one
outcome word becomes a single mark, and a count keeps its number. The tool word is never
dropped for its glyph, and the rollup names tools in words (`read ×2 · bash ×1`) so the mix
is readable without the font. `auto` turns glyphs on only when the terminal can draw them;
force `ascii` to keep every word.

A live call spins through its marker ramp every 100 ms, while the same tick keeps elapsed
time honest. The border title stays static throughout the task. Each live call's description
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
| `` | ⠋⠙⠹… | running, spinning one frame per tick |

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
/grove group turn           persist one option, then reload
/grove group window 6       numbers are clamped to their range
/grove thinking label Plan  free text, quoted output, empty hides the label
/grove on | off | toggle
```

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
