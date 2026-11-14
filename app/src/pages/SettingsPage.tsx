import { useEffect, useMemo, useState, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TextInput } from "trm-ui";
import { CatalogTransition } from "../components/CatalogTransition";
import { SegmentControl } from "../components/SegmentControl";
import { Btn, Block, PagePad } from "../components/ui";
import { Field, Select, Slider, Toggle } from "../components/controls";
import { useConfig } from "../hooks/useConfig";
import { tips } from "../lib/config";
import type { EngineStatus } from "../lib/engine";
import { LOCALES, useI18n, type LocaleCode } from "../i18n";

const TAB_KEYS = [
  "appearance",
  "general",
  "update",
] as const;

type TabKey = (typeof TAB_KEYS)[number];

async function pickWallpaper(
  set: (key: string, value: unknown, defer?: boolean) => void,
) {
  const p = await invoke<string | null>("pick_wallpaper");
  if (p) set("wallpaper_path", p);
}

async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    return await invoke<T>(cmd, args);
  } catch {
    // 浏览器预览 / 引擎未就绪时静默：设置页不能因为一个探测失败整页崩。
    return null;
  }
}


type Props = {
  status?: EngineStatus;
  onReloadDevices?: () => void;
  /** True while the worker is re-enumerating. */
  devicesBusy?: boolean;
  /** False until the worker finishes its cold start, which is when device
   *  names first exist. Drives the empty-state line below. */
  workerAlive?: boolean;
  onCheckUpdate?: () => void;
  updateLine?: string;
  updateBusy?: boolean;
  /** 跳到说明页。设备这一套（虚拟声卡怎么连）的解释全在那边，
   *  这里只放一个入口，不把同一段话再抄一遍。 */
  onOpenHelp?: () => void;
  /** 跳到「其他」页的仓库与社媒。说明页解决不了的，只能找人。 */
  onOpenCommunity?: () => void;
};


const CARD =
  "bg-[var(--group)] rounded-[var(--r)] px-5 py-[22px] flex flex-col gap-6";

