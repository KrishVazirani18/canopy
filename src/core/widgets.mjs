// Widgets: Claude shows the user something visual, drawn inline in the chat (docs/design/interactive-ui.md).
//
//  - createWidgetServer()  an in-process MCP server that is always registered, with two tools:
//                            show_widget { i_have_seen_read_me, title, widget_code }  draws an HTML fragment
//                            read_me { modules }                                      the design guide, by topic
//                          The names are the ones claude.ai gives the same two tools, so what Claude already knows
//                          about when to draw carries over. What differs here (Canopy's components, no network) is
//                          in the description and the guide.
//  - SHOW_WIDGET / READ_ME  the same two tools, defined once for every engine (tool-registry.mjs): a Codex chat has
//                          them through the relay, and the window draws them under the same names.
//  - showResult()          what the model, and a reader in the terminal, get back: a plain-text outline of what was
//                          shown, and notes on anything in it that will not work.
//  - widgetOutline() / lintWidget()  the two halves of that.
// The drawing itself happens in the window (renderer/src/frame). Nothing here renders anything.
import { defineTool, sdkTool } from './tool-registry.mjs';
import { GUIDE_MODULES, guideText } from './widget-guide.mjs';

const soft = async (f) => { try { return await import(f); } catch (err) { return { __missing: String(err?.message ?? err) }; } };
const [sdk, zod] = await Promise.all([soft('@anthropic-ai/claude-agent-sdk'), soft('zod')]);

/** What this build lacks to offer widgets, or null. */
export const WIDGETS_MISSING = !sdk.createSdkMcpServer || !sdk.tool ? 'sdk' : !zod.z ? 'zod' : null;
export const UI_SERVER = 'visualize';
export const SHOW_TOOL = `mcp__${UI_SERVER}__show_widget`;
export const GUIDE_TOOL = `mcp__${UI_SERVER}__read_me`;
export const HTML_LIMIT = 200_000;
const TITLE_LIMIT = 120;
const OUTLINE_LIMIT = 700;
const OUTLINE_ROWS = 6;

/** The elements the frame knows (renderer/src/frame/components). Anything else starting with canopy- is a mistake. */
export const COMPONENTS = ['canopy-table', 'canopy-chart', 'canopy-choices', 'canopy-choice', 'canopy-diff', 'canopy-stat', 'canopy-tabs',
  'canopy-pick', 'canopy-preview', 'canopy-scale', 'canopy-compare', 'canopy-tune', 'canopy-markup', 'canopy-review', 'canopy-rank', 'canopy-shot'];
/** Blocks whose content is a design being judged: inside them, the content's own colors and fonts are the point. */
const DESIGN_BLOCKS = /<canopy-(?:pick|preview|scale|compare|tune|markup|review)\b/i;

export const SHOW_DESCRIPTION = `Show the user something visual, drawn inline in the chat as you write it: a table they can sort, a chart, options side by side, a before and after, a sketch of a screen, a small interactive explainer.

Reach for it without being asked when seeing beats reading:
- data with more than a few rows, or numbers worth comparing: <canopy-table>, <canopy-chart>, <canopy-stat>
- two or more options, tools or approaches to weigh or pick between: <canopy-choices layout="cards">, one card each with its trade-offs. This is the answer to "compare these" and "lay out the options", in place of a Markdown table whose cells are sentences, and the user picks with a click
- how something looks or would look (a screen, a layout, a component): a mockup in plain HTML
- a change to text or code they should see as a change: <canopy-diff>
- an idea that is easier to play with than to read: sliders, toggles, a small simulation
And whenever you are about to ask the user, in words, about something they judge by eye:
- which one they prefer (fonts, colors, slides, logos, brands, layouts, headlines and copy shown in the page they go on): <canopy-pick>, each option drawn as it would really look, at true size with <canopy-scale>; to judge one against another in place, <canopy-compare>
- a value (a size, spacing, a color, a speed): <canopy-tune>, controls on a live preview that send the values
- what they think of something you built or a screenshot you took: <canopy-review> on the shot, or <canopy-markup> on a mockup, so they pin notes where they apply
- what order to do things in: <canopy-rank>. Which of several to keep or cut: <canopy-pick multiple> with your suggestion ticked (recommended)
When the decision is theirs, let them make it with a click: give your recommendation in a line, not instead of the choice.
- how something should move: show each option playing
Do not use it when text does the job: an answer of a sentence or two, an explanation, a short list, code (a code block), a few rows of plain facts (a Markdown table), a flowchart or sequence diagram (a \`\`\`mermaid block), a plain question with nothing to look at (ask it in words), or when the user asked for a quick answer. Options to weigh are never a Markdown table whose cells are sentences. Never draw with ASCII art instead. One widget per idea. Say the takeaway in your reply in a line or two, and do not repeat what the widget shows, in prose or as a Markdown table. Showing a widget again with the same title replaces the earlier one.

widget_code is an HTML fragment (no <html>, <head> or <body>): a short <style> first if you need one, then markup, then <script> last. It appears as you write it, top to bottom; scripts run once it is complete. It runs in a sandboxed frame that already looks like Canopy and has no network: no CDN scripts, fetch, external images or fonts.

Call read_me before your first widget in a conversation. It has the components' attributes, the CSS variables and the look to follow; without it the widget will not match the app.`;

