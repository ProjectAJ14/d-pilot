import { useRef, useState } from "react";
import { Badge, Loader, Modal, Select, Table, Text } from "@mantine/core";
import type { DriftItem, DriftReport } from "../../types";
import { api } from "../../utils/api-client";
import { useStore } from "../../store";

const STATUS_COLOR: Record<DriftItem["status"], string> = {
  different: "orange",
  only_left: "blue",
  only_right: "violet",
};

/**
 * Every procedure, function, view and trigger in a schema that differs between
 * this connection and another — "does QA run what production runs?". The
 * server compares hashes of normalized definitions and returns names only;
 * a row opens the object with the other connection already diffed against it.
 */
export function DriftReportModal({
  connId,
  schema,
  opened,
  onClose,
}: {
  connId: string;
  schema: string;
  opened: boolean;
  onClose: () => void;
}) {
  const connections = useStore((s) => s.connections);
  const openObjectTab = useStore((s) => s.openObjectTab);
  const conn = connections.find((c) => c.id === connId);
  const [against, setAgainst] = useState<string | null>(null);
  const [report, setReport] = useState<DriftReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetched on pick, not in an effect; a later pick wins over an earlier
  // answer still in flight.
  const pick = (id: string | null) => {
    setAgainst(id);
    setReport(null);
    setError(null);
    if (!id) return;
    setLoading(true);
    api
      .getDrift(connId, id, schema || undefined)
      .then((r) => latest.current === id && setReport(r))
      .catch((err) => latest.current === id && setError(err.message))
      .finally(() => latest.current === id && setLoading(false));
    latest.current = id;
  };
  const latest = useRef<string | null>(null);

  const other = connections.find((c) => c.id === against);
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="lg"
      title={`Drift report — ${conn?.name ?? connId}${schema ? ` · ${schema}` : ""}`}
    >
      <Select
        size="xs"
        label="Compare with"
        placeholder="Pick a connection"
        data={connections
          .filter((c) => c.id !== connId && c.type === conn?.type)
          .map((c) => ({ value: c.id, label: `${c.env} · ${c.name}` }))}
        value={against}
        onChange={pick}
        searchable
        nothingFoundMessage="No other connection of this type"
        mb="sm"
      />
      {loading && <Loader size="sm" color="var(--accent)" />}
      {error && (
        <Text size="sm" c="red">
          {error}
        </Text>
      )}
      {report && !loading && against && (
        <>
          <Text size="xs" c="dimmed" mb="xs">
            {report.items.length
              ? `${report.items.length} differ, ${report.identical} identical.`
              : `All ${report.identical} objects are identical on ${other?.name}.`}
          </Text>
          {report.items.length > 0 && (
            <Table highlightOnHover verticalSpacing={4} fz="xs">
              <Table.Tbody>
                {report.items.map((item) => (
                  <Table.Tr
                    key={`${item.kind}:${item.name}(${item.args ?? ""})@${item.parent ?? ""}`}
                    style={{ cursor: "pointer" }}
                    onClick={() => {
                      // Open it where it exists; a one-sided object diffs
                      // against an empty other side.
                      const [here, there] =
                        item.status === "only_right"
                          ? [against, connId]
                          : [connId, against];
                      const { status: _s, ...object } = item;
                      openObjectTab(here, object, there);
                      onClose();
                    }}
                  >
                    <Table.Td c="dimmed">{item.kind}</Table.Td>
                    <Table.Td ff="monospace">
                      {item.name}
                      {item.args != null && `(${item.args})`}
                      {item.parent && (
                        <Text span c="dimmed" inherit>
                          {" "}
                          on {item.parent}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        size="xs"
                        variant="light"
                        color={STATUS_COLOR[item.status]}
                      >
                        {item.status === "different"
                          ? "differs"
                          : `only on ${(item.status === "only_left" ? conn : other)?.name}`}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </>
      )}
    </Modal>
  );
}
