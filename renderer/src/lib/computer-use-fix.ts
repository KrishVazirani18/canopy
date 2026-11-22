// A Computer Use step that failed for a reason the user can fix: what to say under it and the one thing to press.
// The texts are Computer Use's own (read from Codex's bundled plugin and its helper app, never changed here).
import type { ComputerUsePane } from './api';

export type ComputerUseFix =
  /** macOS has not let Computer Use in yet: open that pane of System Settings. */
  | { kind: 'permission'; line: string; pane: ComputerUsePane }
  /** The app was not approved (a No, or a mode that answers no for you): ask again, and answer the card. */
  | { kind: 'app'; line: string; app: string | null; prompt: string };

const TOOL = /(?:^|_)(?:cua_repl|computer[-_]use)(?:_|$)/i;
const NOT_APPROVED = [
  /Computer Use was not approved to use ([^\n]{1,120}?)(?:[.\n]|$)/,
  /Computer Use approval denied via MCP elicitation for app '([^'\n]{1,120})'/,
  /Computer Use permission request canceled for app '([^'\n]{1,120})'/,
];

/** null for any other tool, any other failure, and a step that did not fail. */
export function computerUseFix(name: string, result: string | undefined | null, failed: boolean): ComputerUseFix | null {
  if (!failed || typeof result !== 'string' || !TOOL.test(name)) return null;
  const text = result.slice(0, 4000);
  for (const re of NOT_APPROVED) {
    const m = re.exec(text);
    if (m) {
      const app = m[1].trim() || null;
      return { kind: 'app', app, line: `${app ?? 'That app'} was not allowed. Try again and choose Allow when Canopy asks.`, prompt: app ? `Try that again. I will allow ${app}.` : 'Try that again.' };
    }
  }
  if (/Computer Use was not approved to record computer audio/.test(text)) {
    return { kind: 'app', app: null, line: 'Recording this Mac’s audio was not allowed. Try again and choose Allow when Canopy asks.', prompt: 'Try that again. I will allow it.' };
  }
  if (/Computer Use permissions are still pending|has not finished granting Accessibility and Screen Recording/.test(text)) {
    return { kind: 'permission', pane: 'accessibility', line: 'Computer Use needs Accessibility and Screen Recording turned on for “Codex Computer Use”.' };
  }
  if (/Accessibility error:/.test(text)) return { kind: 'permission', pane: 'accessibility', line: 'Computer Use needs Accessibility turned on for “Codex Computer Use”.' };
  if (/Screen Recording (?:permission|access)|screen recording is not (?:granted|allowed)/i.test(text)) return { kind: 'permission', pane: 'screen', line: 'Computer Use needs Screen Recording turned on for “Codex Computer Use”.' };
  return null;
}

/** The fixes still worth showing for a run of steps (a folded group, a finished turn): each once, and none that a
 *  later Computer Use step got past by working. */
export function computerUseFixes(steps: { name: string; result?: string | null; status?: string }[]): ComputerUseFix[] {
  let out: ComputerUseFix[] = [];
  for (const s of steps) {
    if (!TOOL.test(s.name)) continue;
    if (s.status === 'done') { out = []; continue; }
    const fix = computerUseFix(s.name, s.result, s.status === 'error');
    if (fix && !out.some((f) => f.line === fix.line)) out.push(fix);
  }
  return out.slice(-2);
}
