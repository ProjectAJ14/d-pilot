import { useState, useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor, languages, IDisposable } from "monaco-editor";
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
} from "@mantine/core";
import {
  IconPlayerPlay,
  IconDeviceFloppy,
  IconFileExport,
  IconAlignJustified,
  IconArrowsVertical,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import type { DatabaseType, QueryTab, TableInfo, ColumnInfo } from "../../types";

interface Props {
  tab: QueryTab;
  height?: number;
  expanded?: boolean;
  onToggleHeight?: () => void;
}

// Cache schema data for autocomplete
const schemaCache: Record<string, { tables: TableInfo[]; columns: Record<string, ColumnInfo[]> }> = {};
let completionDisposables: IDisposable[] = [];

function disposeCompletions() {
  for (const d of completionDisposables) d.dispose();
  completionDisposables = [];
}

const TRIGGER_CHARS = " .,(abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\"'{[}".split("");

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
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "LIKE", "ILIKE", "BETWEEN",
  "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "OUTER JOIN", "CROSS JOIN",
  "ON", "AS", "ORDER BY", "GROUP BY", "HAVING", "LIMIT", "OFFSET",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "DISTINCT",
  "CASE", "WHEN", "THEN", "ELSE", "END",
  "IS NULL", "IS NOT NULL", "EXISTS", "UNION", "UNION ALL",
  "ASC", "DESC", "TOP", "WITH", "NULL", "TRUE", "FALSE",
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
  monaco: { languages: { CompletionItemKind: typeof languages.CompletionItemKind } },
  suggestions: languages.CompletionItem[],
  keywords: string[],
  range: languages.CompletionItem["range"]
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

async function loadSchemaForConnection(connectionId: string) {
  if (schemaCache[connectionId]) return schemaCache[connectionId];
  try {
    const tables = await api.getTables(connectionId);
    schemaCache[connectionId] = { tables, columns: {} };
    // Load columns for first 20 tables in background
    for (const t of tables.slice(0, 20)) {
      api.getColumns(connectionId, t.name).then((cols) => {
        schemaCache[connectionId].columns[t.name] = cols;
      }).catch(() => {});
    }
    return schemaCache[connectionId];
  } catch {
    return { tables: [], columns: {} };
  }
}

function addSqlSchemaSuggestions(
  monaco: any,
  suggestions: languages.CompletionItem[],
  connectionId: string,
  range: languages.CompletionItem["range"],
  isTableContext: boolean
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
function registerQueryCompletions(monaco: any, connectionId: string, dbType: DatabaseType | null | undefined) {
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
          const lastClause = textUntilPosition.match(/\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+\w*$/i);
          const isTableContext = !!lastClause;

          const kws = [...SQL_KEYWORDS];
          if (eff === "mssql") kws.push(...MSSQL_EXTRA_KEYWORDS);
          pushKeywordSuggestions(monaco, suggestions, kws, range);
          if (connectionId) addSqlSchemaSuggestions(monaco, suggestions, connectionId, range, isTableContext);

          return { suggestions };
        },
      })
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

          const lineUntil = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
          const dbMatch = lineUntil.match(/db\.(\w*)$/);
          const schema = connectionId ? schemaCache[connectionId] : undefined;
          if (schema && dbMatch) {
            const prefix = dbMatch[1].toLowerCase();
            for (const coll of schema.tables) {
              if (prefix && !coll.name.toLowerCase().startsWith(prefix)) continue;
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
              }
            );
          }

          const collForFields = lineUntil.match(
            /db\.(\w+)\.(?:find|findOne|aggregate|countDocuments|distinct)\(/
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
      })
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

          const lineUntil = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
          const pathMatch = lineUntil.match(/^(?:GET|POST)?\s*\/?([\w\-.*]*)$/i);
          const schema = connectionId ? schemaCache[connectionId] : undefined;
          if (schema && pathMatch) {
            const prefix = pathMatch[1].toLowerCase();
            for (const idx of schema.tables) {
              if (prefix && !idx.name.toLowerCase().startsWith(prefix)) continue;
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
      })
    );
  }
}

// Toolbar + padding takes roughly 56px; subtract from total height for the editor area
const TOOLBAR_HEIGHT = 56;

