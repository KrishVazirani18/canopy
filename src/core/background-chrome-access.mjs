import { setTimeout as delay } from 'node:timers/promises';
import { CHROME_ALLOW_PROMPT, CHROME_CONNECT_PROMPT, CHROME_SETUP_HELP } from './background-chrome.mjs';

// One authorization and one browser connection for all chats in this app instance.
export function chromeAccess({ ready, connect, waitMs = 120_000, intervalMs = 350 }) {
  let browser;
  let opening;
  const open = async (ask, signal) => {
    const needsSetup = !(await ready());
    const answer = await ask(needsSetup ? CHROME_CONNECT_PROMPT : CHROME_ALLOW_PROMPT);
    signal.throwIfAborted();
    if (answer !== 'accept') throw new Error('Chrome connection skipped.');
    if (needsSetup) {
      const expires = Date.now() + waitMs;
      while (!(await ready())) {
        if (Date.now() >= expires) throw new Error(`Chrome setup timed out. ${CHROME_SETUP_HELP}`);
        await delay(intervalMs, undefined, { signal });
      }
    }
    signal.throwIfAborted();
    return connect();
  };
  return async (ask, signal) => {
    signal.throwIfAborted();
    if (browser?.connected) return;
    opening ??= open(ask, signal).then((opened) => { browser = opened; }).finally(() => { opening = null; });
    // The browser approval can outlive any waiting tool. A cancelled caller stops here without cancelling other chats.
    let abort;
    try {
      await Promise.race([opening, new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } finally { signal.removeEventListener('abort', abort); }
  };
}
