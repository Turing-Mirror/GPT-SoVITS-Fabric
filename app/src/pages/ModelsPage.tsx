import { peekCharacters, readCharacters } from "../lib/characters";
import { TextInput, usePageLeave } from "trm-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PagePad, PageHead, Block, Btn } from "../components/ui";
import { Field } from "../components/controls";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { CropCoverDialog } from "../components/CropCoverDialog";
import { AdBanner } from "../components/AdBanner";
import { Modal } from "../components/Modal";
import { Leave } from "../components/Presence";
import { CatalogTransition } from "../components/CatalogTransition";
import { FlowList, Dropdown, Pager, SearchBox, Tag, useDir, useMenu, usePaged, type MenuItem } from "../trm";
import type { PlazaItem } from "../lib/plaza";
import { ModelCard } from "../components/ModelCard";
import { RoleAssetsDialog } from "../components/RoleAssetsDialog";
import { MODEL_GRID_CLASS, useModelGrid } from "../hooks/useModelGrid";
import { askConfirm } from "trm-ui/fabric";
import { goTo, synthWithRole } from "../lib/intent";
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

const refCount = (r: Role) => (r.lists ?? []).reduce((n, l) => n + (l.rows?.length ?? 0), 0);

export function ModelsPage({
  onOpenPlaza,
  banner,
  active = true,
}: {
  onOpenPlaza?: () => void;
  active?: boolean;
  /** 广场投放到本页的那一条（`plaza::pick_models_banner`，至多一条且必须可关）。 */
  banner?: PlazaItem | null;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  usePageLeave(() => setMsg(""));
  const [loading, setLoading] = useState(() => isTauri() && peekCharacters() === null);
  const [roles, setRoles] = useState<Role[]>(() => peekCharacters() ?? []);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [editing, setEditing] = useState<Role | null>(null);
  const [managing, setManaging] = useState<Role | null>(null);
  // 封面换过之后浏览器会按旧地址缓存，地址上带一个版本号
  const [coverVer, setCoverVer] = useState(0);
  const [coverEdit, setCoverEdit] = useState<Role | null>(null);
  const loadRequest = useRef(0);
  const menu = useMenu();

  const reload = useCallback(() => {
    if (!isTauri()) return;
    const request = ++loadRequest.current;
    setLoading(true);
    void readCharacters()
      .then((r) => { if (request === loadRequest.current) setRoles(r); })
      .catch((e) => { if (request === loadRequest.current) setMsg(String(e)); })
      .finally(() => { if (request === loadRequest.current) setLoading(false); });
  }, []);

  useEffect(() => {
    if (active) reload();
    else { setEditing(null); setCoverEdit(null); setManaging(null); }
    const counter = loadRequest;
    return () => { counter.current++; };
  }, [active, reload]);

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
  const grid = useModelGrid();
  const paged = usePaged(shown, grid.pageSize, `${query}|${sort}`);
  const pageDir = useDir(paged.page);

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
    return [
      { id: "edit", label: t("library.editInfo"), icon: "edit", onSelect: () => setEditing(r) },
      {
        id: "cover",
        label: t("library.setCover"),
        icon: "image",
        onSelect: () => setCoverEdit(r),
      },
      {
        id: "reset-cover",
        label: t("library.resetCover"),
        icon: "image",
        onSelect: () => void run(async () => {
          await invoke("role_cover_reset", { id: r.id });
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
            <div ref={grid.ref} style={grid.style}>
              <CatalogTransition scope="models" page={paged.page} dir={pageDir || 1}>
                <FlowList layout="grid" items={paged.slice} keyOf={(r) => r.id}
                  className={MODEL_GRID_CLASS}
                  render={(r) => {
                    const cover = r.cover_exists && r.cover && isTauri() ? `${convertFileSrc(`${r.dir}/${r.cover}`)}?v=${coverVer}` : "";
                    return (
                      <ModelCard id={r.id} name={r.name || r.id} cover={cover}>
                        <div className="text-[11.5px] text-[var(--meta)] mt-1 truncate">
                          {r.author ? t("home.author", { author: r.author }) : t("library.noAuthor")}
                        </div>
                        <div className="mt-1.5">
                          <Tag>{joinClauses([r.version && t("s.metaVersion", { v0: r.version }), t("library.refCount", { v0: String(refCount(r)) })])}</Tag>
                        </div>
                        <div className="mt-2.5 flex items-center gap-1.5" onClick={event => event.stopPropagation()}>
                          <Btn className="flex-1 min-w-0" onClick={() => synthWithRole(r.id)}><span className="block truncate" title={t("nav.synth")}>{t("nav.synth")}</span></Btn>
                          <Btn className="flex-1 min-w-0" onClick={() => setManaging(r)}><span className="block truncate" title={t("library.manageAssets")}>{t("library.manageAssets")}</span></Btn>
                          <Btn className="shrink-0 px-2.5" ariaLabel={t("ui.common.more")} onClick={event => menu.open(event.currentTarget, itemsFor(r))}>⋯</Btn>
                        </div>
                      </ModelCard>
                    );
                  }} />
              </CatalogTransition>
            </div>
            {shown.length === 0 ? <p className="text-[13px] text-[var(--ink-muted)] m-0">{t("library.noHit")}</p> : null}
            <Pager page={paged.page} pages={paged.pages} onChange={paged.setPage} />
          </>
        ) : loading ? (
          <p className="m-0 text-[12.5px] text-[var(--help)]">{t("s.valueLoading")}</p>
        ) : (
          <div className="rounded-[var(--r)] border border-dashed border-[var(--line)] p-6 text-center">
            <div className="text-[13px] font-medium">{t("library.emptyTitle")}</div>
            <div className="text-[12.5px] text-[var(--help)] mt-2 leading-relaxed max-w-[420px] mx-auto">
              {t("library.emptyDesc")}
            </div>
          </div>
        )}
      </Block>

      {menu.node}
      <Leave>{managing ? <RoleAssetsDialog key={managing.id} role={managing} onClose={() => setManaging(null)} onChanged={reload} /> : null}</Leave>
      <Leave>{coverEdit ? (
        <CropCoverDialog key={coverEdit.id} model={coverEdit}
          onClose={() => setCoverEdit(null)}
          onSaved={() => {
            setCoverEdit(null);
            setCoverVer((v) => v + 1);
            setMsg(t("library.coverDone"));
            reload();
          }} />
      ) : null}</Leave>
      <Leave>
        {editing ? (
          <EditDialog
            key={editing.id}
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
        <h2 className="text-[16px] font-semibold m-0 mb-5">{t("library.editInfo")}</h2>
        <div className="flex flex-col gap-4">
          <Field label={t("library.fieldName")} control={<TextInput value={name} onChange={setName} className="selectable" autoFocus />} />
          <Field label={t("library.fieldAuthor")} control={<TextInput value={author} onChange={setAuthor} className="selectable" />} />
        </div>
        {err ? <div className="mt-3 text-[12.5px] text-[var(--danger-text)]">{err}</div> : null}
        <div className="mt-6 flex gap-2.5 justify-end">
          <Btn onClick={onClose} disabled={busy}>{t("library.cancel")}</Btn>
          <Btn primary busy={busy} disabled={!name.trim()} onClick={() => void save()}>{t("library.save")}</Btn>
        </div>
      </div>
    </Modal>
  );
}
