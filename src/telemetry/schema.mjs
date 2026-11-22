// Canopy Telemetry: what may leave the Mac, and nothing else.
//
// Every event Canopy sends is listed here with the exact props it may carry and what each prop may hold. `clean()`
// drops unknown events, unknown props and values that don't fit, so content can't leak even by mistake (a path passed
// where a count belongs is dropped, not sent). Every batch goes through this file once more as a whole before it
// leaves (cleanBatch), and a server put in front of the events can run it again on whatever reaches it.
//
// Rules for anyone adding to this file:
//   - Never a prop that can hold what someone typed, what Claude or Codex wrote, a file or folder name, a project or
//     repo name, a chat title, a command, a URL, a credential, a token count or a cost.
//   - Free text is allowed in exactly two places (an error's first line, and the person's display name in the batch
//     header), and both go through scrubText().
//   - A word is only ever one from a list here (a mode, an effort level, a setting's value: each has its own). There
//     is no type for "a short identifier": anything that would fit one could be a word of the person's.
//   - Changing what an event means needs SCHEMA_VERSION + 1.
//
// Dependency-free on purpose: a server that checks batches again does it with a copy of this exact file, in whatever
// runtime it has, so the two sides can never disagree about what is allowed.

export const SCHEMA_VERSION = 1;
/**
 * The versions the server takes: its own, and the older ones listed here. Canopy builds stay in use long after a
 * newer one ships, so a server that has moved on to version 2 keeps taking batches that say 1 for as long as 1 is
 * on this list (their events are checked against the catalog as it is now, and what it no longer lists is dropped).
 */
export const SUPPORTED_SCHEMAS = [1];

// ---------- Vocabularies ----------

export const ENGINES = ['claude', 'codex'];

/** The permission modes a chat can be in: Claude Code's six. A Codex chat is in one of the same, never dontAsk. */
export const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];

/** Effort levels: the five Claude Code has (low to max), and the three only Codex has (none, minimal, ultra). */
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Where a message was sent from, for the "Canopy vs the tools people already use" numbers (day_summary). */
export const SOURCES = [
  'claude_canopy', 'claude_terminal', 'claude_desktop', 'claude_ide', 'claude_other',
  'codex_canopy', 'codex_app', 'codex_terminal', 'codex_ide', 'codex_other',
];

/** Kinds of tool a reply ran. Built-in tool names map onto these; MCP tools are all 'mcp'. */
export const TOOL_KINDS = ['bash', 'edit', 'read', 'web', 'agent', 'mcp', 'question', 'plan', 'other'];

export const MILESTONES = ['claude_found', 'claude_signed_in', 'codex_found', 'codex_signed_in', 'first_chat', 'first_message', 'first_reply', 'second_day'];

export const WIDGET_KINDS = ['table', 'chart', 'stat', 'choices', 'diff', 'tabs', 'mockup', 'diagram', 'interactive', 'html', 'other'];

/** Things people do in the window. Add names here as features are instrumented; never a name built from user data. */
export const FEATURES = [
  // chats and the sidebar
  'chat_new', 'chat_resumed', 'chat_pinned', 'chat_unpinned', 'chat_archived', 'chat_unarchived', 'chat_renamed', 'chat_deleted',
  'chat_forked', 'sidebar_search', 'project_added', 'project_removed', 'folder_picked', 'home_opened',
  // composing
  'attachment_added', 'image_pasted', 'file_mentioned', 'slash_command', 'message_queued', 'message_edited', 'stop_clicked',
  // the chat area
  'model_menu_opened', 'model_changed', 'effort_changed', 'mode_changed', 'speed_changed', 'engine_changed',
  'terminal_opened', 'multi_view_opened', 'pane_added', 'pane_closed', 'inspector_opened', 'agents_drawer_opened',
  'tool_details_opened', 'link_opened', 'file_opened', 'reveal_in_finder', 'message_copied', 'palette_opened', 'search_opened',
  // app
  'settings_opened', 'settings_page', 'notification_clicked', 'update_toast_clicked', 'restart_clicked', 'menu_bar_used',
  'usage_opened', 'whats_sent_opened', 'release_card_tried', 'release_card_dismissed',
];

/** Settings pages, for feature_used { name: 'settings_page', page }. */
export const SETTINGS_PAGES = ['you', 'memory', 'chats', 'tools', 'advanced', 'general', 'appearance', 'models', 'shortcuts', 'connectors', 'skills', 'plugins', 'claude', 'codex', 'about', 'privacy', 'accounts', 'other'];

