// Settings → Memory: what Canopy remembers, in one page of its own.
//
// Canopy Memory is short notes a chat saves for the chats after it (src/core/memory-store.mjs): things you said you
// want by default, corrections you made, facts about a project a chat confirmed. Your Claude and Codex chats share
// them. The page reads top to bottom: the switch, the notes (about you first, then each project's), and sharing.
//
// Each note is one row that says the note itself, who it came from and when. Editing opens a small window over the
// page, so nothing on it moves; a deleted note keeps its row, says Deleted and offers Undo, for the same reason.
//
// Sharing is apart from the notes: Claude Code and Codex each keep a memory of their own, and with it on each one's
// chats are shown the other's. That sends one maker's notes about you to the other maker, and the page says so.
import { useCallback, useEffect, useState } from 'react';
import { BookmarkIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api, type MemoryNote } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button, IconButton, Page, Row, Section, Switch } from './kit';

const LIMIT = 600; // characters of one note (MEMORY_LIMITS.text in memory-store.mjs)
const base = (p: string | null) => (p ?? '').split('/').filter(Boolean).pop() ?? '';
const day = (ms: number) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });

/** Whether memory is on, and how many notes there are (for a summary elsewhere). */
export function useMemorySummary() {
  const [state, setState] = useState<{ on: boolean; count: number } | null>(null);
  useEffect(() => {
    let live = true;
    if (typeof api?.memory?.get !== 'function') return;
    Promise.all([api.memory.get(), api.memory.list()]).then(([g, l]) => {
      if (live && g && 'on' in g) setState({ on: g.on, count: l && 'notes' in l ? l.notes.length : 0 });
    }, () => {});
    return () => { live = false; };
  }, []);
  return state;
}

/** Editing a note, in a small window over the page: the page itself never changes size. */
function EditNote({ note, onDone }: { note: MemoryNote | null; onDone: (saved: MemoryNote | null) => void }) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setText(note?.text ?? ''); setProblem(null); }, [note]);
  const save = async () => {
    if (!note || !api?.memory) return;
    setBusy(true); setProblem(null);
    const r = await api.memory.edit(note.id, { title: note.title, text }).catch(() => ({ error: 'Couldn’t save the note.' }));
    setBusy(false);
    if (!r || 'error' in r) setProblem(r?.error ?? 'Couldn’t save the note.'); else onDone(r.note);
  };
  return (
    <Dialog open={!!note} onOpenChange={(o) => { if (!o) onDone(null); }}>
      <DialogContent className="gap-0 p-5 sm:max-w-md">
        <DialogTitle className="text-ui font-medium">Edit note</DialogTitle>
        <DialogDescription className="mt-1 text-small text-muted-foreground">New chats start out knowing this.</DialogDescription>
        <textarea value={text} onChange={(e) => setText(e.target.value)} aria-label="Note" rows={5} maxLength={LIMIT} autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) void save(); }}
          className="mt-4 block w-full resize-none rounded-lg border border-hairline bg-background px-3 py-2 text-ui leading-relaxed outline-none placeholder:text-faint focus:border-foreground/30" />
        {note?.replaced && <p className="mt-2 truncate text-small text-faint" title={note.replaced}>Before: {note.replaced}</p>}
        <div className="mt-4 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-small text-faint">{problem ?? `${text.trim().length} / ${LIMIT}`}</span>
          <Button onClick={() => onDone(null)}>Cancel</Button>
          <Button primary busy={busy} disabled={!text.trim()} onClick={save}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Nothing saved yet: what memory is, and how a note gets here. */
function NothingYet() {
  return (
    <Section>
      <div className="flex flex-col items-center px-6 py-9 text-center">
        <span className="mb-3 flex size-10 items-center justify-center rounded-xl bg-accent text-muted-foreground"><BookmarkIcon className="size-[18px]" /></span>
        <p className="text-ui text-foreground">Nothing remembered yet</p>
        <p className="mt-1 max-w-xs text-small text-muted-foreground">Tell any chat something lasting, like “keep answers short”, and it shows up here for every chat after.</p>
      </div>
    </Section>
  );
}

