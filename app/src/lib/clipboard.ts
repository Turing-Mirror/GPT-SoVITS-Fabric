/** Call from an explicit click. HTTP LAN pages don't expose navigator.clipboard. */
export async function copyText(text: string): Promise<boolean> {
  if (!text.trim()) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // A browser may deny the async API even when it exposes it.
  }
  if (typeof document.execCommand !== "function") return false;
  const active = document.activeElement;
  const box = document.createElement("textarea");
  box.value = text;
  box.readOnly = true;
  box.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;font-size:16px";
  document.body.append(box);
  try {
    box.focus({ preventScroll: true });
    box.select();
    box.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    box.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
  }
}
