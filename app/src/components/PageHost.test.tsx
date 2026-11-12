// @vitest-environment happy-dom
import { act, lazy } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PageId } from "../lib/nav";
import { PageHost } from "./PageHost";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// 推移动画的替身：按真实时长走完，由假计时器推进。
const realAnimate = HTMLElement.prototype.animate;
beforeEach(() => {
  HTMLElement.prototype.animate = function () {
    let fail!: (reason: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => { fail = reject; window.setTimeout(resolve, 420); });
    return { finished, cancel: () => fail(new Error("cancelled")) } as unknown as Animation;
  } as typeof HTMLElement.prototype.animate;
});
afterEach(() => { HTMLElement.prototype.animate = realAnimate; });

it("keeps the outgoing page inert while a first visit loads, and ignores a load that finishes after leaving", async () => {
  vi.useFakeTimers();
  const container = document.createElement("div");
  const root = createRoot(container);
  let finish!: () => void;
  const load = new Promise<{ default: () => React.JSX.Element }>(resolve => {
    finish = () => resolve({ default: () => <button>Models</button> });
  });
  const Models = lazy(() => load);
  const render = (page: PageId) => act(() => root.render(
    <PageHost page={page}>{id => id === "models" ? <Models /> : <button>Home</button>}</PageHost>,
  ));
  try {
    render("home");
    const home = container.querySelector("button");
    render("models");
    expect(container.querySelector("[inert] button")).toBe(home);
    expect(container.querySelector("[data-page-scroll] [role=status]")).not.toBeNull();
    render("home");
    await act(async () => { finish(); await vi.advanceTimersByTimeAsync(450); });
    expect(container.querySelector("[data-page-scroll] button")).toBe(home);
    // 模型页留在台下：搭好了但藏着，点不到。
    const models = [...container.querySelectorAll("button")].find(b => b.textContent === "Models")!;
    expect(models.style.display).toBe("none");
    expect(models.closest("[inert]")).not.toBeNull();
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
  }
});

it("keeps Community mounted and restores the same scroll and form after changing tabs", async () => {
  vi.useFakeTimers();
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (page: PageId) => act(() => root.render(
    <PageHost page={page}>{id => id === "plaza" ? <input aria-label="Community search" /> : <button>Home</button>}</PageHost>,
  ));
  try {
    render("plaza");
    const initialPane = container.querySelector<HTMLElement>("[data-page-scroll]")!;
    const field = initialPane.querySelector("input")!;
    field.value = "Yuuka";
    initialPane.scrollTop = 130;
    render("home");
    await act(async () => { await vi.advanceTimersByTimeAsync(450); });
    expect(initialPane.inert).toBe(true);
    expect(initialPane.querySelector("input")).toBe(field);
    initialPane.scrollTop = 0;
    render("plaza");
    expect(container.querySelector("[data-page-scroll]")).toBe(initialPane);
    expect(field.value).toBe("Yuuka");
    expect(initialPane.scrollTop).toBe(130);
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
  }
});
