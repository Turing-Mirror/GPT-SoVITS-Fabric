// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "./index";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("waits for the stored language and lets the latest preview win without saving it", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const save = vi.fn();
  let current!: ReturnType<typeof useI18n>;
  function Probe() {
    current = useI18n();
    return current.ready ? <p>{current.t("nav.home")}</p> : null;
  }
  try {
    await act(async () => root.render(<I18nProvider store={{ load: () => "en-US", save }}><Probe /></I18nProvider>));
    await vi.waitFor(() => expect(container.textContent).toBe("Home"));
    await act(async () => {
      const previous = current.setLocale("fr-FR", false);
      const latest = current.setLocale("ja-JP", false);
      expect(await previous).toBe(false);
      expect(await latest).toBe(true);
    });
    expect(current.locale).toBe("ja-JP");
    expect(save).not.toHaveBeenCalled();
    await act(async () => { await current.setLocale("ja-JP"); });
    expect(save).toHaveBeenCalledExactlyOnceWith("ja-JP");
  } finally {
    act(() => root.unmount());
  }
});
