import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge Canopy's type scale and easings (index.css @theme), or
// cn('text-ui text-muted-foreground') would silently drop the size.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['display', 'title', 'heading', 'body', 'ui', 'small', 'label', 'micro', 'code'],
      ease: ['out-quint', 'drawer', 'loop'],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
