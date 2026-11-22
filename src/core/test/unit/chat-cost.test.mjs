// What a chat cost (src/chat-cost.mjs): the price of one reply from its usage, and a chat's total read from its
// transcript and its agents' transcripts, a little at a time. The transcripts are written into a throwaway folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { chatCost, replyCost } from '../../../chat-cost.mjs';

const M = 1_000_000;
const near = (got, want, what) => assert.ok(Math.abs(got - want) < 1e-9, `${what ?? 'cost'}: ${got} is not ${want}`);

// ---- one reply ----

test('a model is priced by the most specific name that begins it, whatever date or [1m] follows', () => {
  near(replyCost('claude-opus-5-5', { input_tokens: M }), 4);
  near(replyCost('claude-opus-5-5-20261101', { input_tokens: M }), 4, 'a dated Opus 5.5 is not priced as Opus 5');
  near(replyCost('claude-opus-5', { input_tokens: M }), 5);
  near(replyCost('claude-opus-5-20260301', { input_tokens: M }), 5);
  near(replyCost('claude-sonnet-5-5[1m]', { input_tokens: M, output_tokens: M }), 2 + 10);
  near(replyCost('claude-fable-5-2', { output_tokens: M }), 40);
  near(replyCost('claude-opus-4-1-20250805', { input_tokens: M }), 15, 'Opus 4.1 is not priced as Opus 4');
});

test('a model that is not listed is priced as Opus 5.5, and a reply with no usage costs nothing', () => {
  near(replyCost('some-new-model', { input_tokens: M, output_tokens: M }), 4 + 20);
  near(replyCost(null, { input_tokens: M }), 4);
  assert.equal(replyCost('claude-opus-5-5', null), 0);
  assert.equal(replyCost('claude-opus-5-5', {}), 0);
});

test('what is written to the cache costs more by how long it is kept, and what is read from it costs a fraction', () => {
  // 600k kept five minutes at 1.25 × $4, 400k kept an hour at 2 × $4.
  near(replyCost('claude-opus-5-5', { cache_creation_input_tokens: M, cache_creation: { ephemeral_1h_input_tokens: 400_000 } }), 0.6 * 5 + 0.4 * 8);
  near(replyCost('claude-opus-5-5', { cache_creation_input_tokens: M }), 5, 'all of it for five minutes when nothing says an hour');
  near(replyCost('claude-opus-5-5', { cache_creation_input_tokens: 100_000, cache_creation: { ephemeral_1h_input_tokens: M } }), 0.1 * 8, 'never more for an hour than was written');
  near(replyCost('claude-opus-5-5', { cache_read_input_tokens: M }), 0.2, 'the price the model lists');
  near(replyCost('claude-opus-5', { cache_read_input_tokens: M }), 0.5, 'a tenth of the input price when it lists none');
});

