import { notifications } from "@mantine/notifications";
import { IconCopy } from "@tabler/icons-react";

/**
 * Copy `text` to the clipboard and show a success notification.
 *
 * Uses the async Clipboard API when available and falls back to a hidden
 * textarea + `document.execCommand("copy")` for insecure (http LAN) contexts
 * where `navigator.clipboard` is unavailable. Pairs with the fallback wired up
 * in `clipboard-polyfill.ts`.
 */
export function copyToClipboard(text: string, label: string) {
  const showSuccess = () => {
    const display = text.length > 60 ? text.slice(0, 60) + "…" : text;
    notifications.show({
      message: `Copied ${label}: ${display}`,
      color: "teal",
      icon: <IconCopy size={16} />,
      autoClose: 2000,
    });
  };

  const fallback = () => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    showSuccess();
  };

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(showSuccess).catch(fallback);
  } else {
    fallback();
  }
}
