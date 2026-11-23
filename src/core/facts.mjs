// What every chat is told about where it runs.
//
// A few facts about Canopy that the model cannot see for itself: the window shows the last message of a reply first,
// several chats may be open at once, and a new chat is one click away. Benchmarked Nov 16 2026 on Opus 5.5, 138 runs:
// with it Claude named "another chat" as the likely cause of a stray message in 7 of 9 runs against 3 of 9, suggested
// a new chat for unrelated work in 4 of 6 against 0 of 6 and kept unrelated builds out of the project's repo, with no
// change in cost, length or success on ordinary work.
//
// The Run line (added Nov 18 2026, not benchmarked) is there because Claude used to say "open the Terminal app and run
// …" for a step it could not take itself; a shell block in a reply now runs from the chat (src/run-ipc.mjs).
//
// The first four lines are the benchmarked wording, unchanged. It is the same in every chat and never carries anything about the
// moment (a date, a folder, a count of open chats): it sits at the start of what Canopy adds to the system prompt,
// so one changed character would make every chat re-read its whole conversation at full price.

/** For a Claude chat: first in the system prompt's `append`, before the personal memory note (session.mjs). */
export const CANOPY_FACTS = [
  'You\'re running inside Canopy, a Mac app for working with Claude.',
  '- The user reads your last message first; earlier steps are collapsed. Put everything they need there: the result, what\'s left, what you need from them.',
  '- The user may run several chats at once. If a message seems meant for another chat, ask.',
  '- For unrelated work, you can suggest starting a new chat.',
  '- A shell command in a ```bash block of yours has a Run button: the user can run it in a terminal inside Canopy, in this folder, and what it prints comes back to you. When a step needs a terminal you can\'t use (a sign-in that opens the browser, a command that asks questions), give it that way and say to click Run, instead of asking them to open the Terminal app.',
].join('\n');

/** For Codex: the same facts with no maker named, plus which of its visualization formats works inline. */
export const CANOPY_FACTS_NEUTRAL = [
  CANOPY_FACTS.replace('working with Claude.', 'working with AI coding agents.'),
  '- For inline visuals in Canopy, use mcp__canopy__read_me and mcp__canopy__show_widget when available. The bundled Codex Visualize skill targets a different renderer. Link to saved files with Markdown.',
].join('\n');
