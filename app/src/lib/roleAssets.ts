import { invoke } from "@tauri-apps/api/core";

export type WeightKind = "gpt" | "sovits";
export type RoleAssets = {
  id: string;
  version: string;
  versions: string[];
  weights: { kind: WeightKind; path: string; exists: boolean; size: number }[];
  lists: { index: number; file: string; lang: string; note: string; path: string; exists: boolean; valid: boolean; rows: number }[];
};

export const getRoleAssets = (id: string) => invoke<RoleAssets>("role_assets_get", { id });
export const replaceRoleWeight = (id: string, kind: WeightKind, version?: string) =>
  invoke<RoleAssets | null>("role_weight_replace", { id, kind, version });
export const associateRoleList = (id: string) => invoke<RoleAssets | null>("role_list_associate", { id });
export const unlinkRoleList = (id: string, index: number, file: string) => invoke<RoleAssets>("role_list_unlink", { id, index, file });
