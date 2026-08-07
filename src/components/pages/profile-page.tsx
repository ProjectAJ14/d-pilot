import { useState } from "react";
import {
  Text,
  TextInput,
  PasswordInput,
  Button,
  Badge,
  Group,
  Switch,
  NavLink,
  CopyButton,
  ActionIcon,
  Tooltip,
  Progress,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconUser,
  IconLock,
  IconArrowLeft,
  IconAdjustments,
  IconCopy,
  IconCheck,
  IconShieldLock,
  IconPencilBolt,
  IconGitPullRequest,
  IconEye,
} from "@tabler/icons-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import { envColor } from "../../utils/environments";

/**
 * Profile is the only account area every user can reach — `/settings` is
 * admin-only (see App.tsx). Personal, per-browser preferences therefore live
 * here rather than in Settings, so non-admins can change them too.
 *
 * Same full-page shell as Settings: fixed left nav + independently scrolling
 * content pane.
 */
const PROFILE_SECTIONS = [
  {
    value: "profile",
    label: "Account",
    icon: IconUser,
    desc: "Your identity & access",
  },
  {
    value: "security",
    label: "Security",
    icon: IconLock,
    desc: "Password & sign-in",
  },
  {
    // Kept as "user-settings" so older /profile?tab=user-settings links still land here.
    value: "user-settings",
    label: "Preferences",
    icon: IconAdjustments,
    desc: "Editor options, saved on this browser",
  },
] as const;

export function ProfilePage() {
  const user = useStore((s) => s.user);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") || PROFILE_SECTIONS[0].value;
  const active =
    PROFILE_SECTIONS.find((s) => s.value === activeTab) || PROFILE_SECTIONS[0];

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
        display: "flex",
        flex: 1,
        height: "100%",
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      {/* ── Sidebar ── */}
      <aside
        style={{
          width: 264,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          background: "var(--surface)",
          display: "flex",
          flexDirection: "column",
          overflow: "auto",
        }}
      >
        <div style={{ padding: "18px 16px 10px" }}>
          <Button
            variant="subtle"
            color="gray"
            size="xs"
            leftSection={<IconArrowLeft size={14} />}
            onClick={() => navigate("/")}
            mb="md"
            px={8}
          >
            Back to queries
          </Button>
          <Group gap={10} px={8} mb={2} wrap="nowrap">
            <Avatar initials={initials} size={38} />
            <div style={{ minWidth: 0 }}>
              <Text fw={700} size="sm" c="secondary.9" truncate>
                {user?.name || user?.username}
              </Text>
              <Text size="xs" c="dimmed" truncate ff="monospace">
                {user?.email || user?.username}
              </Text>
            </div>
          </Group>
        </div>

        <div style={{ padding: "6px 10px 16px" }}>
          {PROFILE_SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <NavLink
                key={s.value}
                active={s.value === activeTab}
                label={s.label}
                description={s.desc}
                leftSection={<Icon size={18} />}
                onClick={() => setSearchParams({ tab: s.value })}
                variant="light"
                style={{ borderRadius: 8, marginBottom: 2 }}
              />
            );
          })}
        </div>
      </aside>

      {/* ── Content ── */}
      <main
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <div
            style={{ maxWidth: 820, margin: "0 auto", padding: "28px 32px" }}
          >
            <Text fw={700} size="xl" mb={2} c="secondary.9">
              {active.label}
            </Text>
            <Text size="sm" c="dimmed" mb="lg">
              {active.desc}
            </Text>

            {activeTab === "profile" && <AccountTab initials={initials} />}
            {activeTab === "security" && <SecurityTab />}
            {activeTab === "user-settings" && <PreferencesTab />}
          </div>
        </div>
      </main>
    </div>
  );
}

function Avatar({ initials, size }: { initials: string; size: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "linear-gradient(135deg, #1f9196, #0c2340)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size / 3,
        fontWeight: 700,
        color: "#fff",
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  );
}

