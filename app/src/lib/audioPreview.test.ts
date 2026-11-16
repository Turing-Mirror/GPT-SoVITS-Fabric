import { describe, expect, it, vi } from "vitest";
import { AudioPreview } from "./audioPreview";
function fixture() {
  const changed = vi.fn();
  const failed = vi.fn();
  const media: { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; volume: number; onended: (() => void) | null; onerror: (() => void) | null }[] = [];
  const player = new AudioPreview(changed, () => {
    const audio = { play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(), volume: 1, onended: null, onerror: null };
    media.push(audio); return audio as unknown as HTMLAudioElement;
  });
  return { player, changed, failed, media };
}
describe("preview ownership", () => {
  it("handles rejected playback without displaying a playing state", async () => {
    const f = fixture();
    const pending = f.player.toggle("a", "a", .6, f.failed);
    await pending;
    f.media[0].onerror?.();
    expect(f.failed).toHaveBeenCalledOnce();
    expect(f.changed).toHaveBeenLastCalledWith("");
    expect(f.media[0].pause).toHaveBeenCalledOnce();
  });
  it("catches play Promise rejection", async () => {
    const failed = vi.fn(), changed = vi.fn(), pause = vi.fn();
    const player = new AudioPreview(changed, () => ({ play: () => Promise.reject(new Error("blocked")), pause, removeAttribute: vi.fn(), load: vi.fn() }) as unknown as HTMLAudioElement);
    await player.toggle("a", "a", 1, failed);
    expect(failed).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalledWith("a");
    expect(pause).toHaveBeenCalledOnce();
  });
  it("ignores the old promise after a newer track starts", async () => {
    let reject!: (error: Error) => void;
    const changed = vi.fn(), failed = vi.fn();
    const old = { play: () => new Promise<void>((_, r) => { reject = r; }), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(), onerror: null as null | (() => void) };
    const next = { play: () => Promise.resolve(), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() };
    const create = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(next);
    const player = new AudioPreview(changed, create);
    const first = player.toggle("old", "old", 1, failed);
    const oldError = old.onerror;
    await player.toggle("next", "next", 1, failed);
    reject(new Error("interrupted")); await first; oldError?.();
    expect(changed).toHaveBeenLastCalledWith("next");
    expect(failed).not.toHaveBeenCalled();
    expect(old.pause).toHaveBeenCalledOnce();
  });
  it("stops pending playback when its row is removed or filtered out", async () => {
    let resolve!: () => void;
    const changed = vi.fn(), pause = vi.fn();
    const player = new AudioPreview(changed, () => ({ play: () => new Promise<void>(r => { resolve = r; }), pause, removeAttribute: vi.fn(), load: vi.fn() }) as unknown as HTMLAudioElement);
    const pending = player.toggle("a", "a", 1, vi.fn());
    player.retain(["b"]); resolve(); await pending;
    expect(pause).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalledWith("a");
  });
  it("updates volume and toggles the same pending or playing file off", async () => {
    const f = fixture(); await f.player.toggle("a", "a", .6, f.failed);
    expect(f.media[0].volume).toBe(.6);
    f.player.setVolume(.2); expect(f.media[0].volume).toBe(.2);
    await f.player.toggle("a", "a", .2, f.failed);
    expect(f.media).toHaveLength(1);
    expect(f.changed).toHaveBeenLastCalledWith("");
  });
});
