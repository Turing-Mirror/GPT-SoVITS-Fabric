// @vitest-environment happy-dom
import { act, lazy } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { PageId } from "../lib/nav";
import { PageHost } from "./PageHost";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
    expect(container.textContent).toBe("Home");
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
  }
});
