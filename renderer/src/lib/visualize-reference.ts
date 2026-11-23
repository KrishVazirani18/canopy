import type { Root } from 'mdast';

const START = 'visualize';
const END = '';

export function absoluteReplyPath(path: string): boolean {
  return /^\/[^/]/u.test(path) && !/[\\\u0000-\u001f\u007f]/u.test(path);
}

// Codex's Visualize skill emits a standalone reference to an HTML file. Turn it into a normal
// link in the reply, at the same position. Markdown code and quoted examples stay as written.
export function remarkVisualizeReferences() {
  return (root: Root, file: { value: unknown }) => {
    if (typeof file.value !== 'string' || !file.value.includes(START)) return;
    for (const part of root.children) {
      if (part.type !== 'paragraph' || !part.position) continue;
      const { start, end } = part.position;
      const raw = file.value.slice(start.offset, end.offset).trim();
      if (!raw.startsWith(START) || !raw.endsWith(END) || raw.includes('\n')) continue;
      try {
        const ref: unknown = JSON.parse(raw.slice(START.length, -END.length));
        if (!ref || typeof ref !== 'object' || !('path' in ref) || typeof ref.path !== 'string') continue;
        if (!absoluteReplyPath(ref.path) || !/\.html?$/i.test(ref.path)) continue;
        const title = 'title' in ref && typeof ref.title === 'string' ? ref.title.trim() : '';
        part.children = [{
          type: 'link',
          url: ref.path.split('/').map(encodeURIComponent).join('/'),
          children: [{ type: 'text', value: title ? `Open ${title}` : 'Open visualization' }],
        }];
      } catch { /* Keep malformed references as written. */ }
    }
  };
}
