# Contributing to Canopy

Thanks for helping. Canopy is maintained by one person, so a review can take a few days. Small, focused pull requests are merged fastest.

## Before you start

- **A bug.** Open an issue with the bug form. Say what you did, what you expected and what happened.
- **A small fix.** Send the pull request.
- **Anything bigger.** Open an issue first and describe the change, so you don't build something that does not fit.
- **A security problem.** Do not open an issue. Follow [SECURITY.md](SECURITY.md).

Canopy tries to stay calm and familiar: nothing new to learn, color only for the one thing that needs you, and nothing that moves while it loads. Changes in that spirit fit best.

## Setup

You need a Mac and Node.js 26 or later.

```sh
npm install
npm start
```

`npm start` runs Canopy from this folder. It builds the interface first, rebuilds it as you edit, and reloads the window. A change to the main process (`src/`) needs a restart.

To try something without touching your own Canopy, give the run a data folder of its own:

```sh
CANOPY_USER_DATA=/tmp/canopy-dev npm start
```

A run like that sends no usage stats and never updates your Claude Code or Codex.

### The Dock says Canopy, not Electron

`scripts/brand-dev.mjs` runs before every `npm start`. The first time, it renames the copy of Electron inside `node_modules` to Canopy, gives it Canopy's icon and a bundle ID of its own, and signs it again ad hoc. After that it finds nothing to do. macOS grants notifications per bundle ID, so without this step Canopy's notifications never appear. It changes nothing outside `node_modules`.

## Checks

Every change has to pass these. CI runs them on each pull request.

```sh
npm run typecheck
npm test
npm run build:ui
```

CI also scans the repository for secrets with [gitleaks](https://github.com/gitleaks/gitleaks). `.gitleaks.toml` lists the made-up keys the unit tests use. A new one in a test goes on that list.

**Unit tests.** They are all in `src/core/test/unit` and run on Node's own test runner. They replay recorded fixtures against stand-ins, so they need no Claude Code, no Codex and no network, and they cost nothing. To run one file:

```sh
node --test src/core/test/unit/session.test.mjs
```

**The interface without the app.** After `npm run build:ui`, `node scripts/ui-harness.mjs` serves the built interface to a plain browser at `http://127.0.0.1:5199/`, with a stand-in for the app behind it. Nothing else is started. The top of the script lists the states you can open from the address, which makes it the quickest way to take screenshots.

**The Playground.** In a run from source, ⌘⇧P opens it. Each file in `renderer/src/playground/mocks` is a screen built from the app's own components with sample data, for trying a design at true size before it is built. A packaged app does not have it.

### Checks that spend real usage

These talk to the real Claude Code or Codex on your own sign-in. None of them runs in `npm test` or in CI. Run one by hand when you change what it covers. The top of each script says exactly what it does.

| Script | What it checks | Cost |
| --- | --- | --- |
| `node src/core/test/run.mjs` | Canopy's engine against the real Claude Code | Tiny prompts on the smallest model |
| `node scripts/codex-smoke.mjs` | Canopy's Codex session against the real Codex | Free. `--live` adds one tiny turn, and other flags add a few more |
| `node scripts/codex-tools-smoke.mjs` | Canopy's own tools in a real Codex chat | Free. `--live` and `--reopen` add one turn each |
| `node scripts/widget-evals.mjs` | Whether Claude draws a widget when it should | About a cent to a quarter per prompt |
| `node src/core/test/record.mjs`<br>`node src/core/test/codex-record.mjs` | Record the fixtures the unit tests replay again | Tiny turns on the smallest models |

## A map of the code

| Path | What lives there |
| --- | --- |
| `src/main.mjs` | The Electron main process: the window, the menus and everything the interface asks for. |
| `src/core/` | The engine. It runs Claude Code through the Claude Agent SDK and Codex through its app server. It imports no Electron, so the tests run it under plain Node. |
| `src/telemetry/` | Usage stats. `schema.mjs` is the one list of what may be sent. |
| `renderer/` | The interface: React, Vite and Tailwind. |
| `resources/` | The two plugins Canopy adds to chats. |
| `assets/` | The app's icons and the two font files, with the fonts' license. |
| `scripts/` | Tools for development: the interface harness, the smoke checks and the icons. |
| `docs/design/` | Design notes for the larger features: what was built, why, and what was checked against the real tools. |
| `supabase-accounts/` | The database behind the Canopy account in official builds. Its README says what the two migrations do. |
| `site/` | The download page, published with GitHub Pages. |

## Pull requests

- One change per pull request.
- The title is a [Conventional Commit](https://www.conventionalcommits.org), such as `fix: the sidebar keeps its place after a restart`. Pull requests are squash-merged, so the title becomes the commit message.
- Say what problem it solves and how you checked it. For anything visible, add screenshots in light and dark.
- When you change how something in `src/` behaves, add or update a unit test.
- Leave the text Canopy sends to the model alone unless it is the point of your change. Some of it, such as `CANOPY_FACTS` in `src/core/facts.mjs`, starts every chat. One changed character makes every open chat read its whole conversation again at full price.

By contributing, you agree that your work is released under the [MIT License](LICENSE).

## Changes written with AI

They are welcome on the same terms as any other change. Say so in the pull request, understand every line you submit, and be ready to answer questions about it. Leave tool-added trailers and signatures out of commit messages.