/**
 * The settings whose change is counted, and exactly what each one's value may say: Canopy's own words for that
 * setting and no others. A value that is not on its own key's list is dropped, and the change is counted without it.
 *   a list      one of these words
 *   'percent'   a whole number from 50 to 200, as text (the window's size; the View menu offers 80 to 150)
 *   null        never a value: what the setting holds can be a company's own name for something (a model)
 */
const ON_OFF = ['on', 'off'];
export const SETTING_VALUES = {
  theme: ['light', 'dark', 'system'],
  default_mode: MODES,
  default_engine: ENGINES,
  default_model: null,
  default_effort: [...EFFORTS, 'default'], // 'default': back to the model's own level
  sound: ['chime', 'bell', 'tick', 'none'],
  notifications: ON_OFF,
  auto_update: ON_OFF,
  ui_size: 'percent',
  code_mode: ON_OFF,
  canopy_kit: ON_OFF,
  usage_stats: ON_OFF,
};
export const SETTING_KEYS = Object.keys(SETTING_VALUES);

/**
 * Connectors, skills and plugins that may be named. Anything else is sent as 'custom', because a private
 * connector's name can say where someone works. Compared lowercased, after dropping a scope like "@org/".
 */
export const PUBLIC_EXTENSIONS = [
  'github', 'gitlab', 'linear', 'jira', 'atlassian', 'confluence', 'notion', 'slack', 'discord', 'sentry', 'figma',
  'playwright', 'puppeteer', 'browserbase', 'context7', 'supabase', 'vercel', 'netlify', 'cloudflare', 'stripe',
  'aws', 'gcp', 'azure', 'firebase', 'postgres', 'mongodb', 'redis', 'sqlite', 'docker', 'kubernetes',
  'google-drive', 'gdrive', 'gmail', 'google-calendar', 'asana', 'hubspot', 'salesforce', 'zapier', 'airtable',
  'exa', 'perplexity', 'brave-search', 'tavily', 'fetch', 'filesystem', 'git', 'memory', 'sequential-thinking', 'time',
  'composio', 'canva', 'intercom', 'paypal', 'square', 'shopify', 'huggingface', 'posthog', 'datadog', 'grafana',
  'codex', 'superpowers', 'frontend-design', 'code-review', 'commit-commands', 'pr-review-toolkit', 'feature-dev',
  'security-guidance', 'hookify', 'plugin-dev', 'agent-sdk-dev', 'mattpocock-skills', 'pdf', 'docx', 'xlsx', 'pptx',
];

// ---------- Value types ----------
// A spec is one of:
//   'bool' | 'count' (integer 0..1e7) | 'secs' (number 0..1e6, 1 decimal) | 'minutes' (integer 0..10080)
//   'version' (a version string) | 'model' (a maker's public model id, or 'other')
//   'date' (YYYY-MM-DD) | 'hex16' (a fingerprint) | 'errtype' (an error class name) | 'errtext' (scrubbed, 200 chars)
//   'extension' (public name or 'custom') | an array (one of these strings)
//   a function of the value and the event's props, for a value whose list depends on another prop (a setting's
//   value on its key): it returns the cleaned value, or undefined to drop it

const RE = {
  version: /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  hex16: /^[0-9a-f]{16}$/,
  errtype: /^[A-Za-z_$][A-Za-z0-9_$]{0,59}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
};

