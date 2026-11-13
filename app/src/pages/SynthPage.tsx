import { peekCharacters, readCharacters, type Character as Role, type AnnotRow } from "../lib/characters";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PagePad, PageHead, Btn } from "../components/ui";
import { Field, Select, Slider, Toggle } from "../components/controls";
import { Collapse } from "../components/Presence";
import { SynthResults, type OutFormat, type SynthRecord } from "../components/SynthResults";
import { ErrorNote } from "../components/ErrorNote";
import { useConfig } from "../hooks/useConfig";
import { useAudioPreview } from "../hooks/useAudioPreview";
import { referenceKey, findReference, referenceConfigKey, roleReferences } from "../lib/roleReferences";
import { useRoleParams } from "../hooks/useRoleParams";
import { SYNTH_DEFAULTS } from "../lib/synthRoleParams";
import { t } from "../i18n/t";
import { goTo, onHandoff, openInAnnot, take } from "../lib/intent";
import { artOf } from "trm-ui";
import { Icon, Pager, SearchBox, SegmentControl, useDir, usePaged } from "../trm";
import { CatalogTransition } from "../components/CatalogTransition";
import { HelpMark } from "../components/Tooltip";
import { VulkanResourceAction } from "../components/VulkanResourceAction";
import { getAssetsStatus, type AssetsStatus } from "../lib/downloadModels";
import { useExtraJobs } from "../lib/extraJobs";

/**
 * 合成台 —— GPT-SoVITS Fabric 的核心页面。
 *
 * 角色来自本地角色库（`User_Data/characters/<id>/config.json`），参考音频
 * 来自角色包里的 `.list` 标注（和标注管理页读的是同一份解析结果，见
 * DECISIONS D4），合成通过共享任务入口选择推理引擎。
 *
 * 三处和「看起来更漂亮」相反的取舍：
 *
 * 1. **进度条是不定向的。** 上游 `tts.run()` 是个生成器，只知道又出了一段，
 *    不知道总共几段，报百分比就是在编。所以这里只报确定知道的：
 *    已生成几段、第一段和全部各用了多少秒。
 * 2. **文件不在的参考行不能选。** `.list` 里指向的 wav 缺失是常事（数据集
 *    搬过目录）。让它可选，用户点下去只会拿到一句引擎的报错。
 * 3. **参数按角色保存。** 已保存的个人参数优先于角色推荐；未保存的调整只用于当前合成。
 *
 * 浏览器预览模式（无 Tauri 外壳）下用内置样例数据，只为看排版，合成不可用。
 */

type RoleParams = {
  speed?: number;
  top_k?: number;
  top_p?: number;
  temperature?: number;
  repetition_penalty?: number;
};

/** 参考候选：`.list` 的一行，加上它属于哪个标注文件。 */
type RefRow = AnnotRow & { from: string };

type Params = Required<RoleParams>;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 上游 TTS.py 的硬性范围（16 kHz 下 48000–160000 采样）：超出直接报错。 */
const REF_SEC = { min: 3, max: 10 };

/** 时长只读元数据，按路径缓存；切换角色再切回来不重复探测。 */
const durCache = new Map<string, number>();

function probeDuration(src: string): Promise<number> {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = "metadata";
    const done = (v: number) => {
      a.removeAttribute("src");
      a.load();
      resolve(v);
    };
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : NaN);
    a.onerror = () => done(NaN);
    a.src = src;
  });
}

function refFits(sec: number | undefined): boolean {
  return sec == null || Number.isNaN(sec) || (sec >= REF_SEC.min && sec <= REF_SEC.max);
}

/** 参考行的语言名称。`.list` 里常见 zh、ja、all_zh 这类代码，统一按单一语种显示。 */
function refLangKey(lang: string): string | null {
  const k = (lang || "").toLowerCase().replace(/^all_/, "");
  if (k === "en" || k === "auto") return LANG_LABEL[k];
  return LANG_LABEL[`all_${k}`] ?? null;
}

/** 参考音频每页几条。 */
const REF_PAGE = 10;

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
    author: "Kara251",
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

/** 进阶参数。与 synth_worker.py 透传给上游 `TTS.run` 的键一一对应。 */
type Adv = {
  text_lang: string;
  /** 空串表示由引擎按文本长度自动选择。 */
  text_split_method: string;
  fragment_interval: number;
  seed: number;
  seedFixed: boolean;
  /** 空串表示用该版本的缺省步数。 */
  sample_steps: string;
  super_sampling: boolean;
  batch_size: number;
};

const ADV_DEFAULT: Adv = { ...SYNTH_DEFAULTS, batch_size: 1 };

/** 上游 dict_language_v2 的取值；v1 没有粤语和韩语。 */
const TEXT_LANGS = ["auto", "auto_yue", "all_zh", "zh", "en", "all_ja", "ja", "all_yue", "yue", "all_ko", "ko"];
const TEXT_LANGS_V1 = ["auto", "all_zh", "zh", "en", "all_ja", "ja"];
/** 上游 text_segmentation_method.py 的切分方法。 */
const SPLITS = ["cut0", "cut1", "cut2", "cut3", "cut4", "cut5"];
/** 采样步数只对 v3 及之后的版本生效，选项同上游 WebUI。 */
const STEP_VERSIONS = ["v3", "v4", "v5dev", "v5turbo"];
const STEP_OPTIONS = ["4", "8", "16", "32", "64", "128"];

type Mode = "single" | "batch";
type Backend = "cuda" | "vulkan";
const VULKAN_LANGS = new Set(["auto", "zh", "ja", "all_zh", "all_ja"]);
type BatchState = "wait" | "run" | "done" | "fail" | "stop";
type BatchItem = { text: string; state: BatchState; err?: string };

