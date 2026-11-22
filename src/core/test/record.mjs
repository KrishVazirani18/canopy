// Re-records the frame fixtures from one throwaway conversation with the real
// claude (haiku, tiny prompts, a folder under /tmp, no user or project settings).
//
//   node src/core/test/record.mjs            write fixtures/live-*.json
//   node src/core/test/record.mjs --print    show the frame types instead
//
// It talks to the SDK directly, not through Session, so the fixtures stay an
// independent record of what the CLI sends.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSessionMessages, query } from '@anthropic-ai/claude-agent-sdk';
import { FIXTURES, POOL_PREFIX, acquireLock, cleanup, emptyDir, findClaudeBin, neutralIds, noteSessionId, releaseLock, scrubbedEnv, sleep, within } from './helpers.mjs';

const print = process.argv.includes('--print');
const cwd = `${POOL_PREFIX}1`;

class Feed {
  constructor() { this.items = []; this.waiter = null; this.done = false; }
  push(x) { if (this.waiter) { const w = this.waiter; this.waiter = null; w({ value: x, done: false }); } else this.items.push(x); }
  end() { this.done = true; this.waiter?.({ value: undefined, done: true }); }
  [Symbol.asyncIterator]() {
    return { next: () => (this.items.length ? Promise.resolve({ value: this.items.shift(), done: false }) : this.done ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => { this.waiter = r; })) };
  }
}

const user = (text, id = randomUUID()) => ({ type: 'user', uuid: id, session_id: '', origin: { kind: 'human' }, message: { role: 'user', content: text }, parent_tool_use_id: null });

// Fixtures are committed, so nothing personal may survive: home paths, the
// account, ids that point at this machine.
function sanitize(value) {
  const home = os.homedir();
  const name = os.userInfo().username;
  const walk = (v, key) => {
    if (typeof v === 'string') {
      let s = v.split(home).join('/Users/test').split(name).join('test');
      if (key === 'signature' || key === 'data') s = s.slice(0, 16);
      return s;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === 'messaging_socket_path') { out[k] = '/tmp/redacted.sock'; continue; }
        if (k === 'account' || k === 'email' || k === 'organization') continue;
        if ((k === 'tools' || k === 'slash_commands' || k === 'skills' || k === 'terminal_slash_commands' || k === 'agents') && Array.isArray(x)) { out[k] = x.slice(0, 6).map((y) => walk(y)); continue; }
        out[k] = walk(x, k);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

async function main() {
  const lock = acquireLock();
  if (!lock.ok) throw new Error(lock.message);
  const env = scrubbedEnv({ CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1', CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' });
  const claude = findClaudeBin(env);
  if (!claude) throw new Error('claude is not installed');
  emptyDir(cwd);

  const feed = new Feed();
  const frames = [];
  const waiters = new Set();
  const q = query({
    prompt: feed,
    options: {
      pathToClaudeCodeExecutable: claude, cwd, env, model: 'haiku',
      settingSources: [], strictMcpConfig: true, includePartialMessages: true, includeHookEvents: true,
      enableFileCheckpointing: true, forwardSubagentText: true, promptSuggestions: false,
      extraArgs: { 'thinking-display': 'summarized' },
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
    },
  });
  const pump = (async () => {
    try {
      for await (const m of q) {
        frames.push(m);
        if (m.session_id) noteSessionId(m.session_id);
        for (const w of [...waiters]) w(m);
      }
    } catch (err) { frames.push({ type: '__iterator_error', message: String(err?.message ?? err) }); }
  })();
  const until = (test, ms = 90000) => within(new Promise((resolve) => {
    const hit = frames.find(test);
    if (hit) return resolve(hit);
    const w = (m) => { if (test(m)) { waiters.delete(w); resolve(m); } };
    waiters.add(w);
  }), ms, 'frame');
  const idleAfter = async (from) => { await until((m) => frames.indexOf(m) >= from && m.type === 'system' && m.subtype === 'session_state_changed' && m.state === 'idle'); };

  const cuts = {};
  let from = 0;
  const cut = (name) => { cuts[name] = frames.slice(from); from = frames.length; };

  // 1. A tool turn: Write, tool_result with tool_use_result, final text.
  feed.push(user('Use the Write tool to create the file note.txt containing exactly: hi. Then reply with exactly: OK'));
  await idleAfter(from); cut('tool-turn');
  const firstSession = frames.find((m) => m.type === 'system' && m.subtype === 'init')?.session_id;

  // 2. Interrupt with a queued message behind it.
  const queuedId = randomUUID();
  feed.push(user('Count from 1 to 400, one number per line, and nothing else.'));
  await until((m) => frames.indexOf(m) >= from && m.type === 'stream_event' && m.event?.type === 'content_block_delta');
  feed.push(user('Reply with exactly: QUEUED', queuedId));
  await sleep(400);
  const receipt = await q.interrupt({ cancelQueued: true });
  await idleAfter(from); cut('interrupt');

  // 3. A local slash command, then /clear.
  feed.push(user('/context'));
  await idleAfter(from); cut('local-command');
  feed.push(user('/clear'));
  await idleAfter(from); cut('clear');

  feed.end();
  q.close();
  await within(pump, 10000, 'pump').catch(() => {});

  const history = firstSession ? await getSessionMessages(firstSession, { dir: cwd }).catch(() => []) : [];

  if (print) {
    for (const [name, list] of Object.entries(cuts)) {
      console.log(`\n== ${name} (${list.length})`);
      for (const m of list) console.log(' ', [m.type, m.subtype, m.event?.type, m.state].filter(Boolean).join('/'), Object.keys(m).join(','));
    }
    console.log('\n== interrupt receipt', JSON.stringify(receipt));
    console.log(`== history (${history.length})`);
    for (const m of history) console.log(' ', m.type, Object.keys(m).join(','), JSON.stringify(m.message?.content ?? '').slice(0, 110));
  } else {
    fs.mkdirSync(FIXTURES, { recursive: true });
    // Every id (session, message, request, tool use) leaves as a made-up one: see neutralIds in helpers.mjs.
    const write = (name, value) => fs.writeFileSync(path.join(FIXTURES, `live-${name}.json`), neutralIds(JSON.stringify(sanitize(value), null, 1)) + '\n');
    for (const [name, list] of Object.entries(cuts)) write(name, list);
    write('history', history);
    write('meta', { queuedId, receipt, recordedWith: frames.find((m) => m.subtype === 'init')?.claude_code_version ?? null });
    console.log(`recorded ${Object.values(cuts).reduce((n, l) => n + l.length, 0)} frames and ${history.length} history rows into ${FIXTURES}`);
  }
}

let code = 0;
try { await main(); } catch (err) { console.error(`record failed: ${err?.message ?? err}`); code = 1; }
cleanup();
releaseLock();
process.exit(code);
