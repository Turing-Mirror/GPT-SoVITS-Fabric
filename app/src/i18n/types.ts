/** 语言代码、可选语言与系统语言识别。实现在 TRM UI。 */
export {
  LOCALES,
  DEFAULT_LOCALE,
  isLocaleCode,
  detectSystemLocale,
} from "../trm/i18n/types";
export type { LocaleCode, Dict, TVars, TranslateFn } from "../trm/i18n/types";

/** 术语表的一条。数据在语言包的 `glossary.terms`。 */
export type GlossaryTerm = {
  id: string;
  term: string;
  brief: string;
  detail: string;
};
