// Canopy's own plugin: what every chat is given besides its tools, whichever maker's model it runs on.
//
//   resources/canopy-plugin/            one folder, in the shape of a Claude Code plugin
//     .claude-plugin/plugin.json        the manifest. Its name, "canopy", is what both makers file the skills under
//     skills/canopy/SKILL.md            how Canopy itself works, for when the user asks
//
//  - A Claude chat is given the folder as a local plugin: the SDK's `plugins` option (session.mjs).
//  - A Codex chat is given its skills/ folder as one more place to look for skills, for that process only:
//    `skills/extraRoots/set`, said before the thread opens (codex-session.mjs).
// Neither writes anything under ~/.claude or ~/.codex, and both list the skill under the same name, canopy:canopy
// (checked live Nov 16 2026 on Claude Code 2.1.325 and Codex 0.169.0, which reads the manifest
// beside the skills folder for the name).
//
// Only a skill's name and description are in every chat: 84 tokens by Claude Code's own count. The body is
// read when a model asks for the skill. So the descriptions are the part to keep short, and they say when to load.
// A chat that started before the plugin and is reopened with it pays for those two lines and nothing more (measured:
// 185 tokens written on its next turn; the rest of what it re-reads is the same as without the plugin).
//
// A `verify` skill (how to check a change in this project) shipped here on Nov 16 2026 and was taken out the next
// day. Measured on Claude Code 2.1.325 (176 sessions, five small projects): no model loaded it by itself after a
// change (0 of 79 runs), so listed it changed neither results nor cost, and these models already ran a project's
// tests unasked (22 of 24). Typed as a command it made every reply end with what was and wasn't checked, but it sat
// in the / menu beside Claude Code's own /verify, and the team's feedback was that models already test too much.
//
// The folder is read by programs outside Canopy, so it has to be a real folder on disk. Inside a packaged app
// Electron's app.asar is a folder to Electron alone: `pluginDir` gives the unpacked twin of a path in one, and the
// packaging has to put resources/canopy-plugin there (asarUnpack, or an extra resource).
//
// The kit (resources/canopy-kit, below) is the one other plugin, kept apart so it can be turned off.
//
// Anything else Canopy bundles for Claude Code as a plugin (language servers in .lsp.json, agents, hooks) goes in the
// same folder under the same manifest: one plugin, one `plugins` entry, one name.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The plugin's name in its manifest: the prefix of every skill in it (canopy:canopy). */
export const PLUGIN_NAME = 'canopy';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where the plugin is, as a path another program can open. `root` is the app's folder (the one holding src/). */
export function pluginDir(root = path.join(HERE, '..', '..')) {
  return path.join(root, 'resources', 'canopy-plugin').replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked');
}

/**
 * The plugin on disk: { dir, skillsDir, skills } with the names of its skills in a fixed order, or null when the
 * folder is missing or is not a plugin (a build that left it out). Never throws.
 */
export function canopyPlugin(dir = pluginDir()) {
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || !existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) return null;
    const skillsDir = path.join(dir, 'skills');
    const skills = existsSync(skillsDir)
      ? readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(path.join(skillsDir, e.name, 'SKILL.md'))).map((e) => e.name).sort()
      : [];
    return { dir, skillsDir, skills };
  } catch { return null; }
}

/** For a Claude chat: the Agent SDK's `plugins` option, or undefined when there is no plugin. Takes several. */
export function claudePlugins(...plugins) {
  const list = plugins.filter((p) => p?.dir).map((p) => ({ type: 'local', path: p.dir }));
  return list.length ? list : undefined;
}

/** For a Codex chat: the folders `skills/extraRoots/set` is given. Empty when there is nothing to add. Takes several. */
export function codexSkillRoots(...plugins) {
  return plugins.filter((p) => p?.skills?.length).map((p) => p.skillsDir);
}

// Canopy Kit: a second plugin beside Canopy's own, resources/canopy-kit, with guidance for work the user and the
// project leave open (for now its Design section: the canopy-kit:design and canopy-kit:design-taste skills). It is
// on unless the user turns it off in Settings > General, and that choice is read when a chat is created, so a chat
// keeps what it started with. It is a plugin of its own, under its own name, so turning it off takes its skills out
// of the chat entirely instead of leaving their descriptions listed.
//
// With the kit on, a chat is also told it exists (KIT_NOTE, after the facts in what Canopy adds to the prompt).
// Measured Nov 19 2026 on Claude Code 2.1.328, Opus 5.5, ten one-shot asks: without the line Claude loaded
// canopy-kit:design for 5 of 7 design asks; with it, 7 of 7; neither loaded it for any of the 3 non-design asks.
// The line names the kit only, never anything about the moment, so it is the same in every chat that has it.

/** The kit's name in its manifest: the prefix of its skills (canopy-kit:design). */
export const KIT_NAME = 'canopy-kit';

/** Where the kit is, as a path another program can open (see pluginDir). */
export function kitDir(root = path.join(HERE, '..', '..')) {
  return path.join(root, 'resources', 'canopy-kit').replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked');
}

/** What a chat with the kit is told, after the facts about Canopy. */
export const KIT_NOTE = 'Canopy Kit is on. For any visual work (web pages, app screens, components, dashboards, decks, PDFs, posters), load canopy-kit:design before building. The user\'s words and the project\'s existing design come first; the kit only fills what they leave open.';
