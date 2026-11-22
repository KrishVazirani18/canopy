// Secrets: the API keys you paste into Canopy, kept encrypted on this Mac.
//
// A key is encrypted by Electron's safeStorage, whose own key lives in the macOS Keychain ("Canopy Safe Storage"),
// and only the ciphertext is written down: <userData>/secrets.json, readable by you alone (mode 0600). Nothing in
// here is a login of Claude Code's or Codex's: only keys typed into Canopy. A key leaves this file one way, `get`,
// for the launch environment of a chat (accounts.mjs `keyFor`) or a check with the maker's API. It is never
// logged, never sent to the window and never written anywhere else.
//
//   Secrets    the vault: available / has / get / set / delete / keep, by account id
//
// `safe` is injected (main.mjs passes Electron's safeStorage, tests pass a stand-in), so this file imports no
// Electron and runs under plain node. The Keychain is only touched for an account that has a key: with no key
// pasted, nothing here asks macOS for anything.
//
// Contract: nothing here throws. A failure is `null`, `false` or a coded answer, and the log never carries a secret.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_SECRET = 4096;   // far above any API key: a paste of something else entirely is not kept
const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isId = (id) => typeof id === 'string' && /^[\w.-]{1,80}$/.test(id) && id !== '__proto__';

export class Secrets {
  /**
   * @param {{
   *   file: string | (() => string),     where the ciphertext is kept (secrets.json in the app's data folder)
   *   safe: {                            Electron's safeStorage, or anything shaped like it
   *     isEncryptionAvailable(): boolean,
   *     encryptString(text: string): Buffer, decryptString(data: Buffer): string,
   *     getSelectedStorageBackend?(): string,
   *   },
   *   log?: (msg: string) => void,
   * }} deps
   */
  constructor({ file, safe, log } = {}) {
    this.fileOf = typeof file === 'function' ? file : () => file;
    this.safe = safe ?? null;
    this.logFn = typeof log === 'function' ? log : () => {};
    this.items = null;   // id -> base64 ciphertext, read from the file on first use
  }

  log(msg) { try { this.logFn(msg); } catch { /* logging never breaks a call */ } }

  /**
   * Can a key be kept right now? False when the Keychain cannot be used, and on a system whose only "encryption"
   * is a fixed password (Linux without a keyring): a key is never written where anyone could read it back.
   */
  available() {
    try {
      if (!this.safe || this.safe.isEncryptionAvailable() !== true) return false;
      return this.safe.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  }

  /** Is anything kept under this id? (Says nothing about whether it can be read right now.) */
  has(id) { return isId(id) && typeof this.#all()[id] === 'string'; }

  /**
   * The secret kept under an id.
   * @returns {{ok: true, secret: string} | {ok: false, code: 'none' | 'locked'}}
   *   `none`: nothing is kept under it. `locked`: something is, but it cannot be read now (the Keychain is locked
   *   or refused, or the file was written on another Mac).
   */
  read(id) {
    if (!this.has(id)) return { ok: false, code: 'none' };
    try {
      if (!this.available()) return { ok: false, code: 'locked' };
      const secret = this.safe.decryptString(Buffer.from(this.#all()[id], 'base64'));
      return typeof secret === 'string' && secret ? { ok: true, secret } : { ok: false, code: 'locked' };
    } catch { return { ok: false, code: 'locked' }; } // the error is not logged: it is not ours to word, and says nothing useful
  }

  /** The secret, or null when there is none or it cannot be read now. */
  get(id) { const r = this.read(id); return r.ok ? r.secret : null; }

  /**
   * Keep a secret under an id (replacing what was there). It is on disk, encrypted, before this returns.
   * @returns {{ok: true} | {ok: false, code: 'invalid' | 'unavailable' | 'write-failed'}}
   */
  set(id, secret) {
    if (!isId(id) || typeof secret !== 'string' || !secret || secret.length > MAX_SECRET) return { ok: false, code: 'invalid' };
    if (!this.available()) return { ok: false, code: 'unavailable' };
    let sealed;
    try {
      const data = this.safe.encryptString(secret);
      // What is written must be ciphertext that reads back: a backend that hands the text back as it came, or
      // loses it, is refused before anything reaches the disk.
      if (!Buffer.isBuffer(data) || !data.length || data.includes(Buffer.from(secret, 'utf8')) || this.safe.decryptString(data) !== secret) return { ok: false, code: 'unavailable' };
      sealed = data.toString('base64');
    } catch { return { ok: false, code: 'unavailable' }; }
    const items = this.#all();
    const had = Object.hasOwn(items, id) ? items[id] : undefined;
    items[id] = sealed;
    if (this.#write()) return { ok: true };
    if (had === undefined) delete items[id]; else items[id] = had; // what is in memory is what is on disk
    return { ok: false, code: 'write-failed' };
  }

  /** Forget what is kept under an id. Returns whether it is gone from the disk (true too when nothing was kept). */
  delete(id) {
    if (!this.has(id)) return true;
    const items = this.#all();
    const had = items[id];
    delete items[id];
    if (this.#write()) return true;
    items[id] = had;
    return false;
  }

  /** Forget everything kept under an id that is not in `ids` (keys of accounts that are gone). Returns how many. */
  keep(ids) {
    const wanted = new Set(Array.isArray(ids) ? ids : []);
    const items = this.#all();
    const gone = Object.keys(items).filter((id) => !wanted.has(id));
    if (!gone.length) return 0;
    const had = gone.map((id) => [id, items[id]]);
    for (const id of gone) delete items[id];
    if (this.#write()) return gone.length;
    for (const [id, v] of had) items[id] = v;
    return 0;
  }

  // ---- the file ----

  // The ciphertexts, read once. A file that is missing or cannot be understood starts empty: its keys cannot be
  // read back either way, and the accounts that used them say so (see `read`).
  #all() {
    if (this.items) return this.items;
    const items = Object.create(null);
    let raw = null;
    try { raw = readFileSync(this.fileOf(), 'utf8'); } catch { /* no key has been kept yet */ }
    if (raw !== null) {
      try {
        const saved = JSON.parse(raw);
        for (const [id, v] of Object.entries(isPlain(saved?.keys) ? saved.keys : {})) if (isId(id) && typeof v === 'string' && v) items[id] = v;
      } catch { this.log('secrets.json could not be read; keys kept in it have to be pasted again'); }
    }
    this.items = items;
    return items;
  }

  // Written whole, through a file of its own that only you can read, then renamed: a crash mid-write leaves the
  // previous file, never half of one, and the file is never readable by anyone else even for a moment.
  #write() {
    let tmp = null;
    try {
      const file = this.fileOf();
      mkdirSync(path.dirname(file), { recursive: true });
      tmp = `${file}.tmp`;
      rmSync(tmp, { force: true });
      writeFileSync(tmp, JSON.stringify({ v: 1, keys: { ...this.items } }, null, 2), { mode: 0o600, flag: 'wx' });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
      return true;
    } catch (err) {
      this.log(`secrets.json could not be written (${err?.code ?? 'error'})`);
      try { if (tmp) rmSync(tmp, { force: true }); } catch { /* nothing to clean up */ }
      return false;
    }
  }
}
