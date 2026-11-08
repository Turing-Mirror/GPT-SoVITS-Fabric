import { useCallback, useRef, useState } from "react";
import { mayLeave } from "../lib/navigationGuard";
import type { PageId } from "../lib/nav";
export function usePageNavigation(initial: PageId) {
  const [page, setPage] = useState(initial);
  const current = useRef(initial);
  const request = useRef(0);
  const navigate = useCallback(async (next: PageId): Promise<boolean> => {
    const revision = ++request.current;
    if (next === current.current) return true;
    if (!(await mayLeave()) || revision !== request.current) return false;
    current.current = next;
    setPage(next);
    return true;
  }, []);
  return [page, navigate] as const;
}
