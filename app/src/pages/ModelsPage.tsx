import { useCallback, useEffect, useMemo, useState } from "react";
import { PagePad, PageHead, Block, Btn } from "../components/ui";
import { Field } from "../components/controls";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { AdBanner } from "../components/AdBanner";
import { Modal } from "../components/Modal";
import { Leave } from "../components/Presence";
import { Swap, stagger } from "../components/Motion";
import { Dropdown, MoreBtn, Pager, SearchBox, Tag, useMenu, usePaged, type MenuItem } from "../trm";
import type { PlazaItem } from "../lib/plaza";
import { artOf } from "../lib/art";
import { askConfirm } from "../lib/webDialog";
import { goTo, openInAnnot, synthWithRole } from "../lib/intent";
import { t } from "../i18n/t";
import { joinClauses } from "../lib/text";

/**
 * 角色库。
 *
 * 一个「角色」= SoVITS 音色模型 + GPT 韵律模型 + 参考音频集（.list 标注）
 * + 元数据与推荐参数，打包为单个 zip。本页负责导入、管理与导出分享包：
 * 改名称与作者、换封面、导出角色包、打开所在文件夹、删除；并且可以把角色
 * 直接交给合成页，把它的标注交给标注页。
 *
 * 列表读的是 `synth_characters` —— 和合成台扫的是同一份数据，所以这里列出来的
 * 和那边能选的必然一致。
 */

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** `synth_characters` 里这一页用得上的字段。合成台用的是同一份。 */
type Role = {
  id: string;
  name: string;
  author?: string;
  version?: string;
  cover?: string;
  cover_exists?: boolean;
  dir: string;
  lists?: { file: string; lang?: string; rows?: unknown[] }[];
};

type Sort = "name" | "refs";

/** 每页几张卡。 */
const PAGE_SIZE = 12;

const refCount = (r: Role) => (r.lists ?? []).reduce((n, l) => n + (l.rows?.length ?? 0), 0);

