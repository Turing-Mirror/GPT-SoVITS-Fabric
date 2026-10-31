/** 组件实现在 TRM UI（vendor: ../trm）。产品侧只经这里引用，换实现时页面不用改。 */
import type { ReactNode } from "react";
import { PagePad as TrmPagePad } from "../trm/components/ui";

export { PageHead, Block, Group, Btn, ListItem, HelpMark, type AccordionItem, AccordionGroup } from "../trm/components/ui";

/**
 * 页面内边距。`fill` 同 RVC Fabric 的音频页：宽度够时整页卡死成面板高度，
 * 各栏在自己内部滚动；窄窗口退回普通的整页滚动。
 */
export function PagePad({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
  if (!fill) return <TrmPagePad>{children}</TrmPagePad>;
  return (
    <div className="px-[30px] max-[1020px]:px-[22px] max-[720px]:px-4 pb-[26px] min-[900px]:pb-0 min-[900px]:h-full flex flex-col [container-type:inline-size]">
      {children}
    </div>
  );
}
