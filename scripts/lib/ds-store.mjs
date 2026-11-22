// Writes the .DS_Store that makes Finder open a disk image as designed: a window of a set size with no toolbar or
// sidebar, large icons at set places, and a picture behind them. Finder keeps a folder's look in that file; this
// writes one directly, so making a disk image needs no Finder, no screen and no permission to script anything.
//
// Three small formats, written here in full so the build depends on nothing outside macOS itself:
//   .DS_Store   a "buddy allocator" file holding one B-tree of records: (file name, 4-letter key, type, value)
//   alias       how Finder remembers which file the background picture is (classic Alias Manager record, version 2)
//   plist       the window and icon view settings, as binary property lists (made with macOS's own plutil)
// The layouts follow the format notes in the Python ds_store and mac_alias packages (MIT), which Finder reads back.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ascii = (s) => Buffer.from(s, 'latin1');
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; };
const utf16be = (s) => Buffer.from(s, 'utf16le').swap16();

// ---------- plist ----------

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plistValue(v) {
  if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
  if (typeof v === 'string') return `<string>${xml(v)}</string>`;
  if (Buffer.isBuffer(v)) return `<data>${v.toString('base64')}</data>`;
  if (Number.isInteger(v)) return `<integer>${v}</integer>`;
  if (typeof v === 'number') return `<real>${v}</real>`;
  if (v && typeof v === 'object' && 'real' in v) return `<real>${Number(v.real)}</real>`;
  throw new TypeError(`cannot write ${typeof v} to a plist`);
}
/** A flat dictionary as a binary property list. { real: 128 } writes a whole number as a real, as Finder does. */
export function binaryPlist(dict) {
  const body = Object.entries(dict).map(([k, v]) => `<key>${xml(k)}</key>${plistValue(v)}`).join('');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-plist-'));
  try {
    const file = path.join(dir, 'p.plist');
    fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${body}</dict></plist>`);
    execFileSync('/usr/bin/plutil', ['-convert', 'binary1', file]);
    return fs.readFileSync(file);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------- alias ----------

const MAC_EPOCH = 2082844800; // seconds from 1904 (the Mac's old year zero) to 1970
const macSeconds = (date) => Math.max(0, Math.floor(date.getTime() / 1000) + MAC_EPOCH);
/** A length byte, the text, and zeros up to `size` bytes. */
function pascal(text, size) {
  const b = Buffer.alloc(size);
  const t = Buffer.from(text, 'utf8').subarray(0, size - 1);
  b[0] = t.length;
  t.copy(b, 1);
  return b;
}
/** One tagged field of an alias, padded to an even length. */
function tagged(tag, data) {
  return Buffer.concat([u16(tag), u16(data.length), data, Buffer.alloc(data.length & 1)]);
}

/**
 * An alias to a file on a mounted volume, as Finder stores one.
 * @param {string} file        the file, inside the mounted volume
 * @param {string} mountPoint  where the volume is mounted now
 * @param {string} volumeName  the volume's name, which is also where it will be mounted on someone's Mac (/Volumes/<name>)
 */
export function aliasFor(file, mountPoint, volumeName) {
  const stat = fs.statSync(file), folder = fs.statSync(path.dirname(file)), volume = fs.statSync(mountPoint);
  const fileName = path.basename(file), folderName = path.basename(path.dirname(file));
  const inside = `/${path.relative(mountPoint, file).split(path.sep).join('/')}`;
  const cnid = (s) => Number(BigInt(s.ino) & 0xffffffffn);
  const header = Buffer.concat([
    Buffer.alloc(4),                          // the app that made it: none
    u16(0),                                   // the record's length, filled in below
    u16(2),                                   // version 2
    u16(0),                                   // 0: a file (1 would be a folder)
    pascal(volumeName, 28),
    u32(macSeconds(volume.birthtime)),
    ascii('H+'),                              // an HFS+ volume
    u16(0),                                   // a fixed disk
    u32(cnid(folder)),
    pascal(fileName, 64),
    u32(cnid(stat)),
    u32(macSeconds(stat.birthtime)),
    Buffer.alloc(8),                          // creator and type codes: none
    u16(0xffff), u16(0xffff),                 // not relative to anything
    u32(0), Buffer.alloc(2), Buffer.alloc(10),
  ]);
  const hiRes = (date) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(macSeconds(date)) * 65536n); return b; };
  const unicode = (s) => Buffer.concat([u16(s.length), utf16be(s)]);
  const body = Buffer.concat([
    tagged(0, Buffer.from(folderName, 'utf8')),                                   // the folder it is in
    tagged(16, hiRes(volume.birthtime)), tagged(17, hiRes(stat.birthtime)),
    tagged(1, u32(cnid(folder))),                                                 // the folders on the way down, by id
    tagged(2, Buffer.from([volumeName, ...inside.split('/').filter(Boolean)].join(':'), 'utf8')), // Canopy:.background:file
    tagged(14, unicode(fileName)), tagged(15, unicode(volumeName)),
    tagged(18, Buffer.from(inside, 'utf8')),                                      // /.background/file
    tagged(19, Buffer.from(`/Volumes/${volumeName}`, 'utf8')),
    u16(0xffff), u16(0),                                                          // the end
  ]);
  const alias = Buffer.concat([header, body]);
  alias.writeUInt16BE(alias.length, 4);
  return alias;
}

// ---------- .DS_Store ----------

function record(name, key, type, value) {
  let body;
  if (type === 'blob') body = Buffer.concat([u32(value.length), value]);
  else if (type === 'long') body = u32(value);
  else if (type === 'type') body = ascii(value);
  else throw new TypeError(`unknown record type ${type}`);
  return Buffer.concat([u32(name.length), utf16be(name), ascii(key), ascii(type), body]);
}

/**
 * The file's bytes. One leaf of records, laid out in fixed places:
 *   0       00 00 00 01, then the 32-byte header at "offset 0" (every offset below counts from byte 4)
 *   32      the tree's own record (DSDB): which block is the root, how many records
 *   2048    the allocator's table: where each block is, the name "DSDB", and which blocks are free
 *   4096    the leaf: the records, sorted by file name and then by key
 * @param {{name: string, key: string, type: 'blob'|'long'|'type', value: Buffer|number|string}[]} records
 */
export function dsStore(records) {
  const sorted = [...records].sort((a, b) => {
    const x = a.name.toLowerCase(), y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const leaf = Buffer.concat([u32(0), u32(sorted.length), ...sorted.map((r) => record(r.name, r.key, r.type, r.value))]);
  if (leaf.length > 4096) throw new Error('too many records for one page');

  const file = Buffer.alloc(4 + 8192);
  const put = (offset, buf) => buf.copy(file, 4 + offset);
  file.writeUInt32BE(1, 0);
  // Header: magic, where the allocator's table is (twice) and how big, then 16 bytes Finder ignores.
  put(0, Buffer.concat([ascii('Bud1'), u32(2048), u32(2048), u32(2048), Buffer.from('0000100c000000870000200b00000000', 'hex')]));
  // DSDB: root block number 2, a tree one level high (0 levels above the leaf), record and node counts, page size.
  put(32, Buffer.concat([u32(2), u32(0), u32(sorted.length), u32(1), u32(4096)]));
  // A block's address is its offset with the size's power of two in the low five bits.
  const addresses = [2048 | 11, 32 | 5, 4096 | 12];
  const free = [];
  for (let width = 0; width < 32; width++) {
    // Free space starts as one block of each size from 32 bytes up, at the offset equal to its size; three are in use.
    const taken = width < 5 || width === 5 || width === 11 || width === 12 || width === 31;
    free.push(taken ? u32(0) : Buffer.concat([u32(1), u32(2 ** width)]));
  }
  put(2048, Buffer.concat([
    u32(addresses.length), u32(0), ...addresses.map(u32), Buffer.alloc((256 - addresses.length) * 4),
    u32(1), Buffer.from([4]), ascii('DSDB'), u32(1),
    ...free,
  ]));
  put(4096, leaf);
  return file;
}

/**
 * The .DS_Store for a disk image's window.
 * @param {object} o
 * @param {{x: number, y: number, width: number, height: number}} o.window  on screen; the height includes the title bar
 * @param {number} o.iconSize
 * @param {number} o.textSize
 * @param {Buffer} o.backgroundAlias  from aliasFor()
 * @param {{name: string, x: number, y: number}[]} o.icons  each icon's middle, measured from the window's top left
 */
export function windowStore({ window: w, iconSize, textSize, backgroundAlias, icons }) {
  const bwsp = binaryPlist({
    ContainerShowSidebar: false, PreviewPaneVisibility: false, ShowPathbar: false, ShowSidebar: false, ShowStatusBar: false,
    ShowTabView: false, ShowToolbar: false, SidebarWidth: 0, WindowBounds: `{{${w.x}, ${w.y}}, {${w.width}, ${w.height}}}`,
  });
  const icvp = binaryPlist({
    arrangeBy: 'none', backgroundType: 2, backgroundImageAlias: backgroundAlias,
    backgroundColorRed: { real: 1 }, backgroundColorGreen: { real: 1 }, backgroundColorBlue: { real: 1 },
    gridOffsetX: { real: 0 }, gridOffsetY: { real: 0 }, gridSpacing: { real: 100 },
    iconSize: { real: iconSize }, textSize: { real: textSize }, labelOnBottom: true,
    showIconPreview: false, showItemInfo: false, viewOptionsVersion: 1, scrollPositionX: { real: 0 }, scrollPositionY: { real: 0 },
  });
  const place = (x, y) => Buffer.concat([u32(x), u32(y), Buffer.from('ffffffffffff0000', 'hex')]);
  return dsStore([
    { name: '.', key: 'bwsp', type: 'blob', value: bwsp },
    { name: '.', key: 'icvl', type: 'type', value: 'icnv' }, // icon view
    { name: '.', key: 'icvp', type: 'blob', value: icvp },
    { name: '.', key: 'vSrn', type: 'long', value: 1 },
    ...icons.map((i) => ({ name: i.name, key: 'Iloc', type: 'blob', value: place(i.x, i.y) })),
  ]);
}