function SettingsPageImpl({
  onCheckUpdate,
  updateLine,
  updateBusy = false,
  onOpenCommunity,
}: Props = {}) {
  const { t, locale, setLocale } = useI18n();
  // Must re-resolve on locale change — module-level t() freezes zh-CN at import.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tips() 读全局语言，locale 是重算信号
  const TIPS = useMemo(() => tips(), [locale]);
  const tabLabels = useMemo(
    () =>
      Object.fromEntries(
        TAB_KEYS.map((k) => [k, t(`settings.tabs.${k}`)]),
      ) as Record<TabKey, string>,
    [t],
  );
  const [tab, setTab] = useState<TabKey>("appearance");
  const c = useConfig();
  // 开机自启：状态以注册表为准（autostart_get），不进 app_config。
  const [autoStart, setAutoStart] = useState(false);
  const [autoStartBusy, setAutoStartBusy] = useState(false);
  /** 上一次注册的结果。被别的软件占掉的组合要说出来，不然用户只会觉得没生效。 */
  const [hotkeyFailed, setHotkeyFailed] = useState<string[]>([]);
  const applyHotkeys = async (enabled: boolean) => {
    const r = await safeInvoke<{ failed?: string[] }>("hotkeys_apply", { enabled });
    setHotkeyFailed(r?.failed ?? []);
  };
  const hotkeyNote = hotkeyFailed.length
    ? t("settings.hotkeyTaken", { v0: hotkeyFailed.join(", ") })
    : undefined;
  useEffect(() => {
    let alive = true;
    void safeInvoke<{ enabled: boolean }>("autostart_get").then((s) => {
      if (alive && s) setAutoStart(s.enabled);
    });
    return () => {
      alive = false;
    };
  }, []);
  // 「在线更新」里那行当前版本。和「其他」页读的是同一个命令，也就是同一个
  // APP_VERSION —— 两处显示不一致的话，一定是有人又手写了版本号。
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    let alive = true;
    void safeInvoke<string>("shell_version").then(
      (v) => alive && setAppVersion(v || ""),
    );
    return () => {
      alive = false;
    };
  }, []);


  return (
    <div>
      {/* 「联系社区」跟标签栏同一行，卡住的人不会先想到
          去翻「其他」页，得让求助的路在他正卡着的那一页上就看得见。 */}
      <div className="px-[30px] pt-4 max-[1020px]:px-[22px] max-[720px]:px-4 flex items-center gap-3 flex-wrap">
        <div className="min-w-0">
          <SegmentControl
            options={TAB_KEYS.map((k) => ({ id: k, label: tabLabels[k] }))}
            value={tab}
            onChange={setTab}
            className="!inline-flex !ml-0 max-w-full"
          />
        </div>
        {onOpenCommunity ? (
          <Btn className="ml-auto shrink-0" onClick={onOpenCommunity}>
            {t("s.contactCommunity")}
          </Btn>
        ) : null}
      </div>

      <PagePad>
        {c.error ? (
          <p className="text-[12.5px] text-[var(--danger-text)] mt-4 mb-0">{c.error}</p>
        ) : null}

        {c.restartKeys.length ? (
          <div className="mt-4 rounded-[var(--rs)] bg-[color-mix(in_srgb,var(--notify)_14%,transparent)] px-3.5 py-2.5 flex items-center gap-3 flex-wrap">
            <span className="text-[12.5px] text-[var(--ink-muted)]">{t("s.63bb17a9d2")}</span>
            <Btn className="!ml-auto" onClick={c.clearRestartNotice}>{t("s.cb63c62e50")}</Btn>
          </div>
        ) : null}

        {!c.loaded ? (
          <p className="text-[12.5px] text-[var(--meta)] mt-6">{t("s.49fd445d8b")}</p>
        ) : null}

        <CatalogTransition scope={tab} order={TAB_KEYS}>
        {c.loaded && tab === "appearance" ? (
          <Block title={tabLabels.appearance} className="!mt-6">
            <div className={CARD}>
              <Field
                label={t("settings.language")}
                tip={t("settings.languageTip")}
                inline
                control={
                  <Select
                    width={150}
                    value={locale}
                    options={LOCALES.map((l) => ({
                      id: l.id,
                      label: t(l.labelKey),
                    }))}
                    onChange={(v) => {
                      // LOCALES 已列全量；非法值忽略
                      if (LOCALES.some((l) => l.id === v)) {
                        setLocale(v as LocaleCode);
                        c.set("ui_locale", v, true);
                        // 设置里改过语言也算确认过，避免误触发首次引导。
                        c.set("ui_locale_picked", true, true);
                      }
                    }}
                  />
                }
              />
              <Field
                label={t("settings.theme")}
                tip={TIPS.theme_mode}
                inline
                control={
                  <Select
                    width={150}
                    value={c.str("theme_mode", "system")}
                    options={[
                      { id: "system", label: t("settings.themeSystem") },
                      { id: "light", label: t("settings.themeLight") },
                      { id: "dark", label: t("settings.themeDark") },
                    ]}
                    onChange={(v) => {
                      c.set("theme_mode", v, true);
                      const el = document.documentElement;
                      if (v === "system") el.removeAttribute("data-theme");
                      else el.setAttribute("data-theme", v);
                    }}
                  />
                }
              />
              <Field
                label={t("s.e5c12c3be5")}
                tip={TIPS.wallpaper_path}
                desc={t("s.3451ca742f")}
                control={
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <Btn onClick={() => void pickWallpaper(c.set)}>{t("s.18104edf89")}</Btn>
                    {c.str("wallpaper_path") ? (
                      <>
                        <span className="text-[12.5px] text-[var(--meta)] max-w-[280px] truncate">
                          {c.str("wallpaper_path")}
                        </span>
                        <Btn onClick={() => c.set("wallpaper_path", "", true)}>{t("s.7b15e5e8e7")}</Btn>
                      </>
                    ) : (
                      <span className="text-[12.5px] text-[var(--meta)]">{t("s.55a04b58cd")}</span>
                    )}
                  </div>
                }
              />
              <Field
                label={t("s.910adcad16")}
                tip={TIPS.wallpaper_blur}
                control={
                  <Slider
                    value={c.num("wallpaper_blur", 40)}
                    min={0}
                    max={100}
                    step={1}
                    onChange={(v) => c.set("wallpaper_blur", v)}
                    format={(v) => `${v}%`}
                  />
                }
              />
              <Field
                label={t("s.b4efb6cdcf")}
                tip={TIPS.wallpaper_opacity}
                control={
                  <Slider
                    value={c.num("wallpaper_opacity", 70)}
                    min={0}
                    max={100}
                    step={1}
                    onChange={(v) => c.set("wallpaper_opacity", v)}
                    format={(v) => `${v}%`}
                  />
                }
              />
              <Field
                label={t("settings.bannerText")}
                tip={TIPS.home_banner_text}
                control={
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <TextInput
                      fit
                      type="text"
                      maxLength={40}
                      className="w-[260px]"
                      placeholder={t("settings.bannerTextPlaceholder")}
                      value={c.str("home_banner_text")}
                      onChange={(v) => c.set("home_banner_text", v)}
                    />
                    {c.str("home_banner_text") ? (
                      <Btn onClick={() => c.set("home_banner_text", "", true)}>
                        {t("settings.bannerTextReset")}
                      </Btn>
                    ) : null}
                  </div>
                }
              />
              <Field
                label={t("settings.bannerSub")}
                tip={TIPS.home_banner_sub}
                control={
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <TextInput
                      fit
                      type="text"
                      maxLength={60}
                      className="w-[260px]"
                      placeholder={t("settings.bannerSubPlaceholder")}
                      value={c.str("home_banner_sub")}
                      onChange={(v) => c.set("home_banner_sub", v)}
                    />
                    {c.str("home_banner_sub") ? (
                      <Btn onClick={() => c.set("home_banner_sub", "", true)}>
                        {t("settings.bannerTextReset")}
                      </Btn>
                    ) : null}
                  </div>
                }
              />
              <Field
                label={t("settings.bannerOpacity")}
                tip={TIPS.home_banner_opacity}
                control={
                  <Slider
                    value={c.num("home_banner_opacity", 100)}
                    min={20}
                    max={100}
                    step={1}
                    onChange={(v) => c.set("home_banner_opacity", v)}
                    format={(v) => `${v}%`}
                  />
                }
              />
            </div>
          </Block>
        ) : null}

        {c.loaded && tab === "general" ? (
          <Block title={t("s.f1484fa78b")} className="!mt-6">
            <div className={CARD}>
              <Field
                label={t("s.f0ace6ccbe")}
                tip={TIPS.close_action}
                inline
                control={
                  <Select
                    width={170}
                    value={c.str("close_action", "ask")}
                    options={[
                      { id: "ask", label: t("s.393704c0f8") },
                      { id: "tray", label: t("s.aea56dcdfe") },
                      { id: "exit", label: t("s.0dd68a51dd") },
                    ]}
                    onChange={(v) => c.set("close_action", v, true)}
                  />
                }
              />
              <Field
                label={t("settings.autoStart")}
                control={
                  <Toggle
                    label={autoStart ? t("settings.autoStartOn") : t("settings.autoStartOff")}
                    checked={autoStart}
                    onChange={(v) => {
                      if (autoStartBusy) return;
                      setAutoStartBusy(true);
                      try {
                        invoke("autostart_set", { enabled: v })
                          .then(() => setAutoStart(v))
                          // 写失败（权限/注册表异常）回读真实状态，开关跟着
                          // 注册表走，不假装改成了。
                          .catch(() => {
                            void invoke<{ enabled: boolean }>("autostart_get").then((s) =>
                              setAutoStart(s.enabled),
                            );
                          })
                          .finally(() => setAutoStartBusy(false));
                      } catch {
                        // 浏览器预览没有 Tauri 后端，开关保持原样即可。
                        setAutoStartBusy(false);
                      }
                    }}
                  />
                }
              />
              <Field
                label={t("settings.compatRender")}
                tip={t("settings.compatRenderTip")}
                control={
                  <Toggle
                    label={
                      c.cfg.ui_compat_render === true
                        ? t("settings.compatRenderOn")
                        : t("settings.compatRenderOff")
                    }
                    checked={c.cfg.ui_compat_render === true}
                    onChange={(v) => c.set("ui_compat_render", v, true)}
                  />
                }
              />
              {/* 全局快捷键。`hotkeys_apply` 一直注册着却没有任何入口 ——
                  CmdOrCtrl+F11 抢在系统层面，用户既关不掉也改不了，而全局
                  快捷键是独占的：被抢走的组合在别的软件里就按不出来了。
                  这个产品只剩「显示/隐藏主界面」一条（其余八条是 RVC 实时
                  变声的动作，早就从 HOTKEYS 里去掉了），所以不另开一页，
                  就放在常规里。 */}
              <Field
                label={t("settings.hotkeys")}
                tip={t("settings.hotkeysTip")}
                desc={hotkeyNote}
                control={
                  <Toggle
                    label={
                      c.cfg.hotkeys_enabled === true
                        ? t("settings.hotkeysOn")
                        : t("settings.hotkeysOff")
                    }
                    checked={c.cfg.hotkeys_enabled === true}
                    onChange={(v) => {
                      // 先等写盘落地再注册。Rust 那边是从配置文件里读组合键的，
                      // 不 await 的话注册用的还是上一个值 —— useConfig.set 的
                      // 注释里点名说的就是这条路径。
                      void c.set("hotkeys_enabled", v, true).then(() => applyHotkeys(v));
                    }}
                  />
                }
              />
              <Field
                label={t("settings.hotkeyToggleWindow")}
                tip={t("settings.hotkeyToggleWindowTip")}
                inline
                control={
                  <div className="w-[190px]">
                    <TextInput
                      value={c.str("hotkey_toggle_window", "CmdOrCtrl+F11")}
                      // 打字时走 220ms 合并写，别每敲一个字符落一次盘。
                      onChange={(next) => void c.set("hotkey_toggle_window", next)}
                      // 改完立刻重注册。不重注册的话设置页显示新组合、系统里
                      // 还挂着旧的，要等下次重启才对得上。同样要等写盘先落地。
                      onBlur={() => {
                        if (c.cfg.hotkeys_enabled !== true) return;
                        void c.set("hotkey_toggle_window", c.str("hotkey_toggle_window", "CmdOrCtrl+F11"), true)
                          .then(() => applyHotkeys(true));
                      }}
                      spellCheck={false}
                      aria-label={t("settings.hotkeyToggleWindow")}
                    />
                  </div>
                }
              />
              <Field
                label={t("s.3ff3e5ff9b")}
                tip={TIPS.telemetry_opt_in}
                desc={t("s.dc3f6fc6fd")}
                control={
                  <Toggle
                    label={c.cfg.telemetry_opt_in === true ? t("s.a056bc39f4") : t("s.ef92935b07")}
                    checked={c.cfg.telemetry_opt_in === true}
                    onChange={(v) => c.set("telemetry_opt_in", v, true)}
                  />
                }
              />
              <Field
                label={t("settings.hfEndpoint")}
                tip={t("settings.hfEndpointTip")}
                inline
                control={
                  <Select
                    width={220}
                    value={(() => {
                      const v = c.str("hf_endpoint", "");
                      if (
                        v === "" ||
                        v === "https://hf-mirror.com" ||
                        v === "https://hf-cdn.sufy.com"
                      ) {
                        return v;
                      }
                      // 旧自定义值仍可选中显示
                      return v;
                    })()}
                    options={[
                      { id: "", label: t("settings.hfEndpointDefault") },
                      { id: "https://hf-cdn.sufy.com", label: "hf-cdn.sufy.com" },
                      { id: "https://hf-mirror.com", label: "hf-mirror.com" },
                      // 若用户 app_config 里有非预设值，补进列表避免 Select 空白
                      ...(() => {
                        const v = c.str("hf_endpoint", "");
                        if (
                          v &&
                          v !== "https://hf-mirror.com" &&
                          v !== "https://hf-cdn.sufy.com"
                        ) {
                          return [{ id: v, label: v }];
                        }
                        return [] as { id: string; label: string }[];
                      })(),
                    ]}
                    onChange={(v) => c.set("hf_endpoint", v, true)}
                  />
                }
              />
            </div>
          </Block>
        ) : null}

        {c.loaded && tab === "update" ? (
          <Block title={t("s.f0332ff72a")} className="!mt-6">
            <div className={CARD}>
              {/* 当前版本单独一行，常驻。
                  以前这一整块只有一个按钮，点完什么都不变（desc 被 inline 版
                  吞了），于是「我到底是不是最新的」这个问题在设置页里根本
                  没有答案。版本号摆出来，起码有一半答案是白纸黑字的。 */}
              <Field
                label={t("s.46e66f6321")}
                inline
                control={
                  <span className="text-[13px] text-[var(--ink-muted)] tabular-nums">
                    {appVersion || t("s.valueLoading")}
                  </span>
                }
              />
              <Field
                label={t("s.a6df38586d")}
                desc={updateLine || t("s.1fd4658c44")}
                inline
                control={
                  <Btn onClick={onCheckUpdate} disabled={updateBusy}>
                    {updateBusy ? t("s.5fc65af5b3") : t("s.72523c6421")}
                  </Btn>
                }
              />
              <p className="text-xs text-[var(--help)] m-0 leading-[1.75]">{t("s.5fe7a5211b")}<br />{t("s.6c26ecbfb3")}</p>
            </div>
          </Block>
        ) : null}
        </CatalogTransition>
      </PagePad>
    </div>
  );
}

export const SettingsPage = memo(SettingsPageImpl);
