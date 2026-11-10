import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { t } from "../i18n/t";

/**
 * 广场（社区角色）与它的暂存下载。
 *
 * **这个文件以前还带着 RVC 的整套音色管理**：列音色 / 选中 / 清除 / 改名 /
 * 删除 / 导入 pth / 检索库绑定 / 参数档案的增删改导入导出 / 打开音色目录 ——
 * 21 个导出，**一个都没有被任何组件调用过**（StoreSection 与 PinnedRow 只用
 * 广场那几个和 `colsForWidth`）。
 *
 * 它们没被四道文案校验发现，正是因为「命令名的字面量出现在源码里」——
 * 一个没人调的函数把二十个死命令、一整套死文案、以及背后 2400 行
 * `voices.rs` 一起吊着。和 FPS 那边未被调用的 `tips()` 吊住 39 条变声器
 * 文案是同一个漏法。
 */

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export type VoiceAuthor = { name: string; url?: string };

export type StoreVoice = {
  id: string;
  name: string;
  name_i18n?: Record<string, string>;
  /** Japanese display name when different from name */
  name_ja?: string;
  /** English / romanization */
  name_en?: string;
  /** Traditional Chinese */
  name_zh_Hant?: string;
  tag?: string;
  tag_i18n?: Record<string, string>;
  version?: string;
  pack_url?: string;
  pth_url?: string;
  /** Absolute https URL (preferred; filled by store.rs from cover/banner). */
  cover_url?: string;
  /** Relative path leftover from older caches, e.g. ch-banner/foo.jpg */
  cover?: string;
  size_bytes?: number;
  size_label?: string;
  sha256?: string;
  description?: string;
  description_i18n?: Record<string, string>;
  author?: string;
  author_i18n?: Record<string, string>;
  author_url?: string;
  /** 多作者写法（清单的 authors 数组）。 */
  authors?: VoiceAuthor[];
  date?: string;
  series?: string;
  series_i18n?: Record<string, string>;
  series_ja?: string;
  series_en?: string;
  series_zh_Hant?: string;
  /** Club / department inside a series (e.g. 研讨会). */
  group?: string;
  group_i18n?: Record<string, string>;
  origin?: string;
  origin_label?: string;
  /** 本机 ch-banner 绝对路径；远程封面挂了时走 asset 协议。 */
  cover_local?: string;
  source_url?: string;
  official?: boolean;
  installed?: boolean;
  installed_role_id?: string;
  update_available?: boolean;
  community_release?: string;
  community_staging_id?: string;
  license?: { id?: string; text?: string; url?: string };
};

export type StoreCatalog = {
  source?: string;
  voices?: StoreVoice[];
  thirdparty_voices?: StoreVoice[];
  fetch_error?: string;
};

export function coverSrc(path?: string): string {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  if (!isTauri()) return "";
  try {
    return convertFileSrc(path);
  } catch {
    return "";
  }
}

export async function fetchStoreCatalog(preferRemote = true) {
  if (!isTauri()) {
    return {
      source: "demo",
      voices: [],
      thirdparty_voices: [],
      fetch_error: t("s.d15a7a3da1"),
    } satisfies StoreCatalog;
  }
  return invoke<StoreCatalog>("store_catalog", { preferRemote });
}

export async function installStoreVoice(entry: StoreVoice) {
  if (!isTauri()) return { ok: false };
  return invoke("store_install", { entry });
}

export type StagedVoice = { dir: string; file: string; size_bytes: number };

export async function stagedVoices(): Promise<Record<string, StagedVoice>> {
  if (!isTauri()) return {};
  return (await invoke<Record<string, StagedVoice>>("store_staged")) || {};
}

export async function revealStagedVoice(voiceId: string) {
  if (!isTauri()) return;
  return invoke("store_reveal_staged", { voiceId });
}

export async function discardStagedVoice(voiceId: string) {
  if (!isTauri()) return;
  return invoke("store_discard_staged", { voiceId });
}

export async function installStagedVoice(entry: StoreVoice) {
  if (!isTauri()) return { ok: false };
  return invoke("store_install_staged", { entry });
}

export async function cancelStoreDownload(voiceId?: string) {
  if (!isTauri()) return;
  return invoke("store_cancel", { voiceId: voiceId ?? "" });
}

export function colsForWidth(w: number): number {
  // card_min ≈ 180 + gap; max 5
  const usable = Math.max(w - 48, 320);
  return Math.max(1, Math.min(5, Math.floor(usable / 200)));
}
