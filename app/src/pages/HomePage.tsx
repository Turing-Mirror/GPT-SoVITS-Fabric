import { useCallback, useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { PagePad, Block, Btn } from "../components/ui";
import { useI18n } from "../i18n";
import { t } from "../i18n/t";
import type { PageId } from "../lib/nav";
import { synthWithRole } from "../lib/intent";
import { artOf } from "../lib/art";
import { stagger } from "../components/Motion";
import { getConfig, onConfigPatch } from "../lib/config";

/**
 * 首页。
 *
 * 三件事：一眼可用的入口（快速合成 / 角色库 / 训练台）、当前角色的最近合成、
 * 社区入口。浏览器预览模式下角色网格使用内置演示数据。
 */

type Props = {
  onNavigate: (id: PageId) => void;
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
 * 副标题留空 = 不显示。配置变化走 onConfigPatch，改完立刻生效。
 */
function useBannerConfig(): { title: string; sub: string; role: string } {
  const [v, setV] = useState({ title: "", sub: "", role: "" });
  useEffect(() => {
    let alive = true;
    const str = (x: unknown) => (typeof x === "string" ? x : undefined);
    void getConfig()
      .then((c) => {
        if (alive) setV({ title: str(c.home_banner_text) ?? "", sub: str(c.home_banner_sub) ?? "", role: str(c.synth_role) ?? "" });
      })
      .catch(() => {
        /* 浏览器预览里没有 Tauri 后端，用默认标题 */
      });
    const off = onConfigPatch((p) =>
      setV((prev) => ({
        title: str(p.home_banner_text) ?? prev.title,
        sub: str(p.home_banner_sub) ?? prev.sub,
        role: str(p.synth_role) ?? prev.role,
      })),
    );
    return () => {
      alive = false;
      off();
    };
  }, []);
  return { title: v.title.trim(), sub: v.sub.trim(), role: v.role };
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

export function HomePage({ onNavigate }: Props) {
  const { locale } = useI18n();
  void locale;
  const [roles, setRoles] = useState<Role[]>(isTauri() ? [] : DEMO_ROLES);
  const [recent, setRecent] = useState<Recent[]>([]);
  const banner = useBannerConfig();

  useEffect(() => {
    if (!isTauri()) return;
    void invoke<{ roles?: Role[] }>("synth_characters")
      .then((r) => setRoles(r?.roles ?? []))
      .catch(() => {});
    void invoke<Recent[]>("synth_recent")
      .then((r) => setRecent(Array.isArray(r) ? r : []))
      .catch(() => {});
  }, []);

  const pickRole = useCallback(
    (r: Role) => {
      if (isTauri()) {
        void invoke("config_set", { patch: { synth_role: r.id } }).catch(() => {});
      }
      synthWithRole(r.id);
    },
    [],
  );

  const current = roles.find((r) => r.id === banner.role);

  return (
    <div>
      <div
        className="relative overflow-hidden px-[30px] pt-8 pb-7 max-[1020px]:px-[22px] max-[1020px]:pt-7 max-[1020px]:pb-6 max-[720px]:px-4 max-[720px]:pt-[22px] max-[720px]:pb-5"
        style={{ background: STAGE_BG }}
      >
        <h2 className="text-[27px] font-semibold tracking-tight m-0 mb-[15px] max-[860px]:text-2xl">{banner.title || t("home.bannerTitle")}</h2>
        <p className="text-[19px] font-semibold text-[var(--accent)] m-0">
          {current ? current.name || current.id : t("home.noRole")}
        </p>
        {banner.sub ? <p className="text-[12.5px] text-[var(--ink-muted)] m-0 mt-1.5">{banner.sub}</p> : null}
      </div>
    <PagePad>
      {/* 入口卡 */}
      <Block>
        <div className="grid grid-cols-3 max-[760px]:grid-cols-1 gap-[10px]">
          {[
            { id: "synth" as PageId, title: t("home.qSynth"), desc: t("home.qSynthDesc") },
            { id: "models" as PageId, title: t("home.qLibrary"), desc: t("home.qLibraryDesc") },
            { id: "train" as PageId, title: t("home.qTrain"), desc: t("home.qTrainDesc") },
          ].map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onNavigate(c.id)}
              className="text-left rounded-[var(--r)] bg-transparent p-4 cursor-pointer border-0 shadow-[inset_0_0_0_1px_var(--line)] hover:shadow-[inset_0_0_0_1px_var(--accent)] active:scale-[0.98] transition-all duration-200 ease-[var(--ease)]"
            >
              <div className="text-[14.5px] font-semibold">{c.title}</div>
              <div className="text-[12.5px] text-[var(--help)] mt-1.5 leading-relaxed">{c.desc}</div>
            </button>
          ))}
        </div>
      </Block>

      {/* 角色速选 */}
      <Block
        title={t("home.rolesTitle")}
        note={!isTauri() ? t("synth.demoBadge") : undefined}
        action={
          <Btn onClick={() => onNavigate("models")}>{t("home.allRoles")}</Btn>
        }
      >
        {roles.length === 0 ? (
          <div className="rounded-[var(--r)] border border-dashed border-[var(--line)] p-6 text-center text-[12.5px] text-[var(--help)]">
            {t("home.rolesEmpty")}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-[10px]">
            {roles.map((r, i) => {
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => pickRole(r)}
                  style={stagger(i)}
                  className="rise text-left rounded-[var(--r)] p-2.5 cursor-pointer border-0 bg-[var(--group)] hover:bg-[color-mix(in_srgb,var(--ink)_5%,transparent)] active:scale-[0.97] transition-all duration-200 ease-[var(--ease)]"
                >
                  {r.cover_exists && r.cover && r.dir && isTauri() ? (
                    <img
                      src={convertFileSrc(`${r.dir}/${r.cover}`)}
                      alt={r.name || r.id}
                      draggable={false}
                      className="w-full aspect-[5/3] rounded-[calc(var(--r)-4px)] mb-2 object-cover"
                    />
                  ) : (
                    <div
                      className="w-full aspect-[5/3] rounded-[calc(var(--r)-4px)] mb-2"
                      style={{ background: artOf(r.id) }}
                    />
                  )}
                  <div className="text-[13px] font-medium leading-tight">{r.name || r.id}</div>
                  <div className="text-[11px] text-[var(--meta)] mt-0.5">{r.version || ""}</div>
                </button>
              );
            })}
          </div>
        )}
      </Block>

      {/* 最近合成 */}
      <Block title={t("home.recentTitle")} note={t("home.recentNote")}>
        {recent.length === 0 ? (
          <div className="rounded-[var(--r)] border border-dashed border-[var(--line)] p-6 text-center text-[12.5px] text-[var(--help)]">
            {t("home.recentEmpty")}
          </div>
        ) : (
          <ul className="m-0 list-none p-0">
            {recent.map((r) => (
              <li key={r.path} className="py-1.5 first:pt-0 last:pb-0">
                <button
                  type="button"
                  onClick={() => void invoke("synth_reveal_file", { path: r.path }).catch(() => {})}
                  className="w-full text-left bg-transparent border-0 p-0 cursor-pointer flex items-baseline gap-3 group"
                >
                  <span className="text-[12.5px] text-[var(--ink)] break-all flex-1 group-hover:underline">
                    {r.name}
                  </span>
                  <span className="text-[11px] text-[var(--meta)] shrink-0 tabular-nums">
                    {fmtAgo(r.mtime)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </PagePad>
    </div>
  );
}
