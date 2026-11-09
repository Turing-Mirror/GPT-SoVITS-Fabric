import { t } from "../i18n/t";
import { cancelVulkanDownload, startVulkanDownload, type ExtraJobsSnap } from "../lib/extraJobs";
import { joinClauses } from "../lib/text";
import { ErrorNote } from "./ErrorNote";
import { Btn } from "./ui";

export function VulkanResourceAction({ jobs, disabled = false }: { jobs: ExtraJobsSnap; disabled?: boolean }) {
  const { vulkanBusy, vulkanCancelling, vulkanProgress, vulkanError } = jobs;
  const percent = vulkanProgress?.percent ?? (vulkanProgress?.total
    ? (vulkanProgress.done ?? 0) / vulkanProgress.total * 100
    : 0);
  const pct = Math.round(Math.min(100, Math.max(0, percent)));

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        {vulkanBusy ? (
          <>
            <span role="status" className="text-[12px] text-[var(--help)] tabular-nums">
              {joinClauses([
                vulkanProgress?.message || t("s.65188d08a2"),
                vulkanProgress?.speed_label && t("s.metaSpeed", { v0: vulkanProgress.speed_label }),
                pct > 0 && t("s.metaProgress", { v0: String(pct) }),
              ])}
            </span>
            <Btn disabled={vulkanCancelling} onClick={cancelVulkanDownload}>
              {t("synth.cancel")}
            </Btn>
          </>
        ) : (
          <Btn
            disabled={disabled || jobs.coreBusy || Object.keys(jobs.busyKeys).length > 0}
            onClick={startVulkanDownload}
          >
            {t("synth.vulkanDownload")}
          </Btn>
        )}
      </div>
      {vulkanError ? <ErrorNote text={vulkanError} compact /> : null}
    </div>
  );
}
