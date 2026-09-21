import { memo } from "react";
import { t } from "../i18n/t";

/**
 * 底部状态条（替代 RVC-Fabric 的实时变声 Dock）。
 *
 * GPT-SoVITS Fabric 没有常驻变声流，底栏只承担三件事：当前角色、引擎状态、
 * 去合成台的主行动按钮。
 *
 * `statusTitle` / `statusSub` 现在由运行时是否就绪驱动（见 App.tsx）。
 *
 * `roleName` 由 App 读配置里的 `synth_role` 再换成名字传进来；合成台换角色
 * 时会广播配置补丁，这里跟着变。角色被删掉之后传空串 —— id 还留在配置里，
 * 但人已经不在了，继续显示它的名字是在骗人。 */

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
    <footer className="shrink-0 relative px-[30px] py-3 flex items-center gap-4 flex-wrap max-[1020px]:px-[22px] max-[720px]:px-4">
      {/* 发丝线两端收进页边距，不做满宽 border-top —— 满宽实底条会把这一行
          读成「遮住半个窗口的一条横幅」，而不是页面底部的一个状态区。 */}
      <span
        aria-hidden
        className="absolute top-0 left-[30px] right-[30px] h-px bg-[var(--hairline)] max-[1020px]:left-[22px] max-[1020px]:right-[22px] max-[720px]:left-4 max-[720px]:right-4"
      />
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium leading-tight truncate">
          {roleName ? t("statusbar.role", { name: roleName }) : t("statusbar.noRole")}
        </div>
        <div className="text-[11.5px] text-[var(--meta)] leading-tight truncate mt-0.5">
          {loading ? t("statusbar.loading") : statusSub ? `${statusTitle} · ${statusSub}` : statusTitle}
        </div>
      </div>
      {progress != null ? (
        <div className="w-[120px] h-[5px] rounded-full bg-[color-mix(in_srgb,var(--ink)_8%,transparent)] overflow-hidden">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-200 ease-[var(--ease)]"
            style={{ width: `${Math.min(100, progress)}%` }}
          />
        </div>
      ) : null}
      <div className="ml-auto">
        <button
          type="button"
          onClick={onOpenSynth}
          className="text-[12.5px] font-semibold px-[14px] py-1.5 rounded-[var(--rs)] border-0 cursor-pointer bg-[var(--accent)] text-[var(--accent-ink)] hover:brightness-95 active:scale-[0.955] transition-all duration-200 ease-[var(--ease)]"
        >
          {t("statusbar.openSynth")}
        </button>
      </div>
    </footer>
  );
}

export const StatusBar = memo(StatusBarImpl);