function Card({
  icon,
  title,
  desc,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 24,
        marginBottom: 20,
      }}
    >
      <Group gap={8} mb={desc ? 2 : "md"}>
        {icon}
        <Text fw={600} size="sm" c="secondary.9">
          {title}
        </Text>
      </Group>
      {desc && (
        <Text size="xs" c="dimmed" mb="lg">
          {desc}
        </Text>
      )}
      {children}
    </div>
  );
}

/** Environment chips for one capability, or a muted "No access" note. */
function EnvRow({
  icon,
  label,
  envs,
  isAdmin,
}: {
  icon: React.ReactNode;
  label: string;
  envs: string[];
  isAdmin?: boolean;
}) {
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      gap="lg"
      py={10}
      style={{ borderTop: "1px solid var(--border)" }}
    >
      <Group gap={8} wrap="nowrap">
        {icon}
        <Text size="sm" c="secondary.9">
          {label}
        </Text>
      </Group>
      <Group gap={4} justify="flex-end" wrap="wrap">
        {isAdmin ? (
          <Badge size="sm" color="red" variant="light">
            ALL (ADMIN)
          </Badge>
        ) : envs.length ? (
          envs.map((e) => (
            <Badge key={e} size="sm" color={envColor(e)} variant="light">
              {e}
            </Badge>
          ))
        ) : (
          <Text size="xs" c="dimmed">
            No access
          </Text>
        )}
      </Group>
    </Group>
  );
}

function AccountTab({ initials }: { initials: string }) {
  const user = useStore((s) => s.user);
  const login = useStore((s) => s.login);
  const [displayName, setDisplayName] = useState(user?.name || "");
  const [saving, setSaving] = useState(false);
  const email = user?.email || user?.username || "";

  const handleUpdateProfile = async () => {
    if (!displayName.trim()) return;
    setSaving(true);
    try {
      const updated = await api.updateProfile({
        displayName: displayName.trim(),
      });
      if (user) {
        const token = localStorage.getItem("dbpilot_token")!;
        login(token, { ...user, name: updated.displayName });
      }
      notifications.show({ message: "Profile updated", color: "green" });
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* Identity banner */}
      <div
        style={{
          background:
            "linear-gradient(135deg, rgba(31,145,150,0.12), transparent 60%)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 24,
          marginBottom: 20,
        }}
      >
        <Group gap="lg" align="center" wrap="nowrap">
          <Avatar initials={initials} size={64} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Group gap="sm" mb={4}>
              <Text fw={700} size="lg" c="secondary.9">
                {user?.name}
              </Text>
              {user?.isAdmin && (
                <Badge size="sm" color="red" variant="light">
                  ADMIN
                </Badge>
              )}
            </Group>
            <Group gap={6} wrap="nowrap">
              <Text size="sm" c="dimmed" ff="monospace" truncate>
                {email}
              </Text>
              <CopyButton value={email}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? "Copied" : "Copy email"}>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="sm"
                      onClick={copy}
                    >
                      {copied ? (
                        <IconCheck size={14} />
                      ) : (
                        <IconCopy size={14} />
                      )}
                    </ActionIcon>
                  </Tooltip>
                )}
              </CopyButton>
            </Group>
          </div>
        </Group>
      </div>

      <Card
        icon={<IconShieldLock size={16} color="var(--accent)" />}
        title="Your access"
        desc="Granted per environment by an administrator. Read-only here."
      >
        <EnvRow
          icon={<IconEye size={15} color="var(--muted)" />}
          label="Read"
          envs={user?.allowedEnvironments || []}
          isAdmin={user?.isAdmin}
        />
        <EnvRow
          icon={<IconShieldLock size={15} color="var(--muted)" />}
          label="Unmask PHI"
          envs={user?.unmaskEnvironments || []}
          isAdmin={user?.isAdmin}
        />
        <EnvRow
          icon={<IconPencilBolt size={15} color="var(--muted)" />}
          label="Write"
          envs={user?.writeEnvironments || []}
          isAdmin={user?.isAdmin}
        />
        <EnvRow
          icon={<IconGitPullRequest size={15} color="var(--muted)" />}
          label="Approve"
          envs={user?.approveEnvironments || []}
          isAdmin={user?.isAdmin}
        />
      </Card>

      <Card
        icon={<IconUser size={16} color="var(--accent)" />}
        title="Display name"
        desc="How your name appears on queries, write requests and the audit log."
      >
        <TextInput
          value={displayName}
          onChange={(e) => setDisplayName(e.currentTarget.value)}
          placeholder="Your display name"
          mb="sm"
        />
        <TextInput
          label="Email"
          description="Managed by your administrator"
          value={email}
          disabled
          mb="md"
          styles={{ input: { opacity: 0.6 } }}
        />
        <Button
          size="sm"
          onClick={handleUpdateProfile}
          loading={saving}
          disabled={!displayName.trim() || displayName.trim() === user?.name}
        >
          Save changes
        </Button>
      </Card>
    </>
  );
}

