// Only image metadata crosses into the transcript. Never forward an entire server config or _meta object.
const IMAGE = /^image\/(?:png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i;
export function toolIcons(value) {
  if (!value || typeof value !== 'object') return [];
  const info = value._meta?.['io.modelcontextprotocol/serverInfo'] ?? value.serverInfo ?? value.server ?? value;
  const candidates = info.icons ?? info.meta?.icons ?? value.icons
    ?? info.logo ?? info.logo_url ?? info.logoUrl ?? info.meta?.logo;
  const out = [];
  for (const icon of (Array.isArray(candidates) ? candidates : [candidates]).slice(0, 8)) {
    const src = typeof icon === 'string' ? icon : icon?.src ?? icon?.url;
    if (typeof src !== 'string' || src.length > 256_000) continue;
    try {
      const url = new URL(src);
      if (url.protocol === 'data:') {
        if (!/^data:image\/(?:png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)[;,]/i.test(src)) continue;
      } else if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
    } catch { continue; }
    if (icon?.mimeType && !IMAGE.test(icon.mimeType)) continue;
    out.push({ src, ...(icon?.theme === 'light' || icon?.theme === 'dark' ? { theme: icon.theme } : {}),
      ...(typeof icon?.mimeType === 'string' ? { mimeType: icon.mimeType } : {}) });
  }
  return out;
}
