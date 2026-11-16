import { describe, expect, it } from "vitest";
import { fittedCount } from "./fittedItems";

describe("fitted home content", () => {
  it("keeps complete wrapped rows and omits a partially visible row", () => {
    expect(fittedCount([{ top: 0, height: 32 }, { top: 0, height: 32 }, { top: 40, height: 32 }], 60)).toBe(2);
  });
  it("reveals another row when the window grows", () => {
    expect(fittedCount([{ top: 0, height: 32 }, { top: 40, height: 32 }], 72)).toBe(2);
  });
  it("handles taller translated entries, empty space, and fractional rounding", () => {
    expect(fittedCount([{ top: 0, height: 44 }, { top: 52, height: 60 }], 100)).toBe(1);
    expect(fittedCount([{ top: 0, height: 44 }], 0)).toBe(0);
    expect(fittedCount([{ top: 0, height: 32.3 }], 32)).toBe(1);
    expect(fittedCount([], 100)).toBe(0);
  });
});
