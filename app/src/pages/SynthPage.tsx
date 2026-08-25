import { useMemo, useRef, useState } from "react";
import { PagePad, PageHead, Block, Btn } from "../components/ui";
import { Field, Slider, Toggle } from "../components/controls";
import { t } from "../i18n/t";

/**
 * 合成台 —— GPT-SoVITS Fabric 的核心页面。
 *
 * 浏览器预览模式（无 Tauri 外壳）下整页运行在演示数据上：角色与 .list 参考
 * 行均为内置样例，合成流程走本地模拟进度。接通 synth_worker 后，数据源替换
 * 为引擎真实返回，组件结构与交互保持不变。
 */

type RefRow = {
  /** 对应 .list 一行：audios/xxx.wav|说话人|语种|文本 */
  wav: string;
  text: string;
  lang: "ZH" | "JA" | "EN" | "KO" | "YUE";
  mood?: string;
};

type Role = {
  id: string;
  name: string;
  author: string;
  version: "v2" | "v2Pro" | "v2ProPlus" | "v4";
  coverHue: number;
  refs: RefRow[];
};

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const LANG_BADGE: Record<RefRow["lang"], string> = {
  ZH: "中",
  JA: "日",
  EN: "英",
  KO: "韩",
  YUE: "粤",
};

function demoRoles(): Role[] {
  return [
    {
      id: "tendou_alice",
      name: "天童爱丽丝",
      author: "图灵镜官方",
      version: "v2ProPlus",
      coverHue: 205,
      refs: [
        { wav: "jp_original_游戏标题.ogg", text: "ブルーアーカイブ", lang: "JA", mood: "平静" },
        { wav: "zh_获得补给.wav", text: "哇！是新的补给品！", lang: "ZH", mood: "开心" },
        { wav: "zh_战斗受创1.wav", text: "机体出现异常……", lang: "ZH", mood: "低落" },
      ],
    },
    {
      id: "hoshino",
      name: "小鸟游星野",
      author: "图灵镜官方",
      version: "v2ProPlus",
      coverHue: 45,
      refs: [
        { wav: "jp_login.ogg", text: "おはよう、先生……", lang: "JA", mood: "慵懒" },
        { wav: "zh_battle_skill.wav", text: "要上了哦，大家掩护我！", lang: "ZH", mood: "认真" },
      ],
    },
    {
      id: "serika",
      name: "黑见芹香",
      author: "图灵镜官方",
      version: "v2ProPlus",
      coverHue: 300,
      refs: [
        { wav: "zh_吐槽.wav", text: "又来？真是服了你了。", lang: "ZH", mood: "无奈" },
        { wav: "jp_battle.ogg", text: "逃げても無駄だよ！", lang: "JA", mood: "生气" },
      ],
    },
    {
      id: "mutsuki",
      name: "浅黄睦月",
      author: "图灵镜官方",
      version: "v2ProPlus",
      coverHue: 160,
      refs: [{ wav: "jp_greet.ogg", text: "ふふっ、面白いねぇ", lang: "JA", mood: "调皮" }],
    },
  ];
}

/** 角色包 config.json 内嵌的作者推荐参数；「恢复推荐值」回到这里。 */
const RECOMMENDED = { speed: 1.0, topK: 15, topP: 1.0, temperature: 1.0, repPenalty: 1.35 };

