import { memo } from "react";
import { t } from "../i18n/t";

/**
 * 底部悬浮状态条。
 *
 * GPT-SoVITS Fabric 没有常驻变声流，RVC 那种贴底的 Dock 没有对应物 ——
 * 但「当前角色 / 运行环境是否就绪 / 去合成」这句提示仍然值得常驻。
 * 所以它是一条浮在页面之上的小提示条：圆角卡片、不贴窗口边缘、不占
 * 布局、不满宽，像 Nudge 一样可随时被更新提示盖住。
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
    // 外壳占住布局位置但自身透明；内容条宽度由内容决定、四周留白 ——
    // 视觉上是浮起来的一条，不是贴死在窗口底边的横幅。
    <div className="shrink-0 px-[30px] pb-3 pt-1 flex max-[1020px]:px-[22px] max-[720px]:px-4">
      <footer className="flex items-center gap-3 rounded-[var(--r)] bg-[var(--surface)] px-4 py-2.5 shadow-[0_8px_24px_-10px_rgba(20,26,33,.35),inset_0_0_0_1px_var(--hairline)] max-w-full">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium leading-tight truncate">
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
          <div className="w-[120px] h-[5px] rounded-full bg-[color-mix(in_srgb,var(--ink)_8%,transparent)] overflow-hidden flex-none">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-200 ease-[var(--ease)]"
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>
        ) : null}
        <button
          type="button"
          onClick={onOpenSynth}
          className="flex-none text-[12.5px] font-semibold px-[14px] py-1.5 rounded-[var(--rs)] border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-ink)] hover:brightness-95 active:scale-[0.955] transition-all duration-200 ease-[var(--ease)]"
        >
          {t("statusbar.openSynth")}
        </button>
      </footer>
    </div>
  );
}

export const StatusBar = memo(StatusBarImpl);
