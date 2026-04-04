import { useState, useEffect } from "react";
import {
  Text,
  Tabs,
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
} from "@tabler/icons-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import type { User, PhiFieldRule, MaskingType } from "../../types";

// ── PHI Field Icons ──
const FIELD_ICONS: Record<string, string> = {
  "*firstName*": "👤", "*lastName*": "👤", "*middleName*": "👤", "*preferredName*": "👤",
  "*dateOfBirth*": "🎂", "*date_of_birth*": "🎂", "*dob*": "🎂",
  "*email*": "✉️", "*phone*": "📞",
  "*addressLine1*": "🏠", "*addressLine2*": "🏠", "*zipCode*": "🏠",
  "*memberId*": "💳", "*policyNumber*": "💳", "*ethnicity*": "🧬",
};

function getIcon(pattern: string): string {
  return FIELD_ICONS[pattern] || "🔐";
}

export function SettingsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") || "users";
  const user = useStore((s) => s.user);

  return (
    <div style={{ padding: "28px 32px", maxWidth: 900, margin: "0 auto", overflow: "auto", flex: 1 }}>
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
        Settings
      </Text>
      <Text size="sm" c="dimmed" mb="lg">
        Manage users, roles, PHI tokenization rules, and audit logs
      </Text>

      <Tabs
        value={activeTab}
        onChange={(v) => setSearchParams({ tab: v || "users" })}
      >
        <Tabs.List mb="lg">
          <Tabs.Tab value="users" leftSection={<IconUsers size={14} />}>
            User Management
          </Tabs.Tab>
          <Tabs.Tab value="phi" leftSection={<IconShieldLock size={14} />}>
            PHI Tokenization
          </Tabs.Tab>
          <Tabs.Tab value="audit" leftSection={<IconFileText size={14} />}>
            Audit Log
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="users">
          <UserManagementTab currentUserId={user?.id || ""} />
        </Tabs.Panel>

        <Tabs.Panel value="phi">
          <PhiManagementTab />
        </Tabs.Panel>

        <Tabs.Panel value="audit">
          <AuditLogTab />
        </Tabs.Panel>
      </Tabs>
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

  useEffect(() => { loadUsers(); }, []);

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
        <Table highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Email</Table.Th>
              <Table.Th>Role</Table.Th>
              <Table.Th>Last Login</Table.Th>
              <Table.Th style={{ width: 120 }}>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {users.map((u) => (
              <Table.Tr key={u.id}>
                <Table.Td>
                  <Text fw={600} size="sm">{u.displayName}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" ff="monospace" c="dimmed">{u.email || u.username}</Text>
                </Table.Td>
                <Table.Td>
                  <Badge
                    size="sm"
                    color={u.role === "admin" ? "red" : u.role === "phi_viewer" ? "orange" : "primary"}
                    variant="light"
                  >
                    {u.role === "phi_viewer" ? "PHI VIEWER" : u.role.toUpperCase()}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {u.lastLogin ? new Date(u.lastLogin).toLocaleDateString() : "Never"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    <Tooltip label="Edit role">
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        onClick={() => setEditUser(u)}
                      >
                        <IconEdit size={14} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Reset password">
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        onClick={() => setResetPwUser(u)}
                      >
                        <IconKey size={14} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={u.id === currentUserId ? "Cannot delete yourself" : "Delete user"}>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="sm"
                        disabled={u.id === currentUserId}
                        onClick={() => setDeleteUser(u)}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
            {users.length === 0 && !loading && (
              <Table.Tr>
                <Table.Td colSpan={5}>
                  <Text ta="center" c="dimmed" py="lg">No users found</Text>
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

function AddUserModal({ opened, onClose, onSuccess, emailDomain }: { opened: boolean; onClose: () => void; onSuccess: () => void; emailDomain: string | null }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<string>("read");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (emailDomain) {
      if (!email.endsWith(`@${emailDomain}`)) {
        notifications.show({ message: `Email must be a @${emailDomain} address`, color: "red" });
        return;
      }
    } else if (!email.includes("@")) {
      notifications.show({ message: "A valid email address is required", color: "red" });
      return;
    }
    if (password.length < 8) {
      notifications.show({ message: "Password must be at least 8 characters", color: "red" });
      return;
    }

    setSaving(true);
    try {
      await api.createUser({ email, displayName: displayName || email.split("@")[0], role, password });
      notifications.show({ message: "User created successfully", color: "green" });
      onClose();
      onSuccess();
      setEmail(""); setDisplayName(""); setRole("read"); setPassword("");
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
        description={emailDomain ? `Must be a @${emailDomain} address` : "Used as the login username"}
      />
      <TextInput
        label="Display Name"
        placeholder="Full name"
        value={displayName}
        onChange={(e) => setDisplayName(e.currentTarget.value)}
        mb="sm"
      />
      <Select
        label="Role"
        data={[
          { value: "read", label: "Read — View queries, cannot unmask PHI" },
          { value: "phi_viewer", label: "PHI Viewer — Can unmask PHI on permitted environments" },
          { value: "admin", label: "Admin — Full access to all features" },
        ]}
        value={role}
        onChange={(v) => setRole(v || "read")}
        mb="sm"
      />
      <PasswordInput
        label="Temporary Password"
        placeholder="At least 8 characters"
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        mb="lg"
      />
      <Group justify="flex-end">
        <Button variant="subtle" color="gray" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} loading={saving} disabled={!email || !password}>
          Create User
        </Button>
      </Group>
    </Modal>
  );
}

function EditUserModal({ user, onClose, onSuccess }: { user: User | null; onClose: () => void; onSuccess: () => void }) {
  const [role, setRole] = useState<string>(user?.role || "read");
  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) {
      setRole(user.role);
      setDisplayName(user.displayName);
    }
  }, [user]);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await api.updateUser(user.id, { displayName, role });
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
      <Select
        label="Role"
        data={[
          { value: "read", label: "Read — View queries, cannot unmask PHI" },
          { value: "phi_viewer", label: "PHI Viewer — Can unmask PHI on permitted environments" },
          { value: "admin", label: "Admin — Full access to all features" },
        ]}
        value={role}
        onChange={(v) => setRole(v || "read")}
        mb="lg"
      />
      <Group justify="flex-end">
        <Button variant="subtle" color="gray" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} loading={saving}>Save</Button>
      </Group>
    </Modal>
  );
}

function DeleteUserModal({ user, onClose, onSuccess }: { user: User | null; onClose: () => void; onSuccess: () => void }) {
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
        Are you sure you want to delete <strong>{user?.displayName}</strong> ({user?.email})?
        This action cannot be undone.
      </Text>
      <Group justify="flex-end">
        <Button variant="subtle" color="gray" onClick={onClose}>Cancel</Button>
        <Button color="red" onClick={handleDelete} loading={deleting}>Delete User</Button>
      </Group>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: User | null; onClose: () => void }) {
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const handleReset = async () => {
    if (!user || newPassword.length < 8) {
      notifications.show({ message: "Password must be at least 8 characters", color: "red" });
      return;
    }
    setSaving(true);
    try {
      await api.resetUserPassword(user.id, newPassword);
      notifications.show({ message: `Password reset for ${user.displayName}`, color: "green" });
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
        <Button variant="subtle" color="gray" onClick={onClose}>Cancel</Button>
        <Button onClick={handleReset} loading={saving} disabled={newPassword.length < 8}>
          Reset Password
        </Button>
      </Group>
    </Modal>
  );
}

// ═══════════════════════════════════════
// ── PHI Management Tab ──
// ═══════════════════════════════════════

const ENV_OPTIONS = ["PROD", "STG", "QA", "DEV"] as const;
const ENV_COLORS: Record<string, string> = { PROD: "red", STG: "orange", QA: "violet", DEV: "green" };

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

  useEffect(() => { loadRules(); loadMaskedEnvs(); }, []);

  const toggleEnv = async (env: string) => {
    const next = maskedEnvs.includes(env)
      ? maskedEnvs.filter((e) => e !== env)
      : [...maskedEnvs, env];
    setMaskedEnvs(next);
    setEnvSaving(true);
    try {
      await api.updateMaskedEnvironments(next);
      setConfig({ ...config, phiMaskedEnvironments: next });
      notifications.show({ message: "Masked environments updated", color: "green" });
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
            Real PHI is replaced at query time with deterministic tokens. The same patient
            always gets the same token — enabling joins and analytics without exposing data.
          </Text>
        </div>
      </div>

      {/* Masked Environments */}
      <Text fw={700} size="sm" c="secondary.9" mb="xs">
        Masked Environments
      </Text>
      <Text size="xs" c="dimmed" mb="sm">
        PHI fields are tokenized for connections in these environments. Users with{" "}
        <Badge size="xs" color="orange" variant="light">PHI VIEWER</Badge> or{" "}
        <Badge size="xs" color="red" variant="light">ADMIN</Badge> role can request de-tokenization with a logged reason.
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
                    <span style={{ fontSize: 16 }}>{getIcon(rule.pattern)}</span>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" fw={600}>{rule.pattern.replace(/\*/g, "")}</Text>
                    <Text size="xs" c="dimmed" ff="monospace">{rule.pattern}</Text>
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
                      <Badge size="xs" color="red" variant="light">LOCKED</Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={rule.alwaysMasked ? "Locked rules cannot be deleted" : "Delete rule"}>
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
                    <Text ta="center" c="dimmed" py="lg">No PHI rules configured</Text>
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
      <Modal opened={!!deleteRule} onClose={() => setDeleteRule(null)} title="Delete PHI Rule" size="sm">
        <Text size="sm" mb="lg">
          Delete the tokenization rule for pattern <strong>{deleteRule?.pattern}</strong>?
          Columns matching this pattern will no longer be masked.
        </Text>
        <Group justify="flex-end">
          <Button variant="subtle" color="gray" onClick={() => setDeleteRule(null)}>Cancel</Button>
          <Button color="red" onClick={handleDelete}>Delete Rule</Button>
        </Group>
      </Modal>
    </>
  );
}

function AddPhiRuleModal({ opened, onClose, onSuccess }: { opened: boolean; onClose: () => void; onSuccess: () => void }) {
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
      setPattern(""); setMaskingType("PARTIAL"); setAlwaysMasked(false);
      setDatabase(""); setTable("");
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Add PHI Tokenization Rule" size="md">
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
          { value: "FULL", label: "FULL — Entire value replaced with ********" },
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
        <Button variant="subtle" color="gray" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} loading={saving} disabled={!pattern.trim()}>
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
};

