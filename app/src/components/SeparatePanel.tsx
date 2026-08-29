import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Btn } from "./ui";
import { HelpMark } from "./Tooltip";
import { ErrorNote } from "./ErrorNote";
import { RangeBar } from "./controls";
import { openDownloadModels } from "../lib/downloadModels";
import { openHelpSection } from "../lib/helpNav";
import { ToolActions, ToolBody } from "./ToolWindow";
import { pickPath } from "../lib/nativeDialog";
import { t } from "../i18n/t";

/**
 * 人声分离（PyMSS）—— 训练流水线的第一道工序。
 *
 * `separate.rs`、`tools/separate_worker.py` 和 pymss 两棵树早就在仓库里，
 * 五个命令也都注册着，但前端一处都没调过：整个功能装好了没接电。素材里
 * 带伴奏就直接拿去训练，出来的音色会把背景音一起学进去 —— 而用户没有
 * 任何入口能先把人声抠出来。
 *
 * 一次一个文件（或一个目录），没有队列：分离很吃显存，排队跑只会让人
 * 以为卡死了。
 */

type Status = {
  runtime_ready?: boolean;
  worker_present?: boolean;
  core_present?: boolean;
  model_dir?: string;
  models?: string[];
  busy?: boolean;
};

type Progress = {
  phase: "start" | "run" | "done" | "error";
  done: number;
  total: number;
  message: string;
};

const ROW = "flex items-center gap-3 py-2.5";
/**
 * 表单左边那一列。
 *
 * 宽度不能照着中文标签配 —— 四个汉字五十来像素够了，但法语的
 * 「Enregistrer les modèles dans」有两百多像素，会在词中间断成三行。
 * 放宽到装得下绝大多数语言，剩下几个特别长的折成两行，配 leading-tight
 * 看着是有意为之，而不是挤坏了。
 */
const LABEL = "w-[96px] shrink-0 text-[13px] leading-tight";
const FIELD =
  "rounded-[var(--rs)] border border-[var(--hairline)] bg-transparent px-2 py-1.5 text-[13px]";
const PATH =
  "flex-1 min-w-0 truncate text-[12.5px] text-[var(--ink-muted)] font-mono";
const FORMATS = ["wav", "flac", "mp3", "m4a"] as const;

