import { peekCharacters, readCharacters } from "../lib/characters";
import { useCallback, useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Btn } from "../components/ui";
import { useI18n } from "../i18n";
import { t } from "../i18n/t";
import type { PageId } from "../lib/nav";
import { synthWithRole } from "../lib/intent";
import { artOf } from "trm-ui";
import { ThumbImage } from "trm-ui";
import { FittedItems } from "../components/FittedItems";
import { listen } from "@tauri-apps/api/event";
import { useConfigSnapshot } from "../hooks/useConfigSnapshot";
import emblem from "../assets/brand/gsvf-main-logo.svg";

/**
 * 首页。
 *
 * 三件事：一眼可用的入口（快速合成 / 角色库 / 训练台）、当前角色的最近合成、
 * 社区入口。浏览器预览模式下角色网格使用内置演示数据。
 */

type Props = {
  onNavigate: (id: PageId) => void;
  active?: boolean;
};

type Role = {
  id: string;
  name?: string;
  version?: string;
  cover?: string;
  cover_exists?: boolean;
  dir?: string;
};

type Recent = { name: string; path: string; mtime: number };
const homeSnapshot: { roles: Role[] | null; recent: Recent[] | null } = { roles: null, recent: null };

const DEMO_ROLES: Role[] = [
  { id: "tendou_alice", name: "天童爱丽丝", version: "v2ProPlus" },
  { id: "hoshino", name: "小鸟游星野", version: "v2ProPlus" },
  { id: "serika", name: "黑见芹香", version: "v2ProPlus" },
  { id: "mutsuki", name: "浅黄睦月", version: "v2ProPlus" },
];

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 首页横幅的自定义文案与当前角色（设置 → 外观、合成页）。标题留空 = 默认标题；
 * 副标题留空 = 不显示。配置快照跨页保留，改完立刻生效。
 */
function useBannerConfig() {
  const { config, loaded } = useConfigSnapshot();
  const str = (key: string) => typeof config[key] === "string" ? (config[key] as string).trim() : "";
  return { title: str("home_banner_text"), sub: str("home_banner_sub"), role: str("synth_role"),
    ready: loaded || !("__TAURI_INTERNALS__" in window) };
}

/**
 * 横幅底色。--banner-opacity 由 applyAppearance 写到 <html> 上（默认 1），
 * 只混这一格的背景色，文字与标志不受影响。
 */
const STAGE_BG = "color-mix(in srgb, var(--stage) calc(var(--banner-opacity, 1) * 100%), transparent)";

function fmtAgo(mtime: number): string {
  const diff = Date.now() / 1000 - mtime;
  if (diff < 60) return t("home.justNow");
  if (diff < 3600) return t("home.mAgo", { v0: String(Math.floor(diff / 60)) });
  if (diff < 86400) return t("home.hAgo", { v0: String(Math.floor(diff / 3600)) });
  return t("home.dAgo", { v0: String(Math.floor(diff / 86400)) });
}

export function HomePage({ onNavigate, active = true }: Props) {
  const { locale } = useI18n();
  void locale;
  const [roles, setRoles] = useState<Role[] | null>(() => isTauri() ? peekCharacters() ?? homeSnapshot.roles : DEMO_ROLES);
  const [recent, setRecent] = useState<Recent[] | null>(() => isTauri() ? homeSnapshot.recent : []);
  const banner = useBannerConfig();

  useEffect(() => {
    if (!isTauri() || !active) return;
    let alive = true;
    const refresh = () => {
    void readCharacters()
      .then((r) => { if (alive) { homeSnapshot.roles = r; setRoles(homeSnapshot.roles); } })
      .catch(() => {});
    void invoke<Recent[]>("synth_recent")
      .then((r) => { if (alive) { homeSnapshot.recent = Array.isArray(r) ? r : []; setRecent(homeSnapshot.recent); } })
      .catch(() => {});
    };
    refresh();
    let off: (() => void) | undefined;
    void listen("synth-done", refresh).then((fn) => { if (alive) off = fn; else fn(); }).catch(() => {});
    return () => { alive = false; off?.(); };
  }, [active]);

  const pickRole = useCallback(
    (r: Role) => {
      synthWithRole(r.id);
    },
    [],
  );

  const current = roles?.find((r) => r.id === banner.role);

  return (
    <div className="home-page">
      <div className="home-banner" style={{ background: STAGE_BG }}>
        <h2 title={banner.ready ? banner.title || t("home.bannerTitle") : ""}>{banner.ready ? banner.title || t("home.bannerTitle") : ""}</h2>
        <p className="home-current" title={current ? current.name || current.id : roles && banner.ready ? t("home.noRole") : ""}>
          {current ? current.name || current.id : roles && banner.ready ? t("home.noRole") : ""}
        </p>
        {banner.sub ? <p className="home-sub" title={banner.sub}>{banner.sub}</p> : null}
        <img src={emblem} alt="" aria-hidden draggable={false} className="home-emblem" />
      </div>
      <div className="home-content">
        <div className="home-shortcuts">
          {[
            { id: "synth" as PageId, title: t("home.qSynth"), desc: t("home.qSynthDesc") },
            { id: "models" as PageId, title: t("home.qLibrary"), desc: t("home.qLibraryDesc") },
            { id: "train" as PageId, title: t("home.qTrain"), desc: t("home.qTrainDesc") },
          ].map((c) => (
            <button key={c.id} type="button" onClick={() => onNavigate(c.id)}
              className="home-shortcut" title={c.desc}>
              <span className="font-semibold">{c.title}</span>
              <span className="home-shortcut-desc">{c.desc}</span>
            </button>
          ))}
        </div>
        <section className="home-section">
          <div className="home-section-head">
            <h3>{t("home.rolesTitle")}</h3>
            {!isTauri() ? <span className="text-[11px] text-[var(--meta)]">{t("synth.demoBadge")}</span> : null}
            <Btn onClick={() => onNavigate("models")}>{t("home.allRoles")}</Btn>
          </div>
          {roles === null ? null : roles.length === 0 ? <div className="home-empty">{t("home.rolesEmpty")}</div> : (
            <FittedItems className="home-role-grid" items={roles.map((r) => (
              <button key={r.id} type="button" onClick={() => pickRole(r)} className="home-role" title={r.name || r.id}>
                {r.cover_exists && r.cover && r.dir && isTauri() ? (
                  <ThumbImage src={convertFileSrc(`${r.dir}/${r.cover}`)} alt="" draggable={false} />
                ) : <div className="home-role-art" style={{ background: artOf(r.id) }} />}
                <span className="block truncate text-[13px] font-medium">{r.name || r.id}</span>
                <span className="block truncate text-[11px] text-[var(--meta)] mt-0.5">{r.version || ""}</span>
              </button>
            ))} />
          )}
        </section>
        <section className="home-section home-recent">
          <div className="home-section-head">
            <h3>{t("home.recentTitle")}</h3>
            <span className="text-[11px] text-[var(--meta)]">{t("home.recentNote")}</span>
          </div>
          {recent === null ? null : recent.length === 0 ? <div className="home-empty">{t("home.recentEmpty")}</div> : (
            <FittedItems className="home-recent-list" items={recent.map((r) => (
              <button key={r.path} type="button" title={r.name}
                onClick={() => void invoke("synth_reveal_file", { path: r.path }).catch(() => {})}
                className="home-recent-item">
                <span className="truncate min-w-0">{r.name}</span>
                <span className="text-[11px] text-[var(--meta)] shrink-0 tabular-nums">{fmtAgo(r.mtime)}</span>
              </button>
            ))} />
          )}
        </section>
      </div>
    </div>
  );
}
