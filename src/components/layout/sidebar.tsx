import { useState } from "react";
import {
  Text,
  Badge,
  ActionIcon,
  TextInput,
  Tooltip,
  ScrollArea,
  Loader,
  Divider,
  Select,
  Menu,
  Alert,
  Button,
} from "@mantine/core";
import {
  IconChevronDown,
  IconBookmark,
  IconSearch,
  IconShieldLock,
  IconTrash,
  IconTable,
  IconDatabase,
  IconColumns,
  IconKey as IconPK,
  IconHistory,
  IconClock,
  IconDots,
  IconEye,
  IconLink,
  IconBraces,
  IconCode,
  IconAlignLeft,
  IconPlugConnectedX,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useStore } from "../../store";
import { api, ApiError } from "../../utils/api-client";
import { copyToClipboard } from "../../utils/clipboard";
import { copySavedQueryShareLink } from "../../utils/share-links";
import { buildTableMetadata, supportsDdl, type MetadataFormat } from "../../utils/schema-metadata";
import type { ConnectionInfo, TableInfo, ColumnInfo, Environment, DatabaseType } from "../../types";

const ENV_COLORS: Record<Environment, string> = {
  PROD: "red", STG: "orange", UAT: "teal", QA: "violet", DEV: "green",
};
const DB_ICONS: Record<DatabaseType, string> = {
  postgres: "🐘", mssql: "🗄️", mongodb: "🍃", elasticsearch: "🔍",
};
const DB_SHORT: Record<DatabaseType, string> = {
  postgres: "PG", mssql: "SQL", mongodb: "MDB", elasticsearch: "ES",
};

/** Explorer cache key scoping tables/columns by connection + active schema. */
function keyFor(connId: string, schema: string, table?: string) {
  const base = schema ? `${connId}::${schema}` : connId;
  return table ? `${base}::${table}` : base;
}

const SCHEMA_DB_TYPES: DatabaseType[] = ["postgres", "mssql"];

/** The default schema for a connection, known client-side without a round-trip. */
function defaultSchemaOf(conn: ConnectionInfo): string {
  if (conn.type === "postgres") return conn.schema || "public";
  if (conn.type === "mssql") return conn.schema || "dbo";
  return "";
}

