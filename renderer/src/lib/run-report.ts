// Run in the chat: what goes back to Claude when a command you ran from a reply ends, and how the chat knows that
// message again. It is an ordinary message (so Claude Code keeps it, and Claude reads it as you telling it what
// happened); the chat draws it as a small "You ran …" bubble, folded, by its words, so a reopened chat shows the same.
// No window code here: node runs this file as it is, for the unit tests.

export const RUN_LEAD = "I ran this in Canopy's terminal";
const MAX_LINES = 60;
const MAX_CHARS = 4000;

/** Terminal output as the lines a person saw: colours and cursor moves dropped, a line redrawn in place (a progress
 *  bar, a spinner) kept as it ended, trailing blank lines gone. */
export function plainOutput(raw: string): string {
  const text = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')      // OSC: titles, links
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')                 // CSI: colours, cursor, erase
    .replace(/\x1b[@-Z\\-_]/g, '')                            // the rest of the two-byte escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, ''); // bells, backspaces, other controls
  const lines = text.split('\n').map((l) => {
    const line = l.replace(/\r+$/, '');
    const at = line.lastIndexOf('\r');
    return (at < 0 ? line : line.slice(at + 1)).replace(/\s+$/, '');
  });
  while (lines.length && !lines.at(-1)) lines.pop();
  while (lines.length && !lines[0]) lines.shift();
  return lines.join('\n');
}

/** A fence the text can't close early. */
const fenceFor = (text: string) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)));

/** The message Claude gets when a run ends by itself. `exitCode` null: it ended on a signal. */
export function runReport(code: string, exitCode: number | null, raw: string): string {
  const out = plainOutput(raw);
  let lines = out ? out.split('\n') : [];
  const cut = lines.length > MAX_LINES;
  if (cut) lines = lines.slice(-MAX_LINES);
  let shown = lines.join('\n');
  if (shown.length > MAX_CHARS) shown = `…${shown.slice(-MAX_CHARS)}`;
  const how = exitCode === null ? 'it ended on a signal' : `exit code ${exitCode}`;
  const cmd = code.replace(/\s+$/, '');
  const c = fenceFor(cmd);
  const parts = [`${RUN_LEAD} (${how}):`, '', `${c}sh`, cmd, c, ''];
  if (!shown) parts.push('It printed nothing.');
  else {
    const f = fenceFor(shown);
    parts.push(cut ? `What it printed (the last ${MAX_LINES} lines):` : 'What it printed:', '', `${f}text`, shown, f);
  }
  return parts.join('\n');
}

export type RunReport = { code: string; exitCode: number | null; output: string };

/** The parts of a run report, or null when the message is not one. */
export function parseRunReport(text: string): RunReport | null {
  if (!text.startsWith(RUN_LEAD)) return null;
  const head = /^I ran this in Canopy's terminal \((?:exit code (-?\d+)|it ended on a signal)\):\n\n(`{3,})sh\n([\s\S]*?)\n\2\n/.exec(text);
  if (!head) return null;
  const rest = text.slice(head[0].length);
  const out = /\n(`{3,})text\n([\s\S]*)\n\1\s*$/.exec(rest);
  return { code: head[3], exitCode: head[1] === undefined ? null : Number(head[1]), output: out ? out[2] : '' };
}

// A block with no language is also where Claude puts diagrams, file trees and command output, so it has Run only
// when it reads as commands and nothing else: a few lines, each a command (a known program, a path to one, or a
// variable set), none drawn with lines and arrows. A "$ " in front of every command is a prompt, not part of it.
const PROGRAMS = new Set(('security claude codex npm npx pnpm yarn bun bunx node deno python python3 pip pip3 uv uvx brew '
  + 'git gh cd ls cat echo printf curl wget open mkdir rmdir cp mv rm touch ln chmod chown export source sudo '
  + 'defaults launchctl xcode-select xcrun killall pkill kill ps lsof osascript sh bash zsh docker make cargo go '
  + 'rustup supabase vercel ssh scp rsync tar unzip zip env which mdfind pbcopy pbpaste tail head grep find sed '
  + 'awk jq sqlite3 psql redis-cli mise asdf nvm fnm volta corepack firebase gcloud aws az flyctl fly heroku '
  + 'terraform kubectl helm stripe ngrok code cursor xattr codesign spctl diskutil hdiutil softwareupdate').split(' '));
const DRAWN = /[│┃├┤┬┴┼└┘┌┐─━═║╔╗╚╝▶◀→←↑↓⇒•]/;

/** The command to run when a block with no language is one, or null. */
export function plainCommand(text: string): string | null {
  const lines = text.replace(/\s+$/, '').split('\n');
  if (!lines[0]?.trim() || lines.length > 12 || DRAWN.test(text)) return null;
  const prompted = lines.filter((l) => l.trim()).every((l) => /^\s*\$ /.test(l));
  const cmds = prompted ? lines.map((l) => l.replace(/^(\s*)\$ /, '$1')) : lines;
  let continued = false; // the line before ended in "\": this one is part of it
  for (const raw of cmds) {
    const l = raw.trim();
    const part = continued;
    continued = /\\$/.test(l);
    if (!l || part || l.startsWith('#')) continue;
    const first = l.split(/\s+/)[0];
    const ok = PROGRAMS.has(first) || /^(\.{0,2}\/|~\/)\S+$/.test(first) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first);
    if (!ok) return null;
  }
  return cmds.join('\n');
}
