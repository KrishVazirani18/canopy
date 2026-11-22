// The word "Canopy" as a drawing: six outlines, 1000 units to the em, filled with the text colour around it. A
// wordmark is a picture of a word, so no font file ships for it. It takes the place of a line of bold text and sits
// exactly where that text sat: as wide as the letters with their spacing, one line tall, on the same baseline (the
// `.wordmark` rule in index.css does the sums). Give it a size and a colour as you would text.
//
//   tracking    the space between letters, in em, as letter-spacing would add it (after the last letter too)
//   twoStorey   the "a" with a bowl and a roof. The "requested an update" bubble has always drawn that one; every
//               other place draws the single-storey "a" of the sidebar's lockup.
import { cn } from '@/lib/utils';

const C = 'M390 12Q230 12 134 -90Q39 -193 39 -365Q39 -535 137 -639Q235 -743 396 -743Q526 -743 615 -673Q704 -603 723 -485H588Q569 -549 518 -584Q466 -620 393 -620Q292 -620 232 -552Q173 -483 173 -366Q173 -250 233 -180Q293 -111 393 -111Q467 -111 520 -147Q574 -183 592 -244H725Q704 -129 612 -58Q520 12 390 12Z';
const A = 'M446 -494H557V0H443L435 -77Q410 -37 366 -12Q322 13 265 13Q157 13 96 -61Q34 -135 34 -253Q34 -369 98 -439Q161 -509 266 -509Q323 -509 370 -485Q417 -461 439 -418ZM394 -138Q433 -180 433 -247Q433 -314 395 -356Q357 -398 294 -398Q231 -398 194 -356Q156 -314 156 -247Q156 -180 193 -138Q230 -97 293 -97Q356 -97 394 -138Z';
const A_TWO_STOREY = 'M210 13Q132 13 86 -29Q41 -71 41 -141Q41 -209 88 -250Q136 -291 224 -298L372 -309V-320Q372 -414 270 -414Q216 -414 187 -392Q158 -371 158 -332H54Q54 -412 114 -460Q175 -509 276 -509Q377 -509 434 -455Q491 -401 491 -300V0H384L375 -73Q359 -35 314 -11Q268 13 210 13ZM250 -79Q307 -79 340 -111Q373 -143 373 -200V-226L270 -218Q165 -208 165 -146Q165 -79 250 -79Z';
const N = 'M185 0H63V-494H176L186 -430Q209 -467 251 -488Q293 -509 344 -509Q436 -509 484 -455Q532 -401 532 -304V0H410V-275Q410 -336 382 -367Q355 -398 306 -398Q250 -398 218 -362Q185 -326 185 -266Z';
const O = 'M108 -60Q34 -133 34 -248Q34 -363 108 -436Q183 -508 298 -508Q413 -508 488 -436Q562 -363 562 -248Q562 -133 488 -60Q413 12 298 12Q183 12 108 -60ZM196 -357Q156 -315 156 -248Q156 -181 196 -139Q235 -97 298 -97Q361 -97 400 -139Q440 -181 440 -248Q440 -315 400 -357Q361 -399 298 -399Q235 -399 196 -357Z';
const P = 'M63 229V-494H176L184 -419Q206 -461 252 -485Q297 -509 354 -509Q458 -509 522 -439Q585 -369 585 -253Q585 -135 524 -61Q462 13 354 13Q298 13 253 -8Q208 -29 185 -66V229ZM325 -97Q389 -97 426 -138Q462 -180 462 -247Q462 -314 425 -356Q388 -398 325 -398Q262 -398 224 -356Q186 -314 186 -247Q186 -180 224 -138Q262 -97 325 -97Z';
const Y = 'M20 229V127H93Q132 127 154 113Q177 99 192 58L206 21L7 -494H136L263 -134L397 -494H523L281 110Q253 179 212 210Q172 240 111 240Q62 240 20 229Z';

type Glyph = readonly [x: number, d: string];
// Where each letter starts, kerning included, and where the word ends.
const ONE_STOREY = { advance: 3693, glyphs: [[0, C], [759, A], [1379, N], [1968, O], [2564, P], [3164, Y]] as readonly Glyph[] };
const TWO_STOREY = { advance: 3611, glyphs: [[0, C], [749, A_TWO_STOREY], [1297, N], [1886, O], [2482, P], [3082, Y]] as readonly Glyph[] };

export function Wordmark({ className, tracking = -0.02, twoStorey = false }: { className?: string; tracking?: number; twoStorey?: boolean }) {
  const { advance, glyphs } = twoStorey ? TWO_STOREY : ONE_STOREY;
  const gap = Math.round(tracking * 1000);
  const width = advance + glyphs.length * gap;
  return (
    <svg viewBox={`0 -1000 ${width} 1000`} preserveAspectRatio="xMinYMax meet" role="img" aria-label="Canopy" fill="currentColor"
      className={cn('wordmark', className)} style={{ width: `${width / 1000}em` }}>
      {glyphs.map(([x, d], i) => <path key={i} d={d} transform={`translate(${x + i * gap})`} />)}
    </svg>
  );
}
