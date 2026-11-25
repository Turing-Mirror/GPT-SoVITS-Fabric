// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/intent", () => ({ openInAnnot: vi.fn(), synthWithRole: vi.fn() }));

import { RoleAssetsDialog } from "./RoleAssetsDialog";
import { I18nProvider } from "../i18n";
import { t } from "../i18n/t";

let root: Root;
let container: HTMLDivElement;

function makeAssets(opts?: { sovitsPath?: string; sovitsExists?: boolean; gptPath?: string; gptExists?: boolean }) {
  return {
    id: "role-1",
    version: "v2Pro",
    versions: ["v2Pro"],
    weights: [
      { kind: "sovits", path: opts?.sovitsPath ?? "C:/roles/role-1/sovits_e12.pth", exists: opts?.sovitsExists ?? true, size: 1024 },
      { kind: "gpt", path: opts?.gptPath ?? "C:/roles/role-1/gpt_e10.ckpt", exists: opts?.gptExists ?? true, size: 2048 },
    ],
    lists: [],
  };
}

function makeVersions(overrides?: {
  experiment?: string | null;
  sovitsState?: "matched" | "source_removed" | "external" | "missing";
  sovitsEpoch?: number | null;
  sovitsVersions?: { file: string; epoch: number | null; step: number | null; is_final: boolean; current: boolean }[];
  gptVersions?: { file: string; epoch: number | null; step: number | null; is_final: boolean; current: boolean }[];
}) {
  return {
    experiment: overrides && "experiment" in overrides ? overrides.experiment : "role-1",
    weights_dir: "C:/train/role-1",
    weights: [
      {
        kind: "sovits",
        current: {
          state: overrides?.sovitsState ?? "matched",
          file: "sovits_e12.pth",
          epoch: overrides && "sovitsEpoch" in overrides ? overrides.sovitsEpoch : 12,
          step: null,
        },
        versions: overrides?.sovitsVersions ?? [
          { file: "sovits_e8.pth", epoch: 8, step: null, is_final: false, current: false },
          { file: "sovits_e12.pth", epoch: 12, step: null, is_final: true, current: true },
        ],
      },
      {
        kind: "gpt",
        current: { state: "matched", file: "gpt_e10.ckpt", epoch: 10, step: null },
        versions: overrides?.gptVersions ?? [
          { file: "gpt_e10.ckpt", epoch: 10, step: null, is_final: true, current: true },
        ],
      },
    ],
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RoleAssetsDialog model versions", () => {
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    mocks.invoke.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("hides epoch selector when experiment is null or versions are empty", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "role_assets_get") return makeAssets();
      if (cmd === "model_versions_list") return makeVersions({ experiment: null, sovitsVersions: [], gptVersions: [] });
      return {};
    });

    await act(async () => root.render(
      <I18nProvider><RoleAssetsDialog role={{ id: "role-1", name: "Role 1" }} onClose={vi.fn()} onChanged={vi.fn()} /></I18nProvider>,
    ));
    await flush();

    expect(document.body.querySelectorAll('[aria-haspopup="listbox"]')).toHaveLength(0);
    expect(document.body.textContent).toContain("SoVITS");
    expect(document.body.textContent).toContain("GPT");
  });

  it("still renders assets when model_versions_list fails", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "role_assets_get") return makeAssets();
      if (cmd === "model_versions_list") throw new Error("boom");
      return {};
    });

    await act(async () => root.render(
      <I18nProvider><RoleAssetsDialog role={{ id: "role-1", name: "Role 1" }} onClose={vi.fn()} onChanged={vi.fn()} /></I18nProvider>,
    ));
    await flush();

    expect(document.body.querySelectorAll('[aria-haspopup="listbox"]')).toHaveLength(0);
    expect(document.body.textContent).toContain("sovits_e12.pth");
  });

  it("switches epoch via Select, updates details/versions, and ignores sentinel", async () => {
    const onChanged = vi.fn();
    let currentEpoch = 12;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "role_assets_get") {
        return makeAssets({ sovitsPath: `C:/roles/role-1/sovits_e${currentEpoch}.pth` });
      }
      if (cmd === "model_versions_list") {
        return makeVersions({
          sovitsState: "source_removed",
          sovitsEpoch: 6,
        });
      }
      if (cmd === "model_version_apply") {
        const { file } = args as { file: string };
        currentEpoch = file === "sovits_e8.pth" ? 8 : 12;
        return makeVersions({
          sovitsState: "matched",
          sovitsEpoch: currentEpoch,
          sovitsVersions: [
            { file: "sovits_e8.pth", epoch: 8, step: null, is_final: false, current: currentEpoch === 8 },
            { file: "sovits_e12.pth", epoch: 12, step: null, is_final: true, current: currentEpoch === 12 },
          ],
        });
      }
      return {};
    });

    await act(async () => root.render(
      <I18nProvider><RoleAssetsDialog role={{ id: "role-1", name: "Role 1" }} onClose={vi.fn()} onChanged={onChanged} /></I18nProvider>,
    ));
    await flush();

    const triggers = [...document.body.querySelectorAll<HTMLButtonElement>('[aria-haspopup="listbox"]')];
    expect(triggers).toHaveLength(2);
    expect(triggers[0].textContent).toContain(t("library.epochSourceRemoved", { v0: 6 }));

    // Open SoVITS dropdown and click sentinel -> should not call model_version_apply
    await act(async () => triggers[0].click());
    const sentinel = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(el => el.textContent?.includes(t("library.epochSourceRemoved", { v0: 6 })));
    expect(sentinel).toBeDefined();
    await act(async () => sentinel!.click());
    expect(mocks.invoke.mock.calls.filter(([c]) => c === "model_version_apply")).toHaveLength(0);

    // Re-open and pick epoch 8
    await act(async () => triggers[0].click());
    const opt8 = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(el => el.textContent?.includes(t("library.epochOption", { v0: 8 })));
    expect(opt8).toBeDefined();
    await act(async () => opt8!.click());
    await flush();

    expect(mocks.invoke).toHaveBeenCalledWith("model_version_apply", {
      target: "role-1",
      kind: "sovits",
      file: "sovits_e8.pth",
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("sovits_e8.pth");
    expect(document.body.querySelectorAll<HTMLButtonElement>('[aria-haspopup="listbox"]')[0].textContent)
      .toContain(t("library.epochOption", { v0: 8 }));
  });

  it("shows external and missing states and displays errors on apply failure", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === "role_assets_get") return makeAssets({ sovitsExists: false });
      if (cmd === "model_versions_list") {
        return {
          experiment: "role-1",
          weights_dir: "C:/train/role-1",
          weights: [
            {
              kind: "sovits",
              current: { state: "missing", file: null, epoch: null, step: null },
              versions: [{ file: "sovits_e8.pth", epoch: 8, step: null, is_final: false, current: false }],
            },
            {
              kind: "gpt",
              current: { state: "external", file: "custom.ckpt", epoch: null, step: null },
              versions: [{ file: "gpt_e10.ckpt", epoch: 10, step: null, is_final: true, current: false }],
            },
          ],
        };
      }
      if (cmd === "model_version_apply") throw new Error("apply failed");
      return {};
    });

    await act(async () => root.render(
      <I18nProvider><RoleAssetsDialog role={{ id: "role-1", name: "Role 1" }} onClose={vi.fn()} onChanged={vi.fn()} /></I18nProvider>,
    ));
    await flush();

    const triggers = [...document.body.querySelectorAll<HTMLButtonElement>('[aria-haspopup="listbox"]')];
    expect(document.body.textContent).toContain(t("library.missingFile"));
    expect(triggers[0].textContent).toContain(t("library.selectEpoch"));
    expect(triggers[1].textContent).toContain(t("library.weightExternal"));

    await act(async () => triggers[0].click());
    const opt8 = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(el => el.textContent?.includes(t("library.epochOption", { v0: 8 })));
    await act(async () => opt8!.click());
    await flush();

    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(t("diag.title.importexport"));
    expect(alert?.textContent).not.toContain("apply failed");
    await act(async () => [...alert!.querySelectorAll("button")].find(button => button.textContent === "Show details")!.click());
    expect(alert?.textContent).toContain("apply failed");
  });
});