// Model ids. A model is named only when its id is one the maker publishes; anything else is sent as 'other'. A
// company's own deployment is named after the company (gpt-4o-acme-prod, a fine-tune, an ARN with an account number
// in it), so "starts with claude or gpt" is not enough: these are the public shapes, spelled out, and nothing may
// follow one. A maker's new family or tier is 'other' until it is added here.
const CLAUDE_FAMILY = '(?:opus|sonnet|haiku|fable)';
const LONG = '(?:\\[1m\\])?'; // Claude Code's mark for a model's long-context variant
const MODEL_SHAPES = [
  // Claude Code's short names: a family, or its words for "the usual one": opus, fable[1m], default, best, opusplan
  new RegExp(`^(?:${CLAUDE_FAMILY}|opusplan|default|best)${LONG}$`),
  // claude-opus-5-5, claude-fable-5-2[1m], claude-opus-6, and with its date: claude-opus-5-5-20261001
  new RegExp(`^claude-${CLAUDE_FAMILY}-\\d{1,2}(?:-\\d{1,2})?(?:-\\d{8}|-latest)?${LONG}$`),
  // the older order: claude-3-5-sonnet-20241022
  new RegExp(`^claude-\\d{1,2}(?:-\\d{1,2})?-${CLAUDE_FAMILY}(?:-\\d{8}|-latest)?${LONG}$`),
  // gpt-5.5, gpt-5.5-codex, gpt-5.1-codex-max, gpt-6.1-sol, gpt-6-luna, gpt-4o-mini, and with its date: gpt-5-2025-08-07
  /^gpt-(?:\d{1,2}(?:\.\d{1,2})?|4o)(?:-(?:mini|nano|pro|max|codex|codex-mini|codex-max|sol|luna|astra|terra))?(?:-\d{4}-\d{2}-\d{2})?$/,
  // o3, o4-mini, o1-pro
  /^o\d(?:-mini|-pro)?(?:-\d{4}-\d{2}-\d{2})?$/,
  /^codex-mini-latest$/,
];
// Longer than any public id, with a cloud's wrapping on it.
const MODEL_ID_MAX = 100;

/**
 * A model id as it may be sent: the maker's public name for the model, or 'other'. What a cloud wraps around a
 * Claude id is taken off first, so a model is the same word wherever it runs: Bedrock's region and vendor in front
 * (us.anthropic.claude-…) and its own release number behind (…-v1:0), Vertex's @ before the date.
 */
export function publicModel(id) {
  if (typeof id !== 'string' || !id || id.length > MODEL_ID_MAX) return 'other';
  const bare = id.toLowerCase()
    .replace(/^(?:(?:us|eu|apac|global)\.)?anthropic\./, '')
    .replace(/-v\d{1,2}:\d{1,3}(?=(?:\[1m\])?$)/, '')
    .replace(/@(?=\d{8}(?:\[1m\])?$)/, '-');
  return MODEL_SHAPES.some((shape) => shape.test(bare)) ? bare : 'other';
}

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** One value against its spec: the cleaned value, or undefined to drop it. `props`: the event it came in. */
function cleanValue(spec, v, props) {
  if (Array.isArray(spec)) return typeof v === 'string' && spec.includes(v) ? v : undefined;
  if (typeof spec === 'function') return spec(v, props);
  switch (spec) {
    case 'bool': return typeof v === 'boolean' ? v : undefined;
    case 'count': return isInt(v) && v >= 0 && v <= 1e7 ? v : undefined;
    case 'minutes': return isNum(v) && v >= 0 && v <= 10080 ? Math.round(v) : undefined;
    case 'secs': return isNum(v) && v >= 0 && v <= 1e6 ? Math.round(v * 10) / 10 : undefined;
    case 'version': return typeof v === 'string' && RE.version.test(v) ? v : undefined;
    case 'date': return typeof v === 'string' && RE.date.test(v) ? v : undefined;
    case 'hex16': return typeof v === 'string' && RE.hex16.test(v) ? v : undefined;
    case 'errtype': return typeof v === 'string' && RE.errtype.test(v) ? v : undefined;
    case 'model': return typeof v === 'string' && v ? publicModel(v) : undefined;
    case 'extension': return typeof v === 'string' && v ? publicName(v) : undefined;
    case 'errtext': { if (typeof v !== 'string') return undefined; const s = scrubText(v, 200); return s || undefined; }
    default: return undefined;
  }
}

/** A setting's value, checked against the list of its own key (SETTING_VALUES). With no such key, no value. */
function settingValue(v, props) {
  const key = cleanValue(SETTING_KEYS, props?.key);
  const allowed = key === undefined ? null : SETTING_VALUES[key];
  if (typeof v !== 'string' || !allowed) return undefined;
  if (allowed === 'percent') return /^\d{2,3}$/.test(v) && Number(v) >= 50 && Number(v) <= 200 ? v : undefined;
  return allowed.includes(v) ? v : undefined;
}

// ---------- The catalog ----------

const tools = Object.fromEntries(TOOL_KINDS.map((k) => [`tools_${k}`, 'count']));
const daySources = Object.fromEntries(SOURCES.flatMap((s) => [[`msgs_${s}`, 'count'], [`chats_${s}`, 'count']]));

