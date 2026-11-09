import { useCallback, useEffect, useRef, useState } from "react";
import {
  getEngineStatus,
  getProvisionStatus,
  type EngineStatus,
  type ProvisionStatus,
} from "../lib/engine";
import { t } from "../i18n/t";

/**
 * 运行时补全状态。
 *
 * 这个 hook 以前还管着实时变声：开启/停止、音高与共鸣的热推、输出模式、
 * 麦克风电平、「按下开启变声的次数」。那条链路是照搬 RVC 的，
 * GPT-SoVITS 没有实时推理，而它调的 `tools/realtime_worker.py` 也从来
 * 没随附过 —— 那个「开启变声」按钮点下去必然报脚本缺失。
 *
 * 现在只剩一件事：运行时装好了没。首次引导和合成台、训练台的前置闸都看它。
 * 设备枚举也一并去掉了 —— 这个产品的界面上没有任何声卡下拉框。
 */
export function useEngine() {
  const [status, setStatus] = useState<EngineStatus>({});
  const [provision, setProvision] = useState<ProvisionStatus>({});
  const [lastError, setLastError] = useState("");

  // 运行时是不是已经补全了。用 ref 是因为轮询回调要读它，又不能让它进依赖 ——
  // 进了依赖每次翻转都会重建定时器。
  const runtimeReadyRef = useRef<boolean | undefined>(undefined);

  /**
   * 重新问一次运行时状态。
   *
   * 以前这个只在挂载时问一次，于是「下载 → 解压 → 装好」之后
   * `provision.runtime_ready` 还停在 false，各个面板的前置闸照样拦着说
   * 「运行时未就绪」—— 用户唯一的出路是重启软件。装完就该能用。
   */
  const refreshProvision = useCallback(async () => {
    try {
      const p = await getProvisionStatus();
      setProvision(p);
      const wasReady = runtimeReadyRef.current;
      runtimeReadyRef.current = p.runtime_ready;
      // false → true 的那一下：运行时刚补全，把「运行时未就绪」那句错误撤掉。
      if (wasReady === false && p.runtime_ready !== false) {
        setLastError("");
        setStatus(await getEngineStatus());
      }
      return p;
    } catch {
      return undefined;
    }
  }, []);

  const refresh = useCallback(async () => {
    // 运行时还没就绪时顺带盯着它 —— 补全是在另一个组件里跑的，装完那一刻
    // 没有事件通知这里。就绪之后就不再问，免得白跑文件检查。
    if (runtimeReadyRef.current === false) {
      void refreshProvision();
    }
    try {
      const st = await getEngineStatus();
      setStatus((prev) =>
        Object.keys(st).every((key) => Object.is(prev[key], st[key])) ? prev : { ...prev, ...st },
      );
      if (st.state === "error" && st.error) setLastError(String(st.error));
    } catch (e) {
      setLastError(String(e));
    }
  }, [refreshProvision]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await getProvisionStatus();
        if (!cancelled) setProvision(p);
        runtimeReadyRef.current = p.runtime_ready;
        const st = await getEngineStatus();
        if (cancelled) return;
        setStatus(st);
        if (p.runtime_ready === false) {
          setLastError(String(p.message || t("s.14b8f39742")));
        }
      } catch (e) {
        if (!cancelled) setLastError(String(e));
      }
    })();

    // 慢轮询。这里已经没有麦克风电平那种需要跟手的东西了，剩下的只是
    // 「运行时装好了没」，几秒一次足够；窗口在后台时再放慢一档。
    let id = 0;
    let currentMs = 0;
    const arm = () => {
      const ms = document.visibilityState === "hidden" ? 8000 : 3000;
      if (ms === currentMs && id) return;
      currentMs = ms;
      if (id) window.clearInterval(id);
      id = window.setInterval(() => void refresh(), ms);
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", arm);
      if (id) window.clearInterval(id);
    };
  }, [refresh]);

  return {
    status,
    provision,
    lastError,
    refresh,
    refreshProvision,
  };
}
