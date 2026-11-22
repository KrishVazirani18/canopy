// Where telemetry goes, and the switches outside Settings that keep it from going anywhere.
import { BUILT_IN } from '../build-config.mjs';
import { DEFAULT_HOST, batchUrl } from './posthog.mjs';

/**
 * Canopy sends its events straight to PostHog (PostHog Cloud, US, unless the build names another host): there is no
 * server of Canopy's own in between.
 */
export const POSTHOG_HOST = BUILT_IN.posthogHost || DEFAULT_HOST;

/**
 * The PostHog project's key. It is the kind made to ship inside apps: it can add events to the project and read
 * nothing back, so it is no secret. An official build is given the project's (src/build-config.mjs); a copy built
 * from source has none. Empty, Canopy still shows what it would send ("See what's sent") and sends nothing.
 */
export const POSTHOG_KEY = BUILT_IN.posthogKey;

const OFF_WORDS = new Set(['0', 'false', 'off', 'no']);
// A key is one short word. Anything else (a line break, a space, a whole sentence pasted by mistake) is not one.
const KEY = /^[\w-]{1,200}$/;

/** A host Canopy may post to: https anywhere, plain http only to this Mac (a test server). '' for anything else. */
function usable(host) {
  if (typeof host !== 'string' || !host.trim()) return '';
  try {
    const u = new URL(host.trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    return u.protocol === 'https:' || (u.protocol === 'http:' && local) ? `${u.origin}${u.pathname}` : '';
  } catch { return ''; }
}

/**
 * Where this run sends, and whether an outside switch blocks sending.
 *   CANOPY_POSTHOG_KEY     replaces POSTHOG_KEY  (tests, a build of one's own with a PostHog project of one's own)
 *   CANOPY_POSTHOG_HOST    replaces POSTHOG_HOST (tests, PostHog's EU cloud)
 *   CANOPY_USER_DATA       an automated run or a harness, in a throwaway data folder: never sends ('automated')
 *   CANOPY_TELEMETRY=0     the person said no from outside the app: never sends ('env')
 *
 * A variable that is set replaces the built-in value whatever it holds: set to nothing, or to something that can't
 * be used, it means "nowhere", never "the real one after all". So a test that names its own key or host can't reach
 * the real project by getting one of them wrong.
 *
 * @param {Record<string, string | undefined>} [environ]
 * @param {{ key: string, host: string }} [builtIn] what this copy was built with (left out: its own)
 * @returns {{ endpoint: string, key: string, blocked: 'automated' | 'env' | null }}
 *   `endpoint`: the address batches are posted to, '' when there is no key or no usable host (nothing is sent).
 */
export function resolveConfig(environ = process.env, builtIn = { key: POSTHOG_KEY, host: POSTHOG_HOST }) {
  const env = environ && typeof environ === 'object' ? environ : {};
  const said = typeof env.CANOPY_TELEMETRY === 'string' ? env.CANOPY_TELEMETRY.trim().toLowerCase() : '';
  const pick = (name, builtIn) => (typeof env[name] === 'string' ? env[name].trim() : builtIn);
  const key = pick('CANOPY_POSTHOG_KEY', builtIn.key);
  const host = usable(pick('CANOPY_POSTHOG_HOST', builtIn.host));
  const ready = KEY.test(key) && !!host;
  return {
    endpoint: ready ? batchUrl(host) : '',
    key: ready ? key : '',
    blocked: env.CANOPY_USER_DATA ? 'automated' : OFF_WORDS.has(said) ? 'env' : null,
  };
}
