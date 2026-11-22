# Security

## Reporting a problem

Report it privately. Open this repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue or pull request for it.

Say what you found, how to reproduce it, and which versions of Canopy and macOS you used. Leave chat content, file paths and keys out of the report unless they are the point.

You will get a reply as soon as possible. Please allow a week before following up.

## Supported versions

Only the latest version gets fixes: the newest release once there is one, and the `main` branch until then.

## What Canopy is, and is not

Canopy is a window onto the Claude Code and Codex on your own Mac.

- **It is not a sandbox.** Claude Code and Codex run as you, with your files and your permissions, exactly as they do in the terminal. The permission mode you pick decides what they ask before doing.
- **It does not hold your plan sign-in.** You sign in to Claude Code and Codex through their own sign-in. Canopy asks each tool who is signed in. It never opens their login files or Keychain entries, and it refuses a sign-in token pasted where an API key belongs.
- **An API key you add is kept encrypted.** The key that encrypts it lives in the macOS Keychain, the file it is stored in is readable by you alone, and it is sent only to its maker.
- **Your chats stay on your Mac.** Usage stats are counts, and everything that may be sent is listed in [src/telemetry/schema.mjs](src/telemetry/schema.mjs).

## What counts

Please report:

- A way for a web page, a file, a reply or a widget to run code or read files beyond what the chat was allowed to do.
- A way to make Canopy approve something you did not approve.
- An API key, a sign-in or chat content reaching a log, the usage stats or anywhere off your Mac.

These are not problems in Canopy:

- Something Claude Code or Codex does that it would also do in the terminal. Report that to Anthropic or OpenAI.
- What a chat does in a permission mode that lets it.
- Anything that needs someone to already control your Mac account.

## Builds

Releases are signed with a Developer ID (team 99BZGU2598) and notarized by Apple, so macOS checks both before Canopy first opens. Each release also lists the SHA-256 of its download, so you can see that it arrived whole:

```sh
shasum -a 256 ~/Downloads/Canopy.dmg
```

A checksum published beside a download shows the file was not damaged on the way. It does not show who made it: someone able to replace the download could replace the checksum too.

### Updates

Canopy updates itself ([src/core/app-update.mjs](src/core/app-update.mjs)). It reads `latest.json` from the newest release of this repository over HTTPS, downloads the zip it names, and checks the zip's SHA-256 and size against it. The app inside must carry Canopy's bundle id, be the version the feed named, pass `codesign --verify` and be signed by the same developer team as the running Canopy. The old app is kept until the new one has started, and put back if it does not.

Like the checksum above, `latest.json` comes from the same release as the zip, so it protects against damage, not against someone who controls the release. A release may also set a minimum version; older copies then ask to update before going on. Offline, or with a feed that cannot be read, nothing is blocked.

