import type { ReactNode } from "react";
import { Menu, Badge, Group, Text, Tooltip } from "@mantine/core";
import {
  IconShieldLock,
  IconShieldOff,
  IconSettings,
  IconUser,
  IconLogout,
  IconSearch,
  IconPencilBolt,
  IconGitPullRequest,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useNavigate, useLocation } from "react-router-dom";
import { useStore } from "../../store";
import { PhiUnmaskModal } from "../phi/phi-unmask-modal";
import { ColorSchemeToggle } from "./color-scheme-toggle";

export function TopBar() {
  const connections = useStore((s) => s.connections);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const phiEnabled = useStore((s) => s.phiEnabled);
  const setPhi = useStore((s) => s.setPhi);
  const togglePhiPanel = useStore((s) => s.togglePhiPanel);
  const user = useStore((s) => s.user);
  const logout = useStore((s) => s.logout);

  const navigate = useNavigate();
  const location = useLocation();
  const actionRequiredCount = useStore((s) => s.actionRequiredCount);
  const { appName, logoUrl, phiMaskedEnvironments } = useStore((s) => s.config);
  const activeConn = connections.find((c) => c.id === activeConnectionId);
  const maskedEnvs = phiMaskedEnvironments;
  const isEnvMasked = activeConn ? maskedEnvs.includes(activeConn.env) : false;

  // PHI unmask is environment-scoped: allowed only where the active connection's
  // environment is in the user's unmask capability (admins hold all).
  const canUnmaskHere =
    !!user?.isAdmin ||
    (!!activeConn && (user?.unmaskEnvironments || []).includes(activeConn.env));

  const handlePhiToggle = () => {
    if (!phiEnabled) {
      setPhi(true);
      notifications.show({ message: "PHI re-tokenized", color: "violet" });
      return;
    }

    if (!canUnmaskHere) {
      notifications.show({
        message: activeConn
          ? `You cannot de-tokenize PHI in ${activeConn.env}`
          : "Select a connection first",
        color: "red",
      });
      return;
    }

    if (isEnvMasked) {
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
      {/* Logo — click to go to the dashboard */}
      <Tooltip label="Go to dashboard">
        <button
          type="button"
          className="dp-btn"
          onClick={() => navigate("/")}
          aria-label="Go to dashboard"
          style={{ display: "flex", alignItems: "center", gap: 10 }}
        >
          {logoUrl && (
            <>
              <img src={logoUrl} alt={appName} style={{ height: 32 }} />
              <div
                style={{ width: 1, height: 28, background: "var(--border)" }}
              />
            </>
          )}
          <Text fw={700} size="sm" c="var(--accent-text)">
            {appName}
          </Text>
        </button>
      </Tooltip>

      <div style={{ width: 1, height: 28, background: "var(--border)" }} />

      {/* Workspace nav */}
      <div
        style={{
          display: "flex",
          gap: 2,
          background: "var(--surface2)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 3,
        }}
      >
        <NavTab
          icon={<IconSearch size={14} />}
          label="Read"
          active={location.pathname === "/"}
          onClick={() => navigate("/")}
        />
        {user?.canWrite && (
          <NavTab
            icon={<IconPencilBolt size={14} />}
            label="Write"
            active={location.pathname === "/write"}
            onClick={() => navigate("/write")}
          />
        )}
        {(user?.canWrite || user?.canApprove) && (
          <NavTab
            icon={<IconGitPullRequest size={14} />}
            label="Requests"
            badge={actionRequiredCount}
            active={location.pathname === "/requests"}
            onClick={() => navigate("/requests")}
          />
        )}
      </div>

      <div style={{ width: 1, height: 28, background: "var(--border)" }} />

      {/* PHI Shield */}
      <Tooltip
        label={
          phiEnabled
            ? "PHI fields are masked — click to unmask (admin only)"
            : "PHI fields are VISIBLE — click to re-enable masking"
        }
      >
        <button
          type="button"
          onClick={handlePhiToggle}
          aria-pressed={!phiEnabled}
          aria-label={
            phiEnabled ? "PHI tokenized — click to unmask" : "PHI visible — click to re-tokenize"
          }
          className="dp-btn dp-interactive"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "6px 12px",
            borderRadius: 8,
            cursor: "pointer",
            // color-mix keeps the tint derived from the token, so it tracks
            // the color scheme instead of freezing a light-mode rgba().
            border: `1px solid ${
              phiEnabled
                ? "color-mix(in srgb, var(--token) 40%, transparent)"
                : "color-mix(in srgb, var(--error) 40%, transparent)"
            }`,
            background: phiEnabled
              ? "color-mix(in srgb, var(--token) 12%, transparent)"
              : "color-mix(in srgb, var(--error) 12%, transparent)",
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
            <>
              <IconShieldLock size={14} /> PHI Tokenized
            </>
          ) : (
            <>
              <IconShieldOff size={14} /> PHI Visible
            </>
          )}
        </button>
      </Tooltip>

      <div style={{ flex: 1 }} />

      {/* Theme */}
      <ColorSchemeToggle />

      <div style={{ width: 1, height: 28, background: "var(--border)" }} />

      {/* User Dropdown */}
      <Menu shadow="lg" width={210}>
        <Menu.Target>
          <button
            type="button"
            className="dp-btn"
            aria-label={`Account menu for ${user?.name || user?.username || "user"}`}
            style={{
              width: 34,
              height: 34,
              borderRadius: "50%",
              // Brand mark: fixed teal->navy in BOTH schemes. Using --accent4 here
              // inverted the circle in dark mode (that token is near-white there),
              // which dragged the initials' color along with it.
              background: "linear-gradient(135deg, #1f9196, #0c2340)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              fontWeight: 700,
              color: "#fff",
              flexShrink: 0,
            }}
          >
            {initials}
          </button>
        </Menu.Target>
        <Menu.Dropdown>
          <div
            style={{
              padding: "14px 16px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <Text fw={600} size="sm">
              {user?.name || user?.username}
            </Text>
            <Group gap={4} mt={5}>
              {user?.isAdmin ? (
                <Badge size="xs" color="red" variant="light">
                  ADMIN
                </Badge>
              ) : (
                <>
                  {user?.canUnmaskPhi && (
                    <Badge size="xs" color="orange" variant="light">
                      PHI
                    </Badge>
                  )}
                  {user?.canWrite && (
                    <Badge size="xs" color="grape" variant="light">
                      WRITE
                    </Badge>
                  )}
                  {user?.canApprove && (
                    <Badge size="xs" color="teal" variant="light">
                      APPROVE
                    </Badge>
                  )}
                  {!user?.canUnmaskPhi &&
                    !user?.canWrite &&
                    !user?.canApprove && (
                      <Badge size="xs" color="blue" variant="light">
                        READ
                      </Badge>
                    )}
                </>
              )}
            </Group>
          </div>
          <Menu.Item
            leftSection={<IconUser size={14} />}
            onClick={() => navigate("/profile")}
          >
            Profile
          </Menu.Item>
          {/* Admins get Settings (the hub — PHI/token config, audit, etc. live
              there as tabs). Non-admins get the lighter token config panel. */}
          {user?.isAdmin ? (
            <Menu.Item
              leftSection={<IconSettings size={14} />}
              onClick={() => navigate("/settings")}
            >
              Settings
            </Menu.Item>
          ) : (
            <Menu.Item
              leftSection={<IconShieldLock size={14} />}
              onClick={togglePhiPanel}
            >
              Token Configuration
            </Menu.Item>
          )}
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

function NavTab({
  label,
  icon,
  active,
  badge,
  onClick,
}: {
  label: string;
  icon?: ReactNode;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={active ? "dp-btn" : "dp-btn dp-interactive"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontFamily: "Barlow, sans-serif",
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: 0.2,
        padding: "6px 12px",
        borderRadius: 6,
        background: active ? "var(--surface)" : "transparent",
        color: active ? "var(--accent-text)" : "var(--muted2)",
        boxShadow: active ? "var(--shadow-1)" : "none",
        whiteSpace: "nowrap",
      }}
    >
      {icon}
      {label}
      {badge != null && badge > 0 && (
        <Badge
          size="xs"
          circle
          color="red"
          variant="filled"
          style={{ marginLeft: 2, minWidth: 16, height: 16, padding: 0 }}
        >
          {badge}
        </Badge>
      )}
    </button>
  );
}
