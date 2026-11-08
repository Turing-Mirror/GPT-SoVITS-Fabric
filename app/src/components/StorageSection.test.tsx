// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("../lib/webDialog", () => ({ askConfirm: bridge.confirm }));
vi.mock("./CatalogTransition", () => ({ CatalogTransition: ({ children }: { children: ReactNode }) => children }));
vi.mock("../trm", async importOriginal => ({
  ...await importOriginal<typeof import("../trm")>(),
  Ring: () => null,
  useDir: () => 1,
  Pager: ({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }) =>
    <button data-next disabled={page >= pages} onClick={() => onChange(page + 1)}>next</button>,
}));
import { StorageSection } from "./StorageSection";
import { t } from "../i18n/t";
let root: Root, host: HTMLDivElement;
const rows = Array.from({ length: 6 }, (_, i) => ({ exp: "voice" + i, total_bytes: 6000 - i * 100,
  kinds: { checkpoints: { files: 1, bytes: 1024 }, dataset: { files: 1, bytes: 2048 } } }));
const apply = () => [...host.querySelectorAll("button")].filter(button => button.textContent === t("s.cleanupApply"));
const check = (row: number, kind: number) => host.querySelectorAll("li")[row].querySelectorAll("input")[kind] as HTMLInputElement;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  bridge.invoke.mockReset().mockImplementation(async cmd => {
    if (cmd === "storage_usage") return { items: [], total_bytes: 0, free_bytes: 10000 };
    if (cmd === "train_cleanup_scan") return rows;
    return { freed_bytes: 1024 };
  });
  bridge.confirm.mockReset().mockResolvedValue(true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<StorageSection />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it("uses one action and one confirmation for selections across pages", async () => {
  expect(apply()).toHaveLength(1); expect(apply()[0].disabled).toBe(true);
  act(() => check(0, 1).click());
  act(() => (host.querySelector("[data-next]") as HTMLButtonElement).click());
  act(() => check(0, 2).click());
  expect(host.textContent).toContain(t("s.cleanPicked", { n: 2, size: "3.0 KB" }));
  await act(async () => apply()[0].click());
  expect(bridge.confirm).toHaveBeenCalledOnce();
  expect(bridge.confirm.mock.calls[0][0]).toContain("voice0");
  expect(bridge.confirm.mock.calls[0][0]).toContain("voice5");
  expect(bridge.invoke.mock.calls.filter(([cmd]) => cmd === "train_cleanup_apply")).toEqual([
    ["train_cleanup_apply", { exp: "voice0", kinds: ["checkpoints"] }],
    ["train_cleanup_apply", { exp: "voice5", kinds: ["dataset"] }],
  ]);
  expect(apply()[0].disabled).toBe(true);
});
it("keeps selected items when the confirmation is cancelled", async () => {
  bridge.confirm.mockResolvedValue(false);
  act(() => check(0, 1).click());
  await act(async () => apply()[0].click());
  expect(bridge.invoke.mock.calls.some(([cmd]) => cmd === "train_cleanup_apply")).toBe(false);
  expect(check(0, 1).checked).toBe(true);
  expect(apply()[0].disabled).toBe(false);
});
it("clears only successful selections if another experiment fails", async () => {
  act(() => { check(0, 1).click(); check(1, 2).click(); });
  bridge.invoke.mockImplementation(async (cmd, args) => {
    if (cmd === "storage_usage") return { items: [], total_bytes: 0, free_bytes: 10000 };
    if (cmd === "train_cleanup_scan") return rows;
    if (args.exp === "voice1") throw new Error("experiment is running");
    return { freed_bytes: 1024 };
  });
  await act(async () => apply()[0].click());
  expect(check(0, 1).checked).toBe(false);
  expect(check(1, 2).checked).toBe(true);
  expect(host.textContent).toContain("experiment is running");
  expect(host.textContent).toContain(t("s.cleanupDone", { v0: "1.0 KB" }));
  expect(apply()[0].disabled).toBe(false);
});
