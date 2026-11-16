import type { PageId } from "./nav";

/**
 * 页面之间的跳转与交接：在模型页点「用于合成」、在标注页点「用于训练」这类动作。
 *
 * 发起方写下要交给哪一页的东西，再切过去；目标页挂载时（或已挂载时收到通知）取走。
 * 取走即清空，同一件事不会被处理两次。
 */

type Kind = "synthRole" | "annotList" | "trainDataset";

let navigate: ((page: PageId) => void | Promise<boolean>) | null = null;
const pending: Partial<Record<Kind, string>> = {};
const listeners = new Set<() => void>();

const TARGET: Record<Kind, PageId> = {
  synthRole: "synth",
  annotList: "annot",
  trainDataset: "train",
};

/** App 挂载时登记换页函数。 */
export function registerNavigator(fn: ((page: PageId) => void | Promise<boolean>) | null): void {
  navigate = fn;
}

function hand(kind: Kind, value: string): void {
  void Promise.resolve(navigate?.(TARGET[kind])).then(allowed => {
    if (allowed === false) return;
    pending[kind] = value;
    listeners.forEach((fn) => fn());
  });
}

/** 只换页，不交接东西。 */
export function goTo(page: PageId): void {
  navigate?.(page);
}

/** 取走交给本页的东西。没有时返回 null。 */
export function take(kind: Kind): string | null {
  const v = pending[kind];
  delete pending[kind];
  return v ?? null;
}

/** 已挂载的页面订阅交接；返回取消订阅。 */
export function onHandoff(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 到合成页并选中这个角色。 */
export const synthWithRole = (roleId: string) => hand("synthRole", roleId);
/** 到标注页并打开这份 .list。 */
export const openInAnnot = (listPath: string) => hand("annotList", listPath);
/** 到训练页并把这个目录设为数据集。 */
export const trainWith = (datasetDir: string) => hand("trainDataset", datasetDir);
