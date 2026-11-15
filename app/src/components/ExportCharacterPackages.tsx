import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Btn, Group, Modal, SearchBox, Toggle, Warn } from "trm-ui";
import { useI18n } from "../i18n";
import { CatalogTransition } from "./CatalogTransition";

type ExportRole = { id: string; name: string; version?: string };
type ExportResult = { folder: string; packs: Array<{ roleId?: string; name: string; error?: string }> };

export function ExportCharacterPackages({ open, roles, onClose }: {
  open: boolean;
  roles: ExportRole[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ExportResult>();
  const [requestedIds, setRequestedIds] = useState<string[]>([]);
  const search = query.trim().toLocaleLowerCase();
  const visible = roles.filter((role) => role.name.toLocaleLowerCase().includes(search));
  const ids = roles.filter((role) => selected.has(role.id)).map((role) => role.id);
  const allShown = visible.length > 0 && visible.every((role) => selected.has(role.id));
  const failures = result?.packs.filter((row) => row.error) ?? [];
  const retryIds = result?.packs.flatMap((row, index) => {
    const id = row.roleId ?? requestedIds[index];
    return row.error && id ? [id] : [];
  }) ?? [];

  function close() {
    if (busy) return;
    onClose();
  }

  function toggle(changes: string[], checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const id of changes) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  async function start(roleIds: string[]) {
    setBusy(true);
    setError("");
    try {
      const exported = await invoke<ExportResult | null>("publication_export_packs", { ids: roleIds });
      if (exported) {
        setRequestedIds(roleIds);
        setResult(exported);
      }
    } catch {
      setError(t("publication.packReadError"));
    } finally {
      setBusy(false);
    }
  }

  const title = t("publication.exportPacks");
  return (
    <Modal open={open} onClose={close} label={title} width={640}>
      <div className="space-y-4 p-6">
        <h2 className="m-0 text-[16px] font-semibold">{title}</h2>
        {error && <Warn>{error}</Warn>}
        <CatalogTransition scope={result ? "result" : "selection"} order={["selection", "result"]}>
          {result ? (
            <div className="space-y-3 text-[13px]" role="status">
              <p className="m-0">{t("publication.exportedCount", { v0: result.packs.length - failures.length, v1: result.packs.length })}</p>
              {result.packs.length > failures.length && <p className="break-all text-[var(--help)]">{result.folder}</p>}
              {failures.length > 0 && <Group>
                <ul className="m-0 max-h-[36vh] list-none space-y-3 overflow-y-auto p-0">
                  {failures.map((row, index) => <li key={row.roleId ?? index}>
                    <p className="m-0">{t("publication.packFailed", { v0: row.name })}</p>
                    <p className="m-0 mt-1 whitespace-pre-wrap break-words text-[12.5px] text-[var(--help)]">{row.error}</p>
                  </li>)}
                </ul>
              </Group>}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="m-0 text-[12.5px] text-[var(--help)]">{t("publication.exportHint")}</p>
              <SearchBox full value={query} onChange={setQuery} ariaLabel={t("ui.common.search")} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Toggle look="inline" checked={allShown} disabled={busy || !visible.length}
                  label={t(search ? "publication.selectResults" : "publication.selectAll")}
                  onChange={(checked) => toggle(visible.map((role) => role.id), checked)} />
                <span className="text-[11.5px] tabular-nums text-[var(--help)]" aria-live="polite">
                  {t("publication.selectedCount", { v0: ids.length })}
                </span>
              </div>
              {visible.length ? <Group>
                <div className="max-h-[36vh] divide-y divide-[var(--hairline)] overflow-y-auto">
                  {visible.map((role) => (
                    <div key={role.id} className="flex items-center justify-between gap-3 py-2">
                      <Toggle look="inline" className="min-w-0 break-words" checked={selected.has(role.id)}
                        disabled={busy} label={role.name} onChange={(checked) => toggle([role.id], checked)} />
                      {role.version && <span className="shrink-0 text-[11.5px] text-[var(--help)]">{role.version}</span>}
                    </div>
                  ))}
                </div>
              </Group> : <p className="text-[13px] text-[var(--help)]">{t("library.noHit")}</p>}
            </div>
          )}
        </CatalogTransition>
        <div className="flex flex-wrap justify-end gap-2">
          <Btn disabled={busy} onClick={close}>{t(result ? "ui.common.close" : "ui.common.cancel")}</Btn>
          {result ? retryIds.length > 0 && <Btn primary busy={busy} disabled={busy}
            onClick={() => void start(retryIds)}>{t("publication.retryExport")}</Btn>
            : <Btn primary busy={busy} disabled={!ids.length || busy} onClick={() => void start(ids)}>{title}</Btn>}
        </div>
      </div>
    </Modal>
  );
}
