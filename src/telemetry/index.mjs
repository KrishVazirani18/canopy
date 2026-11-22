// Canopy Telemetry: the one object the rest of Canopy talks to.
//
// What may be sent is decided in schema.mjs. This file decides whether, and ties the parts together: who this
// install is (identity.mjs), the queue on disk (queue.mjs), sending (flush.mjs, send.mjs), the local "what's sent"
// list (recent.mjs), errors (errors.mjs), active minutes (activity.mjs) and a few remembered things (state.mjs).
//
// Four rules shape everything here:
//   - It can't break Canopy. Every method `createTelemetry` hands out is wrapped: it never throws, never rejects,
//     and returns at once (disk and network happen behind it). Calls made before `init()` has finished wait in
//     memory and are handled in order once it has; calls after `shutdown()` do nothing.
//   - Off means off: nothing is queued, listed, counted or remembered. (One thing is written down: on which days it
//     was off, so that nothing about those days is sent later either. off-days.mjs.)
//   - On, but with nowhere to send (no PostHog key, an automated run, CANOPY_TELEMETRY=0): events still show in
//     "what's sent", so people and harnesses can see what would go, and nothing is queued or sent.
//   - Nothing is sent before the person could say no. Until the first-launch notice has been answered, or has been
//     on screen for ten minutes of Canopy being open, events wait in the queue (see NOTICE_READ_MS below).
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createActivity, localDate } from './activity.mjs';
import { resolveConfig } from './config.mjs';
import { once } from './disk.mjs';
import { createErrorLog } from './errors.mjs';
import { createFlusher } from './flush.mjs';
import { createIdentity } from './identity.mjs';
import { toPostHogBatch } from './posthog.mjs';
import { createQueue } from './queue.mjs';
import { createRecent } from './recent.mjs';
import { LIMITS, MILESTONES, SCHEMA_VERSION, clean, cleanBatch, scrubText } from './schema.mjs';
import { platformNet, postBatch } from './send.mjs';
import { createSessionLog, createState } from './state.mjs';

const MINUTE = 60_000;
// Status changes that come in a burst (a queue filling up) reach listeners as one.
const STATUS_DELAY_MS = 300;
// Sending waits for the Mac to say whose it is, but not for long.
const NAME_WAIT_MS = 3000;
// The first-launch notice comes before anything is sent. A new install's events wait in the queue until the notice
// has been answered (OK, Settings, swiped away: `noticeShown`), or has been on screen this long while Canopy was
// open. The window says when it is up (noticeOnScreen()), the time is counted a minute at a time and kept in
// identity.json, so it adds up over launches. Switching sharing off in the meantime empties the queue as it always
// does, and then nothing was ever sent. An install whose notice was answered long ago never waits.
const NOTICE_READ_MS = 10 * MINUTE;
// Answering is not the end of the wait: "Settings" is an answer, and whoever clicks it to switch sharing off needs
// the time to get there. So the first batch goes this long after the answer, not with it.
const ANSWERED_WAIT_MS = 2 * MINUTE;
// Calls held while init is still reading files. Far more than a launch makes; past it, new ones are dropped.
const EARLY_MAX = 2000;
const LAST_SENT = 'core.lastSentAt';
const DROPPED = 'core.dropped'; // what PostHog refused for good in the last hour: [[when, how many]] (flush.mjs)
const IDS_SINCE = 'core.idsSince';
// What an event's id has to look like (the schema's own check).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Only the switch says these: anyone else tracking them would make "exactly one telemetry_off" untrue.
const SWITCH_EVENTS = new Set(['telemetry_off', 'telemetry_on']);
/**
 * The events the window may send (the `telemetry:track` IPC; renderer/src/lib/telemetry-rules.ts lists the same
 * four). Everything else is main's own to say: a page that went wrong must not be able to report an error's text,
 * a day's counts, a milestone or a chat that never happened.
 */
