// Names for Codex chats. Codex's apps name a chat themselves: the Codex app asks a model for a short title and
// saves it as the chat's name. Codex's app-server, which Canopy talks to, can only *set* a name, so Canopy does what
// the apps do. Once a chat's first real exchange is done (small talk skipped, as for Claude chats in
// chat-titles.mjs), it asks Codex for a title with Codex's own title prompt, on the lightest model, in a throwaway
// thread (CodexService.suggestTitle), and names the chat with it. The name is Codex's, so it shows in the Codex app too.
//
// One try per chat. A name you gave the chat is never touched: the chat list remembers who named it (`named`), and a
// chat from before that whose name isn't its first message counts as yours. Measured Nov 16 2026: about 8,600 tokens
// a name on GPT-6-Luna at standard speed, about a tenth of a cent.
//
// When a chat's first message is edited (edit and resend), a name Canopy gave it described words that are gone: it
// is worked out again from the new first exchange (again()), as chat-titles.mjs does for Claude chats.
//
// The question goes to a model, so it is asked on the account the chat itself is on (titleHelper): a chat begun on an
// API key pasted into Canopy is named on that key, never on Codex's own login, and the other way round.
import { isSmallTalk, plain } from './chat-titles.mjs';

const TITLE_CHARS = 48;
const MAX_USER = 450;
const MAX_REPLY = 520;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Codex's own title prompt, so names read like the Codex app's. The wording comes from openai/codex (the Codex
 * terminal app, 0.153), which OpenAI publishes under the Apache License 2.0; only the length limit is Canopy's.
 */
export function titlePrompt({ user, reply }) {
  return `Generate a concise, single-line task title of at most ${TITLE_CHARS} characters and under five words where possible. `
    + 'Start with an imperative verb. Capitalize only the first word unless the user\'s language, proper nouns, acronyms, or code terms require otherwise. '
    + 'Preserve ticket references exactly. Write in the user\'s language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.\n'
    + 'Prioritize the current task and latest substantive user request.\n'
    + `Recent conversation messages:\nUser: ${clip(user, MAX_USER)}\nAssistant: ${clip(reply, MAX_REPLY)}`;
}

