// Today's activity for Home (src/day-activity.mjs): working time, cost and chats per quarter hour, from transcripts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dayActivity, dayKey, spendByDay, SLOT } from '../../../day-activity.mjs';

const MIN = 60_000;
const since = new Date(2026, 10, 16).getTime(); // a local midnight
const at = (m) => new Date(since + m * MIN).toISOString(); // minutes after midnight
const you = (m, text = 'do it') => ({ type: 'user', timestamp: at(m), message: { role: 'user', content: text } });
const result = (m) => ({ type: 'user', timestamp: at(m), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
const claude = (m, stop, id, usage = { input_tokens: 1_000_000, output_tokens: 0 }) =>
  ({ type: 'assistant', timestamp: at(m), message: { id, model: 'claude-opus-5-5', role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: 'ok' }], usage } });
const lines = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'day-activity-'));
  const proj = path.join(dir, 'projects', '-Users-me-app');
  mkdirSync(proj, { recursive: true });
  return { dir, proj };
}

test('working time runs from your message to the end of the turn; the gap before your next message is not work', async () => {
  const { dir, proj } = setup();
  try {
    // 9:00 you ask; tool calls until 9:06; reply ends the turn. 9:30 you ask again; done 9:32.
    writeFileSync(path.join(proj, 'a.jsonl'), lines([you(540), claude(541, 'tool_use', 'm1'), result(543), claude(546, 'end_turn', 'm2'), you(570), claude(572, 'end_turn', 'm3')]));
    const d = await dayActivity({ since, now: since + 600 * MIN, configDir: dir });
    assert.equal(d.busy, 8 * MIN);
    assert.equal(d.chats, 1);
    assert.equal(d.slots.length, 96);
    assert.equal(d.slots[36].busy, 6 * MIN); // 9:00 – 9:15
    assert.equal(d.slots[38].busy, 2 * MIN); // 9:30 – 9:45
    assert.ok(Math.abs(d.cost - 3 * 4) < 1e-9, `three replies of 1M input tokens at $4: ${d.cost}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two chats at once count once; a long silence (an approval left open) is not work', async () => {
  const { dir, proj } = setup();
  try {
    writeFileSync(path.join(proj, 'a.jsonl'), lines([you(600), claude(610, 'end_turn', 'a1')]));
    writeFileSync(path.join(proj, 'b.jsonl'), lines([you(605), claude(615, 'end_turn', 'b1')]));
    // c waits 40 minutes on an approval between the tool call and its result.
    writeFileSync(path.join(proj, 'c.jsonl'), lines([you(700), claude(701, 'tool_use', 'c1'), result(741), claude(742, 'end_turn', 'c2')]));
    const d = await dayActivity({ since, now: since + 800 * MIN, configDir: dir });
    assert.equal(d.busy, 15 * MIN + 1 * MIN + 1 * MIN);
    assert.equal(d.chats, 3);
    assert.equal(d.slots[40].chats, 2); // 10:00 – 10:15: a and b
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('agents count toward their chat; yesterday, temp folders and an interrupted turn do not', async () => {
  const { dir, proj } = setup();
  try {
    writeFileSync(path.join(proj, 'a.jsonl'), lines([you(-30), claude(-20, 'end_turn', 'y1'), you(60), you(62, '[Request interrupted by user]'), you(90)]));
    mkdirSync(path.join(proj, 'a', 'subagents', 'workflows', 'w1'), { recursive: true });
    writeFileSync(path.join(proj, 'a', 'subagents', 'workflows', 'w1', 'agent-1.jsonl'), lines([you(120), claude(125, 'end_turn', 'g1', { input_tokens: 0, output_tokens: 0 })]));
    const tmp = path.join(dir, 'projects', '-private-tmp-probe');
    mkdirSync(tmp);
    writeFileSync(path.join(tmp, 'p.jsonl'), lines([you(60), claude(70, 'end_turn', 'p1')]));
    const d = await dayActivity({ since, now: since + 200 * MIN, configDir: dir });
    assert.equal(d.busy, 2 * MIN + 5 * MIN); // 1:00 – 1:02 until interrupted, the agent 2:00 – 2:05
    assert.equal(d.chats, 1);
    assert.equal(d.cost, 0); // yesterday's reply isn't today's cost
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reads only what was added, and live spans fill in the rest', async () => {
  const { dir, proj } = setup();
  try {
    const file = path.join(proj, 'a.jsonl');
    writeFileSync(file, lines([you(600), claude(605, 'tool_use', 'a1')]));
    let d = await dayActivity({ since, now: since + 606 * MIN, configDir: dir });
    assert.equal(d.busy, 5 * MIN);
    appendFileSync(file, lines([result(607), claude(610, 'end_turn', 'a2')]));
    d = await dayActivity({ since, now: since + 700 * MIN, configDir: dir, extra: [{ chat: 'a', from: since + 650 * MIN, to: null }] });
    assert.equal(d.busy, 10 * MIN + 50 * MIN);
    assert.equal(d.slots[43].busy, 10 * MIN); // 10:45 – 11:00: live from 10:50
    assert.equal(d.slots[44].busy, SLOT); // 11:00 – 11:15, all live
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a long chat seen for the first time is read from today only, with the same result', async () => {
  const { dir, proj } = setup();
  try {
    // A week of old turns, some carrying a big pasted image, then today's work.
    const old = [];
    for (let k = 0; k < 400; k++) old.push(you(-7 * 1440 + k * 20, k % 50 ? 'old' : 'x'.repeat(300_000)), claude(-7 * 1440 + k * 20 + 5, 'end_turn', `o${k}`));
    writeFileSync(path.join(proj, 'a.jsonl'), lines([...old, you(-5), claude(3, 'end_turn', 't0'), you(600), claude(610, 'tool_use', 't1'), result(611), claude(615, 'end_turn', 't2')]));
    const d = await dayActivity({ since, now: since + 700 * MIN, configDir: dir });
    assert.equal(d.busy, 3 * MIN + 15 * MIN); // the turn running over midnight counts from 12:00
    assert.ok(Math.abs(d.cost - 3 * 4) < 1e-9, `today's three replies: ${d.cost}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- whose reply it was (the Usage tab's spend per account) ----

test('byAccount: each reply goes to the account its chat was on, and the buckets add up to the day’s cost', async () => {
  const { dir, proj } = setup();
  try {
    // a: on the plan until 10:00, on a key after. b: never anything but the default login. An agent of a, after the switch.
    writeFileSync(path.join(proj, 'a.jsonl'), lines([you(540), claude(545, 'end_turn', 'a1'), you(620), claude(625, 'end_turn', 'a2', { input_tokens: 500_000, output_tokens: 0 })]));
    writeFileSync(path.join(proj, 'b.jsonl'), lines([you(560), claude(565, 'end_turn', 'b1', { input_tokens: 250_000, output_tokens: 0 })]));
    mkdirSync(path.join(proj, 'a', 'subagents'), { recursive: true });
    writeFileSync(path.join(proj, 'a', 'subagents', 'agent-1.jsonl'), lines([you(630), claude(635, 'end_turn', 'g1', { input_tokens: 125_000, output_tokens: 0 })]));
    const asked = [];
    const attribute = (chat, at) => { asked.push([chat, (at - since) / MIN]); return chat === 'a' && at >= since + 600 * MIN ? 'key' : 'plan'; };
    const plain = await dayActivity({ since, now: since + 700 * MIN, configDir: dir });
    const d = await dayActivity({ since, now: since + 700 * MIN, configDir: dir, attribute });
    assert.deepEqual(d.byAccount, { plan: 4 + 1, key: 2 + 0.5 });
    assert.equal(d.byAccount.plan + d.byAccount.key, d.cost);
    assert.deepEqual(asked.sort((x, y) => x[1] - y[1]), [['a', 545], ['b', 565], ['a', 625], ['a', 635]], 'asked once per reply, with the chat (an agent’s reply is its chat’s) and when it landed');
    // Without `attribute` the answer is exactly what Home has always had.
    assert.ok(!('byAccount' in plain));
    assert.deepEqual({ ...d, byAccount: undefined }, { ...plain, byAccount: undefined });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('byAccount: with one account its number is the day’s cost exactly, and a reply nobody can name is still counted', async () => {
  const { dir, proj } = setup();
  try {
    const odd = (n) => ({ input_tokens: 1234 * n, output_tokens: 77 * n, cache_read_input_tokens: 9999 * n, cache_creation_input_tokens: 31 * n });
    for (const chat of ['a', 'b', 'c']) writeFileSync(path.join(proj, `${chat}.jsonl`), lines(Array.from({ length: 40 }, (_, k) => claude(60 + k, 'end_turn', `${chat}${k}`, odd(k + chat.charCodeAt(0)))))); // sums that do not round nicely
    const one = await dayActivity({ since, now: since + 700 * MIN, configDir: dir, attribute: () => 'claude-default' });
    assert.deepEqual(Object.keys(one.byAccount), ['claude-default']);
    assert.equal(one.byAccount['claude-default'], one.cost, 'the same additions in the same order: not a cent apart, not a bit apart');
    for (const bad of [() => null, () => undefined, () => 7, () => { throw new Error('registry exploded'); }]) {
      const d = await dayActivity({ since, now: since + 700 * MIN, configDir: dir, attribute: bad });
      assert.deepEqual(d.byAccount, { '': one.cost });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two reads at once take turns: neither loses its place in a file, and what is added afterwards is all read', async () => {
  const { dir, proj } = setup();
  try {
    const file = path.join(proj, 'a.jsonl');
    const batch = (n) => lines(Array.from({ length: 200 }, (_, k) => claude(60 + n * 200 + k, 'end_turn', `m${n}-${k}`, { input_tokens: 1000, output_tokens: 0 })));
    writeFileSync(file, batch(0));
    const read = () => dayActivity({ since, now: since + 1000 * MIN, configDir: dir, attribute: () => 'x' });
    // Home and the Usage tab asking in the same moment. Read side by side, each would count the file's length once
    // more and believe it had read twice as far as it had.
    for (const d of await Promise.all([read(), read()])) assert.ok(Math.abs(d.cost - 200 * 0.004) < 1e-9, String(d.cost));
    appendFileSync(file, batch(1) + batch(2));
    const d = await read();
    assert.ok(Math.abs(d.cost - 600 * 0.004) < 1e-9, `every reply added since is counted: ${d.cost}`);
    assert.ok(Math.abs(d.byAccount.x - d.cost) < 1e-12);
    // A read that fails does not wedge the ones behind it.
    await assert.rejects(dayActivity(null));
    assert.equal((await read()).chats, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A transcript written by `sudo claude` sits in the user's folder and cannot be opened; one can also go between being listed and being read.
test('a transcript that cannot be opened is left out: the day and the spend are counted from the rest', { skip: process.getuid?.() === 0 && 'root can open anything' }, async () => {
  const { dir, proj } = setup();
  const locked = path.join(proj, 'locked.jsonl');
  try {
    writeFileSync(path.join(proj, 'a.jsonl'), lines([you(540), claude(546, 'end_turn', 'm1')]));
    writeFileSync(locked, lines([you(600), claude(606, 'end_turn', 'm2')]));
    chmodSync(locked, 0o000);
    const d = await dayActivity({ since, now: since + 700 * MIN, configDir: dir });
    assert.equal(d.busy, 6 * MIN);
    assert.equal(d.chats, 1);
    assert.ok(Math.abs(d.cost - 4) < 1e-9, `the one reply that could be read: ${d.cost}`);
    assert.deepEqual(await spendByDay({ from: since, to: since + 1440 * MIN, configDir: dir }), { [dayKey(since + 720 * MIN)]: { '': 4 } });
  } finally { try { chmodSync(locked, 0o600); } catch {} rmSync(dir, { recursive: true, force: true }); }
});

test('spendByDay: days that are over, each reply on the local day it landed, without disturbing today’s read', async () => {
  const { dir, proj } = setup();
  try {
    const DAY_MIN = 1440;
    // Three days back to today; the chat moves to a key two days ago at noon. One reply a minute before midnight, one a minute after.
    writeFileSync(path.join(proj, 'a.jsonl'), lines([
      claude(-3 * DAY_MIN + 600, 'end_turn', 'd3'),
      claude(-2 * DAY_MIN + 600, 'end_turn', 'd2a'), claude(-2 * DAY_MIN + 800, 'end_turn', 'd2b', { input_tokens: 500_000, output_tokens: 0 }),
      claude(-DAY_MIN - 1, 'end_turn', 'd2c', { input_tokens: 250_000, output_tokens: 0 }), claude(-DAY_MIN + 1, 'end_turn', 'd1', { input_tokens: 125_000, output_tokens: 0 }),
      claude(30, 'end_turn', 't0'),
    ]));
    const day = (n) => dayKey(since + n * DAY_MIN * MIN + 720 * MIN);
    const attribute = (chat, at) => (at >= since + (-2 * DAY_MIN + 720) * MIN ? 'key' : 'plan');
    const today = await dayActivity({ since, now: since + 60 * MIN, configDir: dir, attribute });
    assert.deepEqual(today.byAccount, { key: 4 });
    const from = since - 2 * DAY_MIN * MIN;
    assert.deepEqual(await spendByDay({ from, to: since, configDir: dir, attribute }), { [day(-2)]: { plan: 4, key: 2 + 1 }, [day(-1)]: { key: 0.5 } });
    assert.deepEqual(await spendByDay({ from, to: since, configDir: dir }), { [day(-2)]: { '': 7 }, [day(-1)]: { '': 0.5 } }, 'nobody to ask: all of it under the unnamed login');
    assert.deepEqual(await spendByDay({ from: since - 3 * DAY_MIN * MIN, to: from, configDir: dir, attribute }), { [day(-3)]: { plan: 4 } });
    assert.deepEqual(await spendByDay({ from: since, to: since, configDir: dir, attribute }), {});
    assert.deepEqual(await spendByDay({ from: since, to: from, configDir: dir, attribute }), {});
    // Today's incremental read still stands where it stood.
    appendFileSync(path.join(proj, 'a.jsonl'), lines([claude(45, 'end_turn', 't1')]));
    assert.deepEqual((await dayActivity({ since, now: since + 60 * MIN, configDir: dir, attribute })).byAccount, { key: 8 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

