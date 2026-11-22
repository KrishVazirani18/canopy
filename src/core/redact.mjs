// Redaction for anything that leaves core as display text (stderr tails, error messages).
// Best effort by design: it removes the secrets we can recognise, it does not prove absence.

const MARK = '[redacted]';
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
// Names that match the above but hold a location, not a secret (SSH_AUTH_SOCK, AWS_SHARED_CREDENTIALS_FILE…).
const LOCATION_NAME = /_(SOCK|PATH|DIR|FILE)$/i;
const MIN_VALUE = 8;
const MAX_VALUE = 16 * 1024;
const MAX_VALUES = 256;

const PATTERNS = [
  // Anthropic keys and OAuth tokens.
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, MARK],
  // OpenAI keys: a project's, a service account's, an older one. (OpenAI's own masked form, `sk-abcde***wxyz`, is
  // too short before its stars to match, and stays readable.)
  [/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{19,}/g, MARK],
  // Other vendor token shapes that show up in tool and MCP stderr.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abeprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, MARK],
  // Authorization headers, in any casing.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MARK}`],
  [/\b(x-api-key|api-key|authorization)(["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b)[^\s"',;]{8,}/gi, `$1$2${MARK}`],
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:?#]*(?::[^\s/@?#]*)?@/gi, `$1${MARK}@`],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Secret-looking values from an environment, longest first so a secret is never half-replaced by a shorter one. */
export function secretValues(env) {
  const out = new Set();
  if (!env || typeof env !== 'object') return [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < MIN_VALUE || value.length > MAX_VALUE) continue;
    if (!SECRET_NAME.test(name) || LOCATION_NAME.test(name)) continue;
    out.add(value);
    // Multi-line secrets (PEM keys) are usually printed one line at a time.
    if (value.includes('\n')) for (const line of value.split(/\r?\n/)) if (line.length >= 24 && !line.startsWith('-----')) out.add(line);
    if (out.size >= MAX_VALUES) break;
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Build a redactor bound to an environment snapshot.
 * @param {Record<string, string | undefined>} [env]
 * @returns {(text: unknown) => string}
 */
export function makeRedactor(env) {
  let byValue = null;
  try {
    const values = secretValues(env);
    if (values.length) byValue = new RegExp(values.map(escapeRe).join('|'), 'g');
  } catch { byValue = null; }
  return function redact(text) {
    if (text == null) return '';
    let s = typeof text === 'string' ? text : String(text);
    if (!s) return s;
    try {
      if (byValue) s = s.replace(byValue, MARK);
      for (const [re, to] of PATTERNS) s = s.replace(re, to);
    } catch { /* keep what we have: a redaction bug must never lose the error text */ }
    return s;
  };
}

/** One-off redaction with pattern rules only (no environment). */
export const redact = makeRedactor(null);
