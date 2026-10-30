import { useState } from "react";
import { Badge, Button, Loader, Text } from "@mantine/core";
import {
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconCode,
} from "@tabler/icons-react";
import type { DbObjectInfo, DbObjectKind, JobList } from "@src/types";
import { api } from "@src/utils/api-client";
import { nameMatches } from "@src/utils/explorer-search";
import { useStore } from "@src/store";
import { DriftReportModal } from "@src/components/query/drift-report";

const KIND_LABELS: [DbObjectKind, string][] = [
  ["procedure", "Procedures"],
  ["function", "Functions"],
  ["view", "Views"],
  ["trigger", "Triggers"],
];

/**
 * Procedures, functions, views and triggers under a connection's tables
 * (Postgres/SQL Server). Loaded on first expand, not with the tables, so
 * browsing tables costs nothing extra. Selecting one opens its definition as
 * a tab. The parent keys this on connection + schema, so a schema switch
 * starts it fresh.
 */
export function ObjectTree({
  connId,
  schema,
  query,
}: {
  connId: string;
  schema: string;
  query: string;
}) {
  const openObjectTab = useStore((s) => s.openObjectTab);
  const [open, setOpen] = useState(false);
  const [objects, setObjects] = useState<DbObjectInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [driftOpen, setDriftOpen] = useState(false);

  const toggle = () => {
    setOpen(!open);
    if (open || objects || loading) return;
    setLoading(true);
    setError(null);
    api
      .getObjects(connId, schema || undefined)
      .then(setObjects)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const shown = (objects ?? []).filter(
    (o) => !query || nameMatches(o.name, query),
  );

  return (
    <div style={{ paddingLeft: 14, paddingBottom: 4 }}>
      <div
        onClick={toggle}
        className="dp-row"
        role="button"
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
        }}
      >
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        <Text size="xs" c="dimmed" style={{ flex: 1, fontSize: 11 }}>
          Procedures, functions, views & triggers
          {objects && ` (${objects.length})`}
        </Text>
        {loading && <Loader size={10} color="var(--accent)" />}
      </div>

      {open && error && (
        <Text size="xs" c="red" style={{ fontSize: 10, padding: "4px 24px" }}>
          {error}
        </Text>
      )}
      {open && objects && (
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          ml={24}
          onClick={() => setDriftOpen(true)}
        >
          Drift report…
        </Button>
      )}
      {driftOpen && (
        <DriftReportModal
          connId={connId}
          schema={schema}
          opened
          onClose={() => setDriftOpen(false)}
        />
      )}
      {open && objects?.length === 0 && (
        <Text
          size="xs"
          c="dimmed"
          style={{ fontSize: 10, padding: "4px 24px" }}
        >
          None in this schema
        </Text>
      )}

      {open &&
        KIND_LABELS.map(([kind, heading]) => {
          const list = shown.filter((o) => o.kind === kind);
          if (!list.length) return null;
          return (
            <div key={kind} style={{ paddingLeft: 12 }}>
              <Text
                size="xs"
                c="dimmed"
                tt="uppercase"
                style={{ fontSize: 9, padding: "6px 10px 2px" }}
              >
                {heading} ({list.length})
              </Text>
              {list.map((o) => (
                <div
                  key={`${o.name}(${o.args ?? ""})${o.parent ?? ""}`}
                  onClick={() => openObjectTab(connId, o)}
                  className="dp-row"
                  role="button"
                  title={o.parent ? `on ${o.parent}` : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 10px",
                    borderRadius: "var(--radius-sm)",
                    cursor: "pointer",
                  }}
                >
                  <IconCode
                    size={12}
                    color="var(--accent)"
                    style={{ flexShrink: 0 }}
                  />
                  <Text
                    size="xs"
                    ff="monospace"
                    className="dp-row-label"
                    truncate
                    style={{ flex: 1, fontSize: 11 }}
                  >
                    {o.name}
                    {o.args != null && (
                      <Text span c="dimmed" inherit>
                        ({o.args})
                      </Text>
                    )}
                  </Text>
                  {o.parent && (
                    <Text
                      size="xs"
                      c="dimmed"
                      truncate
                      style={{ fontSize: 9, maxWidth: 90 }}
                    >
                      {o.parent}
                    </Text>
                  )}
                </div>
              ))}
            </div>
          );
        })}
    </div>
  );
}

/**
 * SQL Server Agent / pg_cron jobs that run against this connection's database.
 * Loaded on first expand. A connection without pg_cron shows nothing; one whose
 * login lacks the grant says which grant.
 */
export function JobTree({ connId, query }: { connId: string; query: string }) {
  const openJobTab = useStore((s) => s.openJobTab);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<JobList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = () => {
    setOpen(!open);
    if (open || list || loading) return;
    setLoading(true);
    api
      .getJobs(connId)
      .then(setList)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  // pg_cron not installed: nothing to show, so no node once we know.
  if (list && !list.available && !list.reason) return null;
  const jobs = (list?.jobs ?? []).filter(
    (j) => !query || nameMatches(j.name, query),
  );

  return (
    <div style={{ paddingLeft: 14, paddingBottom: 4 }}>
      <div
        onClick={toggle}
        className="dp-row"
        role="button"
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
        }}
      >
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        <Text size="xs" c="dimmed" style={{ flex: 1, fontSize: 11 }}>
          Scheduled jobs{list?.available && ` (${list.jobs.length})`}
        </Text>
        {loading && <Loader size={10} color="var(--accent)" />}
      </div>
      {open && (error || list?.reason) && (
        <Text
          size="xs"
          c="dimmed"
          style={{ fontSize: 10, padding: "4px 24px" }}
        >
          {error ?? list?.reason}
        </Text>
      )}
      {open && list?.available && jobs.length === 0 && (
        <Text
          size="xs"
          c="dimmed"
          style={{ fontSize: 10, padding: "4px 24px" }}
        >
          No jobs run against this database
        </Text>
      )}
      {open &&
        jobs.map((j) => (
          <div
            key={j.id}
            onClick={() => openJobTab(connId, { id: j.id, name: j.name })}
            className="dp-row"
            role="button"
            title={j.schedule}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 10px 5px 22px",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
            }}
          >
            <IconClock
              size={12}
              color={j.enabled ? "var(--accent)" : "var(--muted)"}
              style={{ flexShrink: 0 }}
            />
            <Text
              size="xs"
              className="dp-row-label"
              truncate
              style={{ flex: 1, fontSize: 11 }}
              c={j.enabled ? undefined : "dimmed"}
            >
              {j.name}
            </Text>
            {j.lastRun?.status === "failed" && (
              <Badge size="xs" color="red" variant="light">
                failed
              </Badge>
            )}
          </div>
        ))}
    </div>
  );
}
