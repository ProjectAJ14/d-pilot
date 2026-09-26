import { useState, useEffect, useMemo } from "react";
import {
  Text,
  Group,
  Button,
  Loader,
  Badge,
  SegmentedControl,
  Table,
  ScrollArea,
  Tooltip,
  TextInput,
  Pagination,
} from "@mantine/core";
import {
  IconRefresh,
  IconInboxOff,
  IconGitPullRequest,
  IconChevronRight,
  IconBell,
  IconSearch,
  IconUser,
  IconListDetails,
} from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";
import { api } from "../../utils/api-client";
import { notifyError } from "../../utils/notify-error";
import { useStore } from "../../store";
import type { WriteRequest } from "../../types";
import { StatusBadge, EnvBadge, VerdictBadge, fmtDateTime } from "./shared";

/**
 * One segment of the filter control: glyph, micro-label, count.
 *
 * The count is `dp-tnum` (tabular figures) so the three segments' numbers
 * share a width and sit in a readable column instead of jittering as they
 * update. A zero is dimmed rather than hidden — "0 need me" is information,
 * and a segment that changes width when it hits zero is worse.
 */
function FilterLabel({
  icon: Icon,
  label,
  count,
  active,
}: {
  icon: typeof IconBell;
  label: string;
  count: number;
  active: boolean;
}) {
  return (
    <Group
      gap={6}
      wrap="nowrap"
      // The selected segment carries accent ink at a heavier weight while the
      // others sit at --muted — the same current/not-current pairing the
      // top-bar nav and the sidebar section tabs use. The indicator tint alone
      // is not enough on paper, where it is a shade the ground already owns.
      style={{
        color: active ? "var(--accent-text)" : "var(--muted)",
        fontWeight: active ? 700 : 500,
      }}
    >
      <Icon size={13} stroke={1.6} />
      <span>{label}</span>
      <span
        className="dp-tnum"
        style={{
          color: active
            ? "inherit"
            : count > 0
              ? "var(--text)"
              : "var(--muted)",
        }}
      >
        {count}
      </span>
    </Group>
  );
}

/** Requests that need the current user's attention (approve, submit a draft, or revise their own). */
export function needsMyAction(r: WriteRequest): boolean {
  if (r.viewerCanApprove && r.status === "PENDING") return true;
  // A saved draft (yours, or one an agent left in an environment you can write
  // to) sits there doing nothing until someone submits or runs it.
  if (r.status === "DRAFT" && (r.viewerIsRequester || r.viewerCanSubmit))
    return true;
  if (r.viewerIsRequester && (r.status === "REJECTED" || r.status === "FAILED"))
    return true;
  return false;
}

export function countActionRequired(requests: WriteRequest[]): number {
  return requests.filter(needsMyAction).length;
}

/**
 * What the row wants from the viewer. A draft cannot be reviewed or approved —
 * the only move is to submit it — so a teammate's draft must not claim to be
 * "To review", and a row you can do nothing about must not claim either.
 */
function rowRole(r: WriteRequest): { label: string; color: string } {
  if (r.viewerIsRequester) return { label: "Mine", color: "blue" };
  if (r.status === "DRAFT" && r.viewerCanSubmit)
    return { label: "To submit", color: "grape" };
  if (r.viewerCanApprove && r.status === "PENDING")
    return { label: "To review", color: "grape" };
  return { label: "Theirs", color: "gray" };
}

/** Why the attention dot is lit — mirrors the branches in needsMyAction. */
function actionLabel(r: WriteRequest): string {
  if (r.viewerCanApprove && r.status === "PENDING")
    return "Awaiting your review";
  if (r.status === "DRAFT")
    return r.viewerIsRequester
      ? "Your saved draft — submit or run it"
      : "A saved draft you can submit";
  return "Needs your revision";
}

type Filter = "action" | "mine" | "all";

const PAGE_SIZE = 12;

