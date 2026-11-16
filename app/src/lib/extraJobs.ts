/**
 * Extra-asset and engine-core downloads, kept off the plaza page.
 *
 * Same reason as storeJobs: leaving the plaza unmounts ExtrasPanel, and a
 * download that only exists in that component looks cancelled even though
 * Rust is still writing the file.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "../i18n/t";

export type ExtraProgress = {
  key: string;
  phase: "run" | "done" | "error";
  done?: number;
  total?: number;
  message?: string;
};

export type CoreProgress = {
  phase?: string;
  done?: number;
  total?: number;
  percent?: number;
  message?: string;
  speed_label?: string;
};

export type ExtraJobsSnap = {
  busyKeys: Record<string, true>;
  coreBusy: boolean;
  progByKey: Record<string, ExtraProgress>;
  coreProg: CoreProgress | null;
  vulkanBusy: boolean;
  vulkanCancelling: boolean;
  vulkanProgress: CoreProgress | null;
  vulkanError: string;
  msg: string;
  generation: number;
};

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const starting = new Set<string>();
let busyKeys: Record<string, true> = {};
let coreBusy = false;
let progByKey: Record<string, ExtraProgress> = {};
let coreProg: CoreProgress | null = null;
let vulkanBusy = false;
let vulkanCancelling = false;
let vulkanProgress: CoreProgress | null = null;
let vulkanError = "";
let msg = "";
let generation = 0;
let listening = false;
const listeners = new Set<() => void>();

function snap(): ExtraJobsSnap {
  return { busyKeys, coreBusy, progByKey, coreProg, vulkanBusy, vulkanCancelling, vulkanProgress, vulkanError, msg, generation };
}

function emit() {
  for (const fn of listeners) fn();
}

function ensureListen() {
  if (listening || !isTauri()) return;
  listening = true;
  void listen<ExtraProgress>("extra-progress", (ev) => {
    const p = ev.payload;
    if (!p?.key) return;
    progByKey = { ...progByKey, [p.key]: p };
    if (p.phase === "error") msg = p.message || t("s.e0dab22b1a");
    emit();
  }).catch(() => {
    listening = false;
  });
  void listen<CoreProgress>("provision-progress", (ev) => {
    if (ev.payload?.phase === "gsv-cpp" && vulkanBusy) {
      vulkanProgress = ev.payload;
      emit();
    } else if (ev.payload?.phase === "engine-core" || String(ev.payload?.phase || "").includes("engine")) {
      coreProg = ev.payload;
      emit();
    }
  }).catch(() => undefined);
}

export function startExtraDownload(key: string): void {
  ensureListen();
  if (coreBusy || vulkanBusy || Object.keys(busyKeys).length > 0 || starting.has(key)) return;

  starting.add(key);
  busyKeys = { ...busyKeys, [key]: true };
  progByKey = { ...progByKey, [key]: { key, phase: "run", done: 0 } };
  msg = "";
  emit();
  void (async () => {
    try {
      await invoke("extra_download", { key });
      generation += 1;
      msg = t("s.4bbcf94739");
    } catch (e) {
      msg = String(e);
    } finally {
      starting.delete(key);
      const next = { ...busyKeys };
      delete next[key];
      busyKeys = next;
      emit();
    }
  })();
}

export function startEngineCoreDownload(): void {
  ensureListen();
  if (coreBusy || vulkanBusy || Object.keys(busyKeys).length > 0) return;
  coreBusy = true;
  msg = "";
  coreProg = {
    phase: "engine-core",
    done: 0,
    total: 1,
    percent: 0,
    message: t("s.c7ea0cf156"),
  };
  emit();
  void (async () => {
    try {
      await invoke("assets_ensure_engine_core");
      generation += 1;
      msg = t("s.33dadd8dd6");
      coreProg = null;
    } catch (e) {
      msg = String(e);
    } finally {
      coreBusy = false;
      emit();
    }
  })();
}

export function startVulkanDownload(): void {
  if (!isTauri() || coreBusy || vulkanBusy || Object.keys(busyKeys).length > 0) return;
  ensureListen();
  vulkanBusy = true;
  vulkanProgress = null;
  vulkanError = "";
  emit();
  void invoke<{ ok: boolean }>("assets_ensure_gsv_cpp")
    .then((result) => {
      if (result.ok) generation += 1;
    })
    .catch((e) => { vulkanError = String(e); })
    .finally(() => {
      vulkanBusy = false;
      vulkanCancelling = false;
      vulkanProgress = null;
      emit();
    });
}

export function cancelVulkanDownload(): void {
  if (!vulkanBusy || vulkanCancelling) return;
  vulkanCancelling = true;
  emit();
  void invoke("assets_cancel_gsv_cpp").catch((e) => {
    vulkanCancelling = false;
    vulkanError = String(e);
    emit();
  });
}

export function subscribeExtraJobs(fn: () => void): () => void {
  ensureListen();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useExtraJobs(): ExtraJobsSnap {
  const [s, setS] = useState(snap);
  useEffect(() => subscribeExtraJobs(() => setS(snap())), []);
  return s;
}
