import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PagePad, PageHead, Block, Btn } from "../components/ui";
import { Field, Slider, Toggle } from "../components/controls";
import { ErrorNote } from "../components/ErrorNote";
import { useConfig } from "../hooks/useConfig";
import { t } from "../i18n/t";

/**
 * 合成台 —— GPT-SoVITS Fabric 的核心页面。
 *
 * 角色来自本地角色库（`User_Data/characters/<id>/config.json`），参考音频
 * 来自角色包里的 `.list` 标注（和标注管理页读的是同一份解析结果，见
 * DECISIONS D4），合成走常驻的 synth_worker。
 *
 * 三处和「看起来更漂亮」相反的取舍：
 *
 * 1. **进度条是不定向的。** 上游 `tts.run()` 是个生成器，只知道又出了一段，
 *    不知道总共几段 —— 报一个百分比就是在编。所以这里只报确定知道的：
 *    首包多少毫秒、已出几段、已用多少秒。
 * 2. **文件不在的参考行不能选。** `.list` 里指向的 wav 缺失是常事（数据集
 *    搬过目录）。让它可选，用户点下去只会拿到一句引擎的报错。
 * 3. **换角色就回到该角色包的推荐参数。** 参数是作者随包给的，跨角色沿用
 *    上一个角色的 temperature 没有意义。
 *
 * 浏览器预览模式（无 Tauri 外壳）下用内置样例数据，只为看排版，合成不可用。
 */

type AnnotRow = {
  line: number;
  wav: string;
  speaker: string;
  lang: string;
  text: string;
  abs: string;
  exists: boolean;
  issues: string[];
};

type ListFile = { file: string; lang: string; note: string; rows: AnnotRow[] };

type RoleParams = {
  speed?: number;
  top_k?: number;
  top_p?: number;
  temperature?: number;
  repetition_penalty?: number;
};

type Role = {
  id: string;
  name: string;
  author: string;
  version: string;
  cover: string;
  cover_exists: boolean;
  params: RoleParams;
  lists: ListFile[];
  dir: string;
};

/** 参考候选：`.list` 的一行，加上它属于哪个标注文件。 */
type RefRow = AnnotRow & { from: string };

type Params = Required<RoleParams>;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 上游没给推荐值时的兜底。和 synth_worker.py 的默认值一致。 */
const FALLBACK: Params = {
  speed: 1.0,
  top_k: 15,
  top_p: 1.0,
  temperature: 1.0,
  repetition_penalty: 1.35,
};

const LANG_BADGE: Record<string, string> = {
  zh: "中",
  all_zh: "中",
  ja: "日",
  all_ja: "日",
  en: "英",
  ko: "韩",
  all_ko: "韩",
  yue: "粤",
  auto: "自",
};

function langBadge(lang: string): string {
  const k = (lang || "").toLowerCase();
  return LANG_BADGE[k] ?? (k ? k.slice(0, 2).toUpperCase() : "?");
}

/** 没有封面图时按 id 取一个稳定的色相 —— 同一个角色每次打开都是同一种颜色。 */
function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

function recommendedOf(role: Role | null): Params {
  const p = role?.params ?? {};
  return {
    speed: typeof p.speed === "number" ? p.speed : FALLBACK.speed,
    top_k: typeof p.top_k === "number" ? p.top_k : FALLBACK.top_k,
    top_p: typeof p.top_p === "number" ? p.top_p : FALLBACK.top_p,
    temperature: typeof p.temperature === "number" ? p.temperature : FALLBACK.temperature,
    repetition_penalty:
      typeof p.repetition_penalty === "number" ? p.repetition_penalty : FALLBACK.repetition_penalty,
  };
}

function refsOf(role: Role | null): RefRow[] {
  if (!role) return [];
  const out: RefRow[] = [];
  for (const l of role.lists ?? []) {
    for (const r of l.rows ?? []) {
      if (!r.wav || !r.text.trim()) continue;
      out.push({ ...r, from: l.file, lang: r.lang || l.lang || "zh" });
    }
  }
  return out;
}

