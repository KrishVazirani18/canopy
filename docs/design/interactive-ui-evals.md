# Does Claude use widgets well? What was checked, and what changed

Companion to `interactive-ui.md`. The question is whether real Claude, given only the two tools' descriptions and the
guide, reaches for a widget when a visual beats text, leaves it alone otherwise, and writes it the way Canopy wants.

## How it is checked

`node scripts/widget-evals.mjs` runs a fixed set of prompts through Canopy's own engine (`Session`, so the same tools,
descriptions, settings and Claude Code a chat in Canopy has) against the real Claude, in a small made-up project
(`scripts/widget-evals/project`, copied to `/tmp` first). Each prompt is marked `widget` or `text`. For each one it
prints which tools were called, whether `read_me` came first, how the widget's HTML arrived (in how many steps, over
how long), any notes `show_widget` would have given back, and saves the widget's HTML.

It spends real usage (a few dollars for the full set on Opus 5.5 at High). Run it when the
descriptions (`src/core/widgets.mjs`) or the guide (`src/core/widget-guide.mjs`) change, not in `npm test`.

`node scripts/widget-examples.mjs <results dir>` then puts the widgets Claude wrote into the Playground (Widgets), so
they can be looked at in the real frame.

## The prompts

| id | Prompt | Should |
|---|---|---|
| csv | show me data/usage.csv | draw |
| compare-libs | compare zod, valibot and arktype for validating API input in this project. which should we use? | draw |
| settings-sketch | sketch what a settings screen for this API's admin panel could look like: rate limits, API keys, and a danger zone | draw |
| cost-trend | how has spend in data/usage.csv trended day by day, and which model drives it? | draw |
| copy-edit | here's our error message: "…" make it shorter and friendlier and show me what changed | draw |
| pick-approach | the orders endpoint needs pagination. lay out the options (offset, cursor, keyset) so I can pick one | draw |
| pricing-explorer | we pay $0.004 per order processed plus $200/month flat. help me get a feel for what the bill looks like between 10k and 500k orders a month | draw |
| arith | what's 2+2 | stay text |
| explain-error | explain the error in error.log | stay text |
| what-does | what does src/orders.js do? | stay text |
| small-list | what are the three dependencies or scripts in package.json worth knowing about? | stay text |
| flow | draw how a request to /api/orders flows through the code | stay text (a mermaid block) |
| yes-no | is express 5 stable enough to use in production? | stay text |
| rename | what would be a better name for loadOrders? | stay text |
| put-patch | what's the difference between PUT and PATCH? | stay text (added in round 2) |
| quick-pick | express or fastify for something this small? just tell me | stay text (added in round 2) |

## Round 1 (Opus 5.5 at High)

12 of 14 as expected. Nothing overused.

| id | Result | What Claude did |
|---|---|---|
| csv | drew | `read_me(table)`, then a `<canopy-table>` with caption, `sort`, `rows`; costs written as `$0.41` |
| settings-sketch | drew | `read_me(mockup)`, then 5.6 KB: `<canopy-tabs>` with three sections, switches, sliders, a select, working scripts, only the CSS variables and classes |
| cost-trend | drew | `read_me(chart)`, a stacked bar chart with `highlight`, and four `<canopy-stat>` under it |
| copy-edit | drew | `read_me(diff)`, `<canopy-diff split>` on one sentence |
| pricing-explorer | drew | `read_me(interactive, chart)`: a slider, three stats and a stacked area chart, with a script |
| compare-libs | **missed** | answered with a Markdown table, three columns of sentences |
| pick-approach | **missed** | the same: a Markdown table of sentences, then "which one?" |
| arith, explain-error, what-does, small-list, yes-no, rename | text | as they should |
| flow | text | a `mermaid` flowchart, which is what the description asks for |

What was good without any change:

- `read_me` was called before the first widget every time, with the right modules.
- Every widget used the components and the variables. None loaded anything from the network, wrote a color out, or
  used an element that does not exist, so `show_widget` had no notes to give.
- Plain prompts stayed plain. "Draw how a request flows" became a mermaid block, not a widget.

What was wrong, and what was changed:

1. **Comparisons came back as Markdown tables whose cells were sentences.** The description said `<canopy-choices>`
   was for options "the user has to weigh or pick between", and Claude read a comparison as a table. It now says in
   so many words that side-by-side cards are the answer to "compare these" and "lay out the options", in place of a
   Markdown table whose cells are sentences, and the don't-list says "a few rows of plain facts" rather than "a table
   of a few rows". The guide's module opens the same way and adds: keep cards to a label, a hint and three or four
   short points.
2. **The widget never streamed.** Its HTML arrived all at once, seconds after its title. The API sends a tool's
   argument only when the whole argument is written unless fine-grained tool streaming is on, and Claude Code leaves
   that off by default. Canopy now sets `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1` for its Claude Code
   processes (a value the user set is left alone). Measured on the csv prompt: off, the HTML landed in one piece; on,
   it grew in 59 steps over 6.2 seconds.
3. **A total was estimated, then corrected by showing a second widget.** On an earlier run of the csv prompt Claude
   put totals it had added up by eye above the table, noticed, and showed the table again with the right ones, leaving
   the wrong one above it. Two changes: the guide says every number in a widget is one that was read or worked out;
   and a widget shown again under the same title (a note in brackets at the end aside) takes the earlier one's place.
