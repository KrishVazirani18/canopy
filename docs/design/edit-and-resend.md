# Edit and resend

Status: built. Checked against real Claude Code 2.1.325 with the live cases
`edit-*` in `src/core/test/run.mjs`, and by hand in the app.

## What it is

Hover one of your own messages and click Edit (the pencil beside Copy). The bubble becomes a text box in the same
place. Change the words and press Send (Enter; Shift+Enter is a new line; Esc cancels). The message and everything
after it leave the chat, and Claude answers the new text instead.

It works while Claude is still replying: Send stops the reply and Claude starts again on the edited message.

It works in OpenAI (Codex) chats too. Everything up to "Known limits" describes a Claude chat; what Codex does
instead, and the two things that differ for you there, are under "OpenAI (Codex) chats" at the end.

## How the conversation is cut

In place. The chat keeps its session id.

```
Send
  └─ store.ts editFrom: the bubble and everything after it leave the transcript at once, the new bubble takes its place
       └─ main: ChatHost.edit ──► Session.edit (src/core/session.mjs)
            1. stop the reply (an ordinary Stop), wait until its turn is over
            2. if asked, put the files back (rewindFiles, while the old process is still alive)
            3. stop Claude Code
            4. read the saved conversation: the row the message followed is where to cut (src/core/transcript.mjs)
            5. `edit` event: from here on, everything belongs to the new message
            6. start Claude Code on the same session with `resume` + `resumeSessionAt`, and send the new text
```

Claude Code loads the conversation only up to the cut and writes the new message after it. The rows that were
dropped stay in the saved file, on a branch nothing follows any more: every reader works back from the newest row.

**Where to cut.** At the row the edited message itself followed (its `parentUuid`), not at the reply before it.
Claude Code often saves another row after a reply (an attachment), and that row belongs to the kept turn. The SDK's
readers do not return these links, so `transcript.mjs` reads them from the `.jsonl`. It never writes.

**The first message.** If nothing was saved before it, there is nothing to cut back to (`--session-id` on an existing
session is refused: "already in use"). Then a new conversation starts, Claude Code gives it a new id, and the old one
is reported as replaced (`meta.supersedes`). Main remembers replaced ids (`superseded` in state.json) and never lists
or searches them again, so the chat shows up once. With a SessionStart hook, Claude Code saves the hook's output
before the first message; then even the first message is cut in place and nothing of this applies.

**The cut is only real once the new message starts.** The cut options go to every start until Claude Code reports
the edited message as started, then never again. If that start dies first, the restart asks for the same cut. If the
message never starts, nothing was written and the chat is whole.

### The check (`resumeDropsTurn`)

Claude Code can check a cut: told which turn is being dropped, it refuses when anything else would go with it
(`Resume rejected by --resume-drops-turn:`). Measured:

- one turn dropped, the check on: accepted, also when that turn was stopped mid-reply;
- several turns dropped, the check on: refused, every time;
- several turns dropped, the check off: works.

So the check is sent only when the edited message is the only thing said in what is dropped. Editing an older
message, or one with a later message of yours or a background task's report after it, goes without the check: you can
see those in the chat and asked for them to go.

A refusal is final for that cut. `Session.cutRefused` gives it up: the edited message is not sent, Claude Code is
started again on the whole conversation, and `edit()` answers `edit-refused`. The window puts the chat back as it is
on disk and opens the message's editor again with what you wrote. A second try on the same message is made without
the check: by then you are looking at the conversation as it really is.

## What was proven first

In place counted as working only if, after an edit:

| | Checked by | Result |
|---|---|---|
| (a) the SDK's reader and Canopy's history load show the new branch only | `edit-idle`, `edit-midreply`, `edit-older` | yes |
| (b) the terminal view (`claude --resume <id>`, which ignores the cut options) shows the new branch | `edit-terminal-resume`, a real terminal read with node-pty | yes |
| (c) what the sidebar and search read from the file shows the edited text | `edit-idle` | yes, after one fix |

For (c): `last-active.mjs` reads the file's last rows, which are the new branch. `chat-titles.mjs` goes through the
SDK's reader. Cost and working time (`chat-totals`, `chat-cost`, `day-activity`) still count the dropped turns, which
is right: that work was done and paid for. Search read every row, so it found dropped messages: `chat-search.mjs` now
keeps only what the newest row leads back to (`liveUuids`).

`Session.branch()` (fork into a new session) is kept as it was, for "continue from here as a new chat". It is still
not wired to the window.

## The window

- `UserItem.uuid`: the message's id in the saved conversation. Sends make it in the window and pass it along
  (`send(text, images, id)`); history and queued messages that went out carry it too.
