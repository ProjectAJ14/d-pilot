import { useState, useEffect, type ReactNode } from "react";
import {
  Text,
  Table,
  Badge,
  Button,
  Group,
  Modal,
  TextInput,
  Select,
  PasswordInput,
  ActionIcon,
  Tooltip,
  Switch,
  ScrollArea,
  MultiSelect,
  Collapse,
  Avatar,
  NavLink,
  SimpleGrid,
  Loader,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconUsers,
  IconShieldLock,
  IconPlus,
  IconEdit,
  IconTrash,
  IconArrowLeft,
  IconKey,
  IconCheck,
  IconFileText,
  IconAlertTriangle,
  IconRefresh,
  IconSparkles,
  IconX,
  IconRobot,
  IconCopy,
  IconChevronRight,
  IconSettings,
  IconChartBar,
  IconActivity,
  IconClock,
  IconDatabase,
  IconUserCheck,
  IconPencilBolt,
  IconBolt,
} from "@tabler/icons-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import type {
  User,
  PhiFieldRule,
  MaskingType,
  AiChatLogEntry,
} from "../../types";

// ── PHI Field Icons ──
const FIELD_ICONS: Record<string, string> = {
  "*firstName*": "👤",
  "*lastName*": "👤",
  "*middleName*": "👤",
  "*preferredName*": "👤",
  "*dateOfBirth*": "🎂",
  "*date_of_birth*": "🎂",
  "*dob*": "🎂",
  "*email*": "✉️",
  "*phone*": "📞",
  "*addressLine1*": "🏠",
  "*addressLine2*": "🏠",
  "*zipCode*": "🏠",
  "*memberId*": "💳",
  "*policyNumber*": "💳",
  "*ethnicity*": "🧬",
};

function getIcon(pattern: string): string {
  return FIELD_ICONS[pattern] || "🔐";
}

const SETTINGS_SECTIONS = [
  {
    value: "analytics",
    label: "Analytics",
    icon: IconChartBar,
    desc: "Usage, adoption & activity trends",
  },
  {
    value: "users",
    label: "User Management",
    icon: IconUsers,
    desc: "People, roles & environment access",
  },
  {
    value: "write",
    label: "Write Mode",
    icon: IconPencilBolt,
    desc: "Write feature toggle & per-environment policy",
  },
  {
    value: "phi",
    label: "PHI Tokenization",
    icon: IconShieldLock,
    desc: "Field masking & de-tokenization rules",
  },
  {
    value: "audit",
    label: "Audit Log",
    icon: IconFileText,
    desc: "Access & query history",
  },
  {
    value: "azure",
    label: "Azure OpenAI",
    icon: IconSparkles,
    desc: "AI provider connection",
  },
  {
    value: "ai-log",
    label: "AI Chat Log",
    icon: IconRobot,
    desc: "AI query generation history",
  },
] as const;

