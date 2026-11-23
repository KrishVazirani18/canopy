// Canopy owns this socket and the daemon. Engine subprocesses only relay stdio.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backgroundChromeServer } from './background-chrome.mjs';

export function createBackgroundChromeHost({ log = () => {} } = {}) {
  let directory;
  let child;
  let closed = false;
  const token = randomBytes(24).toString('hex');
  const base = backgroundChromeServer();
  return {
    configuration() {
      if (!base || closed) return null;
      try {
        if (!directory) directory = mkdtempSync('/tmp/canopy-chrome-');
        const socket = path.join(directory, 'mcp');
        if (!child) {
          rmSync(socket, { force: true });
          const proc = spawn(base.command, [...base.args, socket], {
            env: { ...process.env, ...base.env, CANOPY_CHROME_TOKEN: token }, stdio: ['pipe', 'ignore', 'ignore'],
          });
          child = proc;
          proc.stdin.on('error', () => {});
          proc.stdin.unref?.();
          proc.unref();
          proc.once('error', (error) => log(`background Chrome: ${error.message}`));
          proc.once('close', () => { if (child === proc) child = null; });
        }
        return { ...base, args: [fileURLToPath(new URL('./background-chrome-client.mjs', import.meta.url)), socket], env: { ...base.env, CANOPY_CHROME_TOKEN: token } };
      } catch (error) { log(`background Chrome: ${error.message}`); return null; }
    },
    close() {
      closed = true;
      child?.stdin.end();
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
}
