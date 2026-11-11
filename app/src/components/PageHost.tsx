import { Suspense, useEffect, type ReactNode } from "react";
import { navDirection, type PageId } from "../lib/nav";
import { PageHost as SlideHost } from "../trm";
import { PageLoading } from "./PageLoading";
import { noteMount, noteUnmount } from "../lib/lifecycle";

type Props = {
  page: PageId;
  children: (id: PageId) => ReactNode;
};

const nav = { direction: navDirection };
/** 社区页离开后保持挂载：搜索、筛选和滚动位置都留着。 */
const keep = (id: PageId) => id === "plaza";
const paneClassName = (id: PageId) => (id === "home" ? "overflow-hidden" : "overflow-y-auto");

/**
 * 按导航顺序整页推移，动效由 TRM UI 的 PageHost 提供：
 * 新旧两页首尾相接一起平移，中途改主意时从当前位置接着走。
 */
export function PageHost({ page, children }: Props) {
  return (
    <SlideHost nav={nav} page={page} keep={keep} paneClassName={paneClassName}>
      {(id) => (
        <Ledger id={id}>
          <Suspense fallback={<PageLoading />}>{children(id)}</Suspense>
        </Ledger>
      )}
    </SlideHost>
  );
}

/** 装卸次数记进生命周期台账，供「切页 100 次不留净增长」验收。 */
function Ledger({ id, children }: { id: PageId; children: ReactNode }) {
  useEffect(() => {
    noteMount(`page:${id}`);
    return () => noteUnmount(`page:${id}`);
  }, [id]);
  return <>{children}</>;
}
