/**
 * Clipboard fallback for insecure contexts.
 *
 * The native `navigator.clipboard` API only exists in a secure context
 * (https:// or localhost). Because the dev/preview server is exposed on the
 * LAN (`host: true` in vite.config), users often open the app via a plain
 * `http://<ip>:<port>` URL where `navigator.clipboard` is `undefined`. Any
 * code that calls `navigator.clipboard.writeText(...)` — including the
 * "Copy JSON" / "Copy Text" buttons in the JSON tree viewer
 * (react-obj-view) — then throws and shows an ERROR state.
 *
 * This installs a `writeText` implementation backed by the legacy
 * `document.execCommand("copy")` approach whenever the native API is missing,
 * so copy works regardless of context. When the native API is available it is
 * left untouched.
 */
function legacyWriteText(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      // Keep it out of view and out of layout flow, but focusable/selectable.
      textarea.style.position = "fixed";
      textarea.style.top = "0";
      textarea.style.left = "0";
      textarea.style.width = "1px";
      textarea.style.height = "1px";
      textarea.style.padding = "0";
      textarea.style.border = "none";
      textarea.style.outline = "none";
      textarea.style.boxShadow = "none";
      textarea.style.background = "transparent";
      textarea.setAttribute("readonly", "");

      document.body.appendChild(textarea);
      const selection = document.getSelection();
      const previousRange =
        selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

      textarea.select();
      textarea.setSelectionRange(0, text.length);

      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);

      // Restore any prior selection so we don't disrupt the user.
      if (previousRange && selection) {
        selection.removeAllRanges();
        selection.addRange(previousRange);
      }

      if (ok) resolve();
      else reject(new Error("Copy command was unsuccessful"));
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function installClipboardFallback(): void {
  if (typeof navigator === "undefined" || typeof document === "undefined") return;

  const nav = navigator as Navigator & {
    clipboard?: { writeText?: (text: string) => Promise<void> };
  };

  // Native, secure-context clipboard already present — leave it alone.
  if (nav.clipboard && typeof nav.clipboard.writeText === "function") return;

  const clipboard = nav.clipboard ?? ({} as { writeText?: (text: string) => Promise<void> });
  clipboard.writeText = legacyWriteText;

  try {
    // `navigator.clipboard` is read-only in some browsers; define it when possible.
    if (!nav.clipboard) {
      Object.defineProperty(nav, "clipboard", {
        value: clipboard,
        configurable: true,
      });
    }
  } catch {
    // If we can't attach the object, there's nothing more we can do here.
  }
}