export const GUIDE_DESCRIPTION = `How to write widgets for show_widget: Canopy's components and their attributes, the CSS variables, and the design rules. Call it once per conversation, before the first show_widget, naming the modules for what you are about to draw. Call it again only for a module you have not read.`;

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const num = (n) => Number(n).toLocaleString('en-US');
const toolResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError && { isError: true }) });

// ---- a widget as plain text ----

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', ndash: '–', mdash: '—', hellip: '…', rarr: '→', larr: '←', times: '×' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
  const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  try { return Number.isFinite(code) ? String.fromCodePoint(code) : m; } catch { return m; }
});
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
};
/**
 * Every element whose opening tag matches `open` (with its tag name as group 1), replaced, content and all, by
 * `fn(openingTag)`. Nested elements of the same name are counted, so a <div option> holding <div>s ends where it ends.
 */
function replaceElements(s, open, fn) {
  let out = '';
  let at = 0;
  const re = new RegExp(open.source, 'gi');
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index < at) continue;
    const name = m[1].toLowerCase();
    const tags = new RegExp(`<(/?)${name}\\b[^>]*?(/?)>`, 'gi');
    tags.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = s.length;
    for (let t = tags.exec(s); t; t = tags.exec(s)) {
      if (t[2]) continue; // <x/> opens and closes
      depth += t[1] ? -1 : 1;
      if (!depth) { end = t.index + t[0].length; break; }
    }
    out += s.slice(at, m.index) + fn(m[0]);
    at = end;
    re.lastIndex = end;
  }
  return out + s.slice(at);
}
const stripTags = (s) => decode(s.replace(/<[^>]*>/g, ' ')).replace(/[ \t]+/g, ' ').trim();

// One CSV line into its cells. Quoted cells may hold commas and doubled quotes; that is all a summary needs.
function cells(line, sep) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c; }
    else if (c === '"' && !cur) quoted = true;
    else if (c === sep) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

// Rows of data as a few aligned-enough lines: the header, the first rows, and how many more there are.
function rowsText(rows) {
  const shown = rows.slice(0, OUTLINE_ROWS + 1).map((r) => r.join(' | '));
  const more = rows.length - shown.length;
  if (more > 0) shown.push(`… ${num(more)} more row${more === 1 ? '' : 's'}`);
  return shown.join('\n');
}

function dataText(inner) {
  if (/<table[\s>]/i.test(inner)) {
    const rows = [...inner.matchAll(/<tr[\s>][\s\S]*?(?=<tr[\s>]|<\/table|$)/gi)]
      .map((r) => [...r[0].matchAll(/<t[hd][^>]*>([\s\S]*?)(?=<\/t[hd]>|<t[hd][\s>]|<\/tr|$)/gi)].map((c) => stripTags(c[1])))
      .filter((r) => r.length);
    return rowsText(rows);
  }
  const lines = decode(inner.replace(/<[^>]*>/g, '')).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const sep = lines[0].includes('\t') ? '\t' : ',';
  return rowsText(lines.map((l) => cells(l, sep)));
}

