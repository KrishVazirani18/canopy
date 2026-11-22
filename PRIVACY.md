# Privacy

Canopy is in a small beta. This page says plainly what it keeps and where.

## What stays on your Mac

Your chats, your code and files, and everything Claude Code and Codex write. Canopy runs the copies of Claude Code and Codex on your Mac with your own sign-ins; there is no Canopy server between you and them, and Canopy never reads or stores their sign-ins.

## Your Canopy account

The downloaded app asks you to sign in with Google once. Canopy keeps your email, name and profile picture, when you signed up, when you last opened Canopy, and which version you run. It is stored with [Supabase](https://supabase.com). Settings > You shows the account and can delete it, which removes it.

## Usage stats

Canopy sends counts so it can get better, never content: which parts of Canopy you use, the models and versions you run, how long replies take, the first line of an error, and how many messages you send each day in Claude Code and Codex. The full list is [src/telemetry/schema.mjs](src/telemetry/schema.mjs), and [docs/telemetry.md](docs/telemetry.md) has the details. Stats go to [PostHog](https://posthog.com), with IP addresses discarded. Turn them off in Settings > You (**Share usage stats**).

## How long it is kept

For as long as the beta runs. Ask and it is deleted.

## Contact

krishvazirani1018@gmail.com
