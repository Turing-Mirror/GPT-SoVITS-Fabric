// @vitest-environment happy-dom
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useEngine } from "./useEngine";

const engine = vi.hoisted(() => ({
  getEngineStatus: vi.fn(),
  getProvisionStatus: vi.fn(),
}));
vi.mock("../lib/engine", () => engine);

it("skips commits for unchanged status polls and displays new status", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  engine.getProvisionStatus.mockResolvedValue({ runtime_ready: true });
  let status = { state: "idle", runtime_ready: true, compute_backend: "" };
  engine.getEngineStatus.mockImplementation(async () => ({ ...status }));
  const container = document.createElement("div");
  const root = createRoot(container);
  const commits = vi.fn();

  function Status() {
    const { status } = useEngine();
    return (
      <Profiler id="engine" onRender={commits}>
        <output>{status.state}</output>
      </Profiler>
    );
  }

  try {
    await act(async () => {
      root.render(<Status />);
    });
    expect(container.textContent).toBe("idle");
    commits.mockClear();
    engine.getEngineStatus.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(engine.getEngineStatus).toHaveBeenCalled();
    expect(commits).not.toHaveBeenCalled();

    status = { ...status, state: "busy", compute_backend: "cuda" };
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(container.textContent).toBe("busy");
    expect(commits).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