export const EVENTS = {
  /** Canopy started. Versions say what broke for whom; sign-in says who is stuck before their first chat. */
  app_opened: {
    os_version: 'version', arch: ['arm64', 'x64', 'other'], cc_version: 'version', codex_version: 'version',
    claude_found: 'bool', claude_signed_in: 'bool', codex_found: 'bool', codex_signed_in: 'bool', first_run: 'bool',
  },
  /** Canopy quit. open_min: wall time; active_min: minutes in front with the person not idle. */
  app_closed: { open_min: 'minutes', active_min: 'minutes' },
  /** The first time an install reaches each step of getting started. Sent once per step per install. */
  milestone: { step: MILESTONES },
  chat_started: { engine: ENGINES, model: 'model', mode: MODES, effort: EFFORTS, has_folder: 'bool', kind: ['new', 'resumed', 'forked'] },
  message_sent: { engine: ENGINES, model: 'model', length: ['short', 'medium', 'long'], images_n: 'count', files_n: 'count', queued: 'bool' },
  reply_finished: { engine: ENGINES, model: 'model', secs: 'secs', tools_n: 'count', ...tools, outcome: ['done', 'stopped', 'error'], background: 'bool' },
  permission_answered: { engine: ENGINES, tool_kind: TOOL_KINDS, answer: ['allow', 'always', 'deny'] },
  widget: { kind: WIDGET_KINDS, action: ['shown', 'used'] },
  feature_used: { name: FEATURES, page: SETTINGS_PAGES },
  extension_added: { type: ['connector', 'skill', 'plugin'], name: 'extension' },
  setting_changed: { key: SETTING_KEYS, value: settingValue },
  upkeep: { action: ['check', 'update'], result: ['current', 'updated', 'failed', 'skipped'], from: 'version', to: 'version' },
  /** A problem, grouped: one event per fingerprint per hour, with how many times it happened. */
  error: { where: ['main', 'ui', 'engine'], fingerprint: 'hex16', type: 'errtype', message: 'errtext', count: 'count' },
  /** One per local day, counted from history already on the Mac. baseline: a day from before Canopy was installed. */
  day_summary: {
    date: 'date', baseline: 'bool', ...daySources,
    canopy_active_min: 'minutes', canopy_stops: 'count', canopy_images: 'count', canopy_long_waits: 'count', projects_n: 'count',
  },
  /** Every few minutes while Canopy is open: how much is going on right now, as counts. Chats open in Canopy, working,
   *  and waiting on the person; agents, workflows and commands still running in the background. */
  live: { chats_open: 'count', chats_working: 'count', chats_waiting: 'count', agents: 'count', workflows: 'count', commands: 'count' },
  /** Sent once, at the moment the switch is turned off (the switch says so), and once when it's turned back on. */
  telemetry_off: {},
  telemetry_on: {},
};

// ---------- Cleaning ----------

/**
 * An event's props, cleaned: unknown props and bad values dropped. Returns null for an event that isn't in the
 * catalog. Never throws.
 */
export function clean(event, props) {
  const spec = Object.prototype.hasOwnProperty.call(EVENTS, event) ? EVENTS[event] : null;
  if (!spec) return null;
  const out = {};
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    for (const key of Object.keys(spec)) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
      const v = cleanValue(spec[key], props[key], props);
      if (v !== undefined) out[key] = v;
    }
  }
  return out;
}

/** Fields every event carries, besides its props. */
export const ENVELOPE = {
  id: 'uuid',          // unique per event: a retry is not counted twice (PostHog merges two events with one id)
  event: 'event',      // a key of EVENTS
  ts: 'iso',           // when it happened, the Mac's clock
  launch_id: 'uuid',   // one per app launch
};

/** The batch header: who sent it. One per request. */
export const BATCH = {
  install_id: 'uuid',
  name: 'name',              // the person's display name (scrubbed, may be empty)
  env: ['prod', 'dev'],      // dev: running from source, kept apart in the charts
  app_version: 'version',
  os_version: 'version',
  schema: 'schema',
  sent_at: 'iso',
};

export const LIMITS = { batchEvents: 200, batchBytes: 256 * 1024, nameChars: 80 };

const isIso = (v) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

