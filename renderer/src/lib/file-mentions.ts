// Files attached to a message (a dropped PDF, a spreadsheet, a folder) travel as @mentions of their paths, which is
// how Claude Code and Codex read a file from disk. Canopy shows them as attachment cards instead of the raw text: in
// the message box, and in your sent message, where the mentions are a paragraph of their own at the start or end.
// Plain TypeScript with no run-time imports, so node's tests run it as it is.

/** "@path", quoted when the path has a space. A path inside the project is written from the project. */
export function mentionOf(path: string, cwd?: string | null): string {
  const p = cwd && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path;
  return /\s/.test(p) ? `@"${p}"` : `@${p}`;
}

/** The message as sent: what was written, then the attached files as one paragraph of mentions. */
export function withFiles(text: string, files: string[], cwd?: string | null): string {
  const mentions = files.map((f) => mentionOf(f, cwd)).join(' ');
  return [text, mentions].filter((s) => s.trim()).join('\n\n');
}

// A paragraph made only of mentions: @"quoted path" or @bare/path, separated by spaces.
const MENTION = /@"([^"\n]+)"|@([^\s"]+)/g;
function onlyMentions(paragraph: string): string[] | null {
  const files: string[] = [];
  const rest = paragraph.replace(MENTION, (_m, quoted: string | undefined, bare: string | undefined) => { files.push(quoted ?? bare!); return ''; });
  // A bare "@name" with no path or extension is a person or a word, not a file.
  if (rest.trim() || !files.length || files.some((f) => !/[/.]/.test(f))) return null;
  return files;
}

/** Splits a sent message into its words and the files attached to it (a mentions-only first or last paragraph). */
export function splitFiles(text: string): { text: string; files: string[] } {
  const parts = text.trim().split(/\n[ \t]*\n/);
  const files: string[] = [];
  const last = parts.length > 1 || parts[0] ? onlyMentions(parts[parts.length - 1]) : null;
  if (last) { files.push(...last); parts.pop(); }
  const first = parts.length ? onlyMentions(parts[0]) : null;
  if (first) { files.unshift(...first); parts.shift(); }
  return { text: parts.join('\n\n'), files };
}

/** "Meeting notes.pdf" → { name: "Meeting notes.pdf", kind: "PDF" }; a folder or extensionless file says "File". */
export function fileLabel(path: string): { name: string; kind: string } {
  const name = path.replace(/\/+$/, '').split('/').pop() || path;
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1];
  return { name, kind: ext ? ext.toUpperCase() : 'File' };
}
