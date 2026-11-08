// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  getAllWindows: vi.fn(), emitTo: vi.fn(), mayLeave: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => unknown>(),
  closeHandler: null as null | ((event: { preventDefault: () => void }) => Promise<void>),
  win: { show: vi.fn(), setFocus: vi.fn(), close: vi.fn() },
}));
vi.mock("./navigationGuard", () => ({ mayLeave: native.mayLeave }));
vi.mock("@tauri-apps/api/window", () => ({
  getAllWindows: native.getAllWindows,
  getCurrentWindow: () => ({ ...native.win, onCloseRequested: async (callback: typeof native.closeHandler) => { native.closeHandler = callback; return () => {}; } }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: native.emitTo,
  listen: async (name: string, callback: (event: { payload: unknown }) => unknown) => {
    native.handlers.set(name, callback); return () => { native.handlers.delete(name); };
  },
}));
import { mayCloseApp, protectToolClose } from "./windowLeave";
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); native.handlers.clear(); native.closeHandler = null;
  native.mayLeave.mockResolvedValue(true);
  native.getAllWindows.mockResolvedValue([{ label: "main" }, { label: "tool-annot" }]);
  native.emitTo.mockResolvedValue(undefined);
  native.win.show.mockResolvedValue(undefined); native.win.setFocus.mockResolvedValue(undefined); native.win.close.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());
it("respects an unsaved main editor cancellation before checking other windows", async () => {
  native.mayLeave.mockResolvedValue(false);
  expect(await mayCloseApp()).toBe(false); expect(native.getAllWindows).not.toHaveBeenCalled();
});
it("coalesces exit requests and respects a standalone editor cancellation", async () => {
  native.emitTo.mockImplementation(async (_label, _event, payload) => {
    native.handlers.get("annotation-leave-response")?.({ payload: { id: payload.id, allowed: false } });
  });
  const first = mayCloseApp(), second = mayCloseApp();
  expect(first).toBe(second); expect(await first).toBe(false);
  expect(native.emitTo).toHaveBeenCalledOnce();
  expect(native.handlers.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
it("finishes when a tool closes between enumeration and its reply", async () => {
  native.getAllWindows.mockResolvedValueOnce([{ label: "tool-annot" }]).mockResolvedValue([]);
  expect(await mayCloseApp()).toBe(true); expect(native.emitTo).not.toHaveBeenCalled();
});
it("retries while a tool is mounting and stops retrying after acknowledgement", async () => {
  const pending = mayCloseApp(); await vi.advanceTimersByTimeAsync(0);
  expect(native.emitTo).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(500); expect(native.emitTo).toHaveBeenCalledTimes(2);
  const id = native.emitTo.mock.calls[0][2].id;
  native.handlers.get("annotation-leave-response")?.({ payload: { id, allowed: null } });
  await vi.advanceTimersByTimeAsync(1000); expect(native.emitTo).toHaveBeenCalledTimes(2);
  native.handlers.get("annotation-leave-response")?.({ payload: { id, allowed: true } });
  expect(await pending).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it("keeps a dirty standalone editor open when its close confirmation is cancelled", async () => {
  const cleanup = protectToolClose(); await Promise.resolve();
  const preventDefault = vi.fn(); native.mayLeave.mockResolvedValue(false);
  await native.closeHandler!({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce(); expect(native.win.close).not.toHaveBeenCalled();
  native.mayLeave.mockResolvedValue(true);
  await native.closeHandler!({ preventDefault }); expect(native.win.close).toHaveBeenCalledOnce();
  cleanup();
});
it("returns a cancellation if a standalone window cannot present its confirmation", async () => {
  const cleanup = protectToolClose(); await Promise.resolve();
  native.win.show.mockRejectedValue(new Error("closed"));
  await native.handlers.get("annotation-leave-request")!({ payload: { id: "request" } });
  expect(native.emitTo).toHaveBeenLastCalledWith("main", "annotation-leave-response", { id: "request", allowed: false });
  cleanup();
});
