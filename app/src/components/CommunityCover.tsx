import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ImageCropDialog, Leave, usePageActive, usePaneOn } from "trm-ui";
import { useI18n } from "../i18n";
import { Btn, Warn } from "./ui";

const pickImage = () => invoke<string | null>("role_cover_pick");

export function CommunityCover({ value, name, onChange, disabled }: {
  value: string;
  name: string;
  onChange: (cover: string) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const paneActive = usePaneOn();
  const pageActive = usePageActive();
  const [source, setSource] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState(false);
  const loadImage = useCallback(async () => source ?? "", [source]);

  async function open() {
    setPicking(true);
    setError(false);
    try {
      const image = value || await pickImage();
      if (image) setSource(image);
    } catch {
      setError(true);
    } finally {
      setPicking(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="text-[13px] font-semibold">{t("publication.cover")}</div>
      {value && <img src={value} alt={t("publication.cover")} draggable={false} className="w-full max-w-[280px] aspect-[4/3] rounded-[var(--rs)] object-cover" />}
      <div className="flex flex-wrap gap-2">
        <Btn disabled={disabled || picking} busy={picking} onClick={() => void open()}>{t(value ? "ui.crop.title" : "publication.chooseCover")}</Btn>
        {value && <Btn disabled={disabled} onClick={() => onChange("")}>{t("ui.common.clear")}</Btn>}
      </div>
      {error && <Warn>{t("publication.coverError")}</Warn>}
      <Leave>
        {source && paneActive && pageActive ? (
          <ImageCropDialog
            name={name || t("publication.cover")}
            pickImage={pickImage}
            loadInitialImage={loadImage}
            onClose={() => setSource(undefined)}
            onSave={async (cover) => {
              onChange(cover);
              setSource(undefined);
            }}
          />
        ) : null}
      </Leave>
    </section>
  );
}
