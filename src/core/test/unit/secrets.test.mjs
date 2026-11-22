// secrets.mjs: the vault for pasted API keys. Electron's safeStorage is a stand-in here (a reversible scramble
// that is not the text itself), and the file is in a throwaway folder: no Keychain, no real key, no app data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Secrets } from '../../../secrets.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-unit-secrets-'));
after(() => { try { fs.chmodSync(path.join(root, 'ro'), 0o700); } catch { /* not made */ } fs.rmSync(root, { recursive: true, force: true }); });
let seq = 0;
const KEY = 'sk-ant-api03-THIS-IS-NOT-A-REAL-KEY-0123456789abcdef-4f2a';
const OTHER = 'sk-ant-api03-ANOTHER-MADE-UP-KEY-zyxwvutsrqponmlkjih-9z9z';

// Shaped like Electron's safeStorage. What it hands back is not the text (each byte is flipped, behind a marker),
// and it counts how often it is used, so a test can tell that the Keychain was left alone.
function fakeSafe(over = {}) {
  return {
    on: true, locked: false, used: 0,
    isEncryptionAvailable() { return this.on; },
    encryptString(text) {
      this.used += 1;
      if (this.locked) throw new Error('Error while encrypting the text provided to safeStorage.encryptString.');
      return Buffer.concat([Buffer.from('v10'), Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)]);
    },
    decryptString(data) {
      this.used += 1;
      if (this.locked || data.subarray(0, 3).toString() !== 'v10') throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return Buffer.from(data.subarray(3).map((b) => b ^ 0x5a)).toString('utf8');
    },
    ...over,
  };
}
function vault(over = {}) {
  const dir = over.dir ?? path.join(root, `v${++seq}`);
  const file = path.join(dir, 'secrets.json');
  const safe = over.safe ?? fakeSafe();
  const logs = [];
  return { file, dir, safe, logs, secrets: new Secrets({ file: over.asGetter ? () => file : file, safe, log: (m) => logs.push(m) }) };
}
const mode = (file) => fs.statSync(file).mode & 0o777;

test('a key is kept encrypted, in a file only you can read, and read back', () => {
  const { secrets, file, logs } = vault();
  assert.deepEqual(secrets.read('claude-key-1'), { ok: false, code: 'none' });
  assert.equal(secrets.get('claude-key-1'), null);
  assert.equal(fs.existsSync(file), false, 'nothing is written until there is something to keep');

  assert.deepEqual(secrets.set('claude-key-1', KEY), { ok: true });
  assert.equal(secrets.has('claude-key-1'), true);
  assert.deepEqual(secrets.read('claude-key-1'), { ok: true, secret: KEY });
  assert.equal(secrets.get('claude-key-1'), KEY);

  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(mode(file), 0o600);
  assert.ok(!raw.includes(KEY) && !raw.includes('sk-ant'), 'the file holds ciphertext, never the key');
  const saved = JSON.parse(raw);
  assert.deepEqual(Object.keys(saved).sort(), ['keys', 'v']);
  assert.deepEqual(Object.keys(saved.keys), ['claude-key-1']);
  assert.ok(!Buffer.from(saved.keys['claude-key-1'], 'base64').includes(Buffer.from(KEY)), 'nor is it the key in another spelling');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['secrets.json'], 'no temporary file is left behind');
  assert.deepEqual(logs, []);
});

test('what was kept is there after a restart, and replacing a key leaves the others alone', () => {
  const first = vault({ asGetter: true });
  first.secrets.set('a', KEY);
  first.secrets.set('b', OTHER);
  const again = new Secrets({ file: first.file, safe: fakeSafe() });
  assert.equal(again.get('a'), KEY);
  assert.equal(again.get('b'), OTHER);
  assert.deepEqual(again.set('a', OTHER), { ok: true });
  const third = new Secrets({ file: first.file, safe: fakeSafe() });
  assert.deepEqual([third.get('a'), third.get('b')], [OTHER, OTHER]);
});

