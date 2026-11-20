import { expect, it } from "vitest";
import { referenceKey, findReference, referenceConfigKey, roleReferences } from "./roleReferences";
const row = { from: "dataset/voice.list", wav: "audio/one.wav", speaker: "voice", lang: "ja", line: 4, text: "old" };
it("keeps the same audio after annotation rows are reordered or text is corrected", () => {
  const corrected = { ...row, line: 17, text: "corrected" };
  expect(findReference([corrected], referenceKey(row))).toBe(corrected);
  expect(referenceKey(row)).not.toBe(referenceKey({ ...row, wav: "audio/two.wav" }));
  expect(referenceKey(row)).toBe(referenceKey({ ...row, from: ".\\dataset\\voice.list", wav: "audio\\one.wav" }));
});
it("persists primary and auxiliary references independently for each character", () => {
  const first = { primary: referenceKey(row), auxiliary: [referenceKey({ ...row, wav: "other.wav" })] };
  const second = { primary: "second", auxiliary: [] };
  const config = JSON.parse(JSON.stringify({ [referenceConfigKey("a")]: first, [referenceConfigKey("b")]: second }));
  expect(roleReferences(config, "a")).toEqual(first);
  expect(roleReferences(config, "b")).toEqual(second);
  expect(roleReferences(config, "missing")).toEqual({ primary: "", auxiliary: [] });
});
it("ignores invalid saved entries and duplicate auxiliary references", () => {
  expect(roleReferences({ [referenceConfigKey("a")]: { primary: 42, auxiliary: ["a", null, "a"] } }, "a"))
    .toEqual({ primary: "", auxiliary: ["a"] });
});
it("distinguishes repeated audio rows with different transcripts", () => {
  const other = { ...row, line: 8, text: "different" };
  expect(referenceKey(row)).not.toBe(referenceKey(other));
  expect(findReference([row, other], referenceKey(other))).toBe(other);
  expect(findReference([row, other], referenceKey({ ...row, text: "deleted" }))).toBeUndefined();
});
it("keeps a reference whose audio was found in another folder and saved", () => {
  const moved = { ...row, wav: "D:/new/place/ONE.wav" };
  expect(findReference([moved], referenceKey(row))).toBe(moved);
  expect(findReference([moved, { ...moved, wav: "elsewhere/one.wav" }], referenceKey(row))).toBeUndefined();
});
