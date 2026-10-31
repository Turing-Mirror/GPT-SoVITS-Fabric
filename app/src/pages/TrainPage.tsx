import { useCallback, useEffect, useRef, useState } from "react";
import { PagePad, PageHead, Btn } from "../components/ui";
import { Swap } from "../components/Motion";
import { Icon } from "../trm";
import { Field, Select, Slider, Toggle } from "../components/controls";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openTool } from "../components/ToolWindow";
import { ErrorNote } from "../components/ErrorNote";
import { t } from "../i18n/t";
import { goTo, onHandoff, take } from "../lib/intent";

/**
 * 训练台 —— 数据集准备与微调的统一入口。
 *
 * 流水线四阶段：数据集工具链（分离 / 切片 / 打标 / 校对）→ 训练集格式化 →
 * SoVITS 微调 → GPT 微调。前三步的开关在 `train_worker.py` 里，这一页只负责
 * 把参数交出去、把 worker 报回来的进度画出来。
 *
 * **这一页曾经是纯形状**：按钮禁用、四个阶段常年 idle、进度恒为 0。更早一版
 * 更糟 —— 「开始训练」走的是一个定时器，进度条爬到 100%、四个阶段依次打勾、
 * 日志打出「训练完成」，一个字节都没算过。现在接的是真的：`train_start`
 * 起 worker，`train-progress` 事件逐行回传，阶段与轮数都来自它。
 *
 * 版本列表、每个版本缺哪些底模、默认参数，都取自 `train_status()`：Rust 读
 * 随包的上游版本表（`configs/upstream_versions.json`）与默认值
 * （`configs/train_defaults.json`）。这一页不写死任何版本或数值。
 * SoVITS 与 GPT 两段的轮数、批大小、保存间隔分开设，换版本时回到该版本的默认值。
 */

type Stage = "prepare" | "format" | "sovits" | "gpt";
const STAGES: Stage[] = ["prepare", "format", "sovits", "gpt"];
const STAGE_KEYS: Record<Stage, string> = {
  prepare: "train.stagePrepare",
  format: "train.stageFormat",
  sovits: "train.stageSovits",
  gpt: "train.stageGpt",
};

type PartDefaults = {
  epochs: number;
  min_epochs?: number;
  max_epochs: number;
  save_every: number;
  batch: number;
  max_batch: number;
};

type VersionInfo = {
  id: string;
  lora?: boolean;
  base_missing?: string[];
  defaults?: {
    sovits?: PartDefaults & { learning_rate?: number; lora_rank?: number; lora_ranks?: number[] };
    gpt?: PartDefaults;
  };
};

type Part = { epochs: number; batch: number; saveEvery: number };

const FALLBACK_PART: Part = { epochs: 8, batch: 4, saveEvery: 4 };

function partOf(d?: PartDefaults): Part {
  return d ? { epochs: d.epochs, batch: d.batch, saveEvery: d.save_every } : FALLBACK_PART;
}

type Status = {
  runtime_ready?: boolean;
  worker_present?: boolean;
  engine_core_ready?: boolean;
  engine_core_missing?: string[];
  nvidia?: boolean;
  versions?: VersionInfo[];
  default_version?: string;
  experiments?: { name?: string }[];
  disk_free_bytes?: number | null;
  busy?: boolean;
  interrupted?: { exp?: string; epoch?: number; total?: number } | null;
};

type Scan = { files?: number; other_files?: number; total_bytes?: number };
type Inspect = {
  available?: boolean;
  files?: number;
  sampled?: number;
  median_seconds?: number;
  estimated_total_seconds?: number;
  mean_volume_db?: number;
};

