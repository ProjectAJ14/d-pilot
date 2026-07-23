import { useState, type ReactNode } from "react";
import Editor from "@monaco-editor/react";
import {
  Badge,
  Text,
  Group,
  ScrollArea,
  Table,
  Tooltip,
  Button,
} from "@mantine/core";
import {
  IconShieldCheck,
  IconAlertTriangle,
  IconFlame,
  IconShieldLock,
  IconWand,
} from "@tabler/icons-react";
import type {
  WriteRequestStatus,
  WriteAiReview,
  QueryResult,
  Environment,
  DatabaseType,
} from "../../types";

function monacoLang(dbType?: DatabaseType): string {
  if (dbType === "mongodb") return "javascript";
  if (dbType === "elasticsearch") return "plaintext";
  return "sql";
}

/** Small numbered circle used to head each step in the write flow. */
export function StepBadge({ n }: { n: number }) {
  return (
    <span
      style={{
        flexShrink: 0,
        width: 20,
        height: 20,
        borderRadius: 999,
        background: "rgba(31,145,150,0.12)",
        color: "var(--accent)",
        fontSize: 12,
        fontWeight: 700,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {n}
    </span>
  );
}

/** Read-only, syntax-highlighted query view that auto-sizes to its content. */
export function SqlView({
  code,
  dbType,
}: {
  code: string;
  dbType?: DatabaseType;
}) {
  const [height, setHeight] = useState(48);
  return (
    <Editor
      height={height}
      language={monacoLang(dbType)}
      theme="vs"
      value={code}
      onMount={(editor: any) => {
        const update = () =>
          setHeight(Math.min(Math.max(editor.getContentHeight(), 40), 360));
        update();
        editor.onDidContentSizeChange(update);
      }}
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        wordWrap: "on",
        fontSize: 13,
        fontFamily: "IBM Plex Mono, monospace",
        padding: { top: 8, bottom: 8 },
        automaticLayout: true,
        renderLineHighlight: "none",
        overviewRulerLanes: 0,
        folding: false,
        contextmenu: false,
        scrollbar: {
          vertical: "auto",
          horizontal: "auto",
          alwaysConsumeMouseWheel: false,
        },
        guides: { indentation: false },
      }}
    />
  );
}