- `Store.editFrom` cuts at once and clears what the removed items held: the reply being written, steps, open
  permission and question cards, background task lines, the turn count. Cost and working time stay.
- Between Send and the engine's `edit` event the engine is still closing the old reply. Those events are not shown
  (`passesCut` in `lib/edit.ts` lists the few kinds that pass).
- If the engine says no, `Store.reload` (set by App and by each Multi mode pane) shows the chat as the engine has it.
- Files: opening the editor asks for a dry-run of `rewindFiles`. If Claude changed files since the message, one line
  under the box offers "Also undo Claude’s changes to N files since this message", unchecked.
- Background work: a restart ends workflows, agents and background commands, so an edit never makes one while any
  are running. The button reads "Send as New Message" and the edited text goes in as a new message, the way the
  message box sends it (queued behind a reply in progress): nothing is cut, stopped or undone, and the files line is
  not offered. Otherwise Send edits as above.
- Queued messages stay queued. `ChatHost` holds its queue while an edit runs, so nothing slips out when the old reply
  stops; they go out after the edited reply.
- A message's own images and documents go out again unchanged. The engine takes them from the saved message, so
  nothing depends on the thumbnails the window holds.

Edit is not offered (`editBlocked` in `lib/edit.ts`) on: a message with no id or whose send failed; `/commands` and
`!` shell lines (in a Claude chat: an OpenAI chat has no such commands, there they are words); messages that were not
typed by you; anything above the place the conversation was summarized or cleared; while the chat is open in the
terminal view; while the chat is still loading; and, in an OpenAI (Codex) chat only, a message you steered into a
reply that was already running (see below).

## Known limits

- Editing restarts Claude Code (about one to three seconds before the new reply starts).
- A chat Canopy named is named again after a first-message edit only if Canopy named it in this run of the app.
- A chat whose first message was replaced by a new conversation (no SessionStart hook) keeps its pin and its place in
  your own order, but not its archived or marked-unread state. The replaced conversation's file stays on disk.
- A message you steered in mid-reply can be edited; the cut then lands inside that turn. Not tested against real
  Claude Code.
- Stop pressed in the second after Send, while Claude Code is restarting, either withdraws the edit (the chat is
  put back as it was) or takes effect a few seconds late.
- The sidebar's second line for a closed chat is the file's last reply. If an edited message never got a reply
  (stopped at once), that line is still the dropped reply until the next one.

## OpenAI (Codex) chats

Status: built. Checked against real Codex 0.153.4 with `node scripts/codex-smoke.mjs --live --edit`, and by
hand in the app.

The same Edit, the same box, the same keys. What happens underneath is Codex's own, and two things differ for you:

- **Files are never put back.** Codex keeps no checkpoints of what it changed, and its `thread/revert` says so itself
  ("does not revert local file changes"). So the "Also undo…" line never shows in an OpenAI chat: `rewindFiles`
  answers `canRewind: false`, the preview is null, and there is no checkbox. What Codex changed on disk stays.
- **A message you steered into a running reply can't be edited on its own.** Codex cuts a conversation back a whole
  turn at a time, and a steered message is part of the turn it went into. Its bubble has no Edit. Editing the message
  that started that turn takes the whole turn, the steered message with it.

### How the conversation is cut

In place, with `thread/revert { threadId, beforeTurnId }`: the turn that message started goes, with every later one.
The chat keeps its thread id and (unless a Stop had to be forced) its process. Nothing is restarted.

```
Send
  └─ store.ts editFrom: the same cut as in a Claude chat, at once
       └─ main: ChatHost.edit ──► CodexSession.edit (src/core/codex-session.mjs)
            1. find the turn the message started (see "Which turn")
               · it was steered into a running reply: answer `steered`, touch nothing
               · Codex has not been handed it yet: withdraw it, there is no turn to cut (skip to 5)
            2. a reply is running: an ordinary Stop (turn/interrupt), then wait for Codex's own turn/completed
            3. make sure the thread is open in this process (a Stop that had to be forced ended it; a chat that was
               not running yet is opened)
            4. thread/revert before that turn
            5. `edit` event: from here on, everything belongs to the new message
            6. the new message goes out as the next turn (turn/start), with the old one's pictures unless new ones
               were given
```

Between 1 and 6 nothing else is handed to Codex (`editing` holds `deliver()`), so a message typed meanwhile goes after
the edited one, not ahead of it. Canopy's own queue is held by `ChatHost` exactly as for a Claude chat.

