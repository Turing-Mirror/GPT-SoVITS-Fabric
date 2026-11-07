// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConfigWrite } from "../lib/config";
const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), listen: vi.fn() }));
vi.mock("../lib/config", () => ({
  getConfig: mocks.get, setConfig: mocks.set, notifyConfigPatch: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../lib/appearance", () => ({ applyAppearance: vi.fn() }));
import { useConfig } from "./useConfig";

let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useConfig>;
function Harness() { state = useConfig(); return <output>{String(state.cfg.value ?? "")}</output>; }
const result = (value: string): ConfigWrite => ({ config: { value }, hot: {}, needs_restart: [] });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.get.mockReset().mockResolvedValue({ value: "saved" });
  mocks.set.mockReset().mockImplementation(async (patch) => ({ config: patch, hot: {}, needs_restart: [] }));
  mocks.listen.mockReset().mockResolvedValue(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

describe("configuration page lifecycle", () => {
  it("keeps a newer local edit while an earlier save responds", async () => {
    const resolvers: Array<(v: ConfigWrite) => void> = [];
    mocks.set.mockImplementation(() => new Promise<ConfigWrite>((resolve) => resolvers.push(resolve)));
    await act(async () => root.render(<Harness />));
    act(() => { void state.set("value", "first", true); });
    act(() => { void state.set("value", "second", true); });
    await act(async () => { resolvers[0](result("first")); });
    expect(container.textContent).toBe("second");
    await act(async () => { resolvers[1](result("second")); });
    expect(container.textContent).toBe("second");
  });

  it("flushes debounced changes when leaving the page", async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<Harness />));
    act(() => { void state.set("value", "pending"); });
    expect(mocks.set).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith({ value: "pending" });
    await act(async () => vi.advanceTimersByTime(500));
    expect(mocks.set).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a local edit with a late initial read", async () => {
    let resolve!: (v: { value: string }) => void;
    mocks.get.mockReturnValue(new Promise((done) => { resolve = done; }));
    act(() => root.render(<Harness />));
    act(() => { void state.set("value", "new"); });
    await act(async () => resolve({ value: "old" }));
    expect(container.textContent).toBe("new");
  });
});
