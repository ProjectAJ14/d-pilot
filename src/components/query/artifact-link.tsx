import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import type { Artifact } from "../../types";

/**
 * Deep-link target for shared artifacts (`/artifacts/:id`) — the counterpart of
 * `SavedQueryLink`. Opens the document as a tab and lands on the workspace, so
 * a link pasted in chat behaves like everything else that opens in a tab.
 */
export function ArtifactLink() {
  const { id } = useParams();
  const navigate = useNavigate();
  const opened = useRef(false);

  useEffect(() => {
    if (!id || opened.current) return;
    opened.current = true;

    api
      .getArtifact(id)
      .then((artifact: Artifact) => {
        const { openArtifactTab, user } = useStore.getState();
        openArtifactTab(artifact);
        const byOther = user?.email !== artifact.createdByEmail;
        notifications.show({
          message: byOther
            ? `Opened "${artifact.title}" — shared by ${artifact.createdByEmail}`
            : `Opened "${artifact.title}"`,
          color: "green",
        });
        navigate("/", { replace: true });
      })
      .catch(() => {
        notifications.show({
          message:
            "This artifact link is invalid, was deleted, or isn't shared with you",
          color: "red",
        });
        navigate("/", { replace: true });
      });
  }, [id]);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        background: "var(--bg)",
      }}
    >
      <Loader size="sm" />
      <Text size="sm" c="dimmed">
        Opening artifact…
      </Text>
    </div>
  );
}
