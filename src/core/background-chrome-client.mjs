// Both agents speak normal MCP over stdio to the app's shared local server.
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const path = process.argv[2];
for (let attempt = 0; ; attempt++) {
  const socket = net.createConnection(path);
  try { await once(socket, 'connect'); }
  catch (error) {
    socket.destroy();
    if (attempt < 50 && ['ENOENT', 'ECONNREFUSED'].includes(error.code)) { await delay(100); continue; }
    console.error('Canopy’s Chrome connector is unavailable. Reopen the chat and try again.');
    process.exit(1);
  }
  socket.on('error', () => { process.exitCode = 1; });
  socket.on('close', () => process.stdin.pause());
  socket.write(process.env.CANOPY_CHROME_TOKEN || '');
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  break;
}
