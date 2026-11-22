// When a finished turn holds a plan, and what a plan's answers mean. One copy of each rule and each frozen word,
// for the engine (codex-session.mjs raises the plan card and the question card from these) and for the window
// (renderer/src/lib/plan.ts reads a saved chat's plans back with them).
//
// Contract:
//  - Pure: no I/O, nothing imported, safe to load in the window. Nothing here throws; bad input gives null,
//    false or ''.
//  - planOf(events): the plan a finished turn ended with, or null. `events` are one turn's Canopy events with its
//    `turn-end` among them. A turn that was stopped, failed or has not ended offers nothing.
//  - BUILD_WORDS is what is sent when the user presses Build it in an OpenAI chat. They are Codex's own words for
//    it. The plan is already in the chat, so it is not sent again.
//  - KEPT_PREFIX is how Claude Code is told "keep planning" (session.mjs writes the same sentence), so a saved
//    chat's plan can say how it was answered: planOutcome(result).
//  - questionsFor / answerWords: a question Codex asks in passing, as the question card's input, and the card's
//    answer as the message that is sent back.

/** What Build it sends in an OpenAI chat. */
export const BUILD_WORDS = 'Implement the plan.';
/** How a Claude chat's plan is answered "keep planning". With feedback: `${KEPT_PREFIX} Feedback: <words>`. */
export const KEPT_PREFIX = 'The user wants to keep planning.';
const FEEDBACK = 'Feedback: ';
const PLAN_MAX = 200_000;

const TAGGED = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/i;
const LIST_ITEM = /^\s{0,3}(?:\d{1,3}[.)]|[-*+])\s+\S/;
const HEADING = /^\s{0,3}#{1,6}\s+\S/;
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const words = (v) => (typeof v === 'string' ? v : '');

/** The plan inside a reply's `<proposed_plan>` block (Codex's Plan mode asks the model to mark it so), or null. */
export function taggedPlan(text) {
  const m = TAGGED.exec(words(text));
  const inside = m ? m[1].trim() : '';
  return inside ? inside.slice(0, PLAN_MAX) : null;
}

/** A reply with its `<proposed_plan>` block taken out: the words around the plan. */
export function withoutTagged(text) {
  return words(text).replace(TAGGED, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * A reply nobody marked, read as a plan: at least two list items, or a heading. Not one that ends by asking
 * something (the chat simply stays in Plan), and code blocks do not count (a `# comment` is not a heading).
 */
export function readsAsPlan(text) {
  const t = words(text).trim();
  if (!t || /\?\s*$/.test(t)) return false;
  const lines = t.replace(/```[\s\S]*?(?:```|$)/g, '').split('\n');
  return lines.filter((l) => LIST_ITEM.test(l)).length >= 2 || lines.some((l) => HEADING.test(l));
}

/** The plan a reply holds, marked or not, or null when it is talk. */
export function planText(text) {
  const tagged = taggedPlan(text);
  if (tagged) return tagged;
  return readsAsPlan(text) ? words(text).trim().slice(0, PLAN_MAX) : null;
}

/**
 * The plan a finished Plan-mode turn ended with, or null.
 *  1. A plan item (the adapter's `assistant-text` with `plan: true`): that text.
 *  2. Else a final answer holding a `<proposed_plan>` block: the text inside it.
 *  3. Else the final answer, when it reads as a plan (readsAsPlan).
 *  4. Else nothing: the reply was talk or a question.
 * Whether the turn ran in Plan mode is the caller's to know.
 */
export function planOf(events) {
  try {
    const all = Array.isArray(events) ? events.filter(isObj) : [];
    const end = all.findLast((e) => e.kind === 'turn-end');
    if (!end || end.isError || end.interrupted || (end.subtype != null && end.subtype !== 'success')) return null;
    const said = all.filter((e) => e.kind === 'assistant-text' && !e.parent && !e.aborted && words(e.text).trim());
    const item = said.findLast((e) => e.plan === true);
    if (item) return item.text.trim().slice(0, PLAN_MAX);
    const answers = said.filter((e) => !(Array.isArray(e.questions) && e.questions.length));
    // A maker that does not say which reply is the final one: the last thing it said is.
    const phased = answers.some((e) => e.phase != null);
    const final = answers.findLast((e) => !phased || e.phase === 'final_answer');
    return final ? planText(final.text) : null;
  } catch { return null; }
}

/**
 * How a Claude chat's plan was answered, from the result its plan step was given:
 * { outcome: 'approved' | 'kept' | null, feedback }. Null: neither (stopped, cancelled, cut off).
 */
export function planOutcome(result, isError) {
  const text = typeof result === 'string' ? result : result == null ? '' : (() => { try { return JSON.stringify(result) ?? ''; } catch { return ''; } })();
  const at = text.indexOf(KEPT_PREFIX);
  if (at >= 0) {
    const rest = text.slice(at + KEPT_PREFIX.length).trimStart();
    return { outcome: 'kept', feedback: rest.startsWith(FEEDBACK) ? rest.slice(FEEDBACK.length).trim() : '' };
  }
  if (isError === false || (isError == null && /\bapproved\b[^.]*\bplan\b/i.test(text))) return { outcome: 'approved', feedback: '' };
  return { outcome: null, feedback: '' };
}

/**
 * A question Codex asked in passing (a reply that carries `questions`), as the question card's input:
 * { questions: [{ question, header: '', multiSelect: false, options: [{ label }] }] }, or null when it asks nothing.
 * Answers come back keyed by the question's words, so no two questions (and no two choices of one) share them.
 */
export function questionsFor(ev) {
  try {
    const seen = new Set();
    const questions = [];
    for (const q of Array.isArray(ev?.questions) ? ev.questions : []) {
      const question = words(q?.question).trim();
      if (!question || seen.has(question)) continue;
      seen.add(question);
      const labels = [...new Set((Array.isArray(q.options) ? q.options : []).map((o) => words(isObj(o) ? o.label : o).trim()).filter(Boolean))];
      questions.push({ question, header: '', multiSelect: false, options: labels.map((label) => ({ label })) });
    }
    return questions.length ? { questions } : null;
  } catch { return null; }
}

/**
 * The card's answers as the message that goes back: one question gives its answer as it is, several give
 * `<question>: <answer>` a line each. '' when nothing was answered.
 */
export function answerWords(questions, answers) {
  try {
    const given = isObj(answers) ? answers : {};
    const rows = (Array.isArray(questions) ? questions : [])
      .map((q) => [words(q?.question).trim(), words(given[q?.question]).trim()])
      .filter(([question, answer]) => question && answer);
    if (rows.length === 0) return '';
    if (rows.length === 1 && (Array.isArray(questions) ? questions.length : 0) === 1) return rows[0][1];
    return rows.map(([question, answer]) => `${question}: ${answer}`).join('\n');
  } catch { return ''; }
}
