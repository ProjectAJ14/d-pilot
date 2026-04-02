import { Menu, Badge, Group, Text, ActionIcon, Tooltip } from "@mantine/core";
import {
  IconDatabase,
  IconShieldLock,
  IconShieldOff,
  IconSettings,
  IconUser,
  IconLogout,
  IconKey,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "react-router-dom";
import { useStore } from "../../store";
import { PhiUnmaskModal } from "../phi/phi-unmask-modal";
import type { ConnectionInfo, DatabaseType, Environment } from "../../types";

const ENV_COLORS: Record<Environment, string> = {
  PROD: "red",
  STG: "orange",
  QA: "violet",
  DEV: "green",
};

const DB_LABELS: Record<DatabaseType, string> = {
  postgres: "PostgreSQL",
  mssql: "SQL Server",
  mongodb: "MongoDB",
  elasticsearch: "Elasticsearch",
};

const DB_ICONS: Record<DatabaseType, string> = {
  postgres: "🐘",
  mssql: "🗄️",
  mongodb: "🍃",
  elasticsearch: "🔍",
};

export function TopBar() {
  const connections = useStore((s) => s.connections);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const setActiveConnection = useStore((s) => s.setActiveConnection);
  const phiEnabled = useStore((s) => s.phiEnabled);
  const setPhi = useStore((s) => s.setPhi);
  const togglePhiPanel = useStore((s) => s.togglePhiPanel);
  const user = useStore((s) => s.user);
  const logout = useStore((s) => s.logout);

  const navigate = useNavigate();
  const { appName, logoUrl } = useStore((s) => s.config);
  const activeConn = connections.find((c) => c.id === activeConnectionId);
  const isProdOrStg = activeConn?.env === "PROD" || activeConn?.env === "STG";

  const handlePhiToggle = () => {
    if (!phiEnabled) {
      setPhi(true);
      notifications.show({ message: "PHI re-tokenized", color: "violet" });
      return;
    }

    if (!user?.isAdmin) {
      notifications.show({
        message: "Only ADMIN can de-tokenize PHI",
        color: "red",
      });
      return;
    }

    if (isProdOrStg) {
      PhiUnmaskModal.open();
    } else {
      setPhi(false);
      notifications.show({
        message: "PHI visible — access logged",
        color: "orange",
      });
    }
  };

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "U";

  return (
    <div
      style={{
        height: 70,
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        padding: "0 18px",
        gap: 12,
        flexShrink: 0,
        position: "relative",
        zIndex: 50,
      }}
    >
      {/* Logo */}
      <Group gap={10}>
        {logoUrl && (
          <>
            <img src={logoUrl} alt={appName} style={{ height: 32 }} />
            <div style={{ width: 1, height: 28, background: "var(--border)" }} />
          </>
        )}
        <Text fw={700} size="sm" c="var(--accent)">
          {appName}
        </Text>
      </Group>

      <div style={{ width: 1, height: 28, background: "var(--border)" }} />

      {/* Connection Picker */}
      <Menu shadow="lg" width={360}>
        <Menu.Target>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              background: "var(--surface2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "5px 10px",
              cursor: "pointer",
            }}
          >
            {activeConn ? (
              <>
                <Badge size="xs" color={ENV_COLORS[activeConn.env]} variant="light">
                  {activeConn.env}
                </Badge>
                <Text size="xs" fw={600}>{activeConn.name}</Text>
                <Badge size="xs" variant="light">{DB_LABELS[activeConn.type]}</Badge>
              </>
            ) : (
              <Text size="xs" c="dimmed">Select connection...</Text>
            )}
            <Text size="xs" c="dimmed">▾</Text>
          </div>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Environments & Connections</Menu.Label>
          {Object.entries(groupByEnv(connections)).map(([env, conns]) => (
            <div key={env}>
              <Menu.Label>
                <Badge size="xs" color={ENV_COLORS[env as Environment]} variant="light">
                  {env}
                </Badge>
              </Menu.Label>
              {conns.map((conn) => (
                <Menu.Item
                  key={conn.id}
                  leftSection={<span>{DB_ICONS[conn.type]}</span>}
                  onClick={() => setActiveConnection(conn.id)}
                  style={
                    conn.id === activeConnectionId
                      ? { background: "rgba(31,145,150,0.08)" }
                      : undefined
                  }
                  rightSection={
                    (conn.env === "PROD" || conn.env === "STG") ? (
                      <IconShieldLock size={12} color="var(--token)" />
                    ) : null
                  }
                >
                  <div>
                    <Text size="sm" fw={600}>{conn.name}</Text>
                    <Text size="xs" c="dimmed" ff="monospace">
                      {DB_LABELS[conn.type]} · {conn.host}:{conn.port}
                    </Text>
                  </div>
                </Menu.Item>
              ))}
            </div>
          ))}
        </Menu.Dropdown>
      </Menu>

      <div style={{ width: 1, height: 28, background: "var(--border)" }} />

      {/* PHI Shield */}
      <Tooltip
        label={
          phiEnabled
            ? "PHI fields are masked — click to unmask (admin only)"
            : "PHI fields are VISIBLE — click to re-enable masking"
        }
      >
        <div
          onClick={handlePhiToggle}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "6px 12px",
            borderRadius: 8,
            cursor: "pointer",
            border: `1px solid ${phiEnabled ? "rgba(31,145,150,0.4)" : "rgba(215,54,54,0.4)"}`,
            background: phiEnabled ? "rgba(31,145,150,0.1)" : "rgba(215,54,54,0.1)",
            color: phiEnabled ? "var(--token)" : "var(--error)",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: phiEnabled ? "var(--token)" : "var(--error)",
              boxShadow: `0 0 6px ${phiEnabled ? "var(--token)" : "var(--error)"}`,
              animation: !phiEnabled ? "pulsered 1.5s infinite" : undefined,
            }}
          />
          {phiEnabled ? (
            <><IconShieldLock size={14} /> PHI Tokenized</>
          ) : (
            <><IconShieldOff size={14} /> PHI Visible</>
          )}
        </div>
      </Tooltip>

      <div style={{ flex: 1 }} />

      {/* Token Config button */}
      <Tooltip label="Token Configuration">
        <button
          onClick={() => user?.isAdmin ? navigate("/settings?tab=phi") : togglePhiPanel()}
          style={{
            fontFamily: "Barlow, sans-serif",
            fontSize: 12,
            fontWeight: 600,
            padding: "6px 12px",
            borderRadius: 7,
            border: "1px solid var(--border2)",
            background: "var(--surface2)",
            color: "var(--muted2)",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          <IconKey size={12} style={{ marginRight: 4, verticalAlign: "middle" }} />
          Token Config
        </button>
      </Tooltip>

      {/* User Dropdown */}
      <Menu shadow="lg" width={210}>
        <Menu.Target>
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: "50%",
              background: "linear-gradient(135deg, #1f9196, #0c2340)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              fontWeight: 700,
              color: "#fff",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {initials}
          </div>
        </Menu.Target>
        <Menu.Dropdown>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
            <Text fw={600} size="sm">{user?.name || user?.username}</Text>
            <Badge
              size="xs"
              color={user?.isAdmin ? "red" : "blue"}
              variant="light"
              mt={5}
            >
              {user?.role?.toUpperCase()}
            </Badge>
          </div>
          <Menu.Item leftSection={<IconUser size={14} />} onClick={() => navigate("/profile")}>
            Profile
          </Menu.Item>
          {user?.isAdmin && (
            <Menu.Item leftSection={<IconSettings size={14} />} onClick={() => navigate("/settings")}>
              Settings
            </Menu.Item>
          )}
          <Menu.Item
            leftSection={<IconShieldLock size={14} />}
            onClick={() => user?.isAdmin ? navigate("/settings?tab=phi") : togglePhiPanel()}
          >
            Token Configuration
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item
            leftSection={<IconLogout size={14} />}
            color="red"
            onClick={logout}
          >
            Sign Out
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}

function groupByEnv(connections: ConnectionInfo[]): Record<string, ConnectionInfo[]> {
  const grouped: Record<string, ConnectionInfo[]> = {};
  for (const c of connections) {
    if (!grouped[c.env]) grouped[c.env] = [];
    grouped[c.env].push(c);
  }
  return grouped;
}
