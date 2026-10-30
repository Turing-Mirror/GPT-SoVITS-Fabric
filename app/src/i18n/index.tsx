/**
 * 产品侧 i18n：语言状态与翻译由 TRM UI（vendor: ../trm）的 I18nProvider 统一
 * 持有，组件库里的控件和产品页面因此永远是同一种语言。这里只补三样：
 *
 * - Tauri 接线：语言存进 app_config.json，并通知 Rust 侧（托盘、worker 文案）。
 * - `tMsg`：把引擎回报的 `message_code` 解析成 `msg.*` 语言包条目。
 * - 术语表：`glossary.terms`，说明页与问号提示用。
 *
 * 用法不变：
 *   const { t, tMsg, locale, setLocale } = useI18n();
 */
import { useMemo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  I18nProvider as TrmI18nProvider,
  useI18n as useTrmI18n,
  isLocaleCode,
  type LocaleCode,
  type LocaleStore,
  type TranslateFn,
  type TVars,
} from "../trm/i18n";
import { fallbackPack, interpolate, lookup, packOf } from "../trm/i18n/dict";
import { t as tStaticExport } from "../trm/i18n/t";
import { setGlossaryLocale, termsFrom, type GlossaryTerm } from "./glossary";

export type { LocaleCode, GlossaryTerm, TranslateFn };
export { LOCALES, DEFAULT_LOCALE, detectSystemLocale, isLocaleCode } from "../trm/i18n";
export { t, setTLocale, getTLocale } from "../trm/i18n/t";
export { tip } from "./glossary";

type I18nCtx = {
  locale: LocaleCode;
  setLocale: (code: LocaleCode) => void;
  t: TranslateFn;
  /** 引擎的 `message_code`（`engine.starting` 或 `msg.engine.starting`）→ 文案。 */
  tMsg: (code: string | undefined | null, fallback?: string, vars?: TVars) => string;
  glossary: GlossaryTerm[];
  ready: boolean;
};

const tauriStore: LocaleStore = {
  load: async () => {
    const cfg = await invoke<Record<string, unknown>>("config_get");
    // 新装（还没在引导里确认过语言）：返回空，按系统语言预选。
    if (cfg.ui_locale_picked === false) return undefined;
    return isLocaleCode(cfg.ui_locale) ? cfg.ui_locale : undefined;
  },
  save: (code) => {
    void invoke("config_set", { patch: { ui_locale: code } }).catch(() => {});
    void invoke("i18n_set_locale", { locale: code }).catch(() => {});
  },
};

/** 浏览器预览没有壳，invoke 必失败；交给 TRM 默认的 localStorage。 */
const inHost = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function I18nProvider({ children }: { children: ReactNode }) {
  return inHost ? (
    <TrmI18nProvider store={tauriStore}>{children}</TrmI18nProvider>
  ) : (
    <TrmI18nProvider>{children}</TrmI18nProvider>
  );
}

export function useI18n(): I18nCtx {
  const { locale, setLocale, t, ready } = useTrmI18n();
  return useMemo(() => {
    setGlossaryLocale(locale);
    const primary = packOf(locale);
    const fb = fallbackPack();
    const tMsg: I18nCtx["tMsg"] = (code, fallback, vars) => {
      if (code) {
        const path = code.startsWith("msg.") ? code : `msg.${code}`;
        const hit = lookup(primary, path) ?? lookup(fb, path);
        if (typeof hit === "string") return interpolate(hit, vars);
      }
      return fallback ?? "";
    };
    return { locale, setLocale, t, tMsg, glossary: termsFrom(locale), ready };
  }, [locale, setLocale, t, ready]);
}

/** 不能用 hook 的模块（lib/*）用这个。不触发重渲染。 */
export function tStatic(key: string, vars?: TVars): string {
  return tStaticExport(key, vars);
}

export function useGlossary(): GlossaryTerm[] {
  return useI18n().glossary;
}

export function useGlossarySectionTitle(): string {
  const { t } = useI18n();
  return useMemo(() => t("glossary.sectionTitle"), [t]);
}
