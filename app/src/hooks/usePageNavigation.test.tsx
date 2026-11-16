// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { usePageNavigation } from "./usePageNavigation";
import { registerLeaveGuard } from "../lib/navigationGuard";
it("cancels a pending departure when the user chooses the current page again", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"), root = createRoot(host);
  let navigation!: ReturnType<typeof usePageNavigation>;
  function Harness() { navigation = usePageNavigation("annot"); return <>{navigation[0]}</>; }
  await act(async () => root.render(<Harness />));
  let resolve!: (allowed: boolean) => void;
  const off = registerLeaveGuard(() => new Promise(r => { resolve = r; }));
  let pending!: Promise<boolean>;
  await act(async () => { pending = navigation[1]("models"); });
  await act(async () => { expect(await navigation[1]("annot")).toBe(true); });
  await act(async () => { resolve(true); expect(await pending).toBe(false); });
  expect(host.textContent).toBe("annot");
  off(); await act(async () => root.unmount());
});
