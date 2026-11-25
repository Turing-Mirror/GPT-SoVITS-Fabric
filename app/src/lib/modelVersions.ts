import { invoke } from "./invoke";

export type ModelWeightKind = "sovits" | "gpt" | "rvc";
export type ModelVersions = {
  experiment: string | null;
  weights_dir: string | null;
  weights: {
    kind: ModelWeightKind;
    current: {
      state: "matched" | "source_removed" | "external" | "missing";
      file: string | null;
      epoch: number | null;
      step: number | null;
    };
    versions: {
      file: string;
      epoch: number | null;
      step: number | null;
      is_final: boolean;
      current: boolean;
    }[];
  }[];
};

export function listModelVersions(target: string): Promise<ModelVersions> {
  return invoke<ModelVersions>("model_versions_list", { target });
}

export function applyModelVersion(target: string, kind: ModelWeightKind, file: string): Promise<ModelVersions> {
  return invoke<ModelVersions>("model_version_apply", { target, kind, file });
}
