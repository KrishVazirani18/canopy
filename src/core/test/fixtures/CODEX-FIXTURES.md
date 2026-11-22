# Codex fixtures

Real `codex app-server --listen stdio://` traffic, recorded by `src/core/test/codex-record.mjs` with
**codex-cli 0.153.4**, model `gpt-6-luna`, effort `low`, standard service tier, on an API-key sign-in.
A full recording makes eight live turns (about 300k input tokens, most of them cached, and 1.3k output tokens).

## File format

One JSON object per line, in the order the lines crossed the pipe.

- Line 1 is a note: `{"dir":"note","scenario":…,"codex":…,"model":…,"setup":…,"answers":…,"flags":[…]}`.
- `{"t":40,"dir":"out","msg":{…}}` is a line the client wrote. `{"t":41,"dir":"in","msg":{…}}` is a line the app-server wrote.
- `t` is milliseconds since the process was spawned.

Nothing in a file says whose Codex it was recorded on (`neutralFixture` in `../helpers.mjs`, checked by
`unit/codex-fixtures.test.mjs`):

- The home folder is `/Users/test` and `installationId` is zeroed.
- Every id is a made-up one of the same shape: chats, turns and items (`00000000-0000-7000-8000-…`), commands
  (`exec-00000000-0000-4000-8000-…`), and the model's own `msg_…`, `rs_…` and `call_…` ids. One id is the same made-up
  id in every file, so the chat one scenario starts is the chat another resumes.
- MCP servers are `server_1`, `server_2`, … in the order first seen. Only Canopy's own servers and `cua_repl`
  (Computer Use, which the product matches on) would keep their names. A plugin is `example-plugin` from
  `example-marketplace`.
