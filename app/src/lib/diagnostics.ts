import { t } from "../i18n/t";
import type { ErrorNoteContent } from "trm-ui";

export type Feature = "training" | "synthesis" | "annotation" | "separation" | "download" | "update" | "provision" | "enginestart" | "importexport" | "store" | "settings" | "other";
export type Message = { key: string; params: Record<string, string | number | null> };
export type DiagnosticAction = { id: string; params: Record<string, string | number> };
export type Diagnostic = {
  schema: 1; error_id: string; scope: { feature: string; stage: string | null; job_id: string | null; attempt: number | null };
  code: string; source_code: string | null; confidence: string; title: Message; cause: Message | null;
  steps: Message[]; actions: DiagnosticAction[]; detail: { text: string; log_ref: string | null; truncated: boolean };
};

export function readDiagnostic(value: unknown): Diagnostic | null {
  if (value instanceof DiagnosticFailure) return value.diagnostic;
  if (typeof value === "string") {
    try { return readDiagnostic(JSON.parse(value)); } catch { return null; }
  }
  if (!value || typeof value !== "object") return null;
  if ("diagnostic" in value) return readDiagnostic(value.diagnostic);
  // Local API / older bridges may carry the serialized envelope in message.
  if ("message" in value && typeof value.message === "string") return readDiagnostic(value.message);
  const d = value as Diagnostic;
  return d.schema === 1 && typeof d.error_id === "string" && !!d.title?.key && !!d.scope &&
    Array.isArray(d.steps) && Array.isArray(d.actions) && typeof d.detail?.text === "string" ? d : null;
}

const message = (key: string, params: Record<string, string | number | null> = {}): Message => ({ key, params });
/** Existing, explicit business messages can name the failed operation without discarding its evidence. */
export function errorWithTitle(
  value: unknown,
  key: string,
  feature: Feature = "other",
  params: Record<string, string | number | null> = {},
): string {
  return JSON.stringify({ ...unknownDiagnostic(value, feature), title: message(key, params) });
}
/** Override a misleading command-prefix feature with what the user is actually doing. */
export function withFeature(value: unknown, feature: Feature): Diagnostic {
  const d = unknownDiagnostic(value, feature);
  if (d.scope.feature === feature) return d;
  const genericTitle = d.title.key === `diag.title.${d.scope.feature}`;
  return {
    ...d,
    scope: { ...d.scope, feature },
    title: genericTitle ? message(`diag.title.${feature}`) : d.title,
  };
}
export function unknownDiagnostic(value: unknown, feature: Feature = "other"): Diagnostic {
  const found = readDiagnostic(value);
  if (found) return found;
  const raw = value instanceof Error ? `${value.message}\n${value.stack ?? ""}` : typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return {
    schema: 1, error_id: `ui-${globalThis.crypto.randomUUID()}`, scope: { feature, stage: null, job_id: null, attempt: null },
    code: "diag.unknown", source_code: null, confidence: "unknown", title: message(`diag.title.${feature}`),
    cause: message("diag.cause.unknown"), steps: [message("diag.step.copyAndCommunity")],
    actions: [{ id: "open_community", params: {} }], detail: { text: raw, log_ref: null, truncated: false },
  };
}

export function diagnosticContent(value: unknown, feature: Feature = "other"): ErrorNoteContent {
  const d = unknownDiagnostic(value, feature);
  const resolve = (m: Message) => t(m.key, m.params);
  const title = resolve(d.title);
  const cause = resolve(d.cause ?? message("diag.cause.unknown"));
  const steps = d.steps.map(resolve);
  const detail = `${d.detail.text}\n\nerror_id: ${d.error_id}${d.detail.log_ref ? `\nlog_ref: ${d.detail.log_ref}` : ""}\ntruncated: ${d.detail.truncated}`;
  return { title, cause, steps, detail, copy: [title, cause, ...steps.map((s, i) => `${i + 1}. ${s}`), detail].join("\n") };
}

/** String compatibility for existing state/hooks, without losing the wire object. */
export class DiagnosticFailure extends Error {
  readonly code?: unknown;
  readonly details?: unknown;
  constructor(readonly diagnostic: Diagnostic, source?: unknown) {
    super(t(diagnostic.title.key, diagnostic.title.params));
    this.code = diagnostic.source_code;
    if (source && typeof source === "object") {
      if ("code" in source) this.code = source.code;
      if ("details" in source) this.details = source.details;
    }
  }
  override toString(): string { return JSON.stringify(this.diagnostic); }
}

export function isCancelled(value: unknown): boolean {
  return readDiagnostic(value)?.code === "diag.cancelled" ||
    (value instanceof DiagnosticFailure && value.code === "cancelled");
}

export function commandFeature(command: string): Feature {
  if (command.startsWith("train_")) return "training";
  if (command.startsWith("annot_")) return "annotation";
  if (command.startsWith("synth_")) return "synthesis";
  if (command.startsWith("separate_")) return "separation";
  if (command.startsWith("update_")) return "update";
  if (/^(provision|assets|vcredist)_/.test(command)) return "provision";
  if (/^extras?_/.test(command)) return "download";
  if (/^(store|community|plaza)_/.test(command)) return "store";
  if (/^(role|character|publication|model_version)/.test(command)) return "importexport";
  if (/^(config|autostart|wallpaper)_/.test(command)) return "settings";
  if (/^(engine|legacy)_/.test(command)) return "enginestart";
  return "other";
}
