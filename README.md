# pi-grove

Groups every tool call of a prompt into one clickable card, so the transcript reads as
narration instead of a stack of boxes.

```
| > 4 calls · read x4 · bash x3 · codemode x1 · grep x1 · <1s
| +- * codemode audit the funnel queries · read x3 · bash x2 · <1s
| |  +- * bash run the checks · 12 passed · 1s
```

Click the header to reveal every row, click a row to open one level, click again to close.
Nothing opens by default, so a long turn still costs four lines until you ask for detail.

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


## Glyphs

`icons` is what keeps the card short. With a Nerd Font one tool word becomes a single
glyph in that tool's own colour, one outcome word becomes a single mark, and a count
keeps its number. `auto` turns glyphs on only when the terminal can draw them; force
`ascii` to keep every word.

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
| `` | running |

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
