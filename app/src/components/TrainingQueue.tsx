import { useState } from "react";
import { Pager, QueueList, Tag, usePaged } from "../trm";
import { Btn } from "./ui";
import { ErrorNote } from "./ErrorNote";
import { t } from "../i18n/t";
import { terminalJob, trainPercent, type TrainJob, type TrainJobState } from "../lib/trainQueue";

const STATE_KEYS: Record<TrainJobState, string> = {
  queued: "train.queueQueued", running: "train.queueRunning", cancelling: "train.queueCancelling",
  paused: "train.queuePaused", interrupted: "train.queueInterrupted", completed: "train.queueCompleted",
  failed: "train.queueFailed", cancelled: "train.queueCancelled",
};
const STAGE_KEYS = { prepare: "train.stagePrepare", format: "train.stageFormat", sovits: "train.stageSovits", gpt: "train.stageGpt" };
export function TrainingQueue({ jobs, loaded = true, error, onAction }: {
  jobs: TrainJob[]; loaded?: boolean; error: string; onAction: (id: string, action: string) => Promise<void>;
}) {
  const paged = usePaged(jobs, 5);
  const [pending, setPending] = useState<string[]>([]);
  const action = async (id: string, kind: string) => {
    setPending(p => [...p, id]);
    try { await onAction(id, kind); } finally { setPending(p => p.filter(x => x !== id)); }
  };
  return <div className="mt-4 flex flex-col min-h-0 gap-2.5">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-[15.5px] font-semibold m-0">{t("train.queueTitle")}</h3>
      {jobs.some(terminalJob) ? <Btn disabled={pending.includes("")} onClick={() => void action("", "clear")}>{t("train.queueClear")}</Btn> : null}
    </div>
    {error ? <ErrorNote text={error} /> : null}
    <div className="rounded-[var(--r)] bg-[var(--group)] p-3.5 min-h-0 overflow-y-auto">
      <QueueList scope="training" page={paged.page} items={paged.slice} keyOf={job => job.id}
        className="flex flex-col gap-4"
        empty={<div className="text-[12.5px] text-[var(--help)]">{loaded ? t("train.queueEmpty") : error ? "" : t("s.valueLoading")}</div>}
        render={job => {
            const running = job.state === "running" || job.state === "cancelling";
            const stage = job.progress?.stage;
            const disabled = pending.includes(job.id);
            return <div key={job.id} className="flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2 text-[13px]">
                <span className="font-medium break-all">{job.req.exp}</span>
                <Tag tone={job.state === "failed" ? "warn" : running || job.state === "completed" ? "accent" : "muted"}>{t(STATE_KEYS[job.state])}</Tag>
              </div>
              <div className="text-[12px] text-[var(--meta)]">{job.req.version}</div>
              <div className="text-[12px] text-[var(--help)]">{t("train.hyperSummary", { v0: String(job.req.sovits_epoch), v1: String(job.req.gpt_epoch) })}</div>
              {running ? <>
                <div className="flex justify-between gap-2 text-[12px] text-[var(--help)]">
                  <span>{stage && stage in STAGE_KEYS ? t(STAGE_KEYS[stage]) : t("train.queueRunning")}</span>
                  <span className="tabular-nums">{job.progress?.total ? `${job.progress.done ?? 0} / ${job.progress.total}` : ""}</span>
                </div>
                <div className="h-[5px] rounded-full bg-[var(--line)] overflow-hidden">
                  <div className="h-full bg-[var(--accent)] transition-[width] duration-150" style={{ width: `${trainPercent(job)}%` }} />
                </div>
              </> : null}
              {job.state === "failed" && job.error ? <ErrorNote text={job.error} code={job.progress?.message_code} /> : null}
              <div className="flex items-center gap-2 flex-wrap">
                {running ? <Btn disabled={disabled || job.state === "cancelling"} onClick={() => void action(job.id, "cancel")}>{t("train.cancel")}</Btn> : <>
                  {terminalJob(job) || job.state === "paused" ? <Btn disabled={disabled} onClick={() => void action(job.id, "retry")}>{t(job.state === "paused" ? "train.queueContinue" : "train.queueRetry")}</Btn> : null}
                  <Btn disabled={disabled} onClick={() => void action(job.id, "remove")}>{t("train.queueRemove")}</Btn>
                </>}
              </div>
            </div>;
        }}
      />
      <Pager page={paged.page} pages={paged.pages} onChange={paged.setPage} />
    </div>
  </div>;
}
