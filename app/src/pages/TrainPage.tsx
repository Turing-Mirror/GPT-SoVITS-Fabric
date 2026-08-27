import { useState } from "react";
import { PagePad, PageHead, Block, Btn } from "../components/ui";
import { Field, Select, Slider } from "../components/controls";
import { t } from "../i18n/t";

/**
 * 训练台 —— 数据集准备与微调的统一入口。
 *
 * 流水线四阶段：数据集工具链（分离 / 切片 / 打标 / 校对）→ 训练集格式化 →
 * SoVITS 微调 → GPT 微调。
 *
 * **这一页现在只是形状，还没接引擎。** 它调的 `tools/train_worker.py`
 * 没有随包出去，而那份脚本本身是 RVC 的训练流程，跟 GPT-SoVITS 的两段
 * 微调不是一回事，接之前得先重写。
 *
 * 在接通之前，这里刻意什么都不做：以前「开始训练」按下去会走一个定时器，
 * 进度条爬到 100%、四个阶段依次打勾、日志里打出「训练完成」—— 全是假的，
 * 一个字节都没算过。按钮点了没反应是不好，但比谎报训练完成好得多：
 * 后者会让人以为自己有了一个模型。
 *
 * 接引擎时要恢复的是：真实的数据集体检数字、按 engine_core 实际存在与否
 * 点亮的底模标记、以及由 worker 上报的阶段进度。
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

export function TrainPage() {
  const [version, setVersion] = useState<Version>("v2ProPlus");

  const [epochs, setEpochs] = useState(24);
  const [batchSize, setBatchSize] = useState(8);
  const [lr, setLr] = useState(0.0001);

  const states: StageState[] = ["idle", "idle", "idle", "idle"];
  const progress = 0;

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
            {/* 打勾要以「这台机器上真的有这份权重」为准，那要问 engine_core。
                接通之前一个都不打 —— 打了就是在替用户断言他有。 */}
            {["hubert", "bert", "s1v3", "sv", "vocoder"].map((k) => {
              const ok = false;
              return (
              <span
                key={k}
                className={[
                  "text-[11.5px] px-2 py-1 rounded-full",
                  ok
                    ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "bg-[color-mix(in_srgb,var(--ink)_7%,transparent)] text-[var(--ink-muted)]",
                ].join(" ")}
              >
                {t(`train.base_${k}`)}
              </span>
              );
            })}
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
              // 接通之前一律给「—」。摆一组编出来的数字（1286 条 / 9.6 小时）
              // 比空着更糟：它看起来像是真的读过素材。
              { label: t("train.statTotal"), value: "—", warn: false },
              { label: t("train.statHours"), value: "—", warn: false },
              { label: t("train.statShort"), value: "—", warn: false },
              { label: t("train.statLoud"), value: "—", warn: false },
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
            <Btn primary disabled>
              {t("train.start")}
            </Btn>
            <Btn disabled>{t("train.openFolder")}</Btn>
            <span className="text-[12px] text-[var(--meta)]">{t("train.notWired")}</span>
          </div>
        </div>
      </Block>

      <Block title={t("train.logTitle")} note={t("train.logNote")}>
        <pre className="max-w-[860px] rounded-[var(--r)] bg-[var(--page-bg)] p-3.5 text-[11.5px] leading-relaxed text-[var(--ink-muted)] overflow-auto max-h-[220px] m-0 whitespace-pre-wrap tabular-nums">
{t("train.logEmpty")}
        </pre>
      </Block>
    </PagePad>
  );
}
