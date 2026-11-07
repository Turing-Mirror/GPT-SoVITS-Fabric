// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), synth: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (value: string) => value }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../lib/intent", () => ({ synthWithRole: mocks.synth, goTo: vi.fn(), openInAnnot: vi.fn() }));
import { ModelsPage } from "./ModelsPage";
import { I18nProvider } from "../i18n";
let root: Root;
let container: HTMLDivElement;
const role = (name: string) => ({ id: name, name, dir: "C:/roles/" + name, lists: [] });
const view = (active: boolean) => <I18nProvider><ModelsPage active={active} /></I18nProvider>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  mocks.invoke.mockReset().mockImplementation(async (cmd) => cmd === "synth_characters" ? { roles: [role("current")] } : {});
  mocks.synth.mockReset();
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });
describe("role library interaction", () => {
  it("does not switch to synthesis when the more button is opened", async () => {
    await act(async () => root.render(view(true)));
    const card = container.querySelector('[role="button"][aria-label="current"]')!;
    const more = card.querySelector("button")!;
    expect(more).not.toBeNull();
    act(() => more.click());
    expect(mocks.synth).not.toHaveBeenCalled();
    act(() => (card as HTMLElement).click());
    expect(mocks.synth).toHaveBeenCalledExactlyOnceWith("current");
  });
  it("ignores a delayed previous visit after returning and reloading", async () => {
    const loads: Array<(value: unknown) => void> = [];
    mocks.invoke.mockImplementation((cmd) => cmd === "synth_characters"
      ? new Promise(resolve => loads.push(resolve)) : Promise.resolve({}));
    await act(async () => root.render(view(true)));
    await act(async () => root.render(view(false)));
    await act(async () => root.render(view(true)));
    await act(async () => loads[1]({ roles: [role("new")] }));
    await act(async () => loads[0]({ roles: [role("old")] }));
    expect(container.querySelector('[aria-label="new"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="old"]')).toBeNull();
  });
});