**Which turn.** A bubble's id is not a turn id. A message sent from this window carries the id Canopy made for it;
`CodexSession.sendTurns` notes which turn each send went into and whether it started that turn, as the turn id becomes
known (the `turn/start` answer, `turn/started`, the turn's end), and keeps the note after the turn is over. A message
read back from the saved chat carries Codex's own id for it instead (history gives each bubble its `userMessage` item
id), so it is looked up: `thread/turns/list` in the light view, newest first, a page at a time, stopping at the page
that has it. The light view holds each turn's first message and last reply only, which is exactly the kind of message
that can be edited; one not found there is looked for once in the full view, which is what tells "steered" from "not
in this chat".

**After the cut** the next turn says its collaboration mode again (Codex opens the thread anew from what is left, so
a chat in Plan mode stays in Plan mode), and the notes about the turns that went are dropped with them.

**If it fails,** nothing was cut. `edit()` answers `edit-failed` with Codex's own words ("turn not found: …"),
`unsupported` for a Codex too old to know `thread/revert`, or `steered` / `not-found` / `busy`, and the window puts the
chat back as the engine has it and opens the editor again with what you wrote. That reload gives every bubble
Codex's id in place of Canopy's, so `Store.takeLostEdit` finds the message by its place too: the same chat, the same
position among your messages, the same words.

**Another view of the same chat** follows through the `edit` event, as with Claude. A `thread/reverted` this session
did not ask for (nothing sends one today) is passed on as `reverted`, and the window reads the chat again.

**The first message.** Reverting the very first turn leaves an empty thread under the same id, and the new message is
its first turn: `first: true`, never `fresh`, and nothing is superseded. A chat goes by its first message until it is
named, so one still called after the old words is renamed after the new ones (`ChatHost.edit` for the open chat,
`CodexChats.firstMessageEdited` for the sidebar's row). A name Canopy made for it (`src/codex-titles.mjs`) is made
again from the new first exchange after the next turn (`CodexTitler.again`, as `ChatTitler.again` does for a Claude
chat), and a naming try that was under way when the edit landed is dropped, because it may have read the
conversation as it was. A name you gave it stays. The row's quoted reply is emptied on the edit and filled again by
the next reply.

### What was proven first

On a scratch thread, cheapest model, tiny turns, before any of this was built:

| | How | Result |
|---|---|---|
| (a) after a revert, `thread/turns/list` shows only the kept turns | two turns, revert before the second | yes |
| (b) the model does not remember a dropped turn | GUAVA, MANGO, revert before MANGO, "which words?" | "GUAVA" |
| (c) revert works right after `turn/interrupt` of a running turn | a count to 400, interrupt, wait for `turn/completed` (22 ms), revert (61 ms) | yes |
| (d) everything else that reads the chat sees the cut conversation | a new process (`thread/resume` + `thread/turns/list`), `thread/list`, and `codex resume <id>` read in a real terminal with node-pty | yes |

Also seen: a revert sent while a turn is still running is accepted (Codex ends the turn itself); Canopy stops and waits
first all the same. A message steered into a turn that is then stopped before Codex took it in is not saved at all.
The saved file changes its name on every revert; the thread id does not. Codex's own `preview` for a thread keeps the
original first message after that message is reverted; Canopy does not show it (the sidebar's name and line are
Canopy's own, `src/codex-chats.mjs`).

### Tests

- `src/core/test/unit/codex-session.test.mjs`, "edit and resend": idle, mid-reply (the Stop, the wait, the cut, the
  send, in that order, with a message typed meanwhile going after), a Stop already in flight, a forced Stop, a saved
  chat's message found by Codex's id (and by pages in a long chat), steered refused three ways, a refused cut leaving
  the chat whole, a thread Codex let go of, a message not handed over yet, a turn not named yet, pictures, Plan mode,
  `thread/reverted`, bad input, closing mid-edit. `fake-codex.mjs` answers `thread/revert` and the light view the way
  0.153.4 does.
- `codex-chats.test.mjs`: the same through `ChatHost` with the queue and the sidebar's row.
  `store-edit.test.mjs`: `editBlocked` for an OpenAI chat, the steered mark from history, the editor reopening by place.
- Live: `node scripts/codex-smoke.mjs --live --edit` (six tiny turns of its own).

### Known limits

- Not checked against real Codex: a message with pictures (the edit sends the saved parts again as they were; unit
  tested only), an edit above a compaction (the window does not offer it, as in a Claude chat), and a Codex older
  than `thread/revert` (answered from the error text 0.153.4 gives for a method it does not know).
- A message sent while a reply runs is steered by Codex whether or not the window marked it "Steered" (a send that
  raced the end of a turn). Then Edit shows, the engine answers `steered`, and after the reload the bubble has no Edit.
- An edit never waits for the new turn to start: it answers once the cut is made and the message is on its way. If
  Codex then cannot start on it, that shows as any failed send does, under the new bubble.
