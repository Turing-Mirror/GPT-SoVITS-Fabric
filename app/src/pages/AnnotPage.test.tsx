// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), pick: vi.fn(), train: vi.fn(), confirm: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  convertFileSrc: (value: string) => value,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("trm-ui/fabric", async importOriginal => ({
  ...await importOriginal<typeof import("trm-ui/fabric")>(),
  pickPath: mocks.pick, askConfirm: mocks.confirm, askPrompt: vi.fn(),
}));
vi.mock("../lib/intent", () => ({ take: () => null, onHandoff: () => () => {}, trainWith: mocks.train, goTo: vi.fn() }));
vi.mock("../hooks/useConfig", () => ({ useConfig: () => ({ num: () => 100, set: vi.fn(), error: "" }) }));

import { AnnotPage } from "./AnnotPage";
import { I18nProvider } from "../i18n";
import { t } from "../i18n/t";

let root: Root;
let container: HTMLDivElement;
const annotation = {
  path: "C:/User_Data/datasets/dataset-123/voice.list", dir: "C:/User_Data/datasets/dataset-123",
  rows: [{ line: 1, wav: "sliced/voice.wav", abs: "C:/User_Data/datasets/dataset-123/sliced/voice.wav",
    speaker: "voice", lang: "en", text: "Hello", exists: true, issues: [] }],
  speakers: ["voice"], total: 1, bad: 0, missing: 0, relocated: 0, ambiguous: 0,
};

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === label);
  expect(found, `Missing button ${label}`).toBeDefined();
  return found!;
}

async function startCreation() {
  await act(async () => button(t("s.annot.create")).click());
  await act(async () => button(t("s.annot.chooseSource")).click());
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  window.location.hash = "";
  mocks.invoke.mockReset().mockImplementation(async command => command === "annot_generate" || command === "annot_load"
    ? annotation : command === "annot_save" ? { written: 1, backup: true } : { roles: [] });
  mocks.pick.mockReset().mockResolvedValue("C:/Recordings");
  mocks.listen.mockReset().mockResolvedValue(() => {});
  mocks.train.mockReset();
  mocks.confirm.mockReset().mockResolvedValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  window.location.hash = "";
});

it("creates annotations, opens the editor, and sends the exact generated file to training", async () => {
  let complete!: (value: typeof annotation) => void;
  mocks.invoke.mockImplementation(async command => {
    if (command === "annot_generate") return new Promise(resolve => { complete = resolve; });
    if (command === "annot_load") return annotation;
    return { roles: [], written: 1, backup: true };
  });
  await act(async () => root.render(<I18nProvider><AnnotPage /></I18nProvider>));
  await startCreation();
  await act(async () => button(t("s.annot.generate")).click());
  const request = mocks.invoke.mock.calls.find(([command]) => command === "annot_generate")![1];
  expect(request).toEqual({ source: "C:/Recordings", speaker: "Recordings", lang: "auto" });
  const onProgress = mocks.listen.mock.calls.find(([event]) => event === "annot-progress")![1];
  await act(async () => onProgress({ payload: "Transcribing recordings" }));
  expect(document.body.textContent).toContain("Transcribing recordings");
  expect(button(t("s.annot.cancelGenerate")).disabled).toBe(false);
  expect(button(t("s.annot.background")).disabled).toBe(false);
  await act(async () => complete(annotation));
  expect(container.querySelector("textarea")?.value).toBe("Hello");
  await act(async () => button(t("s.annot.toTrain")).click());
  expect(mocks.train).toHaveBeenCalledExactlyOnceWith(annotation.path);
});

it("lets user customize speaker, minimize generation to orb, and cancel running generation", async () => {
  let rejectGen!: (error: unknown) => void;
  mocks.invoke.mockImplementation(async command => {
    if (command === "annot_generate") return new Promise((_, reject) => { rejectGen = reject; });
    if (command === "annot_generate_cancel") {
      rejectGen({ code: "cancelled", message: t("s.annot.cancelled") });
      return {};
    }
    return { roles: [] };
  });
  await act(async () => root.render(<I18nProvider><AnnotPage /></I18nProvider>));
  await startCreation();
  const speakerInput = document.body.querySelector(`input[placeholder="${t("s.annot.speakerPh")}"]`) as HTMLInputElement;
  expect(speakerInput?.value).toBe("Recordings");
  await act(async () => button(t("s.annot.generate")).click());
  await act(async () => button(t("s.annot.background")).click());
  const orb = document.body.querySelector(`button[aria-label="${t("s.orbDownloadLabel")}"]`) as HTMLButtonElement | null;
  expect(orb).not.toBeNull();
  await act(async () => orb!.click());
  await act(async () => button(t("s.annot.cancelGenerate")).click());
  expect(mocks.invoke).toHaveBeenCalledWith("annot_generate_cancel");
  expect(document.body.textContent).toContain(t("s.annot.cancelled"));
});

it("allows retry after generation fails", async () => {
  mocks.invoke.mockImplementation(async command => {
    if (command === "annot_generate") throw new Error("Transcription model download failed");
    return { roles: [] };
  });
  await act(async () => root.render(<I18nProvider><AnnotPage /></I18nProvider>));
  await startCreation();
  await act(async () => button(t("s.annot.generate")).click());
  expect(document.body.textContent).toContain(t("diag.title.annotation"));
  expect(document.body.textContent).not.toContain("Transcription model download failed");
  expect(button(t("s.annot.generate")).disabled).toBe(false);
  mocks.invoke.mockResolvedValue(annotation);
  await act(async () => button(t("s.annot.generate")).click());
  expect(container.querySelector("textarea")?.value).toBe("Hello");
});

it("keeps generation disabled when the folder chooser is cancelled", async () => {
  mocks.pick.mockResolvedValue(null);
  await act(async () => root.render(<I18nProvider><AnnotPage /></I18nProvider>));
  await startCreation();
  expect(button(t("s.annot.generate")).disabled).toBe(true);
  expect(mocks.invoke.mock.calls.some(([command]) => command === "annot_generate")).toBe(false);
});

it("hands the selected file to the main training window from the standalone editor", async () => {
  window.location.hash = "#/tool/annot";
  await act(async () => root.render(<I18nProvider><AnnotPage /></I18nProvider>));
  await startCreation();
  await act(async () => button(t("s.annot.generate")).click());
  await act(async () => button(t("s.annot.toTrain")).click());
  expect(mocks.invoke).toHaveBeenCalledWith("tools_open_train", { path: annotation.path });
  expect(mocks.train).not.toHaveBeenCalled();
});
