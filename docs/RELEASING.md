# Releasing Canopy

How a new version of Canopy gets to the people who use it. Everything is one command; this page says what it does and what to do when something goes wrong.

## What a release is

Three files on a GitHub release of `KrishVazirani18/canopy`:

| File | Who uses it |
| --- | --- |
| `Canopy.dmg` | A person downloading Canopy. Always this name, so the link `https://github.com/KrishVazirani18/canopy/releases/latest/download/Canopy.dmg` always gets the newest one. |
| `Canopy-<version>-mac.zip` | A running Canopy, to update itself. |
| `latest.json` | A running Canopy, to find out there is an update: the version, the zip's address, size and SHA-256, and the oldest version still allowed to run. |

Every Canopy checks `latest.json` a minute after it opens and every four hours. It downloads a newer version in the background, checks it, and installs it when the person presses "Restart to update" or next quits. It never restarts while a chat is working.

The app runs on Apple silicon and Intel Macs (one universal build), macOS 13 or newer.

## A normal release

```
npm run release -- patch
```

`patch` takes 0.1.0 to 0.1.1. Use `minor` (0.2.0), `major` (1.0.0) or a full version (`0.3.0`) instead when that is what you mean.

It needs: a Mac, about 3 GB of free disk, nothing uncommitted, and `gh` signed in. It takes about two minutes and does this:

1. Runs the tests.
2. Builds `Canopy.app` and has the app check itself (it starts in a throwaway data folder and confirms the terminal, Code Mode, the plugins and the updater all work inside the bundle). A build that fails a check is never published.
3. Makes the three files in `dist/release/`.
4. Drafts the release notes from the commits since the last release: `feat` commits under New, `fix` under Fixed, `perf` under Faster. To write your own, put them in a file and add `--notes-file notes.md`.
5. Writes the version into `package.json`, commits `release: v0.1.1`, tags it, and publishes the release with `gh`.

To see everything it would do without publishing: add `--dry-run`. That builds all the files and stops; no commit, no tag, nothing online.

## A required release

When everyone has to update (a fix they must not go without, or a change the old version cannot work with):

```
npm run release -- patch --required "This update fixes sign-in. Restart to continue."
```

The words are what people read, so write them plainly: what the update is for, in one or two short sentences.

What happens on their side: any Canopy older than this release shows "Update required" over the whole window, with your words and one button. The button downloads the update, installs it and restarts. If chats are working it waits for them to finish first.

Three things worth knowing:

- It stays required. Later ordinary releases carry the same floor forward, so someone who opens a months-old Canopy is still asked to update.
- It never locks anyone out by accident. The screen only appears after Canopy has read the feed in that session, so being offline changes nothing, and if the download fails the screen offers "Not now".
- You cannot take it back for people who already updated, but you can lift it for the rest: see "A release went wrong".

## A release went wrong

Canopy only ever moves forward: it installs a version newer than the one it has. So the fix for a bad release is a newer good one.

**First, stop more people getting it** (takes effect within four hours, as each Canopy next checks):

```
gh release edit v0.1.2 --repo KrishVazirani18/canopy --prerelease
```

GitHub's "latest" then points at the release before, and so do the download link and the update feed. People who have not updated yet stay where they are. Deleting the release does the same: `gh release delete v0.1.2 --repo KrishVazirani18/canopy --cleanup-tag`.

**Then get the people who did update onto something good.** Undo the change in git (`git revert <commit>`), and release again with the next number:

```
npm run release -- patch
```

**If the bad release was a required one** and you marked it prerelease, the feed people read is the one from the release before, with the floor it had. Nothing more to do.

**What Canopy does on its own.** After "Restart to update", the old app is kept until the new one has opened its window. If the new one does not start, the old one is put back and opened again, that version is not tried again by itself, and the person sees one line saying so. After an update installed on quit, the old app is kept in `~/Library/Application Support/Canopy/updates/previous` until the new one has started once.

## Rehearse an update

To watch an update happen without publishing anything. This uses a copy of Canopy in a temporary folder with its own data, so your own Canopy is not touched.

```
# 1. Build the version to update from, and install it somewhere throwaway
npm run release -- 0.1.0 --dry-run --out /tmp/canopy-rehearsal/base
mkdir -p /tmp/Applications-test
ditto -x -k /tmp/canopy-rehearsal/base/Canopy-0.1.0-mac.zip /tmp/Applications-test

# 2. Build the version to update to (add --required "..." to rehearse a required update)
npm run release -- 0.1.1 --dry-run --out /tmp/canopy-rehearsal/feed --previous-feed /tmp/canopy-rehearsal/base/latest.json

# 3. Serve that folder, and open the old version pointed at it
python3 -m http.server 18765 --bind 127.0.0.1 -d /tmp/canopy-rehearsal/feed &
open -n /tmp/Applications-test/Canopy.app --env CANOPY_USER_DATA=/tmp/canopy-rehearsal/data \
  --env CANOPY_UPDATE_FEED=http://127.0.0.1:18765/latest.json
```

Within a few seconds the sidebar shows "Update ready". What it did is in `/tmp/canopy-rehearsal/data/canopy.log` (lines starting `update:`) and `/tmp/canopy-rehearsal/data/updates/swap.log`.

`CANOPY_UPDATE_FEED` only accepts an address on this Mac (127.0.0.1 or localhost). `CANOPY_UPDATE_INSTALL_PATH` names a different copy to replace than the one running, if you need that.

## Signing

Releases are signed with the Developer ID "Developer ID Application: Krish Vazirani (99BZGU2598)" and notarized by Apple, so Canopy opens with no warning. The certificate and its private key are in the login keychain; Apple's notary credentials are the keychain profile `canopy` (`xcrun notarytool store-credentials canopy`). Set these before a release:

```
export CANOPY_SIGN_IDENTITY="Developer ID Application: Krish Vazirani (99BZGU2598)"
export APPLE_KEYCHAIN_PROFILE="canopy"
export CANOPY_BUILD_CONFIG="/path/to/build-config.json"
npm run release -- patch
```

`CANOPY_BUILD_CONFIG` names the file with the project's sign-in and stats values (the four in `src/build-config.mjs`). They are not secrets, but they are the project's, so they are kept outside the repository and written into the build only when a release is made. Without them a release stops: a Canopy with no Google sign-in and no usage stats must never go out by mistake. The app checks itself for both before anything is published.

The build then signs the app with the hardened runtime, has Apple notarize it (usually a few minutes), staples the ticket, and does the same for the disk image. Without `CANOPY_SIGN_IDENTITY` the build falls back to an ad hoc signature, and macOS asks people to allow the app once under Privacy & Security; don't publish one of those.

A signed Canopy only accepts updates signed by the same team, which is checked before anything is installed. The certificate expires on 2027-12-22: renew it before then in the Apple developer account, and keep the private key backed up, since a new key means a new certificate.

## Where things are

| | |
| --- | --- |
| `src/app-info.mjs` | The app's id and the repository releases go to. Change either here, nowhere else. |
| `scripts/release.mjs` | The release command. |
| `scripts/build-app.mjs` | Builds `Canopy.app`: what goes in, the signing. `npm run build:app` runs it alone. |
| `scripts/make-dmg.mjs` | Builds `Canopy.dmg` with the approved window. `npm run build:dmg` runs it alone. |
| `assets/dmg/` | The disk image's design. After changing `background.html`, run `node scripts/dmg-background.mjs`. |
| `src/core/app-update.mjs` | The updater inside the app. `src/core/app-update-swap.sh` is the helper that swaps the app. |
| `src/selftest.mjs` | The checks the built app runs on itself. |
