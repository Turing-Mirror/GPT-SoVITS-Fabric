import { useMemo, useRef, useState } from "react";
import { PagePad, PageHead, Block, Btn } from "../components/ui";
import { Field, Select, Slider } from "../components/controls";
import { t } from "../i18n/t";

/**
 * 训练台 —— 数据集准备与微调的统一入口。
 *
 * 流水线四阶段：数据集工具链（分离 / 切片 / 打标 / 校对）→ 训练集格式化 →
 * SoVITS 微调 → GPT 微调。浏览器预览模式下以演示数据呈现各阶段形态；
 * 接通 train_worker 后由引擎上报真实阶段进度。
 */

const VERSIONS = ["v2ProPlus", "v2Pro", "v4", "v2", "v1"] as const;
type Version = (typeof VERSIONS)[number];

type StageState = "idle" | "running" | "done";

const STAGE_KEYS = [
  "train.stagePrepare",
  "train.stageFormat",
  "train.stageSovits",
  "train.stageGpt",
] as const;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 演示用数据集体检摘要。 */
function demoDataset() {
  return { total: 1286, short: 14, loud: 3, hours: "9.6" };
}

export function TrainPage() {
  const [version, setVersion] = useState<Version>("v2ProPlus");
  const ds = useMemo(demoDataset, []);

  const [epochs, setEpochs] = useState(24);
  const [batchSize, setBatchSize] = useState(8);
  const [lr, setLr] = useState(0.0001);

  const [stage, setStage] = useState(-1);
  const [states, setStates] = useState<StageState[]>(["idle", "idle", "idle", "idle"]);
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const timerRef = useRef<number | null>(null);

  const running = stage >= 0 && stage < STAGE_KEYS.length;

  function startTraining() {
    if (running) return;
    setStates(["running", "idle", "idle", "idle"]);
    setStage(0);
    setProgress(0);
    setLog([t("train.logSession", { v: version })]);
    if (timerRef.current != null) window.clearInterval(timerRef.current);
    let tick = 0;
    timerRef.current = window.setInterval(() => {
      tick += 1;
      setProgress((p) => {
        const next = p + 1.6 + Math.random() * 2.2;
        const s = Math.min(STAGE_KEYS.length - 1, Math.floor(next / 25));
        setStage(s);
        setStates((prev) =>
          prev.map((st, i) => (i < s ? ("done" as const) : i === s ? ("running" as const) : st)),
        );
        if (tick % 3 === 0) {
          setLog((lines) =>
            [...lines, t("train.logLine", { n: Math.round(Math.min(100, next)) })].slice(-80),
          );
        }
        if (next >= 100) {
          if (timerRef.current != null) window.clearInterval(timerRef.current);
          setStates(["done", "done", "done", "done"]);
          setStage(STAGE_KEYS.length);
          setLog((lines) => [...lines, t("train.logDone")].slice(-80));
          return 100;
        }
        return next;
      });
    }, 220);
  }

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

      <Block title={t("train.modelTitle")} note={t("train.modelNote")}>
        <div className="rounded-[var(--r)] bg-[var(--surface)] shadow-[var(--glass)] p-4 max-w-[720px] flex flex-col gap-[16px]">
          <Field
            label={t("train.version")}
            tip={t("train.versionTip")}
            control={
              <Select
                full
                value={version}
                options={VERSIONS.map((v) => ({ id: v, label: v }))}
                onChange={(v) => setVersion(v as Version)}
              />
            }
          />
          <div className="flex items-center gap-2 flex-wrap">
            {[
              { k: "hubert", ok: true },
              { k: "bert", ok: true },
              { k: "s1v3", ok: version !== "v1" && version !== "v2" },
              { k: "sv", ok: version === "v2Pro" || version === "v2ProPlus" },
              { k: "vocoder", ok: version === "v4" },
            ].map(({ k, ok }) => (
              <span
                key={k}
                className={[
                  "text-[11.5px] px-2 py-1 rounded-full",
                  ok
                    ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "bg-[color-mix(in_srgb,var(--ink)_7%,transparent)] text-[var(--ink-muted)]",
                ].join(" ")}
              >
                {ok ? "✓ " : ""}
                {t(`train.base_${k}`)}
              </span>
            ))}
          </div>
          <div className="text-[12.5px] text-[var(--help)]">{t("train.baseHint")}</div>
        </div>
      </Block>

      <Block title={t("train.datasetTitle")} note={t("train.datasetNote")}>
        <div className="max-w-[720px] flex flex-col gap-[10px]">
          <div className="rounded-[var(--r)] border border-dashed border-[var(--line)] p-5 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="text-[13.5px] font-medium">{t("train.listFile")}</div>
              <div className="text-[12px] text-[var(--help)] mt-1">{t("train.listDesc")}</div>
            </div>
            <Btn>{t("train.importList")}</Btn>
          </div>
          <div className="rounded-[var(--r)] bg-[var(--surface)] shadow-[var(--glass)] p-4 grid grid-cols-2 max-[560px]:grid-cols-1 gap-x-6 gap-y-3">
            {[
              { label: t("train.statTotal"), value: String(ds.total), warn: false },
              { label: t("train.statHours"), value: `${ds.hours} h`, warn: false },
              { label: t("train.statShort"), value: String(ds.short), warn: ds.short > 0 },
              { label: t("train.statLoud"), value: String(ds.loud), warn: ds.loud > 0 },
            ].map((s) => (
              <div key={s.label} className="flex items-center justify-between">
                <span className="text-[12.5px] text-[var(--help)]">{s.label}</span>
                <span
                  className={[
                    "text-[13.5px] tabular-nums font-medium",
                    s.warn ? "text-[var(--notify)]" : "",
                  ].join(" ")}
                >
                  {s.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Block>

      <Block title={t("train.hyperTitle")}>
        <div className="rounded-[var(--r)] bg-[var(--surface)] shadow-[var(--glass)] p-4 flex flex-col gap-[16px] max-w-[720px]">
          <Field
            label={t("train.epochs")}
            control={<Slider value={epochs} min={1} max={100} step={1} onChange={setEpochs} />}
          />
          <Field
            label={t("train.batch")}
            control={<Slider value={batchSize} min={1} max={32} step={1} onChange={setBatchSize} />}
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
        </div>
      </Block>

      <Block title={t("train.pipelineTitle")}>
        <div className="max-w-[860px]">
          <div className="grid grid-cols-4 gap-[8px]">
            {STAGE_KEYS.map((key, i) => {
              const st = states[i];
              return (
                <div
                  key={key}
                  className={[
                    "rounded-[var(--rs)] px-3 py-2.5 text-center text-[12.5px] transition-colors duration-200",
                    st === "done"
                      ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                      : st === "running"
                        ? "bg-[var(--accent)] text-[var(--accent-ink)] font-semibold"
                        : "bg-[color-mix(in_srgb,var(--ink)_6%,transparent)] text-[var(--ink-muted)]",
                  ].join(" ")}
                >
                  {st === "done" ? "✓ " : ""}
                  {t(key)}
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
            <Btn primary busy={running} onClick={startTraining}>
              {running ? t("train.running") : t("train.start")}
            </Btn>
            {!isTauri() ? (
              <Btn disabled>{t("train.openFolder")}</Btn>
            ) : (
              <Btn>{t("train.openFolder")}</Btn>
            )}
            <span className="text-[12px] text-[var(--meta)] tabular-nums">
              {progress >= 100 ? t("train.finished") : t("train.progressLabel", { n: Math.round(progress) })}
            </span>
          </div>
        </div>
      </Block>

      <Block title={t("train.logTitle")} note={t("train.logNote")}>
        <pre className="max-w-[860px] rounded-[var(--r)] bg-[var(--page-bg)] p-3.5 text-[11.5px] leading-relaxed text-[var(--ink-muted)] overflow-auto max-h-[220px] m-0 whitespace-pre-wrap tabular-nums">
{log.length ? log.join("\n") : t("train.logEmpty")}
        </pre>
      </Block>
    </PagePad>
  );
}