/** One envelope (id, event, ts, launch_id, props) cleaned, or null when it can't be sent. */
export function cleanEnvelope(e) {
  if (!e || typeof e !== 'object') return null;
  if (typeof e.id !== 'string' || !RE.uuid.test(e.id)) return null;
  if (typeof e.launch_id !== 'string' || !RE.uuid.test(e.launch_id)) return null;
  if (!isIso(e.ts)) return null;
  const props = clean(e.event, e.props);
  if (!props) return null;
  return { id: e.id, event: e.event, ts: new Date(e.ts).toISOString(), launch_id: e.launch_id, props };
}

/**
 * A whole request body, cleaned: { header, events, dropped }. header is null when the batch can't be accepted at all
 * (bad install id, a schema version that isn't supported, too many events). Events that fail are dropped one by one
 * and counted.
 */
export function cleanBatch(body) {
  const fail = { header: null, events: [], dropped: 0 };
  if (!body || typeof body !== 'object') return fail;
  if (typeof body.install_id !== 'string' || !RE.uuid.test(body.install_id)) return fail;
  if (body.schema !== SCHEMA_VERSION && !SUPPORTED_SCHEMAS.includes(body.schema)) return fail;
  if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > LIMITS.batchEvents) return fail;
  const header = {
    install_id: body.install_id,
    name: typeof body.name === 'string' ? scrubText(body.name, LIMITS.nameChars, { name: true }) : '',
    env: body.env === 'dev' ? 'dev' : 'prod',
    app_version: cleanValue('version', body.app_version) ?? 'unknown',
    os_version: cleanValue('version', body.os_version) ?? 'unknown',
    schema: body.schema, // as it was sent: an older Canopy's events are stored as that version's
    sent_at: isIso(body.sent_at) ? new Date(body.sent_at).toISOString() : new Date().toISOString(),
  };
  const events = [];
  let dropped = 0;
  for (const e of body.events) { const c = cleanEnvelope(e); if (c) events.push(c); else dropped++; }
  return { header, events, dropped };
}

// ---------- Helpers both sides use ----------

/** A connector, skill or plugin name as it may be sent: its public name, or 'custom'. */
export function publicName(name) {
  const n = String(name ?? '').trim().toLowerCase().replace(/^@[^/]+\//, '').replace(/[\s_]+/g, '-');
  const bare = n.replace(/@.*$/, '').replace(/-mcp$|^mcp-|-server$|^server-/g, '');
  return PUBLIC_EXTENSIONS.includes(bare) ? bare : PUBLIC_EXTENSIONS.includes(n) ? n : 'custom';
}

// One piece of a path: anything but spaces, slashes, quotes and the punctuation a path sits inside of.
const SEG = '[^\\s/\'"`:()[\\]{}<>,;]';
// A path, absolute or not: a relative one is scrubbed from its first folder, which is a project's name as often as not.
const RE_PATH = new RegExp(`${SEG}*(?:/${SEG}+)+/?`, 'g');
// Node's network errors name the machine they could not reach right after the code.
const RE_NET_CODE = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|EPROTO)\s+[^\s,;)]+/g;
// Host names, by how they end. A short list on purpose: "x.map is not a function" has to stay readable.
const RE_HOST = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|ai|app|co|corp|internal|local|lan|edu|gov|cloud)\b/gi;
// Longer than any error's first line worth reading, and all of a text that is ever looked at: it is cut to this
// before anything else is done to it, so no rule below runs over more than this, however long the text is (the server
// runs them on text it did not write). Every rule is cheap on a line this size, whatever it holds.
const SCRUB_INPUT_MAX = 2000;
// Where a line ends, whichever way it was written.
const LINE_END = /[\n\r\u2028\u2029]/;
// What is not text: control characters (a NUL, an escape code) and half of a character that was cut in two. JSON
// carries both, and the database refuses the event they arrive in, along with every other event in its batch.
const RE_NOT_TEXT = /[\p{Cc}\p{Cs}]/gu;

/**
 * The first `max` characters of a string, never half of one: an emoji or a rare letter takes two units of a JS
 * string, and cutting by units can leave one behind.
 */
function cut(s, max) {
  if (s.length <= max) return s;
  // `max` characters are at most twice as many units, so no more than that is ever spread out.
  return Array.from(s.slice(0, max * 2)).slice(0, max).join('').trimEnd();
}

