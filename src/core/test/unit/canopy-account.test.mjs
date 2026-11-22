// Canopy's own account (src/canopy-account.mjs): the Google sign-in round trip through a stand-in Supabase, what is
// kept where, the photo, renewing on launch and signing out. No network, no browser: openExternal hands the URL to
// the test, which plays the browser coming back to the local address.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanopyAccount } from '../../../canopy-account.mjs';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Every folder a test made, removed when the file is done.
const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function setup({ tokenStatus = 200, refreshStatus = 200, keeps = true, saves = true, gate = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'canopy-account-'));
  dirs.push(dir);
  const vault = new Map();
  let refusal = keeps === true ? null : (keeps || 'unavailable'); // the code the store refuses with (src/secrets.mjs)
  let profile = null;
  const calls = [];
  let challenge = null;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = new URL(String(url));
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'pkce') {
      const body = JSON.parse(init.body);
      await gate; // a test may hold the exchange here
      // The secret half must match the challenge sent to the browser.
      const ok = b64url(createHash('sha256').update(body.code_verifier).digest()) === challenge && body.auth_code === 'CODE123';
      if (!ok || tokenStatus !== 200) return new Response('{}', { status: 400 });
      return Response.json({ access_token: 'ACCESS1', refresh_token: 'REFRESH1', expires_in: 3600, user: { id: 'u-1', email: 'alex@example.com', user_metadata: { full_name: 'Alex Rivera', avatar_url: 'https://lh3.googleusercontent.com/a/photo=s96-c' } } });
    }
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'refresh_token') {
      if (refreshStatus !== 200) return new Response('{}', { status: refreshStatus });
      return Response.json({ access_token: 'ACCESS2', refresh_token: 'REFRESH2', expires_in: 3600, user: { id: 'u-1', email: 'alex@example.com', user_metadata: { full_name: 'Alex Rivera', avatar_url: 'https://lh3.googleusercontent.com/a/photo=s96-c' } } });
    }
    if (u.hostname === 'lh3.googleusercontent.com') return new Response(Buffer.from('JPEGDATA'), { status: 200 });
    if (u.pathname.startsWith('/rest/v1/profiles') || u.pathname === '/auth/v1/logout') { if (u.pathname === '/auth/v1/logout') assert.equal(u.searchParams.get('scope'), 'local'); } if (u.pathname.startsWith('/rest/v1/profiles') || u.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
    if (u.pathname === '/rest/v1/rpc/delete_my_account') return new Response(null, { status: init.headers?.authorization === 'Bearer ACCESS1' || init.headers?.authorization === 'Bearer ACCESS2' ? 204 : 401 });
    return new Response('{}', { status: 404 });
  };
  let opened = null;
  const account = new CanopyAccount({
    store: { get: (id) => vault.get(id) ?? null, set: (id, v) => { if (refusal) return { ok: false, code: refusal }; vault.set(id, v); return { ok: true }; }, delete: (id) => vault.delete(id) || true },
    load: () => profile, save: (p) => { if (!saves) throw new Error('disk full'); profile = p; },
    openExternal: (url) => { opened = url; challenge = new URL(url).searchParams.get('code_challenge'); },
    avatarFile: () => path.join(dir, 'avatar.jpg'),
    appVersion: '1.2.3', fetchImpl, url: 'https://proj.supabase.co', key: 'sb_publishable_test',
  });
  return { account, vault, calls, get opened() { return opened; }, get profile() { return profile; }, dir, refuse: (code) => { refusal = code; } };
}

/** Plays the browser: waits for Canopy to open the sign-in, then comes back to the local address. */
async function browserReturns(t, query) {
  for (let i = 0; i < 200 && !t.opened; i++) await new Promise((r) => setTimeout(r, 5));
  const redirect = new URL(t.opened).searchParams.get('redirect_to');
  const res = await fetch(`${redirect}?${query}`);
  return res.text();
}

