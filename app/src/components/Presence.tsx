import { createContext, useContext, useRef, type ReactNode } from "react";
import { EXIT_MS, useExit } from "../hooks/useExit";

/** 外层正在退场。弹窗、提示条读到它就换成退场样式。 */
export const LeavingContext = createContext(false);

export const useLeaving = () => useContext(LeavingContext);

/**
 * 条件渲染的外壳：`{cond ? <X/> : null}` 包进来之后，cond 变假时 X 不立刻
 * 消失，而是按最后一次的样子留到退场动画放完。
 */
export function Leave({ children, ms = EXIT_MS }: { children: ReactNode; ms?: number }) {
  const present = children !== null && children !== undefined && children !== false;
  const { mounted, leaving } = useExit(present, ms);
  const last = useRef<ReactNode>(null);
  if (present) last.current = children;
  if (!mounted) return null;
  return (
    <LeavingContext.Provider value={leaving}>
      {present ? children : last.current}
    </LeavingContext.Provider>
  );
}

/** 展开区：与 TRM UI 共用一个，展开与收起都有高度过渡，收起放完才卸下。 */
export { Collapse } from "../trm/components/motion";
