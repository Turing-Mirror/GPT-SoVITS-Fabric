import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n/t";
import { Select } from "./controls";
import { Btn } from "./ui";
import { Modal } from "./Modal";

/** Browser file selection works on the client; the catalog is on the Windows host. */
export function LanListPicker({ onClose, onPick }: { onClose: () => void; onPick: (path: string) => void }) {
  const title = useId();
  const file = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<{ path: string; label: string }[] | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [uploadError, setUploadError] = useState("");
  useEffect(() => {
    let active = true;
    void invoke<{ path: string; label: string }[]>("annot_catalog").then((rows) => {
      if (!Array.isArray(rows)) throw new Error(t("s.valueFailed"));
      if (active) setItems(rows);
    }).catch((error) => { if (active) setLoadError(String(error)); });
    return () => { active = false; };
  }, []);

  const upload = async (selected?: File) => {
    if (!selected || busy) return;
    setUploadError("");
    setBusy(true);
    try {
      if (selected.size > 2 * 1024 * 1024) throw new Error(t("lan.listTooLarge"));
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await selected.arrayBuffer());
      const p = await invoke<string>("annot_upload", { name: selected.name, text });
      if (typeof p !== "string" || !p) throw new Error(t("s.valueFailed"));
      onPick(p);
    } catch (error) { setUploadError(String(error)); }
    finally { setBusy(false); }
  };

  return <Modal onBackdrop={busy ? undefined : onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby={title} aria-busy={busy}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === "Escape" && !busy) onClose(); }}
      className="w-full max-w-[480px] max-h-[90dvh] overflow-y-auto rounded-[var(--r)] bg-[var(--surface)] p-5">
      <h2 id={title} className="text-[16px] m-0 mb-3">{t("lan.listPicker")}</h2>
      <p className="text-[13px] text-[var(--help)] mt-0">{t("lan.listPickerHint")}</p>
      {items?.length ? <Select value={path} onChange={setPath} full
        options={[{ id: "", label: t("lan.chooseHostList") }, ...items.map((item) => ({ id: item.path, label: item.label }))]} />
        : <p className="text-[13px]" role={loadError ? "alert" : "status"}>
          {loadError || (items ? t("lan.noHostList") : t("s.valueLoading"))}
        </p>}
      {/* design-allow: native browser file input must not be proxied through the desktop picker. */}
      <input ref={file} type="file" accept=".list" hidden onChange={(e) => {
        const chosen = e.currentTarget.files?.[0];
        e.currentTarget.value = "";
        void upload(chosen);
      }} />
      {uploadError ? <p role="alert" className="text-[13px] break-words">{uploadError}</p> : null}
      <div className="flex flex-wrap justify-end gap-2 mt-4">
        <Btn disabled={busy} onClick={onClose}>{t("dialog.cancel")}</Btn>
        <Btn busy={busy} disabled={busy} onClick={() => file.current?.click()}>{t("lan.uploadList")}</Btn>
        <Btn primary disabled={!path || busy} onClick={() => onPick(path)}>{t("dialog.ok")}</Btn>
      </div>
    </section>
  </Modal>;
}
