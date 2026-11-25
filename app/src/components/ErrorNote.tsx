import { useMemo } from "react";
import { ErrorNote as SharedErrorNote } from "trm-ui";
import { diagnosticContent, unknownDiagnostic, type Feature } from "../lib/diagnostics";
import { diagnosticActions } from "../lib/diagnosticActions";

/** Every error surface uses the same resolved content, including compact rows. */
export function ErrorNote({ text, diagnostic, error = true, feature = "other", extraAction }: {
  text?: unknown; diagnostic?: unknown; error?: boolean; feature?: Feature; code?: string | null; compact?: boolean;
  extraAction?: { label: string; run: () => void | Promise<unknown> } | null;
}) {
  const d = useMemo(() => unknownDiagnostic(diagnostic ?? text, feature), [diagnostic, text, feature]);
  if (!text && !diagnostic) return null;
  if (!error) return <p className="m-0 mt-3 text-[12.5px] text-[var(--ink-muted)] break-all leading-relaxed whitespace-pre-wrap">{String(text ?? "")}</p>;
  return <SharedErrorNote key={d.error_id} content={diagnosticContent(d)} actions={[
    ...(extraAction ? [extraAction] : []), ...diagnosticActions(d),
  ]} />;
}
