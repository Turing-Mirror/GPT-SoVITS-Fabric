import { useLayoutEffect, useState, type CSSProperties } from "react";
import { colsForWidth } from "../lib/voices";

export const MODEL_GRID_CLASS = "grid grid-cols-[repeat(var(--model-columns),minmax(0,1fr))] gap-3";

/** Use the same five-column maximum and responsive breakpoints as RVC Fabric. */
export function useModelGrid(rowsPerPage = 3) {
  const [element, ref] = useState<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(5);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      if (element.clientWidth > 0) setColumns(colsForWidth(element.clientWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { ref, pageSize: columns * rowsPerPage, style: { "--model-columns": columns } as CSSProperties };
}
