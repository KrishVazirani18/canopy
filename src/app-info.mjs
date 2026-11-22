// What Canopy is called to macOS, and where its releases live. The one place to change either: the app's updater
// (src/core/app-update.mjs), the build and release scripts (scripts/), and the dev bundle (scripts/brand-dev.mjs)
// all read from here.

/** The app's name: the bundle is Canopy.app, the disk image Canopy.dmg. */
export const PRODUCT_NAME = 'Canopy';

/** Canopy's bundle id. macOS files permissions, notifications and the Keychain under it. */
export const APP_ID = 'io.github.krishvazirani18.canopy';
/** A copy run from source (`npm start`): a separate app to macOS, so it never shares the released app's permissions. */
export const DEV_APP_ID = `${APP_ID}.dev`;

/** The GitHub repository releases are published to and read from, as owner/name. It has to be public. */
export const RELEASE_REPO = 'KrishVazirani18/canopy';

const releases = (repo = RELEASE_REPO) => `https://github.com/${repo}/releases`;

/** The download link: always the newest disk image, because every release uploads one under this same name. */
export const DMG_NAME = `${PRODUCT_NAME}.dmg`;
export const downloadUrl = (repo) => `${releases(repo)}/latest/download/${DMG_NAME}`;

/** The update feed: one small JSON file on the newest release (what is in it: src/core/app-update.mjs). */
export const FEED_NAME = 'latest.json';
export const feedUrl = (repo) => `${releases(repo)}/latest/download/${FEED_NAME}`;

/** The zip a running Canopy updates itself from, and where a release keeps it. */
export const zipName = (version) => `${PRODUCT_NAME}-${version}-mac.zip`;
export const zipUrl = (version, repo) => `${releases(repo)}/download/v${version}/${zipName(version)}`;
