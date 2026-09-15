import { describe, expect, it } from "vitest";
import { actionCodes, actionFor } from "./errorActions";

/**
 * 错误码 → 动作按钮的映射表。表面是「查表」，实际约束是：每个码的 run
 * 都得真的能点 —— 表里多一个死码，界面上就多一个按了没反应的按钮。
 */
describe("errorActions", () => {
  it("covers the missing-asset family", () => {
    for (const code of [
      "train.pretrained_missing",
      "train.bert_missing",
      "train.hubert_missing",
      "train.sv_missing",
    ]) {
      expect(actionCodes()).toContain(code);
    }
  });

  it("returns a labelled action for a known code", () => {
    const a = actionFor("train.pretrained_missing");
    expect(a).not.toBeNull();
    expect(a!.label.length).toBeGreaterThan(0);
    expect(typeof a!.run).toBe("function");
  });

  it("returns null without a code or for an unknown one", () => {
    expect(actionFor(null)).toBeNull();
    expect(actionFor(undefined)).toBeNull();
    expect(actionFor("no.such.code")).toBeNull();
  });
});
