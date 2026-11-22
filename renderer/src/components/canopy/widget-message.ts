// What a widget's answer (`ui/message`) may carry, checked before it becomes the user's next message. The content is
// one text block, or a list of blocks: text, and up to four pictures (PNG or JPEG, base64, at most 5 MB each), which
// become the message's attachments exactly as if they had been pasted. Anything else refuses the whole answer.
// No DOM and no React here, so node tests import this file as it is (src/core/test/unit/widget-message.test.mjs).

export const MAX_ANSWER = 4000;           // characters of one answer
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg'];
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type AnswerImage = { mediaType: string; data: string; name?: string };
export type Answer = { text: string; images: AnswerImage[] } | { error: string };

/** The bytes a base64 string holds. */
export const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

/** Read a `ui/message`'s params: the words and pictures in it, or why it is refused. */
export function readAnswer(params: Record<string, unknown> | null | undefined): Answer {
  const p = params ?? {};
  if (p.role !== 'user') return { error: 'Invalid message format' };
  const raw = p.content;
  const blocks = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  if (!blocks.length) return { error: 'Invalid message format' };
  const words: string[] = [];
  const images: AnswerImage[] = [];
  for (const b of blocks as Record<string, unknown>[]) {
    if (!b || typeof b !== 'object') return { error: 'Invalid message format' };
    if (b.type === 'text') {
      if (typeof b.text !== 'string') return { error: 'Invalid message format' };
      if (b.text.trim()) words.push(b.text.trim());
    } else if (b.type === 'image') {
      const mime = typeof b.mimeType === 'string' ? b.mimeType.toLowerCase() : '';
      const data = typeof b.data === 'string' ? b.data.replace(/\s+/g, '') : '';
      if (!TYPES.includes(mime)) return { error: 'Only PNG and JPEG pictures can be sent' };
      if (!data || data.length % 4 !== 0 || !BASE64.test(data)) return { error: 'A picture was not valid base64' };
      if (base64Bytes(data) > MAX_IMAGE_BYTES) return { error: 'A picture was larger than 5 MB' };
      if (images.length >= MAX_IMAGES) return { error: `At most ${MAX_IMAGES} pictures can be sent` };
      images.push({ mediaType: mime, data });
    } else return { error: 'Invalid message format' };
  }
  const text = words.join('\n\n').slice(0, MAX_ANSWER);
  if (!text) return { error: 'Invalid message format' };
  return { text, images };
}
