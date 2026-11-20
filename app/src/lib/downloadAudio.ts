import { convertFileSrc } from "@tauri-apps/api/core";

export function downloadAudio(path: string, name: string): void {
  const link = document.createElement("a");
  link.href = convertFileSrc(path);
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
}
