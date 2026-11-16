import { describe, expect, it } from "vitest";
import { categoriesOf, groupOf, inferGroup } from "./extraGroups";

describe("附加资源分类", () => {
  it("空清单不造出空页签", () => {
    expect(categoriesOf([])).toEqual([]);
  });

  it("页签顺序跟着 CATEGORY_ORDER，不跟着清单里的出现顺序", () => {
    expect(
      categoriesOf([
        { key: "a", group: "separate" },
        { key: "b", group: "train" },
      ]),
    ).toEqual(["synth", "separate"]);
  });

  it("清单明写的 group 压过 key 的猜测", () => {
    // key 的命名规则会变，清单是明写的。
    expect(inferGroup("pymss-vocal")).toBe("separate");
    expect(groupOf({ key: "pymss-vocal", group: "train" })).toBe("synth");
  });

  it("清单没写 group 时按 key 兜底，判据和 Rust 那份一致", () => {
    expect(groupOf({ key: "pretrained-v2-40k" })).toBe("synth");
    expect(groupOf({ key: "pymss-vocal" })).toBe("separate");
    expect(groupOf({ key: "uvr-hp2" })).toBe("separate");
    expect(groupOf({ key: "something-else" })).toBe("other");
  });

  it("认不出来的 group 字面量退回按 key 猜，而不是凭空造一个页签", () => {
    // 落进一个画不出来的类，等于这条资源在界面上不存在。
    expect(groupOf({ key: "pymss-vocal", group: "brand-new" })).toBe("separate");
    expect(categoriesOf([{ key: "x", group: "brand-new" }])).toEqual(["other"]);
  });

  it("合成底模有明确分类，不落入其他", () => {
    expect(groupOf({ key: "gsv-v5", group: "synth" })).toBe("synth");
    expect(categoriesOf([{ key: "gsv-v5", group: "synth" }])).toEqual(["synth"]);
  });

  it("大小写和空白不影响分类", () => {
    expect(groupOf({ key: "x", group: "  Train " })).toBe("synth");
  });
});
