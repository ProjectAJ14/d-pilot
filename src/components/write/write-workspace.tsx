import { useState, useEffect } from "react";
import { Text, Group, Alert } from "@mantine/core";
import { IconInfoCircle, IconPencilBolt } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "react-router-dom";
import { api } from "../../utils/api-client";
import type { ConnectionInfo } from "../../types";
import { WriteComposer } from "./write-composer";

export function WriteWorkspace() {
  const navigate = useNavigate();

  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [directEnvs, setDirectEnvs] = useState<string[]>([]);
  const [writeModeEnabled, setWriteModeEnabled] = useState(true);

  useEffect(() => {
    api
      .getWritableConnections()
      .then(setConnections)
      .catch((e) => notifications.show({ message: e.message, color: "red" }));
    api
      .getWritePolicy()
      .then((p) => {
        setDirectEnvs(p.directEnvs);
        setWriteModeEnabled(p.writeModeEnabled);
      })
      .catch(() => {});
  }, []);

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        overflow: "auto",
        background: "var(--bg)",
      }}
    >
      <div
        style={{ maxWidth: 940, margin: "0 auto", padding: "34px 24px 72px" }}
      >
        <Group gap={10} mb={6}>
          <IconPencilBolt size={22} color="var(--accent)" />
          <Text
            fw={700}
            size="xl"
            c="secondary.9"
            style={{ letterSpacing: "-0.02em" }}
          >
            Write &amp; Request
          </Text>
        </Group>
        <Text size="sm" c="dimmed" mb="lg" style={{ lineHeight: 1.55 }}>
          Draft the statement you want to run, then generate an editable verify
          SELECT so a reviewer can see exactly which rows it affects. On
          approval environments it is submitted for a second person to review;
          on direct environments it runs immediately. Track it under{" "}
          <Text component="span" fw={600} c="secondary.9">
            Requests
          </Text>
          .
        </Text>

        {connections.length === 0 && (
          <Alert color="gray" mb="md" icon={<IconInfoCircle size={16} />}>
            You do not have write access to any environment. Ask an
            administrator to grant write access.
          </Alert>
        )}

        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            padding: 26,
            boxShadow:
              "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -18px rgba(15,23,42,0.18)",
          }}
        >
          <WriteComposer
            mode="create"
            connections={connections}
            directEnvs={directEnvs}
            writeModeEnabled={writeModeEnabled}
            onSubmit={(p) =>
              api.createWriteRequest({
                title: p.title,
                description: p.description,
                connectionId: p.connectionId,
                selectSql: p.selectSql,
                writeSql: p.writeSql,
                noTransaction: p.noTransaction,
              })
            }
            onSubmitted={(wr) => navigate(`/write-requests/${wr.id}`)}
          />
        </div>
      </div>
    </div>
  );
}
