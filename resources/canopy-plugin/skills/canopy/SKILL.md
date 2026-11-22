---
name: canopy
description: How Canopy, the Mac app this chat runs in, works. Load when the user asks how Canopy works or about its settings - Code Mode, permission modes, models, sign-in, several chats at once, the look and read_chat tools, where things are kept.
---

# How Canopy works

Canopy is a Mac app that runs the Claude Code and the Codex already installed on this Mac, in one window. It uses their setup as it is (Claude Code: settings, skills, plugins, MCP servers, CLAUDE.md; Codex: config.toml, MCP servers, AGENTS.md). Answer from this page. Where it is silent, say you are not sure instead of guessing, and point to Settings (⌘,).

## The window

- Sidebar: projects (folders) and their chats. A dot on a chat means it needs you. Home shows every chat as Needs you, Working or Done today.
- Under the message box: the model (with effort and Fast) and the permission mode.
- Right panel (⌘I): Stats (context and cost), Changes (files this chat edited) and Terminal (the real Claude Code on the same chat; Claude chats only).
- ⌘K searches chat titles, what was said in any chat, and actions. ⌘N starts a chat.
- While a reply is being written: Esc stops it, a message sent meanwhile waits in a queue, ⌘↵ sends it now and steers.

## Several chats

Every chat keeps working when you open another. A notification, the Dock badge and the menu bar icon say when one finishes or needs you. Multi mode (the grid button in the title bar, ⌘⇧M) shows up to four chats side by side.

## Permission modes

Picked on the chip under the message box or with ⇧⇥; the choice for new chats is also in Settings > Chats.

- Ask Before Edits: you approve every edit and command.
- Accept Edits: edits apply, commands still ask.
- Plan Mode: plans first, changes nothing yet.
- Auto Mode: safe actions run, risky ones ask.
- Full Access: everything runs without asking.

## Settings (⌘,)

- You: your Canopy account, Memory, usage stats and what is sent.
- Chats: what new chats start with (model, effort, Fast, permissions), finish sound and theme.
- Accounts: who is signed in to Claude Code and Codex, Add account, which one new chats use, updates.
- Tools: Connectors (MCP servers), Skills and Plugins.
- Advanced: the model menu, shortcuts, Code Mode, Canopy Kit, folders, versions and the log.

## Sign-in

- Canopy: the downloaded app asks you to sign in with Google once (Settings > You). A copy run from source has none.
- Claude Code and Codex: each chat uses that tool's own sign-in; Canopy never reads it. Settings > Accounts > Add account signs in or takes an API key.
- A missing tool: the first run installs it with its maker's installer; for Codex, Settings > Accounts links to OpenAI's guide (Check Again).

## Models

A chat belongs to one maker. Picking another model of the same maker switches the chat as it is. Picking the other maker's model in a chat that has started moves it: a new chat in the same folder carries on from a summary of this one, and this one stays as it was.

## Code Mode

A switch in Settings > Advanced, or `/codemode on` and `/codemode off`. Claude chats only. With it on, work that takes several connector (MCP) calls is written as one script for the `run` tool, and only the script's result is read: fewer steps and less to pay for. It applies to new chats; a chat keeps the tools it started with.

## Canopy's tools

A chat has the ones in its own tool list; say so if the one asked about is not there.

- `look`: a screenshot of a web page (localhost works) or of a Mac app window. A page on this Mac and Canopy's own window are not asked about. Another app's window needs Screen Recording allowed for Canopy in System Settings.
- `read_chat`: lists the user's other chats in this project, or reads one by id or words from its title.
- `show_widget`: draws a table, chart, choices, diff or mockup in the chat.
- `remember`, `recall` and `forget`: Canopy Memory, below.

## Memory

Short notes every new chat starts out knowing, Claude or Codex: what the user wants by default, corrections, confirmed project facts. `remember` saves one (about the user, or this project; a changed fact replaces the old note), `recall` reads them back, `forget` removes one the user says is wrong.

- A save or a removal shows in the chat with Undo. Settings > You > Memory lists the notes, to edit or delete, and has the switch for new chats (a chat keeps what it started with).
- A chat is told the notes once, when it starts; one saved mid-chat is in the next chat's list.
- Secrets are never kept, nothing is saved because a file or a web page asked for it, and a note marked "you said" holds only the user's words.
- Claude Code's and Codex's own memories are shown to each other only if turned on there.

## Where things are kept

- Chats are Claude Code's and Codex's own files: `~/.claude/projects/` and `~/.codex/sessions/`. A chat started in Canopy can be carried on in the terminal, and chats started in the terminal show in Canopy under their project.
- Canopy's own state and log: `~/Library/Application Support/Canopy/` (`state.json`, `canopy.log`).
- Canopy Memory's notes: `~/Library/Application Support/Canopy/memory/`, one Markdown file per note.
- Claude Code's settings: `~/.claude/`. Codex's: `~/.codex/config.toml`.
