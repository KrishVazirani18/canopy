// The agents drawer's reading of Claude Code's own files (src/workflows.mjs): a workflow's journal and saved script,
// and a background agent's transcript. All of it depends on the shape of files another program writes, so the shapes
// are written out here, into a throwaway Claude Code folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { agentSteps, workflowAgents } from '../../../workflows.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-workflows-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const CWD = '/Users/test/my app';
const SESSION = '00000000-0000-4000-8000-0000000000aa';
let made = 0;
/** A chat's folder inside a Claude Code folder of its own. */
function chat() {
  const configDir = path.join(root, `config-${made++}`);
  const dir = path.join(configDir, 'projects', '-Users-test-my-app', SESSION); // how Claude Code names the project's folder
  fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
  return { configDir, dir, subagents: path.join(dir, 'subagents'), workflows: path.join(dir, 'subagents', 'workflows'), scripts: path.join(dir, 'workflows', 'scripts') };
}
const lines = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
const at = (s) => `2026-11-16T09:00:${String(s).padStart(2, '0')}.000Z`;
const used = (name, input, s = 1) => ({ type: 'assistant', timestamp: at(s), message: { model: 'claude-fable-5-2', role: 'assistant', content: [{ type: 'tool_use', id: `t${s}`, name, input }] } });
const said = (text, s = 1) => ({ type: 'assistant', timestamp: at(s), message: { role: 'assistant', content: [{ type: 'text', text }] } });

// ---- a workflow's agents ----

test('a workflow: its agents by key, started and result lines joined, with what each is doing and the phases its script declared', async () => {
  const c = chat();
  const run = path.join(c.workflows, 'wf_joined01');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'journal.jsonl'), lines([
    { type: 'started', key: 'gather', label: 'Read the docs', phase: 'Gather', agentId: 'ag1' },
    { type: 'started', key: 'write', label: 'Draft the summary', phase: 'Write it up', agentId: 'ag2' },
    { type: 'result', key: 'gather', result: 'Three pages read.' },
    { type: 'result', key: 'orphan', value: { pages: 3 } }, // a result whose start was never written
    { type: 'note', key: 'gather' },
    '{"type":"started","key":"half', // a line still being written
  ]));
  fs.writeFileSync(path.join(run, 'agent-ag1.jsonl'), lines([
    { type: 'user', timestamp: at(1), message: { role: 'user', content: 'Read the docs' } },
    used('WebSearch', { query: 'canopy   pricing page' }, 2),
    used('Read', { file_path: '/Users/test/my app/pricing.html' }, 5),
    used('StructuredOutput', { answer: 'Three pages read.' }, 7), // handing its answer back is not its latest work
  ]) + '\n');
  fs.mkdirSync(c.scripts, { recursive: true });
  fs.writeFileSync(path.join(c.scripts, 'research-wf_joined01.js'), [
    'export const meta = {', '  name: \'research\',', '  phases: [', '    { title: \'Gather\' },', '    { title: "Write it up", detail: \'one page\' },', '  ],', '}', '',
    'export default async function run() { const phases = [{ title: \'not this one\' }]; return phases; }', '',
  ].join('\n'));

  const w = await workflowAgents(CWD, SESSION, { configDir: c.configDir });
  assert.equal(w.run, 'wf_joined01');
  assert.deepEqual(w.phases, ['Gather', 'Write it up']);
  assert.deepEqual(w.agents, [
    { key: 'gather', label: 'Read the docs', phase: 'Gather', done: true, agentId: 'ag1', result: 'Three pages read.',
      model: 'claude-fable-5-2', steps: 3, tool: 'Read', detail: '/Users/test/my app/pricing.html', startedAt: Date.parse(at(1)), lastAt: Date.parse(at(7)) },
    { key: 'write', label: 'Draft the summary', phase: 'Write it up', done: false, agentId: 'ag2' }, // its transcript is not there yet
    { key: 'orphan', label: 'agent', phase: null, done: true, result: '{\n  "pages": 3\n}' },
  ]);
});

test('the workflow shown is the one whose journal was written last, and a long result is cut', async () => {
  const c = chat();
  const older = path.join(c.workflows, 'wf_older01'), newer = path.join(c.workflows, 'wf_newer01');
  fs.mkdirSync(older, { recursive: true });
  fs.mkdirSync(newer, { recursive: true });
  fs.mkdirSync(path.join(c.workflows, 'not-a-run'), { recursive: true });
  fs.writeFileSync(path.join(older, 'journal.jsonl'), lines([{ type: 'started', key: 'a', label: 'Old work' }]));
  fs.writeFileSync(path.join(newer, 'journal.jsonl'), lines([{ type: 'started', key: 'b' }, { type: 'result', key: 'b', output: 'x'.repeat(20_500) }]));
  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(older, 'journal.jsonl'), past, past);

  const w = await workflowAgents(CWD, SESSION, { configDir: c.configDir });
  assert.equal(w.run, 'wf_newer01');
  assert.deepEqual(w.phases, [], 'no script was saved for it');
  assert.equal(w.agents.length, 1);
  assert.deepEqual({ ...w.agents[0], result: undefined }, { key: 'b', label: 'agent', phase: null, done: true, agentId: undefined, result: undefined });
  assert.equal(w.agents[0].result, `${'x'.repeat(20_000)}\n…`);
});

