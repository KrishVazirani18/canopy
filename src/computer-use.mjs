// What Codex needs before it can use the Mac (Computer Use), as Settings → Codex shows it and a failed step points
// at. Everything here is read from Codex itself or is a link into System Settings; nothing under ~/.codex is opened
// for writing, and the one change Canopy can make goes through Codex's own config call, on the user's click.
//
// What was found (Codex 0.169.0, Computer Use helper 26.1111, read from the binaries and the bundled plugin):
//   - Computer Use is the `computer_use` feature (experimentalFeature/list says whether it is on; on by default)
//     plus a helper app Codex installs at <CODEX_HOME>/computer-use/"Codex Computer Use.app" (bundle id
//     com.openai.sky.CUAService). The tool the model calls is `cua_repl` from the unified-computer-use plugin.
//   - macOS permissions: the helper needs Accessibility and Screen Recording (its own words: "the user has not
//     finished granting Accessibility and Screen Recording permissions"). Its Info.plist also asks for Automation
//     (Apple Events, to send messages you approve), Calendars and Contacts, for the other tools it carries; macOS
//     asks for those by itself the first time. Whether a permission is granted to another app cannot be read
//     without Full Disk Access, so Canopy never claims a status: it opens the pane.
//   - Which apps: Codex's config has `computer_use.default_app_access` ("allow" | "deny") and
//     `computer_use.macos.bundle_ids` ({ <bundle id>: "allow" | "deny" }), shown here as they are. The apps you
//     said "Always allow" to are kept by Computer Use itself, in a store with no call to list or change it, so
//     those are changed in the Codex app (bundle id com.openai.codex).
import fs from 'node:fs';
import path from 'node:path';

const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

export const FEATURE = 'computer_use';
export const HELPER_APP = 'Codex Computer Use.app';
export const CODEX_APP_ID = 'com.openai.codex';
const PRIVACY = 'x-apple.systempreferences:com.apple.preference.security?';
/** The System Settings panes a card or a row may open. Nothing else is ever handed to macOS from here. */
export const PANES = Object.freeze({
  accessibility: `${PRIVACY}Privacy_Accessibility`,
  screen: `${PRIVACY}Privacy_ScreenCapture`,
  automation: `${PRIVACY}Privacy_Automation`,
});
/** What Computer Use needs from macOS. `needed`: it cannot work without it. */
export const PERMISSIONS = Object.freeze([
  { key: 'accessibility', label: 'Accessibility', detail: 'So it can click and type in your apps', needed: true },
  { key: 'screen', label: 'Screen & System Audio Recording', detail: 'So it can see the app it is working in', needed: true },
  { key: 'automation', label: 'Automation', detail: 'Only to send messages you approve', needed: false },
]);

/** Which apps Computer Use may touch, as Codex's own config says it. */
export function appAccess(config) {
  const cu = isPlain(config?.computer_use) ? config.computer_use : {};
  const ids = isPlain(cu.macos?.bundle_ids) ? cu.macos.bundle_ids : {};
  const listed = Object.entries(ids).filter(([id, v]) => typeof id === 'string' && (v === 'allow' || v === 'deny')).slice(0, 200).map(([id, access]) => ({ id, access }));
  return { any: cu.default_app_access !== 'deny', listed };
}

/** Is the feature on, from experimentalFeature/list's rows. null when Codex did not say. */
export function featureOn(rows) {
  const row = (Array.isArray(rows) ? rows : []).find((f) => isPlain(f) && f.name === FEATURE);
  return row ? row.enabled === true : null;
}

/** One line for Settings: is Computer Use ready as far as Codex is concerned? */
export function summary({ installed, on }) {
  if (on === false) return { state: 'off', line: 'Turned off in Codex' };
  if (!installed) return { state: 'missing', line: 'Not set up yet. Codex installs it the first time you use it in the Codex app.' };
  if (on === null) return { state: 'unknown', line: 'Installed. Codex is not answering, so Canopy cannot tell if it is on.' };
  return { state: 'on', line: 'On' };
}

/**
 * @param {{ service: { call: (method: string, params?: object) => Promise<{ok: boolean, result?: any}> }, codexHome: () => string,
 *   openExternal: (url: string) => Promise<unknown> | unknown, openApp: (bundleId: string) => Promise<unknown> | unknown,
 *   version?: (plist: string) => Promise<string | null>, log?: (msg: string) => void }} deps
 */
export function createComputerUse({ service, codexHome, openExternal, openApp, version = async () => null, log = () => {} }) {
  const call = async (method, params) => { try { const r = await service.call(method, params); return r?.ok === true ? r.result : null; } catch { return null; } };
  return {
    /** Everything the Settings section shows. Never throws; what Codex did not answer is null. */
    async status() {
      let installed = false;
      let helperVersion = null;
      try {
        const app = path.join(codexHome(), 'computer-use', HELPER_APP);
        installed = fs.existsSync(app);
        if (installed) helperVersion = await version(path.join(app, 'Contents', 'Info.plist')).catch(() => null);
      } catch { /* not there */ }
      const [features, config] = await Promise.all([call('experimentalFeature/list', {}), call('config/read', { includeLayers: false })]);
      const on = featureOn(features?.data);
      return {
        installed, version: helperVersion, on, ...summary({ installed, on }),
        apps: isPlain(config?.config) ? appAccess(config.config) : null,
        permissions: PERMISSIONS,
      };
    },
    /** Turn the feature on in the user's Codex config, through Codex's own config call. Only ever on a click. */
    async turnOn() {
      const r = await service.call('config/value/write', { keyPath: `features.${FEATURE}`, value: true, mergeStrategy: 'upsert' }).catch(() => null);
      if (r?.ok !== true) log(`computer use: could not turn it on: ${r?.message ?? 'no answer'}`);
      return { ok: r?.ok === true };
    },
    /** Open one privacy pane of System Settings. An unknown key opens nothing. */
    async openPane(key) {
      const url = Object.hasOwn(PANES, key) ? PANES[key] : null;
      if (!url) return { ok: false };
      try { await openExternal(url); return { ok: true }; } catch { return { ok: false }; }
    },
    async openCodexApp() {
      try { await openApp(CODEX_APP_ID); return { ok: true }; } catch { return { ok: false }; }
    },
  };
}
