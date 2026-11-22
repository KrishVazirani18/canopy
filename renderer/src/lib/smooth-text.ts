// Smooth streaming reveal. Claude Code streams text in chunks of a few words, and with Fast mode a
// whole reply can arrive in about a second, which reads as text being pasted in. For any reply that
// streamed in live, this types the text out at a pace that follows the stream, speeding up the further
// it falls behind, and keeps going after the stream ends until it has caught up. History renders instantly.
import { useEffect, useRef, useState } from 'react';

// Reveal speed in chars/s is FLOOR + GAIN * backlog. Pacing by backlog settles about 1/GAIN seconds
// behind the stream whatever its speed, so the text keeps flowing between network chunks instead of
// catching up and stalling, and a reply that lands all at once finishes in about a quarter second.
// (Was GAIN 8: measured ~450ms behind the stream, which made Canopy feel slower than the terminal.)
const FLOOR = 60;
const GAIN = 30; // ~35ms behind the stream: still flows between chunks, but reads as live as the terminal

export function useSmoothText(target: string, animate: boolean): { text: string; typing: boolean } {
  const [shown, setShown] = useState(animate ? '' : target);
  const shownRef = useRef(shown);
  const targetRef = useRef(target);
  targetRef.current = target;
  const rafRef = useRef(0);

  useEffect(() => {
    if (!animate) { shownRef.current = targetRef.current; setShown(targetRef.current); return; }
    if (rafRef.current) return; // already running; it reads the latest target each frame
    let last = performance.now();
    let owed = 0; // fraction of a character carried to the next frame, so the pace is the same at 60Hz and 120Hz
    const tick = (now: number) => {
      const dt = Math.max(0, Math.min(50, now - last)); // a frame's timestamp can predate the effect that started the loop
      last = now;
      const tgt = targetRef.current;
      let cur = shownRef.current;
      if (!tgt.startsWith(cur)) cur = tgt.slice(0, Math.min(cur.length, tgt.length));
      const backlog = tgt.length - cur.length;
      if (backlog <= 0) { rafRef.current = 0; return; } // caught up: stop until more text arrives
      rafRef.current = requestAnimationFrame(tick);
      owed += ((FLOOR + GAIN * backlog) * dt) / 1000;
      const n = Math.floor(owed);
      if (n < 1) return; // less than a character is due: leave the text alone this frame
      owed -= n;
      let end = Math.min(tgt.length, cur.length + n);
      if (end < tgt.length && (tgt.charCodeAt(end - 1) & 0xfc00) === 0xd800) end++; // never show half an emoji
      cur = tgt.slice(0, end);
      shownRef.current = cur;
      setShown(cur);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [animate, target]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  if (!animate) return { text: target, typing: false };
  return { text: shown, typing: shown.length < target.length };
}
