// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { t } from "../i18n/t";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../lib/engine", () => ({
  startProvision: (variant: string, force: boolean) => invoke("provision_start", { variant, force }),
  cancelProvision: () => invoke("provision_cancel"),
}));

import { ProvisionGate } from "./ProvisionGate";

it("offers one dependency at a time and keeps remaining steps when one is skipped", async () => {
  invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case "provision_start": return { ok: true };
      case "assets_status": return { engine_core_ready: false, vbcable_installed: false };
      case "vcredist_installed": return false;
      default: return {};
    }
  });
  const finish = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    root.render(<ProvisionGate open initial={{ recommended_variant: "nvidia" }} onDone={finish} />);
  });
  const body = document.body;
  const click = async (label: string) => {
    const button = Array.from(body.querySelectorAll("button")).find(b => b.textContent?.trim() === label);
    expect(button, label).toBeDefined();
    await act(async () => button!.click());
  };

  try {
    expect(body.textContent).toContain(t("s.405125fb37"));
    await click(t("s.92f35590d5"));
    expect(body.textContent).toContain(t("extras.engineTitle"));
    expect(body.textContent).not.toContain(t("s.vcrTitle"));
    await click(t("s.479fcc1cc0"));
    expect(body.textContent).toContain(t("s.vcrTitle"));
    expect(finish).not.toHaveBeenCalled();
    await click(t("s.vcrInstall"));
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(expect.arrayContaining([
      "assets_ensure_vcredist", "vcredist_install",
    ]));
    expect(body.textContent).toContain(t("s.f2e88c071e"));
    await click(t("s.33246f6a5e"));
    expect(finish).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