/**
 * What a widget says, as plain text: for the terminal, where the same chat shows the tool's result and nothing else,
 * and for anything that reads the transcript. An outline, not a rendering: tables keep their first rows, choices
 * their labels, everything else its words.
 */
export function widgetOutline(html, { limit = OUTLINE_LIMIT } = {}) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<(style|script)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  const blocks = [];
  const keep = (text) => { blocks.push(text); return `\n\u0000${blocks.length - 1}\u0000\n`; };
  s = s.replace(/<canopy-(table|chart)\b([^>]*)>([\s\S]*?)(?:<\/canopy-\1\s*>|$)/gi, (m, kind, tag, inner) => {
    const caption = attr(` ${tag}`, 'caption');
    const head = [kind === 'chart' ? `Chart${attr(` ${tag}`, 'type') ? ` (${attr(` ${tag}`, 'type')})` : ''}` : '', caption].filter(Boolean).join(': ');
    return keep([head, dataText(inner)].filter(Boolean).join('\n'));
  });
  s = s.replace(/<canopy-diff\b([^>]*)>[\s\S]*?(?:<\/canopy-diff\s*>|$)/gi, (m, tag) => keep(`Before and after${attr(` ${tag}`, 'file') ? `: ${attr(` ${tag}`, 'file')}` : ''}`));
  s = s.replace(/<canopy-stat\b([^>]*)>(?:\s*<\/canopy-stat\s*>)?/gi, (m, tag) => {
    const t = ` ${tag}`;
    return keep(`${attr(t, 'label')}: ${attr(t, 'value')}${attr(t, 'delta') ? ` (${attr(t, 'delta')})` : ''}`);
  });
  s = s.replace(/<canopy-choices\b([^>]*)>/gi, (m, tag) => (attr(` ${tag}`, 'question') ? keep(attr(` ${tag}`, 'question')) : '\n'));
  // The visual blocks: what is being asked, and each option, item or control by its words. Previews and scaled
  // content say nothing more than their option's label already does.
  s = s.replace(/<canopy-preview\b[\s\S]*?(?:<\/canopy-preview\s*>|$)/gi, '\n');
  s = s.replace(/<canopy-pick\b([^>]*)>/gi, (m, tag) => {
    const t = ` ${tag}`;
    const q = attr(t, 'question');
    return keep([q || (/\smultiple\b/i.test(t) ? 'Pick any:' : 'Pick one:'), q && /\smultiple\b/i.test(t) ? '(pick any)' : ''].filter(Boolean).join(' '));
  });
  s = replaceElements(s, /<([a-z][\w-]*)\b[^>]*\soption\s*=[^>]*>/, (tag) => {
    const label = attr(tag, 'option');
    return `\n- ${[label, attr(tag, 'hint')].filter(Boolean).join(': ')}${/\srecommended\b/i.test(tag) ? ' (recommended)' : ''}\n`;
  });
  s = s.replace(/<canopy-rank\b([^>]*)>/gi, (m, tag) => keep(attr(` ${tag}`, 'question') || 'In order:'));
  s = replaceElements(s, /<([a-z][\w-]*)\b[^>]*\sitem\s*=[^>]*>/, (tag) => `\n- ${[attr(tag, 'item'), attr(tag, 'hint')].filter(Boolean).join(': ')}\n`);
  s = s.replace(/<canopy-tune\b([^>]*)>/gi, (m, tag) => keep(attr(` ${tag}`, 'question') || 'Values to tune:'));
  s = s.replace(/<canopy-compare\b([^>]*)>/gi, '\nBefore and after:\n');
  s = s.replace(/<canopy-(review|shot)\b([^>]*)>(?:\s*<\/canopy-\1\s*>)?/gi, (m, kind, tag) => keep(`${kind === 'review' ? 'Notes on screenshot' : 'Screenshot'} ${attr(` ${tag}`, 'ref') || '(no ref)'}`));
  s = s.replace(/<canopy-markup\b([^>]*)>/gi, '\nNotes pinned on:\n');
  s = s.replace(/<canopy-scale\b[^>]*>/gi, '\n');
  s = s.replace(/<canopy-choice\b([^>]*)>/gi, (m, tag) => {
    const t = ` ${tag}`;
    const label = attr(t, 'label') || attr(t, 'value');
    return `\n- ${[label, attr(t, 'hint')].filter(Boolean).join(': ')}${label ? ' ' : ''}`;
  });
  s = s.replace(/<section\b([^>]*)>/gi, (m, tag) => { const name = attr(` ${tag}`, 'label') || attr(` ${tag}`, 'title'); return name ? keep(`${name}:`) : '\n'; });
  s = s.replace(/<table\b[\s\S]*?(?:<\/table\s*>|$)/gi, (m) => keep(dataText(m)));
  s = s.replace(/<(input|textarea|select)\b[^>]*>/gi, (m) => (attr(m, 'placeholder') || attr(m, 'aria-label') ? ` [${attr(m, 'placeholder') || attr(m, 'aria-label')}] ` : ' '));
  s = s.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<(br|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/?(p|div|section|article|header|footer|h[1-6]|ul|ol|tr|pre|details|summary|button|label|canopy-[a-z]+|text|g|svg)\b[^>]*>/gi, '\n');
  s = decode(s.replace(/<[^>]*>/g, ' '));
  const lines = s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean)
    .map((l) => l.replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[Number(i)] ?? '')).filter(Boolean);
  // The same words twice in a row (a label repeated by its control) say nothing new.
  const text = lines.filter((l, i) => l !== lines[i - 1]).join('\n');
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return `${cut.slice(0, Math.max(cut.lastIndexOf('\n'), limit - 120))}\n…`;
}

