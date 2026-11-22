/** CUA calls have the same identity in Claude and Codex, including plugin-prefixed MCP servers. */
export function isComputerUse(name: string): boolean {
  return /^mcp__(?:plugin_[\w-]+_)?cua_repl__(?:js|js_reset)$/.test(name);
}

/** The tool's human-written action title is useful in the timeline; its JavaScript stays in the details. */
export function computerUseAction(name: string, input: Record<string, unknown>): string {
  const args = input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments)
    ? input.arguments as Record<string, unknown> : input;
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (title) return title;
  const summary = typeof args.completion_summary === 'string' ? args.completion_summary.trim() : '';
  if (summary) return summary;
  return name.endsWith('__js_reset') ? 'Resetting computer connection' : 'Using the computer';
}
