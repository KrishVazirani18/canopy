// The tool relay's helper: the MCP server an agent starts to reach Canopy's tools.
//
// Canopy never imports this file to run it. tool-relay.mjs hands its text to node with -e (as code-mode.mjs hands
// over its runner), and the agent starts that as its MCP server `canopy`. The helper holds no tool of its own: it
// asks the app which tools this chat has and passes every call on.
//
//   agent  <- stdio: MCP, one JSON-RPC message per line ->  helper  <- Unix socket: tool-relay.mjs's wire ->  Canopy
//
//   CANOPY_TOOLS_SOCKET   the socket to reach Canopy on
//   CANOPY_TOOLS_TOKEN    says which chat this is; sent first on every connection, and nowhere else
//
// It answers initialize, ping, tools/list and tools/call, and passes notifications/cancelled on. Any other request
// is "method not found", and a line that is not a JSON-RPC message is ignored. When its input ends the agent has
// gone, and so does it. When Canopy cannot be reached, a call is answered with a tool result that says so, and the
// next call tries the socket again.
import net from 'node:net';

const SOCKET = process.env.CANOPY_TOOLS_SOCKET ?? '';
const TOKEN = process.env.CANOPY_TOOLS_TOKEN ?? '';
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']; // the MCP versions this speaks, newest first
const CONNECT_MS = 5000;
const UNREACHABLE = 'Canopy could not be reached, so this tool did not run. Try once more; if it fails again, carry on without it and tell the user.';

const failed = (text) => ({ content: [{ type: 'text', text }], isError: true });
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const short = (v) => (typeof v === 'string' && v.length <= 200 ? v : null);

// Whole lines out of a stream that arrives in pieces. A result can be a megabyte (a screenshot), so only the new
// piece is searched for the line's end.
function lines(onLine) {
  let parts = [];
  return (chunk) => {
    let from = 0;
    for (let at = chunk.indexOf('\n'); at >= 0; at = chunk.indexOf('\n', from)) {
      parts.push(chunk.slice(from, at));
      const line = parts.join('');
      parts = [];
      from = at + 1;
      if (line.trim()) onLine(line);
    }
    if (from < chunk.length) parts.push(chunk.slice(from));
  };
}

// ---- the agent's side ----

function say(msg) { try { process.stdout.write(`${JSON.stringify(msg)}\n`); } catch { process.exit(0); } }
const reply = (id, result) => say({ jsonrpc: '2.0', id, result });
const refuse = (id, code, message) => say({ jsonrpc: '2.0', id, error: { code, message } });

// ---- Canopy's side ----

let link = null;   // the connection in use: { socket, ready, closed, calls }
let callSeq = 0;

// The connection to Canopy, made on first use and again after it was lost. `ready` resolves to this chat's tools
// once Canopy has taken the token, and rejects when it does not.
function connect() {
  if (link && !link.closed) return link;
  const l = { socket: null, closed: false, calls: new Map(), ready: null };
  l.ready = new Promise((resolve, reject) => {
    const lost = () => {
      if (l.closed) return;
      l.closed = true;
      clearTimeout(timer);
      reject(new Error('closed'));
      for (const done of l.calls.values()) done(failed(UNREACHABLE));
      l.calls.clear();
    };
    const timer = setTimeout(() => { l.socket?.destroy(); lost(); }, CONNECT_MS);
    if (!SOCKET || !TOKEN) return lost();
    const socket = net.createConnection(SOCKET);
    l.socket = socket;
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ t: 'hello', token: TOKEN })}\n`));
    socket.on('data', lines((line) => {
      let m = null;
      try { m = JSON.parse(line); } catch { return; }
      if (m?.t === 'ready') { clearTimeout(timer); resolve(Array.isArray(m.tools) ? m.tools : []); }
      else if (m?.t === 'result') { const done = l.calls.get(m.id); if (done) { l.calls.delete(m.id); done(m.result); } }
    }));
    socket.on('error', () => {}); // the close that follows says it
    socket.on('close', lost);
  });
  l.ready.catch(() => {});
  link = l;
  return l;
}

const running = new Map(); // the agent's request id -> { l, id }: a call it may yet cancel

async function call(rpcId, params) {
  const p = isObj(params) ? params : {};
  const turn = isObj(p._meta?.['x-codex-turn-metadata']) ? p._meta['x-codex-turn-metadata'] : {};
  const l = connect();
  try { await l.ready; } catch { return failed(UNREACHABLE); }
  if (l.closed) return failed(UNREACHABLE);
  const id = ++callSeq;
  const answered = new Promise((resolve) => l.calls.set(id, resolve));
  running.set(rpcId, { l, id });
  l.socket.write(`${JSON.stringify({
    t: 'call', id, name: String(p.name ?? ''), args: isObj(p.arguments) ? p.arguments : {},
    // Which call of which turn this is, as the agent names it: Canopy ties its approval card to that row.
    meta: { callId: short(p._meta?.callId), threadId: short(turn.thread_id), turnId: short(turn.turn_id) },
  })}\n`);
  const result = await answered;
  running.delete(rpcId);
  return isObj(result) && Array.isArray(result.content) ? result : failed('Canopy sent back nothing for this call. Try once more.');
}

function cancel(rpcId) {
  const r = running.get(rpcId);
  if (!r) return;
  running.delete(rpcId);
  if (!r.l.closed) r.l.socket.write(`${JSON.stringify({ t: 'cancel', id: r.id })}\n`);
}

async function hear(line) {
  let m = null;
  try { m = JSON.parse(line); } catch { return; }
  if (!isObj(m) || typeof m.method !== 'string') return; // an answer to nothing this asked, or not a message at all
  const { id, method, params } = m;
  const asked = id !== undefined && id !== null;
  if (method === 'notifications/cancelled') return cancel(params?.requestId);
  if (!asked) return; // any other notification
  switch (method) {
    case 'initialize': {
      const wanted = params?.protocolVersion;
      // Connecting now, not at the first tools/list, so the tools are usually there by the time they are asked for.
      connect();
      return reply(id, { protocolVersion: VERSIONS.includes(wanted) ? wanted : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'canopy', version: '1.0.0' } });
    }
    case 'ping': return reply(id, {});
    case 'tools/list':
      try { return reply(id, { tools: await connect().ready }); }
      catch { return refuse(id, -32603, 'Canopy could not be reached, so its tools are not available.'); }
    case 'tools/call': return reply(id, await call(id, params));
    default: return refuse(id, -32601, `Method not found: ${method}`);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', lines((line) => { hear(line).catch(() => {}); }));
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
