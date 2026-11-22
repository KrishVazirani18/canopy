// Images attached to unsent drafts, per chat (same keys as the text drafts), saved across restarts.
// IndexedDB, not localStorage: a few screenshots are already past localStorage's ~5MB.
// Two stores: `images` holds the attachments, `meta` holds their size and age so eviction never has to read
// megabytes of base64 just to decide what to drop. Oldest drafts go first past MAX_DRAFTS or MAX_BYTES.
import type { ImageAttachment } from './api';

const DB = 'canopy.draft-attachments';
const IMAGES = 'images';
const META = 'meta';
const MAX_DRAFTS = 40;
const MAX_BYTES = 150 * 1024 * 1024;
// Drafts are temporary: attachments nobody has touched for a day are cleared (checked at startup and on every save).
const MAX_AGE = 24 * 60 * 60 * 1000; // a day

type Meta = { key: string; size: number; at: number };

let db: Promise<IDBDatabase> | null = null;
function open() {
  return db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IMAGES);
      req.result.createObjectStore(META, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { db = null; reject(req.error); };
  });
}

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error);
});
const result = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** The images saved for a draft ([] when none, or if storage is unavailable). */
async function get(key: string): Promise<ImageAttachment[]> {
  try {
    const tx = (await open()).transaction(IMAGES, 'readonly');
    const v = await result(tx.objectStore(IMAGES).get(key) as IDBRequest<ImageAttachment[] | undefined>);
    // Plain copies: callers hang previews off the object identity, and these must not be shared between loads.
    return Array.isArray(v) ? v.map((im) => ({ ...im })) : [];
  } catch { return []; }
}

/** Saves a draft's images (an empty list deletes it), then evicts the oldest drafts past the caps. */
async function set(key: string, images: ImageAttachment[]): Promise<void> {
  if (!images.length) return del(key);
  try {
    const tx = (await open()).transaction([IMAGES, META], 'readwrite');
    const imgs = tx.objectStore(IMAGES), meta = tx.objectStore(META);
    const plain = images.map(({ mediaType, data, name }) => (name ? { mediaType, data, name } : { mediaType, data }));
    imgs.put(plain, key);
    meta.put({ key, size: plain.reduce((n, im) => n + im.data.length, 0), at: Date.now() } satisfies Meta);
    const all = (await result(meta.getAll() as IDBRequest<Meta[]>)).sort((a, b) => b.at - a.at);
    let bytes = 0;
    all.forEach((m, i) => {
      bytes += m.size;
      if (m.key !== key && (i >= MAX_DRAFTS || bytes > MAX_BYTES || Date.now() - m.at > MAX_AGE)) { imgs.delete(m.key); meta.delete(m.key); bytes -= m.size; }
    });
    await done(tx);
  } catch { /* quota or storage unavailable: the draft just won't survive a restart */ }
}

async function del(key: string): Promise<void> {
  try {
    const tx = (await open()).transaction([IMAGES, META], 'readwrite');
    tx.objectStore(IMAGES).delete(key);
    tx.objectStore(META).delete(key);
    await done(tx);
  } catch { /* nothing to do */ }
}

/** Clear attachments older than a day. Runs once when Canopy opens, so a draft you abandoned doesn't linger. */
async function sweep(): Promise<void> {
  try {
    const tx = (await open()).transaction([IMAGES, META], 'readwrite');
    const imgs = tx.objectStore(IMAGES), meta = tx.objectStore(META);
    for (const m of await result(meta.getAll() as IDBRequest<Meta[]>)) {
      if (Date.now() - m.at > MAX_AGE) { imgs.delete(m.key); meta.delete(m.key); }
    }
    await done(tx);
  } catch { /* nothing to do */ }
}
setTimeout(sweep, 5000);

export const draftAttachments = { get, set, delete: del };
