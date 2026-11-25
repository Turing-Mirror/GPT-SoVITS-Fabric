import { useCallback, useRef, useState } from "react";
import { Leave, usePageActive, usePaneOn } from "trm-ui";
import { ImageCropDialog } from "./DiagnosticImageCropDialog";
import { ErrorNote } from "./ErrorNote";
import { errorWithTitle } from "../lib/diagnostics";
import { useI18n } from "../i18n";
import { invoke } from "../lib/invoke";
import { Btn } from "./ui";

const pickCoverImage = () => invoke<string | null>("publication_pick_cover_path");
const coverDataUrl = (src: string) => invoke<string>("role_cover_data_url", { src });

export function CommunityCover({ value, original, name, onChange, disabled, fallback }: {
  value: string;
  original?: string;
  fallback?: string;
  name: string;
  onChange: (cover: string, original?: string) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const paneActive = usePaneOn();
  const pageActive = usePageActive();
  const [source, setSource] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const originalPath = useRef<string | undefined>(undefined);
  const loadImage = useCallback(async () => source ?? "", [source]);

  async function pickImage() {
    const path = await pickCoverImage();
    if (!path) return null;
    const image = await coverDataUrl(path);
    originalPath.current = path;
    return image;
  }

  async function open() {
    setPicking(true);
    setError("");
    originalPath.current = original;
    try {
      const image = value
        ? (original ? await coverDataUrl(original).catch(() => value) : value)
        : await pickImage();
      if (image) setSource(image);
    } catch (error) {
      setError(errorWithTitle(error, "publication.coverError", "importexport"));
    } finally {
      setPicking(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="text-[13px] font-semibold">{t("publication.cover")}</div>
      {(value || fallback) && <img src={value || fallback} alt={t("publication.cover")} draggable={false} className="w-full max-w-[280px] aspect-[4/3] rounded-[var(--rs)] object-cover" />}
      <div className="flex flex-wrap gap-2">
        <Btn disabled={disabled || picking} busy={picking} onClick={() => void open()}>{t(value ? "ui.crop.title" : "publication.chooseCover")}</Btn>
        {value && <Btn disabled={disabled || picking} onClick={() => onChange("")}>{t("ui.common.clear")}</Btn>}
      </div>
      {error && <ErrorNote feature="importexport" text={error} />}
      <Leave>
        {source && paneActive && pageActive ? (
          <ImageCropDialog
            name={name || t("publication.cover")}
            pickImage={pickImage}
            loadInitialImage={loadImage}
            onClose={() => setSource(undefined)}
            onSave={async (cover) => {
              onChange(cover, originalPath.current);
              setSource(undefined);
            }}
          />
        ) : null}
      </Leave>
    </section>
  );
}