4. **A one-sentence rewrite was shown as two tinted lines.** `<canopy-diff>` compared lines only. It now marks the
   words that changed inside a changed line, and has `words` for prose: one flowing text, removals struck, additions
   marked. The guide points copy at `words`.
5. **The reply repeated the widget as a Markdown table** (pricing-explorer). The description now says not to repeat
   what the widget shows "in prose or as a Markdown table".
6. Found by looking at the real widgets in the frame: a label over its control (`label.stack`) broke its words onto
   two lines; with a `highlight`, the other series of a chart all took the same gray; a long hint with no spaces ran
   out of its card; counts written bare (`1830400`) are now shown with separators.

## Round 2 (same settings, after the changes)

The prompts the changes touch, plus text prompts to see that the stronger wording did not tip into overuse, two of
them new. 10 of 10 as expected.

| id | Result | What Claude did |
|---|---|---|
| compare-libs | drew | `<canopy-choices layout="cards">`, three cards of three or four short points, Zod `recommended`; the reply says why in a few lines |
| pick-approach | drew | the same shape, with a `question` and a `message` template |
| copy-edit | drew | `<canopy-diff words>` |
| csv, pricing-explorer | drew | as before |
| small-list, explain-error, rename, put-patch, quick-pick | text | none drew |

Then in the app itself (real chats in the same sample project): the csv, cost-trend and pick-approach
prompts drew as they streamed, a pick from the choices came back as the user's message and Claude carried on from
it, and the chats drew the same from history after a restart.

## Round 3 (Opus 5.5 at High): visual widgets

The description gained the moments a user would otherwise be asked in words about something judged by eye, and the
guide six modules (pick, compare, tune, markup, rank, motion); see `visual-widgets.md`. Fourteen prompts were added
(eleven that should draw, three that should stay text), and a prompt can now name the blocks a right answer uses:
drawing the wrong kind is its own verdict.

27 of 30 as expected, 0 the wrong kind, 0 overused.

| id | Result | What Claude did |
|---|---|---|
| font-pick, title-slide, accent-color | drew | `<canopy-pick>` with a `<canopy-preview>` of true-size `<canopy-scale>` options: a stand-in dashboard in each font, four full slides, the dashboard in each color |
| app-icon | drew | each icon large, at 64, 32 and 16px, and in a light and a dark dock |
| tune-spacing | drew | `<canopy-tune>` with three sliders on the order cards |
| markup-sketch | drew | the order page as a mockup inside `<canopy-markup>` |
| rank-roadmap | drew | `<canopy-rank>` in its suggested order, a reason per row |
| toast-motion | drew | a pick whose options play the toast on hover |
| remix-brand | drew | a pick of three full headers |
| headlines | **missed** | ten headlines as a list |
| keep-several | **missed** | decided for the user in prose |
| compare-libs | **missed** | a Markdown table of sentences |
| font-quick, color-name, hex-convert, and every round-1 text prompt | text | as they should |

Changed: the description names "headlines and copy shown in the page they go on", says a pick of several comes with
the suggestion ticked and that when the decision is the user's they make it with a click, and that options are never
a Markdown table of sentences (and a plain question is asked in words: Codex has no AskUserQuestion). Rerun on the
misses and five text prompts: 8 of 9; headlines and keep-several drew, nothing overused.

compare-libs ("which should we use?", with Zod already a dependency) draws about one time in four: 1 of 3 after the
change, and 1 of 5 with the round-2 description. Claude reads it as a request for a recommendation, which is
a fair answer; it is left.

Then the widgets Claude wrote were drawn by the real blocks (the Playground's Widgets page). Two fixes came from
looking: a pick of several now starts with the recommended options ticked, and hints wrap to two lines instead of
one. A review of a screenshot was checked end to end in the harness: a pin on the headline sent
`1. "Calm software for people who build with AI, every day." (h1): Headline is one line too long`, with the
screenshot and its pin attached as an image.

Codex (GPT-6.1 Sol, low effort, `scripts/codex-tools-smoke.mjs --widget`): called read_me, then show_widget with
three choice cards. GPT-6 Luna at low effort answered in text. The new prompts have not been run on Codex yet.

## Not yet seen

- A widget whose script fails on its own. No real widget's script failed in either round. The report back to Claude
  was checked in the app by asking for a failure on purpose ("call a function that is not defined"): the tool's result
  said "Its script failed when it ran: Uncaught ReferenceError: setup is not defined (line 2)", Claude fixed it and
  showed it again under the same title, and the fixed one took the broken one's place.
- The `diagram` module: the one diagram prompt rightly went to mermaid. An SVG prompt Mermaid cannot do belongs in
  the set.
- Other models. All runs were Opus 5.5 at High. Sonnet and Fable have not been run.
- Long conversations: whether Claude calls `read_me` again after the guide has been compacted away.

## The harness's own limits

It only lets Claude read (files, searches, shell commands that cannot write), so a run is not quite a chat in Full
Access. In round 1 it refused the shell entirely, which is why one reply says it added up by hand; from round 2 it
allows commands that read.
