import type { Config } from "./config";
export type ReferenceSelection = { primary: string; auxiliary: string[] };
const normalize = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "");
type Reference = { from: string; wav: string; speaker: string; lang: string; text: string };
const identity = (row: Reference) => [normalize(row.from), normalize(row.wav), row.speaker, row.lang];
export const referenceKey = (row: Reference) => JSON.stringify([...identity(row), row.text]);
/** Transcript edits retain a reference only when its audio identity is unambiguous. */
export function findReference<T extends Reference>(rows: T[], key: string): T | undefined {
  const exact = rows.find(row => referenceKey(row) === key);
  if (exact) return exact;
  let saved: unknown;
  try { saved = JSON.parse(key); } catch { return undefined; }
  if (!Array.isArray(saved) || saved.length < 4) return undefined;
  const base = JSON.stringify(saved.slice(0, 4));
  const matches = rows.filter(row => JSON.stringify(identity(row)) === base);
  return matches.length === 1 ? matches[0] : undefined;
}
export const referenceConfigKey = (roleId: string) => `synth_references:${roleId}`;
export function roleReferences(config: Config, roleId: string): ReferenceSelection {
  const value = config[referenceConfigKey(roleId)];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { primary: "", auxiliary: [] };
  const saved = value as Partial<ReferenceSelection>;
  return { primary: typeof saved.primary === "string" ? saved.primary : "",
    auxiliary: Array.isArray(saved.auxiliary) ? [...new Set(saved.auxiliary.filter((key): key is string => typeof key === "string"))] : [] };
}