/**
 * Free text made safe to send: one line, no paths, emails, URLs, IPs, host names, long numbers, or anything shaped
 * like a key or token, then cut to max characters. Best effort on top of the rule that free text is only ever an
 * error's first line or a display name. { name: true } keeps only letters, spaces and . ' - (a display name has
 * nothing else). What comes out is always text a database will take: no control characters, and no character cut
 * in half. Scrubbing text twice gives the same text (Canopy scrubs, then the server does).
 */
export function scrubText(text, max = 200, { name = false } = {}) {
  // The start of the first line. Cut first, then split: the line's end is looked for in what is left, never in the
  // megabytes that may follow.
  let s = String(text ?? '').slice(0, SCRUB_INPUT_MAX).split(LINE_END, 1)[0];
  if (name) return cut(s.replace(/[^\p{L}\p{M} .'-]/gu, '').replace(/\s+/g, ' ').trim(), max);
  s = s
    // a tab is a space; the rest of what isn't text goes without leaving a gap, so a key with an escape code in
    // the middle of it is still one key to the rules below
    .replace(/\t/g, ' ')
    .replace(RE_NOT_TEXT, '')
    // URLs and emails before paths, so their slashes and @ go as one piece (someone@a-machine counts: ssh and git
    // errors name people that way)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*/g, '<email>')
    // credentials that say what they are: "Bearer …", "password=…", "token: …" (too short for the key shapes below)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 <secret>')
    .replace(/\b(pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|authorization)(\s*[:=]\s*)(?!<[a-z]+>|Bearer\b|Basic\b)[^\s'"`,;]+/gi, '$1$2<secret>')
    // Mac, Linux and Windows paths, ~ paths, and file:// leftovers
    .replace(RE_PATH, '<path>')
    .replace(/\b[A-Za-z]:\\[^\s'"`]*/g, '<path>')
    // a folder with spaces in its name (/Users/a/My Side Projects/x) leaves its words between two pieces of path
    .replace(/<path>(?:\s+[^\s<>]+){1,5}(?=\s+<path>)/g, '<path>')
    .replace(/<path>(?:\s*<path>)+/g, '<path>')
    // IPv4 addresses, then host names
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
    .replace(RE_NET_CODE, '$1 <host>')
    .replace(RE_HOST, '<host>')
    // key/token shapes: long runs of letters+digits, base64ish blobs, hex
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, '<secret>')
    .replace(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{16,}\b/g, '<secret>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\b\d{5,}\b/g, '<n>')
    // quoted strings usually hold user data ("Cannot find module 'foo'"), in straight quotes or curly ones (macOS
    // names files in “…”). An apostrophe inside a word (the user's) is not a quote: pairing it with a real one
    // would scrub the wrong half of the line.
    .replace(/(["`])(?:(?!\1).){1,200}\1/g, '<q>')
    .replace(/(?<![A-Za-z])'[^']{1,200}'/g, '<q>')
    .replace(/“[^”]{1,200}”|‘[^’]{1,200}’/g, '<q>')
    // a quote still open after that never closes (the line was cut short): everything after it goes
    .replace(/(?:["`“‘]|(?<![A-Za-z])').*$/, '<q>');
  return cut(s.replace(/\s+/g, ' ').trim(), max);
}

/** How long a message was, without sending the message: short < 80 chars, long > 1000. */
export function lengthBucket(text) {
  const n = typeof text === 'number' ? text : String(text ?? '').length;
  return n < 80 ? 'short' : n > 1000 ? 'long' : 'medium';
}

/** A tool name as one of TOOL_KINDS. */
export function toolKind(name) {
  const n = String(name ?? '');
  if (n.startsWith('mcp__')) return 'mcp';
  if (n === 'Bash' || n === 'BashOutput' || n === 'KillShell' || n === 'shell' || n === 'exec_command' || n === 'local_shell' || n === 'commandExecution') return 'bash';
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch', 'fileChange'].includes(n)) return 'edit';
  if (['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'LSP'].includes(n)) return 'read';
  if (['WebSearch', 'WebFetch', 'web_search', 'webSearch'].includes(n)) return 'web';
  if (['Task', 'Agent', 'Workflow', 'SendMessage', 'TaskStop', 'ListAgents'].includes(n)) return 'agent';
  if (n === 'AskUserQuestion') return 'question';
  if (n === 'ExitPlanMode' || n === 'EnterPlanMode' || n === 'TodoWrite' || n === 'update_plan') return 'plan';
  return 'other';
}
