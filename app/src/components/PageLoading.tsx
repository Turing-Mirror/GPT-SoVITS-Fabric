import { useI18n } from "../i18n";

export function PageLoading() {
  const { t } = useI18n();
  return <p role="status" className="m-0 px-6 py-4 text-[13px] text-[var(--meta)]">{t("s.f950213ab7")}</p>;
}
