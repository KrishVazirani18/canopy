// The Code Mode runner: the program inside the sandbox that runs the script Claude wrote.
//
// Canopy never imports this file to run it (only the tests import its pure helpers). code-mode.mjs hands this
// file's text to a locked-down Node child with `-e`: no files, no network, no processes. The script's only way
// out is a message to the host asking for a helper, and the host decides every one of them.
//
//   host -> runner   { t: 'run', code }             { t: 'reply', id, value | error }
//   runner -> host   { t: 'ready' }                 { t: 'call', id, op, args, quiet }    op: mcp | read | files
//                    { t: 'step', id, op, label }   { t: 'step', id, ok, note | error }   one row in the UI (glob, grep)
//                    { t: 'log', text }             { t: 'done', ok, out, length | error, line }
//
// Nothing the script does is trusted by the host: the sandbox is the boundary, this file is only good manners.
import vm from 'node:vm';

export const SCRIPT_FILE = 'script.js';
// What a script can name. `process` and `require` are passed as undefined so a script fails plainly instead of half-working.
export const HELPERS = ['mcp', 'read', 'glob', 'grep', 'sleep', 'print', 'console', 'process', 'require'];

const MAX_RETURN = 400_000;  // characters of result sent to the host, which cuts further for the model
const MAX_LOG = 200_000;
const MAX_LOG_LINE = 4000;
export const GREP_FILES = 2000;
const GREP_LINE = 300;
const GREP_PARALLEL = 8;
const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|icns|pdf|zip|gz|tgz|bz2|xz|7z|tar|jar|wasm|node|dylib|so|dll|exe|bin|woff2?|ttf|otf|eot|mp[34]|mov|avi|mkv|webm|wav|ogg|flac|psd|sqlite|db)$/i;

const plain = (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : typeof v === 'bigint' ? String(v)
  : v instanceof Error ? { error: `${v.name}: ${v.message}` } : v);
const toJson = (v) => { try { return JSON.stringify(v, plain); } catch { return undefined; } };
const count = (n) => Number(n).toLocaleString('en-US');
const show = (v) => (typeof v === 'string' ? v : v instanceof Error ? `${v.name}: ${v.message}` : toJson(v) ?? String(v));

// A glob such as src/**/*.ts as a RegExp over forward-slash relative paths. Understands ** * ? [abc] [!abc] {a,b}.
export function globToRegExp(glob) {
  const g = String(glob).replace(/^\.\//, '');
  let re = '';
  let braces = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      // '**/' spans any number of folders, including none; a bare '**' spans anything.
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[' && g.indexOf(']', i + 2) > 0) {
      const end = g.indexOf(']', i + 2);
      const body = g.slice(i + 1, end).replace(/\\/g, '\\\\');
      re += `[${body[0] === '!' ? `^${body.slice(1)}` : body}]`;
      i = end;
    } else if (c === '{') { braces += 1; re += '(?:'; }
    else if (c === '}' && braces) { braces -= 1; re += ')'; }
    else if (c === ',' && braces) re += '|';
    else re += c.replace(/[.+^$()|\\{}[\]]/, '\\$&');
  }
  return new RegExp(`^${re}${')'.repeat(braces)}$`);
}

/** The script line an error came from: its first frame in the script (a SyntaxError names the line up front). */
export function locate(err) {
  const m = String(err?.stack ?? '').match(/script\.js:(\d+)/);
  return m ? Number(m[1]) : null;
}

export const explain = (err) => (err instanceof Error ? `${err.name}: ${err.message}` : `Thrown: ${show(err)}`);

/** What the script returned, as text for the host: a string as it is, anything else as JSON. */
export function pack(value) {
  if (value === undefined) return { out: null, length: 0 };
  const s = typeof value === 'string' ? value : toJson(value) ?? String(value);
  return { out: s.length > MAX_RETURN ? s.slice(0, MAX_RETURN) : s, length: s.length };
}

