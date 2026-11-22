# Visual widgets: building blocks the model composes

Status: built, in Claude and Codex chats. Extends `interactive-ui.md`. How it was checked against real
Claude: `interactive-ui-evals.md`, round 3. The target is the Playground's **Widgets, Next**
(`renderer/src/playground/mocks/widgets-next.tsx`): fifteen asks answered by widgets a model lays out itself.

## Why blocks, not more widgets

`<canopy-choices>` squeezes anything visual into a narrow card (a font question came back as four cards with a
thumbnail each). People judge designs in many ways: pick one, compare two in place, tune a value, remix parts, pin
notes on a design, rank, keep several, watch motion. One finished widget per way would never end. Instead the frame
gives a few blocks that do the hard, repeated parts (selection, keyboard, the confirm row, sending, locking, true-size
scaling, screenshots), and the model writes the layout and the content in the content's own colors and type.

## The blocks (renderer/src/frame/components)

Every block lives in the light DOM the model writes, so its own CSS can style everything; the blocks only add state
attributes, a confirm row, and behavior. Every block remembers its state across reloads (`rt.get/set`), locks once
sent, never sends without a click, and works with the keyboard.

### `<canopy-pick>`: pick on anything
```html
<canopy-pick question="Which title slide?" message="Go with {choice} for the title slide" button="Use {choice}">
  <canopy-preview>                                   <!-- optional: one cell, shows the option pointed at -->
    <canopy-scale for="Night Forest" width="1280" height="720">…slide…</canopy-scale>
    <canopy-scale for="Editorial" width="1280" height="720">…slide…</canopy-scale>
  </canopy-preview>
  <div class="row">
    <figure option="Night Forest" hint="Dark, the mark large" recommended>…thumbnail…</figure>
    <figure option="Editorial" hint="Warm paper, a serif">…thumbnail…</figure>
  </div>
</canopy-pick>
```
- Options are any descendants with `option="Label"` (also `value`, `hint`, `recommended`). Not inside a nested pick.
- On each option the block sets `aria-checked`, `data-picked` (picked), `data-shown` (what the preview shows: pointed
  at or focused, else last picked, else recommended, else first), `tabindex`, `role` (radio/checkbox). Default look:
  a quiet ring and background on hover/picked, overridable. A `recommended` option gets the signal dot after its
  label when it has a `hint` or when the block draws captions (`captions` attribute: the block appends label + hint
  under each option).
- `multiple`: several can be picked; button default "Use {count}". Until the user clicks, the `recommended` options
  start ticked: the model's suggestion, there to be changed.
- `<canopy-preview>` children with `for="Label"` are stacked in one grid cell; only the shown one is visible
  (opacity, no layout shift: the cell is as tall as the tallest). Anything inside a pick may also read
  `[data-shown]` / `[data-picked]` itself.
- Keyboard: arrows move (and point the preview), Space/Enter picks.
- Confirm row: right-aligned primary button; disabled until something is picked. `message` template: `{choice}`
  is the label(s) joined with ", ", `{count}` the number. Default message is the label(s).

### `<canopy-scale width height>`: true size, shrunk to fit
Lays its content out at `width`×`height` CSS px and scales it to the element's width. Reserves the aspect from the
first frame (`aspect-ratio`), so nothing jumps. Default 1280×800.

### `<canopy-compare>`: before and after
Two children (the first is before, the second after; `label` on each is shown above). A divider to drag (pointer and
arrow keys). Inside a pick, the after side can be a `<canopy-preview>`, so the chosen option is what is compared.

### `<canopy-tune>`: dial it in, send the values
```html
<canopy-tune message="Set the chat cards to {values}">
  <label>Corner radius <input type="range" name="radius" min="0" max="24" value="10" unit="px"></label>
  <label>Shadow <input type="checkbox" name="shadow"></label>
  <div class="card" style="border-radius: var(--radius); box-shadow: calc(var(--shadow) * 1px) …">…</div>
</canopy-tune>
```
- Every `input`/`select` with a `name` inside sets a CSS custom property `--<name>` on the block: number inputs and
  ranges as `<value><unit>`, checkboxes as `1`/`0`, colors and selects as the raw value. The preview reads `var(--x)`:
  no script needed. Each control also shows its current value next to it (`data-value` on the label).
