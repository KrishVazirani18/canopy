// The page a widget frame loads: Canopy's own MCP App for Claude's widgets (renderer/src/frame), as one string for
// the iframe's srcdoc. A srcdoc frame under sandbox="allow-scripts" has no URL, no origin and no way to load a file,
// so everything it needs travels in this text: the policy, the fonts, the first paint's CSS and the bundled script.
import frameJs from 'virtual:canopy-frame';
import pageCss from '@/frame/page.css?inline';
// The same two files index.css loads (assets/fonts, with their licence beside them).
import geist from '../../../assets/fonts/Geist-Variable.woff2?inline';
import geistMono from '../../../assets/fonts/GeistMono-Variable.woff2?inline';

/**
 * Nothing loads from anywhere: no network, no files, no frames. Scripts and styles are the widget's own inline ones;
 * images, fonts and media only from data: (or blob:, made inside the frame). The main process enforces the same
 * from outside (src/main.mjs: frames never navigate and never reach the network).
 */
export const WIDGET_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:',
  'media-src data: blob:', "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'",
].join('; ');

const FONTS = `@font-face{font-family:"Geist";src:url(${geist}) format("woff2");font-weight:100 900;font-display:block}`
  + `@font-face{font-family:"Geist Mono";src:url(${geistMono}) format("woff2");font-weight:100 900;font-display:block}`;

// An arrowhead any <svg> in the widget can use: marker-end="url(#arrow)".
const DEFS = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0.5L7.5 4L0 7.5z" fill="context-stroke"/></marker></defs></svg>';

// A script's text may not contain "</script": the HTML parser would end the element there.
const inlineScript = (js: string) => js.replace(/<\/(script)/gi, '<\\/$1');

/** Canopy's tokens under the names MCP Apps gives a host's style variables (plus two of Canopy's own). */
export function hostVariables(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const fg = v('--foreground');
  // --radius is written in rem; the frame is told in px.
  const radius = Math.round((parseFloat(v('--radius')) || 0.5) * (parseFloat(cs.fontSize) || 16));
  return {
    '--color-text-primary': fg, '--color-text-secondary': v('--muted-foreground'), '--color-text-tertiary': v('--faint'), '--color-text-inverse': v('--primary-foreground'),
    '--color-background-primary': v('--background'), '--color-background-secondary': v('--card'), '--color-background-tertiary': v('--muted'), '--color-background-inverse': v('--primary'),
    '--color-border-primary': `color-mix(in oklch, ${fg} 25%, transparent)`, '--color-border-secondary': v('--border'), '--color-border-tertiary': v('--hairline'),
    '--color-ring-primary': v('--ring'),
    '--color-text-success': v('--good'), '--color-text-warning': v('--warn'), '--color-text-danger': v('--destructive'),
    '--font-sans': '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif', '--font-mono': '"Geist Mono", "SF Mono", ui-monospace, Menlo, monospace',
    '--font-weight-normal': '400', '--font-weight-medium': '500', '--font-weight-semibold': '600', '--font-weight-bold': '700',
    '--font-text-xs-size': '11px', '--font-text-sm-size': '12px', '--font-text-md-size': '13px', '--font-text-lg-size': '15px',
    '--font-text-xs-line-height': '16px', '--font-text-sm-line-height': '16px', '--font-text-md-line-height': '20px', '--font-text-lg-line-height': '24px',
    '--border-radius-xs': '2px', '--border-radius-sm': `${Math.max(2, radius - 4)}px`, '--border-radius-md': `${radius}px`, '--border-radius-lg': `${radius + 4}px`, '--border-radius-xl': `${radius + 8}px`, '--border-radius-full': '999px',
    '--border-width-regular': '1px',
    // Canopy's own: the one signal color, and the wash a hovered or pressed row gets.
    '--color-accent': v('--brand'), '--color-background-hover': v('--accent'),
  };
}

export const isDark = () => document.documentElement.classList.contains('dark');

/** The shell page, carrying the look as it is right now so its first paint is already right. */
export function widgetDocument(): string {
  const vars = Object.entries(hostVariables()).map(([k, val]) => `${k}:${val}`).join(';');
  return `<!doctype html><html data-theme="${isDark() ? 'dark' : 'light'}" style="color-scheme:${isDark() ? 'dark' : 'light'}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">`
    + `<style>${FONTS}</style><style>${pageCss}</style><style>:root{${vars}}</style></head>`
    + `<body><div id="root"></div>${DEFS}<script>${inlineScript(frameJs)}</script></body></html>`;
}
