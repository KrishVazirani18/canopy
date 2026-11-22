// Usage stats, the parts that need no window: the names the window may count, which kind of widget a reply drew, how
// main's answers are read, and how the "What's sent" list words an event.
//
// The one list of what may leave the Mac is src/telemetry/schema.mjs, and main checks every event against it. The
// names below are the part of that list the window uses; a name that is not on main's list would be dropped without
// a word, so a unit test holds the two together (src/core/test/unit/telemetry-ui.test.mjs).
//
// Nothing here imports anything at run time, reads the window, or throws: bad input gives the empty answer. That is
// what lets a plain node test run this file as it is.
import type { TelemetryEvent, TelemetryStatus } from './api';

// ---------- what the window counts ----------

/** The events the window sends, and all main takes from it. Chats, messages, replies and errors are counted by main
 *  itself, from the engine's events and its own. */
export const UI_EVENTS = ['feature_used', 'setting_changed', 'widget', 'extension_added'] as const;
export type UiEvent = (typeof UI_EVENTS)[number];

/** Things people do in the window, each counted in the one place it happens. Never a name built from what someone wrote. */
export const UI_FEATURES = [
  // chats and the sidebar
  'chat_new', 'chat_resumed', 'chat_pinned', 'chat_unpinned', 'chat_archived', 'chat_unarchived', 'chat_renamed',
  'sidebar_search', 'project_added', 'project_removed', 'folder_picked', 'home_opened',
  // composing
  'attachment_added', 'image_pasted', 'file_mentioned', 'slash_command', 'message_queued', 'message_edited', 'stop_clicked',
  // the chat area
  'model_menu_opened', 'model_changed', 'effort_changed', 'mode_changed', 'speed_changed', 'engine_changed',
  'terminal_opened', 'multi_view_opened', 'pane_added', 'pane_closed', 'inspector_opened', 'agents_drawer_opened',
  'tool_details_opened', 'link_opened', 'file_opened', 'reveal_in_finder', 'message_copied', 'palette_opened',
  // app
  'settings_opened', 'settings_page', 'update_toast_clicked', 'restart_clicked', 'usage_opened', 'whats_sent_opened',
  'release_card_tried', 'release_card_dismissed',
] as const;
export type Feature = (typeof UI_FEATURES)[number];

/** The pages of Settings, as `settings_page` names them (the ids in settings-dialog.tsx). */
export const UI_SETTINGS_PAGES = ['you', 'memory', 'chats', 'tools', 'advanced', 'accounts', 'general', 'appearance', 'models', 'shortcuts', 'connectors', 'skills', 'plugins', 'claude', 'codex', 'about', 'privacy'] as const;
export type SettingsPage = (typeof UI_SETTINGS_PAGES)[number];

/** Settings whose change is counted. Their values are Canopy's own words (a theme, a mode, on or off), or left out. */
export const UI_SETTING_KEYS = ['theme', 'default_mode', 'default_engine', 'default_model', 'default_effort', 'sound', 'auto_update', 'code_mode', 'canopy_kit', 'usage_stats'] as const;
export type SettingKey = (typeof UI_SETTING_KEYS)[number];

// ---------- widgets ----------

export const UI_WIDGET_KINDS = ['table', 'chart', 'stat', 'choices', 'diff', 'tabs', 'diagram', 'interactive', 'html', 'other'] as const;
export type WidgetKind = (typeof UI_WIDGET_KINDS)[number];

// A widget built from Canopy's components is named by the one that leads it: tabs hold the others, choices ask for
// an answer, a chart or a table is what a row of stats sits above.
const COMPONENTS = ['tabs', 'choices', 'chart', 'table', 'diff', 'stat'] as const;
const hasTag = (html: string, tag: string) => new RegExp(`<${tag}[\\s>/]`, 'i').test(html);
/** A script that runs (not a block of data such as type="application/json"), or an inline handler like onclick. */
function runsCode(html: string): boolean {
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(m[1])?.[1]?.toLowerCase();
    if (!type || type === 'module' || type.endsWith('javascript')) return true;
  }
  return /<[a-z][^>]*\son[a-z]+\s*=/i.test(html);
}

/**
 * Which kind of widget this is, read off the HTML Claude wrote: the Canopy component it is built around, else
 * whether it runs code, draws, or is plain HTML. Only this one word is ever counted; the HTML stays where it is.
 */
export function widgetKind(code: unknown): WidgetKind {
  const html = typeof code === 'string' ? code : '';
  if (!html.trim()) return 'other';
  for (const kind of COMPONENTS) if (hasTag(html, `canopy-${kind}`)) return kind;
  if (runsCode(html)) return 'interactive';
  if (hasTag(html, 'svg')) return 'diagram';
  return 'html';
}

