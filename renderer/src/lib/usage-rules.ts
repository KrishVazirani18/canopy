// The Usage tab's words: how a window, an amount, a moment and an account read. What is shown is decided in main
// (src/core/usage.mjs); this file only says it. Plain TypeScript with no run-time imports, so node runs it as it
// is: the rules are tested without a window (src/core/test/unit/usage-rules.test.mjs).
//
// `locale` is there for the tests; the window leaves it out and gets the Mac's own.
import type { Engine, UsageCount, UsageSection } from './api';

/** What each maker's section is called. */
export const MAKER: Record<Engine, string> = { claude: 'Claude', codex: 'Codex' };
/** A window this full is drawn in amber: the same line main uses for "near a limit". */
export const HOT = 90;

const DAY = 86_400_000;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- a window ----------

/** "34%", and "<1%" for a window that has only just been touched. */
export const percentText = (p: number) => `${p > 0 && p < 1 ? '<1' : Math.round(Math.min(100, Math.max(0, p)))}%`;
/** The bar's width in percent: never so thin it disappears. */
export const barWidth = (p: number) => Math.max(1.5, Math.min(100, p));
/** Amber: at 90% or more, as far as is known. A window whose reset time has passed has started over since it was
 *  read, so its old number is drawn plainly until the next read. */
export const isHot = (w: { percent: number; resetsAt: number | null }, now: number) => w.percent >= HOT && !(w.resetsAt !== null && w.resetsAt <= now);

/** "Resets 3:40 PM" today, "Resets Sat 11:00 PM" this week, "Resets Nov 30" further off. Empty when not known or already past. */
export function resetText(resetsAt: number | null | undefined, now: number, locale?: string): string {
  if (typeof resetsAt !== 'number' || !(resetsAt > now)) return '';
  const d = new Date(resetsAt);
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date(now).toDateString()) return `Resets ${time}`;
  // Six days out a weekday still means one day; at seven it would read as today.
  if (resetsAt - now < 6 * DAY) return `Resets ${d.toLocaleDateString(locale, { weekday: 'short' })} ${time}`;
  return `Resets ${d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}`;
}

