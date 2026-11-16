/**
 * 附加资源的分类。
 *
 * 抽出来单放一份，是因为这套判据必须和 Rust 侧（`extra_assets.rs` 的
 * `infer_group` / `group_rank`）逐条对上：分类错了，资源不是显示在错误的
 * 页签里，而是**根本不显示** —— 弹窗只画「清单里出现过的类」，落在没有
 * 页签的类里的条目就此消失。SVC 那边真出过这事，七条资源里五条不可见。
 */

/** 页签顺序。照抄 Rust 的 `group_rank`，两边排出来的次序才一致。 */
export const CATEGORY_ORDER = ["synth", "separate", "other"] as const;

export type Category = (typeof CATEGORY_ORDER)[number];

/** 清单没写 group 时的兜底。判据与 Rust 的 `infer_group` 一一对应。 */
export function inferGroup(key: string): Category {
  if (key.startsWith("pretrained")) return "synth";
  if (key.startsWith("pymss") || key.startsWith("uvr")) return "separate";
  return "other";
}

/** 一条资源归哪一类。清单明写的 group 优先，认不出来的按 key 猜。 */
export function groupOf(it: { key: string; group?: string }): Category {
  const g = String(it.group || "").trim().toLowerCase();
  if (g === "train" || g === "engine") return "synth";
  if ((CATEGORY_ORDER as readonly string[]).includes(g)) return g as Category;
  return inferGroup(it.key);
}

/** 清单里真正出现过的类，按 CATEGORY_ORDER 排。空清单给空数组。 */
export function categoriesOf(items: { key: string; group?: string }[]): Category[] {
  const present = new Set(items.map(groupOf));
  return CATEGORY_ORDER.filter((c) => present.has(c));
}