/** Cheap strength meter — length + character-class variety, nothing clever. */
function scorePassword(pw: string): {
  value: number;
  label: string;
  color: string;
} {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) =>
    r.test(pw),
  ).length;
  const score = Math.min(100, pw.length * 6 + classes * 12);
  if (!pw) return { value: 0, label: "", color: "gray" };
  if (score < 45) return { value: score, label: "Weak", color: "red" };
  if (score < 75) return { value: score, label: "Fair", color: "yellow" };
  return { value: score, label: "Strong", color: "teal" };
}

function SecurityTab() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changing, setChanging] = useState(false);
  const strength = scorePassword(newPassword);

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

    setChanging(true);
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
      setChanging(false);
    }
  };

  return (
    <Card
      icon={<IconLock size={16} color="var(--accent)" />}
      title="Change password"
      desc="At least 8 characters. You stay signed in on this browser."
    >
      <PasswordInput
        label="Current password"
        placeholder="Enter current password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.currentTarget.value)}
        mb="sm"
      />

      <PasswordInput
        label="New password"
        placeholder="At least 8 characters"
        value={newPassword}
        onChange={(e) => setNewPassword(e.currentTarget.value)}
        mb={6}
      />
      {newPassword && (
        <Group gap={8} mb="sm" wrap="nowrap">
          <Progress
            value={strength.value}
            color={strength.color}
            size="sm"
            style={{ flex: 1 }}
          />
          <Text size="xs" c={strength.color} fw={600} w={44}>
            {strength.label}
          </Text>
        </Group>
      )}

      <PasswordInput
        label="Confirm new password"
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
        loading={changing}
        disabled={!currentPassword || !newPassword || !confirmPassword}
      >
        Update password
      </Button>
    </Card>
  );
}

function PreferencesTab() {
  const viModeEnabled = useStore((s) => s.viModeEnabled);
  const setViMode = useStore((s) => s.setViMode);

  return (
    <Card
      icon={<IconAdjustments size={16} color="var(--accent)" />}
      title="Editor"
      desc="Saved in this browser only — not on the server, and not shared with anyone else."
    >
      <Group justify="space-between" wrap="nowrap" gap="lg">
        <div>
          <Text fw={600} size="sm" c="secondary.9">
            Vim keybindings
          </Text>
          <Text size="xs" c="dimmed">
            Modal editing in every SQL editor — the query editor and both write
            composer editors. The cursor shows the mode: a solid block in normal
            mode, a thin bar in insert.
          </Text>
        </div>
        <Switch
          checked={viModeEnabled}
          onChange={(e) => setViMode(e.currentTarget.checked)}
          size="md"
          color="teal"
        />
      </Group>
    </Card>
  );
}
