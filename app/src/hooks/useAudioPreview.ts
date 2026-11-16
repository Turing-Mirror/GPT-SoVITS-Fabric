import { useEffect, useState } from "react";
import { usePageActive } from "trm-ui";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AudioPreview } from "../lib/audioPreview";
export function useAudioPreview(volume = 1) {
  const [playing, setPlaying] = useState("");
  const [player] = useState(() => new AudioPreview(setPlaying));
  const active = usePageActive();
  useEffect(() => { player.setVolume(volume); }, [player, volume]);
  useEffect(() => { if (!active) player.stop(); }, [active, player]);
  useEffect(() => () => player.stop(), [player]);
  const play = (path: string, onError: () => void) => {
    const src = "__TAURI_INTERNALS__" in window ? convertFileSrc(path) : path;
    void player.toggle(path, src, volume, onError);
  };
  return { playing, play, stop: player.stop, player };
}
