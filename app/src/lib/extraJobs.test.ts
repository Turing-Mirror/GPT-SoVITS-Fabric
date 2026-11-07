// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: bridge.listen }));
import { startExtraDownload, useExtraJobs } from "./extraJobs";

it("keeps optional-asset progress across page remounts and respects the backend single download slot", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  let event!: (e: { payload: { key: string; phase: string; done: number; total: number } }) => void;
  bridge.listen.mockImplementation(async (name, callback) => { if (name === "extra-progress") event = callback; return () => {}; });
  let finish!: () => void;
  bridge.invoke.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const host = document.createElement("div");
  let root = createRoot(host);
  let current!: ReturnType<typeof useExtraJobs>;
  function Harness() { current = useExtraJobs(); return null; }
  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => { startExtraDownload("v5", true); startExtraDownload("separation", true); });
    expect(bridge.invoke).toHaveBeenCalledTimes(1);
    await act(async () => event({ payload: { key: "v5", phase: "run", done: 40, total: 100 } }));
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(Harness)));
    expect(current.busyKeys).toEqual({ v5: true });
    expect(current.progByKey.v5.done).toBe(40);
    await act(async () => finish());
    expect(current.busyKeys).toEqual({});
    expect(current.generation).toBe(1);
    expect(current.msg).toBeTruthy();
    await act(async () => startExtraDownload("v5", true));
    expect(current.progByKey.v5.done).toBe(0);
    await act(async () => finish());
  } finally {
    await act(async () => root.unmount());
  }
});
