import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Snapshot as Cache } from "./snapshot";
import { listen } from "@tauri-apps/api/event";

export type TrainJobState = "queued" | "running" | "cancelling" | "paused" | "interrupted" | "completed" | "failed" | "cancelled";
export type TrainStage = "prepare" | "format" | "sovits" | "gpt";
export const TRAIN_STAGES: TrainStage[] = ["prepare", "format", "sovits", "gpt"];
export type TrainJob = {
  id: string;
  state: TrainJobState;
  req: { exp: string; version: string; dataset: string; sovits_epoch: number; gpt_epoch: number };
  progress: { stage?: TrainStage; done?: number; total?: number; message_code?: string } | null;
  error: string;
};
type Snapshot = { jobs: TrainJob[] };
const queueSnapshot = new Cache<TrainJob[]>();
export const activeJob = (jobs: TrainJob[]) => jobs.find(j => j.state === "running" || j.state === "cancelling");
export const terminalJob = (job: TrainJob) => ["completed", "failed", "cancelled", "interrupted"].includes(job.state);
export function latestExperimentJob(jobs: TrainJob[], experiment: string): TrainJob | undefined {
  const name = experiment.trim();
  if (!name) return undefined;
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    if (jobs[index].req.exp === name) return jobs[index];
  }
  return undefined;
}
export function trainPercent(job?: TrainJob): number {
  if (job?.state === "completed") return 100;
  const p = job?.progress;
  const stage = p?.stage ? TRAIN_STAGES.indexOf(p.stage) : -1;
  if (stage < 0) return 0;
  const within = p?.total && typeof p.done === "number" ? Math.max(0, Math.min(1, p.done / p.total)) : 0;
  return Math.round(((stage + within) / TRAIN_STAGES.length) * 100);
}
export function useTrainingQueue() {
  const [jobs, setJobs] = useState<TrainJob[]>(() => queueSnapshot.get() ?? []);
  const [loaded, setLoaded] = useState(() => queueSnapshot.get() !== null);
  const [error, setError] = useState("");
  const updates = useRef(0);
  const refresh = useCallback(async () => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const revision = updates.current;
    try {
      const jobs = await queueSnapshot.read(async () => (await invoke<Snapshot>("train_queue_list")).jobs);
      if (revision === updates.current) { setJobs(jobs); setLoaded(true); }
      setError("");
    } catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    const un = listen<Snapshot>("train-queue", event => { if (!disposed) { updates.current += 1; queueSnapshot.receive(event.payload.jobs); setJobs(event.payload.jobs); setLoaded(true); } });
    // Subscribe before reading the snapshot to cover mounting during a transition.
    void un.then(() => { if (!disposed) void refresh(); });
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { disposed = true; window.clearInterval(timer); void un.then(f => f()); };
  }, [refresh]);
  const action = useCallback(async (id: string, action: string) => {
    try {
      await invoke("train_queue_action", { id, action });
      await refresh();
    } catch (e) { setError(String(e)); }
  }, [refresh]);
  return { jobs, loaded, error, refresh, action };
}