/** How old the numbers are: "Updated just now", "Updated 3 min ago", "Updated 2 hr ago", then the date. */
export function ageText(at: number, now: number, locale?: string): string {
  const s = Math.max(0, now - at) / 1000;
  if (s < 60) return 'Updated just now';
  if (s < 3600) return `Updated ${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `Updated ${Math.floor(s / 3600)} hr ago`;
  return `Updated ${new Date(at).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}`;
}

// ---------- an amount ----------

/** Dollars, written as Home writes today's cost: with one account the two numbers are the same, and read the same. */
export const money = (n: number) => `$${n < 1000 ? n.toFixed(2) : Math.round(n).toLocaleString()}`;

/** "950 tokens", "12.3k tokens", "1.2M tokens": the context meter's short numbers. */
export function tokenText(n: number): string {
  const v = Math.max(0, Math.round(n));
  const millions = v >= 999_500; // from here "k" would round up to a thousand of them
  const short = millions ? `${+(v / 1e6).toFixed(v % 1e6 ? 1 : 0)}M` : v >= 1000 ? `${(v / 1000).toFixed(v >= 1e5 ? 0 : 1)}k` : `${v}`;
  return `${short} ${v === 1 ? 'token' : 'tokens'}`;
}

// Dollars, and beside them any tokens no price is known for: "$1.84", "$1.84 + 12.3k tokens", "12.3k tokens".
const amount = (usd: number, tokens = 0) => (tokens > 0 ? (usd > 0 ? `${money(usd)} + ${tokenText(tokens)}` : tokenText(tokens)) : money(usd));

/**
 * The lines for an account billed per use, the same for either maker: Today, This chat (only when the chat on
 * screen runs on it), and the month, which is called "Since Nov 16" until Canopy has counted a whole one.
 * A chat is counted whole, whichever days it ran on: when that is more than today holds, its line says "in total",
 * so it is not read as part of today. The month's line is left out while it would only repeat today's (counting
 * began today, or the month did).
 */
export function countRows(c: UsageCount, locale?: string): [string, string][] {
  const u = c.unpriced ?? null;
  const today = amount(c.today, u?.today);
  const rows: [string, string][] = [['Today', today]];
  if (c.chat !== null) {
    const more = c.chat - c.today >= 0.005 || (u?.chat ?? 0) > (u?.today ?? 0);
    rows.push([more ? 'This chat, in total' : 'This chat', amount(c.chat, u?.chat)]);
  }
  const month = amount(c.month, u?.month);
  if (month !== today) rows.push([c.since ? `Since ${new Date(c.since).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}` : 'This month', month]);
  return rows;
}

const listed = (names: string[]) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * The faint line under the count: where the numbers come from. For Codex, how the dollars were worked out (OpenAI
 * gives no cost for a key, so they are tokens at its list prices), and which tokens have no price and are shown
 * as they are. For a provider of your own, who keeps the limits.
 */
export function countNote(s: UsageSection): string {
  const said = ['Counted from chats in Canopy.'];
  if (s.engine === 'codex') {
    said.push('Worked out from tokens at OpenAI’s list prices.');
    const u = s.count?.unpriced;
    if (u && (u.today > 0 || u.month > 0 || u.chat > 0)) {
      said.push(u.models.length ? `Price not known for ${listed(u.models)}, so ${u.models.length > 1 ? 'their' : 'its'} tokens are shown instead.` : 'Some tokens have no known price, and are shown as tokens.');
    }
  }
  if (s.account.kind === 'external') said.push('Limits are tracked by your provider.');
  return said.join(' ');
}

function currency(n: number, code: string, locale?: string): string {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(n); }
  catch { return `${n.toFixed(2)} ${code}`; }
}

/** Extra usage on a plan, in a few words: "Off", "On", "$12.34 of $50.00", "$2.50 spent", or how full when no amount is known. */
export function extraText(e: NonNullable<UsageSection['extra']>, locale?: string): string {
  if (!e.enabled) return 'Off';
  if (e.used !== null && e.limit !== null) return `${currency(e.used, e.currency, locale)} of ${currency(e.limit, e.currency, locale)}`;
  if (e.used !== null) return `${currency(e.used, e.currency, locale)} spent`;
  if (e.percent !== null) return `${percentText(e.percent)} used`;
  return 'On';
}

/** A ChatGPT plan's credits as Codex words them: "Unlimited", or the balance as it came. Null when there is nothing to say. */
export function creditsText(c: NonNullable<UsageSection['credits']>): string | null {
  return c.unlimited ? 'Unlimited' : c.balance;
}

// ---------- an account ----------

const PLANS: Record<string, string> = { free: 'Free', pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };
// What in the environment can supply a Claude login without being a cloud provider.
const OWN_KEYS = ['ANTHROPIC_API_KEY', 'apiKeyHelper', 'token'];
// Each part of a line starts with a capital, as a row's second line does in Settings (accounts.ts `accountLine`).
const PROBLEM: Record<string, string> = {
  'signed-out': 'Signed out', expired: 'Signed out', mismatch: 'Using a different login', missing: 'Its folder is missing',
  locked: 'Keychain is locked', 'invalid-key': 'Key no longer works',
};

/** A plan's name. For Claude the plan as usage() names it wins: Claude Code words it differently in different places. */
export function planName(s: UsageSection): string {
  const plan = s.engine === 'claude' ? s.plan ?? s.account.plan : null;
  return plan ? PLANS[plan.toLowerCase()] ?? cap(plan) : s.account.label;
}

/** The line under the maker's name: which account this is, and how it is paid for or what is wrong with it. */
export function accountLine(s: UsageSection): string {
  const a = s.account;
  if (s.shape === 'attention') return `${a.label} · ${a.state === 'blocked' ? cap(a.why ?? 'your settings choose the login') : PROBLEM[a.state] ?? 'Needs attention'}`;
  if (s.shape === 'plan') return [planName(s), a.email].filter(Boolean).join(' · ');
  const cloud = a.kind === 'external' && a.engine === 'claude' && !!a.via && !OWN_KEYS.includes(a.via);
  return `${a.label} · ${cloud ? 'Billed by your provider' : 'Billed per use'}`;
}

/** An account that needs you: what to do, or what is in the way. Nothing is read for it until then. */
export function attentionText(s: UsageSection): string {
  const what = s.account.kind === 'plan' ? 'limits' : 'usage';
  switch (s.account.state) {
    case 'signed-out': case 'expired': return `Sign in again to see this account’s ${what}.`;
    case 'mismatch': return `${s.engine === 'codex' ? 'Codex' : 'Claude Code'} is signed in as someone else, so this account’s ${what} can’t be read.`;
    case 'missing': return `This account’s folder is missing, so its ${what} can’t be read.`;
    case 'locked': return `Its key could not be read from the Keychain, so its ${what} can’t be read.`;
    case 'invalid-key': return `Its key no longer works, so its ${what} can’t be read.`;
    default: return `This account can’t be used right now, so its ${what} can’t be read.`;
  }
}

// ---------- near a limit ----------

/** One line for the window that is nearly full, or full. */
export function nearText(near: NonNullable<UsageSection['near']>): string {
  const full = near.percent >= 100;
  if (near.key === 'five_hour') return full ? 'This session’s limit is reached.' : 'Almost at this session’s limit.';
  if (near.key === 'seven_day') return full ? 'This week’s limit is reached.' : 'Almost at this week’s limit.';
  return full ? `${near.label} is at its limit.` : `${near.label} is almost at its limit.`;
}

/** The button that takes the offer (account-rules.ts `limitOffer`): "Use API key", "Use Console". A key's last four characters stay off the button. */
export function offerLabel(offer: { label: string }): string {
  return `Use ${offer.label.startsWith('API key') ? 'API key' : offer.label}`;
}

/** What is said once the offer is taken: new chats move, the open ones stay where they are. */
export function switchedText(offer: { label: string }): { title: string; description: string } {
  const name = offer.label.startsWith('API key') ? 'your API key' : offer.label;
  return { title: `New chats use ${name}`, description: 'Open chats stay on the account they started on.' };
}
