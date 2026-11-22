// How each Claude Code tool's input and output is shown.
//
// An OpenAI chat's steps arrive under the same tool names, with three differences this file knows about:
//   - an edit carries the diff itself (`input.diff`, hunks only), which is shown and counted as it is;
//   - a read, search or file listing was really a shell command, kept in `input.command` and shown when the step is opened;
//   - "Permissions" is the chat asking for more access (other folders, the network), said in plain lines.
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { structuredPatch } from 'diff';
import type { BundledLanguage } from 'shiki';
import { CheckCircle2Icon, CircleDotIcon, CircleIcon } from 'lucide-react';
import { CodeBlock, CodeBlockCopyButton } from '@/components/ai-elements/code-block';
import { MessageResponse } from '@/components/ai-elements/message';
import { diffStats } from '@/lib/engine-rules';
import { computerUseAction, isComputerUse } from '@/lib/computer-use';
import { api } from '@/lib/api';
import { ImageViewer, type Thumb } from './message-images';
import { SEND_TOOL, chatName } from './chat-text';

const MAX = 12000;
export const clip = (s: string, n = MAX) => (s.length > n ? `${s.slice(0, n)}\n… ${(s.length - n).toLocaleString()} more characters not shown` : s);

const EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript', json: 'json',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c',
  cpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', zsh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', md: 'markdown', html: 'html', css: 'css', scss: 'scss', sql: 'sql', xml: 'xml', vue: 'vue', svelte: 'svelte',
};
export function langFor(path?: unknown): BundledLanguage {
  const ext = String(path ?? '').split('.').pop()?.toLowerCase() ?? '';
  return (EXT[ext] ?? 'text') as BundledLanguage;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
const base = (p: unknown) => String(p ?? '').split('/').pop();
const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
const paths = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** An OpenAI edit's own diff, when it has one. Claude's edits have none, and are drawn from their two sides. */
const ownDiff = (i: Record<string, unknown>) => (typeof i.diff === 'string' && i.diff.trim() ? i.diff : null);
/** "https://www.example.com/a" → "example.com"; empty when the URL can't be parsed. */
const host = (u: unknown) => { try { return new URL(str(u)).hostname.replace(/^www\./, ''); } catch { return ''; } };
/** "ListMcpResourcesTool" → "List mcp resources tool": CamelCase tool names in sentence case. */
const sentence = (name: string) => {
  const s = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const mcpParts = (name: string) => { const [, server = '', tool = ''] = name.split('__'); return { server, tool }; };

/**
 * A step that looked at a picture: Codex viewing an image (`image`, codex-adapter.mjs), or Claude reading an image file.
 * Never a shell command that happened to read one: that step shows what ran.
 */
const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
export const isImageView = (name: string, i: Record<string, unknown>) =>
  name === 'Read' && !(typeof i.command === 'string' && i.command.trim()) && (i.image === true || PICTURE.test(str(i.file_path)));

/** Code Mode's tool: one script Claude wrote that makes many tool calls (src/core/code-mode.mjs). */
export const CODE_TOOL = 'mcp__canopy__run';
/** Claude's widgets (src/core/widgets.mjs): the call that draws one, and the call that reads how to. */
export const SHOW_TOOL = 'mcp__visualize__show_widget';
export const GUIDE_TOOL = 'mcp__visualize__read_me';
/** Claude's look (src/core/look.mjs): a screenshot of a web page or an app window. */
export const LOOK_TOOL = 'mcp__canopy_look__look';
/** task (src/core/task-tool.mjs): Claude reports long work. Drawn as one card per turn, never as rows. */
export const TASK_TOOL = 'mcp__canopy_task__task';
/** What a look is of: the app window's name, or the page's address without the "http://". */
const lookAt = (i: Record<string, unknown>) => str(i.window).trim() || str(i.url).trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
/** Claude's read_chat (src/core/read-chat.mjs): the user's other chats in this project, listed or read. */
export const READ_CHAT_TOOL = 'mcp__canopy_chats__read_chat';
/** Canopy Memory (src/core/memory-tools.mjs): saving a note for later chats, looking the notes up, and taking one out. */
export const REMEMBER_TOOL = 'mcp__canopy_memory__remember';
export const RECALL_TOOL = 'mcp__canopy_memory__recall';
export const FORGET_TOOL = 'mcp__canopy_memory__forget';
/** Claude names each script in a few words; that is the step's title. */
export const codeTitle = (i: Record<string, unknown>) => str(i.description).trim() || 'Run a script';
/**
 * What a script handed back, in the parts the engine wrote it in (formatOutcome in code-mode.mjs): why it failed,
 * what it logged, what it returned. The "(3 tool calls, 1.2s)" line at the end is left out: the step already shows it.
 */
function codeResult(result: string): { error: string; logs: string; value: { text: string; lang: BundledLanguage } | null } {
  const body = result.replace(/\n\n\(\d+ tool calls?, [^)\n]*\)\s*$/, '');
  const m = /^([\s\S]*?)(?:^|\n\n)Logs:\n([\s\S]*?)(?:\n\nResult:\n([\s\S]*)|\n\n(The script returned nothing\.[^\n]*))?$/.exec(body);
  if (!m) return { error: '', logs: '', value: pretty(body) };
  return { error: m[1], logs: m[2], value: m[3] != null ? pretty(m[3]) : m[4] ? pretty(m[4]) : null };
}
function pretty(text: string): { text: string; lang: BundledLanguage } {
  try { if (/^\s*[[{]/.test(text)) return { text: JSON.stringify(JSON.parse(text), null, 2), lang: 'json' }; } catch { /* not JSON: shown as it is */ }
  return { text, lang: 'text' as BundledLanguage };
}

// MCP tools, in words. Gateways like Composio run another app's action ("run_tool" + "SLACK_SEARCH_MESSAGES"),
// so name the real app and action: { app: "Slack", action: "Search messages" }.
const APPS: Record<string, string> = {
  googlecalendar: 'Google Calendar', gmail: 'Gmail', googledrive: 'Google Drive', googledocs: 'Google Docs', googlesheets: 'Google Sheets',
  slack: 'Slack', notion: 'Notion', jira: 'Jira', github: 'GitHub', linear: 'Linear', hubspot: 'HubSpot', fireflies: 'Fireflies',
  composio: 'Composio', playwright: 'Browser', supabase: 'Supabase', vercel: 'Vercel', context7: 'Docs',
};
const appName = (s: string) => APPS[s.toLowerCase().replace(/^plugin_[^_]+_/, '')] ?? sentence(s.replace(/^plugin_[^_]+_/, ''));
export function mcpInfo(name: string, i: Record<string, unknown>) {
  if (isComputerUse(name)) return { app: 'Computer Use', action: computerUseAction(name, i) };
  const { server, tool } = mcpParts(name);
  const slug = str(i.tool_slug ?? i.slug ?? (tool === 'run_tool' ? i.tool : ''));
  if (slug && /^[A-Z0-9_]+$/.test(slug)) {
    const [app, ...rest] = slug.split('_');
    return { app: appName(app), action: sentence(rest.join('_').toLowerCase() || slug.toLowerCase()) };
  }
  return { app: appName(server), action: sentence(tool) };
}

/** A skill Canopy ships (its own plugin `canopy`, or Canopy Kit `canopy-kit`): its row carries the Canopy mark and a
 *  readable name ("Canopy Kit · Design Taste"), not the raw "canopy-kit:design-taste". Null for anyone else's skill. */
const CANOPY_PLUGINS: Record<string, string> = { canopy: 'Canopy', 'canopy-kit': 'Canopy Kit' };
export function canopySkill(i: Record<string, unknown>): { plugin: string; label: string } | null {
  const m = /^([a-z-]+):(.+)$/.exec(str(i.skill ?? i.command).trim());
  const plugin = m ? CANOPY_PLUGINS[m[1]] : undefined;
  if (!m || !plugin) return null;
  const label = m[2] === m[1] ? 'Guide' : m[2].split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return { plugin, label };
}
const skillName = (i: Record<string, unknown>) => { const c = canopySkill(i); return c ? `${c.plugin} · ${c.label}` : str(i.skill ?? i.command); };

export function toolSummary(name: string, i: Record<string, unknown>): string {
  if (isComputerUse(name)) return computerUseAction(name, i);
  if (isImageView(name, i)) return base(i.file_path) ?? '';
  switch (name) {
    case 'Bash': return str(i.command);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return str(i.file_path);
    case 'NotebookEdit': return str(i.notebook_path);
    case 'Grep': return `${str(i.pattern)}${i.path ? `  in ${str(i.path)}` : ''}`;
    case 'Glob': return str(i.pattern);
    case 'WebFetch': return str(i.url);
    case 'WebSearch': return str(i.query);
    case 'Task': case 'Agent': return str(i.description ?? i.prompt);
    case 'TodoWrite': { const n = (i.todos as unknown[] | undefined)?.length ?? 0; return `${n} item${n === 1 ? '' : 's'}`; }
    case 'Skill': return str(i.args).trim(); // the title already names it
    case 'Permissions': return [...paths(i.write), ...paths(i.read)].map(home).join('  ') || (i.network ? 'the network' : '');
    case 'ImageGeneration': return str(i.prompt);
    case CODE_TOOL: case SHOW_TOOL: return '';
    case GUIDE_TOOL: return Array.isArray(i.modules) ? i.modules.map(str).join(', ') : '';
    case READ_CHAT_TOOL: return str(i.chat).trim();
    case REMEMBER_TOOL: return str(i.title).trim() || str(i.note).trim();
    case RECALL_TOOL: return str(i.query).trim();
    case FORGET_TOOL: return str(i.note).trim();
    case SEND_TOOL: return str(i.summary).trim();
    case LOOK_TOOL: return [lookAt(i), !i.window && typeof i.width === 'number' ? `${i.width} wide` : '', i.fullPage === true ? 'full page' : ''].filter(Boolean).join('  ');
    default: {
      if (name.startsWith('mcp__')) {
        const args = (i.arguments && typeof i.arguments === 'object' ? i.arguments : i) as Record<string, unknown>;
        return Object.entries(args).filter(([k]) => !['tool_slug', 'slug', 'connected_account_id'].includes(k)).map(([, v]) => str(v)).join('  ').slice(0, 200);
      }
      return JSON.stringify(i);
    }
  }
}

export function toolTitle(name: string, i: Record<string, unknown>): string {
  if (isComputerUse(name)) return 'Computer Use';
  if (isImageView(name, i)) return 'View an image';
  switch (name) {
    case 'Bash': return 'Run command';
    case 'Read': return `Read ${base(i.file_path)}`;
    case 'Write': return `Write ${base(i.file_path)}`;
    case 'Edit': case 'MultiEdit': return `${i.deleted ? 'Delete' : 'Edit'} ${base(i.file_path)}`;
    case 'NotebookEdit': return `Edit ${base(i.notebook_path)}`;
    case 'Grep': return 'Search code';
    case 'Glob': return 'Find files';
    case 'WebFetch': { const h = host(i.url); return h ? `Read ${h}` : 'Read web page'; }
    case 'WebSearch': return 'Search the web';
    case 'Task': case 'Agent': return `Agent${i.subagent_type ? ` · ${str(i.subagent_type)}` : ''}`;
    case 'TodoWrite': return 'Update to-do list';
    case 'Skill': return canopySkill(i) ? skillName(i) : `Skill · ${skillName(i)}`;
    case 'BashOutput': return 'Check command output';
    case 'KillShell': case 'KillBash': return 'Stop command';
    case 'ExitPlanMode': return 'Present plan';
    case 'AskUserQuestion': return 'Ask a question';
    case 'ListMcpResourcesTool': return 'List MCP resources';
    case 'ReadMcpResourceTool': return 'Read MCP resource';
    case 'Permissions': return 'Ask for more access';
    case 'ImageGeneration': return 'Make an image';
    case CODE_TOOL: return codeTitle(i);
    case SHOW_TOOL: return str(i.title).trim() ? `Draw ${str(i.title).trim()}` : 'Draw a widget';
    case GUIDE_TOOL: return 'Read the widget guide';
    case LOOK_TOOL: return i.window ? 'Look at a window' : 'Look at a page';
    case READ_CHAT_TOOL: return str(i.chat).trim() ? 'Read another chat' : 'List your other chats';
    case REMEMBER_TOOL: return 'Save to memory';
    case RECALL_TOOL: return 'Check memory';
    case FORGET_TOOL: return 'Remove from memory';
    case SEND_TOOL: return str(i.message).trim() ? `Message ${chatName(i.to)}` : `Wait for ${chatName(i.to)}`;
    default: {
      if (name.startsWith('mcp__')) { const m = mcpInfo(name, i); return `${m.app} · ${m.action}`; }
      return sentence(name);
    }
  }
}

/** What Claude is doing right now, for the live "Worked for" line. Present participle, no ellipsis. */
export function toolActivity(name: string, i: Record<string, unknown>): string {
  if (isComputerUse(name)) return computerUseAction(name, i);
  if (isImageView(name, i)) return 'Viewing an image';
  switch (name) {
    case 'Bash': return 'Running a command';
    case 'Read': return `Reading ${base(i.file_path)}`;
    case 'Write': return `Writing ${base(i.file_path)}`;
    case 'Edit': case 'MultiEdit': return `${i.deleted ? 'Deleting' : 'Editing'} ${base(i.file_path)}`;
    case 'NotebookEdit': return `Editing ${base(i.notebook_path)}`;
    case 'Grep': return 'Searching the code';
    case 'Glob': return 'Finding files';
    case 'WebFetch': { const h = host(i.url); return h ? `Reading ${h}` : 'Reading a web page'; }
    case 'WebSearch': return 'Searching the web';
    case 'Task': case 'Agent': return 'Running an agent';
    case 'TodoWrite': return 'Updating the to-do list';
    case 'Skill': { const sk = skillName(i); return sk ? `Using ${sk}` : 'Working'; }
    case 'Permissions': return 'Asking for more access';
    case 'ImageGeneration': return 'Making an image';
    case CODE_TOOL: return str(i.description).trim() ? `Running: ${codeTitle(i)}` : 'Running a script';
    case SHOW_TOOL: return str(i.title).trim() ? `Drawing ${str(i.title).trim()}` : 'Drawing';
    case GUIDE_TOOL: return 'Getting ready to draw';
    case LOOK_TOOL: return lookAt(i) ? `Looking at ${lookAt(i)}` : 'Taking a screenshot';
    case READ_CHAT_TOOL: return str(i.chat).trim() ? 'Reading another chat' : 'Listing your other chats';
    case REMEMBER_TOOL: return 'Saving to memory';
    case RECALL_TOOL: return 'Checking memory';
    case FORGET_TOOL: return 'Removing from memory';
    case SEND_TOOL: return `Messaging ${chatName(i.to)}`;
    default: {
      if (name.startsWith('mcp__')) { const m = mcpInfo(name, i); return `${m.app} · ${m.action}`; }
      return 'Working';
    }
  }
}

/** The approval card's question: "Run this command?", "Edit App.tsx?". */
export function permTitle(name: string, i: Record<string, unknown>): string {
  if (isComputerUse(name)) return 'Use the computer?';
  if (isImageView(name, i)) return `View ${base(i.file_path)}?`;
  switch (name) {
    case 'Bash': return 'Run this command?';
    case 'Read': return `Read ${base(i.file_path)}?`;
    case 'Write': return `Write ${base(i.file_path)}?`;
    case 'Edit': case 'MultiEdit': return `${i.deleted ? 'Delete' : 'Edit'} ${base(i.file_path)}?`;
    case 'NotebookEdit': return `Edit ${base(i.notebook_path)}?`;
    case 'Grep': return 'Search the code?';
    case 'Glob': return 'Find these files?';
    case 'WebFetch': { const h = host(i.url); return h ? `Open ${h}?` : 'Open this web page?'; }
    case 'WebSearch': return 'Search the web?';
    case 'Task': case 'Agent': return 'Start an agent?';
    case 'Skill': { const sk = skillName(i); return sk ? `Use the ${sk} skill?` : 'Use a skill?'; }
    case 'Permissions': return 'Allow more access?';
    case 'ImageGeneration': return 'Make this image?';
    case CODE_TOOL: return 'Run this script?';
    case LOOK_TOOL: return lookAt(i) ? `Look at ${lookAt(i)}?` : 'Take a screenshot?';
    default: {
      if (name.startsWith('mcp__')) { const { server, tool } = mcpParts(name); return `Use ${server} · ${tool}?`; }
      return `Use ${name}?`;
    }
  }
}

function unifiedDiff(path: string, oldS: string, newS: string) {
  const p = structuredPatch(path, path, oldS, newS, '', '', { context: 3 });
  const out: string[] = [];
  for (const h of p.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    out.push(...h.lines);
  }
  return out.join('\n') || 'No changes';
}

function Code({ code, lang, copy = true }: { code: string; lang: BundledLanguage; copy?: boolean }) {
  return (
    <CodeBlock code={clip(code)} language={lang} className="text-code [&>div:last-child]:max-h-80">
      {copy && <CodeBlockCopyButton aria-label="Copy code" className="absolute top-1.5 right-1.5 z-10 size-6 rounded-sm text-muted-foreground opacity-0 transition-opacity duration-120 ease-out hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100" />}
    </CodeBlock>
  );
}

function Label({ children }: { children: string }) {
  return <div className="mb-1.5 text-label text-muted-foreground">{children}</div>;
}

/** Input preview: used inside tool cards and approval cards. */
export function ToolInputView({ name, input }: { name: string; input: Record<string, unknown> }) {
  if (isComputerUse(name)) {
    const args = input.arguments && typeof input.arguments === 'object' ? input.arguments as Record<string, unknown> : input;
    return typeof args.code === 'string' ? <Code code={args.code} lang="javascript" />
      : <p className="text-small text-muted-foreground">{computerUseAction(name, input)}</p>;
  }
  const file = str(input.file_path);
  switch (name) {
    case 'Bash':
      return (
        <div className="space-y-1.5">
          <Code code={str(input.command)} lang="bash" />
          {input.description ? <p className="text-small text-muted-foreground">{str(input.description)}</p> : null}
        </div>
      );
    case 'Edit': {
      // An OpenAI edit: the diff as it came. Its two sides are joined across hunks, so a diff rebuilt from them
      // would number the lines of a two-hunk edit wrongly.
      const diff = ownDiff(input);
      return <Code code={diff ? diff.replace(/\n+$/, '') : unifiedDiff(file, str(input.old_string), str(input.new_string))} lang="diff" />;
    }
    case 'MultiEdit':
      return (
        <div className="space-y-2">
          {/* The input is as the model wrote it: a list that came as a string (a step Claude Code then refused) draws nothing. */}
          {(Array.isArray(input.edits) ? input.edits : []).map((e, n) => (
            <Code key={n} code={unifiedDiff(file, str(e?.old_string), str(e?.new_string))} lang="diff" />
          ))}
        </div>
      );
    case 'Write':
      return <Code code={str(input.content)} lang={langFor(file)} />;
    case 'TodoWrite':
      return (
        <ul className="flex flex-col gap-1 text-ui">
          {/* Why the list changed, when the model said (an OpenAI chat's to-do list can carry it). */}
          {typeof input.explanation === 'string' && input.explanation.trim() && <li className="text-muted-foreground">{input.explanation}</li>}
          {(Array.isArray(input.todos) ? input.todos : []).map((t, n) => (
            <li key={n} className="flex items-start gap-2">
              {t?.status === 'completed' ? <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                : t?.status === 'in_progress' ? <CircleDotIcon className="mt-0.5 size-3.5 shrink-0 text-foreground" />
                : <CircleIcon className="mt-0.5 size-3.5 shrink-0 text-faint" />}
              <span className={t?.status === 'completed' ? 'text-muted-foreground line-through' : undefined}>{str(t?.content)}</span>
            </li>
          ))}
        </ul>
      );
    case 'Task': case 'Agent':
      return <AgentBrief prompt={str(input.prompt)} />;
    case CODE_TOOL:
      return <Code code={str(input.code)} lang="javascript" />;
    case 'Read': case 'Glob': case 'Grep':
      // An OpenAI chat reads and searches with shell commands: the step is named for what it did, and this is what ran.
      return typeof input.command === 'string' && input.command.trim() ? <Code code={input.command} lang="bash" /> : null;
    case 'WebFetch': case 'WebSearch': case 'ImageGeneration': case LOOK_TOOL:
      return null; // the summary line says it all
    case 'Permissions': {
      // More access than the chat has: one plain line for each thing asked, never the raw request.
      const write = paths(input.write), read = paths(input.read);
      return (
        <div className="space-y-1.5 text-ui">
          {input.reason ? <p className="text-small text-muted-foreground">{str(input.reason)}</p> : null}
          {write.length > 0 && <p>Change files in <code className="font-mono text-code text-muted-foreground">{write.map(home).join(', ')}</code></p>}
          {read.length > 0 && <p>Read files in <code className="font-mono text-code text-muted-foreground">{read.map(home).join(', ')}</code></p>}
          {input.network ? <p>Use the network</p> : null}
        </div>
      );
    }
    default:
      return <Code code={JSON.stringify(input, null, 2)} lang="json" />;
  }
}

/** Pictures a tool handed back (a look screenshot, an image it viewed): fitted in the step, full size on a click. */
function ResultImages({ images, label = 'Open screenshot' }: { images: Thumb[]; label?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const srcs = images.map((t) => `data:${t.mediaType};base64,${t.data}`);
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {srcs.map((src, n) => (
          <button key={n} type="button" onClick={() => setOpen(n)} aria-label={label} className="cursor-zoom-in overflow-hidden rounded-lg border border-hairline bg-muted">
            <img src={src} alt="" draggable={false} className="block max-h-72 max-w-full object-contain" />
          </button>
        ))}
      </div>
      <ImageViewer srcs={srcs} index={open} onIndex={setOpen} />
    </>
  );
}

/**
 * The picture a step viewed. The one the engine handed back when the chat still has it (a Claude chat keeps those of
 * its latest few steps); otherwise the file itself, read when the step is opened (Codex hands back no picture at all).
 */
function ViewedImage({ path, images }: { path: string; images?: Thumb[] }) {
  const [file, setFile] = useState<{ path: string; image: Thumb | null } | null>(null);
  const kept = !!images?.length;
  useEffect(() => {
    if (kept || !path || !api?.readImage) return;
    let live = true;
    const done = (image: Thumb | null) => { if (live) setFile({ path, image }); };
    api.readImage(path).then((r) => done(r && 'data' in r ? r : null), () => done(null));
    return () => { live = false; };
  }, [kept, path]);
  if (kept) return <ResultImages images={images!} label="Open image" />;
  if (!api?.readImage) return null;
  if (file?.path !== path) return null; // still reading it: a moment
  return file.image ? <ResultImages images={[file.image]} label="Open image" />
    : <p className="text-small text-muted-foreground">The image is no longer at <code className="font-mono text-code">{home(path)}</code>.</p>;
}

export function ToolResultView({ name, input, result, isError, images }: { name: string; input: Record<string, unknown>; result?: string; isError?: boolean; images?: Thumb[] }) {
  // The picture is the whole result: "[image]" in the text stands for it, so it is never shown as output too.
  if (isImageView(name, input) && !isError) return <ViewedImage path={str(input.file_path)} images={images} />;
  const shots = images?.length ? <ResultImages images={images} /> : null;
  if (name === LOOK_TOOL && !isError) {
    // The result is the picture and one line about it. "[image]" stands for the picture in the text: not shown twice.
    const caption = (result ?? '').replace(/^\[image\]\n?/, '').trim();
    // A chat that is opened again keeps the pictures of its latest few looks (adapter.mjs): say so under an older one.
    const older = !shots && /^\[image\]/.test(result ?? '');
    return shots || caption ? (
      <div className="flex flex-col gap-1.5">
        {shots}
        {caption && <p className="text-small text-muted-foreground">{caption}</p>}
        {older && <p className="text-small text-muted-foreground">Canopy keeps the screenshots of a chat's latest few looks. This one is older.</p>}
      </div>
    ) : null;
  }
  if (shots) return <div className="flex flex-col gap-2">{shots}<ToolResultView name={name} input={input} result={result} isError={isError} /></div>;
  if (!result?.trim()) return null;
  if (name === 'TodoWrite' || (name === 'Edit' && !isError) || (name === 'MultiEdit' && !isError) || (name === 'Write' && !isError)) return null;
  if (name === 'Task' || name === 'Agent') {
    // A background agent's "result" is Claude Code's internal receipt (ids, "never quote this"): not for people.
    if (/^Async agent launched/i.test(result.trim())) return <p className="text-small text-muted-foreground">Running in the background. Its answer comes back to Canopy when it's done.</p>;
    return (<div><Label>Answer</Label><div className="prose-reply prose-compact"><MessageResponse>{clip(result)}</MessageResponse></div></div>);
  }
  if (name === CODE_TOOL) {
    const r = codeResult(result);
    const text = 'text' as BundledLanguage;
    return (
      <div className="flex flex-col gap-2">
        {r.error && <div><Label>Error</Label><Code code={r.error} lang={text} /></div>}
        {r.logs && <div><Label>Logs</Label><Code code={r.logs} lang={text} /></div>}
        {r.value && <div><Label>{isError ? 'Error' : 'Result'}</Label><Code code={r.value.text} lang={r.value.lang} /></div>}
      </div>
    );
  }
  const lang: BundledLanguage = name === 'Read' ? langFor(input.file_path) : ('text' as BundledLanguage);
  const text = name === 'Read' ? result.replace(/^\s*\d+→/gm, '') : result;
  return (
    <div>
      <Label>{isError ? 'Error' : 'Output'}</Label>
      <Code code={text} lang={lang} />
    </div>
  );
}

/** Lines added/removed by an edit tool call, for change chips and the Changes tab. */
export function editStats(name: string, input: Record<string, unknown>): { file: string; add: number; del: number } | null {
  const file = str(input.file_path);
  if (!file) return null;
  const count = (oldS: string, newS: string) => {
    let add = 0, del = 0;
    for (const h of structuredPatch(file, file, oldS, newS, '', '', { context: 0 }).hunks) {
      for (const l of h.lines) { if (l[0] === '+') add++; else if (l[0] === '-') del++; }
    }
    return { add, del };
  };
  const diff = ownDiff(input);
  if (name === 'Edit' && diff) return { file, ...diffStats(diff) }; // an OpenAI edit: its own "+" and "-" lines
  if (name === 'Edit') return { file, ...count(str(input.old_string), str(input.new_string)) };
  if (name === 'MultiEdit') {
    let add = 0, del = 0;
    for (const e of Array.isArray(input.edits) ? input.edits : []) { const c = count(str(e?.old_string), str(e?.new_string)); add += c.add; del += c.del; }
    return { file, add, del };
  }
  if (name === 'Write') return { file, add: str(input.content).split('\n').length, del: 0 };
  return null;
}
export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

/** What Claude asked a helper agent to do: two lines, with the rest one click away. */
function AgentBrief({ prompt }: { prompt: string }) {
  const [open, setOpen] = useState(false);
  if (!prompt.trim()) return null;
  return (
    <div>
      <Label>Asked to</Label>
      <div className={cn('prose-reply prose-compact text-muted-foreground', !open && 'line-clamp-2')}><MessageResponse>{prompt}</MessageResponse></div>
      {prompt.length > 160 && <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-small text-faint hover:text-foreground">{open ? 'Show less' : 'Show all'}</button>}
    </div>
  );
}
