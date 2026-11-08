import { expect, it } from "vitest";
import { Snapshot } from "./snapshot";
it("keeps successful data available during refresh and after failure", async () => {
  const cache = new Snapshot<string[]>();
  expect(cache.get()).toBeNull();
  await cache.read(async () => ["role"]);
  await expect(cache.read(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  expect(cache.get()).toEqual(["role"]);
});
it("does not overwrite a newer read with a late result", async () => {
  const cache = new Snapshot<string[]>();
  let resolve!: (v: string[]) => void;
  const old = cache.read(() => new Promise(r => { resolve = r; }));
  await cache.read(async () => ["new"]);
  resolve(["old"]); expect(await old).toEqual(["new"]);
});
it("does not overwrite queue progress events with a pending read", async () => {
  const cache = new Snapshot<string[]>();
  let resolve!: (v: string[]) => void;
  const old = cache.read(() => new Promise(r => { resolve = r; }));
  cache.receive(["completed"]);
  resolve(["running"]); expect(await old).toEqual(["completed"]);
});
it("continues updating when polling overlaps slow reads", async () => {
  const cache = new Snapshot<string>(); cache.receive("cached");
  let one!: (value: string) => void, two!: (value: string) => void;
  const first = cache.read(() => new Promise(r => { one = r; }));
  const second = cache.read(() => new Promise(r => { two = r; }));
  one("progress1"); expect(await first).toBe("progress1");
  const third = cache.read(async () => "progress3");
  two("progress2"); await second; await third;
  expect(cache.get()).toBe("progress3");
});
