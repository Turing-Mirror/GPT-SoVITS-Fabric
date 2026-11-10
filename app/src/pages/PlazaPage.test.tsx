// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NoticeProvider } from "trm-ui";
import { I18nProvider } from "../i18n";
import { ensurePack } from "../trm/i18n/packs";
import { PlazaPage } from "./PlazaPage";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../components/StoreSection", () => ({ StoreSection: () => null }));
vi.mock("../components/ExtrasDialog", () => ({ ExtrasPanel: () => null }));

const feed = { items: [], banner: null, changelog: [], errors: [], app_version: "", newest: "", unread: false };
const guest = { signedIn: false, displayName: null, email: null, offline: false };
const signedIn = { signedIn: true, displayName: "Test publisher", email: "publisher@example.test", offline: false };
const publishUrl = "https://community.example.test/?community=publish&kind=model&family=gpt-sovits";
const accountUrl = "https://account.example.test/";
const submissionsUrl = "https://community.example.test/?community=mine";
let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  localStorage.setItem("trm.ui.locale", "en-US");
  await ensurePack("en-US");
  invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "community_links") return { enabled: true, publishUrl, submissionsUrl, accountUrl };
    if (command === "community_account_status" || command === "community_account_sign_out") return guest;
    if (command === "community_account_sign_in") return signedIn;
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
  await act(async () => button("Publish").click());
  expect(invoke).toHaveBeenCalledWith("open_external", { url: publishUrl });
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
