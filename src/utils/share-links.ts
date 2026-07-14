import { notifications } from "@mantine/notifications";
import { copyToClipboard } from "./clipboard";
import type { SavedQuery } from "../types";

/**
 * Copy a saved query's share link (`/saved-queries/:id`) to the clipboard,
 * warning when the query is private and the link won't open for others.
 */
export function copySavedQueryShareLink(query: SavedQuery) {
  copyToClipboard(
    `${window.location.origin}/saved-queries/${query.id}`,
    "share link",
  );
  if (!query.isShared) {
    notifications.show({
      message:
        "This query is private — only you can open the link. Make it shared for others to open it.",
      color: "yellow",
    });
  }
}