export const WINDOW_EVENTS = Object.freeze(['feature_used', 'setting_changed', 'widget', 'extension_added']);

const iso = (ms) => new Date(ms).toISOString();
const displayName = (v) => scrubText(String(v ?? ''), LIMITS.nameChars, { name: true });

class Telemetry {
  #dir; #env; #appVersion; #osVersion; #defaultNameOpt;
  #now; #timers; #log; #warn; #config;
  #identity; #queue; #recent; #state; #sessions; #activity; #errors; #flusher;
  #launchId = randomUUID();
  #net;                         // { fetch, isOnline }, or a promise of it while Electron is being asked
  #online = () => true;
  #defaultName = '';
  #nameFound = Promise.resolve();
  #loading = null;              // init(), shared by everyone who calls it
  #ready = false;
  #stopped = false;
  #early = [];                  // calls made before init finished
  #said = new Set();            // milestones recorded this launch
  #unknown = new Set();         // event names already reported as unknown
  #listeners = new Set();
  #lastStatus = '';
  #statusTimer = null;
  #minuteTimer = null;
  #noticeUpAt = null;           // since when the notice has been on screen and not yet counted (null: it is not up)
  #holdUntil = 0;               // the notice was answered: nothing leaves before this
  #answeredWaitMs = ANSWERED_WAIT_MS;

