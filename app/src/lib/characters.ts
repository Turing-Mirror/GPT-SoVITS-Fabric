import { invoke } from "@tauri-apps/api/core";
import type { SynthParams } from "./synthRoleParams";
import { Snapshot } from "./snapshot";
export type AnnotRow = { line: number; wav: string; speaker: string; lang: string; text: string; abs: string; exists: boolean; issues: string[] };
export type Character = {
  id: string; name: string; author: string; version: string; cover: string; cover_exists: boolean;
  dir: string; params: Partial<SynthParams>;
  lists: { file: string; lang: string; note: string; rows: AnnotRow[] }[];
};
const characters = new Snapshot<Character[]>();
export const peekCharacters = () => characters.get();
export const readCharacters = () => characters.read(async () => {
  const result = await invoke<{ roles?: Character[] }>("synth_characters");
  return result?.roles ?? [];
});
