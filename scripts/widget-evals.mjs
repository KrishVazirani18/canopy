// Does Claude reach for a widget when it should, leave it alone when it should not, and write it well?
// Runs a fixed set of prompts (scripts/widget-evals/prompts.json) through Canopy's own engine (Session, with the same tools,
// descriptions and settings a chat in Canopy has) against the real Claude Code, and reports what happened to each:
// which tools were called, whether the guide was read first, what show_widget said back, and the widget itself.
//
//   node scripts/widget-evals.mjs [--only id,id] [--out dir] [--jobs N] [--model name]
//
// This spends real usage (about a cent to a quarter per prompt), so it is run by hand when the tools' descriptions
// or the guide change, not in `npm test`. Results and what was changed because of them: docs/design/interactive-ui-evals.md.
// It only reads: reading, searching, the widgets and questions are let through, and so is a shell command that reads
// (Claude counts and sums with awk or python, as it would in a real chat); anything that could change something is refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findClaude, loadShellEnv } from '../src/core/env.mjs';
import { Session } from '../src/core/session.mjs';
import { GUIDE_TOOL, SHOW_TOOL, lintWidget } from '../src/core/widgets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const only = value('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const out = path.resolve(value('--out') ?? path.join(os.tmpdir(), 'canopy-widget-evals'));
const jobs = Math.max(1, Math.min(4, Number(value('--jobs')) || 3));
const model = value('--model');
const TURN_MS = 5 * 60_000;

const { prompts } = JSON.parse(fs.readFileSync(path.join(HERE, 'widget-evals/prompts.json'), 'utf8'));
// The prompts are asked in a small made-up project (scripts/widget-evals/project), copied out of this repo first so
// Claude Code sees a project of its own, not Canopy's.
const cwd = path.resolve(value('--cwd') ?? path.join(os.tmpdir(), 'canopy-eval-project'));
if (!value('--cwd')) { fs.rmSync(cwd, { recursive: true, force: true }); fs.cpSync(path.join(HERE, 'widget-evals/project'), cwd, { recursive: true }); }

