// A command that only waits ("sleep 300", "sleep 5m && check") has a known end, so the agents drawer can count it
// down with a bar instead of a spinner. Anything else (a loop, a sleep buried mid-script) has no end we can know.

const UNIT: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };

/** How long a command that starts by sleeping waits, in ms; null when it isn't one. "sleep 1m 30s" is 90 seconds. */
export function waitMs(command: unknown): number | null {
  if (typeof command !== 'string') return null;
  const m = /^\s*sleep\s+((?:\d+(?:\.\d+)?[smhd]?\s+)*\d+(?:\.\d+)?[smhd]?)\s*(?:$|[;&|\n])/.exec(command);
  if (!m) return null;
  let s = 0;
  for (const part of m[1].trim().split(/\s+/)) {
    const p = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(part);
    if (!p) return null;
    s += Number(p[1]) * UNIT[p[2]];
  }
  return s > 0 ? Math.round(s * 1000) : null;
}

/** Time left on the clock: "4:05", "1:02:07", "0:00". */
export function clock(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
