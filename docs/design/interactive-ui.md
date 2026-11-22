# Interactive UI in replies

Status: built, except hosting third-party MCP Apps, which the host is shaped for but
does not do yet (see MCP Apps). How it was checked against real Claude: `interactive-ui-evals.md`.

## What it is

Claude's replies in Canopy can hold live UI, not only text: a table you can sort, a chart you can read values off,
options you can pick, a before/after, a sketch of a screen. It draws itself as Claude writes it, looks like the rest
of Canopy, and can answer back. A terminal cannot do this. It is the thing Canopy does that Claude Code alone does not.

Three things draw in the same place, through one host:

1. **Claude's widgets.** Claude calls `show_widget` with an HTML fragment. Always available, in every chat.
2. **MCP Apps** (next). A connector's tool that declares a `ui://` page (SEP-1865) gets that page drawn where its step is.
3. Whatever comes after. The host only speaks the MCP Apps protocol, so anything that speaks it fits.

## How it is built

```
Claude writes show_widget { title, widget_code }
  └─ Claude Code streams the call ──► adapter.mjs: tool-input-partial events (the input so far, parsed from partial JSON)
       └─ store.ts: the widget's item exists from the first event; its input grows
            └─ transcript.tsx ──► WidgetFrame (the host): one sandboxed iframe, MCP Apps JSON-RPC over postMessage
                 └─ the shell (Canopy's own page inside the frame): Canopy's look, the components, and a runtime that
                    draws the fragment as it arrives and runs its scripts once it is complete
```

**The host** (`renderer/src/components/canopy/widget-frame.tsx`) is the only thing that touches the iframe. It answers
`ui/initialize`, sends `ui/notifications/tool-input-partial`, `tool-input`, `tool-result`, `host-context-changed`
(theme), and takes `ui/notifications/size-changed`, `ui/message`, `ui/open-link`, `tools/call`. It does not know what
is inside the frame.

**The shell** (`renderer/src/frame/`) is what is inside for Claude's widgets. It is an MCP App like any other: it gets
`{ title, widget_code }` as its tool input and draws it. It carries Canopy's tokens, Geist, styled plain elements and
the components. It is bundled to one string at build time (`canopyFrame` in `vite.config.ts`) and loaded as the
frame's `srcdoc`, so the frame never has a URL, a file path or an origin of its own.

**The tools** live in an in-process MCP server of their own, `visualize` (`src/core/widgets.mjs`), registered for every
chat beside Code Mode's `canopy` server. (One server could not hold both: the SDK will not swap a registered server's
tools, and Code Mode's comes and goes.) The names are the ones claude.ai gives the same two tools, so what Claude
already knows about when to draw carries over; what differs here is in the description and the guide.

- `show_widget { i_have_seen_read_me, title, widget_code }` draws the widget. The result is plain text: what was
  shown, as an outline, plus notes on anything that will not work (an element that does not exist, something from the
  network, colors written out), and, for a widget with a script, whether the script failed when the window ran it.
  So the chat reads fine in the terminal, and Claude hears about its mistakes in time to fix them in the same turn.
- `read_me { modules }` returns the design guide (`src/core/widget-guide.mjs`), by topic. The long guidance is only
  paid for when Claude is about to draw.
- A widget shown again under the same title takes the earlier one's place in the reply, so a fix replaces a mistake.

## It streams

- The API only sends a tool's argument once it is whole unless fine-grained tool streaming is on, and Claude Code
  leaves that off by default. Canopy turns it on for its Claude Code processes
  (`CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1`; a value the user set is left alone). Without it a widget
  appears all at once, seconds after its title.
- `adapter.mjs` already sees the tool's JSON arrive in pieces. For tools the session asks for, it now parses what has
  arrived so far (`partial-json.mjs`: close the open strings, objects and arrays) and emits `tool-input-partial`
  with the whole input so far, at most every 80 ms. Whole snapshots, not deltas: a missed or repeated event cannot
  corrupt anything, and a window that reloads mid-stream needs only the latest one.
- The store creates the widget's item at the first of these, so its place in the reply is taken before any HTML exists.
  `tool-start` later fills in the final input on the same item.
- The shell draws partial HTML safely: it cuts the text back to the last point that is whole (never half a tag, half an
  entity, a half-written style rule or an unfinished script), parses that, and morphs the page to match, touching
  only what changed. New elements ease in. Scripts run once, in order, when the full input has arrived.