  constructor(o = {}) {
    this.#dir = typeof o.dir === 'string' && path.isAbsolute(o.dir) ? o.dir : null;
    this.#env = o.env === 'dev' ? 'dev' : 'prod';
    this.#appVersion = String(o.appVersion ?? 'unknown');
    this.#osVersion = String(o.osVersion ?? 'unknown');
    this.#defaultNameOpt = o.defaultName;
    this.#now = typeof o.now === 'function' ? o.now : Date.now;
    this.#timers = o.timers ?? globalThis;
    // Wrapped once, here: the log is called from timers nobody awaits, where a throw would be an unhandled rejection.
    const log = typeof o.log === 'function' ? o.log : () => {};
    this.#log = (msg) => { try { log(msg); } catch { /* a log that fails says nothing */ } };
    this.#warn = once(this.#log);
    this.#config = resolveConfig(o.environ ?? process.env);
    if (Number.isFinite(o.answeredWaitMs) && o.answeredWaitMs >= 0) this.#answeredWaitMs = o.answeredWaitMs;
    if (typeof o.fetch === 'function') {
      this.#net = { fetch: o.fetch, isOnline: typeof o.isOnline === 'function' ? o.isOnline : () => true };
      this.#online = this.#net.isOnline;
    }

    const now = this.#now;
    const warn = this.#warn;
    const at = (name) => path.join(this.#dir ?? '', name);
    this.#identity = createIdentity({ dir: this.#dir ?? '', now, warn });
    this.#queue = createQueue({ file: at('queue.jsonl'), warn });
    this.#recent = createRecent({ file: at('recent.jsonl'), warn });
    this.#state = createState({ file: at('state.json'), warn });
    this.#sessions = createSessionLog({ file: at('sessions.jsonl'), warn });
    this.#activity = createActivity({ file: at('activity.json'), isFocused: o.isFocused, idleSeconds: o.idleSeconds, now, warn });
    this.#errors = createErrorLog({ emit: (props) => this.#record('error', props), hide: typeof o.localPaths === 'function' ? o.localPaths : () => [], now });
    this.#flusher = createFlusher({
      queue: this.#queue,
      post: (events, signal) => this.#post(events, signal),
      canSend: () => this.#sending && this.#cleared,
      isOnline: () => this.#online(),
      onSent: () => { this.#state.set(LAST_SENT, iso(now())); this.#statusSoon(); },
      dropLog: { read: () => this.#state.get(DROPPED), write: (drops) => this.#state.set(DROPPED, drops) },
      note: this.#log,
      now,
      ...(typeof o.random === 'function' && { random: o.random }),
    });
  }

  /** The switch is on (and the identity is loaded): events are recorded. */
  get #on() { return this.#ready && this.#identity.enabled; }
  /** Events really leave this Mac: on, with a key and a host to send to, and no outside switch in the way. */
  get #sending() { return this.#on && !!this.#config.endpoint && !this.#config.blocked; }
  /**
   * The person has had their chance to say no, so what is queued may go: the notice was on screen for long enough,
   * or it was answered and the wait after an answer is over. Until then the queue only grows.
   */
  get #cleared() {
    const id = this.#identity;
    return id.noticeMs >= NOTICE_READ_MS || (id.noticeShown && this.#now() >= this.#holdUntil);
  }

  // ---- start and stop ----

  init() { return (this.#loading ??= this.#load()); }

  async #load() {
    const safely = (what, p) => p.catch((err) => this.#warn(`could not load ${what}`, err));
    if (this.#dir) {
      await mkdir(this.#dir, { recursive: true }).catch((err) => this.#warn('could not create the telemetry folder', err));
      this.#findName();
      this.#findNet();
      await safely('the identity', this.#identity.load());
      await Promise.all([
        safely('the queue', this.#queue.load()), safely('what was sent', this.#recent.load()), safely('the saved state', this.#state.load()),
        safely('the chat ids', this.#sessions.load()), safely('the active minutes', this.#activity.load()),
      ]);
    } else this.#warn('telemetry was given no folder for its files: it stays off');
    if (this.#stopped) return; // Canopy quit while this was reading
    // Off means nothing waits to be sent, even if Canopy died between saving the switch and emptying the queue.
    if (!this.#identity.enabled && this.#queue.size) this.#queue.clear();
    this.#noteSwitch();
    this.#ready = true;
    for (const call of this.#early.splice(0)) {
      try { call(); } catch (err) { this.#warn('a call made before telemetry was ready failed', err); }
    }
    this.#secondDay(localDate(this.#now()));
    if (this.#on) { this.#arm(); this.#listStarts(); }
    this.#tellStatus();
  }

  async flush() {
    if (!this.#ready) await this.#loading;
    if (!this.#ready || this.#stopped) return;
    this.#errors.sweep();
    await this.#flusher.flush();
  }

  /** The last flush, at quit. Returns within `timeoutMs` whatever the disk and the network are doing. */
  async shutdown({ timeoutMs = 2000 } = {}) {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#disarm();
    if (this.#ready) this.#countNotice(); // the part of a minute the notice was up since the last count
    if (this.#statusTimer) this.#timers.clearTimeout(this.#statusTimer);
    this.#statusTimer = null;
    let timer = null;
    const limit = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 2000;
    const tooLate = new Promise((resolve) => { timer = this.#timers.setTimeout(resolve, limit); });
    const lastWords = this.#ready ? this.#lastWords().catch((err) => this.#warn('the last flush failed', err)) : Promise.resolve();
    await Promise.race([lastWords, tooLate]);
    this.#timers.clearTimeout(timer);
    this.#flusher.stop(); // a request still out is cut: what it carried stays queued for the next launch
  }

  async #lastWords() {
    if (this.#on) this.#errors.flush(); // counts held back for the hour go out with the rest
    await this.#files();                // what was tracked is on disk before the network gets its turn
    await this.#flusher.flush();
    await this.#files();
  }

  #files() {
    return Promise.all([this.#queue, this.#recent, this.#identity, this.#state, this.#sessions, this.#activity].map((f) => f.settled()));
  }

  // ---- recording ----

  /**
   * `opts.id`: the id this event goes out under, for the one kind of event that may be sent twice and must be
   * stored once (a day's summary, after a quit in the wrong instant: PostHog merges two events with one id, see
   * posthog.mjs). It must be a uuid; anything else is not used, and the event gets an id of its own like every other.
   */
  track(event, props, opts) {
    if (this.#stopped || SWITCH_EVENTS.has(event)) return;
    // The launch is ending: error counts held back for the hour go out first, so app_closed is its last event.
    if (event === 'app_closed' && this.#on) this.#errors.flush();
    const id = opts && typeof opts === 'object' ? opts.id : undefined;
    if (id !== undefined && !(typeof id === 'string' && UUID.test(id))) this.#warn('an event was given an id that is not a uuid: it got one of its own');
    this.#record(event, props, id);
  }

  /**
   * An event the window asked for. Only the kinds it has reason to send (WINDOW_EVENTS) are taken, with their props
   * and nothing else: the window can't give an event an id.
   */
  trackFromWindow(event, props) {
    if (this.#stopped) return;
    if (!WINDOW_EVENTS.includes(event)) { this.#dropped('the window may not send', event); return; }
    this.track(event, props);
  }

  /** An event that was not taken: said once per name, and only when running from source. */
  #dropped(why, event) {
    const name = String(event).slice(0, 60);
    if (this.#env !== 'dev' || this.#unknown.has(name) || this.#unknown.size >= 50) return;
    this.#unknown.add(name);
    this.#log(`dropped an event ${why}: ${name}`);
  }

  /** Clean an event now (so it carries the time it happened), admit it once the switch is known. */
  #record(event, props, id) {
    const cleaned = typeof event === 'string' ? clean(event, props) : null;
    if (!cleaned) { this.#dropped('that is not in the schema', event); return; }
    const e = this.#envelope(event, cleaned, id);
    this.#whenReady(() => this.#admit(e));
  }

  #envelope(event, props, id) {
    return { id: typeof id === 'string' && UUID.test(id) ? id : randomUUID(), event, ts: iso(this.#now()), launch_id: this.#launchId, props };
  }

  #admit(e) {
    if (!this.#identity.enabled) return;
    this.#recent.add(e);
    if (this.#sending) { this.#queue.add(e); this.#flusher.poke(); }
    this.#statusSoon();
  }

  milestone(step) {
    if (this.#stopped || !MILESTONES.includes(step) || this.#said.has(step) || this.#identity.reached(step)) return;
    const e = this.#envelope('milestone', { step });
    this.#whenReady(() => {
      if (!this.#identity.enabled || this.#identity.reached(step) || this.#said.has(step)) return;
      this.#said.add(step);
      // Remembered for good only when it is really on its way: a step reached while there was nowhere to send it
      // is reported again by a later launch that has somewhere.
      if (this.#sending) this.#identity.reach(step, e.ts);
      this.#admit(e);
    });
  }

  error(where, err) {
    if (this.#stopped || (this.#ready && !this.#identity.enabled)) return;
    this.#errors.report(where, err);
  }

  /** "Came back on a later day": the app is open, or in use, on a local date after the one it first ran on. */
  #secondDay(today) {
    const first = this.#identity.firstRunAt;
    if (first && today > localDate(Date.parse(first))) this.milestone('second_day');
  }

  // The conversations that are Canopy's, for the daily summary to tell from the terminal's in the history on disk.
  // Which ones those are is decided in one place, the engine tracker (engine.mjs, "conversations Canopy ran": one
  // Canopy has sent a message in, and for Codex only one that began here). This only keeps the list it is told.
  noteCanopySession(engine, sessionId) {
    if (this.#stopped) return;
    this.#whenReady(() => { if (this.#identity.enabled) this.#sessions.note(engine, sessionId); });
  }

  canopySessions() { return this.#sessions.sets(); }
  canopySessionsSince() { const at = this.#state.get(IDS_SINCE); return typeof at === 'string' ? at : null; }
  /** The list is only kept while the switch is on. The first moment it is, is written down once, for good. */
  #listStarts() { if (this.canopySessionsSince() === null) this.#state.set(IDS_SINCE, iso(this.#now())); }
  firstRunAt() { return this.#ready ? this.#identity.firstRunAt : null; }

  /**
   * The days sharing was off, kept in step with the switch: looked at once the files are read, and each time the
   * switch moves. Off is the person's own no, said with the switch or with CANOPY_TELEMETRY=0. (A Canopy with
   * nowhere to send to is not one where sharing is off, and an automated run keeps its files in a folder of its own.)
   */
  #noteSwitch() {
    // Kept in identity.json, in the same save as the switch. (No identity this launch: nothing is known or written.)
    this.#identity.noteSharing(!this.#identity.enabled || this.#config.blocked === 'env', localDate(this.#now()));
  }

  /** The stretches of local dates on which sharing was off: [[from, to]], `to` null while it still is. */
  offDays() { return this.#identity.offDays; }
  activeMinutes(date) { return this.#activity.minutes(date); }
  sessionMinutes() { return this.#activity.session(); }
  stateGet(key) { return this.#state.get(key); }
  stateSet(key, value) { if (!this.#stopped) this.#state.set(key, value); }

  // ---- the switch, the name, the notice ----

  setEnabled(on) {
    if (this.#stopped || typeof on !== 'boolean') return;
    this.#whenReady(() => (on ? this.#turnOn() : this.#turnOff()));
  }

  #turnOff() {
    if (!this.#identity.enabled) return;
    // The goodbye goes only if events were leaving. Said before anything was allowed to (the notice not answered,
    // or only just), no means nothing was ever sent, the goodbye included.
    const wasSending = this.#sending && this.#cleared;
    const bye = this.#envelope('telemetry_off', {});
    this.#recent.add(bye);            // the list shows the goodbye too: it is the last thing sent
    this.#identity.setEnabled(false); // saved first: from here on a crash still comes back off
    this.#noteSwitch();               // today is a day it was off, whatever happens next
    this.#flusher.stop();             // a request in flight is cut
    this.#queue.clear();
    this.#errors.clear();
    this.#disarm();
    this.#noticeUpAt = null;
    // One try, never queued and never retried: off means nothing waits to be sent.
    if (wasSending) this.#post([bye]).catch(() => {});
    this.#tellStatus();
  }

  #turnOn() {
    if (this.#identity.enabled || !this.#identity.installId) return; // already on, or no identity to turn on
    this.#identity.setEnabled(true);
    this.#noteSwitch(); // the stretch it was off ends today, and today stays in it
    this.#flusher.resume();
    this.#arm();
    this.#listStarts();
    this.#admit(this.#envelope('telemetry_on', {}));
    this.#tellStatus();
  }

  setName(name) {
    if (this.#stopped || typeof name !== 'string') return;
    this.#whenReady(() => { this.#identity.setName(displayName(name)); this.#tellStatus(); });
  }

  markNoticeShown() {
    if (this.#stopped) return;
    this.#whenReady(() => {
      // Answered while events were still waiting for it: they wait a little longer (ANSWERED_WAIT_MS).
      if (this.#identity.installId && !this.#identity.noticeShown && !this.#cleared) this.#holdUntil = this.#now() + this.#answeredWaitMs;
      this.#identity.markNoticeShown();
      this.#noticeUpAt = null;
      this.#tellStatus();
    });
  }

  /** The window has put the first-launch notice up. Its time on screen is counted from here (see NOTICE_READ_MS). */
  noticeOnScreen() {
    if (this.#stopped) return;
    this.#whenReady(() => {
      // Only where the notice is owed: sharing on, nothing outside keeping it from being sent, not yet answered.
      if (!this.#identity.enabled || this.#config.blocked || this.#identity.noticeShown) return;
      this.#noticeUpAt ??= this.#now();
    });
  }

  /**
   * Adds the time the notice has been up since it was last counted. A minute at most each time: this is asked every
   * minute Canopy is open, and a Mac that slept in between was not showing the notice to anyone.
   */
  #countNotice() {
    if (this.#noticeUpAt === null) return;
    const id = this.#identity;
    if (id.noticeShown || !id.enabled) { this.#noticeUpAt = null; return; }
    const t = this.#now();
    id.addNoticeTime(Math.min(Math.max(t - this.#noticeUpAt, 0), MINUTE));
    this.#noticeUpAt = t;
  }

  // ---- what the Settings page reads ----

  status() {
    const id = this.#identity;
    const lastSentAt = this.#state.get(LAST_SENT);
    return {
      enabled: this.#on,
      name: id.name ?? this.#defaultName,
      installId: this.#ready ? id.installId : null,
      endpoint: !!this.#config.endpoint,
      queued: this.#queue.size,
      lastSentAt: typeof lastSentAt === 'string' ? lastSentAt : null,
      noticeShown: this.#ready ? id.noticeShown : true, // until the file is read, nothing says the notice is due
      // Beyond the contract, for main.mjs and the Settings page:
      firstRun: this.#ready && id.firstRun,   // this launch is the install's first
      blocked: this.#config.blocked,          // 'automated' | 'env' | null: an outside switch keeps events from leaving
      sending: this.#sending,                 // events really leave this Mac right now
    };
  }

  recent() { return this.#recent.list(); }

  onStatus(cb) {
    if (typeof cb !== 'function') return () => {};
    this.#listeners.add(cb);
    return () => { this.#listeners.delete(cb); };
  }

  #tellStatus() {
    const status = this.status();
    const json = JSON.stringify(status);
    if (json === this.#lastStatus) return;
    this.#lastStatus = json;
    for (const cb of this.#listeners) {
      try { cb(status); } catch (err) { this.#warn('a telemetry status listener failed', err); }
    }
  }

  #statusSoon() {
    if (this.#statusTimer || this.#stopped || !this.#listeners.size) return;
    this.#statusTimer = this.#timers.setTimeout(() => { this.#statusTimer = null; this.#tellStatus(); }, STATUS_DELAY_MS);
    this.#statusTimer?.unref?.();
  }

  // ---- internals ----

  #whenReady(call) {
    if (this.#ready) call();
    else if (this.#early.length < EARLY_MAX) this.#early.push(call);
  }

  /** One timer wakes telemetry once a minute: count the minute, close out error hours, send what is queued. */
  #arm() {
    if (this.#minuteTimer || this.#stopped) return;
    this.#minuteTimer = this.#timers.setTimeout(() => { this.#minuteTimer = null; this.#minute(); }, MINUTE);
    this.#minuteTimer?.unref?.(); // never the reason Canopy stays open
  }

  #disarm() {
    if (this.#minuteTimer) this.#timers.clearTimeout(this.#minuteTimer);
    this.#minuteTimer = null;
  }

  #minute() {
    if (this.#stopped || !this.#on) return;
    try {
      const day = this.#activity.sample();
      if (day) this.#secondDay(day);
      this.#errors.sweep();
      this.#countNotice();
      this.#flusher.tick();
    } catch (err) { this.#warn('the minute check failed', err); }
    this.#arm();
  }

  /** The name to send until the person sets one, when the host hands one in (Canopy does not), asked in the background. Only sending waits for it, and only briefly. */
  #findName() {
    const d = this.#defaultNameOpt;
    const asked = Promise.resolve()
      .then(() => (typeof d === 'function' ? d() : d))
      .then((name) => { this.#defaultName = displayName(name); if (this.#ready) this.#tellStatus(); })
      .catch(() => {});
    let timer = null;
    const waited = new Promise((resolve) => { timer = this.#timers.setTimeout(resolve, NAME_WAIT_MS); timer?.unref?.(); });
    this.#nameFound = Promise.race([asked, waited]).then(() => this.#timers.clearTimeout(timer));
  }

  #findNet() {
    if (this.#net) return;
    this.#net = platformNet().then((net) => { this.#net = net; this.#online = net.isOnline; return net; });
  }

  /**
   * One batch to PostHog. Before anything leaves, the whole batch goes through the catalog once more
   * (schema.cleanBatch: the check a server of Canopy's own would have made on arrival): an event the queue held
   * that this Canopy may not send is left out, and a batch with nothing left in it is not sent at all.
   */
  async #post(events, signal) {
    await this.#nameFound;
    const net = await this.#net;
    const id = this.#identity;
    const batch = cleanBatch({
      install_id: id.installId, name: id.name ?? this.#defaultName, env: this.#env,
      app_version: this.#appVersion, os_version: this.#osVersion,
      schema: SCHEMA_VERSION, sent_at: iso(this.#now()), events,
    });
    // Nothing in it may be sent, now or later: an answer of "drop" lets the queue forget it (flush.mjs).
    if (!batch.header || !batch.events.length) return { result: 'drop', status: 0, reason: 'nothing in it may be sent' };
    if (batch.dropped) this.#warn('an event waiting to be sent is not one this Canopy may send: left out');
    const body = JSON.stringify(toPostHogBatch(this.#config.key, batch.header, batch.events, id.firstRunAt));
    return postBatch({ endpoint: this.#config.endpoint, body, fetch: net.fetch, signal, now: this.#now, timers: this.#timers });
  }
}

const BLANK_STATUS = { enabled: false, name: '', installId: null, endpoint: false, queued: 0, lastSentAt: null, noticeShown: true, firstRun: false, blocked: null, sending: false };

/**
 * The Telemetry object. Every method is safe to call at any time (before `init()` has finished, when sharing is
 * off, after `shutdown()`): none throws, none rejects, all return at once.
 *
 * @param {{
 *   dir: string,                          // folder for telemetry's files: path.join(app.getPath('userData'), 'telemetry')
 *   appVersion: string, osVersion: string,
 *   env: 'dev' | 'prod',                  // dev: running from source, kept apart in the charts
 *   defaultName?: string | Promise<string> | (() => string | Promise<string>),   // a name to send until the person sets one; Canopy hands in none
 *   log?: (msg: string) => void,
 *   isFocused?: () => boolean,            // Canopy's window is in front (for active minutes)
 *   idleSeconds?: () => number,           // powerMonitor.getSystemIdleTime()
 *   localPaths?: () => string[],          // folders this Mac knows are personal: removed from error text by name
 *   fetch?: typeof globalThis.fetch,      // tests; otherwise Electron's net.fetch, and outside Electron nothing is sent
 *   isOnline?: () => boolean,             // tests; otherwise Electron's net.isOnline
 *   now?: () => number, random?: () => number,
 *   timers?: { setTimeout: Function, clearTimeout: Function },
 *   environ?: Record<string, string | undefined>,                               // tests; otherwise process.env
 *   answeredWaitMs?: number,              // tests: how long the first batch waits once the notice is answered
 * }} opts
 */
export function createTelemetry(opts) {
  const log = typeof opts?.log === 'function' ? opts.log : () => {};
  const warn = once(log);
  let t = null;
  try { t = new Telemetry(opts ?? {}); } catch (err) { warn('telemetry could not start', err); }

  // A method that answers at once: on any failure, its harmless answer instead.
  const direct = (name, fallback) => (...args) => {
    try { return t ? t[name](...args) : fallback(); }
    catch (err) { warn(`telemetry.${name} failed`, err); return fallback(); }
  };
  // A method that is awaited: it always resolves.
  const awaited = (name) => async (...args) => {
    try { if (t) await t[name](...args); }
    catch (err) { warn(`telemetry.${name} failed`, err); }
  };
  const nothing = () => undefined;

  return {
    /** Load the identity and the queue, start the minute timer. Call once, in the background; calling again waits for the same load. */
    init: awaited('init'),
    /**
     * Record an event: track(event, props). Cleaned by schema.clean(); an event that isn't in the schema is dropped
     * (and logged in dev). A third argument `{ id }` (a uuid) sends it under that id instead of a new one, for an
     * event that may be sent twice and must be stored once (a day's summary).
     */
    track: direct('track', nothing),
    /**
     * Record an event the window asked for (the `telemetry:track` IPC): trackFromWindow(event, props). Only the
     * events in WINDOW_EVENTS are taken; any other is dropped (and logged in dev).
     */
    trackFromWindow: direct('trackFromWindow', nothing),
    /** Record a getting-started step, once per install. */
    milestone: direct('milestone', nothing),
    /** Record a problem: where ('main' | 'ui' | 'engine') and the error. Grouped by fingerprint, at most one event an hour each. */
    error: direct('error', nothing),
    /** { enabled, name, installId, endpoint, queued, lastSentAt (ISO or null), noticeShown } plus { firstRun, blocked, sending }. */
    status: direct('status', () => ({ ...BLANK_STATUS })),
    /**
     * The switch. Off: the queue is deleted, everything stops, and one `telemetry_off` is sent (one try), unless
     * nothing was allowed to leave yet (the notice still unanswered): then nothing is sent at all. On: `telemetry_on`.
     */
    setEnabled: direct('setEnabled', nothing),
    /** The display name sent with events (letters, spaces and . ' - only; '' sends none). */
    setName: direct('setName', nothing),
    /** The first-launch notice was answered (OK, Settings, swiped away). What was waiting for that goes two minutes later. */
    markNoticeShown: direct('markNoticeShown', nothing),
    /**
     * The first-launch notice is on screen now (the window says so when it puts it up). Until it is answered,
     * nothing is sent before it has been up for ten minutes of Canopy being open, added up over launches.
     */
    noticeOnScreen: direct('noticeOnScreen', nothing),
    /** The last 200 events recorded, newest first: [{ event, ts, props }]. */
    recent: direct('recent', () => []),
    /** Hear every status change. Returns the function that stops it. */
    onStatus: direct('onStatus', () => () => {}),
    /** Send what is queued now. */
    flush: awaited('flush'),
    /** The final flush at quit: resolves within `timeoutMs` (2000 by default), then nothing more happens. */
    shutdown: awaited('shutdown'),

    /** Remember that this conversation is Canopy's ('claude' | 'codex', its session id), for the daily summary. The engine tracker decides which are. */
    noteCanopySession: direct('noteCanopySession', nothing),
    /** The conversations that are Canopy's: { claude: Set<id>, codex: Set<id> }. */
    canopySessions: direct('canopySessions', () => ({ claude: new Set(), codex: new Set() })),
    /** Since when that list has been kept (an ISO time), or null when it never was. A Canopy chat from before it is on no list. */
    canopySessionsSince: direct('canopySessionsSince', () => null),
    /** When this install first ran with telemetry (an ISO time). Null until `init()` has resolved. */
    firstRunAt: direct('firstRunAt', () => null),
    /**
     * The local dates on which sharing was off, as stretches: [[from, to]], both 'YYYY-MM-DD' and included, `to` null
     * while it is still off. The daily summary never sends a day that falls in one. Read it after `init()` has resolved.
     */
    offDays: direct('offDays', () => []),
    /** Minutes Canopy was in front and in use on a local day ('YYYY-MM-DD'). */
    activeMinutes: direct('activeMinutes', () => 0),
    /** This launch so far, shaped as `app_closed` props: { open_min, active_min }. */
    sessionMinutes: direct('sessionMinutes', () => ({ open_min: 0, active_min: 0 })),
    /** A small persisted key/value store (JSON values), for the summary scheduler. Read it after `init()` has resolved. */
    state: { get: direct('stateGet', nothing), set: direct('stateSet', nothing) },
  };
}