/** The model's answer as a name: its first line, without quotes, markdown or a full stop; null if nothing is left. */
export function cleanTitle(text) {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const t = line.replace(/^(?:title\s*:\s*)/i, '').replace(/[*_`#]+/g, '').replace(/^["'“‘]+|["'”’]+$/g, '').replace(/[.!?;:,]+$/, '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 80) : null;
}

const userText = (item) => (Array.isArray(item?.content) ? item.content : []).filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');

/**
 * The first exchange worth naming, from Codex's turns (oldest first): the first message that isn't small talk and
 * the answer to it (a turn's last message; the ones before it are progress notes). null when there is none yet.
 */
export function firstExchange(turns) {
  for (const t of Array.isArray(turns) ? turns : []) {
    const items = Array.isArray(t?.items) ? t.items : [];
    const user = plain(items.filter((i) => i?.type === 'userMessage').map(userText).join('\n'));
    const answers = items.filter((i) => i?.type === 'agentMessage' && typeof i.text === 'string' && i.text.trim());
    const reply = plain(answers.at(-1)?.text ?? '');
    if (!user || !reply) continue;
    if (isSmallTalk(user)) continue;
    return { user, reply };
  }
  return null;
}

/** The first thing you wrote in the chat, as Canopy's list first names it (entry.title), for telling it from a real name. */
const firstMessage = (turns) => {
  const t = (Array.isArray(turns) ? turns : []).find((x) => (x?.items ?? []).some((i) => i?.type === 'userMessage'));
  return t ? userText(t.items.find((i) => i?.type === 'userMessage')).replace(/\s+/g, ' ').trim() : '';
};

/** The model to ask: Codex's lightest (a Luna), else its default, else whatever Codex picks. And its lowest effort. */
export function pickModel(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((m) => m && typeof m.value === 'string' && !m.hidden);
  const m = list.find((x) => /luna/i.test(x.value)) ?? list.find((x) => x.isDefault) ?? null;
  const order = ['none', 'minimal', 'low', 'medium'];
  const effort = m ? order.find((e) => m.supportedEffortLevels?.includes(e)) ?? null : null;
  return { model: m?.value ?? null, effort };
}

/**
 * The helper that may ask a model about a chat: the one on the chat's own account, so naming a chat never uses
 * another account. `began`: the pasted key the chat began on, as its account's id (null: Codex's own login).
 * A chat on Codex's own login is asked about through `own`, Codex as it finds itself. One begun on a pasted key is
 * asked about through `onKey`, the helper started for the key in use, while that key (`keyInUse`) is its own;
 * otherwise through nobody (null), and the chat keeps the name it has.
 */
export function titleHelper({ began, keyInUse, own, onKey } = {}) {
  if (!began) return own ?? null;
  return began === keyInUse ? onKey ?? null : null;
}

export class CodexTitler {
  /**
   * @param {{ service: { turns: Function, suggestTitle: Function, models: Function },
   *   helperFor?: (id: string) => { suggestTitle: Function, models: Function } | null,
   *   chats: { get: (id: string) => object | null, markNamed: (id: string, by: string) => void },
   *   rename: (id: string, title: string) => Promise<unknown>, onTitled?: (id: string, title: string) => void,
   *   log?: (msg: string) => void }} opts
   *   `service` reads the chat (no model is asked). `helperFor(id)` is who asks the model for the name (see
   *   titleHelper); left out, `service` does. When it answers null the chat is not named now, and is looked at
   *   again after its next turn.
   */
  constructor({ service, helperFor, chats, rename, onTitled, log }) {
    this.service = service;
    this.helperFor = typeof helperFor === 'function' ? helperFor : () => this.service;
    this.chats = chats;
    this.rename = rename;
    this.onTitled = onTitled ?? (() => {});
    this.log = log ?? (() => {});
    this.done = new Set();   // named, or tried once, this run
    this.busy = new Set();
    this.redo = new Set();   // chats carrying Canopy's name whose first message was edited: named again after their next turn
    this.edits = new Map();  // chat -> how often its first message was edited: a try that straddles an edit is dropped
  }

  /**
   * The chat's first message was edited (edit and resend), so what the chat is called was about words that are gone.
   * A name Canopy gave it is made again after the next turn, as for a Claude chat; a name you gave it stays. A try
   * already under way is dropped: it may have read the conversation as it was before the edit.
   */
  again(id) {
    if (!id) return;
    this.edits.set(id, (this.edits.get(id) ?? 0) + 1);
    const named = this.chats.get(id)?.named;
    if (named === 'you') return;
    if (named === 'canopy') this.redo.add(id);
    this.done.delete(id);
  }

  /** Call when a Codex chat's turn ends. Names it once its first real exchange is done. */
  async afterTurn(id) {
    if (!id || this.done.has(id) || this.busy.has(id)) return;
    const e = this.chats.get(id);
    const redo = this.redo.has(id) && e?.named === 'canopy'; // Canopy's own name, for a first message that is gone
    if (!e || (e.named && !redo)) { this.done.add(id); this.redo.delete(id); return; }
    const edits = this.edits.get(id) ?? 0;
    const moved = () => (this.edits.get(id) ?? 0) !== edits; // the first message was edited while this was at it
    this.busy.add(id);
    try {
      const r = await this.service.turns(id, { maxTurns: 20 });
      if (!r?.ok || moved()) return; // try again after the next turn
      // A long chat from before Canopy named Codex chats: its first exchange is out of reach, and it was named or not
      // long ago. Leave it.
      if (r.truncated) { this.done.add(id); return; }
      // A name that isn't the first message was given by you (or by the Codex app) before Canopy kept track.
      const first = firstMessage(r.turns);
      const title = typeof e.title === 'string' ? e.title.replace(/\s+/g, ' ').trim() : '';
      if (!redo && title && first && !first.startsWith(title.replace(/…$/, '')) && !title.startsWith(first.slice(0, 40))) {
        this.chats.markNamed(id, 'you'); this.done.add(id); return;
      }
      const ex = firstExchange(r.turns);
      if (!ex) return; // only small talk so far
      const helper = this.helperFor(id);
      if (!helper) return; // nothing is running on this chat's account that could be asked: after a later turn, maybe
      this.done.add(id);
      const models = await helper.models();
      const { model, effort } = pickModel(models?.ok ? models.models : []);
      const answer = await helper.suggestTitle(titlePrompt(ex), { model, effort });
      if (moved()) { this.done.delete(id); return; } // the exchange it was named after is no longer the chat's first
      const name = answer?.ok ? cleanTitle(answer.title) : null;
      if (!name) { if (!answer?.ok) this.log(`codex title: ${answer?.message ?? answer?.code ?? 'no answer'}`); return; }
      const by = this.chats.get(id)?.named;
      if (by && !(redo && by === 'canopy')) return; // you named it meanwhile
      this.redo.delete(id);
      await this.rename(id, name);
      this.chats.markNamed(id, 'canopy');
      this.onTitled(id, name);
    } catch (err) {
      this.done.add(id);
      this.log(`codex title: ${err?.message ?? err}`);
    } finally { this.busy.delete(id); }
  }
}