const ACTION_LABELS: Record<string, string> = {
  QUERY_EXECUTE: "Query",
  QUERY_ERROR: "Error",
  EXPORT_CSV: "CSV Export",
  EXPORT_JSON: "JSON Export",
  PHI_UNMASK: "PHI Unmasked",
  PHI_UNMASK_DENIED: "Unmask Denied",
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

      const data = source === "archive"
        ? await api.getArchiveLog(params)
        : await api.getAuditLog(params);
      setEntries(data);
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAudit(); }, [source]);

  const filtered = filter === "phi"
    ? entries.filter((e) => e.phiAccessed || e.action === "PHI_UNMASK" || e.action === "PHI_UNMASK_DENIED")
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
          <Button size="xs" variant="light" onClick={loadAudit} loading={loading}>
            Search
          </Button>
          {(fromDate || toDate) && (
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              onClick={() => { setFromDate(""); setToDate(""); }}
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
        <ScrollArea style={{ maxHeight: "calc(100vh - 320px)" }}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ width: 160 }}>Timestamp</Table.Th>
                <Table.Th>User</Table.Th>
                <Table.Th style={{ width: 120 }}>Action</Table.Th>
                <Table.Th style={{ width: 80 }}>PHI</Table.Th>
                <Table.Th style={{ width: 80 }}>Rows</Table.Th>
                <Table.Th style={{ width: 70 }}>Time</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filtered.map((entry) => (
                <Table.Tr
                  key={entry.id}
                  onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                  style={{ cursor: "pointer" }}
                >
                  <Table.Td>
                    <Text size="xs" ff="monospace" c="dimmed">
                      {new Date(entry.timestamp + "Z").toLocaleString()}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" fw={600} style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {entry.userEmail}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      size="sm"
                      color={ACTION_COLORS[entry.action] || "gray"}
                      variant="light"
                    >
                      {ACTION_LABELS[entry.action] || entry.action}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {entry.phiAccessed ? (
                      <Badge size="sm" color="red" variant="light">
                        EXPOSED
                      </Badge>
                    ) : entry.action === "PHI_UNMASK_DENIED" ? (
                      <Badge size="sm" color="orange" variant="light">
                        DENIED
                      </Badge>
                    ) : (
                      <Text size="xs" c="dimmed">—</Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" ff="monospace">
                      {entry.rowsReturned ?? "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" ff="monospace" c="dimmed">
                      {entry.executionMs != null ? `${entry.executionMs}ms` : "—"}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
              {filtered.length === 0 && !loading && (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <Text ta="center" c="dimmed" py="lg">No audit entries found</Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      </div>

      {/* Expanded detail modal */}
      <AuditDetailModal
        entry={filtered.find((e) => e.id === expandedId) || null}
        onClose={() => setExpandedId(null)}
      />
    </>
  );
}

function AuditDetailModal({ entry, onClose }: { entry: AuditEntry | null; onClose: () => void }) {
  if (!entry) return null;

  return (
    <Modal opened={!!entry} onClose={onClose} title="Audit Entry Detail" size="lg">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Group gap="lg">
          <div>
            <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>Timestamp</Text>
            <Text size="sm" ff="monospace">{new Date(entry.timestamp + "Z").toLocaleString()}</Text>
          </div>
          <div>
            <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>User</Text>
            <Text size="sm">{entry.userEmail}</Text>
          </div>
          <div>
            <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>Action</Text>
            <Badge color={ACTION_COLORS[entry.action] || "gray"} variant="light">
              {ACTION_LABELS[entry.action] || entry.action}
            </Badge>
          </div>
        </Group>

        {entry.connectionId && (
          <div>
            <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>Connection</Text>
            <Text size="sm" ff="monospace">{entry.connectionId}</Text>
          </div>
        )}

        {entry.sql && (
          <div>
            <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>SQL</Text>
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
              <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>Rows Returned</Text>
              <Text size="sm" ff="monospace">{entry.rowsReturned}</Text>
            </div>
          )}
          {entry.executionMs != null && (
            <div>
              <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>Execution Time</Text>
              <Text size="sm" ff="monospace">{entry.executionMs}ms</Text>
            </div>
          )}
        </Group>

        {/* PHI Section */}
        {(entry.phiAccessed || entry.action === "PHI_UNMASK_DENIED") && (
          <div
            style={{
              background: entry.phiAccessed ? "rgba(215,54,54,0.06)" : "rgba(240,136,62,0.06)",
              border: `1px solid ${entry.phiAccessed ? "rgba(215,54,54,0.2)" : "rgba(240,136,62,0.2)"}`,
              borderRadius: 8,
              padding: 14,
            }}
          >
            <Group gap={6} mb={8}>
              <IconAlertTriangle size={14} color={entry.phiAccessed ? "var(--error)" : "var(--warning)"} />
              <Text size="xs" fw={700} c={entry.phiAccessed ? "red" : "orange"} tt="uppercase">
                {entry.phiAccessed ? "PHI Data Exposed" : "PHI Unmask Denied"}
              </Text>
            </Group>

            {entry.phiFieldsUnmasked && entry.phiFieldsUnmasked.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <Text size="xs" c="dimmed" fw={700} mb={2}>Fields Unmasked</Text>
                <Group gap={4}>
                  {entry.phiFieldsUnmasked.map((f) => (
                    <Badge key={f} size="xs" variant="light" color="red" ff="monospace">
                      {f}
                    </Badge>
                  ))}
                </Group>
              </div>
            )}

            {entry.phiUnmaskReason && (
              <div style={{ marginBottom: 4 }}>
                <Text size="xs" c="dimmed" fw={700} mb={2}>Reason</Text>
                <Text size="sm">{entry.phiUnmaskReason}</Text>
              </div>
            )}

            {entry.phiUnmaskNotes && (
              <div>
                <Text size="xs" c="dimmed" fw={700} mb={2}>Notes</Text>
                <Text size="sm" c="dimmed">{entry.phiUnmaskNotes}</Text>
              </div>
            )}
          </div>
        )}
      </div>

      <Group justify="flex-end" mt="lg">
        <Button variant="subtle" color="gray" onClick={onClose}>Close</Button>
      </Group>
    </Modal>
  );
}