export function ModelsPage({
  onOpenPlaza,
  banner,
}: {
  onOpenPlaza?: () => void;
  /** 广场投放到本页的那一条（`plaza::pick_models_banner`，至多一条且必须可关）。 */
  banner?: PlazaItem | null;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [roles, setRoles] = useState<Role[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [editing, setEditing] = useState<Role | null>(null);
  // 封面换过之后浏览器会按旧地址缓存，地址上带一个版本号
  const [coverVer, setCoverVer] = useState(0);
  const menu = useMenu();

  const reload = useCallback(() => {
    if (!isTauri()) return;
    void invoke<{ roles?: Role[] }>("synth_characters")
      .then((r) => setRoles(r?.roles ?? []))
      .catch(() => setRoles([]));
  }, []);

  useEffect(reload, [reload]);

  // 页面消息自己消失，免得一条旧结果一直挂着。
  useEffect(() => {
    if (!msg) return;
    const id = window.setTimeout(() => setMsg(""), 5000);
    return () => window.clearTimeout(id);
  }, [msg]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? roles.filter((r) => `${r.name} ${r.author ?? ""} ${r.id}`.toLowerCase().includes(q)) : roles;
    return [...list].sort((a, b) => (sort === "refs" ? refCount(b) - refCount(a) : (a.name || a.id).localeCompare(b.name || b.id)));
  }, [roles, query, sort]);
  const paged = usePaged(shown, PAGE_SIZE, `${query}|${sort}`);

  async function importPack() {
    if (!isTauri()) {
      setMsg(t("library.demoImport"));
      return;
    }
    setBusy(true);
    setMsg(t("library.importPending"));
    try {
      const r = await invoke<{ name?: string }>("role_import_pack");
      setMsg(t("library.importDone", { v0: String(r?.name ?? "") }));
      reload();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  const run = async (fn: () => Promise<string | null>) => {
    try {
      const note = await fn();
      if (note) setMsg(note);
      reload();
    } catch (e) {
      setMsg(String(e));
    }
  };

  const itemsFor = (r: Role): MenuItem[] => {
    const lists = r.lists ?? [];
    return [
      { id: "synth", label: t("library.useInSynth"), icon: "play", onSelect: () => synthWithRole(r.id) },
      lists.length > 1
        ? {
            id: "annot",
            label: t("library.editList"),
            icon: "note",
            items: lists.map((l) => ({ id: l.file, label: l.file, onSelect: () => openInAnnot(`${r.dir}/${l.file}`) })),
          }
        : { id: "annot", label: t("library.editList"), icon: "note", disabled: !lists.length, onSelect: () => openInAnnot(`${r.dir}/${lists[0].file}`) },
      { id: "g1", gap: true },
      { id: "edit", label: t("library.editInfo"), icon: "edit", onSelect: () => setEditing(r) },
      {
        id: "cover",
        label: t("library.setCover"),
        icon: "image",
        onSelect: () =>
          void run(async () => {
            const res = await invoke<{ cover?: string } | null>("role_set_cover", { id: r.id });
            if (!res) return null;
            setCoverVer((v) => v + 1);
            return t("library.coverDone");
          }),
      },
      {
        id: "export",
        label: t("library.exportPack"),
        icon: "download",
        onSelect: () =>
          void run(async () => {
            setMsg(t("library.exporting"));
            const res = await invoke<{ path?: string } | null>("role_export", { id: r.id });
            return res?.path ? t("library.exportDone", { v0: res.path }) : "";
          }),
      },
      { id: "reveal", label: t("library.reveal"), icon: "folder", onSelect: () => void invoke("annot_reveal", { path: r.dir }).catch(() => {}) },
      { id: "g2", gap: true },
      {
        id: "delete",
        label: t("library.delete"),
        icon: "trash",
        danger: true,
        onSelect: () =>
          void run(async () => {
            if (!(await askConfirm(t("library.deleteAsk", { v0: r.name || r.id })))) return null;
            await invoke("role_delete", { id: r.id });
            return t("library.deleteDone", { v0: r.name || r.id });
          }),
      },
    ];
  };

  return (
    <PagePad>
      <PageHead
        title={t("library.title")}
        sub={t("library.subtitle")}
        actions={
          <>
            <Btn onClick={() => onOpenPlaza?.()}>{t("library.goPlaza")}</Btn>
            <Btn onClick={() => goTo("train")}>{t("library.goTrain")}</Btn>
            <Btn primary busy={busy} onClick={() => void importPack()}>
              {t("library.import")}
            </Btn>
          </>
        }
      />

      <AdBanner banner={banner ?? null} />

      <Block
        title={t("library.listTitle")}
        note={query ? `${shown.length} / ${roles.length}` : String(roles.length)}
        extra={roles.length ? <SearchBox value={query} onChange={setQuery} /> : undefined}
        action={
          roles.length > 1 ? (
            <Dropdown<Sort>
              value={sort}
              onChange={setSort}
              options={[
                { id: "name", label: t("library.sortName") },
                { id: "refs", label: t("library.sortRefs") },
              ]}
            />
          ) : undefined
        }
      >
        {msg ? <div className="text-[12.5px] text-[var(--help)] mb-3 selectable">{msg}</div> : null}
        {roles.length ? (
          <>
            <Swap k={`${paged.page}|${query}|${sort}`}>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
                {paged.slice.map((r, i) => {
                  const cover = r.cover_exists && r.cover && isTauri() ? `${convertFileSrc(`${r.dir}/${r.cover}`)}?v=${coverVer}` : "";
                  return (
                    <div
                      key={r.id}
                      className="group rise relative rounded-[var(--r)] bg-[var(--group)] p-2.5 cursor-pointer transition-colors duration-200 hover:bg-[color-mix(in_srgb,var(--ink)_3%,var(--group))]"
                      style={stagger(i)}
                      onClick={() => synthWithRole(r.id)}
                      onContextMenu={(e) => menu.open(e, itemsFor(r))}
                    >
                      <div
                        className="w-full aspect-[4/3] rounded-[calc(var(--r)-4px)] mb-2.5 bg-center bg-cover"
                        style={cover ? { backgroundImage: `url("${cover}")` } : { background: artOf(r.id) }}
                      />
                      <div className="absolute top-4 right-4">
                        <MoreBtn onOpen={(el) => menu.open(el, itemsFor(r))} />
                      </div>
                      <div className="text-[13.5px] font-medium leading-tight truncate">{r.name || r.id}</div>
                      <div className="text-[11.5px] text-[var(--meta)] mt-1 truncate">
                        {r.author ? t("home.author", { author: r.author }) : t("library.noAuthor")}
                      </div>
                      <div className="mt-1.5">
                        <Tag>{joinClauses([r.version && t("s.metaVersion", { v0: r.version }), t("library.refCount", { v0: String(refCount(r)) })])}</Tag>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Swap>
            {shown.length === 0 ? <p className="text-[13px] text-[var(--ink-muted)] m-0">{t("library.noHit")}</p> : null}
            <Pager page={paged.page} pages={paged.pages} onChange={paged.setPage} />
          </>
        ) : (
          <div className="rounded-[var(--r)] border border-dashed border-[var(--line)] p-6 text-center">
            <div className="text-[13.5px] font-medium">{t("library.emptyTitle")}</div>
            <div className="text-[12.5px] text-[var(--help)] mt-2 leading-relaxed max-w-[420px] mx-auto">
              {t("library.emptyDesc")}
            </div>
          </div>
        )}
      </Block>

      <Block title={t("library.fmtTitle")} titleTip={t("library.fmtTip")}>
        <pre className=" rounded-[var(--r)] bg-[var(--page-bg)] p-3.5 text-[11.5px] leading-relaxed text-[var(--ink-muted)] overflow-auto m-0">{`character.zip
├─ config.json      # ${t("library.fmtConfig")}
├─ cover.jpg
├─ models/
│  ├─ sovits.pth    # ${t("library.fmtSovits")}
│  └─ gpt.ckpt      # ${t("library.fmtGpt")}
└─ dataset/
   ├─ name.list     # ${t("library.fmtList")}
   └─ audios/`}</pre>
      </Block>

      {menu.node}
      <Leave>
        {editing ? (
          <EditDialog
            role={editing}
            onClose={() => setEditing(null)}
            onSaved={(name) => {
              setEditing(null);
              setMsg(t("library.editDone", { v0: name }));
              reload();
            }}
          />
        ) : null}
      </Leave>
    </PagePad>
  );
}

/** 改名称与作者。 */
function EditDialog({ role, onClose, onSaved }: { role: Role; onClose: () => void; onSaved: (name: string) => void }) {
  const [name, setName] = useState(role.name || role.id);
  const [author, setAuthor] = useState(role.author ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const INPUT =
    "w-full px-3 py-2 rounded-[var(--rs)] text-[13px] text-[var(--ink)] bg-transparent shadow-[inset_0_0_0_1px_var(--line)] outline-none focus:shadow-[inset_0_0_0_1px_var(--accent)] selectable";
  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      await invoke("role_update", { id: role.id, name, author });
      onSaved(name.trim());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onBackdrop={busy ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[440px] rounded-[var(--r)] bg-[var(--surface)] shadow-[0_22px_56px_-18px_var(--scrim)] p-6"
      >
        <h2 className="text-[19px] font-semibold m-0 mb-5">{t("library.editInfo")}</h2>
        <div className="flex flex-col gap-4">
          <Field label={t("library.fieldName")} control={<input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} autoFocus />} />
          <Field label={t("library.fieldAuthor")} control={<input value={author} onChange={(e) => setAuthor(e.target.value)} className={INPUT} />} />
        </div>
        {err ? <div className="mt-3 text-[12.5px] text-[var(--danger)]">{err}</div> : null}
        <div className="mt-6 flex gap-2.5 justify-end">
          <Btn onClick={onClose} disabled={busy}>{t("library.cancel")}</Btn>
          <Btn primary busy={busy} disabled={!name.trim()} onClick={() => void save()}>{t("library.save")}</Btn>
        </div>
      </div>
    </Modal>
  );
}