// ---------- reading main's answers ----------

/** A time from main, as ms: it may come as a number or as an ISO string. */
function timeOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === 'string' && v) { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}

/** Main's status, or null when it is not one (an older main, a failed call). */
export function readStatus(v: unknown): TelemetryStatus | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (typeof s.enabled !== 'boolean') return null;
  return {
    enabled: s.enabled,
    name: typeof s.name === 'string' ? s.name : '',
    installId: typeof s.installId === 'string' ? s.installId : '',
    endpoint: s.endpoint === true,
    queued: typeof s.queued === 'number' && s.queued > 0 ? Math.floor(s.queued) : 0,
    lastSentAt: timeOf(s.lastSentAt),
    // Anything but a clear yes means the notice is still owed: showing it once too often beats never showing it.
    noticeShown: s.noticeShown === true,
    // Any word here means nothing is sent from this copy. (A main from before this field says nothing: not blocked.)
    blocked: typeof s.blocked === 'string' && s.blocked ? s.blocked : null,
    sending: s.sending === true,
  };
}

/**
 * Whether the first-launch notice is owed now: stats are on, nothing outside Settings keeps them from being sent,
 * and it has never been seen.
 * Blocked (an automated run, CANOPY_TELEMETRY=0), the notice would say something untrue ("Canopy shares usage
 * stats"), and a test run would get a toast over what it is looking at. It stays owed: with the block gone, a later
 * launch shows it. With nowhere to send to yet it is shown all the same: it is how someone hears of the stats
 * before the first one is sent, never after.
 */
export const noticeDue = (s: TelemetryStatus | null | undefined): boolean => !!s && s.enabled && !s.blocked && !s.noticeShown;

const MAX_EVENTS = 200; // what main keeps
/** Main's recent events, newest first. Anything that is not an event is left out. */
export function readEvents(v: unknown): TelemetryEvent[] {
  if (!Array.isArray(v)) return [];
  const out: TelemetryEvent[] = [];
  for (const e of v) {
    if (out.length >= MAX_EVENTS) break;
    if (!e || typeof e !== 'object' || typeof (e as { event?: unknown }).event !== 'string' || !(e as { event: string }).event) continue;
    const { event, ts, props } = e as { event: string; ts?: unknown; props?: unknown };
    const kept: TelemetryEvent['props'] = {};
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [k, val] of Object.entries(props)) if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') kept[k] = val;
    }
    out.push({ event, ts: timeOf(ts), props: kept });
  }
  return out;
}

// ---------- "What's sent", in words ----------

/** Every event main can send, by its name in plain words (the unit test checks none is missing). */
export const EVENT_TITLES: Record<string, string> = {
  app_opened: 'Canopy opened',
  app_closed: 'Canopy closed',
  milestone: 'Getting started',
  chat_started: 'Chat started',
  message_sent: 'Message sent',
  reply_finished: 'Reply finished',
  permission_answered: 'Approval answered',
  widget: 'Widget',
  feature_used: 'Feature used',
  extension_added: 'Extension added',
  setting_changed: 'Setting changed',
  upkeep: 'Claude Code upkeep',
  error: 'Problem in Canopy',
  day_summary: 'Daily summary',
  live: 'Still open',
  telemetry_off: 'Usage stats turned off',
  telemetry_on: 'Usage stats turned on',
};
const EXTENSIONS: Record<string, string> = { connector: 'Connector added', skill: 'Skill added', plugin: 'Plugin added' };
const WIDGET_ACTIONS: Record<string, string> = { shown: 'Widget shown', used: 'Widget used' };
const UPKEEP_ACTIONS: Record<string, string> = { check: 'Claude Code update check', update: 'Claude Code update' };

/** An event's name in plain words. One this list doesn't know yet is shown by its own name, spaced out. */
export function eventTitle(e: Pick<TelemetryEvent, 'event' | 'props'>): string {
  const name = typeof e?.event === 'string' ? e.event : '';
  const p = e?.props ?? {};
  if (name === 'widget') return WIDGET_ACTIONS[String(p.action)] ?? EVENT_TITLES.widget;
  if (name === 'extension_added') return EXTENSIONS[String(p.type)] ?? EVENT_TITLES.extension_added;
  if (name === 'upkeep') return UPKEEP_ACTIONS[String(p.action)] ?? EVENT_TITLES.upkeep;
  if (Object.prototype.hasOwnProperty.call(EVENT_TITLES, name)) return EVENT_TITLES[name];
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Event';
}

/** What went with an event, exactly as it was sent: one "key: value" per prop. */
export function eventProps(e: Pick<TelemetryEvent, 'props'>): string[] {
  return Object.entries(e?.props ?? {}).map(([k, v]) => `${k}: ${String(v)}`);
}
