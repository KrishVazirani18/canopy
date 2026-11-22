// What an official build of Canopy is given and a copy built from source is not: where usage stats go, and where
// Canopy's own sign-in lives.
//
// Neither key is a secret (both are the kind made to ship inside an app). They are the project's, though: a fork
// that sent its stats to the project's PostHog, or signed people in to the project's list, would be speaking for it.
// So the repository holds none of them. A release writes them into src/build-config.json (ignored by git) before it
// packages, and a build of one's own can be pointed at one's own services the same way, or with the variables:
//
//   src/build-config.json    { "posthogKey": "…", "posthogHost": "…", "supabaseUrl": "…", "supabaseKey": "…" }
//   CANOPY_POSTHOG_KEY, CANOPY_POSTHOG_HOST    replace the first two (src/telemetry/config.mjs reads them)
//   CANOPY_SUPABASE_URL, CANOPY_SUPABASE_KEY   replace the last two
//
// With no values, nothing is sent and Canopy has no account of its own: onboarding goes straight to setting up.
// A value that is missing or not usable counts as no value, never as a reason to stop.
import { readFileSync } from 'node:fs';

const FILE = new URL('./build-config.json', import.meta.url);
const KEYS = ['posthogKey', 'posthogHost', 'supabaseUrl', 'supabaseKey'];

const text = (v) => (typeof v === 'string' && v.trim().length <= 500 ? v.trim() : '');

/** What the file holds: four strings, '' for each one that is not there. `read` gives the file's text (or throws). */
export function readBuildFile(read = () => readFileSync(FILE, 'utf8')) {
  let found = null;
  try { found = JSON.parse(read()); } catch { /* no file (a copy built from source), or not JSON: nothing is configured */ }
  const from = found && typeof found === 'object' && !Array.isArray(found) ? found : {};
  return Object.fromEntries(KEYS.map((k) => [k, text(from[k])]));
}

/** What this copy was built with, before any variable has its say. */
export const BUILT_IN = Object.freeze(readBuildFile());

// An address Canopy may sign in at: https anywhere, plain http only on this Mac (a local stack, a test).
function address(v) {
  try {
    const u = new URL(v);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    return u.protocol === 'https:' || (u.protocol === 'http:' && local) ? u.origin : '';
  } catch { return ''; }
}
// A key is one short word. Anything else (a space, a line break, a sentence pasted by mistake) is not one.
const KEY = /^[\w.-]{1,300}$/;

/**
 * Where Canopy's own sign-in lives for this run, or nowhere. A variable that is set replaces the built-in value
 * whatever it holds: set to nothing, it means "no sign-in", never "the built-in one after all".
 * @returns {{ url: string, key: string }} both '' unless both are usable
 */
export function accountService(environ = process.env, builtIn = BUILT_IN) {
  const env = environ && typeof environ === 'object' ? environ : {};
  const pick = (name, fallback) => (typeof env[name] === 'string' ? env[name].trim() : fallback);
  const url = address(pick('CANOPY_SUPABASE_URL', builtIn.supabaseUrl));
  const key = pick('CANOPY_SUPABASE_KEY', builtIn.supabaseKey);
  return url && KEY.test(key) ? { url, key } : { url: '', key: '' };
}