test('Haiku 5.5 costs more past 100,000 tokens of prompt, counting what came from and went to the cache', () => {
  near(replyCost('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: M }), 0.01 + 0.5, 'at the line: the short price');
  near(replyCost('claude-haiku-5-5', { input_tokens: 100_001, output_tokens: M }), 100_001 * 0.5 / M + 2.5);
  near(replyCost('claude-haiku-5-5', { input_tokens: 50_000, cache_read_input_tokens: 50_001 }), (50_000 * 0.5 + 50_001 * 0.05) / M, 'cache reads count toward the line');
});

test('a Fast reply costs twice as much, one kept in the US a tenth more, and both together', () => {
  near(replyCost('claude-opus-5-5', { input_tokens: M, speed: 'fast' }), 8);
  near(replyCost('claude-opus-5-5', { input_tokens: M, inference_geo: 'us' }), 4.4);
  near(replyCost('claude-opus-5-5', { input_tokens: M, speed: 'fast', inference_geo: 'us' }), 8.8);
  near(replyCost('claude-opus-5-5', { input_tokens: M, speed: 'standard', inference_geo: 'global' }), 4);
});

// ---- a chat ----

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-chat-cost-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const WORK = '/Users/test/my app';
let made = 0;
/** A chat's place in a Claude Code folder of its own: { config, id, file, agents }. */
function chat() {
  const config = path.join(root, `config-${made++}`);
  const id = `00000000-0000-4000-8000-00000000000${made}`;
  const dir = path.join(config, 'projects', '-Users-test-my-app'); // how Claude Code names the project's folder
  fs.mkdirSync(dir, { recursive: true });
  return { config, id, file: path.join(dir, `${id}.jsonl`), agents: path.join(dir, id, 'subagents') };
}
const reply = (id, input, extra = {}) => JSON.stringify({ type: 'assistant', uuid: `row-${id}-${input}`, message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [], usage: { input_tokens: input, output_tokens: 0 }, ...extra } });
const you = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

test('a chat costs its replies, each counted once however many rows it was logged as', async () => {
  const c = chat();
  // One reply logged as three rows (one per block): the last row has the final usage.
  fs.writeFileSync(c.file, [you('hello'), reply('m1', 250_000), reply('m1', 500_000), reply('m1', M), reply('m2', M), 'not json at all "usage" "type":"assistant"', ''].join('\n'));
  const cost = await chatCost(c.id, WORK, c.config);
  near(cost.chat, 8);
  assert.deepEqual({ agents: cost.agents, total: cost.total }, { agents: 0, total: cost.chat });
});

test('only what was added is read: a half-written last line waits for the rest of it', async () => {
  const c = chat();
  const second = reply('m2', M);
  fs.writeFileSync(c.file, `${reply('m1', M)}\n${second.slice(0, 40)}`);
  near((await chatCost(c.id, WORK, c.config)).total, 4, 'the half line is not a reply yet');
  fs.appendFileSync(c.file, `${second.slice(40)}\n`);
  near((await chatCost(c.id, WORK, c.config)).total, 8, 'joined with its other half');
  fs.appendFileSync(c.file, `${reply('m3', 500_000)}\n`);
  near((await chatCost(c.id, WORK, c.config)).total, 10);
  near((await chatCost(c.id, WORK, c.config)).total, 10, 'asked again with nothing new');
});

test('a transcript that got shorter is read again from the start', async () => {
  const c = chat();
  fs.writeFileSync(c.file, `${reply('m1', M)}\n${reply('m2', M)}\n${reply('m3', M)}\n`);
  near((await chatCost(c.id, WORK, c.config)).total, 12);
  fs.writeFileSync(c.file, `${reply('m9', 500_000)}\n`);
  near((await chatCost(c.id, WORK, c.config)).total, 2, 'nothing of the longer file is left in the count');
});

test('the agents a chat started are added in, wherever under its subagents folder they wrote', async () => {
  const c = chat();
  fs.writeFileSync(c.file, `${reply('m1', M)}\n`);
  fs.mkdirSync(path.join(c.agents, 'workflows', 'run-1'), { recursive: true });
  fs.writeFileSync(path.join(c.agents, 'agent-a1.jsonl'), `${reply('a1', 500_000)}\n`);
  fs.writeFileSync(path.join(c.agents, 'workflows', 'run-1', 'agent-b2.jsonl'), `${reply('b1', 250_000)}\n`);
  fs.writeFileSync(path.join(c.agents, 'notes.jsonl'), `${reply('x', M)}\n`); // not an agent's transcript
  const cost = await chatCost(c.id, WORK, c.config);
  near(cost.chat, 4);
  near(cost.agents, 2 + 1);
  near(cost.total, 7);
});

test('no transcript, no id, or an id that is not one: null, and nothing is read', async () => {
  const c = chat();
  assert.equal(await chatCost(c.id, WORK, c.config), null, 'the chat has written nothing yet');
  fs.writeFileSync(c.file, `${reply('m1', M)}\n`);
  assert.equal(await chatCost(c.id, '/Users/test/another', c.config), null, 'another folder');
  for (const bad of [null, '', '../' + c.id, `${c.id}/../x`, 'a b']) assert.equal(await chatCost(bad, WORK, c.config), null, String(bad));
  assert.equal(await chatCost(c.id, '', c.config), null);
  near((await chatCost(c.id, WORK, c.config)).total, 4);
});
