// Images you attached, shown as thumbnails above your message (like Messages / ChatGPT).
// Click one to see it full size in a pop-up; ← → move between them, Esc closes.
import { useEffect, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export type Thumb = { mediaType: string; data: string };
const src = (t: Thumb) => `data:${t.mediaType};base64,${t.data}`;

export function MessageImages({ images, className }: { images: Thumb[]; className?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!images.length) return null;
  return (
    <>
      <div className={cn('flex flex-wrap justify-end gap-1.5', className)}>
        {images.map((t, i) => (
          <button key={i} onClick={() => setOpen(i)} aria-label={`Open image ${i + 1}`}
            className="size-[104px] cursor-zoom-in overflow-hidden rounded-xl border border-hairline bg-muted transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.98]">
            {/* Every attachment the same square, however many and whatever their shape; the full image is a click away. */}
            <img src={src(t)} alt="" draggable={false} className="block size-full object-cover" />
          </button>
        ))}
      </div>
      <ImageViewer srcs={images.map(src)} index={open} onIndex={setOpen} />
    </>
  );
}

/** Full-size viewer for a set of images (data or blob URLs): ← → between them, Esc closes. Centered over the chat. */
export function ImageViewer({ srcs: images, index, onIndex }: { srcs: string[]; index: number | null; onIndex: (i: number | null) => void }) {
  const many = images.length > 1;
  useEffect(() => {
    if (index == null || !many) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') onIndex((index + 1) % images.length);
      if (e.key === 'ArrowLeft') onIndex((index - 1 + images.length) % images.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, many, images.length, onIndex]);
  const btn = 'flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground';
  return (
    <Dialog open={index != null} onOpenChange={(o) => !o && onIndex(null)}>
      {/* One standard frame for every image: big, centered in the window. The image fills it (fitted, never cropped);
          close, arrows and the counter live in the frame's margins, never on the picture. */}
      <DialogContent showCloseButton={false}
        className="flex h-[min(82vh,820px)] w-[min(1100px,calc(100vw-64px))] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none">
        <DialogTitle className="sr-only">Image</DialogTitle>
        <DialogDescription className="sr-only">Attached image, full size</DialogDescription>
        <div className="flex h-12 shrink-0 items-center justify-between px-3">
          <span className="pl-2 text-small text-faint tabular-nums">{many && index != null ? `${index + 1} / ${images.length}` : ''}</span>
          <button onClick={() => onIndex(null)} aria-label="Close" className={btn}><XIcon className="size-4" /></button>
        </div>
        {index != null && (
          <div className="relative flex min-h-0 flex-1 items-center justify-center px-14 pb-12">
            <img src={images[index]} alt="" className="size-full object-contain" draggable={false} />
            {many && (
              <>
                <button onClick={() => onIndex((index - 1 + images.length) % images.length)} aria-label="Previous" className={`${btn} absolute top-1/2 left-3 -translate-y-1/2`}><ChevronLeftIcon className="size-4" /></button>
                <button onClick={() => onIndex((index + 1) % images.length)} aria-label="Next" className={`${btn} absolute top-1/2 right-3 -translate-y-1/2`}><ChevronRightIcon className="size-4" /></button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
