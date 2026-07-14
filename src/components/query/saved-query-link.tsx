import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import type { SavedQuery } from "../../types";

/**
 * Deep-link target for shared saved queries (`/saved-queries/:id`), the
 * counterpart of `/write-requests/:id` share links. Fetches the query, opens
 * it in a fresh editor tab, and lands on the query workspace.
 */
export function SavedQueryLink() {
  const { id } = useParams();
  const navigate = useNavigate();
  const opened = useRef(false);

  useEffect(() => {
    if (!id || opened.current) return;
    opened.current = true;

    api
      .getSavedQuery(id)
      .then((query: SavedQuery) => {
        const { addTab, updateTab, user } = useStore.getState();
        addTab(query.connectionId);
        const tabId = useStore.getState().activeTabId;
        updateTab(tabId, {
          sql: query.sql,
          title: query.name,
          connectionId:
            query.connectionId || useStore.getState().activeConnectionId,
        });
        const byOther = user?.email !== query.createdByEmail;
        notifications.show({
          message: byOther
            ? `Opened "${query.name}" — shared by ${query.createdByEmail}`
            : `Opened "${query.name}"`,
          color: "green",
        });
        navigate("/", { replace: true });
      })
      .catch(() => {
        notifications.show({
          message:
            "This query link is invalid, was deleted, or isn't shared with you",
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
        Opening shared query…
      </Text>
    </div>
  );
}
