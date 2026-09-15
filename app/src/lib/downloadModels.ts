/**
 * 引擎资源 / 「下载模型」入口。
 *
 * 合成与训练都依赖引擎底模组（cnhubert / roberta / s1v3 / v2ProPlus / sv /
 * g2pw）。缺了就打开「下载模型」：先补引擎资源，再允许下分离/训练附加包。
 *
 * - 合成台、训练台、分离窗：前置检查发现缺引擎资源 → 跳转广场「下载模型」
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ExtrasFilter } from "../components/ExtrasDialog";

export type AssetsStatus = {
  engine_core_ready?: boolean;
  engine_core_missing?: string[];
};

export type OpenDownloadModelsOpts = {
  reason?: string;
  filter?: ExtrasFilter;
};

type ModelsOpener = (opts?: OpenDownloadModelsOpts) => void;

let modelsOpener: ModelsOpener | null = null;

/** App 挂载时注册「下载模型」弹窗。 */
export function registerDownloadModelsOpener(fn: ModelsOpener | null): void {
  modelsOpener = fn;
}

/**
 * 打开「广场 → 下载模型」。
 *
 * 主窗口里有注册好的 opener，直接跳广场。工具窗口（人声分离 / 标注管理）
 * 是独立的 webview，没有广场也没有 App —— 那边改成把主窗口叫到
 * 前面再跳，而不是就地弹一个塞不下的框。
 */
export function openDownloadModels(opts?: OpenDownloadModelsOpts): void {
  // 工具窗是独立 webview。以前只要模块里挂过 opener（或 hash 丢了误挂
  // 整棵 App）就会在小窗里 setPage("plaza")，看起来像旧的「下载分离模型」
  // 弹窗，主窗口广场根本没动。不是主窗就一律绕回主窗口。
  let isMain = false;
  try {
    isMain = getCurrentWindow().label === "main";
  } catch {
    isMain = !/^#\/tool\//.test(window.location.hash || "");
  }
  if (isMain && modelsOpener) {
    modelsOpener(opts);
    return;
  }
  void invoke("tools_open_downloads", {
    reason: opts?.reason || "",
    filter: opts?.filter || "",
  }).catch(() => {
    /* 浏览器预览里没有 shell */
  });
}

export async function getAssetsStatus(): Promise<AssetsStatus> {
  try {
    return await invoke<AssetsStatus>("assets_status");
  } catch {
    return { engine_core_ready: true };
  }
}

export async function isEngineCoreReady(): Promise<boolean> {
  const st = await getAssetsStatus();
  return st.engine_core_ready !== false;
}

/**
 * 缺引擎资源则打开「下载模型」弹窗并返回 false；已就绪返回 true。
 */
export async function ensureEngineCoreOrPrompt(
  reason: string,
): Promise<boolean> {
  if (await isEngineCoreReady()) return true;
  openDownloadModels({ reason });
  return false;
}
