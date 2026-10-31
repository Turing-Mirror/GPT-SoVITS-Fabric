/** 没有封面图时的占位底色：按 id 从 TRM UI 的 --art-1 … --art-6 里取一个，同一个 id 每次相同。 */
const ART_COUNT = 6;

export function artOf(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return `var(--art-${(h % ART_COUNT) + 1})`;
}
