import { useEffect, useMemo, useRef, useState, memo } from "react";
import {
  AccordionGroup,
  Block,
  Btn,
  PageHead,
  PagePad,
  type AccordionItem,
} from "../components/ui";
import { SearchBox } from "../trm";
import { useGlossary, useGlossarySectionTitle } from "../lib/glossary";
import { useI18n } from "../i18n";
import { t } from "../i18n/t";

/**
 * 说明页。
 *
 * 保留 RVC-Fabric 的信息架构：锚点分节 + 手风琴问答，任何一处结论都能深链
 * 到具体小节。内容按 GPT-SoVITS Fabric 重写：安装与首次运行、角色包导入、
 * 合成指南、训练指南、.list 标注格式、常见问题。
 *
 * 每条问答三层：标题（问题）、一行摘要（扫读用）、展开后的完整答案。
 * 摘要和答案是两条文案 —— 摘要只写结论，答案写操作步骤，别互相复读。
 *
 * 词条表（专有名词）和问答共用同一套手风琴，但展开状态分开管：
 * 词条是查字典式的浏览，展开一条不该把刚才看的那条答案收掉。
 */

export const HELP_ANCHORS = new Set([
  "firstrun",
  "packs",
  "synth",
  "train",
  "listformat",
  "faq",
  "glossary",
]);

/** i18n 校验靠源码里的字面量认活键，所以 Q/H/A 三个 key 全写实、不拼模板。 */
const SECTIONS: {
  anchor: string;
  titleKey: string;
  items: { id: string; q: string; h: string; a: string }[];
}[] = [
  {
    anchor: "firstrun",
    titleKey: "help.firstrunTitle",
    items: [
      { id: "fr1", q: "help.frQ1", h: "help.frH1", a: "help.frA1" },
      { id: "fr2", q: "help.frQ2", h: "help.frH2", a: "help.frA2" },
      { id: "fr3", q: "help.frQ3", h: "help.frH3", a: "help.frA3" },
    ],
  },
  {
    anchor: "packs",
    titleKey: "help.packsTitle",
    items: [
      { id: "pack1", q: "help.packQ1", h: "help.packH1", a: "help.packA1" },
      { id: "pack2", q: "help.packQ2", h: "help.packH2", a: "help.packA2" },
      { id: "pack3", q: "help.packQ3", h: "help.packH3", a: "help.packA3" },
    ],
  },
  {
    anchor: "synth",
    titleKey: "help.synthTitle",
    items: [
      { id: "synth1", q: "help.synthQ1", h: "help.synthH1", a: "help.synthA1" },
      { id: "synth2", q: "help.synthQ2", h: "help.synthH2", a: "help.synthA2" },
      { id: "synth3", q: "help.synthQ3", h: "help.synthH3", a: "help.synthA3" },
      { id: "synth4", q: "help.synthQ4", h: "help.synthH4", a: "help.synthA4" },
      { id: "synthEngine", q: "help.synthEngineQ", h: "help.synthEngineH", a: "help.synthEngineA" },
    ],
  },
  {
    anchor: "train",
    titleKey: "help.trainGuideTitle",
    items: [
      { id: "train1", q: "help.trainQ1", h: "help.trainH1", a: "help.trainA1" },
      { id: "train2", q: "help.trainQ2", h: "help.trainH2", a: "help.trainA2" },
      { id: "train3", q: "help.trainQ3", h: "help.trainH3", a: "help.trainA3" },
    ],
  },
  {
    anchor: "listformat",
    titleKey: "help.listTitle",
    items: [
      { id: "list1", q: "help.listQ1", h: "help.listH1", a: "help.listA1" },
      { id: "list2", q: "help.listQ2", h: "help.listH2", a: "help.listA2" },
      { id: "list3", q: "help.listQ3", h: "help.listH3", a: "help.listA3" },
    ],
  },
  {
    anchor: "faq",
    titleKey: "help.faqTitle",
    items: [
      { id: "faq1", q: "help.faqQ1", h: "help.faqH1", a: "help.faqA1" },
      { id: "faq2", q: "help.faqQ2", h: "help.faqH2", a: "help.faqA2" },
      { id: "faq3", q: "help.faqQ3", h: "help.faqH3", a: "help.faqA3" },
      { id: "faq4", q: "help.faqQ4", h: "help.faqH4", a: "help.faqA4" },
    ],
  },
];

function useHelpFocus(focus: string, focusNonce: number) {
  const [hit, setHit] = useState("");
  // 页面常驻，每次回来副作用都会重新执行：已处理过的跳转不再重复高亮。
  const done = useRef(0);
  useEffect(() => {
    if (!focus || !focusNonce || done.current === focusNonce) return;
    setHit(focus);
    const timer = window.setTimeout(() => {
      done.current = focusNonce;
      setHit("");
    }, 2400);
    return () => window.clearTimeout(timer);
  }, [focus, focusNonce]);
  return hit;
}