/** worker 的一行。`text` 是 Rust 侧翻好的，界面不再拼文案。 */
type Line = {
  phase?: string;
  stage?: Stage;
  done?: number;
  total?: number;
  text?: string;
  message?: string;
  message_code?: string;
};

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function hhmm(sec?: number): string {
  if (!sec || !isFinite(sec)) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function gb(bytes?: number | null): string {
  if (!bytes) return "—";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function TrainPage() {
  const [st, setSt] = useState<Status>({});
  const [version, setVersion] = useState("");
  const [exp, setExp] = useState("");
  const [dataset, setDataset] = useState("");
  const [outDir, setOutDir] = useState("");
  const [scan, setScan] = useState<Scan | null>(null);
  const [inspect, setInspect] = useState<Inspect | null>(null);

  const [sovits, setSovits] = useState<Part>(FALLBACK_PART);
  const [gpt, setGpt] = useState<Part>(FALLBACK_PART);
  const [lr, setLr] = useState(0.0001);
  const [loraRank, setLoraRank] = useState(32);
  const [resume, setResume] = useState(true);

  const [stage, setStage] = useState<Stage | null>(null);
  const [doneStages, setDoneStages] = useState<Stage[]>([]);
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [errCode, setErrCode] = useState("");
  const [starting, setStarting] = useState(false);
  /** 中栏显示第几步（0–3）。 */
  const [step, setStep] = useState(0);

  const logRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const s = await invoke<Status>("train_status");
      setSt(s ?? {});
      setVersion((v) => v || s?.default_version || s?.versions?.[0]?.id || "");
    } catch {
      /* 状态问不到就维持上一次的，别把界面清空 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void invoke<string>("train_output_dir").then(setOutDir).catch(() => {});
  }, [refresh]);

  const info = (st.versions ?? []).find((v) => v.id === version);
  const sd = info?.defaults?.sovits;
  const gd = info?.defaults?.gpt;

  const applyDefaults = useCallback(() => {
    setSovits(partOf(sd));
    setGpt(partOf(gd));
    setLr(sd?.learning_rate ?? 0.0001);
    setLoraRank(sd?.lora_rank ?? 32);
  }, [sd, gd]);

  // 换版本（含首次拿到状态）时回到该版本的默认值；全参与 LoRA 的合理轮数差一个量级。
  const appliedFor = useRef("");
  useEffect(() => {
    if (!info || appliedFor.current === info.id) return;
    appliedFor.current = info.id;
    applyDefaults();
  }, [info, applyDefaults]);

  // 不跑的时候慢轮询（底模刚下完、运行时刚补齐，这一页得自己看见）；
  // 跑起来之后状态由事件推，轮询只用来确认 busy 何时落回 false。
  useEffect(() => {
    const id = window.setInterval(() => void refresh(), st.busy ? 4000 : 8000);
    return () => window.clearInterval(id);
  }, [refresh, st.busy]);

  useEffect(() => {
    if (!isTauri()) return;
    const un = listen<Line>("train-progress", (ev) => {
      const v = ev.payload || {};
      const text = v.text || v.message || "";
      if (text) {
        setLog((l) => [...l.slice(-199), text]);
      }
      if (v.stage && STAGES.includes(v.stage)) {
        setStage(v.stage);
        setDoneStages((d) => {
          const i = STAGES.indexOf(v.stage!);
          const before = STAGES.slice(0, i);
          return Array.from(new Set([...d, ...before]));
        });
      }
      if (typeof v.done === "number" && typeof v.total === "number" && v.total > 0) {
        // 每阶段自己 0→100，四阶段各占四分之一。
        const i = v.stage ? STAGES.indexOf(v.stage) : 0;
        const within = Math.min(1, v.done / v.total);
        setProgress(Math.round(((Math.max(0, i) + within) / STAGES.length) * 100));
      }
      if (v.phase === "error") {
        setErr(text);
        setErrCode(v.message_code || "");
        setStage(null);
      }
      if (v.phase === "done") {
        setDoneStages([...STAGES]);
        setStage(null);
        setProgress(100);
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const applyDataset = useCallback(async (p: string) => {
    setDataset(p);
    // 角色包的数据集在 <角色>/dataset 下：实验名取角色目录名，不取「dataset」。
    const parts = p.split(/[\\/]/).filter(Boolean);
    const last = parts.pop() || "";
    setExp((e) => e || (last.toLowerCase() === "dataset" ? parts.pop() || last : last));
    setScan(await invoke<Scan>("train_scan_dataset", { path: p }).catch(() => null));
    setInspect(await invoke<Inspect>("train_inspect_dataset", { path: p }).catch(() => null));
  }, []);

  const pickDataset = useCallback(async () => {
    const p = await invoke<string | null>("train_pick_dataset").catch(() => null);
    if (p) await applyDataset(p);
  }, [applyDataset]);

  // 标注页点了「用于训练」：把那份标注所在的目录设为数据集。
  useEffect(() => {
    const apply = () => {
      const p = take("trainDataset");
      if (p) void applyDataset(p);
    };
    apply();
    return onHandoff(apply);
  }, [applyDataset]);

  const pickOutput = useCallback(async () => {
    const p = await invoke<string | null>("train_pick_output_dir").catch(() => null);
    if (p) setOutDir(p);
  }, []);

  const versionMissing = info?.base_missing ?? [];

  // 拦住的几种情况分开报，别糊成一句「不能训练」—— 用户得知道去补哪一样。
  const blocked =
    !st.runtime_ready
      ? t("train.blockRuntime")
      : !st.worker_present
        ? t("train.blockWorker")
        : !st.engine_core_ready
          ? t("train.blockCore", { v0: String((st.engine_core_missing ?? []).length) })
          : versionMissing.length
            ? t("s.trainBaseMissing", { a0: version })
            : !st.nvidia
            ? t("train.blockNvidia")
            : !dataset
              ? t("train.blockDataset")
              : !exp.trim()
                ? t("train.blockExp")
                : "";

  const start = useCallback(async () => {
    setErr("");
    setLog([]);
    setDoneStages([]);
    setProgress(0);
    setStarting(true);
    try {
      await invoke("train_start", {
        req: {
          exp: exp.trim(),
          dataset,
          version,
          sovits_epoch: sovits.epochs,
          sovits_batch: sovits.batch,
          sovits_save_every: sovits.saveEvery,
          gpt_epoch: gpt.epochs,
          gpt_batch: gpt.batch,
          gpt_save_every: gpt.saveEvery,
          learning_rate: lr,
          lora_rank: loraRank,
          resume,
          output_dir: outDir,
        },
      });
    } catch (e) {
      setErr(String(e));
    } finally {
      setStarting(false);
      void refresh();
    }
  }, [exp, dataset, version, sovits, gpt, lr, loraRank, resume, outDir, refresh]);

  const versions = st.versions ?? [];
  const missing = [...(st.engine_core_missing ?? []), ...versionMissing];
  const baseReady = !!st.engine_core_ready && versionMissing.length === 0;
  const finished = !st.busy && doneStages.length === STAGES.length;

  // 跑着的时候停在「开始训练」一步，进度和停止按钮都在那里。
  useEffect(() => {
    if (st.busy) setStep(3);
  }, [st.busy]);

  const steps: { title: string; sub: string; ok: boolean }[] = [
    { title: t("train.stepVersion"), sub: version || "—", ok: baseReady },
    { title: t("train.datasetTitle"), sub: exp.trim() || t("train.unset"), ok: !!dataset && !!exp.trim() },
    {
      title: t("train.hyperTitle"),
      sub: t("train.hyperSummary", { v0: String(sovits.epochs), v1: String(gpt.epochs) }),
      ok: !!dataset && !!exp.trim(),
    },
    {
      title: t("train.start"),
      sub: st.busy ? `${progress}%` : finished ? t("train.finished") : blocked ? t("train.notReady") : t("train.statusReady"),
      ok: finished,
    },
  ];

  const statusRows: { label: string; value: string; ok: boolean }[] = [
    { label: t("train.rowRuntime"), value: st.runtime_ready && st.worker_present ? t("train.ok") : t("train.notReady"), ok: !!st.runtime_ready && !!st.worker_present },
    { label: t("train.rowBase"), value: baseReady ? t("train.ok") : t("train.missingN", { v0: String(missing.length) }), ok: baseReady },
    { label: t("train.rowGpu"), value: st.nvidia ? "NVIDIA" : t("train.gpuNone"), ok: !!st.nvidia },
    { label: t("train.datasetTitle"), value: scan ? t("train.itemsN", { v0: String(scan.files ?? 0) }) : t("train.unset"), ok: !!scan?.files },
  ];

  const stepBody = [
    // 1. 版本与底模
    <div key="v" className="rounded-[var(--r)] bg-[var(--group)] p-4 flex flex-col gap-[16px]">
      <Field
        label={t("train.version")}
        tip={t("train.versionTip")}
        control={
          <Select
            full
            value={version}
            options={versions.map((v) => ({ id: v.id, label: v.lora ? `${v.id} · LoRA` : v.id }))}
            onChange={setVersion}
          />
        }
      />
      {/* 判据是「这台机器上真的有这份权重」：引擎资源加上所选版本自己的底模。 */}
      <div className="text-[12.5px]">
        {baseReady ? (
          <span className="text-[var(--accent)]">{t("train.baseReady")}</span>
        ) : (
          <span className="text-[var(--notify)]">{t("train.baseMissing", { v0: String(missing.length) })}</span>
        )}
      </div>
      {missing.length ? (
        <pre className="rounded-[var(--rs)] bg-[var(--page-bg)] p-2.5 text-[11.5px] leading-relaxed text-[var(--ink-muted)] overflow-auto max-h-[240px] m-0">
          {missing.join("\n")}
        </pre>
      ) : null}
      <div className="text-[12.5px] text-[var(--help)]">{t("train.baseHint")}</div>
    </div>,

    // 2. 训练集
    <div key="d" className="flex flex-col gap-[10px]">
      <div className="rounded-[var(--r)] border border-dashed border-[var(--line)] p-5 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium">{t("train.listFile")}</div>
          <div className="text-[12px] text-[var(--help)] mt-1 break-all">{dataset || t("train.listDesc")}</div>
        </div>
        <Btn onClick={() => void pickDataset()}>{t("train.importList")}</Btn>
      </div>

      {/* 流水线第一步的入口。素材里带伴奏就直接拿去训，出来的音色会把
          背景音一起学进去 —— 分离这一整套（separate.rs + worker + pymss）
          早就在仓库里，之前只是没有任何地方能打开它。 */}
      <div className="flex items-center justify-between gap-3 flex-wrap py-1">
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium">{t("train.sepEntry")}</div>
          <div className="text-[12px] text-[var(--help)] mt-1 leading-relaxed">{t("train.sepEntryDesc")}</div>
        </div>
        <Btn onClick={() => openTool("separate")}>{t("train.sepOpen")}</Btn>
      </div>

      <div className="rounded-[var(--r)] bg-[var(--group)] p-4 flex flex-col gap-[16px]">
        <Field
          label={t("train.expName")}
          tip={t("train.expNameTip")}
          control={
            <input
              value={exp}
              onChange={(e) => setExp(e.target.value)}
              placeholder={t("train.expNamePh")}
              className="inline-flex w-full min-w-[230px] px-[13px] py-[7px] rounded-[var(--rs)] text-[13px] text-[var(--ink)] bg-transparent shadow-[inset_0_0_0_1px_var(--line)] outline-none focus:shadow-[inset_0_0_0_1px_var(--accent)]"
            />
          }
        />
        <Field
          label={t("train.outputDir")}
          tip={t("train.outputDirTip")}
          control={
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[12.5px] text-[var(--help)] break-all">{outDir || t("train.outputDefault")}</span>
              <Btn onClick={() => void pickOutput()}>{t("train.pickOutput")}</Btn>
            </div>
          }
        />
      </div>

      {/* 数字全部来自 train_scan_dataset / train_inspect_dataset。
          没有 ffprobe 时 available=false，那几项就写「—」，不编。 */}
      <div className="rounded-[var(--r)] bg-[var(--group)] p-4 grid grid-cols-2 max-[560px]:grid-cols-1 gap-x-6 gap-y-3">
        {[
          { label: t("train.statTotal"), value: scan ? String(scan.files ?? 0) : "—" },
          { label: t("train.statHours"), value: inspect?.available ? `≈ ${hhmm(inspect.estimated_total_seconds)}` : "—" },
          { label: t("train.statMedian"), value: inspect?.median_seconds ? `${inspect.median_seconds.toFixed(1)} s` : "—" },
          { label: t("train.statLoud"), value: typeof inspect?.mean_volume_db === "number" ? `${inspect.mean_volume_db} dB` : "—" },
        ].map((s) => (
          <div key={s.label} className="flex items-center justify-between">
            <span className="text-[12.5px] text-[var(--help)]">{s.label}</span>
            <span className="text-[13.5px] tabular-nums font-medium">{s.value}</span>
          </div>
        ))}
      </div>
    </div>,

    // 3. 训练参数
    <div key="h" className="flex flex-col gap-[10px]">
      <div className="text-[12.5px] text-[var(--meta)] px-1">{t("train.sovitsTitle")}</div>
      <div className="rounded-[var(--r)] bg-[var(--group)] p-4 flex flex-col gap-[16px]">
        <PartFields part={sovits} defaults={sd} minEpochs={1} onChange={setSovits} />
        <Field
          label={t("train.lr")}
          control={
            <Slider
              value={Math.round(lr * 100000) / 100000}
              min={0.00001}
              max={0.001}
              step={0.00001}
              defaultValue={sd?.learning_rate ?? 0.0001}
              onChange={(v) => setLr(v)}
              format={(v) => v.toExponential(1)}
            />
          }
        />
        {info?.lora ? (
          <Field
            label={t("train.loraRank")}
            tip={t("train.loraRankTip")}
            control={
              <Select
                value={String(loraRank)}
                options={(sd?.lora_ranks ?? [16, 32, 64, 128]).map((r) => ({ id: String(r), label: String(r) }))}
                onChange={(v) => setLoraRank(Number(v))}
              />
            }
          />
        ) : null}
      </div>

      <div className="text-[12.5px] text-[var(--meta)] px-1 mt-2">{t("train.gptTitle")}</div>
      <div className="rounded-[var(--r)] bg-[var(--group)] p-4 flex flex-col gap-[16px]">
        <PartFields part={gpt} defaults={gd} minEpochs={gd?.min_epochs ?? 1} onChange={setGpt} />
      </div>

      <div className="rounded-[var(--r)] bg-[var(--group)] p-4 mt-2">
        {/* Toggle 自带 label/tip，不套 Field —— 套了会出现两个标题。 */}
        <Toggle checked={resume} onChange={setResume} label={t("train.resume")} tip={t("train.resumeTip")} />
      </div>
    </div>,

    // 4. 开始训练
    <div key="s" className="rounded-[var(--r)] bg-[var(--group)] p-4">
      <div className="grid grid-cols-2 min-[1180px]:grid-cols-4 gap-[8px]">
        {STAGES.map((s) => {
          const running = stage === s;
          const done = doneStages.includes(s);
          return (
            <div
              key={s}
              className={[
                "rounded-[var(--rs)] px-3 py-2.5 text-center text-[12.5px] transition-colors duration-200 inline-flex items-center justify-center gap-1.5",
                running
                  ? "bg-[var(--accent)] text-[var(--accent-ink)] font-semibold"
                  : done
                    ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "bg-[color-mix(in_srgb,var(--ink)_6%,transparent)] text-[var(--ink-muted)]",
              ].join(" ")}
            >
              {done && !running ? <Icon name="check" size={12} /> : null}
              {t(STAGE_KEYS[s])}
            </div>
          );
        })}
      </div>
      <div className="h-[6px] rounded-full bg-[color-mix(in_srgb,var(--ink)_8%,transparent)] overflow-hidden mt-3">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-150 ease-[var(--ease)]"
          style={{ width: `${Math.min(100, progress)}%` }}
        />
      </div>
      <div className="flex items-center gap-3 mt-3 flex-wrap">
        {st.busy ? (
          <Btn onClick={() => void invoke("train_cancel").catch(() => {})}>{t("train.cancel")}</Btn>
        ) : (
          <Btn primary busy={starting} disabled={!!blocked} onClick={() => void start()}>
            {t("train.start")}
          </Btn>
        )}
        <span className="text-[12px] text-[var(--meta)]">
          {blocked || t("train.diskFree", { v0: gb(st.disk_free_bytes) })}
        </span>
        {finished ? <Btn onClick={() => goTo("models")}>{t("train.viewRole")}</Btn> : null}
      </div>
      {err ? (
        <div className="mt-3">
          <ErrorNote text={err} code={errCode} />
        </div>
      ) : null}
    </div>,
  ];

  return (
    <PagePad fill>
      <PageHead
        title={t("train.title")}
        sub={t("train.subtitle")}
        actions={
          !isTauri() ? (
            <span className="text-[12px] px-2 py-1 rounded-[var(--rs)] bg-[var(--accent-soft)] text-[var(--accent)]">
              {t("synth.demoBadge")}
            </span>
          ) : null
        }
      />

      {st.interrupted ? (
        <div className="flex-none mt-[18px] rounded-[var(--r)] bg-[var(--accent-soft)] text-[var(--accent)] px-4 py-3 text-[12.5px]">
          {t("train.interrupted", {
            v0: String(st.interrupted.exp ?? ""),
            v1: String(st.interrupted.epoch ?? 0),
            v2: String(st.interrupted.total ?? 0),
          })}
        </div>
      ) : null}

      <div className="mt-[22px] flex-1 min-h-0 grid gap-[18px] grid-cols-1 min-[900px]:grid-cols-[minmax(190px,220px)_minmax(0,1fr)_minmax(260px,320px)] min-[900px]:pb-[22px]">
        {/* 左栏：步骤 */}
        <nav className="min-h-0 flex flex-col gap-1.5 max-[899px]:grid max-[899px]:grid-cols-2">
          {steps.map((s, i) => {
            const on = step === i;
            return (
              <button
                key={i}
                type="button"
                onClick={() => setStep(i)}
                className={[
                  "w-full text-left border-0 rounded-[var(--r)] px-3 py-2.5 flex items-center gap-2.5 cursor-pointer transition-colors duration-150",
                  on ? "bg-[var(--accent-soft)]" : "bg-transparent hover:bg-[color-mix(in_srgb,var(--ink)_4%,transparent)]",
                ].join(" ")}
              >
                <span
                  className={[
                    "shrink-0 w-[22px] h-[22px] rounded-full grid place-items-center text-[11.5px] font-semibold tabular-nums",
                    s.ok
                      ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                      : on
                        ? "bg-[var(--stage)] text-[var(--accent)]"
                        : "bg-[color-mix(in_srgb,var(--ink)_8%,transparent)] text-[var(--ink-muted)]",
                  ].join(" ")}
                >
                  {s.ok ? <Icon name="check" size={12} /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={["block text-[13px] truncate", on ? "font-semibold text-[var(--accent)]" : ""].join(" ")}>{s.title}</span>
                  <span className="block text-[11.5px] text-[var(--meta)] truncate mt-0.5 tabular-nums">{s.sub}</span>
                </span>
              </button>
            );
          })}
        </nav>

        {/* 中栏：当前步骤 */}
        <div className="min-h-0 flex flex-col min-[900px]:overflow-y-auto min-[900px]:overscroll-contain min-[900px]:pr-1">
          <div className="flex-none flex items-center gap-2 mb-2.5 min-h-[30px]">
            <h3 className="text-[15.5px] font-semibold m-0">{steps[step].title}</h3>
            {step === 0 ? <span className="text-[12px] text-[var(--meta)]">{t("train.modelNote")}</span> : null}
            {step === 1 ? <span className="text-[12px] text-[var(--meta)]">{t("train.datasetNote")}</span> : null}
            {step === 2 ? (
              <span className="ml-auto">
                <Btn onClick={applyDefaults}>{t("train.resetDefaults")}</Btn>
              </span>
            ) : null}
          </div>
          <Swap k={String(step)}>{stepBody[step]}</Swap>
          <div className="flex-none flex items-center gap-2 mt-4">
            {step > 0 ? <Btn onClick={() => setStep(step - 1)}>{t("train.prev")}</Btn> : null}
            {step < steps.length - 1 ? (
              <span className="ml-auto">
                <Btn primary={steps[step].ok} onClick={() => setStep(step + 1)}>{t("train.next")}</Btn>
              </span>
            ) : null}
          </div>
        </div>

        {/* 右栏：状态与日志 */}
        <div className="min-h-[360px] min-[900px]:min-h-0 flex flex-col">
          <div className="flex-none flex items-center gap-2 mb-2.5 min-h-[30px]">
            <h3 className="text-[15.5px] font-semibold m-0">{t("train.statusTitle")}</h3>
          </div>
          <div className="flex-none rounded-[var(--r)] bg-[var(--group)] p-3.5 flex flex-col gap-2.5">
            {statusRows.map((r) => (
              <div key={r.label} className="flex items-center gap-2 text-[12.5px]">
                <span className={["w-[7px] h-[7px] rounded-full shrink-0", r.ok ? "bg-[var(--accent)]" : "bg-[var(--notify)]"].join(" ")} />
                <span className="text-[var(--help)]">{r.label}</span>
                <span className="ml-auto tabular-nums truncate">{r.value}</span>
              </div>
            ))}
            {st.busy ? (
              <div className="pt-1">
                <div className="flex items-center justify-between text-[12px] mb-1.5">
                  <span className="text-[var(--accent)]">{stage ? t(STAGE_KEYS[stage]) : t("train.start")}</span>
                  <span className="tabular-nums">{progress}%</span>
                </div>
                <div className="h-[5px] rounded-full bg-[color-mix(in_srgb,var(--ink)_8%,transparent)] overflow-hidden">
                  <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-150" style={{ width: `${Math.min(100, progress)}%` }} />
                </div>
              </div>
            ) : (
              <div className="pt-1 text-[12px] leading-relaxed text-[var(--help)]">
                {blocked || t("train.statusReady")}
              </div>
            )}
          </div>
          <div className="flex-none flex items-center gap-2 mt-4 mb-2.5">
            <h3 className="text-[15.5px] font-semibold m-0">{t("train.logTitle")}</h3>
            <span className="text-[12px] text-[var(--meta)] truncate">{t("train.logNote")}</span>
          </div>
          <pre
            ref={logRef}
            className="flex-1 min-h-[160px] rounded-[var(--r)] bg-[var(--page-bg)] p-3.5 text-[11.5px] leading-relaxed text-[var(--ink-muted)] overflow-auto m-0 whitespace-pre-wrap tabular-nums"
          >
            {log.length ? log.join("\n") : t("train.logEmpty")}
          </pre>
        </div>
      </div>
    </PagePad>
  );
}

/** 一段微调的三个参数。范围与默认值来自所选版本，滑杆上标出默认值。 */
function PartFields({
  part,
  defaults,
  minEpochs,
  onChange,
}: {
  part: Part;
  defaults?: PartDefaults;
  minEpochs: number;
  onChange: (p: Part) => void;
}) {
  const maxEpochs = Math.max(defaults?.max_epochs ?? 50, part.epochs);
  const maxBatch = Math.max(defaults?.max_batch ?? 16, part.batch);
  return (
    <>
      <Field
        label={t("train.epochs")}
        control={
          <Slider
            value={part.epochs}
            min={minEpochs}
            max={maxEpochs}
            step={1}
            defaultValue={defaults?.epochs}
            onChange={(v) => onChange({ ...part, epochs: v })}
          />
        }
      />
      <Field
        label={t("train.batch")}
        control={
          <Slider
            value={part.batch}
            min={1}
            max={maxBatch}
            step={1}
            defaultValue={defaults?.batch}
            onChange={(v) => onChange({ ...part, batch: v })}
          />
        }
      />
      <Field
        label={t("train.saveEvery")}
        tip={t("train.saveEveryTip")}
        control={
          <Slider
            value={part.saveEvery}
            min={1}
            max={maxEpochs}
            step={1}
            defaultValue={defaults?.save_every}
            onChange={(v) => onChange({ ...part, saveEvery: v })}
          />
        }
      />
    </>
  );
}
