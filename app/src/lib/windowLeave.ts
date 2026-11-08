import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo, listen } from "@tauri-apps/api/event";
import { mayLeave } from "./navigationGuard";

const REQUEST = "annotation-leave-request";
const RESPONSE = "annotation-leave-response";
/** Main-window exit must also ask an open standalone annotation editor. */
let closing: Promise<boolean> | null = null;
export function mayCloseApp(): Promise<boolean> {
  if (!closing) closing = checkWindows().finally(() => { closing = null; });
  return closing;
}
async function checkWindows(): Promise<boolean> {
  if (!(await mayLeave())) return false;
  const windows = await getAllWindows();
  for (const window of windows.filter(w => w.label === "tool-annot")) {
    const id = crypto.randomUUID();
    let resolve!: (allowed: boolean) => void;
    let acknowledged = false;
    const answer = new Promise<boolean>(r => { resolve = r; });
    const off = await listen<{ id: string; allowed: boolean | null }>(RESPONSE, e => {
      if (e.payload.id !== id) return;
      acknowledged = true;
      if (e.payload.allowed !== null) resolve(e.payload.allowed);
    });
    const check = async () => {
      const open = await getAllWindows();
      if (!open.some(w => w.label === window.label)) resolve(true);
      else if (!acknowledged) await emitTo(window.label, REQUEST, { id });
    };
    const timer = globalThis.setInterval(() => { void check().catch(() => resolve(false)); }, 500);
    try {
      await check();
      if (!(await answer)) return false;
    } finally { globalThis.clearInterval(timer); off(); }
  }
  return true;
}

/** Returns cleanup even if native listener registration finishes after unmount. */
export function protectToolClose() {
  const win = getCurrentWindow();
  let disposed = false;
  let approved = false;
  const offs: (() => void)[] = [];
  const add = (promise: Promise<() => void>) => {
    void promise.then(off => { if (disposed) off(); else offs.push(off); });
  };
  add(win.onCloseRequested(async event => {
    if (approved) return;
    event.preventDefault();
    if (await mayLeave()) { approved = true; await win.close(); }
  }));
  add(listen<{ id: string }>(REQUEST, async e => {
    await emitTo("main", RESPONSE, { id: e.payload.id, allowed: null });
    let allowed = false;
    try {
      await win.show();
      await win.setFocus();
      allowed = await mayLeave();
    } catch { allowed = false; }
    await emitTo("main", RESPONSE, { id: e.payload.id, allowed });
  }));
  return () => { disposed = true; offs.forEach(off => off()); };
}
