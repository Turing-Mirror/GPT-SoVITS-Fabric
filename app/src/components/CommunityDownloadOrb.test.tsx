// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { t } from "../i18n/t";

const storeState = vi.hoisted(() => ({
  running: [] as string[],
  queued: [] as string[],
  prog: {} as Record<string, { percent?: number }>,
  error: null as string | null,
  activeLabel: undefined as string | undefined,
}));

const extraState = vi.hoisted(() => ({
  coreBusy: false,
  coreProg: null as { done?: number; total?: number; percent?: number } | null,
  busyKeys: {} as Record<string, boolean>,
  progByKey: {} as Record<string, { done?: number; total?: number }>,
  vulkanBusy: false,
  vulkanProgress: null as { done?: number; total?: number; percent?: number } | null,
  vulkanError: "",
  msg: "",
  hasError: false,
}));

vi.mock("../lib/storeJobs", () => ({ useStoreJobs: () => storeState }));
vi.mock("../lib/extraJobs", () => ({ useExtraJobs: () => extraState }));

import { CommunityDownloadOrb } from "./CommunityDownloadOrb";

beforeEach(() => {
  storeState.running = [];
  storeState.queued = [];
  storeState.prog = {};
  storeState.error = null;
  storeState.activeLabel = undefined;
  extraState.coreBusy = false;
  extraState.coreProg = null;
  extraState.busyKeys = {};
  extraState.progByKey = {};
  extraState.vulkanBusy = false;
  extraState.vulkanProgress = null;
  extraState.vulkanError = "";
  extraState.msg = "";
  extraState.hasError = false;
});

it("shows orb only off-plaza during community downloads, auto-hides cleanly, and alerts on error", async () => {
  const onOpenPlaza = vi.fn();
  const onOpenDownloads = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const renderAt = async (page: string) => {
    await act(async () => {
      root.render(
        <CommunityDownloadOrb
          activePage={page}
          onOpenPlaza={onOpenPlaza}
          onOpenDownloads={onOpenDownloads}
        />,
      );
    });
  };

  try {
    storeState.running = ["voice-1"];
    storeState.prog = { "voice-1": { percent: 42 } };
    storeState.activeLabel = "Demo Voice";

    await renderAt("plaza");
    expect(document.body.querySelector(`button[aria-label="${t("s.orbDownloadLabel")}"]`)).toBeNull();

    await renderAt("home");
    const orb = document.body.querySelector(`button[aria-label="${t("s.orbDownloadLabel")}"]`) as HTMLButtonElement | null;
    expect(orb).not.toBeNull();
    expect(orb!.textContent).toContain("42");

    // Clean finish starts exit transition (trm-orb-out) automatically.
    storeState.running = [];
    storeState.prog = {};
    await renderAt("home");
    const exitingOrb = document.body.querySelector(`button[aria-label="${t("s.orbDownloadLabel")}"]`);
    expect(exitingOrb === null || exitingOrb.classList.contains("trm-orb-out")).toBe(true);

    // Error while off-plaza keeps orb visible with alert and navigates back on click.
    extraState.vulkanBusy = true;
    await renderAt("home");
    extraState.vulkanBusy = false;
    extraState.hasError = true;
    extraState.vulkanError = "network failed";
    await renderAt("home");
    const errOrb = document.body.querySelector(`button[aria-label="${t("s.orbDownloadLabel")}"]`) as HTMLButtonElement | null;
    expect(errOrb).not.toBeNull();
    expect(errOrb!.classList.contains("trm-orb-out")).toBe(false);
    await act(async () => errOrb!.click());
    expect(onOpenDownloads).toHaveBeenCalledOnce();
    expect(onOpenPlaza).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
