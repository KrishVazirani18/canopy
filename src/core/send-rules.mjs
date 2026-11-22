// What a message may be, whichever maker's chat it is sent in: text of a bounded length, a bounded number of images
// of the kinds both makers take, and options that say what they mean. Session and CodexSession both ask here, so a
// limit can never let a message through in one maker's chats that the other refuses.

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_TEXT = 1024 * 1024;
const MAX_IMAGES = 20;
const MAX_IMAGE_B64 = 7_000_000; // about 5 MB of image, the API limit
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);
export const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

/**
 * Why a message cannot be sent, as `{ code: 'invalid-input', message }` in words for a person, or null when it can.
 * `priorities`: the values `opts.priority` may take in this maker's chats (a Claude chat has three; a Codex chat has
 * none, and there the option is not looked at).
 */
export function checkMessage(text, images, opts, { priorities = null } = {}) {
  const bad = (message) => ({ code: 'invalid-input', message });
  if (typeof text !== 'string') return bad('The message must be text.');
  if (text.length > MAX_TEXT) return bad('That message is too long to send.');
  if (!Array.isArray(images)) return bad('Attachments must be a list of images.');
  if (images.length > MAX_IMAGES) return bad(`You can attach at most ${MAX_IMAGES} images.`);
  if (!text.trim() && !images.length) return bad('There is nothing to send.');
  for (const im of images) {
    if (!isPlain(im) || !IMAGE_TYPES.has(im.mediaType)) return bad('Only PNG, JPEG, GIF and WebP images can be attached.');
    if (typeof im.data !== 'string' || !im.data || !BASE64_RE.test(im.data)) return bad('An attached image could not be read.');
    if (im.data.length > MAX_IMAGE_B64) return bad('An attached image is larger than 5 MB.');
  }
  if (!isPlain(opts)) return bad('Send options must be an object.');
  if (opts.id !== undefined && !isUuid(opts.id)) return bad('The message id must be a UUID.');
  if (priorities && opts.priority !== undefined && !priorities.includes(opts.priority)) return bad('Unknown message priority.');
  return null;
}
