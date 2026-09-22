import { useCallback, useEffect, useRef, useState } from "react";
import { PagePad, PageHead, Block, Btn } from "../components/ui";
import { Field, Select, Slider, Toggle } from "../components/controls";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openTool } from "../components/ToolWindow";
import { ErrorNote } from "../components/ErrorNote";
import { t } from "../i18n/t";

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
 * 版本列表直接取 `train_status().versions`（即 Rust 的 `TRAIN_VERSIONS`）。
 * 以前这里写死了五个，含后端根本不认的 v4 / v1 —— 用户选得到，一按就被拒。
 * 契约只该有一处，那处在 Rust。
 */

type Stage = "prepare" | "format" | "sovits" | "gpt";
const STAGES: Stage[] = ["prepare", "format", "sovits", "gpt"];
const STAGE_KEYS: Record<Stage, string> = {
  prepare: "train.stagePrepare",
  format: "train.stageFormat",
  sovits: "train.stageSovits",
  gpt: "train.stageGpt",
};

type Status = {
  runtime_ready?: boolean;
  worker_present?: boolean;
  engine_core_ready?: boolean;
  engine_core_missing?: string[];
  nvidia?: boolean;
  versions?: string[];
  experiments?: { name?: string }[];
  suggested_batch?: number;
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

  const [epochs, setEpochs] = useState(24);
  const [batchSize, setBatchSize] = useState(8);
  const [lr, setLr] = useState(0.0001);
  const [saveEvery, setSaveEvery] = useState(4);
  const [resume, setResume] = useState(true);

  const [stage, setStage] = useState<Stage | null>(null);
  const [doneStages, setDoneStages] = useState<Stage[]>([]);
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [errCode, setErrCode] = useState("");
  const [starting, setStarting] = useState(false);

  const logRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const s = await invoke<Status>("train_status");
      setSt(s ?? {});
      setVersion((v) => v || (s?.versions ?? [])[0] || "");
      if (s?.suggested_batch) setBatchSize((b) => (b === 8 ? s.suggested_batch! : b));
    } catch {
      /* 状态问不到就维持上一次的，别把界面清空 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void invoke<string>("train_output_dir").then(setOutDir).catch(() => {});
  }, [refresh]);

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

  const pickDataset = useCallback(async () => {
    const p = await invoke<string | null>("train_pick_dataset").catch(() => null);
    if (!p) return;
    setDataset(p);
    setExp((e) => e || p.split(/[\\/]/).filter(Boolean).pop() || "");
    setScan(await invoke<Scan>("train_scan_dataset", { path: p }).catch(() => null));
    setInspect(await invoke<Inspect>("train_inspect_dataset", { path: p }).catch(() => null));
  }, []);

  const pickOutput = useCallback(async () => {
    const p = await invoke<string | null>("train_pick_output_dir").catch(() => null);
    if (p) setOutDir(p);
  }, []);

  // 拦住的四种情况分开报，别糊成一句「不能训练」—— 用户得知道去补哪一样。
  const blocked =
    !st.runtime_ready
      ? t("train.blockRuntime")
      : !st.worker_present
        ? t("train.blockWorker")
        : !st.engine_core_ready
          ? t("train.blockCore", { v0: String((st.engine_core_missing ?? []).length) })
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
          total_epoch: epochs,
          batch_size: batchSize,
          learning_rate: lr,
          save_every: saveEvery,
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
  }, [exp, dataset, version, epochs, batchSize, lr, saveEvery, resume, outDir, refresh]);

  const versions = st.versions ?? [];
  const missing = st.engine_core_missing ?? [];

  return (
    <PagePad>
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
        <div className=" rounded-[var(--r)] bg-[var(--accent-soft)] text-[var(--accent)] px-4 py-3 text-[12.5px] mb-4">
          {t("train.interrupted", {
            v0: String(st.interrupted.exp ?? ""),
            v1: String(st.interrupted.epoch ?? 0),
            v2: String(st.interrupted.total ?? 0),
          })}
        </div>
      ) : null}

      <Block title={t("train.modelTitle")} note={t("train.modelNote")}>
        <div className="rounded-[var(--r)] bg-[var(--group)] p-4 flex flex-col gap-[16px]">
          <Field
            label={t("train.version")}
            tip={t("train.versionTip")}
            control={
              <Select
                full
                value={version}
                options={versions.map((v) => ({ id: v, label: v }))}
                onChange={setVersion}
              />
            }
          />
          {/* 打勾以「这台机器上真的有这份权重」为准，判据是 engine_core_missing。
              以前这里五个标记恒为灰 —— 灰得没有信息量；现在缺哪几个直接列出来。 */}
          <div className="text-[12.5px]">
            {st.engine_core_ready ? (
              <span className="text-[var(--accent)]">{t("train.baseReady")}</span>
            ) : (
              <span className="text-[var(--notify)]">
                {t("train.baseMissing", { v0: String(missing.length) })}
              </span>
            )}
          </div>
          {missing.length ? (
            <pre className="rounded-[var(--rs)] bg-[var(--page-bg)] p-2.5 text-[11.5px] leading-relaxed text-[var(--ink-muted)] overflow-auto m-0">
              {missing.join("\n")}
            </pre>
          ) : null}
          <div className="text-[12.5px] text-[var(--help)]">{t("train.baseHint")}</div>
        </div>
      </Block>

      <Block title={t("train.datasetTitle")} note={t("train.datasetNote")}>
        <div className=" flex flex-col gap-[10px]">
          <div className="rounded-[var(--r)] border border-dashed border-[var(--line)] p-5 flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium">{t("train.listFile")}</div>
              <div className="text-[12px] text-[var(--help)] mt-1 break-all">
                {dataset || t("train.listDesc")}
              </div>
            </div>
            <Btn onClick={() => void pickDataset()}>{t("train.importList")}</Btn>
          </div>

          {/* 流水线第一步的入口。素材里带伴奏就直接拿去训，出来的音色会把
              背景音一起学进去 —— 分离这一整套（separate.rs + worker + pymss）
              早就在仓库里，之前只是没有任何地方能打开它。 */}
          <div className="flex items-center justify-between gap-3 flex-wrap py-1">
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium">{t("train.sepEntry")}</div>
              <div className="text-[12px] text-[var(--help)] mt-1 leading-relaxed">
                {t("train.sepEntryDesc")}
              </div>
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
                  <span className="text-[12.5px] text-[var(--help)] break-all">
                    {outDir || t("train.outputDefault")}
                  </span>
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
              {
                label: t("train.statHours"),
                value: inspect?.available ? `≈ ${hhmm(inspect.estimated_total_seconds)}` : "—",
              },
              {
                label: t("train.statMedian"),
                value: inspect?.median_seconds ? `${inspect.median_seconds.toFixed(1)} s` : "—",
              },
              {
                label: t("train.statLoud"),
                value:
                  typeof inspect?.mean_volume_db === "number"
                    ? `${inspect.mean_volume_db} dB`
                    : "—",
              },
            ].map((s) => (
              <div key={s.label} className="flex items-center justify-between">
                <span className="text-[12.5px] text-[var(--help)]">{s.label}</span>
                <span className="text-[13.5px] tabular-nums font-medium">{s.value}</span>
              </div>
            ))}
          </div>
        </div>
      </Block>

      <Block title={t("train.hyperTitle")}>
        <div className="rounded-[var(--r)] bg-[var(--group)] p-4 flex flex-col gap-[16px]">
          <Field
            label={t("train.epochs")}
            control={<Slider value={epochs} min={1} max={200} step={1} onChange={setEpochs} />}
          />
          <Field
            label={t("train.batch")}
            control={<Slider value={batchSize} min={1} max={64} step={1} onChange={setBatchSize} />}
          />
          <Field
            label={t("train.saveEvery")}
            tip={t("train.saveEveryTip")}
            control={<Slider value={saveEvery} min={1} max={50} step={1} onChange={setSaveEvery} />}
          />
          <Field
            label={t("train.lr")}
            control={
              <Slider
                value={Math.round(lr * 100000) / 100000}
                min={0.00001}
                max={0.001}
                step={0.00001}
                defaultValue={0.0001}
                onChange={(v) => setLr(v)}
                format={(v) => v.toExponential(1)}
              />
            }
          />
          {/* Toggle 自带 label/tip，不套 Field —— 套了会出现两个标题。 */}
          <Toggle
            checked={resume}
            onChange={setResume}
            label={t("train.resume")}
            tip={t("train.resumeTip")}
          />
        </div>
      </Block>

      <Block title={t("train.pipelineTitle")}>
        <div className="">
          <div className="grid grid-cols-4 gap-[8px]">
            {STAGES.map((s) => {
              const running = stage === s;
              const done = doneStages.includes(s);
              return (
                <div
                  key={s}
                  className={[
                    "rounded-[var(--rs)] px-3 py-2.5 text-center text-[12.5px] transition-colors duration-200",
                    running
                      ? "bg-[var(--accent)] text-[var(--accent-ink)] font-semibold"
                      : done
                        ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                        : "bg-[color-mix(in_srgb,var(--ink)_6%,transparent)] text-[var(--ink-muted)]",
                  ].join(" ")}
                >
                  {done && !running ? "✓ " : ""}
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
              <Btn onClick={() => void invoke("train_cancel").catch(() => {})}>
                {t("train.cancel")}
              </Btn>
            ) : (
              <Btn primary busy={starting} disabled={!!blocked} onClick={() => void start()}>
                {t("train.start")}
              </Btn>
            )}
            <span className="text-[12px] text-[var(--meta)]">
              {blocked || t("train.diskFree", { v0: gb(st.disk_free_bytes) })}
            </span>
          </div>
          {err ? (
            <div className="mt-3">
              <ErrorNote text={err} code={errCode} />
            </div>
          ) : null}
        </div>
      </Block>

      <Block title={t("train.logTitle")} note={t("train.logNote")}>
        <pre
          ref={logRef}
          className=" rounded-[var(--r)] bg-[var(--page-bg)] p-3.5 text-[11.5px] leading-relaxed text-[var(--ink-muted)] overflow-auto max-h-[220px] m-0 whitespace-pre-wrap tabular-nums"
        >
          {log.length ? log.join("\n") : t("train.logEmpty")}
        </pre>
      </Block>
    </PagePad>
  );
}
