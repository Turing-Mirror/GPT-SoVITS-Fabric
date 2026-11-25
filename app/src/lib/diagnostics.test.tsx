// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { diagnosticContent, DiagnosticFailure, errorWithTitle, readDiagnostic, unknownDiagnostic, withFeature } from "./diagnostics";
import { invoke, invokeFor } from "./invoke";
import { publicationError } from "./communityPublication";
import { ErrorNote } from "../components/ErrorNote";
import { t, setTLocale } from "../i18n/t";

const bridge = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge }));
afterEach(() => { bridge.mockReset(); });

it("keeps legacy technical strings out of the main text and copies their full detail", () => {
  setTLocale("zh-CN");
  const raw = "s1_train.py exited 1\nValueError: unknown\n详情见日志";
  const view = diagnosticContent(raw, "training");
  expect(view.title).toBe(t("diag.title.training"));
  expect(view.cause).toBe(t("diag.cause.unknown"));
  expect([view.title, view.cause, ...view.steps!].join(" ")).not.toMatch(/s1_train|ValueError|退出码|详情见日志/);
  expect(view.copy).toContain(raw);
  expect(view.copy).toContain(t("diag.step.copyAndCommunity"));
});

it("preserves a host error id and API business code across IPC rejection and String compatibility", async () => {
  const diagnostic = unknownDiagnostic("this request only", "synthesis");
  bridge.mockRejectedValue({ code: "canceled", diagnostic });
  const error = await invoke("synth_start").catch(error => error);
  expect(error).toBeInstanceOf(DiagnosticFailure);
  if (!(error instanceof DiagnosticFailure)) throw new Error("missing diagnostic");
  expect(error.code).toBe("canceled");
  expect(readDiagnostic(String(error))?.error_id).toBe(diagnostic.error_id);
});

it("uses the command feature for an unknown bridge failure without calling the broken bridge again", async () => {
  bridge.mockRejectedValue(new Error("IPC disconnected"));
  const error = await invoke("annot_generate").catch(error => error);
  if (!(error instanceof DiagnosticFailure)) throw new Error("missing diagnostic");
  expect(error.diagnostic.scope.feature).toBe("annotation");
  expect(error.diagnostic.code).toBe("diag.unknown");
  expect(bridge).toHaveBeenCalledTimes(1);
});

it("shows an action rejection in the same error area", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  const run = vi.fn().mockRejectedValue(new Error("navigation failed"));
  try {
    await act(async () => root.render(<ErrorNote text="original evidence" extraAction={{ label: "Action", run }} />));
    const before = host.querySelectorAll('[role="alert"]').length;
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(run).toHaveBeenCalledOnce();
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(before);
    expect(host.textContent).not.toContain("navigation failed");
    expect(host.textContent).toContain("未能完成此操作");
  } finally { act(() => root.unmount()); }
});

it("preserves specific localized titles and overrides misleading command-prefix features", async () => {
  setTLocale("zh-CN");
  const hostDiagnostic = {
    ...unknownDiagnostic("file locked", "training"),
    code: "diag.file_locked",
    cause: { key: "diag.cause.fileLocked", params: {} },
  };
  bridge.mockRejectedValueOnce({ diagnostic: hostDiagnostic });
  const err = await invokeFor("other", "train_cleanup_scan").catch(e => e);
  expect(err).toBeInstanceOf(DiagnosticFailure);
  const view = diagnosticContent(err, "other");
  expect(view.title).toBe(t("diag.title.other"));
  expect(view.title).not.toBe(t("diag.title.training"));
  expect(view.cause).toBe(t("diag.cause.fileLocked"));
  expect(view.copy).toContain(view.title);
  expect(view.copy).toContain(view.cause);
  expect(view.copy).toContain("file locked");

  const withSpecific = errorWithTitle(hostDiagnostic, "publication.packReadError", "importexport");
  const specificView = diagnosticContent(withSpecific, "importexport");
  expect(specificView.title).toBe(t("publication.packReadError"));
  expect(specificView.cause).toBe(t("diag.cause.fileLocked"));
  expect(specificView.copy).toContain(t("publication.packReadError"));
  expect(specificView.copy).toContain("file locked");

  const pubView = diagnosticContent(publicationError({ code: "hash_mismatch" }, "submit"), "store");
  expect(pubView.title).toBe(t("publication.hashMismatch"));

  const parameterized = diagnosticContent(errorWithTitle("C:/clips/sample.wav", "s.annot.playFailed", "annotation", { v0: "sample.wav" }), "annotation");
  expect(parameterized.title).toBe(t("s.annot.playFailed", { v0: "sample.wav" }));
  expect(parameterized.detail).toContain("C:/clips/sample.wav");

  const keptSpecific = withFeature(withSpecific, "other");
  expect(keptSpecific.title.key).toBe("publication.packReadError");
});

it("has no drift from the pinned eight diagnostic locale catalogs, including the boot fallback", () => {
  expect(() => execFileSync(process.execPath, ["../scripts/sync_diag_locales.mjs", "--check"])).not.toThrow();
});