const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'ToolSearch', 'TodoWrite', 'Skill']);
// A shell command is let through unless it could write, delete, install, send or escalate.
const UNSAFE = /(^|[;&|(`]\s*)(rm|mv|cp|ln|chmod|chown|mkdir|touch|tee|dd|curl|wget|ssh|scp|nc|git|npm|npx|pnpm|yarn|pip|pip3|brew|sudo|kill|pkill|open|osascript|launchctl|defaults)\b|>|\bwrite\b|\bunlink\b|\bos\.(remove|system|rename)|subprocess|\bexec\b|\beval\b/;
const safeShell = (input) => typeof input?.command === 'string' && input.command.length < 2000 && !UNSAFE.test(input.command);
const { env } = await loadShellEnv();
const claudePath = await findClaude(env);
if (!claudePath) { console.error('Claude Code was not found.'); process.exit(1); }
fs.mkdirSync(out, { recursive: true });

async function run(p) {
  const s = new Session({ cwd, claudePath, env, permissionMode: 'default', suggestions: false, codeMode: true, ...(model && { model }) });
  const r = { id: p.id, prompt: p.prompt, expect: p.expect, uses: p.uses ?? null, tools: [], widgets: [], text: '', partials: 0, stream: {}, guideFirst: null, denied: [], error: null, cost: null, ms: null };
  const started = Date.now();
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => { r.error = 'timed out'; resolve(); }, TURN_MS);
    s.on('event', (ev) => {
      if (ev.kind === 'tool-input-partial') {
        // When each piece arrived: a widget that streams grows over seconds, one that does not lands in a single burst.
        r.partials += 1;
        const t = (r.stream[ev.id] ??= { first: Date.now(), last: Date.now(), steps: 0, length: 0 });
        const length = String(ev.input?.widget_code ?? '').length;
        if (length > t.length) { t.steps += 1; t.length = length; t.last = Date.now(); if (!t.started && length) { t.started = true; t.first = Date.now(); } }
      }
      else if (ev.kind === 'tool-start' && !ev.parent) {
        r.tools.push(ev.name);
        if (ev.name === SHOW_TOOL) {
          r.guideFirst ??= r.tools.includes(GUIDE_TOOL);
          r.widgets.push({ id: ev.id, title: ev.input?.title ?? '', code: ev.input?.widget_code ?? '', seen: ev.input?.i_have_seen_read_me, result: null });
        }
        if (ev.name === GUIDE_TOOL) r.modules = [...(r.modules ?? []), ...(ev.input?.modules ?? [])];
      } else if (ev.kind === 'tool-result') { const w = r.widgets.find((x) => x.id === ev.id); if (w) w.result = ev.content; }
      else if (ev.kind === 'assistant-text' && !ev.parent) r.text += `${ev.text}\n`;
      else if (ev.kind === 'permission') {
        // Nothing here may change anything: reading and asking are let through, the rest is refused.
        if (ev.type === 'question') { r.tools.push('AskUserQuestion(answered)'); s.respond(ev.id, { action: 'deny', message: 'The user is away. Decide yourself and go on.' }); }
        else if (READ_ONLY.has(ev.toolName) || /^mcp__visualize__/.test(ev.toolName) || (ev.toolName === 'Bash' && safeShell(ev.input))) s.respond(ev.id, { action: 'allow' });
        else { r.denied.push(ev.toolName); s.respond(ev.id, { action: 'deny', message: 'This is a read-only session.' }); }
      } else if (ev.kind === 'turn-end') { r.cost = ev.turnCost ?? null; if (ev.isError) r.error = (ev.errors ?? []).join('; ') || ev.text || 'failed'; clearTimeout(timer); resolve(); }
      else if (ev.kind === 'error') { r.error = ev.message; clearTimeout(timer); resolve(); }
    });
  });
  s.send(p.prompt);
  await done;
  r.ms = Date.now() - started;
  await s.dispose({ graceMs: 1500 }).catch(() => {});
  return r;
}

// `uses`: the blocks a right answer is built from (any one of them). A widget without any is the wrong kind: drawn,
// but not the way the moment calls for (a font question answered with trade-off cards).
const usesOne = (r, uses) => !uses?.length || r.widgets.some((w) => uses.some((u) => new RegExp(`<${u}\\b`, 'i').test(w.code)));
function verdict(r) {
  const drew = r.widgets.length > 0;
  if (r.error) return 'ERROR';
  if (r.expect === 'widget') return !drew ? 'MISSED' : usesOne(r, r.uses) ? 'ok' : 'WRONG KIND';
  if (r.expect === 'text') return drew ? 'OVERUSED' : 'ok';
  return drew ? 'drew' : 'text';
}

const todo = prompts.filter((p) => !only || only.includes(p.id));
const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(jobs, todo.length) }, async () => {
  while (next < todo.length) {
    const p = todo[next++];
    const r = await run(p);
    results.push(r);
    const notes = r.widgets.flatMap((w) => lintWidget(w.code));
    console.log(`${verdict(r).padEnd(9)} ${r.id.padEnd(22)} ${String(Math.round(r.ms / 1000)).padStart(3)}s ${r.cost != null ? `$${r.cost.toFixed(2)}` : '     '}  ${r.tools.map((t) => t.replace('mcp__visualize__', '')).join(' → ') || '(no tools)'}`
      + `${r.widgets.length ? `  [${r.widgets.map((w) => `${w.title}: ${w.code.length} chars`).join('; ')}${r.guideFirst ? '' : '; NO GUIDE'}${r.partials ? `; grew in ${Math.max(0, ...Object.values(r.stream).map((t) => t.steps))} steps over ${(Math.max(0, ...Object.values(r.stream).map((t) => t.last - t.first)) / 1000).toFixed(1)}s` : '; NOT STREAMED'}]` : ''}`
      + `${notes.length ? `\n          notes: ${notes.join(' | ')}` : ''}${r.error ? `\n          error: ${r.error}` : ''}${r.denied.length ? `\n          refused: ${r.denied.join(', ')}` : ''}`);
    fs.writeFileSync(path.join(out, `${r.id}.json`), JSON.stringify(r, null, 2));
    r.widgets.forEach((w, i) => fs.writeFileSync(path.join(out, `${r.id}${i ? `-${i + 1}` : ''}.html`), w.code));
  }
}));
const tally = (v) => results.filter((r) => verdict(r) === v).length;
console.log(`\n${results.length} prompts: ${tally('ok')} as expected, ${tally('MISSED')} missed, ${tally('WRONG KIND')} the wrong kind, ${tally('OVERUSED')} overused, ${tally('ERROR')} errors. Total $${results.reduce((n, r) => n + (r.cost ?? 0), 0).toFixed(2)}. Details in ${out}`);
process.exit(0);
