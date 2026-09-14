import { useEffect, useState, memo } from "react";
import { Block, Group, ListItem, PageHead, PagePad } from "../components/ui";
import { t } from "../i18n/t";

/**
 * 说明页。
 *
 * 保留 RVC-Fabric 的信息架构：锚点分节 + 手风琴问答，任何一处结论都能深链
 * 到具体小节。内容按 GPT-SoVITS Fabric 重写：安装与首次运行、角色包导入、
 * 合成指南、训练指南、.list 标注格式、常见问题。
 */

export const HELP_ANCHORS = new Set([
  "firstrun",
  "packs",
  "synth",
  "train",
  "listformat",
  "faq",
]);

type QA = { q: string; a: string };

function useHelpFocus(focus: string, focusNonce: number) {
  const [hit, setHit] = useState("");
  useEffect(() => {
    if (!focus || !focusNonce) return;
    setHit(focus);
    const timer = window.setTimeout(() => setHit(""), 2400);
    return () => window.clearTimeout(timer);
  }, [focus, focusNonce]);
  return hit;
}

function Faq({ items, highlight }: { items: QA[]; highlight: string }) {
  return (
    <Group>
      {items.map((f, i) => (
        <div
          key={i}
          className={
            highlight && f.q === highlight
              ? "rounded-[var(--rs)] shadow-[inset_0_0_0_2px_var(--accent)]"
              : ""
          }
        >
          <ListItem title={f.q} desc={f.a} />
        </div>
      ))}
    </Group>
  );
}

const FIRST_RUN: QA[] = [
  {
    q: t("help.frQ1"),
    a: t("help.frA1"),
  },
  {
    q: t("help.frQ2"),
    a: t("help.frA2"),
  },
  {
    q: t("help.frQ3"),
    a: t("help.frA3"),
  },
];

const PACK_GUIDE: QA[] = [
  { q: t("help.packQ1"), a: t("help.packA1") },
  { q: t("help.packQ2"), a: t("help.packA2") },
  { q: t("help.packQ3"), a: t("help.packA3") },
];

const SYNTH_GUIDE: QA[] = [
  { q: t("help.synthQ1"), a: t("help.synthA1") },
  { q: t("help.synthQ2"), a: t("help.synthA2") },
  { q: t("help.synthQ3"), a: t("help.synthA3") },
  { q: t("help.synthQ4"), a: t("help.synthA4") },
];

const TRAIN_GUIDE: QA[] = [
  { q: t("help.trainQ1"), a: t("help.trainA1") },
  { q: t("help.trainQ2"), a: t("help.trainA2") },
  { q: t("help.trainQ3"), a: t("help.trainA3") },
];

const LIST_FORMAT: QA[] = [
  { q: t("help.listQ1"), a: t("help.listA1") },
  { q: t("help.listQ2"), a: t("help.listA2") },
  { q: t("help.listQ3"), a: t("help.listA3") },
];

const FAQ: QA[] = [
  { q: t("help.faqQ1"), a: t("help.faqA1") },
  { q: t("help.faqQ2"), a: t("help.faqA2") },
  { q: t("help.faqQ3"), a: t("help.faqA3") },
  { q: t("help.faqQ4"), a: t("help.faqA4") },
];

function HelpPageImpl({
  focus,
  focusNonce,
}: {
  focus: string;
  focusNonce: number;
  onOpenCommunity?: () => void;
}) {
  const hit = useHelpFocus(focus, focusNonce);

  return (
    <PagePad>
      <PageHead title={t("help.title")} sub={t("help.subtitle")} />

      <Block id="help-firstrun" title={t("help.firstrunTitle")} note={String(FIRST_RUN.length)}>
        <Faq items={FIRST_RUN} highlight={hit} />
      </Block>

      <Block id="help-packs" title={t("help.packsTitle")} note={String(PACK_GUIDE.length)}>
        <Faq items={PACK_GUIDE} highlight={hit} />
      </Block>

      <Block id="help-synth" title={t("help.synthTitle")} note={String(SYNTH_GUIDE.length)}>
        <Faq items={SYNTH_GUIDE} highlight={hit} />
      </Block>

      <Block id="help-train" title={t("help.trainGuideTitle")} note={String(TRAIN_GUIDE.length)}>
        <Faq items={TRAIN_GUIDE} highlight={hit} />
      </Block>

      <Block id="help-listformat" title={t("help.listTitle")} note={String(LIST_FORMAT.length)}>
        <Faq items={LIST_FORMAT} highlight={hit} />
      </Block>

      <Block id="help-faq" title={t("help.faqTitle")} note={String(FAQ.length)}>
        <Faq items={FAQ} highlight={hit} />
      </Block>
    </PagePad>
  );
}

export const HelpPage = memo(HelpPageImpl);
