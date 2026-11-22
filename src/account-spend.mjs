// Spend per account: what the Usage tab shows for a login that is billed per use (an API key, a Console sign-in, a
// cloud provider), where there is no plan limit to read. Counted here, on this Mac, from chats. Nothing is asked of
// anyone, so nothing here can touch a login.
//
// Claude, in dollars. Every transcript under Claude Code's folder is priced reply by reply (day-activity.mjs: the
// same count as Home's "today"), and each reply goes to the account its chat was running on at that moment. Canopy
// knows that from spans: `chats[sessionId].spans = [[at, account], …]`, one more whenever a chat's process starts on
// a different account than its last. A chat with no span (run in the terminal, or always on the login Claude Code
// finds on its own) counts toward that login, so with one account "today" here is Home's number exactly.
// A day that is over is counted once more from the transcripts, whole, and kept: "this month" is those days plus
// today. Counting starts the day this first ran (`since`). Before that nothing is known, which is why the month is
// called "Since <date>" until a whole one has been counted.
//
// Codex, in dollars too. Codex has no cost to give for an API key, so each turn's tokens are kept as the turn
// reports them, apart by model and speed and by kind (input, cached input, input written to the cache, output), and
// priced when they are read, at OpenAI's list prices (core/codex-prices.mjs). Keeping the tokens and not the dollars
// means a price that changes with a Canopy update, or a model that only then gets one, is right from then on. A
// model with no known price is never priced: its tokens are handed back as tokens (`unpriced`). So are the tokens
// counted before they were kept apart (`tokenDays`, `tokenChats`: one total, which no price fits).
//
// The host says where state is kept, which account is the default one, and (for tests) how transcripts are read.
// Nothing here touches Electron, and nothing exported throws.
import { codexCost } from './core/codex-prices.mjs';
import { dayActivity, dayKey, spendByDay } from './day-activity.mjs';

const KEEP_DAYS = 62;         // this month and the one before it
const MAX_CHATS = 2000;       // chats with spans (only those that ran on something other than the default login)
const MAX_SPANS = 24;         // per chat
const MAX_TOKEN_CHATS = 500;
const MAX_KINDS = 40;         // models and speeds kept apart, per account and day, and per chat
const UNNAMED = '';           // "the login the tool finds on its own", when its id was not known at the time

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (k) => typeof k === 'string' && DAY_KEY.test(k);
const amount = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const name = (v) => (typeof v === 'string' && v.length <= 80 ? v : null);

