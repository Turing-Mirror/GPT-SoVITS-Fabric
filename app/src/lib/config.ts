import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n/t";

export type Config = Record<string, unknown>;

export type ConfigWrite = {
  config: Config;
  hot: Record<string, unknown>;
  /** Cold keys in this patch — the stream must be restarted for them. */
  needs_restart: string[];
};

export async function getConfig(): Promise<Config> {
  return await invoke<Config>("config_get");
}

export async function setConfig(patch: Config): Promise<ConfigWrite> {
  return await invoke<ConfigWrite>("config_set", { patch });
}

/** 设置页乐观写入时立刻通知底栏等订阅方，不等 220ms 落盘。 */
const patchListeners = new Set<(patch: Config) => void>();

export function onConfigPatch(fn: (patch: Config) => void): () => void {
  patchListeners.add(fn);
  return () => {
    patchListeners.delete(fn);
  };
}

export function notifyConfigPatch(patch: Config): void {
  if (!Object.keys(patch).length) return;
  patchListeners.forEach((fn) => fn(patch));
}

/**
 * 设置页每个 ? 后面的详细说明。
 *
 * 必须是函数：顶层 t() 会把语言冻结在导入那一刻的 zh-CN。
 *
 * 只列设置页真的渲染的那几项。此前这里还挂着三十多条实时变声的说明
 * （声卡接口、监听设备、切片块时长、EQ、噪声门……），设置页早就不渲染它们了，
 * 却因为被这张表引用而一直算「在用」，八个语言包各留一份。
 */
export function tips(): Record<string, string> {
  return {
    theme_mode: t("s.ffa02ab8a7"),
    wallpaper_path: t("s.f06f8d2041"),
    wallpaper_blur: t("s.f069ff33fd"),
    wallpaper_opacity: t("s.6e2aba9d02"),
    home_banner_text: t("settings.bannerTextTip"),
    home_banner_opacity: t("settings.bannerOpacityTip"),
    close_action: t("s.a22a5eeab1"),
    telemetry_opt_in: t("s.a97cbce3c5"),
  };
}
