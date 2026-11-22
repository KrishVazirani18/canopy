// What telemetry keeps on disk goes through here. Two kinds of file:
//   - a JSON file, replaced whole: written to a temp file and renamed, so a crash leaves the old file, never half of one
//   - a file of JSON lines that grows by appending, and is rewritten whole (the same safe way) when lines must go
// Writes to one file happen one at a time, in the order they were asked for. Nothing here throws or rejects: a write
// that fails is reported and the next one tries again.
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A reporter that says each kind of trouble once per launch: a full disk or a dead network would otherwise fill the
 * log with the same line.
 * @param {(msg: string) => void} [log]
 * @returns {(kind: string, err?: unknown) => void}
 */
export function once(log) {
  const said = new Set();
  return (kind, err) => {
    if (said.has(kind)) return;
    said.add(kind);
    try { log?.(err === undefined ? kind : `${kind}: ${err?.message ?? err}`); } catch { /* a log that fails says nothing */ }
  };
}

/** Replace a file in one step: readers see the old text or the new, never a mix. */
async function replaceFile(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}

/**
 * What a JSON file holds. `status` tells a first run ('missing') from a file that is there but can't be used
 * ('corrupt': not JSON; 'unreadable': the disk said no), because the two call for different answers.
 * @returns {Promise<{status: 'ok'|'missing'|'corrupt'|'unreadable', value: unknown}>}
 */
export async function readJson(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (err) { return { status: err?.code === 'ENOENT' ? 'missing' : 'unreadable', value: null }; }
  try { return { status: 'ok', value: JSON.parse(raw) }; }
  catch { return { status: 'corrupt', value: null }; }
}

/**
 * A JSON file that is saved whole. `write(value)` reads `value` when its turn comes, so several saves in a row
 * write the newest state once.
 * @param {string} file
 * @param {(kind: string, err?: unknown) => void} [warn]
 */
export function jsonFile(file, warn = () => {}) {
  let next;
  let scheduled = false;
  let writes = Promise.resolve();
  return {
    read: () => readJson(file),
    /** @returns {Promise<boolean>} whether this state reached the disk */
    write(value) {
      next = value;
      if (scheduled) return writes;
      scheduled = true;
      writes = writes.then(async () => {
        scheduled = false;
        try { await replaceFile(file, JSON.stringify(next)); return true; }
        catch (err) { warn(`could not save ${path.basename(file)}`, err); return false; }
      });
      return writes;
    },
    /** Resolves once every save asked for so far has been tried. */
    settled: () => writes,
  };
}

// How many lines to parse before letting the main process do something else (a full queue is ten thousand lines).
const PARSE_SLICE = 2000;
const breathe = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A file of JSON lines. The owner keeps the truth in memory and passes `lines()`, which says what the file should
 * hold right now: `append` adds a line the owner already holds, `rewrite` replaces the file with `lines()`.
 * After a write fails, the next one is a rewrite, so the file catches up with memory instead of staying wrong.
 * @param {string} file
 * @param {{ lines: () => string[], warn?: (kind: string, err?: unknown) => void }} opts
 */
export function lineFile(file, { lines, warn = () => {} }) {
  let pending = [];     // appended lines that are not on disk yet
  let stale = false;    // the file no longer matches memory: the next write replaces it
  let scheduled = false;
  let writes = Promise.resolve();

  const write = async () => {
    scheduled = false;
    try {
      if (stale) {
        stale = false;
        pending = [];
        const all = lines();
        if (all.length) await replaceFile(file, `${all.join('\n')}\n`);
        else await rm(file, { force: true });
      } else if (pending.length) {
        const batch = pending;
        pending = [];
        await appendFile(file, `${batch.join('\n')}\n`);
      }
    } catch (err) {
      stale = true; // not retried here (a full disk would spin): the next append or rewrite tries again
      warn(`could not write ${path.basename(file)}`, err);
    }
  };
  const schedule = () => {
    if (!scheduled) { scheduled = true; writes = writes.then(write); }
    return writes;
  };

  return {
    /**
     * Every line that parses, in order. `damaged`: a line didn't parse or the last one was cut short (a crash
     * mid-write), so the owner should rewrite the file before appending to it.
     * @returns {Promise<{rows: unknown[], damaged: boolean}>}
     */
    async read() {
      let raw;
      try { raw = await readFile(file, 'utf8'); }
      catch (err) {
        if (err?.code !== 'ENOENT') warn(`could not read ${path.basename(file)}`, err);
        return { rows: [], damaged: false };
      }
      const rows = [];
      let damaged = raw.length > 0 && !raw.endsWith('\n');
      let n = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { damaged = true; }
        if (++n % PARSE_SLICE === 0) await breathe();
      }
      return { rows, damaged };
    },
    append(line) {
      if (!stale) pending.push(line);
      return schedule();
    },
    rewrite() {
      stale = true;
      return schedule();
    },
    settled: () => writes,
  };
}

/**
 * The newest `max` rows of a JSON-lines file, in memory and on disk. Rows are appended as they come; the file is
 * trimmed back to `max` once it has grown a fifth past it, so trimming is rare. `check` decides what a row read back
 * from disk may be (the row to keep, or null to drop it).
 * @param {string} file
 * @param {{ max: number, check?: (row: unknown) => unknown, warn?: (kind: string, err?: unknown) => void }} opts
 */
export function ringFile(file, { max, check = (row) => row, warn = () => {} }) {
  let rows = [];     // oldest first
  let onDisk = 0;    // lines in the file
  const spare = Math.max(50, Math.ceil(max / 5));
  const disk = lineFile(file, { lines: () => rows.map((r) => JSON.stringify(r)), warn });
  const trim = () => { disk.rewrite(); onDisk = rows.length; };

  return {
    /** Read what an earlier run left. Rows pushed while this was reading stay, after the older ones. */
    async load() {
      const { rows: read, damaged } = await disk.read();
      const old = [];
      for (const row of read) { const kept = check(row); if (kept != null) old.push(kept); }
      onDisk += read.length;
      rows = [...old, ...rows].slice(-max);
      if (damaged || old.length !== read.length || onDisk > max + spare) trim();
    },
    push(row) {
      rows.push(row);
      if (rows.length > max) rows.shift();
      onDisk++;
      if (onDisk > max + spare) trim();
      else disk.append(JSON.stringify(row));
    },
    /** The rows, oldest first. The caller must not change them. */
    rows: () => rows,
    settled: () => disk.settled(),
  };
}