const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
// Calendar days, not 24 hours: a day with a clock change is 23 or 25 hours long.
const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
const startOfMonth = (ms) => { const d = new Date(ms); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayStart = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

// { day: { account: amount } }, with nothing in it that is not a day, a short name and a positive number.
function buckets(raw) {
  const out = {};
  for (const [day, by] of Object.entries(isPlain(raw) ? raw : {})) {
    if (!isDay(day) || !isPlain(by)) continue;
    const kept = {};
    for (const [id, v] of Object.entries(by)) if (name(id) !== null && amount(v)) kept[id] = v;
    if (Object.keys(kept).length) out[day] = kept;
  }
  return out;
}

// A Codex turn's tokens, each counted once: [input, cached input, input written to the cache, output].
const KINDS = 4;
const useOf = (u) => [amount(u?.inputTokens), amount(u?.cacheReadInputTokens), amount(u?.cacheCreationInputTokens), amount(u?.outputTokens)];
const word = (v, max) => (typeof v === 'string' && v.length <= max && !v.includes('|') ? v : '');
// What the tokens are kept under: the model and the speed it ran at ("gpt-6.1-sol|priority"; standard speed is "").
const kindKey = (model, tier) => `${word(model, 80)}|${tier === 'default' ? '' : word(tier, 24)}`;
// { "model|speed": [input, cached, written, output] }, with nothing else in it.
function uses(raw) {
  const out = {};
  for (const [key, u] of Object.entries(isPlain(raw) ? raw : {}).slice(0, MAX_KINDS)) {
    if (!key.includes('|') || key.length > 110 || !Array.isArray(u)) continue;
    const kept = Array.from({ length: KINDS }, (_, i) => amount(u[i]));
    if (kept.some(Boolean)) out[key] = kept;
  }
  return out;
}
function addUse(into, key, use) {
  if (!into[key] && Object.keys(into).length >= MAX_KINDS) key = '|'; // past the cap, the rest is kept as tokens of no known model
  const had = into[key] ?? [0, 0, 0, 0];
  into[key] = had.map((n, i) => n + use[i]);
}
// { day: { account: { "model|speed": [...] } } }
function useDays(raw) {
  const out = {};
  for (const [day, by] of Object.entries(isPlain(raw) ? raw : {})) {
    if (!isDay(day) || !isPlain(by)) continue;
    const kept = {};
    for (const [id, u] of Object.entries(by)) { const k = name(id) !== null ? uses(u) : {}; if (Object.keys(k).length) kept[id] = k; }
    if (Object.keys(kept).length) out[day] = kept;
  }
  return out;
}

export class AccountSpend {
  /**
   * @param {{
   *   load?: () => object | null | undefined, save?: (state: object) => unknown,   state.json's `accountSpend`
   *   defaultAccount?: (engine: 'claude' | 'codex') => string | null,   the account the tool finds on its own
   *   configDir?: () => string | undefined,     Claude Code's folder (default: the one the shell points it at)
   *   read?: { day: typeof dayActivity, days: typeof spendByDay },   the test seam
   *   now?: () => number, log?: (msg: string) => void,
   * }} deps
   */
  constructor({ load, save, defaultAccount, configDir, read, now, log } = {}) {
    this.saveFn = typeof save === 'function' ? save : () => {};
    this.defaultFn = typeof defaultAccount === 'function' ? defaultAccount : () => null;
    this.configDir = typeof configDir === 'function' ? configDir : () => undefined;
    this.read = { day: read?.day ?? dayActivity, days: read?.days ?? spendByDay };
    this.now = typeof now === 'function' ? now : Date.now;
    this.logFn = typeof log === 'function' ? log : () => {};
    this.loadFn = typeof load === 'function' ? load : () => null;
    this.loaded = null;  // what is kept, read from the host on first use (see `state`)
    this.settling = null;
    this.saved = null;   // the JSON last handed to the host
  }

  // What is kept, read once, on first use, field by field. What cannot be read starts counting from today.
  get state() {
    if (this.loaded) return this.loaded;
    let saved = null;
    try { saved = this.loadFn() ?? null; } catch { /* unreadable */ }
    const s = isPlain(saved) ? saved : {};
    const chats = {};
    for (const [id, c] of Object.entries(isPlain(s.chats) ? s.chats : {})) {
      const spans = (Array.isArray(c?.spans) ? c.spans : []).filter((x) => Array.isArray(x) && amount(x[0]) && name(x[1])).map((x) => [x[0], x[1]]).slice(-MAX_SPANS);
      if (name(id) && spans.length) chats[id] = { seen: isDay(c.seen) ? c.seen : dayKey(spans.at(-1)[0]), spans };
    }
    const tokenChats = {};
    for (const [id, c] of Object.entries(isPlain(s.tokenChats) ? s.tokenChats : {})) if (name(id) && amount(c?.n)) tokenChats[id] = { n: c.n, at: amount(c.at) };
    const codexChats = {};
    for (const [id, c] of Object.entries(isPlain(s.codexChats) ? s.codexChats : {})) {
      const use = uses(c?.use);
      if (name(id) && Object.keys(use).length) codexChats[id] = { at: amount(c.at), use };
    }
    this.loaded = {
      v: 1,
      since: isDay(s.since) ? s.since : null,     // the first day counted
      closed: isDay(s.closed) ? s.closed : null,   // the last day counted whole, from the transcripts
      chats, days: buckets(s.days),
      codexDays: useDays(s.codexDays), codexChats,          // Codex's tokens, by model and speed and by kind
      tokenDays: buckets(s.tokenDays), tokenChats,          // Codex's tokens from before that: one total each
    };
    return this.loaded;
  }

  log(msg) { try { this.logFn(msg); } catch { /* logging never breaks a count */ } }

  // ---- which account a chat ran on ----

  /**
   * A chat's process started. `account` is the one the chat was started on (null: whatever Claude Code finds).
   * Written down only when it differs from the chat's last span, and a chat that has only ever been on the login
   * Claude Code finds on its own has no span at all. Returns whether anything was recorded.
   */
  started(sessionId, account, at = this.now()) {
    try {
      if (name(sessionId) === null || !sessionId) return false;
      const found = this.#found('claude');
      const id = name(account) || found;
      if (!id) return false; // nothing known about who this is: it counts toward the default login, like any chat without a span
      const chat = this.state.chats[sessionId];
      const day = dayKey(at);
      if (!chat) {
        if (id === found) return false;
        this.state.chats[sessionId] = { seen: day, spans: [[at, id]] };
      } else if (chat.spans.at(-1)[1] !== id) {
        chat.spans = [...chat.spans, [at, id]].slice(-MAX_SPANS);
        chat.seen = day;
      } else if (chat.seen !== day) chat.seen = day; // still in use: the oldest unused chats are the ones forgotten
      else return false;
      this.#save();
      return true;
    } catch (err) { this.log(`could not record a chat's account (${err?.message ?? err})`); return false; }
  }

  /** The account a chat was on when a reply landed at `at`, or null: no span covers it, so it is the default login's. */
  accountAt(sessionId, at) {
    const spans = this.state.chats[sessionId]?.spans;
    if (!spans) return null;
    let hit = null;
    for (const [from, id] of spans) { if (from <= at) hit = id; else break; }
    return hit;
  }

  /** Whose reply it was, for day-activity.mjs: the chat's span, else the login Claude Code finds on its own. */
  attribute = (chat, at) => this.accountAt(chat, at) ?? this.#found('claude') ?? UNNAMED;

  // ---- Claude: dollars ----

  /**
   * What an account has spent: { unit: 'usd', today, month, since }. `since` is when counting began (ms), when that
   * is later than the first of this month; null once the whole month has been counted. Reads today's transcripts
   * (only what is new since the last read), and first counts any day that has ended since the last time.
   * Rejects when the transcripts cannot be read.
   */
  async dollars(account) {
    const now = this.now();
    await this.settle();
    const day = await this.read.day({ since: startOfDay(now), now, configDir: this.configDir(), attribute: this.attribute });
    const today = dayKey(now);
    const counted = buckets({ [today]: day?.byAccount })[today];
    if (counted) this.state.days[today] = counted; else delete this.state.days[today];
    this.#save();
    return { unit: 'usd', today: this.#of(counted, account, 'claude'), month: this.#month(this.state.days, account, 'claude', now), since: this.#since(now) };
  }

  /**
   * Count the days that have ended since the last time, whole, from the transcripts. One run at a time; a day is
   * only marked done once it has been read, so a failed read is simply tried again. Never rejects.
   */
  settle() {
    this.settling ??= this.#settle().catch((err) => this.log(`could not count the days that are over (${err?.message ?? err})`)).finally(() => { this.settling = null; });
    return this.settling;
  }

  async #settle() {
    const today = startOfDay(this.now());
    const yesterday = dayKey(addDays(today, -1));
    if (!this.state.since) { this.state.since = dayKey(today); this.state.closed = yesterday; this.#save(); return; }
    if (this.state.closed && this.state.closed >= yesterday) return;
    const from = Math.max(dayStart(this.state.since), this.state.closed ? addDays(dayStart(this.state.closed), 1) : 0, addDays(today, -KEEP_DAYS));
    if (from < today) {
      const got = buckets(await this.read.days({ from, to: today, configDir: this.configDir(), attribute: this.attribute }));
      // Every day in the range is now final. A day with nothing spent has no entry.
      for (let d = from; d < today; d = addDays(d, 1)) { const k = dayKey(d); if (got[k]) this.state.days[k] = got[k]; else delete this.state.days[k]; }
    }
    this.state.closed = yesterday;
    this.#save();
  }

  // ---- Codex: dollars, worked out from tokens ----

  /**
   * A Codex turn ended, in this chat, on this account (null: the login Codex finds). `usage` is what the turn used
   * as it reports it: { inputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens }, each token in
   * one of them. `model` and `tier` (Codex's word for the speed: null, 'priority', 'ultrafast', 'flex') say which
   * price is theirs; a turn that names no model is kept all the same, and shown as tokens.
   */
  addTurn(threadId, account, turn, at = this.now()) {
    try {
      const { model = null, tier = null, usage = null } = isPlain(turn) ? turn : {};
      const use = useOf(usage);
      if (!use.some(Boolean)) return;
      if (!this.state.since) { this.state.since = dayKey(at); this.state.closed = dayKey(addDays(startOfDay(at), -1)); }
      const id = name(account) || this.#found('codex') || UNNAMED;
      const key = kindKey(model, tier);
      addUse(((this.state.codexDays[dayKey(at)] ??= {})[id] ??= {}), key, use);
      if (name(threadId)) {
        const chat = (this.state.codexChats[threadId] ??= { at, use: {} });
        chat.at = at;
        addUse(chat.use, key, use);
      }
      this.#save();
    } catch (err) { this.log(`could not count a turn's tokens (${err?.message ?? err})`); }
  }

  /**
   * What an account has spent on Codex, at list prices: { unit: 'usd', today, month, since }, as counted so far.
   * With tokens that have no known price, also `unpriced: { today, month, models }`: how many, and which models
   * (none named for tokens whose model was never known). No reading, no waiting.
   */
  codex(account) {
    const now = this.now();
    const first = dayKey(startOfMonth(now)), today = dayKey(now);
    const sum = { today: 0, month: 0 }, loose = { today: 0, month: 0 }, models = new Set();
    const put = (day, usd, tokens) => {
      sum.month += usd; loose.month += tokens;
      if (day === today) { sum.today += usd; loose.today += tokens; }
    };
    for (const [day, by] of Object.entries(this.state.codexDays)) {
      if (day < first || day > today) continue;
      for (const id of this.#ids(account, 'codex')) { const p = this.#price(by[id], dayStart(day), models); put(day, p.usd, p.tokens); }
    }
    for (const [day, bucket] of Object.entries(this.state.tokenDays)) if (day >= first && day <= today) put(day, 0, this.#of(bucket, account, 'codex'));
    return { unit: 'usd', ...sum, since: this.#since(now), ...(loose.month > 0 && { unpriced: { ...loose, models: [...models].sort() } }) };
  }

  /** One Codex chat, as counted so far: { amount, unpriced } (dollars, and the tokens no price is known for), or null when nothing has been. */
  codexChat(threadId) {
    const kept = this.state.codexChats[threadId], old = this.state.tokenChats[threadId];
    if (!kept && !old) return null;
    const p = this.#price(kept?.use, kept?.at || this.now(), new Set());
    return { amount: p.usd, unpriced: p.tokens + amount(old?.n) };
  }

  // The dollars in one lot of tokens, and the tokens no price is known for. Their models are added to `models`.
  #price(use, at, models) {
    let usd = 0, tokens = 0;
    for (const [key, counts] of Object.entries(isPlain(use) ? use : {})) {
      const [model, tier] = key.split('|');
      const cost = codexCost(model, tier || null, counts, at);
      if (cost !== null) { usd += cost; continue; }
      tokens += counts.reduce((n, x) => n + amount(x), 0);
      if (model) models.add(model);
    }
    return { usd, tokens };
  }

  // The names an account's count is kept under: its own, and '' for what was counted before the default login had one.
  #ids(account, engine) {
    if (!name(account)) return [];
    return account === this.#found(engine) ? [account, UNNAMED] : [account];
  }

  // ---- internals ----

  #found(engine) { try { return name(this.defaultFn(engine)) || null; } catch { return null; } }

  // One day's amount for an account. What was counted before the default login had a name is the default login's.
  #of(bucket, account, engine) {
    if (!isPlain(bucket) || !name(account)) return 0;
    return amount(bucket[account]) + (account === this.#found(engine) ? amount(bucket[UNNAMED]) : 0);
  }

  #month(days, account, engine, now) {
    const first = dayKey(startOfMonth(now)), last = dayKey(now);
    let sum = 0;
    for (const [day, bucket] of Object.entries(days)) if (day >= first && day <= last) sum += this.#of(bucket, account, engine);
    return sum;
  }

  #since(now) {
    const s = this.state.since;
    return s && s > dayKey(startOfMonth(now)) ? dayStart(s) : null;
  }

  #save() {
    try {
      const st = this.state;
      const oldest = dayKey(addDays(startOfDay(this.now()), -KEEP_DAYS));
      for (const field of ['days', 'tokenDays', 'codexDays']) for (const day of Object.keys(st[field])) if (day < oldest) delete st[field][day];
      // A chat not opened in Canopy for that long has no reply in any day still kept.
      for (const [id, c] of Object.entries(st.chats)) if (c.seen < oldest) delete st.chats[id];
      // Past the cap, the ones unused the longest go first.
      const drop = (map, max, age) => {
        const ids = Object.keys(map);
        if (ids.length <= max) return;
        const oldestFirst = ids.sort((a, b) => { const x = age(map[a]), y = age(map[b]); return x < y ? -1 : x > y ? 1 : 0; });
        for (const id of oldestFirst.slice(0, ids.length - max)) delete map[id];
      };
      drop(st.chats, MAX_CHATS, (c) => c.seen);
      drop(st.tokenChats, MAX_TOKEN_CHATS, (c) => c.at);
      drop(st.codexChats, MAX_TOKEN_CHATS, (c) => c.at);
      const json = JSON.stringify(st);
      if (json === this.saved) return; // counted again and nothing moved: nothing to write
      this.saved = json;
      // A copy: the host keeps what it is handed, and this object goes on changing.
      Promise.resolve(this.saveFn(JSON.parse(json))).catch((err) => this.log(`save failed: ${err?.message ?? err}`));
    } catch (err) { this.log(`save failed: ${err?.message ?? err}`); }
  }
}
