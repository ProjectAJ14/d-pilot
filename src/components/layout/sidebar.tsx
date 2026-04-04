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
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import type { ConnectionInfo, TableInfo, ColumnInfo, Environment, DatabaseType } from "../../types";

const ENV_COLORS: Record<Environment, string> = {
  PROD: "red", STG: "orange", QA: "violet", DEV: "green",
};
const DB_ICONS: Record<DatabaseType, string> = {
  postgres: "🐘", mssql: "🗄️", mongodb: "🍃", elasticsearch: "🔍",
};
const DB_SHORT: Record<DatabaseType, string> = {
  postgres: "PG", mssql: "SQL", mongodb: "MDB", elasticsearch: "ES",
};

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
  const [explorerSearch, setExplorerSearch] = useState("");
  const [savedSearch, setSavedSearch] = useState("");
  const [historySearch, setHistorySearch] = useState("");
  const [loadingConn, setLoadingConn] = useState<string | null>(null);
  const [loadingTable, setLoadingTable] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const grouped = groupByEnv(connections);

  const toggleEnv = (env: string) => {
    setExpandedEnvs((prev) => {
      const next = new Set(prev);
      next.has(env) ? next.delete(env) : next.add(env);
      return next;
    });
  };

  const selectConn = (connId: string) => {
    setActiveConnection(connId);
    if (expandedConn === connId) {
      setExpandedConn(null);
      return;
    }
    setExpandedConn(connId);
    if (!tables[connId]) {
      setLoadingConn(connId);
      api.getTables(connId)
        .then((t) => setTables((prev) => ({ ...prev, [connId]: t })))
        .catch((err) => {
          setTables((prev) => ({ ...prev, [connId]: [] }));
          notifications.show({
            message: `Failed to load tables: ${err.message}`,
            color: "red",
          });
        })
        .finally(() => setLoadingConn(null));
    }
  };

  const toggleTable = (connId: string, tableName: string) => {
    const key = `${connId}:${tableName}`;
    if (expandedTable === key) {
      setExpandedTable(null);
      return;
    }
    setExpandedTable(key);
    if (!columns[key]) {
      setLoadingTable(key);
      api.getColumns(connId, tableName)
        .then((cols) => setColumns((prev) => ({ ...prev, [key]: cols })))
        .catch(() => setColumns((prev) => ({ ...prev, [key]: [] })))
        .finally(() => setLoadingTable(null));
    }
  };

  const doubleClickTable = (connId: string, tableName: string) => {
    const conn = connections.find((c) => c.id === connId);
    const sql = conn?.type === "elasticsearch"
      ? `GET /${tableName}/_search {"query":{"match_all":{}},"size":100}`
      : conn?.type === "mongodb"
        ? `db.${tableName}.find({})`
        : `SELECT * FROM ${tableName} LIMIT 100`;
    addTab(connId);
    setTimeout(() => {
      const tabId = useStore.getState().activeTabId;
      updateTab(tabId, { sql, title: tableName, connectionId: connId, loading: true });
      api.executeQuery(connId, sql)
        .then((result) => updateTab(tabId, { result, loading: false }))
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
                    {env === "PROD" ? "Production" : env === "STG" ? "Staging" : env === "QA" ? "QA / Testing" : "Development"}
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
                              borderRadius: 6,
                              cursor: "pointer",
                              marginBottom: 2,
                              borderLeft: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                              background: isActive
                                ? "rgba(31,145,150,0.06)"
                                : isHovered
                                  ? "rgba(0,0,0,0.02)"
                                  : "transparent",
                              boxShadow: isHovered && !isActive
                                ? "0 1px 2px 0 rgba(0,0,0,0.06)"
                                : "none",
                              transition: "all 150ms ease",
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <Text
                                size="xs"
                                fw={600}
                                ff="monospace"
                                c={isActive ? "primary.8" : "secondary.9"}
                                style={{ fontSize: 12, wordBreak: "break-word", lineHeight: 1.4 }}
                              >
                                {conn.name}
                              </Text>
                              <Text size="xs" c="dimmed" style={{ marginTop: 2, fontSize: 10 }}>
                                {conn.database || ""}
                              </Text>
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                              <span style={{ fontSize: 22, lineHeight: 1 }}>{DB_ICONS[conn.type]}</span>
                              <Text ff="monospace" c="dimmed" style={{ fontSize: 9, marginTop: 2 }}>
                                {DB_SHORT[conn.type]}
                              </Text>
                            </div>
                          </div>

                          {/* Loading tables */}
                          {expandedConn === conn.id && loadingConn === conn.id && (
                            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px" }}>
                              <Loader size={12} color="var(--accent)" />
                              <Text size="xs" c="dimmed" style={{ fontSize: 11 }}>Loading tables...</Text>
                            </div>
                          )}

                          {/* Tables tree */}
                          {expandedConn === conn.id && tables[conn.id] && (
                            <div style={{ paddingLeft: 14, paddingBottom: 4 }}>
                              {tables[conn.id]
                                .filter((t) => !explorerSearch || t.name.toLowerCase().includes(explorerSearch.toLowerCase()))
                                .map((table) => {
                                  const tableKey = `${conn.id}:${table.name}`;
                                  const isTableHovered = hovered === `table-${tableKey}`;
                                  return (
                                    <div key={table.name}>
                                      <div
                                        onClick={() => toggleTable(conn.id, table.name)}
                                        onDoubleClick={() => doubleClickTable(conn.id, table.name)}
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
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--muted2)" }}>
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--success)",
              flexShrink: 0,
            }}
          />
          {connections.length} connection{connections.length !== 1 ? "s" : ""} configured
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--accent)" }}>
          <IconShieldLock size={10} style={{ flexShrink: 0 }} />
          PHI tokenized on {maskedEnvLabel}
        </div>
      </div>
    </div>
  );
}

function groupByEnv(connections: ConnectionInfo[]): Record<string, ConnectionInfo[]> {
  const order: string[] = ["PROD", "STG", "QA", "DEV"];
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