const ITEM_TONE: Record<BatchState, string> = {
  wait: "text-[var(--meta)]",
  run: "text-[var(--accent-text)]",
  done: "text-[var(--accent-text)]",
  fail: "text-[var(--danger-text)]",
  stop: "text-[var(--meta)]",
};

/** 界面文案的 key 写全，i18n 校验才能认出它们在用。 */
const LANG_LABEL: Record<string, string> = {
  auto: "synth.lang_auto",
  auto_yue: "synth.lang_auto_yue",
  all_zh: "synth.lang_all_zh",
  zh: "synth.lang_zh",
  en: "synth.lang_en",
  all_ja: "synth.lang_all_ja",
  ja: "synth.lang_ja",
  all_yue: "synth.lang_all_yue",
  yue: "synth.lang_yue",
  all_ko: "synth.lang_all_ko",
  ko: "synth.lang_ko",
};
const SPLIT_LABEL: Record<string, string> = {
  cut0: "synth.split_cut0",
  cut1: "synth.split_cut1",
  cut2: "synth.split_cut2",
  cut3: "synth.split_cut3",
  cut4: "synth.split_cut4",
  cut5: "synth.split_cut5",
};
const ITEM_LABEL: Record<BatchState, string> = {
  wait: "synth.item_wait",
  run: "synth.item_run",
  done: "synth.item_done",
  fail: "synth.item_fail",
  stop: "synth.item_stop",
};

function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/** 栏标题：与 Block 标题同一字号，但不带上外边距，三栏顶边对齐。 */
function ColHead({ title, note, action }: { title: string; note?: string; action?: ReactNode }) {
  return (
    <div className="flex-none flex items-center gap-2 mb-2.5 min-h-[30px]">
      <h3 className="text-[15px] font-semibold m-0">{title}</h3>
      {note ? <span className="text-[12.5px] text-[var(--meta)] tabular-nums">{note}</span> : null}
      {action ? <div className="ml-auto flex items-center gap-1.5">{action}</div> : null}
    </div>
  );
}

/** 每一栏：宽窗口下各自内部滚动；窄窗口下随整页滚动。 */
const COL = "min-h-0 flex flex-col min-[900px]:overflow-y-auto min-[900px]:overscroll-contain min-[900px]:pr-1";

const keyOf = referenceKey;