export function SeparatePanel() {
  const [st, setSt] = useState<Status>({});
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [model, setModel] = useState("");
  const [fmt, setFmt] = useState<(typeof FORMATS)[number]>("wav");
  const [agg, setAgg] = useState(10);
  const [prog, setProg] = useState<Progress | null>(null);

  // 这一格既报错也报结果。「复制完整错误 / 打开日志」只该在报错时出现，
  // 所以两条路分开走，别让 ErrorNote 去猜。
  const [msg, setMsg] = useState("");
  const [msgErr, setMsgErr] = useState(false);
  const showErr = (v: string) => {
    setMsgErr(true);
    setMsg(v);
  };
  const showInfo = (v: string) => {
    setMsgErr(false);
    setMsg(v);
  };

  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        const s = await invoke<Status>("separate_status");
        setSt(s);
        setModel((m) => m || s.models?.[0] || "");
      } catch (e) {
        showErr(String(e));
      }
    })();

    // listen() 是异步的：窗口在它 resolve 之前关掉就会把注销句柄丢掉，
    // 每开一次泄漏一个监听。
    let disposed = false;
    let un: (() => void) | undefined;
    void listen<Progress>("separate-progress", (ev) => {
      setProg(ev.payload);
      if (ev.payload.phase === "error") showErr(ev.payload.message);
    }).then((fn) => {
      if (disposed) fn();
      else un = fn;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  const pick = async (dir: boolean, inputFolder = false) => {
    try {
      const p = await pickPath<string | null>(
        "separate_pick",
        { dir, inputFolder },
        t("sep.pickBusy"),
      );
      if (!p) return;
      if (dir) setOutput(p);
      else setInput(p);
    } catch (e) {
      showErr(String(e));
    }
  };

  const start = async () => {
    if (runningRef.current) return;
    showInfo("");
    setProg(null);
    runningRef.current = true;
    setRunning(true);
    try {
      const r = await invoke<{ files?: string[] }>("separate_start", {
        input,
        output,
        model,
        format: fmt,
        aggression: agg,
      });
      showInfo(t("sep.doneCount", { v0: String(r.files?.length ?? 0) }));
    } catch (e) {
      showErr(String(e));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  const ready = !!st.runtime_ready && !!st.worker_present;
  const needCore = ready && st.core_present === false;
  const needModels = ready && !needCore && !st.models?.length;
  // 四种拦截分开报。糊成一句「暂时不能用」的话，用户不知道该去补哪一样。
  const blocked = !st.runtime_ready
    ? t("sep.blockRuntime")
    : !st.worker_present
      ? t("sep.blockWorker")
      : needCore
        ? t("sep.blockCore")
        : needModels
          ? t("sep.blockModels")
          : "";

  const pct = prog?.total ? Math.round((prog.done / prog.total) * 100) : 0;

  return (
    <ToolBody>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="m-0 text-[17px] font-semibold">{t("sep.title")}</h3>
        <Btn onClick={() => openHelpSection("separate")}>{t("sep.help")}</Btn>
      </div>
      <p className="m-0 mb-4 text-[12.5px] text-[var(--ink-muted)]">{t("sep.desc")}</p>

      {blocked ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <p className="m-0 text-[13px] text-[var(--notify)]">{blocked}</p>
          {needModels || needCore ? (
            <Btn onClick={() => openDownloadModels({ filter: "separate" })}>
              {t("sep.getModels")}
            </Btn>
          ) : null}
        </div>
      ) : (
        <div className="mb-3 flex justify-end">
          <Btn onClick={() => openDownloadModels({ filter: "separate" })}>
            {t("sep.manageModels")}
          </Btn>
        </div>
      )}

      <div className="border-t border-[var(--hairline)]">
        <div className={ROW}>
          <span className={LABEL}>{t("sep.input")}</span>
          <span className={PATH}>{input || t("sep.unset")}</span>
          <Btn onClick={() => void pick(false)}>{t("sep.pickFile")}</Btn>
          <Btn onClick={() => void pick(false, true)}>{t("sep.pickFolder")}</Btn>
        </div>
        <div className={ROW}>
          <span className={LABEL}>{t("sep.output")}</span>
          <span className={PATH}>{output || t("sep.unset")}</span>
          <Btn onClick={() => void pick(true)}>{t("sep.pickFolder")}</Btn>
        </div>
        <div className={ROW}>
          <span className={LABEL}>{t("sep.model")}</span>
          <select
            aria-label={t("sep.model")}
            className="flex-1 min-w-0 rounded-[var(--rs)] border border-[var(--hairline)] bg-transparent px-2 py-1.5 text-[13px]"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {(st.models || []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {!st.models?.length ? <option value="">{t("sep.noModel")}</option> : null}
          </select>
        </div>
        <div className={ROW}>
          <span className={`${LABEL} flex items-center gap-1.5`}>
            {t("sep.format")}
            <HelpMark title={t("sep.formatTip")} />
          </span>
          <select
            aria-label={t("sep.format")}
            className={FIELD}
            value={fmt}
            onChange={(e) => setFmt(e.target.value as (typeof FORMATS)[number])}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div className={ROW}>
          <span className={`${LABEL} flex items-center gap-1.5`}>
            {t("sep.agg")}
            <HelpMark title={t("sep.aggTip")} />
          </span>
          <div className="flex-1">
            <RangeBar
              value={agg}
              min={0}
              max={20}
              step={1}
              defaultValue={10}
              onChange={setAgg}
              ariaLabel={t("sep.agg")}
            />
          </div>
          <span className="w-[36px] text-right text-[13px] tabular-nums">{agg}</span>
        </div>
      </div>

      {prog ? (
        <div className="mt-4">
          <div className="h-1 w-full overflow-hidden rounded bg-[color-mix(in_srgb,var(--ink)_10%,transparent)]">
            <div
              className="h-full bg-[var(--accent)] transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="m-0 mt-2 text-[12px] text-[var(--meta)]">
            {prog.message} {prog.phase === "run" ? `${pct}%` : ""}
          </p>
        </div>
      ) : null}

      {msg ? <ErrorNote text={msg} error={msgErr} /> : null}

      <ToolActions>
        <div className="ml-auto flex items-center gap-2.5">
          {running ? (
            <Btn onClick={() => void invoke("separate_cancel")}>{t("sep.cancel")}</Btn>
          ) : (
            <Btn
              disabled={!output}
              onClick={() => void invoke("separate_reveal", { path: output })}
            >
              {t("sep.reveal")}
            </Btn>
          )}
          <Btn
            primary
            busy={running}
            disabled={running || !!blocked || !input || !output}
            onClick={() => void start()}
          >
            {running ? t("sep.running") : t("sep.start")}
          </Btn>
        </div>
      </ToolActions>
    </ToolBody>
  );
}
