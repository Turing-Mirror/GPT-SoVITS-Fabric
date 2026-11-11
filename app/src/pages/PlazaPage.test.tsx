// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NoticeProvider } from "trm-ui";
import { I18nProvider } from "../i18n";
import { ensurePack } from "../trm/i18n/packs";
import { PlazaPage } from "./PlazaPage";
import { newDraft, prepareSubmission, type Draft } from "../lib/communityPublication";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../components/StoreSection", () => ({ StoreSection: () => null }));
vi.mock("../components/ExtrasDialog", () => ({ ExtrasPanel: () => null }));

const feed = { items: [], banner: null, changelog: [], errors: [], app_version: "", newest: "", unread: false };
const guest = { signedIn: false, displayName: null, email: null, offline: false };
const signedIn = { signedIn: true, displayName: "Test publisher", email: "publisher@example.test", offline: false };
const accountUrl = "https://account.example.test/";
let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  localStorage.setItem("trm.ui.locale", "en-US");
  await ensurePack("en-US");
  invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "community_links") return { enabled: true, accountUrl };
    if (command === "community_account_status" || command === "community_account_sign_out") return guest;
    if (command === "community_account_sign_in") return signedIn;
    if (command === "community_publication") return { items: [], page: 1, totalPages: 1 };
    return {};
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.removeItem("trm.ui.locale");
  localStorage.removeItem("fabric.community.characterDrafts.v1");
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

function button(label: string, scope: HTMLElement = host) {
  const result = [...scope.querySelectorAll("button")].find(node => node.textContent?.trim() === label);
  if (!result) throw new Error("Missing button " + label);
  return result;
}

it("keeps Publish and account before Refresh and replaces Sign in after authentication", async () => {
  await act(async () => root.render(<I18nProvider><NoticeProvider><PlazaPage feed={feed} /></NoticeProvider></I18nProvider>));
  const toolbar = button("Refresh").parentElement!;
  const labels = () => [...toolbar.querySelectorAll("button")].map(node => node.textContent?.trim());
  expect(labels()).toEqual(["Publish", "Sign in", "Refresh"]);
  await act(async () => button("Sign in").click());
  expect(invoke).toHaveBeenCalledWith("community_account_sign_in");
  expect(labels()).toEqual(["Publish", "Test publisher", "Refresh"]);
  await act(async () => button("Test publisher").click());
  expect(button("My submissions", document.body)).toBeDefined();
  expect(button("Manage account", document.body)).toBeDefined();
  await act(async () => button("Sign out", document.body).click());
  expect(invoke).toHaveBeenCalledWith("community_account_sign_out");
  expect(labels()).toEqual(["Publish", "Sign in", "Refresh"]);
});

it("opens character publishing and My submissions in the signed-in desktop window", async () => {
  await act(async () => root.render(<I18nProvider><NoticeProvider><PlazaPage feed={feed} /></NoticeProvider></I18nProvider>));
  await act(async () => button("Sign in").click());
  await act(async () => button("Publish").click());
  const editor = host.querySelector<HTMLElement>('[data-trm-pane="publish"]')!;
  expect(editor.hidden).toBe(false);
  expect(editor.textContent).toContain("Publish character");
  expect(editor.querySelector('[aria-label="Source link"]')).not.toBeNull();
  const baseModel = editor.querySelector<HTMLSelectElement>('select[aria-label="Base model"]')!;
  expect(baseModel.value).toBe("");
  expect([...baseModel.options].map((option) => option.value)).toEqual(["", "v1", "v2", "v2Pro", "v2ProPlus", "v3", "v4", "v5dev", "v5turbo"]);
  expect(editor.textContent).toContain("Choose a character ZIP from a public repository.");

  await act(async () => {
    button("My submissions", editor).click();
    await new Promise(resolve => setTimeout(resolve, 450));
  });
  await act(async () => {});
  const list = host.querySelector<HTMLElement>('[data-trm-pane="submissions"]')!;
  expect(list.hidden).toBe(false);
  expect(list.textContent).toContain("No drafts yet.");
  await act(async () => button("Under review", list).click());
  expect(invoke).toHaveBeenCalledWith("community_publication", { request: { action: "mine", state: "pending", page: 1, limit: 8 } });
  expect(invoke.mock.calls.some(([command]) => command === "open_external")).toBe(false);
});

it("records the chosen base version and preserves the original request on retry", async () => {
  const draft: Draft = {
    ...newDraft(),
    baseVersion: "v2",
    selection: {
      account: signedIn.email,
      resolveId: "source",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      canonicalUrl: "https://modelscope.cn/models/example/characters",
      revision: "fixed-revision",
      file: { id: "character.zip", path: "character.zip", sizeBytes: 128 },
    },
  };

  await expect(prepareSubmission({ ...draft, baseVersion: undefined }, signedIn.email))
    .rejects.toMatchObject({ code: "base_version_required" });
  const pending = await prepareSubmission(draft, signedIn.email);
  expect(pending.body.asset.metadata.familyVersion).toBe("v2");
  expect(await prepareSubmission({ ...draft, baseVersion: undefined, pending }, signedIn.email)).toBe(pending);
});
