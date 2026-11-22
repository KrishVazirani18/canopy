// The completion sound: synthesized with Web Audio (oscillators + gain envelopes), so there are no audio files to
// ship or license. The choice is saved in this window (localStorage), like the theme; main only says "a chat finished".
export type SoundId = 'chime' | 'bell' | 'tick' | 'none';
export const SOUNDS: { id: SoundId; label: string }[] = [
  { id: 'chime', label: 'Chime' }, { id: 'bell', label: 'Soft bell' }, { id: 'tick', label: 'Tick' }, { id: 'none', label: 'None' },
];
const KEY = 'canopy.sound';

export function getSound(): SoundId {
  try { const v = localStorage.getItem(KEY); return SOUNDS.some((s) => s.id === v) ? v as SoundId : 'chime'; } catch { return 'chime'; }
}
export function setSound(id: SoundId) { try { localStorage.setItem(KEY, id); } catch { /* ignore */ } }

let ctx: AudioContext | null = null;
let lastAt = 0;

type Partials = readonly (readonly [mult: number, amp: number])[];
const BELL: Partials = [[1, 1], [2, 0.3], [3, 0.12], [4.2, 0.05]]; // a struck bell: bright overtones that die fast
const WARM: Partials = [[1, 1], [2, 0.1]];                           // the cabin chime: a sine and a touch of its octave

/** One note: the partials of a tone, a short linear attack (no click), then an exponential decay. */
function note(c: AudioContext, out: AudioNode, freq: number, at: number, peak: number, decay: number, partials: Partials = BELL, attack = 0.006) {
  for (const [mult, amp] of partials) {
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine'; osc.frequency.value = freq * mult;
    const d = decay / (1 + (mult - 1) * 0.6); // overtones die faster
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak * amp, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + d);
    osc.connect(g).connect(out);
    osc.start(at); osc.stop(at + d + 0.05);
  }
}

/** The sound itself, scheduled from "now" on a context that is running. */
function schedule(c: AudioContext, id: SoundId) {
  const out = c.createGain(); out.gain.value = 0.5; out.connect(c.destination); // low volume overall
  const t = c.currentTime + 0.02;
  if (id === 'chime') {
    // Two soft tones falling a major third, like a cabin announcement chime: E5, then C5 0.24 s later, quiet and short.
    note(c, out, 659.25, t, 0.13, 0.9, WARM, 0.015);
    note(c, out, 523.25, t + 0.24, 0.13, 1.05, WARM, 0.015);
  } else if (id === 'bell') { note(c, out, 392, t, 0.18, 0.9); note(c, out, 587.33, t + 0.16, 0.18, 1.0); } // G4, then D5
  else { // tick: a short falling blip
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(900, t); osc.frequency.exponentialRampToValueAtTime(380, t + 0.07);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.35, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    osc.connect(g).connect(out); osc.start(t); osc.stop(t + 0.15);
  }
}

/** The shared context, made once. A context that Chromium suspended (no gesture yet, or the window was hidden) or macOS interrupted is woken. */
function audio(): AudioContext {
  ctx ??= new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state !== 'running') void ctx.resume().catch(() => {});
  return ctx;
}

// Make the context before the first sound is due, from your first click or key (a gesture always lets it run), and wake
// it when the window comes back: a context first created at the moment a chat finishes can sit suspended, and the sound
// only plays when something finally resumes it.
if (typeof window !== 'undefined') {
  const unlock = () => { try { audio(); } catch { /* no audio device */ } };
  for (const e of ['pointerdown', 'keydown'] as const) window.addEventListener(e, unlock, { capture: true, once: true });
  window.addEventListener('focus', () => { if (ctx && ctx.state !== 'running') unlock(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx && ctx.state !== 'running') unlock(); });
}

function play(id: SoundId) {
  if (id === 'none') return;
  try {
    const c = audio();
    // Schedule only once it is running: while suspended the clock stands still, so the sound would be placed against a stale time.
    if (c.state === 'running') schedule(c, id);
    else void c.resume().then(() => schedule(c, id)).catch(() => { /* still blocked: stay quiet */ });
  } catch { /* no audio device: stay quiet */ }
}

/** A chat finished: play the chosen sound, once even if several finish within a second. */
export function playDone() {
  const now = Date.now();
  if (now - lastAt < 1000) return;
  const id = getSound();
  if (id === 'none') return;
  lastAt = now;
  play(id);
}
/** The Test button (and picking a sound) plays it right away. */
export const testSound = (id: SoundId = getSound()) => play(id);