- The user agent keeps Codex's version and the client's; the macOS and terminal versions are levelled.
- Strings over 6,000 characters are cut to 400 (only Codex's built-in Plan mode instructions were that long).

The number of lines and their order are as recorded. The recorder refuses to write a file that still holds the stored
key, a key-shaped string or an email address.

`setup` is `bare` (MCP servers, plugins, apps and memories switched off for that process) or `user` (Codex as it is
set up, start-up noise and all). Every process also got `-c service_tier="default" -c notify=[] --disable memories`.

## The fixtures

| File | Live turn | What it holds |
|---|---|---|
| `codex-text.jsonl` | yes | `user` set-up. `thread/start`, then "Reply with exactly: OK". MCP servers starting (two notifications each, 22 in all), a `warning`, plugin `sessionStart` hooks, one text delta, token usage, `turn/completed`. |
| `codex-command-approval.jsonl` | yes | Ask mode (read-only + on-request). `touch approved.txt` asks through `item/commandExecution/requestApproval`; answered `accept`; the command runs. |
| `codex-file-change-approval.jsonl` | yes | Ask mode. An `apply_patch` edit asks through `item/fileChange/requestApproval`; answered `accept`; `turn/diff/updated` follows. |
| `codex-decline.jsonl` | yes | The same edit answered `decline`. Also the only fixture with a reasoning summary (83 `item/reasoning/summaryTextDelta`). |
| `codex-interrupt.jsonl` | yes | "Count from 1 to 300", `turn/interrupt` sent 300 ms after the first text delta. |
| `codex-read-command.jsonl` | yes | `cat`, `grep -n`, `ls`: `commandActions` of type `read`, `search`, `listFiles`. No approval needed. |
| `codex-command-output.jsonl` | yes | A 1.5 s loop that prints three lines: `item/commandExecution/outputDelta`. The prompt also asks for `update_plan`; the model answers that it has no such tool. |
| `codex-plan.jsonl` | yes | Plan mode: `turn/start` with `collaborationMode: {mode: "plan"}`. A read command, a question back to the user, a two-step plan. |
| `codex-inject.jsonl` | yes | Recorded for moving a chat between makers. `thread/inject_items` with one `developer` message (a Canopy digest holding a code word) before the first turn, answered `{}`; then "Reply with only the code word.", answered `TANGERINE`. Read back: `thread/turns/list` holds only the `userMessage` and the `agentMessage` (the injected message is not an item), and the `preview` in `thread/read` and `thread/list` is the user's words. |
| `codex-resume.jsonl` | no | New process. `thread/resume` with `excludeTurns: true`, `thread/turns/list` (default and full), `thread/name/set`, `thread/read`, a second `thread/resume` the deprecated way, and a resume of a chat that does not exist. |
| `codex-meta.jsonl` | no | `account/read`, `model/list` (plain and `includeHidden`), `collaborationMode/list`, `thread/list` for the scratch folder (slow way and quick way), `thread/read` (with and without turns, and of a missing chat). |
| `codex-history.jsonl` | no | `thread/turns/list` with full items for the chat of each tool scenario, read without resuming them. This is what a reopened transcript is rebuilt from. |
| `codex-modes.jsonl` | no | `thread/start` for Ask, Accept edits, Auto (`approvalsReviewer: "auto_review"`) and Full access, one with nothing chosen, then twelve `thread/settings/update` calls: mode, model, effort, Fast on and off, Plan on and off, and three made-up values. |
| `codex-startup.jsonl` | no | `user` set-up. `thread/start` alone, to show the notices and MCP start-up a chat opens with. |
| `codex-compact.jsonl` | yes | `/compact`, recorded later by `scripts/codex-smoke.mjs --live --commands --record`: `thread/compact/start` answers `{}`, then a turn of its own (`turn/started`, a `contextCompaction` item started and completed, token usage, `turn/completed`). Only the lines of the compaction, not the chat before it. |

One wrinkle: in `codex-resume.jsonl` the chat is already named "Canopy fixture chat" in the first response, because an
earlier recording run had set the name.

## Not captured

- `turn/plan/updated`: the model has no `update_plan` tool on this version, in ordinary or Plan mode.
- A `plan` item or `item/plan/delta`: the Plan mode turn gave its plan as an ordinary final answer.
- `item/tool/requestUserInput`: the question arrived another way (see Plan mode below).
- `item/permissions/requestApproval`, `mcpServer/elicitation/request`, MCP tool calls, web search, a compaction Codex
  starts on its own, a failed turn, `turn/steer`, a declined command (only a declined edit), `acceptForSession`.

## Quirks

**The wire**
- There is no `"jsonrpc"` field in either direction.
- Every notification carries a top-level `emittedAtMs` beside `method` and `params`. Requests and responses do not.
- Server requests count their own ids from `0` in each process. They overlap with the client's ids, so a request is told
  from a response by `method`, never by id.
- `initialize` returns `userAgent`, `codexHome`, `platformFamily`, `platformOs` and nothing about capabilities.
  `remoteControl/status/changed` always follows it.
- Errors seen: `-32600 "thread not loaded: <id>"` (`thread/read` of an unknown id) and
  `-32600 "no rollout found for thread id <id>"` (`thread/resume` or `thread/archive` of an unknown, empty or already
  archived chat).

**Starting a chat**
- The `thread/started` notification arrives after the `thread/start` response.
- A chat is written to disk only once it has a turn. Before that it is not in `thread/list` and cannot be resumed or
  archived.
- `thread.source` is `"vscode"` for app-server chats. `preview` is empty and `gitInfo` and `name` are null until the
  first turn. `historyMode` is `"paginated"` (`"legacy"` and `path: null` for an ephemeral chat).
- A chat opens with whatever its set-up has to say: a `deprecationNotice` for a config key Codex has retired, and two
  `mcpServer/startupStatus/updated` lines for each MCP server (`starting`, then `ready` or `failed`). A server that is
  not signed in ends `failed` ("not logged in. Run `codex mcp login …`"), as does one whose sign-in has run out. None
  of this is a problem with the chat, so it should not reach the transcript as an error.
- The first turn waited about 1.8 s between `turn/started` and the first item while MCP servers started (0.6 s bare).
- Plugin `sessionStart` hooks run at the first turn, not at `thread/start`: `hook/started` and `hook/completed` carry the
  `turnId` and arrive before the user message item.
- A `notify` program set in `config.toml` runs at the end of every turn unless the process is started with
  `-c notify=[]`, as the recorder's are.

**Settings**
- `serviceTier` left out means the tier set in `config.toml`. `serviceTier: null` means standard and comes back as
  `"default"`. `"priority"` is Fast.
- `thread/start` reports the effort set in `config.toml` (`"high"` in these files) whatever the last turn used, and so
  does a resumed chat. An unloaded chat in `thread/list` or `thread/read` reports the last turn's effort instead. Send model
  and effort with every turn.
- `effort`, `summary`, `model` and `collaborationMode` on `turn/start` apply to later turns too (the protocol's own
  comments say so; not tested here). Each change is echoed in full by `thread/settings/updated`, which arrives before
  the `turn/start` response.
- `thread/settings/update` changes anything between turns and returns `{}`. It checks nothing: `no-such-model`,
  `no-such-effort` and `no-such-tier` are all accepted and echoed back. Canopy has to check against `model/list` itself.
- `thread/start` takes `sandbox` as a string (`"read-only"`). `turn/start` and `thread/settings/update` take
  `sandboxPolicy` as an object (`{"type":"readOnly","networkAccess":false}`); `codex-modes.jsonl` has all three shapes.
- All four mode mappings are accepted, `approvalsReviewer: "auto_review"` included (`model/list` with `includeHidden`
  shows a hidden `codex-auto-review` model).
- With nothing chosen, a chat in a folder Codex does not yet trust came up as on-request + workspace-write.

**A turn**
- The `turn/start` response has `startedAt: null`. `turn/started` follows with the time set.
- `thread/status/changed` to `idle` arrives just before `turn/completed`, not after.
- `turn/completed` lists only the final answer in `turn.items` (`itemsView: "summary"`). The transcript has to be built
  from `item/started` and `item/completed`.
- The user's own message comes back as a `userMessage` item (started and completed) at the top of the turn.
- `agentMessage.phase` is `"commentary"` for narration between steps and `"final_answer"` for the answer.
- A `reasoning` item is started and completed on almost every step with `summary: []` and `content: []`. Only one of
  eight turns produced a summary, even with `summary: "auto"`. Empty ones should be skipped.
- Item ids: UUIDs for user messages, `msg_…` for text, `rs_…` for reasoning, `exec-<uuid>` for commands and for file
  changes. History returns the same ids.
- `thread/tokenUsage/updated` arrives after each model call with `total`, `last` and `modelContextWindow` (258,400).

**Commands**
- `command` is the wrapped form (`/bin/zsh -lc 'cat notes.txt'`). `commandActions[].command` is what the model typed.
- `read` has `name` and an absolute `path`. `search` has `query` and `path` as typed. `listFiles` has `path: null` for
  a bare `ls`. `rg --files -g …` also counts as `listFiles`. Anything else is `unknown`.
- A quick command sends no `outputDelta` at all. Its output is only in `aggregatedOutput` on `item/completed`
  (`null` when it printed nothing).
- **The first chunk of streamed output is lost.** The loop printed `line 1`, `line 2`, `line 3`; only `line 2` and
  `line 3` arrived, in the deltas and in `aggregatedOutput` alike. History has the same gap.
- `processId` is a string. `source` is `"agent"` while a command waits for approval and `"unifiedExecStartup"` once it runs.

**Approvals**
- Command: `thread/status/changed` (`activeFlags: ["waitingOnApproval"]`), `item/started` (`inProgress`), then the
  request. File change: `item/started`, the status change, then the request. Do not rely on the order of the first two.
- After the answer: `serverRequest/resolved` (`requestId`), the status back to `active` with no flags, `item/completed`.
- The command request carries `reason` (the model's own sentence), `command`, `commandActions`,
  `proposedExecpolicyAmendment` and `availableDecisions`, which here was `accept`, `acceptWithExecpolicyAmendment`
  and `cancel`. Neither `decline` nor `acceptForSession` was offered.
- The file change request carries only `itemId`, `reason` and `grantRoot`. The diff has to be looked up from the
  `fileChange` item already started with that id. It has no `availableDecisions`.
- `fileChange.changes[]` is `{path (absolute), kind: {type: "update", move_path}, diff}`. `diff` is hunks only
  (`@@ -1 +1 @@\n-hello\n+goodbye\n`), with no file header.
- `turn/diff/updated` carries the whole turn's diff in git form and repeats (three times for one edit).
- Declined: `item/completed` with `status: "declined"`, and the turn carries on to a normal `completed`.
- In Ask mode reads ran without asking, in ordinary and in Plan mode.

**Interrupt**
- `turn/interrupt` returns `{}`. Then `thread/status/changed` to `idle` and `turn/completed` with
  `status: "interrupted"`, `error: null` and `items: []`.
- The text item that was streaming never gets an `item/completed`, and there is no token usage for the turn.
- History keeps only the user message for that turn. The partial answer is gone.

**Plan mode**
- `collaborationMode.settings.developer_instructions: null` is replaced by Codex's built-in instructions (9 kB), and the
  echo shows them. Switching back to `default` installs a short "you are now in Default mode" text the same way.
- The question did not arrive as `item/tool/requestUserInput`. It was an `agentMessage` with id `call_…`,
  `delivery: "async"` and `questions: [{title, options: ["world","there"]}]`, sent whole with no deltas, and the turn
  went on to the plan without waiting for an answer.
- `collaborationMode/list` gives `plan` (default effort `medium`) and `default`.

**Reopening and listing**
- `thread/list` took 2.6 to 3.2 s for eight chats (it scans the chat files). With `useStateDbOnly: true` it took 2 ms
  and returned the same eight chats.
- `thread/list` echoes `cwd` as it was given (`/tmp/…`). `thread/read` and the `thread` inside a resume response give
  the real path (`/private/tmp/…`). Compare folders by real path.
- `thread/resume` without `excludeTurns`, and `thread/read` with `includeTurns: true`, still return every turn but send
  a `deprecationNotice`. The supported way is `excludeTurns: true` and then `thread/turns/list`.
- `thread/turns/list` works on a chat that is not loaded. It returns `itemsView: "summary"` unless asked for
  `"full"`, and newest first unless asked for `sortDirection: "asc"` (the order is from the protocol's comments; every
  chat here has one turn).
- `thread/resume` sends `thread/status/changed` (`idle`) before its response, then `thread/tokenUsage/updated` with the
  last known usage and `thread/goal/cleared`. It sends no `thread/started`.
- `thread/name/set` returns `{}` and sends `thread/name/updated` with `threadName`.

Seen later, by the smoke script (`scripts/codex-smoke.mjs`) and read-only calls against a long chat list:

- `thread/list` hands out at most 100 chats a page whatever `limit` says, with a `nextCursor` to carry on from.
- The index (`useStateDbOnly: true`) can lack a chat that is on disk: it came back one chat short of the slow scan,
  before and after the scan. `thread/read` and `thread/turns/list` both found the odd one. So "not in the list"
  does not mean "gone".
- A chat is in the index straight after its first turn.
- `thread/list` with `archived: true` lists archived chats, a just-archived one included, and shares none with the
  open list. `thread/read` still succeeds for an archived chat; `thread/resume` does not (see above).
- `thread/name/set` works on a chat that is not loaded in that process.
- The slow scan repeats rows across pages (about two rows a chat), so rows are told apart by id.

**Flags**
- `-c mcp_servers={}` does not empty the MCP table in `config.toml`; it merges with it.
- `-c mcp_servers.<name>.enabled=false` for a server that only a plugin defines stops the app-server from starting
  ("invalid transport"). It works for servers that `config.toml` defines.
