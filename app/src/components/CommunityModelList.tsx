import { useEffect, useState } from "react";
import { SearchBox, useMenu, usePaneOn, type MenuItem } from "trm-ui";
import { useI18n } from "../i18n";
import { openExternal } from "../lib/plaza";
import { publication, publicationError, validUrl, type CatalogModel } from "../lib/communityPublication";
import { Btn, Group, PageHead, Warn } from "./ui";
import { CatalogTransition } from "./CatalogTransition";
import { CommunityThumb } from "./CommunityThumb";
import { Pager } from "./Pager";

type ModelPage = { name?: string; items: CatalogModel[]; nextCursor?: string };
type ModelListState = {
  scope: string | null;
  opened: boolean;
  query: string;
  search: string;
  page: number;
  pages: Record<number, ModelPage>;
  profile?: { name?: string; url?: string };
  error: string;
  busy: boolean;
  refreshing: boolean;
};
const PAGE_SIZE = 8;

function emptyList(scope: string | null): ModelListState {
  return { scope, opened: false, query: "", search: "", page: 1, pages: {}, error: "", busy: false, refreshing: false };
}

export function useCommunityModels({ account, author, active }: {
  account?: string | null;
  author?: string;
  active: boolean;
}) {
  const scope = author ?? account ?? null;
  const [state, setState] = useState(() => emptyList(scope));
  const { opened, query, search, page, pages, profile, error, busy, refreshing } = state;
  const result = pages[page];
  const cursor = pages[page - 1]?.nextCursor;
  if (state.scope !== scope) {
    setState(emptyList(scope));
  } else if (active && scope !== null && !opened) {
    setState({ ...state, opened: true });
  }

  useEffect(() => {
    const next = query.trim();
    if (next === search) return;
    const timer = window.setTimeout(() => {
      setState((value) => ({ ...value, search: next, pages: {}, page: 1, error: "", busy: false, refreshing: false }));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query, scope, search]);

  useEffect(() => {
    // Leave requests running across tab switches. The list lives above the animated content.
    if (!opened || scope === null || error || (result && !refreshing) || (page > 1 && !cursor)) return;
    let current = true;
    const isCurrentRequest = (value: ModelListState) => value.scope === scope &&
      value.search === search && value.page === page && value.refreshing === refreshing;
    setState((value) => isCurrentRequest(value) ? { ...value, busy: true } : value);
    const options = { query: search || undefined, cursor, limit: PAGE_SIZE };
    const load = author ? publication<ModelPage>({ action: "author", id: author, ...options })
      : publication<ModelPage>({ action: "owned", ...options });
    void load.then((next) => {
      if (!current) return;
      const url = author ? next.items.find((item) => item.authorUrl && validUrl(item.authorUrl))?.authorUrl : undefined;
      setState((value) => isCurrentRequest(value) ? {
        ...value,
        pages: { ...(refreshing ? {} : value.pages), [page]: next },
        profile: author ? { name: next.name ?? value.profile?.name, url: url ?? value.profile?.url } : undefined,
        busy: false,
        refreshing: false,
      } : value);
    }).catch((cause) => {
      if (current) setState((value) => isCurrentRequest(value)
        ? { ...value, error: publicationError(cause, "list"), busy: false, refreshing: false }
        : value);
    });
    return () => { current = false; };
  }, [author, cursor, error, opened, page, refreshing, result, scope, search]);

  const furthest = Math.max(1, ...Object.keys(pages).map(Number));
  const availablePages = pages[furthest]?.nextCursor ? furthest + 1 : furthest;

  return {
    query, search, page, result, profile, error, busy, availablePages,
    setQuery: (query: string) => setState((value) => ({ ...value, query })),
    setPage: (page: number) => setState((value) => value.page === page ? value
      : { ...value, page, busy: false, refreshing: false, error: "" }),
    refresh: () => setState((value) => value.busy || value.refreshing ? value
      : { ...value, page: 1, refreshing: true, error: "" }),
    retry: () => setState((value) => ({ ...value, error: "", refreshing: Boolean(value.pages[value.page]) })),
  };
}

export function CommunityAuthorModels({ author, onBack, onView }: {
  author: string;
  onBack: () => void;
  onView: (item: CatalogModel) => void;
}) {
  const active = usePaneOn();
  const list = useCommunityModels({ author, active });
  return <CommunityModelList list={list} onBack={onBack} onView={onView} />;
}

export function CommunityModelList({ list, onBack, onManage, onView }: {
  list: ReturnType<typeof useCommunityModels>;
  onBack?: () => void;
  onManage?: (item: CatalogModel, action: "listing" | "version") => void;
  onView: (item: CatalogModel) => void;
}) {
  const { t, locale } = useI18n();
  const menu = useMenu();
  const { query, search, profile, page, result, error, availablePages, setQuery, setPage, retry } = list;

  function showActions(item: CatalogModel, anchor: HTMLElement) {
    const actions: MenuItem[] = [];
    if (onManage) actions.push(
      { id: "edit", label: t("publication.editListing"), onSelect: () => onManage(item, "listing") },
      { id: "version", label: t("publication.newVersion"), onSelect: () => onManage(item, "version") },
    );
    if (item.upstreamUrl && validUrl(item.upstreamUrl)) actions.push({
      id: "source", label: t("s.voiceLinkSource"), onSelect: () => void openExternal(item.upstreamUrl!),
    });
    if (actions.length) menu.open(anchor, actions);
  }

  return <>
    {onBack && <PageHead title={profile?.name || t("s.voiceLinkAuthor")} back={onBack}
      actions={profile?.url && <Btn text onClick={() => void openExternal(profile.url!)}>{t("publication.externalAuthor")}</Btn>} />}
    <div className="mb-4 mt-3"><SearchBox value={query} ariaLabel={t("ui.common.search")} onChange={setQuery} /></div>
    {error && <Warn className="mb-4">{error} <Btn text onClick={retry}>{t("s.38108eaa1d")}</Btn></Warn>}
    <CatalogTransition scope={search} page={page}>
      {result?.items.length ? (
        <Group>
          <div className="divide-y divide-[var(--hairline)]">
            {result.items.map((item) => {
              const name = item.metadata?.nameI18n?.[locale] || item.title;
              const base = item.compatibleVersion.metadata?.familyVersion ?? item.metadata?.familyVersion;
              const hasMenu = onManage || (item.upstreamUrl && validUrl(item.upstreamUrl));
              const published = onManage ? item.compatibleVersion.createdAt : undefined;
              return <article key={item.id} className="flex flex-wrap items-center gap-3 py-3">
                <CommunityThumb title={name} src={item.coverUrl} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="break-words text-[13px] font-semibold">{name}</div>
                  <div className="flex flex-wrap gap-x-2 text-[11.5px] text-[var(--help)]">
                    <span>{item.compatibleVersion.label}</span>
                    {published && !Number.isNaN(Date.parse(published)) && <time dateTime={published}>
                      {new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(published))}
                    </time>}
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
    {availablePages > 1 && <Pager page={page} pages={availablePages} onChange={setPage} />}
    {menu.node}
  </>;
}
