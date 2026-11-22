// How far along a workflow is, as a steady estimate. Agents alone ("4 of 7 done") can't give a percentage: a workflow
// starts agents as it goes, so the total grows and the bar would slide backwards. The phases are declared up front, so:
// every phase counts equally, and the phase(s) under way count by how many of their agents are done so far. A phase
// with no agents yet counts as done once a later one has started (it was plain code, or it had nothing to do).

export type ProgressAgent = { phase: string | null; done: boolean };
export type WorkflowProgress = {
  pct: number;          // 0-100, rounded; capped at 99 while it runs
  phase: string | null; // the phase in progress (the earliest with an agent still going)
  index: number;        // its position, 1-based
  count: number;        // how many phases in all
};

export function workflowProgress(agents: ProgressAgent[] | null | undefined, declared: string[] | null | undefined, running: boolean): WorkflowProgress | null {
  const list = agents ?? [];
  // The plan: declared phases first, then any the agents used that weren't declared, in the order they appeared.
  const phases = [...(declared ?? [])];
  for (const a of list) { const k = a.phase ?? 'Agents'; if (!phases.includes(k)) phases.push(k); }
  if (!phases.length) return null;
  const of = (p: string) => list.filter((a) => (a.phase ?? 'Agents') === p);
  const lastStarted = phases.reduce((n, p, i) => (of(p).length ? i : n), -1);
  let sum = 0;
  phases.forEach((p, i) => {
    const xs = of(p);
    if (xs.length) sum += xs.filter((a) => a.done).length / xs.length;
    else if (i < lastStarted) sum += 1;
  });
  let pct = Math.round((sum / phases.length) * 100);
  if (!running) pct = 100;
  else pct = Math.min(pct, 99);
  const curI = phases.findIndex((p) => of(p).some((a) => !a.done));
  // Between phases (all started agents done, next phase not begun yet): show the next one.
  const at = curI >= 0 ? curI : running && lastStarted + 1 < phases.length ? lastStarted + 1 : Math.max(0, lastStarted);
  return { pct, phase: phases[at] ?? null, index: at + 1, count: phases.length };
}
