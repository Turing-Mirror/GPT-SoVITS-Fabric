// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NoticeProvider } from "trm-ui";
import { I18nProvider } from "../i18n";
import { ensurePack } from "../trm/i18n/packs";
import { PlazaPage } from "./PlazaPage";
import { editListingDraft, newDraft, newVersionDraft, prepareSubmission, type CommunityAsset, type Draft, type PublishedVersion } from "../lib/communityPublication";

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

it("starts a new version from the exact model and requires its updated package", async () => {
  const asset: CommunityAsset = {
    id: "rin", title: "Rin (Chinese)", description: "A character package with reference clips.", originalAuthor: "Test publisher",
    publisherRole: "original_author", license: { id: "CC-BY-4.0" }, coverUrl: "https://example.test/cover.webp",
    metadata: { family: "gpt-sovits", familyVersion: "v5turbo", series: "Blue Archive", group: "General Affairs Department",
      groupI18n: { "zh-CN": "总务部" }, language: "zh" },
  };
  const oldHash = "a".repeat(64);
  const path = "characters/zh/rin-voice.zip";
  const repository = "https://modelscope.cn/models/example/characters";
  const current: PublishedVersion = {
    id: "rin-public-v1", label: "v1", createdAt: "2026-11-10T10:00:00Z", metadata: { familyVersion: "v5turbo" },
    files: [{ id: "rin-package", path: "rin-voice.zip", role: "package", sizeBytes: 24, sha256: oldHash,
      sources: [{ canonicalUrl: repository, revision: "fixed-revision-for-v1", upstreamPath: path }] }],
  };
  const { files: [pack], ...version } = current;
  invoke.mockImplementation(async (name: string, input?: { request?: { action: string } }) => {
    if (name === "community_links") return { enabled: true, accountUrl };
    if (name === "community_account_status") return signedIn;
    if (input?.request?.action === "owned") return { items: [{ ...asset, compatibleVersion: { ...version, package: pack } }] };
    if (input?.request?.action === "version") return { asset, version: current };
    if (input?.request?.action === "resolve") return {
      resolveId: "fixed", canonicalUrl: repository, revision: "new-revision", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      files: [
        { id: "rin-zip", path, sizeBytes: 24, providerDigest: { algorithm: "sha256", value: oldHash } },
        { id: "new-rin-zip", path: "characters/zh/rin-voice-v2.zip", sizeBytes: 26,
          providerDigest: { algorithm: "sha256", value: "b".repeat(64) } },
      ],
    };
    return {};
  });
  await act(async () => root.render(<I18nProvider><NoticeProvider><PlazaPage feed={feed} /></NoticeProvider></I18nProvider>));
  await act(async () => button("Test publisher").click());
  await act(async () => button("My models", document.body).click());
  const owner = host.querySelector<HTMLElement>('[data-trm-pane="owned"]')!;
  await act(async () => owner.querySelector<HTMLButtonElement>('button[aria-label="More"]')!.click());
  await act(async () => button("New version", document.body).click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 480)); });
  expect(invoke).toHaveBeenCalledWith("community_publication", { request: { action: "version", id: asset.id, versionId: current.id } });
  const editor = host.querySelector<HTMLElement>('[data-trm-pane="publish"]')!;
  expect(editor.textContent).toContain("Current version v1");
  expect(editor.textContent).toContain(path);
  expect(editor.textContent).toContain("fixed-revision-for-v1");
  expect(editor.querySelector<HTMLInputElement>('input[aria-label="Source link"]')?.value).toBe(repository);
  await act(async () => button("Read source", editor).click());
  const row = [...editor.querySelectorAll("label")].find((label) => label.textContent?.includes(path));
  expect(row).toBeDefined();
  const radio = row!.querySelector("input")!;
  expect(radio.checked).toBe(false);
  await act(async () => radio.click());
  expect(button("Next", editor).disabled).toBe(true);
  expect(editor.textContent).toContain("This ZIP is already used by the current version.");

  const draft = newVersionDraft(asset, current)!;
  const prepared = await prepareSubmission({
    ...draft,
    selection: {
      account: signedIn.email, resolveId: "new-source", revision: "new-revision", canonicalUrl: repository,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      file: { id: "new-rin", path: "rin-new.zip", sizeBytes: 26, providerDigest: { algorithm: "sha256", value: "b".repeat(64) } },
    },
  }, signedIn.email);
  expect(prepared.body.operation).toBe("new_version");
  expect(prepared.body.assetId).toBe(asset.id);
  expect(prepared.body.asset.metadata.groupI18n).toEqual({ "zh-CN": "总务部" });
  expect(prepared.body.asset.metadata.language).toBe("zh");
  expect(prepared.body.version.label).toBe("v2");
  expect(prepared.body.version.files[0].sha256).toBeUndefined();

  const listing = editListingDraft(asset, current)!;
  const metadata = await prepareSubmission({ ...listing, description: "Updated description" }, signedIn.email);
  expect(metadata.body).toMatchObject({
    operation: "metadata", assetId: asset.id, versionId: current.id,
    asset: { description: "Updated description", upstreamUrl: repository },
  });
  expect(metadata.body.version.files).toEqual([]);
});