function demoRoles(): Role[] {
  const mk = (
    id: string,
    name: string,
    rows: [string, string, string][],
  ): Role => ({
    id,
    name,
    author: "图灵镜官方",
    version: "v2ProPlus",
    cover: "",
    cover_exists: false,
    params: {},
    dir: `characters/${id}`,
    lists: [
      {
        file: "voice.list",
        lang: "zh",
        note: "",
        rows: rows.map(([wav, text, lang], i) => ({
          line: i + 1,
          wav,
          speaker: name,
          lang,
          text,
          abs: `characters/${id}/dataset/${wav}`,
          exists: true,
          issues: [],
        })),
      },
    ],
  });
  return [
    mk("tendou_alice", "天童爱丽丝", [
      ["audios/jp_title.ogg", "ブルーアーカイブ", "ja"],
      ["audios/zh_supply.wav", "哇！是新的补给品！", "zh"],
      ["audios/zh_hurt.wav", "机体出现异常……", "zh"],
    ]),
    mk("hoshino", "小鸟游星野", [
      ["audios/jp_login.ogg", "おはよう、先生……", "ja"],
      ["audios/zh_skill.wav", "要上了哦，大家掩护我！", "zh"],
    ]),
    mk("serika", "黑见芹香", [
      ["audios/zh_tsukkomi.wav", "又来？真是服了你了。", "zh"],
      ["audios/jp_battle.ogg", "逃げても無駄だよ！", "ja"],
    ]),
  ];
}

