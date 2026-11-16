// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { t } from "../i18n/t";
import { SetupGuide } from "./SetupGuide";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../lib/plaza", () => ({ openExternal: vi.fn() }));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let confirmed: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  confirmed = false;
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "config_get") return { feedback_notice_done: confirmed };
    return {};
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openGuide() {
  const minimize = vi.fn();
  await act(async () => {
    root.render(
      <SetupGuide
        open
        step="runtime"
        onStep={() => {}}
        onMinimize={minimize}
        onFinish={() => {}}
        onNavigate={() => {}}
        onOpenProvision={() => {}}
      />,
    );
  });
  return minimize;
}

it("keeps the first feedback notice open for five seconds before confirmation", async () => {
  const minimize = await openGuide();
  const notice = document.querySelector('[role="dialog"]');
  expect(notice?.textContent).toContain(t("guide.notice.title"));
  expect(notice?.querySelector("img")?.getAttribute("src")).toBeTruthy();

  const buttons = Array.from(notice?.querySelectorAll("button") ?? []);
  const confirm = buttons[buttons.length - 1];
  expect(confirm?.disabled).toBe(true);
  act(() => {
    notice?.parentElement?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    notice?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(minimize).not.toHaveBeenCalled();

  for (let second = 0; second < 4; second++) {
    act(() => { vi.advanceTimersByTime(1000); });
  }
  act(() => { vi.advanceTimersByTime(999); });
  expect(confirm?.disabled).toBe(true);
  act(() => { vi.advanceTimersByTime(1); });
  expect(confirm?.disabled).toBe(false);

  await act(async () => confirm?.click());
  expect(invoke).toHaveBeenCalledWith("config_set", { patch: { feedback_notice_done: true } });
  expect(document.body.textContent).toContain(t("guide.runtime.title"));
  expect(document.body.textContent).not.toContain(t("guide.notice.title"));
});

it("shows the guide steps immediately after the notice has been confirmed", async () => {
  confirmed = true;
  const minimize = await openGuide();
  expect(document.body.textContent).toContain(t("guide.runtime.title"));
  expect(document.body.textContent).not.toContain(t("guide.notice.title"));
  const guide = document.querySelector('[role="dialog"]');
  act(() => {
    guide?.parentElement?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
  expect(minimize).toHaveBeenCalledOnce();
});