function HelpPageImpl({
  focus,
  focusNonce,
  onOpenCommunity,
  onStartGuide,
}: {
  focus: string;
  focusNonce: number;
  /** 跳到「其他」页的仓库与社媒。说明页答不上来的，只能找人问。 */
  onOpenCommunity?: () => void;
  /** 打开新手引导。 */
  onStartGuide?: () => void;
}) {
  // 订阅语言：问答与词条都随界面语言切换重算。
  const { locale } = useI18n();
  const glossary = useGlossary();
  const glossaryTitle = useGlossarySectionTitle();
  const hit = useHelpFocus(focus, focusNonce);

  // 问答区和词条区各自最多展开一条，互不干扰。
  const [open, setOpen] = useState("");
  const [openTerm, setOpenTerm] = useState("");
  // 页头的搜索框：在全部问答与词条里找，问题、摘要、答案里出现就算命中。
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const pick = (items: AccordionItem[]) =>
    needle
      ? items.filter((e) => [e.title, e.desc, e.content].some((v) => String(v ?? "").toLowerCase().includes(needle)))
      : items;

  const sections = useMemo(
    () =>
      SECTIONS.map((s) => ({
        ...s,
        title: t(s.titleKey),
        items: s.items.map(
          (e): AccordionItem => ({
            id: e.id,
            title: t(e.q),
            desc: t(e.h),
            content: t(e.a),
          }),
        ),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t() 读全局 locale，locale 变化必须触发重算
    [locale],
  );

  const glossaryItems = useMemo(
    () =>
      glossary.map(
        (term): AccordionItem => ({
          id: term.id,
          title: term.term,
          desc: term.brief,
          content: term.detail,
        }),
      ),
    [glossary],
  );

  const shownSections = sections.map((s) => ({ ...s, shown: pick(s.items) }));
  const shownGlossary = pick(glossaryItems);
  const hits = shownSections.reduce((n, s) => n + s.shown.length, shownGlossary.length);
  const note = (shown: AccordionItem[], all: AccordionItem[]) =>
    needle ? `${shown.length} / ${all.length}` : String(all.length);

  // 跳转落地：focus 形如「synth」或「synth#synth2」。带条目 id 时
  // 直接把那条展开 —— 指到一整块等于没指。
  const landed = useRef(0);
  useEffect(() => {
    if (!focus || !focusNonce || landed.current === focusNonce) return;
    landed.current = focusNonce;
    const [sec, itemId] = focus.split("#");
    if (!sec || !HELP_ANCHORS.has(sec)) return;
    if (sec === "glossary") {
      if (itemId) setOpenTerm(itemId);
    } else if (itemId) {
      setOpen(itemId);
    } else {
      // 没带条目 id 就展开该节第一条，否则跳过去只看到一排标题。
      const first = sections.find((s) => s.anchor === sec)?.items[0].id;
      if (first) setOpen(first);
    }
    const el = document.getElementById(`help-${sec}`);
    const pane = el?.closest(".overflow-y-auto");
    if (el && pane instanceof HTMLElement) {
      // offsetTop 不受 transform 影响；换页动画期间 scrollIntoView 落点会漂。
      pane.scrollTop = Math.max(0, el.offsetTop - 12);
    } else {
      el?.scrollIntoView({ block: "start" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sections 随语言重建，focus 才是触发源
  }, [focus, focusNonce]);

  return (
    <PagePad width="read">
      <PageHead
        title={t("help.title")}
        sub={t("help.subtitle")}
        actions={
          <>
            <div className="w-[240px] flex">
              <SearchBox value={query} onChange={setQuery} />
            </div>
            {onOpenCommunity ? <Btn onClick={() => onOpenCommunity()}>{t("s.contactCommunity")}</Btn> : null}
          </>
        }
      />

      {needle && hits === 0 ? (
        <p className="text-[13px] text-[var(--ink-muted)] m-0 mb-4">{t("help.faqNoHit")}</p>
      ) : null}

      {shownSections.map((s) => {
        if (!s.shown.length) return null;
        return (
        <Block
          key={s.anchor}
          id={`help-${s.anchor}`}
          className="!mt-6"
          title={s.title}
          note={note(s.shown, s.items)}
          action={s.anchor === "firstrun" && onStartGuide ? <Btn primary onClick={() => onStartGuide()}>{t("help.guideStart")}</Btn> : undefined}
        >
          <AccordionGroup
            items={s.shown}
            openId={open}
            onToggle={(id) => setOpen((c) => (c === id ? "" : id))}
            openLabel={t("s.5d5815647c")}
            closedLabel={t("s.b0e24833f7")}
            highlight={hit.startsWith(`${s.anchor}#`) ? hit.split("#")[1] : undefined}
          />
        </Block>
        );
      })}

      {shownGlossary.length ? (
        <Block id="help-glossary" className="!mt-6" title={glossaryTitle} note={note(shownGlossary, glossaryItems)}>
          <AccordionGroup
            items={shownGlossary}
            openId={openTerm}
            onToggle={(id) => setOpenTerm((c) => (c === id ? "" : id))}
            openLabel={t("s.5d5815647c")}
            closedLabel={t("s.b0e24833f7")}
          />
        </Block>
      ) : null}
    </PagePad>
  );
}

export const HelpPage = memo(HelpPageImpl);
