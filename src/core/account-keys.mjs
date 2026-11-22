// Pasted API keys: is this text a key Canopy may keep, and does its maker accept it?
//
//   keyShape(engine, text)   what was pasted, as a key: { ok: true, key, hint } or { ok: false, code, message }
//   checkKey(key, …)         ask the key's maker whether it works: one request that lists models, nothing billed
//
// Only API keys are taken: an Anthropic key for Claude's chats, an OpenAI key for Codex's. A sign-in token (what a
// plan login holds) is refused by its shape, before it is sent anywhere: Canopy never holds a plan login (see
// accounts.mjs). An Admin key manages an organization and cannot run a chat. A key of the other maker is refused
// with a line saying where it goes.
//
// Nothing here stores or logs a key. `keyShape` hands back the key it was given, trimmed; `checkKey` sends it to
// its maker's own API and nowhere else (a redirect is an error, never followed), and its answer never contains it.

/** Where a key is checked. Listing models needs a working key and costs nothing. */
export const CHECK_URL = 'https://api.anthropic.com/v1/models?limit=1';
export const OPENAI_CHECK_URL = 'https://api.openai.com/v1/models';
const API_VERSION = '2023-06-01';

const fail = (code, message) => ({ ok: false, code, message });
const ADMIN_KEY = 'That is an Admin API key. It manages an organization and can’t run chats. Paste a regular API key.';

// What each maker's key looks like, and what is refused with a reason of its own before that is asked.
function anthropicKey(key) {
  // A sign-in or refresh token of a Claude plan, or a claude.ai session: never a key, and never Canopy's to hold.
  if (/^sk-ant-(?:oat|ort|sid)/i.test(key)) return fail('plan-token', 'That is a Claude sign-in token, not an API key. Canopy doesn’t take sign-in tokens. Create an API key in the Claude Console instead.');
  if (/^sk-ant-admin/i.test(key)) return fail('admin-key', ADMIN_KEY);
  if (key.length > 512 || !/^sk-ant-api\d{2}-[A-Za-z0-9_-]{16,}$/.test(key)) return fail('not-a-key', 'That doesn’t look like an Anthropic API key. They start with sk-ant-api.');
  return null;
}
function openaiKey(key) {
  if (/^sk-ant-/i.test(key)) return fail('wrong-maker', 'That is an Anthropic API key. Add it under Claude instead.');
  // What a ChatGPT sign-in holds (a signed token in three parts): never a key, and never Canopy's to hold.
  if (/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\./.test(key)) return fail('plan-token', 'That is a ChatGPT sign-in token, not an API key. Canopy doesn’t take sign-in tokens. Create an API key on the OpenAI Platform instead.');
  if (/^sk-admin-/i.test(key)) return fail('admin-key', ADMIN_KEY);
  // A project key, a service account's, or an older one: `sk-`, then letters, digits, dashes and underscores.
  if (key.length > 512 || !/^sk-[A-Za-z0-9][A-Za-z0-9_-]{19,}$/.test(key)) return fail('not-a-key', 'That doesn’t look like an OpenAI API key. They start with sk-.');
  return null;
}
const SHAPES = { claude: anthropicKey, codex: openaiKey };

/**
 * What was pasted, as an API key for an engine's maker.
 * @param {'claude' | 'codex'} engine
 * @param {unknown} text
 * @returns {{ok: true, key: string, hint: string} | {ok: false, code: string, message: string}}
 *   `hint`: the key's last four characters, the only part of it Canopy ever shows or saves.
 *   Codes: `empty`, `plan-token`, `admin-key`, `wrong-maker`, `not-a-key`, `unsupported`.
 */
export function keyShape(engine, text) {
  const refusal = Object.hasOwn(SHAPES, engine) ? SHAPES[engine] : null;
  if (!refusal) return fail('unsupported', 'Canopy doesn’t take API keys for that yet.');
  if (typeof text !== 'string') return fail('empty', 'Paste an API key.');
  // Copied with quotes around it (or one of them), or with a line break after it.
  const key = text.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!key) return fail('empty', 'Paste an API key.');
  return refusal(key) ?? { ok: true, key, hint: key.slice(-4) };
}

// How each maker is asked, and what its answer means. `rejected(status, said)`: the maker does not accept the key.
const MAKERS = {
  claude: {
    name: 'Anthropic', url: CHECK_URL,
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': API_VERSION, accept: 'application/json' }),
    accepted: (status) => status === 200,
    rejected: (status) => status === 401 || status === 403,
  },
  codex: {
    name: 'OpenAI', url: OPENAI_CHECK_URL,
    headers: (key) => ({ authorization: `Bearer ${key}`, accept: 'application/json' }),
    // 403: OpenAI knows the key and will not list models for it (a key limited to some calls, a network it does
    // not serve). That says nothing against the key: what it may do is OpenAI's to say in the chat. Older answers
    // say the same thing about a limited key with a 401, in these words.
    accepted: (status, said) => status === 200 || status === 403 || (status === 401 && /insufficient permissions|missing scopes/i.test(said)),
    rejected: (status) => status === 401,
    reads: (status) => status === 401,
  },
};

// The maker's own sentence about a refusal, to tell a limited key from one it does not know. Read only for that,
// a few thousand characters at most, and never passed on.
async function errorSaid(res) {
  try {
    const said = JSON.parse(String(await res.text()).slice(0, 4096))?.error?.message;
    return typeof said === 'string' ? said : '';
  } catch { return ''; }
}

/**
 * Ask a key's maker whether the key works.
 * @param {string} key
 * @param {{ engine?: 'claude' | 'codex', fetch?: typeof fetch, timeoutMs?: number }} [opts]
 *   `engine`: whose key it is (default Claude's, checked with Anthropic). `fetch`: how the request is made (the test seam)
 * @returns {Promise<{ok: true} | {ok: false, code: 'rejected' | 'unreachable', message: string}>}
 *   `rejected`: the maker answered, and does not accept the key. `unreachable`: no usable answer (offline, a
 *   timeout, a busy or failing server), which says nothing about the key. Never rejects.
 */
export async function checkKey(key, { engine = 'claude', fetch: ask = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const maker = Object.hasOwn(MAKERS, engine) ? MAKERS[engine] : null;
  const unreachable = fail('unreachable', `Canopy couldn’t reach ${maker?.name ?? 'the key’s maker'} to check the key. Check your connection and try again.`);
  if (!maker || typeof key !== 'string' || !key || typeof ask !== 'function') return unreachable;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeoutMs);
  try {
    const res = await ask(maker.url, {
      method: 'GET', headers: maker.headers(key),
      // The key goes to this address only: a redirect would carry the header along, so it is refused.
      redirect: 'error', credentials: 'omit', cache: 'no-store', signal: stop.signal,
    });
    const status = res?.status;
    const said = maker.reads?.(status) ? await errorSaid(res) : '';
    try { await res?.body?.cancel?.(); } catch { /* the rest of the answer is never read */ }
    if (maker.accepted(status, said)) return { ok: true };
    if (maker.rejected(status)) return fail('rejected', `${maker.name} didn’t accept that key. Check that all of it was copied and that it hasn’t been deleted.`);
    return unreachable;
  } catch { return unreachable; } // whatever went wrong is not worded here: an error's text is never passed on
  finally { clearTimeout(timer); }
}