test('no workflow, another folder, or an id that is not one: null', async () => {
  const c = chat();
  assert.equal(await workflowAgents(CWD, SESSION, { configDir: c.configDir }), null, 'the chat ran no workflow');
  fs.mkdirSync(path.join(c.workflows, 'notes'), { recursive: true });
  assert.equal(await workflowAgents(CWD, SESSION, { configDir: c.configDir }), null, 'a folder that is not a run');
  fs.mkdirSync(path.join(c.workflows, 'wf_there01'), { recursive: true });
  assert.deepEqual(await workflowAgents(CWD, SESSION, { configDir: c.configDir }), { run: 'wf_there01', agents: [], phases: [] }, 'a run that has written nothing yet');
  assert.equal(await workflowAgents('/Users/test/another', SESSION, { configDir: c.configDir }), null);
  for (const bad of [null, '', '../x', `${SESSION}/..`, 'a b']) assert.equal(await workflowAgents(CWD, bad, { configDir: c.configDir }), null, String(bad));
  assert.equal(await workflowAgents('', SESSION, { configDir: c.configDir }), null);
});

// ---- one background agent ----

test('each step of an agent is one short sentence, by the tool it used', async () => {
  const c = chat();
  const table = [
    ['Read', { file_path: '/Users/test/my app/site/pricing.html' }, 'Read pricing.html'],
    ['Read', {}, 'Read a file'],
    ['Edit', { file_path: 'src/app.js', old_string: 'a', new_string: 'b' }, 'Edited app.js'],
    ['MultiEdit', { file_path: 'src/list.ts', edits: [] }, 'Edited list.ts'],
    ['Write', { file_path: 'notes.md', content: 'x' }, 'Wrote notes.md'],
    ['Bash', { command: 'npm   test' }, 'Ran npm test'],
    ['Bash', { command: 'sed -i s/a/b/ x', description: 'Fix last line reference' }, 'Fix last line reference'],
    ['Bash', {}, 'Ran a command'],
    ['WebSearch', { query: 'canopy pricing' }, 'Searched the web for canopy pricing'],
    ['WebFetch', { url: 'https://example.com/pricing' }, 'Read https://example.com/pricing'],
    ['Grep', { pattern: 'TODO' }, 'Searched the code for TODO'],
    ['Glob', { pattern: '**/*.ts' }, 'Found files **/*.ts'],
    ['Task', { description: 'Check the docs', prompt: 'Read them all' }, 'Started an agent Check the docs'],
    ['TodoWrite', { todos: [{ content: 'one', status: 'pending' }] }, 'Updated its to-do list'],
    ['mcp__notion__search', { query: 'roadmap' }, 'Used notion: roadmap'],
    ['mcp__notion__list_pages', {}, 'Used notion'],
    ['Sparkle', {}, 'Used Sparkle'],
    ['Sparkle', { prompt: 'make it shine' }, 'Used Sparkle make it shine'],
  ];
  fs.writeFileSync(path.join(c.subagents, 'agent-ag7.jsonl'), lines([
    { type: 'user', timestamp: at(0), message: { role: 'user', content: 'go' } },
    ...table.map(([name, input], i) => used(name, input, i + 1)),
    said('Halfway there.', 30),
    used('StructuredOutput', { answer: 'done' }, 31), // its answer handed back: not a step
    said('  All done: the page is priced.  ', 32),
    { type: 'user', timestamp: at(33), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    '{"type":"assistant","timestamp":"2026-11-16T09:00:40.000Z","message":{"content":[{"type":"tool_use","name":"Read"', // still being written
  ]));

  const r = await agentSteps(CWD, SESSION, 'ag7', { configDir: c.configDir });
  assert.deepEqual(r.steps.map((s) => s.text), table.map(([, , words]) => words));
  assert.deepEqual(r.steps.map((s) => s.at), table.map((_, i) => Date.parse(at(i + 1))));
  assert.deepEqual({ total: r.total, startedAt: r.startedAt, lastAt: r.lastAt, result: r.result },
    { total: table.length, startedAt: Date.parse(at(0)), lastAt: Date.parse(at(33)), result: 'All done: the page is priced.' });

  const few = await agentSteps(CWD, SESSION, 'ag7', { configDir: c.configDir, limit: 2 });
  assert.deepEqual([few.steps.map((s) => s.text), few.total], [['Used Sparkle', 'Used Sparkle make it shine'], table.length], 'the newest steps, and how many there were');
});

test('an agent with no transcript, or an id that is not one: null', async () => {
  const c = chat();
  assert.equal(await agentSteps(CWD, SESSION, 'ag-missing', { configDir: c.configDir }), null);
  fs.writeFileSync(path.join(c.subagents, 'agent-ag1.jsonl'), '');
  assert.deepEqual(await agentSteps(CWD, SESSION, 'ag1', { configDir: c.configDir }), { steps: [], total: 0, startedAt: null, lastAt: null, result: null });
  for (const bad of [null, '', '../ag1', 'a/b', 'a b']) {
    assert.equal(await agentSteps(CWD, SESSION, bad, { configDir: c.configDir }), null, `agent ${bad}`);
    assert.equal(await agentSteps(CWD, bad, 'ag1', { configDir: c.configDir }), null, `session ${bad}`);
  }
  assert.equal(await agentSteps('', SESSION, 'ag1', { configDir: c.configDir }), null);
});
