// A question an MCP server puts to the user in the middle of a chat (MCP "elicitation"), in the one shape the
// window draws, whichever maker's chat it came through. Three kinds:
//
//   a form     `requestedSchema`: a flat object of string / number / integer / boolean / enum properties
//              (MCP 2025-11-25 ElicitRequestFormParams). Each property becomes one field of the card.
//   a link     `mode: 'url'`: a page to open in the browser (a sign-in, a payment), then Done or Cancel.
//   a yes/no   a form with no properties at all: Allow or Deny, never an empty form.
//
// The answer goes back in MCP's words: accept (with the form's values), decline (the user said no) or cancel (the
// user walked away). Nothing here throws: a schema that cannot be read is a question with no fields.

import { CHROME_ALLOW_PROMPT, CHROME_CONNECT_PROMPT, CHROME_SERVER } from './background-chrome.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export const FIELD_CAP = 40;
export const OPTION_CAP = 100;
const FORMATS = new Set(['email', 'uri', 'date', 'date-time']);

// "github" is "Github", "my_docs-server" is "My docs server": a server's name as a person would say it.
export function serverWords(name) {
  const s = str(name).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? clip(s[0].toUpperCase() + s.slice(1), 80) : 'A connected tool';
}

const labelOf = (key) => { const s = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase(); return s ? s[0].toUpperCase() + s.slice(1) : String(key); };

// The choices of an enum, however it is written: `oneOf`/`anyOf` of { const, title }, or `enum` with `enumNames`.
function optionsOf(p) {
  const out = [];
  const add = (value, label) => { if (typeof value === 'string' && out.length < OPTION_CAP && !out.some((o) => o.value === value)) out.push({ value, label: clip(str(label) || value, 200) }); };
  const titled = Array.isArray(p.oneOf) ? p.oneOf : Array.isArray(p.anyOf) ? p.anyOf : null;
  if (titled) for (const o of titled) { if (isObj(o)) add(o.const, o.title); }
  else if (Array.isArray(p.enum)) p.enum.forEach((v, i) => add(v, Array.isArray(p.enumNames) ? p.enumNames[i] : null));
  return out.length ? out : null;
}

function fieldOf(key, p, required) {
  const base = { key, label: clip(str(p.title) || labelOf(key), 200), help: clip(str(p.description), 500) || null, required };
  if (p.type === 'array') {
    const options = isObj(p.items) ? optionsOf(p.items) : null;
    if (!options) return null; // a list of free text: MCP has no such field
    const values = new Set(options.map((o) => o.value));
    return { ...base, kind: 'choices', options, default: Array.isArray(p.default) ? p.default.filter((v) => values.has(v)) : [] };
  }
  const options = optionsOf(p);
  if (options) return { ...base, kind: 'choice', options, default: options.some((o) => o.value === p.default) ? p.default : null };
  if (p.type === 'boolean') return { ...base, kind: 'boolean', default: p.default === true };
  if (p.type === 'number' || p.type === 'integer') {
    return { ...base, kind: 'number', integer: p.type === 'integer', default: num(p.default) ?? null, min: num(p.minimum) ?? null, max: num(p.maximum) ?? null };
  }
  return {
    ...base, kind: 'text', default: typeof p.default === 'string' ? clip(p.default, 2000) : null, format: FORMATS.has(p.format) ? p.format : null,
    minLength: num(p.minLength) ?? null, maxLength: num(p.maxLength) ?? null,
  };
}

// The fields of a form, in the order the server wrote them. [] for a link, a yes/no, or a schema that is not one.
export function fieldsOf(schema) {
  try {
    if (!isObj(schema) || !isObj(schema.properties)) return [];
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((k) => typeof k === 'string') : []);
    const out = [];
    for (const [key, p] of Object.entries(schema.properties)) {
      if (out.length >= FIELD_CAP) break;
      if (!isObj(p)) continue;
      const f = fieldOf(key, p, required.has(key));
      if (f) out.push(f);
    }
    return out;
  } catch { return []; }
}

// What the window typed, as the values the server asked for: numbers as numbers, a choice only if it was offered,
// nothing the form did not have. An optional field left empty is left out.
export function contentOf(fields, values) {
  const content = {};
  try {
    const v = isObj(values) ? values : {};
    for (const f of Array.isArray(fields) ? fields : []) {
      if (!isObj(f) || typeof f.key !== 'string' || !Object.hasOwn(v, f.key)) continue;
      const raw = v[f.key];
      if (f.kind === 'boolean') { content[f.key] = raw === true || raw === 'true'; continue; }
      if (f.kind === 'number') {
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
        if (Number.isFinite(n) && (!f.integer || Number.isInteger(n))) content[f.key] = n;
        continue;
      }
      const offered = new Set((Array.isArray(f.options) ? f.options : []).map((o) => o?.value));
      if (f.kind === 'choice') { if (typeof raw === 'string' && offered.has(raw)) content[f.key] = raw; continue; }
      if (f.kind === 'choices') { if (Array.isArray(raw)) content[f.key] = raw.filter((x) => typeof x === 'string' && offered.has(x)); continue; }
      if (typeof raw === 'string' && raw !== '') content[f.key] = clip(raw, 20000);
    }
  } catch { /* what was read so far stands */ }
  return content;
}

// Only a web page is opened from a card: never a file, an app link or a script.
export function webLink(url) {
  try { const u = new URL(str(url)); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch { return null; }
}

// The card, as both makers' sessions raise it: who is asking in plain words, what they said, and the fields.
// `ask`: 'form' (Submit / Cancel), 'link' (Open link, then Done / Cancel) or 'confirm' (Allow / Deny).
export function describe(req) {
  const r = isObj(req) ? req : {};
  const server = str(r.serverName) || null;
  const who = serverWords(server);
  const link = r.mode === 'url';
  const url = link ? webLink(r.url) : null;
  const fields = link ? [] : fieldsOf(r.requestedSchema);
  const chrome = !link && server === CHROME_SERVER && !fields.length
    && (r.message === CHROME_CONNECT_PROMPT ? 'chrome-setup' : r.message === CHROME_ALLOW_PROMPT ? 'chrome-allow' : null);
  const ask = chrome || (link ? 'link' : fields.length ? 'form' : 'confirm');
  const title = clip(str(r.title), 200) || (ask === 'link' ? `${who} wants you to open a link` : ask === 'form' ? `${who} needs a few details` : `${who} needs your OK`);
  return {
    server, message: clip(str(r.message), 4000), mode: link ? 'url' : 'form', ask, url, fields, title: chrome ? 'Connect Chrome' : title,
    elicitationId: typeof r.elicitationId === 'string' ? r.elicitationId : null,
  };
}

// The window's answer in MCP's words. `fields` are the ones the card was raised with.
export function answerOf(fields, answer) {
  const a = isObj(answer) ? answer : {};
  if (a.action === 'elicit-accept') return { action: 'accept', content: Array.isArray(fields) && fields.length ? contentOf(fields, a.content) : {} };
  if (a.action === 'elicit-decline') return { action: 'decline' };
  return { action: 'cancel' };
}
