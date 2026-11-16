import { expect, it, vi } from "vitest";
import { mayLeave, registerLeaveGuard } from "./navigationGuard";
import { openInAnnot, registerNavigator, take } from "./intent";
it("keeps unsaved data on cancellation and asks once for concurrent navigation", async () => {
  let resolve!: (value: boolean) => void;
  const ask = vi.fn(() => new Promise<boolean>(r => { resolve = r; }));
  const off = registerLeaveGuard(ask);
  const first = mayLeave(), second = mayLeave();
  expect(first).toBe(second); expect(ask).toHaveBeenCalledOnce();
  resolve(false); expect(await first).toBe(false);
  off(); expect(await mayLeave()).toBe(true);
});
it("does not leave a file handoff behind after a rejected navigation", async () => {
  registerNavigator(async () => false);
  openInAnnot("cancelled.list"); await Promise.resolve();
  expect(take("annotList")).toBeNull();
  registerNavigator(async () => true);
  openInAnnot("selected.list"); await Promise.resolve();
  expect(take("annotList")).toBe("selected.list");
  expect(take("annotList")).toBeNull();
  registerNavigator(null);
});
