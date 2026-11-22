// Who this install is and what it has chosen, in identity.json: a random install id, the switch, the display name
// (once the person has set one), whether the first-launch notice was seen (and until it is, for how long it has been
// on screen), when Canopy first ran, which getting-started steps were already reported, and the days on which
// sharing was off (off-days.mjs: they are written in the same save as the switch, so the two can't disagree).
//
// The switch is the one thing here that must never be lost: a damaged file must not quietly turn sharing back on.
// So "off" is also kept as a small file of its own (`opted-out`), and either one saying off means off.
import { randomUUID } from 'node:crypto';
import { access, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { jsonFile } from './disk.mjs';
import { offFrom, offUntil, readOffDays } from './off-days.mjs';
import { MILESTONES } from './schema.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isIso = (v) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const exists = (file) => access(file).then(() => true, () => false);

/**
 * @param {{ dir: string, now?: () => number, uuid?: () => string, warn?: (kind: string, err?: unknown) => void }} opts
 */
export function createIdentity({ dir, now = Date.now, uuid = randomUUID, warn = () => {} }) {
  const file = jsonFile(path.join(dir, 'identity.json'), warn);
  const offMark = path.join(dir, 'opted-out');
  let me = null;          // null until loaded, and for a launch that has no identity it can keep
  let firstRun = false;
  let marking = Promise.resolve();

  const save = () => file.write(me);
  // The marker follows the switch, after the switch itself is saved. Going off, a crash in between leaves
  // identity.json saying off; going on, it leaves the marker saying off. Either way nothing is sent by accident.
  function syncMark() {
    marking = marking.then(async () => {
      await file.settled();
      if (me.enabled) await rm(offMark, { force: true });
      else await writeFile(offMark, `${new Date(now()).toISOString()}\n`);
    }).catch((err) => warn('could not update the opted-out marker', err));
  }

  return {
    /**
     * Read identity.json, or make a new identity on a first run. Returns false when this launch has none: the file
     * is there but the disk won't give it up (overwriting it could lose the switch), or a new one can't be saved
     * (an id that isn't kept would look like a new person at every launch). Telemetry then stays off until restart.
     */
    async load() {
      const optedOut = await exists(offMark);
      const { status, value } = await file.read();
      if (status === 'unreadable') { warn('identity.json can\'t be read: telemetry stays off for this launch'); return false; }
      if (status === 'ok' && value && typeof value === 'object' && UUID.test(value.install_id)) {
        const steps = value.milestones && typeof value.milestones === 'object' ? value.milestones : {};
        me = {
          install_id: value.install_id,
          enabled: value.enabled !== false && !optedOut,
          name: typeof value.name === 'string' ? value.name : null,
          notice_shown: value.notice_shown === true,
          notice_ms: Number.isFinite(value.notice_ms) && value.notice_ms > 0 ? value.notice_ms : 0,
          first_run_at: isIso(value.first_run_at) ? value.first_run_at : new Date(now()).toISOString(),
          milestones: Object.fromEntries(MILESTONES.filter((s) => isIso(steps[s])).map((s) => [s, steps[s]])),
          off_days: readOffDays(value.off_days),
        };
        if (optedOut && value.enabled !== false) save(); // the two disagreed: off wins, and the file now says so
        return true;
      }
      // A first run, or a file that is no longer JSON. Someone who had turned sharing off has seen the notice too.
      firstRun = status === 'missing';
      const fresh = { install_id: uuid(), enabled: !optedOut, name: null, notice_shown: optedOut, notice_ms: 0, first_run_at: new Date(now()).toISOString(), milestones: {}, off_days: [] };
      me = fresh;
      if (await save()) return true;
      if (me === fresh) me = null;
      warn('identity.json can\'t be saved: telemetry stays off for this launch');
      return false;
    },

    get installId() { return me?.install_id ?? null; },
    get enabled() { return me?.enabled === true; },
    /** The name the person set ('' when they cleared it), or null when they never set one. */
    get name() { return me?.name ?? null; },
    get noticeShown() { return me ? me.notice_shown : true; },
    /** How long the notice has been on screen without an answer, over every launch so far (ms). */
    get noticeMs() { return me?.notice_ms ?? 0; },
    /** This launch created the identity: the first time Canopy ran with telemetry on this Mac. */
    get firstRun() { return firstRun && !!me; },
    get firstRunAt() { return me?.first_run_at ?? null; },

    setEnabled(on) {
      if (!me || me.enabled === on) return;
      me.enabled = on === true;
      save();
      syncMark();
    },
    setName(name) {
      if (!me || me.name === name) return;
      me.name = name;
      save();
    },
    markNoticeShown() {
      if (!me || me.notice_shown) return;
      me.notice_shown = true;
      save();
    },
    /** The notice was on screen for this much longer (ms). Kept, so the time adds up across launches. */
    addNoticeTime(ms) {
      if (!me || me.notice_shown || !(ms > 0) || !Number.isFinite(ms)) return;
      me.notice_ms += ms;
      save();
    },

    /** The stretches of local dates on which sharing was off: [[from, to]], `to` null while it still is. A copy. */
    get offDays() { return readOffDays(me?.off_days); },
    /**
     * Keeps that list in step: sharing is off (`off`: by the switch, or by a no said from outside the app) or on,
     * as of the local date `date`. Off opens a stretch that day; on ends the open one with that day.
     */
    noteSharing(off, date) {
      if (!me) return;
      const next = off ? offFrom(me.off_days, date) : offUntil(me.off_days, date);
      if (JSON.stringify(next) === JSON.stringify(me.off_days)) return;
      me.off_days = next;
      save();
    },

    reached: (step) => !!me?.milestones[step],
    reach(step, at) {
      if (!me || me.milestones[step]) return;
      me.milestones[step] = at;
      save();
    },

    settled: () => marking.then(() => file.settled()),
  };
}
