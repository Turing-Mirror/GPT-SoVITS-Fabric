// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../components/CatalogTransition", () => ({
  CatalogTransition: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../components/TrainingQueue", () => ({
  TrainingQueue: () => null,
}));
vi.mock("../components/ToolWindow", () => ({
  openTool: vi.fn(),
}));
vi.mock("../lib/intent", () => ({
  goTo: vi.fn(),
  createAnnot: vi.fn(),
  onHandoff: () => () => {},
  take: () => null,
}));

import { TrainPage } from "./TrainPage";
import { t, setTLocale } from "../i18n/t";

let root: Root;
let container: HTMLDivElement;

const STATUS = {
  runtime_ready: true,
  worker_present: true,
  engine_core_ready: true,
  engine_core_missing: [],
  nvidia: true,
  default_version: "v2Pro",
  versions: [
    {
      id: "v2Pro",
      lora: false,
      base_missing: [],
      defaults: {
        sovits: { epochs: 8, min_epochs: 1, max_epochs: 50, save_every: 4, batch: 4, max_batch: 16, learning_rate: 0.0001 },
        gpt: { epochs: 15, min_epochs: 1, max_epochs: 50, save_every: 5, batch: 4, max_batch: 16 },
      },
    },
  ],
  disk_free_bytes: 100 * 1024 ** 3,
  busy: false,
  interrupted: null,
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(b => b.textContent?.includes(label));
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

describe("TrainPage save_every_weights toggle", () => {
  beforeEach(() => {
    setTLocale("zh-CN");
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    mocks.invoke.mockReset().mockImplementation(async (cmd) => {
      if (cmd === "train_status") return STATUS;
      if (cmd === "train_output_dir") return "C:/out";
      if (cmd === "train_pick_dataset") return "C:/roles/demo/dataset/demo.list";
      if (cmd === "train_scan_dataset") return { files: 12 };
      if (cmd === "train_inspect_dataset") return { available: false };
      if (cmd === "train_queue_list") return { jobs: [] };
      return {};
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("defaults save_every_weights to true and passes the toggled value to train_queue_add", async () => {
    await act(async () => root.render(<TrainPage />));
    await flush();

    // Step 2: import dataset so step 4 can start
    await act(async () => button(t("train.datasetTitle")).click());
    await act(async () => button(t("train.importList")).click());
    await flush();

    // Step 3: verify toggle is checked by default, toggle off, resetDefaults keeps it off
    await act(async () => button(t("train.hyperTitle")).click());
    const labels = [...container.querySelectorAll("label")];
    const saveWeightsLabel = labels.find(l => l.textContent?.includes(t("train.saveEveryWeights")));
    expect(saveWeightsLabel).toBeDefined();
    const checkbox = saveWeightsLabel!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    // First submit with default true
    await act(async () => button(t("train.start")).click());
    await act(async () => button(t("train.queueAdd")).click());
    await flush();
    const firstCall = mocks.invoke.mock.calls.find(([cmd]) => cmd === "train_queue_add");
    expect((firstCall?.[1] as { req: { save_every_weights: boolean } }).req.save_every_weights).toBe(true);

    // Go back to step 3, uncheck, click resetDefaults, then submit again
    await act(async () => button(t("train.hyperTitle")).click());
    const checkbox2 = [...container.querySelectorAll("label")]
      .find(l => l.textContent?.includes(t("train.saveEveryWeights")))!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => checkbox2.click());
    expect(checkbox2.checked).toBe(false);

    await act(async () => button(t("train.resetDefaults")).click());
    expect(checkbox2.checked).toBe(false);

    await act(async () => button(t("train.start")).click());
    await act(async () => button(t("train.queueAdd")).click());
    await flush();

    const addCalls = mocks.invoke.mock.calls.filter(([cmd]) => cmd === "train_queue_add");
    expect(addCalls).toHaveLength(2);
    expect((addCalls[1][1] as { req: { save_every_weights: boolean } }).req.save_every_weights).toBe(false);
  });
});
