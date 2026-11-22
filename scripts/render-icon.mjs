// Renders assets/icon.svg to a transparent PNG (the .icns is built from it), and the menu bar icons
// from the mark in assets/logo.svg into assets/tray/.
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { ANIMATION } from '../src/tray.mjs';

const svg = readFileSync('assets/icon.svg', 'utf8');
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 }, background: 'rgba(0,0,0,0)' }).render().asPng();
writeFileSync('assets/icon.png', png);
console.log('icon.png', png.length, 'bytes');

// Menu bar: macOS template images (black plus alpha; the system tints them for a light or dark bar),
// 18 pt, with an @2x for Retina. Names end in "Template" so Electron marks them as templates.
//   idle            the mark
//   working-N       the loading logo's animation, frame by frame (ANIMATION in src/tray.mjs plays them)
//   needs-you       the mark with a dot cut into its top right corner
const tiers = [...readFileSync('assets/logo.svg', 'utf8').matchAll(/<path d="([^"]+)"\/>/g)].map((m) => m[1]); // top, middle, bottom
if (tiers.length !== 3) throw new Error(`expected 3 tiers in logo.svg, found ${tiers.length}`);
const VIEW = '488 223 560 560'; // a square around the mark
const shape = (alpha = [1, 1, 1], extra = '', transforms = []) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW}">${extra}`
  + tiers.map((d, i) => `<path d="${d}" fill="#000" fill-opacity="${alpha[i]}"${transforms[i] ? ` transform="${transforms[i]}"` : ''}${extra ? ' mask="url(#m)"' : ''}/>`).join('') + '</svg>';
const DOT = { cx: 958, cy: 310, r: 86, gap: 44 };
const badge = `<defs><mask id="m"><rect x="0" y="0" width="2000" height="2000" fill="#fff"/><circle cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.r + DOT.gap}" fill="#000"/></mask></defs>`
  + `<circle cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.r}" fill="#000"/>`;
// The loading logo (.grow in renderer/src/index.css), sampled at ANIMATION.frameMs. Per tier, trunk end first:
//   tier-in    0.6 s, cubic-bezier(.22,1,.36,1), delays 0 / .13 / .26 s: from opacity 0, translateY(22%) scale(.8),
//              about the bottom centre of the tier's own box
//   tier-wave  2.6 s ease-in-out, infinite, delays .8 / 1 / 1.2 s: opacity 1 → .45 → 1
function bezier(x1, y1, x2, y2) {
  const at = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  return (x) => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (at(x1, x2, mid) < x) lo = mid; else hi = mid; }
    return at(y1, y2, (lo + hi) / 2);
  };
}
const easeOut = bezier(0.22, 1, 0.36, 1);
const easeInOut = bezier(0.42, 0, 0.58, 1);
const IN = { dur: 0.6, delay: [0.26, 0.13, 0] };   // indexed like tiers: top, middle, bottom
const WAVE = { dur: 2.6, delay: [1.2, 1, 0.8], low: 0.45 };
const boxes = tiers.map((d) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW}"><path d="${d}"/></svg>`).getBBox());
function logoFrame(t) {
  const alpha = [], transforms = [];
  tiers.forEach((_, i) => {
    const p = Math.min(1, Math.max(0, (t - IN.delay[i]) / IN.dur));
    const e = easeOut(p);
    let a = e;
    if (t >= WAVE.delay[i]) {
      const q = (((t - WAVE.delay[i]) / WAVE.dur) % 1) * 2; // 0…2: down the first half, back up the second
      const k = easeInOut(q <= 1 ? q : q - 1);
      a *= q <= 1 ? 1 - (1 - WAVE.low) * k : WAVE.low + (1 - WAVE.low) * k;
    }
    alpha.push(+a.toFixed(3));
    if (e < 1) {
      const b = boxes[i], cx = b.x + b.width / 2, by = b.y + b.height;
      transforms.push(`translate(${cx} ${by}) translate(0 ${(0.22 * b.height * (1 - e)).toFixed(2)}) scale(${(0.8 + 0.2 * e).toFixed(4)}) translate(${-cx} ${-by})`);
    } else transforms.push('');
  });
  return shape(alpha, '', transforms);
}
function wave() {
  const out = {};
  const dt = ANIMATION.frameMs / 1000;
  // Growing: frames 0…grow-1 from t = 0. Breathing: the next `loop` frames, one 2.6 s period, starting once every tier is in it.
  if ((ANIMATION.grow) * dt < Math.max(...WAVE.delay)) throw new Error('ANIMATION.grow ends before every tier has started breathing');
  if (Math.abs(ANIMATION.loop * dt - WAVE.dur) > 1e-9) throw new Error('ANIMATION.loop must span one breath');
  for (let f = 0; f < ANIMATION.grow + ANIMATION.loop; f++) out[`working-${f}`] = logoFrame(f * dt);
  return out;
}
const icons = {
  idle: shape(),
  ...wave(),
  'needs-you': shape([1, 1, 1], badge),
};
mkdirSync('assets/tray', { recursive: true });
for (const f of readdirSync('assets/tray')) if (f.startsWith('working-')) rmSync(`assets/tray/${f}`); // no stale frames from a longer run
for (const [name, s] of Object.entries(icons)) {
  for (const [suffix, px] of [['', 18], ['@2x', 36]]) {
    const out = new Resvg(s, { fitTo: { mode: 'width', value: px }, background: 'rgba(0,0,0,0)' }).render().asPng();
    writeFileSync(`assets/tray/${name}Template${suffix}.png`, out);
  }
}
console.log('tray icons:', Object.keys(icons).join(', '));
