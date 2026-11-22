// Fills the Playground's Widgets mock with widgets real Claude wrote: takes the results of an eval run
// (scripts/widget-evals.mjs --out dir) and writes renderer/src/playground/mocks/widget-examples.ts from them,
// followed by the few hand-made ones that show a state no good run produces (stopped mid-write, a failing script,
// nothing drawn).
//
//   node scripts/widget-examples.mjs <dir of eval results> [id,id,...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) { console.error('usage: node scripts/widget-examples.mjs <dir of eval results> [ids]'); process.exit(1); }
const want = process.argv[3]?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const { prompts } = JSON.parse(fs.readFileSync(path.join(HERE, 'widget-evals/prompts.json'), 'utf8'));

// What Claude said before the widget: its reply up to the first blank line, which is as far as the mock shows.
const lead = (text) => String(text ?? '').trim().split(/\n\s*\n/)[0].slice(0, 400);
const real = [];
for (const p of prompts) {
  if (want && !want.includes(p.id)) continue;
  const file = path.join(dir, `${p.id}.json`);
  if (!fs.existsSync(file)) continue;
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const w = r.widgets?.at(-1);
  if (!w?.code) continue;
  real.push({ id: p.id, title: w.title, kind: `Claude wrote this · ${(r.modules ?? []).join(', ') || 'no module'}`, ask: p.prompt, after: lead(r.text), code: w.code });
}

const STATES = [
  { id: 'cut', title: 'Release checklist', kind: 'Stopped while it was being written', cut: true, ask: 'Lay out the release checklist.',
    code: '<canopy-table caption="Release 0.4">\nStep,Owner,Status\nFreeze main,Sam,Done\nRun the full suite,Canopy,Done\nSign and nota' },
  { id: 'broken', title: 'Burn-down', kind: 'A widget whose script fails: it stays up, and says so quietly', ask: 'Chart the burn-down.',
    code: '<canopy-chart type="area" caption="Open issues" unit="issues">\nDay,Open\nMon,42\nTue,38\nWed,31\nThu,24\nFri,19\n</canopy-chart>\n<script>\nrenderBurndown(document.querySelector(\'canopy-chart\'));\n</script>' },
  // What the sandbox holds: the widget tries each way out and lists what happened. Every row should say blocked or refused.
  { id: 'escape', title: 'Ways out', kind: 'A widget that tries to get out of its frame: every attempt is stopped', ask: 'Can a widget reach outside its frame?',
    code: `<canopy-table caption="What this widget tried, and what happened">
Attempt,Result
</canopy-table>
<script>
const rows = [];
const table = document.querySelector('canopy-table');
const add = (what, result) => { rows.push(what + ',' + result); table.textContent = 'Attempt,Result\\n' + rows.join('\\n') + '\\n'; };
const attempt = (what, fn) => { try { add(what, fn()); } catch (e) { add(what, 'blocked (' + e.name + ')'); } };
attempt('Read the app around it', () => 'read: ' + parent.document.title);
attempt('Call Canopy from inside', () => (parent.canopy ? 'reached' : 'blocked'));
attempt('Read cookies', () => 'read: ' + document.cookie);
attempt('Keep data in the browser', () => 'kept: ' + localStorage.length);
attempt('Send the whole app somewhere else', () => { top.location = 'https://example.com/'; return 'left'; });
attempt('Open a new window', () => (window.open('https://example.com/') ? 'opened' : 'blocked'));
fetch('https://example.com/').then(() => add('Fetch from the network', 'fetched'), () => add('Fetch from the network', 'blocked'));
const img = new Image();
img.onload = () => add('Load an image from the network', 'loaded');
img.onerror = () => add('Load an image from the network', 'blocked');
img.src = 'https://example.com/x.png';
canopy.send('This was sent without a click').then((sent) => add('Speak as you without a click', sent ? 'sent' : 'refused'));
</script>` },
  { id: 'empty', title: 'the layout', kind: 'A widget that draws nothing: one quiet line, the source a click away', ask: 'Show the layout.',
    code: '<div style="display:none">hidden</div>' },
];

const out = `// The widgets the Playground shows (show-widgets.tsx). Written by scripts/widget-examples.mjs: the first ${real.length} are
// widget_code from real show_widget calls in an eval run (docs/design/interactive-ui-evals.md); the rest are hand-made
// to show states a good run does not produce. Regenerate rather than edit.
export type Example = {
  id: string; title: string; /** Which component or state this one is here to show. */ kind: string;
  ask: string; before?: string; after?: string; code: string; /** Shown as a widget Claude was stopped in the middle of. */ cut?: boolean;
};

export const EXAMPLES: Example[] = ${JSON.stringify([...real, ...STATES], null, 2)};
`;
fs.writeFileSync(path.join(HERE, '../renderer/src/playground/mocks/widget-examples.ts'), out);
console.log(`${real.length} from ${dir}, ${STATES.length} states`);
