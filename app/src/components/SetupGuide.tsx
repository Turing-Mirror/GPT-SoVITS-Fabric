import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Wizard, WizardPill, type WizardStep } from "../trm";
import { Btn } from "./ui";
import { t } from "../i18n/t";
import { setConfig } from "../lib/config";
import { issueLink, qqGroupLink } from "../lib/links";
import { openExternal } from "../lib/plaza";
import type { PageId } from "../lib/nav";

/**
 * 新手引导：从装好运行环境一步步走到第一次合成，再指向自己训练角色。
 *
 * 外壳是 TRM UI 的 Wizard。每一步的完成与否按真实状态判断（onboarding_status），
 * 不靠用户自己勾。需要去别的页面办的事，先把引导收成右下角的小按钮，办完点它回来。
 * 第一次打开时先显示反馈须知，确认过的写进 feedback_notice_done，之后不再出现。
 */

export type GuideStep = "runtime" | "role" | "synth" | "own";
export const GUIDE_STEPS: GuideStep[] = ["runtime", "role", "synth", "own"];

type Status = { runtime?: boolean; voice?: boolean; convert?: boolean };

type Props = {
  open: boolean;
  step: GuideStep;
  onStep: (s: GuideStep) => void;
  onMinimize: () => void;
  onFinish: () => void;
  onNavigate: (page: PageId) => void;
  /** 打开运行环境的安装窗口。 */
  onOpenProvision: () => void;
};

export function SetupGuide({ open, step, onStep, onMinimize, onFinish, onNavigate, onOpenProvision }: Props) {
  const [st, setSt] = useState<Status>({});
  // null = 还没读到配置，先不画，免得步骤闪一下再换成须知
  const [notice, setNotice] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open || notice !== null) return;
    void invoke<Record<string, unknown>>("config_get")
      .then((cfg) => setNotice(cfg.feedback_notice_done !== true))
      .catch(() => setNotice(false));
  }, [open, notice]);

  // 两秒读一次：下载角色、合成都在别处完成，回来时这里要已经知道
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const read = () =>
      void invoke<Status>("onboarding_status")
        .then((s) => alive && setSt(s))
        .catch(() => {});
    read();
    const id = window.setInterval(read, 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [open]);

  const away = (page: PageId) => {
    onMinimize();
    onNavigate(page);
  };

  const steps: WizardStep[] = [
    {
      id: "runtime",
      title: t("guide.runtime.title"),
      done: !!st.runtime,
      body: (
        <StepBody lead={t("guide.runtime.body")} done={st.runtime ? t("guide.runtime.done") : undefined}>
          {st.runtime ? null : (
            <Btn primary onClick={() => { onMinimize(); onOpenProvision(); }}>{t("guide.runtime.install")}</Btn>
          )}
        </StepBody>
      ),
    },
    {
      id: "role",
      title: t("guide.role.title"),
      done: !!st.voice,
      body: (
        <StepBody lead={t("guide.role.body")} done={st.voice ? t("guide.role.done") : undefined}>
          <Btn primary={!st.voice} onClick={() => away("plaza")}>{t("guide.role.plaza")}</Btn>
          <Btn onClick={() => away("models")}>{t("guide.role.import")}</Btn>
          <Btn onClick={() => away("train")}>{t("guide.role.train")}</Btn>
        </StepBody>
      ),
    },
    {
      id: "synth",
      title: t("guide.synth.title"),
      done: !!st.convert,
      body: (
        <StepBody lead={t("guide.synth.body")} done={st.convert ? t("guide.synth.done") : undefined}>
          <Btn primary={!st.convert} onClick={() => away("synth")}>{t("guide.synth.go")}</Btn>
        </StepBody>
      ),
    },
    {
      id: "own",
      title: t("guide.own.title"),
      body: (
        <StepBody lead={t("guide.own.body")}>
          <Btn onClick={() => away("annot")}>{t("guide.own.annot")}</Btn>
          <Btn onClick={() => away("train")}>{t("guide.own.train")}</Btn>
        </StepBody>
      ),
    },
  ];

  const qq = qqGroupLink();
  const issues = issueLink();
  return (
    <Wizard
      open={open && notice !== null}
      title={t("guide.title")}
      steps={steps}
      step={step}
      onStep={(id) => onStep(id as GuideStep)}
      onMinimize={onMinimize}
      onFinish={onFinish}
      notice={
        notice
          ? {
              title: t("guide.notice.title"),
              body: (
                <ol className="m-0 pl-5 list-decimal flex flex-col gap-3">
                  <li>{t("guide.notice.where")}</li>
                  <li>{t("guide.notice.diag")}</li>
                  <li>{t("guide.notice.detail")}</li>
                </ol>
              ),
              aside: qq?.qr ? (
                <img src={qq.qr} alt={qq.title} draggable={false} className="w-[128px] h-auto rounded-[var(--rs)] select-none" />
              ) : undefined,
              actions: <Btn onClick={() => void openExternal(issues.url)}>{issues.short}</Btn>,
              onAck: () => {
                setNotice(false);
                void setConfig({ feedback_notice_done: true }).catch(() => {});
              },
            }
          : undefined
      }
    />
  );
}

function StepBody({ lead, done, children }: { lead: string; done?: string; children?: ReactNode }) {
  return (
    <div>
      <p className="text-[13px] text-[var(--ink)] m-0 mb-5 leading-relaxed">{lead}</p>
      {done ? <div className="mb-4 text-[13px] text-[var(--accent-text)]">{done}</div> : null}
      {children ? <div className="flex items-center gap-2 flex-wrap">{children}</div> : null}
    </div>
  );
}

/** 收起后留在右下角的小按钮。 */
export function GuidePill({ step, onOpen, onClose }: { step: GuideStep; onOpen: () => void; onClose: () => void }) {
  return (
    <WizardPill
      label={t("guide.resume")}
      detail={t("ui.wizard.count", { n: GUIDE_STEPS.indexOf(step) + 1, total: GUIDE_STEPS.length })}
      onOpen={onOpen}
      onClose={onClose}
    />
  );
}
