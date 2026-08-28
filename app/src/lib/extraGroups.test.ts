import { describe, expect, it } from "vitest";
import { categoriesOf, groupOf, inferGroup } from "./extraGroups";

describe("附加资源分类", () => {
  it("空清单不造出空页签", () => {
    // GSV 的发行仓目前一条 extras 都不发（底模走 engine-core）。写死页签的
    // 那一版会画出「人声分离 / 训练音色」两个空页签 —— 两个名字都是 RVC 的。
    expect(categoriesOf([])).toEqual([]);
  });

  it("页签顺序跟着 CATEGORY_ORDER，不跟着清单里的出现顺序", () => {
    expect(
      categoriesOf([
        { key: "a", group: "separate" },
        { key: "b", group: "train" },
      ]),
    ).toEqual(["train", "separate"]);
  });

  it("清单明写的 group 压过 key 的猜测", () => {
    // key 的命名规则会变，清单是明写的。
    expect(inferGroup("pymss-vocal")).toBe("separate");
    expect(groupOf({ key: "pymss-vocal", group: "train" })).toBe("train");
  });

  it("清单没写 group 时按 key 兜底，判据和 Rust 那份一致", () => {
    expect(groupOf({ key: "pretrained-v2-40k" })).toBe("train");
    expect(groupOf({ key: "pymss-vocal" })).toBe("separate");
    expect(groupOf({ key: "uvr-hp2" })).toBe("separate");
    expect(groupOf({ key: "something-else" })).toBe("other");
  });

  it("认不出来的 group 字面量退回按 key 猜，而不是凭空造一个页签", () => {
    // 落进一个画不出来的类，等于这条资源在界面上不存在。
    expect(groupOf({ key: "pymss-vocal", group: "brand-new" })).toBe("separate");
    expect(categoriesOf([{ key: "x", group: "brand-new" }])).toEqual(["other"]);
  });

  it("大小写和空白不影响分类", () => {
    expect(groupOf({ key: "x", group: "  Train " })).toBe("train");
  });
});
