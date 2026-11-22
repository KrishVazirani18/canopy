// Models write math in LaTeX's own delimiters, \( … \) and \[ … \] (Codex nearly always does). Markdown reads \( as an
// escaped parenthesis, so the reply showed "(x_{\mathrm{max}})" as text. The math plugin only knows dollar signs, so
// those delimiters become dollars before the reply is drawn: \[ … \] on its own line is a display block, anything else
// is inline math ($$ … $$, since single dollars stay prices). Code blocks and inline code are left exactly as written.
// Plain TypeScript with no run-time imports, so node's tests run it as it is.

// One pass, left to right: code is matched first so nothing inside it is touched.
const PARTS = new RegExp(
  [
    String.raw`^ {0,3}(\`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[\`~]*[ \t]*(?=\n|$)|(?![\s\S]))`, // fenced code (open runs to the end)
    String.raw`(\`+)[\s\S]*?\2`, // inline code
    String.raw`\\\[((?:(?!\n[ \t]*\n)[\s\S])+?)\\\]`, // \[ … \], no blank line inside
    String.raw`\\\(((?:(?!\n[ \t]*\n)[\s\S])+?)\\\)`, // \( … \), no blank line inside
  ].join('|'),
  'gm',
);

export function normalizeMath(md: string): string {
  if (!md.includes('\\(') && !md.includes('\\[')) return md;
  return md.replace(PARTS, (whole, _fence, _ticks, display: string | undefined, inline: string | undefined, at: number) => {
    if (display !== undefined) {
      const tex = display.trim();
      if (!tex) return whole;
      // At the start of a line it is a block of its own, kept at the line's indent so it stays inside a list item.
      // Text after the closing \] moves to the next line, since a closing $$ must stand alone.
      const lineStart = md.lastIndexOf('\n', at - 1) + 1;
      const indent = md.slice(lineStart, at);
      if (/^[ \t]*$/.test(indent)) {
        const after = at + whole.length < md.length && md[at + whole.length] !== '\n' ? '\n' + indent : '';
        return `$$\n${indent}${tex}\n${indent}$$${after}`;
      }
      return `$$${tex}$$`;
    }
    if (inline !== undefined) {
      const tex = inline.trim();
      return tex ? `$$${tex}$$` : whole;
    }
    return whole; // code
  });
}
