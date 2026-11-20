/** Browser-compatible replacement for @tauri-apps/api/event. */
type EventCallback<T = unknown> = (event: { payload: T; event: string }) => void;

const base = () => (globalThis as { __FABRIC_LAN_API__?: string }).__FABRIC_LAN_API__ || "";
let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Map<string, Set<EventCallback>>();

function ensureSocket() {
  if (socket || retry !== undefined || listeners.size === 0) return;
  const url = new URL(`${base()}/api/events`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const connection = new WebSocket(url);
  socket = connection;
  connection.onmessage = (message) => {
    if (socket !== connection) return;
    try {
      const data = JSON.parse(String(message.data)) as { event?: string; payload?: unknown };
      const event = data.event;
      if (!event) return;
      listeners.get(event)?.forEach((fn) => fn({ event, payload: data.payload }));
    } catch {
      // Ignore malformed event frames.
    }
  };
  connection.onclose = () => {
    if (socket !== connection) return;
    socket = null;
    if (listeners.size) {
      retry = setTimeout(() => {
        retry = undefined;
        ensureSocket();
      }, 1000);
    }
  };
}

export async function listen<T = unknown>(event: string, callback: EventCallback<T>): Promise<() => void> {
  let set = listeners.get(event);
  if (!set) { set = new Set(); listeners.set(event, set); }
  // A new subscription gets a separate entry even when it uses the same callback.
  const entry: EventCallback = (value) => callback(value as Parameters<EventCallback<T>>[0]);
  set.add(entry);
  ensureSocket();
  return () => {
    if (!set.delete(entry)) return;
    if (set.size === 0) listeners.delete(event);
    if (listeners.size === 0) {
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
      const previous = socket;
      socket = null;
      previous?.close();
    }
  };
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  await fetch(`${base()}/api/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, payload }),
  }).catch(() => {});
}

export async function emitTo(_target: string, event: string, payload?: unknown): Promise<void> {
  return emit(event, payload);
}
