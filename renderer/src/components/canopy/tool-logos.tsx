import { createContext, useContext, useState, useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import { PlugIcon } from 'lucide-react';
import { StoreContext, type CodeCall, type ToolItem } from '@/lib/store';
import { brandKey, chooseIcon, type ToolIcon } from '@/lib/tool-branding';
import { cn } from '@/lib/utils';
import { isComputerUse } from '@/lib/computer-use';
import { CODE_TOOL, FORGET_TOOL, GUIDE_TOOL, LOOK_TOOL, READ_CHAT_TOOL, RECALL_TOOL, REMEMBER_TOOL, SHOW_TOOL, TASK_TOOL, canopySkill, mcpInfo } from './tool-details';
import { SEND_TOOL } from './chat-text';
import { Logo } from './logo';

type Step = Pick<ToolItem | CodeCall, 'name' | 'input' | 'icons'> & { calls?: CodeCall[] };
const INTERNAL = new Set([CODE_TOOL, FORGET_TOOL, GUIDE_TOOL, LOOK_TOOL, READ_CHAT_TOOL, RECALL_TOOL, REMEMBER_TOOL, SHOW_TOOL, TASK_TOOL]);
// Canopy's own tools and skills carry the Canopy mark. Not a Code Mode script (its row shows the apps it called) and
// not a widget (drawn in place, no row).
const CANOPY_TOOLS = new Set([FORGET_TOOL, GUIDE_TOOL, LOOK_TOOL, READ_CHAT_TOOL, RECALL_TOOL, REMEMBER_TOOL, SEND_TOOL]);
const isCanopy = (t: Step) => CANOPY_TOOLS.has(t.name) || (t.name === 'Skill' && !!canopySkill(t.input));
const CANOPY = 'Canopy';
/** True inside a task card, whose title row already carries the Canopy mark: the step lines under it don't repeat it. */
export const InTaskCard = createContext(false);

function Mark({ icons, app }: { icons: ToolIcon[]; app: string }) {
  if (app === CANOPY) return <span title={app} className="flex size-3.5 shrink-0 items-center justify-center" data-tool-logo={app}><Logo className="size-3.5 text-brand" /></span>;
  return <AppMark icons={icons} app={app} />;
}

function AppMark({ icons, app }: { icons: ToolIcon[]; app: string }) {
  const { resolvedTheme } = useTheme();
  const [failed, setFailed] = useState<string[]>([]);
  const src = chooseIcon(icons, resolvedTheme === 'dark', failed);
  return <span title={app} className="flex size-3.5 shrink-0 items-center justify-center" data-tool-logo={app}>
    {src ? <img src={src} alt="" aria-hidden draggable={false} referrerPolicy="no-referrer"
      className="size-full rounded-[3px] bg-white p-px object-contain" onError={() => setFailed((old) => old.includes(src) ? old : [...old, src])} />
      : <PlugIcon aria-hidden className="size-3.5 text-faint" />}
  </span>;
}

/** Small, deduplicated app marks: a call, a group of calls, or a whole finished turn. */
export function ToolLogos({ tools, className }: { tools: Step[]; className?: string }) {
  const store = useContext(StoreContext);
  const inCard = useContext(InTaskCard);
  useSyncExternalStore(store.subscribe, () => store.brandVersion);
  const apps = new Map<string, { app: string; icons: ToolIcon[] }>();
  function add(t: Step) {
    for (const call of t.calls ?? []) add(call);
    if (isCanopy(t)) { if (!inCard && !apps.has(CANOPY)) apps.set(CANOPY, { app: CANOPY, icons: [] }); return; }
    if (!t.name.startsWith('mcp__') || INTERNAL.has(t.name) || isComputerUse(t.name)) return;
    const { app } = mcpInfo(t.name, t.input);
    const key = brandKey(app);
    const server = brandKey(t.name.split('__')[1] ?? '');
    // A tool's own icon wins, followed by its app catalog and its server's identity.
    // An unrelated gateway's mark never stands in for a known underlying app.
    const icons = t.icons?.length ? t.icons : store.brands[brandKey(t.name)] ?? store.brands[key]
      ?? (key === server ? store.brands[server] : undefined) ?? [];
    const previous = apps.get(key);
    if (!previous || icons.length) apps.set(key, { app, icons });
    // Composio batches can name several underlying apps inside one outer tool call.
    if (Array.isArray(t.input.tools)) for (const call of t.input.tools.slice(0, 50)) {
      if (call && typeof call === 'object' && typeof call.tool_slug === 'string') add({ name: t.name, input: call });
    }
  }
  for (const tool of tools) add(tool);
  if (!apps.size) return null;
  const marks = [...apps.values()];
  return <span aria-hidden className={cn('inline-flex shrink-0 items-center gap-1.5', className)}>
    {marks.slice(0, 3).map((mark) => <Mark key={mark.app} {...mark} />)}
    {marks.length > 3 && <span className="text-[10px] text-faint" title={marks.slice(3).map((m) => m.app).join(', ')}>+{marks.length - 3}</span>}
  </span>;
}