export function SettingsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") || SETTINGS_SECTIONS[0].value;
  const user = useStore((s) => s.user);
  const active =
    SETTINGS_SECTIONS.find((s) => s.value === activeTab) ||
    SETTINGS_SECTIONS[0];

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
          <Group gap={8} px={8} mb={2} wrap="nowrap">
            <IconSettings
              size={20}
              color="var(--mantine-color-primary-6, #1f9196)"
            />
            <Text fw={700} size="lg" c="secondary.9">
              Settings
            </Text>
          </Group>
          <Text size="xs" c="dimmed" px={8}>
            Admin &amp; configuration
          </Text>
        </div>

        <div style={{ padding: "6px 10px 16px" }}>
          {SETTINGS_SECTIONS.map((s) => {
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
            style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 32px" }}
          >
            <Text fw={700} size="xl" mb={2} c="secondary.9">
              {active.label}
            </Text>
            <Text size="sm" c="dimmed" mb="lg">
              {active.desc}
            </Text>

            {activeTab === "analytics" && <AnalyticsTab />}
            {activeTab === "users" && (
              <UserManagementTab currentUserId={user?.id || ""} />
            )}
            {activeTab === "write" && <WriteModeTab />}
            {activeTab === "phi" && <PhiManagementTab />}
            {activeTab === "audit" && <AuditLogTab />}
            {activeTab === "azure" && <AzureOpenAiTab />}
            {activeTab === "ai-log" && <AiChatLogTab />}
          </div>
        </div>
      </main>
    </div>
  );
}

// ═══════════════════════════════════════
// ── Analytics Tab ──
// ═══════════════════════════════════════

interface Analytics {
  generatedAt: string;
  totals: {
    totalUsers: number;
    activeUsers: number;
    neverLoggedIn: number;
    queriesToday: number;
    queries30d: number;
    queriesTotal: number;
    dauToday: number;
    wau: number;
    mau: number;
    phiUnmask30d: number;
    phiDenied30d: number;
    errors30d: number;
    exports30d: number;
    avgLatencyMs: number;
    totalRows30d: number;
    aiGenerations30d: number;
    aiSuccess30d: number;
    aiTokens30d: number;
    savedQueries: number;
  };
  capabilityDistribution: { capability: string; count: number }[];
  daily: {
    date: string;
    queries: number;
    activeUsers: number;
    aiQueries: number;
  }[];
  actionBreakdown: { action: string; count: number }[];
  topUsers: { email: string; queries: number; lastActive: string }[];
  byConnection: { connectionId: string; count: number }[];
}

function fmtNum(n: number): string {
  return (n ?? 0).toLocaleString();
}

function fmtDay(iso: string): string {
  // iso = YYYY-MM-DD (UTC). Render as "Jun 5"
  const [y, m, d] = iso.split("-").map(Number);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[(m || 1) - 1]} ${d}`;
}

function StatCard({
  label,
  value,
  sub,
  icon,
  accent = "primary",
}: {
  label: string;
  value: string;
  sub?: string;
  icon: ReactNode;
  accent?: string;
}) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Text
          size="xs"
          c="dimmed"
          fw={600}
          tt="uppercase"
          style={{ letterSpacing: 0.3 }}
        >
          {label}
        </Text>
        <div
          style={{
            color: `var(--mantine-color-${accent}-6)`,
            display: "flex",
            opacity: 0.85,
          }}
        >
          {icon}
        </div>
      </Group>
      <Text fw={700} style={{ fontSize: 28, lineHeight: 1.1 }} c="secondary.9">
        {value}
      </Text>
      {sub && (
        <Text size="xs" c="dimmed">
          {sub}
        </Text>
      )}
    </div>
  );
}

function BarChart({
  data,
  color,
  label,
}: {
  data: { date: string; value: number }[];
  color: string;
  label: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const peak = data.reduce(
    (a, b) => (b.value > a.value ? b : a),
    data[0] || { date: "", value: 0 },
  );
  return (
    <div>
      <Group justify="space-between" mb={10}>
        <Text size="sm" fw={600} c="secondary.9">
          {label}
        </Text>
        <Text size="xs" c="dimmed">
          peak {fmtNum(peak.value)} · {fmtDay(peak.date)}
        </Text>
      </Group>
      <div
        style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 120 }}
      >
        {data.map((d) => (
          <Tooltip
            key={d.date}
            label={`${fmtDay(d.date)}: ${fmtNum(d.value)}`}
            withArrow
            openDelay={0}
          >
            <div
              style={{
                flex: 1,
                height: "100%",
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
                cursor: "default",
              }}
            >
              <div
                style={{
                  height: `${(d.value / max) * 100}%`,
                  minHeight: d.value > 0 ? 3 : 0,
                  background: color,
                  borderRadius: "3px 3px 0 0",
                  transition: "height .2s",
                }}
              />
            </div>
          </Tooltip>
        ))}
      </div>
      <Group justify="space-between" mt={6}>
        <Text size="10px" c="dimmed">
          {data.length ? fmtDay(data[0].date) : ""}
        </Text>
        <Text size="10px" c="dimmed">
          {data.length ? fmtDay(data[Math.floor(data.length / 2)].date) : ""}
        </Text>
        <Text size="10px" c="dimmed">
          {data.length ? fmtDay(data[data.length - 1].date) : ""}
        </Text>
      </Group>
    </div>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 18,
      }}
    >
      {children}
    </div>
  );
}

function AnalyticsTab() {
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const d = await api.getAnalytics();
      setData(d);
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading || !data) {
    return (
      <Group justify="center" py={80}>
        <Loader size="sm" />
        <Text size="sm" c="dimmed">
          Crunching usage data…
        </Text>
      </Group>
    );
  }

  const t = data.totals;
  const aiSuccessRate =
    t.aiGenerations30d > 0
      ? Math.round((t.aiSuccess30d / t.aiGenerations30d) * 100)
      : 0;
  const errorRate =
    t.queries30d + t.errors30d > 0
      ? Math.round((t.errors30d / (t.queries30d + t.errors30d)) * 100)
      : 0;
  const maxAction = Math.max(1, ...data.actionBreakdown.map((a) => a.count));
  const maxTopUser = Math.max(1, ...data.topUsers.map((u) => u.queries));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          Derived from users, audit log & AI logs · windows noted per metric
        </Text>
        <Button
          size="xs"
          variant="subtle"
          leftSection={<IconRefresh size={14} />}
          onClick={load}
        >
          Refresh
        </Button>
      </Group>

      {/* KPI cards */}
      <SimpleGrid cols={{ base: 1, xs: 2, sm: 3, md: 4 }} spacing="md">
        <StatCard
          label="Total users"
          value={fmtNum(t.totalUsers)}
          sub={`${fmtNum(t.activeUsers)} active in 30d`}
          icon={<IconUsers size={20} />}
          accent="primary"
        />
        <StatCard
          label="Active today"
          value={fmtNum(t.dauToday)}
          sub={`${fmtNum(t.wau)} this week · ${fmtNum(t.mau)} this month`}
          icon={<IconUserCheck size={20} />}
          accent="teal"
        />
        <StatCard
          label="Queries today"
          value={fmtNum(t.queriesToday)}
          sub={`${fmtNum(t.queries30d)} in 30d · ${fmtNum(t.queriesTotal)} all-time`}
          icon={<IconDatabase size={20} />}
          accent="blue"
        />
        <StatCard
          label="Avg query time"
          value={`${fmtNum(t.avgLatencyMs)} ms`}
          sub={`${fmtNum(t.totalRows30d)} rows returned (30d)`}
          icon={<IconClock size={20} />}
          accent="grape"
        />
        <StatCard
          label="AI generations"
          value={fmtNum(t.aiGenerations30d)}
          sub={`${aiSuccessRate}% success · ${fmtNum(t.aiTokens30d)} tokens (30d)`}
          icon={<IconSparkles size={20} />}
          accent="violet"
        />
        <StatCard
          label="PHI unmasks"
          value={fmtNum(t.phiUnmask30d)}
          sub={`${fmtNum(t.phiDenied30d)} denied (30d)`}
          icon={<IconShieldLock size={20} />}
          accent="orange"
        />
        <StatCard
          label="Query errors"
          value={fmtNum(t.errors30d)}
          sub={`${errorRate}% error rate (30d)`}
          icon={<IconActivity size={20} />}
          accent="red"
        />
        <StatCard
          label="Saved queries"
          value={fmtNum(t.savedQueries)}
          sub={`${fmtNum(t.neverLoggedIn)} users never logged in`}
          icon={<IconFileText size={20} />}
          accent="cyan"
        />
      </SimpleGrid>

      {/* Daily trend charts */}
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Panel>
          <BarChart
            label="Queries per day (30d)"
            color="var(--mantine-color-blue-5)"
            data={data.daily.map((d) => ({ date: d.date, value: d.queries }))}
          />
        </Panel>
        <Panel>
          <BarChart
            label="Daily active users (30d)"
            color="var(--mantine-color-teal-5)"
            data={data.daily.map((d) => ({
              date: d.date,
              value: d.activeUsers,
            }))}
          />
        </Panel>
        <Panel>
          <BarChart
            label="AI generations per day (30d)"
            color="var(--mantine-color-violet-5)"
            data={data.daily.map((d) => ({ date: d.date, value: d.aiQueries }))}
          />
        </Panel>

        {/* Activity breakdown */}
        <Panel>
          <Text size="sm" fw={600} c="secondary.9" mb={12}>
            Activity breakdown (30d)
          </Text>
          {data.actionBreakdown.length === 0 && (
            <Text size="xs" c="dimmed">
              No activity yet
            </Text>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {data.actionBreakdown.map((a) => (
              <div key={a.action}>
                <Group justify="space-between" mb={3}>
                  <Badge
                    size="sm"
                    radius="sm"
                    variant="light"
                    color={ACTION_COLORS[a.action] || "gray"}
                    style={{ overflow: "visible" }}
                  >
                    {ACTION_LABELS[a.action] || a.action}
                  </Badge>
                  <Text size="xs" fw={600} c="secondary.9">
                    {fmtNum(a.count)}
                  </Text>
                </Group>
                <div
                  style={{
                    height: 6,
                    background: "var(--mantine-color-gray-2)",
                    borderRadius: 4,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${(a.count / maxAction) * 100}%`,
                      background: `var(--mantine-color-${ACTION_COLORS[a.action] || "gray"}-5)`,
                      borderRadius: 4,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </SimpleGrid>

      {/* Top users + role distribution */}
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Panel>
          <Text size="sm" fw={600} c="secondary.9" mb={12}>
            Top users by queries (30d)
          </Text>
          {data.topUsers.length === 0 && (
            <Text size="xs" c="dimmed">
              No query activity yet
            </Text>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {data.topUsers.map((u) => (
              <Group key={u.email} gap="sm" wrap="nowrap">
                <Avatar size={30} radius="xl" color="primary" variant="light">
                  {getInitials(u.email)}
                </Avatar>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Group justify="space-between" mb={3} wrap="nowrap">
                    <Text size="xs" fw={600} truncate>
                      {u.email}
                    </Text>
                    <Text size="xs" fw={700} c="secondary.9">
                      {fmtNum(u.queries)}
                    </Text>
                  </Group>
                  <div
                    style={{
                      height: 5,
                      background: "var(--mantine-color-gray-2)",
                      borderRadius: 4,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${(u.queries / maxTopUser) * 100}%`,
                        background: "var(--mantine-color-primary-5)",
                        borderRadius: 4,
                      }}
                    />
                  </div>
                </div>
              </Group>
            ))}
          </div>
        </Panel>

        <Panel>
          <Text size="sm" fw={600} c="secondary.9" mb={12}>
            Users by capability
          </Text>
          <Group gap="lg" mb="lg">
            {data.capabilityDistribution.map((r) => (
              <div key={r.capability}>
                <Text fw={700} style={{ fontSize: 24 }} c="secondary.9">
                  {fmtNum(r.count)}
                </Text>
                <Badge
                  size="sm"
                  radius="sm"
                  variant="light"
                  color={CAP_META[r.capability]?.color || "gray"}
                  style={{ overflow: "visible" }}
                >
                  {CAP_META[r.capability]?.label || r.capability}
                </Badge>
              </div>
            ))}
          </Group>

          <Text size="sm" fw={600} c="secondary.9" mb={12}>
            Queries by connection (30d)
          </Text>
          {data.byConnection.length === 0 && (
            <Text size="xs" c="dimmed">
              No queries yet
            </Text>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {data.byConnection.map((c) => (
              <Group key={c.connectionId} justify="space-between" wrap="nowrap">
                <Text size="xs" ff="monospace" c="dimmed" truncate>
                  {c.connectionId}
                </Text>
                <Text size="xs" fw={600} c="secondary.9">
                  {fmtNum(c.count)}
                </Text>
              </Group>
            ))}
          </div>
        </Panel>
      </SimpleGrid>
    </div>
  );
}

// ═══════════════════════════════════════
// ── User Management Tab ──
// ═══════════════════════════════════════

function UserManagementTab({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const emailDomain = useStore((s) => s.config.emailDomain);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [deleteUser, setDeleteUser] = useState<User | null>(null);
  const [resetPwUser, setResetPwUser] = useState<User | null>(null);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const data = await api.getUsers();
      setUsers(data);
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  return (
    <>
      <Group justify="space-between" mb="md">
        <Text fw={600} size="sm" c="secondary.9">
          {users.length} user{users.length !== 1 ? "s" : ""}
        </Text>
        <Button
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={() => setAddModalOpen(true)}
        >
          Add User
        </Button>
      </Group>

      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <Table
          highlightOnHover
          verticalSpacing="sm"
          horizontalSpacing="lg"
          layout="fixed"
        >
          <Table.Thead
            style={{ background: "var(--surface-2, rgba(0,0,0,0.02))" }}
          >
            <Table.Tr>
              <Table.Th style={{ width: "26%" }}>User</Table.Th>
              <Table.Th>Capabilities</Table.Th>
              <Table.Th style={{ width: 110 }}>Last Login</Table.Th>
              <Table.Th style={{ width: 120, textAlign: "right" }}>
                Actions
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {users.map((u) => (
              <Table.Tr key={u.id}>
                <Table.Td>
                  <Group gap="sm" wrap="nowrap">
                    <Avatar
                      size={34}
                      radius="xl"
                      color={u.isAdmin ? "red" : "primary"}
                      variant="light"
                    >
                      {getInitials(u.displayName)}
                    </Avatar>
                    <div style={{ minWidth: 0 }}>
                      <Text fw={600} size="sm" truncate>
                        {u.displayName}
                        {u.id === currentUserId && (
                          <Text component="span" size="xs" c="dimmed" fw={400}>
                            {" "}
                            (you)
                          </Text>
                        )}
                      </Text>
                      <Text size="xs" ff="monospace" c="dimmed" truncate>
                        {u.email || u.username}
                      </Text>
                    </div>
                  </Group>
                </Table.Td>
                <Table.Td>
                  <UserCapabilities user={u} />
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {u.lastLogin
                      ? new Date(u.lastLogin).toLocaleDateString()
                      : "Never"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={2} justify="flex-end" wrap="nowrap">
                    <Tooltip label="Edit role">
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        onClick={() => setEditUser(u)}
                      >
                        <IconEdit size={15} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Reset password">
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        onClick={() => setResetPwUser(u)}
                      >
                        <IconKey size={15} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip
                      label={
                        u.id === currentUserId
                          ? "Cannot delete yourself"
                          : "Delete user"
                      }
                    >
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="sm"
                        disabled={u.id === currentUserId}
                        onClick={() => setDeleteUser(u)}
                      >
                        <IconTrash size={15} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
            {users.length === 0 && !loading && (
              <Table.Tr>
                <Table.Td colSpan={4}>
                  <Text ta="center" c="dimmed" py="lg">
                    No users found
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </div>

      {/* Add User Modal */}
      <AddUserModal
        opened={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onSuccess={loadUsers}
        emailDomain={emailDomain}
      />

      {/* Edit User Modal */}
      <EditUserModal
        user={editUser}
        onClose={() => setEditUser(null)}
        onSuccess={loadUsers}
      />

      {/* Delete Confirmation */}
      <DeleteUserModal
        user={deleteUser}
        onClose={() => setDeleteUser(null)}
        onSuccess={loadUsers}
      />

      {/* Reset Password Modal */}
      <ResetPasswordModal
        user={resetPwUser}
        onClose={() => setResetPwUser(null)}
      />
    </>
  );
}

const CAP_META: Record<string, { label: string; color: string }> = {
  admin: { label: "Admin", color: "red" },
  read: { label: "Read", color: "blue" },
  unmask_phi: { label: "Unmask PHI", color: "orange" },
  write: { label: "Write", color: "grape" },
  approve: { label: "Approve", color: "teal" },
};

/** Renders a user's capabilities as compact env-scoped badges. */
function UserCapabilities({ user }: { user: User }) {
  if (user.isAdmin) {
    return (
      <Badge
        size="sm"
        radius="sm"
        color="red"
        variant="filled"
        style={{ overflow: "visible" }}
      >
        Admin — full access
      </Badge>
    );
  }
  const rows: { key: string; envs: string[] }[] = [
    { key: "read", envs: user.allowedEnvironments || [] },
    { key: "unmask_phi", envs: user.unmaskEnvironments || [] },
    { key: "write", envs: user.writeEnvironments || [] },
    { key: "approve", envs: user.approveEnvironments || [] },
  ].filter((r) => r.envs.length > 0);

  if (rows.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        No access
      </Text>
    );
  }
  return (
    <Group gap={6}>
      {rows.map((r) => (
        <Badge
          key={r.key}
          size="sm"
          radius="sm"
          variant="light"
          color={CAP_META[r.key].color}
          style={{ overflow: "visible" }}
        >
          {CAP_META[r.key].label}: {r.envs.join(" · ")}
        </Badge>
      ))}
    </Group>
  );
}

function getInitials(name: string): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const ALL_ENVS_DATA = [
  { value: "DEV", label: "DEV" },
  { value: "QA", label: "QA" },
  { value: "UAT", label: "UAT" },
  { value: "STG", label: "STG" },
  { value: "PROD", label: "PROD" },
];

function AddUserModal({
  opened,
  onClose,
  onSuccess,
  emailDomain,
}: {
  opened: boolean;
  onClose: () => void;
  onSuccess: () => void;
  emailDomain: string | null;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [readEnvs, setReadEnvs] = useState<string[]>(["DEV", "QA"]);
  const [unmaskEnvs, setUnmaskEnvs] = useState<string[]>([]);
  const [writeEnvs, setWriteEnvs] = useState<string[]>([]);
  const [approveEnvs, setApproveEnvs] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (emailDomain) {
      if (!email.endsWith(`@${emailDomain}`)) {
        notifications.show({
          message: `Email must be a @${emailDomain} address`,
          color: "red",
        });
        return;
      }
    } else if (!email.includes("@")) {
      notifications.show({
        message: "A valid email address is required",
        color: "red",
      });
      return;
    }
    if (password.length < 8) {
      notifications.show({
        message: "Password must be at least 8 characters",
        color: "red",
      });
      return;
    }

    setSaving(true);
    try {
      await api.createUser({
        email,
        displayName: displayName || email.split("@")[0],
        password,
        isAdmin,
        allowedEnvironments: readEnvs,
        unmaskEnvironments: unmaskEnvs,
        writeEnvironments: writeEnvs,
        approveEnvironments: approveEnvs,
      });
      notifications.show({
        message: "User created successfully",
        color: "green",
      });
      onClose();
      onSuccess();
      setEmail("");
      setDisplayName("");
      setPassword("");
      setIsAdmin(false);
      setReadEnvs(["DEV", "QA"]);
      setUnmaskEnvs([]);
      setWriteEnvs([]);
      setApproveEnvs([]);
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Add User" size="md">
      <TextInput
        label="Email"
        placeholder={emailDomain ? `user@${emailDomain}` : "user@example.com"}
        value={email}
        onChange={(e) => setEmail(e.currentTarget.value)}
        mb="sm"
        description={
          emailDomain
            ? `Must be a @${emailDomain} address`
            : "Used as the login username"
        }
      />
      <TextInput
        label="Display Name"
        placeholder="Full name"
        value={displayName}
        onChange={(e) => setDisplayName(e.currentTarget.value)}
        mb="sm"
      />
      <CapabilityFields
        isAdmin={isAdmin}
        setIsAdmin={setIsAdmin}
        readEnvs={readEnvs}
        setReadEnvs={setReadEnvs}
        unmaskEnvs={unmaskEnvs}
        setUnmaskEnvs={setUnmaskEnvs}
        writeEnvs={writeEnvs}
        setWriteEnvs={setWriteEnvs}
        approveEnvs={approveEnvs}
        setApproveEnvs={setApproveEnvs}
      />
      <PasswordInput
        label="Temporary Password"
        placeholder="At least 8 characters"
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        mt="sm"
        mb="lg"
      />
      <Group justify="flex-end">
        <Button variant="subtle" color="gray" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          loading={saving}
          disabled={!email || !password}
        >
          Create User
        </Button>
      </Group>
    </Modal>
  );
}

/** Shared capability editor: Administrator toggle + four env-scoped multiselects. */
function CapabilityFields({
  isAdmin,
  setIsAdmin,
  readEnvs,
  setReadEnvs,
  unmaskEnvs,
  setUnmaskEnvs,
  writeEnvs,
  setWriteEnvs,
  approveEnvs,
  setApproveEnvs,
}: {
  isAdmin: boolean;
  setIsAdmin: (v: boolean) => void;
  readEnvs: string[];
  setReadEnvs: (v: string[]) => void;
  unmaskEnvs: string[];
  setUnmaskEnvs: (v: string[]) => void;
  writeEnvs: string[];
  setWriteEnvs: (v: string[]) => void;
  approveEnvs: string[];
  setApproveEnvs: (v: string[]) => void;
}) {
  return (
    <>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "10px 12px",
          marginBottom: isAdmin ? 4 : 10,
          background: "var(--surface-2, rgba(0,0,0,0.02))",
        }}
      >
        <Switch
          label="Administrator"
          description="Full access to everything on every environment — implies all capabilities below."
          checked={isAdmin}
          onChange={(e) => setIsAdmin(e.currentTarget.checked)}
          color="red"
        />
      </div>
      {!isAdmin && (
        <>
          <MultiSelect
            label="Read environments"
            description="Run read queries in these environments"
            data={ALL_ENVS_DATA}
            value={readEnvs}
            onChange={setReadEnvs}
            mb="sm"
          />
          <MultiSelect
            label="Unmask PHI environments"
            description="De-tokenize PHI in these environments (still needs a reason on masked envs)"
            data={ALL_ENVS_DATA}
            value={unmaskEnvs}
            onChange={setUnmaskEnvs}
            mb="sm"
          />
          <MultiSelect
            label="Write environments"
            description="Author write requests (direct-policy envs run immediately)"
            data={ALL_ENVS_DATA}
            value={writeEnvs}
            onChange={setWriteEnvs}
            mb="sm"
          />
          <MultiSelect
            label="Approve environments"
            description="Approve others' write requests"
            data={ALL_ENVS_DATA}
            value={approveEnvs}
            onChange={setApproveEnvs}
            mb="sm"
          />
        </>
      )}
    </>
  );
}

function EditUserModal({
  user,
  onClose,
  onSuccess,
}: {
  user: User | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const [isAdmin, setIsAdmin] = useState(user?.isAdmin || false);
  const [readEnvs, setReadEnvs] = useState<string[]>(
    user?.allowedEnvironments || ["DEV", "QA"],
  );
  const [unmaskEnvs, setUnmaskEnvs] = useState<string[]>(
    user?.unmaskEnvironments || [],
  );
  const [writeEnvs, setWriteEnvs] = useState<string[]>(
    user?.writeEnvironments || [],
  );
  const [approveEnvs, setApproveEnvs] = useState<string[]>(
    user?.approveEnvironments || [],
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName);
      setIsAdmin(user.isAdmin || false);
      setReadEnvs(user.allowedEnvironments || ["DEV", "QA"]);
      setUnmaskEnvs(user.unmaskEnvironments || []);
      setWriteEnvs(user.writeEnvironments || []);
      setApproveEnvs(user.approveEnvironments || []);
    }
  }, [user]);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await api.updateUser(user.id, {
        displayName,
        isAdmin,
        allowedEnvironments: readEnvs,
        unmaskEnvironments: unmaskEnvs,
        writeEnvironments: writeEnvs,
        approveEnvironments: approveEnvs,
      });
      notifications.show({ message: "User updated", color: "green" });
      onClose();
      onSuccess();
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened={!!user} onClose={onClose} title="Edit User" size="md">
      <TextInput
        label="Email"
        value={user?.email || user?.username || ""}
        disabled
        mb="sm"
        styles={{ input: { opacity: 0.6 } }}
      />
      <TextInput
        label="Display Name"
        value={displayName}
        onChange={(e) => setDisplayName(e.currentTarget.value)}
        mb="sm"
      />
      <CapabilityFields
        isAdmin={isAdmin}
        setIsAdmin={setIsAdmin}
        readEnvs={readEnvs}
        setReadEnvs={setReadEnvs}
        unmaskEnvs={unmaskEnvs}
        setUnmaskEnvs={setUnmaskEnvs}
        writeEnvs={writeEnvs}
        setWriteEnvs={setWriteEnvs}
        approveEnvs={approveEnvs}
        setApproveEnvs={setApproveEnvs}
      />
      <Group justify="flex-end" mt="md">
        <Button variant="subtle" color="gray" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleSave} loading={saving}>
          Save
        </Button>
      </Group>
    </Modal>
  );
}

function DeleteUserModal({
  user,
  onClose,
  onSuccess,
}: {
  user: User | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!user) return;
    setDeleting(true);
    try {
      await api.deleteUser(user.id);
      notifications.show({ message: "User deleted", color: "green" });
      onClose();
      onSuccess();
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal opened={!!user} onClose={onClose} title="Delete User" size="sm">
      <Text size="sm" mb="lg">
        Are you sure you want to delete <strong>{user?.displayName}</strong> (
        {user?.email})? This action cannot be undone.
      </Text>
      <Group justify="flex-end">
        <Button variant="subtle" color="gray" onClick={onClose}>
          Cancel
        </Button>
        <Button color="red" onClick={handleDelete} loading={deleting}>
          Delete User
        </Button>
      </Group>
    </Modal>
  );
}

function ResetPasswordModal({
  user,
  onClose,
}: {
  user: User | null;
  onClose: () => void;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const handleReset = async () => {
    if (!user || newPassword.length < 8) {
      notifications.show({
        message: "Password must be at least 8 characters",
        color: "red",
      });
      return;
    }
    setSaving(true);
    try {
      await api.resetUserPassword(user.id, newPassword);
      notifications.show({
        message: `Password reset for ${user.displayName}`,
        color: "green",
      });
      onClose();
      setNewPassword("");
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened={!!user} onClose={onClose} title="Reset Password" size="sm">
      <Text size="sm" mb="sm">
        Set a new password for <strong>{user?.displayName}</strong>
      </Text>
      <PasswordInput
        label="New Password"
        placeholder="At least 8 characters"
        value={newPassword}
        onChange={(e) => setNewPassword(e.currentTarget.value)}
        mb="lg"
      />
      <Group justify="flex-end">
        <Button variant="subtle" color="gray" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={handleReset}
          loading={saving}
          disabled={newPassword.length < 8}
        >
          Reset Password
        </Button>
      </Group>
    </Modal>
  );
}

// ═══════════════════════════════════════
// ── Write Mode Tab ──
// ═══════════════════════════════════════

function WriteModeTab() {
  const [enabled, setEnabled] = useState(true);
  const [directEnvs, setDirectEnvs] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const p = await api.getWritePolicy();
      setEnabled(p.writeModeEnabled);
      setDirectEnvs(p.directEnvs);
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const save = async (next: {
    writeModeEnabled?: boolean;
    directEnvs?: string[];
  }) => {
    setSaving(true);
    try {
      const p = await api.updateWritePolicy(next);
      setEnabled(p.writeModeEnabled);
      setDirectEnvs(p.directEnvs);
      notifications.show({ message: "Write policy updated", color: "green" });
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
      load();
    } finally {
      setSaving(false);
    }
  };

  const toggleDirect = (env: string) => {
    const next = directEnvs.includes(env)
      ? directEnvs.filter((e) => e !== env)
      : [...directEnvs, env];
    setDirectEnvs(next);
    save({ directEnvs: next });
  };

  const WRITE_ENVS = ["PROD", "STG", "UAT", "QA", "DEV"];

  if (loading) {
    return (
      <Group justify="center" py="xl">
        <Loader size="sm" />
      </Group>
    );
  }

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          background: "rgba(31,145,150,0.06)",
          border: "1px solid rgba(31,145,150,0.2)",
          borderRadius: 10,
          padding: 16,
          marginBottom: 20,
        }}
      >
        <div style={{ fontSize: 24, flexShrink: 0 }}>✍️</div>
        <div>
          <Text fw={700} size="sm" c="primary.8" mb={4}>
            Write Mode &amp; Approvals
          </Text>
          <Text size="xs" c="dimmed" style={{ lineHeight: 1.6 }}>
            Writes always run as a two-part request (a verify SELECT + a single
            DML statement) and are logged with who raised, who approved, and how
            many rows changed. On <strong>direct</strong> environments an
            authorized writer executes immediately; every other environment
            requires a second person to approve.
          </Text>
        </div>
      </div>

      <Group justify="space-between" mb="lg" style={{ maxWidth: 520 }}>
        <div>
          <Text fw={700} size="sm" c="secondary.9">
            Enable write mode
          </Text>
          <Text size="xs" c="dimmed">
            Master switch. When off, no write requests can be submitted or
            approved.
          </Text>
        </div>
        <Switch
          checked={enabled}
          onChange={(e) => save({ writeModeEnabled: e.currentTarget.checked })}
          disabled={saving}
          size="md"
          color="teal"
        />
      </Group>

      <Text fw={700} size="sm" c="secondary.9" mb="xs">
        Direct-write Environments
      </Text>
      <Text size="xs" c="dimmed" mb="sm">
        In these environments an authorized writer executes immediately (still
        logged). All other environments require approval by a second person.
      </Text>
      <Group gap={8} mb="lg">
        {WRITE_ENVS.map((env) => {
          const active = directEnvs.includes(env);
          return (
            <Button
              key={env}
              size="xs"
              variant={active ? "filled" : "outline"}
              color={active ? "green" : "gray"}
              onClick={() => toggleDirect(env)}
              loading={saving}
              leftSection={active ? <IconBolt size={12} /> : null}
              style={{ minWidth: 84 }}
            >
              {env}
            </Button>
          );
        })}
      </Group>
      <Text size="xs" c="dimmed">
        Grant users their <strong>Write</strong> and <strong>Approve</strong>{" "}
        environments individually in User Management.
      </Text>
    </>
  );
}

// ═══════════════════════════════════════
// ── PHI Management Tab ──
// ═══════════════════════════════════════

const ENV_OPTIONS = ["PROD", "STG", "UAT", "QA", "DEV"] as const;
const ENV_COLORS: Record<string, string> = {
  PROD: "red",
  STG: "orange",
  UAT: "teal",
  QA: "violet",
  DEV: "green",
};

function PhiManagementTab() {
  const [rules, setRules] = useState<PhiFieldRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [deleteRule, setDeleteRule] = useState<PhiFieldRule | null>(null);
  const [maskedEnvs, setMaskedEnvs] = useState<string[]>([]);
  const [envSaving, setEnvSaving] = useState(false);
  const setConfig = useStore((s) => s.setConfig);
  const config = useStore((s) => s.config);

  const loadRules = async () => {
    setLoading(true);
    try {
      const data = await api.getPhiRules();
      setRules(data);
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setLoading(false);
    }
  };

  const loadMaskedEnvs = async () => {
    try {
      const data = await api.getMaskedEnvironments();
      setMaskedEnvs(data.environments);
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    }
  };

  useEffect(() => {
    loadRules();
    loadMaskedEnvs();
  }, []);

  const toggleEnv = async (env: string) => {
    const next = maskedEnvs.includes(env)
      ? maskedEnvs.filter((e) => e !== env)
      : [...maskedEnvs, env];
    setMaskedEnvs(next);
    setEnvSaving(true);
    try {
      await api.updateMaskedEnvironments(next);
      setConfig({ ...config, phiMaskedEnvironments: next });
      notifications.show({
        message: "Masked environments updated",
        color: "green",
      });
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
      setMaskedEnvs(maskedEnvs); // revert
    } finally {
      setEnvSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteRule) return;
    try {
      await api.deletePhiRule(deleteRule.id);
      notifications.show({ message: "Rule deleted", color: "green" });
      setDeleteRule(null);
      loadRules();
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    }
  };

  return (
    <>
      {/* Strategy Banner */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          background: "rgba(31,145,150,0.06)",
          border: "1px solid rgba(31,145,150,0.2)",
          borderRadius: 10,
          padding: 16,
          marginBottom: 20,
        }}
      >
        <div style={{ fontSize: 24, flexShrink: 0 }}>🪙</div>
        <div>
          <Text fw={700} size="sm" c="primary.8" mb={4}>
            Tokenized Placeholder Strategy
          </Text>
          <Text size="xs" c="dimmed" style={{ lineHeight: 1.6 }}>
            Real PHI is replaced at query time with deterministic tokens. The
            same patient always gets the same token — enabling joins and
            analytics without exposing data.
          </Text>
        </div>
      </div>

      {/* Masked Environments */}
      <Text fw={700} size="sm" c="secondary.9" mb="xs">
        Masked Environments
      </Text>
      <Text size="xs" c="dimmed" mb="sm">
        PHI fields are tokenized for connections in these environments. Users
        with{" "}
        <Badge size="xs" color="orange" variant="light">
          PHI VIEWER
        </Badge>{" "}
        or{" "}
        <Badge size="xs" color="red" variant="light">
          ADMIN
        </Badge>{" "}
        role can request de-tokenization with a logged reason.
      </Text>
      <Group gap={8} mb="lg">
        {ENV_OPTIONS.map((env) => {
          const active = maskedEnvs.includes(env);
          return (
            <Button
              key={env}
              size="xs"
              variant={active ? "filled" : "outline"}
              color={ENV_COLORS[env]}
              onClick={() => toggleEnv(env)}
              loading={envSaving}
              leftSection={active ? <IconCheck size={12} /> : null}
              style={{ minWidth: 80 }}
            >
              {env}
            </Button>
          );
        })}
      </Group>

      <Group justify="space-between" mb="md">
        <Text fw={600} size="sm" c="secondary.9">
          {rules.length} tokenization rule{rules.length !== 1 ? "s" : ""}
        </Text>
        <Button
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={() => setAddModalOpen(true)}
        >
          Add Rule
        </Button>
      </Group>

      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <ScrollArea>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ width: 40 }}></Table.Th>
                <Table.Th>Pattern</Table.Th>
                <Table.Th>Masking Type</Table.Th>
                <Table.Th>Scope</Table.Th>
                <Table.Th>Lock</Table.Th>
                <Table.Th style={{ width: 80 }}>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rules.map((rule) => (
                <Table.Tr key={rule.id}>
                  <Table.Td>
                    <span style={{ fontSize: 16 }}>
                      {getIcon(rule.pattern)}
                    </span>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {rule.pattern.replace(/\*/g, "")}
                    </Text>
                    <Text size="xs" c="dimmed" ff="monospace">
                      {rule.pattern}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      size="sm"
                      variant="light"
                      color="primary"
                      ff="monospace"
                    >
                      {rule.maskingType}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {rule.database || rule.table
                        ? `${rule.database || "*"}.${rule.table || "*"}`
                        : "All databases"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {rule.alwaysMasked && (
                      <Badge size="xs" color="red" variant="light">
                        LOCKED
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Tooltip
                      label={
                        rule.alwaysMasked
                          ? "Locked rules cannot be deleted"
                          : "Delete rule"
                      }
                    >
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="sm"
                        disabled={rule.alwaysMasked}
                        onClick={() => setDeleteRule(rule)}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))}
              {rules.length === 0 && !loading && (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <Text ta="center" c="dimmed" py="lg">
                      No PHI rules configured
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      </div>

      {/* Add Rule Modal */}
      <AddPhiRuleModal
        opened={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onSuccess={loadRules}
      />

      {/* Delete Confirmation */}
      <Modal
        opened={!!deleteRule}
        onClose={() => setDeleteRule(null)}
        title="Delete PHI Rule"
        size="sm"
      >
        <Text size="sm" mb="lg">
          Delete the tokenization rule for pattern{" "}
          <strong>{deleteRule?.pattern}</strong>? Columns matching this pattern
          will no longer be masked.
        </Text>
        <Group justify="flex-end">
          <Button
            variant="subtle"
            color="gray"
            onClick={() => setDeleteRule(null)}
          >
            Cancel
          </Button>
          <Button color="red" onClick={handleDelete}>
            Delete Rule
          </Button>
        </Group>
      </Modal>
    </>
  );
}

function AddPhiRuleModal({
  opened,
  onClose,
  onSuccess,
}: {
  opened: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [pattern, setPattern] = useState("");
  const [maskingType, setMaskingType] = useState<string>("PARTIAL");
  const [alwaysMasked, setAlwaysMasked] = useState(false);
  const [database, setDatabase] = useState("");
  const [table, setTable] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!pattern.trim()) {
      notifications.show({ message: "Pattern is required", color: "red" });
      return;
    }

    setSaving(true);
    try {
      await api.createPhiRule({
        pattern: pattern.trim(),
        maskingType: maskingType as MaskingType,
        alwaysMasked,
        database: database.trim() || undefined,
        table: table.trim() || undefined,
      });
      notifications.show({ message: "PHI rule created", color: "green" });
      onClose();
      onSuccess();
      setPattern("");
      setMaskingType("PARTIAL");
      setAlwaysMasked(false);
      setDatabase("");
      setTable("");
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Add PHI Tokenization Rule"
      size="md"
    >
      <TextInput
        label="Column Pattern"
        placeholder="e.g. *patient_name* or *ssn*"
        description="Use * as wildcard. Matches column names case-insensitively."
        value={pattern}
        onChange={(e) => setPattern(e.currentTarget.value)}
        mb="sm"
      />
      <Select
        label="Masking Type"
        data={[
          {
            value: "FULL",
            label: "FULL — Entire value replaced with ********",
          },
          { value: "PARTIAL", label: "PARTIAL — Last 4 chars visible" },
          { value: "HASH", label: "HASH — SHA256 token (tok_abc123...)" },
          { value: "REDACT", label: "REDACT — Replaced with [REDACTED]" },
        ]}
        value={maskingType}
        onChange={(v) => setMaskingType(v || "PARTIAL")}
        mb="sm"
      />
      <Switch
        label="Always masked (cannot be unmasked by anyone)"
        checked={alwaysMasked}
        onChange={(e) => setAlwaysMasked(e.currentTarget.checked)}
        mb="sm"
        color="red"
      />
      <Group grow mb="lg">
        <TextInput
          label="Database (optional)"
          placeholder="All databases"
          value={database}
          onChange={(e) => setDatabase(e.currentTarget.value)}
        />
        <TextInput
          label="Table (optional)"
          placeholder="All tables"
          value={table}
          onChange={(e) => setTable(e.currentTarget.value)}
        />
      </Group>
      <Group justify="flex-end">
        <Button variant="subtle" color="gray" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          loading={saving}
          disabled={!pattern.trim()}
        >
          Create Rule
        </Button>
      </Group>
    </Modal>
  );
}

// ═══════════════════════════════════════
// ── Audit Log Tab ──
// ═══════════════════════════════════════

const ACTION_COLORS: Record<string, string> = {
  QUERY_EXECUTE: "blue",
  QUERY_ERROR: "red",
  EXPORT_CSV: "teal",
  EXPORT_JSON: "teal",
  PHI_UNMASK: "orange",
  PHI_UNMASK_DENIED: "red",
  WRITE_SUBMIT: "grape",
  WRITE_RESUBMIT: "grape",
  WRITE_APPROVE: "green",
  WRITE_REJECT: "red",
  WRITE_EXECUTE: "green",
  WRITE_EXECUTE_ERROR: "red",
  WRITE_AI_REVIEW: "violet",
  WRITE_PREVIEW: "blue",
};

const ACTION_LABELS: Record<string, string> = {
  QUERY_EXECUTE: "Query",
  QUERY_ERROR: "Error",
  EXPORT_CSV: "CSV Export",
  EXPORT_JSON: "JSON Export",
  PHI_UNMASK: "PHI Unmasked",
  PHI_UNMASK_DENIED: "Unmask Denied",
  WRITE_SUBMIT: "Write Submitted",
  WRITE_RESUBMIT: "Write Resubmitted",
  WRITE_APPROVE: "Write Approved",
  WRITE_REJECT: "Write Rejected",
  WRITE_EXECUTE: "Write Executed",
  WRITE_EXECUTE_ERROR: "Write Failed",
  WRITE_AI_REVIEW: "Write AI Review",
  WRITE_PREVIEW: "Write Preview",
};

interface AuditEntry {
  id: string;
  userId: string;
  userEmail: string;
  action: string;
  sql?: string;
  connectionId?: string;
  rowsReturned?: number;
  executionMs?: number;
  phiAccessed: boolean;
  phiFieldsUnmasked?: string[];
  phiUnmaskReason?: string;
  phiUnmaskNotes?: string;
  timestamp: string;
}

function AuditLogTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [source, setSource] = useState<string>("live");
  const [archiving, setArchiving] = useState(false);

  const loadAudit = async () => {
    setLoading(true);
    try {
      const params: any = { limit: 500 };
      if (fromDate) params.from = fromDate;
      if (toDate) params.to = toDate + "T23:59:59";
      // Server-side action filter (except "phi" which is client-side composite)
      if (filter !== "all" && filter !== "phi") params.action = filter;

      const data =
        source === "archive"
          ? await api.getArchiveLog(params)
          : await api.getAuditLog(params);
      setEntries(data);
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAudit();
  }, [source]);

  const filtered =
    filter === "phi"
      ? entries.filter(
          (e) =>
            e.phiAccessed ||
            e.action === "PHI_UNMASK" ||
            e.action === "PHI_UNMASK_DENIED",
        )
      : entries;

  const handleArchive = async () => {
    setArchiving(true);
    try {
      const result = await api.triggerArchive();
      notifications.show({ message: result.message, color: "green" });
      if (result.archived > 0) loadAudit();
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setArchiving(false);
    }
  };

  return (
    <>
      {/* Filters row */}
      <Group justify="space-between" mb="sm" wrap="wrap">
        <Group gap="xs">
          <Select
            size="xs"
            value={filter}
            onChange={(v) => setFilter(v || "all")}
            data={[
              { value: "all", label: "All events" },
              { value: "phi", label: "PHI access only" },
              { value: "QUERY_EXECUTE", label: "Queries only" },
              { value: "QUERY_ERROR", label: "Errors only" },
              { value: "PHI_UNMASK", label: "PHI unmasked" },
              { value: "PHI_UNMASK_DENIED", label: "Denied unmask" },
            ]}
            style={{ width: 170 }}
          />
          <TextInput
            size="xs"
            type="date"
            placeholder="From"
            value={fromDate}
            onChange={(e) => setFromDate(e.currentTarget.value)}
            style={{ width: 140 }}
          />
          <TextInput
            size="xs"
            type="date"
            placeholder="To"
            value={toDate}
            onChange={(e) => setToDate(e.currentTarget.value)}
            style={{ width: 140 }}
          />
          <Button
            size="xs"
            variant="light"
            onClick={loadAudit}
            loading={loading}
          >
            Search
          </Button>
          {(fromDate || toDate) && (
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              onClick={() => {
                setFromDate("");
                setToDate("");
              }}
            >
              Clear
            </Button>
          )}
        </Group>
        <Group gap="xs">
          <Select
            size="xs"
            value={source}
            onChange={(v) => setSource(v || "live")}
            data={[
              { value: "live", label: "Live log" },
              { value: "archive", label: "Archive (30d+)" },
            ]}
            style={{ width: 150 }}
          />
          <Tooltip label="Move entries older than 30 days to archive">
            <Button
              size="xs"
              variant="subtle"
              onClick={handleArchive}
              loading={archiving}
            >
              Archive Now
            </Button>
          </Tooltip>
          <Button
            size="xs"
            variant="subtle"
            leftSection={<IconRefresh size={14} />}
            onClick={loadAudit}
            loading={loading}
          >
            Refresh
          </Button>
        </Group>
      </Group>

      <Text size="xs" c="dimmed" mb="sm">
        {filtered.length} event{filtered.length !== 1 ? "s" : ""}
        {source === "archive" && " (from archive)"}
      </Text>

      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <div>
          <Table
            highlightOnHover
            verticalSpacing="xs"
            horizontalSpacing="lg"
            layout="fixed"
          >
            <Table.Thead
              style={{ background: "var(--surface-2, rgba(0,0,0,0.02))" }}
            >
              <Table.Tr>
                <Table.Th style={{ width: 190 }}>Timestamp</Table.Th>
                <Table.Th style={{ width: 320 }}>User</Table.Th>
                <Table.Th style={{ width: 150 }}>Action</Table.Th>
                <Table.Th style={{ width: 100 }}>PHI</Table.Th>
                <Table.Th style={{ width: 90, textAlign: "right" }}>
                  Rows
                </Table.Th>
                <Table.Th style={{ width: 90, textAlign: "right" }}>
                  Time
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filtered.map((entry) => (
                <Table.Tr
                  key={entry.id}
                  onClick={() =>
                    setExpandedId(expandedId === entry.id ? null : entry.id)
                  }
                  style={{ cursor: "pointer" }}
                >
                  <Table.Td>
                    <Text size="xs" ff="monospace" c="dimmed">
                      {new Date(entry.timestamp + "Z").toLocaleString()}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                      <Avatar
                        size={24}
                        radius="xl"
                        color="primary"
                        variant="light"
                      >
                        {getInitials(entry.userEmail)}
                      </Avatar>
                      <Text size="xs" fw={600} truncate>
                        {entry.userEmail}
                      </Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      size="sm"
                      radius="sm"
                      color={ACTION_COLORS[entry.action] || "gray"}
                      variant="light"
                      style={{ overflow: "visible" }}
                    >
                      {ACTION_LABELS[entry.action] || entry.action}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {entry.phiAccessed ? (
                      <Badge
                        size="sm"
                        radius="sm"
                        color="red"
                        variant="light"
                        style={{ overflow: "visible" }}
                      >
                        EXPOSED
                      </Badge>
                    ) : entry.action === "PHI_UNMASK_DENIED" ? (
                      <Badge
                        size="sm"
                        radius="sm"
                        color="orange"
                        variant="light"
                        style={{ overflow: "visible" }}
                      >
                        DENIED
                      </Badge>
                    ) : (
                      <Text size="xs" c="dimmed">
                        —
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td style={{ textAlign: "right" }}>
                    <Text size="xs" ff="monospace">
                      {entry.rowsReturned ?? "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td style={{ textAlign: "right" }}>
                    <Text size="xs" ff="monospace" c="dimmed">
                      {entry.executionMs != null
                        ? `${entry.executionMs}ms`
                        : "—"}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
              {filtered.length === 0 && !loading && (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <Text ta="center" c="dimmed" py="lg">
                      No audit entries found
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </div>
      </div>

      {/* Expanded detail modal */}
      <AuditDetailModal
        entry={filtered.find((e) => e.id === expandedId) || null}
        onClose={() => setExpandedId(null)}
      />
    </>
  );
}

function AuditDetailModal({
  entry,
  onClose,
}: {
  entry: AuditEntry | null;
  onClose: () => void;
}) {
  if (!entry) return null;

  return (
    <Modal
      opened={!!entry}
      onClose={onClose}
      title="Audit Entry Detail"
      size="lg"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Group gap="lg">
          <div>
            <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>
              Timestamp
            </Text>
            <Text size="sm" ff="monospace">
              {new Date(entry.timestamp + "Z").toLocaleString()}
            </Text>
          </div>
          <div>
            <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>
              User
            </Text>
            <Text size="sm">{entry.userEmail}</Text>
          </div>
          <div>
            <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>
              Action
            </Text>
            <Badge
              color={ACTION_COLORS[entry.action] || "gray"}
              variant="light"
            >
              {ACTION_LABELS[entry.action] || entry.action}
            </Badge>
          </div>
        </Group>

        {entry.connectionId && (
          <div>
            <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>
              Connection
            </Text>
            <Text size="sm" ff="monospace">
              {entry.connectionId}
            </Text>
          </div>
        )}

        {entry.sql && (
          <div>
            <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>
              SQL
            </Text>
            <div
              style={{
                background: "var(--surface2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "10px 14px",
                fontFamily: "IBM Plex Mono, monospace",
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                maxHeight: 200,
                overflow: "auto",
              }}
            >
              {entry.sql}
            </div>
          </div>
        )}

        <Group gap="lg">
          {entry.rowsReturned != null && (
            <div>
              <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>
                Rows Returned
              </Text>
              <Text size="sm" ff="monospace">
                {entry.rowsReturned}
              </Text>
            </div>
          )}
          {entry.executionMs != null && (
            <div>
              <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>
                Execution Time
              </Text>
              <Text size="sm" ff="monospace">
                {entry.executionMs}ms
              </Text>
            </div>
          )}
        </Group>

        {/* PHI Section */}
        {(entry.phiAccessed || entry.action === "PHI_UNMASK_DENIED") && (
          <div
            style={{
              background: entry.phiAccessed
                ? "rgba(215,54,54,0.06)"
                : "rgba(240,136,62,0.06)",
              border: `1px solid ${entry.phiAccessed ? "rgba(215,54,54,0.2)" : "rgba(240,136,62,0.2)"}`,
              borderRadius: 8,
              padding: 14,
            }}
          >
            <Group gap={6} mb={8}>
              <IconAlertTriangle
                size={14}
                color={entry.phiAccessed ? "var(--error)" : "var(--warning)"}
              />
              <Text
                size="xs"
                fw={700}
                c={entry.phiAccessed ? "red" : "orange"}
                tt="uppercase"
              >
                {entry.phiAccessed ? "PHI Data Exposed" : "PHI Unmask Denied"}
              </Text>
            </Group>

            {entry.phiFieldsUnmasked && entry.phiFieldsUnmasked.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <Text size="xs" c="dimmed" fw={700} mb={2}>
                  Fields Unmasked
                </Text>
                <Group gap={4}>
                  {entry.phiFieldsUnmasked.map((f) => (
                    <Badge
                      key={f}
                      size="xs"
                      variant="light"
                      color="red"
                      ff="monospace"
                    >
                      {f}
                    </Badge>
                  ))}
                </Group>
              </div>
            )}

            {entry.phiUnmaskReason && (
              <div style={{ marginBottom: 4 }}>
                <Text size="xs" c="dimmed" fw={700} mb={2}>
                  Reason
                </Text>
                <Text size="sm">{entry.phiUnmaskReason}</Text>
              </div>
            )}

            {entry.phiUnmaskNotes && (
              <div>
                <Text size="xs" c="dimmed" fw={700} mb={2}>
                  Notes
                </Text>
                <Text size="sm" c="dimmed">
                  {entry.phiUnmaskNotes}
                </Text>
              </div>
            )}
          </div>
        )}
      </div>

      <Group justify="flex-end" mt="lg">
        <Button variant="subtle" color="gray" onClick={onClose}>
          Close
        </Button>
      </Group>
    </Modal>
  );
}

// ═══════════════════════════════════════
// ── Azure OpenAI Tab ──
// ═══════════════════════════════════════

interface AzureTestResult {
  success: boolean;
  message: string;
  endpoint?: string;
  deployment?: string;
  model?: string;
}

function AzureOpenAiTab() {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AzureTestResult | null>(null);

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const data = await api.testAzureConnection();
      setResult(data);
    } catch (err: any) {
      setResult({ success: false, message: err.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      {/* Info banner */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          background: "rgba(31,145,150,0.06)",
          border: "1px solid rgba(31,145,150,0.2)",
          borderRadius: 10,
          padding: 16,
          marginBottom: 20,
        }}
      >
        <div style={{ fontSize: 24, flexShrink: 0 }}>✨</div>
        <div>
          <Text fw={700} size="sm" c="primary.8" mb={4}>
            Azure OpenAI Connection
          </Text>
          <Text size="xs" c="dimmed" style={{ lineHeight: 1.6 }}>
            Credentials are read from server environment variables (
            <Text span ff="monospace" size="xs">
              AZURE_OPENAI_ENDPOINT
            </Text>
            ,{" "}
            <Text span ff="monospace" size="xs">
              AZURE_OPENAI_KEY
            </Text>
            ,{" "}
            <Text span ff="monospace" size="xs">
              AZURE_OPENAI_DEPLOYMENT
            </Text>
            ). Click below to send a test request and verify the keys are valid.
          </Text>
        </div>
      </div>

      <Group mb="lg">
        <Button
          leftSection={<IconSparkles size={16} />}
          onClick={handleTest}
          loading={testing}
        >
          Test Connect to Azure OpenAI
        </Button>
      </Group>

      {/* Result panel */}
      {result && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            background: result.success
              ? "rgba(46,160,67,0.06)"
              : "rgba(215,54,54,0.06)",
            border: `1px solid ${result.success ? "rgba(46,160,67,0.25)" : "rgba(215,54,54,0.25)"}`,
            borderRadius: 10,
            padding: 16,
          }}
        >
          <div style={{ flexShrink: 0, marginTop: 2 }}>
            {result.success ? (
              <IconCheck size={20} color="var(--success, #2ea043)" />
            ) : (
              <IconX size={20} color="var(--error, #d73636)" />
            )}
          </div>
          <div style={{ flex: 1 }}>
            <Group gap={8} mb={6}>
              <Badge color={result.success ? "green" : "red"} variant="light">
                {result.success ? "SUCCESS" : "FAILED"}
              </Badge>
            </Group>
            <Text size="sm" mb={result.endpoint ? "sm" : 0}>
              {result.message}
            </Text>
            {result.endpoint && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <Text size="xs" c="dimmed" ff="monospace">
                  endpoint: {result.endpoint}
                </Text>
                {result.deployment && (
                  <Text size="xs" c="dimmed" ff="monospace">
                    deployment: {result.deployment}
                  </Text>
                )}
                {result.model && (
                  <Text size="xs" c="dimmed" ff="monospace">
                    model: {result.model}
                  </Text>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ═══════════════════════════════════════
// ── AI Chat Log Tab ──
// ═══════════════════════════════════════

function AiChatLogTab() {
  const [entries, setEntries] = useState<AiChatLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selected, setSelected] = useState<AiChatLogEntry | null>(null);

  const loadLog = async () => {
    setLoading(true);
    try {
      const params: any = { limit: 500 };
      if (fromDate) params.from = fromDate;
      if (toDate) params.to = toDate + "T23:59:59";
      if (status !== "all") params.status = status;
      const data = await api.getAiChatLog(params);
      setEntries(data);
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLog();
  }, []);

  return (
    <>
      <Text size="xs" c="dimmed" mb="md">
        Every AI query generation is recorded — the full prompt sent (schema
        context + request) and the model's response — for prompt tuning and
        optimization. Schema metadata only; no row data is sent or stored.
      </Text>

      {/* Filters */}
      <Group justify="space-between" mb="sm" wrap="wrap">
        <Group gap="xs">
          <Select
            size="xs"
            value={status}
            onChange={(v) => setStatus(v || "all")}
            data={[
              { value: "all", label: "All outcomes" },
              { value: "success", label: "Success only" },
              { value: "error", label: "Errors only" },
            ]}
            style={{ width: 150 }}
          />
          <TextInput
            size="xs"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.currentTarget.value)}
            style={{ width: 140 }}
          />
          <TextInput
            size="xs"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.currentTarget.value)}
            style={{ width: 140 }}
          />
          <Button size="xs" variant="light" onClick={loadLog} loading={loading}>
            Search
          </Button>
          {(fromDate || toDate) && (
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              onClick={() => {
                setFromDate("");
                setToDate("");
              }}
            >
              Clear
            </Button>
          )}
        </Group>
        <Button
          size="xs"
          variant="subtle"
          leftSection={<IconRefresh size={14} />}
          onClick={loadLog}
          loading={loading}
        >
          Refresh
        </Button>
      </Group>

      <Text size="xs" c="dimmed" mb="sm">
        {entries.length} generation{entries.length !== 1 ? "s" : ""}
      </Text>

      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <div>
          <Table
            highlightOnHover
            verticalSpacing="sm"
            horizontalSpacing="lg"
            layout="fixed"
          >
            <Table.Thead
              style={{ background: "var(--surface-2, rgba(0,0,0,0.02))" }}
            >
              <Table.Tr>
                <Table.Th style={{ width: 180 }}>Timestamp</Table.Th>
                <Table.Th style={{ width: 230 }}>User</Table.Th>
                <Table.Th>Prompt</Table.Th>
                <Table.Th style={{ width: 100 }}>Status</Table.Th>
                <Table.Th style={{ width: 90, textAlign: "right" }}>
                  Tokens
                </Table.Th>
                <Table.Th style={{ width: 90, textAlign: "right" }}>
                  Latency
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {entries.map((e) => (
                <Table.Tr
                  key={e.id}
                  onClick={() => setSelected(e)}
                  style={{ cursor: "pointer" }}
                >
                  <Table.Td style={{ verticalAlign: "top" }}>
                    <Text size="xs" ff="monospace" c="dimmed">
                      {new Date(e.timestamp + "Z").toLocaleString()}
                    </Text>
                  </Table.Td>
                  <Table.Td style={{ verticalAlign: "top" }}>
                    <Group gap="xs" wrap="nowrap">
                      <Avatar
                        size={28}
                        radius="xl"
                        color="primary"
                        variant="light"
                      >
                        {getInitials(e.userEmail)}
                      </Avatar>
                      <Text size="xs" fw={600} truncate>
                        {e.userEmail}
                      </Text>
                    </Group>
                  </Table.Td>
                  <Table.Td style={{ verticalAlign: "top" }}>
                    <Text
                      size="xs"
                      c="secondary.9"
                      style={{
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                        lineHeight: 1.45,
                        wordBreak: "break-word",
                      }}
                    >
                      {e.prompt}
                    </Text>
                  </Table.Td>
                  <Table.Td style={{ verticalAlign: "top" }}>
                    <Badge
                      size="sm"
                      radius="sm"
                      color={e.status === "success" ? "green" : "red"}
                      variant="light"
                      style={{ overflow: "visible" }}
                    >
                      {e.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td
                    style={{ verticalAlign: "top", textAlign: "right" }}
                  >
                    <Text size="xs" ff="monospace" c="dimmed">
                      {e.totalTokens ?? "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td
                    style={{ verticalAlign: "top", textAlign: "right" }}
                  >
                    <Text size="xs" ff="monospace" c="dimmed">
                      {e.latencyMs != null ? `${e.latencyMs}ms` : "—"}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
              {entries.length === 0 && !loading && (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <Text ta="center" c="dimmed" py="lg">
                      No AI generations logged yet
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </div>
      </div>

      <AiChatDetailModal entry={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      size="xs"
      fw={800}
      tt="uppercase"
      c="secondary.9"
      style={{
        letterSpacing: 0.5,
        borderBottom: "1px solid var(--border)",
        paddingBottom: 4,
        marginTop: 4,
      }}
    >
      {children}
    </Text>
  );
}

function copyChatText(text: string) {
  const done = () =>
    notifications.show({
      message: "Copied to clipboard",
      color: "teal",
      autoClose: 1500,
    });
  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(done)
      .catch(() => done());
  } else {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done();
  }
}

function CodeBlock({
  label,
  value,
  collapsible = false,
  defaultOpen = true,
  accent,
}: {
  label: string;
  value?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  accent?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!value) return null;
  const lines = value.split("\n").length;

  return (
    <div>
      <Group justify="space-between" gap={6} mb={3} wrap="nowrap">
        <Group
          gap={6}
          wrap="nowrap"
          style={{ cursor: collapsible ? "pointer" : "default", minWidth: 0 }}
          onClick={collapsible ? () => setOpen((o) => !o) : undefined}
        >
          {collapsible && (
            <IconChevronRight
              size={13}
              color="var(--mantine-color-dimmed)"
              style={{
                transform: open ? "rotate(90deg)" : "none",
                transition: "transform .15s",
                flexShrink: 0,
              }}
            />
          )}
          <Text
            size="xs"
            fw={700}
            tt="uppercase"
            c={accent || "dimmed"}
            style={{ whiteSpace: "nowrap" }}
          >
            {label}
          </Text>
          <Text
            size="xs"
            c="dimmed"
            style={{ fontSize: 10, whiteSpace: "nowrap" }}
          >
            {value.length.toLocaleString()} chars · {lines}{" "}
            {lines === 1 ? "line" : "lines"}
          </Text>
        </Group>
        <Tooltip label="Copy">
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            onClick={() => copyChatText(value)}
            style={{ flexShrink: 0 }}
          >
            <IconCopy size={13} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Collapse in={open}>
        <div
          style={{
            background: "var(--surface2)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "10px 14px",
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 320,
            overflow: "auto",
          }}
        >
          {value}
        </div>
      </Collapse>
    </div>
  );
}

function AiChatDetailModal({
  entry,
  onClose,
}: {
  entry: AiChatLogEntry | null;
  onClose: () => void;
}) {
  if (!entry) return null;

  return (
    <Modal
      opened={!!entry}
      onClose={onClose}
      title="AI Generation Detail"
      size="xl"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Group gap="lg" wrap="wrap">
          <div>
            <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>
              Timestamp
            </Text>
            <Text size="sm" ff="monospace">
              {new Date(entry.timestamp + "Z").toLocaleString()}
            </Text>
          </div>
          <div>
            <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>
              User
            </Text>
            <Text size="sm">{entry.userEmail}</Text>
          </div>
          <div>
            <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>
              Status
            </Text>
            <Badge
              color={entry.status === "success" ? "green" : "red"}
              variant="light"
            >
              {entry.status}
            </Badge>
          </div>
          {entry.model && (
            <div>
              <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>
                Model
              </Text>
              <Text size="sm" ff="monospace">
                {entry.model}
              </Text>
            </div>
          )}
        </Group>

        <Group gap="lg" wrap="wrap">
          {entry.connectionId && (
            <div>
              <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>
                Connection
              </Text>
              <Text size="sm" ff="monospace">
                {entry.connectionId} {entry.dbType ? `· ${entry.dbType}` : ""}
              </Text>
            </div>
          )}
          {entry.latencyMs != null && (
            <div>
              <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>
                Latency
              </Text>
              <Text size="sm" ff="monospace">
                {entry.latencyMs}ms
              </Text>
            </div>
          )}
          {entry.totalTokens != null && (
            <div>
              <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>
                Tokens
              </Text>
              <Text size="sm" ff="monospace">
                {entry.totalTokens} total
                {entry.promptTokens != null
                  ? ` (${entry.promptTokens} in / ${entry.completionTokens} out)`
                  : ""}
              </Text>
            </div>
          )}
          {entry.tablesProvided != null && (
            <div>
              <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>
                Schema
              </Text>
              <Text size="sm" ff="monospace">
                {entry.tablesProvided}
                {entry.totalTables != null ? `/${entry.totalTables}` : ""}{" "}
                tables{entry.schemaTruncated ? " (truncated)" : ""}
              </Text>
            </div>
          )}
        </Group>

        <SectionLabel>1 · The request</SectionLabel>
        <CodeBlock
          label="User Prompt (plain English)"
          value={entry.prompt}
          accent="primary.7"
        />

        <SectionLabel>2 · What we sent to the model</SectionLabel>
        <Text size="xs" c="dimmed" mt={-6}>
          This is the exact prompt and context the model received. Schema
          metadata only — no row data.
        </Text>
        <CodeBlock
          label="System Prompt (instructions)"
          value={entry.systemPrompt}
          collapsible
          defaultOpen={false}
        />
        <CodeBlock
          label="User Message — schema context + request"
          value={entry.userMessage}
          collapsible
          defaultOpen={false}
        />

        <SectionLabel>3 · What came back</SectionLabel>
        {entry.errorMessage && (
          <div
            style={{
              background: "rgba(215,54,54,0.06)",
              border: "1px solid rgba(215,54,54,0.2)",
              borderRadius: 8,
              padding: 12,
            }}
          >
            <Text size="xs" fw={700} c="red" tt="uppercase" mb={2}>
              Error
            </Text>
            <Text size="sm">{entry.errorMessage}</Text>
          </div>
        )}
        <CodeBlock
          label="Generated Query"
          value={entry.generatedQuery}
          accent="primary.7"
        />
        {entry.explanation && (
          <CodeBlock label="Explanation" value={entry.explanation} />
        )}
        <CodeBlock
          label="Raw Model Response (JSON)"
          value={entry.responseRaw}
          collapsible
          defaultOpen={false}
        />
      </div>

      <Group justify="flex-end" mt="lg">
        <Button variant="subtle" color="gray" onClick={onClose}>
          Close
        </Button>
      </Group>
    </Modal>
  );
}
