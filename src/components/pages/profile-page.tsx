import { useState } from "react";
import {
  Text,
  TextInput,
  PasswordInput,
  Button,
  Badge,
  Divider,
  Group,
  Switch,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconUser,
  IconLock,
  IconArrowLeft,
  IconAdjustments,
} from "@tabler/icons-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";

/**
 * Profile is the only account area every user can reach — `/settings` is
 * admin-only (see App.tsx). Personal, per-browser preferences therefore live
 * here rather than in Settings, so non-admins can change them too.
 */
const PROFILE_TABS = [
  { value: "profile", label: "Profile", icon: IconUser },
  { value: "user-settings", label: "User Settings", icon: IconAdjustments },
] as const;

export function ProfilePage() {
  const user = useStore((s) => s.user);
  const login = useStore((s) => s.login);
  const viModeEnabled = useStore((s) => s.viModeEnabled);
  const setViMode = useStore((s) => s.setViMode);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = PROFILE_TABS.some(
    (t) => t.value === searchParams.get("tab"),
  )
    ? searchParams.get("tab")!
    : PROFILE_TABS[0].value;

  const [displayName, setDisplayName] = useState(user?.name || "");
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "U";

  const handleUpdateProfile = async () => {
    if (!displayName.trim()) return;
    setSavingProfile(true);
    try {
      const updated = await api.updateProfile({
        displayName: displayName.trim(),
      });
      // Update local store with new name
      if (user) {
        const token = localStorage.getItem("dbpilot_token")!;
        login(token, { ...user, name: updated.displayName });
      }
      notifications.show({ message: "Profile updated", color: "green" });
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword) {
      notifications.show({
        message: "All password fields are required",
        color: "red",
      });
      return;
    }
    if (newPassword.length < 8) {
      notifications.show({
        message: "New password must be at least 8 characters",
        color: "red",
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      notifications.show({ message: "Passwords do not match", color: "red" });
      return;
    }

    setChangingPassword(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      notifications.show({
        message: "Password changed successfully",
        color: "green",
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <div
      style={{
        padding: "28px 32px",
        maxWidth: 640,
        margin: "0 auto",
        overflow: "auto",
        flex: 1,
      }}
    >
      {/* Back button */}
      <Button
        variant="subtle"
        color="gray"
        size="xs"
        leftSection={<IconArrowLeft size={14} />}
        onClick={() => navigate("/")}
        mb="lg"
      >
        Back to queries
      </Button>

      <Text fw={700} size="xl" mb="xs" c="secondary.9">
        {activeTab === "user-settings" ? "User Settings" : "Profile"}
      </Text>
      <Text size="sm" c="dimmed" mb="md">
        {activeTab === "user-settings"
          ? "Personal preferences, saved on this browser"
          : "Manage your account settings"}
      </Text>

      {/* Tab bar — matches the sidebar's section tabs. */}
      <div
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid var(--border)",
          marginBottom: 20,
        }}
      >
        {PROFILE_TABS.map((tab) => {
          const isActive = activeTab === tab.value;
          const Icon = tab.icon;
          return (
            <button
              key={tab.value}
              onClick={() => setSearchParams({ tab: tab.value })}
              style={{
                padding: "10px 14px",
                background: "none",
                border: "none",
                borderBottom: isActive
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
                marginBottom: -1,
                color: isActive ? "var(--accent4)" : "var(--muted)",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                fontFamily: "Barlow, sans-serif",
                transition: "color 150ms ease, border-color 150ms ease",
              }}
            >
              <Icon
                size={13}
                style={{
                  verticalAlign: "middle",
                  marginRight: 6,
                  marginTop: -2,
                }}
              />
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "user-settings" && (
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: 24,
          }}
        >
          <Group gap={8} mb={4}>
            <IconAdjustments size={16} color="var(--accent)" />
            <Text fw={600} size="sm" c="secondary.9">
              Editor
            </Text>
          </Group>
          <Text size="xs" c="dimmed" mb="lg">
            Saved in this browser only — not on the server, and not shared with
            anyone else.
          </Text>

          <Group justify="space-between" wrap="nowrap" gap="lg">
            <div>
              <Text fw={600} size="sm" c="secondary.9">
                Vim keybindings
              </Text>
              <Text size="xs" c="dimmed">
                Modal editing in every SQL editor — the query editor and both
                write composer editors. The cursor shows the mode: a solid block
                in normal mode, a thin bar in insert.
              </Text>
            </div>
            <Switch
              checked={viModeEnabled}
              onChange={(e) => setViMode(e.currentTarget.checked)}
              size="md"
              color="teal"
            />
          </Group>
        </div>
      )}

      {activeTab === "profile" && (
        <>
          {/* User info card */}
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 24,
              marginBottom: 20,
            }}
          >
            <Group gap="lg" align="flex-start">
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: "50%",
                  background: "linear-gradient(135deg, #1f9196, #0c2340)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 18,
                  fontWeight: 700,
                  color: "#fff",
                  flexShrink: 0,
                }}
              >
                {initials}
              </div>
              <div style={{ flex: 1 }}>
                <Group gap="sm" mb={4}>
                  <Text fw={700} size="lg" c="secondary.9">
                    {user?.name}
                  </Text>
                  {user?.isAdmin ? (
                    <Badge size="sm" color="red" variant="light">
                      ADMIN
                    </Badge>
                  ) : (
                    <>
                      {user?.canUnmaskPhi && (
                        <Badge size="sm" color="orange" variant="light">
                          PHI
                        </Badge>
                      )}
                      {user?.canWrite && (
                        <Badge size="sm" color="grape" variant="light">
                          WRITE
                        </Badge>
                      )}
                      {user?.canApprove && (
                        <Badge size="sm" color="teal" variant="light">
                          APPROVE
                        </Badge>
                      )}
                      {!user?.canUnmaskPhi &&
                        !user?.canWrite &&
                        !user?.canApprove && (
                          <Badge size="sm" color="blue" variant="light">
                            READ
                          </Badge>
                        )}
                    </>
                  )}
                </Group>
                <Text size="sm" c="dimmed" ff="monospace">
                  {user?.email || user?.username}
                </Text>
              </div>
            </Group>
          </div>

          {/* Update display name */}
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 24,
              marginBottom: 20,
            }}
          >
            <Group gap={8} mb="md">
              <IconUser size={16} color="var(--accent)" />
              <Text fw={600} size="sm" c="secondary.9">
                Display Name
              </Text>
            </Group>

            <TextInput
              value={displayName}
              onChange={(e) => setDisplayName(e.currentTarget.value)}
              placeholder="Your display name"
              mb="sm"
            />

            <TextInput
              label="Email"
              value={user?.email || user?.username || ""}
              disabled
              mb="sm"
              styles={{ input: { opacity: 0.6 } }}
            />

            <Button
              size="sm"
              onClick={handleUpdateProfile}
              loading={savingProfile}
              disabled={displayName.trim() === user?.name}
            >
              Save Changes
            </Button>
          </div>

          {/* Change password */}
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: 24,
            }}
          >
            <Group gap={8} mb="md">
              <IconLock size={16} color="var(--accent)" />
              <Text fw={600} size="sm" c="secondary.9">
                Change Password
              </Text>
            </Group>

            <PasswordInput
              label="Current Password"
              placeholder="Enter current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.currentTarget.value)}
              mb="sm"
            />

            <PasswordInput
              label="New Password"
              placeholder="At least 8 characters"
              value={newPassword}
              onChange={(e) => setNewPassword(e.currentTarget.value)}
              mb="sm"
            />

            <PasswordInput
              label="Confirm New Password"
              placeholder="Re-enter new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.currentTarget.value)}
              mb="md"
              error={
                confirmPassword && newPassword !== confirmPassword
                  ? "Passwords do not match"
                  : undefined
              }
            />

            <Button
              size="sm"
              onClick={handleChangePassword}
              loading={changingPassword}
              disabled={!currentPassword || !newPassword || !confirmPassword}
            >
              Update Password
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
