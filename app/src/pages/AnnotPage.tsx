import { peekCharacters, readCharacters } from "../lib/characters";
import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "../lib/invoke";
import { diagnosticContent, errorWithTitle, isCancelled, withFeature } from "../lib/diagnostics";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Block, Btn, PageHead, PagePad } from "../components/ui";
import { Field, Select, Slider } from "../components/controls";
import { SegmentControl } from "../components/SegmentControl";
import { ErrorNote } from "../components/ErrorNote";
import { openTool } from "../components/ToolWindow";
import { pickPath } from "trm-ui/fabric";
import { askConfirm, askPrompt } from "trm-ui/fabric";
import { goTo, onHandoff, take, trainWith } from "../lib/intent";
import { joinClauses } from "../lib/text";
import { Pager, SearchBox, useDir, usePaged } from "../trm";
import { CatalogTransition } from "../components/CatalogTransition";
import { t } from "../i18n/t";
import { useI18n } from "../i18n";
import { ModelCard } from "../components/ModelCard";
import { useAudioPreview } from "../hooks/useAudioPreview";
import { registerLeaveGuard } from "../lib/navigationGuard";
import { DockableModal, TextInput, TransferProgress, usePageActive, usePageLeave } from "trm-ui";
import { useConfig } from "../hooks/useConfig";
import { MODEL_GRID_CLASS, useModelGrid } from "../hooks/useModelGrid";

/**
 * `.list` 标注管理。
 *
 * 一份标注是「一个音频 + 它的文本」重复几千遍。这些行同时是训练集、也是
 * 合成台的参考候选（见 docs/DECISIONS.md D4），所以它坏在哪，用户迟早都得
 * 一行一行去修 —— 这一页存在的意义就是让他不用开记事本对着几千行数竖线。
 *
 * 三条贯穿整页的设计取舍：
 *
 * 1. **先体检，再编辑。** 打开就把每一行的毛病标出来（文件不在 / 少字段 /
 *    文本空 / 同一个音频出现两次 / 语种记号不认识），并且默认给一个「只看有
 *    问题的」开关。用户来这一页十有八九是因为训练报错了，不是来通读的。
 * 2. **改动留在内存里，保存是一个明确的动作。** 边改边写盘看着聪明，实际上
 *    是把「我改错了，撤销」这条路堵死。顶栏那个圆点就是唯一的真相：亮着 =
 *    有没存的改动。
 * 3. **删行不重排行号。** 用户报错时说的是「第 47 行」，训练日志里印的也是
 *    行号。删掉第 12 行之后把 47 变成 46，是把唯一能对上的坐标毁掉。
 */

type Row = {
  line: number;
  wav: string;
  speaker: string;
  lang: string;
  text: string;
  abs: string;
  exists: boolean;
  issues: string[];
};

type Loaded = {
  path: string;
  dir: string;
  rows: Row[];
  total: number;
  bad: number;
  missing: number;
  /** 按文件名找回的行数。这些行的路径已换成新位置，保存后写入文件。 */
  relocated: number;
  /** 有多个同名文件、没有自动选择的行数。 */
  ambiguous: number;
  speakers: string[];
};

/** 上游认得的语种记号。和 annot.rs 的 KNOWN_LANGS 一致。 */
const LANGS = ["zh", "ja", "en", "ko", "yue", "all_zh", "all_ja", "all_ko", "auto"];

const PAGE_SIZE = 10;

/** 角色包里的一份标注。 */
function listsOf(roles: NonNullable<ReturnType<typeof peekCharacters>>): RoleList[] {
  return roles.flatMap(role => (role.lists ?? []).map(l => ({
    key: `${role.id}/${l.file}`, roleId: role.id, role: role.name || role.id,
    cover: role.cover_exists && role.cover ? convertFileSrc(`${role.dir}/${role.cover}`) : undefined,
    file: l.file, path: `${role.dir}/${l.file}`, rows: l.rows?.length ?? 0,
  })));
}

type RoleList = { key: string; roleId: string; role: string; cover?: string; file: string; path: string; rows: number };

function issueText(id: string): string {
  return t(`s.annot.issue.${id}`);
}

const CREATE_LANGS = ["auto", "zh", "ja", "en", "ko", "yue"] as const;

