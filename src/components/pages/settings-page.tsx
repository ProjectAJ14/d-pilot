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
        Manage users, roles, and PHI tokenization rules
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
        </Tabs.List>

        <Tabs.Panel value="users">
          <UserManagementTab currentUserId={user?.id || ""} />
        </Tabs.Panel>

        <Tabs.Panel value="phi">
          <PhiManagementTab />
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
                    color={u.role === "admin" ? "red" : "primary"}
                    variant="light"
                  >
                    {u.role.toUpperCase()}
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
          { value: "read", label: "Read — View queries, cannot modify settings" },
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
  const [role, setRole] = useState(user?.role || "read");
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
          { value: "read", label: "Read — View queries, cannot modify settings" },
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

function PhiManagementTab() {
  const [rules, setRules] = useState<PhiFieldRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [deleteRule, setDeleteRule] = useState<PhiFieldRule | null>(null);

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

  useEffect(() => { loadRules(); }, []);

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
