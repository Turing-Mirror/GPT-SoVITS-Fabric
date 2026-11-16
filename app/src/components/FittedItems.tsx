import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { fittedCount } from "../lib/fittedItems";

/** Measure the same wrapping layout without exposing its overflow to focus or scrolling. */
export function FittedItems({ items, className }: { items: ReactElement[]; className: string }) {
  const host = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  useLayoutEffect(() => {
    const box = host.current;
    const list = measure.current;
    if (!box || !list) return;
    const update = () => setCount(fittedCount(
      Array.from(list.children, (child) => {
        const el = child as HTMLElement;
        return { top: el.offsetTop, height: el.offsetHeight };
      }),
      box.clientHeight,
    ));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    observer.observe(list);
    return () => observer.disconnect();
  }, [items]);
  return (
    <div ref={host} className="relative min-h-0 overflow-hidden h-full">
      <div className={className}>{items.slice(0, count)}</div>
      <div ref={measure} aria-hidden inert className={className}
        style={{ position: "absolute", inset: "0 0 auto", visibility: "hidden", pointerEvents: "none" }}>
        {items}
      </div>
    </div>
  );
}
