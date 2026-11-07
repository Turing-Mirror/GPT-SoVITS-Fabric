/** Count complete items in layout order; never expose a clipped last row. */
export function fittedCount(items: readonly { top: number; height: number }[], height: number): number {
  if (height <= 0) return 0;
  const firstOverflow = items.findIndex((item) => item.top + item.height > height + 0.5);
  return firstOverflow < 0 ? items.length : firstOverflow;
}
