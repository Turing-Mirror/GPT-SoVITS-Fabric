import { useCallback } from "react";
import { invoke } from "../lib/invoke";
import { ImageCropDialog } from "./DiagnosticImageCropDialog";

type CoverRole = { id: string; name: string; dir: string; cover?: string; cover_exists?: boolean };
const pickImage = () => invoke<string | null>("role_cover_pick");

export function CropCoverDialog({ model, onClose, onSaved }: {
  model: CoverRole;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const source = model.cover && model.cover_exists ? `${model.dir}/${model.cover}` : undefined;
  const loadInitialImage = useCallback(() => invoke<string>("role_cover_data_url", { src: source }), [source]);
  return (
    <ImageCropDialog
      name={model.name}
      pickImage={pickImage}
      loadInitialImage={source ? loadInitialImage : undefined}
      onClose={onClose}
      onSave={async (dataUrl) => {
        await invoke("role_cover_save", { id: model.id, dataUrl });
        await onSaved();
      }}
    />
  );
}