export function SynthPage() {
  const c = useConfig();
  const [roles, setRoles] = useState<Role[] | null>(peekCharacters);
  const [reloadTick, setReloadTick] = useState(0);
  const [roleId, setRoleId] = useState("");

  const [mode, setMode] = useState<Mode>("single");
  const [text, setText] = useState("");
  const [batchSize, setBatchSize] = useState(ADV_DEFAULT.batch_size);
  const [advOpen, setAdvOpen] = useState(false);
  const [streaming, setStreaming] = useState(true);
  const [format, setFormat] = useState<OutFormat>("wav");
  const backend: Backend = c.str("synth_backend") === "vulkan" ? "vulkan" : "cuda";
  const vulkan = backend === "vulkan";
  const extraJobs = useExtraJobs();
  const [vulkanAssets, setVulkanAssets] = useState<AssetsStatus | null>(null);

  useEffect(() => {
    if (!vulkan || !isTauri()) return;
    let active = true;
    void getAssetsStatus().then((assets) => {
      if (active) setVulkanAssets(assets);
    });
    return () => { active = false; };
  }, [vulkan, extraJobs.generation]);

  const [batchText, setBatchText] = useState("");
  const [items, setItems] = useState<BatchItem[]>([]);
  const stopBatch = useRef(false);

  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [chunks, setChunks] = useState(0);
  const [tFirst, setTFirst] = useState<number | null>(null);
  const [tTotal, setTTotal] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState("");
  const [resultTick, setResultTick] = useState(0);
  const [latest, setLatest] = useState("");
  const { playing: preview, play: previewAudio, stop: stopPreview, player: previewPlayer } = useAudioPreview();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const startedAt = useRef(0);
  /** 配置只在第一次读到时灌进来一次，之后以界面为准，免得写盘回声把滑块拽回去。 */
  const seeded = useRef(false);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let off: (() => void) | undefined;
    void listen("roles-changed", () => { if (alive) setReloadTick((n) => n + 1); })
      .then((fn) => { if (alive) off = fn; else fn(); }).catch(() => {});
    return () => { alive = false; off?.(); };
  }, []);

  // —— 角色库 ——
  useEffect(() => {
    let alive = true;
    if (!isTauri()) {
      setRoles(demoRoles());
      return;
    }
    readCharacters()
      .then((r) => alive && setRoles(r))
      .catch((e) => {
        if (!alive) return;
        setErr(String(e));
      });
    return () => {
      alive = false;
    };
  }, [reloadTick]);

  const selectedRoleId = roleId || c.str("synth_role");
  const role = useMemo(
    () => roles?.find((r) => r.id === selectedRoleId) ?? roles?.[0] ?? null,
    [roles, selectedRoleId],
  );
  const selection = useMemo(() => roleReferences(c.cfg, role?.id ?? ""), [c.cfg, role?.id]);
  const refKey = selection.primary;
  const auxKeys = selection.auxiliary;
  const setRefKey = (primary: string) => {
    if (role && c.loaded) void c.set(referenceConfigKey(role.id), { ...selection, primary }, true);
  };
  const rp = useRoleParams(role, c.cfg, c.loaded);
  const { setDraft } = rp;
  const params: Params = useMemo(() => ({
    speed: rp.draft.speed, top_k: rp.draft.top_k, top_p: rp.draft.top_p,
    temperature: rp.draft.temperature, repetition_penalty: rp.draft.repetition_penalty,
  }), [rp.draft]);
  const adv: Adv = useMemo(() => ({ ...rp.draft, batch_size: batchSize }), [rp.draft, batchSize]);
  const recommended = rp.recommendation;
  const refs = useMemo(() => refsOf(role), [role]);
  // 参考音频可能有上千条：可搜索、分页显示。
  const [refQuery, setRefQuery] = useState("");
  const shownRefs = useMemo(() => {
    const q = refQuery.trim().toLowerCase();
    return q ? refs.filter((r) => `${r.text} ${r.wav}`.toLowerCase().includes(q)) : refs;
  }, [refs, refQuery]);
  const refPaged = usePaged(shownRefs, REF_PAGE, `${role?.id ?? ""}|${refQuery}`);
  const refDir = useDir(refPaged.page);
  const [durs, setDurs] = useState<Record<string, number>>({});
  const usable = useCallback((r: RefRow) => r.exists && refFits(durs[r.abs]), [durs]);
  const savedRef = useMemo(() => refKey ? findReference(refs, refKey) : undefined, [refs, refKey]);
  const ref = useMemo(() => {
    if (savedRef && usable(savedRef)) return savedRef;
    // 默认优先已确认时长合格的，其次尚未探测完的。
    return (
      refs.find((r) => r.exists && durs[r.abs] != null && refFits(durs[r.abs])) ??
      refs.find(usable) ??
      null
    );
  }, [refs, savedRef, durs, usable]);
  // 辅助参考只取音色，不受 3–10 秒限制，文件在就行。
  const auxRows = useMemo(
    () => auxKeys.map((k) => findReference(refs, k)).filter((r): r is RefRow => !!r && r.exists),
    [auxKeys, refs],
  );

  const langs = role?.version === "v1" ? TEXT_LANGS_V1 : TEXT_LANGS;
  const showSteps = STEP_VERSIONS.includes(role?.version ?? "");
  const showSuper = role?.version === "v3";
  let vulkanReason = "";
  let needsVulkanDownload = false;
  if (vulkan) {
    if (role && role.version.trim().toLowerCase() !== "v5turbo") {
      vulkanReason = t("synth.vulkanRole");
    } else if (auxRows.length > 0) {
      vulkanReason = t("synth.vulkanReference");
    } else if (!VULKAN_LANGS.has(adv.text_lang.trim().toLowerCase()) ||
      (ref && !VULKAN_LANGS.has(ref.lang.trim().toLowerCase()))) {
      vulkanReason = t("synth.vulkanLanguage");
    } else if (vulkanAssets?.gsv_cpp_ready === false) {
      needsVulkanDownload = true;
      vulkanReason = t("synth.vulkanMissing");
    } else if (vulkanAssets?.gsv_cpp_ready !== true) {
      vulkanReason = vulkanAssets == null && isTauri() ? t("s.5fc65af5b3") : t("synth.vulkanUnavailable");
    }
  }
  const runBackend: Backend = vulkanReason ? "cuda" : backend;
  const runWithVulkan = runBackend === "vulkan";

  // 参考音频时长：逐条读元数据，结果随到随显示。
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const todo = refs.filter((r) => r.exists && !durCache.has(r.abs));
    const flush = () =>
      setDurs(Object.fromEntries(refs.filter((r) => durCache.has(r.abs)).map((r) => [r.abs, durCache.get(r.abs)!])));
    flush();
    void (async () => {
      for (const r of todo) {
        const sec = await probeDuration(convertFileSrc(r.abs));
        if (!alive) return;
        durCache.set(r.abs, sec);
        flush();
      }
    })();
    return () => {
      alive = false;
    };
  }, [refs]);

  // 首次加载：上次用的角色、上次用的参数。角色没了就落到第一个。
  useEffect(() => {
    if (seeded.current || !c.loaded || !roles) return;
    seeded.current = true;
    const saved = c.str("synth_role");
    if (saved && roles.some((r) => r.id === saved)) setRoleId(saved);
    setStreaming(c.cfg.synth_streaming !== false);
    setFormat(c.str("synth_format") === "flac" ? "flac" : "wav");
    setBatchSize(c.num("synth_batch_size", ADV_DEFAULT.batch_size));
  }, [c, roles]);

  const setParam = (key: keyof Params) => (v: number) => {
    rp.setDraft((p) => ({ ...p, [key]: v }));
  };
  const setAdvKey = <K extends keyof Adv>(key: K, v: Adv[K]) => {
    if (key === "batch_size") {
      setBatchSize(v as number);
      void c.set("synth_batch_size", v);
    } else rp.setDraft((p) => ({ ...p, [key]: v }));
  };
  const applyParams = useCallback((p: Params) => setDraft((old) => ({ ...old, ...p })), [setDraft]);
  const applyAdv = useCallback((next: Adv) => {
    const { batch_size, ...voice } = next;
    setDraft((old) => ({ ...old, ...voice }));
    setBatchSize(batch_size);
    void c.set("synth_batch_size", batch_size);
  }, [setDraft, c]);
  const pickRole = useCallback((r: Role) => {
    setRoleId(r.id);
    void c.set("synth_role", r.id);
  }, [c]);

  // 别的页面点了「用于合成」：选中那个角色。
  useEffect(() => {
    if (!roles || !c.loaded) return;
    const apply = () => {
      const id = take("synthRole");
      const r = id ? roles.find((x) => x.id === id) : undefined;
      if (r) {
        seeded.current = true;
        pickRole(r);
      }
    };
    apply();
    return onHandoff(apply);
  }, [roles, pickRole, c.loaded]);

  // —— 引擎事件 ——
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const offs: Array<() => void> = [];
    const keep = (p: Promise<() => void>) =>
      void p.then((fn) => (alive ? offs.push(fn) : fn()));

    keep(
      listen<{ seq?: number; sec?: number; owner?: string | null }>("synth-chunk", (ev) => {
        if (!alive || ev.payload.owner != null) return;
        const seq = ev.payload?.seq ?? 0;
        setChunks(seq + 1);
        // 进度里的时间都从点下「开始合成」算起，含首次加载模型，和界面上走的秒数一致。
        if (seq === 0) setTFirst(Math.round(performance.now() - startedAt.current));
      }),
    );
    keep(
      listen<{ owner?: string | null }>("synth-done", (ev) => {
        if (!alive || ev.payload.owner != null) return;
        setTTotal(Math.round(performance.now() - startedAt.current));
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

  useEffect(() => {
    stopPreview();
  }, [role?.id, refPaged.page, refQuery, stopPreview]);
  useEffect(() => {
    previewPlayer.retain(refs.filter(r => r.exists).map(r => r.abs));
  }, [refs, previewPlayer]);
  const playRef = (r: RefRow) => {
    if (isTauri()) previewAudio(r.abs, () => setErr(t("synth.playFailed")));
  };

  const refLang = (code: string) => {
    const k = refLangKey(code);
    return k ? t(k) : code;
  };

  const toggleAux = (r: RefRow) => {
    const k = keyOf(r);
    if (!role || !c.loaded) return;
    const current = auxRows.map(keyOf);
    const auxiliary = current.includes(k) ? current.filter(x => x !== k) : [...current, k];
    void c.set(referenceConfigKey(role.id), { ...selection, auxiliary }, true);
  };

  /** 合成一条。返回 "done" 或 "stop"；出错时抛出。 */
  const runOne = useCallback(
    async (line: string, chosenBackend: Backend): Promise<"done" | "stop"> => {
      const useVulkan = chosenBackend === "vulkan";
      if (!role || !ref) return "stop";
      setCancelling(false);
      setChunks(0);
      setTFirst(null);
      setTTotal(null);
      setElapsed(0);
      startedAt.current = performance.now();
      // 不固定种子时也由界面先抽一个，记录里留下实际用的值，「复用参数」才能复现。
      const seed = adv.seedFixed && adv.seed >= 0 ? adv.seed : randomSeed();
      const sent = {
        ...params,
        text_lang: adv.text_lang,
        text_split_method: adv.text_split_method,
        fragment_interval: adv.fragment_interval,
        batch_size: useVulkan ? ADV_DEFAULT.batch_size : adv.batch_size,
        seed,
        ...(showSteps && adv.sample_steps ? { sample_steps: Number(adv.sample_steps) } : {}),
        ...(showSuper ? { super_sampling: adv.super_sampling } : {}),
      };
      const r = await invoke<{ cancelled?: boolean; out?: string }>("synth_start", {
        roleId: role.id,
        roleDir: role.dir,
        version: role.version,
        text: line,
        refWav: ref.abs,
        refText: ref.text,
        refLang: ref.lang,
        params: sent,
        streaming: !useVulkan && streaming,
        opts: {
          backend: chosenBackend,
          format: useVulkan ? "wav" : format,
          aux_refs: auxRows.map((x) => x.abs),
          role_name: role.name,
        },
      });
      if (r?.out) {
        setLatest(r.out);
        setResultTick((n) => n + 1);
      }
      return r?.cancelled ? "stop" : "done";
    },
    [role, ref, adv, params, streaming, format, auxRows, showSteps, showSuper],
  );

  const ready = Boolean(role && ref) && rp.ready && !busy;

  const startSingle = useCallback(async () => {
    if (!ready || !text.trim()) return;
    if (!isTauri()) {
      setErr(t("synth.previewOnly"));
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await runOne(text.trim(), runBackend);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
      setCancelling(false);
    }
  }, [ready, text, runOne, runBackend]);

  /** 批量：逐条顺序合成。`only` 给出时只跑这些下标（重试失败项）。 */
  const startBatch = useCallback(
    async (list: BatchItem[], only?: number[]) => {
      if (!ready || list.length === 0) return;
      if (!isTauri()) {
        setErr(t("synth.previewOnly"));
        return;
      }
      const todo = only ?? list.map((_, i) => i);
      let cur: BatchItem[] = list.map((it, i) => (todo.includes(i) ? { text: it.text, state: "wait" } : it));
      const put = (i: number, patch: Partial<BatchItem>) => {
        cur = cur.map((it, j) => (j === i ? { ...it, ...patch } : it));
        setItems(cur);
      };
      setItems(cur);
      setBusy(true);
      setErr("");
      stopBatch.current = false;
      try {
        for (const i of todo) {
          if (stopBatch.current) break;
          put(i, { state: "run" });
          try {
            const state = await runOne(cur[i].text, runBackend);
            put(i, { state });
            if (state === "stop") break;
          } catch (e) {
            put(i, { state: "fail", err: String(e) });
          }
        }
      } finally {
        cur = cur.map((it) => (it.state === "wait" || it.state === "run" ? { ...it, state: "stop" } : it));
        setItems(cur);
        setBusy(false);
        setCancelling(false);
      }
    },
    [ready, runOne, runBackend],
  );

  const cancelSynth = useCallback(() => {
    if (!busy || cancelling) return;
    stopBatch.current = true;
    setCancelling(true);
    void invoke("synth_cancel").catch((e) => setErr(String(e)));
  }, [busy, cancelling]);

  const batchLines = useMemo(
    () => batchText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    [batchText],
  );

  const importTxt = (f: File | undefined) => {
    if (!f) return;
    void f.text().then((s) => setBatchText(s.replace(/^﻿/, "")));
  };

  const reuse = useCallback(
    (rec: SynthRecord) => {
      const p = rec.params ?? {};
      const num = (k: string, d: number) => (typeof p[k] === "number" ? (p[k] as number) : d);
      applyParams({
        speed: num("speed", recommended.speed),
        top_k: num("top_k", recommended.top_k),
        top_p: num("top_p", recommended.top_p),
        temperature: num("temperature", recommended.temperature),
        repetition_penalty: num("repetition_penalty", recommended.repetition_penalty),
      });
      applyAdv({
        text_lang: typeof p.text_lang === "string" ? p.text_lang : ADV_DEFAULT.text_lang,
        text_split_method: typeof p.text_split_method === "string" ? p.text_split_method : "",
        fragment_interval: num("fragment_interval", ADV_DEFAULT.fragment_interval),
        seed: num("seed", -1),
        seedFixed: typeof p.seed === "number" && p.seed >= 0,
        sample_steps: typeof p.sample_steps === "number" ? String(p.sample_steps) : "",
        super_sampling: p.super_sampling === true,
        batch_size: num("batch_size", ADV_DEFAULT.batch_size),
      });
      if (rec.text && !busy) {
        setMode("single");
        setText(rec.text);
      }
    },
    [applyParams, applyAdv, recommended, busy],
  );

  const empty = roles != null && roles.length === 0;
  const failed = items.map((it, i) => (it.state === "fail" ? i : -1)).filter((i) => i >= 0);
  const doneCount = items.filter((it) => it.state === "done").length;

  const secs = ((tTotal != null && !busy ? tTotal / 1000 : elapsed) || 0).toFixed(1);
  const progress =
    busy || tTotal != null ? (
      <div className="mt-3">
        <div className="h-[6px] rounded-full bg-[color-mix(in_srgb,var(--ink)_8%,transparent)] overflow-hidden">
          <div
            className={[
              "h-full rounded-full bg-[var(--accent)]",
              // 引擎报不出总量，所以这条是「在动」而不是「到了几成」。
              busy ? "w-1/3 trm-bar-indeterminate" : "w-full",
            ].join(" ")}
          />
        </div>
        <p className="m-0 mt-2 text-[12.5px] text-[var(--help)] tabular-nums leading-relaxed">
          {chunks === 0
            ? t("synth.progressWait", { s: secs })
            : tFirst != null
              ? t("synth.progressFull", { n: chunks, s: secs, f: (tFirst / 1000).toFixed(1) })
              : t("synth.progress", { n: chunks, s: secs })}
        </p>
      </div>
    ) : null;

  const runBar = (count: string, start: () => void, canStart: boolean) => (<>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--meta)]">
        {t("synth.backend")}
        <HelpMark title={t("synth.backendTip")} />
      </span>
      <div role="group" aria-label={t("synth.backend")}>
        <SegmentControl<Backend>
          role="group"
          value={backend}
          options={[
            { id: "cuda", label: "CUDA", disabled: busy || !c.loaded },
            { id: "vulkan", label: "Vulkan", disabled: busy || !c.loaded },
          ]}
          onChange={(next) => {
            if (busy || !c.loaded) return;
            setErr("");
            void c.set("synth_backend", next, true);
          }}
        />
      </div>
    </div>
    {vulkanReason ? (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p role="status" className="m-0 text-[12.5px] leading-relaxed text-[var(--help)]">{vulkanReason}</p>
        {needsVulkanDownload ? <VulkanResourceAction jobs={extraJobs} disabled={busy} /> : null}
      </div>
    ) : null}
    <div className="flex items-center gap-3 mt-3 flex-wrap">
      <span className="text-[12.5px] text-[var(--meta)] tabular-nums">{count}</span>
      <Toggle
        checked={!runWithVulkan && streaming}
        disabled={runWithVulkan || busy}
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
        <Btn primary busy={busy} onClick={start} disabled={!canStart}>
          {busy ? t("synth.synthesizing") : vulkanReason ? t("synth.useCuda") : t("synth.synthesize")}
        </Btn>
      </div>
    </div>
  </>);

  const textArea = (value: string, onChange: (v: string) => void, placeholder: string) => (
    <textarea
      value={value}
      disabled={busy && mode === "batch"}
      onChange={(e) => onChange(e.target.value)}
      rows={6}
      placeholder={placeholder}
      className="w-full resize-y border-0 outline-none bg-transparent text-[13px] leading-relaxed text-[var(--ink)] placeholder:text-[var(--meta)]"
    />
  );

  return (
    <PagePad fill>
      <PageHead
        title={t("synth.title")}
        actions={
          <div className="flex items-center gap-2">
            {!isTauri() ? (
              <span className="text-[12.5px] px-2 py-1 rounded-[var(--rs)] bg-[var(--accent-soft)] text-[var(--accent-text)]">
                {t("synth.demoBadge")}
              </span>
            ) : null}
            <SegmentControl<Mode>
              value={mode}
              onChange={(m) => !busy && setMode(m)}
              options={[
                { id: "single", label: t("synth.modeSingle"), disabled: busy && mode !== "single" },
                { id: "batch", label: t("synth.modeBatch"), disabled: busy && mode !== "batch" },
              ]}
            />
          </div>
        }
      />

      {err || rp.error || c.error ? <ErrorNote text={err || rp.error || c.error} /> : null}

      {/* 角色条：选择在这里，管理去模型页。 */}
      <div className="flex-none mt-[22px] flex items-center gap-3.5 rounded-[var(--r)] bg-[var(--group)] p-2.5 pr-3.5 flex-wrap">
        {empty || !role ? (
          <span className="flex-1 px-1.5 text-[12.5px] text-[var(--help)]">{t("synth.roleEmpty")}</span>
        ) : (
          <>
            <div
              className="w-[72px] aspect-[5/3] shrink-0 rounded-[calc(var(--r)-4px)] bg-center bg-cover"
              style={
                role.cover_exists && isTauri()
                  ? { backgroundImage: `url("${convertFileSrc(`${role.dir}/${role.cover}`)}")` }
                  : { background: artOf(role.id) }
              }
            />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium leading-tight truncate">{role.name}</div>
              <div className="text-[12.5px] text-[var(--meta)] mt-1 truncate">
                {role.author
                  ? t("synth.roleMetaAuthor", { v0: role.version, v1: role.author })
                  : t("synth.roleMetaNoAuthor", { v0: role.version })}
              </div>
            </div>
            <Select
              width={220}
              value={role.id}
              disabled={busy}
              options={(roles ?? []).map((r) => ({ id: r.id, label: r.name }))}
              onChange={(id) => {
                const r = (roles ?? []).find((x) => x.id === id);
                if (r) pickRole(r);
              }}
            />
          </>
        )}
        <Btn onClick={() => setReloadTick((n) => n + 1)}>{t("synth.roleRefresh")}</Btn>
        <Btn onClick={() => goTo("models")}>{t("synth.roleManage")}</Btn>
      </div>

      <div className="mt-[18px] flex-1 min-h-0 grid gap-[18px] grid-cols-1 min-[900px]:grid-cols-[minmax(220px,280px)_minmax(0,1fr)_minmax(240px,300px)] min-[900px]:pb-[22px]">
        {/* 左栏：参考音频 */}
        <div className={COL}>
          <ColHead
            title={t("synth.refTitle")}
            note={refQuery ? `${shownRefs.length} / ${refs.length}` : t("synth.refCount", { v0: refs.length })}
            action={
              role && role.lists.length ? (
                <Btn onClick={() => openInAnnot(`${role.dir}/${ref?.from ?? role.lists[0].file}`)}>{t("synth.refEdit")}</Btn>
              ) : undefined
            }
          />
          {refs.length > REF_PAGE ? (
            <div className="flex-none mb-2">
              <SearchBox value={refQuery} onChange={setRefQuery} />
            </div>
          ) : null}
          {refs.length === 0 ? (
            <div className="rounded-[var(--r)] border border-dashed border-[var(--line)] p-5 text-center text-[12.5px] text-[var(--help)]">
              {role ? t("synth.refEmpty") : t("synth.refNoRole")}
            </div>
          ) : (
            <>
              <CatalogTransition scope={`${role?.id ?? ""}|${refQuery}`} page={refPaged.page} dir={refDir || 1}>
                <div className="rounded-[var(--r)] overflow-hidden bg-[var(--group)]">
                  {refPaged.slice.map((row, i) => {
                    const key = keyOf(row);
                    const on = ref != null && key === keyOf(ref);
                    const isAux = auxRows.some(r => keyOf(r) === key);
                    const sec = durs[row.abs];
                    const ok = usable(row);
                    return (
                      <div
                        key={`${key}:${row.line}`}
                        role="button"
                        tabIndex={ok ? 0 : -1}
                        aria-disabled={!ok || undefined}
                        onClick={() => ok && setRefKey(key)}
                        onKeyDown={(e) => e.key === "Enter" && ok && setRefKey(key)}
                        className={[
                          "group px-2.5 py-2 flex items-center gap-2 transition-colors duration-200 outline-none",
                          ok ? "cursor-pointer" : "cursor-not-allowed",
                          i > 0 ? "border-t border-[var(--hairline)]" : "",
                          on ? "bg-[var(--accent-soft)]" : "hover:bg-[color-mix(in_srgb,var(--ink)_4%,transparent)]",
                        ].join(" ")}
                      >
                        <button
                          type="button"
                          disabled={!row.exists}
                          aria-label={preview === row.abs ? t("synth.stop") : t("synth.play")}
                          onClick={(e) => {
                            e.stopPropagation();
                            playRef(row);
                          }}
                          className={[
                            "shrink-0 w-[22px] h-[22px] rounded-full grid place-items-center border-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40",
                            preview === row.abs || on
                              ? "bg-[var(--accent-fill)] text-[var(--accent-ink)]"
                              : "bg-[color-mix(in_srgb,var(--ink)_8%,transparent)] text-[var(--ink-muted)]",
                          ].join(" ")}
                        >
                          <Icon name={preview === row.abs ? "close" : "play"} size={11} />
                        </button>
                        <span className={["min-w-0 flex-1", ok ? "" : "opacity-55"].join(" ")}>
                          <span className="block text-[12.5px] leading-snug truncate">{row.text}</span>
                          <span className="block text-[11.5px] text-[var(--meta)] truncate mt-0.5 tabular-nums">
                            {!row.exists
                              ? t("synth.refMissing")
                              : sec != null && !Number.isNaN(sec)
                                ? t(ok ? "synth.refMeta" : "synth.refMetaBad", { lang: refLang(row.lang), sec: sec.toFixed(1) })
                                : refLang(row.lang)}
                          </span>
                        </span>
                        {row.exists && !on && !runWithVulkan ? (
                          <button
                            type="button"
                            title={isAux ? t("synth.auxRemove") : t("synth.auxAdd")}
                            aria-label={isAux ? t("synth.auxRemove") : t("synth.auxAdd")}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleAux(row);
                            }}
                            className={[
                              "shrink-0 w-[22px] h-[22px] rounded-[var(--rs)] grid place-items-center border-0 cursor-pointer transition-opacity",
                              isAux
                                ? "bg-[var(--accent-soft)] text-[var(--accent-text)]"
                                : "bg-transparent text-[var(--meta)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                            ].join(" ")}
                          >
                            <Icon name={isAux ? "check" : "plus"} size={12} />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </CatalogTransition>
              <Pager page={refPaged.page} pages={refPaged.pages} onChange={refPaged.setPage} />
            </>
          )}
          {!runWithVulkan ? <div className="flex-none mt-3">
            <div className="flex items-center gap-1.5 text-[12.5px] font-medium mb-1.5">
              {t("synth.auxTitle")}
              <span className="text-[11.5px] font-normal text-[var(--meta)]">{auxRows.length}</span>
            </div>
            {auxRows.length === 0 ? (
              <p className="m-0 text-[12.5px] text-[var(--help)] leading-relaxed">{t("synth.auxEmpty")}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {auxRows.map((r) => (
                  <span
                    key={keyOf(r)}
                    className="inline-flex items-center gap-1 max-w-full pl-2 pr-1 py-0.5 rounded-full bg-[var(--group)] text-[12.5px]"
                  >
                    <span className="truncate max-w-[180px]">{r.text}</span>
                    <button
                      type="button"
                      aria-label={t("synth.auxRemove")}
                      onClick={() => toggleAux(r)}
                      className="w-[18px] h-[18px] grid place-items-center rounded-full border-0 bg-transparent text-[var(--meta)] cursor-pointer hover:text-[var(--ink)]"
                    >
                      <Icon name="close" size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div> : null}
        </div>

        {/* 中栏：文本与参数 */}
        <div className={COL}>
          <CatalogTransition scope={mode} order={["single", "batch"]}>
          <ColHead
            title={mode === "single" ? t("synth.textTitle") : t("synth.batchTitle")}
            note={mode === "batch" && items.length ? `${doneCount} / ${items.length}` : undefined}
            action={
              mode === "batch" ? (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".txt,text/plain"
                    className="hidden"
                    onChange={(e) => {
                      importTxt(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                  <Btn disabled={busy} onClick={() => fileRef.current?.click()}>{t("synth.batchImport")}</Btn>
                </>
              ) : undefined
            }
          />
          <div className="flex-none rounded-[var(--r)] bg-[var(--group)] p-3.5">
            {mode === "single"
              ? textArea(text, setText, t("synth.textPlaceholder"))
              : textArea(batchText, setBatchText, t("synth.batchPlaceholder"))}
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <span className="text-[12.5px] text-[var(--meta)]">{t("synth.textLang")}</span>
              <Select
                width={150}
                value={langs.includes(adv.text_lang) ? adv.text_lang : "auto"}
                options={langs.map((l) => ({ id: l, label: t(LANG_LABEL[l]) }))}
                onChange={(v) => setAdvKey("text_lang", v)}
              />
              <span className="text-[12.5px] text-[var(--meta)] ml-2">{t("synth.split")}</span>
              <Select
                width={170}
                value={adv.text_split_method}
                options={[
                  { id: "", label: t("synth.splitAuto") },
                  ...SPLITS.map((s) => ({ id: s, label: t(SPLIT_LABEL[s]) })),
                ]}
                onChange={(v) => setAdvKey("text_split_method", v)}
              />
            </div>
            {mode === "single"
              ? runBar(t("synth.charCount", { n: text.length }), () => void startSingle(), ready && !!text.trim())
              : runBar(
                  t("synth.batchCount", { n: batchLines.length }),
                  () => void startBatch(batchLines.map((l) => ({ text: l, state: "wait" }))),
                  ready && batchLines.length > 0,
                )}
            {progress}
          </div>

          {mode === "batch" && items.length ? (
            <div className="flex-none mt-3">
              <div className="flex items-center gap-2 mb-1.5 min-h-[30px]">
                <span className="text-[12.5px] font-medium">{t("synth.batchList")}</span>
                {failed.length && !busy ? (
                  <span className="ml-auto">
                    <Btn disabled={!ready} onClick={() => void startBatch(items, failed)}>
                      {vulkanReason ? t("synth.retryCuda", { n: failed.length }) : t("synth.batchRetry", { n: failed.length })}
                    </Btn>
                  </span>
                ) : null}
              </div>
              <div className="rounded-[var(--r)] bg-[var(--group)] overflow-hidden max-h-[260px] overflow-y-auto">
                {items.map((it, i) => (
                  <div
                    key={i}
                    title={it.err}
                    className="flex items-center gap-2.5 px-3 py-1.5 text-[12.5px]"
                  >
                    <span className="w-[22px] shrink-0 text-[11.5px] text-[var(--meta)] tabular-nums">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{it.text}</span>
                    <span className={`shrink-0 text-[11.5px] ${ITEM_TONE[it.state]}`}>{t(ITEM_LABEL[it.state])}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          </CatalogTransition>
          <div className="flex-none mt-3 rounded-[var(--r)] bg-[var(--group)] p-3.5">
            <div className="flex items-center flex-wrap gap-2 mb-3 min-h-[30px]">
              <span className="text-[13px] font-medium">{t("synth.paramsTitle")}</span>
              <span className="text-[11.5px] text-[var(--meta)]">
                {rp.dirty ? t("synth.paramsEdited") : rp.source === "saved" ? t("synth.paramsSaved") : rp.source === "recommended" ? t("synth.paramsFromPack") : t("synth.paramsDefault")}
              </span>
              <span className="ml-auto flex gap-2 flex-wrap">
                <Btn disabled={!role || !rp.ready || rp.saving || busy} onClick={() => void rp.save()}>{t("synth.paramsSave")}</Btn>
                <Btn disabled={!role || !rp.ready || rp.saving || busy} onClick={() => void rp.restore()}>{t("synth.paramsReset")}</Btn>
              </span>
            </div>
            <div className="grid grid-cols-1 min-[1180px]:grid-cols-2 gap-x-6 gap-y-3.5">
              <Field
                label={t("synth.pSpeed")}
                tip={t("synth.pSpeedTip")}
                control={<Slider value={params.speed} min={0.5} max={2} step={0.05} defaultValue={recommended.speed} onChange={setParam("speed")} format={(v) => `${v.toFixed(2)}x`} />}
              />
              <Field
                label={t("synth.pFragment")}
                tip={t("synth.pFragmentTip")}
                control={<Slider value={adv.fragment_interval} min={0.01} max={1} step={0.01} defaultValue={recommended.fragment_interval} onChange={(v) => setAdvKey("fragment_interval", v)} format={(v) => `${v.toFixed(2)} s`} />}
              />
              <Field
                label={t("synth.pTopK")}
                tip={t("synth.pTopKTip")}
                control={<Slider value={params.top_k} min={1} max={100} step={1} defaultValue={recommended.top_k} onChange={setParam("top_k")} />}
              />
              <Field
                label={t("synth.pTopP")}
                tip={t("synth.pTopPTip")}
                control={<Slider value={params.top_p} min={0} max={1} step={0.01} defaultValue={recommended.top_p} onChange={setParam("top_p")} format={(v) => v.toFixed(2)} />}
              />
              <Field
                label={t("synth.pTemp")}
                tip={t("synth.pTempTip")}
                control={<Slider value={params.temperature} min={0} max={1} step={0.01} defaultValue={recommended.temperature} onChange={setParam("temperature")} format={(v) => v.toFixed(2)} />}
              />
              <Field
                label={t("synth.pRep")}
                tip={t("synth.pRepTip")}
                control={<Slider value={params.repetition_penalty} min={1} max={2} step={0.01} defaultValue={recommended.repetition_penalty} onChange={setParam("repetition_penalty")} format={(v) => v.toFixed(2)} />}
              />
            </div>

            <button
              type="button"
              onClick={() => setAdvOpen((o) => !o)}
              className="mt-3.5 flex items-center gap-1.5 border-0 bg-transparent p-0 text-[12.5px] text-[var(--ink-muted)] cursor-pointer hover:text-[var(--ink)]"
            >
              <span className={`inline-flex transition-transform duration-200 ${advOpen ? "rotate-90" : ""}`}>
                <Icon name="chevron" size={13} />
              </span>
              {t("synth.advTitle")}
            </button>
            <Collapse open={advOpen}>
              <div className="pt-3.5 grid grid-cols-1 min-[1180px]:grid-cols-2 gap-x-6 gap-y-3.5">
                <Field
                  label={t("synth.pSeed")}
                  tip={t("synth.pSeedTip")}
                  control={
                    <div className="flex items-center gap-2.5">
                      <input
                        type="number"
                        min={0}
                        disabled={!adv.seedFixed}
                        value={adv.seedFixed && adv.seed >= 0 ? adv.seed : ""}
                        placeholder={t("synth.seedRandom")}
                        onChange={(e) => setAdvKey("seed", Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                        className="w-[120px] h-[30px] px-2.5 rounded-[var(--rs)] border border-[var(--line)] bg-[var(--stage)] text-[13px] text-[var(--ink)] outline-none tabular-nums disabled:opacity-60"
                      />
                      <Toggle
                        checked={adv.seedFixed}
                        onChange={(v) => {
                          setAdvKey("seedFixed", v);
                          if (v && adv.seed < 0) setAdvKey("seed", randomSeed());
                        }}
                        label={t("synth.seedFixed")}
                      />
                    </div>
                  }
                />
                <Field
                  label={t("synth.pBatch")}
                  tip={t("synth.pBatchTip")}
                  control={<Slider value={runWithVulkan ? ADV_DEFAULT.batch_size : adv.batch_size} disabled={runWithVulkan} min={1} max={200} step={1} defaultValue={ADV_DEFAULT.batch_size} onChange={(v) => setAdvKey("batch_size", v)} />}
                />
                {showSteps ? (
                  <Field
                    label={t("synth.pSteps")}
                    tip={t("synth.pStepsTip")}
                    control={
                      <Select
                        width={150}
                        value={adv.sample_steps}
                        options={[{ id: "", label: t("synth.stepsDefault") }, ...STEP_OPTIONS.map((s) => ({ id: s, label: s }))]}
                        onChange={(v) => setAdvKey("sample_steps", v)}
                      />
                    }
                  />
                ) : null}
                {showSuper ? (
                  <Field
                    label={t("synth.pSuper")}
                    tip={t("synth.pSuperTip")}
                    control={<Toggle checked={adv.super_sampling} onChange={(v) => setAdvKey("super_sampling", v)} label={t("synth.pSuperOn")} />}
                  />
                ) : null}
              </div>
            </Collapse>
          </div>
        </div>

        {/* 右栏：合成记录 */}
        <div className="min-h-[360px] min-[900px]:min-h-0 flex flex-col">
          <SynthResults
            tick={resultTick}
            latest={latest}
            format={runWithVulkan ? "wav" : format}
            formatDisabled={runWithVulkan || busy}
            onFormat={(f) => {
              setFormat(f);
              void c.set("synth_format", f);
            }}
            onReuse={reuse}
            onError={setErr}
          />
        </div>
      </div>
    </PagePad>
  );
}
