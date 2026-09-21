import { memo } from "react";
import { t } from "../i18n/t";

/**
 * 底部状态条（对应 RVC-Fabric 的 Dock 位，但形态按这个产品来）。
 *
 * GPT-SoVITS Fabric 没有常驻变声流，RVC Dock 中间的模式切换、麦克风电平、
 * 音高/共鸣滑块在这里都没有对应物 —— 所以这条只保留 Dock 的两端：左边
 * 「当前角色」块，右边「引擎状态 + 主行动按钮」。排版与 Dock 相同：满宽、
 * 平铺在页面底色上、顶部一条两端收进页边距的发丝线。
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
    <footer className="flex-none relative px-[30px] py-4 flex items-center gap-[30px] flex-wrap max-[1020px]:px-[22px] max-[1020px]:gap-[22px] max-[720px]:px-4 max-[720px]:gap-4">
      {/* Hairline: inset ends, not full-width border-top */}
      <div
        aria-hidden
        className="absolute top-0 left-[30px] right-[30px] h-px bg-[var(--hairline)] max-[1020px]:left-[22px] max-[1020px]:right-[22px] max-[720px]:left-4 max-[720px]:right-4"
      />

      <div className="min-w-[190px] max-w-[240px] max-[720px]:min-w-0 max-[720px]:max-w-none max-[720px]:flex-1 max-[720px]:basis-full">
        <div className="text-[15px] font-semibold">
          {roleName ? t("statusbar.role", { name: roleName }) : t("statusbar.noRole")}
        </div>
        <div
          className="text-[11.5px] text-[var(--meta)] mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap"
          title={loading ? t("statusbar.loading") : statusSub ? `${statusTitle} · ${statusSub}` : statusTitle}
        >
          {loading ? t("statusbar.loading") : statusSub ? `${statusTitle} · ${statusSub}` : statusTitle}
        </div>
      </div>

      <div className="ml-auto flex items-center gap-[18px]">
        {progress != null ? (
          <div
            className="h-1 w-[132px] overflow-hidden rounded-sm bg-[color-mix(in_srgb,var(--ink)_10%,transparent)]"
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
            "border-0 rounded-[var(--rs)] px-7 py-3 cursor-pointer whitespace-nowrap",
            "text-sm font-semibold bg-[var(--accent)] text-[var(--accent-ink)]",
            "transition-[transform,filter] duration-200 ease-[var(--spring)]",
            "hover:brightness-95",
            "active:scale-[0.965]",
            "focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2",
          ].join(" ")}
        >
          {t("statusbar.openSynth")}
        </button>
      </div>
    </footer>
  );
}

export const StatusBar = memo(StatusBarImpl);