test('with no key kept, the Keychain is never asked for anything', () => {
  const { secrets, safe } = vault();
  assert.equal(secrets.has('claude-key-1'), false);
  assert.equal(secrets.get('claude-key-1'), null);
  assert.equal(secrets.delete('claude-key-1'), true);
  assert.equal(secrets.keep([]), 0);
  assert.equal(safe.used, 0);
});

test('a key is not kept when it could not be kept safely', () => {
  const cases = {
    'the Keychain cannot be used': fakeSafe({ on: false }),
    'the Keychain refuses': fakeSafe({ locked: true }),
    'the only "encryption" is a fixed password': fakeSafe({ getSelectedStorageBackend: () => 'basic_text' }),
    'what comes back is the text itself': fakeSafe({ encryptString: (text) => Buffer.from(`v10${text}`), decryptString: (data) => data.subarray(3).toString() }),
    'what comes back does not read back': fakeSafe({ decryptString: () => 'something else' }),
    'what comes back is nothing': fakeSafe({ encryptString: () => Buffer.alloc(0) }),
    'the check itself fails': fakeSafe({ isEncryptionAvailable() { throw new Error('safeStorage cannot be used before app is ready'); } }),
  };
  for (const [why, safe] of Object.entries(cases)) {
    const { secrets, file } = vault({ safe });
    assert.deepEqual(secrets.set('k', KEY), { ok: false, code: 'unavailable' }, why);
    assert.equal(secrets.has('k'), false, why);
    assert.equal(fs.existsSync(file), false, `${why}: nothing reaches the disk`);
  }
  assert.deepEqual(new Secrets({ file: path.join(root, 'none', 'secrets.json') }).set('k', KEY), { ok: false, code: 'unavailable' }, 'no safeStorage at all');
  assert.equal(vault({ safe: fakeSafe({ getSelectedStorageBackend: () => 'keychain' }) }).secrets.set('k', KEY).ok, true);
});

test('a key that cannot be read right now is "locked", not gone, and comes back with the Keychain', () => {
  const { secrets, safe, file } = vault();
  secrets.set('k', KEY);
  const before = fs.readFileSync(file, 'utf8');
  safe.locked = true;
  assert.deepEqual(secrets.read('k'), { ok: false, code: 'locked' });
  assert.equal(secrets.get('k'), null);
  assert.equal(secrets.has('k'), true);
  safe.locked = false; safe.on = false;
  assert.deepEqual(secrets.read('k'), { ok: false, code: 'locked' });
  safe.on = true;
  assert.equal(secrets.get('k'), KEY);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'reading never rewrites the file');
  // Written on another Mac (or by something else): it cannot be opened here, and that is all that is said.
  fs.writeFileSync(file, JSON.stringify({ v: 1, keys: { k: Buffer.from('not ours').toString('base64') } }));
  assert.deepEqual(new Secrets({ file, safe: fakeSafe() }).read('k'), { ok: false, code: 'locked' });
});

test('only a real id and a real secret are taken', () => {
  const { secrets, file } = vault();
  for (const id of ['', '../escape', 'a/b', 'a b', '__proto__', 'x'.repeat(81), null, 7, {}]) {
    assert.deepEqual(secrets.set(id, KEY), { ok: false, code: 'invalid' }, String(id));
    assert.equal(secrets.has(id), false);
    assert.equal(secrets.get(id), null);
  }
  for (const secret of ['', null, undefined, 7, { key: KEY }, 'x'.repeat(4097)]) assert.deepEqual(secrets.set('k', secret), { ok: false, code: 'invalid' });
  assert.equal(fs.existsSync(file), false);
});

test('forgetting a key takes it off the disk, and `keep` forgets the keys of accounts that are gone', () => {
  const { secrets, file } = vault();
  for (const id of ['a', 'b', 'c', 'd']) secrets.set(id, `${KEY}-${id}`);
  assert.equal(secrets.delete('b'), true);
  assert.equal(secrets.has('b'), false);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).keys), ['a', 'c', 'd']);
  assert.equal(secrets.keep(['a', 'd', 'never-kept']), 1);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).keys), ['a', 'd']);
  assert.equal(secrets.keep(['a', 'd']), 0);
  assert.equal(secrets.keep('junk'), 2, 'nothing listed: nothing kept');
  assert.equal(new Secrets({ file, safe: fakeSafe() }).has('a'), false);
  assert.equal(mode(file), 0o600);
});

