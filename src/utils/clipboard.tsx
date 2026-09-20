import { notifications } from "@mantine/notifications";
import { IconCopy, IconClipboardOff } from "@tabler/icons-react";

/**
 * One id for every copy toast.
 *
 * Copying is a burst action — you grab three or four values in a row — and
 * without this each one stacked another near-identical toast in the corner, so
 * the confirmation for the value you just copied was indistinguishable from the
 * four behind it. Reusing the id means there is only ever one, showing the most
 * recent copy, with its timer reset.
 */
const COPY_TOAST = "clipboard-copy";

/**
 * Copy `text` to the clipboard and confirm it.
 *
 * Uses the async Clipboard API when available and falls back to a hidden
 * textarea + `document.execCommand("copy")` for insecure (http LAN) contexts
 * where `navigator.clipboard` is unavailable. Pairs with the fallback wired up
 * in `clipboard-polyfill.ts`.
 *
 * Both paths report what actually happened. This used to announce success
 * unconditionally: `execCommand` returns a boolean that was ignored, and
 * `navigator.clipboard.writeText` rejects when the document is not focused —
 * which it often is not a moment after alt-tabbing back to the app. So a copy
 * could leave the previous clipboard contents in place while the toast said it
 * had worked, and the next paste produced the wrong value. A copy tool that
 * lies about copying is worse than one that fails loudly.
 */
export function copyToClipboard(text: string, label: string) {
  const report = (ok: boolean) => {
    // Replace any toast still on screen rather than queueing behind it.
    notifications.hide(COPY_TOAST);
    if (ok) {
      const display = text.length > 60 ? text.slice(0, 60) + "…" : text;
      notifications.show({
        id: COPY_TOAST,
        message: `Copied ${label}: ${display}`,
        color: "teal",
        icon: <IconCopy size={16} />,
      });
    } else {
      notifications.show({
        id: COPY_TOAST,
        title: "Nothing was copied",
        message:
          "The browser refused the clipboard write. Click the page and try again.",
        color: "red",
        icon: <IconClipboardOff size={16} />,
      });
    }
  };

  /** Returns whether the copy actually landed. */
  const viaTextarea = (): boolean => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(textarea);
    return ok;
  };

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => report(true),
      // The async API rejects for reasons the sync one survives (an unfocused
      // document, a denied permission), so it is worth a second attempt before
      // giving up.
      () => report(viaTextarea()),
    );
  } else {
    report(viaTextarea());
  }
}
