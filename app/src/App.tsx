import { useCallback, useEffect, useRef, useState } from "react";
import { GuidePill, SetupGuide, type GuideStep } from "./components/SetupGuide";
import type { ExtrasFilter } from "./components/ExtrasDialog";
import { Nudge } from "./components/Nudge";
import { Leave } from "./components/Presence";
import { Modal } from "./components/Modal";
import { Btn } from "./components/ui";
import { followLinks } from "./lib/links";
import { QrDialog } from "./components/QrDialog";
import { WebDialogHost } from "./components/WebDialog";
import { NativeDialogHint } from "./components/NativeDialogHint";
import { openExternal } from "./lib/plaza";
import { PageHost } from "./components/PageHost";
import { ProvisionGate } from "./components/ProvisionGate";
import { LanguageGate } from "./components/LanguageGate";
import { TitleBar } from "./components/TitleBar";
import { useEngine } from "./hooks/useEngine";
import { usePlaza } from "./hooks/usePlaza";
import { forceKillEngine } from "./lib/engine";
import { invoke } from "@tauri-apps/api/core";
import { applyAppearance } from "./lib/appearance";
import { listen } from "@tauri-apps/api/event";
import { HomePage } from "./pages/HomePage";
import { HelpPage } from "./pages/HelpPage";
import { AnnotPage } from "./pages/AnnotPage";
import { ModelsPage } from "./pages/ModelsPage";
import { MorePage } from "./pages/MorePage";
import { PlazaPage } from "./pages/PlazaPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SynthPage } from "./pages/SynthPage";
import { TrainPage } from "./pages/TrainPage";
import { getAssetsStatus, registerDownloadModelsOpener } from "./lib/downloadModels";
import { registerHelpOpener } from "./lib/helpNav";
import { usePageNavigation } from "./hooks/usePageNavigation";
import { mayCloseApp } from "./lib/windowLeave";
import { registerNavigator } from "./lib/intent";
import { useI18n } from "./i18n";
import { t } from "./i18n/t";

/**
 * 合成完成多少次之后问一句「要不要关注」。
 *
 * 十次的意思是：这人已经把软件用起来了，不是打开看两眼就走的。太早问等于
 * 拦路要东西，太晚问他早就忘了这软件是谁做的。
 */
const FOLLOW_AFTER_RUNS = 10;

/** known_issues.rs 匹配出来的一条。文案已经在 Rust 那边按当前语言取好。 */
type KnownIssue = {
  id: string;
  level: "error" | "warn" | "info";
  title: string;
  body: string;
  /** 哪一版修好。空 = 还没修 —— 有值才给「更新到 x.y.z」按钮。 */
  fixed_in?: string;
};

/** `update_check` 的返回。字段名和 `update::decide` 里那个 json! 一一对应。 */
type UpdateInfo = {
  local: string;
  remote: string;
  available: boolean;
  blocked_by_min_version: boolean;
  min_app_version: string;
  package_type: string;
  /** `external` = 换 exe，走签名更新器；否则是界面补丁。 */
  action: string;
  url: string;
  sha256: string;
  notes: string;
};

