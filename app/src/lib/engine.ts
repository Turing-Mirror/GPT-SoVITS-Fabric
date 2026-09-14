import { invoke } from "@tauri-apps/api/core";
import { tStatic } from "../i18n";

/**
 * 外壳与 Rust 侧引擎命令之间的这一层。
 *
 * 这里以前还有实时变声的一整套：开启 / 停止 / 热推参数 / 换音色不重开流 /
 * 枚举声卡。那是照搬 RVC 的，GPT-SoVITS Fabric 没有实时链路 ——
 * `tools/realtime_worker.py` 从来没随附过，`engine_start_vc` 打头那道
 * 脚本检查必然失败。界面上「开启变声」那个按钮点下去只会报错。
 *
 * 现在只剩「运行时装好了没」和「把引擎强行结束掉」两件事，
 * 合成本身走 synth_start / synth-chunk 那条独立的路。
 */

export type EngineStatus = {
  /** "busy" | "idle"。 */
  state?: string;
  runtime_ready?: boolean;
  /**
   * 最近一次合成 ready 时 worker 报的后端：cuda | mps | cpu | ""。
   *
   * 后端是自动降级的，装了 N 卡包也可能落到 CPU。不摆出来的话，
   * 用户只会看到「显存不足」之类的现象，没法把它和显卡设置联系起来。
   * 还没合成过就是空 —— 没有跑起来的后端可读。
   */
  compute_backend?: string;
  [key: string]: unknown;
};

export type ProvisionStatus = {
  runtime_ready?: boolean;
  need_provision?: boolean;
  runtime_python?: string | null;
  worker_script_ok?: boolean;
  product_root?: string;
  gpus?: string[];
  /**
   * 只含 N 卡，「主显卡」下拉用它，下标就是 CUDA 序号。
   *
   * 来源是 `nvidia-smi`，不是系统的显示适配器枚举 —— 后者会把已禁用的卡、残留的
   * 驱动键和虚拟显示器一起数进去，下标跟 CUDA 对不上。
   */
  nvidia_gpus?: string[];
  recommended_variant?: string;
  recommend_reason?: string;
  recommended_label?: string;
  recommended_size_bytes?: number;
  recommended_size_label?: string;
  installed_variant?: string | null;
  download_supported?: boolean;
  busy?: boolean;
  /** Per-variant size so the start button tracks the user's selection. */
  variants?: {
    id: string;
    label: string;
    size_bytes?: number;
    size_label?: string;
  }[];
  message?: string;
};

export type ProvisionProgress = {
  phase?: string;
  done?: number;
  total?: number;
  percent?: number;
  /** Instantaneous / short-window bytes per second (when known). */
  speed_bps?: number;
  speed_label?: string;
  message?: string;
};

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getEngineStatus(): Promise<EngineStatus> {
  if (!isTauri()) {
    return { state: "idle", runtime_ready: false };
  }
  return invoke<EngineStatus>("engine_status");
}

export async function forceKillEngine(): Promise<EngineStatus> {
  if (!isTauri()) return getEngineStatus();
  return invoke<EngineStatus>("engine_force_kill");
}

export async function getProvisionStatus(): Promise<ProvisionStatus> {
  if (!isTauri()) {
    return {
      runtime_ready: false,
      need_provision: true,
      message: tStatic("engine.browserNoRuntime"),
      download_supported: false,
    };
  }
  return invoke<ProvisionStatus>("provision_status");
}

export async function startProvision(
  variant: string,
  force = false,
): Promise<{ ok?: boolean; message?: string; variant?: string }> {
  if (!isTauri()) {
    return { ok: false, message: tStatic("engine.browserNoDownload") };
  }
  return invoke("provision_start", { variant, force });
}

export async function cancelProvision(): Promise<void> {
  if (!isTauri()) return;
  await invoke("provision_cancel");
}
