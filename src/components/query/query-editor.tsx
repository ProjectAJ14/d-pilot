import { useState, useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type {
  editor as MonacoEditor,
  languages,
  IDisposable,
} from "monaco-editor";
import { format as formatSql } from "sql-formatter";
import {
  Button,
  Group,
  Text,
  Badge,
  ActionIcon,
  Tooltip,
  TextInput,
  Modal,
  Checkbox,
  NumberInput,
  Select,
  Loader,
} from "@mantine/core";
import {
  IconPlayerPlay,
  IconDeviceFloppy,
  IconFileExport,
  IconAlignJustified,
  IconArrowsVertical,
  IconCircleCheck,
  IconSparkles,
  IconPencilBolt,
  IconDatabase,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "react-router-dom";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import type {
  DatabaseType,
  QueryTab,
  TableInfo,
  ColumnInfo,
} from "../../types";

interface Props {
  tab: QueryTab;
  height?: number;
  expanded?: boolean;
  onToggleHeight?: () => void;
}

// Cache schema data for autocomplete
const schemaCache: Record<
  string,
  { tables: TableInfo[]; columns: Record<string, ColumnInfo[]> }
> = {};
let completionDisposables: IDisposable[] = [];

function disposeCompletions() {
  for (const d of completionDisposables) d.dispose();
  completionDisposables = [];
}

const TRIGGER_CHARS =
  " .,(abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\"'{[}".split("");

/** Monaco grammar: SQL for RDBMS; JavaScript for Mongo shell-style; plaintext for ES (GET + JSON body). */
function monacoLanguageForDb(dbType: DatabaseType | null | undefined): string {
  switch (dbType) {
    case "mongodb":
      return "javascript";
    case "elasticsearch":
      return "plaintext";
    case "postgres":
    case "mssql":
    default:
      return "sql";
  }
}

const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "LIKE",
  "ILIKE",
  "BETWEEN",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "OUTER JOIN",
  "CROSS JOIN",
  "ON",
  "AS",
  "ORDER BY",
  "GROUP BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "DISTINCT",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "IS NULL",
  "IS NOT NULL",
  "EXISTS",
  "UNION",
  "UNION ALL",
  "ASC",
  "DESC",
  "TOP",
  "WITH",
  "NULL",
  "TRUE",
  "FALSE",
];

const MSSQL_EXTRA_KEYWORDS = [
  "FETCH NEXT",
  "ROWS ONLY",
  "ROW_NUMBER",
  "OVER",
  "PARTITION BY",
];

const MONGO_KEYWORDS = [
  "db",
  "find",
  "findOne",
  "aggregate",
  "countDocuments",
  "distinct",
  "limit",
  "sort",
  "skip",
  "$eq",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$ne",
  "$regex",
  "$exists",
  "$and",
  "$or",
  "$not",
  "$nor",
  "$match",
  "$group",
  "$project",
  "$sort",
  "$limit",
  "$skip",
  "$lookup",
  "$unwind",
];

const ELASTIC_KEYWORDS = [
  "GET",
  "POST",
  "_search",
  "_count",
  "query",
  "match_all",
  "match",
  "match_phrase",
  "term",
  "terms",
  "range",
  "bool",
  "must",
  "should",
  "must_not",
  "filter",
  "size",
  "from",
  "_source",
  "sort",
  "aggs",
  "wildcard",
  "prefix",
];

function pushKeywordSuggestions(
  monaco: {
    languages: { CompletionItemKind: typeof languages.CompletionItemKind };
  },
  suggestions: languages.CompletionItem[],
  keywords: string[],
  range: languages.CompletionItem["range"],
) {
  for (const kw of keywords) {
    const lower = kw.toLowerCase();
    const insert = kw.endsWith("(") ? kw : kw + " ";
    suggestions.push({
      label: kw,
      kind: monaco.languages.CompletionItemKind.Keyword,
      insertText: insert,
      filterText: lower,
      range,
      sortText: "!0_" + lower,
      detail: "keyword",
    });
    if (lower !== kw) {
      suggestions.push({
        label: lower,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: insert,
        filterText: lower,
        range,
        sortText: "!0_" + lower,
        detail: "keyword",
      });
    }
  }
}

/** Autocomplete cache key: connection + active schema (schema-scoped for SQL). */
function schemaCacheKey(connectionId: string, schema?: string) {
  return schema ? `${connectionId}::${schema}` : connectionId;
}

/** The default schema for a connection, known client-side without a round-trip. */
function defaultSchemaOf(conn: { type: DatabaseType; schema?: string }): string {
  if (conn.type === "postgres") return conn.schema || "public";
  if (conn.type === "mssql") return conn.schema || "dbo";
  return "";
}

// De-dupe concurrent loads for the same key so multiple open tabs sharing a
// connection/schema trigger only ONE full-schema fetch, not one per editor.
const schemaInflight: Record<
  string,
  Promise<{ tables: TableInfo[]; columns: Record<string, ColumnInfo[]> }>
> = {};

async function loadSchemaForConnection(
  connectionId: string,
  schema?: string,
  dbType?: DatabaseType | null,
) {
  const key = schemaCacheKey(connectionId, schema);
  if (schemaCache[key]) return schemaCache[key];
  if (schemaInflight[key]) return schemaInflight[key];

  // SQL engines return the full schema (all tables + columns) in ONE cheap,
  // server-cached call. Mongo/ES introspect a client connection per collection,
  // so for those we only list collections and fetch fields for the first few —
  // avoiding a large concurrent fan-out on the server for autocomplete.
  const useFull = dbType === "postgres" || dbType === "mssql";

  const pending = (async () => {
    try {
      if (useFull) {
        const full = await api.getFullSchema(connectionId, schema);
        const entry = {
          tables: full.tables.map((t) => ({
            schema: schema || "",
            name: t.name,
            type: t.type,
          })) as TableInfo[],
          columns: (full.columns || {}) as Record<string, ColumnInfo[]>,
        };
        schemaCache[key] = entry;
        return entry;
      }

      const tables = await api.getTables(connectionId, schema);
      const entry: { tables: TableInfo[]; columns: Record<string, ColumnInfo[]> } =
        { tables, columns: {} };
      schemaCache[key] = entry;
      // Fields for the first 20 collections/indices, loaded in the background.
      for (const t of tables.slice(0, 20)) {
        api
          .getColumns(connectionId, t.name, schema)
          .then((cols) => {
            entry.columns[t.name] = cols;
          })
          .catch(() => {});
      }
      return entry;
    } catch {
      return { tables: [], columns: {} };
    }
  })().finally(() => {
    delete schemaInflight[key];
  });

  schemaInflight[key] = pending;
  return pending;
}

function addSqlSchemaSuggestions(
  monaco: any,
  suggestions: languages.CompletionItem[],
  connectionId: string,
  range: languages.CompletionItem["range"],
  isTableContext: boolean,
) {
  const schema = schemaCache[connectionId];
  if (!schema) return;

  for (const table of schema.tables) {
    suggestions.push({
      label: table.name,
      kind: monaco.languages.CompletionItemKind.Struct,
      insertText: table.name,
      detail: `${table.type} · ${table.schema}`,
      range,
      sortText: isTableContext ? "0_" + table.name : "1_" + table.name,
    });

    const cols = schema.columns[table.name];
    if (cols) {
      for (const col of cols) {
        suggestions.push({
          label: `${table.name}.${col.name}`,
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: col.name,
          detail: `${col.dataType}${col.isPrimaryKey ? " PK" : ""}${col.isPhiField ? " 🔐 PHI" : ""}`,
          range,
          sortText: "1_" + col.name,
        });
        suggestions.push({
          label: col.name,
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: col.name,
          detail: `${table.name}.${col.dataType}`,
          range,
          sortText: "1_" + col.name,
        });
      }
    }
  }
}

/** Registers the completion provider(s) for the active connection dialect. */
function registerQueryCompletions(
  monaco: any,
  connectionId: string,
  dbType: DatabaseType | null | undefined,
) {
  disposeCompletions();

  const eff: DatabaseType | "none" = dbType ?? "none";

  if (eff === "postgres" || eff === "mssql" || eff === "none") {
    completionDisposables.push(
      monaco.languages.registerCompletionItemProvider("sql", {
        triggerCharacters: TRIGGER_CHARS,
        provideCompletionItems: (model: any, position: any) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };

          const suggestions: languages.CompletionItem[] = [];
          const textUntilPosition = model.getValueInRange({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          });
          const lastClause = textUntilPosition.match(
            /\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+\w*$/i,
          );
          const isTableContext = !!lastClause;

          const kws = [...SQL_KEYWORDS];
          if (eff === "mssql") kws.push(...MSSQL_EXTRA_KEYWORDS);
          pushKeywordSuggestions(monaco, suggestions, kws, range);
          if (connectionId)
            addSqlSchemaSuggestions(
              monaco,
              suggestions,
              connectionId,
              range,
              isTableContext,
            );

          return { suggestions };
        },
      }),
    );
  }

  if (eff === "mongodb") {
    completionDisposables.push(
      monaco.languages.registerCompletionItemProvider("javascript", {
        triggerCharacters: TRIGGER_CHARS,
        provideCompletionItems: (model: any, position: any) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          const suggestions: languages.CompletionItem[] = [];
          pushKeywordSuggestions(monaco, suggestions, MONGO_KEYWORDS, range);

          const lineUntil = model
            .getLineContent(position.lineNumber)
            .slice(0, position.column - 1);
          const dbMatch = lineUntil.match(/db\.(\w*)$/);
          const schema = connectionId ? schemaCache[connectionId] : undefined;
          if (schema && dbMatch) {
            const prefix = dbMatch[1].toLowerCase();
            for (const coll of schema.tables) {
              if (prefix && !coll.name.toLowerCase().startsWith(prefix))
                continue;
              suggestions.push({
                label: coll.name,
                kind: monaco.languages.CompletionItemKind.Struct,
                insertText: `${coll.name}.find({})`,
                filterText: coll.name,
                sortText: "0_" + coll.name,
                detail: `${coll.type} · ${coll.schema}`,
                range,
              });
            }
          }

          if (schema && /\.\s*$/.test(lineUntil)) {
            suggestions.push(
              {
                label: "find({})",
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: "find({})",
                sortText: "0_find",
                detail: "MongoDB read",
                range,
              },
              {
                label: "findOne({})",
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: "findOne({})",
                sortText: "0_findOne",
                detail: "MongoDB read",
                range,
              },
              {
                label: "aggregate([])",
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: "aggregate([])",
                sortText: "0_agg",
                detail: "MongoDB read",
                range,
              },
              {
                label: "countDocuments({})",
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: "countDocuments({})",
                sortText: "0_count",
                detail: "MongoDB read",
                range,
              },
              {
                label: 'distinct("field", {})',
                kind: monaco.languages.CompletionItemKind.Method,
                insertText: 'distinct("field", {})',
                sortText: "0_distinct",
                detail: "MongoDB read",
                range,
              },
            );
          }

          const collForFields = lineUntil.match(
            /db\.(\w+)\.(?:find|findOne|aggregate|countDocuments|distinct)\(/,
          );
          if (schema && collForFields) {
            const collName = collForFields[1];
            const cols = schema.columns[collName];
            if (cols) {
              for (const col of cols) {
                suggestions.push({
                  label: col.name,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: `"${col.name}"`,
                  filterText: col.name,
                  detail: col.dataType + (col.isPhiField ? " 🔐 PHI" : ""),
                  range,
                  sortText: "1_" + col.name,
                });
              }
            }
          }

          return { suggestions };
        },
      }),
    );
  }

  if (eff === "elasticsearch") {
    completionDisposables.push(
      monaco.languages.registerCompletionItemProvider("plaintext", {
        triggerCharacters: TRIGGER_CHARS,
        provideCompletionItems: (model: any, position: any) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          const suggestions: languages.CompletionItem[] = [];
          pushKeywordSuggestions(monaco, suggestions, ELASTIC_KEYWORDS, range);

          const lineUntil = model
            .getLineContent(position.lineNumber)
            .slice(0, position.column - 1);
          const pathMatch = lineUntil.match(
            /^(?:GET|POST)?\s*\/?([\w\-.*]*)$/i,
          );
          const schema = connectionId ? schemaCache[connectionId] : undefined;
          if (schema && pathMatch) {
            const prefix = pathMatch[1].toLowerCase();
            for (const idx of schema.tables) {
              if (prefix && !idx.name.toLowerCase().startsWith(prefix))
                continue;
              suggestions.push({
                label: idx.name + "/_search",
                kind: monaco.languages.CompletionItemKind.Struct,
                insertText: `${idx.name}/_search `,
                filterText: idx.name,
                sortText: "0_" + idx.name,
                detail: `${idx.type} · open _search body`,
                range,
              });
            }
          }

          return { suggestions };
        },
      }),
    );
  }
}