export function QueryEditor({ tab, height, expanded, onToggleHeight }: Props) {
  const updateTab = useStore((s) => s.updateTab);
  const connections = useStore((s) => s.connections);
  const addSavedQuery = useStore((s) => s.addSavedQuery);
  const savedQueries = useStore((s) => s.savedQueries);
  const updateSavedQueryInStore = useStore((s) => s.updateSavedQuery);
  const defaultLimitEnabled = useStore((s) => s.defaultLimitEnabled);
  const defaultLimitValue = useStore((s) => s.defaultLimitValue);
  const setDefaultLimitEnabled = useStore((s) => s.setDefaultLimitEnabled);
  const setDefaultLimitValue = useStore((s) => s.setDefaultLimitValue);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [editingSavedId, setEditingSavedId] = useState<string | null>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<any>(null);

  const activeConn = connections.find((c) => c.id === tab.connectionId);

  // Load schema, switch Monaco language, and register dialect-specific completions
  useEffect(() => {
    const connId = tab.connectionId || "";
    const dbType = activeConn?.type ?? null;

    const tryApply = () => {
      if (!monacoRef.current) return false;
      registerQueryCompletions(monacoRef.current, connId, dbType);
      const model = editorRef.current?.getModel();
      if (model) {
        monacoRef.current.editor.setModelLanguage(model, monacoLanguageForDb(dbType));
      }
      return true;
    };

    const run = async () => {
      if (connId) await loadSchemaForConnection(connId);
      if (tryApply()) return;
      const interval = window.setInterval(() => {
        if (tryApply()) window.clearInterval(interval);
      }, 200);
      window.setTimeout(() => window.clearInterval(interval), 5000);
    };

    void run();
  }, [tab.connectionId, activeConn?.type]);

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
        defaultLimitEnabled ? defaultLimitValue : null
      );
      updateTab(tab.id, { result, loading: false });
    } catch (err: any) {
      updateTab(tab.id, {
        error: err.message,
        loading: false,
        result: null,
      });
      notifications.show({ message: err.message, color: "red" });
    }
  }, [tab.sql, tab.connectionId, tab.id, defaultLimitEnabled, defaultLimitValue]);

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
      const formatted = formatSql(tab.sql, { language, tabWidth: 2, keywordCase: "upper" });
      updateTab(tab.id, { sql: formatted });
    } catch {
      notifications.show({ message: "Could not format query", color: "orange" });
    }
  }, [tab.sql, tab.id, activeConn?.type]);

  // Store handleRun in a ref so editor commands always call the latest version
  const handleRunRef = useRef(handleRun);
  handleRunRef.current = handleRun;

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Cmd+Enter / Ctrl+Enter to run query
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      handleRunRef.current();
    });

    // Cmd+S / Ctrl+S to save query
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      openUpdateExisting();
    });

    const connId = tab.connectionId || "";
    const dbType =
      useStore.getState().connections.find((c) => c.id === connId)?.type ?? null;
    registerQueryCompletions(monaco, connId, dbType);
    if (connId) {
      loadSchemaForConnection(connId).then(() => {
        const t =
          useStore.getState().connections.find((c) => c.id === connId)?.type ?? null;
        registerQueryCompletions(monaco, connId, t);
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

          <Text
            size="xs"
            fw={700}
            tt="uppercase"
            c="dimmed"
            style={{ letterSpacing: 1 }}
          >
            Query
            {activeConn?.type === "mongodb" && (
              <Text component="span" size="xs" c="dimmed" ml={6} ff="monospace" fw={400}>
                · Mongo shell
              </Text>
            )}
            {activeConn?.type === "elasticsearch" && (
              <Text component="span" size="xs" c="dimmed" ml={6} ff="monospace" fw={400}>
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
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={handleExportCsv}
            >
              <IconFileExport size={16} />
            </ActionIcon>
          </Tooltip>

          {/* Default Limit controls */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 4 }}>
            <Checkbox
              size="xs"
              label="Limit"
              checked={defaultLimitEnabled}
              onChange={(e) => setDefaultLimitEnabled(e.currentTarget.checked)}
              styles={{
                label: { fontSize: 11, fontWeight: 600, color: "var(--mantine-color-dimmed)", paddingLeft: 4 },
              }}
            />
            <NumberInput
              size="xs"
              value={defaultLimitValue}
              onChange={(val) => setDefaultLimitValue(typeof val === "number" ? val : 500)}
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

          {activeConn && (
            <Badge size="sm" variant="light" color="gray" ff="monospace">
              {activeConn.name}
            </Badge>
          )}
        </div>

        {/* Monaco Editor */}
        <div style={{ margin: "0 14px 12px", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
          <Editor
            height={height ? `${Math.max(60, height - TOOLBAR_HEIGHT)}px` : "150px"}
            language={monacoLanguageForDb(activeConn?.type ?? null)}
            theme="vs"
            value={tab.sql}
            onChange={(value) => updateTab(tab.id, { sql: value || "" })}
            onMount={handleEditorMount}
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
        onClose={() => { setSaveModalOpen(false); setEditingSavedId(null); }}
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
          <Button variant="subtle" onClick={() => { setSaveModalOpen(false); setEditingSavedId(null); }}>
            Cancel
          </Button>
          <Button onClick={handleSave}>{editingSavedId ? "Update" : "Save"}</Button>
        </Group>
      </Modal>
    </>
  );
}