/** `14:07`。状态行里带个时间，才看得出这句话是刚查的还是上次留下的。 */
function clockNow(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

export default function App() {
  // Subscribe so locale change re-renders App (static t() labels) without
  // remounting the tree / re-running useEngine.
  const { locale } = useI18n();
  void locale;

  const [page, setPage] = usePageNavigation("home");
  const [compactNav, setCompactNav] = useState(false);
  // 「下载模型」：用户主动打开，或音频工具缺引擎资源时跳转。
  const [extrasReason, setExtrasReason] = useState("");
  const [extrasFilter, setExtrasFilter] = useState<ExtrasFilter>("all");
  const [scrollToDownloads, setScrollToDownloads] = useState(0);
  // Self-update: check reports the catalog's latest; applying swaps the
  // external frontend/ dir and takes effect on restart.
  const [updateLine, setUpdateLine] = useState("");
  // 检查更新唯一的反馈原来只有一行灰色小字，用户点完看不出点没点上，
  // 会以为按钮坏了。按钮自己也要进入「检查中…」并禁用。
  const [updateBusy, setUpdateBusy] = useState(false);

  // 开机时把外观（配色 / 背景图 / 磨砂 / 不透明度）套上。之后用户在设置页
  // 每改一下都由 useConfig 就地再套一次，所以这里只跑一次就够 —— 以前依赖数组
  // 写的是 [page]，等于「换页才刷新外观」，改完当场毫无反应。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const cfg = await invoke<Record<string, unknown>>("config_get");
        if (alive) applyAppearance(cfg);
      } catch {
        /* config unavailable outside Tauri */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  // 启动时自动查到的新版本。非空 = 弹一条「要不要现在装」。
  const [updateOffer, setUpdateOffer] = useState<UpdateInfo | null>(null);

  /** 只查，不装。返回后端那份原样的结果，顺手把状态行写好。 */
  const probeUpdate = async (): Promise<UpdateInfo | null> => {
    const r = (await invoke<Record<string, unknown>>(
      "update_check",
    )) as UpdateInfo;
    if (r.blocked_by_min_version) {
      setUpdateLine(
        t("s.214fe7bcad", {
          v0: String(r.local),
          v1: String(r.min_app_version),
        }),
      );
      return null;
    }
    if (!r.available) {
      // 「已是最新」必须带上版本号和时间。只说一句「已是最新」，用户分不清
      // 是真查过了还是根本没查动。
      setUpdateLine(
        t("s.7ccca92d5e", { v0: String(r.local), v1: clockNow() }),
      );
      return null;
    }
    setUpdateLine(
      t("s.622a22349e", {
        v0: String(r.remote),
        v1: String(r.local),
      }),
    );
    return r;
  };

  /** 真正下载并安装。整包走签名更新器，界面补丁走 update_apply。 */
  const installUpdate = async (r: UpdateInfo) => {
    if (r.action === "external") {
      // Rust side changed → replace the exe through the signed updater.
      setUpdateLine(t("s.b22f6e52ac", { v0: String(r.remote) }));
      const b = await invoke<Record<string, unknown>>("update_app");
      setUpdateLine(
        b.installed
          ? t("s.995e0f4c81", {
              v0: String(b.version ?? r.remote),
            })
          : t("s.3d1fde4601"),
      );
      return;
    }
    setUpdateLine(t("s.5b3dc1999a", { v0: String(r.remote) }));
    await invoke("update_apply", {
      url: String(r.url),
      sha256: String(r.sha256 || ""),
    });
    setUpdateLine(t("s.995e0f4c81", { v0: String(r.remote) }));
  };

  /** 设置页那个「立即检查」：查到了就直接装，这是用户主动点的。 */
  const checkUpdate = async () => {
    if (updateBusy) return;
    setUpdateBusy(true);
    setUpdateLine(t("s.481ee2d4bc"));
    try {
      const r = await probeUpdate();
      if (r) await installUpdate(r);
    } catch (e) {
      setUpdateLine(t("s.ac3a85a9c1", { v0: String(e) }));
    } finally {
      setUpdateBusy(false);
    }
  };

  // 开机自动查一次。
  //
  // 查到了**不直接装** —— 用户刚点开软件多半是要马上用，后台自作主张占着网
  // 下几 MB 到几十 MB，是别人的软件才干的事。弹一条问一句，他说装才装。
  //
  // 没查到也要把「已是最新（版本号 + 时间）」写进状态行：这样进设置页时那行
  // 字已经在了，不用先点一下才知道自己是不是最新的。
  //
  // 延后 4 秒：启动那几秒 CPU 和磁盘都在忙着起引擎、扫音色，这一发网络请求
  // 挤进去只会让开屏更卡，而更新这件事晚四秒没有任何损失。
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const r = await probeUpdate();
          if (!cancelled && r) setUpdateOffer(r);
        } catch {
          // 开机没网是常态，不要为此弹窗打扰。状态行留空，用户进设置页
          // 手点「立即检查」时才会看到具体的失败原因。
        }
      })();
    }, 4000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  // 答应更新之后，那条提示**留在原地**变成进度，不跳页也不换地方看。
  // 把人扔到设置页去找进度条，等于让他自己去确认「我刚才点的那下算数了吗」。
  const [updateWorking, setUpdateWorking] = useState(false);
  const acceptUpdate = async () => {
    const r = updateOffer;
    if (!r) return;
    setUpdateWorking(true);
    setUpdateBusy(true);
    try {
      await installUpdate(r);
    } catch (e) {
      setUpdateLine(t("s.bac68ea7db", { v0: String(e) }));
    } finally {
      setUpdateBusy(false);
    }
  };
  /**
   * 空串 = 还没选音色，渲染时才去取那句占位文案。
   *
   * 以前写的是 `useState(t("s.262d11e2d6"))`。`useState` 的初值只在首帧求值一次，
   * 而那一帧语言包还没加载完，t() 拿到的是 DEFAULT_LOCALE —— 于是底栏那句
   * 「未选择模型」会永远停在简体中文，用户把界面切成日文也不会变，除非他真的
   * 去选一个音色把这个 state 覆盖掉。占位文案不该进 state，它是渲染出来的。
   */
  /** id → 显示名。底栏要写「收音机」，不是写 radio。 */

  const [coreOnly, setCoreOnly] = useState(false);
  const [showProvision, setShowProvision] = useState(false);
  const [provisionDismissed, setProvisionDismissed] = useState(false);
  /** 补全弹窗关掉之后，底部 Nudge 再问一次 —— 那次也关了，这个会话就不再提。 */
  const [runtimeNudgeDismissed, setRuntimeNudgeDismissed] = useState(false);
  // 新装 ui_locale_picked===false 时先选语言，再走 Runtime 补全。
  const [showLangGate, setShowLangGate] = useState(false);
  const [langGateChecked, setLangGateChecked] = useState(false);
  const [guidePending, setGuidePending] = useState(false);

  const engine = useEngine();

  /**
   * 合成跑起来 / 跑完的次数。
   *
   * RVC 那边统计邀请、关注邀请、首次引导挂的都是实时变声的 running 从真变假；
   * GPT-SoVITS 没有实时链路，running 永远是假，照抄过来的结果是这三样东西
   * 一次都不会发生。这里改挂 synth 的事件 —— 对这个产品来说，
   * 「一段文本合成完」才是用户真正拿到东西的那一刻。
   */
  const [synthDone, setSynthDone] = useState(0);
  useEffect(() => {
    let disposed = false;
    const offs: Array<() => void> = [];
    const add = async (event: string, fn: () => void) => {
      const un = await listen(event, fn);
      if (disposed) un();
      else offs.push(un);
    };
    void add("synth-done", () => setSynthDone((n) => n + 1));
    return () => {
      disposed = true;
      offs.forEach((f) => f());
    };
  }, []);
  const plaza = usePlaza();
  const { refreshProvision } = engine;

  // Telemetry consent: ask only after the user has actually got value out of
  // the product — 60 s of clean conversion — not at first launch.
  const [askTelemetry, setAskTelemetry] = useState(false);

  // 这台机器有没有踩到我们已经知道的坑。判据和条目都在 Rust 那边
  // （known_issues.json + known_issues.rs），这里只负责显示第一条。
  const [knownIssue, setKnownIssue] = useState<KnownIssue | null>(null);
  useEffect(() => {
    let alive = true;
    invoke<KnownIssue[]>("known_issues_check")
      .then((v) => {
        if (alive && Array.isArray(v) && v.length > 0) setKnownIssue(v[0]);
      })
      .catch(() => {
        /* 查不到就不提示，这条本来就是锦上添花 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 「更新到 x.y.z」的回执。修复还没发布、没有新版本可装时进度条不会动，
  // 这条得留在横幅里说清楚为什么按钮没起作用。
  const [kiNote, setKiNote] = useState("");
  const kiUpdate = async () => {
    if (updateBusy) return;
    // 开机 4 秒那次检查的结果还热着就复用，别再发一次请求。
    const r = updateOffer ?? (await probeUpdate().catch(() => null));
    if (!r) {
      setKiNote(t("s.kiNoUpdateYet"));
      return;
    }
    // 下载进度走下面那条更新横幅（两块 Nudge 各占一行，可以并存）——
    // 用户按了按钮就得看得见它在动。
    setUpdateOffer(r);
    setUpdateWorking(true);
    setUpdateBusy(true);
    try {
      await installUpdate(r);
    } catch (e) {
      setUpdateLine(t("s.bac68ea7db", { v0: String(e) }));
    } finally {
      setUpdateBusy(false);
    }
  };

  // The daily ping belongs to app start, not to every start/stop of the
  // stream. The Rust side dedupes by day, but firing it on each toggle still
  // meant a network attempt and a config write every time.
  useEffect(() => {
    void (async () => {
      const cfg = await invoke<Record<string, unknown>>("config_get").catch(() => null);
      if (cfg?.telemetry_opt_in === true) {
        void invoke("telemetry_tick").catch(() => {});
      }
    })();
  }, []);

  // Ask only after the user has actually got value out of the product —
  // 60 s of clean conversion — not at first launch.
  useEffect(() => {
    if (synthDone === 0) return;
    let timer: number | null = null;
    let cancelled = false;
    void (async () => {
      const cfg = await invoke<Record<string, unknown>>("config_get").catch(() => null);
      if (!cfg || cancelled) return;
      // null/undefined = never answered. false = declined, do not ask again.
      if (cfg.telemetry_opt_in !== null && cfg.telemetry_opt_in !== undefined) return;
      // 计时期间用户可能已经答过（上一次合成排的计时器先弹了），到点再查一次。
      timer = window.setTimeout(() => {
        void invoke<Record<string, unknown>>("config_get")
          .then((now) => {
            const answered = now?.telemetry_opt_in !== null && now?.telemetry_opt_in !== undefined;
            if (!cancelled && !answered) setAskTelemetry(true);
          })
          .catch(() => {});
      }, 60_000);
    })();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [synthDone]);

  const answerTelemetry = async (yes: boolean) => {
    setAskTelemetry(false);
    await invoke("config_set", { patch: { telemetry_opt_in: yes } }).catch(() => {});
    if (yes) void invoke("telemetry_tick").catch(() => {});
  };

  // 「喜欢的话关注一下」——攒够 FOLLOW_AFTER_RUNS 次合成之后问一次。
  //
  // 数的是**跑完**的次数，不是点了几次开始：开跑就报错的不该算数，那种时候
  // 用户正在烦躁，问他要不要关注是最糟的时机。
  const [askFollow, setAskFollow] = useState(false);
  // 有二维码的社媒（QQ 群）点开的是图片，不是外链。
  const [qr, setQr] = useState<{ src: string; label: string } | null>(null);
  useEffect(() => {
    if (synthDone === 0) return;
    void (async () => {
      try {
        const cfg = await invoke<Record<string, unknown>>("config_get");
        // 新手引导的「第一次合成」：合成成功过一次。
        if (cfg.onboard_convert !== true) {
          await invoke("config_set", { patch: { onboard_convert: true } });
        }
        if (cfg.follow_prompt_done === true) return;
        const n = Number(cfg.vc_run_count ?? 0) + 1;
        await invoke("config_set", { patch: { vc_run_count: n } });
        if (n >= FOLLOW_AFTER_RUNS) setAskFollow(true);
      } catch {
        /* 配置读不到就算了，这不是要紧事 */
      }
    })();
  }, [synthDone]);

  // 新手引导：运行环境装好后自动打开；中途可收成右下角的小按钮，走完或关掉后不再出现。
  // 已经合成过的老用户不主动打扰，从说明页随时可以再打开。
  const [guide, setGuide] = useState<{ open: boolean; step: GuideStep; pill: boolean }>({ open: false, step: "runtime", pill: false });
  const openGuide = useCallback((step?: GuideStep) => setGuide((g) => ({ open: true, pill: false, step: step ?? g.step })), []);
  const finishGuide = useCallback(() => {
    setGuidePending(false);
    setGuide((g) => ({ ...g, open: false, pill: false }));
    void invoke("config_set", { patch: { setup_guide_done: true, onboard_dismiss: true } }).catch(() => {});
  }, []);

  const guideRequested = useRef(false);
  const { need_provision: needRuntime, runtime_ready: runtimeReady } = engine.provision;

  useEffect(() => {
    if (!langGateChecked || showLangGate || showProvision || provisionDismissed) return;
    if (needRuntime) {
      setShowProvision(true);
      return;
    }
    if (!runtimeReady || !guidePending) return;
    let alive = true;
    void getAssetsStatus().then(assets => {
      if (!alive) return;
      if (assets.engine_core_ready === false) {
        setCoreOnly(true);
        setShowProvision(true);
      } else {
        setGuide(g => g.open || g.pill ? g : { ...g, pill: true });
      }
    });
    return () => { alive = false; };
  }, [langGateChecked, showLangGate, showProvision, provisionDismissed, needRuntime, runtimeReady, guidePending]);

  async function startGuide() {
    if (!runtimeReady) {
      guideRequested.current = true;
      setCoreOnly(false);
      setShowProvision(true);
      return;
    }
    const assets = await getAssetsStatus();
    if (assets.engine_core_ready === false) {
      guideRequested.current = true;
      setCoreOnly(true);
      setShowProvision(true);
    } else {
      openGuide("role");
    }
  }

  function closeProvision() {
    setShowProvision(false);
    setCoreOnly(false);
    setProvisionDismissed(true);
  }

  async function finishProvision() {
    closeProvision();
    const provision = await refreshProvision().catch(() => undefined);
    await engine.refresh();
    const requested = guideRequested.current;
    guideRequested.current = false;
    if (!(provision?.runtime_ready ?? runtimeReady) || (!requested && !guidePending)) return;
    const assets = await getAssetsStatus();
    if (assets.engine_core_ready !== false) openGuide("role");
  }


  // 不管点的是哪个社媒还是「以后再说」，都不再问第二次。反复问一件用户
  // 已经表过态的事，比不问更让人反感。
  const closeFollow = () => {
    setAskFollow(false);
    void invoke("config_set", { patch: { follow_prompt_done: true } }).catch(
      () => {},
    );
  };

  // Close prompt (close_action = "ask"). Same two choices as the Tk shell,
  // plus 「记住我的选择」 which writes close_action so we stop asking.
  const [closeAsk, setCloseAsk] = useState(false);
  const [closeRemember, setCloseRemember] = useState(false);
  const answerClose = async (toTray: boolean) => {
    setCloseAsk(false);
    if (!toTray && !(await mayCloseApp())) return;
    if (closeRemember) {
      await invoke("config_set", {
        patch: { close_action: toTray ? "tray" : "exit" },
      }).catch(() => {});
    }
    await invoke("close_finish", { toTray }).catch(() => {});
  };

  // 「强制结束合成引擎」。
  //
  // 它会把正在跑的合成任务一起收掉（见 lib.rs 的 engine_force_kill）。
  // 一批长文本可能跑几分钟，不能闷声吃掉，所以按之前先查一下在不在跑，
  // 在跑就问一句。不在跑就直接执行，不给已经卡死的人再加一道弹窗。
  const [killAsk, setKillAsk] = useState(false);
  const doForceKill = async () => {
    setKillAsk(false);
    await forceKillEngine();
    await engine.refresh();
  };
  const requestForceKill = async () => {
    try {
      const st = await invoke<{ state?: string }>("engine_status");
      if (st?.state === "busy") {
        setKillAsk(true);
        return;
      }
    } catch {
      /* 问不到就当没在跑：这个按钮是用来解卡死的，不该被一次查询失败挡住 */
    }
    await doForceKill();
  };



  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const cfg = await invoke<Record<string, unknown>>("config_get");
        if (alive) {
          setShowLangGate(cfg.ui_locale_picked === false);
          setGuidePending(cfg.setup_guide_done !== true && cfg.onboard_dismiss !== true && cfg.onboard_convert !== true);
        }
      } catch {
        /* 预览 */
      } finally {
        if (alive) setLangGateChecked(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 520px)");
    const fn = () => setCompactNav(mq.matches);
    fn();
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);


  // 设置页 / 底栏 / 快捷键 / 切角色都会改配置。底栏自己的 state 以前只在
  // 挂载和切角色时读一次，设置里改完底栏数字不动。


  // 「用不了？联系社区」的落点。仓库与社媒那张表只在「其他」页有一份，
  // 不在设置页和说明页各抄一遍 —— 抄了就得改三处，迟早对不上。
  // 加一 = 「再滚一次」：同一页反复点也要每次都滚过去。
  const [communityNonce, setCommunityNonce] = useState(0);
  const openCommunity = useCallback(() => {
    setCommunityNonce((n) => n + 1);
    setPage("more");
  }, [setPage]);
  const [helpFocus, setHelpFocus] = useState("");
  const [helpFocusNonce, setHelpFocusNonce] = useState(0);
  const openHelp = useCallback((section?: string) => {
    setHelpFocus(section || "");
    setHelpFocusNonce((n) => n + 1);
    setPage("help");
  }, [setPage]);
  // 「下载模型」现在住在广场，「其他」页和工具入口都是跳过来。
  //
  // 以前它是「其他」页上弹的一个框。同一件事在两个地方各有一份实现，改一个
  // 忘一个是迟早的；而且用户在弹框里下完东西，关掉之后回到的还是「其他」页，
  // 跟他刚做的事没有任何关系。
  const openDownloadModels = useCallback(
    (reason?: string, filter?: ExtrasFilter) => {
      plaza.markSeen();
      setPage("plaza");
      setExtrasReason(reason || "");
      // 别在这儿收窄组别：清单里将来多一个类，这行会把它悄悄改成 "all"，
      // 跳过去落在哪个页签全凭运气。合法性由 ExtrasFilter 这个类型管。
      setExtrasFilter(filter || "all");
      // 加一 = 「再滚一次」。广场很长，不滚过去用户看不见自己被带到哪了。
      setScrollToDownloads((n) => n + 1);
    },
    [plaza, setPage],
  );

  useEffect(() => {
    registerDownloadModelsOpener((opts) => {
      const f = opts?.filter;
      openDownloadModels(
        opts?.reason,
        f === "train" || f === "separate" || f === "synth" || f === "other" ? f : "all",
      );
    });
    return () => registerDownloadModelsOpener(null);
  }, [openDownloadModels]);

  // 工具窗口（人声分离 / 训练音色）点「下载模型」时发过来的。那边是独立的
  // webview，没有广场可去，只能把主窗口叫到前面再让它跳。
  useEffect(() => {
    let un: (() => void) | undefined;
    void listen<{ reason?: string; filter?: string }>(
      "open-download-models",
      (e) => {
        const f = e.payload?.filter;
        openDownloadModels(
          e.payload?.reason || "",
          f === "train" || f === "separate" || f === "synth" || f === "other" ? f : "all",
        );
      },
    ).then((f) => {
      un = f;
    });
    return () => un?.();
  }, [openDownloadModels]);

  useEffect(() => {
    registerHelpOpener((section) => openHelp(section));
    return () => registerHelpOpener(null);
  }, [openHelp]);

  useEffect(() => {
    registerNavigator(setPage);
    return () => registerNavigator(null);
  }, [setPage]);

  useEffect(() => {
    let un: (() => void) | undefined;
    void listen<{ section?: string }>("open-help", (e) => {
      openHelp(e.payload?.section || "");
    }).then((f) => {
      un = f;
    });
    return () => un?.();
  }, [openHelp]);
  // 进广场同时把小红点消掉 —— 和顶栏点「广场」是同一件事，不能只有一条路
  // 清红点，否则从模型页进来的用户那个点永远亮着。
  const openPlaza = useCallback(() => {
    plaza.markSeen();
    setPage("plaza");
  }, [plaza, setPage]);
  const { reload: plazaReload } = plaza;
  const reloadPlaza = useCallback(() => void plazaReload(), [plazaReload]);

  useEffect(() => {
    let disposed = false;
    const offs: Array<() => void> = [];
    const add = async (event: string, fn: () => void) => {
      const un = await listen(event, fn);
      // Cleanup may have already run while this was in flight.
      if (disposed) un();
      else offs.push(un);
    };
    // hotkey://toggle-window 没有前端处理：窗口藏起来时 webview 可能被系统
    // 挂起，事件根本到不了这里。那个动作在 Rust 里就地做完了。
    void add("app://close-requested", () => setCloseAsk(true));
    void add("app://exit-requested", () => {
      void mayCloseApp().then(ok => { if (ok) void invoke("close_finish", { toTray: false }); });
    });
    return () => {
      disposed = true;
      offs.forEach((f) => f());
    };
  }, []);

  return (
    // 根容器不铺底色：底色在 html 上，壁纸层夹在中间。这里再铺一层不透明的
    // --bg 会把壁纸盖死 —— 这正是「背景图设了没反应」的另一半原因。
    <div className="h-full flex flex-col text-[var(--ink)] overflow-hidden relative">
      <TitleBar
        page={page}
        onPage={(id) => {
          // Opening the plaza is what clears its dot — it used to be hardcoded
          // on, so it meant nothing.
          if (id === "plaza") plaza.markSeen();
          setPage(id);
        }}
        plazaUnread={plaza.unread}
        compactNav={compactNav}
      />

      <LanguageGate
        open={showLangGate}
        onDone={() => setShowLangGate(false)}
      />

      <ProvisionGate
        open={showProvision && !showLangGate}
        initial={engine.provision}
        coreOnly={coreOnly}
        onDone={() => void finishProvision()}
        onDismiss={() => {
          guideRequested.current = false;
          closeProvision();
        }}
      />

      <PageHost page={page}>
        {(id) => {
          switch (id) {
            case "home":
              return (
                <HomePage onNavigate={setPage} active={page === "home"} />
              );
            case "plaza":
              return (
                <PlazaPage
                  feed={plaza.feed}
                  loading={plaza.loading}
                  onReload={reloadPlaza}
                  downloadReason={extrasReason}
                  extrasFilter={extrasFilter}
                  scrollToDownloads={scrollToDownloads}
                />
              );
            case "models":
              return (
                <ModelsPage onOpenPlaza={openPlaza} banner={plaza.feed.banner} active={page === "models"} />
              );
            case "synth":
              return <SynthPage />;
            case "annot":
              return <AnnotPage />;
            case "train":
              return <TrainPage />;
            case "settings":
              return (
                <SettingsPage
                  onCheckUpdate={() => void checkUpdate()}
                  updateLine={updateLine}
                  updateBusy={updateBusy}
                  onOpenHelp={openHelp}
                  onOpenCommunity={openCommunity}
                />
              );
            case "help":
              return (
                <HelpPage
                  focus={helpFocus}
                  focusNonce={helpFocusNonce}
                  onOpenCommunity={openCommunity}
                  onStartGuide={() => void startGuide()}
                />
              );
            case "more":
              return (
                <MorePage
                  status={engine.status}
                  provision={engine.provision}
                  onForceKill={requestForceKill}
                  onOpenProvision={() => {
                    setProvisionDismissed(false);
                    setShowProvision(true);
                  }}
                  focusCommunityNonce={communityNonce}
                />
              );
          }
        }}
      </PageHost>

      <Modal open={Boolean(killAsk)} z={60} contained>
          <div className="w-full max-w-[420px] rounded-[var(--r)] bg-[var(--surface)] shadow-[0_22px_56px_-18px_var(--scrim)] p-6">
            <h2 className="text-[19px] font-semibold m-0 mb-2">{t("s.killStsAskTitle")}</h2>
            <p className="text-[13px] text-[var(--help)] m-0 mb-5 leading-relaxed">{t("s.killStsAskBody")}</p>
            <div className="flex gap-2.5 justify-end">
              <button
                type="button"
                onClick={() => setKillAsk(false)}
                className="text-[13px] px-3.5 py-2 rounded-[var(--rs)] bg-transparent text-[var(--ink-muted)] border-0 cursor-pointer shadow-[inset_0_0_0_1px_var(--line)]"
              >{t("s.killStsAskKeep")}</button>
              <button
                type="button"
                onClick={() => void doForceKill()}
                className="text-[13px] font-semibold px-3.5 py-2 rounded-[var(--rs)] bg-[var(--accent)] text-[var(--accent-ink)] border-0 cursor-pointer"
              >{t("s.killStsAskGo")}</button>
            </div>
          </div>
      </Modal>

      <Modal open={Boolean(closeAsk)} z={60} contained>
          <div className="w-full max-w-[420px] rounded-[var(--r)] bg-[var(--surface)] shadow-[0_22px_56px_-18px_var(--scrim)] p-6">
            <h2 className="text-[19px] font-semibold m-0 mb-2">{t("s.43b19c9a61")}</h2>
            <p className="text-[13px] text-[var(--help)] m-0 mb-4 leading-relaxed">{t("s.bc19958103")}</p>
            <label className="flex items-center gap-2.5 text-[13px] cursor-pointer mb-5 select-none">
              <input
                type="checkbox"
                checked={closeRemember}
                onChange={(e) => setCloseRemember(e.target.checked)}
                className="accent-[var(--accent)]"
              />{t("s.f75c86ad46")}</label>
            <div className="flex gap-2.5 justify-end">
              <button
                type="button"
                onClick={() => void answerClose(false)}
                className="text-[13px] px-3.5 py-2 rounded-[var(--rs)] bg-transparent text-[var(--ink-muted)] border-0 cursor-pointer shadow-[inset_0_0_0_1px_var(--line)]"
              >{t("s.3a070016e2")}</button>
              <button
                type="button"
                onClick={() => void answerClose(true)}
                className="text-[13px] font-semibold px-3.5 py-2 rounded-[var(--rs)] bg-[var(--accent)] text-[var(--accent-ink)] border-0 cursor-pointer"
              >{t("s.aea56dcdfe")}</button>
            </div>
          </div>
      </Modal>

      {/* Nudge 全部收进这层浮层：absolute 叠在页面之上、不占布局，
          否则每条提示都会在底部顶出一条跟背景同色的带子，看着像伪 dock。
          pointer-events 穿透空区，卡片自己再吃事件。 */}
      <div className="absolute inset-x-0 bottom-0 z-[40] pointer-events-none">
      {/* 已知问题排在这里：比「要不要更新」重要（它解释的是用户此刻为什么
          用不了）。一个会话里关掉就不再出现 —— 不落配置，因为坑没填之前
          下次启动本来就该再说一次。 */}
      <Leave>{knownIssue ? (
        <Nudge
          title={knownIssue.title}
          actions={
            <>
              <Btn onClick={() => setKnownIssue(null)}>{t("s.kiDismiss")}</Btn>
              {/* 有修复版本才给这个按钮：它说的「更新到 x.y.z」必须是真的。 */}
              {knownIssue.fixed_in ? (
                <Btn
                  primary
                  busy={updateBusy}
                  disabled={updateBusy}
                  onClick={() => void kiUpdate()}
                >
                  {t("s.kiUpdate", { v0: knownIssue.fixed_in })}
                </Btn>
              ) : null}
            </>
          }
        >
          {knownIssue.body}
          {kiNote ? <span className="block mt-1">{kiNote}</span> : null}
        </Nudge>
      ) : null}</Leave>

      {/* 同时最多出现一条。更新排最前 —— 它是开机 4 秒就出来的，那会儿另外
          两条的触发条件（用满 60 秒 / 合成十次）都还远没到。
          统计邀请次之，两条撞在一起会把底栏顶掉半个屏。 */}
      {/* 运行环境未补全排最前：它挡的是整个产品的主力功能，比首引/更新都
          急。只在补全弹窗被关掉之后才出现 —— 弹窗开着的时候它俩说的是同一
          件事，一起出现就是复读。补全完成它自己消失。 */}
      {/* 首次引导排在最前：更新提示是开机 4 秒就出来的，统计和关注更靠后，
          而这条只在用户第一次开始合成的那几秒里有意义，错过就没了。
          它关掉之后被它压住的那条会自己顶上来。 */}
      <Leave>{engine.provision.need_provision && provisionDismissed && !runtimeNudgeDismissed ? (
        <Nudge
          title={t("statusbar.needRuntimeTitle")}
          actions={
            <>
              <Btn onClick={() => setRuntimeNudgeDismissed(true)}>
                {t("statusbar.later")}
              </Btn>
              <Btn
                primary
                onClick={() => {
                  setRuntimeNudgeDismissed(true);
                  setProvisionDismissed(false);
                  setShowProvision(true);
                }}
              >
                {t("statusbar.fixRuntime")}
              </Btn>
            </>
          }
        >
          {t("statusbar.needRuntimeSub")}
        </Nudge>
      ) : updateOffer ? (
        <Nudge
          title={
            updateWorking
              ? t("s.87c1bc6fe6")
              : t("s.a462205ca5", { v0: updateOffer.remote })
          }
          actions={
            updateWorking ? (
              <Btn onClick={() => setUpdateOffer(null)} disabled={updateBusy}>
                {updateBusy ? t("s.65188d08a2") : t("s.cb63c62e50")}
              </Btn>
            ) : (
              <>
                <Btn onClick={() => setUpdateOffer(null)}>{t("s.479fcc1cc0")}</Btn>
                <Btn primary onClick={() => void acceptUpdate()}>{t("s.f4df9977ea")}</Btn>
              </>
            )
          }
        >
          {updateWorking
            ? updateLine
            : t("s.3956a2d8bb", {
                v0: updateOffer.local,
                v1:
                  updateOffer.notes ||
                  t("s.58941d30b7"),
              })}
        </Nudge>
      ) : askTelemetry ? (
        <Nudge
          title={t("s.b9feeeb3a8")}
          actions={
            <>
              <Btn onClick={() => void answerTelemetry(false)}>{t("s.206f264868")}</Btn>
              <Btn primary onClick={() => void answerTelemetry(true)}>{t("s.d9702f047c")}</Btn>
            </>
          }
        >{t("s.9546e0b7e2")}</Nudge>
      ) : askFollow ? (
        <Nudge
          title={t("s.d359cf1384")}
          actions={
            <>
              <Btn onClick={closeFollow}>{t("s.6aa652ccb5")}</Btn>
              {followLinks().map((l) => (
                <Btn
                  key={l.url}
                  onClick={() => {
                    // 二维码那条（QQ 群）没有能跳的地址，点开是图片。
                    // 浮层留着不关：关掉它这条邀请就不会再出现，用户扫完码
                    // 想再看一眼群名都没地方看了。
                    if (l.qr) {
                      setQr({ src: l.qr, label: l.title });
                      return;
                    }
                    void openExternal(l.url);
                    closeFollow();
                  }}
                >
                  {l.short}
                </Btn>
              ))}
            </>
          }
        >{t("s.7f3ebfb67b")}</Nudge>
      ) : null}</Leave>
      </div>

      <Leave>{qr ? (
        <QrDialog src={qr.src} label={qr.label} onClose={() => setQr(null)} />
      ) : null}</Leave>

      <WebDialogHost />
      <NativeDialogHint />

      <SetupGuide
        open={guide.open && !showLangGate && !showProvision}
        step={guide.step}
        onStep={(step) => setGuide((g) => ({ ...g, step }))}
        onMinimize={() => setGuide((g) => ({ ...g, open: false, pill: true }))}
        onFinish={finishGuide}
        onNavigate={setPage}
        onOpenProvision={() => {
          setProvisionDismissed(false);
          setShowProvision(true);
        }}
      />
      <Leave>{guide.pill && !guide.open && !showLangGate && !showProvision ? <GuidePill step={guide.step} onOpen={() => openGuide()} onClose={finishGuide} /> : null}</Leave>
    </div>
  );
}
