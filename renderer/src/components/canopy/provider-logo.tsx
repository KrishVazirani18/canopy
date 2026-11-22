// The maker's mark beside an account (Claude, Codex), used only to say whose account it is: the accounts in Settings
// (on the Claude Code and Codex pages), the Usage tab, the signed-out prompt and the sign-in sheets. Never as
// Canopy's own mark.
//
// The same marks the model menu and the Settings list use (maker-logo.tsx): Claude's spark, in Claude's clay, and
// OpenAI's blossom, in the text colour. Drawn bare, the way other apps that run these agents show them, a little
// under the footprint so a row's mark sits like an icon rather than a tile.
import { ClaudeLogo, OpenAILogo } from './maker-logo';
import { cn } from '@/lib/utils';

export type Maker = 'claude' | 'codex';
const NAME: Record<Maker, string> = { claude: 'Claude', codex: 'Codex' };
const CLAY = '#D97757'; // the spark's own colour

/** The maker's mark in a square of `size` px (the footprint every caller lays out by). */
export function ProviderLogo({ engine, size = 32, className }: { engine: Maker; size?: number; className?: string }) {
  const mark = Math.round(size * 0.72 * 10) / 10;
  const Mark = engine === 'codex' ? OpenAILogo : ClaudeLogo;
  return (
    <span role="img" aria-label={NAME[engine]} className={cn('flex shrink-0 select-none items-center justify-center', className)} style={{ width: size, height: size }}>
      <span className={cn('flex', engine === 'codex' && 'text-foreground')} style={{ width: mark, height: mark, ...(engine === 'claude' && { color: CLAY }) }}>
        <Mark className="size-full" />
      </span>
    </span>
  );
}
