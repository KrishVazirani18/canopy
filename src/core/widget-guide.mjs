// The design guide Claude reads before it draws (the read_me tool in widgets.mjs). It is long, so it is not in the
// tool's description, where every turn of every chat would pay for it: Claude asks for it once, by topic.
// Every attribute named here exists in renderer/src/frame/components; widgets.test.mjs holds the two together.
// Wording was tuned against real Claude: docs/design/interactive-ui-evals.md says what changed and why.

export const GUIDE_MODULES = ['table', 'chart', 'choices', 'diff', 'mockup', 'diagram', 'interactive', 'pick', 'compare', 'tune', 'markup', 'rank', 'motion'];

const BASICS = `# Writing a widget for Canopy

## Shape
- A fragment, not a page: no <!doctype>, <html>, <head> or <body>. Order: a short <style> if you need one, then the markup, then <script> last.
- It appears as you write it, top to bottom. Put what matters first. Scripts run once, when everything has arrived.
- No network at all: no CDN scripts or styles, no fetch, no external images or fonts. No <form> submit, alert(), localStorage, <iframe> or position: fixed.
- The frame is as wide as the reply (about 700px, as little as 320px in a narrow pane) and as tall as its content. Use flex, grid and percentages so it reflows; no fixed width above 320px. Aim for under 500px tall: show fewer rows, or use <canopy-tabs>, before making the user scroll.
- The widget is the visual, your reply is the words. No title that repeats the tool's title, no explanation inside it, no "click a column to sort" hints.
- Every number in a widget is one you read or worked out, never an estimate. Totals over many rows are worked out with a tool first, or left out.
- To correct or refine a widget, show it again with the same title: it takes the earlier one's place.

## Look
Canopy is quiet and the frame already looks like it. Plain elements come styled: h3, p, small, a, button, input, select, textarea, table, code, pre, kbd, hr, details, label. Write as little CSS as you can and let them be.
- A design being judged (a slide, a brand board, a swatch, an icon, someone's product screen) is drawn in its own colors and fonts: that is what the user is looking at. Everything around it (captions, borders, controls) follows the rules below.
- Color: neutral surfaces and gray text. At most one small signal: a 6px dot or one highlighted thing, in var(--color-accent). No colored text, tinted cards, colored pills or badges, gradients, shadows or glows. Never write a color out (#fff, rgb(), a name): use the variables, which follow light and dark.
- Type: 13px/20px body, already set. Two weights only, 400 and 500. Sentence case. No emoji. Numbers in tables and stats are already tabular.
- Variables:
  text: --color-text-primary, --color-text-secondary, --color-text-tertiary
  surfaces: --color-background-primary (the page the widget sits on), --color-background-secondary (a raised card), --color-background-tertiary (a subtle fill: a track, a pressed row)
  lines: --color-border-tertiary (hairline, the usual one), --color-border-secondary (a control's border), --color-border-primary (strong)
  signal: --color-accent. For a status dot only: --color-text-success, --color-text-warning, --color-text-danger
  --font-sans, --font-mono, --border-radius-sm (4px), --border-radius-md (8px), --border-radius-lg (12px)
- Classes:
  card: a bordered panel with 16px padding
  grid: columns that fit the width, 12px apart (style="--min: 220px" sets the narrowest a column may be; default 160px)
  row: children in a line, centered, 8px apart. stack: children in a column, 8px apart
  muted, faint: secondary and tertiary text. mono. num: right-aligned tabular numbers
  dot: the 6px signal dot (add good, warn or bad for a status). primary: on a <button>, the one main action

## Components
Custom elements that look and behave like the rest of Canopy. Use them before writing your own markup for the same thing. Each has a module in this guide with its attributes.
- <canopy-table>: rows of data. Sorts, searches, right-aligns numbers, folds long tables. Data is CSV text inside it.
- <canopy-chart type="bar|line|area">: numbers to compare. Data is CSV text inside it.
- <canopy-stat label value delta>: one headline number. Put a few in a <div class="grid">.
- <canopy-choices> with <canopy-choice>: options the user picks from. Their pick comes back as their next message.
- <canopy-diff>: a before and after of text or code.
- <canopy-tabs>: several views in one place, one <section label="..."> each inside it.
- <canopy-pick>: any elements with option="…" become things to pick, with a preview that follows the pointer (<canopy-preview>). For anything judged by eye.
- <canopy-scale width height>: content laid out at its true size (a 1280×720 slide, a 390×844 phone) and shrunk to fit.
- <canopy-compare>: two things in the same place with a divider to drag. <canopy-tune>: controls that drive a live preview through CSS variables.
- <canopy-markup> / <canopy-review ref>: the user pins notes on a design or on a screenshot you took (<canopy-shot ref>). <canopy-rank>: items to drag into order.

## Answering back
canopy.send(text) sends text to you as the user's next message, shown in the chat as theirs. Call it only from a click the user meant (a button), never on load, and write the text the way they would say it: canopy.send('Go with the two-column layout'). End your turn after a widget that asks for a pick; the answer starts the next turn.`;