function folderBaseName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop()?.slice(0, 64) || "";
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 这一份是不是已经跑在工具窗里。是的话就别再给「独立窗口」按钮了。 */
function inToolWindow(): boolean {
  return (
    typeof window !== "undefined" && window.location.hash.startsWith("#/tool/")
  );
}

function AnnotPageImpl() {
  // 订阅语言：这一页的静态文案都走 t()，不订阅的话切语言不会重渲染。
  const { locale } = useI18n();
  void locale;

  const [path, setPath] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [creating, setCreating] = useState(false);
  const [createMin, setCreateMin] = useState(false);
  const [genReady, setGenReady] = useState(false);
  const [source, setSource] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [createLang, setCreateLang] = useState<string>("auto");
  const [progress, setProgress] = useState("");
  const autoSpeakerRef = useRef("");
  const minRef = useRef(false);
  useEffect(() => { minRef.current = createMin; }, [createMin]);
  usePageLeave(() => setMsg(""));
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<"all" | "bad">("all");
  const config = useConfig();
  const savedVolume = config.num("annot_preview_volume", 100);
  const volume = Number.isFinite(savedVolume) ? Math.max(0, Math.min(100, savedVolume)) : 100;
  const { playing, play: playAudio, stop: stopAudio, player } = useAudioPreview(volume / 100);
  const active = usePageActive();
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => {
    if ((!dirty && !(creating && busy)) || (!active && !inToolWindow())) return;
    return registerLeaveGuard(async () => {
      if (creating && busy) {
        if (!(await askConfirm(t("s.annot.cancelGenerateAsk")))) return false;
        await invoke("annot_generate_cancel").catch(() => {});
        setBusy(false);
        setCreating(false);
        setCreateMin(false);
        return true;
      }
      return askConfirm(t("s.annot.dropChanges"));
    });
  }, [dirty, busy, creating, active]);

  // 页面消息自己消失。不消失的话下一条会盖掉上一条，用户更容易漏看。
  useEffect(() => {
    if (!msg) return;
    const id = window.setTimeout(() => setMsg(""), 4000);
    return () => window.clearTimeout(id);
  }, [msg]);

  const apply = useCallback((r: Loaded) => {
    stopAudio();
    setPath(r.path);
    setRows(r.rows || []);
    setSpeakers(r.speakers || []);
    setDirty(false);
  }, [stopAudio]);

  /** 打开时自动找回了音频：新路径还没写进文件，算作未保存的改动。 */
  const noteRelocated = useCallback((r: Loaded) => {
    if (!r.relocated) return;
    setDirty(true);
    setMsg(t("s.annot.relocatedOnLoad", { v0: r.relocated }));
  }, []);

  const openPath = useCallback(async (p: string) => {
    if (dirty && !(await askConfirm(t("s.annot.dropChanges")))) return;
    setErr("");
    setBusy(true);
    try {
      const r = await invoke<Loaded>("annot_load", { path: p });
      apply(r);
      // 行数和问题数已写在「当前标注」右侧，这里不再另报一遍。
      noteRelocated(r);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [apply, dirty, noteRelocated]);

  const open = useCallback(async () => {
    const p = await pickPath<string | null>(
      "annot_pick",
      undefined,
      t("s.annot.pickHint"),
    ).catch(() => null);
    if (p) await openPath(p);
  }, [openPath]);

  const openCreate = useCallback(() => {
    setErr("");
    setGenReady(false);
    setCreateMin(false);
    setCreating(true);
  }, []);

  const pickSource = async () => {
    setErr("");
    try {
      const folder = await pickPath<string | null>(
        "annot_pick_source", undefined, t("s.annot.audioDirHint"),
      );
      if (folder) {
        setSource(folder);
        const inferred = folderBaseName(folder);
        setSpeaker(prev => (!prev || prev === autoSpeakerRef.current ? inferred : prev));
        autoSpeakerRef.current = inferred;
      }
    } catch (e) {
      setErr(String(e));
    }
  };

  const generate = async () => {
    const spk = speaker.trim();
    if (!source || !spk || busy) return;
    setErr("");
    setGenReady(false);
    setBusy(true);
    setProgress(t("s.annot.generating"));
    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await listen<string>("annot-progress", event => setProgress(event.payload));
      apply(await invoke<Loaded>("annot_generate", {
        source,
        speaker: spk,
        lang: createLang,
      }));
      setSource("");
      setSpeaker("");
      autoSpeakerRef.current = "";
      if (minRef.current && !activeRef.current && !inToolWindow()) {
        setGenReady(true);
      } else {
        setCreating(false);
        setCreateMin(false);
      }
    } catch (e) {
      if (isCancelled(e)) setMsg(t("s.annot.cancelled"));
      else setErr(String(e));
    } finally {
      unlisten?.();
      setBusy(false);
    }
  };

  const cancelGenerate = () => {
    void invoke("annot_generate_cancel").catch(() => {});
  };

  const closeCreate = () => {
    if (busy) return;
    setCreating(false);
    setCreateMin(false);
    setGenReady(false);
    setErr("");
  };

  const useForTraining = () => {
    if (inToolWindow()) {
      void invoke("tools_open_train", { path }).catch(e => setErr(String(e)));
    } else {
      trainWith(path);
    }
  };

  // 模型页、合成页点了「编辑标注」，或训练页点了「创建 .list」：按需打开或弹出。
  useEffect(() => {
    const run = () => {
      const p = take("annotList");
      if (p) void openPath(p);
      if (take("annotCreate")) openCreate();
    };
    run();
    return onHandoff(run);
  }, [openPath, openCreate]);

  // 各角色自带的标注文件，未打开文件时列出来，点一下即可打开。
  const [roleLists, setRoleLists] = useState<RoleList[]>(() => listsOf(peekCharacters() ?? []));
  const loadRoleLists = useCallback(() => {
    if (!isTauri()) return;
    void readCharacters().then(roles => setRoleLists(listsOf(roles))).catch(e => setErr(JSON.stringify(withFeature(e, "annotation"))));
  }, []);
  useEffect(loadRoleLists, [loadRoleLists]);
  const roleGrid = useModelGrid();
  const rolePaged = usePaged(roleLists, roleGrid.pageSize);

  /** 关掉当前文件，回到角色标注文件的列表。 */
  const close = useCallback(async () => {
    if (dirty && !(await askConfirm(t("s.annot.dropChanges")))) return;
    stopAudio();
    setPath("");
    setRows([]);
    setSpeakers([]);
    setDirty(false);
    setQuery("");
    setOnly("all");
    setErr("");
  }, [dirty, stopAudio]);

  const reload = useCallback(async () => {
    if (!path) return;
    if (dirty && !(await askConfirm(t("s.annot.dropChanges")))) return;
    setBusy(true);
    setErr("");
    try {
      const r = await invoke<Loaded>("annot_load", { path });
      apply(r);
      setMsg(t("s.annot.reloaded"));
      noteRelocated(r);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [apply, path, dirty, noteRelocated]);

  const save = useCallback(async () => {
    if (!path || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await invoke<{ written: number; backup: boolean }>("annot_save", {
        path,
        rows,
      });
      // 存完立刻重读：文件在不在、有没有重复，都可能因为这次保存变了。
      apply(await invoke<Loaded>("annot_load", { path }));
      loadRoleLists();
      setMsg(
        r.backup
          ? t("s.annot.savedWithBackup", { v0: r.written })
          : t("s.annot.saved", { v0: r.written }),
      );
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [apply, busy, path, rows, loadRoleLists]);

  /** 改一行的某一格。行号是主键 —— 过滤/翻页之后下标早就不是行号了。 */
  const edit = useCallback((line: number, patch: Partial<Row>) => {
    setRows((prev) =>
      prev.map((r) => (r.line === line ? { ...r, ...patch } : r)),
    );
    setDirty(true);
  }, []);

  const removeRow = useCallback((line: number) => {
    setRows((prev) => prev.filter((r) => r.line !== line));
    setDirty(true);
  }, []);

  const play = (r: Row) => {
    const fileName = r.wav.split(/[\\/]/).pop() || r.wav;
    if (r.exists && r.abs) playAudio(r.abs, () => setErr(errorWithTitle(r.wav, "s.annot.playFailed", "annotation", { v0: fileName })));
  };

  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (only === "bad" && r.issues.length === 0) return false;
      if (!q) return true;
      return (
        r.text.toLowerCase().includes(q) ||
        r.wav.toLowerCase().includes(q) ||
        r.speaker.toLowerCase().includes(q)
      );
    });
  }, [rows, query, only]);

  const paged = usePaged(view, PAGE_SIZE, `${path}|${query}|${only}`);
  const pageDir = useDir(paged.page);
  const filterDir = useDir(only === "bad" ? 1 : 0);
  const pageRows = paged.slice;
  useEffect(() => {
    player.retain(pageRows.map(r => r.abs));
  }, [pageRows, player]);

  const bad = useMemo(() => rows.filter((r) => r.issues.length > 0).length, [rows]);
  const missing = useMemo(
    () => rows.filter((r) => r.issues.includes("missing")).length,
    [rows],
  );

  /** 批量动作只作用在**当前筛选出来的**这些行上，不是整份文件。 */
  const bulkSpeaker = useCallback(async () => {
    const name = (speakers[0] || "").trim();
    const next = await askPrompt(t("s.annot.bulkSpeakerAsk"), name);
    if (next == null || !next.trim()) return;
    const keep = new Set(view.map((r) => r.line));
    setRows((prev) =>
      prev.map((r) => (keep.has(r.line) ? { ...r, speaker: next.trim() } : r)),
    );
    setDirty(true);
    setMsg(t("s.annot.bulkDone", { v0: keep.size }));
  }, [speakers, view]);

  const bulkLang = useCallback((lang: string) => {
    if (!lang) return;
    const keep = new Set(view.map((r) => r.line));
    setRows((prev) =>
      prev.map((r) => (keep.has(r.line) ? { ...r, lang } : r)),
    );
    setDirty(true);
    setMsg(t("s.annot.bulkDone", { v0: keep.size }));
  }, [view]);

  /** 选一个音频目录，在里面按文件名找回缺失的音频。作用于整份文件，带着没保存的改动。 */
  const findAudio = useCallback(async () => {
    if (!path || busy) return;
    setErr("");
    const r = await pickPath<Loaded | null>(
      "annot_relocate",
      { path, rows },
      t("s.annot.audioDirHint"),
    ).catch((e) => {
      setErr(String(e));
      return null;
    });
    if (!r) return;
    setRows(r.rows || []);
    if (r.relocated) setDirty(true);
    setMsg(
      r.relocated
        ? r.ambiguous
          ? t("s.annot.relocatedSome", { v0: r.relocated, v1: r.ambiguous })
          : t("s.annot.relocated", { v0: r.relocated })
        : r.ambiguous
          ? t("s.annot.relocatedAmbiguous", { v0: r.ambiguous })
          : t("s.annot.relocatedNone"),
    );
  }, [busy, path, rows]);

  const dropMissing = useCallback(async () => {
    const n = missing;
    if (!n) return;
    if (!(await askConfirm(t("s.annot.dropMissingAsk", { v0: n })))) return;
    setRows((prev) => prev.filter((r) => !r.issues.includes("missing")));
    setDirty(true);
    setMsg(t("s.annot.bulkDone", { v0: n }));
  }, [missing]);

  const CELL = "px-2 py-1.5 align-top";
  // 输入框随内容伸缩（field-sizing），文本多长就显示多长，不截断。
  const INPUT =
    "[field-sizing:content] px-2 py-1 rounded-[var(--rs)] text-[12.5px] text-[var(--ink)] bg-transparent shadow-[inset_0_0_0_1px_var(--line)] outline-none focus:shadow-[inset_0_0_0_1px_var(--accent)]";

  return (
    <div className="h-full overflow-y-auto">
      <PagePad>
        <PageHead
          title={t("s.annot.title")}
          back={path ? () => void close() : undefined}
          actions={
            <>
              {isTauri() && !inToolWindow() ? (
                <Btn onClick={() => openTool("annot")}>
                  {t("s.annot.openWindow")}
                </Btn>
              ) : null}
              {/* 页面空着时这两个按钮在下面的引导卡片里，标题栏不再重复一遍。 */}
              {!path && roleLists.length ? (
                <>
                  <Btn onClick={() => void open()} disabled={busy}>{t("s.annot.open")}</Btn>
                  <Btn primary disabled={busy} onClick={openCreate}>{t("s.annot.create")}</Btn>
                </>
              ) : null}
              {path ? (
                <>
                  <div className="flex items-center gap-2" role="group" aria-label={t("s.annot.volume")}>
                    <span className="text-[12.5px] text-[var(--ink-muted)] whitespace-nowrap">{t("s.annot.volume")}</span>
                    <div className="w-[170px]">
                      <Slider value={volume} min={0} max={100} step={1} defaultValue={100}
                        ariaLabel={t("s.annot.volume")} format={value => `${value}%`}
                        onChange={value => void config.set("annot_preview_volume", value)} />
                    </div>
                  </div>
                  <Btn onClick={() => void reload()} disabled={busy}>
                    {t("s.annot.reload")}
                  </Btn>
                  <Btn
                    onClick={() => void invoke("annot_reveal", { path }).catch(() => {})}
                  >
                    {t("s.annot.reveal")}
                  </Btn>
                  <Btn onClick={useForTraining} disabled={dirty || busy}>
                    {t("s.annot.toTrain")}
                  </Btn>
                  <Btn primary onClick={() => void save()} busy={busy} disabled={!dirty}>
                    {dirty ? t("s.annot.saveDirty") : t("s.annot.saved0")}
                  </Btn>
                </>
              ) : null}
            </>
          }
        />

        {(!creating && err) || config.error ? <ErrorNote feature="annotation" text={(!creating && err) || config.error} /> : null}
        <DockableModal
          open={creating}
          minimized={createMin}
          onMinimizedChange={(next) => {
            if (!next && genReady) {
              setGenReady(false);
              setCreating(false);
              setCreateMin(false);
              if (!inToolWindow()) goTo("annot");
              return;
            }
            setCreateMin(next);
          }}
          canMinimize={busy || createMin || genReady}
          onClose={busy ? undefined : closeCreate}
          contained={false}
          maxWidth={500}
          z={60}
          label={t("s.annot.create")}
          orbLabel={t("s.orbDownloadLabel")}
          attention={err ? "error" : genReady ? "ready" : "idle"}
          tooltip={joinClauses([
            t("s.annot.create"),
            err ? diagnosticContent(err, "annotation").title : (genReady ? t("s.annot.readyOrb") : progress || t("s.annot.generating")),
          ])}
        >
          <div className="space-y-4 p-6" aria-busy={busy}>
            <h2 className="m-0 text-xl font-semibold">{t("s.annot.create")}</h2>
            {!busy ? (
              <p className="m-0 text-[12.5px] text-[var(--help)]">{t("s.annot.createHint")}</p>
            ) : null}
            {!busy ? (
              <>
                <div className="flex items-center gap-3 flex-wrap">
                  <Btn disabled={!isTauri()} onClick={() => void pickSource()}>
                    {t("s.annot.chooseSource")}
                  </Btn>
                  {source ? <span className="min-w-0 break-all text-[12.5px] text-[var(--ink-muted)]">{source}</span> : null}
                </div>
                <Field
                  label={t("s.annot.speaker")}
                  control={
                    <TextInput
                      value={speaker}
                      onChange={setSpeaker}
                      placeholder={t("s.annot.speakerPh")}
                      className="min-w-[200px]"
                    />
                  }
                />
                <Field
                  label={t("s.annot.lang")}
                  control={
                    <Select
                      value={createLang}
                      onChange={setCreateLang}
                      options={[
                        { id: "auto", label: t("s.annot.langAuto") },
                        ...CREATE_LANGS.filter((l) => l !== "auto").map((l) => ({ id: l, label: l.toUpperCase() })),
                      ]}
                    />
                  }
                />
              </>
            ) : (
              <TransferProgress message={progress || t("s.annot.generating")} />
            )}
            {!isTauri() ? (
              <p className="m-0 text-[12.5px] text-[var(--help)]">{t("s.annot.createPreview")}</p>
            ) : null}
            {err ? <ErrorNote feature="annotation" text={err} /> : null}
            <div className="flex justify-end gap-2">
              {busy ? (
                <>
                  <Btn danger onClick={cancelGenerate}>{t("s.annot.cancelGenerate")}</Btn>
                  <Btn onClick={() => setCreateMin(true)}>{t("s.annot.background")}</Btn>
                </>
              ) : (
                <>
                  <Btn onClick={closeCreate}>{t("ui.common.cancel")}</Btn>
                  <Btn primary disabled={!source || !speaker.trim()} onClick={() => void generate()}>
                    {t("s.annot.generate")}
                  </Btn>
                </>
              )}
            </div>
          </div>
        </DockableModal>
        {msg ? (
          <div className="mt-3 text-[12.5px] text-[var(--help)]">{msg}</div>
        ) : null}

        <CatalogTransition scope={path ? "editor" : "library"} dir={path ? 1 : -1}>
        {!path && roleLists.length ? (
          <Block title={t("s.annot.roleListsTitle")} note={String(roleLists.length)}>
            <div ref={roleGrid.ref} style={roleGrid.style}>
              <CatalogTransition scope="role-lists" page={rolePaged.page}>
                <div className={MODEL_GRID_CLASS}>
                  {rolePaged.slice.map(list => (
                    <ModelCard key={list.key} id={list.roleId} name={list.role} cover={list.cover}
                      disabled={busy} onOpen={() => void openPath(list.path)}>
                      <div className="text-[11.5px] text-[var(--meta)] mt-1 leading-relaxed break-words">
                        {t("s.annot.roleListMeta", { v0: list.file, v1: list.rows })}
                      </div>
                    </ModelCard>
                  ))}
                </div>
              </CatalogTransition>
            </div>
            <Pager page={rolePaged.page} pages={rolePaged.pages} onChange={rolePaged.setPage} />
          </Block>
        ) : !path ? (
          <div className="mt-4 rounded-[var(--r)] bg-[var(--group)] p-6 flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="text-[15px] font-semibold">{t("s.annot.emptyTitle")}</div>
              <p className="m-0 mt-1 text-[12.5px] text-[var(--help)]">{t("s.annot.emptyDesc")}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Btn onClick={() => void open()} disabled={busy}>{t("s.annot.open")}</Btn>
              <Btn primary disabled={busy} onClick={openCreate}>{t("s.annot.create")}</Btn>
            </div>
          </div>
        ) : null}

        {path ? (
          <>
            <Block
              title={t("s.annot.fileTitle")}
              note={path}
              action={
                <span className="text-[12.5px] text-[var(--meta)]">
                  {t("s.annot.summary", { v0: rows.length, v1: bad, v2: missing })}
                </span>
              }
            >
              <div className="flex items-center gap-3 flex-wrap mb-4">
                <SearchBox value={query} onChange={setQuery} />
                <SegmentControl<"all" | "bad">
                  value={only}
                  onChange={setOnly}
                  options={[
                    { id: "all", label: t("s.annot.filterAll") },
                    { id: "bad", label: t("s.annot.filterBad") },
                  ]}
                />
                <span className="ml-auto flex items-center gap-2 flex-wrap">
                  <span className="text-[12.5px] text-[var(--meta)]">
                    {t("s.annot.bulkOn", { v0: view.length })}
                  </span>
                  <Btn onClick={() => void bulkSpeaker()} disabled={!view.length}>
                    {t("s.annot.bulkSpeaker")}
                  </Btn>
                  <Select
                    value=""
                    options={[
                      { id: "", label: t("s.annot.bulkLang") },
                      ...LANGS.map((l) => ({ id: l, label: l })),
                    ]}
                    onChange={bulkLang}
                  />
                  <Btn onClick={() => void findAudio()} disabled={!missing || busy}>
                    {t("s.annot.findAudio")}
                  </Btn>
                  <Btn onClick={() => void dropMissing()} disabled={!missing}>
                    {t("s.annot.dropMissing", { v0: missing })}
                  </Btn>
                </span>
              </div>

              <CatalogTransition scope={`${path}|${only}|${query}`} page={paged.page} dir={filterDir || pageDir || 1}>
              <div className="overflow-x-auto bg-[var(--group)] rounded-[var(--r)]">
                <table className="w-full border-collapse text-[12.5px]">
                  <thead>
                    <tr className="text-[var(--meta)] text-left">
                      <th className={`${CELL} w-[52px] font-medium`}>
                        {t("s.annot.colLine")}
                      </th>
                      <th className={`${CELL} w-[210px] font-medium`}>
                        {t("s.annot.colWav")}
                      </th>
                      <th className={`${CELL} w-px font-medium whitespace-nowrap`}>
                        {t("s.annot.colSpeaker")}
                      </th>
                      <th className={`${CELL} w-px font-medium whitespace-nowrap`}>
                        {t("s.annot.colLang")}
                      </th>
                      <th className={`${CELL} font-medium`}>{t("s.annot.colText")}</th>
                      <th className={`${CELL} w-[44px]`} />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r) => (
                      <tr key={r.line} className="align-top">
                        <td className={`${CELL} font-mono text-[var(--meta)]`}>
                          {r.line}
                        </td>
                        <td className={CELL}>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => play(r)}
                              disabled={!r.exists}
                              aria-label={t("s.annot.play")}
                              title={t("s.annot.play")}
                              className={[
                                "shrink-0 w-[22px] h-[22px] rounded-full border-0 cursor-pointer",
                                "inline-flex items-center justify-center",
                                r.exists
                                  ? "bg-transparent text-[var(--accent-text)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_42%,transparent)]"
                                  : "bg-transparent text-[var(--meta)] shadow-[inset_0_0_0_1px_var(--line)] cursor-default",
                              ].join(" ")}
                            >
                              {/* 用图形不用字符：▶ 和 ■ 在 Windows 上会被
                                  当成 emoji 渲染，一颗蓝方块盖住整个按钮。 */}
                              <svg
                                viewBox="0 0 10 10"
                                width="9"
                                height="9"
                                aria-hidden
                                fill="currentColor"
                                className="mx-auto"
                              >
                                {playing === r.abs ? (
                                  <rect x="1" y="1" width="8" height="8" rx="1" />
                                ) : (
                                  <path d="M2 1l7 4-7 4z" />
                                )}
                              </svg>
                            </button>
                            <span
                              className="font-mono truncate text-[11.5px]"
                              title={r.wav}
                            >
                              {r.wav}
                            </span>
                          </div>
                          {r.issues.length ? (
                            <div className="mt-1 flex gap-1 flex-wrap">
                              {r.issues.map((i) => (
                                <span
                                  key={i}
                                  className="text-[11.5px] px-1.5 py-px rounded-full text-[var(--danger-text)] bg-[var(--danger-soft)]"
                                >
                                  {issueText(i)}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </td>
                        <td className={CELL}>
                          {/* design-allow: py-1(12.5px) 与 compact(7px 9px, 13px) 高度差 6px 且描边色不同（--line 对 --hairline）。 */}
                          <input
                            value={r.speaker}
                            onChange={(e) => edit(r.line, { speaker: e.target.value })}
                            className={`${INPUT} min-w-[80px] max-w-[220px]`}
                          />
                        </td>
                        <td className={CELL}>
                          {/* design-allow: py-1(12.5px) 与 compact(7px 9px, 13px) 高度差 6px 且描边色不同（--line 对 --hairline）。 */}
                          <input
                            value={r.lang}
                            list="annot-langs"
                            onChange={(e) => edit(r.line, { lang: e.target.value })}
                            className={`${INPUT} min-w-[48px] max-w-[110px]`}
                          />
                        </td>
                        <td className={CELL}>
                          {/* design-allow: py-1(12.5px)+min-h-[30px] 与 compact/field 高度差超过 5px 且 compact 描边色不同（--line 对 --hairline）。 */}
                          <textarea
                            value={r.text}
                            rows={1}
                            onChange={(e) => edit(r.line, { text: e.target.value })}
                            className={`${INPUT} w-full resize-none min-h-[30px] leading-relaxed`}
                          />
                        </td>
                        <td className={CELL}>
                          <Btn
                            text
                            danger
                            onClick={() => removeRow(r.line)}
                            ariaLabel={t("s.annot.removeRow")}
                            className="!px-0 !py-0 w-[22px] h-[22px] inline-flex items-center justify-center"
                          >
                            ×
                          </Btn>
                        </td>
                      </tr>
                    ))}
                    {!pageRows.length ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-2 py-8 text-center text-[var(--meta)]"
                        >
                          {t("s.annot.noRows")}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              </CatalogTransition>
              <datalist id="annot-langs">
                {LANGS.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>

              <Pager page={paged.page} pages={paged.pages} onChange={paged.setPage} />
            </Block>
          </>
        ) : null}
        </CatalogTransition>
      </PagePad>
    </div>
  );
}

export const AnnotPage = memo(AnnotPageImpl);
