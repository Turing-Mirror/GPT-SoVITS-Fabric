import { invoke } from "./invoke";
import { t } from "../i18n/t";
import type { Diagnostic, DiagnosticAction } from "./diagnostics";
import { openDownloadModels } from "./downloadModels";
import { openHelpSection } from "./helpNav";

export type TrainingCopy = { job_id: string; stage: "sovits" | "gpt" };
type Editor = (copy: TrainingCopy) => Promise<void>;
let editor: Editor | null = null;
export function registerTrainingEditor(fn: Editor | null) { editor = fn; }

export function diagnosticActions(diagnostic: Diagnostic): { label: string; run: () => Promise<unknown> }[] {
  const dispatch = (a: DiagnosticAction): (() => Promise<unknown>) | null => {
    if (!("__TAURI_INTERNALS__" in window) && a.id !== "edit_training_copy") return null;
    switch (a.id) {
      case "copy_error": return null;
      case "open_downloads": return () => openDownloadModels({ filter: "all", reason: diagnostic.code });
      case "open_help": return () => openHelpSection(a.params.section === "train" ? "train" : "");
      case "open_community": return () => invoke("diagnostic_navigate", { target: "community" });
      case "start_provision": return () => invoke("diagnostic_navigate", { target: "runtime" });
      case "open_log": return () => invoke("reveal_user_dir", { name: "logs" });
      case "open_performance_options":
      case "open_storage_cleanup": return /Win/i.test(navigator.platform) ? () => invoke("diagnostic_system_action", { action: a.id }) : null;
      case "edit_training_copy": {
        const stage = a.params.stage;
        if (!editor || typeof a.params.job_id !== "string" || (stage !== "sovits" && stage !== "gpt")) return null;
        return async () => {
          if (!editor) throw new Error("training editor unavailable");
          await editor({ job_id: String(a.params.job_id), stage });
        };
      }
      default: return null;
    }
  };
  return diagnostic.actions.flatMap(action => {
    const run = dispatch(action);
    return run ? [{ label: t(`diag.action.${action.id}`), run }] : [];
  });
}