export function SynthPage() {
  const c = useConfig();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [roleId, setRoleId] = useState("");
  const [refKey, setRefKey] = useState("");

  const [text, setText] = useState("");
  const [params, setParams] = useState<Params>(FALLBACK);
  const [streaming, setStreaming] = useState(true);

  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [chunks, setChunks] = useState(0);
  const [tFirst, setTFirst] = useState<number | null>(null);
  const [tTotal, setTTotal] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [out, setOut] = useState("");
  const [err, setErr] = useState("");
  const [playing, setPlaying] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const startedAt = useRef(0);
  /** 配置只在第一次读到时灌进来一次，之后以界面为准，免得写盘回声把滑块拽回去。 */
  const seeded = useRef(false);

  // —— 角色库 ——
  useEffect(() => {
    let alive = true;
    if (!isTauri()) {
      setRoles(demoRoles());
      return;
    }
    invoke<{ roles: Role[] }>("synth_characters")
      .then((r) => alive && setRoles(r?.roles ?? []))
      .catch((e) => {
        if (!alive) return;
        setRoles([]);
        setErr(String(e));
      });
    return () => {
      alive = false;
    };
  }, [reloadTick]);

  const role = useMemo(
    () => (roles ?? []).find((r) => r.id === roleId) ?? (roles ?? [])[0] ?? null,
    [roles, roleId],
  );
  const recommended = useMemo(() => recommendedOf(role), [role]);
  const refs = useMemo(() => refsOf(role), [role]);
  const ref = useMemo(
    () => refs.find((r) => `${r.from}#${r.line}` === refKey) ?? refs.find((r) => r.exists) ?? null,
    [refs, refKey],
  );

  // 首次加载：上次用的角色、上次用的参数。角色没了就落到第一个。
  useEffect(() => {
    if (seeded.current || !c.loaded || !roles) return;
    seeded.current = true;
    const saved = c.str("synth_role");
    if (saved && roles.some((r) => r.id === saved)) setRoleId(saved);
    setStreaming(c.cfg.synth_streaming !== false);
    setParams({
      speed: c.num("synth_speed", FALLBACK.speed),
      top_k: c.num("synth_top_k", FALLBACK.top_k),
      top_p: c.num("synth_top_p", FALLBACK.top_p),
      temperature: c.num("synth_temperature", FALLBACK.temperature),
      repetition_penalty: c.num("synth_rep_penalty", FALLBACK.repetition_penalty),
    });
  }, [c, roles]);

  const setParam = useCallback(
    (key: keyof Params, cfgKey: string) => (v: number) => {
      setParams((p) => ({ ...p, [key]: v }));
      void c.set(cfgKey, v);
    },
    [c],
  );

  const pickRole = useCallback(
    (r: Role) => {
      setRoleId(r.id);
      setRefKey("");
      // 参数随包走：作者给的推荐值才是这个角色该有的起点。
      setParams(recommendedOf(r));
      void c.set("synth_role", r.id);
      void c.set("synth_speed", recommendedOf(r).speed);
      void c.set("synth_top_k", recommendedOf(r).top_k);
      void c.set("synth_top_p", recommendedOf(r).top_p);
      void c.set("synth_temperature", recommendedOf(r).temperature);
      void c.set("synth_rep_penalty", recommendedOf(r).repetition_penalty);
    },
    [c],
  );

  // —— 引擎事件 ——
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const offs: Array<() => void> = [];
    const keep = (p: Promise<() => void>) =>
      void p.then((fn) => (alive ? offs.push(fn) : fn()));

    keep(
      listen<{ seq?: number; sec?: number }>("synth-chunk", (ev) => {
        if (!alive) return;
        const seq = ev.payload?.seq ?? 0;
        setChunks(seq + 1);
        // 第一段落地的那一刻就是首包延迟，用引擎自己报的秒数，不用界面猜。
        if (seq === 0 && typeof ev.payload?.sec === "number") {
          setTFirst(Math.round(ev.payload.sec * 1000));
        }
      }),
    );
    keep(
      listen<{ t_first_ms?: number; t_total_ms?: number }>("synth-done", (ev) => {
        if (!alive) return;
        if (typeof ev.payload?.t_first_ms === "number" && ev.payload.t_first_ms > 0) {
          setTFirst(ev.payload.t_first_ms);
        }
        if (typeof ev.payload?.t_total_ms === "number") setTTotal(ev.payload.t_total_ms);
      }),
    );
    return () => {
      alive = false;
      offs.forEach((fn) => fn());
    };
  }, []);

  // 「已用 x.x s」：合成期间才走，停了就不再占用一个定时器。
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => {
      setElapsed((performance.now() - startedAt.current) / 1000);
    }, 200);
    return () => window.clearInterval(id);
  }, [busy]);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  const startSynth = useCallback(async () => {
    if (busy || !text.trim() || !role || !ref) return;
    if (!isTauri()) {
      setErr(t("synth.previewOnly"));
      return;
    }
    setBusy(true);
    setCancelling(false);
    setChunks(0);
    setTFirst(null);
    setTTotal(null);
    setElapsed(0);
    setOut("");
    setErr("");
    startedAt.current = performance.now();
    try {
      const r = await invoke<{ cancelled?: boolean; out?: string }>("synth_start", {
        roleId: role.id,
        roleDir: role.dir,
        version: role.version,
        text: text.trim(),
        refWav: ref.abs,
        refText: ref.text,
        refLang: ref.lang,
        params,
        streaming,
      });
      if (r?.cancelled) setOut("");
      else if (r?.out) setOut(r.out);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
      setCancelling(false);
    }
  }, [busy, text, role, ref, params, streaming]);

  const cancelSynth = useCallback(() => {
    if (!busy || cancelling) return;
    setCancelling(true);
    void invoke("synth_cancel").catch((e) => setErr(String(e)));
  }, [busy, cancelling]);

  const togglePlay = useCallback(() => {
    if (!out) return;
    if (playing) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlaying(false);
      return;
    }
    try {
      const a = new Audio(isTauri() ? convertFileSrc(out) : out);
      a.onended = () => setPlaying(false);
      a.onerror = () => {
        setPlaying(false);
        setErr(t("synth.playFailed"));
      };
      audioRef.current = a;
      void a.play();
      setPlaying(true);
    } catch (e) {
      setErr(String(e));
    }
  }, [out, playing]);

  const paramsDirty = (Object.keys(recommended) as Array<keyof Params>).some(
    (k) => params[k] !== recommended[k],
  );

  const empty = roles != null && roles.length === 0;

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

      {err ? <ErrorNote text={err} /> : null}

      <Block
        title={t("synth.roleTitle")}
        note={t("synth.roleNote")}
        action={<Btn onClick={() => setReloadTick((n) => n + 1)}>{t("synth.roleRefresh")}</Btn>}
      >
        {empty ? (
          <div className="rounded-[var(--r)] border border-dashed border-[var(--line)] p-6 text-center text-[12.5px] text-[var(--help)]">
            {t("synth.roleEmpty")}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[10px]">
            {(roles ?? []).map((r) => {
              const on = r.id === role?.id;
              const hue = hueOf(r.id);
              const cover = r.cover_exists && isTauri() ? convertFileSrc(`${r.dir}/${r.cover}`) : "";
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => pickRole(r)}
                  className={[
                    "text-left rounded-[var(--r)] p-2.5 cursor-pointer border-0 transition-all duration-200 ease-[var(--ease)]",
                    "active:scale-[0.97]",
                    on
                      ? "shadow-[inset_0_0_0_2px_var(--accent)] bg-[var(--accent-soft)]"
                      : "bg-[var(--group)] hover:bg-[color-mix(in_srgb,var(--ink)_5%,transparent)]",
                  ].join(" ")}
                >
                  <div
                    className="w-full aspect-[5/3] rounded-[calc(var(--r)-4px)] mb-2 relative overflow-hidden bg-center bg-cover"
                    style={
                      cover
                        ? { backgroundImage: `url("${cover}")` }
                        : {
                            background: `linear-gradient(135deg, hsl(${hue} 62% 72%), hsl(${hue + 30} 55% 58%))`,
                          }
                    }
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
        )}
      </Block>

      <Block title={t("synth.refTitle")} titleTip={t("synth.refTip")} note={t("synth.refNote")}>
        {refs.length === 0 ? (
          // 角色还没选（或库里根本没有角色）时不能说「这个角色包里没有」——
          // 没有「这个角色包」。两句话分开讲。
          <div className="rounded-[var(--r)] border border-dashed border-[var(--line)] p-6 text-center text-[12.5px] text-[var(--help)]">
            {role ? t("synth.refEmpty") : t("synth.refNoRole")}
          </div>
        ) : (
          <div className="rounded-[var(--r)] overflow-hidden bg-[var(--group)]">
            {refs.map((row, i) => {
              const key = `${row.from}#${row.line}`;
              const on = ref != null && key === `${ref.from}#${ref.line}`;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={!row.exists}
                  onClick={() => setRefKey(key)}
                  className={[
                    "w-full text-left px-3.5 py-2.5 border-0 flex items-center gap-3 transition-colors duration-150",
                    row.exists ? "cursor-pointer" : "cursor-not-allowed opacity-55",
                    i > 0 ? "border-t border-[var(--hairline)]" : "",
                    on
                      ? "bg-[var(--accent-soft)]"
                      : "hover:bg-[color-mix(in_srgb,var(--ink)_4%,transparent)]",
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
                      {row.from} · {row.wav}
                    </span>
                  </span>
                  {!row.exists ? (
                    <span className="shrink-0 text-[11px] px-1.5 py-0.5 rounded-full text-[#c44] bg-[color-mix(in_srgb,#c44_10%,transparent)]">
                      {t("synth.refMissing")}
                    </span>
                  ) : null}
                  <span className="shrink-0 w-[20px] h-[20px] rounded-[6px] grid place-items-center text-[10.5px] bg-[var(--stage)] text-[var(--accent)] font-semibold">
                    {langBadge(row.lang)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Block>

      <Block
        title={t("synth.paramsTitle")}
        note={paramsDirty ? t("synth.paramsEdited") : t("synth.paramsFromPack")}
        action={
          paramsDirty ? (
            <Btn
              onClick={() => {
                setParams(recommended);
                void c.set("synth_speed", recommended.speed);
                void c.set("synth_top_k", recommended.top_k);
                void c.set("synth_top_p", recommended.top_p);
                void c.set("synth_temperature", recommended.temperature);
                void c.set("synth_rep_penalty", recommended.repetition_penalty);
              }}
            >
              {t("synth.paramsReset")}
            </Btn>
          ) : null
        }
      >
        <div className="rounded-[var(--r)] bg-[var(--group)] p-4 flex flex-col gap-[16px]">
          <Field
            label={t("synth.pSpeed")}
            tip={t("synth.pSpeedTip")}
            control={
              <Slider
                value={params.speed}
                min={0.5}
                max={2}
                step={0.05}
                defaultValue={recommended.speed}
                onChange={setParam("speed", "synth_speed")}
                format={(v) => `${v.toFixed(2)}x`}
              />
            }
          />
          <Field
            label={t("synth.pTopK")}
            tip={t("synth.pTopKTip")}
            control={
              <Slider
                value={params.top_k}
                min={1}
                max={100}
                step={1}
                defaultValue={recommended.top_k}
                onChange={setParam("top_k", "synth_top_k")}
              />
            }
          />
          <Field
            label={t("synth.pTopP")}
            tip={t("synth.pTopPTip")}
            control={
              <Slider
                value={params.top_p}
                min={0}
                max={1}
                step={0.01}
                defaultValue={recommended.top_p}
                onChange={setParam("top_p", "synth_top_p")}
                format={(v) => v.toFixed(2)}
              />
            }
          />
          <Field
            label={t("synth.pTemp")}
            tip={t("synth.pTempTip")}
            control={
              <Slider
                value={params.temperature}
                min={0}
                max={1}
                step={0.01}
                defaultValue={recommended.temperature}
                onChange={setParam("temperature", "synth_temperature")}
                format={(v) => v.toFixed(2)}
              />
            }
          />
          <Field
            label={t("synth.pRep")}
            tip={t("synth.pRepTip")}
            control={
              <Slider
                value={params.repetition_penalty}
                min={1}
                max={2}
                step={0.01}
                defaultValue={recommended.repetition_penalty}
                onChange={setParam("repetition_penalty", "synth_rep_penalty")}
                format={(v) => v.toFixed(2)}
              />
            }
          />
        </div>
      </Block>

      <Block title={t("synth.textTitle")}>
        <div className="rounded-[var(--r)] bg-[var(--group)] p-4">
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
            <Toggle
              checked={streaming}
              onChange={(v) => {
                setStreaming(v);
                void c.set("synth_streaming", v);
              }}
              label={t("synth.streaming")}
            />
            <div className="ml-auto flex items-center gap-2">
              {busy ? (
                <Btn onClick={cancelSynth} disabled={cancelling}>
                  {cancelling ? t("synth.cancelling") : t("synth.cancel")}
                </Btn>
              ) : null}
              <Btn
                primary
                busy={busy}
                onClick={() => void startSynth()}
                disabled={!text.trim() || !role || !ref}
              >
                {busy ? t("synth.synthesizing") : t("synth.synthesize")}
              </Btn>
            </div>
          </div>

          {busy || out ? (
            <div className="mt-3">
              <div className="h-[6px] rounded-full bg-[color-mix(in_srgb,var(--ink)_8%,transparent)] overflow-hidden">
                <div
                  className={[
                    "h-full rounded-full bg-[var(--accent)]",
                    // 引擎报不出总量，所以这条是「在动」而不是「到了几成」。
                    busy ? "w-1/3 dock-bar-indeterminate" : "w-full",
                  ].join(" ")}
                />
              </div>
              <div className="flex items-center gap-4 mt-2 text-[12px] text-[var(--help)] tabular-nums flex-wrap">
                {tFirst != null ? <span>{t("synth.tFirst", { n: tFirst })}</span> : null}
                {chunks > 0 ? <span>{t("synth.chunks", { n: chunks })}</span> : null}
                <span>
                  {t("synth.elapsed", {
                    n: ((tTotal != null && !busy ? tTotal / 1000 : elapsed) || 0).toFixed(1),
                  })}
                </span>
                {ref ? (
                  <span className="truncate">
                    {t("synth.usingRef", { name: ref.wav, lang: langBadge(ref.lang) })}
                  </span>
                ) : null}
              </div>
              {out && !busy ? (
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <Btn onClick={togglePlay}>{playing ? t("synth.stop") : t("synth.play")}</Btn>
                  <Btn onClick={() => void invoke("synth_reveal_output").catch(() => {})}>
                    {t("synth.openOutDir")}
                  </Btn>
                  <span className="text-[11.5px] text-[var(--meta)] truncate min-w-0">{out}</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Block>
    </PagePad>
  );
}
