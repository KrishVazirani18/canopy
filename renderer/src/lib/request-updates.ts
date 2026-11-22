// "Request Updates" (the agents drawer's button): the question it sends, and how the chat recognises it afterwards.
// The chat shows it as Canopy's own bubble ("Canopy requested an update"), not as a message you typed. It is known by
// its text, so it reads the same way when the chat is reopened from Claude Code's history.

// It asks for the work as a checklist with progress, not a status report, and spells out the chosen card piece by
// piece so every chat draws the same one: a list of fields comes back as a table of paragraphs.
// Canopy chats have show_widget; a chat without it answers in words.
export const UPDATE_PROMPT = 'Where do the running agents and workflows stand? '
  + 'Show one widget, not a table: a bordered card for each agent or workflow. '
  + 'Card top: its name and task on the left, the overall percent and time left on the right, and a full-width progress bar under them. '
  + 'Then one row per step, in order, a few words each: a ✓ for steps done, a small green dot for the step it is on now, '
  + 'and a hollow circle with faint text for steps still to do. Each row ends with a small bar and its percent '
  + '(100% when done, the percent so far for the current one, 0% to do). '
  + 'Then one sentence below the widget. If you can\'t show widgets, list the same steps with their percents.';

// Earlier wordings, already sent in chats from before the bubble: they show as the bubble too.
const EARLIER = [
  'Give me a quick update on the agents and workflows that are still running',
  'Where do the running agents and workflows stand? Show it as one widget, not a table.',
];

/** Whether a message in the chat is a "Request Updates" question. */
export const isUpdateRequest = (text: string) => {
  const t = text.trim();
  return t === UPDATE_PROMPT || EARLIER.some((e) => t.startsWith(e));
};