export function MemoryPage() {
  const [on, setOn] = useState<boolean | null>(null);
  const [bridge, setBridge] = useState(true);
  const [notes, setNotes] = useState<MemoryNote[] | null>(null);
  const [folder, setFolder] = useState('');
  const [editing, setEditing] = useState<MemoryNote | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set()); // notes deleted while the page is open: their rows stay, with Undo
  const load = useCallback(async () => {
    if (typeof api?.memory?.list !== 'function') { setNotes([]); setOn(false); return; }
    const [g, l] = await Promise.all([api.memory.get(), api.memory.list()]).catch(() => [null, null] as const);
    setOn(g && 'on' in g ? g.on : false);
    if (g && 'on' in g) setBridge(g.bridge === true);
    if (l && 'notes' in l) { setNotes(l.notes); setFolder(l.folder); } else setNotes([]);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const flip = (v: boolean) => { setOn(v); void api?.memory?.set(v).then((r) => { if (r && 'on' in r) setOn(r.on); }); };
  const flipBridge = (v: boolean) => { setBridge(v); void api?.memory?.bridge?.(v).then((r) => { if (r && 'on' in r) setBridge(r.bridge === true); }); };
  const remove = async (n: MemoryNote) => {
    const r = await api?.memory?.remove(n.id);
    if (r && 'ok' in r && r.ok) setRemoved((was) => new Set(was).add(n.id));
  };
  const undo = async (n: MemoryNote) => {
    const r = await api?.memory?.restore(n.id);
    if (r && 'note' in r && r.note) setRemoved((was) => { const next = new Set(was); next.delete(n.id); return next; });
  };

  const me = (notes ?? []).filter((n) => n.scope === 'me');
  const projects = new Map<string, MemoryNote[]>();
  for (const n of notes ?? []) if (n.scope === 'project' && n.project) projects.set(n.project, [...(projects.get(n.project) ?? []), n]);
  // One row per note, the same height whatever it says: the note, then who it came from and when.
  const row = (n: MemoryNote) => {
    const gone = removed.has(n.id);
    const from = n.source === 'user-said' ? 'You said' : 'Learned in a chat';
    return (
      <Row key={n.id} muted={gone} title={n.replaced ? `${n.text}\n\nBefore: ${n.replaced}` : n.text}
        label={<span className={cn(gone && 'line-through decoration-faint/60')}>{n.text}</span>}
        detail={gone ? 'Deleted' : <>{from}<span className="text-faint">·</span>{n.replaced ? 'Changed ' : ''}{day(n.updated)}</>}>
        {gone
          ? <Button onClick={() => void undo(n)}>Undo</Button>
          : <>
              <IconButton label="Edit" onClick={() => setEditing(n)}><PencilIcon /></IconButton>
              <IconButton label="Delete" onClick={() => void remove(n)}><Trash2Icon /></IconButton>
            </>}
      </Row>
    );
  };
  const count = (notes?.length ?? 0) - removed.size;
  return (
    <Page title="Memory"
      actions={
        <label className="flex items-center gap-2 text-small text-muted-foreground" title="A chat keeps what it started with, so the switch is for new chats.">
          {on === false ? 'Off' : 'On'}
          <Switch label="Remember across chats" on={on ?? true} onChange={flip} disabled={on === null} />
        </label>
      }>
      {/* What memory is, in a line; the notes are the page. */}
      <p className="-mt-2 text-ui text-muted-foreground">
        {on === false ? 'Memory is off. New chats start fresh and remember nothing.' : 'What your Claude and Codex chats remember about you and your projects.'}
      </p>
      {notes && !notes.length && <NothingYet />}
      {notes && notes.length > 0 && (
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[15px] font-medium text-foreground">{count} {count === 1 ? 'memory' : 'memories'}</h3>
          {folder && <button type="button" onClick={() => void api.reveal(folder)} title={folder.replace(/^\/Users\/[^/]+/, '~')}
            className="text-small text-muted-foreground hover:text-foreground">Show in Finder</button>}
        </div>
      )}
      {me.length > 0 && <Section title="About you" count={me.length}>{me.map(row)}</Section>}
      {[...projects].map(([project, list]) => (
        <Section key={project} title={base(project) || project} count={list.length}>{list.map(row)}</Section>
      ))}
      {/* Apart from the notes: it sends what Claude Code noted about you to OpenAI, and what Codex noted to Anthropic.
          Pointing at the row says so in full. */}
      <Section title="Sharing">
        <Row label="Also use Claude Code’s and Codex’s own memory" muted={on === false}
          title="Claude Code and Codex each keep notes of their own about you. With this on, a new Claude chat is also shown Codex’s notes, and a new Codex chat Claude Code’s. That sends what Claude Code noted about you to OpenAI and what Codex noted to Anthropic. Turn it off to keep each maker’s notes to itself."
          detail={on === false ? 'Needs memory on' : 'Each one’s chats see the other’s notes'}>
          <Switch label="Share Claude Code’s and Codex’s own memory with each other" on={bridge} onChange={flipBridge} disabled={on !== true} />
        </Row>
      </Section>
      <EditNote note={editing} onDone={(saved) => { setEditing(null); if (saved) setNotes((list) => (list ?? []).map((x) => (x.id === saved.id ? saved : x))); }} />
    </Page>
  );
}
