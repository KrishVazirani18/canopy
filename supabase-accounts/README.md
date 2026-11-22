# The Canopy account's database

An official build of Canopy asks you to sign in with Google once. That sign-in is Supabase Auth, and these two migrations are everything the project adds to it. A copy built from source has no account and never talks to this database.

## What is stored

One row per person in `public.profiles`:

| Column | What it holds |
| --- | --- |
| `id` | The Supabase Auth user this row belongs to. |
| `email`, `name`, `avatar_url` | What Google gave at sign-in. |
| `app_version` | The version of Canopy that last opened. |
| `created_at`, `last_seen_at` | When the account was made, and when Canopy was last opened. |

Nothing about chats, projects, files or usage is stored here. Usage stats are a separate thing and go elsewhere: see `src/telemetry/schema.mjs`.

## The migrations

- `20261119000001_profiles.sql` creates the table and a trigger that fills a row when someone signs in for the first time. Row-level security is on: a signed-in person can read and update their own row and no one else's, and nobody can list the table.
- `20261119000002_delete_my_account.sql` adds `delete_my_account()`, which **Settings > You > Delete Account** calls. It deletes the caller's own Auth user, and the row goes with it.

## The key inside the app

The Supabase URL and publishable key ship inside an official build. They are not secrets: with them and no sign-in, the policies above give access to nothing, and with a sign-in, to that person's own row only. They are still the project's, so the repository does not hold them (`src/build-config.mjs` says how a build gets them).

## Using your own

To give a build of your own an account list, create a Supabase project, turn on Google sign-in, allow `http://127.0.0.1:*/callback` as a redirect, and apply both files in order. Then start Canopy with `CANOPY_SUPABASE_URL` and `CANOPY_SUPABASE_KEY` set to your project's URL and publishable key.