function matchesSearch(r: WriteRequest, q: string): boolean {
  if (!q) return true;
  const hay = [
    r.title,
    r.description,
    r.connectionName,
    r.connectionId,
    r.requestedByEmail,
    r.status,
    r.env,
    r.dbType,
    r.aiVerdict,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

export function RequestsPage() {
  const navigate = useNavigate();
  const setActionRequiredCount = useStore((s) => s.setActionRequiredCount);
  const [requests, setRequests] = useState<WriteRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("action");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const load = () => {
    setLoading(true);
    api
      .getWriteRequests()
      .then((all) => {
        setRequests(all);
        setActionRequiredCount(countActionRequired(all));
      })
      .catch((e) => notifyError(e, "Requests"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(
    () => ({
      action: requests.filter(needsMyAction).length,
      mine: requests.filter((r) => r.viewerIsRequester).length,
      all: requests.length,
    }),
    [requests],
  );

  // Land on the most useful non-empty tab on first load.
  useEffect(() => {
    if (loading) return;
    if (counts.action > 0) setFilter("action");
    else if (counts.mine > 0) setFilter("mine");
    else setFilter("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const shown = useMemo(() => {
    const list = (
      filter === "action"
        ? requests.filter(needsMyAction)
        : filter === "mine"
          ? requests.filter((r) => r.viewerIsRequester)
          : requests
    ).filter((r) => matchesSearch(r, search));
    // Action-required first, then newest.
    return [...list].sort((a, b) => {
      const ax = needsMyAction(a) ? 0 : 1;
      const bx = needsMyAction(b) ? 0 : 1;
      if (ax !== bx) return ax - bx;
      return a.requestedAt < b.requestedAt ? 1 : -1;
    });
  }, [requests, filter, search]);

  // Reset to the first page whenever the result set changes.
  useEffect(() => setPage(1), [filter, search]);

  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const paged = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        overflow: "auto",
        background: "var(--bg)",
      }}
    >
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "24px 28px" }}>
        <Group justify="space-between" mb={4}>
          <Group gap={10}>
            <IconGitPullRequest size={22} color="var(--accent)" />
            <Text fw={700} size="xl" c="var(--text)">
              Requests
            </Text>
            {counts.action > 0 && (
              <Badge
                color="red"
                variant="filled"
                radius="sm"
                leftSection={<IconBell size={11} />}
              >
                {counts.action} need{counts.action === 1 ? "s" : ""} you
              </Badge>
            )}
          </Group>
          <Button
            size="xs"
            variant="subtle"
            leftSection={<IconRefresh size={14} />}
            onClick={load}
          >
            Refresh
          </Button>
        </Group>
        <Text size="sm" c="dimmed" mb="lg">
          Every change request you raised or can approve, in one place. Rows
          that need your attention are highlighted — approve/reject pending
          ones, or revise your rejected ones.
        </Text>

        <Group justify="space-between" mb="md" wrap="wrap" gap="sm">
          {/* Icon + micro-label + count. The count used to be "(0)" inside the
              label, which read as part of the sentence; as a tabular figure
              beside it, the three numbers line up and can be compared at a
              glance — which is the only reason they are on screen. The mono
              uppercase treatment comes from the theme, not from here. */}
          <SegmentedControl
            size="xs"
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
            styles={{
              // Mantine's indicator is one step off the control's own ground,
              // so the selected segment read as "slightly lighter" rather than
              // as selected. Accent tint plus an accent edge instead.
              root: { "--sc-color": "var(--selected)", "--sc-shadow": "none" },
              indicator: { border: "1px solid var(--accent)" },
            }}
            data={[
              {
                value: "action",
                label: (
                  <FilterLabel
                    icon={IconBell}
                    label="Needs me"
                    count={counts.action}
                    active={filter === "action"}
                  />
                ),
              },
              {
                value: "mine",
                label: (
                  <FilterLabel
                    icon={IconUser}
                    label="Mine"
                    count={counts.mine}
                    active={filter === "mine"}
                  />
                ),
              },
              {
                value: "all",
                label: (
                  <FilterLabel
                    icon={IconListDetails}
                    label="All"
                    count={counts.all}
                    active={filter === "all"}
                  />
                ),
              },
            ]}
          />
          <TextInput
            size="xs"
            placeholder="Search title, connection, requester, status…"
            leftSection={<IconSearch size={14} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            style={{ width: 320, maxWidth: "100%" }}
          />
        </Group>

        {loading ? (
          <Group justify="center" py="xl">
            <Loader size="sm" />
          </Group>
        ) : shown.length === 0 ? (
          <Group justify="center" py="xl" gap={8}>
            <IconInboxOff size={20} color="var(--muted)" />
            <Text size="sm" c="dimmed">
              {search
                ? "No requests match your search."
                : filter === "action"
                  ? "Nothing needs your attention right now."
                  : "No requests here yet."}
            </Text>
          </Group>
        ) : (
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-lg)",
              overflow: "hidden",
            }}
          >
            <ScrollArea>
              <Table
                highlightOnHover
                verticalSpacing="sm"
                horizontalSpacing="md"
                miw={860}
              >
                <Table.Thead style={{ background: "var(--surface2)" }}>
                  <Table.Tr>
                    <Table.Th style={{ width: 40 }}></Table.Th>
                    <Table.Th>Request</Table.Th>
                    <Table.Th style={{ width: 70 }}>Env</Table.Th>
                    <Table.Th style={{ width: 150 }}>Status</Table.Th>
                    <Table.Th style={{ width: 110 }}>AI</Table.Th>
                    <Table.Th style={{ width: 170 }}>Raised</Table.Th>
                    <Table.Th style={{ width: 40 }}></Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {paged.map((r) => {
                    const act = needsMyAction(r);
                    const role = rowRole(r);
                    return (
                      <Table.Tr
                        key={r.id}
                        onClick={() => navigate(`/write-requests/${r.id}`)}
                        style={{
                          cursor: "pointer",
                          borderLeft: act
                            ? "3px solid var(--mantine-color-red-filled)"
                            : "3px solid transparent",
                        }}
                      >
                        <Table.Td>
                          {act ? (
                            <Tooltip label={actionLabel(r)}>
                              <div
                                style={{
                                  width: 8,
                                  height: 8,
                                  borderRadius: "var(--radius-sm)",
                                  background: "var(--mantine-color-red-filled)",
                                }}
                              />
                            </Tooltip>
                          ) : null}
                        </Table.Td>
                        <Table.Td>
                          <Text
                            size="sm"
                            fw={600}
                            c="var(--text)"
                            truncate
                            style={{ maxWidth: 340 }}
                          >
                            {r.title}
                          </Text>
                          <Group gap={6} mt={2} wrap="nowrap">
                            <Badge size="xs" variant="light" color={role.color}>
                              {role.label}
                            </Badge>
                            <Text
                              size="xs"
                              c="dimmed"
                              ff="monospace"
                              truncate
                              style={{ maxWidth: 220 }}
                            >
                              {r.connectionName || r.connectionId}
                            </Text>
                          </Group>
                        </Table.Td>
                        <Table.Td>
                          <EnvBadge env={r.env} />
                        </Table.Td>
                        <Table.Td>
                          <StatusBadge status={r.status} />
                        </Table.Td>
                        <Table.Td>
                          {r.aiVerdict ? (
                            <VerdictBadge verdict={r.aiVerdict} />
                          ) : (
                            <Text size="xs" c="dimmed">
                              —
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed">
                            {fmtDateTime(r.requestedAt)}
                          </Text>
                          <Text
                            size="10px"
                            c="dimmed"
                            truncate
                            style={{ maxWidth: 160 }}
                          >
                            {r.requestedByEmail}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <IconChevronRight size={15} color="var(--muted)" />
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          </div>
        )}

        {!loading && shown.length > 0 && (
          <Group justify="space-between" mt="md">
            <Text size="xs" c="dimmed">
              {shown.length} request{shown.length === 1 ? "" : "s"}
              {pageCount > 1
                ? ` · showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, shown.length)}`
                : ""}
            </Text>
            {pageCount > 1 && (
              <Pagination
                size="sm"
                total={pageCount}
                value={page}
                onChange={setPage}
              />
            )}
          </Group>
        )}
      </div>
    </div>
  );
}
