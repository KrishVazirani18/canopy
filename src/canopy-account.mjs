// Your Canopy account: Canopy's own sign-in (with Google, through Supabase Auth), so the project knows who uses Canopy
// and the app can show your name and photo. It has nothing to do with Claude Code's or Codex's logins.
//
// Signing in, the way desktop apps do it (OAuth for native apps, RFC 8252, with PKCE):
//   1. Canopy listens on a free port on 127.0.0.1 and opens Supabase's Google sign-in in your own browser, with a
//      one-time challenge whose secret half never leaves this process.
//   2. Google sends the browser back to Supabase, Supabase back to that local address with a one-time code.
//   3. Canopy swaps the code (plus the secret half) for a session, shows "You're signed in" in that tab, and comes to
//      the front. A row for you lands in the profiles table by itself (a trigger on Supabase's side).
// The session (an access token and the refresh token that renews it) is kept encrypted on this Mac, in its own file
// (`store`, safeStorage underneath). What the window may show (name, email, photo) is kept plainly (`load`/`save`),
// and the photo is copied to the Mac once, so it shows offline and Google is not asked on every launch.
//
// Contract: nothing here throws. A failure is { error } with words for a person, and the log never carries a token.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

import { accountService } from './build-config.mjs';

// Where the sign-in lives, and the public ("publishable") key for it: made to ship inside an app, and limited by the
// database's row rules to each person's own row. An official build is given the project's (src/build-config.mjs).
// A copy built from source has neither, and so has no Canopy account: `available` is false and nothing here calls out.
const SERVICE = accountService();

