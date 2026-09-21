import { useCallback, useEffect, useState } from "react";
import { PagePad, PageHead, Block, Btn, ListItem } from "../components/ui";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "@tauri-apps/api/core";
import { AdBanner } from "../components/AdBanner";
import type { PlazaItem } from "../lib/plaza";
import { t } from "../i18n/t";

/**
 * 角色库。
 *
 * 一个「角色」= SoVITS 音色模型 + GPT 韵律模型 + 参考音频集（.list 标注）
 * + 元数据与推荐参数，打包为单个 zip。本页负责导入、管理与导出分享包；
 * 导入走 `role_import_pack`：Rust 侧解压、校验（zip-slip / 体积 / 两份权重
 * 齐全）后落到 `User_Data/characters/<id>/`，也就是合成台扫的那个目录。
 *
 * 「本地角色」那一段读的是 `synth_characters` —— 和合成台扫的是同一份数据，
 * 所以这里列出来的和那边下拉框里能选的必然一致。它以前是块写死的空态骨架：
 * 导入成功之后这一页仍然显示「还没有本地角色」，用户只能去合成台确认到底
 * 装没装上。
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

  const reload = useCallback(() => {
    if (!isTauri()) return;
    void invoke<{ roles?: Role[] }>("synth_characters")
      .then((r) => setRoles(r?.roles ?? []))
      .catch(() => setRoles([]));
  }, []);

  useEffect(reload, [reload]);

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
      // 导入完当场刷新。不刷的话这一页还写着「还没有本地角色」，
      // 而上面那行刚说「已导入」—— 两句话互相打架。
      reload();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PagePad>
      <PageHead
        title={t("library.title")}
        sub={t("library.subtitle")}
        actions={
          <Btn onClick={() => onOpenPlaza?.()}>{t("library.goPlaza")}</Btn>
        }
      />

      {/* 广场投放。Rust 侧一直在 `plaza_feed` 里返回 banner，
          而 `usePlaza` 把它丢掉、这一页也没挂过组件 —— 投放位形同虚设。 */}
      <AdBanner banner={banner ?? null} />

      <Block title={t("library.installTitle")} note={t("library.installNote")}>
        <div className="rounded-[var(--r)] border border-dashed border-[var(--line)] p-6">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium">{t("library.packName")}</div>
              <div className="text-[12px] text-[var(--help)] mt-1 leading-relaxed">
                {t("library.packDesc")}
              </div>
            </div>
            <Btn primary busy={busy} onClick={() => void importPack()}>
              {t("library.import")}
            </Btn>
          </div>
          {msg ? (
            <div className="mt-3 text-[12.5px] text-[var(--accent)]">{msg}</div>
          ) : null}
        </div>
      </Block>

      <Block
        title={t("library.listTitle")}
        note={roles.length ? t("library.listCount", { v0: String(roles.length) }) : t("library.listNote")}
      >
        {roles.length ? (
          <div className=" rounded-[var(--r)] bg-[var(--group)] px-5 py-2">
            {roles.map((r) => (
              <ListItem
                key={r.id}
                title={r.name || r.id}
                desc={[
                  r.author || "",
                  r.version || "",
                  // 参考音频有几条 —— 合成台挑参考时就是从这里选，
                  // 一条都没有的包能装上但用不了，这里得看得出来。
                  t("library.refCount", {
                    v0: String((r.lists ?? []).reduce((n, l) => n + (l.rows?.length ?? 0), 0)),
                  }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                right={
                  r.cover_exists && r.cover && isTauri() ? (
                    <img
                      src={convertFileSrc(`${r.dir}/${r.cover}`)}
                      alt=""
                      className="w-10 h-10 rounded-[var(--rs)] object-cover"
                      loading="lazy"
                    />
                  ) : undefined
                }
              />
            ))}
          </div>
        ) : (
        <div className="rounded-[var(--r)] border border-dashed border-[var(--line)] p-6 text-center">
          <div className="text-[13.5px] font-medium">{t("library.emptyTitle")}</div>
          <div className="text-[12.5px] text-[var(--help)] mt-2 leading-relaxed max-w-[420px] mx-auto">
            {t("library.emptyDesc")}
          </div>
          <div className="mt-4 flex items-center justify-center gap-2 flex-wrap">
            <Btn onClick={() => onOpenPlaza?.()}>{t("library.emptyGoPlaza")}</Btn>
            <Btn onClick={() => void importPack()}>{t("library.emptyImport")}</Btn>
          </div>
        </div>
        )}
      </Block>

      <Block title={t("library.fmtTitle")} titleTip={t("library.fmtTip")}>
        <pre className=" rounded-[var(--r)] bg-[var(--page-bg)] p-3.5 text-[11.5px] leading-relaxed text-[var(--ink-muted)] overflow-auto m-0">{`character.zip
├─ config.json      # 名称 / 作者 / 版本 / 推荐参数
├─ cover.jpg
├─ models/
│  ├─ sovits.pth    # 音色模型
│  └─ gpt.ckpt      # 韵律模型
└─ dataset/
   ├─ name.list     # 音频路径|说话人|语种|文本
   └─ audios/`}</pre>
      </Block>
    </PagePad>
  );
}
