# Usage stats

Canopy sends counts, never content, so it can tell what to improve.

- **The list.** Every event and every field Canopy may send is in [src/telemetry/schema.mjs](../src/telemetry/schema.mjs). Anything not on that list is dropped before it leaves the Mac, and free text (an error's first line) is scrubbed of paths, emails and anything shaped like a key.
- **Never sent.** What you write, what Claude or Codex reply, your code and files, and the names of your files, folders, projects and chats.
- **Where it goes.** [PostHog](https://posthog.com), straight from the app, with IP addresses discarded. Each install has a random ID, and a name only if you add one.
- **Seeing it.** Settings > You lists every event exactly as it was sent.
- **Turning it off.** Switch off **Share usage stats** in Settings > You, or start Canopy with `CANOPY_TELEMETRY=0`. Nothing is sent before the first-launch notice is answered, and a copy built from source sends nothing.