export function SynthPage() {
  const roles = useMemo(demoRoles, []);
  const [roleId, setRoleId] = useState(roles[0].id);
  const role = roles.find((r) => r.id === roleId) ?? roles[0];
  const [refIdx, setRefIdx] = useState(0);
  const ref = role.refs[Math.min(refIdx, role.refs.length - 1)];

  const [text, setText] = useState(
    "欢迎安装 GPT-SoVITS Fabric。选择角色与参考音频后，在此输入文本即可开始合成。",
  );
  const [speed, setSpeed] = useState(RECOMMENDED.speed);
  const [topK, setTopK] = useState(RECOMMENDED.topK);
  const [topP, setTopP] = useState(RECOMMENDED.topP);
  const [temperature, setTemperature] = useState(RECOMMENDED.temperature);
  const [repPenalty, setRepPenalty] = useState(RECOMMENDED.repPenalty);
  const [streaming, setStreaming] = useState(true);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [tFirst, setTFirst] = useState<number | null>(null);
  const timerRef = useRef<number | null>(null);

  function startSynth() {
    if (busy || !text.trim()) return;
    setBusy(true);
    setProgress(0);
    setTFirst(null);
    const started = performance.now();
    let firstPacketDone = false;
    if (timerRef.current != null) window.clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      setProgress((p) => {
        const next = (p ?? 0) + Math.random() * 9 + 3;
        if (!firstPacketDone && next > 22) {
          firstPacketDone = true;
          setTFirst(performance.now() - started);
        }
        if (next >= 100) {
          if (timerRef.current != null) window.clearInterval(timerRef.current);
          setBusy(false);
          return 100;
        }
        return next;
      });
    }, 140);
  }

  const paramsDirty =
    speed !== RECOMMENDED.speed ||
    topK !== RECOMMENDED.topK ||
    topP !== RECOMMENDED.topP ||
    temperature !== RECOMMENDED.temperature ||
    repPenalty !== RECOMMENDED.repPenalty;

  return (
    <PagePad>
      <PageHead
        title={t("synth.title")}
        sub={t("synth.subtitle")}
        actions={
          !isTauri() ? (
            <span className="text-[12px] px-2 py-1 rounded-[var(--rs)] bg-[var(--accent-soft)] text-[var(--accent)]">
              {t("synth.demoBadge")}
            </span>
          ) : null
        }
      />

      <Block title={t("synth.roleTitle")} note={t("synth.roleNote")}>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[10px]">
          {roles.map((r) => {
            const on = r.id === roleId;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setRoleId(r.id);
                  setRefIdx(0);
                }}
                className={[
                  "text-left rounded-[var(--r)] p-2.5 cursor-pointer border-0 transition-all duration-200 ease-[var(--ease)]",
                  "active:scale-[0.97]",
                  on
                    ? "shadow-[inset_0_0_0_2px_var(--accent)] bg-[var(--accent-soft)]"
                    : "shadow-[var(--glass)] bg-[var(--group)] hover:bg-[color-mix(in_srgb,var(--ink)_5%,transparent)]",
                ].join(" ")}
              >
                <div
                  className="w-full aspect-[5/3] rounded-[calc(var(--r)-4px)] mb-2 relative overflow-hidden"
                  style={{
                    background: `linear-gradient(135deg, hsl(${r.coverHue} 62% 72%), hsl(${r.coverHue + 30} 55% 58%))`,
                  }}
                >
                  <span className="absolute bottom-1 right-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-black/35 text-white">
                    {r.version}
                  </span>
                </div>
                <div className="text-[13.5px] font-medium leading-tight">{r.name}</div>
                <div className="text-[11.5px] text-[var(--meta)] mt-0.5">
                  {t("home.author", { author: r.author })}
                </div>
              </button>
            );
          })}
        </div>
      </Block>

      <Block title={t("synth.refTitle")} titleTip={t("synth.refTip")} note={t("synth.refNote")}>
        <div className="rounded-[var(--r)] overflow-hidden shadow-[var(--glass)] max-w-[860px]">
          {role.refs.map((row, i) => {
            const on = i === Math.min(refIdx, role.refs.length - 1);
            return (
              <button
                key={row.wav}
                type="button"
                onClick={() => setRefIdx(i)}
                className={[
                  "w-full text-left px-3.5 py-2.5 border-0 cursor-pointer flex items-center gap-3 transition-colors duration-150",
                  i > 0 ? "border-t border-[var(--hairline)]" : "",
                  on
                    ? "bg-[var(--accent-soft)]"
                    : "bg-[var(--surface)] hover:bg-[color-mix(in_srgb,var(--ink)_4%,transparent)]",
                ].join(" ")}
              >
                <span
                  className={[
                    "shrink-0 w-[22px] h-[22px] rounded-full grid place-items-center text-[11px]",
                    on
                      ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                      : "bg-[color-mix(in_srgb,var(--ink)_8%,transparent)] text-[var(--ink-muted)]",
                  ].join(" ")}
                >
                  ▶
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] truncate">{row.text}</span>
                  <span className="block text-[11.5px] text-[var(--meta)] truncate mt-0.5">
                    dataset/audios/{row.wav}
                  </span>
                </span>
                {row.mood ? (
                  <span className="shrink-0 text-[11px] px-1.5 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--ink)_7%,transparent)] text-[var(--ink-muted)]">
                    {row.mood}
                  </span>
                ) : null}
                <span className="shrink-0 w-[20px] h-[20px] rounded-[6px] grid place-items-center text-[10.5px] bg-[var(--stage)] text-[var(--accent)] font-semibold">
                  {LANG_BADGE[row.lang]}
                </span>
              </button>
            );
          })}
        </div>
      </Block>

      <Block
        title={t("synth.paramsTitle")}
        note={paramsDirty ? t("synth.paramsEdited") : t("synth.paramsFromPack")}
        action={
          paramsDirty ? (
            <Btn
              onClick={() => {
                setSpeed(RECOMMENDED.speed);
                setTopK(RECOMMENDED.topK);
                setTopP(RECOMMENDED.topP);
                setTemperature(RECOMMENDED.temperature);
                setRepPenalty(RECOMMENDED.repPenalty);
              }}
            >
              {t("synth.paramsReset")}
            </Btn>
          ) : null
        }
      >
        <div className="rounded-[var(--r)] bg-[var(--surface)] shadow-[var(--glass)] p-4 flex flex-col gap-[16px] max-w-[720px]">
          <Field
            label={t("synth.pSpeed")}
            tip={t("synth.pSpeedTip")}
            control={
              <Slider
                value={speed}
                min={0.5}
                max={2}
                step={0.05}
                defaultValue={1}
                onChange={setSpeed}
                format={(v) => `${v.toFixed(2)}x`}
              />
            }
          />
          <Field
            label={t("synth.pTopK")}
            tip={t("synth.pTopKTip")}
            control={<Slider value={topK} min={1} max={100} step={1} onChange={setTopK} />}
          />
          <Field
            label={t("synth.pTopP")}
            tip={t("synth.pTopPTip")}
            control={
              <Slider value={topP} min={0} max={1} step={0.01} onChange={setTopP} format={(v) => v.toFixed(2)} />
            }
          />
          <Field
            label={t("synth.pTemp")}
            tip={t("synth.pTempTip")}
            control={
              <Slider
                value={temperature}
                min={0}
                max={1}
                step={0.01}
                onChange={setTemperature}
                format={(v) => v.toFixed(2)}
              />
            }
          />
          <Field
            label={t("synth.pRep")}
            tip={t("synth.pRepTip")}
            control={
              <Slider
                value={repPenalty}
                min={1}
                max={2}
                step={0.01}
                defaultValue={1.35}
                onChange={setRepPenalty}
                format={(v) => v.toFixed(2)}
              />
            }
          />
        </div>
      </Block>

      <Block title={t("synth.textTitle")}>
        <div className="rounded-[var(--r)] bg-[var(--surface)] shadow-[var(--glass)] p-4 max-w-[860px]">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder={t("synth.textPlaceholder")}
            className="w-full resize-y border-0 outline-none bg-transparent text-[14px] leading-relaxed text-[var(--ink)] placeholder:text-[var(--meta)]"
          />
          <div className="flex items-center gap-3 pt-2 mt-2 border-t border-[var(--hairline)] flex-wrap">
            <span className="text-[12px] text-[var(--meta)] tabular-nums">
              {t("synth.charCount", { n: text.length })}
            </span>
            <span className="text-[12px] px-1.5 py-0.5 rounded-md bg-[var(--stage)] text-[var(--accent)]">
              {t("synth.langAuto")}
            </span>
            <Toggle checked={streaming} onChange={setStreaming} label={t("synth.streaming")} />
            <div className="ml-auto">
              <Btn primary busy={busy} onClick={startSynth} disabled={!text.trim()}>
                {busy ? t("synth.synthesizing") : t("synth.synthesize")}
              </Btn>
            </div>
          </div>
          {progress != null ? (
            <div className="mt-3">
              <div className="h-[6px] rounded-full bg-[color-mix(in_srgb,var(--ink)_8%,transparent)] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-150 ease-[var(--ease)]"
                  style={{ width: `${Math.min(100, progress)}%` }}
                />
              </div>
              <div className="flex items-center gap-4 mt-2 text-[12px] text-[var(--help)] tabular-nums flex-wrap">
                <span>{t("synth.progress", { n: Math.round(Math.min(100, progress)) })}</span>
                {tFirst != null ? (
                  <span>{t("synth.tFirst", { n: Math.round(streaming ? tFirst * 0.45 : tFirst) })}</span>
                ) : null}
                {ref ? (
                  <span className="truncate">
                    {t("synth.usingRef", { name: ref.mood ?? ref.wav, lang: LANG_BADGE[ref.lang] })}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </Block>

      <Block title={t("synth.batchTitle")} note={t("synth.batchNote")}>
        <div className="rounded-[var(--r)] border border-dashed border-[var(--line)] p-6 text-center text-[12.5px] text-[var(--help)] max-w-[860px]">
          {t("synth.batchEmpty")}
        </div>
      </Block>
    </PagePad>
  );
}
