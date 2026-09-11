import { notifications } from "@mantine/notifications";
import { copyToClipboard } from "./clipboard";
import type { Artifact, SavedQuery } from "../types";
import { BASE_PATH } from "./base-path";

/**
 * Share links are absolute so they survive being pasted into chat or a ticket,
 * which means building them from the origin — and the origin alone drops the
 * sub-path. `origin + BASE_PATH` is the app's real root in both deployments.
 */
const APP_ORIGIN = () => `${window.location.origin}${BASE_PATH}`;

/**
 * Copy a saved query's share link (`/saved-queries/:id`) to the clipboard,
 * warning when the query is private and the link won't open for others.
 */
export function copySavedQueryShareLink(query: SavedQuery) {
  copyToClipboard(
    `${APP_ORIGIN()}/saved-queries/${query.id}`,
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
    `${APP_ORIGIN()}/artifacts/${artifact.id}`,
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
