import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "./tauri-core";

afterEach(() => vi.unstubAllGlobals());

it("returns an explicit null result rather than the response envelope", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, result: null })));
  await expect(invoke("picker")).resolves.toBeNull();
});

it("rejects missing results and non-JSON successes", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ok: true })).mockResolvedValueOnce(new Response("<html>"));
  vi.stubGlobal("fetch", fetch);
  await expect(invoke("storage_usage")).rejects.toThrow("storage_usage");
  await expect(invoke("storage_usage")).rejects.toThrow("storage_usage");
});

it("reports FastAPI error details", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ detail: "Desktop only" }, { status: 501 })));
  await expect(invoke("train_cleanup_apply")).rejects.toThrow("Desktop only");
});
