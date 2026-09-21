import { memo } from "react";
import { t } from "../i18n/t";

/**
 * 底部悬浮状态条。
 *
 * 形状就是 Nudge 那张圆角卡片：页边距内一条、圆角、表面色加淡投影，
 * 不贴窗口边缘、不是满宽横幅。内容按 RVC Dock 的两端排：左边「当前
 * 角色 + 引擎状态」，右边主行动按钮。
 *
 * `statusTitle` / `statusSub` 由运行时是否就绪驱动（见 App.tsx）。
 * `roleName` 由 App 读配置里的 `synth_role` 再换成名字传进来；合成台换
 * 角色时会广播配置补丁，这里跟着变。角色被删掉之后传空串 —— id 还留在
 * 配置里，但人已经不在了，继续显示它的名字是在骗人。
 */

type Props = {
  roleName?: string;
  statusTitle: string;
  statusSub?: string;
  progress?: number | null;
  loading?: boolean;
  onOpenSynth: () => void;
};

function StatusBarImpl({
  roleName,
  statusTitle,
  statusSub,
  progress,
  loading = false,
  onOpenSynth,
}: Props) {
  return (
    <footer
      className={[
        "shrink-0 mx-[30px] mb-3 mt-1 flex items-center gap-4 flex-wrap",
        "rounded-[var(--r)] bg-[var(--surface)] px-4 py-3",
        "shadow-[0_6px_20px_-10px_rgba(0,0,0,.3),inset_0_0_0_1px_var(--hairline)]",
        "max-[1020px]:mx-[22px] max-[720px]:mx-4",
      ].join(" ")}
    >
      <div className="min-w-0">
        <div className="text-[13.5px] font-semibold leading-tight truncate">
          {roleName ? t("statusbar.role", { name: roleName }) : t("statusbar.noRole")}
        </div>
        <div className="text-[11.5px] text-[var(--meta)] leading-tight truncate mt-0.5">
          {loading
            ? t("statusbar.loading")
            : statusSub
              ? `${statusTitle} · ${statusSub}`
              : statusTitle}
        </div>
      </div>
      {progress != null ? (
        <div
          className="h-1 w-[132px] overflow-hidden rounded-sm bg-[color-mix(in_srgb,var(--ink)_10%,transparent)] flex-none"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
        >
          <div
            className="h-full bg-[var(--accent)] transition-[width] duration-200 ease-out"
            style={{ width: `${Math.max(4, Math.min(100, progress))}%` }}
          />
        </div>
      ) : null}
      <button
        type="button"
        onClick={onOpenSynth}
        className={[
          "ml-auto border-0 rounded-[var(--rs)] px-7 py-2.5 cursor-pointer whitespace-nowrap",
          "text-sm font-semibold bg-[var(--accent)] text-[var(--accent-ink)]",
          "transition-[transform,filter] duration-200 ease-[var(--spring)]",
          "hover:brightness-95",
          "active:scale-[0.965]",
          "focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2",
        ].join(" ")}
      >
        {t("statusbar.openSynth")}
      </button>
    </footer>
  );
}

export const StatusBar = memo(StatusBarImpl);
