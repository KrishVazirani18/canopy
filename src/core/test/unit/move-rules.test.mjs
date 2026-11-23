// The rules of moving a chat to the other maker that need no window (renderer/src/lib/move-rules.ts): which chat a
// move carries, when a chat can be moved, where "Move to …" lands, and the words. Plain TypeScript, run by node as it
// is. The OpenAI rows are the ones recorded from this Mac's Codex, built exactly as main builds them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { codexModelInfo } from '../../codex-host.mjs';
import * as M from '../../../../renderer/src/lib/model-rules.ts';
import * as R from '../../../../renderer/src/lib/move-rules.ts';
import { MOVE_BUSY as HOST_BUSY } from '../../../handoffs.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
function recordedOpenai() {
  const all = fs.readFileSync(path.join(FIXTURES, 'codex-meta.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const asked = all.find((l) => l.dir === 'out' && l.msg.method === 'model/list');
  const answer = all.find((l) => l.dir === 'in' && !l.msg.method && l.msg.id === asked.msg.id);
  return answer.msg.result.data.filter((m) => !m.hidden).map(codexModelInfo);
}
const CLAUDE = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) · $5/$25 per Mtok' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'fable[1m]', resolvedModel: 'claude-fable-5-2', displayName: 'Fable', description: 'Fable 5.2 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks' },
];
const ALL = M.allModels(CLAUDE, recordedOpenai());

const chat = (meta = {}, items = []) => ({ meta: { sessionId: 'chat-1', busy: false, loading: false, ...meta }, items });
const user = { t: 'user' };
const ask = (type, resolved = false) => ({ t: 'permission', resolved, ev: { type } });
const cameFrom = { t: 'handoff', ev: { dir: 'switch', pending: true, from: { id: 'old-chat', engine: 'claude', model: 'Opus 5.5' }, to: { id: null, engine: 'codex', model: 'GPT-6.1-Sol' } } };

test('which chat a move carries: this one once it is saved, else the one it was moved from', () => {
  assert.deepEqual(R.moveSource(chat()), { id: 'chat-1', model: null, pending: false });
  assert.equal(R.moveSource(chat({ sessionId: null })), null, 'a chat that has not started has nothing to carry');
  assert.equal(R.moveSource(chat({ sessionId: null }, [user])), null, 'nor one whose first message has no id yet');
  assert.deepEqual(R.moveSource(chat({ sessionId: null }, [cameFrom])), { id: 'old-chat', model: 'Opus 5.5', pending: true }, 'moved here, no message yet: the old chat moves again');
  assert.equal(R.moveSource(chat({ sessionId: null, busy: true }, [cameFrom, user])), null, 'its first message is on its way: it is becoming a chat of its own');
  assert.deepEqual(R.moveSource(chat({}, [cameFrom, user])), { id: 'chat-1', model: null, pending: false }, 'once saved, it is itself what moves');
  assert.equal(R.moveSource(chat({ sessionId: null }, [{ t: 'handoff', ev: { dir: 'switch', from: { id: 'x', engine: 'claude' }, to: { id: 'y', engine: 'codex' } } }])), null, 'a switch the chat has carried on past is not a pending move');
  assert.equal(R.moveSource(null), null);
});

test('a chat can be moved when it is saved, idle and waiting on nothing', () => {
  assert.equal(R.movable(chat(), true), 'ok');
  assert.equal(R.movable(chat({}, [user, ask('tool', true), ask('question', true)]), true), 'ok', 'answered cards do not hold it');
  assert.equal(R.movable(chat({ sessionId: null }, [cameFrom]), true), 'ok', 'a chat moved here and not yet started can move again');
});

test('not while it works, or waits on an approval or a question: after this turn', () => {
  assert.equal(R.movable(chat({ busy: true }), true), 'busy');
  assert.equal(R.movable(chat({ busy: true }, [ask('tool')]), true), 'busy');
  assert.equal(R.movable(chat({ busy: true }, [ask('question')]), true), 'busy');
  assert.equal(R.movable(chat({}, [ask('question')]), true), 'busy', 'a question that waits with no turn behind it still waits on you');
  assert.equal(R.movable(chat({ loading: true }), true), 'busy');
  assert.equal(R.movable({ ...chat(), cutPending: true }, true), 'busy', 'an edit is on its way');
  assert.equal(R.movable(chat({ sessionId: null, busy: true }, [user]), true), 'busy', 'working on its very first message');
});

test('while only a plan waits, the chat can move', () => {
  assert.equal(R.movable(chat({ busy: true }, [user, ask('plan')]), true), 'ok', 'a Claude chat\'s turn is paused on its plan');
  assert.equal(R.movable(chat({ busy: false }, [user, ask('plan')]), true), 'ok', 'an OpenAI chat\'s plan has no turn behind it');
  assert.equal(R.movable(chat({ busy: true }, [ask('plan'), ask('question')]), true), 'busy', 'a plan and a question: the question holds it');
  assert.equal(R.onlyPlanWaits(chat({}, [ask('plan')])), true);
  assert.equal(R.onlyPlanWaits(chat({}, [ask('plan', true)])), false, 'an answered plan is not waiting');
  assert.equal(R.onlyPlanWaits(chat()), false);
});

