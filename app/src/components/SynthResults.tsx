import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { Btn } from "./ui";
import { Select } from "./controls";
import { t } from "../i18n/t";
import { Icon, PromptDialog } from "../trm";

/**
 * 合成页右栏：合成记录。
 *
 * 数据就是输出目录本身（synth_recent），每条音频旁边的同名 .json 记着文本、
 * 角色和参数（含实际种子）。所以手动删掉的文件不会留下幽灵条目，换个输出
 * 目录记录也跟着换。
 */

export type SynthRecord = {
  text?: string;
  role_name?: string;
  audio_sec?: number;
  t_first_ms?: number;
  t_total_ms?: number;
  params?: Record<string, unknown>;
};

export type ResultRow = { name: string; path: string; mtime: number; record: SynthRecord | null };

/** 导出格式。与 synth_worker.py 的 OUT_FORMATS 一致。 */
export const OUT_FORMATS = ["wav", "flac"] as const;
export type OutFormat = (typeof OUT_FORMATS)[number];

/** 右栏最多列多少条。再多就去输出目录里看。 */
const HISTORY_LIMIT = 200;

function clock(sec: number): string {
  const d = new Date(sec * 1000);
  const same = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return same ? hm : `${d.toLocaleDateString([], { month: "numeric", day: "numeric" })} ${hm}`;
}

export function SynthResults({
  tick,
  latest,
  format,
  onFormat,
  onReuse,
  onError,
}: {
  /** 每合成完一条加一，右栏据此重读。 */
  tick: number;
  /** 刚合成出的文件：重读后自动选中。 */
  latest: string;
  format: OutFormat;
  onFormat: (f: OutFormat) => void;
  onReuse: (rec: SynthRecord) => void;
  onError: (msg: string) => void;
}) {
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [sel, setSel] = useState("");
  const [playing, setPlaying] = useState("");
  const [renaming, setRenaming] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  const reload = useCallback(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    void invoke<ResultRow[]>("synth_recent", { limit: HISTORY_LIMIT })
      .then((r) => setRows(r ?? []))
      .catch((e) => onError(String(e)));
  }, [onError]);

  useEffect(() => {
    reload();
  }, [reload, tick]);

  useEffect(() => {
    if (latest) setSel(latest);
  }, [latest]);

  const stop = useCallback(() => {
    audio.current?.pause();
    audio.current = null;
    setPlaying("");
  }, []);

  useEffect(() => stop, [stop]);

  const play = (path: string) => {
    if (playing === path) {
      stop();
      return;
    }
    stop();
    const a = new Audio(convertFileSrc(path));
    a.onended = () => setPlaying("");
    a.onerror = () => {
      setPlaying("");
      onError(t("synth.playFailed"));
    };
    audio.current = a;
    void a.play();
    setPlaying(path);
  };

  const current = rows.find((r) => r.path === sel) ?? null;
  const seed = current?.record?.params?.seed;
  // 选中一条时列出它的详情，每项一行，名称在左、值在右。
  const fields: [string, string][] = current?.record
    ? [
        [t("synth.resultRole"), current.record.role_name ?? ""],
        [t("synth.pSeed"), typeof seed === "number" ? String(seed) : ""],
        [t("synth.resultFile"), current.name],
      ].filter((f): f is [string, string] => Boolean(f[1]))
    : [];

  const rename = (name: string) => {
    if (!current) return;
    setRenaming(false);
    void invoke<string>("synth_rename", { path: current.path, name })
      .then((p) => {
        setSel(p);
        reload();
      })
      .catch((e) => onError(String(e)));
  };

  const remove = () => {
    if (!current) return;
    if (playing === current.path) stop();
    void invoke("synth_delete", { path: current.path })
      .then(() => {
        setSel("");
        reload();
      })
      .catch((e) => onError(String(e)));
  };

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex-none flex items-center gap-2 mb-2.5">
        <h3 className="text-[15.5px] font-semibold m-0">{t("synth.resultTitle")}</h3>
        <span className="text-[12px] text-[var(--meta)]">{rows.length}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Select
            width={84}
            value={format}
            options={OUT_FORMATS.map((f) => ({ id: f, label: f }))}
            onChange={(v) => onFormat(v as OutFormat)}
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain rounded-[var(--r)] bg-[var(--group)] p-1.5">
        {rows.length === 0 ? (
          <p className="m-0 px-2.5 py-4 text-[12.5px] text-[var(--help)] leading-relaxed">{t("synth.resultEmpty")}</p>
        ) : (
          rows.map((r) => {
            const on = r.path === sel;
            const rec = r.record ?? {};
            return (
              <div
                key={r.path}
                role="button"
                tabIndex={0}
                onClick={() => setSel(r.path)}
                onDoubleClick={() => play(r.path)}
                onKeyDown={(e) => e.key === "Enter" && setSel(r.path)}
                className={[
                  "flex items-start gap-2 px-2 py-2 rounded-[var(--rs)] cursor-pointer transition-colors duration-150 outline-none",
                  on ? "bg-[var(--accent-soft)]" : "hover:bg-[color-mix(in_srgb,var(--ink)_4%,transparent)]",
                ].join(" ")}
              >
                <button
                  type="button"
                  aria-label={playing === r.path ? t("synth.stop") : t("synth.play")}
                  onClick={(e) => {
                    e.stopPropagation();
                    play(r.path);
                  }}
                  className={[
                    "shrink-0 mt-px w-[22px] h-[22px] rounded-full grid place-items-center border-0 cursor-pointer",
                    playing === r.path
                      ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                      : "bg-[color-mix(in_srgb,var(--ink)_8%,transparent)] text-[var(--ink-muted)]",
                  ].join(" ")}
                >
                  <Icon name={playing === r.path ? "close" : "play"} size={11} />
                </button>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] leading-snug line-clamp-2 break-all">{rec.text || r.name}</span>
                  {/* 行里只放时间和时长，角色、种子等放在下方的详情里。 */}
                  <span className="block text-[11.5px] text-[var(--meta)] mt-0.5 truncate tabular-nums">
                    {rec.audio_sec
                      ? t("synth.resultMeta", { time: clock(r.mtime), sec: Number(rec.audio_sec).toFixed(1) })
                      : clock(r.mtime)}
                  </span>
                </span>
              </div>
            );
          })
        )}
      </div>
      {fields.length ? (
        <dl className="flex-none m-0 mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
          {fields.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-[var(--meta)]">{k}</dt>
              <dd className="m-0 truncate tabular-nums">{v}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      <div className="flex-none flex items-center gap-1.5 mt-2.5 flex-wrap">
        <Btn disabled={!current} onClick={() => current && void invoke("synth_reveal_file", { path: current.path }).catch(() => {})}>
          {t("synth.resultReveal")}
        </Btn>
        <Btn disabled={!current?.record?.params} onClick={() => current?.record && onReuse(current.record)}>
          {t("synth.resultReuse")}
        </Btn>
        <Btn disabled={!current} onClick={() => setRenaming(true)}>{t("synth.resultRename")}</Btn>
        <Btn disabled={!current} onClick={remove}>{t("synth.resultDelete")}</Btn>
      </div>
      <PromptDialog
        open={renaming}
        title={t("synth.resultRename")}
        initial={current ? current.name.replace(/\.[^.]+$/, "") : ""}
        confirm={t("synth.resultRename")}
        onSubmit={rename}
        onClose={() => setRenaming(false)}
      />
    </div>
  );
}
