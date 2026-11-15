import { useEffect, useState } from "react";
import { SearchBox, useMenu, usePaneOn, type MenuItem } from "trm-ui";
import { useI18n } from "../i18n";
import { openExternal } from "../lib/plaza";
import { publication, publicationError, validUrl, type CatalogModel } from "../lib/communityPublication";
import { Btn, Group, PageHead, PagePad, Warn } from "./ui";
import { CatalogTransition } from "./CatalogTransition";
import { CommunityThumb } from "./CommunityThumb";
import { Pager } from "./Pager";

type AuthorList = { name?: string; items: CatalogModel[]; nextCursor?: string };
const PAGE_SIZE = 8;

export function CommunityAuthor({ author, owned, onBack, onNewVersion, onEditListing, onView }: {
  author?: string;
  owned?: boolean;
  onBack: () => void;
  onNewVersion?: (item: CatalogModel) => void;
  onEditListing?: (item: CatalogModel) => void;
  onView: (item: CatalogModel) => void;
}) {
  const { t, locale } = useI18n();
  const active = usePaneOn();
  const menu = useMenu();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState<Record<number, AuthorList>>({});
  const [profile, setProfile] = useState<{ name?: string; url?: string }>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const result = pages[page];
  const cursor = pages[page - 1]?.nextCursor;

  useEffect(() => {
    const next = query.trim();
    if (next === search) return;
    const timer = window.setTimeout(() => {
      setSearch(next);
      setPages({});
      setPage(1);
      setError("");
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query, search]);

  useEffect(() => {
    if (!active || result || (page > 1 && !cursor)) return;
    let current = true;
    const options = { query: search || undefined, cursor, limit: PAGE_SIZE };
    const load = owned ? publication<AuthorList>({ action: "owned", ...options })
      : publication<AuthorList>({ action: "author", id: author || "", ...options });
    void load.then((next) => {
      if (!current) return;
      const url = next.items.find((item) => item.authorUrl && validUrl(item.authorUrl))?.authorUrl;
      if (next.name || url) setProfile((previous) => ({ name: next.name ?? previous?.name, url: url ?? previous?.url }));
      setPages((previous) => ({ ...previous, [page]: next }));
    }).catch((cause) => { if (current) setError(publicationError(cause, "list")); });
    return () => { current = false; };
  }, [active, author, cursor, owned, page, result, retry, search]);

  function showActions(item: CatalogModel, anchor: HTMLElement) {
    const actions: MenuItem[] = [];
    if (onEditListing) actions.push({ id: "edit", label: t("publication.editListing"), onSelect: () => onEditListing(item) });
    if (onNewVersion) actions.push({ id: "version", label: t("publication.newVersion"), onSelect: () => onNewVersion(item) });
    if (item.upstreamUrl && validUrl(item.upstreamUrl)) actions.push({
      id: "source", label: t("s.voiceLinkSource"), onSelect: () => void openExternal(item.upstreamUrl!),
    });
    if (actions.length) menu.open(anchor, actions);
  }

  const furthest = Math.max(1, ...Object.keys(pages).map(Number));
  const availablePages = pages[furthest]?.nextCursor ? furthest + 1 : furthest;

  return <PagePad width="wide">
    <PageHead title={owned ? t("publication.myModels") : profile?.name || t("s.voiceLinkAuthor")} back={onBack}
      actions={!owned && profile?.url && <Btn text onClick={() => void openExternal(profile.url!)}>{t("publication.externalAuthor")}</Btn>} />
    <div className="mb-4 mt-3"><SearchBox value={query} ariaLabel={t("ui.common.search")} onChange={setQuery} /></div>
    {error && <Warn className="mb-4">{error} <Btn text onClick={() => { setError(""); setRetry((n) => n + 1); }}>{t("s.38108eaa1d")}</Btn></Warn>}
    <CatalogTransition scope={search} page={page}>
      {result?.items.length ? (
        <Group>
          <div className="divide-y divide-[var(--hairline)]">
            {result.items.map((item) => {
              const name = item.metadata?.nameI18n?.[locale] || item.title;
              const base = item.compatibleVersion.metadata?.familyVersion ?? item.metadata?.familyVersion;
              const hasMenu = onNewVersion || (item.upstreamUrl && validUrl(item.upstreamUrl));
              return <article key={item.id} className="flex flex-wrap items-center gap-3 py-3">
                <CommunityThumb title={name} src={item.coverUrl} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="break-words text-[13px] font-semibold">{name}</div>
                  <div className="flex flex-wrap gap-x-2 text-[11.5px] text-[var(--help)]">
                    <span>{item.compatibleVersion.label}</span>
                    {base && <span>{t("s.roleBaseVersion", { v0: base })}</span>}
                  </div>
                </div>
                <Btn text onClick={() => onView(item)}>{t("s.f7acefd2d4")}</Btn>
                {hasMenu && <Btn text ariaLabel={t("ui.common.more")} onClick={(event) => showActions(item, event.currentTarget)}>⋯</Btn>}
              </article>;
            })}
          </div>
        </Group>
      ) : !error && <p className="py-4 text-[13px] text-[var(--help)]" role="status">
        {result ? t(search ? "library.noHit" : "publication.noModels") : t("s.f950213ab7")}
      </p>}
    </CatalogTransition>
    {availablePages > 1 && <Pager page={page} pages={availablePages} onChange={(next) => { setError(""); setPage(next); }} />}
    {menu.node}
  </PagePad>;
}
