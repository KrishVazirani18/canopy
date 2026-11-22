// Which model ran each turn of a Codex chat, host side. A turn's footer names its model. A Claude chat's saved
// messages say which model wrote them; Codex keeps no model per turn, so a reopened Codex chat would lose the names.
// Canopy notes them as the turns end and puts them back when the chat is read again.
//
//   const models = new CodexTurnModels({ load, save });     state.json, key `codexTurnModels`
//   models.note(sessionId, turnId, model)     a live turn just ended on this model
//   models.stamp(sessionId, events)           the same events, each known turn's `turn-end` given its `model`
//
// Kept: the newest 300 turns of each of the newest 200 chats, as { [sessionId]: { at, turns: [[turnId, model]] } }.
//
// Contract: nothing here throws. A turn it does not know keeps a footer with no model: nothing is guessed. `stamp`
// never changes an event that already names its model, and returns the list it was given when there is nothing to add.

export const TURNS_PER_CHAT = 300;
export const CHATS_MAX = 200;

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const id = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null);

export class CodexTurnModels {
  /** @param {{ load: () => object | null | undefined, save: (all: object) => unknown, now?: () => number }} opts */
  constructor({ load, save, now } = {}) {
    this.load = typeof load === 'function' ? load : () => null;
    this.save = typeof save === 'function' ? save : () => {};
    this.now = typeof now === 'function' ? now : Date.now;
    this.all = null;
  }

  read() {
    if (this.all) return this.all;
    let saved = null;
    try { saved = this.load(); } catch { saved = null; }
    const all = {};
    if (isPlain(saved)) {
      for (const [chat, row] of Object.entries(saved)) {
        if (!id(chat) || !isPlain(row) || !Array.isArray(row.turns)) continue;
        const turns = row.turns.filter((t) => Array.isArray(t) && id(t[0]) && id(t[1])).map((t) => [t[0], t[1]]).slice(-TURNS_PER_CHAT);
        if (turns.length) all[chat] = { at: typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0, turns };
      }
    }
    this.all = all;
    return all;
  }

  /** A live turn of this chat ended on this model. Anything that is not a chat, a turn and a model is ignored. */
  note(sessionId, turnId, model) {
    try {
      if (!id(sessionId) || !id(turnId) || !id(model)) return false;
      const all = this.read();
      const row = all[sessionId] ?? { at: 0, turns: [] };
      const at = row.turns.findIndex((t) => t[0] === turnId);
      if (at >= 0 && row.turns[at][1] === model) return false;
      if (at >= 0) row.turns.splice(at, 1);
      row.turns.push([turnId, model]);
      if (row.turns.length > TURNS_PER_CHAT) row.turns.splice(0, row.turns.length - TURNS_PER_CHAT);
      row.at = this.now();
      all[sessionId] = row;
      const chats = Object.keys(all);
      if (chats.length > CHATS_MAX) {
        chats.sort((a, b) => all[a].at - all[b].at);
        for (const old of chats.slice(0, chats.length - CHATS_MAX)) delete all[old];
      }
      try { this.save(all); } catch { /* kept in memory; the next note saves again */ }
      return true;
    } catch { return false; }
  }

  /** The model that ran a turn, or null. */
  modelOf(sessionId, turnId) {
    try { return this.read()[sessionId]?.turns.find((t) => t[0] === turnId)?.[1] ?? null; } catch { return null; }
  }

  /** A chat's history with each known turn's footer given its model. The list comes back as it was when none is known. */
  stamp(sessionId, events) {
    try {
      if (!Array.isArray(events)) return events;
      const turns = this.read()[sessionId]?.turns;
      if (!turns?.length) return events;
      const byTurn = new Map(turns);
      return events.map((ev) => {
        if (!isPlain(ev) || ev.kind !== 'turn-end' || ev.model || typeof ev.turnId !== 'string') return ev;
        const model = byTurn.get(ev.turnId);
        return model ? { ...ev, model } : ev;
      });
    } catch { return events; }
  }
}