- Height follows the content. The last height of every widget is remembered, so a chat opened from history reserves
  each widget's exact space before its frame loads: nothing jumps. Frames mount only when near the screen.

## The components

Claude writes HTML and SVG, which it already knows. Canopy adds custom elements for the things that are tedious or
easy to get wrong by hand, and that must look and behave exactly like the app. Each takes its data from plain
children, so it also streams.

| Element | For | Data |
|---|---|---|
| `<canopy-table>` | data to explore: sort, search, right-aligned numbers, "Show all N" past the first rows | CSV text, or a plain `<table>` |
| `<canopy-chart type="bar\|line\|area">` | numbers to compare: values on hover, direct labels | CSV text (first column is the label) |
| `<canopy-choices>` + `<canopy-choice>` | options to pick from, with anything inside each one; picking answers back | children |
| `<canopy-diff>` | before and after, of code (lines) or prose (`words`) | two `<pre>`, or one holding a unified diff |
| `<canopy-stat>` | a few headline numbers | attributes |
| `<canopy-tabs>` | several views in one place | `<section label>` children |

Plain `button`, `input`, `select`, `table`, `h3`, `code`, `kbd`, `hr`, `details` are styled to match, and a few classes
(`card`, `row`, `stack`, `grid`, `muted`, `faint`, `dot`) cover layout. Anything bespoke is plain HTML, CSS and SVG
with the CSS variables.

Look: Canopy's rules, enforced by the defaults rather than asked for. Neutral surfaces, gray text, Geist, one small
signal color (`--color-accent`, only ever a dot). Chart series are three steps of ink, not a palette (checked as an
ordinal ramp on both surfaces); a highlighted series is full ink with the rest stepped back. The CSS variables are
MCP Apps' standard names (`--color-text-primary`, `--color-background-secondary`, …), which are also the ones Claude
uses on claude.ai, so a widget written from habit already follows Canopy's theme.

## The bridge

MCP Apps' own messages (JSON-RPC 2.0 over `postMessage`), so one host serves Claude's widgets and third-party apps.

| Direction | Message | What Canopy does |
|---|---|---|
| frame → host | `ui/initialize` | answers with theme, CSS variables, locale, max height |
| host → frame | `ui/notifications/tool-input-partial` | the input so far, while Claude writes |
| host → frame | `ui/notifications/tool-input` | the full input |
| host → frame | `ui/notifications/tool-result` | the tool's result (MCP Apps) |
| host → frame | `ui/notifications/host-context-changed` | light/dark or tokens changed |
| frame → host | `ui/notifications/size-changed` | the frame takes that height |
| frame → host | `ui/message` | the user's next message (see below) |
| frame → host | `ui/open-link` | Canopy's own link confirm, then the browser |
| frame → host | `tools/call`, `resources/read` | MCP Apps only: through Claude Code's permission rules |
| frame → host | `notifications/message` | a script error: the widget is marked, the source is one click away |

Canopy's own shell adds what the standard has no word for: `canopy/state` (save a widget's state), `canopy/drawn`
(the widget is whole and its scripts have run, with any errors), and the saved state handed back under `_meta` in the
answer to `ui/initialize`. Third-party apps never see them.

