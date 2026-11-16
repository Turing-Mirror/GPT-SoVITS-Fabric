import { useEffect, useId, useState } from "react";
import { Modal } from "./Modal";
import { Btn } from "./ui";
import { Collapse } from "./Presence";
import { useI18n } from "../i18n";
import { openInAnnot, synthWithRole } from "../lib/intent";
import { associateRoleList, getRoleAssets, replaceRoleWeight, unlinkRoleList, type RoleAssets } from "../lib/roleAssets";

export function RoleAssetsDialog({ role, onClose, onChanged }: {
  role: { id: string; name: string };
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [details, setDetails] = useState<RoleAssets | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replaceSovits, setReplaceSovits] = useState(false);

  useEffect(() => {
    let alive = true;
    void getRoleAssets(role.id).then(data => {
      if (alive) { setDetails(data); }
    }).catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [role.id]);

  const update = async (action: () => Promise<RoleAssets | null>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await action();
      if (data) {
        setDetails(data);
        setReplaceSovits(false);
        onChanged();
      }
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  // Above page controls (40), below TRM dropdown popovers (70).
  return <Modal z={60} onBackdrop={busy ? undefined : onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); if (!busy) onClose(); } }}
      className="w-full max-w-[640px] max-h-[calc(100vh-48px)] flex flex-col min-h-0 rounded-[var(--r)] bg-[var(--surface)] shadow-[0_22px_56px_-18px_var(--scrim)]">
      <header className="px-6 pt-5 pb-4 flex-none">
        <h2 id={titleId} className="text-[16px] font-semibold m-0">{t("library.manageAssets")}</h2>
        <p className="text-[13px] text-[var(--help)] mt-1 mb-0 truncate" title={role.name}>{role.name}</p>
      </header>
      <div className="px-6 min-h-0 overflow-y-auto flex-1">
        {!details && !error ? <p className="text-[13px] text-[var(--help)]">{t("s.valueLoading")}</p> : null}
        {details ? <>
          <section className="mb-5">
            <h3 className="text-[13px] font-medium mb-2 mt-0">{t("library.modelFiles")}</h3>
            <div className="rounded-[var(--r)] bg-[var(--group)] px-4 divide-y divide-[var(--line)]">
              {details.weights.map(weight => <div key={weight.kind} className="py-3">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium">{weight.kind === "gpt" ? "GPT" : "SoVITS"}{weight.kind === "sovits" ? <span className="text-[11.5px] text-[var(--meta)] ml-2">{details.version}</span> : null}</div>
                    <div className="text-[11.5px] text-[var(--help)] break-all selectable" title={weight.path}>{weight.path}</div>
                    {!weight.exists ? <div className="text-[12.5px] text-[var(--danger-text)]">{t("library.missingFile")}</div> : null}
                  </div>
                  <Btn disabled={busy} onClick={() => weight.kind === "sovits" ? setReplaceSovits(v => !v) : void update(() => replaceRoleWeight(role.id, "gpt"))}>{t("library.replaceWeight")}</Btn>
                </div>
                {weight.kind === "sovits" ? <Collapse open={replaceSovits}>
                  <div className="flex items-center gap-3 flex-wrap pt-3">
                    <Btn busy={busy} onClick={() => void update(() => replaceRoleWeight(role.id, "sovits"))}>{t("sep.pickFile")}</Btn>
                    <Btn disabled={busy} onClick={() => setReplaceSovits(false)}>{t("dialog.cancel")}</Btn>
                  </div>
                </Collapse> : null}
              </div>)}
            </div>
          </section>
          <section>
            <div className="flex items-center gap-3 mb-2">
              <h3 className="text-[13px] font-medium m-0 flex-1">{t("library.associatedLists")}</h3>
              <Btn disabled={busy} onClick={() => void update(() => associateRoleList(role.id))}>{t("library.associateList")}</Btn>
            </div>
            <p className="text-[12.5px] text-[var(--help)] mt-0 mb-3">{t("library.associateNote")}</p>
            <div className="rounded-[var(--r)] bg-[var(--group)] px-4 divide-y divide-[var(--line)]">
              {details.lists.length ? details.lists.map(list => <div key={list.index} className="py-3 flex items-center gap-3 flex-wrap">
                <div className="min-w-0 flex-1 basis-[160px]">
                  <div className="text-[13px] break-all" title={list.path}>{list.note || list.file.split(/[\\/]/).pop() || list.file}</div>
                  <div className={`text-[11.5px] mt-1 ${list.exists && list.valid ? "text-[var(--help)]" : "text-[var(--danger-text)]"}`}>
                    {!list.exists ? t("library.missingFile") : !list.valid ? t("library.invalidList") : t("library.listRows", { v0: list.rows })}
                  </div>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Btn disabled={busy || !list.exists || !list.valid} onClick={() => { onClose(); openInAnnot(list.path); }}>{t("library.editList")}</Btn>
                  <Btn disabled={busy} onClick={() => void update(() => unlinkRoleList(role.id, list.index, list.file))}>{t("library.unlinkList")}</Btn>
                </div>
              </div>) : <p className="text-[12.5px] text-[var(--help)] py-3 m-0">{t("library.noLists")}</p>}
            </div>
          </section>
        </> : null}
        {error ? <p role="alert" className="text-[12.5px] text-[var(--danger-text)] break-words selectable">{error}</p> : null}
      </div>
      <footer className="px-6 py-4 flex justify-end gap-2 flex-none">
        <Btn disabled={busy} onClick={onClose}>{t("window.close")}</Btn>
        <Btn primary disabled={busy || !details || details.weights.some(w => !w.exists)} onClick={() => { onClose(); synthWithRole(role.id); }}>{t("library.useInSynth")}</Btn>
      </footer>
    </section>
  </Modal>;
}
