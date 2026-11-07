import { describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { getConfig, setConfig } from "./config";

describe("shared configuration persistence", () => {
  it("serializes edits across pages and reads after committed writes", async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    invoke.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const first = setConfig({ synth_role: "first" });
    const second = setConfig({ synth_role: "second" });
    const read = getConfig();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
    resolvers.shift()!({ config: { synth_role: "first" }, hot: {}, needs_restart: [] });
    await first;
    await Promise.resolve();
    expect(invoke.mock.calls[1]).toEqual(["config_set", { patch: { synth_role: "second" } }]);
    resolvers.shift()!({ config: { synth_role: "second" }, hot: {}, needs_restart: [] });
    await second;
    await Promise.resolve();
    expect(invoke.mock.calls[2][0]).toBe("config_get");
    resolvers.shift()!({ synth_role: "second" });
    expect(await read).toEqual({ synth_role: "second" });
  });

  it("allows a later write after a failed write", async () => {
    invoke.mockReset();
    invoke.mockRejectedValueOnce(new Error("write failed"));
    invoke.mockResolvedValueOnce({ config: { synth_role: "next" }, hot: {}, needs_restart: [] });
    const failed = setConfig({ synth_role: "failed" });
    const next = setConfig({ synth_role: "next" });
    await expect(failed).rejects.toThrow("write failed");
    expect((await next).config.synth_role).toBe("next");
  });
});