- Confirm row: "Use these values", enabled once anything changed. `{values}` becomes `Corner radius 18px, Shadow on`
  (the label's text, else `aria-label`, else the name).

### `<canopy-markup>`: notes pinned on a design
Wraps any content (a mockup, a `<canopy-scale>`, a `<canopy-shot>`). Click drops a numbered pin; drag draws a box.
Each pin gets a note field in a list beside or below (the block lays this out). Pins and notes can be removed. Send:
```
Notes on <title or the shot's url>:
1. The headline "Calm software for…" (h1): one line too long
2. Box around the buttons: too close together
```
Each note names what is under it: inside the frame the block looks at `document.elementFromPoint` and describes the
element (its text, cut short, and its tag or role); on a `<canopy-shot>` it uses the shot's element map. When the
markup holds a `<canopy-shot>`, the message also carries the screenshot with the pins and boxes drawn on it (a PNG,
made on a canvas in the frame) as an image.

### `<canopy-review ref="look-3">`: the same, on a screenshot
Shorthand for `<canopy-markup><canopy-shot ref="look-3"></canopy-shot></canopy-markup>`.

### `<canopy-rank>`: drag into order
Children with `item="Label"` (and optional `hint`). Drag, or focus one and use Alt+↑/↓. Confirm row "Use this order";
message lists `1. A`, `2. B`… (`message` template with `{order}`).

### `<canopy-shot ref alt>`: a screenshot the model took
Shows a screenshot the `look` tool took in this chat. The model cannot write pixels into HTML, so it names the shot.

## Screenshots: look → shot store → frame

Built in `src/core/shots.mjs` (the store: per chat, newest 40, on disk under the app's data, at most 300 chats'
folders; a chat without an id yet keeps its shots under its own handle and they move to the id when it arrives) and
`src/look-capture.mjs` (`collectElements`, the element map). Page shots are kept at the captured CSS size so the
element boxes line up with the picture pixel for pixel. Not yet: a deleted chat's shots stay until the 300-chat
limit prunes them (there is no chat-deletion hook).

- `look` keeps every picture it takes for the chat under a ref: `look-1`, `look-2`… (per chat, newest 40, kept on
  disk in the app's data so a reopened chat still shows them). Its result text ends with one line:
  `Saved as shot "look-3": show it in a widget with <canopy-shot ref="look-3"> or <canopy-review ref="look-3">.`
- For a web page, look also records an element map at capture time: up to 400 visible elements as
  `{ x, y, w, h, tag, role, text, selector }` in CSS px of the picture.
- The window asks main for a shot: `api.widgetShot(sessionId, ref)` → `{ data: 'data:image/jpeg;base64,…', width,
  height, url, elements } | null`. The frame asks its host with the request `canopy/shot { ref }`; the host answers
  from `api.widgetShot` (the chat's own sessionId; never another chat's).

## Answers that carry pictures

`ui/message` may carry content blocks: `{ role: 'user', content: [{ type: 'text', text }, { type: 'image', data,
mimeType }] }` (data is base64, PNG or JPEG, at most 4 images, each at most 5 MB). The host turns the images into
the message's attachments (`store.dispatch(text, images)` / `enqueue`), exactly as if pasted.

## What the model is told (src/core/widgets.mjs, widget-guide.mjs)

- The always-loaded description says when, in the moments the user would otherwise be asked in words: about to ask
  which they prefer among things judged by eye (pick / compare), about to ask for a value (tune), about to ask what
  they think of something built (review / markup), about to ask for an order (rank), which to keep (pick multiple),
  how something should move (show it playing). And when not.
- `read_me` gains modules: `pick`, `compare`, `tune`, `markup` (incl. review and shots), `rank`, `motion`.
- `lintWidget` knows the new elements; `widgetOutline` describes them as text.

## Codex

Codex chats get `show_widget` and `read_me` through the tool relay (tool-registry.mjs), named so the window knows
them as `mcp__visualize__show_widget` / `mcp__visualize__read_me`, and draw exactly as Claude chats do, with the
script report going back the same way.

## How it is checked

- Unit tests for every pure part (message templates, value formatting, element description, outline, lint).
- `scripts/widget-evals.mjs` gains prompts for each way (pick visual, compare, tune, remix, markup/review, rank, keep
  several, motion) and more should-stay-text ones, run on Claude and Codex.
- The Playground's Widgets page shows real widgets in the real frame for every block.
