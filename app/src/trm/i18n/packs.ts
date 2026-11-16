import zh from "../../../i18n/locales/zh-CN.json";
import type { Dict, LocaleCode } from "./types";

const files = import.meta.glob<Dict>(["../../../i18n/locales/*.json", "!../../../i18n/locales/zh-CN.json"], { import: "default" });
const loaders = Object.fromEntries(Object.entries(files).map(([path, load]) => [
  path.slice(path.lastIndexOf("/") + 1, -".json".length), load,
]));

export const PACKS: Partial<Record<LocaleCode, Dict>> = { "zh-CN": zh };
const pending: Partial<Record<LocaleCode, Promise<Dict>>> = {};

export function hasPack(code: LocaleCode): boolean {
  return code === "zh-CN" || Object.prototype.hasOwnProperty.call(loaders, code);
}

export function ensurePack(code: LocaleCode): Promise<Dict> {
  const loaded = PACKS[code];
  if (loaded) return Promise.resolve(loaded);
  const request = pending[code] ?? (pending[code] = loaders[code]()
    .then(pack => {
      PACKS[code] = pack;
      return pack;
    })
    .finally(() => { delete pending[code]; }));
  return request;
}
