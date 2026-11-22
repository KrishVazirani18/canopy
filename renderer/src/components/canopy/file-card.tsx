// An attached file (a PDF, a spreadsheet, a folder) as a card: a preview on the left, its name and kind on the right.
// Used in the message box beside image thumbnails and pasted text, and above your sent message. Click opens it;
// ⌥-click shows it in Finder.
//
// The preview is the one Finder shows (Quick Look, asked of main: a PDF's first page, a document, a picture). Until it
// comes, or when there is none, a plain tile with the kind's own icon stands in. No colour: kinds differ by icon and label.
import { useEffect, useState } from 'react';
import { FileArchiveIcon, FileAudioIcon, FileCodeIcon, FileIcon, FileImageIcon, FileSpreadsheetIcon, FileTextIcon, FileVideoIcon, PresentationIcon, XIcon, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { fileLabel } from '@/lib/file-mentions';
import { cn } from '@/lib/utils';

// `preview`: Quick Look draws something worth seeing. A CSV, plain text or code comes back a near-blank page, so
// those keep the tile.
type Kind = { icon: LucideIcon; word?: string; preview?: boolean };
const KINDS: [string[], Kind][] = [
  [['PDF'], { icon: FileTextIcon, word: 'PDF', preview: true }],
  [['DOC', 'DOCX', 'PAGES', 'RTF', 'ODT'], { icon: FileTextIcon, word: 'Document', preview: true }],
  [['TXT', 'MD', 'MARKDOWN'], { icon: FileTextIcon, word: 'Text' }],
  [['XLS', 'XLSX', 'NUMBERS', 'ODS'], { icon: FileSpreadsheetIcon, word: 'Spreadsheet', preview: true }],
  [['CSV', 'TSV'], { icon: FileSpreadsheetIcon, word: 'Spreadsheet' }],
  [['PPT', 'PPTX', 'KEY', 'ODP'], { icon: PresentationIcon, word: 'Presentation', preview: true }],
  [['ZIP', 'TAR', 'GZ', 'TGZ', 'RAR', '7Z', 'DMG'], { icon: FileArchiveIcon, word: 'Archive' }],
  [['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'HEIC', 'SVG', 'TIFF', 'BMP'], { icon: FileImageIcon, word: 'Image', preview: true }],
  [['MP3', 'WAV', 'M4A', 'AAC', 'FLAC', 'OGG'], { icon: FileAudioIcon, word: 'Audio' }],
  [['MP4', 'MOV', 'M4V', 'WEBM', 'MKV', 'AVI'], { icon: FileVideoIcon, word: 'Video', preview: true }],
  [['JS', 'TS', 'TSX', 'JSX', 'MJS', 'CJS', 'PY', 'RB', 'GO', 'RS', 'JAVA', 'C', 'H', 'CPP', 'SWIFT', 'KT', 'SH', 'JSON', 'YAML', 'YML', 'TOML', 'HTML', 'CSS', 'SQL', 'IPYNB'],
    { icon: FileCodeIcon }],
];
const kindOf = (ext: string): Kind => KINDS.find(([exts]) => exts.includes(ext))?.[1] ?? { icon: FileIcon };

// Previews already drawn, by path, so a card that mounts again (the sent message, a re-render) shows it at once.
const seen = new Map<string, string | null>();

export function FileCard({ path, cwd, onRemove, className }: { path: string; cwd?: string | null; onRemove?: () => void; className?: string }) {
  const { name, kind: ext } = fileLabel(path);
  const kind = kindOf(ext);
  const Icon = kind.icon;
  const [thumb, setThumb] = useState<string | null>(() => seen.get(path) ?? null);
  useEffect(() => {
    if (!kind.preview) return;
    if (seen.has(path)) { setThumb(seen.get(path) ?? null); return; }
    let live = true;
    void api.fileThumb?.(path, cwd).then((url) => { seen.set(path, url ?? null); if (live) setThumb(url ?? null); }).catch(() => {});
    return () => { live = false; };
  }, [path, cwd, kind.preview]);
  const open = async (reveal: boolean) => {
    const r = await api.openPath(path, cwd, reveal);
    if (!r.ok) toast(r.missing ? `${name} isn't there anymore.` : `Couldn't open ${name}.`);
  };
  return (
    <div role="button" tabIndex={0} title={path} aria-label={`Open ${name}`}
      onClick={(e) => void open(e.altKey)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void open(false); } }}
      className={cn('group relative flex h-20 w-60 min-w-0 shrink-0 cursor-pointer items-center gap-3 rounded-lg border border-border bg-muted/60 pr-3 pl-2 text-left enter-fade [animation-duration:160ms] hover:bg-muted', className)}>
      <span className={cn('relative flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md', !thumb && 'bg-background/70 text-muted-foreground')}>
        {thumb
          ? <img src={thumb} alt="" draggable={false} className="size-full border border-black/10 bg-white object-cover object-top dark:border-white/10" />
          : <Icon className="size-5" strokeWidth={1.75} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 text-small leading-[17px] font-medium break-all text-foreground">{name}</span>
        <span className="flex items-center gap-1.5 text-[11px] leading-none text-faint">
          <span className="rounded-[3px] border border-border px-1 py-[2px] text-[10px] font-semibold tracking-[0.02em] text-muted-foreground">{ext === 'File' ? 'FILE' : ext}</span>
          {kind.word && kind.word !== ext && <span className="truncate">{kind.word}</span>}
        </span>
      </span>
      {onRemove && (
        <button type="button" aria-label={`Remove ${name}`} onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity duration-120 ease-out hover:bg-black/85 group-hover:opacity-100 focus-visible:opacity-100">
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );
}
