# One question for a change to several files (Claude chats)

OpenAI chats already ask once for a change to several files: one card, "Change 3 files?", each file under its own line
with its own diff, one Allow. Claude chats now do the same when one reply edits several files and the permission mode
asks for each. A change to one file is the card it always was.

## What Claude Code does (recorded live, Haiku, default mode, three parallel Writes in one reply)

The three Write calls arrive as one assistant message. Per block: `content_block_start`, an `assistant` frame holding
that block (same message id, input complete), `content_block_stop`.

- The first `canUseTool` arrives about 470 ms before the message ends: after block 0's `assistant` frame, while block 1
  is still streaming. A card raised at once would list one file.
- The asks are serial. The second arrives about 20 ms after the first is answered (after its `tool_result`), the third
  the same way. Nothing runs, and nothing asks, until the one before is answered.
- Each ask's context for a plain write has no `decisionReason`, `blockedPath`, `matchedAskRule`, `requiresInteraction`,
  `defaultToNo` or `agentID`, and its `toolUseID` is the id of its block. The input equals the block's input.
- Denying the first does not stop the others: they ask in turn (and, denied, write nothing).

## Design (src/core/file-approvals.mjs, `broker()` in src/core/session.mjs)

1. `StepTracker` watches the model's top-level frames: which tool calls each assistant message holds, with what input,
   whether the message is still being written, which have been asked about or have run.
2. A plain file-change ask (Edit, Write, MultiEdit, NotebookEdit; inside the project; not a subagent's, not a Code Mode
   script's; none of the special fields above) waits until its message has ended, at most 6 s, then opens a group: itself
   plus the other file changes of that message that are fully written, inside the project, outside `.git`, `.claude`,
   `.vscode`, `.idea`, `.husky`, and not yet asked about or run.
3. Two or more: one permission event with the fields an OpenAI chat's card already has (`title`, `description`, `changes`
   (first 40), `changeCount`, `toolUseIds`). `toolName`, `input` and `toolUseId` name the ask being answered. The window
   and the sidebar/Home line ("changes to 3 files") needed no change.
4. The user's Allow, Always allow or Deny on that card answers the ask, and Session remembers the same answer for each
   other call in the group, keyed on its tool call id, tool name and the exact input shown. When that call's own ask
   arrives it is answered from that, with no card, only if it is a plain ask and its input is identical. Anything else
   (a rule, a safety reason, another folder, an edited input) gets a card of its own, as before.
5. What is remembered ends with the turn, a stop or interrupt, any closing of pending asks, and the session. A card that
   is cancelled, withdrawn or closed covers nothing.

Not changed: one file, subagent asks, Code Mode asks, every other tool.

## Left open

- If the first ask arrives and the rest of the message takes over 6 s to write, the card lists what is known and the
  rest ask for themselves.
- A call listed in the card whose own ask turns out not to be plain (for example a safety check Canopy cannot see
  beforehand) is asked about again on its own after the user allowed the others.
