// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

afterEach(() => vi.restoreAllMocks());

it("copies via the async interface when allowed", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as unknown as Clipboard);
  await expect(copyText("server info")).resolves.toBe(true);
  expect(writeText).toHaveBeenCalledWith("server info");
});

it("copies the selected text synchronously on HTTP and cleans up", async () => {
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(undefined as unknown as Clipboard);
  const original = Object.getOwnPropertyDescriptor(document, "execCommand");
  const runner = vi.fn(() => {
    expect((document.activeElement as HTMLTextAreaElement).value).toBe("Windows\nGPU");
    return true;
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: runner });
  try {
    const result = copyText("Windows\nGPU");
    expect(runner).toHaveBeenCalledWith("copy");
    await expect(result).resolves.toBe(true);
    expect(document.querySelector("textarea")).toBeNull();
    runner.mockReturnValue(false);
    await expect(copyText("Windows\nGPU")).resolves.toBe(false);
  } finally {
    if (original) Object.defineProperty(document, "execCommand", original);
    else Reflect.deleteProperty(document, "execCommand");
  }
});
