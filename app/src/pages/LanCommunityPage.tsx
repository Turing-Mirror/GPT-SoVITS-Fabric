import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../i18n";
import { SearchBox } from "../trm";
import { Block, Btn, Group, ListItem, PageHead, PagePad } from "../components/ui";
import { type ChangelogEntry } from "../lib/plaza";

type Package = { id: string; versionId: string; fileId: string; sha256: string; bytes: number;
  title: string; author: string; version: string; description: string; license: string; sourceUrl: string; cover: string };
type Catalog = { items: Package[]; nextCursor: string; source: string };

function PackageRow({ item }: { item: Package }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const prepare = async () => {
    setBusy(true);
    setError("");
    try {
      const href = await invoke<string>("lan_community_download", { fileId: item.fileId, id: item.id,
        versionId: item.versionId, sha256: item.sha256, bytes: item.bytes });
      if (typeof href !== "string" || !href.startsWith("https://")) throw new Error(t("s.valueFailed"));
      setUrl(href);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <li className="py-4 flex flex-wrap items-start gap-3">
    <div className="min-w-0 flex-1 basis-[220px]">
      <h3 className="m-0 text-[13px] font-medium break-words">{item.title}</h3>
      <p className="m-0 mt-1 text-[12.5px] text-[var(--meta)]">{[item.author, item.version, item.license, `${(item.bytes / 1024**2).toFixed(1)} MB`].filter(Boolean).join(" · ")}</p>
      {item.description ? <p className="m-0 mt-1 text-[12.5px] text-[var(--help)] break-words">{item.description}</p> : null}
      {error ? <p role="alert" className="m-0 mt-1 text-[13px] break-words">{error}</p> : null}
    </div>
    <div className="flex flex-wrap gap-2 items-center">
      {item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-[12.5px] text-[var(--accent-text)]">{t("lan.catalogSource")}</a> : null}
      {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-[13px] text-[var(--accent-text)]" onClick={() => window.setTimeout(() => setUrl(""), 3000)}>{t("lan.catalogDownload")}</a>
        : <Btn busy={busy} disabled={busy} onClick={() => void prepare()}>{t("lan.prepareDownload")}</Btn>}
    </div>
  </li>;
}

export function LanCommunityPage() {
  const { t } = useI18n();
  const [cursors, setCursors] = useState([""]);
  const [data, setData] = useState<Catalog>();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, reload] = useState(0);
  const [notes, setNotes] = useState<ChangelogEntry[] | null>(null);
  const [notesError, setNotesError] = useState("");
  const [showNotes, setShowNotes] = useState(false);
  const notesRequest = useRef(0);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    let keep = true;
    setBusy(true);
    setStatus("");
    void invoke<Catalog>("lan_community_catalog", { cursor }).then(result => {
      if (!result || !Array.isArray(result.items)) throw new Error("Invalid catalog");
      if (keep) setData(result);
    }).catch(e => { if (keep) setStatus(String(e)); })
      .finally(() => { if (keep) setBusy(false); });
    return () => { keep = false; };
  }, [cursor, refresh]);

  const openNotes = async () => {
    setShowNotes(true);
    const seq = ++notesRequest.current;
    setNotes(null);
    setNotesError("");
    try {
      const entries = await invoke<ChangelogEntry[]>("lan_release_notes");
      if (!Array.isArray(entries)) throw new Error(t("s.valueFailed"));
      if (notesRequest.current === seq) setNotes(entries);
    } catch (e) { if (notesRequest.current === seq) setNotesError(String(e)); }
  };
  const q = search.trim().toLowerCase();
  const rows = data?.items.filter(row => `${row.title} ${row.author} ${row.version}`.toLowerCase().includes(q)) ?? [];
  const changePage = (next: string[]) => { setData(undefined); setSearch(""); setCursors(next); };
  return <PagePad width="read">
    <PageHead title={t("nav.plaza")} sub={t("lan.catalogHint")} actions={<>
      <Btn onClick={() => showNotes ? setShowNotes(false) : void openNotes()}>{showNotes ? t("window.close") : t("lan.releaseNotes")}</Btn>
      <Btn busy={busy} disabled={busy} onClick={() => reload(n => n + 1)}>{t("s.38108eaa1d")}</Btn>
    </>} />
    {showNotes ? <Block title={t("lan.releaseNotes")}><Group>
      {notesError ? <ListItem title={notesError} right={<Btn onClick={() => void openNotes()}>{t("lan.retry")}</Btn>} /> :
        notes ? notes.map(entry => <ListItem key={`${entry.version}:${entry.date}`} title={entry.title} desc={entry.notes.join(" · ")} />) :
          <ListItem title={t("s.valueLoading")} />}
    </Group></Block> : null}
    <Block title={t("lan.publicCatalog")}>
      <SearchBox value={search} onChange={setSearch} />
      {status ? <p role="alert">{status}</p> : null}
      {data?.source === "cache" ? <p role="status" className="text-[13px]">{t("lan.catalogCached")}</p> : null}
      {busy && !data ? <p role="status">{t("s.valueLoading")}</p> : null}
      {data && !rows.length ? <p>{t("library.noHit")}</p> : null}
      <ul className="list-none p-0 m-0 divide-y divide-[var(--line)]">{rows.map(item => <PackageRow key={`${item.id}/${item.versionId}/${item.sha256}`} item={item} />)}</ul>
      <div className="flex items-center gap-2 mt-4">
        <Btn disabled={cursors.length === 1 || busy} onClick={() => changePage(cursors.slice(0, -1))}>{t("train.prev")}</Btn>
        <span className="text-[13px] tabular-nums">{cursors.length}</span>
        <Btn disabled={!data?.nextCursor || busy} onClick={() => { if (data?.nextCursor) changePage([...cursors, data.nextCursor]); }}>{t("train.next")}</Btn>
      </div>
    </Block>
  </PagePad>;
}
