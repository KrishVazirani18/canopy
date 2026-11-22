// The frame's side of the bridge: MCP Apps' JSON-RPC 2.0 over postMessage, to the one window that embeds it.
// Requests get an answer or time out; notifications are one-way. Nothing else is said to, or heard from, anyone.

type Json = Record<string, unknown>;
type Pending = { resolve: (v: Json) => void; reject: (e: Error) => void; timer: number };

const pending = new Map<number, Pending>();
const handlers = new Map<string, (params: Json) => void>();
let nextId = 1;

const post = (msg: Json) => window.parent.postMessage({ jsonrpc: '2.0', ...msg }, '*');

/** Ask the host for something. Rejects when it refuses, or has not answered in `ms`. */
export function request(method: string, params: Json = {}, ms = 10_000): Promise<Json> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = window.setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, ms);
    pending.set(id, { resolve, reject, timer });
    post({ id, method, params });
  });
}

/** Tell the host something it does not answer. */
export const notify = (method: string, params: Json = {}) => post({ method, params });

/** Hear a notification from the host. */
export const on = (method: string, handler: (params: Json) => void) => { handlers.set(method, handler); };

window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const m = e.data as { jsonrpc?: string; id?: number; method?: string; params?: Json; result?: Json; error?: { message?: string } } | null;
  if (!m || m.jsonrpc !== '2.0') return;
  if (typeof m.method === 'string') {
    // A request from the host (teardown, ping) is answered with nothing: the frame has nothing to save on the way out.
    if (m.id !== undefined) post({ id: m.id, result: {} });
    try { handlers.get(m.method)?.(m.params ?? {}); } catch (err) { console.error(err); }
    return;
  }
  const p = typeof m.id === 'number' ? pending.get(m.id) : undefined;
  if (!p) return;
  pending.delete(m.id as number);
  clearTimeout(p.timer);
  if (m.error) p.reject(new Error(String(m.error.message ?? 'Refused'))); else p.resolve(m.result ?? {});
});