function main() {
  const waiting = new Map();
  let seq = 0;
  let finished = false;
  const send = (m) => { try { process.send(m); } catch { process.exit(0); } };
  process.on('disconnect', () => process.exit(0)); // Canopy is gone: so is this

  const finish = (m) => { if (!finished) { finished = true; send({ t: 'done', ...m }); } };
  const fail = (err, hint = '') => finish({ ok: false, error: explain(err) + hint, line: locate(err) });
  process.on('uncaughtException', (err) => fail(err));
  process.on('unhandledRejection', (err) => fail(err, ' (a call failed with nothing awaiting it: await every call, or use Promise.all)'));

  // One request to the host. A failure arrives later, from the message handler, so the place the script called
  // from is captured now: the error then points at the script's own line.
  const call = (op, args, quiet = false) => {
    const site = new Error('call');
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, {
        resolve,
        reject: (message) => {
          const err = new Error(message);
          err.stack = `Error: ${message}\n${String(site.stack).split('\n').slice(1).join('\n')}`;
          reject(err);
        },
      });
      try { process.send({ t: 'call', id, op, args, quiet }); }
      catch (err) { waiting.delete(id); reject(new Error(`This call's arguments cannot be sent: ${err?.message ?? err}`)); }
    });
  };

  // One row in the UI for a helper that is built from several requests.
  const step = async (op, label, count, fn) => {
    const id = ++seq;
    send({ t: 'step', id, op, label: String(label).slice(0, 300) });
    try {
      const value = await fn();
      send({ t: 'step', id, ok: true, note: count(value) });
      return value;
    } catch (err) {
      send({ t: 'step', id, ok: false, error: String(err?.message ?? err).slice(0, 300) });
      throw err;
    }
  };
  const many = (n, one) => `${n} ${n === 1 ? one : `${one}${one.endsWith('h') ? 'es' : 's'}`}`;

  // Every file under a folder. A tree too big to list in full is an error, never a quiet half: the script would
  // take "no match" for an answer when the match is in the part that was not looked at.
  const list = async (dir) => {
    const r = await call('files', { path: dir == null ? '.' : String(dir) }, true);
    if (r.truncated) throw new Error(`There are more than ${count(r.files.length)} files under ${dir == null ? 'the project folder' : dir}, too many to go through. Pass { path } to look in a smaller folder.`);
    return r.files.map((rel) => ({ rel, path: r.base ? `${r.base}/${rel}` : rel }));
  };
  // A pattern with no folder in it matches at any depth, like `rg --glob`.
  const matcher = (pattern) => { const p = String(pattern); return globToRegExp(p.includes('/') ? p : `**/${p}`); };

  const mcp = (tool, args) => call('mcp', { tool, args: args ?? {} });
  const read = async (file) => (await call('read', { path: String(file) })).text;
  const glob = (pattern, opts = {}) => step('glob', pattern, (v) => many(v.length, 'file'), async () => {
    const re = matcher(pattern);
    return (await list(opts?.path)).filter((f) => re.test(f.rel)).map((f) => f.path);
  });
  const grep = (pattern, opts = {}) => step('grep', pattern instanceof RegExp ? pattern.source : pattern, (v) => many(v.length, 'match'), async () => {
    const re = pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')) : new RegExp(String(pattern), opts?.ignoreCase ? 'i' : '');
    const limit = Math.min(1000, Math.max(1, Number(opts?.limit) || 200));
    const only = opts?.glob ? matcher(opts.glob) : null;
    const files = (await list(opts?.path)).filter((f) => !BINARY.test(f.rel) && (!only || only.test(f.rel)));
    if (files.length > GREP_FILES) throw new Error(`grep() would have to read ${count(files.length)} files, and reads at most ${count(GREP_FILES)}. Narrow it with { path } or { glob }.`);
    const found = new Array(files.length);
    let next = 0;
    let total = 0;
    const worker = async () => {
      while (next < files.length && total < limit) {
        const i = next++;
        let r;
        try { r = await call('read', { path: files[i].path }, true); } catch { continue; } // unreadable or not allowed: skipped
        if (r.lossy) continue; // not text
        const hits = [];
        const lines = r.text.split('\n');
        for (let n = 0; n < lines.length && hits.length < limit; n++) {
          if (re.test(lines[n])) hits.push({ file: files[i].path, line: n + 1, text: lines[n].trim().slice(0, GREP_LINE) });
        }
        found[i] = hits;
        total += hits.length;
      }
    };
    await Promise.all(Array.from({ length: GREP_PARALLEL }, worker));
    return found.flat().filter(Boolean).slice(0, limit);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

  let logged = 0;
  const print = (...parts) => {
    if (logged > MAX_LOG) return;
    const text = parts.map(show).join(' ');
    logged += text.length + 1;
    send({ t: 'log', text: logged > MAX_LOG ? '… more output not shown' : text.length > MAX_LOG_LINE ? `${text.slice(0, MAX_LOG_LINE)}…` : text });
  };
  const console = { log: print, info: print, warn: print, error: print, debug: print };
  const given = { mcp, read, glob, grep, sleep, print, console, process: undefined, require: undefined };

  const run = async (code) => {
    try {
      // lineOffset: the wrapper's first line is not the script's, so errors report the script's own line numbers.
      const fn = new vm.Script(`(async function (${HELPERS.join(', ')}) {\n${code}\n})`, { filename: SCRIPT_FILE, lineOffset: -1 }).runInThisContext();
      finish({ ok: true, ...pack(await fn(...HELPERS.map((name) => given[name]))) });
    } catch (err) { fail(err); }
  };

  process.on('message', (m) => {
    if (m?.t === 'run') { run(String(m.code ?? '')); return; }
    if (m?.t !== 'reply') return;
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error != null) w.reject(String(m.error)); else w.resolve(m.value);
  });
  send({ t: 'ready' });
}

if (process.env.CANOPY_CODE_RUNNER === '1' && typeof process.send === 'function') main();
