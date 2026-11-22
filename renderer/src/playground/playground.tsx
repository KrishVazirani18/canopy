// Playground: for designing Canopy itself (opened with ⌘⇧P). Each mock in ./mocks is a real
// Canopy screen built from the app's own components with sample data, so a design is seen at true size, type and
// motion, not as a web imitation. Edits hot-reload, and the Playground stays open (and on the same mock) across reloads.
import { useState } from 'react';
import { XIcon } from 'lucide-react';
import { ui } from '@/lib/ui';
import { cn } from '@/lib/utils';

type Mock = { title: string; note?: string; default: () => React.ReactNode };
const mods = import.meta.glob('./mocks/*.tsx', { eager: true }) as Record<string, Mock>;
const MOCKS = Object.entries(mods).map(([path, m]) => ({ id: path.replace(/^.*\/|\.tsx$/g, ''), ...m })).sort((a, b) => a.id.localeCompare(b.id));
const KEY = 'canopy.playground';

/** One mock alone, filling the window with no Playground bar (?mock=<id>), for showing it as it would really appear. */
export function BareMock({ id }: { id: string }) {
  const Body = MOCKS.find((m) => m.id === id)?.default;
  return <div className="relative h-screen w-screen overflow-hidden bg-background text-foreground">{Body ? <Body /> : null}</div>;
}

export function Playground() {
  const [id, setId] = useState(() => localStorage.getItem(KEY) ?? MOCKS[0]?.id ?? '');
  const pick = (next: string) => { setId(next); localStorage.setItem(KEY, next); };
  const mock = MOCKS.find((m) => m.id === id) ?? MOCKS[0];
  const Body = mock?.default;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-hairline bg-sidebar px-3">
        <span className="mr-2 text-small font-semibold text-brand">Playground</span>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {MOCKS.map((m) => (
            <button key={m.id} onClick={() => pick(m.id)}
              className={cn('h-7 shrink-0 rounded-md px-2.5 text-small transition-colors', m.id === mock?.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>{m.title}</button>
          ))}
        </div>
        {mock?.note && <span className="hidden max-w-[40%] truncate text-small text-faint lg:block" title={mock.note}>{mock.note}</span>}
        <button onClick={() => ui.set({ view: 'chat' })} className="ml-2 flex h-7 items-center gap-1 rounded-md px-2 text-small text-muted-foreground hover:bg-accent hover:text-foreground">
          <XIcon className="size-3.5" />Exit
        </button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">{Body ? <Body /> : <p className="p-8 text-faint">No mocks yet.</p>}</div>
    </div>
  );
}