test('signs in with Google: PKCE round trip, tokens kept encrypted, profile and photo kept, row touched', async () => {
  const t = setup();
  const pending = t.account.signIn();
  const html = await browserReturns(t, 'code=CODE123');
  const view = await pending;
  assert.match(html, /You’re signed in/);
  const auth = new URL(t.opened);
  assert.equal(auth.origin + auth.pathname, 'https://proj.supabase.co/auth/v1/authorize');
  assert.equal(auth.searchParams.get('provider'), 'google');
  assert.equal(auth.searchParams.get('code_challenge_method'), 's256');
  assert.match(auth.searchParams.get('redirect_to'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(view.signedIn, true);
  assert.equal(view.name, 'Alex Rivera');
  assert.equal(view.email, 'alex@example.com');
  assert.equal(view.avatar, `data:image/jpeg;base64,${Buffer.from('JPEGDATA').toString('base64')}`);
  // the window's view never carries a token
  assert.ok(!JSON.stringify(view).includes('ACCESS1') && !JSON.stringify(view).includes('REFRESH1'));
  // tokens only in the vault; the plain profile has none
  assert.match(t.vault.get('canopy-account'), /REFRESH1/);
  assert.ok(!JSON.stringify(t.profile).includes('REFRESH1'));
  // a sharper Google photo was asked for, and copied to the Mac
  assert.ok(t.calls.some((c) => c.url.endsWith('=s256-c')));
  assert.equal(readFileSync(path.join(t.dir, 'avatar.jpg'), 'utf8'), 'JPEGDATA');
  // the person's own row notes the version
  const patch = t.calls.find((c) => c.url.includes('/rest/v1/profiles?id=eq.u-1'));
  assert.equal(JSON.parse(patch.init.body).app_version, '1.2.3');
  assert.equal(patch.init.headers.authorization, 'Bearer ACCESS1');
});

test('a sign-in Google turns down comes back as words, keeps nothing', async () => {
  const t = setup();
  const pending = t.account.signIn();
  const html = await browserReturns(t, 'error=access_denied&error_description=The+user+denied+access');
  const r = await pending;
  assert.match(html, /didn’t finish/);
  assert.match(r.error, /denied/);
  assert.equal(t.vault.size, 0);
  assert.equal(t.account.view().signedIn, false);
});

test('a Mac that will not keep the session: the tab and the app both say so, and nobody is signed in', async () => {
  const t = setup({ keeps: false });
  const pending = t.account.signIn();
  const html = await browserReturns(t, 'code=CODE123');
  const r = await pending;
  assert.match(html, /Sign-in didn’t finish/);
  assert.match(r.error, /couldn’t keep your sign-in on this Mac/);
  assert.match(r.error, /Allow access to the Keychain/, 'a refused Keychain is yours to allow');
  assert.equal(t.profile, null, 'no profile without a session');
  assert.equal(t.account.view().signedIn, false);

  // Not every refusal is the Keychain's: a session too long to keep, or a file that could not be written.
  for (const code of ['invalid', 'write-failed']) {
    const other = setup({ keeps: code });
    const waiting = other.account.signIn();
    await browserReturns(other, 'code=CODE123');
    assert.equal((await waiting).error, 'Canopy couldn’t keep your sign-in on this Mac. Try again.', code);
    assert.equal(other.account.view().signedIn, false);
  }
});

test('a renewed session the Mac will not keep still updates who you are, and the session kept before stands', async () => {
  const t = setup();
  const pending = t.account.signIn();
  await browserReturns(t, 'code=CODE123');
  await pending;
  const s = JSON.parse(t.vault.get('canopy-account')); s.expires = Math.floor(Date.now() / 1000); t.vault.set('canopy-account', JSON.stringify(s));
  t.calls.length = 0;
  t.refuse('write-failed');
  const v = await t.account.resume();
  assert.match(t.vault.get('canopy-account'), /REFRESH1/, 'the earlier session is still the one kept');
  assert.deepEqual([v.signedIn, v.name], [true, 'Alex Rivera']);
  const patch = t.calls.find((c) => c.url.includes('/rest/v1/profiles?id=eq.u-1'));
  assert.equal(patch?.init.headers.authorization, 'Bearer ACCESS2', 'your row is still told you are here');
  assert.equal(await t.account.access(), 'ACCESS2', 'and a renewed token is still handed on');
});

test('a sign-in that breaks while it is being kept still answers the tab and ends', async () => {
  const t = setup({ saves: false });
  const pending = t.account.signIn();
  const html = await browserReturns(t, 'code=CODE123');
  const r = await pending;
  assert.match(html, /Sign-in didn’t finish/);
  assert.equal(r.error, 'Sign-in didn’t finish. Try again.');
  assert.equal(t.account.view().signingIn, false);
});

test('the local address takes one code, and a request that is no address at all is turned away', async () => {
  let open;
  const t = setup({ gate: new Promise((r) => { open = r; }) });
  const pending = t.account.signIn();
  for (let i = 0; i < 200 && !t.opened; i++) await new Promise((r) => setTimeout(r, 5));
  const redirect = new URL(new URL(t.opened).searchParams.get('redirect_to'));
  // `GET //` is not a URL Node can read: it used to throw inside the server.
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: redirect.hostname, port: redirect.port, path: '//', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 400);
  // The browser comes back twice while the first code is still being swapped for a session.
  const first = fetch(`${redirect}?code=CODE123`);
  for (let i = 0; i < 600 && !t.calls.some((c) => c.url.includes('grant_type=pkce')); i++) await new Promise((r) => setTimeout(r, 5));
  const again = await fetch(`${redirect}?code=CODE123`);
  assert.equal(again.status, 409);
  assert.match(await again.text(), /Canopy already has this sign-in/, 'the second tab is told, not left blank');
  open();
  assert.equal((await first).status, 200);
  assert.equal((await pending).signedIn, true);
  assert.equal(t.calls.filter((c) => c.url.includes('grant_type=pkce')).length, 1, 'one exchange');
});

test('only one sign-in at a time, and cancel ends it', async () => {
  const t = setup();
  const pending = t.account.signIn();
  for (let i = 0; i < 200 && !t.opened; i++) await new Promise((r) => setTimeout(r, 5));
  assert.match((await t.account.signIn()).error, /Already signing in/);
  t.account.cancel();
  assert.equal((await pending).error, 'Cancelled.');
  assert.equal(t.account.view().signingIn, false);
});

test('resume renews a session about to run out; an expired one signs you out', async () => {
  const t = setup();
  const pending = t.account.signIn();
  await browserReturns(t, 'code=CODE123');
  await pending;
  // make it due
  const s = JSON.parse(t.vault.get('canopy-account')); s.expires = Math.floor(Date.now() / 1000); t.vault.set('canopy-account', JSON.stringify(s));
  await t.account.resume();
  assert.match(t.vault.get('canopy-account'), /REFRESH2/);

  const t2 = setup({ refreshStatus: 400 });
  const p2 = t2.account.signIn();
  await browserReturns(t2, 'code=CODE123');
  await p2;
  const s2 = JSON.parse(t2.vault.get('canopy-account')); s2.expires = 0; t2.vault.set('canopy-account', JSON.stringify(s2));
  const v = await t2.account.resume();
  assert.equal(v.signedIn, false);
  assert.equal(t2.vault.has('canopy-account'), false);
});

test('sign out forgets the session, the profile and the photo', async () => {
  const t = setup();
  const pending = t.account.signIn();
  await browserReturns(t, 'code=CODE123');
  await pending;
  const v = await t.account.signOut();
  assert.equal(v.signedIn, false);
  assert.equal(v.name, null);
  assert.equal(t.vault.has('canopy-account'), false);
  assert.equal(existsSync(path.join(t.dir, 'avatar.jpg')), false);
  assert.ok(t.calls.some((c) => c.url.endsWith('/auth/v1/logout?scope=local'))); // this Mac only
});

test('a photo whose copy is gone is fetched again: on the next sign-in, and on launch', async () => {
  const t = setup();
  let p = t.account.signIn();
  await browserReturns(t, 'code=CODE123');
  await p;
  const file = path.join(t.dir, 'avatar.jpg');
  rmSync(file);
  // the same Google photo as before, but the Mac's copy is gone
  p = t.account.signIn();
  const t2opened = t.opened;
  await new Promise((r) => setTimeout(r, 20));
  const redirect = new URL(t.opened ?? t2opened).searchParams.get('redirect_to');
  await fetch(`${redirect}?code=CODE123`);
  const v = await p;
  assert.ok(existsSync(file));
  assert.ok(v.avatar);
  rmSync(file);
  await t.account.resume();
  assert.ok(existsSync(file));
  assert.ok(t.account.view().avatar);
});

test('delete account: asks Supabase as you, then forgets everything here; signed out, it says to sign in first', async () => {
  const t = setup();
  const p = t.account.signIn();
  await browserReturns(t, 'code=CODE123');
  await p;
  const v = await t.account.deleteAccount();
  assert.equal(v.signedIn, false);
  const call = t.calls.find((c) => c.url.endsWith('/rest/v1/rpc/delete_my_account'));
  assert.equal(call.init.headers.authorization, 'Bearer ACCESS1');
  assert.equal(t.vault.has('canopy-account'), false);
  assert.equal(t.profile, null);
  assert.match((await t.account.deleteAccount()).error, /Sign in again/);
});

test('a copy built with no sign-in has no account: it says so, offers nothing and calls nowhere', async () => {
  const calls = [];
  let opened = null;
  const vault = new Map([['canopy-account', JSON.stringify({ access: 'OLD', refresh: 'OLD', expires: 1 })]]); // left by an official build
  const account = new CanopyAccount({
    store: { get: (id) => vault.get(id) ?? null, set: (id, v) => { vault.set(id, v); return { ok: true }; }, delete: (id) => vault.delete(id) || true },
    load: () => ({ id: 'u-1', name: 'Alex Rivera', email: 'alex@example.com' }), save: () => {},
    openExternal: (url) => { opened = url; },
    fetchImpl: async (url) => { calls.push(String(url)); return new Response('{}'); },
    url: '', key: '',
  });
  assert.equal(account.available, false);
  assert.deepEqual({ available: account.view().available, signedIn: account.view().signedIn }, { available: false, signedIn: false });
  assert.deepEqual(await account.signIn(), { error: 'This copy of Canopy has no account to sign in to.' });
  assert.equal(opened, null, 'no browser is opened');
  assert.equal((await account.resume()).signedIn, false);
  assert.equal(await account.access(), null);
  assert.ok((await account.deleteAccount()).error);
  await account.signOut();
  assert.equal(vault.size, 0, 'signing out still forgets what an earlier build kept here');
  assert.deepEqual(calls, [], 'nothing is asked of any server');
  // The same class with a service is the account every other test here uses.
  assert.equal(setup().account.available, true);
  assert.equal(setup().account.view().available, true);
});