export function Sidebar() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const connections = useStore((s) => s.connections);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const setActiveConnection = useStore((s) => s.setActiveConnection);
  const savedQueries = useStore((s) => s.savedQueries);
  const removeSavedQuery = useStore((s) => s.removeSavedQuery);
  const updateTab = useStore((s) => s.updateTab);
  const activeTabId = useStore((s) => s.activeTabId);
  const addTab = useStore((s) => s.addTab);
  const schemaByConnection = useStore((s) => s.schemaByConnection);
  const setSchemaForConnection = useStore((s) => s.setSchemaForConnection);
  const phiMaskedEnvironments = useStore((s) => s.config.phiMaskedEnvironments);
  const maskedEnvLabel = (phiMaskedEnvironments || ["PROD"]).join(" + ");

  const [activeSection, setActiveSection] = useState<"explorer" | "saved" | "history">("explorer");
  const [history, setHistory] = useState<any[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [expandedEnvs, setExpandedEnvs] = useState<Set<string>>(new Set(["QA"]));
  const [expandedConn, setExpandedConn] = useState<string | null>(null);
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
  const [columns, setColumns] = useState<Record<string, ColumnInfo[]>>({});
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  // Per-connection schema discovery (the browsed schema itself lives in the
  // store as `schemaByConnection`, shared with the editor toolbar).
  const [connSchemas, setConnSchemas] = useState<Record<string, string[]>>({});
  // Per-connection load failure shown as a persistent inline alert.
  const [explorerErrors, setExplorerErrors] = useState<
    Record<string, { message: string; code?: string } | null>
  >({});
  const [explorerSearch, setExplorerSearch] = useState("");
  const [savedSearch, setSavedSearch] = useState("");
  const [historySearch, setHistorySearch] = useState("");
  const [loadingConn, setLoadingConn] = useState<string | null>(null);
  const [loadingTable, setLoadingTable] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  // Right-click context menu for a table row (position + target table).
  const [tableMenu, setTableMenu] = useState<
    { x: number; y: number; connId: string; table: TableInfo } | null
  >(null);

  const grouped = groupByEnv(connections);

  const toggleEnv = (env: string) => {
    setExpandedEnvs((prev) => {
      const next = new Set(prev);
      next.has(env) ? next.delete(env) : next.add(env);
      return next;
    });
  };

  // Loads the table list for a connection/schema into the tree cache. Failures
  // are NOT cached (retry refetches); they surface as an inline alert instead.
  const loadTablesForSchema = (
    connId: string,
    schema: string,
    opts?: { force?: boolean },
  ) => {
    const tKey = keyFor(connId, schema);
    if (!opts?.force && tables[tKey]) return;
    setExplorerErrors((prev) => ({ ...prev, [connId]: null }));
    setLoadingConn(connId);
    api.getTables(connId, schema || undefined)
      .then((t) => setTables((prev) => ({ ...prev, [tKey]: t })))
      .catch((err) => {
        setExplorerErrors((prev) => ({
          ...prev,
          [connId]: {
            message: err.message,
            code: err instanceof ApiError ? err.code : undefined,
          },
        }));
      })
      .finally(() => setLoadingConn(null));
  };

  // Discover the schema list for the picker. A table-load error takes
  // precedence in the alert slot — both share the same root cause.
  const loadSchemasForConn = (connId: string) => {
    api.getSchemas(connId)
      .then((r) => setConnSchemas((prev) => ({ ...prev, [connId]: r.schemas })))
      .catch((err) => {
        setExplorerErrors((prev) =>
          prev[connId]
            ? prev
            : {
                ...prev,
                [connId]: {
                  message: err.message,
                  code: err instanceof ApiError ? err.code : undefined,
                },
              },
        );
      });
  };

  const selectConn = (connId: string) => {
    setActiveConnection(connId);
    if (expandedConn === connId) {
      setExpandedConn(null);
      return;
    }
    setExpandedConn(connId);

    const conn = connections.find((c) => c.id === connId);
    const supportsSchemas = !!conn && SCHEMA_DB_TYPES.includes(conn.type);

    // Load tables for the (client-known) default schema immediately so the tree
    // and its loading indicator show right away — no waiting on schema discovery.
    const sch =
      schemaByConnection[connId] ??
      (supportsSchemas && conn ? defaultSchemaOf(conn) : "");
    if (schemaByConnection[connId] == null && sch) {
      setSchemaForConnection(connId, sch);
    }
    loadTablesForSchema(connId, sch);

    // Discover the full schema list in the background, only to populate the picker.
    if (supportsSchemas && !connSchemas[connId]) {
      loadSchemasForConn(connId);
    }
  };

  // Switch the schema browsed for a connection (shared with the editor toolbar).
  const changeExplorerSchema = (connId: string, schema: string) => {
    setSchemaForConnection(connId, schema);
    setExpandedTable(null);
    loadTablesForSchema(connId, schema);
  };

  // Re-attempt everything that can have failed for a connection.
  const retryConnection = (connId: string) => {
    const conn = connections.find((c) => c.id === connId);
    loadTablesForSchema(connId, schemaByConnection[connId] ?? "", { force: true });
    if (conn && SCHEMA_DB_TYPES.includes(conn.type) && !connSchemas[connId]) {
      loadSchemasForConn(connId);
    }
  };

  const toggleTable = (connId: string, tableName: string) => {
    const schema = schemaByConnection[connId] ?? "";
    const key = keyFor(connId, schema, tableName);
    if (expandedTable === key) {
      setExpandedTable(null);
      return;
    }
    setExpandedTable(key);
    if (!columns[key]) {
      setLoadingTable(key);
      api.getColumns(connId, tableName, schema || undefined)
        // Don't cache on failure — re-clicking the table retries.
        .catch((err) => {
          notifications.show({
            id: `columns-failed-${key}`,
            color: "red",
            message:
              err instanceof ApiError && err.code === "CONNECTION_FAILED"
                ? "Unable to connect to the database. Check your network connection."
                : `Failed to load columns: ${err.message}`,
          });
          return null;
        })
        .then((cols) => {
          if (cols) setColumns((prev) => ({ ...prev, [key]: cols }));
        })
        .finally(() => setLoadingTable(null));
    }
  };

  // Copy a table's structure/metadata (columns, types, keys, PHI flags) in the
  // requested format. Fetches columns on demand if the table isn't expanded yet.
  const copyTableMetadata = async (connId: string, table: TableInfo, format: MetadataFormat) => {
    const conn = connections.find((c) => c.id === connId);
    if (!conn) return;
    const schema = schemaByConnection[connId] ?? "";
    const key = keyFor(connId, schema, table.name);
    try {
      let cols = columns[key];
      if (!cols) {
        cols = await api.getColumns(connId, table.name, schema || undefined);
        setColumns((prev) => ({ ...prev, [key]: cols! }));
      }
      const { text, label } = buildTableMetadata(format, conn, table, cols);
      copyToClipboard(text, label);
    } catch (err: any) {
      notifications.show({
        message: `Failed to copy metadata: ${err.message}`,
        color: "red",
      });
    }
  };

  const doubleClickTable = (connId: string, tableName: string) => {
    const conn = connections.find((c) => c.id === connId);
    const schema = schemaByConnection[connId] ?? "";
    // Schema-qualify the name for SQL engines so it resolves regardless of the
    // session's default schema (matters for MSSQL, which has no search_path).
    const qualified =
      schema && SCHEMA_DB_TYPES.includes(conn!.type)
        ? `${schema}.${tableName}`
        : tableName;
    const sql = conn?.type === "elasticsearch"
      ? `GET /${tableName}/_search {"query":{"match_all":{}},"size":100}`
      : conn?.type === "mongodb"
        ? `db.${tableName}.find({})`
        : `SELECT * FROM ${qualified} LIMIT 100`;
    addTab(connId);
    setTimeout(() => {
      const tabId = useStore.getState().activeTabId;
      updateTab(tabId, { sql, title: tableName, connectionId: connId, schema: schema || undefined, loading: true });
      const viewMode = (conn?.type === "mongodb" || conn?.type === "elasticsearch") ? "json" as const : "table" as const;
      api.executeQuery(connId, sql, undefined, schema || undefined)
        .then((result) => updateTab(tabId, { result, loading: false, viewMode }))
        .catch((err) => updateTab(tabId, { error: err.message, loading: false }));
    }, 0);
  };

  const loadHistory = () => {
    if (!historyLoaded) {
      api.getQueryHistory(50).then(setHistory).catch(() => {});
      setHistoryLoaded(true);
    }
  };

  const loadHistoryQuery = (sql: string, connectionId?: string) => {
    addTab(connectionId);
    setTimeout(() => {
      const tabId = useStore.getState().activeTabId;
      updateTab(tabId, { sql, connectionId: connectionId || activeConnectionId });
    }, 0);
  };

  const loadSavedQuery = (name: string, sql: string, connectionId?: string) => {
    addTab(connectionId);
    setTimeout(() => {
      const tabId = useStore.getState().activeTabId;
      updateTab(tabId, { sql, title: name, connectionId: connectionId || activeConnectionId });
    }, 0);
  };

  const handleDeleteSaved = async (id: string) => {
    try {
      await api.deleteSavedQuery(id);
      removeSavedQuery(id);
      notifications.show({ message: "Query deleted", color: "green" });
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    }
  };

  if (!sidebarOpen) return null;

  return (
    <div
      style={{
        width: 280,
        flexShrink: 0,
        background: "#f7f7f7",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Section tabs */}
      <div
        style={{
          display: "flex",
          gap: 0,
          padding: "0 12px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {(["explorer", "saved", "history"] as const).map((section) => (
          <button
            key={section}
            onClick={() => { setActiveSection(section); if (section === "history") loadHistory(); }}
            style={{
              flex: 1,
              padding: "12px 0",
              background: "none",
              border: "none",
              borderBottom: activeSection === section
                ? "2px solid var(--accent)"
                : "2px solid transparent",
              color: activeSection === section ? "var(--accent4)" : "var(--muted)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              fontFamily: "Barlow, sans-serif",
              transition: "color 150ms ease, border-color 150ms ease",
            }}
          >
            {section === "explorer" ? (
              <>
                <IconDatabase size={13} style={{ verticalAlign: "middle", marginRight: 5, marginTop: -1 }} />
                Explorer
              </>
            ) : section === "saved" ? (
              <>
                <IconBookmark size={13} style={{ verticalAlign: "middle", marginRight: 5, marginTop: -1 }} />
                Saved ({savedQueries.length})
              </>
            ) : (
              <>
                <IconHistory size={13} style={{ verticalAlign: "middle", marginRight: 5, marginTop: -1 }} />
                History
              </>
            )}
          </button>
        ))}
      </div>

      {/* Search */}
      <div style={{ padding: "10px 12px 6px" }}>
        <TextInput
          placeholder={activeSection === "explorer" ? "Search tables..." : activeSection === "saved" ? "Search saved queries..." : "Search history..."}
          size="xs"
          leftSection={<IconSearch size={14} color="var(--muted)" />}
          value={activeSection === "explorer" ? explorerSearch : activeSection === "saved" ? savedSearch : historySearch}
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (activeSection === "explorer") setExplorerSearch(v);
            else if (activeSection === "saved") setSavedSearch(v);
            else setHistorySearch(v);
          }}
          styles={{
            input: {
              background: "#ffffff",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
              transition: "border-color 150ms ease",
            },
          }}
        />
      </div>

      {/* Content */}
      <ScrollArea style={{ flex: 1 }} scrollbarSize={4}>
        {activeSection === "explorer" && (
          <div style={{ padding: "4px 8px" }}>
            {Object.entries(grouped).map(([env, conns]) => (
              <div key={env} style={{ marginBottom: 6 }}>
                {/* Env header */}
                <div
                  onClick={() => toggleEnv(env)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: 6,
                    cursor: "pointer",
                    transition: "background-color 150ms ease",
                    background: "transparent",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(0,0,0,0.03)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <Badge
                    size="xs"
                    color={ENV_COLORS[env as Environment]}
                    variant="filled"
                    styles={{ root: { textTransform: "uppercase", fontWeight: 700, fontSize: 9, letterSpacing: 0.5 } }}
                  >
                    {env}
                  </Badge>
                  <Text size="xs" fw={600} style={{ flex: 1 }} c="secondary.9">
                    {env === "PROD" ? "Production" : env === "STG" ? "Staging" : env === "UAT" ? "UAT" : env === "QA" ? "QA / Testing" : "Development"}
                  </Text>
                  <Text size="xs" c="dimmed" ff="monospace" style={{ fontSize: 10 }}>{conns.length}</Text>
                  <IconChevronDown
                    size={12}
                    color="var(--muted)"
                    style={{
                      transform: expandedEnvs.has(env) ? "rotate(0deg)" : "rotate(-90deg)",
                      transition: "transform 200ms ease",
                    }}
                  />
                </div>

                {/* Connections in this env */}
                {expandedEnvs.has(env) && (
                  <div style={{ padding: "2px 0 2px 8px" }}>
                    {conns.map((conn) => {
                      const isActive = conn.id === activeConnectionId;
                      const isHovered = hovered === `conn-${conn.id}`;
                      const sch = schemaByConnection[conn.id] ?? "";
                      const tKey = keyFor(conn.id, sch);
                      const connSchemaList = connSchemas[conn.id];
                      const showSchemaPicker =
                        SCHEMA_DB_TYPES.includes(conn.type) &&
                        !!connSchemaList &&
                        connSchemaList.length > 0;
                      return (
                        <div key={conn.id}>
                          <div
                            onClick={() => selectConn(conn.id)}
                            onMouseEnter={() => setHovered(`conn-${conn.id}`)}
                            onMouseLeave={() => setHovered(null)}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              padding: "8px 12px",
                              borderRadius: 8,
                              cursor: "pointer",
                              marginBottom: 3,
                              border: isActive
                                ? "1px solid rgba(31,145,150,0.35)"
                                : "1px solid transparent",
                              borderLeft: isActive
                                ? "3px solid var(--accent)"
                                : "3px solid transparent",
                              background: isActive
                                ? "linear-gradient(90deg, rgba(31,145,150,0.16), rgba(31,145,150,0.03))"
                                : isHovered
                                  ? "rgba(0,0,0,0.02)"
                                  : "transparent",
                              boxShadow: isActive
                                ? "0 2px 10px 0 rgba(31,145,150,0.16)"
                                : isHovered
                                  ? "0 1px 2px 0 rgba(0,0,0,0.06)"
                                  : "none",
                              transition: "all 150ms ease",
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <Text
                                  size="xs"
                                  fw={isActive ? 700 : 600}
                                  ff="monospace"
                                  c={isActive ? "primary.8" : "secondary.9"}
                                  style={{ fontSize: 12, wordBreak: "break-word", lineHeight: 1.4 }}
                                >
                                  {conn.name}
                                </Text>
                                {isActive && (
                                  <span
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 4,
                                      background: "var(--accent)",
                                      color: "#fff",
                                      fontSize: 8,
                                      fontWeight: 800,
                                      letterSpacing: 0.7,
                                      textTransform: "uppercase",
                                      padding: "2px 6px",
                                      borderRadius: 5,
                                      lineHeight: 1,
                                      flexShrink: 0,
                                    }}
                                  >
                                    <span
                                      style={{
                                        width: 5,
                                        height: 5,
                                        borderRadius: "50%",
                                        background: "#fff",
                                        boxShadow: "0 0 5px rgba(255,255,255,0.9)",
                                        animation: "pulse 1.8s ease-in-out infinite",
                                      }}
                                    />
                                    Active
                                  </span>
                                )}
                              </div>
                              <Text size="xs" c="dimmed" style={{ marginTop: 2, fontSize: 10 }}>
                                {conn.database || ""}
                              </Text>
                            </div>
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                flexShrink: 0,
                                padding: isActive ? "2px 4px" : undefined,
                                borderRadius: 6,
                                background: isActive ? "rgba(31,145,150,0.10)" : undefined,
                              }}
                            >
                              <span style={{ fontSize: 22, lineHeight: 1 }}>{DB_ICONS[conn.type]}</span>
                              <Text
                                ff="monospace"
                                c={isActive ? "primary.7" : "dimmed"}
                                style={{ fontSize: 9, marginTop: 2, fontWeight: isActive ? 700 : 400 }}
                              >
                                {DB_SHORT[conn.type]}
                              </Text>
                            </div>
                          </div>

                          {/* Schema picker (Postgres/MSSQL) */}
                          {expandedConn === conn.id && showSchemaPicker && (
                            <div style={{ padding: "4px 12px 6px 20px" }}>
                              <Select
                                size="xs"
                                data={connSchemaList}
                                value={sch || null}
                                onChange={(val) => {
                                  if (val) changeExplorerSchema(conn.id, val);
                                }}
                                allowDeselect={false}
                                checkIconPosition="right"
                                leftSection={<IconDatabase size={12} />}
                                comboboxProps={{ withinPortal: true }}
                                styles={{
                                  input: {
                                    background: "#ffffff",
                                    fontFamily: "IBM Plex Mono, monospace",
                                    fontSize: 11,
                                    minHeight: 28,
                                    height: 28,
                                  },
                                }}
                              />
                            </div>
                          )}

                          {/* Loading tables */}
                          {expandedConn === conn.id && loadingConn === conn.id && (
                            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px" }}>
                              <Loader size={12} color="var(--accent)" />
                              <Text size="xs" c="dimmed" style={{ fontSize: 11 }}>Loading tables...</Text>
                            </div>
                          )}

                          {/* Load failure (connection unreachable, etc.) */}
                          {expandedConn === conn.id &&
                            loadingConn !== conn.id &&
                            explorerErrors[conn.id] && (
                              <Alert
                                color="red"
                                variant="light"
                                icon={<IconPlugConnectedX size={14} />}
                                title={
                                  explorerErrors[conn.id]!.code === "CONNECTION_FAILED"
                                    ? "Unable to connect to database"
                                    : "Failed to load tables"
                                }
                                styles={{
                                  root: { margin: "4px 12px 6px 20px", padding: 8 },
                                  title: { fontSize: 11, marginBottom: 2 },
                                  message: { fontSize: 10 },
                                  icon: { marginTop: 2 },
                                }}
                              >
                                {explorerErrors[conn.id]!.code === "CONNECTION_FAILED"
                                  ? "The database host could not be reached. Check your network connection."
                                  : explorerErrors[conn.id]!.message}
                                <Button
                                  size="compact-xs"
                                  variant="light"
                                  color="red"
                                  mt={6}
                                  display="block"
                                  onClick={() => retryConnection(conn.id)}
                                >
                                  Retry
                                </Button>
                              </Alert>
                            )}

                          {/* Tables tree */}
                          {expandedConn === conn.id && tables[tKey] && (
                            <div style={{ paddingLeft: 14, paddingBottom: 4 }}>
                              {tables[tKey]
                                .filter((t) => !explorerSearch || t.name.toLowerCase().includes(explorerSearch.toLowerCase()))
                                .map((table) => {
                                  const tableKey = keyFor(conn.id, sch, table.name);
                                  const isTableHovered = hovered === `table-${tableKey}`;
                                  return (
                                    <div key={table.name}>
                                      <div
                                        onClick={() => toggleTable(conn.id, table.name)}
                                        onDoubleClick={() => doubleClickTable(conn.id, table.name)}
                                        onContextMenu={(e) => {
                                          e.preventDefault();
                                          setTableMenu({ x: e.clientX, y: e.clientY, connId: conn.id, table });
                                        }}
                                        onMouseEnter={() => setHovered(`table-${tableKey}`)}
                                        onMouseLeave={() => setHovered(null)}
                                        style={{
                                          display: "flex",
                                          alignItems: "center",
                                          gap: 6,
                                          padding: "6px 10px",
                                          borderRadius: 5,
                                          cursor: "pointer",
                                          background: isTableHovered ? "rgba(0,0,0,0.03)" : "transparent",
                                          transition: "background-color 150ms ease",
                                        }}
                                      >
                                        <IconTable size={13} color="var(--accent)" style={{ flexShrink: 0 }} />
                                        <Text size="xs" ff="monospace" style={{ flex: 1, fontSize: 11 }} c={isTableHovered ? "secondary.9" : "dimmed"}>
                                          {table.name}
                                        </Text>
                                        {table.type === "VIEW" && (
                                          <Badge size="xs" variant="light" color="gray" styles={{ root: { fontSize: 8 } }}>VIEW</Badge>
                                        )}
                                        {(isTableHovered ||
                                          (tableMenu?.connId === conn.id && tableMenu?.table.name === table.name)) && (
                                          <Tooltip label="Actions" openDelay={400} withArrow>
                                            <ActionIcon
                                              size="xs"
                                              variant="subtle"
                                              color="gray"
                                              style={{ flexShrink: 0 }}
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                const r = e.currentTarget.getBoundingClientRect();
                                                setTableMenu({ x: r.left, y: r.bottom, connId: conn.id, table });
                                              }}
                                            >
                                              <IconDots size={13} />
                                            </ActionIcon>
                                          </Tooltip>
                                        )}
                                      </div>

                                      {expandedTable === tableKey && loadingTable === tableKey && (
                                        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 24px" }}>
                                          <Loader size={10} color="var(--accent)" />
                                          <Text size="xs" c="dimmed" style={{ fontSize: 10 }}>Loading columns...</Text>
                                        </div>
                                      )}

                                      {expandedTable === tableKey && columns[tableKey] && (
                                        <div
                                          style={{
                                            marginLeft: 16,
                                            marginBottom: 4,
                                            paddingLeft: 10,
                                            borderLeft: "1px solid var(--border)",
                                          }}
                                        >
                                          {columns[tableKey].map((col) => (
                                            <div
                                              key={col.name}
                                              style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: 6,
                                                padding: "4px 8px",
                                                fontSize: 11,
                                                fontFamily: "IBM Plex Mono, monospace",
                                              }}
                                            >
                                              {col.isPrimaryKey ? (
                                                <IconPK size={10} color="var(--accent)" style={{ flexShrink: 0 }} />
                                              ) : (
                                                <IconColumns size={10} color="var(--muted)" style={{ flexShrink: 0 }} />
                                              )}
                                              <Text
                                                size="xs"
                                                ff="monospace"
                                                c={col.isPrimaryKey ? "primary.8" : "dimmed"}
                                                style={{ flex: 1, fontSize: 11 }}
                                              >
                                                {col.name}
                                              </Text>
                                              <Text size="xs" c="dimmed" style={{ fontSize: 9, opacity: 0.7 }}>{col.dataType}</Text>
                                              {col.isPhiField && <IconShieldLock size={10} color="var(--token)" />}
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}

            {Object.keys(grouped).length === 0 && (
              <div style={{ padding: "24px 16px", textAlign: "center" }}>
                <IconDatabase size={28} color="var(--muted)" style={{ opacity: 0.4, marginBottom: 8 }} />
                <Text size="xs" c="dimmed">No connections configured</Text>
              </div>
            )}
          </div>
        )}

        {activeSection === "saved" && (
          <div style={{ padding: "4px 8px" }}>
            {savedQueries
              .filter((q) =>
                q.name.toLowerCase().includes(savedSearch.toLowerCase()) ||
                q.sql.toLowerCase().includes(savedSearch.toLowerCase())
              )
              .map((query) => {
                const isQueryHovered = hovered === `query-${query.id}`;
                return (
                  <div
                    key={query.id}
                    onClick={() => loadSavedQuery(query.name, query.sql, query.connectionId)}
                    onMouseEnter={() => setHovered(`query-${query.id}`)}
                    onMouseLeave={() => setHovered(null)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "10px 12px",
                      borderRadius: 6,
                      cursor: "pointer",
                      marginBottom: 2,
                      background: isQueryHovered ? "#ffffff" : "transparent",
                      boxShadow: isQueryHovered
                        ? "0 1px 2px 0 rgba(0,0,0,0.08), 0 1px 3px 0 rgba(0,0,0,0.04)"
                        : "none",
                      transition: "all 150ms ease",
                    }}
                  >
                    <IconBookmark size={15} color="var(--accent)" style={{ flexShrink: 0, alignSelf: "flex-start", marginTop: 2 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text size="xs" fw={600} c="secondary.9" style={{ fontSize: 12, lineHeight: 1.4, wordBreak: "break-word" }}>{query.name}</Text>
                      <Text c="dimmed" ff="monospace" style={{ marginTop: 4, fontSize: 9, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                        {query.sql.trim()}
                      </Text>
                    </div>
                    <Tooltip label="Copy share link" position="right">
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        color="gray"
                        style={{
                          opacity: isQueryHovered ? 1 : 0,
                          transition: "opacity 150ms ease",
                        }}
                        onClick={(e) => { e.stopPropagation(); copySavedQueryShareLink(query); }}
                      >
                        <IconLink size={12} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Delete" position="right">
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        color="red"
                        style={{
                          opacity: isQueryHovered ? 1 : 0,
                          transition: "opacity 150ms ease",
                        }}
                        onClick={(e) => { e.stopPropagation(); handleDeleteSaved(query.id); }}
                      >
                        <IconTrash size={12} />
                      </ActionIcon>
                    </Tooltip>
                  </div>
                );
              })}
            {savedQueries.length === 0 && (
              <div style={{ padding: "24px 16px", textAlign: "center" }}>
                <IconBookmark size={28} color="var(--muted)" style={{ opacity: 0.4, marginBottom: 8 }} />
                <Text size="xs" c="dimmed">No saved queries yet</Text>
                <Text size="xs" c="dimmed" style={{ fontSize: 10, marginTop: 4 }}>
                  Save queries from the editor to access them here
                </Text>
              </div>
            )}
          </div>
        )}

        {activeSection === "history" && (
          <div style={{ padding: "4px 8px" }}>
            {history
              .filter((h) => !historySearch || h.sql?.toLowerCase().includes(historySearch.toLowerCase()))
              .map((entry) => {
                const isEntryHovered = hovered === `hist-${entry.id}`;
                return (
                  <div
                    key={entry.id}
                    onClick={() => loadHistoryQuery(entry.sql, entry.connectionId)}
                    onMouseEnter={() => setHovered(`hist-${entry.id}`)}
                    onMouseLeave={() => setHovered(null)}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "10px 12px",
                      borderRadius: 6,
                      cursor: "pointer",
                      marginBottom: 2,
                      background: isEntryHovered ? "#ffffff" : "transparent",
                      boxShadow: isEntryHovered
                        ? "0 1px 2px 0 rgba(0,0,0,0.08), 0 1px 3px 0 rgba(0,0,0,0.04)"
                        : "none",
                      transition: "all 150ms ease",
                    }}
                  >
                    <IconClock size={14} color="var(--muted)" style={{ flexShrink: 0, marginTop: 2 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text size="xs" ff="monospace" truncate c="secondary.9" style={{ fontSize: 11 }}>
                        {entry.sql?.slice(0, 80)}
                      </Text>
                      <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
                        <Text size="xs" c="dimmed" style={{ fontSize: 9 }}>
                          {entry.rowsReturned != null ? `${entry.rowsReturned} rows` : ""}
                        </Text>
                        <Text size="xs" c="dimmed" style={{ fontSize: 9 }}>
                          {entry.executionMs != null ? `${entry.executionMs}ms` : ""}
                        </Text>
                        <Text size="xs" c="dimmed" style={{ fontSize: 9 }}>
                          {new Date(entry.timestamp).toLocaleString()}
                        </Text>
                      </div>
                    </div>
                  </div>
                );
              })}
            {history.length === 0 && (
              <div style={{ padding: "24px 16px", textAlign: "center" }}>
                <IconHistory size={28} color="var(--muted)" style={{ opacity: 0.4, marginBottom: 8 }} />
                <Text size="xs" c="dimmed">No query history yet</Text>
                <Text size="xs" c="dimmed" style={{ fontSize: 10, marginTop: 4 }}>
                  Run queries to see them here
                </Text>
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      {/* Footer */}
      <Divider color="var(--border)" />
      <div
        style={{
          padding: "12px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--accent)" }}>
          <IconShieldLock size={10} style={{ flexShrink: 0 }} />
          PHI tokenized on {maskedEnvLabel}
        </div>
      </div>

      {/* Right-click context menu for table objects */}
      {tableMenu && (
        <Menu
          opened
          onClose={() => setTableMenu(null)}
          position="bottom-start"
          shadow="md"
          withinPortal
        >
          <Menu.Target>
            <div
              style={{
                position: "fixed",
                left: tableMenu.x,
                top: tableMenu.y,
                width: 0,
                height: 0,
              }}
            />
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{tableMenu.table.name}</Menu.Label>
            <Menu.Item
              leftSection={<IconEye size={14} />}
              onClick={() => {
                doubleClickTable(tableMenu.connId, tableMenu.table.name);
                setTableMenu(null);
              }}
            >
              View top 100 rows
            </Menu.Item>
            <Menu.Divider />
            <Menu.Label>Copy metadata</Menu.Label>
            <Menu.Item
              leftSection={<IconBraces size={14} />}
              onClick={() => {
                copyTableMetadata(tableMenu.connId, tableMenu.table, "json");
                setTableMenu(null);
              }}
            >
              Copy as JSON
            </Menu.Item>
            {(() => {
              const menuConn = connections.find((c) => c.id === tableMenu.connId);
              return menuConn && supportsDdl(menuConn) ? (
                <Menu.Item
                  leftSection={<IconCode size={14} />}
                  onClick={() => {
                    copyTableMetadata(tableMenu.connId, tableMenu.table, "ddl");
                    setTableMenu(null);
                  }}
                >
                  Copy as DDL (CREATE TABLE)
                </Menu.Item>
              ) : null;
            })()}
            <Menu.Item
              leftSection={<IconAlignLeft size={14} />}
              onClick={() => {
                copyTableMetadata(tableMenu.connId, tableMenu.table, "text");
                setTableMenu(null);
              }}
            >
              Copy as text
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      )}
    </div>
  );
}

function groupByEnv(connections: ConnectionInfo[]): Record<string, ConnectionInfo[]> {
  const order: string[] = ["PROD", "STG", "UAT", "QA", "DEV"];
  const grouped: Record<string, ConnectionInfo[]> = {};
  for (const c of connections) {
    if (!grouped[c.env]) grouped[c.env] = [];
    grouped[c.env].push(c);
  }
  const sorted: Record<string, ConnectionInfo[]> = {};
  for (const env of order) {
    if (grouped[env]) sorted[env] = grouped[env];
  }
  return sorted;
}
