import { notifications } from "@mantine/notifications";
import { copyToClipboard } from "./clipboard";
import type { Artifact, SavedQuery } from "../types";

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

/**
 * Copy an artifact's share link (`/artifacts/:id`), the counterpart of the
 * saved-query one. Same caveat: a private artifact's link opens for nobody else.
 */
export function copyArtifactShareLink(artifact: Artifact) {
  copyToClipboard(
    `${window.location.origin}/artifacts/${artifact.id}`,
    "share link",
  );
  if (!artifact.isShared) {
    notifications.show({
      message:
        "This artifact is private — only you can open the link. Make it shared for others to open it.",
      color: "yellow",
    });
  }
}
