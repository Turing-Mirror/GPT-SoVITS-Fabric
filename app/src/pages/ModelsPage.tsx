import { useState } from "react";
import { PagePad, PageHead, Block, Btn } from "../components/ui";
import { t } from "../i18n/t";

/**
 * 角色库。
 *
 * 一个「角色」= SoVITS 音色模型 + GPT 韵律模型 + 参考音频集（.list 标注）
 * + 元数据与推荐参数，打包为单个 zip。本页负责导入、管理与导出分享包；
 * 列表数据在 M1 由角色注册表（Rust）提供，当前为空态与导入流程骨架。
 */

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function ModelsPage({ onOpenPlaza }: { onOpenPlaza?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function importPack() {
    if (!isTauri()) {
      setMsg(t("library.demoImport"));
      return;
    }
    // M1：invoke("role_import_pack") —— Rust 侧解压校验后写入 User_Data/roles。
    setBusy(true);
    setMsg(t("library.importPending"));
    window.setTimeout(() => {
      setBusy(false);
      setMsg("");
    }, 1200);
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

      <Block title={t("library.installTitle")} note={t("library.installNote")}>
        <div className="rounded-[var(--r)] border border-dashed border-[var(--line)] p-6 max-w-[720px]">
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

      <Block title={t("library.listTitle")} note={t("library.listNote")}>
        <div className="rounded-[var(--r)] bg-[var(--surface)] shadow-[var(--glass)] p-6 text-center max-w-[720px]">
          <div className="text-[13.5px] font-medium">{t("library.emptyTitle")}</div>
          <div className="text-[12.5px] text-[var(--help)] mt-2 leading-relaxed max-w-[420px] mx-auto">
            {t("library.emptyDesc")}
          </div>
          <div className="mt-4 flex items-center justify-center gap-2 flex-wrap">
            <Btn onClick={() => onOpenPlaza?.()}>{t("library.emptyGoPlaza")}</Btn>
            <Btn onClick={() => void importPack()}>{t("library.emptyImport")}</Btn>
          </div>
        </div>
      </Block>

      <Block title={t("library.fmtTitle")} titleTip={t("library.fmtTip")}>
        <pre className="max-w-[720px] rounded-[var(--r)] bg-[var(--page-bg)] p-3.5 text-[11.5px] leading-relaxed text-[var(--ink-muted)] overflow-auto m-0">{`character.zip
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