// ---- what will not work ----

const COLOR = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/gi;

/**
 * Mistakes that can be read off the text of a widget, each as a sentence the model can act on. The frame draws
 * what it can either way; these go back with the tool's result so the next widget (or a second try) is right.
 * @returns {string[]}
 */
export function lintWidget(html) {
  const s = String(html ?? '');
  const notes = [];
  const quiet = s.replace(/<!--[\s\S]*?-->/g, '');
  if (/<(?:!doctype|html|head|body)\b/i.test(quiet)) notes.push('Send a fragment, not a page: <!doctype>, <html>, <head> and <body> are dropped.');
  const remote = [...quiet.matchAll(/<(script|link|img|iframe|video|audio|source|embed|object)\b[^>]*?\s(?:src|href|data)\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>]+)/gi)];
  const cssRemote = [...quiet.matchAll(/(?:@import\s+(?:url\()?|url\()\s*["']?\s*((?:https?:)?\/\/[^"')\s]+)/gi)];
  const urls = [...new Set([...remote.map((m) => m[2]), ...cssRemote.map((m) => m[1])])];
  if (urls.length) notes.push(`The frame has no network, so ${urls.length === 1 ? 'this does' : 'these do'} not load: ${urls.slice(0, 3).join(', ')}${urls.length > 3 ? ', …' : ''}. Inline what you need; for charts use <canopy-chart>.`);
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\s*\(|\bimport\s*\(|\bnavigator\.sendBeacon\b/.test(quiet)) notes.push('The frame has no network: fetch, XMLHttpRequest, WebSocket and import() fail. Put the data in the widget.');
  const unknown = [...new Set([...quiet.matchAll(/<(canopy-[a-z0-9-]+)\b/gi)].map((m) => m[1].toLowerCase()).filter((t) => !COMPONENTS.includes(t)))];
  if (unknown.length) notes.push(`There is no <${unknown.join('>, <')}>. The components are: ${COMPONENTS.filter((c) => c !== 'canopy-choice').map((c) => `<${c}>`).join(', ')}.`);
  if (/<iframe\b|<object\b|<embed\b/i.test(quiet)) notes.push('<iframe>, <object> and <embed> are not drawn.');
  if (/<form\b/i.test(quiet)) notes.push('A <form> cannot submit in the frame. Use plain inputs and a <button> that calls canopy.send(text).');
  if (/\b(?:alert|confirm|prompt)\s*\(/.test(quiet.replace(/sendPrompt\s*\(/g, ''))) notes.push('alert(), confirm() and prompt() do nothing in the frame.');
  if (/\b(?:localStorage|sessionStorage|indexedDB)\b|document\.cookie/.test(quiet)) notes.push('localStorage, sessionStorage and cookies throw in the frame. Use canopy.state and canopy.setState({...}) to remember things.');
  if (/position\s*:\s*fixed/i.test(quiet)) notes.push('position: fixed does not work in the frame (it has no viewport of its own). Lay it out in normal flow.');
  // Colors written out do not follow the theme. A couple are let through (an SVG illustration may need them).
  const styled = [...quiet.matchAll(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi)].map((m) => m[1]).join('\n')
    + [...quiet.matchAll(/\s(?:style|fill|stroke|color|bgcolor|stop-color)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2]).join('\n');
  const colors = styled.match(COLOR) ?? [];
  // A design being judged (a slide, a brand, a swatch) is drawn in its own colors: only the chrome around it is quiet.
  if (colors.length > 2 && !DESIGN_BLOCKS.test(quiet)) notes.push(`${colors.length} colors are written out (${[...new Set(colors.map((c) => c.toLowerCase()))].slice(0, 3).join(', ')}…). They will not follow light and dark, and Canopy keeps color to one small signal: use the CSS variables.`);
  for (const m of quiet.matchAll(/<canopy-(?:shot|review)\b([^>]*)>/gi)) {
    const ref = attr(` ${m[1]}`, 'ref');
    if (!/^look-\d+$/.test(ref)) { notes.push(`<canopy-${/review/i.test(m[0]) ? 'review' : 'shot'}> needs ref="look-N": the name a look you took in this chat was saved as${ref ? ` (not "${ref}")` : ''}. Take the screenshot with look first.`); break; }
  }
  for (const m of quiet.matchAll(/<canopy-pick\b[^>]*>([\s\S]*?)(?:<\/canopy-pick\s*>|$)/gi)) {
    const labels = [...m[1].matchAll(/\soption\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((x) => decode(x[1] ?? x[2] ?? '').trim());
    if (labels.length < 2) { notes.push('A <canopy-pick> needs two or more elements with option="…" inside it.'); continue; }
    const twice = labels.filter((l, i) => labels.indexOf(l) !== i);
    if (twice.length) notes.push(`Two options in a <canopy-pick> share a label (${[...new Set(twice)].slice(0, 2).map((l) => `"${l}"`).join(', ')}): give each its own, or the pick cannot tell them apart.`);
    const shows = [...m[1].matchAll(/\sfor\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((x) => decode(x[1] ?? x[2] ?? '').trim());
    const lost = shows.filter((f) => !labels.includes(f));
    if (lost.length) notes.push(`In <canopy-preview>, for="${lost[0]}" names no option. Each preview's for must be exactly one option's label.`);
  }
  return notes;
}

// ---- the tool ----

/**
 * The result of one show_widget call: an error when there is nothing that can be drawn, otherwise what was shown
 * (as text) and any notes. `report` is what the window said about drawing it, when it said anything in time:
 * { errors: string[] } from the widget's own scripts.
 */
export function showResult(args, report = null) {
  const title = typeof args?.title === 'string' ? args.title.trim().slice(0, TITLE_LIMIT) : '';
  const html = typeof args?.widget_code === 'string' ? args.widget_code : '';
  if (!html.trim()) return toolResult('Nothing was shown: widget_code is empty. Pass the HTML fragment to draw.', true);
  if (html.length > HTML_LIMIT) {
    return toolResult(`Nothing was shown: widget_code is ${num(html.length)} characters and the limit is ${num(HTML_LIMIT)}. Show less (fewer rows, a summary) or split it into two widgets.`, true);
  }
  const notes = lintWidget(html);
  const errors = Array.isArray(report?.errors) ? report.errors.filter((e) => typeof e === 'string' && e).slice(0, 3) : [];
  if (errors.length) notes.unshift(`Its script failed when it ran: ${errors.join('; ')}. The markup is showing but the script's work is not. Fix it and show the widget again.`);
  if (args?.i_have_seen_read_me !== true) notes.push('You have not read the guide. Call read_me before the next widget so it matches the app.');
  const outline = widgetOutline(html);
  const parts = [`Shown to the user in Canopy${title ? `: ${title}` : ''}.`];
  if (notes.length) parts.push(`To fix:\n${notes.map((n) => `- ${n}`).join('\n')}`);
  if (outline) parts.push(`What it shows, as text:\n${outline}`);
  return toolResult(parts.join('\n\n'));
}

/** How long show_widget waits to hear how a widget's script ran, in ms. */
export const WIDGET_REPORT_MS = 1500;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

// Neither tool changes anything, so both are marked read-only: Plan mode lets them through (a sketch of the plan
// is exactly when a mockup helps). Neither asks, and every chat has them.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/**
 * show_widget, defined once for every engine (tool-registry.mjs). A Claude chat has it on the `visualize` server
 * below; a Codex chat through the relay, drawn under the same name. A widget with a script can fail when it runs,
 * which only the window that draws it knows: it is given a moment to say so (`ctx.widgetReport(ctx.callId)`), and
 * what it says goes back with the result. A widget without a script has nothing that can fail, and answers at once.
 */
export const SHOW_WIDGET = defineTool({
  name: 'show_widget',
  home: UI_SERVER,
  description: SHOW_DESCRIPTION,
  params: {
    i_have_seen_read_me: { type: 'boolean', required: true, description: 'True once read_me\'s answer is in this conversation. If it is not, call read_me first.' },
    title: { type: 'string', required: true, description: 'A few plain words naming what this shows, e.g. "Usage by model". The user sees it while the widget draws.' },
    widget_code: { type: 'string', required: true, description: 'The HTML fragment: optional <style>, then markup, then <script>. No <html>, <head> or <body>.' },
  },
  alwaysLoad: true,
  annotations: { title: 'Show a widget', ...READ_ONLY },
  run: async (args, ctx) => {
    const code = typeof args?.widget_code === 'string' ? args.widget_code : '';
    const id = ctx?.callId;
    const ask = typeof ctx?.widgetReport === 'function' ? ctx.widgetReport : null;
    let report = null;
    if (ask && typeof id === 'string' && id && /<script\b/i.test(code) && code.length <= HTML_LIMIT) {
      const asked = Promise.resolve().then(() => ask(id)).catch(() => null);
      report = await Promise.race([asked, sleep(WIDGET_REPORT_MS).then(() => null)]);
    }
    return showResult(args, report);
  },
});

/** read_me, defined once for every engine, beside show_widget. */
export const READ_ME = defineTool({
  name: 'read_me',
  home: UI_SERVER,
  description: GUIDE_DESCRIPTION,
  params: {
    modules: { type: 'array', items: { type: 'string', enum: GUIDE_MODULES }, required: true, description: 'What you are about to draw. The basics come with any of them.' },
  },
  alwaysLoad: true,
  annotations: { title: 'Read the widget guide', ...READ_ONLY },
  run: async (args) => toolResult(guideText(isPlain(args) ? args.modules : [])),
});

/**
 * The in-process MCP server that carries the two tools in a Claude chat. One per Claude Code process. `show(args,
 * extra)` is called for every show_widget and may be async; what it returns is the tool's result.
 */
export function createWidgetServer({ show = (args) => showResult(args) } = {}) {
  const showTool = sdkTool(SHOW_WIDGET, sdk, zod.z, (args, extra) => show(args, extra));
  const guideTool = sdkTool(READ_ME, sdk, zod.z, (args) => READ_ME.run(args, {}));
  return sdk.createSdkMcpServer({ name: UI_SERVER, version: '1.0.0', tools: [showTool, guideTool] });
}