test('there is nothing to move in a chat that has not started, and nowhere to move it without the other maker\'s models', () => {
  assert.equal(R.movable(chat({ sessionId: null }), true), 'no');
  assert.equal(R.movable(chat({ sessionId: null }, [{ t: 'error' }]), true), 'no', 'a chat that failed to open: the row opens a new chat, as before');
  assert.equal(R.movable(chat(), false), 'no');
  assert.equal(R.movable(null, true), 'no');
  assert.equal(R.movable(undefined, true), 'no');
});

test('"Move to …" lands on your last pick for that maker, else the first of its rows in the menu', () => {
  const firstOpenai = M.splitMenu(ALL).rows.find((m) => m.maker === 'openai');
  const firstClaude = M.splitMenu(ALL).rows.find((m) => m.maker === 'claude');
  assert.deepEqual(R.targetFor(ALL, 'codex', {}), { engine: 'codex', value: firstOpenai.id, label: firstOpenai.label });
  const other = ALL.filter((m) => m.maker === 'openai').at(-1);
  assert.deepEqual(R.targetFor(ALL, 'codex', { codex: { model: other.id } }), { engine: 'codex', value: other.id, label: other.label });
  assert.deepEqual(R.targetFor(ALL, 'codex', { codex: { model: 'gone-model' } }), { engine: 'codex', value: firstOpenai.id, label: firstOpenai.label }, 'a pick that is no longer offered');
  assert.equal(R.targetFor(ALL, 'claude', {}).label, firstClaude.label);
  assert.deepEqual(R.targetFor(ALL, 'claude', { model: 'sonnet' }), { engine: 'claude', value: 'sonnet', label: 'Sonnet 5.5' });
  // The four as you arranged them decide "the first row".
  const sonnet = ALL.find((m) => m.id === 'sonnet');
  const arranged = M.slotsFor([sonnet, ...M.splitMenu(ALL).rows.filter((m) => m !== sonnet).slice(0, 3)], ALL);
  assert.equal(R.targetFor(ALL, 'claude', {}, arranged).label, 'Sonnet 5.5');
  assert.equal(R.targetFor(M.allModels(CLAUDE, []), 'codex', {}), null, 'no OpenAI models: nowhere to move');
  assert.equal(R.targetFor(null, 'codex', {}), null);
});

test('a row\'s value as the name on screen', () => {
  assert.equal(R.modelLabel(ALL, 'claude', 'sonnet'), 'Sonnet 5.5');
  assert.equal(R.modelLabel(ALL, 'claude', ''), ALL.find((m) => m.maker === 'claude' && m.isDefault).label, 'nothing picked is Claude Code\'s default');
  const gpt = ALL.find((m) => m.maker === 'openai');
  assert.equal(R.modelLabel(ALL, 'codex', gpt.id), gpt.label);
  assert.equal(R.modelLabel(ALL, 'codex', 'typed-by-hand'), 'typed-by-hand');
});

test('the words', () => {
  assert.equal(R.rowWords('ok'), 'Move chat');
  assert.equal(R.rowWords('busy'), 'After this turn');
  assert.equal(R.rowWords('no'), 'New chat');
  assert.equal(R.rowWords(undefined), 'New chat');
  assert.equal(R.moveItem('codex'), 'Move to OpenAI');
  assert.equal(R.moveItem('claude'), 'Move to Claude');
  assert.equal(R.moveLine('GPT-6.1-Sol', 'ok'), 'Continues in GPT-6.1-Sol with this chat’s context');
  assert.equal(R.moveLine('GPT-6.1-Sol', 'busy'), 'Available after this turn');
  assert.equal(R.MOVE_BUSY, HOST_BUSY, 'the window and main say the same sentence');
  assert.equal(R.otherEngine('claude'), 'codex');
  assert.equal(R.otherEngine('codex'), 'claude');
});

test('backTarget: the session the other maker already has in this chat\'s thread', () => {
  const sw = (from, to, extra = {}) => ({ t: 'handoff', ev: { dir: 'switch', from, to, ...extra } });
  const A = { id: 'claude-a', engine: 'claude', model: 'Opus 5.5' }, B = { id: 'codex-b', engine: 'codex', model: 'GPT-6.1-Sol' };
  assert.equal(R.backTarget(chat({}, [user]), 'codex'), null, 'never moved: a move starts a new session');
  assert.equal(R.backTarget(chat({ sessionId: 'codex-b' }, [user, sw(A, B), user]), 'claude'), 'claude-a', 'on Codex, back to Claude');
  assert.equal(R.backTarget(chat({ sessionId: 'claude-a' }, [sw(A, B), sw(B, A)]), 'codex'), 'codex-b', 'and over again');
  assert.equal(R.backTarget(chat({ sessionId: null }, [sw(A, { id: null, engine: 'codex' }, { pending: true })]), 'codex'), null, 'a session with no id yet is nowhere to go back to');
  assert.equal(R.backTarget(null, 'codex'), null);
});
