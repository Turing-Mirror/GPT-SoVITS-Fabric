import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lookup } from "./dict";

/** 代码里写死的每个文案 key，都必须在每种语言里查得到。 */
const SRC = join(__dirname, "..");
const LOCALES = join(__dirname, "../../i18n/locales");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const KEY = /\bt\(\s*["']((?:s|nav|window|dialog|store|settings|locale|tray|engine|home|glossary|msg|extras|onboarding|social|synth|train|help|more|meta)\.[\w.-]+)["']/g;

const keys = [...new Set(sources(SRC).flatMap(file => [...readFileSync(file, "utf8").matchAll(KEY)].map(m => m[1])))];

describe("language packs", () => {
  it("finds the keys used in the code", () => {
    expect(keys.length).toBeGreaterThan(100);
  });

  for (const file of readdirSync(LOCALES).filter(name => name.endsWith(".json"))) {
    it(`resolves every key in ${file}`, () => {
      const pack = JSON.parse(readFileSync(join(LOCALES, file), "utf8"));
      expect(keys.filter(key => typeof lookup(pack, key) !== "string")).toEqual([]);
    });
  }
});