const MODULES = {
  table: `## <canopy-table>
For data with more than a few rows, or anything the user will want to sort or search. (A handful of rows with no numbers to compare is a Markdown table in your reply instead.)

<canopy-table caption="Slowest endpoints, last 7 days" sort="p95 ms desc" rows="8">
Endpoint,Calls,p95 ms,Errors
/api/search,48210,912,0.4%
/api/export,1204,2380,2.1%
"/api/items, bulk",9811,640,0.0%
</canopy-table>

- Content: CSV text, first line the column names. Quote a cell that has a comma ("a, b"); double a quote inside quotes (""). Tabs work in place of commas. HTML-escape < and & as usual.
- caption: one quiet line above it (what the data is, where it is from). Optional.
- sort="Column" or sort="Column desc": the order it starts in. The user re-sorts by clicking a column.
- rows="10": how many rows show before a "Show all" line (default 10). Search appears on its own past 10 rows.
- Numbers, money, percentages and durations are found per column, right-aligned, and sorted by value. Write them as you would read them (1,204 or 1204, $7.12, 2.1%, 912 ms). Do not pad or align the CSV by hand.
- Rich cells: put a plain <table> inside <canopy-table> instead of CSV and it gets the same sorting and folding, with your cells' HTML kept.
- Give it everything you have up to a few hundred rows; it folds. Do not truncate data to make it fit.`,

  chart: `## <canopy-chart>
For numbers whose shape matters: a trend, a comparison, a ranking. If the exact values matter more than the shape, use <canopy-table>; if there are only two or three numbers, use <canopy-stat> or a sentence.

<canopy-chart type="line" caption="Weekly active users" unit="users" highlight="2026">
Week,2025,2026
W1,1200,1810
W2,1260,1990
W3,1310,2240
</canopy-chart>

- Content: CSV. The first column is the label for each point or bar; every other column is a series, named by its header. One series is fine.
- type: bar (compare things), line (a trend over an ordered axis), area (a trend where the amount filled matters). Default bar.
- horizontal: on a bar chart, bars run sideways. Use it for a ranking, or when labels are long.
- stacked: on bar or area, series stack into a total.
- unit="ms": written after values. A currency sign (unit="$") goes before them.
- highlight="Series name" (or, with one series, a label): the one thing drawn in full ink while the rest step back. Series are shades of gray by design, and the only color is a dot at the highlighted line's end. Do not ask for colors.
- caption: one quiet line above it. height="240": the plot's height in px (default 220).
- Values appear on hover and series are labeled directly, so add no legend, axis titles or data labels of your own.
- Keep it readable: at most about 5 series, about 40 points on a line, about 12 bars per series. Aggregate before you chart.
- No charting library is available (no network). For a shape this cannot draw (scatter, a custom diagram), write inline SVG by hand.`,

  choices: `## <canopy-choices>
For two or more options set side by side: libraries, approaches with trade-offs, layouts, plans with costs. Use it whenever you would otherwise write a comparison table with sentences in its cells. The user's pick comes back as their next message. (A plain question with nothing to look at is AskUserQuestion, which also waits for the answer. This does not wait: show it, say which you would pick and why in a line or two, and end your turn.)

<canopy-choices question="Where should chat history live?" message="Go with {choice}">
  <canopy-choice label="SQLite" hint="A file next to the app" recommended>
    <ul><li>Zero setup, ships inside the app</li><li>One writer at a time</li></ul>
  </canopy-choice>
  <canopy-choice label="Postgres" hint="A server you run">
    <ul><li>Many writers, real queries</li><li>Something to install and keep running</li></ul>
  </canopy-choice>
</canopy-choices>

- <canopy-choices> attributes:
  question: a line above the options. Optional when your reply already asks.
  multiple: the user may pick several.
  layout="cards": options side by side as cards, for comparing (best for 2 to 4 options with content). Default is a list of rows.
  message="Go with {choice}": the message sent when they confirm; {choice} becomes the label (several are joined with commas). Default is just the label.
  button="Use this": the confirm button's words (default "Send").
- <canopy-choice> attributes: label (required, short), hint (one quiet line beside it), value (what {choice} becomes, if not the label), recommended (marks one with the signal dot; say why in your reply).
- Inside a <canopy-choice> put anything that helps them decide: a short list, a <canopy-stat>, a small mockup, an SVG. Keep each option to the same shape so they compare.
- Keep cards short: a label, a hint, three or four points of a few words each. The detail goes in your reply.
- After the user answers, the widget shows their pick and locks. Do not add your own buttons for picking.
- Only laying things side by side, with nothing to choose? Use the same shape without the control: <div class="grid"> of <div class="card">.`,

  diff: `## <canopy-diff>
For a change the user should read as a change: wording, config, a function. (To show code you wrote, use a code block in your reply. To show what you changed in files, Canopy already has a Changes view.)

<canopy-diff file="pricing.md">
<pre>Starter: $9 per month
Up to 3 projects</pre>
<pre>Starter: $12 per month
Up to 5 projects
Cancel any time</pre>
</canopy-diff>

- Two <pre> blocks: the first is before, the second is after. The component works out what changed. HTML-escape < and & inside them.
- One <pre> block holding a unified diff (lines starting with +, - or a space) is drawn as it is.
- file: a quiet title line. Optional.
- words: for prose (a sentence or a paragraph reworded). One flowing text, with what was removed struck through and what was added marked. Use it for copy; lines are for code and config.
- split: before and after side by side instead of one column, for code with short lines.`,

  mockup: `## Mockups
A sketch of a screen or component, in plain HTML with the styled elements and classes. It should read as a real piece of the app at true size, not a wireframe and not a picture of a window.

<div class="card stack" style="max-width: 420px">
  <h3>Notifications</h3>
  <label class="row" style="justify-content: space-between">When a chat finishes <input type="checkbox" role="switch" checked></label>
  <label class="row" style="justify-content: space-between">When a chat needs you <input type="checkbox" role="switch" checked></label>
  <hr>
  <label class="stack">Sound <select><option>Chime</option><option>None</option></select></label>
  <div class="row" style="justify-content: flex-end"><button>Cancel</button><button class="primary">Save</button></div>
</div>

- Controls that come styled: button (add class primary for the main one), input (text, number, search), textarea, select, input type=checkbox, type=radio and type=range, and a switch (<input type="checkbox" role="switch">). Wrap a control and its words in <label>: class row puts them on one line, class stack puts the control under its words.
- Make it work enough to feel real: switches toggle and sliders slide on their own. Add script only for what the sketch is about.
- Show one screen. To let the user choose between versions, draw each as an option in a <canopy-pick> (read the pick module); to ask for notes on it, wrap it in <canopy-markup>.
- Do not draw window chrome, device frames, fake cursors or lorem ipsum. Use realistic words and numbers from the task.
- An icon is an inline <svg> of 16px, stroke="currentColor", fill="none", stroke-width="1.5". Keep them few and simple.`,

  diagram: `## Diagrams
A flowchart, sequence, state machine or entity diagram is a \`\`\`mermaid block in your reply, not a widget: Canopy draws those natively and lays them out for you. Use a widget with inline SVG only for a picture Mermaid cannot make: a layout, a timeline, an annotated shape, a custom illustration.

<svg viewBox="0 0 680 120" role="img" aria-label="Request path">
  <rect class="box" x="10" y="30" width="150" height="56" rx="8"/><text x="85" y="62" text-anchor="middle">Browser</text>
  <path class="line" d="M160 58H258" marker-end="url(#arrow)"/>
  <rect class="box" x="260" y="30" width="150" height="56" rx="8"/><text x="335" y="62" text-anchor="middle">Edge cache</text>
</svg>

- Give the <svg> a viewBox about 680 wide and no width or height attributes: it scales to the frame.
- Pre-made SVG classes: box (a node: card fill, hairline stroke), line (a connector: 1.2px, secondary ink, no fill), dash (a dashed connector), and marker id "arrow" for marker-end. <text> is already 13px in the primary ink; add class muted or faint for quieter labels.
- Ink only. One element may use var(--color-accent) if one thing must stand out.
- Leave 24px between boxes, keep every label inside its box (about 7px per character), and never let lines cross text.`,

  pick: `## <canopy-pick>: options judged by eye
For any choice the user makes by looking: fonts, colors, slides, icons, brands, layouts, copy in place. You lay the options out; the pick handles selecting, the keyboard, the confirm button and sending. (Trade-offs in words, like libraries or approaches, are <canopy-choices>.)

<canopy-pick question="Which title slide?" message="Go with {choice} for the title slide" button="Use {choice}">
  <canopy-preview>
    <canopy-scale for="Night Forest" width="1280" height="720"><div style="height:100%;display:grid;place-items:center;background:#0c1712;color:#eef5f0;font:600 140px/1 -apple-system">Canopy</div></canopy-scale>
    <canopy-scale for="Editorial" width="1280" height="720"><div style="height:100%;padding:88px;background:#f3eee4;color:#1c1a15;font:100px/1.05 ui-serif, Georgia, serif">Calm software for people who build with AI.</div></canopy-scale>
  </canopy-preview>
  <div class="grid" style="--min: 140px">
    <div option="Night Forest" hint="Dark, the mark large" recommended><canopy-scale width="1280" height="720"><div style="height:100%;background:#0c1712"></div></canopy-scale></div>
    <div option="Editorial" hint="Warm paper, a serif"><canopy-scale width="1280" height="720"><div style="height:100%;background:#f3eee4"></div></canopy-scale></div>
  </div>
</canopy-pick>

- Any element inside with option="Label" is an option. Optional: hint (a quiet line), value (what {choice} becomes, if not the label), recommended (the signal dot; say why in your reply). Labels are short and unique.
- An option with a hint gets its label, hint and (if recommended) the dot drawn under it; add captions to the pick to draw labels for options without hints, or captions="off" when your layout already shows them. The pick rings the picked one and sets data-picked and data-shown on options for your own CSS.
- <canopy-preview> (optional) shows, in one place, its child whose for= matches the option pointed at, else the picked one, else the recommended one. Every child is drawn in the same spot, so nothing jumps. Use it when options are too detailed to judge as thumbnails.
- Draw each option the way it would really look, where it will live: a font in a real paragraph, an icon in a dock and at 16px, a headline in its page, a card in its feed, a color on the screen it colors. Real size inside <canopy-scale>; never a gray box labelled "image".
- multiple: the user keeps several (the button says how many). message="…{choice}…" is what is sent ({choice} is the labels joined by commas, {count} how many). button="Use {choice}" is the button's words.
- Three or four options. More than six is a list, not a choice.`,

  compare: `## <canopy-compare>: two things in the same place
For a change you judge by looking at both at once: a font against today's, a redesign against the current screen, two crops. The user drags a divider across.

<canopy-compare>
  <div label="Now · Geist" style="font-family: Geist, system-ui"><h3>Fix the Font Picker</h3><p>I moved the restart card into main, so a reload keeps it.</p></div>
  <div label="SF Pro" style="font-family: -apple-system, system-ui"><h3>Fix the Font Picker</h3><p>I moved the restart card into main, so a reload keeps it.</p></div>
</canopy-compare>

- Exactly two children: before first, after second. label= on each is shown above it.
- Make both the same size and the same content, so only the difference moves (a fixed height, the same words).
- Inside a <canopy-pick>, the second child can be a <canopy-preview>: the option pointed at is what is compared against the first.`,

  tune: `## <canopy-tune>: dial it in
For a value the user would otherwise have to say in numbers: a radius, padding, a font size, a color, a speed. Controls drive a live preview; the values are sent back.

<canopy-tune message="Set the chat cards to {values}">
  <label class="row">Corner radius <input type="range" name="radius" min="0" max="24" value="10" unit="px"></label>
  <label class="row">Padding <input type="range" name="pad" min="8" max="28" value="14" unit="px"></label>
  <label class="row">Shadow <input type="checkbox" role="switch" name="shadow"></label>
  <div class="card" style="border-radius: var(--radius); padding: var(--pad); box-shadow: 0 8px 20px -8px rgb(0 0 0 / calc(var(--shadow) * 0.5))">Launch Deck · Done 1h</div>
</canopy-tune>

- Every input or select with a name sets --name on the tune: a range or number as its value plus unit="…", a checkbox as 1 or 0, a color or select as its value. Style the preview with var(--name); no script needed.
- Start at today's values, so "Use these values" means a change. {values} becomes "Corner radius 18px, Padding 14px, Shadow on" (each control's label).
- One idea per tune, two to five controls. Preview the real thing (the actual card, button, page section), not a generic box.`,

  markup: `## <canopy-review> and <canopy-markup>: notes where they apply
For asking what the user thinks of something you built. They click to pin a note, or drag a box, and type; you get each note with what was under it.

<canopy-review ref="look-3" message="Changes to the landing page"></canopy-review>

- After look, its result names the screenshot it saved ("look-3"). <canopy-review ref="look-3"> shows that screenshot to mark up; the answer carries the notes, the element under each pin (on a web page), and the screenshot with the pins drawn on it. Use it after you change something visual and want the user's eye, instead of asking "how does it look?".
- <canopy-shot ref="look-3"> shows a screenshot without notes (inside a pick, a compare, a before and after).
- <canopy-markup title="Order details page"> does the same on anything you draw: wrap a mockup (often in <canopy-scale>) in it. Notes name the text or element under each pin; title names the design in the answer.
- One design per widget. Take the screenshot at the size it will be seen.`,

  rank: `## <canopy-rank>: drag into order
For "what first?": priorities, steps, a reading order. The user drags (or uses Alt+arrows) and sends the order.

<canopy-rank message="Do them in this order: {order}">
  <div item="Visual widgets" hint="Pick, tune, mark up"></div>
  <div item="Widgets in Codex chats" hint="Same blocks for OpenAI"></div>
  <div item="Download site" hint="Quiet launch page"></div>
</canopy-rank>

- Children with item="Label" (and an optional hint) are the rows, in your suggested order; the rank draws them. Anything else inside an item is shown in its row.
- {order} becomes "1. Visual widgets, 2. …". Three to eight items.`,

  motion: `## Motion: show it moving
For how something should appear, move or respond: each option plays, so it is judged moving, not described. Put each in a <canopy-pick> option and play it with CSS on hover and focus.

<style>
[option]:hover .rise, [option]:focus .rise { animation: rise 220ms cubic-bezier(.2,.8,.2,1) both }
[option]:hover .fade, [option]:focus .fade { animation: fade 150ms ease-out both }
@keyframes rise { from { opacity: 0; transform: translateY(8px) } }
@keyframes fade { from { opacity: 0 } }
</style>
<canopy-pick question="How should cards appear?" message="Cards should enter with {choice}">
  <div option="Rise" hint="8px up, 220ms" recommended><div class="card rise">Restart when done</div></div>
  <div option="Fade" hint="150ms, nothing moves"><div class="card fade">Restart when done</div></div>
</canopy-pick>

- Play on hover and focus, once per visit; never loop forever. Name the timing in the hint.
- Animate the real thing (the actual card or menu), in a stage of the size it lives in.
- prefers-reduced-motion is respected by the frame; write the end state as the element's normal style.`,

  interactive: `## Interactive widgets
For an idea that is easier to play with than to read: a slider that changes a number, a toggle between two states, a small calculator or simulation.

<label class="stack">Monthly users <input id="users" type="range" min="1000" max="100000" step="1000" value="20000"></label>
<div class="grid"><canopy-stat id="cost" label="Monthly cost" value=""></canopy-stat><canopy-stat id="per" label="Per user" value=""></canopy-stat></div>
<script>
const users = document.getElementById('users');
function draw() {
  const n = +users.value, cost = 40 + n * 0.012;
  document.getElementById('cost').setAttribute('value', '$' + cost.toFixed(0));
  document.getElementById('per').setAttribute('value', '$' + (cost / n).toFixed(4));
}
users.addEventListener('input', draw);
draw();
</script>

- One <script>, last, plain JavaScript, no imports. Find elements by id. Components update when you set their attributes or replace their text (a <canopy-chart>'s CSV, a <canopy-stat>'s value).
- The script runs once, after the whole widget has arrived, so the markup must look right on its own before that: put real starting values in the HTML.
- Form controls remember their values when the chat is reopened; after restoring them Canopy fires their input events, so derive everything on screen from the controls in one draw() function, as above.
- canopy.state holds anything else you saved with canopy.setState({ step: 2 }); it is {} the first time.
- canopy.send(text) answers back as the user (see Answering back). Only from a click.
- Keep it small: one idea, a few controls. No animation loops that run forever, no timers faster than a second.`,
};

/** The guide for these modules: the basics, then each module asked for, in a fixed order. Unknown names are skipped. */
export function guideText(modules) {
  const asked = new Set(Array.isArray(modules) ? modules : []);
  const parts = [BASICS, ...GUIDE_MODULES.filter((m) => asked.has(m)).map((m) => MODULES[m])];
  const rest = GUIDE_MODULES.filter((m) => !asked.has(m));
  if (rest.length) parts.push(`Other modules, when you need them: ${rest.join(', ')}.`);
  return parts.join('\n\n');
}