// Toolbar + padding takes roughly 56px; subtract from total height for the editor area
const TOOLBAR_HEIGHT = 56;

export function QueryEditor({ tab, height, expanded, onToggleHeight }: Props) {
  const updateTab = useStore((s) => s.updateTab);
  const connections = useStore((s) => s.connections);
  const toggleAiAssistant = useStore((s) => s.toggleAiAssistant);
  const aiAssistantOpen = useStore((s) => s.aiAssistantOpen);
  const addSavedQuery = useStore((s) => s.addSavedQuery);
  const savedQueries = useStore((s) => s.savedQueries);
  const updateSavedQueryInStore = useStore((s) => s.updateSavedQuery);
  const defaultLimitEnabled = useStore((s) => s.defaultLimitEnabled);
  const defaultLimitValue = useStore((s) => s.defaultLimitValue);
  const setDefaultLimitEnabled = useStore((s) => s.setDefaultLimitEnabled);
  const setDefaultLimitValue = useStore((s) => s.setDefaultLimitValue);
  const setWriteHandoff = useStore((s) => s.setWriteHandoff);
  const canWrite = useStore((s) => !!s.user?.canWrite);
  const navigate = useNavigate();
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [editingSavedId, setEditingSavedId] = useState<string | null>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<any>(null);
  const readyTimerRef = useRef<number | null>(null);

  const activeConn = connections.find((c) => c.id === tab.connectionId);
  const supportsSchemas =
    activeConn?.type === "postgres" || activeConn?.type === "mssql";
  const [schemas, setSchemas] = useState<string[]>([]);
  // Monaco lazy-loads its chunk and mounts asynchronously, which flashes a blank
  // area then pops in text. We overlay a stable placeholder until it has mounted.
  const [editorReady, setEditorReady] = useState(false);

  // Cancel the pending reveal timer if the editor unmounts first.
  useEffect(() => {
    return () => {
      if (readyTimerRef.current) window.clearTimeout(readyTimerRef.current);
    };
  }, []);

  // Default the tab's schema synchronously from connection metadata (no
  // round-trip) so schema-scoped autocomplete loads once with the right key,
  // then fetch the full schema list only to populate the dropdown.
  useEffect(() => {
    const connId = tab.connectionId;
    if (!connId || !supportsSchemas) {
      setSchemas([]);
      return;
    }
    if (!tab.schema && activeConn) {
      const def = defaultSchemaOf(activeConn);
      if (def) updateTab(tab.id, { schema: def });
    }
    let cancelled = false;
    api
      .getSchemas(connId)
      .then((r) => {
        if (!cancelled) setSchemas(r.schemas);
      })
      .catch(() => {
        if (!cancelled) setSchemas([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.connectionId, supportsSchemas]);

  // Load schema, switch Monaco language, and register dialect-specific completions
  useEffect(() => {
    const connId = tab.connectionId || "";
    const dbType = activeConn?.type ?? null;
    // Resolve the schema up front (default when unset) so the cache key is
    // stable and we don't fire a throwaway fetch for the undefined key.
    const effectiveSchema =
      tab.schema ?? (activeConn ? defaultSchemaOf(activeConn) : undefined);
    const cacheKey = schemaCacheKey(connId, effectiveSchema);

    const tryApply = () => {
      if (!monacoRef.current) return false;
      registerQueryCompletions(monacoRef.current, cacheKey, dbType);
      const model = editorRef.current?.getModel();
      if (model) {
        monacoRef.current.editor.setModelLanguage(
          model,
          monacoLanguageForDb(dbType),
        );
      }
      return true;
    };

    const run = async () => {
      if (connId) await loadSchemaForConnection(connId, effectiveSchema, dbType);
      if (tryApply()) return;
      const interval = window.setInterval(() => {
        if (tryApply()) window.clearInterval(interval);
      }, 200);
      window.setTimeout(() => window.clearInterval(interval), 5000);
    };

    void run();
  }, [tab.connectionId, tab.schema, activeConn?.type]);

  const handleRun = useCallback(async () => {
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    const model = editor?.getModel();
    const selectedText =
      selection && model && !selection.isEmpty()
        ? model.getValueInRange(selection)
        : "";
    const sqlToRun = selectedText.trim() || tab.sql.trim();

    if (!sqlToRun || !tab.connectionId) {
      notifications.show({
        message: "Enter a query and select a connection first",
        color: "orange",
      });
      return;
    }

    updateTab(tab.id, { loading: true, error: null });

    try {
      const result = await api.executeQuery(
        tab.connectionId,
        sqlToRun,
        defaultLimitEnabled ? defaultLimitValue : null,
        tab.schema,
      );
      const conn = useStore
        .getState()
        .connections.find((c) => c.id === tab.connectionId);
      const dbDefault =
        conn?.type === "mongodb" || conn?.type === "elasticsearch"
          ? ("json" as const)
          : ("table" as const);
      updateTab(tab.id, {
        result,
        loading: false,
        viewMode: tab.viewMode ?? dbDefault,
      });
      const connLabel = conn
        ? `${conn.name} · ${conn.env} · ${conn.type}`
        : "Unknown connection";
      const dbLabel = conn?.database ? ` · ${conn.database}` : "";
      notifications.show({
        title: "Query executed successfully",
        message: `${connLabel}${dbLabel} · ${result.totalRows} rows in ${result.executionTimeMs}ms${result.truncated ? " · Truncated" : ""}`,
        color: "green",
        icon: <IconCircleCheck size={16} />,
        autoClose: 4000,
      });
    } catch (err: any) {
      updateTab(tab.id, {
        error: err.message,
        loading: false,
        result: null,
      });
      notifications.show({ message: err.message, color: "red" });
    }
  }, [
    tab.sql,
    tab.connectionId,
    tab.schema,
    tab.id,
    defaultLimitEnabled,
    defaultLimitValue,
  ]);

  // Take the selected text (or the whole query) into the Write composer.
  const handleNewWriteRequest = () => {
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    const model = editor?.getModel();
    const selectedText =
      selection && model && !selection.isEmpty()
        ? model.getValueInRange(selection)
        : "";
    const seed = selectedText.trim() || tab.sql.trim();
    if (!seed) {
      notifications.show({
        message: "Select or write a statement first",
        color: "orange",
      });
      return;
    }
    setWriteHandoff({
      writeSql: seed,
      connectionId: tab.connectionId,
      title: tab.title.startsWith("Query ") ? "" : tab.title,
    });
    navigate("/write");
  };

  const handleSave = async () => {
    if (!saveName.trim()) return;
    try {
      if (editingSavedId) {
        const updated = await api.updateSavedQuery(editingSavedId, {
          name: saveName,
          sql: tab.sql,
          connectionId: tab.connectionId,
        });
        updateSavedQueryInStore(updated);
        notifications.show({ message: "Query updated!", color: "green" });
      } else {
        const saved = await api.createSavedQuery({
          name: saveName,
          sql: tab.sql,
          connectionId: tab.connectionId,
          isShared: true,
          tags: [],
        });
        addSavedQuery(saved);
        notifications.show({ message: "Query saved!", color: "green" });
      }
      setSaveModalOpen(false);
      setSaveName("");
      setEditingSavedId(null);
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    }
  };

  const openSaveAsNew = () => {
    setEditingSavedId(null);
    setSaveName("");
    setSaveModalOpen(true);
  };

  const openUpdateExisting = () => {
    const match = savedQueries.find((q) => q.name === tab.title);
    if (match) {
      setEditingSavedId(match.id);
      setSaveName(match.name);
    } else {
      setEditingSavedId(null);
      setSaveName(tab.title.startsWith("Query ") ? "" : tab.title);
    }
    setSaveModalOpen(true);
  };

  const handleExportCsv = async () => {
    if (!tab.connectionId || !tab.sql) return;
    try {
      const csv = await api.exportCsv(tab.connectionId, tab.sql);
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "query-export.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    }
  };

  const handleFormat = useCallback(() => {
    const dbType = activeConn?.type ?? null;

    if (dbType === "mongodb") {
      // Use Monaco's built-in JS formatter
      editorRef.current?.getAction("editor.action.formatDocument")?.run();
      return;
    }

    if (dbType === "elasticsearch") {
      // Format JSON body (lines after the first GET/POST line)
      const lines = tab.sql.split("\n");
      const firstLine = lines[0];
      const jsonBody = lines.slice(1).join("\n").trim();
      if (jsonBody) {
        try {
          const formatted = JSON.stringify(JSON.parse(jsonBody), null, 2);
          updateTab(tab.id, { sql: firstLine + "\n" + formatted });
        } catch {
          notifications.show({ message: "Invalid JSON body", color: "orange" });
        }
      }
      return;
    }

    // SQL (postgres, mssql, default)
    try {
      const language = dbType === "mssql" ? "tsql" : "postgresql";
      const formatted = formatSql(tab.sql, {
        language,
        tabWidth: 2,
        keywordCase: "upper",
      });
      updateTab(tab.id, { sql: formatted });
    } catch {
      notifications.show({
        message: "Could not format query",
        color: "orange",
      });
    }
  }, [tab.sql, tab.id, activeConn?.type]);

  // Store handleRun in a ref so editor commands always call the latest version
  const handleRunRef = useRef(handleRun);
  handleRunRef.current = handleRun;

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    // Hold the placeholder ~500ms after mount so Monaco's initial layout/theme
    // paint (the brief black-box flicker) happens behind it, then fade out.
    readyTimerRef.current = window.setTimeout(() => setEditorReady(true), 500);

    // Cmd+Enter / Ctrl+Enter to run query
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      handleRunRef.current();
    });

    // Cmd+S / Ctrl+S to save query
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      openUpdateExisting();
    });

    const connId = tab.connectionId || "";
    const conn = useStore.getState().connections.find((c) => c.id === connId);
    const dbType = conn?.type ?? null;
    const effectiveSchema =
      tab.schema ?? (conn ? defaultSchemaOf(conn) : undefined);
    const cacheKey = schemaCacheKey(connId, effectiveSchema);
    registerQueryCompletions(monaco, cacheKey, dbType);
    if (connId) {
      loadSchemaForConnection(connId, effectiveSchema, dbType).then(() => {
        registerQueryCompletions(monaco, cacheKey, dbType);
      });
    }
  };

  return (
    <>
      <div
        style={{
          background: "var(--surface2)",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {/* Toolbar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 14px",
          }}
        >
          <Button
            size="xs"
            color="green"
            leftSection={<IconPlayerPlay size={14} />}
            loading={tab.loading}
            onClick={handleRun}
            styles={{
              root: { fontWeight: 700 },
            }}
          >
            Run
          </Button>

          <Tooltip label="Generate query from plain English">
            <Button
              size="xs"
              variant={aiAssistantOpen ? "filled" : "light"}
              color="primary"
              leftSection={<IconSparkles size={14} />}
              onClick={toggleAiAssistant}
            >
              Generate
            </Button>
          </Tooltip>

          {canWrite && (
            <Tooltip label="Turn the selected text (or this query) into a write request">
              <Button
                size="xs"
                variant="light"
                color="grape"
                leftSection={<IconPencilBolt size={14} />}
                onClick={handleNewWriteRequest}
              >
                Write request
              </Button>
            </Tooltip>
          )}

          <Text
            size="xs"
            fw={700}
            tt="uppercase"
            c="dimmed"
            style={{ letterSpacing: 1 }}
          >
            Query
            {activeConn?.type === "mongodb" && (
              <Text
                component="span"
                size="xs"
                c="dimmed"
                ml={6}
                ff="monospace"
                fw={400}
              >
                · Mongo shell
              </Text>
            )}
            {activeConn?.type === "elasticsearch" && (
              <Text
                component="span"
                size="xs"
                c="dimmed"
                ml={6}
                ff="monospace"
                fw={400}
              >
                · ES REST / JSON
              </Text>
            )}
          </Text>

          <Tooltip label={expanded ? "Collapse editor" : "Expand editor"}>
            <ActionIcon variant="subtle" color="gray" onClick={onToggleHeight}>
              <IconArrowsVertical size={16} />
            </ActionIcon>
          </Tooltip>

          <Tooltip label="Format">
            <ActionIcon variant="subtle" color="gray" onClick={handleFormat}>
              <IconAlignJustified size={16} />
            </ActionIcon>
          </Tooltip>

          <Tooltip label="Save query (Cmd+S)">
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={openUpdateExisting}
            >
              <IconDeviceFloppy size={16} />
            </ActionIcon>
          </Tooltip>

          <Tooltip label="Export CSV">
            <ActionIcon variant="subtle" color="gray" onClick={handleExportCsv}>
              <IconFileExport size={16} />
            </ActionIcon>
          </Tooltip>

          {/* Default Limit controls */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginLeft: 4,
            }}
          >
            <Checkbox
              size="xs"
              label="Limit"
              checked={defaultLimitEnabled}
              onChange={(e) => setDefaultLimitEnabled(e.currentTarget.checked)}
              styles={{
                label: {
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--mantine-color-dimmed)",
                  paddingLeft: 4,
                },
              }}
            />
            <NumberInput
              size="xs"
              value={defaultLimitValue}
              onChange={(val) =>
                setDefaultLimitValue(typeof val === "number" ? val : 500)
              }
              min={1}
              max={10000}
              step={100}
              disabled={!defaultLimitEnabled}
              w={80}
              styles={{
                input: { fontFamily: "IBM Plex Mono, monospace", fontSize: 12 },
              }}
            />
          </div>

          <div style={{ flex: 1 }} />

          {supportsSchemas && schemas.length > 0 && (
            <Tooltip label="Active schema — tables resolve against this schema">
              <Select
                size="xs"
                data={schemas}
                value={tab.schema ?? null}
                onChange={(val) => {
                  if (val) updateTab(tab.id, { schema: val });
                }}
                allowDeselect={false}
                checkIconPosition="right"
                leftSection={<IconDatabase size={13} />}
                w={160}
                comboboxProps={{ withinPortal: true }}
                styles={{
                  input: {
                    fontFamily: "IBM Plex Mono, monospace",
                    fontSize: 12,
                  },
                }}
              />
            </Tooltip>
          )}

          {activeConn && (
            <Badge size="sm" variant="light" color="gray" ff="monospace">
              {activeConn.name}
            </Badge>
          )}
        </div>

        {/* Monaco Editor */}
        <div
          style={{
            position: "relative",
            margin: "0 14px 12px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          {/* Stable placeholder shown until Monaco has mounted (+500ms), then
              fades out — hides the blank → text-pop → layout flicker. */}
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 2,
              background: "#ffffff",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              opacity: editorReady ? 0 : 1,
              visibility: editorReady ? "hidden" : "visible",
              transition: "opacity 260ms ease, visibility 0s linear 260ms",
              pointerEvents: "none",
            }}
          >
            <Loader size="sm" color="var(--accent)" type="dots" />
            <Text size="xs" c="dimmed" style={{ letterSpacing: 0.3 }}>
              Preparing editor…
            </Text>
          </div>
          <Editor
            height={
              height ? `${Math.max(60, height - TOOLBAR_HEIGHT)}px` : "150px"
            }
            language={monacoLanguageForDb(activeConn?.type ?? null)}
            theme="vs"
            value={tab.sql}
            onChange={(value) => updateTab(tab.id, { sql: value || "" })}
            onMount={handleEditorMount}
            loading={null}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: "IBM Plex Mono, monospace",
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              padding: { top: 10, bottom: 10 },
              renderLineHighlight: "gutter",
              automaticLayout: true,
              tabSize: 2,
              wordWrap: "on",
              overviewRulerBorder: false,
              hideCursorInOverviewRuler: true,
              quickSuggestions: {
                other: true,
                comments: false,
                strings: true,
              },
              suggestOnTriggerCharacters: true,
              wordBasedSuggestions: "off",
              acceptSuggestionOnEnter: "on",
              suggest: {
                // Must be true: our SQL keyword completions use CompletionItemKind.Keyword;
                // when false, Monaco hides them and only schema (table/column) items appear.
                showKeywords: true,
                showWords: false,
                preview: true,
                showIcons: true,
                filterGraceful: true,
                snippetsPreventQuickSuggestions: false,
              },
            }}
          />
        </div>
      </div>

      {/* Save Query Modal */}
      <Modal
        opened={saveModalOpen}
        onClose={() => {
          setSaveModalOpen(false);
          setEditingSavedId(null);
        }}
        title={editingSavedId ? "Update Query" : "Save Query"}
        size="sm"
      >
        <TextInput
          label="Query Name"
          placeholder="e.g., Patient orders with missing kits"
          value={saveName}
          onChange={(e) => setSaveName(e.currentTarget.value)}
          mb="md"
        />
        <Group justify="flex-end">
          <Button
            variant="subtle"
            onClick={() => {
              setSaveModalOpen(false);
              setEditingSavedId(null);
            }}
          >
            Cancel
          </Button>
          <Button onClick={handleSave}>
            {editingSavedId ? "Update" : "Save"}
          </Button>
        </Group>
      </Modal>
    </>
  );
}