test('a file that cannot be understood starts empty, and junk in a good one is skipped', () => {
  const broken = vault();
  fs.mkdirSync(broken.dir, { recursive: true });
  fs.writeFileSync(broken.file, '{ this is not json');
  assert.equal(broken.secrets.has('k'), false);
  assert.equal(broken.logs.length, 1);
  assert.deepEqual(broken.secrets.set('k', KEY), { ok: true });
  assert.equal(new Secrets({ file: broken.file, safe: fakeSafe() }).get('k'), KEY);

  const mixed = vault();
  fs.mkdirSync(mixed.dir, { recursive: true });
  const good = fakeSafe().encryptString(KEY).toString('base64');
  fs.writeFileSync(mixed.file, JSON.stringify({ v: 1, keys: { good, '../bad': good, empty: '', number: 7, nested: { a: 1 } }, extra: 'ignored' }));
  assert.equal(mixed.secrets.get('good'), KEY);
  for (const id of ['../bad', 'empty', 'number', 'nested']) assert.equal(mixed.secrets.has(id), false);
  for (const junk of ['[]', '"text"', 'null', '{"keys":[]}', '{"keys":"x"}']) {
    const v = vault();
    fs.mkdirSync(v.dir, { recursive: true });
    fs.writeFileSync(v.file, junk);
    assert.equal(v.secrets.has('k'), false, junk);
  }
});

test('a file that was readable by others, or a planted temporary file, ends as a private file of its own', () => {
  const { secrets, file, dir } = vault();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, keys: {} }), { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  // Something left a link where the temporary file goes: it is replaced, never written through.
  const canary = path.join(dir, 'canary.txt');
  fs.writeFileSync(canary, 'untouched');
  fs.symlinkSync(canary, `${file}.tmp`);
  assert.deepEqual(secrets.set('k', KEY), { ok: true });
  assert.equal(mode(file), 0o600);
  assert.equal(fs.lstatSync(file).isFile(), true);
  assert.equal(fs.readFileSync(canary, 'utf8'), 'untouched');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('when the disk refuses, nothing changes: what is in memory stays what is on disk', { skip: process.getuid?.() === 0 && 'root can write anywhere' }, () => {
  // The data folder cannot be made: a file is in its place.
  const blocked = path.join(root, `blocked-${++seq}`);
  fs.writeFileSync(blocked, 'a file, not a folder');
  const a = vault({ dir: path.join(blocked, 'data') });
  assert.deepEqual(a.secrets.set('k', KEY), { ok: false, code: 'write-failed' });
  assert.equal(a.secrets.has('k'), false);
  assert.equal(a.logs.length, 1);

  // The folder turns read-only after a key was kept: the key cannot be replaced, forgotten or pruned, and stays as it was.
  const b = vault({ dir: path.join(root, 'ro') });
  assert.deepEqual(b.secrets.set('k', KEY), { ok: true });
  fs.chmodSync(b.dir, 0o500);
  assert.deepEqual(b.secrets.set('k', OTHER), { ok: false, code: 'write-failed' });
  assert.equal(b.secrets.get('k'), KEY);
  assert.deepEqual(b.secrets.set('new', OTHER), { ok: false, code: 'write-failed' });
  assert.equal(b.secrets.has('new'), false);
  assert.equal(b.secrets.delete('k'), false);
  assert.equal(b.secrets.keep([]), 0);
  assert.equal(b.secrets.get('k'), KEY);
  fs.chmodSync(b.dir, 0o700);
  assert.equal(new Secrets({ file: b.file, safe: fakeSafe() }).get('k'), KEY);
  assert.equal(b.secrets.delete('k'), true);

  for (const line of [...a.logs, ...b.logs]) assert.ok(!line.includes('sk-ant') && !line.includes(KEY), 'the log never carries a key');
});