Inside a widget, Claude's script gets one small object: `canopy.send(text)`, `canopy.state`, `canopy.setState(patch)`.
(`sendPrompt(text)`, claude.ai's name for the first, works too.)

## Answering back

- A widget's answer is the user's next message, sent the way the message box sends it: now if Claude is idle, queued
  if it is working. It shows as the user's own bubble. Nothing new to learn.
- `<canopy-choices>` writes that message itself from what was picked, so answers are consistent.
- After answering, the widget shows what was picked and goes quiet, like an answered question card.
- Only a real click can send (the shell checks for user activation, the host limits rate and length).
- When third-party apps are hosted, their `ui/message` will not send: it will land in the message box as a draft.

Claude's `show_widget` does not wait for an answer. It shows and ends its turn; the pick starts the next turn. A plain
question that must be answered before Claude can go on stays with `AskUserQuestion`, which is native, blocks, and
lights the sidebar's "needs you".

## Durable

- A saved chat keeps the tool call, so its widgets draw again from history through the same path, minus the streaming.
- What changed in a widget (sort, tab, what was picked, form values, its height) is saved per tool-call id in
  `localStorage`, newest few hundred kept. Tool-call ids are unique, so a forked or resumed chat keeps its state.
- The record of an answer is the user's message below it, which is in the transcript. The "answered" look on the
  widget is local to this Mac.

## Safe

- `sandbox="allow-scripts"` only: no same-origin, no forms, no popups, no top navigation. The frame's origin is opaque.
- A CSP in the frame: no network at all (`default-src 'none'`), inline script and style only, images and fonts from `data:`.
- The main process is the second wall: a frame inside the window can never navigate, and never makes a network request.
- Links go through `ui/open-link` to Canopy's link confirm. Only `http`, `https` and `mailto` open.
- Limits: 200 KB of HTML, 1600 px tall, 4000 characters per answer, one answer a second.
- A widget that draws nothing or throws is not an error card. It folds to one quiet line with its source one click away.
- The preload bridge is not present in sub-frames, and IPC already refuses anything but the main frame.

## Getting Claude to use it well

- The always-loaded description says when a visual beats text and when it does not, in a few lines, and names the
  components. The detail (attributes, examples, the look) is in `read_me`, by topic, and `show_widget` takes a flag
  (`i_have_seen_read_me`) that makes reading it first the natural thing to do. In every eval run it was read first.
- `show_widget` answers with notes when something will not work, so a mistake is corrected in the same turn.
- Division of labor, stated to Claude: Markdown table for a few rows; `mermaid` block for flowcharts and sequences;
  `AskUserQuestion` for a plain question; code blocks for code; `show_widget` when the user should see or play with it.
- Checked against real Claude with a fixed set of prompts, some that should draw and some that should not:
  `docs/design/interactive-ui-evals.md` holds the prompts, what happened, and what was changed because of it.

## MCP Apps

Not hosted yet. The host is built for it: it already speaks only MCP Apps' messages, and Canopy's own widgets run
through it as an MCP App. Claude Code has the other half ready: `mcpServerStatus()` reports which tools declare a UI
(`_meta.ui.resourceUri`), `readMcpResource()` reads the page, and `mcp_call` with `check_permissions` runs a tool
for an app under the user's permission rules, the way Code Mode's scripts already do. What is left:

1. Session: list the tools that have a UI, read a `ui://` page (cached per server), and follow those tools' input
   as it streams (the adapter's `inputStream` already takes any tool name).
2. WidgetFrame: a second kind of page. Third-party HTML as `srcdoc` with the standard's restrictive CSP put in front
   of it, the same sandbox, `tool-input` and then `tool-result` sent to it.
3. Transcript: a step whose tool has a UI draws as a frame under its row.
4. The app's own requests: `tools/call` through `mcp_call` (only tools of its own server that are visible to apps),
   `ui/message` as a draft in the message box, `ui/update-model-context` kept and sent with the next message.
5. A real app to test against: a connector whose tool declares a `ui://` page.

Two limits come with `srcdoc`: no network for apps that declare domains, and no storage (the frame has no origin).
Both go away if frames are served from an origin of their own (a custom protocol), which is the next step after this.

## What is built

Streaming widgets, the six components, answering back, history and state, the safety walls, text fallback and notes
in the tool result, the report back to Claude when a script fails, same-title replacement, the guide, the eval set,
Playground mocks for every component and state (the widgets in it are ones real Claude wrote).

## What is not

- Hosting third-party MCP Apps (above).
- A widget that blocks Claude's turn until answered (use `AskUserQuestion`).
- Fullscreen and picture-in-picture display modes.
- Syntax highlighting inside widgets (code belongs in the reply's code blocks).
- Widgets inside a subagent's own transcript.

## Open questions

- Fine-grained tool streaming is on for every tool call of every chat, not only widgets. Claude Code is built for
  it (it has the switch), but it is off by default there. If it ever misbehaves, the fallback is widgets that appear
  whole instead of drawing.
- The tools carry claude.ai's names (`visualize`, `show_widget`, `read_me`). That was chosen for what Claude already
  knows; it means a user's own MCP server called `visualize` would clash.
- "Answered" on a widget is remembered on this Mac only. Writing it into the transcript would need a marker inside
  the user's message, which would show in the terminal.
