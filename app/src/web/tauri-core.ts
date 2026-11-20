/** Browser-compatible replacement for @tauri-apps/api/core. */
export type InvokeArgs = Record<string, unknown> | undefined;

const base = () => (globalThis as { __FABRIC_LAN_API__?: string }).__FABRIC_LAN_API__ || "";

export async function invoke<T = unknown>(command: string, args?: InvokeArgs): Promise<T> {
  const response = await fetch(`${base()}/api/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ command, args: args ?? {} }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true || !Object.prototype.hasOwnProperty.call(payload, "result")) {
    const reason = payload?.error ?? payload?.detail;
    throw new Error(typeof reason === "string" && reason ? reason : `LAN command failed: ${command} (${response.status})`);
  }
  return payload.result as T;
}

export function convertFileSrc(path: string): string {
  if (!path) return "";
  if (/^(https?:|data:|blob:|\/api\/)/i.test(path)) return path;
  return `${base()}/api/file?path=${encodeURIComponent(path)}`;
}
