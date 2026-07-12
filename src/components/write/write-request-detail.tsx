import { useState, useEffect, useCallback } from "react";
import {
  Text,
  Group,
  Button,
  Loader,
  Alert,
  Badge,
  Tooltip,
  Textarea,
  Modal,
  Divider,
  CopyButton,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconLink,
  IconCheck,
  IconPlayerPlay,
  IconSparkles,
  IconThumbUp,
  IconThumbDown,
  IconX,
  IconAlertTriangle,
  IconDatabase,
  IconClock,
  IconEdit,
  IconCopyPlus,
  IconEye,
  IconArrowBarToUp,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "../../utils/api-client";
import { useStore } from "../../store";
import { countActionRequired } from "./requests-page";
import type {
  WriteRequest,
  WriteAiReview,
  QueryResult,
  ConnectionInfo,
} from "../../types";
import {
  EnvBadge,
  AiReviewCard,
  PreviewTable,
  SqlBlock,
  fmtDateTime,
  STATUS_META,
} from "./shared";
import { WriteComposer } from "./write-composer";

export function WriteRequestDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const setActionRequiredCount = useStore((s) => s.setActionRequiredCount);
  const setWriteHandoff = useStore((s) => s.setWriteHandoff);
  const canWrite = useStore((s) => !!s.user?.canWrite);

  // Keep the "needs my action" nav badge accurate after acting on a request.
  const refreshBadge = () =>
    api
      .getWriteRequests()
      .then((all) => setActionRequiredCount(countActionRequired(all)))
      .catch(() => {});

  const [wr, setWr] = useState<WriteRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [aiReview, setAiReview] = useState<WriteAiReview | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const [decisionModal, setDecisionModal] = useState<
    "approve" | "reject" | null
  >(null);
  const [notes, setNotes] = useState("");
  const [deciding, setDeciding] = useState(false);

  // Edit & resubmit — reuses the full write composer
  const [editOpen, setEditOpen] = useState(false);
  const [directEnvs, setDirectEnvs] = useState<string[]>([]);
  const [writeModeEnabled, setWriteModeEnabled] = useState(true);

  useEffect(() => {
    api
      .getWritePolicy()
      .then((p) => {
        setDirectEnvs(p.directEnvs);
        setWriteModeEnabled(p.writeModeEnabled);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    api
      .getWriteRequest(id)
      .then((r) => {
        setWr(r);
        if (r.aiReview) setAiReview(r.aiReview);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const runPreview = async () => {
    if (!id) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      setPreview(await api.previewWriteRequest(id));
    } catch (e: any) {
      setPreviewError(e.message);
    } finally {
      setPreviewLoading(false);
    }
  };

  const runAiReview = async () => {
    if (!id) return;
    setAiLoading(true);
    try {
      const r = await api.aiReviewWriteRequest(id);
      setAiReview(r);
      load();
    } catch (e: any) {
      notifications.show({ message: e.message, color: "red" });
    } finally {
      setAiLoading(false);
    }
  };

  const submitDecision = async () => {
    if (!id || !decisionModal) return;
    setDeciding(true);
    try {
      if (decisionModal === "approve") {
        const updated = await api.approveWriteRequest(
          id,
          notes.trim() || undefined,
        );
        notifications.show({
          title: "Approved & executed",
          message: `${updated.rowsAffected ?? 0} row(s) affected`,
          color: "green",
          icon: <IconCheck size={16} />,
        });
      } else {
        await api.rejectWriteRequest(id, notes.trim() || undefined);
        notifications.show({ message: "Request rejected", color: "orange" });
      }
      setDecisionModal(null);
      setNotes("");
      load();
      refreshBadge();
    } catch (e: any) {
      notifications.show({
        title: "Action failed",
        message: e.message,
        color: "red",
      });
      load();
    } finally {
      setDeciding(false);
    }
  };

  const handleCancel = async () => {
    if (!id) return;
    try {
      await api.cancelWriteRequest(id);
      notifications.show({ message: "Request cancelled", color: "gray" });
      load();
      refreshBadge();
    } catch (e: any) {
      notifications.show({ message: e.message, color: "red" });
    }
  };

  // Pre-fill a brand-new request from this one (e.g. re-run on another env).
  const duplicate = () => {
    if (!wr) return;
    setWriteHandoff({
      title: `Copy of ${wr.title}`,
      description: wr.description,
      connectionId: wr.connectionId,
      selectSql: wr.selectSql,
      writeSql: wr.writeSql,
    });
    navigate("/write");
  };

  if (loading) {
    return (
      <Group justify="center" style={{ flex: 1 }} py="xl">
        <Loader />
      </Group>
    );
  }

  if (error || !wr) {
    return (
      <div style={{ flex: 1, overflow: "auto" }}>
        <div style={{ maxWidth: 720, margin: "40px auto", padding: "0 28px" }}>
          <Button
            variant="subtle"
            leftSection={<IconArrowLeft size={14} />}
            onClick={() => navigate(-1)}
            mb="lg"
          >
            Back
          </Button>
          <Alert
            color="red"
            title="Cannot open request"
            icon={<IconAlertTriangle size={16} />}
          >
            {error || "Write request not found"}
          </Alert>
        </div>
      </div>
    );
  }

  const canApprove = wr.viewerCanApprove && wr.status === "PENDING";
  const canCancel = wr.viewerIsRequester && wr.status === "PENDING";
  const canRevise =
    wr.viewerIsRequester &&
    ["REJECTED", "CANCELLED", "FAILED"].includes(wr.status);
  // The request's connection, as a single locked option for the edit composer.
  const editConnections: ConnectionInfo[] = [
    {
      id: wr.connectionId,
      name: wr.connectionName || wr.connectionId,
      env: wr.env,
      type: wr.dbType,
    },
  ];
  const dangerous =
    aiReview?.verdict === "DANGEROUS" ||
    /unbounded/i.test(aiReview?.estimatedBlastRadius || "");

  const statusMeta = STATUS_META[wr.status] || {
    label: wr.status,
    color: "gray",
  };
  const previewNote = preview
    ? `Preview ran · ${preview.totalRows} row(s) returned`
    : "Runs the verify SELECT only — read-only, changes nothing";
  const showAiButton = wr.status !== "EXECUTED";
  const showDecisionBar = canApprove || canCancel || showAiButton;

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        overflow: "auto",
        background: "var(--bg)",
      }}
    >
      <div style={{ maxWidth: 940, margin: "0 auto", padding: "24px 28px 60px" }}>
        <Group justify="space-between" mb="lg">
          <Button
            variant="subtle"
            color="gray"
            size="sm"
            px={6}
            leftSection={<IconArrowLeft size={15} />}
            onClick={() => navigate(-1)}
          >
            Back to requests
          </Button>
          <Group gap={8}>
            {canWrite && (
              <Button
                size="xs"
                variant="default"
                leftSection={<IconCopyPlus size={14} />}
                onClick={duplicate}
              >
                Duplicate
              </Button>
            )}
            <CopyButton value={window.location.href}>
              {({ copied, copy }) => (
                <Button
                  size="xs"
                  variant="default"
                  color={copied ? "teal" : undefined}
                  leftSection={
                    copied ? <IconCheck size={14} /> : <IconLink size={14} />
                  }
                  onClick={copy}
                >
                  {copied ? "Link copied" : "Copy share link"}
                </Button>
              )}
            </CopyButton>
          </Group>
        </Group>

        {/* Title + status */}
        <Group gap={12} mb={10} align="center" wrap="wrap">
          <Text
            fw={700}
            c="secondary.9"
            style={{ fontSize: 26, lineHeight: 1.2, letterSpacing: "-0.02em" }}
          >
            {wr.title}
          </Text>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontSize: 11.5,
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: `var(--mantine-color-${statusMeta.color}-8)`,
              background: `var(--mantine-color-${statusMeta.color}-1)`,
              borderRadius: 999,
              padding: "4px 11px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: `var(--mantine-color-${statusMeta.color}-6)`,
              }}
            />
            {statusMeta.label}
          </span>
        </Group>

        {/* Metadata strip */}
        <Group gap={12} mb="lg" align="center" wrap="wrap">
          <Group gap={6}>
            <IconDatabase size={13} color="var(--muted)" />
            <Text size="xs" c="dimmed" ff="monospace">
              {wr.connectionName || wr.connectionId} · {wr.dbType}
            </Text>
          </Group>
          <span style={{ width: 1, height: 13, background: "var(--border)" }} />
          <EnvBadge env={wr.env} />
          <span style={{ width: 1, height: 13, background: "var(--border)" }} />
          <Text size="xs" c="dimmed" ff="monospace">
            {wr.requestedByEmail}
          </Text>
          <span style={{ width: 1, height: 13, background: "var(--border)" }} />
          <Group gap={6}>
            <IconClock size={13} color="var(--muted)" />
            <Text size="xs" c="dimmed" ff="monospace">
              {fmtDateTime(wr.requestedAt)}
            </Text>
          </Group>
        </Group>

        {wr.description && (
          <Text size="sm" c="secondary.9" mb="md" style={{ lineHeight: 1.6 }}>
            {wr.description}
          </Text>
        )}

        {/* Outcome banners */}
        {wr.status === "EXECUTED" && (
          <Alert
            color="green"
            mb="md"
            icon={<IconCheck size={16} />}
            title="Executed"
          >
            {wr.rowsAffected ?? 0} row(s) affected in {wr.executionMs ?? 0}ms
            {wr.transactional === false &&
              " · ran non-transactionally (no rollback available on this engine)"}
            {wr.executedByEmail && ` · executed by ${wr.executedByEmail}`} ·{" "}
            {fmtDateTime(wr.executedAt)}
          </Alert>
        )}
        {wr.status === "FAILED" && (
          <Alert
            color="red"
            mb="md"
            icon={<IconAlertTriangle size={16} />}
            title="Execution failed"
          >
            {wr.executionError || "The write failed to execute."}
          </Alert>
        )}
        {wr.status === "REJECTED" && (
          <Alert
            color="red"
            mb="md"
            variant="light"
            icon={<IconThumbDown size={16} />}
            title={`Rejected by ${wr.reviewedByEmail || "reviewer"}`}
          >
            {wr.reviewNotes || "No reason provided."}
          </Alert>
        )}

        {/* Edit & resubmit CTA for the requester on a revisable request */}
        {canRevise && (
          <Alert
            color="grape"
            mb="md"
            variant="light"
            icon={<IconEdit size={16} />}
            title="Needs changes"
          >
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm">
                Edit the query and resubmit it for a fresh review — the share
                link stays the same.
              </Text>
              <Button
                size="xs"
                color="grape"
                leftSection={<IconEdit size={14} />}
                onClick={() => setEditOpen(true)}
                style={{ flexShrink: 0 }}
              >
                Edit &amp; resubmit
              </Button>
            </Group>
          </Alert>
        )}

        {/* Review card */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            padding: 26,
            boxShadow:
              "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -18px rgba(15,23,42,0.18)",
          }}
        >
          {/* Queries — write first, verify second */}
          <div
            style={{ display: "flex", flexDirection: "column", gap: 22 }}
          >
            <SqlBlock
              step={1}
              label="Write statement"
              hint="the change this request will apply · single INSERT / UPDATE / DELETE"
              code={wr.writeSql}
              dbType={wr.dbType}
              accent="orange"
              barTone="amber"
              barLabel="WRITES DATA — RUNS ON APPROVAL"
              barIcon={<IconArrowBarToUp size={13} />}
            />
            <SqlBlock
              step={2}
              label="Verify SELECT"
              hint="a read-only query that previews the rows the write will affect"
              code={wr.selectSql}
              dbType={wr.dbType}
              accent="gray"
              barTone="neutral"
              barLabel="READ-ONLY PREVIEW QUERY"
              barIcon={<IconEye size={13} />}
              footer={
                <Group gap={12} align="center" wrap="nowrap">
                  <Tooltip
                    label={`You need read access to ${wr.env} to preview rows`}
                    disabled={wr.viewerCanPreview !== false}
                  >
                    <Button
                      size="xs"
                      variant="default"
                      leftSection={<IconPlayerPlay size={14} />}
                      onClick={runPreview}
                      loading={previewLoading}
                      disabled={!wr.selectSql || wr.viewerCanPreview === false}
                    >
                      Run this SELECT
                    </Button>
                  </Tooltip>
                  <Text size="xs" c="dimmed">
                    {previewNote}
                  </Text>
                </Group>
              }
            />
          </div>

          {previewError && (
            <Alert color="red" mt="md" variant="light">
              {previewError}
            </Alert>
          )}
          {preview && (
            <div style={{ marginTop: 16 }}>
              <PreviewTable result={preview} />
            </div>
          )}

          {/* AI review panel — inline, above the decision bar */}
          {(aiLoading || aiReview) && (
            <div style={{ marginTop: 20 }}>
              {aiLoading ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    background: "var(--surface2)",
                    padding: "14px 16px",
                  }}
                >
                  <Loader size={16} color="grape" />
                  <Text size="sm" c="dimmed">
                    Analyzing the write and verify SELECT…
                  </Text>
                </div>
              ) : aiReview ? (
                <AiReviewCard review={aiReview} />
              ) : null}
            </div>
          )}

          {/* Decision bar */}
          {showDecisionBar && (
            <>
              <Divider my="lg" />
              {canApprove && dangerous && (
                <Alert
                  color="red"
                  mb="md"
                  variant="light"
                  icon={<IconAlertTriangle size={16} />}
                >
                  AI flagged this write as high-risk. Review the preview and
                  blast radius carefully before approving.
                </Alert>
              )}
              <Group justify="space-between" align="center" wrap="wrap" gap={12}>
                <div>
                  {showAiButton && (
                    <Button
                      variant="light"
                      color="primary"
                      leftSection={<IconSparkles size={16} />}
                      onClick={runAiReview}
                      loading={aiLoading}
                    >
                      {aiReview ? "Re-run AI review" : "Review with AI"}
                    </Button>
                  )}
                </div>
                <Group gap={10}>
                  {canApprove && (
                    <>
                      <Button
                        variant="default"
                        leftSection={<IconThumbDown size={16} />}
                        onClick={() => {
                          setNotes("");
                          setDecisionModal("reject");
                        }}
                        style={{
                          color: "var(--mantine-color-red-7)",
                          borderColor: "var(--mantine-color-red-3)",
                        }}
                      >
                        Reject
                      </Button>
                      <Button
                        color="green"
                        leftSection={<IconThumbUp size={16} />}
                        onClick={() => {
                          setNotes("");
                          setDecisionModal("approve");
                        }}
                      >
                        Approve &amp; run
                      </Button>
                    </>
                  )}
                  {canCancel && (
                    <Button
                      variant="default"
                      color="gray"
                      leftSection={<IconX size={16} />}
                      onClick={handleCancel}
                    >
                      Cancel request
                    </Button>
                  )}
                </Group>
              </Group>
            </>
          )}

          {wr.status === "PENDING" && !wr.viewerCanApprove && !canCancel && (
            <Alert
              color="gray"
              variant="light"
              mt="md"
              icon={<IconClock size={16} />}
            >
              Waiting for an approver in {wr.env}.
            </Alert>
          )}

          {/* Timeline */}
          {wr.events && wr.events.length > 0 && (
            <>
              <Divider
                my="lg"
                labelPosition="left"
                label={
                  <Text
                    size="xs"
                    fw={700}
                    c="dimmed"
                    tt="uppercase"
                    style={{ letterSpacing: 0.6 }}
                  >
                    Activity
                  </Text>
                }
              />
              <div
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                {wr.events.map((ev) => (
                  <Group key={ev.id} gap={10} wrap="nowrap" align="flex-start">
                    <span
                      style={{
                        flexShrink: 0,
                        width: 8,
                        height: 8,
                        marginTop: 5,
                        borderRadius: "50%",
                        background: `var(--mantine-color-${EVENT_COLORS[ev.event] || "gray"}-6)`,
                      }}
                    />
                    <Badge
                      size="xs"
                      variant="light"
                      color={EVENT_COLORS[ev.event] || "gray"}
                      style={{ minWidth: 96, overflow: "visible" }}
                    >
                      {ev.event}
                    </Badge>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text size="xs" c="secondary.9">
                        {ev.actorEmail}
                        {ev.notes ? (
                          <Text component="span" size="xs" c="dimmed">
                            {" "}
                            — {ev.notes}
                          </Text>
                        ) : null}
                      </Text>
                      <Text size="10px" c="dimmed">
                        {fmtDateTime(ev.timestamp)}
                      </Text>
                    </div>
                  </Group>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Decision modal */}
      <Modal
        opened={!!decisionModal}
        onClose={() => setDecisionModal(null)}
        centered
        radius={16}
        size={460}
        overlayProps={{ backgroundOpacity: 0.55, blur: 3 }}
        title={
          <Group gap={12} align="center" wrap="nowrap">
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background:
                  decisionModal === "reject"
                    ? "var(--mantine-color-red-1)"
                    : "var(--mantine-color-green-1)",
                color:
                  decisionModal === "reject"
                    ? "var(--mantine-color-red-7)"
                    : "var(--mantine-color-green-7)",
              }}
            >
              {decisionModal === "reject" ? (
                <IconAlertTriangle size={20} />
              ) : (
                <IconThumbUp size={20} />
              )}
            </div>
            <Text fw={700} size="md" c="secondary.9">
              {decisionModal === "approve"
                ? "Approve & run write"
                : "Reject write request"}
            </Text>
          </Group>
        }
      >
        {decisionModal === "reject" ? (
          <Text size="sm" c="dimmed" mb="md">
            The requester will be notified and this can&apos;t be undone.
          </Text>
        ) : (
          <Alert
            color={dangerous ? "red" : "yellow"}
            variant="light"
            mb="md"
            icon={<IconAlertTriangle size={16} />}
          >
            This will execute the write statement against{" "}
            <strong>{wr.connectionName || wr.connectionId}</strong> ({wr.env})
            immediately.
            {wr.transactional === false ? " This engine cannot roll back." : ""}
          </Alert>
        )}
        <Textarea
          label={
            decisionModal === "approve"
              ? "Approval note (optional)"
              : "Reason for rejection"
          }
          required={decisionModal === "reject"}
          placeholder={
            decisionModal === "approve"
              ? "Looks correct, verified against preview…"
              : "Explain why this is being rejected…"
          }
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
          autosize
          minRows={decisionModal === "reject" ? 3 : 2}
          mb="lg"
        />
        <Group justify="flex-end" gap={8}>
          <Button variant="default" onClick={() => setDecisionModal(null)}>
            Cancel
          </Button>
          <Button
            color={decisionModal === "approve" ? "green" : "red"}
            loading={deciding}
            disabled={decisionModal === "reject" && !notes.trim()}
            onClick={submitDecision}
          >
            {decisionModal === "approve" ? "Approve & run" : "Reject request"}
          </Button>
        </Group>
      </Modal>

      {/* Edit & resubmit — the same composer as creating, pre-filled */}
      <Modal
        opened={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit & resubmit"
        size="xl"
      >
        <WriteComposer
          mode="revise"
          connections={editConnections}
          lockConnectionId={wr.connectionId}
          directEnvs={directEnvs}
          writeModeEnabled={writeModeEnabled}
          showNote
          initial={{
            title: wr.title,
            description: wr.description,
            connectionId: wr.connectionId,
            selectSql: wr.selectSql,
            writeSql: wr.writeSql,
          }}
          onSubmit={(p) =>
            api.reviseWriteRequest(wr.id, {
              title: p.title,
              description: p.description,
              selectSql: p.selectSql,
              writeSql: p.writeSql,
              note: p.note,
            })
          }
          onSubmitted={() => {
            setEditOpen(false);
            setPreview(null);
            setAiReview(null);
            load();
            refreshBadge();
          }}
          onCancel={() => setEditOpen(false)}
        />
      </Modal>
    </div>
  );
}

const EVENT_COLORS: Record<string, string> = {
  SUBMITTED: "blue",
  AI_REVIEWED: "violet",
  APPROVED: "green",
  AUTO_APPROVED: "teal",
  EXECUTED: "green",
  REJECTED: "red",
  RESUBMITTED: "grape",
  FAILED: "red",
  CANCELLED: "gray",
};
