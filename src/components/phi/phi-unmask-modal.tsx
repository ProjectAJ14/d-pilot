import { useState } from "react";
import { Modal, Select, Textarea, Button, Group, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useStore } from "../../store";

const UNMASK_REASONS = [
  "Debugging production issue",
  "Support ticket investigation",
  "Data quality validation",
  "Authorized audit review",
  "Engineering incident response",
];

export function PhiUnmaskModal() {
  const phiEnabled = useStore((s) => s.phiEnabled);
  const user = useStore((s) => s.user);
  const setPhi = useStore((s) => s.setPhi);
  const connections = useStore((s) => s.connections);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const [opened, setOpened] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  const activeConn = connections.find((c) => c.id === activeConnectionId);
  const isProdOrStg = activeConn?.env === "PROD" || activeConn?.env === "STG";

  // This is called from the store's togglePhi — we intercept it
  // We expose open/close via a global ref so TopBar can trigger it
  PhiUnmaskModal.open = () => setOpened(true);
  PhiUnmaskModal.close = () => {
    setOpened(false);
    setReason(null);
    setNotes("");
  };

  const handleConfirm = () => {
    if (!reason) return;
    // Persist reason/notes so api-client sends them as headers on subsequent queries
    localStorage.setItem("phi_unmask_reason", reason);
    if (notes) {
      localStorage.setItem("phi_unmask_notes", notes);
    } else {
      localStorage.removeItem("phi_unmask_notes");
    }
    setPhi(false);
    PhiUnmaskModal.close();
  };

  return (
    <Modal
      opened={opened}
      onClose={PhiUnmaskModal.close}
      title=""
      size="lg"
      centered
      withCloseButton={false}
      styles={{
        content: {
          border: "1px solid var(--border)",
        },
        body: { padding: 28 },
      }}
    >
      <div style={{ fontSize: 32, marginBottom: 12 }}>
        <IconAlertTriangle size={32} color="var(--error)" />
      </div>
      <Text fw={700} size="lg" mb={6}>
        De-tokenize PHI Data
      </Text>
      <Text size="sm" c="dimmed" mb="sm" style={{ lineHeight: 1.6 }}>
        You are requesting real PHI values on a{" "}
        <strong>{activeConn?.env || "PRODUCTION"}</strong> connection. Tokens
        will be resolved server-side and real data returned to your session only.
      </Text>

      {/* HIPAA Warning */}
      <div
        style={{
          background: "rgba(215,54,54,0.08)",
          border: "1px solid rgba(215,54,54,0.25)",
          borderRadius: 8,
          padding: "12px 14px",
          fontSize: 12,
          color: "var(--error)",
          marginBottom: 16,
          lineHeight: 1.5,
        }}
      >
        Unauthorized PHI access is a HIPAA violation. Your IP, session, and
        timestamp will be logged.
      </div>

      {/* Token note */}
      <div
        style={{
          background: "rgba(31,145,150,0.08)",
          border: "1px solid rgba(31,145,150,0.25)",
          borderRadius: 8,
          padding: "10px 14px",
          fontSize: 11,
          color: "var(--token)",
          marginBottom: 16,
          lineHeight: 1.5,
          fontFamily: "IBM Plex Mono, monospace",
        }}
      >
        Tokens remain in query results after de-tokenization session ends. Real
        values are never cached or stored client-side.
      </div>

      <Select
        label="REASON FOR DE-TOKENIZATION"
        placeholder="Select a reason..."
        data={UNMASK_REASONS}
        value={reason}
        onChange={setReason}
        mb="sm"
        styles={{
          label: {
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.6,
            color: "var(--muted2)",
          },
        }}
      />

      <Textarea
        label="ADDITIONAL NOTES (OPTIONAL)"
        placeholder="Describe the specific need for accessing real PHI values..."
        value={notes}
        onChange={(e) => setNotes(e.currentTarget.value)}
        mb="lg"
        minRows={3}
        styles={{
          label: {
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.6,
            color: "var(--muted2)",
          },
        }}
      />

      <Group grow>
        <Button variant="subtle" color="gray" onClick={PhiUnmaskModal.close}>
          Cancel
        </Button>
        <Button color="red" disabled={!reason} onClick={handleConfirm}>
          De-tokenize PHI
        </Button>
      </Group>
    </Modal>
  );
}

// Static methods for external access
PhiUnmaskModal.open = () => {};
PhiUnmaskModal.close = () => {};