const SESSION_ID = 'canopy-account';
const WAIT_MS = 5 * 60_000;          // a sign-in left in the browser this long is given up
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The page the browser shows once you're back: plain, in Canopy's colours, and it says what to do next. */
const page = (title, line) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>html,body{height:100%;margin:0;background:#0e0f0e;color:#eef0ec;font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}
main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px}
h1{font-size:22px;font-weight:600;margin:0;letter-spacing:-.02em}p{margin:0;color:#9aa19a}</style>
<main><h1>${title}</h1><p>${line}</p></main>`;

export class CanopyAccount {
  /**
   * @param {{
   *   store: { get(id: string): string | null, set(id: string, v: string): { ok: boolean }, delete(id: string): boolean },
   *   load: () => any, save: (profile: any) => void,
   *   openExternal: (url: string) => Promise<unknown> | unknown,
   *   avatarFile: () => string,
   *   appVersion?: string,
   *   focusApp?: () => void,
   *   onChange?: (state: AccountView) => void,
   *   fetchImpl?: typeof fetch,
   *   log?: (msg: string) => void,
   *   url?: string, key?: string,
   * }} deps
   */
  constructor(deps) {
    this.d = deps;
    this.fetch = deps.fetchImpl ?? fetch;
    this.url = deps.url ?? SERVICE.url;
    this.key = deps.key ?? SERVICE.key;
    this.flow = null; // the sign-in in progress: { server, settle }
  }

  log(m) { try { this.d.log?.(m); } catch { /* never breaks a call */ } }
  emit() { try { this.d.onChange?.(this.view()); } catch { /* the window may be gone */ } }

  /** This copy of Canopy has a sign-in of its own to offer (false in a copy built from source). */
  get available() { return !!this.url && !!this.key; }

  /** What the window may know: never a token. `available` false: there is no Canopy account in this copy. */
  view() {
    const p = this.d.load?.() ?? null;
    let avatar = null;
    if (p?.avatarFile) { try { avatar = `data:image/jpeg;base64,${readFileSync(p.avatarFile).toString('base64')}`; } catch { /* gone: initials instead */ } }
    return { available: this.available, signedIn: this.available && !!p?.id && !!this.d.store.get(SESSION_ID), signingIn: !!this.flow, id: p?.id ?? null, name: p?.name ?? null, email: p?.email ?? null, avatar };
  }

  /** Signs in with Google in the browser. Resolves once you're signed in, it was cancelled, or it timed out. */
  async signIn() {
    if (!this.available) return { error: 'This copy of Canopy has no account to sign in to.' };
    if (this.flow) return { error: 'Already signing in. Finish in your browser.' };
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    let settle;
    const done = new Promise((res) => { settle = res; });
    let used = false; // the one-time code was taken: the browser coming back a second time starts nothing
    const server = createServer((req, res) => {
      let u;
      try { u = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { res.writeHead(400).end(); return; } // e.g. `GET //`
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error_description') || u.searchParams.get('error');
      if (!code) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Sign-in didn’t finish', 'Go back to Canopy and try again.'));
        settle({ error: err ? `Google said: ${err}` : 'Sign-in didn’t finish.' });
        return;
      }
      if (used) {
        res.writeHead(409, { 'content-type': 'text/html; charset=utf-8' }).end(page('Canopy already has this sign-in', 'You can close this tab and go back to Canopy.'));
        return;
      }
      used = true;
      this.exchange(code, verifier).then((r) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end(r.error ? page('Sign-in didn’t finish', 'Go back to Canopy and try again.') : page('You’re signed in', 'You can close this tab and go back to Canopy.'));
        settle(r);
      }, (err) => {
        // Keeping the session failed in a way nobody worded: the tab and the app are still told, at once.
        this.log(`sign-in: ${err?.message ?? err}`);
        try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Sign-in didn’t finish', 'Go back to Canopy and try again.')); } catch { /* the tab is gone */ }
        settle({ error: 'Sign-in didn’t finish. Try again.' });
      });
    });
    const port = await new Promise((res) => {
      server.once('error', () => res(0));
      server.listen(0, '127.0.0.1', () => res(server.address()?.port ?? 0));
    });
    if (!port) { try { server.close(); } catch {} return { error: 'Couldn’t start sign-in on this Mac.' }; }
    const timer = setTimeout(() => settle({ error: 'Sign-in timed out. Try again.' }), WAIT_MS);
    this.flow = { server, settle };
    this.emit();
    const authorize = `${this.url}/auth/v1/authorize?${new URLSearchParams({
      provider: 'google', redirect_to: `http://127.0.0.1:${port}/callback`,
      code_challenge: challenge, code_challenge_method: 's256', prompt: 'select_account',
    })}`;
    try { await this.d.openExternal(authorize); } catch { settle({ error: 'Couldn’t open your browser.' }); }
    const result = await done;
    clearTimeout(timer);
    try { server.close(); } catch {}
    this.flow = null;
    if (!result.error) { try { this.d.focusApp?.(); } catch {} }
    this.log(result.error ? `sign-in: ${result.error}` : 'sign-in: signed in');
    this.emit();
    return result.error ? result : this.view();
  }

  /** Gives up a sign-in still waiting in the browser. */
  cancel() { this.flow?.settle({ error: 'Cancelled.' }); return { ok: true }; }

  async exchange(code, verifier) {
    const r = await this.token('pkce', { auth_code: code, code_verifier: verifier });
    if (r.error) return r;
    const kept = await this.keep(r, { signingIn: true });
    if (kept?.error) return kept;
    return { ok: true };
  }

  /** Asks Supabase for a session. `grant`: 'pkce' (a code from sign-in) or 'refresh_token'. */
  async token(grant, body) {
    try {
      const res = await this.fetch(`${this.url}/auth/v1/token?grant_type=${grant}`, {
        method: 'POST', headers: { apikey: this.key, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.access_token) return { error: res.status === 400 || res.status === 401 ? 'expired' : 'Couldn’t reach Canopy’s sign-in. Check your connection.' };
      return j;
    } catch { return { error: 'Couldn’t reach Canopy’s sign-in. Check your connection.' }; }
  }

  /** Keeps a session: the tokens encrypted, who you are plainly, your photo copied to the Mac once.
   *  A new sign-in (`signingIn`) whose tokens the Mac would not keep is no sign-in: { error }, and nothing else is
   *  saved. A renewed session that could not be kept still updates the profile and the photo: the one kept earlier stands. */
  async keep(s, { signingIn = false } = {}) {
    const kept = this.d.store.set(SESSION_ID, JSON.stringify({ access: s.access_token, refresh: s.refresh_token, expires: s.expires_at ?? Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600) }));
    if (!kept?.ok) {
      this.log(`the session was not kept (${kept?.code ?? 'no answer'})`);
      // Only a refused Keychain is the person's to fix (src/secrets.mjs: 'unavailable'). A session too long to keep, or a
      // file that could not be written, is not.
      if (signingIn) return { error: `Canopy couldn’t keep your sign-in on this Mac. ${kept?.code === 'unavailable' ? 'Allow access to the Keychain, then try again.' : 'Try again.'}` };
    }
    const u = s.user ?? {}, m = u.user_metadata ?? {};
    const prev = this.d.load?.() ?? {};
    const picture = (m.avatar_url || m.picture || '').replace(/=s\d+-c$/, '=s256-c'); // Google: ask for a sharper one
    const pic = picture || prev.picture || null;
    // fetched again when it changed, or when the copy on the Mac is gone
    const avatarFile = pic && (pic !== prev.picture || !prev.avatarFile || !existsSync(prev.avatarFile)) ? await this.photo(pic) : (prev.avatarFile ?? null);
    this.d.save?.({ id: u.id ?? prev.id ?? null, email: u.email ?? prev.email ?? null, name: m.full_name || m.name || prev.name || null, picture: pic, avatarFile });
    this.seen(s.access_token, u.id ?? prev.id);
  }

  /** Copies your photo to the Mac. Returns where it is, or null (initials stand in). */
  async photo(url) {
    try {
      const res = await this.fetch(url);
      if (!res.ok) return null;
      writeFileSync(this.d.avatarFile(), Buffer.from(await res.arrayBuffer()));
      return this.d.avatarFile();
    } catch { return null; }
  }

  /** Notes on your row that you opened Canopy (and which version), without waiting for an answer. */
  seen(access, id) {
    if (!access || !id) return;
    this.fetch(`${this.url}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { apikey: this.key, authorization: `Bearer ${access}`, 'content-type': 'application/json', prefer: 'return=minimal' },
      body: JSON.stringify({ last_seen_at: new Date().toISOString(), app_version: this.d.appVersion ?? null }),
    }).catch(() => {});
  }

  /** On launch: renews the session if it's close to running out, and notes that you're here. */
  async resume() {
    if (!this.available) return this.view();
    const raw = this.d.store.get(SESSION_ID);
    if (!raw) return this.view();
    let s; try { s = JSON.parse(raw); } catch { return this.view(); }
    // the photo's copy went missing (or never landed): fetch it again
    const p = this.d.load?.();
    if (p?.picture && (!p.avatarFile || !existsSync(p.avatarFile))) { const f = await this.photo(p.picture); if (f) { this.d.save?.({ ...p, avatarFile: f }); this.emit(); } }
    if (s.expires - 300 > Date.now() / 1000) { this.seen(s.access, this.d.load?.()?.id); return this.view(); }
    const r = await this.token('refresh_token', { refresh_token: s.refresh });
    if (r.error === 'expired') { this.forget(); return this.view(); } // signed out elsewhere: ask again
    if (!r.error) await this.keep(r);
    this.emit();
    return this.view();
  }

  /** A current access token: the kept one, renewed first if it's about to run out. null when signed out. */
  async access() {
    if (!this.available) return null;
    const raw = this.d.store.get(SESSION_ID);
    if (!raw) return null;
    let s; try { s = JSON.parse(raw); } catch { return null; }
    if (s.expires - 120 > Date.now() / 1000) return s.access;
    const r = await this.token('refresh_token', { refresh_token: s.refresh });
    if (r.error) return null;
    await this.keep(r);
    return r.access_token;
  }

  /** Deletes your Canopy account for good (your row in Canopy's list goes with it), then forgets it on this Mac.
   *  Your chats, Claude Code and Codex are not touched. */
  async deleteAccount() {
    const access = await this.access();
    if (!access) return { error: 'Sign in again first, then delete your account.' };
    try {
      const res = await this.fetch(`${this.url}/rest/v1/rpc/delete_my_account`, {
        method: 'POST', headers: { apikey: this.key, authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: '{}',
      });
      if (!res.ok) return { error: 'Couldn’t delete your account. Check your connection and try again.' };
    } catch { return { error: 'Couldn’t delete your account. Check your connection and try again.' }; }
    this.log('account deleted');
    this.forget();
    this.emit();
    return this.view();
  }

  /** Signs out of Canopy on this Mac (Claude Code and Codex are not touched). */
  async signOut() {
    const raw = this.d.store.get(SESSION_ID);
    if (raw && this.available) {
      try {
        const { access } = JSON.parse(raw);
        await this.fetch(`${this.url}/auth/v1/logout?scope=local`, { method: 'POST', headers: { apikey: this.key, authorization: `Bearer ${access}` } }).catch(() => {});
      } catch { /* forget it here either way */ }
    }
    this.forget();
    this.emit();
    return this.view();
  }

  forget() {
    this.d.store.delete(SESSION_ID);
    const p = this.d.load?.();
    if (p?.avatarFile) { try { rmSync(p.avatarFile, { force: true }); } catch {} }
    this.d.save?.(null);
  }
}

/** @typedef {{ signedIn: boolean, signingIn: boolean, id: string | null, name: string | null, email: string | null, avatar: string | null }} AccountView */