/** Labelled, accent-bordered read-only query block (used on the request detail). */
export function SqlBlock({
  label,
  code,
  dbType,
  accent = "gray",
  step,
  hint,
  barLabel,
  barIcon,
  barTone = "neutral",
  footer,
}: {
  label: string;
  code: string;
  dbType?: DatabaseType;
  accent?: string;
  /** Optional numbered step badge to head the block. */
  step?: number;
  /** Optional muted hint shown after the label. */
  hint?: string;
  /** Optional colored header bar inside the box stating the query's nature. */
  barLabel?: string;
  barIcon?: ReactNode;
  barTone?: "amber" | "neutral";
  /** Optional footer row rendered inside the box, below the code. */
  footer?: ReactNode;
}) {
  const bar =
    barTone === "amber"
      ? {
          color: "#b47707",
          background: "rgba(224,160,32,0.10)",
          border: "rgba(224,160,32,0.28)",
        }
      : {
          color: "var(--muted)",
          background: "var(--surface2)",
          border: "var(--border)",
        };
  return (
    <div>
      {step != null ? (
        <Group gap={8} mb={7} align="center">
          <StepBadge n={step} />
          <Text size="sm" fw={600} c="secondary.9">
            {label}
          </Text>
          {hint && (
            <Text size="xs" c="dimmed">
              {hint}
            </Text>
          )}
        </Group>
      ) : (
        <Text
          size="xs"
          fw={700}
          tt="uppercase"
          c="dimmed"
          mb={4}
          style={{ letterSpacing: 0.5 }}
        >
          {label}
        </Text>
      )}
      <div
        style={{
          border: `1px solid var(--mantine-color-${accent}-3, var(--border))`,
          borderRadius: 12,
          overflow: "hidden",
          background: "var(--surface)",
        }}
      >
        {barLabel && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "8px 14px",
              borderBottom: `1px solid ${bar.border}`,
              background: bar.background,
              color: bar.color,
              fontSize: 11.5,
              fontWeight: 700,
              letterSpacing: "0.04em",
            }}
          >
            {barIcon}
            {barLabel}
          </div>
        )}
        {code?.trim() ? (
          <SqlView code={code} dbType={dbType} />
        ) : (
          <div
            style={{
              padding: "10px 14px",
              fontFamily: "IBM Plex Mono, monospace",
              fontSize: 12.5,
              color: "var(--muted)",
            }}
          >
            (empty)
          </div>
        )}
        {footer && (
          <div
            style={{
              borderTop: "1px solid var(--border)",
              background: "var(--surface2)",
              padding: "9px 12px",
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export const ENV_COLORS: Record<string, string> = {
  PROD: "red",
  STG: "orange",
  UAT: "teal",
  QA: "violet",
  DEV: "green",
};

export const STATUS_META: Record<
  WriteRequestStatus,
  { label: string; color: string }
> = {
  DRAFT: { label: "Draft", color: "gray" },
  PENDING: { label: "Pending approval", color: "yellow" },
  APPROVED: { label: "Approved", color: "blue" },
  EXECUTED: { label: "Executed", color: "green" },
  FAILED: { label: "Failed", color: "red" },
  REJECTED: { label: "Rejected", color: "red" },
  CANCELLED: { label: "Cancelled", color: "gray" },
};

export function StatusBadge({ status }: { status: WriteRequestStatus }) {
  const meta = STATUS_META[status] || { label: status, color: "gray" };
  return (
    <Badge
      size="sm"
      radius="sm"
      variant="light"
      color={meta.color}
      style={{ overflow: "visible" }}
    >
      {meta.label}
    </Badge>
  );
}

export function EnvBadge({ env }: { env: Environment | string }) {
  return (
    <Badge
      size="xs"
      radius="sm"
      variant="light"
      color={ENV_COLORS[env] || "gray"}
      style={{ overflow: "visible" }}
    >
      {env}
    </Badge>
  );
}

const VERDICT_META: Record<
  string,
  { color: string; icon: typeof IconShieldCheck; label: string }
> = {
  SAFE: { color: "green", icon: IconShieldCheck, label: "Safe" },
  CAUTION: { color: "orange", icon: IconAlertTriangle, label: "Caution" },
  DANGEROUS: { color: "red", icon: IconFlame, label: "Dangerous" },
};

export function VerdictBadge({ verdict }: { verdict?: string }) {
  if (!verdict) return null;
  const meta = VERDICT_META[verdict] || VERDICT_META.CAUTION;
  const Icon = meta.icon;
  return (
    <Badge
      size="sm"
      radius="sm"
      variant="filled"
      color={meta.color}
      leftSection={<Icon size={12} />}
      style={{ overflow: "visible" }}
    >
      {meta.label}
    </Badge>
  );
}

export function AiReviewCard({
  review,
  onApply,
}: {
  review: WriteAiReview;
  /** When provided, shows an "Apply suggested queries" button. */
  onApply?: (suggested: { writeSql?: string; selectSql?: string }) => void;
}) {
  const meta = VERDICT_META[review.verdict] || VERDICT_META.CAUTION;
  const unbounded = /unbounded/i.test(review.estimatedBlastRadius ?? "");
  const hasSuggestion = !!(
    review.suggestedWriteSql || review.suggestedSelectSql
  );
  return (
    <div
      style={{
        border: `1px solid var(--mantine-color-${meta.color}-4)`,
        background: `var(--mantine-color-${meta.color}-0)`,
        borderRadius: 10,
        padding: 16,
      }}
    >
      <Group justify="space-between" mb={8}>
        <Group gap={8}>
          <VerdictBadge verdict={review.verdict} />
          {review.estimatedBlastRadius && (
            <Badge size="xs" variant="light" color={unbounded ? "red" : "gray"}>
              Blast radius: {review.estimatedBlastRadius}
            </Badge>
          )}
          {review.selectMatchesWrite !== undefined && (
            <Badge
              size="xs"
              variant="light"
              color={review.selectMatchesWrite ? "green" : "orange"}
            >
              {review.selectMatchesWrite
                ? "SELECT matches WRITE"
                : "SELECT may not match WRITE"}
            </Badge>
          )}
        </Group>
        {review.model && (
          <Text size="10px" c="dimmed" ff="monospace">
            {review.model}
          </Text>
        )}
      </Group>
      <Text
        size="sm"
        c="secondary.9"
        mb={review.risks.length ? 10 : 0}
        style={{ lineHeight: 1.6 }}
      >
        {review.summary}
      </Text>
      {review.risks.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {review.risks.map((r, i) => (
            <Group key={i} gap={6} wrap="nowrap" align="flex-start">
              <IconAlertTriangle
                size={13}
                color={`var(--mantine-color-${meta.color}-6)`}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <Text size="xs" c="secondary.9">
                {r}
              </Text>
            </Group>
          ))}
        </div>
      )}
      <Text size="xs" c="dimmed" mt={10}>
        Recommendation: <strong>{review.recommendation}</strong>
      </Text>

      {hasSuggestion && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: `1px dashed var(--mantine-color-${meta.color}-3)`,
          }}
        >
          <Group justify="space-between" mb={6} wrap="nowrap">
            <Group gap={6}>
              <IconWand
                size={14}
                color={`var(--mantine-color-${meta.color}-7)`}
              />
              <Text size="xs" fw={700} c="secondary.9">
                Suggested correction
              </Text>
            </Group>
            {onApply && (
              <Button
                size="compact-xs"
                color={meta.color}
                leftSection={<IconWand size={12} />}
                onClick={() =>
                  onApply({
                    writeSql: review.suggestedWriteSql,
                    selectSql: review.suggestedSelectSql,
                  })
                }
              >
                Apply suggestion
              </Button>
            )}
          </Group>
          {review.suggestedWriteSql && (
            <div style={{ marginBottom: review.suggestedSelectSql ? 8 : 0 }}>
              <SuggestedSql
                label="Write statement"
                code={review.suggestedWriteSql}
              />
            </div>
          )}
          {review.suggestedSelectSql && (
            <SuggestedSql
              label="Verify SELECT"
              code={review.suggestedSelectSql}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SuggestedSql({ label, code }: { label: string; code: string }) {
  return (
    <div>
      <Text
        size="10px"
        fw={700}
        tt="uppercase"
        c="dimmed"
        mb={2}
        style={{ letterSpacing: 0.4 }}
      >
        {label}
      </Text>
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          background: "var(--surface, #fff)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          fontSize: 12,
          fontFamily: "IBM Plex Mono, monospace",
          lineHeight: 1.5,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {code}
      </pre>
    </div>
  );
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function PreviewTable({ result }: { result: QueryResult }) {
  if (!result.columns.length) {
    return (
      <Text size="sm" c="dimmed">
        Query returned no columns.
      </Text>
    );
  }
  return (
    <div>
      <Group gap={8} mb={6}>
        <Text size="xs" c="dimmed">
          {result.totalRows} row{result.totalRows !== 1 ? "s" : ""} ·{" "}
          {result.executionTimeMs}ms
          {result.truncated ? " · truncated" : ""}
        </Text>
        {result.masked && (
          <Badge
            size="xs"
            variant="light"
            color="teal"
            leftSection={<IconShieldLock size={10} />}
          >
            PHI masked
          </Badge>
        )}
      </Group>
      <ScrollArea.Autosize mah={320} type="auto">
        <Table
          striped
          highlightOnHover
          withTableBorder
          stickyHeader
          verticalSpacing={4}
          horizontalSpacing="sm"
        >
          <Table.Thead>
            <Table.Tr>
              {result.columns.map((c) => (
                <Table.Th key={c.name} style={{ whiteSpace: "nowrap" }}>
                  <Group gap={4} wrap="nowrap">
                    <Text size="xs" fw={700} ff="monospace">
                      {c.name}
                    </Text>
                    {c.isMasked && (
                      <Tooltip label={`Masked (${c.maskingType})`}>
                        <IconShieldLock
                          size={11}
                          color="var(--mantine-color-teal-6)"
                        />
                      </Tooltip>
                    )}
                  </Group>
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {result.rows.map((row, i) => (
              <Table.Tr key={i}>
                {result.columns.map((c) => (
                  <Table.Td
                    key={c.name}
                    style={{
                      whiteSpace: "nowrap",
                      maxWidth: 320,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    <Text size="xs" ff="monospace">
                      {renderCell(row[c.name])}
                    </Text>
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea.Autosize>
    </div>
  );
}

export function CodeBlock({
  label,
  code,
  color = "gray",
}: {
  label: string;
  code: string;
  color?: string;
}) {
  return (
    <div>
      <Text
        size="xs"
        fw={700}
        tt="uppercase"
        c="dimmed"
        mb={4}
        style={{ letterSpacing: 0.5 }}
      >
        {label}
      </Text>
      <pre
        style={{
          margin: 0,
          padding: "12px 14px",
          background: "var(--surface2, #f7f7f7)",
          border: `1px solid var(--mantine-color-${color}-3, var(--border))`,
          borderRadius: 8,
          fontSize: 12.5,
          fontFamily: "IBM Plex Mono, monospace",
          lineHeight: 1.6,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {code || "(empty)"}
      </pre>
    </div>
  );
}

export function fmtDateTime(iso?: string): string {
  if (!iso) return "—";
  // stored timestamps are UTC without offset; append Z when needed
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + "Z");
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}
